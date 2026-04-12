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
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-f2l-ll-prediction.json");
const DEFAULT_PUZZLE = "3x3";
const DEFAULT_METHODS = ["CFOP", "ZB"];
const DEFAULT_SMOOTHING_ALPHA = 2;
const DEFAULT_MAX_CASES = 8;
const DEFAULT_MAX_FORMULAS = 12;
const SCHEMA_VERSION = "reco-f2l-ll-prediction.v3";
const FORMULA_ROTATIONS = ["", "y", "y2", "y'"];
const FORMULA_AUF = ["", "U", "U2", "U'"];
const FRAME_ROTATION_TOKENS = new Set(["x", "x2", "x'", "z", "z2", "z'"]);

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

function round6(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    puzzle: DEFAULT_PUZZLE,
    methods: DEFAULT_METHODS.slice(),
    smoothingAlpha: DEFAULT_SMOOTHING_ALPHA,
    maxCases: DEFAULT_MAX_CASES,
    maxFormulas: DEFAULT_MAX_FORMULAS,
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
    } else if (flag === "--smoothing-alpha") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) {
        opts.smoothingAlpha = n;
      }
      if (consumeNext) i += 1;
    } else if (flag === "--max-cases") {
      opts.maxCases = Math.max(1, parseIntOrFallback(value, opts.maxCases));
      if (consumeNext) i += 1;
    } else if (flag === "--max-formulas") {
      opts.maxFormulas = Math.max(1, parseIntOrFallback(value, opts.maxFormulas));
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-f2l-ll-prediction.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>           Input details JSON");
  console.log("  --output <path>          Output prediction JSON");
  console.log("  --puzzle <name>          Puzzle filter (default: 3x3)");
  console.log("  --methods <csv>          Methods to include (default: CFOP,ZB)");
  console.log("  --smoothing-alpha <n>    Smoothing pseudo-count against global prior (default: 2)");
  console.log("  --max-cases <n>          Keep top N LL case labels per state (default: 8)");
  console.log("  --max-formulas <n>       Keep top N LL formulas per state (default: 12)");
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

function invertToken(tok) {
  if (!tok) return tok;
  if (tok.endsWith("2")) return tok;
  if (tok.endsWith("'")) return tok.slice(0, -1);
  return `${tok}'`;
}

function invertRotation(rot) {
  if (!rot) return "";
  if (rot === "y2") return "y2";
  if (rot === "y") return "y'";
  if (rot === "y'") return "y";
  return "";
}

function buildFormulaCandidate(rot, preAuf, alg, postAuf = "") {
  return [rot, preAuf, alg, invertRotation(rot), postAuf].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function stripOuterFrameRotations(tokens) {
  let start = 0;
  let end = tokens.length;
  while (start < end && FRAME_ROTATION_TOKENS.has(tokens[start])) start += 1;
  while (end > start && FRAME_ROTATION_TOKENS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end);
}

function normalizeFormulaMatchText(text) {
  const tokens = splitMoveTokens(text)
    .map((token) => normalizeMoveToken(token))
    .filter(Boolean);
  return stripOuterFrameRotations(tokens).join(" ");
}

function normalizeCaseLabel(label) {
  return String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function classifyStepLabel(label) {
  const text = String(label || "").trim().toLowerCase();
  if (!text) return "other";
  if (text === "inspection" || text.startsWith("inspect")) return "inspection";
  if (text.includes("zbll") || /\bpll\b/.test(text)) return "pll";
  if (text.includes("zbls") || /\boll\b/.test(text)) return "oll";
  if (text.includes("cross") || text.includes("pair") || text === "f2l" || text === "f2l2") {
    return "f2l";
  }
  return "other";
}

function classifyLlFormulaFamily(label) {
  const text = String(label || "").trim().toLowerCase();
  if (!text) return "OTHER";
  if (text.includes("zbls")) return "ZBLS";
  if (text.includes("eo+zbll") || text.includes("zbll")) return "ZBLL";
  if (text.includes("epll") || text.includes("pll")) return "PLL";
  if (text.includes("oll")) return "OLL";
  return "OTHER";
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

  const topEdgePositions = collectChangedPositions(solvedData.EDGES.pieces, afterU.EDGES.pieces);
  const topCornerPositions = collectChangedPositions(
    solvedData.CORNERS.pieces,
    afterU.CORNERS.pieces,
  );

  const topEdgeSet = new Set(topEdgePositions);
  const topCornerSet = new Set(topCornerPositions);

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
    f2lEdgePositions,
    f2lCornerPositions,
  };
}

async function loadFormulaLibraries() {
  const [{ SCDB_CFOP_ALGS }, { ZB_FORMULAS }] = await Promise.all([
    import("../solver/scdbCfopAlgs.js"),
    import("../solver/zbDataset.js"),
  ]);

  function dedupeNormalizedFormulas(list) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const normalized = normalizeAlgorithmText(list[i]);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  return {
    OLL: dedupeNormalizedFormulas(SCDB_CFOP_ALGS.OLL || []),
    PLL: dedupeNormalizedFormulas(SCDB_CFOP_ALGS.PLL || []),
    ZBLL: dedupeNormalizedFormulas(ZB_FORMULAS.ZBLL || []),
    ZBLS: dedupeNormalizedFormulas(ZB_FORMULAS.ZBLS || []),
  };
}

function buildFormulaReverseIndex(formulaLibraries) {
  const result = {
    libraries: {},
    reverseMaps: {},
  };

  for (const family of Object.keys(formulaLibraries || {})) {
    const formulas = Array.isArray(formulaLibraries[family]) ? formulaLibraries[family] : [];
    const reverseMap = new Map();
    const entries = [];
    for (let i = 0; i < formulas.length; i++) {
      const formula = normalizeAlgorithmText(formulas[i]);
      if (!formula) continue;
      const entry = {
        family,
        formula,
        index: i,
        key: `${family}:${i}`,
      };
      entries.push(entry);
      for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
        const rot = FORMULA_ROTATIONS[r];
        for (let a = 0; a < FORMULA_AUF.length; a++) {
          const preAuf = FORMULA_AUF[a];
          for (let p = 0; p < FORMULA_AUF.length; p++) {
            const postAuf = FORMULA_AUF[p];
            const candidate = normalizeFormulaMatchText(buildFormulaCandidate(rot, preAuf, formula, postAuf));
            if (!candidate) continue;
            const existing = reverseMap.get(candidate);
            if (!existing || entry.index < existing.index) {
              reverseMap.set(candidate, entry);
            }
          }
        }
      }
    }
    result.libraries[family] = entries;
    result.reverseMaps[family] = reverseMap;
  }

  return result;
}

function createStateAccumulator() {
  return {
    sampleCount: 0,
    ollMoveSum: 0,
    pllMoveSum: 0,
    llMoveSum: 0,
    caseCounts: new Map(),
    formulaCounts: new Map(),
    formulaVariantCounts: new Map(),
  };
}

function addCaseCount(caseCounts, caseTag) {
  if (!caseTag) return;
  caseCounts.set(caseTag, (caseCounts.get(caseTag) || 0) + 1);
}

function addFormulaCount(formulaCounts, family, formula) {
  if (!formulaCounts || !family || !formula) return;
  const key = `${family}::${formula}`;
  const existing = formulaCounts.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  formulaCounts.set(key, { family, formula, count: 1 });
}

function addFormulaVariantCount(formulaVariantCounts, family, canonicalFormula, variantFormula) {
  if (!formulaVariantCounts || !family || !canonicalFormula || !variantFormula) return;
  const key = `${family}::${canonicalFormula}::${variantFormula}`;
  const existing = formulaVariantCounts.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  formulaVariantCounts.set(key, {
    family,
    canonicalFormula,
    formula: variantFormula,
    count: 1,
  });
}

function addStateSample(stateMap, stateKey, sample) {
  const key = String(stateKey);
  let acc = stateMap.get(key);
  if (!acc) {
    acc = createStateAccumulator();
    stateMap.set(key, acc);
  }
  acc.sampleCount += 1;
  acc.ollMoveSum += sample.ollMoveCount;
  acc.pllMoveSum += sample.pllMoveCount;
  acc.llMoveSum += sample.llMoveCount;
  addCaseCount(acc.caseCounts, sample.firstCaseTag);
  if (sample.formulaFamily && sample.formulaKey) {
    addFormulaCount(acc.formulaCounts, sample.formulaFamily, sample.formulaKey);
  }
  if (
    sample.formulaVariantFamily &&
    sample.formulaCanonicalKey &&
    sample.formulaVariantKey &&
    sample.formulaVariantKey !== sample.formulaCanonicalKey
  ) {
    addFormulaVariantCount(
      acc.formulaVariantCounts,
      sample.formulaVariantFamily,
      sample.formulaCanonicalKey,
      sample.formulaVariantKey,
    );
  }
}

function matchFormulaForStep(movesText, family, formulaIndex) {
  if (!formulaIndex || !family) return null;
  const normalizedStep = normalizeFormulaMatchText(movesText);
  if (!normalizedStep) return null;
  const reverseMap = formulaIndex.reverseMaps?.[family];
  if (!reverseMap) return null;
  const entry = reverseMap.get(normalizedStep);
  if (entry) return entry;

  const tokens = splitMoveTokens(normalizedStep);
  if (tokens.length > 1) {
    const stripped = stripOuterFrameRotations(tokens).join(" ");
    if (stripped && stripped !== normalizedStep) {
      return reverseMap.get(stripped) || null;
    }
  }
  return null;
}

function createProfileStats() {
  return {
    solveCount: 0,
    replayFailureCount: 0,
    skippedCount: 0,
  };
}

function computeRawMeans(stateMap) {
  let sampleCount = 0;
  let ollMoveSum = 0;
  let pllMoveSum = 0;
  let llMoveSum = 0;
  for (const acc of stateMap.values()) {
    sampleCount += acc.sampleCount;
    ollMoveSum += acc.ollMoveSum;
    pllMoveSum += acc.pllMoveSum;
    llMoveSum += acc.llMoveSum;
  }
  const denom = Math.max(1, sampleCount);
  return {
    sampleCount,
    expectedOllMoves: ollMoveSum / denom,
    expectedPllMoves: pllMoveSum / denom,
    expectedLlMoves: llMoveSum / denom,
  };
}

function serializeDownstreamProfile(solver, stateMap, stats, opts, priorMeans = null) {
  const ownMeans = computeRawMeans(stateMap);
  const globalPrior = priorMeans && priorMeans.sampleCount > 0 ? priorMeans : ownMeans;
  const alpha = Math.max(0, Number(opts.smoothingAlpha) || DEFAULT_SMOOTHING_ALPHA);
  const maxCases = Math.max(1, Number(opts.maxCases) || DEFAULT_MAX_CASES);
  const maxFormulas = Math.max(1, Number(opts.maxFormulas) || DEFAULT_MAX_FORMULAS);

  const baselineOll = Number(globalPrior.expectedOllMoves) || 0;
  const baselinePll = Number(globalPrior.expectedPllMoves) || 0;
  const baselineLl = Number(globalPrior.expectedLlMoves) || baselineOll + baselinePll;

  const states = [];
  for (const [key, acc] of stateMap.entries()) {
    if (!acc.sampleCount) continue;
    const denom = acc.sampleCount + alpha;
    const expectedOllMoves = denom > 0 ? (acc.ollMoveSum + alpha * baselineOll) / denom : baselineOll;
    const expectedPllMoves = denom > 0 ? (acc.pllMoveSum + alpha * baselinePll) / denom : baselinePll;
    const expectedLlMoves = denom > 0 ? (acc.llMoveSum + alpha * baselineLl) / denom : baselineLl;

    const topCases = Array.from(acc.caseCounts.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return String(a[0]).localeCompare(String(b[0]));
      })
      .slice(0, maxCases);

    const formulaFamilyCounts = {};
    const formulaEntries = Array.from(acc.formulaCounts.values())
      .map((entry) => ({
        family: String(entry.family || "OTHER"),
        formula: String(entry.formula || ""),
        count: Number(entry.count || 0),
      }))
      .filter((entry) => entry.formula && Number.isFinite(entry.count) && entry.count > 0)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const familyCmp = a.family.localeCompare(b.family);
        if (familyCmp !== 0) return familyCmp;
        return a.formula.localeCompare(b.formula);
      });
    for (let i = 0; i < formulaEntries.length; i++) {
      const entry = formulaEntries[i];
      formulaFamilyCounts[entry.family] = (formulaFamilyCounts[entry.family] || 0) + entry.count;
    }
    const topFormulas = formulaEntries.slice(0, maxFormulas);

    const formulaVariantEntries = Array.from(acc.formulaVariantCounts.values())
      .map((entry) => ({
        family: String(entry.family || "OTHER"),
        canonicalFormula: String(entry.canonicalFormula || ""),
        formula: String(entry.formula || ""),
        count: Number(entry.count || 0),
      }))
      .filter(
        (entry) =>
          entry.formula &&
          entry.canonicalFormula &&
          entry.formula !== entry.canonicalFormula &&
          Number.isFinite(entry.count) &&
          entry.count > 0,
      )
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const familyCmp = a.family.localeCompare(b.family);
        if (familyCmp !== 0) return familyCmp;
        const canonicalCmp = a.canonicalFormula.localeCompare(b.canonicalFormula);
        if (canonicalCmp !== 0) return canonicalCmp;
        return a.formula.localeCompare(b.formula);
      });
    const topFormulaVariants = formulaVariantEntries.slice(0, maxFormulas * 2);

    states.push({
      key: Number(key),
      sampleCount: acc.sampleCount,
      expectedOllMoves: round6(expectedOllMoves),
      expectedPllMoves: round6(expectedPllMoves),
      expectedLlMoves: round6(expectedLlMoves),
      deltaExpectedLlMoves: round6(expectedLlMoves - baselineLl),
      topCases,
      formulaFamilyCounts,
      topFormulas,
      topFormulaVariants,
    });
  }

  states.sort((a, b) => {
    if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
    return a.key - b.key;
  });

  return {
    solver,
    solveCount: stats.solveCount,
    replayFailureCount: stats.replayFailureCount,
    skippedCount: stats.skippedCount,
    stateCount: stateMap.size,
    smoothingAlpha: alpha,
    globalExpectedOllMoves: round6(baselineOll),
    globalExpectedPllMoves: round6(baselinePll),
    globalExpectedLlMoves: round6(baselineLl),
    profileExpectedOllMoves: round6(ownMeans.expectedOllMoves),
    profileExpectedPllMoves: round6(ownMeans.expectedPllMoves),
    profileExpectedLlMoves: round6(ownMeans.expectedLlMoves),
    states,
  };
}

async function buildDownstreamProfiles(rows, ctx, opts, formulaIndex = null) {
  const methodSet = new Set(opts.methods);
  const seenIds = new Set();
  const seenSecondaryKeys = new Set();

  const globalStateMap = new Map();
  const globalStats = createProfileStats();
  const perSolverStateMap = new Map();
  const perSolverStats = new Map();

  let duplicateByIdCount = 0;
  let duplicateBySecondaryCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.ok) continue;

    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== opts.puzzle) continue;

    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!methodSet.has(method)) continue;

    const scramble = normalizeAlgorithmText(String(row.scramble || "").trim());
    const algorithmPlain = normalizeAlgorithmText(String(row.algorithmPlain || "").trim());
    if (!scramble || !algorithmPlain) {
      globalStats.skippedCount += 1;
      continue;
    }

    const id = String(row.id || "").trim();
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
      globalStats.skippedCount += 1;
      continue;
    }

    const solver = String(row?.meta?.solver || row?.solver || "").trim() || "UNKNOWN";
    if (!perSolverStateMap.has(solver)) {
      perSolverStateMap.set(solver, new Map());
      perSolverStats.set(solver, createProfileStats());
    }

    let currentPattern;
    try {
      currentPattern = ctx.solvedPattern.applyAlg(scramble);
    } catch (_) {
      globalStats.replayFailureCount += 1;
      const solverStats = perSolverStats.get(solver);
      solverStats.replayFailureCount += 1;
      continue;
    }

    let llStarted = false;
    let llStateKey = null;
    let firstCaseTag = "";
    let firstFormulaFamily = null;
    let firstFormulaKey = null;
    let firstFormulaVariantKey = null;
    let ollMoveCount = 0;
    let pllMoveCount = 0;
    let llMoveCount = 0;
    let rowFailed = false;

    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      const label = String(step?.label || "").trim();
      const labelKind = classifyStepLabel(label);
      const formulaFamily = classifyLlFormulaFamily(label);
      const movesText = normalizeAlgorithmText(String(step?.moves || "").trim());
      const moveCount = movesText ? splitMoveTokens(movesText).length : 0;

      if (!llStarted && (labelKind === "oll" || labelKind === "pll")) {
        llStarted = true;
        llStateKey = getF2LStateKey(currentPattern.patternData, ctx);
        firstCaseTag = normalizeCaseLabel(label) || (labelKind === "pll" ? "PLL" : "OLL");
      }

      if (llStarted && moveCount > 0) {
        llMoveCount += moveCount;
        if (labelKind === "oll") {
          ollMoveCount += moveCount;
        } else if (labelKind === "pll") {
          pllMoveCount += moveCount;
        }
      }
      if (
        llStarted &&
        !firstFormulaKey &&
        formulaIndex &&
        formulaFamily !== "OTHER" &&
        (labelKind === "oll" || labelKind === "pll")
      ) {
        const formulaMatch = matchFormulaForStep(movesText, formulaFamily, formulaIndex);
        if (formulaMatch) {
          firstFormulaFamily = formulaMatch.family;
          firstFormulaKey = formulaMatch.formula;
          firstFormulaVariantKey = movesText;
        }
      }

      if (movesText) {
        try {
          currentPattern = currentPattern.applyAlg(movesText);
        } catch (_) {
          rowFailed = true;
          break;
        }
      }
    }

    const solverStats = perSolverStats.get(solver);
    if (rowFailed) {
      globalStats.replayFailureCount += 1;
      solverStats.replayFailureCount += 1;
      continue;
    }

    if (!llStarted || llStateKey === null || llMoveCount <= 0) {
      globalStats.skippedCount += 1;
      solverStats.skippedCount += 1;
      continue;
    }

    const sample = {
      ollMoveCount,
      pllMoveCount,
      llMoveCount,
      firstCaseTag,
      formulaFamily: firstFormulaFamily,
      formulaKey: firstFormulaKey,
      formulaVariantFamily: firstFormulaFamily,
      formulaCanonicalKey: firstFormulaKey,
      formulaVariantKey: firstFormulaVariantKey,
    };

    addStateSample(globalStateMap, llStateKey, sample);
    addStateSample(perSolverStateMap.get(solver), llStateKey, sample);
    globalStats.solveCount += 1;
    solverStats.solveCount += 1;
  }

  const globalPriorMeans = computeRawMeans(globalStateMap);
  const globalDownstreamProfile = serializeDownstreamProfile(
    "global",
    globalStateMap,
    globalStats,
    opts,
    globalPriorMeans,
  );

  const playerDownstreamProfiles = Array.from(perSolverStateMap.entries())
    .map(([solver, stateMap]) =>
      serializeDownstreamProfile(
        solver,
        stateMap,
        perSolverStats.get(solver),
        opts,
        globalPriorMeans,
      ),
    )
    .sort((a, b) => {
      if (b.solveCount !== a.solveCount) return b.solveCount - a.solveCount;
      return String(a.solver || "").localeCompare(String(b.solver || ""));
    });

  return {
    globalDownstreamProfile,
    playerDownstreamProfiles,
    duplicateByIdCount,
    duplicateBySecondaryCount,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const records = loadRecords(opts.input);
  const ctx = await buildF2LContext();
  const formulaLibraries = await loadFormulaLibraries();
  const formulaIndex = buildFormulaReverseIndex(formulaLibraries);

  const methodCounts = new Map();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!method) continue;
    methodCounts.set(method, (methodCounts.get(method) || 0) + 1);
  }

  const {
    globalDownstreamProfile,
    playerDownstreamProfiles,
    duplicateByIdCount,
    duplicateBySecondaryCount,
  } = await buildDownstreamProfiles(records, ctx, opts, formulaIndex);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceInput: opts.input,
    filter: {
      puzzle: opts.puzzle,
      methods: opts.methods,
      smoothingAlpha: opts.smoothingAlpha,
      maxCases: opts.maxCases,
      maxFormulas: opts.maxFormulas,
      llBoundaryRule: "first step label matching OLL|PLL|ZBLS|ZBLL",
      formulaRule: "match normalized LL moves against SCDB/ZB formula libraries and per-player variants",
    },
    totals: {
      records: records.length,
      playerCount: playerDownstreamProfiles.length,
      methodCounts: Object.fromEntries(methodCounts.entries()),
      duplicateByIdCount,
      duplicateBySecondaryCount,
    },
    validation: {
      replayFailureCount: Number(globalDownstreamProfile.replayFailureCount || 0),
      skippedCount: Number(globalDownstreamProfile.skippedCount || 0),
      globalSolveCount: Number(globalDownstreamProfile.solveCount || 0),
      globalStateCount: Number(globalDownstreamProfile.stateCount || 0),
    },
    globalDownstreamProfile,
    playerDownstreamProfiles,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
