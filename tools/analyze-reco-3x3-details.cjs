#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-profiles.json");
const SCHEMA_VERSION = "reco-style-profiles.v2";
const DISTANCE_WEIGHTS = Object.freeze({
  rotationRate: 3,
  aufRate: 3,
  wideTurnRate: 2,
  avgF2LSegmentLen: 1,
  zbUsageRate: 1,
});

const STYLE_PRESET_WEIGHTS = Object.freeze({
  legacy: { rotationWeight: 0, aufWeight: 0, wideTurnWeight: 0 },
  balanced: { rotationWeight: 2, aufWeight: 1, wideTurnWeight: 1 },
  rotationless: { rotationWeight: 5, aufWeight: 1, wideTurnWeight: 2 },
  "low-auf": { rotationWeight: 1, aufWeight: 4, wideTurnWeight: 1 },
});

function normalizePuzzleFilter(value) {
  const text = String(value || "all").trim();
  if (!text) return "all";
  if (text.toLowerCase() === "all") return "all";
  return text;
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    minSolves: 20,
    puzzle: "all",
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
    } else if (flag === "--min-solves") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) opts.minSolves = Math.max(1, n);
      if (consumeNext) i += 1;
    } else if (flag === "--puzzle") {
      opts.puzzle = normalizePuzzleFilter(value);
      if (consumeNext) i += 1;
    }
  }

  opts.puzzle = normalizePuzzleFilter(opts.puzzle);

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/analyze-reco-3x3-details.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>       Input details JSON");
  console.log("  --output <path>      Output style profile JSON");
  console.log("  --min-solves <n>     Minimum solves per player (default: 20)");
  console.log("  --puzzle <name|all>  Puzzle filter (default: all)");
}

function splitMoveTokens(text) {
  return String(text || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseMoveToken(token) {
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(token);
  if (!match) return null;
  const suffix = match[2] || "";
  let amount = 1;
  if (suffix === "2" || suffix === "2'") amount = 2;
  if (suffix === "'") amount = 3;
  return {
    face: match[1],
    amount,
  };
}

function isCubeRotationFace(face) {
  return face === "x" || face === "y" || face === "z" || face === "X" || face === "Y" || face === "Z";
}

function isWideTurnFace(face) {
  if (!face) return false;
  if (face.endsWith("w") || face.endsWith("W")) return true;
  return face === "u" || face === "r" || face === "f" || face === "d" || face === "l" || face === "b";
}

function solveStyleMetrics(algorithmPlain) {
  const tokens = splitMoveTokens(algorithmPlain);
  let rotationCount = 0;
  let aufCount = 0;
  let wideTurnCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseMoveToken(tokens[i]);
    if (!parsed) continue;
    const face = parsed.face;
    if (isCubeRotationFace(face)) {
      rotationCount += 1;
      continue;
    }
    if (face === "U") {
      aufCount += 1;
    }
    if (isWideTurnFace(face)) {
      wideTurnCount += 1;
    }
  }

  return {
    moveCount: tokens.length,
    rotationCount,
    aufCount,
    wideTurnCount,
  };
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function topEntry(mapObj) {
  const entries = Object.entries(mapObj || {});
  if (!entries.length) return { key: "", count: 0, ratio: 0 };
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((acc, entry) => acc + entry[1], 0);
  return {
    key: entries[0][0],
    count: entries[0][1],
    ratio: total > 0 ? entries[0][1] / total : 0,
  };
}

function normalizeMethod(method) {
  const text = String(method || "").trim();
  if (!text) return "UNKNOWN";
  return text.toUpperCase();
}

function normalizeLabel(label) {
  return String(label || "").toLowerCase();
}

function inferLlApproach(method, steps) {
  const normalizedMethod = normalizeMethod(method);
  if (normalizedMethod.includes("ZB")) return "ZB";
  for (let i = 0; i < steps.length; i++) {
    const label = normalizeLabel(steps[i]?.label);
    if (label.includes("zbll") || label.includes("zbls")) return "ZB";
  }
  return "CFOP";
}

function recommendF2LMethod(summary) {
  if (summary.rotationRate === null || summary.aufRate === null) return "legacy";
  if (summary.rotationRate !== null && summary.rotationRate <= 0.03) {
    return "rotationless";
  }
  if (summary.aufRate !== null && summary.aufRate <= 0.16) {
    return "low-auf";
  }
  return "balanced";
}

function toRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function loadDetails(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error(`Input has no records array: ${inputPath}`);
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const records = loadDetails(opts.input);
  const byPlayer = new Map();
  let processedSolves = 0;
  let solvesWithF2LSegments = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (opts.puzzle !== "all" && puzzle !== opts.puzzle) continue;

    const solver = String(row?.meta?.solver || row?.solver || "").trim();
    if (!solver) continue;

    let agg = byPlayer.get(solver);
    if (!agg) {
      agg = {
        solver,
        solveCount: 0,
        moveCounts: [],
        rotationCounts: [],
        aufCounts: [],
        wideTurnCounts: [],
        f2lSegmentLens: [],
        zbUsageFlags: [],
        methods: {},
        labelCounts: {},
      };
      byPlayer.set(solver, agg);
    }

    const metrics = solveStyleMetrics(row.algorithmPlain || "");
    if (metrics.moveCount <= 0) continue;

    agg.solveCount += 1;
    agg.moveCounts.push(metrics.moveCount);
    agg.rotationCounts.push(metrics.rotationCount);
    agg.aufCounts.push(metrics.aufCount);
    agg.wideTurnCounts.push(metrics.wideTurnCount);
    processedSolves += 1;

    const method = normalizeMethod(row.method || row?.meta?.method);
    agg.methods[method] = (agg.methods[method] || 0) + 1;

    const steps = Array.isArray(row.steps) ? row.steps : [];
    const f2lLens = [];
    for (let s = 0; s < steps.length; s++) {
      const label = normalizeLabel(steps[s].label);
      if (!label) continue;
      if (label.includes("zbll")) agg.labelCounts.ZBLL = (agg.labelCounts.ZBLL || 0) + 1;
      if (label.includes("zbls")) agg.labelCounts.ZBLS = (agg.labelCounts.ZBLS || 0) + 1;
      if (label.includes("oll")) agg.labelCounts.OLL = (agg.labelCounts.OLL || 0) + 1;
      if (label.includes("pll")) agg.labelCounts.PLL = (agg.labelCounts.PLL || 0) + 1;
      if (label.includes("cross")) agg.labelCounts.CROSS = (agg.labelCounts.CROSS || 0) + 1;
      if (label.includes("f2l")) {
        const moveCount = splitMoveTokens(steps[s].moves || "").length;
        if (moveCount > 0) f2lLens.push(moveCount);
      }
    }
    if (f2lLens.length > 0) {
      solvesWithF2LSegments += 1;
      agg.f2lSegmentLens.push(average(f2lLens));
    }
    const llApproach = inferLlApproach(method, steps);
    agg.zbUsageFlags.push(llApproach === "ZB" ? 1 : 0);
  }

  const players = [];
  for (const agg of byPlayer.values()) {
    if (agg.solveCount < opts.minSolves) continue;

    const totalMoves = agg.moveCounts.reduce((acc, v) => acc + v, 0);
    const totalRotations = agg.rotationCounts.reduce((acc, v) => acc + v, 0);
    const totalAuf = agg.aufCounts.reduce((acc, v) => acc + v, 0);
    const totalWide = agg.wideTurnCounts.reduce((acc, v) => acc + v, 0);

    const primaryMethod = topEntry(agg.methods);
    const summary = {
      solver: agg.solver,
      solveCount: agg.solveCount,
      avgMoveCount: average(agg.moveCounts),
      avgRotationCount: average(agg.rotationCounts),
      avgAufCount: average(agg.aufCounts),
      avgWideTurnCount: average(agg.wideTurnCounts),
      rotationRate: toRatio(totalRotations, totalMoves),
      aufRate: toRatio(totalAuf, totalMoves),
      wideTurnRate: toRatio(totalWide, totalMoves),
      avgF2LSegmentLen: average(agg.f2lSegmentLens),
      zbUsageRate: average(agg.zbUsageFlags),
      primaryMethod: primaryMethod.key,
      primaryMethodRatio: primaryMethod.ratio,
      stageLabelCounts: agg.labelCounts,
      recommendedF2LMethod: "legacy",
      recommendedStyleProfile: STYLE_PRESET_WEIGHTS.legacy,
    };

    summary.recommendedF2LMethod = recommendF2LMethod(summary);
    summary.recommendedStyleProfile = STYLE_PRESET_WEIGHTS[summary.recommendedF2LMethod] || STYLE_PRESET_WEIGHTS.legacy;
    players.push(summary);
  }

  players.sort((a, b) => b.solveCount - a.solveCount || a.solver.localeCompare(b.solver));

  const payload = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sourceInput: opts.input,
    minSolves: opts.minSolves,
    puzzle: opts.puzzle,
    playerCount: players.length,
    distanceConfig: buildDistanceConfig(players),
    playerProfiles: players,
    qualityReport: {
      processedSolves,
      solvesWithF2LSegments,
      solvesWithF2LSegmentsRate: processedSolves > 0 ? solvesWithF2LSegments / processedSolves : 0,
    },
    players,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (${players.length} players)`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
