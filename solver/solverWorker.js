import { expose } from "../vendor/comlink/index.js";
import { solveWithFMCSearch } from "./fmcSolver.js";
import { solveWithExternalSearch } from "./externalSolver.js";

let solver2x2ModulesPromise = null;
let solver3x3PhaseModulesPromise = null;
const FMC_333_TIMEOUT_MS = 120000;
const STRICT_CFOP_TIMEOUT_MS = 45000;
const STRICT_CFOP_RETRY_TIMEOUT_MS = 25000;
const INTERNAL_333_PHASE_TIMEOUT_MS = 20000;
const EXTERNAL_333_FALLBACK_TIMEOUT_MS = 20000;
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
const INTERNAL_PHASE_FALLBACK_OPTIONS = {
  phase1MaxDepth: 12,
  phase2MaxDepth: 16,
  phase1NodeLimit: 350000,
  phase2NodeLimit: 450000,
};

function normalizeMode(mode) {
  if (mode === "fmc") {
    return "fmc";
  }
  if (mode === "optimal") {
    return "optimal";
  }
  return "strict";
}

function normalizeF2LMethod(method) {
  return "legacy";
}

function shouldFallbackToExternal3x3(result) {
  if (!result || result.ok) return false;
  const reason = String(result.reason || "");
  return (
    reason.startsWith("F2L_") ||
    reason === "FINAL_STATE_NOT_SOLVED" ||
    reason === "INTERNAL_3X3_CFOP_TIMEOUT"
  );
}

function withTimeout(promise, timeoutMs) {
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

async function solveWithInternal2x2(scramble) {
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

async function solveWithInternal3x3StrictCfop(scramble, onProgress, options = {}) {
  const [{ getDefaultPattern }, { solve3x3StrictCfopFromPattern }] = await Promise.all([
    import("./context.js"),
    import("./cfop3x3.js"),
  ]);
  const solved = await getDefaultPattern("333");
  const pattern = solved.applyAlg(scramble);
  return solve3x3StrictCfopFromPattern(pattern, {
    onStageUpdate(progress) {
      if (typeof onProgress === "function") {
        try {
          void onProgress(progress);
        } catch (_) {
          // Progress callback is best-effort.
        }
      }
    },
    crossColor: options.crossColor,
    mode: options.mode,
    f2lMethod: options.f2lMethod,
  });
}

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

async function solveWithInternal3x3StrictRetries(scramble, onProgress, options = {}) {
  const attempts = [
    { timeoutMs: STRICT_CFOP_TIMEOUT_MS, extraOptions: null },
    { timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS, extraOptions: STRICT_F2L_RETRY_OPTIONS[0] },
    { timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS, extraOptions: STRICT_F2L_RETRY_OPTIONS[1] },
  ];

  let firstFailureReason = "";
  let lastFailure = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
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
        ...options,
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

const api = {
  async ping() {
    // Start async warmups early; don't block ping response.
    void prewarmInternal2x2();
    void prewarmInternal3x3StrictCfop();
    void prewarmInternal3x3Phase();
    return { ok: true };
  },
  async solve(arg1, arg2, arg3, arg4, arg5, arg6) {
    let scramble;
    let eventId;
    let onProgress;
    let crossColor = "D";
    let mode = "strict";
    let f2lMethod = "legacy";
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
        if (mode === "fmc" || mode === "optimal") {
          const isOptimalMode = mode === "optimal";
          const fmcResult = await withTimeout(
            solveWithFMCSearch(scramble, onProgress, {
              maxPremoveSets: isOptimalMode ? 8 : 3,
              timeBudgetMs: isOptimalMode ? 65000 : 25000,
              targetMoveCount: isOptimalMode ? 19 : 24,
              premoveAllowCfopFallback: isOptimalMode,
              crossColors: isOptimalMode ? ["D", "U", "F", "B", "R", "L"] : ["D"],
            }),
            FMC_333_TIMEOUT_MS,
          ).catch(() => ({ ok: false, reason: isOptimalMode ? "OPTIMAL_TIMEOUT" : "FMC_TIMEOUT" }));
          if (fmcResult?.ok) {
            return fmcResult;
          }
          if (mode === "fmc") {
            return fmcResult || { ok: false, reason: "FMC_FAILED" };
          }
        }
        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "queue", eventId: "333" });
          } catch (_) {}
        }
        const strictResult = await solveWithInternal3x3StrictRetries(scramble, onProgress, {
          crossColor,
          mode,
          f2lMethod,
        });

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
          // Do not use external library fallback in optimal/fmc mode.
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
