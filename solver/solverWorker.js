import { expose } from "../vendor/comlink/index.js";
import { solveWithFMCSearch } from "./fmcSolver.js";
import { solveWithExternalSearch } from "./externalSolver.js";
import { ensureWasmSolverReady, solveWithWasmIfAvailable } from "./wasmSolver.js";

// 워커 내부 상태 및 모듈 캐시: 2x2 및 3x3 phase solver 모듈을 비동기적으로 로드합니다.
let solver2x2ModulesPromise = null;
let solver3x3PhaseModulesPromise = null;
const FMC_333_TIMEOUT_MS = 120000;
const OPTIMAL_333_TIMEOUT_MS = 240000;
// 시간 제한 및 탐색 전략: 다양한 solver 모드에서 안정적으로 결과를 가져오기 위한 설정값입니다.
const STRICT_CFOP_TIMEOUT_MS = 150000;
const STRICT_CFOP_RETRY_TIMEOUT_MS = 90000;
const INTERNAL_333_PHASE_TIMEOUT_MS = 20000;
const EXTERNAL_333_FALLBACK_TIMEOUT_MS = 20000;
const ROUX_PARALLEL_ROTATIONS = Object.freeze(["", "x", "x'", "z", "z'", "x2"]);
const ROUX_PARALLEL_COLOR_LOCK_ROTATIONS = Object.freeze(["", "y", "y'", "y2"]);
const ROUX_PARALLEL_MAX_WORKERS = 6;
const ROUX_PARALLEL_CANDIDATE_TIMEOUT_MS = 70000;
const ROUX_PARALLEL_DEFAULT_SCOUT_CHECKS = 6;
const ROUX_PARALLEL_EARLY_STOP_MOVE_COUNT = 48;
const ROUX_PARALLEL_PRIMARY_ENABLED = true;
const ROUX_PARALLEL_RESCUE_TIMEOUT_MS = 70000;
const ROUX_PARALLEL_RESCUE_MAX_WORKERS = 4;
const ROUX_PARALLEL_RESCUE_SCOUT_CHECKS = 3;
const ROUX_PARALLEL_RESCUE_CANDIDATE_TIMEOUT_MS = 30000;
const CROSS_COLOR_ROTATION_CANDIDATES = Object.freeze({
  D: Object.freeze([""]),
  U: Object.freeze(["x2"]),
  F: Object.freeze(["x", "x'"]),
  B: Object.freeze(["x'", "x"]),
  R: Object.freeze(["z'", "z"]),
  L: Object.freeze(["z", "z'"]),
});
const STRICT_F2L_RETRY_OPTIONS = [
  {
    f2lFormulaMaxSteps: 16,
    f2lFormulaBeamWidth: 12,
    f2lFormulaExpansionLimit: 20,
    f2lFormulaMaxAttempts: 600000,
    f2lSearchMaxDepth: 14,
    f2lNodeLimit: 600000,
  },
  {
    f2lFormulaMaxSteps: 18,
    f2lFormulaBeamWidth: 16,
    f2lFormulaExpansionLimit: 28,
    f2lFormulaMaxAttempts: 1200000,
    f2lSearchMaxDepth: 16,
    f2lNodeLimit: 1500000,
  },
];
const ROUX_RETRY_OPTIONS = [
  {
    sbSearchMaxDepth: 12,
    sbNodeLimit: 480000,
    cmllFormulaAttemptLimit: 90000,
    cmllSearchMaxDepth: 12,
    cmllNodeLimit: 320000,
    lseFormulaAttemptLimit: 75000,
    lseSearchMaxDepth: 12,
    lseNodeLimit: 320000,
  },
  {
    sbSearchMaxDepth: 13,
    sbNodeLimit: 760000,
    cmllFormulaAttemptLimit: 120000,
    cmllSearchMaxDepth: 13,
    cmllNodeLimit: 460000,
    lseFormulaAttemptLimit: 110000,
    lseSearchMaxDepth: 13,
    lseNodeLimit: 460000,
  },
  {
    sbSearchMaxDepth: 14,
    sbNodeLimit: 1100000,
    cmllFormulaAttemptLimit: 170000,
    cmllSearchMaxDepth: 14,
    cmllNodeLimit: 620000,
    lseFormulaAttemptLimit: 150000,
    lseSearchMaxDepth: 14,
    lseNodeLimit: 620000,
  },
  {
    sbSearchMaxDepth: 15,
    sbNodeLimit: 1500000,
    cmllFormulaAttemptLimit: 240000,
    cmllSearchMaxDepth: 15,
    cmllNodeLimit: 820000,
    lseFormulaAttemptLimit: 220000,
    lseSearchMaxDepth: 15,
    lseNodeLimit: 880000,
  },
  {
    sbSearchMaxDepth: 16,
    sbNodeLimit: 2600000,
    cmllFormulaAttemptLimit: 320000,
    cmllSearchMaxDepth: 16,
    cmllNodeLimit: 1400000,
    lseFormulaAttemptLimit: 360000,
    lseSearchMaxDepth: 16,
    lseNodeLimit: 1800000,
  },
];
const ROUX_STRICT_RETRY_OPTIONS = Object.freeze([
  ROUX_RETRY_OPTIONS[2],
  ROUX_RETRY_OPTIONS[3],
  ROUX_RETRY_OPTIONS[4],
]);
const ZB_RETRY_OPTIONS = [
  {
    zblsFormulaAttemptLimit: 70000,
    zblsSearchMaxDepth: 12,
    zblsNodeLimit: 900000,
    zbllFormulaAttemptLimit: 90000,
    zbllSearchMaxDepth: 13,
    zbllNodeLimit: 760000,
  },
  {
    zblsFormulaAttemptLimit: 100000,
    zblsSearchMaxDepth: 13,
    zblsNodeLimit: 1300000,
    zbllFormulaAttemptLimit: 140000,
    zbllSearchMaxDepth: 14,
    zbllNodeLimit: 1200000,
  },
  {
    zblsFormulaAttemptLimit: 180000,
    zblsSearchMaxDepth: 15,
    zblsNodeLimit: 2200000,
    zbllFormulaAttemptLimit: 240000,
    zbllSearchMaxDepth: 16,
    zbllNodeLimit: 2600000,
  },
  {
    zblsFormulaAttemptLimit: 260000,
    zblsSearchMaxDepth: 16,
    zblsNodeLimit: 3400000,
    zbllFormulaAttemptLimit: 320000,
    zbllSearchMaxDepth: 17,
    zbllNodeLimit: 3800000,
  },
];
const INTERNAL_PHASE_FALLBACK_OPTIONS = {
  phase1MaxDepth: 13,
  phase2MaxDepth: 20,
  phase1NodeLimit: 0,
  phase2NodeLimit: 0,
  timeCheckInterval: 768,
};

function normalizeMode(mode) {
  // 사용자 입력 또는 저장된 값에서 유효한 solver 모드 문자열을 정규화합니다.
  const normalized = String(mode || "strict").trim().toLowerCase();
  if (normalized === "zz") {
    return "zb";
  }
  if (normalized === "fmc") {
    return "fmc";
  }
  if (normalized === "optimal") {
    return "optimal";
  }
  if (normalized === "roux") {
    return "roux";
  }
  if (normalized === "zb") {
    return "zb";
  }
  return "strict";
}

function normalizeF2LMethod(method) {
  // F2L 방법 이름을 표준화하여 내부 로직에서 일관되게 처리합니다.
  const normalized = String(method || "legacy").trim().toLowerCase();
  if (normalized === "search") {
    return "search";
  }
  if (
    normalized === "fast" ||
    normalized === "hybrid" ||
    normalized === "free" ||
    normalized === "nodb" ||
    normalized === "no-db"
  ) {
    return "hybrid";
  }
  return "legacy";
}

// Cross 색상 값을 검증하고 기본값으로 보정합니다.
function normalizeCrossColor(color) {
  const normalized = String(color || "D").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CROSS_COLOR_ROTATION_CANDIDATES, normalized)
    ? normalized
    : "D";
}

function getCrossRotationCandidates(color) {
  // 선택된 cross 색상에 따라 회전 후보를 반환합니다.
  const normalized = normalizeCrossColor(color);
  const rotations = CROSS_COLOR_ROTATION_CANDIDATES[normalized];
  return Array.isArray(rotations) && rotations.length ? rotations : [""];
}

// 내부 3x3 solver가 실패했을 때 외부 fallback을 시도할지 판별합니다.
function shouldFallbackToExternal3x3(result) {
  if (!result || result.ok) return false;
  const reason = String(result.reason || "");
  return (
    reason.startsWith("FB_") ||
    reason.startsWith("SB_") ||
    reason.startsWith("CMLL_") ||
    reason.startsWith("LSE_") ||
    reason.startsWith("XCROSS_") ||
    reason.startsWith("F2L_") ||
    reason.startsWith("F2L2_") ||
    reason.startsWith("ZBLS_") ||
    reason.startsWith("ZBLL_") ||
    reason.endsWith("_TIMEOUT") ||
    reason === "FINAL_STATE_NOT_SOLVED" ||
    reason === "INTERNAL_3X3_CFOP_TIMEOUT"
  );
}

// Promise에 타임아웃을 적용하여 오래 걸리는 작업을 안전하게 처리합니다.
function withTimeout(promise, timeoutMs) {
  // 주어진 Promise에 시간 제한을 추가합니다. 제한 초과 시 TIMEOUT 에러를 발생시킵니다.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT_${timeoutMs}MS`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// 2x2 내부 solver 실행: WASM 우선, 없으면 JS 모듈로 폴백합니다.
async function solveWithInternal2x2(scramble) {
  const wasmResult = await solveWithWasmIfAvailable(scramble, "222");
  if (wasmResult?.ok) {
    return {
      ok: true,
      solution: wasmResult.solution,
      moveCount: wasmResult.moveCount,
      nodes: wasmResult.nodes ?? 0,
      bound: wasmResult.bound ?? 0,
      source: "WASM_2X2",
    };
  }

  if (!solver2x2ModulesPromise) {
    solver2x2ModulesPromise = import("./solver2x2.js");
  }
  const { solve2x2Scramble } = await solver2x2ModulesPromise;
  const result = await solve2x2Scramble(scramble);
  if (!result) {
    return { ok: false, reason: "NO_SOLUTION" };
  }
  return {
    ok: true,
    solution: result.solution,
    moveCount: result.moveCount,
    nodes: result.nodes ?? 0,
    bound: result.bound ?? 0,
  };
}

// 3x3 CFOP solver 실행: 패턴 생성 후 CFOP 단계별 탐색을 수행합니다.
async function solveWithInternal3x3StrictCfop(scramble, onProgress, options = {}) {
  const [{ getDefaultPattern }, { solve3x3StrictCfopFromPattern }] = await Promise.all([
    import("./context.js"),
    import("./cfop3x3.js"),
  ]);
  const solved = await getDefaultPattern("333");
  const pattern = solved.applyAlg(scramble);
  return solve3x3StrictCfopFromPattern(pattern, {
    ...options,
    onStageUpdate(progress) {
      if (typeof onProgress === "function") {
        try {
          void onProgress(progress);
        } catch (_) {
          // Progress callback is best-effort.
        }
      }
    },
  });
}

// 3x3 내부 phase solver 실행: phase1/phase2 기반 플래너를 사용합니다.
async function solveWithInternal3x3Phase(scramble, options = {}) {
  if (!solver3x3PhaseModulesPromise) {
    solver3x3PhaseModulesPromise = import("./solver3x3Phase/index.js");
  }
  const [{ getDefaultPattern }, { solve3x3InternalPhase }] = await Promise.all([
    import("./context.js"),
    solver3x3PhaseModulesPromise,
  ]);
  const solved = await getDefaultPattern("333");
  const pattern = solved.applyAlg(scramble);
  return solve3x3InternalPhase(pattern, options);
}

// 입력 값이 양의 정수인지 확인하고, 아니면 기본값을 반환합니다.
function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN > 0 ? intN : fallback;
}

// 입력 값이 0 이상 정수인지 확인하고, 아니면 기본값을 반환합니다.
function normalizeNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN >= 0 ? intN : fallback;
}

// Roux 후보 탐색을 위해 서브 워커를 생성하고 결과를 비동기적으로 가져옵니다.
async function runRouxCandidateInSubWorker(scramble, rotationAlg, options, timeoutMs) {
  if (typeof Worker !== "function") {
    return { ok: false, reason: "WORKER_UNAVAILABLE" };
  }

  return await new Promise((resolve) => {
    let finished = false;
    let worker = null;
    let timer = 0;

    function done(result) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (worker) {
        try {
          worker.terminate();
        } catch (_) {}
      }
      resolve(result || { ok: false, reason: "ROUX_SUBWORKER_EMPTY_RESULT" });
    }

    try {
      worker = new Worker(new URL("./rouxCandidateWorker.js", import.meta.url), { type: "module" });
    } catch (_) {
      done({ ok: false, reason: "ROUX_SUBWORKER_SPAWN_FAILED" });
      return;
    }

    worker.addEventListener("message", (event) => {
      done(event?.data || { ok: false, reason: "ROUX_SUBWORKER_NO_DATA" });
    });
    worker.addEventListener("error", () => {
      done({ ok: false, reason: "ROUX_SUBWORKER_RUNTIME_ERROR" });
    });
    worker.addEventListener("messageerror", () => {
      done({ ok: false, reason: "ROUX_SUBWORKER_MESSAGE_ERROR" });
    });

    timer = setTimeout(() => {
      done({ ok: false, reason: "ROUX_SUBWORKER_TIMEOUT" });
    }, timeoutMs);

    try {
      worker.postMessage({
        scramble,
        rotationAlg,
        options,
      });
    } catch (_) {
      done({ ok: false, reason: "ROUX_SUBWORKER_POST_FAILED" });
    }
  });
}

// Roux 병렬 탐색: 여러 방향으로 후보를 생성해 최적 해를 찾습니다.
async function solveWithInternal3x3RouxParallel(scramble, onProgress, options = {}) {
  if (options.rouxParallelEnabled === false) return null;
  if (typeof Worker !== "function") return null;

  const normalizedCrossColor = normalizeCrossColor(options.crossColor);
  const baseCrossRotations = getCrossRotationCandidates(normalizedCrossColor);
  const defaultOrientationCandidates =
    normalizedCrossColor === "D" ? ROUX_PARALLEL_ROTATIONS : ROUX_PARALLEL_COLOR_LOCK_ROTATIONS;
  const requested = Array.isArray(options.rouxOrientationCandidates)
    ? options.rouxOrientationCandidates
    : defaultOrientationCandidates;
  const orientationRotations = [];
  const seenOrientation = new Set();
  for (let i = 0; i < requested.length; i++) {
    const value = String(requested[i] || "").trim();
    if (seenOrientation.has(value)) continue;
    seenOrientation.add(value);
    orientationRotations.push(value);
  }
  if (!seenOrientation.has("")) {
    orientationRotations.unshift("");
  }

  const rotations = [];
  const seenCombined = new Set();
  const pushRotation = (baseRotation, orientationRotation = "") => {
    const combined = `${String(baseRotation || "").trim()} ${String(orientationRotation || "").trim()}`
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (seenCombined.has(combined)) return;
    seenCombined.add(combined);
    rotations.push(combined);
  };
  for (let i = 0; i < baseCrossRotations.length; i++) {
    pushRotation(baseCrossRotations[i], "");
  }
  const primaryBaseRotation = String(baseCrossRotations[0] || "").trim();
  for (let i = 0; i < orientationRotations.length; i++) {
    const orientation = String(orientationRotations[i] || "").trim();
    if (!orientation) continue;
    pushRotation(primaryBaseRotation, orientation);
  }
  if (!rotations.length) {
    rotations.push("");
  }

  const maxWorkers = Math.min(
    normalizePositiveInt(options.rouxParallelWorkers, ROUX_PARALLEL_MAX_WORKERS),
    ROUX_PARALLEL_MAX_WORKERS,
    rotations.length,
  );
  const candidateTimeoutMs = normalizePositiveInt(
    options.rouxParallelCandidateTimeoutMs,
    ROUX_PARALLEL_CANDIDATE_TIMEOUT_MS,
  );
  const scoutChecks = normalizeNonNegativeInt(
    options.rouxParallelScoutChecks,
    Math.min(rotations.length, ROUX_PARALLEL_DEFAULT_SCOUT_CHECKS),
  );
  const minimumCrossChecks = Math.min(rotations.length, Math.max(1, baseCrossRotations.length));
  const candidateCount = Math.max(minimumCrossChecks, Math.max(1, Math.min(rotations.length, scoutChecks)));
  const candidateRotations = rotations.slice(0, candidateCount);
  const earlyStopMoveCount = normalizePositiveInt(
    options.rouxParallelStopMoveCount,
    ROUX_PARALLEL_EARLY_STOP_MOVE_COUNT,
  );
  const subWorkerOptions = {
    ...options,
    mode: "roux",
    crossColor: "D",
    __colorNeutralApplied: true,
    __rouxOrientationApplied: true,
    rouxSweepMaxChecks: 0,
  };
  // Roux parallel sweep uses the fast profile by default so LSE doesn't dominate wall-clock time.
  if (options.rouxParallelFastProfile !== false) {
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "enablePostInsertionOptimization")) {
      subWorkerOptions.enablePostInsertionOptimization = false;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "fbMaxDepth")) {
        subWorkerOptions.fbMaxDepth = 10;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "sbMaxDepth")) {
        subWorkerOptions.sbMaxDepth = 12;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "sbSearchMaxDepth")) {
        subWorkerOptions.sbSearchMaxDepth = 11;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "sbNodeLimit")) {
        subWorkerOptions.sbNodeLimit = 550000;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "cmllSearchMaxDepth")) {
        subWorkerOptions.cmllSearchMaxDepth = 11;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "cmllNodeLimit")) {
        subWorkerOptions.cmllNodeLimit = 420000;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "cmllFormulaAttemptLimit")) {
        subWorkerOptions.cmllFormulaAttemptLimit = 90000;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "lseSearchMaxDepth")) {
        subWorkerOptions.lseSearchMaxDepth = 11;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "lseNodeLimit")) {
        subWorkerOptions.lseNodeLimit = 500000;
    }
    if (!Object.prototype.hasOwnProperty.call(subWorkerOptions, "lseFormulaAttemptLimit")) {
        subWorkerOptions.lseFormulaAttemptLimit = 110000;
    }
  }

  if (typeof onProgress === "function") {
    try {
      void onProgress({
        type: "fallback_start",
        stageName: `Roux Parallel Sweep (${candidateCount})`,
        reason: `${maxWorkers} workers`,
      });
    } catch (_) {}
  }

  let nextIndex = 0;
  let running = 0;
  let best = null;
  const failures = [];
  let stopLaunch = false;

  return await new Promise((resolve) => {
    const maybeFinish = () => {
      if (running > 0) return;
      if (!stopLaunch && nextIndex < candidateRotations.length) return;
      if (typeof onProgress === "function") {
        try {
          void onProgress({
            type: best?.ok ? "fallback_done" : "fallback_fail",
            stageName: "Roux Parallel Sweep",
          });
        } catch (_) {}
      }
      if (best?.ok) {
        resolve(best);
      } else {
        resolve({
          ok: false,
          reason: failures[0] || "ROUX_PARALLEL_ALL_FAILED",
        });
      }
    };

    const launch = () => {
      while (!stopLaunch && running < maxWorkers && nextIndex < candidateRotations.length) {
        const idx = nextIndex++;
        const rotation = candidateRotations[idx];
        running += 1;
        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "fallback_start",
              stageName: `Roux Candidate ${idx + 1}/${candidateRotations.length}`,
              reason: rotation || "identity",
            });
          } catch (_) {}
        }

        void runRouxCandidateInSubWorker(scramble, rotation, subWorkerOptions, candidateTimeoutMs)
          .then((result) => {
            if (result?.ok) {
              if (!best || result.moveCount < best.moveCount) {
                best = result;
              }
              if (best?.moveCount <= earlyStopMoveCount) {
                stopLaunch = true;
              }
              if (typeof onProgress === "function") {
                try {
                  void onProgress({
                    type: "fallback_done",
                    stageName: `Roux Candidate ${idx + 1}/${candidateRotations.length}`,
                  });
                } catch (_) {}
              }
            } else {
              failures.push(String(result?.reason || "ROUX_CANDIDATE_FAILED"));
              if (typeof onProgress === "function") {
                try {
                  void onProgress({
                    type: "fallback_fail",
                    stageName: `Roux Candidate ${idx + 1}/${candidateRotations.length}`,
                  });
                } catch (_) {}
              }
            }
          })
          .catch((error) => {
            failures.push(String(error?.message || "ROUX_CANDIDATE_ERROR"));
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_fail",
                  stageName: `Roux Candidate ${idx + 1}/${candidateRotations.length}`,
                });
              } catch (_) {}
            }
          })
          .finally(() => {
            running -= 1;
            launch();
            maybeFinish();
          });
      }
      maybeFinish();
    };

    launch();
  });
}

async function solveWithInternal3x3StrictRetries(scramble, onProgress, options = {}) {
  const hasCustomRetryOptions = Object.prototype.hasOwnProperty.call(options, "retryOptions");
  const customRetryOptions = hasCustomRetryOptions
    ? Array.isArray(options.retryOptions)
      ? options.retryOptions
      : []
    : STRICT_F2L_RETRY_OPTIONS;
  const baseOptions = { ...options };
  delete baseOptions.retryOptions;
  const attempts = [{ timeoutMs: STRICT_CFOP_TIMEOUT_MS, extraOptions: null }];
  for (let i = 0; i < customRetryOptions.length; i++) {
    attempts.push({
      timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS,
      extraOptions: customRetryOptions[i],
    });
  }

  let firstFailureReason = "";
  let lastFailure = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const explicitDeadline = Number.isFinite(baseOptions.deadlineTs) ? Number(baseOptions.deadlineTs) : Infinity;
    const attemptDeadlineTs = Math.min(explicitDeadline, Date.now() + Math.max(500, attempt.timeoutMs - 120));
    if (i > 0 && typeof onProgress === "function") {
      try {
        void onProgress({
          type: "fallback_start",
          stageName: `3x3 Strict Retry ${i}/${attempts.length - 1}`,
          reason: lastFailure?.reason || firstFailureReason || "F2L_RECOVERY",
        });
      } catch (_) {}
    }

    const strictResult = await withTimeout(
      solveWithInternal3x3StrictCfop(scramble, onProgress, {
        ...baseOptions,
        deadlineTs: attemptDeadlineTs,
        ...(attempt.extraOptions || {}),
      }),
      attempt.timeoutMs,
    ).catch(() => ({ ok: false, reason: "INTERNAL_3X3_CFOP_TIMEOUT" }));

    if (strictResult?.ok) {
      if (i > 0) {
        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "fallback_done", stageName: "3x3 Strict Retry" });
          } catch (_) {}
        }
        return {
          ...strictResult,
          source: "INTERNAL_3X3_CFOP_RETRY",
          fallbackFrom: firstFailureReason || "F2L_FAILED",
        };
      }
      return strictResult;
    }

    if (!firstFailureReason) {
      firstFailureReason = String(strictResult?.reason || "");
    }
    lastFailure = strictResult;
    if (!shouldFallbackToExternal3x3(strictResult)) {
      return strictResult;
    }
  }

  return lastFailure || { ok: false, reason: "INTERNAL_3X3_CFOP_FAILED" };
}

async function prewarmInternal2x2() {
  try {
    const { solve2x2Scramble } = await import("./solver2x2.js");
    await solve2x2Scramble("R U R' U'");
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmInternal3x3StrictCfop() {
  try {
    const [{ getDefaultPattern }, { solve3x3StrictCfopFromPattern }] = await Promise.all([
      import("./context.js"),
      import("./cfop3x3.js"),
    ]);
    const solved = await getDefaultPattern("333");
    await solve3x3StrictCfopFromPattern(solved, {
      crossMaxDepth: 1,
      f2lMaxDepth: 1,
      ollMaxDepth: 1,
      pllMaxDepth: 1,
    });
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmInternal3x3Phase() {
  try {
    if (!solver3x3PhaseModulesPromise) {
      solver3x3PhaseModulesPromise = import("./solver3x3Phase/index.js");
    }
    await solver3x3PhaseModulesPromise;
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmWasmSolver() {
  try {
    await ensureWasmSolverReady();
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmRouxParallel() {
  try {
    await runRouxCandidateInSubWorker(
      "R U R' U' F R U R' U' F'",
      "",
      {
        mode: "roux",
        crossColor: "D",
        __colorNeutralApplied: true,
        __rouxOrientationApplied: true,
        rouxSweepMaxChecks: 0,
        enablePostInsertionOptimization: false,
        fbMaxDepth: 6,
        sbMaxDepth: 10,
        cmllSearchMaxDepth: 7,
        lseSearchMaxDepth: 8,
      },
      12000,
    );
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

const api = {
  async ping() {
    // Start async warmups early; don't block ping response.
    void prewarmInternal2x2();
    void prewarmInternal3x3StrictCfop();
    void prewarmInternal3x3Phase();
    void prewarmWasmSolver();
    void prewarmRouxParallel();
    return { ok: true };
  },
  async solve(arg1, arg2, arg3, arg4, arg5, arg6) {
    let scramble;
    let eventId;
    let onProgress;
    let crossColor = "D";
    let mode = "strict";
    let f2lMethod = "legacy";
    let rouxParallelPrimary = ROUX_PARALLEL_PRIMARY_ENABLED;
    let rouxParallelRescue = true;
    let rouxOrientationSweep = true;
    let rouxSweepMaxChecks = 3;
    let rouxAllowCfopStageRecovery = true;
    let rouxRecoverAllStages = false;
    let rouxSafetyCfop = false;
    if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
      scramble = arg1.scramble;
      eventId = arg1.eventId;
      onProgress = arg1.onProgress;
      if (typeof arg1.crossColor === "string" && arg1.crossColor) {
        crossColor = arg1.crossColor;
      }
      if (typeof arg1.mode === "string" && arg1.mode) {
        mode = arg1.mode;
      }
      if (typeof arg1.f2lMethod === "string" && arg1.f2lMethod) {
        f2lMethod = arg1.f2lMethod;
      }
      if (typeof arg1.rouxParallelPrimary === "boolean") {
        rouxParallelPrimary = arg1.rouxParallelPrimary;
      } else if (typeof arg1.rouxParallelFirst === "boolean") {
        rouxParallelPrimary = arg1.rouxParallelFirst;
      }
      if (typeof arg1.rouxParallelRescue === "boolean") {
        rouxParallelRescue = arg1.rouxParallelRescue;
      }
      if (typeof arg1.rouxOrientationSweep === "boolean") {
        rouxOrientationSweep = arg1.rouxOrientationSweep;
      }
      if (Object.prototype.hasOwnProperty.call(arg1, "rouxSweepMaxChecks")) {
        rouxSweepMaxChecks = normalizeNonNegativeInt(arg1.rouxSweepMaxChecks, rouxSweepMaxChecks);
      }
      if (typeof arg1.rouxAllowCfopStageRecovery === "boolean") {
        rouxAllowCfopStageRecovery = arg1.rouxAllowCfopStageRecovery;
      }
      if (typeof arg1.rouxRecoverAllStages === "boolean") {
        rouxRecoverAllStages = arg1.rouxRecoverAllStages;
      }
      if (typeof arg1.rouxSafetyCfop === "boolean") {
        rouxSafetyCfop = arg1.rouxSafetyCfop;
      }
    } else {
      scramble = arg1;
      eventId = arg2;
      onProgress = arg3;
      if (typeof arg4 === "string" && arg4) {
        crossColor = arg4;
      }
      if (typeof arg5 === "string" && arg5) {
        mode = arg5;
      }
      if (typeof arg6 === "string" && arg6) {
        f2lMethod = arg6;
      }
    }
    mode = normalizeMode(mode);
    f2lMethod = normalizeF2LMethod(f2lMethod);
    const normalizedEventId = eventId === "333fm" ? "333" : eventId;
    if (!scramble) {
      return { ok: false, reason: "NO_SCRAMBLE" };
    }

    // 222 uses in-repo solver implementation.
    try {
      if (normalizedEventId === "222") {
        // 2x2 internal solver is IDA* based and already shortest-path oriented.
        return await solveWithInternal2x2(scramble);
      }
      if (normalizedEventId === "333") {
        const wasm3x3Result = await solveWithWasmIfAvailable(scramble, "333");
        if (wasm3x3Result?.ok) {
          return {
            ...wasm3x3Result,
            source: "WASM_3X3",
          };
        }

        if (mode === "fmc" || mode === "optimal") {
          const isOptimalMode = mode === "optimal";
          const fmcLikeTimeoutMs = isOptimalMode ? OPTIMAL_333_TIMEOUT_MS : FMC_333_TIMEOUT_MS;
          const fmcCrossColor = normalizeCrossColor(crossColor);
          const baseFmcOptions = {
            maxPremoveSets: isOptimalMode ? 180 : 16,
            timeBudgetMs: isOptimalMode ? 170000 : 20000,
            sweepBudgetMs: isOptimalMode ? 125000 : 7000,
            aggressivePrune: isOptimalMode ? false : true,
            sweepIncludeInverse: true,
            targetMoveCount: isOptimalMode ? 18 : 24,
            allowCfopFallback: false,
            premoveAllowCfopFallback: false,
            preferNonCfop: true,
            directProfileLevel: isOptimalMode ? "xdeep" : "deep",
            directMaxProfiles: isOptimalMode ? 4 : 3,
            nissMaxProfiles: isOptimalMode ? 4 : 3,
            directPhaseAttemptTimeoutMs: isOptimalMode ? 10500 : 2800,
            directStageBudgetMs: isOptimalMode ? 42000 : 6000,
            nissStageBudgetMs: isOptimalMode ? 42000 : 6000,
            phaseTimeCheckInterval: 768,
            directCfopPerColorTimeoutMs: isOptimalMode ? 1500 : 1000,
            sweepProfileLevel: isOptimalMode ? "deep" : "light",
            sweepMaxProfiles: isOptimalMode ? 3 : 2,
            sweepHeavyMaxProfiles: isOptimalMode ? 4 : 2,
            sweepPhaseAttemptTimeoutMs: isOptimalMode ? 2600 : 1200,
            sweepAttemptBudgetMs: isOptimalMode ? 2600 : 1200,
            sweepCfopPerColorTimeoutMs: isOptimalMode ? 900 : 800,
            sweepUseScout: true,
            sweepScoutProfileLevel: isOptimalMode ? "light" : "micro",
            sweepScoutMaxProfiles: isOptimalMode ? 2 : 1,
            sweepScoutPhaseAttemptTimeoutMs: isOptimalMode ? 1000 : 500,
            sweepScoutAttemptBudgetMs: isOptimalMode ? 1000 : 500,
            sweepScoutCfopPerColorTimeoutMs: isOptimalMode ? 750 : 600,
            sweepScoutIncludeInverse: true,
            sweepScoutLimit: isOptimalMode ? 120 : 16,
            sweepRefineSets: isOptimalMode ? 48 : 8,
            sweepScoutImproveBy: isOptimalMode ? 0 : 1,
            sweepImproveBy: 1,
            sweepRefineSlack: isOptimalMode ? 2 : 3,
            sweepSkipGap: isOptimalMode ? 2 : 3,
            sweepScoutInverseSkipSlack: isOptimalMode ? 1 : 0,
            sweepInverseSkipSlack: isOptimalMode ? 1 : 0,
            sweepMaxUnsolvedRefine: isOptimalMode ? 10 : 8,
            sweepScoutMaxNoImprove: isOptimalMode ? 40 : 18,
            sweepMaxNoImprove: isOptimalMode ? 28 : 10,
            verifyLimit: isOptimalMode ? 80 : 16,
            enableInsertions: true,
            insertionCandidateLimit: isOptimalMode ? 6 : 2,
            insertionMaxPasses: isOptimalMode ? 4 : 2,
            insertionMinWindow: 3,
            insertionMaxWindow: isOptimalMode ? 8 : 6,
            insertionMaxDepth: isOptimalMode ? 7 : 5,
            insertionTimeMs: isOptimalMode ? 18000 : 2500,
            insertionThreshold: isOptimalMode ? 25 : 24,
            crossColors: [fmcCrossColor],
          };

          let fmcResult = await withTimeout(
            solveWithFMCSearch(scramble, onProgress, baseFmcOptions),
            fmcLikeTimeoutMs,
          ).catch(() => ({ ok: false, reason: isOptimalMode ? "OPTIMAL_TIMEOUT" : "FMC_TIMEOUT" }));
          if (!fmcResult?.ok) {
            const deepRetryStageName = isOptimalMode ? "Optimal Deep Retry" : "FMC Deep Retry";
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_start",
                  stageName: deepRetryStageName,
                  reason: fmcResult?.reason || "FMC_NO_VALID_SOLUTION",
                });
              } catch (_) {}
            }
            const deepRetryTimeoutMs = Math.min(
              isOptimalMode ? 90000 : 36000,
              Math.max(12000, fmcLikeTimeoutMs - 4000),
            );
            const deepRetryResult = await withTimeout(
              solveWithFMCSearch(scramble, onProgress, {
                ...baseFmcOptions,
                maxPremoveSets: isOptimalMode ? 220 : 42,
                timeBudgetMs: isOptimalMode ? 205000 : 36000,
                sweepBudgetMs: isOptimalMode ? 150000 : 16000,
                aggressivePrune: false,
                directProfileLevel: "xdeep",
                directMaxProfiles: isOptimalMode ? 5 : 4,
                nissMaxProfiles: isOptimalMode ? 5 : 4,
                directPhaseAttemptTimeoutMs: isOptimalMode ? 12500 : 4200,
                directStageBudgetMs: isOptimalMode ? 58000 : 12000,
                nissStageBudgetMs: isOptimalMode ? 58000 : 12000,
                sweepProfileLevel: "deep",
                sweepMaxProfiles: isOptimalMode ? 4 : 3,
                sweepHeavyMaxProfiles: isOptimalMode ? 5 : 4,
                sweepPhaseAttemptTimeoutMs: isOptimalMode ? 3200 : 1800,
                sweepAttemptBudgetMs: isOptimalMode ? 3200 : 1800,
                sweepCfopPerColorTimeoutMs: isOptimalMode ? 1000 : 900,
                sweepScoutProfileLevel: "light",
                sweepScoutMaxProfiles: 2,
                sweepScoutPhaseAttemptTimeoutMs: isOptimalMode ? 1200 : 700,
                sweepScoutAttemptBudgetMs: isOptimalMode ? 1200 : 700,
                sweepScoutCfopPerColorTimeoutMs: isOptimalMode ? 900 : 700,
                sweepScoutLimit: isOptimalMode ? 160 : 28,
                sweepRefineSets: isOptimalMode ? 64 : 16,
                sweepScoutImproveBy: 0,
                verifyLimit: isOptimalMode ? 140 : 48,
                insertionCandidateLimit: isOptimalMode ? 8 : 4,
                insertionMaxPasses: isOptimalMode ? 5 : 3,
                insertionMaxWindow: isOptimalMode ? 9 : 7,
                insertionMaxDepth: isOptimalMode ? 8 : 6,
                insertionTimeMs: isOptimalMode ? 26000 : 6500,
              }),
              deepRetryTimeoutMs,
            ).catch(() => ({ ok: false, reason: isOptimalMode ? "OPTIMAL_DEEP_TIMEOUT" : "FMC_DEEP_TIMEOUT" }));
            if (deepRetryResult?.ok) {
              if (typeof onProgress === "function") {
                try {
                  void onProgress({
                    type: "fallback_done",
                    stageName: deepRetryStageName,
                  });
                } catch (_) {}
              }
              return deepRetryResult;
            }
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_fail",
                  stageName: deepRetryStageName,
                });
              } catch (_) {}
            }
            fmcResult = deepRetryResult || fmcResult;
          }
          if (fmcResult?.ok) {
            return fmcResult;
          }
          if (mode === "fmc" || mode === "optimal") {
            const safetyStageName = isOptimalMode ? "Optimal Safety Phase" : "FMC Safety Phase";
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_start",
                  stageName: safetyStageName,
                  reason: fmcResult?.reason || "FMC_NO_VALID_SOLUTION",
                });
              } catch (_) {}
            }
            const phaseSafety = await withTimeout(
              solveWithInternal3x3Phase(scramble, {
                ...INTERNAL_PHASE_FALLBACK_OPTIONS,
                ...(isOptimalMode
                  ? {
                      phase1MaxDepth: 14,
                      phase2MaxDepth: 22,
                    }
                  : {}),
                deadlineTs: Date.now() + Math.min(isOptimalMode ? 18000 : 9000, INTERNAL_333_PHASE_TIMEOUT_MS - 800),
              }),
              INTERNAL_333_PHASE_TIMEOUT_MS,
            ).catch(() => null);
            if (phaseSafety?.ok) {
              if (typeof onProgress === "function") {
                try {
                  void onProgress({
                    type: "fallback_done",
                    stageName: safetyStageName,
                  });
                } catch (_) {}
              }
              return {
                ...phaseSafety,
                source: isOptimalMode
                  ? "INTERNAL_3X3_PHASE_OPTIMAL_SAFETY"
                  : "INTERNAL_3X3_PHASE_FMC_SAFETY",
                fallbackFrom: fmcResult?.reason || "FMC_NO_VALID_SOLUTION",
              };
            }
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_fail",
                  stageName: safetyStageName,
                });
              } catch (_) {}
            }
            return fmcResult || { ok: false, reason: isOptimalMode ? "OPTIMAL_FAILED" : "FMC_FAILED" };
          }
        }
        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "queue", eventId: "333" });
          } catch (_) {}
        }
        let rouxParallelSucceeded = false;
        if (mode === "roux" && rouxParallelPrimary) {
          const parallelRouxResult = await withTimeout(
            solveWithInternal3x3RouxParallel(scramble, onProgress, {
              crossColor,
              mode,
              f2lMethod,
            }),
            STRICT_CFOP_TIMEOUT_MS,
          ).catch(() => null);
          rouxParallelSucceeded = !!parallelRouxResult?.ok;
          if (parallelRouxResult?.ok) {
            return {
              ...parallelRouxResult,
              source: "INTERNAL_3X3_ROUX_PARALLEL",
            };
          }
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_start",
                stageName: "Roux Core Search",
                reason: parallelRouxResult?.reason || "ROUX_PARALLEL_FAILED",
              });
            } catch (_) {}
          }
        }

        let strictResult = null;
        let strictAttemptedWithCurrentMethod = false;
        let noDbFailureReason = "";
        const shouldRunNoDbPrimary = mode === "strict" && (f2lMethod === "hybrid" || f2lMethod === "search");
        const noDbStageName = f2lMethod === "search" ? "F2L No-DB Search" : "F2L Hybrid (DB Seed + No-DB)";
        if (shouldRunNoDbPrimary) {
          strictAttemptedWithCurrentMethod = true;
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_start",
                stageName: noDbStageName,
                reason: f2lMethod === "search" ? "algorithmic search" : "db-seeded hybrid search",
              });
            } catch (_) {}
          }
          strictResult = await solveWithInternal3x3StrictRetries(scramble, onProgress, {
            crossColor,
            mode: "strict",
            f2lMethod,
            retryOptions: [],
          });
          if (!strictResult?.ok && f2lMethod === "hybrid") {
            noDbFailureReason = String(strictResult?.reason || "F2L_HYBRID_FAILED");
          }
          if (strictResult?.ok) {
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_done",
                  stageName: noDbStageName,
                });
              } catch (_) {}
            }
          } else if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_fail",
                stageName: noDbStageName,
              });
            } catch (_) {}
          }
        }

        if (!strictResult?.ok) {
          const useLegacyRecovery = mode === "strict" && f2lMethod === "hybrid";
          const shouldRetryCurrentMethod = !(mode === "strict" && strictAttemptedWithCurrentMethod);
          if (useLegacyRecovery || shouldRetryCurrentMethod) {
            strictResult = await solveWithInternal3x3StrictRetries(scramble, onProgress, {
              crossColor,
              mode,
              f2lMethod: useLegacyRecovery ? "legacy" : f2lMethod,
              ...(mode === "roux"
                ? {
                    sbFormulaBeamWidth: 12,
                    sbFormulaExpansionLimit: 20,
                    sbFormulaMaxAttempts: 1200000,
                    sbSearchMaxDepth: 16,
                    sbNodeLimit: 2400000,
                    cmllFormulaAttemptLimit: 280000,
                    cmllSearchMaxDepth: 15,
                    cmllNodeLimit: 1300000,
                    lseFormulaAttemptLimit: 320000,
                    lseSearchMaxDepth: 16,
                    lseNodeLimit: 2400000,
                    lseSecondarySearchMaxDepth: 17,
                    lseSecondaryNodeLimit: 3600000,
                    lsePllFallback: true,
                    lseStageTimeBudgetMs: 70000,
                    sbDeepRetry: true,
                    rouxLastLayerDeepRetry: true,
                    retryOptions: ROUX_STRICT_RETRY_OPTIONS,
                    // Parallel sweep already covers orientation alternatives.
                    rouxOrientationSweep: rouxParallelSucceeded ? false : rouxOrientationSweep,
                    rouxSweepMaxChecks: rouxParallelSucceeded ? 0 : rouxSweepMaxChecks,
                    rouxAllowCfopStageRecovery,
                    rouxRecoverAllStages,
                  }
                : {}),
              ...(mode === "zb"
                ? {
                    zblsFormulaAttemptLimit: 180000,
                    zblsSearchMaxDepth: 15,
                    zblsNodeLimit: 2200000,
                    zbllFormulaAttemptLimit: 240000,
                    zbllSearchMaxDepth: 16,
                    zbllNodeLimit: 2600000,
                    retryOptions: ZB_RETRY_OPTIONS,
                  }
                : {}),
              ...(useLegacyRecovery
                ? {
                    enablePostInsertionOptimization: true,
                    postInsertionMaxPasses: 2,
                    postInsertionMinWindow: 3,
                    postInsertionMaxWindow: 7,
                    postInsertionMaxDepth: 5,
                    postInsertionTimeMs: 900,
                  }
                : {}),
            });
            if (useLegacyRecovery && strictResult?.ok) {
              strictResult = {
                ...strictResult,
                source: strictResult.source || "INTERNAL_3X3_CFOP_HYBRID_RECOVERY",
                fallbackFrom: noDbFailureReason || strictResult.fallbackFrom || "F2L_HYBRID_FAILED",
              };
            }
          }
        }

        if (!strictResult?.ok && mode === "roux" && !rouxParallelSucceeded && rouxParallelRescue) {
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_start",
                stageName: "Roux Parallel Sweep",
                reason: strictResult?.reason || "ROUX_STAGE_FAILED",
              });
            } catch (_) {}
          }
          const rouxParallelRescueResult = await withTimeout(
            solveWithInternal3x3RouxParallel(scramble, onProgress, {
              crossColor,
              mode,
              f2lMethod,
              rouxParallelWorkers: ROUX_PARALLEL_RESCUE_MAX_WORKERS,
              rouxParallelScoutChecks: ROUX_PARALLEL_RESCUE_SCOUT_CHECKS,
              rouxParallelCandidateTimeoutMs: ROUX_PARALLEL_RESCUE_CANDIDATE_TIMEOUT_MS,
            }),
            ROUX_PARALLEL_RESCUE_TIMEOUT_MS,
          ).catch(() => null);
          if (rouxParallelRescueResult?.ok) {
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_done",
                  stageName: "Roux Parallel Sweep",
                });
              } catch (_) {}
            }
            return {
              ...rouxParallelRescueResult,
              source: "INTERNAL_3X3_ROUX_PARALLEL_RESCUE",
              fallbackFrom: strictResult?.reason || "ROUX_STAGE_FAILED",
            };
          }
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_fail",
                stageName: "Roux Parallel Sweep",
              });
            } catch (_) {}
          }
        }

        if (!strictResult?.ok && mode === "roux" && rouxSafetyCfop) {
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_start",
                stageName: "Roux Safety CFOP",
                reason: strictResult?.reason || "ROUX_STAGE_FAILED",
              });
            } catch (_) {}
          }
          const rouxSafetyResult = await solveWithInternal3x3StrictRetries(scramble, onProgress, {
            crossColor,
            mode: "strict",
            f2lMethod: "legacy",
            retryOptions: [STRICT_F2L_RETRY_OPTIONS[0]],
          });
          if (rouxSafetyResult?.ok) {
            if (typeof onProgress === "function") {
              try {
                void onProgress({
                  type: "fallback_done",
                  stageName: "Roux Safety CFOP",
                });
              } catch (_) {}
            }
            return {
              ...rouxSafetyResult,
              source: "INTERNAL_3X3_ROUX_SAFETY_CFOP",
              fallbackFrom: strictResult?.reason || "ROUX_STAGE_FAILED",
            };
          }
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "fallback_fail",
                stageName: "Roux Safety CFOP",
              });
            } catch (_) {}
          }
        }

        if (strictResult?.ok || !shouldFallbackToExternal3x3(strictResult)) {
          return strictResult;
        }

        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "fallback_start",
              stageName: "3x3 Internal Phase",
              reason: strictResult.reason,
            });
          } catch (_) {}
        }

        const phaseResult = await withTimeout(
          solveWithInternal3x3Phase(scramble, INTERNAL_PHASE_FALLBACK_OPTIONS),
          INTERNAL_333_PHASE_TIMEOUT_MS,
        ).catch(() => ({ ok: false, reason: "INTERNAL_3X3_PHASE_TIMEOUT" }));

        if (phaseResult?.ok) {
          if (typeof onProgress === "function") {
            try {
              void onProgress({ type: "fallback_done", stageName: "3x3 Internal Phase" });
            } catch (_) {}
          }
          return {
            ...phaseResult,
            source: "INTERNAL_3X3_PHASE_FALLBACK",
            fallbackFrom: strictResult.reason || "F2L_FAILED",
          };
        }

        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "fallback_fail", stageName: "3x3 Internal Phase" });
          } catch (_) {}
        }

        if (mode !== "strict") {
          // Do not use external library fallback in non-strict modes (optimal/fmc/roux/zb).
          return phaseResult?.reason ? phaseResult : strictResult;
        }

        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "fallback_start",
              stageName: "3x3 External",
              reason: phaseResult?.reason || strictResult.reason,
            });
          } catch (_) {}
        }

        const fallbackResult = await withTimeout(
          solveWithExternalSearch(scramble, "333"),
          EXTERNAL_333_FALLBACK_TIMEOUT_MS,
        ).catch(() => null);

        if (fallbackResult?.ok) {
          if (typeof onProgress === "function") {
            try {
              void onProgress({ type: "fallback_done", stageName: "3x3 External" });
            } catch (_) {}
          }
          return {
            ...fallbackResult,
            source: "EXTERNAL_CUBING_SEARCH_FALLBACK",
            fallbackFrom: strictResult.reason || "F2L_FAILED",
          };
        }

        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "fallback_fail", stageName: "3x3 External" });
          } catch (_) {}
        }

        return phaseResult?.reason ? phaseResult : strictResult;
      }
      return { ok: false, reason: "UNSUPPORTED_EVENT" };
    } catch (error) {
      console.error("Search solver error", error);
      return { ok: false, reason: `SOLVER_ERROR: ${error?.message || error}` };
    }
  },
};

expose(api);
