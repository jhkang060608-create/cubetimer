#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-features.json");
const SCHEMA_VERSION = "reco-style-features.v1";

const DISTANCE_WEIGHTS = Object.freeze({
  rotationRate: 3,
  aufRate: 3,
  wideTurnRate: 2,
  avgF2LSegmentLen: 1,
  zbUsageRate: 1,
});

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return fallback;
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    puzzle: "3x3",
    minSolves: 20,
    verifySample: 200,
    verifyAll: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    const [flag, inlineValue] = arg.split("=", 2);
    const value = inlineValue !== undefined ? inlineValue : argv[i + 1];
    const consumeNext = inlineValue === undefined;

    if (flag === "--input") {
      opts.input = value || opts.input;
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    } else if (flag === "--puzzle") {
      opts.puzzle = String(value || opts.puzzle || "3x3").trim() || "3x3";
      if (consumeNext) i += 1;
    } else if (flag === "--min-solves") {
      opts.minSolves = Math.max(1, parseIntOrFallback(value, opts.minSolves));
      if (consumeNext) i += 1;
    } else if (flag === "--verify-sample") {
      opts.verifySample = Math.max(0, parseIntOrFallback(value, opts.verifySample));
      if (consumeNext) i += 1;
    } else if (flag === "--verify-all") {
      opts.verifyAll = normalizeBool(value, opts.verifyAll);
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-style-features.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>          Input details JSON (default: vendor-data/reco/reco-3x3-details.json)");
  console.log("  --output <path>         Output features JSON");
  console.log("  --puzzle <name>         Puzzle filter (default: 3x3)");
  console.log("  --min-solves <n>        Minimum solves per player profile (default: 20)");
  console.log("  --verify-sample <n>     Sample size for scramble+solution replay verification (default: 200)");
  console.log("  --verify-all <bool>     Replay-verify all solves (default: false)");
}

function loadRecords(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error(`Input has no records array: ${inputPath}`);
}

function splitMoveTokens(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\/\/.*$/gm, " ")
    .replace(/[\[\](),]/g, " ")
    .replace(/[{}]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseMoveToken(token) {
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(token);
  if (!match) return null;
  return {
    face: match[1],
    suffix: match[2] || "",
  };
}

function normalizeMoveToken(token) {
  const parsed = parseMoveToken(token);
  if (!parsed) return "";
  const face = parsed.face;
  const suffix = parsed.suffix;
  if (!face) return "";
  if (suffix === "2'" || suffix === "2") return `${face}2`;
  if (suffix === "'") return `${face}'`;
  return face;
}

function normalizeAlgorithmText(text) {
  const tokens = splitMoveTokens(text);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const normalized = normalizeMoveToken(tokens[i]);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out.join(" ");
}

function parseResultSeconds(resultText) {
  const text = String(resultText || "").trim();
  if (!text) return null;
  if (/^dnf$/i.test(text)) return null;
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (m) {
    const mins = Number(m[1]);
    const secs = Number(m[2]);
    if (Number.isFinite(mins) && Number.isFinite(secs)) {
      return mins * 60 + secs;
    }
  }
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isCubeRotationFace(face) {
  return face === "x" || face === "y" || face === "z" || face === "X" || face === "Y" || face === "Z";
}

function isWideTurnFace(face) {
  if (!face) return false;
  if (face.endsWith("w") || face.endsWith("W")) return true;
  return face === "u" || face === "r" || face === "f" || face === "d" || face === "l" || face === "b";
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function buildSecondaryKey(scramble, algorithmPlain) {
  return crypto
    .createHash("sha1")
    .update(String(scramble || ""))
    .update("\n")
    .update(String(algorithmPlain || ""))
    .digest("hex");
}

function collectF2LSegmentLengths(steps) {
  const lengths = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const label = String(step?.label || "").toLowerCase();
    const moves = String(step?.moves || "").trim();
    if (!label.includes("f2l")) continue;
    const moveCount = splitMoveTokens(moves).length;
    if (moveCount > 0) lengths.push(moveCount);
  }
  return lengths;
}

function inferLlApproach(methodText, steps) {
  const method = String(methodText || "").toUpperCase();
  if (method.includes("ZB")) return "ZB";
  for (let i = 0; i < steps.length; i++) {
    const label = String(steps[i]?.label || "").toLowerCase();
    if (label.includes("zbll") || label.includes("zbls")) {
      return "ZB";
    }
  }
  return "CFOP";
}

function computeSolveFeature(row) {
  const solver = String(row?.meta?.solver || row?.solver || "").trim();
  const method = String(row?.method || row?.meta?.method || "").trim();
  const resultText = String(row?.meta?.result || row?.result || "").trim();
  const scramble = String(row.scramble || "").trim();
  const algorithmRaw = String(row.algorithmPlain || "").trim();
  const normalizedAlgorithm = normalizeAlgorithmText(algorithmRaw);
  const tokens = splitMoveTokens(algorithmRaw);

  let rotationCount = 0;
  let aufCount = 0;
  let wideTurnCount = 0;
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseMoveToken(tokens[i]);
    if (!parsed) continue;
    if (isCubeRotationFace(parsed.face)) {
      rotationCount += 1;
      continue;
    }
    if (parsed.face === "U") {
      aufCount += 1;
    }
    if (isWideTurnFace(parsed.face)) {
      wideTurnCount += 1;
    }
  }

  const steps = Array.isArray(row.steps) ? row.steps : [];
  const f2lSegmentLengths = collectF2LSegmentLengths(steps);
  const llApproach = inferLlApproach(method, steps);
  const moveCount = tokens.length;
  const resultSeconds = parseResultSeconds(resultText);
  const secondaryDedupKey = buildSecondaryKey(scramble, algorithmRaw);

  return {
    id: Number(row.id),
    solver,
    method: method || "UNKNOWN",
    result: resultText,
    resultSeconds,
    solveUrl: row.solveUrl || "",
    scramble,
    algorithmPlain: algorithmRaw,
    algorithmNormalized: normalizedAlgorithm,
    secondaryDedupKey,
    moveCount,
    rotationCount,
    aufCount,
    wideTurnCount,
    rotationRate: moveCount > 0 ? rotationCount / moveCount : null,
    aufRate: moveCount > 0 ? aufCount / moveCount : null,
    wideTurnRate: moveCount > 0 ? wideTurnCount / moveCount : null,
    avgF2LSegmentLen: average(f2lSegmentLengths),
    f2lSegmentCount: f2lSegmentLengths.length,
    f2lPairProgress: Math.min(4, f2lSegmentLengths.length),
    llApproach,
    zbUsageRate: llApproach === "ZB" ? 1 : 0,
    moveEfficiency: moveCount,
    movePerSecond: Number.isFinite(resultSeconds) && resultSeconds > 0 ? moveCount / resultSeconds : null,
  };
}

function dedupeSolveFeatures(features) {
  const byId = new Map();
  const bySecondaryKey = new Map();
  let droppedById = 0;
  let droppedBySecondary = 0;

  function qualityScore(feature) {
    let score = 0;
    if (feature.scramble) score += 2;
    if (feature.algorithmPlain) score += 2;
    if (feature.moveCount > 0) score += 1;
    if (Number.isFinite(feature.resultSeconds)) score += 1;
    return score;
  }

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (!Number.isFinite(feature.id)) continue;

    const idPrev = byId.get(feature.id);
    if (idPrev) {
      if (qualityScore(feature) > qualityScore(idPrev)) {
        byId.set(feature.id, feature);
      }
      droppedById += 1;
      continue;
    }

    const secPrev = bySecondaryKey.get(feature.secondaryDedupKey);
    if (secPrev) {
      if (qualityScore(feature) > qualityScore(secPrev)) {
        byId.delete(secPrev.id);
        bySecondaryKey.set(feature.secondaryDedupKey, feature);
        byId.set(feature.id, feature);
      }
      droppedBySecondary += 1;
      continue;
    }

    byId.set(feature.id, feature);
    bySecondaryKey.set(feature.secondaryDedupKey, feature);
  }

  const deduped = Array.from(byId.values()).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  return {
    deduped,
    droppedById,
    droppedBySecondary,
  };
}

function summarizePlayers(features, minSolves) {
  const byPlayer = new Map();
  for (let i = 0; i < features.length; i++) {
    const row = features[i];
    if (!row.solver) continue;
    let agg = byPlayer.get(row.solver);
    if (!agg) {
      agg = {
        solver: row.solver,
        solveCount: 0,
        moveCount: [],
        rotationRate: [],
        aufRate: [],
        wideTurnRate: [],
        avgF2LSegmentLen: [],
        zbUsageRate: [],
        movePerSecond: [],
        methods: {},
      };
      byPlayer.set(row.solver, agg);
    }
    agg.solveCount += 1;
    if (Number.isFinite(row.moveCount)) agg.moveCount.push(row.moveCount);
    if (Number.isFinite(row.rotationRate)) agg.rotationRate.push(row.rotationRate);
    if (Number.isFinite(row.aufRate)) agg.aufRate.push(row.aufRate);
    if (Number.isFinite(row.wideTurnRate)) agg.wideTurnRate.push(row.wideTurnRate);
    if (Number.isFinite(row.avgF2LSegmentLen)) agg.avgF2LSegmentLen.push(row.avgF2LSegmentLen);
    if (Number.isFinite(row.zbUsageRate)) agg.zbUsageRate.push(row.zbUsageRate);
    if (Number.isFinite(row.movePerSecond)) agg.movePerSecond.push(row.movePerSecond);
    const method = row.method || "UNKNOWN";
    agg.methods[method] = (agg.methods[method] || 0) + 1;
  }

  const players = [];
  for (const agg of byPlayer.values()) {
    if (agg.solveCount < minSolves) continue;
    const primaryMethodEntry = Object.entries(agg.methods).sort((a, b) => b[1] - a[1])[0] || ["UNKNOWN", 0];
    players.push({
      solver: agg.solver,
      solveCount: agg.solveCount,
      avgMoveCount: average(agg.moveCount),
      rotationRate: average(agg.rotationRate),
      aufRate: average(agg.aufRate),
      wideTurnRate: average(agg.wideTurnRate),
      avgF2LSegmentLen: average(agg.avgF2LSegmentLen),
      zbUsageRate: average(agg.zbUsageRate),
      avgMovePerSecond: average(agg.movePerSecond),
      primaryMethod: primaryMethodEntry[0],
      primaryMethodRatio: agg.solveCount > 0 ? primaryMethodEntry[1] / agg.solveCount : 0,
      methodBreakdown: agg.methods,
    });
  }

  players.sort((a, b) => b.solveCount - a.solveCount || a.solver.localeCompare(b.solver));
  return players;
}

function computeMissingRates(features) {
  let missingRotationRate = 0;
  let missingAufRate = 0;
  let missingWideTurnRate = 0;
  let missingF2L = 0;
  let missingZbUsage = 0;
  for (let i = 0; i < features.length; i++) {
    const row = features[i];
    if (!Number.isFinite(row.rotationRate)) missingRotationRate += 1;
    if (!Number.isFinite(row.aufRate)) missingAufRate += 1;
    if (!Number.isFinite(row.wideTurnRate)) missingWideTurnRate += 1;
    if (!Number.isFinite(row.avgF2LSegmentLen)) missingF2L += 1;
    if (!Number.isFinite(row.zbUsageRate)) missingZbUsage += 1;
  }
  return {
    missingRotationRate,
    missingRotationRateRatio: features.length > 0 ? missingRotationRate / features.length : 0,
    missingAufRate,
    missingAufRateRatio: features.length > 0 ? missingAufRate / features.length : 0,
    missingWideTurnRate,
    missingWideTurnRateRatio: features.length > 0 ? missingWideTurnRate / features.length : 0,
    missingAvgF2LSegmentLen: missingF2L,
    missingAvgF2LSegmentLenRatio: features.length > 0 ? missingF2L / features.length : 0,
    missingZbUsageRate: missingZbUsage,
    missingZbUsageRateRatio: features.length > 0 ? missingZbUsage / features.length : 0,
  };
}

function buildDistanceConfig(players) {
  const bounds = {};
  const keys = Object.keys(DISTANCE_WEIGHTS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    let min = Infinity;
    let max = -Infinity;
    for (let p = 0; p < players.length; p++) {
      const value = Number(players[p][key]);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      bounds[key] = { min: 0, max: 1 };
    } else if (max <= min) {
      bounds[key] = { min, max: min + 1e-6 };
    } else {
      bounds[key] = { min, max };
    }
  }
  return {
    weights: DISTANCE_WEIGHTS,
    normalizationBounds: bounds,
  };
}

async function verifyScrambleSolutions(features, verifyLimit) {
  if (verifyLimit <= 0 || features.length === 0) {
    return {
      attempted: 0,
      matched: 0,
      mismatched: 0,
      invalid: 0,
      matchRate: null,
    };
  }

  const contextPath = pathToFileURL(path.join(ROOT_DIR, "solver", "context.js")).href;
  const { getDefaultPattern } = await import(contextPath);
  const solvedPattern = await getDefaultPattern("333");

  let attempted = 0;
  let matched = 0;
  let invalid = 0;

  for (let i = 0; i < features.length && attempted < verifyLimit; i++) {
    const feature = features[i];
    if (!feature.scramble || !feature.algorithmPlain) continue;
    attempted += 1;
    try {
      const finalPattern = solvedPattern.applyAlg(feature.scramble).applyAlg(feature.algorithmPlain);
      const solved = finalPattern.experimentalIsSolved({ ignorePuzzleOrientation: true });
      if (solved) matched += 1;
    } catch (_) {
      invalid += 1;
    }
  }

  const mismatched = Math.max(0, attempted - matched - invalid);
  return {
    attempted,
    matched,
    mismatched,
    invalid,
    matchRate: attempted > 0 ? matched / attempted : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const records = loadRecords(opts.input);
  const inputFiltered = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (opts.puzzle && puzzle !== opts.puzzle) continue;
    inputFiltered.push(row);
  }

  const rawFeatures = [];
  for (let i = 0; i < inputFiltered.length; i++) {
    rawFeatures.push(computeSolveFeature(inputFiltered[i]));
  }

  const dedupeResult = dedupeSolveFeatures(rawFeatures);
  const solveFeatures = dedupeResult.deduped;
  const playerProfiles = summarizePlayers(solveFeatures, opts.minSolves);
  const distanceConfig = buildDistanceConfig(playerProfiles);
  const sampleVerification = await verifyScrambleSolutions(
    solveFeatures,
    Math.min(opts.verifySample, solveFeatures.length),
  );
  const fullVerification = opts.verifyAll
    ? await verifyScrambleSolutions(solveFeatures, solveFeatures.length)
    : null;

  const payload = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sourceInput: opts.input,
    puzzle: opts.puzzle,
    dataContract: {
      solveFeatureRequired: [
        "solver",
        "method",
        "result",
        "scramble",
        "algorithmPlain",
        "rotationRate",
        "aufRate",
        "wideTurnRate",
        "avgF2LSegmentLen",
        "zbUsageRate",
      ],
      playerProfileRequired: [
        "solver",
        "solveCount",
        "rotationRate",
        "aufRate",
        "wideTurnRate",
        "avgF2LSegmentLen",
        "zbUsageRate",
      ],
    },
    distanceConfig,
    solveFeatures,
    playerProfiles,
    qualityReport: {
      inputRecords: records.length,
      filteredRecords: inputFiltered.length,
      rawFeatureCount: rawFeatures.length,
      dedupedFeatureCount: solveFeatures.length,
      droppedById: dedupeResult.droppedById,
      droppedBySecondaryKey: dedupeResult.droppedBySecondary,
      featureMissingRates: computeMissingRates(solveFeatures),
      integrity: {
        sampleVerification,
        fullVerification,
      },
    },
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (solveFeatures=${solveFeatures.length}, playerProfiles=${playerProfiles.length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
