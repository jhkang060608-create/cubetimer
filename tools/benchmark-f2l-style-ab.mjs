#!/usr/bin/env node
import fs from "fs";
import os from "os";
import path from "path";
import { performance } from "perf_hooks";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-style-benchmark.json");
const DEFAULT_STYLE_PROFILE_INPUT = path.join(
  ROOT_DIR,
  "vendor-data",
  "reco",
  "reco-3x3-style-features.json",
);
const FALLBACK_STYLE_PROFILE_INPUT = path.join(
  ROOT_DIR,
  "vendor-data",
  "reco",
  "reco-3x3-style-profiles.json",
);
const DEFAULT_STYLE_LIST = ["legacy", "balanced", "rotationless", "low-auf"];
const DEFAULT_MODES = ["strict", "zb"];
const DEFAULT_GLOBAL_TIMEOUT_MS = 5000;
const DEFAULT_STRICT_TIMEOUT_MS = 3000;
const DEFAULT_ZB_TIMEOUT_MS = 5000;
const SOLVE_WORKER_URL = new URL("./benchmark-f2l-style-solve-worker.mjs", import.meta.url);
const WORKER_TIMEOUT_GRACE_MS = 150;

const GATE_THRESHOLDS = Object.freeze({
  deltaSuccessRateMin: 0.01,
  deltaAvgMoveCountSolvedMax: -0.5,
  deltaP95DurationRatioMax: 0.1,
  deltaStyleDistancePctMax: -0.05,
});

const DEFAULT_DISTANCE_WEIGHTS = Object.freeze({
  rotationRate: 3,
  aufRate: 3,
  wideTurnRate: 2,
  avgF2LSegmentLen: 1,
  zbUsageRate: 1,
});

function getParallelismLimit() {
  if (typeof os.availableParallelism === "function") {
    const n = Number(os.availableParallelism());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 0;
  return Math.max(1, Math.floor(cpuCount) || 1);
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
    styleProfileInput: DEFAULT_STYLE_PROFILE_INPUT,
    offset: 0,
    limit: 50,
    perSolverLimit: 12,
    scrambleConcurrency: 1,
    crossColor: "D",
    timeoutMs: null,
    strictTimeoutMs: null,
    zbTimeoutMs: null,
    styles: DEFAULT_STYLE_LIST.slice(),
    modes: DEFAULT_MODES.slice(),
    methods: ["CFOP", "ZB"],
    solvers: [],
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
    } else if (flag === "--style-profile-input") {
      opts.styleProfileInput = value || opts.styleProfileInput;
      if (consumeNext) i += 1;
    } else if (flag === "--offset") {
      opts.offset = Math.max(0, parseIntOrFallback(value, opts.offset));
      if (consumeNext) i += 1;
    } else if (flag === "--limit") {
      opts.limit = Math.max(1, parseIntOrFallback(value, opts.limit));
      if (consumeNext) i += 1;
    } else if (flag === "--per-solver-limit") {
      opts.perSolverLimit = Math.max(0, parseIntOrFallback(value, opts.perSolverLimit));
      if (consumeNext) i += 1;
    } else if (flag === "--scramble-concurrency") {
      opts.scrambleConcurrency = Math.max(1, parseIntOrFallback(value, opts.scrambleConcurrency));
      if (consumeNext) i += 1;
    } else if (flag === "--cross-color") {
      opts.crossColor = String(value || opts.crossColor || "D").toUpperCase();
      if (consumeNext) i += 1;
    } else if (flag === "--timeout-ms") {
      opts.timeoutMs = Math.max(1000, parseIntOrFallback(value, opts.timeoutMs));
      if (consumeNext) i += 1;
    } else if (flag === "--strict-timeout-ms") {
      opts.strictTimeoutMs = Math.max(
        1000,
        parseIntOrFallback(value, opts.strictTimeoutMs),
      );
      if (consumeNext) i += 1;
    } else if (flag === "--zb-timeout-ms") {
      opts.zbTimeoutMs = Math.max(1000, parseIntOrFallback(value, opts.zbTimeoutMs));
      if (consumeNext) i += 1;
    } else if (flag === "--styles") {
      opts.styles = parseCsvList(value, opts.styles);
      if (consumeNext) i += 1;
    } else if (flag === "--modes") {
      opts.modes = parseCsvList(value, opts.modes)
        .map((mode) => mode.toLowerCase())
        .filter((mode) => mode === "strict" || mode === "zb");
      if (!opts.modes.length) {
        opts.modes = DEFAULT_MODES.slice();
      }
      if (consumeNext) i += 1;
    } else if (flag === "--methods") {
      opts.methods = parseCsvList(value, opts.methods)
        .map((method) => method.toUpperCase())
        .filter((method) => method === "CFOP" || method === "ZB");
      if (!opts.methods.length) {
        opts.methods = ["CFOP", "ZB"];
      }
      if (consumeNext) i += 1;
    } else if (flag === "--solvers") {
      opts.solvers = parseCsvList(value, opts.solvers);
      if (consumeNext) i += 1;
    } else if (flag === "--mode") {
      const mode = String(value || "").trim().toLowerCase();
      if (mode === "strict" || mode === "zb") {
        opts.modes = [mode];
      }
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/benchmark-f2l-style-ab.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>             Input details JSON (default: vendor-data/reco/reco-3x3-details.json)");
  console.log("  --output <path>            Output benchmark JSON");
  console.log("  --style-profile-input <path> Target player profile JSON for style distance");
  console.log("  --offset <n>               Start offset in detail records (default: 0)");
  console.log("  --limit <n>                Number of scrambles to benchmark (default: 50)");
  console.log("  --per-solver-limit <n>     Number of scrambles to sample per solver (default: 12, 0 = disabled)");
  console.log("  --scramble-concurrency <n> Number of scrambles to process in parallel (default: 1)");
  console.log("  --cross-color <face>       Cross color (default: D)");
  console.log("  --timeout-ms <n>           Global fallback timeout per solve (default: 5000)");
  console.log("  --strict-timeout-ms <n>    Timeout per solve in strict mode (default: 3000)");
  console.log("  --zb-timeout-ms <n>        Timeout per solve in zb mode (default: 5000)");
  console.log("  --styles <csv>             Style profile list (default: legacy,balanced,rotationless,low-auf)");
  console.log("  --modes <csv>              Modes to benchmark (default: strict,zb)");
  console.log("  --methods <csv>            Methods to include (default: CFOP,ZB)");
  console.log("  --solvers <csv>            Solver names to include (default: all found in input)");
  console.log("  --mode <strict|zb>         Single mode alias (backward compatible)");
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function loadDetailsRecords(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error(`Input has no records array: ${inputPath}`);
}

function toNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function resolveTimeoutMsForMode(mode, opts) {
  const globalTimeoutMs =
    opts.timeoutMs == null
      ? null
      : Math.max(1000, parseIntOrFallback(opts.timeoutMs, DEFAULT_GLOBAL_TIMEOUT_MS));
  if (mode === "strict") {
    if (opts.strictTimeoutMs != null) {
      return Math.max(1000, parseIntOrFallback(opts.strictTimeoutMs, DEFAULT_STRICT_TIMEOUT_MS));
    }
    if (globalTimeoutMs != null) {
      return globalTimeoutMs;
    }
    return DEFAULT_STRICT_TIMEOUT_MS;
  }
  if (mode === "zb") {
    if (opts.zbTimeoutMs != null) {
      return Math.max(1000, parseIntOrFallback(opts.zbTimeoutMs, DEFAULT_ZB_TIMEOUT_MS));
    }
    if (globalTimeoutMs != null) {
      return globalTimeoutMs;
    }
    return DEFAULT_ZB_TIMEOUT_MS;
  }
  return globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS;
}

function normalizeSolvePayload(payload, durationFallbackMs) {
  return {
    ok: Boolean(payload?.ok),
    reason: payload?.ok ? null : String(payload?.reason || "NO_SOLUTION"),
    stage: payload?.ok ? null : String(payload?.stage || ""),
    moveCount: toNullableNumber(payload?.moveCount),
    nodes: toNullableNumber(payload?.nodes),
    durationMs: Math.max(1, Math.floor(toNullableNumber(payload?.durationMs) || durationFallbackMs)),
    styleMetrics:
      payload?.styleMetrics && typeof payload.styleMetrics === "object"
        ? {
            rotationRate: toNullableNumber(payload.styleMetrics.rotationRate),
            aufRate: toNullableNumber(payload.styleMetrics.aufRate),
            wideTurnRate: toNullableNumber(payload.styleMetrics.wideTurnRate),
            avgF2LSegmentLen: toNullableNumber(payload.styleMetrics.avgF2LSegmentLen),
            zbUsageRate: toNullableNumber(payload.styleMetrics.zbUsageRate),
            llApproach: payload.styleMetrics.llApproach || "",
          }
        : null,
  };
}

class SolveWorkerPool {
  constructor(workerCount) {
    this.workerCount = Math.max(1, Math.floor(workerCount) || 1);
    this.workers = [];
    this.queue = [];
    this.closed = false;
    this.failed = null;
    this.nextTaskId = 1;
    this.readyPromise = this.init();
  }

  async init() {
    const readyPromises = [];
    for (let i = 0; i < this.workerCount; i++) {
      readyPromises.push(this.createWorker());
    }
    await Promise.all(readyPromises);
  }

  createWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(SOLVE_WORKER_URL, {
        workerData: { __poolMode: true },
      });
      const state = {
        worker,
        busy: false,
        ready: false,
        currentTask: null,
        currentTaskTimer: null,
        terminating: false,
      };
      this.workers.push(state);

      worker.on("message", (message) => {
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") {
          if (!state.ready) {
            state.ready = true;
            resolve();
          }
          return;
        }
        if (message.type !== "result") return;
        const task = state.currentTask;
        if (state.currentTaskTimer) {
          clearTimeout(state.currentTaskTimer);
          state.currentTaskTimer = null;
        }
        state.currentTask = null;
        state.busy = false;
        if (!task) {
          this.dispatch();
          return;
        }
        task.resolve(message);
        this.dispatch();
      });

      worker.once("error", (error) => {
        if (state.terminating) return;
        if (!state.ready) {
          reject(error);
          return;
        }
        this.fail(error);
      });

      worker.once("exit", (code) => {
        if (this.closed) return;
        if (state.terminating) return;
        if (code === 0) return;
        this.fail(new Error(`WORKER_EXIT_${code}`));
      });
    });
  }

  async recycleWorker(state) {
    if (!state) return;
    state.terminating = true;
    try {
      await state.worker.terminate();
    } catch (_) {
      // Best-effort recycle.
    }

    const index = this.workers.indexOf(state);
    if (index >= 0) {
      this.workers.splice(index, 1);
    }

    if (this.closed || this.failed) return;
    try {
      await this.createWorker();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.dispatch();
  }

  onTaskTimeout(state, task) {
    if (this.closed || this.failed) return;
    if (!state || state.currentTask !== task) return;

    if (state.currentTaskTimer) {
      clearTimeout(state.currentTaskTimer);
      state.currentTaskTimer = null;
    }
    state.currentTask = null;
    state.busy = false;

    task.resolve({
      ok: false,
      reason: `TIMEOUT_${task.timeoutMs}MS`,
      stage: "",
      moveCount: null,
      nodes: null,
      styleMetrics: null,
      durationMs: task.timeoutMs + WORKER_TIMEOUT_GRACE_MS,
    });

    void this.recycleWorker(state);
    this.dispatch();
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error(String(error || "WORKER_FAILED"));
    while (this.queue.length) {
      const task = this.queue.shift();
      task.reject(this.failed);
    }
    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.currentTaskTimer) {
        clearTimeout(state.currentTaskTimer);
        state.currentTaskTimer = null;
      }
      if (state.currentTask) {
        state.currentTask.reject(this.failed);
        state.currentTask = null;
      }
      state.busy = false;
    }
    void this.close();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      this.workers.map((state) =>
        (async () => {
          if (state.currentTaskTimer) {
            clearTimeout(state.currentTaskTimer);
            state.currentTaskTimer = null;
          }
          state.terminating = true;
          try {
            await state.worker.terminate();
          } catch (_) {
            return 0;
          }
          return 0;
        })(),
      ),
    );
  }

  dispatch() {
    if (this.closed || this.failed) return;
    for (let i = 0; i < this.workers.length; i++) {
      const state = this.workers[i];
      if (state.busy) continue;
      const task = this.queue.shift();
      if (!task) return;
      state.busy = true;
      state.currentTask = task;
      const timeoutMs = Math.max(
        1000,
        parseIntOrFallback(task?.payload?.timeoutMs, DEFAULT_GLOBAL_TIMEOUT_MS),
      );
      task.timeoutMs = timeoutMs;
      state.currentTaskTimer = setTimeout(() => {
        this.onTaskTimeout(state, task);
      }, timeoutMs + WORKER_TIMEOUT_GRACE_MS);
      state.worker.postMessage({
        type: "solve",
        taskId: task.id,
        task: task.payload,
      });
    }
  }

  async solve(payload) {
    if (this.failed) {
      throw this.failed;
    }
    await this.readyPromise;
    if (this.failed) {
      throw this.failed;
    }
    return await new Promise((resolve, reject) => {
      const task = {
        id: this.nextTaskId++,
        payload,
        resolve,
        reject,
      };
      this.queue.push(task);
      this.dispatch();
    });
  }
}

function buildScrambleSet(records, opts) {
  const methods = Array.isArray(opts.methods) && opts.methods.length ? new Set(opts.methods) : null;
  const solverFilter = Array.isArray(opts.solvers) && opts.solvers.length ? new Set(opts.solvers) : null;
  if (opts.perSolverLimit > 0) {
    const grouped = new Map();
    const solverOrder = [];
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      if (!row || !row.ok) continue;
      const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
      if (puzzle !== "3x3") continue;
      const sourceSolver = String(row?.meta?.solver || row?.solver || "").trim();
      if (!sourceSolver) continue;
      if (solverFilter && !solverFilter.has(sourceSolver)) continue;
      const sourceMethod = String(row.method || row?.meta?.method || "").trim().toUpperCase();
      if (methods && !methods.has(sourceMethod)) continue;
      const scramble = String(row.scramble || "").trim();
      if (!scramble) continue;
      let bucket = grouped.get(sourceSolver);
      if (!bucket) {
        bucket = { seen: new Set(), rows: [] };
        grouped.set(sourceSolver, bucket);
        solverOrder.push(sourceSolver);
      }
      if (bucket.seen.has(scramble)) continue;
      bucket.seen.add(scramble);
      bucket.rows.push({
        id: row.id,
        scramble,
        sourceSolver,
        sourceMethod,
      });
    }

    const orderedSolvers = solverFilter ? Array.from(solverFilter) : solverOrder;
    const eligibleSolvers = [];
    for (let s = 0; s < orderedSolvers.length; s++) {
      const solver = orderedSolvers[s];
      const bucket = grouped.get(solver);
      if (!bucket || !bucket.rows.length) continue;
      if (bucket.rows.length < opts.perSolverLimit) continue;
      eligibleSolvers.push(solver);
    }
    const out = [];
    for (let s = 0; s < eligibleSolvers.length; s++) {
      const solver = eligibleSolvers[s];
      const bucket = grouped.get(solver);
      if (!bucket || !bucket.rows.length) continue;
      const sampled = bucket.rows.slice(0, opts.perSolverLimit);
      for (let i = 0; i < sampled.length; i++) {
        out.push(sampled[i]);
      }
    }
    return out;
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle !== "3x3") continue;
    const sourceMethod = String(row.method || row?.meta?.method || "").trim().toUpperCase();
    if (methods && !methods.has(sourceMethod)) continue;
    const scramble = String(row.scramble || "").trim();
    if (!scramble) continue;
    if (seen.has(scramble)) continue;
    seen.add(scramble);
    out.push({
      id: row.id,
      scramble,
      sourceSolver: String(row?.meta?.solver || row?.solver || "").trim(),
      sourceMethod,
    });
  }
  return out.slice(opts.offset, opts.offset + opts.limit);
}

function summarizeScrambleCoverage(scrambleSet, opts) {
  const bySolver = new Map();
  const byMethod = new Map();
  for (let i = 0; i < scrambleSet.length; i++) {
    const row = scrambleSet[i];
    const solver = String(row?.sourceSolver || "").trim();
    const method = String(row?.sourceMethod || "").trim().toUpperCase() || "UNKNOWN";
    if (solver) {
      bySolver.set(solver, (bySolver.get(solver) || 0) + 1);
    }
    byMethod.set(method, (byMethod.get(method) || 0) + 1);
  }
  const solverRows = Array.from(bySolver.entries())
    .map(([solver, samples]) => ({ solver, samples }))
    .sort((a, b) => b.samples - a.samples || a.solver.localeCompare(b.solver));
  const samplesPerSolver =
    solverRows.length > 0 && solverRows.every((row) => row.samples === solverRows[0].samples)
      ? solverRows[0].samples
      : null;
  return {
    samplingPolicy: opts.perSolverLimit > 0 ? "balanced-per-solver" : "offset-limit",
    samplesPerSolver,
    solverCoverage: {
      count: solverRows.length,
      solvers: solverRows,
    },
    methodCoverage: Object.fromEntries(byMethod.entries()),
  };
}

async function runSingleSolve(pool, scramble, solveOpts) {
  const started = performance.now();
  const payload = await pool.solve({
    ...solveOpts,
    scramble,
  }).catch((error) => ({
    ok: false,
    reason: `WORKER_ERROR:${String(error?.message || error)}`,
  }));
  const durationMs = Math.max(1, Math.round(performance.now() - started));
  const result = normalizeSolvePayload(payload, durationMs);
  return result;
}

function deriveBoundsFromPlayers(players, weights) {
  const bounds = {};
  const keys = Object.keys(weights);
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
  return bounds;
}

function toTargetVector(player) {
  if (!player || typeof player !== "object") return null;
  if (player.styleFingerprint && typeof player.styleFingerprint === "object") {
    return {
      rotationRate: toNullableNumber(player.styleFingerprint.rotationRate),
      aufRate: toNullableNumber(player.styleFingerprint.aufRate),
      wideTurnRate: toNullableNumber(player.styleFingerprint.wideTurnRate),
      avgF2LSegmentLen: toNullableNumber(player.styleFingerprint.avgF2LSegmentLen),
      zbUsageRate: toNullableNumber(player.styleFingerprint.zbUsageRate),
    };
  }
  return {
    rotationRate: toNullableNumber(player.rotationRate),
    aufRate: toNullableNumber(player.aufRate),
    wideTurnRate: toNullableNumber(player.wideTurnRate),
    avgF2LSegmentLen: toNullableNumber(player.avgF2LSegmentLen),
    zbUsageRate: toNullableNumber(player.zbUsageRate),
  };
}

function loadStyleProfileSource(inputPath) {
  const candidatePaths = [inputPath, FALLBACK_STYLE_PROFILE_INPUT];
  let parsed = null;
  let sourcePath = "";
  for (let i = 0; i < candidatePaths.length; i++) {
    const p = candidatePaths[i];
    if (!p || !fs.existsSync(p)) continue;
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    sourcePath = p;
    break;
  }
  if (!parsed) {
    return {
      sourcePath: "",
      playerMap: new Map(),
      distanceConfig: {
        weights: DEFAULT_DISTANCE_WEIGHTS,
        normalizationBounds: deriveBoundsFromPlayers([], DEFAULT_DISTANCE_WEIGHTS),
      },
    };
  }

  const players = Array.isArray(parsed.playerProfiles)
    ? parsed.playerProfiles
    : Array.isArray(parsed.players)
      ? parsed.players
      : [];

  const playerMap = new Map();
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    const solver = String(player?.solver || "").trim();
    if (!solver) continue;
    const target = toTargetVector(player);
    if (!target) continue;
    playerMap.set(solver, target);
  }

  const weights =
    parsed?.distanceConfig?.weights && typeof parsed.distanceConfig.weights === "object"
      ? parsed.distanceConfig.weights
      : DEFAULT_DISTANCE_WEIGHTS;
  const normalizationBounds =
    parsed?.distanceConfig?.normalizationBounds && typeof parsed.distanceConfig.normalizationBounds === "object"
      ? parsed.distanceConfig.normalizationBounds
      : deriveBoundsFromPlayers(
          Array.from(playerMap.values()),
          weights,
        );

  return {
    sourcePath,
    playerMap,
    distanceConfig: {
      weights,
      normalizationBounds,
    },
  };
}

function computeStyleDistance(runStyleMetrics, target, distanceConfig) {
  if (!runStyleMetrics || !target) return null;
  const weights = distanceConfig.weights || DEFAULT_DISTANCE_WEIGHTS;
  const bounds = distanceConfig.normalizationBounds || {};
  const keys = Object.keys(weights);
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const w = Number(weights[key]);
    const sourceValue = Number(runStyleMetrics[key]);
    const targetValue = Number(target[key]);
    if (!Number.isFinite(w) || w <= 0) continue;
    if (!Number.isFinite(sourceValue) || !Number.isFinite(targetValue)) continue;
    const bound = bounds[key] || { min: 0, max: 1 };
    const span = Math.max(1e-6, Number(bound.max) - Number(bound.min));
    const distance = Math.abs(sourceValue - targetValue) / span;
    weightedSum += distance * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return weightedSum / totalWeight;
}

function countBy(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    const key = String(items[i] || "").trim() || "UNKNOWN";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function summarizeRuns(styleName, runs) {
  const solvedRuns = runs.filter((run) => run.ok);
  const durations = runs.map((run) => run.durationMs).filter((v) => Number.isFinite(v));
  const solvedMoves = solvedRuns.map((run) => run.moveCount).filter((v) => Number.isFinite(v));
  const solvedNodes = solvedRuns.map((run) => run.nodes).filter((v) => Number.isFinite(v));
  const solvedDistances = solvedRuns.map((run) => run.styleDistanceToTarget).filter((v) => Number.isFinite(v));

  return {
    style: styleName,
    attempted: runs.length,
    solved: solvedRuns.length,
    failed: runs.length - solvedRuns.length,
    successRate: runs.length > 0 ? solvedRuns.length / runs.length : 0,
    avgMoveCountSolved: average(solvedMoves),
    p50MoveCountSolved: percentile(solvedMoves, 0.5),
    p90MoveCountSolved: percentile(solvedMoves, 0.9),
    avgDurationMs: average(durations),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    avgNodesSolved: average(solvedNodes),
    avgStyleDistanceToTarget: average(solvedDistances),
    p50StyleDistanceToTarget: percentile(solvedDistances, 0.5),
    failureReasonCounts: countBy(runs.filter((run) => !run.ok).map((run) => run.reason)),
    failureStageCounts: countBy(runs.filter((run) => !run.ok).map((run) => run.stage)),
  };
}

function summarizeModeComparisons(mode, summaries) {
  const baseline = summaries.find((entry) => entry.style === "legacy");
  if (!baseline) return [];
  const out = [];
  for (let i = 0; i < summaries.length; i++) {
    const entry = summaries[i];
    if (entry.style === "legacy") continue;
    const deltaP95Duration =
      Number.isFinite(entry.p95DurationMs) && Number.isFinite(baseline.p95DurationMs)
        ? entry.p95DurationMs - baseline.p95DurationMs
        : null;
    const deltaP95DurationRatio =
      Number.isFinite(deltaP95Duration) && Number.isFinite(baseline.p95DurationMs) && baseline.p95DurationMs > 0
        ? deltaP95Duration / baseline.p95DurationMs
        : null;
    const deltaStyleDistance =
      Number.isFinite(entry.avgStyleDistanceToTarget) && Number.isFinite(baseline.avgStyleDistanceToTarget)
        ? entry.avgStyleDistanceToTarget - baseline.avgStyleDistanceToTarget
        : null;
    const deltaStyleDistancePct =
      Number.isFinite(deltaStyleDistance) &&
      Number.isFinite(baseline.avgStyleDistanceToTarget) &&
      baseline.avgStyleDistanceToTarget > 0
        ? deltaStyleDistance / baseline.avgStyleDistanceToTarget
        : null;

    out.push({
      mode,
      style: entry.style,
      deltaSuccessRate: (entry.successRate ?? 0) - (baseline.successRate ?? 0),
      deltaAvgMoveCountSolved:
        Number.isFinite(entry.avgMoveCountSolved) && Number.isFinite(baseline.avgMoveCountSolved)
          ? entry.avgMoveCountSolved - baseline.avgMoveCountSolved
          : null,
      deltaAvgDurationMs:
        Number.isFinite(entry.avgDurationMs) && Number.isFinite(baseline.avgDurationMs)
          ? entry.avgDurationMs - baseline.avgDurationMs
          : null,
      deltaP95DurationMs: deltaP95Duration,
      deltaP95DurationRatio,
      deltaStyleDistanceToTarget: deltaStyleDistance,
      deltaStyleDistancePct,
    });
  }
  return out;
}

function evaluateBalancedGate(comparison) {
  const checks = {
    successRate: Number.isFinite(comparison.deltaSuccessRate)
      ? comparison.deltaSuccessRate >= GATE_THRESHOLDS.deltaSuccessRateMin
      : false,
    avgMoveCountSolved: Number.isFinite(comparison.deltaAvgMoveCountSolved)
      ? comparison.deltaAvgMoveCountSolved <= GATE_THRESHOLDS.deltaAvgMoveCountSolvedMax
      : false,
    p95DurationRatio: Number.isFinite(comparison.deltaP95DurationRatio)
      ? comparison.deltaP95DurationRatio <= GATE_THRESHOLDS.deltaP95DurationRatioMax
      : false,
    styleDistancePct: Number.isFinite(comparison.deltaStyleDistancePct)
      ? comparison.deltaStyleDistancePct <= GATE_THRESHOLDS.deltaStyleDistancePctMax
      : false,
  };
  return {
    mode: comparison.mode,
    style: comparison.style,
    pass: checks.successRate && checks.avgMoveCountSolved && checks.p95DurationRatio && checks.styleDistancePct,
    checks,
    thresholds: GATE_THRESHOLDS,
  };
}

async function runModeBenchmarks(mode, scrambleSet, opts, targetProfiles) {
  const parallelismLimit = getParallelismLimit();
  const requestedWorkerCount = Math.max(1, opts.scrambleConcurrency * opts.styles.length);
  const workerCount = Math.max(1, Math.min(requestedWorkerCount, parallelismLimit));
  const maxSafeScrambleConcurrency = Math.max(1, Math.floor(workerCount / Math.max(1, opts.styles.length)));
  const scrambleConcurrency = Math.min(
    Math.max(1, opts.scrambleConcurrency),
    Math.max(1, scrambleSet.length),
    maxSafeScrambleConcurrency,
  );

  if (workerCount < requestedWorkerCount || scrambleConcurrency < opts.scrambleConcurrency) {
    console.log(
      `[${mode}] parallelism capped: requested workers=${requestedWorkerCount}, using workers=${workerCount}, requested scrambleConcurrency=${opts.scrambleConcurrency}, using scrambleConcurrency=${scrambleConcurrency}, limit=${parallelismLimit}`,
    );
  }

  const pool = new SolveWorkerPool(workerCount);
  await pool.readyPromise;
  try {
    const timeoutMs = resolveTimeoutMsForMode(mode, opts);
    const runsByStyle = new Map();
    for (let i = 0; i < opts.styles.length; i++) {
      runsByStyle.set(opts.styles[i], []);
    }

    let nextScrambleIndex = 0;
    let completedScrambles = 0;

    async function processScramble(index, workerId) {
      const item = scrambleSet[index];
      const runResults = await Promise.all(
        opts.styles.map((style) =>
          runSingleSolve(pool, item.scramble, {
            scramble: item.scramble,
            mode,
            crossColor: opts.crossColor,
            timeoutMs,
            styleProfile: style,
            transitionProfileSolver: item.sourceSolver,
          }),
        ),
      );

      completedScrambles += 1;
      console.log(
        `[${mode}] [${completedScrambles}/${scrambleSet.length}] #${workerId} scramble id=${item.id} (sample ${index + 1})`,
      );

      const target = targetProfiles.playerMap.get(item.sourceSolver) || null;
      for (let s = 0; s < opts.styles.length; s++) {
        const style = opts.styles[s];
        const run = runResults[s];
        const styleDistanceToTarget =
          run.ok && run.styleMetrics
            ? computeStyleDistance(run.styleMetrics, target, targetProfiles.distanceConfig)
            : null;
        runsByStyle.get(style).push({
          sampleIndex: index + 1,
          id: item.id,
          scramble: item.scramble,
          sourceSolver: item.sourceSolver,
          sourceMethod: item.sourceMethod,
          styleDistanceToTarget,
          ...run,
        });
        const status = run.ok ? `ok moves=${run.moveCount}` : `fail ${run.reason}`;
        console.log(`  - ${style}: ${status}, ${run.durationMs}ms`);
      }
    }

    async function workerLoop(workerId) {
      while (true) {
        const index = nextScrambleIndex;
        nextScrambleIndex += 1;
        if (index >= scrambleSet.length) break;
        await processScramble(index, workerId);
      }
    }

    const workers = [];
    for (let i = 0; i < scrambleConcurrency; i++) {
      workers.push(workerLoop(i + 1));
    }
    await Promise.all(workers);

    const runsByStyleObj = {};
    for (let i = 0; i < opts.styles.length; i++) {
      const style = opts.styles[i];
      const runs = (runsByStyle.get(style) || []).slice().sort((a, b) => a.sampleIndex - b.sampleIndex);
      runsByStyleObj[style] = runs;
    }

    const summaries = opts.styles.map((style) => summarizeRuns(style, runsByStyleObj[style] || []));
    const comparisonVsLegacy = summarizeModeComparisons(mode, summaries);
    const gateEvaluation = comparisonVsLegacy.map((entry) => evaluateBalancedGate(entry));

    return {
      mode,
      summaries,
      comparisonVsLegacy,
      gateEvaluation,
      runsByStyle: runsByStyleObj,
    };
  } finally {
    await pool.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const details = loadDetailsRecords(opts.input);
  const scrambleSet = buildScrambleSet(details, opts);
  if (!scrambleSet.length) {
    throw new Error("No benchmarkable 3x3 scrambles found in input.");
  }
  const coverage = summarizeScrambleCoverage(scrambleSet, opts);

  const targetProfiles = loadStyleProfileSource(opts.styleProfileInput);
  const modeResults = [];
  for (let i = 0; i < opts.modes.length; i++) {
    const mode = opts.modes[i];
    const modeResult = await runModeBenchmarks(mode, scrambleSet, opts, targetProfiles);
    modeResults.push(modeResult);
  }

  const runsByMode = {};
  const summariesByMode = {};
  const comparisonsByMode = {};
  const gateByMode = {};
  for (let i = 0; i < modeResults.length; i++) {
    const row = modeResults[i];
    runsByMode[row.mode] = row.runsByStyle;
    summariesByMode[row.mode] = row.summaries;
    comparisonsByMode[row.mode] = row.comparisonVsLegacy;
    gateByMode[row.mode] = row.gateEvaluation;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceInput: opts.input,
    sourceStyleProfileInput: targetProfiles.sourcePath,
    parameters: {
      offset: opts.offset,
      limit: opts.limit,
      perSolverLimit: opts.perSolverLimit,
      scrambleConcurrency: opts.scrambleConcurrency,
      crossColor: opts.crossColor,
      timeoutMs: opts.timeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS,
      timeoutMsByMode: {
        strict: resolveTimeoutMsForMode("strict", opts),
        zb: resolveTimeoutMsForMode("zb", opts),
      },
      styles: opts.styles,
      modes: opts.modes,
      methods: opts.methods,
      includedMethods: opts.methods,
      samplingPolicy: coverage.samplingPolicy,
      acceptanceGate: "balanced",
    },
    sampleCount: scrambleSet.length,
    samplesPerSolver: coverage.samplesPerSolver,
    solverCoverage: coverage.solverCoverage,
    methodCoverage: coverage.methodCoverage,
    distanceConfig: targetProfiles.distanceConfig,
    gateThresholds: GATE_THRESHOLDS,
    summariesByMode,
    comparisonVsLegacyByMode: comparisonsByMode,
    gateEvaluationByMode: gateByMode,
    runsByMode,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
