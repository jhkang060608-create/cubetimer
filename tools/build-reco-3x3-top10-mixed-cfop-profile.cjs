#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DETAILS_INPUT_PRIMARY = path.join(
  ROOT_DIR,
  "vendor-data",
  "reco",
  "reco-all-3x3-gte100-details.json",
);
const DEFAULT_DETAILS_INPUT_SECONDARY = path.join(ROOT_DIR, "vendor-data", "reco", "reco-all-3x3-top10-details.json");
const DEFAULT_DETAILS_INPUT_FALLBACK = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const DEFAULT_DETAILS_INPUT = fs.existsSync(DEFAULT_DETAILS_INPUT_PRIMARY)
  ? DEFAULT_DETAILS_INPUT_PRIMARY
  : fs.existsSync(DEFAULT_DETAILS_INPUT_SECONDARY)
    ? DEFAULT_DETAILS_INPUT_SECONDARY
    : DEFAULT_DETAILS_INPUT_FALLBACK;
const DEFAULT_STYLE_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-details.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-mixed-cfop-profile.json");
const DEFAULT_PUZZLE = "3x3";
const DEFAULT_METHODS = ["CFOP", "ZB"];
const DEFAULT_MIN_SOLVES = 100;
const DEFAULT_STYLE_PROFILE = Object.freeze({
  preset: "top10-mixed",
  rotationWeight: 2,
  aufWeight: 1,
  wideTurnWeight: 1,
});
const SCHEMA_VERSION = "reco-mixed-cfop-profile.v2";
const SUPPORTED_PRIMARY_METHODS = new Set(["CFOP", "ZB"]);

function parseCsvList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback.slice();
}

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseArgs(argv) {
  const opts = {
    details: DEFAULT_DETAILS_INPUT,
    styleDetails: DEFAULT_STYLE_INPUT,
    output: DEFAULT_OUTPUT,
    puzzle: DEFAULT_PUZZLE,
    methods: DEFAULT_METHODS.slice(),
    minSolves: DEFAULT_MIN_SOLVES,
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

    if (flag === "--details") {
      opts.details = value || opts.details;
      if (consumeNext) i += 1;
    } else if (flag === "--style-details") {
      opts.styleDetails = value || opts.styleDetails;
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
        .filter((method) => SUPPORTED_PRIMARY_METHODS.has(method));
      if (!opts.methods.length) {
        opts.methods = DEFAULT_METHODS.slice();
      }
      if (consumeNext) i += 1;
    } else if (flag === "--min-solves") {
      opts.minSolves = Math.max(1, parseIntOrFallback(value, opts.minSolves));
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-top10-mixed-cfop-profile.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --details <path>        Input solve details JSON");
  console.log("  --style-details <path>  Input style details JSON");
  console.log("  --output <path>         Output mixed CFOP profile JSON");
  console.log("  --puzzle <name>         Puzzle filter (default: 3x3)");
  console.log("  --methods <csv>         Methods to include (default: CFOP)");
  console.log(`  --min-solves <n>        Minimum solves per player (default: ${DEFAULT_MIN_SOLVES})`);
}

function loadJsonFile(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  return JSON.parse(fs.readFileSync(inputPath, "utf8"));
}

function getRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  throw new Error("Input has no records array");
}

function getStylePlayers(payload) {
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.playerProfiles)) return payload.playerProfiles;
  return [];
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

function normalizeLabel(label) {
  return String(label || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function hashStringToUnitInterval(text) {
  const source = String(text || "");
  if (!source) return 0.5;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function countLabel(counts, label) {
  if (!label) return;
  counts[label] = (counts[label] || 0) + 1;
}

function emptySolveStats() {
  return {
    solveCount: 0,
    xcrossCount: 0,
    xxcrossCount: 0,
    crossCount: 0,
    zbllCount: 0,
    zblsCount: 0,
    firstStageXCrossCount: 0,
    firstStageXXCrossCount: 0,
    firstStageCrossCount: 0,
    stageLabelCounts: {},
    firstStageLabelCounts: {},
  };
}

function classifyFirstStageLabel(label) {
  const lower = normalizeLabel(label);
  if (!lower || lower === "inspection") return "";
  if (lower.includes("xxcross")) return "xxcross";
  if (lower.includes("xcross")) return "xcross";
  if (lower.includes("cross")) return "cross";
  if (lower.includes("pseudo")) return `pseudo ${lower.includes("xcross") ? "xcross" : "cross"}`;
  return lower;
}

function collectSolveStats(records, opts) {
  const methodSet = new Set(opts.methods);
  const summary = emptySolveStats();
  const perSolver = new Map();

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== opts.puzzle) continue;
    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!methodSet.has(method)) continue;

    const solver = String(row?.meta?.solver || row?.solver || "").trim();
    if (!solver) continue;
    const steps = Array.isArray(row.steps) ? row.steps : [];
    let firstStageLabel = "";
    const solveStats = perSolver.get(solver) || {
      ...emptySolveStats(),
    };

    for (let j = 0; j < steps.length; j++) {
      const step = steps[j];
      const label = normalizeLabel(step?.label || "");
      if (!label) continue;
      countLabel(summary.stageLabelCounts, label);
      countLabel(solveStats.stageLabelCounts, label);

      if (!firstStageLabel && label !== "inspection") {
        firstStageLabel = classifyFirstStageLabel(label);
      }

      if (label.includes("xxcross")) {
        summary.xxcrossCount += 1;
        summary.xcrossCount += 1;
        solveStats.xxcrossCount += 1;
        solveStats.xcrossCount += 1;
      } else if (label.includes("xcross")) {
        summary.xcrossCount += 1;
        solveStats.xcrossCount += 1;
      }

      if (label === "cross" || (label.includes("cross") && !label.includes("xcross"))) {
        summary.crossCount += 1;
        solveStats.crossCount += 1;
      }

      if (label.includes("zbll")) {
        summary.zbllCount += 1;
        solveStats.zbllCount += 1;
      }
      if (label.includes("zbls")) {
        summary.zblsCount += 1;
        solveStats.zblsCount += 1;
      }
    }

    if (!firstStageLabel) {
      firstStageLabel = "other";
    }
    countLabel(summary.firstStageLabelCounts, firstStageLabel);
    countLabel(solveStats.firstStageLabelCounts, firstStageLabel);

    if (firstStageLabel === "xcross") {
      summary.firstStageXCrossCount += 1;
      solveStats.firstStageXCrossCount += 1;
    } else if (firstStageLabel === "xxcross") {
      summary.firstStageXXCrossCount += 1;
      summary.firstStageXCrossCount += 1;
      solveStats.firstStageXXCrossCount += 1;
      solveStats.firstStageXCrossCount += 1;
    } else if (firstStageLabel === "cross") {
      summary.firstStageCrossCount += 1;
      solveStats.firstStageCrossCount += 1;
    }

    summary.solveCount += 1;
    solveStats.solveCount += 1;
    perSolver.set(solver, solveStats);
  }

  return { summary, perSolver };
}

function mergeSolveStats(target, source) {
  if (!target || !source) return;
  target.solveCount += Number(source.solveCount || 0);
  target.xcrossCount += Number(source.xcrossCount || 0);
  target.xxcrossCount += Number(source.xxcrossCount || 0);
  target.crossCount += Number(source.crossCount || 0);
  target.zbllCount += Number(source.zbllCount || 0);
  target.zblsCount += Number(source.zblsCount || 0);
  target.firstStageXCrossCount += Number(source.firstStageXCrossCount || 0);
  target.firstStageXXCrossCount += Number(source.firstStageXXCrossCount || 0);
  target.firstStageCrossCount += Number(source.firstStageCrossCount || 0);
  const stageLabels = source.stageLabelCounts || {};
  for (const [label, count] of Object.entries(stageLabels)) {
    target.stageLabelCounts[label] = (target.stageLabelCounts[label] || 0) + Number(count || 0);
  }
  const firstLabels = source.firstStageLabelCounts || {};
  for (const [label, count] of Object.entries(firstLabels)) {
    target.firstStageLabelCounts[label] = (target.firstStageLabelCounts[label] || 0) + Number(count || 0);
  }
}

function collectSolveStatsFromStageLabels(stageLabelCounts, solveCount) {
  const stats = emptySolveStats();
  stats.solveCount = Math.max(0, Math.floor(Number(solveCount) || 0));
  const entries =
    stageLabelCounts && typeof stageLabelCounts === "object" ? Object.entries(stageLabelCounts) : [];
  for (let i = 0; i < entries.length; i++) {
    const [rawLabel, rawCount] = entries[i];
    const label = normalizeLabel(rawLabel);
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (!label || count <= 0) continue;
    stats.stageLabelCounts[label] = (stats.stageLabelCounts[label] || 0) + count;
    if (label.includes("xxcross")) {
      stats.xxcrossCount += count;
      stats.xcrossCount += count;
    } else if (label.includes("xcross")) {
      stats.xcrossCount += count;
    }
    if (label === "cross" || (label.includes("cross") && !label.includes("xcross"))) {
      stats.crossCount += count;
    }
    if (label.includes("zbll")) stats.zbllCount += count;
    if (label.includes("zbls")) stats.zblsCount += count;
  }
  stats.firstStageXCrossCount = stats.xcrossCount;
  stats.firstStageXXCrossCount = stats.xxcrossCount;
  stats.firstStageCrossCount = Math.max(0, stats.solveCount - stats.firstStageXCrossCount);
  if (stats.firstStageCrossCount > 0) {
    stats.firstStageLabelCounts.cross = stats.firstStageCrossCount;
  }
  if (stats.firstStageXCrossCount > 0) {
    stats.firstStageLabelCounts.xcross = stats.firstStageXCrossCount;
  }
  if (stats.firstStageXXCrossCount > 0) {
    stats.firstStageLabelCounts.xxcross = stats.firstStageXXCrossCount;
  }
  return stats;
}

function buildStyleDerivedSolverStats(stylePlayers, opts) {
  const out = new Map();
  for (let i = 0; i < stylePlayers.length; i++) {
    const player = stylePlayers[i];
    const solver = String(player?.solver || "").trim();
    if (!solver) continue;
    const primaryMethod = String(player?.primaryMethod || "").trim().toUpperCase();
    if (!SUPPORTED_PRIMARY_METHODS.has(primaryMethod)) continue;
    const solveCount = Math.max(0, Math.floor(Number(player?.solveCount) || 0));
    if (solveCount < opts.minSolves) continue;
    const stats = collectSolveStatsFromStageLabels(player?.stageLabelCounts, solveCount);
    out.set(solver, stats);
  }
  return out;
}

function toCaseBias(summary) {
  if (!summary || typeof summary !== "object") return null;
  const mapRate = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(12, Math.round(1 + n * 11)));
  };
  return {
    xcrossWeight: mapRate(summary.xcrossRate),
    xxcrossWeight: mapRate(summary.xxcrossRate),
    zbllWeight: mapRate(summary.zbllRate),
    zblsWeight: mapRate(summary.zblsRate),
  };
}

function averageStyleProfile(players) {
  const weights = players
    .map((player) => player?.recommendedStyleProfile || player?.detailedStyleProfile || null)
    .filter(Boolean);
  if (!weights.length) return { ...DEFAULT_STYLE_PROFILE };
  const total = weights.reduce(
    (acc, profile) => {
      acc.rotationWeight += Number(profile.rotationWeight) || 0;
      acc.aufWeight += Number(profile.aufWeight) || 0;
      acc.wideTurnWeight += Number(profile.wideTurnWeight) || 0;
      return acc;
    },
    { rotationWeight: 0, aufWeight: 0, wideTurnWeight: 0 },
  );
  return {
    preset: "top10-mixed",
    rotationWeight: Math.max(0, Math.round(total.rotationWeight / weights.length)),
    aufWeight: Math.max(0, Math.round(total.aufWeight / weights.length)),
    wideTurnWeight: Math.max(0, Math.round(total.wideTurnWeight / weights.length)),
  };
}

function summarizeStats(stats) {
  const solveCount = Number(stats.solveCount || 0);
  const denom = solveCount > 0 ? solveCount : 1;
  return {
    solveCount,
    xcrossCount: Number(stats.xcrossCount || 0),
    xxcrossCount: Number(stats.xxcrossCount || 0),
    crossCount: Number(stats.crossCount || 0),
    zbllCount: Number(stats.zbllCount || 0),
    zblsCount: Number(stats.zblsCount || 0),
    firstStageXCrossCount: Number(stats.firstStageXCrossCount || 0),
    firstStageXXCrossCount: Number(stats.firstStageXXCrossCount || 0),
    firstStageCrossCount: Number(stats.firstStageCrossCount || 0),
    xcrossRate: Number((Number(stats.xcrossCount || 0) / denom).toFixed(6)),
    xxcrossRate: Number((Number(stats.xxcrossCount || 0) / denom).toFixed(6)),
    crossRate: Number((Number(stats.crossCount || 0) / denom).toFixed(6)),
    zbllRate: Number((Number(stats.zbllCount || 0) / denom).toFixed(6)),
    zblsRate: Number((Number(stats.zblsCount || 0) / denom).toFixed(6)),
    firstStageXCrossRate: Number((Number(stats.firstStageXCrossCount || 0) / denom).toFixed(6)),
    firstStageXXCrossRate: Number((Number(stats.firstStageXXCrossCount || 0) / denom).toFixed(6)),
    firstStageCrossRate: Number((Number(stats.firstStageCrossCount || 0) / denom).toFixed(6)),
    stageLabelCounts: stats.stageLabelCounts || {},
    firstStageLabelCounts: stats.firstStageLabelCounts || {},
  };
}

function buildScrambleListBySolver(records, opts) {
  const out = new Map();
  const methodSet = new Set(opts.methods);
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== opts.puzzle) continue;
    const method = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (!methodSet.has(method)) continue;
    const solver = String(row?.meta?.solver || row?.solver || "").trim();
    if (!solver) continue;
    const scramble = String(row.scramble || "").trim();
    if (!scramble) continue;
    let arr = out.get(solver);
    if (!arr) {
      arr = [];
      out.set(solver, arr);
    }
    arr.push(scramble);
  }
  return out;
}

function clampRate01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function computeCrossSamplingCalibration(mixedSummary, scrambles) {
  const n = Array.isArray(scrambles) ? scrambles.length : 0;
  if (!mixedSummary || n <= 0) {
    return {
      sampleCount: n,
      xcrossRateOffset: 0,
      xxcrossRateOffset: 0,
      targetXCrossRate: 0,
      targetXXCrossRate: 0,
      predictedXCrossRate: 0,
      predictedXXCrossRate: 0,
    };
  }
  const targetX = clampRate01(mixedSummary.xcrossRate);
  const targetXX = Math.min(targetX, clampRate01(mixedSummary.xxcrossRate));
  let predX = 0;
  let predXX = 0;
  for (let i = 0; i < scrambles.length; i++) {
    const r = hashStringToUnitInterval(scrambles[i]);
    if (r < targetXX) {
      predXX += 1;
      predX += 1;
    } else if (r < targetX) {
      predX += 1;
    }
  }
  const predictedXCrossRate = predX / n;
  const predictedXXCrossRate = predXX / n;
  const xcrossRateOffset = Number((targetX - predictedXCrossRate).toFixed(6));
  const xxcrossRateOffset = Number((targetXX - predictedXXCrossRate).toFixed(6));
  return {
    sampleCount: n,
    xcrossRateOffset: Math.max(-0.08, Math.min(0.08, xcrossRateOffset)),
    xxcrossRateOffset: Math.max(-0.05, Math.min(0.05, xxcrossRateOffset)),
    targetXCrossRate: Number(targetX.toFixed(6)),
    targetXXCrossRate: Number(targetXX.toFixed(6)),
    predictedXCrossRate: Number(predictedXCrossRate.toFixed(6)),
    predictedXXCrossRate: Number(predictedXXCrossRate.toFixed(6)),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const detailsPayload = loadJsonFile(opts.details);
  const stylePayload = loadJsonFile(opts.styleDetails);
  const records = getRecords(detailsPayload);
  const stylePlayers = getStylePlayers(stylePayload);
  const styleBySolver = new Map();
  for (let i = 0; i < stylePlayers.length; i++) {
    const player = stylePlayers[i];
    const solver = String(player?.solver || "").trim();
    if (!solver) continue;
    styleBySolver.set(solver, player);
  }

  const stylePerSolver = buildStyleDerivedSolverStats(stylePlayers, opts);
  const { perSolver: detailsPerSolver } = collectSolveStats(records, opts);
  const scramblesBySolver = buildScrambleListBySolver(records, opts);
  const eligiblePerSolver = new Map(stylePerSolver);
  for (const [solver, stats] of detailsPerSolver.entries()) {
    const stylePlayer = styleBySolver.get(solver) || null;
    const primaryMethod = String(stylePlayer?.primaryMethod || "").trim().toUpperCase();
    if (primaryMethod !== "CFOP") continue;
    if (Number(stats?.solveCount || 0) < opts.minSolves) continue;
    eligiblePerSolver.set(solver, stats);
  }
  const rawSummary = emptySolveStats();
  for (const [, stats] of eligiblePerSolver.entries()) {
    mergeSolveStats(rawSummary, stats);
  }
  const globalMixedCfopSummary = summarizeStats(rawSummary);
  const globalMixedCfopStyleProfile = averageStyleProfile(stylePlayers);

  const playerMixedCfopProfiles = Array.from(eligiblePerSolver.entries())
    .map(([solver, stats]) => {
      const stylePlayer = styleBySolver.get(solver) || {};
      const mixedCfopSummary = summarizeStats(stats);
      const primaryMethod = String(stylePlayer.primaryMethod || "CFOP").trim().toUpperCase();
      const forcePureCfop =
        Number(mixedCfopSummary.xcrossCount || 0) <= 0 && Number(mixedCfopSummary.zbllCount || 0) <= 0;
      const mixedStyleProfile =
        stylePlayer.recommendedStyleProfile ||
        stylePlayer.detailedStyleProfile ||
        stylePlayer.learnedStyleProfile ||
        globalMixedCfopStyleProfile;
      const recommendedF2LMethod = forcePureCfop ? "legacy" : stylePlayer.recommendedF2LMethod || "mixed";
      return {
        solver,
        solveCount: mixedCfopSummary.solveCount,
        primaryMethod,
        primaryMethodGroup: primaryMethod === "ZB" ? "ZB" : "CFOP",
        primaryMethodRatio: toFiniteNumber(stylePlayer.primaryMethodRatio, null),
        mixedEligible: SUPPORTED_PRIMARY_METHODS.has(primaryMethod),
        caseBias: toCaseBias(mixedCfopSummary),
        crossSamplingCalibration: computeCrossSamplingCalibration(
          mixedCfopSummary,
          scramblesBySolver.get(solver) || [],
        ),
        recommendedF2LMethod,
        forcePureCfop,
        pureCfopReason: forcePureCfop ? "NO_XCROSS_AND_NO_ZBLL" : "",
        mixedStyleProfile: forcePureCfop
          ? null
          : {
              preset: "top10-mixed",
              rotationWeight: Number(mixedStyleProfile.rotationWeight) || DEFAULT_STYLE_PROFILE.rotationWeight,
              aufWeight: Number(mixedStyleProfile.aufWeight) || DEFAULT_STYLE_PROFILE.aufWeight,
              wideTurnWeight: Number(mixedStyleProfile.wideTurnWeight) || DEFAULT_STYLE_PROFILE.wideTurnWeight,
            },
        mixedCfopSummary,
        stageLabelCounts: mixedCfopSummary.stageLabelCounts,
        firstStageLabelCounts: mixedCfopSummary.firstStageLabelCounts,
      };
    })
    .sort((a, b) => Number(b.solveCount || 0) - Number(a.solveCount || 0) || a.solver.localeCompare(b.solver));

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceDetailsInput: opts.details,
    sourceStyleDetailsInput: opts.styleDetails,
    minSolves: opts.minSolves,
    filter: {
      puzzle: opts.puzzle,
      methods: opts.methods,
      minSolves: opts.minSolves,
      llFocus: "XCross / ZBLL within CFOP",
    },
    totals: {
      records: records.length,
      playerCount: playerMixedCfopProfiles.length,
      cfopRecordCount: globalMixedCfopSummary.solveCount,
    },
    globalMixedCfopStyleProfile,
    globalMixedCfopSummary,
    globalMixedCfopProfile: {
      solver: "global",
      solveCount: globalMixedCfopSummary.solveCount,
      mixedStyleProfile: globalMixedCfopStyleProfile,
      mixedCfopSummary: globalMixedCfopSummary,
      stageLabelCounts: globalMixedCfopSummary.stageLabelCounts,
      firstStageLabelCounts: globalMixedCfopSummary.firstStageLabelCounts,
    },
    playerMixedCfopProfiles,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (players=${playerMixedCfopProfiles.length}, solves=${globalMixedCfopSummary.solveCount})`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
