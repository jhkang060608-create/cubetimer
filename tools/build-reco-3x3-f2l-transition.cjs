#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT_PRIMARY = path.join(ROOT_DIR, "vendor-data", "reco", "reco-all-3x3-gte100-details.json");
const DEFAULT_INPUT_SECONDARY = path.join(ROOT_DIR, "vendor-data", "reco", "reco-all-3x3-top10-details.json");
const DEFAULT_INPUT_FALLBACK = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const DEFAULT_INPUT = fs.existsSync(DEFAULT_INPUT_PRIMARY)
  ? DEFAULT_INPUT_PRIMARY
  : fs.existsSync(DEFAULT_INPUT_SECONDARY)
    ? DEFAULT_INPUT_SECONDARY
    : DEFAULT_INPUT_FALLBACK;
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-f2l-transition.json");
const DEFAULT_PUZZLE = "3x3";
const DEFAULT_METHODS = ["CFOP", "ZB"];
const DEFAULT_MAX_NEXT_STATES = 16;
const DEFAULT_SMOOTHING_ALPHA = 0.5;
const SCHEMA_VERSION = "reco-f2l-transition.v1";

const POPCOUNT_12 = new Uint8Array(1 << 12);
for (let i = 1; i < POPCOUNT_12.length; i++) {
  POPCOUNT_12[i] = POPCOUNT_12[i >> 1] + (i & 1);
}

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseCsvList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback.slice();
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    puzzle: DEFAULT_PUZZLE,
    methods: DEFAULT_METHODS.slice(),
    maxNextStates: DEFAULT_MAX_NEXT_STATES,
    smoothingAlpha: DEFAULT_SMOOTHING_ALPHA,
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
      opts.puzzle = String(value || opts.puzzle || DEFAULT_PUZZLE).trim() || DEFAULT_PUZZLE;
      if (consumeNext) i += 1;
    } else if (flag === "--methods") {
      opts.methods = parseCsvList(value, opts.methods)
        .map((method) => method.toUpperCase())
        .filter((method) => method === "CFOP" || method === "ZB");
      if (!opts.methods.length) {
        opts.methods = DEFAULT_METHODS.slice();
      }
      if (consumeNext) i += 1;
    } else if (flag === "--max-next-states") {
      opts.maxNextStates = Math.max(1, parseIntOrFallback(value, opts.maxNextStates));
      if (consumeNext) i += 1;
    } else if (flag === "--smoothing-alpha") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        opts.smoothingAlpha = n;
      }
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-f2l-transition.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>            Input details JSON");
  console.log("  --output <path>           Output transition JSON");
  console.log("  --puzzle <name>           Puzzle filter (default: 3x3)");
  console.log("  --methods <csv>           Methods to include (default: CFOP,ZB)");
  console.log("  --max-next-states <n>     Keep only the top N next states per source state (default: 16)");
  console.log("  --smoothing-alpha <n>    Laplace smoothing constant (default: 0.5)");
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

function collectChangedPositions(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push(i);
  }
  return out;
}

function buildSecondaryKey(scramble, algorithmPlain) {
  return crypto
    .createHash("sha1")
    .update(String(scramble || ""))
    .update("\n")
    .update(String(algorithmPlain || ""))
    .digest("hex");
}

function isRelevantTransitionLabel(label) {
  const text = String(label || "").trim().toLowerCase();
  if (!text) return false;
  if (text === "inspection" || text.startsWith("inspect")) return false;
  if (text.includes("cross")) return true;
  if (text.includes("pair")) return true;
  if (text === "f2l" || text === "f2l2") return true;
  return false;
}

function encodeF2LCornerState(data, positions) {
  const pieces = data.CORNERS.pieces;
  const orientation = data.CORNERS.orientation;
  let usedMask = 0;
  let permRank = 0;
  let oriCode = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const pieceId = pieces[pos];
    const lowerMask = (1 << pieceId) - 1;
    const usedLower = POPCOUNT_12[usedMask & lowerMask];
    const lessUnused = pieceId - usedLower;
    permRank = permRank * (8 - i) + lessUnused;
    usedMask |= 1 << pieceId;
    oriCode = oriCode * 3 + (orientation[pos] % 3);
  }
  return permRank * 81 + oriCode;
}

function encodeF2LEdgeState(data, positions) {
  const pieces = data.EDGES.pieces;
  const orientation = data.EDGES.orientation;
  let usedMask = 0;
  let permRank = 0;
  let oriCode = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const pieceId = pieces[pos];
    const lowerMask = (1 << pieceId) - 1;
    const usedLower = POPCOUNT_12[usedMask & lowerMask];
    const lessUnused = pieceId - usedLower;
    permRank = permRank * (12 - i) + lessUnused;
    usedMask |= 1 << pieceId;
    oriCode = (oriCode << 1) | (orientation[pos] & 1);
  }
  return permRank * 256 + oriCode;
}

function getF2LStateKey(data, ctx) {
  const cornerState = encodeF2LCornerState(data, ctx.f2lCornerPositions);
  const edgeState = encodeF2LEdgeState(data, ctx.f2lEdgePositions);
  return edgeState * 136080 + cornerState;
}

async function buildF2LContext() {
  const { getDefaultPattern } = await import("../solver/context.js");
  const solvedPattern = await getDefaultPattern("333");
  const solvedData = solvedPattern.patternData;
  const afterU = solvedPattern.applyMove("U").patternData;
  const afterD = solvedPattern.applyMove("D").patternData;

  const topEdgePositions = collectChangedPositions(solvedData.EDGES.pieces, afterU.EDGES.pieces);
  const topCornerPositions = collectChangedPositions(
    solvedData.CORNERS.pieces,
    afterU.CORNERS.pieces,
  );
  const bottomEdgePositions = collectChangedPositions(
    solvedData.EDGES.pieces,
    afterD.EDGES.pieces,
  );
  const topEdgeSet = new Set(topEdgePositions);
  const topCornerSet = new Set(topCornerPositions);
  const bottomEdgeSet = new Set(bottomEdgePositions);

  const f2lEdgePositions = [];
  for (let i = 0; i < solvedData.EDGES.pieces.length; i++) {
    if (!topEdgeSet.has(i)) f2lEdgePositions.push(i);
  }
  const f2lCornerPositions = [];
  for (let i = 0; i < solvedData.CORNERS.pieces.length; i++) {
    if (!topCornerSet.has(i)) f2lCornerPositions.push(i);
  }

  return {
    solvedPattern,
    solvedData,
    topEdgePositions,
    topCornerPositions,
    bottomEdgePositions,
    bottomEdgeSet,
    f2lEdgePositions,
    f2lCornerPositions,
  };
}

function addTransition(stateMap, fromKey, toKey) {
  const fromId = String(fromKey);
  const toId = String(toKey);
  let entry = stateMap.get(fromId);
  if (!entry) {
    entry = { total: 0, next: new Map() };
    stateMap.set(fromId, entry);
  }
  entry.total += 1;
  entry.next.set(toId, (entry.next.get(toId) || 0) + 1);
}

function serializeTransitionProfile(solver, stateMap, stats, opts) {
  const maxNextStates = Math.max(1, Number(opts.maxNextStates) || DEFAULT_MAX_NEXT_STATES);
  const smoothingAlpha = Math.max(0, Number(opts.smoothingAlpha) || DEFAULT_SMOOTHING_ALPHA);
  const states = [];
  let keptTransitionCount = 0;
  let droppedTransitionCount = 0;
  for (const [key, entry] of stateMap.entries()) {
    const nextEntries = Array.from(entry.next.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return Number(a[0]) - Number(b[0]);
    });
    const keptEntries = nextEntries.slice(0, maxNextStates);
    const keptCount = keptEntries.reduce((sum, [, count]) => sum + count, 0);
    const droppedCount = Math.max(0, entry.total - keptCount);
    keptTransitionCount += keptCount;
    droppedTransitionCount += droppedCount;
    states.push({
      key: Number(key),
      total: entry.total,
      uniqueNext: entry.next.size,
      keptCount,
      droppedCount,
      next: keptEntries.map(([nextKey, count]) => [Number(nextKey), count]),
    });
  }
  states.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.key - b.key;
  });

  return {
    solver,
    solveCount: stats.solveCount,
    relevantStepCount: stats.relevantStepCount,
    transitionCount: stats.transitionCount,
    stateCount: stateMap.size,
    maxNextStates,
    smoothingAlpha,
    keptTransitionCount,
    droppedTransitionCount,
    replayFailureCount: stats.replayFailureCount,
    skippedCount: stats.skippedCount,
    states,
  };
}

function buildTransitionProfile(rows, ctx, solverName, opts) {
  const stateMap = new Map();
  const stats = {
    solveCount: 0,
    relevantStepCount: 0,
    transitionCount: 0,
    replayFailureCount: 0,
    skippedCount: 0,
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== DEFAULT_PUZZLE) continue;
    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!opts.methodSet.has(method)) continue;
    const scramble = normalizeAlgorithmText(String(row.scramble || "").trim());
    if (!scramble) {
      stats.skippedCount += 1;
      continue;
    }
    const algorithmPlain = normalizeAlgorithmText(String(row.algorithmPlain || "").trim());
    if (!algorithmPlain) {
      stats.skippedCount += 1;
      continue;
    }
    const id = String(row.id || "").trim();
    const secondaryKey = buildSecondaryKey(scramble, algorithmPlain);
    if (opts.seenIds.has(id) || opts.seenSecondaryKeys.has(secondaryKey)) {
      continue;
    }
    if (id) opts.seenIds.add(id);
    opts.seenSecondaryKeys.add(secondaryKey);

    const steps = Array.isArray(row.steps)
      ? row.steps
          .map((step, index) => ({
            step,
            order: Number.isFinite(Number(step?.order)) ? Number(step.order) : index + 1,
          }))
          .sort((a, b) => a.order - b.order)
          .map((entry) => entry.step)
      : [];
    if (!steps.length) {
      stats.skippedCount += 1;
      continue;
    }

    let currentPattern = ctx.solvedPattern.applyAlg(scramble);
    if (!currentPattern) {
      stats.replayFailureCount += 1;
      continue;
    }

    let previousStateKey = null;
    let rowFailed = false;
    let rowRelevantStepCount = 0;

    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      const movesText = normalizeAlgorithmText(String(step?.moves || "").trim());
      if (movesText) {
        try {
          currentPattern = currentPattern.applyAlg(movesText);
        } catch (error) {
          rowFailed = true;
          break;
        }
      }

      const label = String(step?.label || "").trim();
      if (!isRelevantTransitionLabel(label)) {
        continue;
      }

      const stateKey = getF2LStateKey(currentPattern.patternData, ctx);
      rowRelevantStepCount += 1;
      if (previousStateKey !== null) {
        addTransition(stateMap, previousStateKey, stateKey);
        stats.transitionCount += 1;
      }
      previousStateKey = stateKey;
    }

    if (rowFailed) {
      stats.replayFailureCount += 1;
      continue;
    }

    if (rowRelevantStepCount > 0) {
      stats.solveCount += 1;
      stats.relevantStepCount += rowRelevantStepCount;
    } else {
      stats.skippedCount += 1;
    }
  }

  return serializeTransitionProfile(solverName, stateMap, stats, opts);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const records = loadRecords(opts.input);
  const methodSet = new Set(opts.methods);
  const seenIds = new Set();
  const seenSecondaryKeys = new Set();
  const ctx = await buildF2LContext();

  const filteredRows = [];
  const solverCounts = new Map();
  const methodCounts = new Map();
  const reconstructorCounts = new Map();
  let duplicateByIdCount = 0;
  let duplicateBySecondaryCount = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== opts.puzzle) continue;
    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!methodSet.has(method)) continue;
    const id = String(row.id || "").trim();
    const scramble = normalizeAlgorithmText(String(row.scramble || "").trim());
    const algorithmPlain = normalizeAlgorithmText(String(row.algorithmPlain || "").trim());
    const secondaryKey = buildSecondaryKey(scramble, algorithmPlain);
    if (id && seenIds.has(id)) {
      duplicateByIdCount += 1;
      continue;
    }
    if (seenSecondaryKeys.has(secondaryKey)) {
      duplicateBySecondaryCount += 1;
      continue;
    }
    if (id) seenIds.add(id);
    seenSecondaryKeys.add(secondaryKey);
    filteredRows.push(row);

    const solver = String(row?.meta?.solver || row?.solver || "").trim() || "UNKNOWN";
    const reconstructor = String(row?.meta?.reconstructor || row?.reconstructor || "").trim() || "UNKNOWN";
    solverCounts.set(solver, (solverCounts.get(solver) || 0) + 1);
    methodCounts.set(method, (methodCounts.get(method) || 0) + 1);
    reconstructorCounts.set(reconstructor, (reconstructorCounts.get(reconstructor) || 0) + 1);
  }

  const rowsBySolver = new Map();
  for (let i = 0; i < filteredRows.length; i++) {
    const row = filteredRows[i];
    const solver = String(row?.meta?.solver || row?.solver || "").trim() || "UNKNOWN";
    let bucket = rowsBySolver.get(solver);
    if (!bucket) {
      bucket = [];
      rowsBySolver.set(solver, bucket);
    }
    bucket.push(row);
  }

  const transitionProfiles = [];
  for (const [solver, rows] of rowsBySolver.entries()) {
    transitionProfiles.push(
      buildTransitionProfile(rows, ctx, solver, {
        methodSet,
        maxNextStates: opts.maxNextStates,
        smoothingAlpha: opts.smoothingAlpha,
        seenIds: new Set(),
        seenSecondaryKeys: new Set(),
      }),
    );
  }
  transitionProfiles.sort((a, b) => {
    const countDiff = Number(b.solveCount || 0) - Number(a.solveCount || 0);
    if (countDiff !== 0) return countDiff;
    return String(a.solver || "").localeCompare(String(b.solver || ""));
  });

  const globalTransitionProfile = buildTransitionProfile(filteredRows, ctx, "global", {
    methodSet,
    maxNextStates: opts.maxNextStates,
    smoothingAlpha: opts.smoothingAlpha,
    seenIds: new Set(),
    seenSecondaryKeys: new Set(),
  });

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceInput: opts.input,
    filter: {
      puzzle: opts.puzzle,
      methods: opts.methods,
      maxNextStates: opts.maxNextStates,
      smoothingAlpha: opts.smoothingAlpha,
      transitionLabelRule: "label contains cross|pair, excluding inspection",
    },
    totals: {
      records: records.length,
      filteredRecords: filteredRows.length,
      playerCount: transitionProfiles.length,
      methodCounts: Object.fromEntries(methodCounts.entries()),
      solverCounts: Object.fromEntries(solverCounts.entries()),
      reconstructorCounts: Object.fromEntries(reconstructorCounts.entries()),
      duplicateByIdCount,
      duplicateBySecondaryCount,
    },
    validation: {
      replayFailureCount: Number(globalTransitionProfile.replayFailureCount || 0),
      skippedCount: Number(globalTransitionProfile.skippedCount || 0),
      globalSolveCount: Number(globalTransitionProfile.solveCount || 0),
      globalTransitionCount: Number(globalTransitionProfile.transitionCount || 0),
    },
    globalTransitionProfile,
    playerTransitionProfiles: transitionProfiles,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
