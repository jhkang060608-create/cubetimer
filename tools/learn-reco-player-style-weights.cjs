#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BENCHMARK = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-benchmark.json");
const DEFAULT_PLAYERS = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-details.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-learned-style-weights.json");

const STYLE_TO_VECTOR = Object.freeze({
  legacy: { rotationWeight: 0, aufWeight: 0, wideTurnWeight: 0 },
  balanced: { rotationWeight: 2, aufWeight: 1, wideTurnWeight: 1 },
  rotationless: { rotationWeight: 5, aufWeight: 1, wideTurnWeight: 2 },
  "low-auf": { rotationWeight: 1, aufWeight: 4, wideTurnWeight: 1 },
});

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
    benchmarks: [DEFAULT_BENCHMARK],
    players: DEFAULT_PLAYERS,
    output: DEFAULT_OUTPUT,
    modes: ["strict"],
    minSamples: 10,
    objective: "conservative",
    aggressiveBlend: 0.85,
    aggressiveExtrapolation: 1.35,
    targetOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    const [flag, inline] = arg.split("=", 2);
    const value = inline !== undefined ? inline : argv[i + 1];
    const consumeNext = inline === undefined;

    if (flag === "--benchmark") {
      opts.benchmarks = [value || opts.benchmarks[0]];
      if (consumeNext) i += 1;
    } else if (flag === "--benchmarks") {
      opts.benchmarks = parseCsvList(value, opts.benchmarks);
      if (consumeNext) i += 1;
    } else if (flag === "--players") {
      opts.players = value || opts.players;
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    } else if (flag === "--mode") {
      const mode = String(value || opts.modes[0] || "strict").trim().toLowerCase();
      if (mode === "strict" || mode === "zb") {
        opts.modes = [mode];
      }
      if (consumeNext) i += 1;
    } else if (flag === "--modes") {
      opts.modes = parseCsvList(value, opts.modes)
        .map((mode) => mode.toLowerCase())
        .filter((mode) => mode === "strict" || mode === "zb");
      if (!opts.modes.length) {
        opts.modes = ["strict"];
      }
      if (consumeNext) i += 1;
    } else if (flag === "--min-samples") {
      opts.minSamples = Math.max(1, parseIntOrFallback(value, opts.minSamples));
      if (consumeNext) i += 1;
    } else if (flag === "--objective") {
      opts.objective = String(value || opts.objective || "conservative").trim().toLowerCase();
      if (consumeNext) i += 1;
    } else if (flag === "--aggressive-blend") {
      const n = Number(value);
      if (Number.isFinite(n)) opts.aggressiveBlend = Math.max(0, Math.min(1, n));
      if (consumeNext) i += 1;
    } else if (flag === "--aggressive-extrapolation") {
      const n = Number(value);
      if (Number.isFinite(n)) opts.aggressiveExtrapolation = Math.max(1, Math.min(3, n));
      if (consumeNext) i += 1;
    } else if (flag === "--target-only") {
      const normalized = String(value || "true").trim().toLowerCase();
      opts.targetOnly = !(normalized === "0" || normalized === "false" || normalized === "no");
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/learn-reco-player-style-weights.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --benchmark <path>    Benchmark JSON input");
  console.log("  --benchmarks <csv>    Multiple benchmark JSON inputs");
  console.log("  --players <path>      Top players/style details JSON input");
  console.log("  --output <path>       Output learned style JSON");
  console.log("  --mode <strict|zb>    Benchmark mode to learn from (default: strict)");
  console.log("  --modes <csv>         Benchmark modes to learn from (default: strict)");
  console.log("  --min-samples <n>     Minimum solved samples per style per player (default: 10)");
  console.log("  --objective <name>    conservative | aggressive (default: conservative)");
  console.log("  --aggressive-blend <n> Blend ratio for aggressive target-chasing objective (default: 0.85)");
  console.log("  --aggressive-extrapolation <n> Extrapolation factor for out-of-range target rates (default: 1.35)");
  console.log("  --target-only <bool>  Learn from target fingerprints only (skip benchmark observation fitting)");
}

function loadJsonOrThrow(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function getTargetFingerprint(player) {
  const fp = player && player.styleFingerprint && typeof player.styleFingerprint === "object"
    ? player.styleFingerprint
    : player;
  if (!fp || typeof fp !== "object") return null;
  const rotationRate = Number(fp.rotationRate);
  const aufRate = Number(fp.aufRate);
  const wideTurnRate = Number(fp.wideTurnRate);
  if (!Number.isFinite(rotationRate) || !Number.isFinite(aufRate) || !Number.isFinite(wideTurnRate)) {
    return null;
  }
  return { rotationRate, aufRate, wideTurnRate };
}

function squaredDistance(a, b) {
  const dr = a.rotationRate - b.rotationRate;
  const da = a.aufRate - b.aufRate;
  const dw = a.wideTurnRate - b.wideTurnRate;
  return dr * dr + da * da + dw * dw;
}

function collectRunsByModesAndStyle(benchmarks, modes) {
  const out = {};
  const benchmarkDocs = Array.isArray(benchmarks) ? benchmarks : [];
  const selectedModes = Array.isArray(modes) && modes.length ? modes : ["strict"];
  for (let b = 0; b < benchmarkDocs.length; b++) {
    const benchmark = benchmarkDocs[b];
    if (!benchmark || typeof benchmark !== "object") continue;
    for (let m = 0; m < selectedModes.length; m++) {
      const mode = selectedModes[m];
      if (benchmark.runsByMode && benchmark.runsByMode[mode]) {
        const styleMap = benchmark.runsByMode[mode];
        const styleNames = Object.keys(styleMap);
        for (let i = 0; i < styleNames.length; i++) {
          const style = styleNames[i];
          const rows = Array.isArray(styleMap[style]) ? styleMap[style] : [];
          if (!out[style]) out[style] = [];
          out[style].push(...rows);
        }
        continue;
      }
      if (selectedModes.length === 1 && benchmark.runsByStyle) {
        const styleNames = Object.keys(benchmark.runsByStyle);
        for (let i = 0; i < styleNames.length; i++) {
          const style = styleNames[i];
          const rows = Array.isArray(benchmark.runsByStyle[style]) ? benchmark.runsByStyle[style] : [];
          if (!out[style]) out[style] = [];
          out[style].push(...rows);
        }
      }
    }
  }
  return out;
}

function aggregateStyleMetricsForSolver(runs, solverName) {
  const solved = [];
  for (let i = 0; i < runs.length; i++) {
    const row = runs[i];
    if (!row || !row.ok) continue;
    if (String(row.sourceSolver || "").trim() !== solverName) continue;
    if (!row.styleMetrics || typeof row.styleMetrics !== "object") continue;
    const rot = Number(row.styleMetrics.rotationRate);
    const auf = Number(row.styleMetrics.aufRate);
    const wide = Number(row.styleMetrics.wideTurnRate);
    if (!Number.isFinite(rot) || !Number.isFinite(auf) || !Number.isFinite(wide)) continue;
    solved.push({
      rotationRate: rot,
      aufRate: auf,
      wideTurnRate: wide,
    });
  }
  return {
    sampleCount: solved.length,
    metrics: {
      rotationRate: average(solved.map((x) => x.rotationRate)),
      aufRate: average(solved.map((x) => x.aufRate)),
      wideTurnRate: average(solved.map((x) => x.wideTurnRate)),
    },
  };
}

function aggregateDurationMetricsForSolver(runs, solverName) {
  const solved = [];
  for (let i = 0; i < runs.length; i++) {
    const row = runs[i];
    if (!row || !row.ok) continue;
    if (String(row.sourceSolver || "").trim() !== solverName) continue;
    const durationMs = Number(row.durationMs);
    if (!Number.isFinite(durationMs)) continue;
    const moveCount = Number(row.moveCount);
    solved.push({
      durationMs,
      moveCount: Number.isFinite(moveCount) ? moveCount : null,
    });
  }
  return {
    sampleCount: solved.length,
    metrics: {
      durationMs: average(solved.map((x) => x.durationMs)),
      moveCount: average(solved.filter((x) => Number.isFinite(x.moveCount)).map((x) => x.moveCount)),
    },
  };
}

function aggregateDurationMetrics(runs) {
  const solved = [];
  for (let i = 0; i < runs.length; i++) {
    const row = runs[i];
    if (!row || !row.ok) continue;
    const durationMs = Number(row.durationMs);
    if (!Number.isFinite(durationMs)) continue;
    const moveCount = Number(row.moveCount);
    solved.push({
      durationMs,
      moveCount: Number.isFinite(moveCount) ? moveCount : null,
    });
  }
  return {
    sampleCount: solved.length,
    metrics: {
      durationMs: average(solved.map((x) => x.durationMs)),
      moveCount: average(solved.filter((x) => Number.isFinite(x.moveCount)).map((x) => x.moveCount)),
    },
  };
}

function collectBenchmarkSamplesBySolver(benchmarkDocs, modes) {
  const out = new Map();
  const modeSet = new Set(Array.isArray(modes) && modes.length ? modes : ["strict"]);
  for (let b = 0; b < benchmarkDocs.length; b++) {
    const benchmark = benchmarkDocs[b];
    if (!benchmark || typeof benchmark !== "object") continue;
    const runsByMode = benchmark.runsByMode && typeof benchmark.runsByMode === "object" ? benchmark.runsByMode : {};
    for (const mode of modeSet) {
      const styleMap = runsByMode[mode];
      if (!styleMap || typeof styleMap !== "object") continue;
      const styleNames = Object.keys(styleMap);
      if (!styleNames.length) continue;
      const anchorStyle = styleNames.includes("legacy") ? "legacy" : styleNames[0];
      const rows = Array.isArray(styleMap[anchorStyle]) ? styleMap[anchorStyle] : [];
      const seenBySolver = new Map();
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const solver = String(row?.sourceSolver || "").trim();
        const scramble = String(row?.scramble || "").trim();
        if (!solver || !scramble) continue;
        const seen = seenBySolver.get(solver) || new Set();
        if (seen.has(scramble)) continue;
        seen.add(scramble);
        seenBySolver.set(solver, seen);
      }
      for (const [solver, seen] of seenBySolver.entries()) {
        const prev = out.get(solver) || { total: 0, byMode: {} };
        const sampleCount = seen.size;
        prev.total += sampleCount;
        prev.byMode[mode] = (prev.byMode[mode] || 0) + sampleCount;
        out.set(solver, prev);
      }
    }
  }
  return out;
}

function learnWeightsForPlayer(target, styleObservations) {
  const weighted = {
    rotationWeight: 0,
    aufWeight: 0,
    wideTurnWeight: 0,
  };
  let totalW = 0;

  for (let i = 0; i < styleObservations.length; i++) {
    const obs = styleObservations[i];
    const base = STYLE_TO_VECTOR[obs.style];
    if (!base) continue;
    const d2 = squaredDistance(obs.metrics, target);
    const sampleScale = Math.max(1, obs.sampleCount);
    const score = sampleScale / (d2 + 1e-7);
    weighted.rotationWeight += base.rotationWeight * score;
    weighted.aufWeight += base.aufWeight * score;
    weighted.wideTurnWeight += base.wideTurnWeight * score;
    totalW += score;
  }

  if (totalW <= 0) {
    return null;
  }

  return {
    rotationWeight: clampInt(weighted.rotationWeight / totalW, 0, 12),
    aufWeight: clampInt(weighted.aufWeight / totalW, 0, 12),
    wideTurnWeight: clampInt(weighted.wideTurnWeight / totalW, 0, 12),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function learnFeatureWeightAggressive(targetValue, styleObservations, metricKey, weightKey, extrapolation) {
  const points = [];
  for (let i = 0; i < styleObservations.length; i++) {
    const obs = styleObservations[i];
    const base = STYLE_TO_VECTOR[obs.style];
    const metricValue = Number(obs?.metrics?.[metricKey]);
    const weightValue = Number(base?.[weightKey]);
    if (!Number.isFinite(metricValue) || !Number.isFinite(weightValue)) continue;
    points.push({
      metricValue,
      weightValue,
      sampleCount: Math.max(1, Number(obs.sampleCount) || 1),
    });
  }
  if (!points.length) return null;

  points.sort((a, b) => a.metricValue - b.metricValue);

  if (points.length === 1) {
    return clampInt(points[0].weightValue, 0, 12);
  }

  if (targetValue <= points[0].metricValue) {
    const p0 = points[0];
    const p1 = points[1];
    const metricSpan = Math.max(1e-7, p1.metricValue - p0.metricValue);
    const t = ((targetValue - p0.metricValue) / metricSpan) * extrapolation;
    return clampInt(lerp(p0.weightValue, p1.weightValue, t), 0, 12);
  }

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (targetValue <= cur.metricValue) {
      const metricSpan = Math.max(1e-7, cur.metricValue - prev.metricValue);
      const t = (targetValue - prev.metricValue) / metricSpan;
      return clampInt(lerp(prev.weightValue, cur.weightValue, t), 0, 12);
    }
  }

  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const metricSpan = Math.max(1e-7, last.metricValue - prev.metricValue);
  const t = ((targetValue - last.metricValue) / metricSpan) * extrapolation;
  return clampInt(lerp(last.weightValue, last.weightValue + (last.weightValue - prev.weightValue), t), 0, 12);
}

function learnWeightsForPlayerAggressive(target, styleObservations, opts) {
  const conservative = learnWeightsForPlayer(target, styleObservations);
  if (!conservative) return null;
  const extrapolation = Number.isFinite(opts?.aggressiveExtrapolation) ? opts.aggressiveExtrapolation : 1.35;
  const blend = Number.isFinite(opts?.aggressiveBlend) ? opts.aggressiveBlend : 0.85;
  const direct = {
    rotationWeight: learnFeatureWeightAggressive(
      target.rotationRate,
      styleObservations,
      "rotationRate",
      "rotationWeight",
      extrapolation,
    ),
    aufWeight: learnFeatureWeightAggressive(
      target.aufRate,
      styleObservations,
      "aufRate",
      "aufWeight",
      extrapolation,
    ),
    wideTurnWeight: learnFeatureWeightAggressive(
      target.wideTurnRate,
      styleObservations,
      "wideTurnRate",
      "wideTurnWeight",
      extrapolation,
    ),
  };

  return {
    rotationWeight: clampInt(
      lerp(conservative.rotationWeight, direct.rotationWeight ?? conservative.rotationWeight, blend),
      0,
      12,
    ),
    aufWeight: clampInt(
      lerp(conservative.aufWeight, direct.aufWeight ?? conservative.aufWeight, blend),
      0,
      12,
    ),
    wideTurnWeight: clampInt(
      lerp(conservative.wideTurnWeight, direct.wideTurnWeight ?? conservative.wideTurnWeight, blend),
      0,
      12,
    ),
  };
}

function clampWeightProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  return {
    rotationWeight: clampInt(profile.rotationWeight, 0, 12),
    aufWeight: clampInt(profile.aufWeight, 0, 12),
    wideTurnWeight: clampInt(profile.wideTurnWeight, 0, 12),
  };
}

function averageWeightProfiles(profiles, weights) {
  const sum = {
    rotationWeight: 0,
    aufWeight: 0,
    wideTurnWeight: 0,
  };
  let total = 0;
  for (let i = 0; i < profiles.length; i++) {
    const profile = clampWeightProfile(profiles[i]);
    if (!profile) continue;
    const weight = Number(weights?.[i]);
    const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
    sum.rotationWeight += profile.rotationWeight * w;
    sum.aufWeight += profile.aufWeight * w;
    sum.wideTurnWeight += profile.wideTurnWeight * w;
    total += w;
  }
  if (total <= 0) {
    return null;
  }
  return {
    rotationWeight: clampInt(sum.rotationWeight / total, 0, 12),
    aufWeight: clampInt(sum.aufWeight / total, 0, 12),
    wideTurnWeight: clampInt(sum.wideTurnWeight / total, 0, 12),
  };
}

function learnSpeedStyleForPlayer(styleObservations) {
  const ranked = [];
  for (let i = 0; i < styleObservations.length; i++) {
    const obs = styleObservations[i];
    const base = STYLE_TO_VECTOR[obs.style];
    const durationMs = Number(obs?.metrics?.durationMs);
    const moveCount = Number(obs?.metrics?.moveCount);
    if (!base || !Number.isFinite(durationMs)) continue;
    ranked.push({
      style: obs.style,
      sampleCount: Math.max(1, Number(obs.sampleCount) || 1),
      durationMs,
      moveCount: Number.isFinite(moveCount) ? moveCount : Number.POSITIVE_INFINITY,
      base,
    });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => {
    if (a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
    if (a.moveCount !== b.moveCount) return a.moveCount - b.moveCount;
    return b.sampleCount - a.sampleCount;
  });
  const best = ranked[0];
  return {
    preset: "speed",
    rotationWeight: best.base.rotationWeight,
    aufWeight: best.base.aufWeight,
    wideTurnWeight: best.base.wideTurnWeight,
    bestStyle: best.style,
    sampleCount: best.sampleCount,
    avgDurationMs: best.durationMs,
    avgMoveCount: Number.isFinite(best.moveCount) ? best.moveCount : null,
  };
}

function synthesizeProfileFromAnchors(player, opts) {
  const target = getTargetFingerprint(player);
  if (!target) return null;
  const detailed = clampWeightProfile(player?.detailedStyleProfile);
  const recommended = clampWeightProfile(player?.recommendedStyleProfile);
  if (!detailed && !recommended) return null;
  if (!detailed) return recommended;
  if (!recommended) return detailed;

  const datasetCenter = opts?.targetCenter && typeof opts.targetCenter === "object" ? opts.targetCenter : null;
  const centerRotation = Number.isFinite(datasetCenter?.rotationRate) ? datasetCenter.rotationRate : 0.05;
  const centerAuf = Number.isFinite(datasetCenter?.aufRate) ? datasetCenter.aufRate : 0.37;
  const centerWide = Number.isFinite(datasetCenter?.wideTurnRate) ? datasetCenter.wideTurnRate : 0.035;
  const rotationDelta = target.rotationRate - centerRotation;
  const aufDelta = target.aufRate - centerAuf;
  const wideDelta = target.wideTurnRate - centerWide;
  const emphasis = Number.isFinite(opts?.aggressiveExtrapolation) ? opts.aggressiveExtrapolation : 1.35;
  const blend = Math.max(0, Math.min(1, Number.isFinite(opts?.aggressiveBlend) ? opts.aggressiveBlend : 0.85));

  const rotationWeight = lerp(detailed.rotationWeight, recommended.rotationWeight, blend);
  const aufWeight = lerp(detailed.aufWeight, recommended.aufWeight, blend);
  const wideTurnWeight = lerp(detailed.wideTurnWeight, recommended.wideTurnWeight, blend);

  const rotationNudge = Math.max(-2, Math.min(2, rotationDelta * 120 * emphasis));
  const aufNudge = Math.max(-2, Math.min(2, -aufDelta * 110 * emphasis));
  const wideNudge = Math.max(-2, Math.min(2, wideDelta * 120 * emphasis));

  return {
    rotationWeight: clampInt(rotationWeight + rotationNudge, 0, 12),
    aufWeight: clampInt(aufWeight + aufNudge, 0, 12),
    wideTurnWeight: clampInt(wideTurnWeight + wideNudge, 0, 12),
  };
}

function buildTargetCenter(players) {
  const targets = players
    .map((player) => getTargetFingerprint(player))
    .filter((target) => !!target);
  if (!targets.length) {
    return {
      rotationRate: 0.05,
      aufRate: 0.37,
      wideTurnRate: 0.035,
    };
  }
  return {
    rotationRate: average(targets.map((target) => target.rotationRate)),
    aufRate: average(targets.map((target) => target.aufRate)),
    wideTurnRate: average(targets.map((target) => target.wideTurnRate)),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const playersDoc = loadJsonOrThrow(opts.players);
  const players = Array.isArray(playersDoc.players) ? playersDoc.players : [];
  const benchmarkDocs = opts.targetOnly ? [] : opts.benchmarks.map((benchmarkPath) => loadJsonOrThrow(benchmarkPath));
  const runsByStyle = collectRunsByModesAndStyle(benchmarkDocs, opts.modes);
  const strictRunsByStyle = collectRunsByModesAndStyle(benchmarkDocs, ["strict"]);
  const benchmarkSamplesBySolver = collectBenchmarkSamplesBySolver(benchmarkDocs, opts.modes);
  const styleNames = Object.keys(runsByStyle).filter((style) => STYLE_TO_VECTOR[style]);
  const targetCenter = buildTargetCenter(players);

  const learnedPlayers = [];
  const speedProfiles = [];
  for (let p = 0; p < players.length; p++) {
    const player = players[p];
    const solver = String(player?.solver || "").trim();
    if (!solver) continue;
    const target = getTargetFingerprint(player);
    if (!target) continue;

    const observations = [];
    for (let s = 0; s < styleNames.length; s++) {
      const style = styleNames[s];
      const agg = aggregateStyleMetricsForSolver(runsByStyle[style], solver);
      if (agg.sampleCount < opts.minSamples) continue;
      if (
        !Number.isFinite(agg.metrics.rotationRate) ||
        !Number.isFinite(agg.metrics.aufRate) ||
        !Number.isFinite(agg.metrics.wideTurnRate)
      ) {
        continue;
      }
      observations.push({
        style,
        sampleCount: agg.sampleCount,
        metrics: agg.metrics,
      });
    }

    const speedObservations = [];
    for (let s = 0; s < styleNames.length; s++) {
      const style = styleNames[s];
      const agg = aggregateDurationMetricsForSolver(runsByStyle[style], solver);
      if (agg.sampleCount < opts.minSamples) continue;
      if (!Number.isFinite(agg.metrics.durationMs)) continue;
      speedObservations.push({
        style,
        sampleCount: agg.sampleCount,
        metrics: agg.metrics,
      });
    }

    let learned = null;
    if (!opts.targetOnly) {
      learned =
        opts.objective === "aggressive"
          ? learnWeightsForPlayerAggressive(target, observations, opts)
          : learnWeightsForPlayer(target, observations);
    }
    if (!learned) {
      learned = synthesizeProfileFromAnchors(player, {
        ...opts,
        targetCenter,
      });
    }
    if (!learned) continue;

    const speedStyleProfile = learnSpeedStyleForPlayer(speedObservations);
    if (speedStyleProfile) {
      speedProfiles.push(speedStyleProfile);
    }

    learnedPlayers.push({
      solver,
      solveCount: Number(player?.solveCount || 0),
      primaryMethod: String(player?.primaryMethod || "").trim() || "UNKNOWN",
      primaryMethodGroup: String(player?.primaryMethodGroup || "").trim() || "CFOP",
      mixedEligible: player?.mixedEligible === true,
      caseBias: player?.caseBias && typeof player.caseBias === "object" ? player.caseBias : null,
      learnedStyleProfile: {
        preset: opts.objective === "aggressive" ? "ml-aggressive" : "ml-learned",
        ...learned,
      },
      speedStyleProfile,
      speedBestStyle: speedStyleProfile ? speedStyleProfile.bestStyle : null,
      speedObservation: speedStyleProfile
        ? {
            sampleCount: speedStyleProfile.sampleCount,
            avgDurationMs: speedStyleProfile.avgDurationMs,
            avgMoveCount: speedStyleProfile.avgMoveCount,
          }
        : null,
      coverage: {
        totalSolves: Number(player?.coverage?.totalSolves || player?.solveCount || 0),
        benchmarkSamples: Number(benchmarkSamplesBySolver.get(solver)?.total || 0),
        benchmarkModes: Object.keys(benchmarkSamplesBySolver.get(solver)?.byMode || {}).sort(),
      },
      targetFingerprint: target,
      observations,
      speedObservations,
    });
  }

  const globalSpeedObservations = [];
  for (let s = 0; s < styleNames.length; s++) {
    const style = styleNames[s];
    const strictRuns = strictRunsByStyle[style] || [];
    const agg = aggregateDurationMetrics(strictRuns);
    if (agg.sampleCount < opts.minSamples) continue;
    if (!Number.isFinite(agg.metrics.durationMs)) continue;
    globalSpeedObservations.push({
      style,
      sampleCount: agg.sampleCount,
      metrics: agg.metrics,
    });
  }
  const globalSpeedStyleProfile =
    (() => {
      const bestGlobalSpeed = learnSpeedStyleForPlayer(globalSpeedObservations);
      if (bestGlobalSpeed) {
        return bestGlobalSpeed;
      }
      const averaged = averageWeightProfiles(
        speedProfiles,
        speedProfiles.map((profile) => Number(profile.sampleCount) || 1),
      );
      if (averaged) {
        return {
          preset: "speed",
          ...averaged,
        };
      }
      return {
        preset: "speed",
        rotationWeight: 5,
        aufWeight: 1,
        wideTurnWeight: 2,
      };
    })();

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceBenchmark: opts.benchmarks.length === 1 ? opts.benchmarks[0] : null,
    sourceBenchmarks: opts.benchmarks,
    sourcePlayers: opts.players,
    modes: opts.modes,
    minSamples: opts.minSamples,
    objective: opts.objective,
    aggressiveBlend: opts.aggressiveBlend,
    aggressiveExtrapolation: opts.aggressiveExtrapolation,
    targetOnly: opts.targetOnly,
    targetCenter,
    playerCount: learnedPlayers.length,
    speedProfile: {
      generatedFrom: "lowest-average-duration-across-strict-cfop-solvers",
      playerCount: speedProfiles.length,
      bestStyle: globalSpeedStyleProfile.bestStyle || null,
      preset: "speed",
      ...globalSpeedStyleProfile,
    },
    globalSpeedStyleProfile: {
      generatedFrom: "lowest-average-duration-across-strict-cfop-solvers",
      playerCount: speedProfiles.length,
      bestStyle: globalSpeedStyleProfile.bestStyle || null,
      preset: "speed",
      ...globalSpeedStyleProfile,
    },
    players: learnedPlayers,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (${learnedPlayers.length} players)`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
