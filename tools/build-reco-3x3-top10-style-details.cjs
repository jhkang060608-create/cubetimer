#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-profiles.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-details.json");
const SUPPORTED_PRIMARY_METHODS = new Set(["CFOP", "ZB"]);

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    top: 0,
    minSolves: 100,
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
    } else if (flag === "--top") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) opts.top = Math.max(0, n);
      if (consumeNext) i += 1;
    } else if (flag === "--min-solves") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) opts.minSolves = Math.max(1, n);
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-top10-style-details.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>       Input style profile JSON (default: vendor-data/reco/reco-3x3-style-profiles.json)");
  console.log("  --output <path>      Output detailed style JSON");
  console.log("  --top <n>            Number of top players by solveCount (default: 0 = all)");
  console.log("  --min-solves <n>     Minimum solves to keep player in candidate pool (default: 100)");
}

function loadProfilePayload(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const players = Array.isArray(parsed?.playerProfiles)
    ? parsed.playerProfiles
    : Array.isArray(parsed?.players)
      ? parsed.players
      : [];
  if (!players.length) {
    throw new Error(`Input has no players array: ${inputPath}`);
  }
  return {
    ...parsed,
    players,
  };
}

function toFiniteNumber(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  const intN = Math.round(n);
  return Math.max(min, Math.min(max, intN));
}

function safePercent(value) {
  if (!Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(3));
}

function rateBounds(players, key) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < players.length; i++) {
    const v = toFiniteNumber(players[i]?.[key], null);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (max <= min) {
    return { min, max: min + 1e-6 };
  }
  return { min, max };
}

function mapRateToPenaltyWeight(rate, bounds) {
  const value = toFiniteNumber(rate, null);
  if (value === null) return 2;
  const span = bounds.max - bounds.min;
  const normalized = span > 0 ? (value - bounds.min) / span : 0.5;
  const lowRatePreference = 1 - normalized;
  return clampInt(2 + lowRatePreference * 10, 1, 12);
}

function mapCaseRateToWeight(rate) {
  const value = toFiniteNumber(rate, 0) || 0;
  return clampInt(1 + value * 11, 1, 12);
}

function countCaseLabels(stageLabelCounts) {
  const out = {
    xcrossCount: 0,
    xxcrossCount: 0,
    zbllCount: 0,
    zblsCount: 0,
  };
  const entries =
    stageLabelCounts && typeof stageLabelCounts === "object" ? Object.entries(stageLabelCounts) : [];
  for (let i = 0; i < entries.length; i++) {
    const [rawLabel, rawCount] = entries[i];
    const label = String(rawLabel || "").trim().toLowerCase();
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (!label || count <= 0) continue;
    if (label.includes("xxcross")) {
      out.xxcrossCount += count;
      out.xcrossCount += count;
    } else if (label.includes("xcross")) {
      out.xcrossCount += count;
    }
    if (label.includes("zbll")) out.zbllCount += count;
    if (label.includes("zbls")) out.zblsCount += count;
  }
  return out;
}

function getPrimaryMethodGroup(primaryMethod) {
  const method = String(primaryMethod || "").trim().toUpperCase();
  return method === "ZB" ? "ZB" : "CFOP";
}

function makeDetailedStyleProfile(player, bounds) {
  const preset = typeof player?.recommendedF2LMethod === "string" && player.recommendedF2LMethod
    ? player.recommendedF2LMethod
    : "balanced";
  return {
    preset,
    rotationWeight: mapRateToPenaltyWeight(player.rotationRate, bounds.rotation),
    aufWeight: mapRateToPenaltyWeight(player.aufRate, bounds.auf),
    wideTurnWeight: mapRateToPenaltyWeight(player.wideTurnRate, bounds.wide),
  };
}

function buildPlayerDetail(player, detailedStyleProfile) {
  const solveCount = Number(player.solveCount || 0);
  const caseCounts = countCaseLabels(player.stageLabelCounts);
  const denom = solveCount > 0 ? solveCount : 1;
  const xcrossRate = Number((caseCounts.xcrossCount / denom).toFixed(6));
  const xxcrossRate = Number((caseCounts.xxcrossCount / denom).toFixed(6));
  const zbllRate = Number((caseCounts.zbllCount / denom).toFixed(6));
  const zblsRate = Number((caseCounts.zblsCount / denom).toFixed(6));
  const caseBias = {
    xcrossWeight: mapCaseRateToWeight(xcrossRate),
    xxcrossWeight: mapCaseRateToWeight(xxcrossRate),
    zbllWeight: mapCaseRateToWeight(zbllRate),
    zblsWeight: mapCaseRateToWeight(zblsRate),
  };
  const primaryMethodGroup = getPrimaryMethodGroup(player.primaryMethod);
  const mixedEligible = primaryMethodGroup === "CFOP" || primaryMethodGroup === "ZB";
  return {
    solver: player.solver,
    solveCount,
    primaryMethod: player.primaryMethod || "UNKNOWN",
    primaryMethodGroup,
    primaryMethodRatio: toFiniteNumber(player.primaryMethodRatio, null),
    mixedEligible,
    recommendedF2LMethod: player.recommendedF2LMethod || "legacy",
    recommendedStyleProfile: player.recommendedStyleProfile || null,
    detailedStyleProfile,
    caseBias,
    caseRates: {
      xcrossRate,
      xxcrossRate,
      zbllRate,
      zblsRate,
    },
    coverage: {
      totalSolves: solveCount,
      benchmarkSamples: null,
      benchmarkModes: [],
    },
    styleFingerprint: {
      avgMoveCount: toFiniteNumber(player.avgMoveCount, null),
      avgRotationCount: toFiniteNumber(player.avgRotationCount, null),
      avgAufCount: toFiniteNumber(player.avgAufCount, null),
      avgWideTurnCount: toFiniteNumber(player.avgWideTurnCount, null),
      rotationRate: toFiniteNumber(player.rotationRate, null),
      aufRate: toFiniteNumber(player.aufRate, null),
      wideTurnRate: toFiniteNumber(player.wideTurnRate, null),
      avgF2LSegmentLen: toFiniteNumber(player.avgF2LSegmentLen, null),
      zbUsageRate: toFiniteNumber(player.zbUsageRate, null),
      rotationRatePct: safePercent(player.rotationRate),
      aufRatePct: safePercent(player.aufRate),
      wideTurnRatePct: safePercent(player.wideTurnRate),
    },
    stageLabelCounts: player.stageLabelCounts || {},
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const source = loadProfilePayload(opts.input);
  const rawPlayers = Array.isArray(source.players) ? source.players : [];
  const candidates = rawPlayers
    .filter((player) => player && typeof player.solver === "string" && player.solver.trim())
    .filter((player) => SUPPORTED_PRIMARY_METHODS.has(String(player.primaryMethod || "").trim().toUpperCase()))
    .filter((player) => Number(player.solveCount || 0) >= opts.minSolves)
    .sort((a, b) => Number(b.solveCount || 0) - Number(a.solveCount || 0) || String(a.solver).localeCompare(String(b.solver)));

  const topPlayers = opts.top > 0 ? candidates.slice(0, opts.top) : candidates.slice();

  const bounds = {
    rotation: rateBounds(candidates, "rotationRate"),
    auf: rateBounds(candidates, "aufRate"),
    wide: rateBounds(candidates, "wideTurnRate"),
  };

  const detailedPlayers = topPlayers.map((player) => {
    const detailedStyleProfile = makeDetailedStyleProfile(player, bounds);
    return buildPlayerDetail(player, detailedStyleProfile);
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceInput: opts.input,
    sourceGeneratedAt: source.generatedAt || "",
    sourceSchemaVersion: source.schemaVersion || "",
    puzzle: "3x3",
    method: "CFOP+ZB",
    profileScope: opts.top > 0 ? `top-${opts.top}` : "all",
    minSolves: opts.minSolves,
    candidatePlayerCount: candidates.length,
    playerCount: detailedPlayers.length,
    distanceConfig: source.distanceConfig || null,
    players: detailedPlayers,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (${detailedPlayers.length} players)`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
