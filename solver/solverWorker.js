import { expose } from "../vendor/comlink/index.js";

let solver2x2ModulesPromise = null;
let solver3x3PhaseModulesPromise = null;
let fmcSolverModulePromise = null;
let externalSolverModulePromise = null;
let profileSupportModulesPromise = null;
let wasmSolverModulePromise = null;
const FMC_333_TIMEOUT_MS = 120000;
const STRICT_CFOP_TIMEOUT_MS = 25000;
const STRICT_CFOP_RETRY_TIMEOUT_MS = 12000;
const ROUX_333_TIMEOUT_MS = 45000;
const INTERNAL_333_PHASE_TIMEOUT_MS = 20000;
const TWOPHASE_333_TIMEOUT_MS = 45000;
const TWOPHASE_333_MAX_FRONTIERS = 12;
const EXTERNAL_333_FALLBACK_TIMEOUT_MS = 20000;
const MINMOVE_333_TIMEOUT_MS = 235000;
const MINMOVE_333_EXACT_PROOF_TIMEOUT_MS = 60000;
const MINMOVE_333_PHASE_SEED_TIMEOUT_MS = 25000;
const MINMOVE_333_PHASE_SEED_MAX_FRONTIERS = 96;
const MINMOVE_333_PHASE_SEED_PHASE1_MAX_DEPTH = 15;
const PROFILE_PREWARM_SCRAMBLE = "U2 L' F' R U' F2 L D L2 F' B R2 F' U2 R2 F' U2 F U'";
const STRICT_F2L_RETRY_OPTIONS = [
  {
    f2lFormulaMaxSteps: 14,
    f2lFormulaBeamWidth: 8,
    f2lFormulaExpansionLimit: 12,
    f2lFormulaMaxAttempts: 240000,
    f2lFormulaBeamBudgetMs: 30,
    f2lSearchMaxDepth: 12,
    f2lNodeLimit: 320000,
  },
  {
    f2lFormulaMaxSteps: 16,
    f2lFormulaBeamWidth: 10,
    f2lFormulaExpansionLimit: 16,
    f2lFormulaMaxAttempts: 420000,
    f2lFormulaBeamBudgetMs: 40,
    f2lSearchMaxDepth: 14,
    f2lNodeLimit: 800000,
  },
];
const INTERNAL_PHASE_FALLBACK_OPTIONS = {
  phase1MaxDepth: 13,
  phase2MaxDepth: 20,
  phase1NodeLimit: 0,
  phase2NodeLimit: 0,
  timeCheckInterval: 768,
};

function getFmcSolverModule() {
  if (!fmcSolverModulePromise) {
    fmcSolverModulePromise = import("./fmcSolver.js");
  }
  return fmcSolverModulePromise;
}

function getExternalSolverModule() {
  if (!externalSolverModulePromise) {
    externalSolverModulePromise = import("./externalSolver.js");
  }
  return externalSolverModulePromise;
}

function getProfileSupportModules() {
  if (!profileSupportModulesPromise) {
    profileSupportModulesPromise = Promise.all([
      import("./f2lTransitionProfiles.js"),
      import("./f2lDownstreamProfiles.js"),
      import("./llFamilyCalibration.js"),
    ]).then(([transitionProfiles, downstreamProfiles, llCalibration]) => ({
      getF2LTransitionProfileForSolver: transitionProfiles.getF2LTransitionProfileForSolver,
      getF2LDownstreamProfileForSolver: downstreamProfiles.getF2LDownstreamProfileForSolver,
      getLlFamilyCalibrationForSolver: llCalibration.getLlFamilyCalibrationForSolver,
    }));
  }
  return profileSupportModulesPromise;
}

function getWasmSolverModule() {
  if (!wasmSolverModulePromise) {
    wasmSolverModulePromise = import("./wasmSolver.js");
  }
  return wasmSolverModulePromise;
}

async function solveWithFMCSearchLazy(scramble, onProgress, options) {
  const { solveWithFMCSearch } = await getFmcSolverModule();
  return solveWithFMCSearch(scramble, onProgress, options);
}

async function solveWithExternalSearchLazy(scramble, eventId) {
  const { solveWithExternalSearch } = await getExternalSolverModule();
  return solveWithExternalSearch(scramble, eventId);
}

async function getF2LTransitionProfileForSolverLazy(transitionProfileSolver) {
  const { getF2LTransitionProfileForSolver } = await getProfileSupportModules();
  return getF2LTransitionProfileForSolver(transitionProfileSolver);
}

async function getF2LDownstreamProfileForSolverLazy(transitionProfileSolver) {
  const { getF2LDownstreamProfileForSolver } = await getProfileSupportModules();
  return getF2LDownstreamProfileForSolver(transitionProfileSolver);
}

async function getLlFamilyCalibrationForSolverLazy(transitionProfileSolver) {
  const { getLlFamilyCalibrationForSolver } = await getProfileSupportModules();
  return getLlFamilyCalibrationForSolver(transitionProfileSolver);
}

async function ensureMinmove333ReadyLazy() {
  const { ensureMinmove333Ready } = await getWasmSolverModule();
  return ensureMinmove333Ready();
}

async function ensureTwophase333ReadyLazy() {
  const { ensureTwophase333Ready } = await getWasmSolverModule();
  return ensureTwophase333Ready();
}

async function ensureWasmSolverReadyLazy() {
  const { ensureWasmSolverReady } = await getWasmSolverModule();
  return ensureWasmSolverReady();
}

async function prepareMinmove333Lazy(scramble) {
  const { prepareMinmove333 } = await getWasmSolverModule();
  return prepareMinmove333(scramble);
}

async function prepareTwophase333Lazy(scramble, options) {
  const { prepareTwophase333 } = await getWasmSolverModule();
  return prepareTwophase333(scramble, options);
}

async function searchMinmove333BoundLazy(searchId, bound, maxNodes) {
  const { searchMinmove333Bound } = await getWasmSolverModule();
  return searchMinmove333Bound(searchId, bound, maxNodes);
}

async function searchTwophase333Lazy(searchId, options) {
  const { searchTwophase333 } = await getWasmSolverModule();
  return searchTwophase333(searchId, options);
}

async function searchTwophaseExact333Lazy(scramble, options) {
  const { searchTwophaseExact333 } = await getWasmSolverModule();
  return searchTwophaseExact333(scramble, options);
}

async function dropMinmove333SearchLazy(searchId) {
  const { dropMinmove333Search } = await getWasmSolverModule();
  return dropMinmove333Search(searchId);
}

async function dropTwophase333SearchLazy(searchId) {
  const { dropTwophase333Search } = await getWasmSolverModule();
  return dropTwophase333Search(searchId);
}

async function solveWithWasmIfAvailableLazy(scramble, eventId) {
  const { solveWithWasmIfAvailable } = await getWasmSolverModule();
  return solveWithWasmIfAvailable(scramble, eventId);
}

function normalizeMode(mode) {
  if (mode === "fmc") {
    return "fmc";
  }
  if (mode === "optimal" || mode === "minmove") {
    return "minmove";
  }
  if (mode === "twophase" || mode === "two-phase" || mode === "phase") {
    return "twophase";
  }
  if (mode === "zb") {
    return "zb";
  }
  if (mode === "roux") {
    return "roux";
  }
  return "strict";
}

function normalizeF2LMethod(method) {
  const normalized = String(method || "legacy").toLowerCase();
  if (normalized === "balanced") return "balanced";
  if (normalized === "rotationless") return "rotationless";
  if (normalized === "low-auf") return "low-auf";
  if (normalized === "top10-mixed" || normalized === "elite-mixed" || normalized === "mixed") {
    return "top10-mixed";
  }
  return "legacy";
}

function normalizeCrossColorList(crossColor) {
  const normalized = String(crossColor || "D").toUpperCase();
  if (
    normalized === "CN" ||
    normalized === "COLOR_NEUTRAL" ||
    normalized === "COLOR-NEUTRAL" ||
    normalized === "AUTO"
  ) {
    return ["D", "U", "F", "B", "R", "L"];
  }
  return [normalized];
}

function splitAlgorithmTokens(sequence) {
  return String(sequence || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function invertOuterMoveToken(token) {
  const normalized = String(token || "").trim();
  if (!/^[URFDLB](2|'|2')?$/.test(normalized)) return "";
  if (normalized.endsWith("2") || normalized.endsWith("2'")) {
    return `${normalized[0]}2`;
  }
  if (normalized.endsWith("'")) {
    return normalized.slice(0, -1);
  }
  return `${normalized}'`;
}

function invertAlgorithmString(sequence) {
  const tokens = splitAlgorithmTokens(sequence);
  if (!tokens.length) return "";
  const inverse = [];
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = invertOuterMoveToken(tokens[i]);
    if (!token) return "";
    inverse.push(token);
  }
  return inverse.join(" ");
}

function countAlgorithmMoves(sequence) {
  return splitAlgorithmTokens(sequence).length;
}

async function verify3x3Solution(scramble, solution) {
  try {
    const { getDefaultPattern } = await import("./context.js");
    const solvedPattern = await getDefaultPattern("333");
    const scrambledPattern = solvedPattern.applyAlg(scramble);
    const afterSolution = solution ? scrambledPattern.applyAlg(solution) : scrambledPattern;
    return typeof afterSolution.experimentalIsSolved === "function"
      ? !!afterSolution.experimentalIsSolved({ ignorePuzzleOrientation: false })
      : JSON.stringify(afterSolution.patternData) === JSON.stringify(solvedPattern.patternData);
  } catch (_) {
    return false;
  }
}

async function normalizeVerifiedMinmoveCandidate(scramble, solution, invert = false) {
  let normalizedSolution = String(solution || "").trim();
  if (!normalizedSolution) return null;
  if (invert) {
    normalizedSolution = invertAlgorithmString(normalizedSolution);
  }
  if (!normalizedSolution) return null;
  if (!(await verify3x3Solution(scramble, normalizedSolution))) {
    return null;
  }
  return {
    solution: normalizedSolution,
    moveCount: countAlgorithmMoves(normalizedSolution),
  };
}

function buildMinmoveWorkerResult(solution, meta = {}) {
  const normalizedSolution = String(solution || "").trim();
  const moveCount = countAlgorithmMoves(normalizedSolution);
  const optimalityProven = meta.optimalityProven !== false;
  return {
    ok: true,
    solution: normalizedSolution,
    moveCount,
    nodes: Number.isFinite(meta.nodes) ? meta.nodes : 0,
    bound: Number.isFinite(meta.bound) ? meta.bound : moveCount,
    source: String(meta.source || "MINMOVE_333_WASM"),
    metric: "HTM",
    optimalityProven,
    lowerBound: Number.isFinite(meta.lowerBound) ? meta.lowerBound : null,
    upperBoundLength: Number.isFinite(meta.upperBoundLength) ? meta.upperBoundLength : moveCount,
    proofSource: String(meta.proofSource || (optimalityProven ? "exact_search" : "phase_fallback")),
    fallbackReason: meta.fallbackReason ? String(meta.fallbackReason) : null,
  };
}

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
  const wasmResult = await solveWithWasmIfAvailableLazy(scramble, "222");
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

async function solveWithInternal3x3StrictCfop(scramble, onProgress, options = {}) {
  const [{ getDefaultPattern }, { solve3x3StrictCfopFromPattern }] = await Promise.all([
    import("./context.js"),
    import("./cfop3x3.js"),
  ]);
  const solved = await getDefaultPattern("333");
  const pattern = solved.applyAlg(scramble);
  const f2lStyleProfile =
    options.f2lMethod && options.f2lMethod !== "legacy" ? options.f2lMethod : undefined;
  const styleProfile =
    options.styleProfile !== undefined && options.styleProfile !== null
      ? options.styleProfile
      : f2lStyleProfile;
  // Use player-specified solve mode (e.g. "zb" for ZB-method players like Xuanyi Geng)
  // Falls back to deriving mode from primaryMethod when solveMode is not explicitly set.
  const profileSolveMode =
    styleProfile && typeof styleProfile === "object" && typeof styleProfile.solveMode === "string"
      ? styleProfile.solveMode.toLowerCase()
      : styleProfile &&
          typeof styleProfile === "object" &&
          typeof styleProfile.primaryMethod === "string" &&
          styleProfile.primaryMethod.toUpperCase() === "ZB"
        ? "zb"
        : null;
  const effectiveMode = profileSolveMode && profileSolveMode !== options.mode ? profileSolveMode : options.mode;
  return solve3x3StrictCfopFromPattern(pattern, {
    ...options,
    mode: effectiveMode,
    scramble,
    styleProfile,
    enableMixedCfopStages:
      options.enableMixedCfopStages === true ||
      (typeof options.f2lMethod === "string" && options.f2lMethod.toLowerCase() === "mixed"),
    svWvMode:
      options.svWvMode === true ||
      (typeof options.svWvUsage === "number" && options.svWvUsage > 0.1),
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

async function solveWithInternal3x3TwoPhase(scramble, onProgress) {
  const inverseSolution = invertAlgorithmString(scramble);
  const inverseLength = inverseSolution ? countAlgorithmMoves(inverseSolution) : 0;
  const phaseStartedAt = Date.now();
  let phaseResult = null;
  let phaseSource = "INTERNAL_3X3_TWOPHASE";

  if (typeof onProgress === "function") {
    try {
      void onProgress({
        type: "stage_start",
        stageIndex: 0,
        totalStages: 1,
        stageName: "3x3 Two-Phase",
      });
    } catch (_) {}
  }

  let twophaseSearchId = null;
  try {
    const wasmReady = await ensureTwophase333ReadyLazy().catch(() => null);
    if (wasmReady) {
      const prepared = await withTimeout(
        prepareTwophase333Lazy(scramble, {
          maxPhase1Solutions: TWOPHASE_333_MAX_FRONTIERS,
          phase1MaxDepth: INTERNAL_PHASE_FALLBACK_OPTIONS.phase1MaxDepth,
          phase1NodeLimit: INTERNAL_PHASE_FALLBACK_OPTIONS.phase1NodeLimit,
        }),
        TWOPHASE_333_TIMEOUT_MS,
      ).catch(() => null);
      if (prepared?.ok && Number.isFinite(prepared.searchId)) {
        twophaseSearchId = prepared.searchId;
        const searched = await withTimeout(
          searchTwophase333Lazy(twophaseSearchId, {
            incumbentLength: inverseLength > 0 ? inverseLength : undefined,
            phase2MaxDepth: INTERNAL_PHASE_FALLBACK_OPTIONS.phase2MaxDepth,
            phase2NodeLimit: INTERNAL_PHASE_FALLBACK_OPTIONS.phase2NodeLimit,
          }),
          TWOPHASE_333_TIMEOUT_MS,
        ).catch(() => null);
        if (searched?.ok) {
          phaseResult = searched;
          phaseSource = "WASM_3X3_TWOPHASE";
        }
      }
    }
  } finally {
    if (Number.isFinite(twophaseSearchId)) {
      void dropTwophase333SearchLazy(twophaseSearchId).catch(() => false);
    }
  }

  if (!phaseResult?.ok) {
    phaseResult = await withTimeout(
      solveWithInternal3x3Phase(scramble, {
        ...INTERNAL_PHASE_FALLBACK_OPTIONS,
        maxPhase1Solutions: TWOPHASE_333_MAX_FRONTIERS,
        targetTotalDepth: inverseLength > 0 ? inverseLength - 1 : undefined,
      }),
      TWOPHASE_333_TIMEOUT_MS,
    ).catch(() => ({ ok: false, reason: "INTERNAL_3X3_TWOPHASE_TIMEOUT" }));
    phaseSource = "INTERNAL_3X3_TWOPHASE";
  }

  if (!phaseResult?.ok) {
    if (typeof onProgress === "function") {
      try {
        void onProgress({
          type: "stage_fail",
          stageIndex: 0,
          totalStages: 1,
          stageName: "3x3 Two-Phase",
        });
      } catch (_) {}
    }
    return { ok: false, reason: phaseResult?.reason || "INTERNAL_3X3_TWOPHASE_FAILED" };
  }

  const solution = String(phaseResult.solution || "").trim();
  if (!(await verify3x3Solution(scramble, solution))) {
    return { ok: false, reason: "TWOPHASE_FINAL_STATE_NOT_SOLVED" };
  }

  if (typeof onProgress === "function") {
    try {
      void onProgress({
        type: "stage_done",
        stageIndex: 0,
        totalStages: 1,
        stageName: "3x3 Two-Phase",
        moveCount: Number.isFinite(phaseResult.moveCount) ? phaseResult.moveCount : countAlgorithmMoves(solution),
        elapsedMs: Math.max(1, Date.now() - phaseStartedAt),
      });
    } catch (_) {}
  }

  return {
    ...phaseResult,
    solution,
    source: phaseSource,
    metric: "HTM",
    optimalityProven: false,
    proofSource: "two_phase_practical",
    upperBoundLength: inverseLength > 0 ? inverseLength : null,
  };
}

async function buildMinmovePhaseSeed(scramble, incumbentLength) {
  // Try WASM 2-phase first (faster, handles more frontiers efficiently)
  try {
    const wasmReady = await ensureTwophase333ReadyLazy().catch(() => null);
    if (wasmReady) {
      let wasmSearchId = null;
      try {
        const prepared = await withTimeout(
          prepareTwophase333Lazy(scramble, {
            maxPhase1Solutions: MINMOVE_333_PHASE_SEED_MAX_FRONTIERS,
            phase1MaxDepth: MINMOVE_333_PHASE_SEED_PHASE1_MAX_DEPTH,
          }),
          MINMOVE_333_PHASE_SEED_TIMEOUT_MS,
        ).catch(() => null);
        if (prepared?.ok && Number.isFinite(prepared.searchId)) {
          wasmSearchId = prepared.searchId;
          const searched = await withTimeout(
            searchTwophase333Lazy(wasmSearchId, {
              incumbentLength: incumbentLength > 0 ? incumbentLength : undefined,
              phase2MaxDepth: 20,
              phase2NodeLimit: 20_000_000,
            }),
            MINMOVE_333_PHASE_SEED_TIMEOUT_MS,
          ).catch(() => null);
          if (searched?.ok) return searched;
        }
      } finally {
        if (Number.isFinite(wasmSearchId)) {
          void dropTwophase333SearchLazy(wasmSearchId).catch(() => {});
        }
      }
    }
  } catch (_) {}
  // Fall back to JS phase solver
  return withTimeout(
    solveWithInternal3x3Phase(scramble, {
      ...INTERNAL_PHASE_FALLBACK_OPTIONS,
      maxPhase1Solutions: MINMOVE_333_PHASE_SEED_MAX_FRONTIERS,
      phase1MaxDepth: MINMOVE_333_PHASE_SEED_PHASE1_MAX_DEPTH,
      targetTotalDepth: incumbentLength > 0 ? incumbentLength - 1 : undefined,
    }),
    MINMOVE_333_PHASE_SEED_TIMEOUT_MS,
  ).catch(() => null);
}

async function solveWithInternal3x3Minmove(scramble, onProgress) {
  const inverseSolution = invertAlgorithmString(scramble);
  if (splitAlgorithmTokens(scramble).length > 0 && !inverseSolution) {
    return { ok: false, reason: "MINMOVE_BAD_SCRAMBLE" };
  }

  let incumbentSolution = inverseSolution;
  let incumbentLength = countAlgorithmMoves(incumbentSolution);
  let incumbentSource = "inverse scramble";
  let incumbentVerified = false;

  if (typeof onProgress === "function") {
    try {
      void onProgress({ type: "upper_bound_start", stageName: "Seed upper bound" });
    } catch (_) {}
  }

  // Run seeds for original scramble and inverse direction in parallel
  const [phaseSeed, phaseSeedInvDir] = await Promise.all([
    buildMinmovePhaseSeed(scramble, incumbentLength),
    buildMinmovePhaseSeed(inverseSolution, incumbentLength),
  ]);

  const normalizedPhaseSeed = phaseSeed?.ok ? String(phaseSeed.solution || "").trim() : "";
  const normalizedPhaseSeedLength = Number.isFinite(phaseSeed?.moveCount)
    ? phaseSeed.moveCount
    : countAlgorithmMoves(normalizedPhaseSeed);
  if (normalizedPhaseSeed && Number.isFinite(normalizedPhaseSeedLength)) {
    const phaseSeedVerified = await verify3x3Solution(scramble, normalizedPhaseSeed);
    if (phaseSeedVerified && normalizedPhaseSeedLength <= incumbentLength) {
      incumbentSolution = normalizedPhaseSeed;
      incumbentLength = normalizedPhaseSeedLength;
      incumbentSource = "phase seed";
      incumbentVerified = true;
    }
  }

  // Inverse direction: solving the inverse scramble and inverting gives an alternative solution
  if (phaseSeedInvDir?.ok) {
    const rawInvDir = String(phaseSeedInvDir.solution || "").trim();
    const convertedInvDir = rawInvDir ? invertAlgorithmString(rawInvDir) : null;
    if (convertedInvDir) {
      const invDirLength = Number.isFinite(phaseSeedInvDir.moveCount)
        ? phaseSeedInvDir.moveCount
        : countAlgorithmMoves(convertedInvDir);
      if (invDirLength < incumbentLength) {
        const invDirVerified = await verify3x3Solution(scramble, convertedInvDir);
        if (invDirVerified) {
          incumbentSolution = convertedInvDir;
          incumbentLength = invDirLength;
          incumbentSource = "inverse direction seed";
          incumbentVerified = true;
        }
      }
    }
  }

  if (!incumbentVerified && !(await verify3x3Solution(scramble, incumbentSolution))) {
    return { ok: false, reason: "MINMOVE_SEED_INVALID" };
  }

  if (typeof onProgress === "function") {
    try {
      void onProgress({
        type: "upper_bound_done",
        upperBoundLength: incumbentLength,
        upperBoundSource: incumbentSource,
      });
    } catch (_) {}
  }

  const ready = await ensureMinmove333ReadyLazy();
  if (!ready) {
    return { ok: false, reason: "MINMOVE_UNAVAILABLE" };
  }

  const prepared = await prepareMinmove333Lazy(scramble);
  if (!prepared?.ok) {
    return { ok: false, reason: prepared?.reason || "MINMOVE_PREPARE_FAILED" };
  }

  const lowerBound = Number.isFinite(prepared.lowerBound) ? prepared.lowerBound : 0;
  const reverseDepth = Number.isFinite(prepared.reverseDepth) ? prepared.reverseDepth : 0;
  const reverseStates = Number.isFinite(prepared.reverseStates) ? prepared.reverseStates : 0;
  const searchId = Number.isFinite(prepared.searchId) ? prepared.searchId : null;
  if (!Number.isFinite(searchId)) {
    return { ok: false, reason: "MINMOVE_INVALID_SEARCH_ID" };
  }

  if (typeof onProgress === "function") {
    try {
      void onProgress({
        type: "exact_search_start",
        lowerBound,
        reverseDepth,
        reverseStates,
        upperBoundLength: incumbentLength,
      });
    } catch (_) {}
  }

  const deadlineTs = Date.now() + MINMOVE_333_TIMEOUT_MS;
  const exactSearchDeadlineTs = Math.min(deadlineTs, Date.now() + MINMOVE_333_EXACT_PROOF_TIMEOUT_MS);

  if (lowerBound >= incumbentLength) {
    await dropMinmove333SearchLazy(searchId);
    if (typeof onProgress === "function") {
      try {
        void onProgress({ type: "optimality_proven", moveCount: incumbentLength, proofSource: "seed upper bound" });
      } catch (_) {}
    }
    return buildMinmoveWorkerResult(incumbentSolution, {
      nodes: 0,
      bound: incumbentLength,
      lowerBound,
      upperBoundLength: incumbentLength,
      source: incumbentSource === "phase seed" ? "MINMOVE_333_PHASE_SEED_PROVEN" : "MINMOVE_333_INVERSE_SEED_PROVEN",
      proofSource: "seed_upper_bound",
    });
  }

  // If the gap between incumbent and lower bound is too large the exact search
  // cannot complete within any practical timeout. Try iterative two-phase
  // tightening to drive the upper bound down before resorting to fallback.
  const MINMOVE_MAX_FEASIBLE_GAP = 8;
  if (incumbentLength - lowerBound > MINMOVE_MAX_FEASIBLE_GAP) {
    if (typeof onProgress === "function") {
      try {
        void onProgress({ type: "twophase_tighten_start", lowerBound, upperBoundLength: incumbentLength });
      } catch (_) {}
    }

    const TIGHTEN_BUDGET_MS = 12000;
    const tightenDeadline = Date.now() + TIGHTEN_BUDGET_MS;
    const EXACT_TIGHTEN_BUDGET_MS = 4500;
    const exactTightenDeadline = Math.min(tightenDeadline, Date.now() + EXACT_TIGHTEN_BUDGET_MS);
    const exactTightenProfiles = [
      { phase1NodeLimit: 2_000_000, phase2NodeLimit: 20_000_000 },
      { phase1NodeLimit: 8_000_000, phase2NodeLimit: 50_000_000 },
    ];
    const tightenConfigs = [
      { frontiers: 96, phase1MaxDepth: 15, phase2NodeLimit: 8_000_000 },
      { frontiers: 192, phase1MaxDepth: 17, phase2NodeLimit: 15_000_000 },
      { frontiers: 384, phase1MaxDepth: 18, phase2NodeLimit: 25_000_000 },
    ];

    // Try original scramble + inverse scramble with two-phase
    const scramblesToTry = [scramble];
    const inverseScramble = invertAlgorithmString(scramble);
    if (inverseScramble) scramblesToTry.push(inverseScramble);

    const wasmTpReady = await ensureTwophase333ReadyLazy().catch(() => null);
    if (wasmTpReady) {
      const exactDirections = [{ scramble, isInverse: false }];
      if (inverseScramble) {
        exactDirections.push({ scramble: inverseScramble, isInverse: true });
      }

      while (
        Date.now() < exactSearchDeadlineTs &&
        Date.now() < exactTightenDeadline &&
        incumbentLength - lowerBound > MINMOVE_MAX_FEASIBLE_GAP
      ) {
        const targetLength = incumbentLength - 1;
        if (targetLength <= lowerBound) break;

        let improvedThisRound = false;
        let exhaustedAllDirections = true;

        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "twophase_tighten_exact_start",
              lowerBound,
              upperBoundLength: incumbentLength,
              targetLength,
            });
          } catch (_) {}
        }

        for (const exactDirection of exactDirections) {
          let exhaustedThisDirection = false;
          for (const profile of exactTightenProfiles) {
            if (Date.now() >= exactSearchDeadlineTs || Date.now() >= exactTightenDeadline) {
              exhaustedAllDirections = false;
              break;
            }

            const searched = await searchTwophaseExact333Lazy(exactDirection.scramble, {
              maxTotalDepth: targetLength,
              phase1NodeLimit: profile.phase1NodeLimit,
              phase2NodeLimit: profile.phase2NodeLimit,
            }).catch(() => null);

            if (!searched?.ok) {
              exhaustedThisDirection = false;
              break;
            }

            if (searched.found && typeof searched.solution === "string") {
              const candidate = await normalizeVerifiedMinmoveCandidate(
                scramble,
                searched.solution,
                exactDirection.isInverse,
              );
              if (candidate && candidate.moveCount < incumbentLength) {
                incumbentSolution = candidate.solution;
                incumbentLength = candidate.moveCount;
                incumbentSource = "twophase tighten";
                improvedThisRound = true;
                if (typeof onProgress === "function") {
                  try {
                    void onProgress({
                      type: "twophase_tighten_improved",
                      moveCount: incumbentLength,
                      lowerBound,
                      method: "exact_bound",
                    });
                  } catch (_) {}
                }
              }
              break;
            }

            if (!searched.interrupted) {
              exhaustedThisDirection = true;
              break;
            }

            exhaustedThisDirection = false;
          }

          if (improvedThisRound) break;
          if (!exhaustedThisDirection) {
            exhaustedAllDirections = false;
          }
        }

        if (!improvedThisRound) {
          if (typeof onProgress === "function") {
            try {
              void onProgress({
                type: "twophase_tighten_exact_done",
                lowerBound,
                upperBoundLength: incumbentLength,
                targetLength,
                exhausted: exhaustedAllDirections,
              });
            } catch (_) {}
          }
          break;
        }
      }

      for (const tryScramble of scramblesToTry) {
        const isInverse = tryScramble !== scramble;
        for (const config of tightenConfigs) {
          if (Date.now() >= exactSearchDeadlineTs) break;
          if (Date.now() >= tightenDeadline) break;
          if (incumbentLength - lowerBound <= MINMOVE_MAX_FEASIBLE_GAP) break;

          let tpSearchId = null;
          try {
            const prepared = await prepareTwophase333Lazy(tryScramble, {
              maxPhase1Solutions: config.frontiers,
              phase1MaxDepth: config.phase1MaxDepth,
            });
            if (!prepared?.ok || !Number.isFinite(prepared.searchId)) continue;
            tpSearchId = prepared.searchId;

            const searched = await searchTwophase333Lazy(tpSearchId, {
              incumbentLength: incumbentLength,
              phase2MaxDepth: 20,
              phase2NodeLimit: config.phase2NodeLimit,
            });
            if (searched?.ok && Number.isFinite(searched.moveCount) && searched.moveCount < incumbentLength) {
              let candidateSolution = String(searched.solution || "").trim();
              if (isInverse) candidateSolution = invertAlgorithmString(candidateSolution);
              if (candidateSolution && (await verify3x3Solution(scramble, candidateSolution))) {
                incumbentSolution = candidateSolution;
                incumbentLength = countAlgorithmMoves(candidateSolution);
                incumbentSource = "twophase tighten";
                if (typeof onProgress === "function") {
                  try {
                    void onProgress({ type: "twophase_tighten_improved", moveCount: incumbentLength, lowerBound });
                  } catch (_) {}
                }
              }
            }
          } catch (_) {
            // ignore individual tighten round failures
          } finally {
            if (Number.isFinite(tpSearchId)) {
              void dropTwophase333SearchLazy(tpSearchId).catch(() => {});
            }
          }
        }
        if (Date.now() >= exactSearchDeadlineTs) break;
        if (Date.now() >= tightenDeadline) break;
        if (incumbentLength - lowerBound <= MINMOVE_MAX_FEASIBLE_GAP) break;
      }
    }

    if (Date.now() >= exactSearchDeadlineTs) {
      await dropMinmove333SearchLazy(searchId);
      if (typeof onProgress === "function") {
        try {
          void onProgress({ type: "exact_search_fallback", reason: "timeout", moveCount: incumbentLength });
        } catch (_) {}
      }
      return buildMinmoveWorkerResult(incumbentSolution, {
        nodes: 0,
        bound: incumbentLength,
        lowerBound,
        upperBoundLength: incumbentLength,
        source: incumbentSource === "twophase tighten"
          ? "MINMOVE_333_TWOPHASE_TIGHTEN_TIMEOUT_FALLBACK"
          : incumbentSource === "phase seed"
            ? "MINMOVE_333_PHASE_TIMEOUT_FALLBACK"
            : "MINMOVE_333_INVERSE_TIMEOUT_FALLBACK",
        proofSource: incumbentSource === "twophase tighten"
          ? "twophase_tighten_timeout"
          : incumbentSource === "phase seed"
            ? "phase_fallback_timeout"
            : "inverse_fallback_timeout",
        optimalityProven: false,
        fallbackReason: "MINMOVE_TIMEOUT",
      });
    }

    // After tightening, if the gap is still too large for IDA* to prove optimality
    // within any practical time budget, return the best tightened solution immediately.
    if (incumbentLength - lowerBound > MINMOVE_MAX_FEASIBLE_GAP) {
      await dropMinmove333SearchLazy(searchId);
      if (typeof onProgress === "function") {
        try {
          void onProgress({ type: "exact_search_fallback", reason: "gap_too_large", moveCount: incumbentLength });
        } catch (_) {}
      }
      return buildMinmoveWorkerResult(incumbentSolution, {
        nodes: 0,
        bound: incumbentLength,
        lowerBound,
        upperBoundLength: incumbentLength,
        source: "MINMOVE_333_TIGHTEN_GAP_FALLBACK",
        proofSource: "phase_fallback_gap_too_large",
        optimalityProven: false,
        fallbackReason: "MINMOVE_GAP_TOO_LARGE",
      });
    }

    // Continue to bottom-up IDA* search below
    if (typeof onProgress === "function") {
      try {
        void onProgress({ type: "twophase_tighten_done", moveCount: incumbentLength, lowerBound });
      } catch (_) {}
    }
  }

  // Per-bound node budget: keeps each WASM call under ~1-2 s.
  // At ~10M nodes/s in WASM, 8M ≈ 0.8 s per bound call.
  const NODES_PER_BOUND = 8_000_000;
  let totalNodes = 0;

  const buildIncumbentFallbackResult = (fallbackReason, meta = {}) => {
    return buildMinmoveWorkerResult(incumbentSolution, {
      nodes: totalNodes,
      bound: Number.isFinite(meta.bound) ? meta.bound : incumbentLength,
      lowerBound,
      upperBoundLength: incumbentLength,
      source: String(
        meta.source ||
          (incumbentSource === "phase seed"
            ? "MINMOVE_333_PHASE_TIMEOUT_FALLBACK"
            : "MINMOVE_333_INVERSE_TIMEOUT_FALLBACK"),
      ),
      proofSource: String(
        meta.proofSource ||
          (incumbentSource === "phase seed" ? "phase_fallback_timeout" : "inverse_fallback_timeout"),
      ),
      optimalityProven: false,
      fallbackReason,
    });
  };

  try {
    for (let bound = lowerBound; bound < incumbentLength; bound += 1) {
      if (Date.now() >= exactSearchDeadlineTs) {
        const fallbackResult = buildIncumbentFallbackResult("MINMOVE_TIMEOUT", {
          bound,
        });
        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "exact_search_fallback", reason: "timeout", moveCount: incumbentLength });
          } catch (_) {}
        }
        return fallbackResult;
      }
      if (typeof onProgress === "function") {
        try {
          void onProgress({ type: "bound_update", bound, upperBoundLength: incumbentLength, nodes: totalNodes });
        } catch (_) {}
      }
      // Retry the same bound in chunks until the tree is exhausted,
      // a solution is found, or the global deadline is hit.
      let boundDone = false;
      let foundSearchResult = null;
      while (!boundDone) {
        if (Date.now() >= exactSearchDeadlineTs) {
          const fallbackResult = buildIncumbentFallbackResult("MINMOVE_TIMEOUT", {
            bound,
          });
          if (typeof onProgress === "function") {
            try {
              void onProgress({ type: "exact_search_fallback", reason: "timeout", moveCount: incumbentLength });
            } catch (_) {}
          }
          return fallbackResult;
        }
        const searchResult = await searchMinmove333BoundLazy(searchId, bound, NODES_PER_BOUND);
        if (!searchResult?.ok) {
          return { ok: false, reason: searchResult?.reason || "MINMOVE_SEARCH_FAILED" };
        }
        if (Number.isFinite(searchResult.nodes)) {
          totalNodes += searchResult.nodes;
        }
        if (searchResult.status === "found" && typeof searchResult.solution === "string") {
          foundSearchResult = searchResult;
          boundDone = true;
        } else if (searchResult.status === "exhausted") {
          boundDone = true;
        } else {
          // interrupted: node budget exceeded for this chunk
          // Keep retrying this bound chunk by chunk until done or deadline.
          if (typeof onProgress === "function") {
            try {
              void onProgress({ type: "bound_update", bound, upperBoundLength: incumbentLength, nodes: totalNodes });
            } catch (_) {}
          }
        }
      }
      if (foundSearchResult !== null) {
        const solution = String(foundSearchResult.solution || "").trim();
        if (!(await verify3x3Solution(scramble, solution))) {
          return { ok: false, reason: "MINMOVE_FINAL_STATE_NOT_SOLVED" };
        }
        if (typeof onProgress === "function") {
          try {
            void onProgress({ type: "optimality_proven", moveCount: foundSearchResult.moveCount ?? bound });
          } catch (_) {}
        }
        return buildMinmoveWorkerResult(solution, {
          nodes: totalNodes,
          bound: Number.isFinite(foundSearchResult.bound) ? foundSearchResult.bound : bound,
          lowerBound,
          upperBoundLength: incumbentLength,
          source: "MINMOVE_333_WASM",
          proofSource: "exact_search",
        });
      }
    }

    if (typeof onProgress === "function") {
      try {
        void onProgress({ type: "optimality_proven", moveCount: incumbentLength, proofSource: "seed upper bound" });
      } catch (_) {}
    }
    return buildMinmoveWorkerResult(incumbentSolution, {
      nodes: totalNodes,
      bound: incumbentLength,
      lowerBound,
      upperBoundLength: incumbentLength,
      source: incumbentSource === "phase seed"
        ? "MINMOVE_333_PHASE_SEED_PROVEN"
        : incumbentSource === "twophase tighten"
          ? "MINMOVE_333_TWOPHASE_TIGHTEN_PROVEN"
          : "MINMOVE_333_INVERSE_SEED_PROVEN",
      proofSource: "seed_upper_bound",
    });
  } finally {
    await dropMinmove333SearchLazy(searchId);
  }
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN > 0 ? intN : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN >= 0 ? intN : fallback;
}

async function solveWithInternal3x3StrictRetries(scramble, onProgress, options = {}) {
  const normalizedMode = String(options.mode || "strict").toLowerCase();
  const attempts = normalizedMode === "zb"
    ? [
        { timeoutMs: STRICT_CFOP_TIMEOUT_MS, extraOptions: null },
        { timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS, extraOptions: STRICT_F2L_RETRY_OPTIONS[0] },
      ]
    : [
        { timeoutMs: STRICT_CFOP_TIMEOUT_MS, extraOptions: null },
        { timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS, extraOptions: STRICT_F2L_RETRY_OPTIONS[0] },
        { timeoutMs: STRICT_CFOP_RETRY_TIMEOUT_MS, extraOptions: STRICT_F2L_RETRY_OPTIONS[1] },
      ];

  let firstFailureReason = "";
  let lastFailure = null;
  const failureHistory = [];
  // After the first CN probe, reuse the selected color in subsequent retries to avoid
  // re-running the expensive 6-color probe on every attempt.
  let resolvedCrossColor = options.crossColor;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const deadlineTs = Date.now() + Math.max(250, attempt.timeoutMs - 120);
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
        crossColor: resolvedCrossColor,
        ...(attempt.extraOptions || {}),
        deadlineTs,
      }),
      attempt.timeoutMs,
    ).catch(() => ({ ok: false, reason: "INTERNAL_3X3_CFOP_TIMEOUT" }));

    // After first attempt, capture the CN-selected cross color so retries skip the probe.
    if (i === 0 && strictResult?.selectedCrossColor) {
      resolvedCrossColor = strictResult.selectedCrossColor;
    }

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
          failureHistory,
        };
      }
      return {
        ...strictResult,
        failureHistory,
      };
    }

    failureHistory.push({
      attempt: i + 1,
      timeoutMs: attempt.timeoutMs,
      reason: String(strictResult?.reason || ""),
      stage: String(strictResult?.stage || ""),
      nodes: Number.isFinite(strictResult?.nodes) ? strictResult.nodes : null,
    });

    if (!firstFailureReason) {
      firstFailureReason = String(strictResult?.reason || "");
    }
    lastFailure = strictResult;
    if (!shouldFallbackToExternal3x3(strictResult)) {
      return {
        ...strictResult,
        failureHistory,
      };
    }
  }

  return {
    ...(lastFailure || { ok: false, reason: "INTERNAL_3X3_CFOP_FAILED" }),
    failureHistory,
  };
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
    const { prewarm3x3StrictCfopLibraries } = await import("./cfop3x3.js");
    await prewarm3x3StrictCfopLibraries();
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmInternal3x3Roux() {
  try {
    const [{ getDefaultPattern }, { solve3x3RouxFromPattern }] = await Promise.all([
      import("./context.js"),
      import("./roux3x3.js"),
    ]);
    const solved = await getDefaultPattern("333");
    await solve3x3RouxFromPattern(solved, {
      fbMaxDepth: 1,
      sbMaxDepth: 1,
      cmllMaxDepth: 1,
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
    await ensureWasmSolverReadyLazy();
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmTwophaseAndFmcTables() {
  try {
    // Pre-load twophase bundle (2.2MB) so the first FMC/twophase solve doesn't pay the download cost.
    const { ensureTwophase333Ready, buildFmcTablesWasm } = await getWasmSolverModule();
    const api = await ensureTwophase333Ready();
    if (api) {
      // Build FMC tables (~100ms) now so first FMC solve is instant.
      await buildFmcTablesWasm();
    }
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

async function prewarmCubingJs3x3Pattern() {
  try {
    // Pre-load the cubing.js 3x3 puzzle pattern so FMC solve doesn't pay ~700ms cold-start cost.
    const { getDefaultPattern } = await import("./context.js");
    await getDefaultPattern("333");
  } catch (_) {
    // Warmup failure should not block solving.
  }
}

let backgroundWarmupsStarted = false;
function startBackgroundWarmups() {
  if (backgroundWarmupsStarted) return;
  backgroundWarmupsStarted = true;
  void prewarmInternal2x2();
  void prewarmInternal3x3StrictCfop();
  void prewarmInternal3x3Roux();
  void prewarmInternal3x3Phase();
  void prewarmWasmSolver();
  void prewarmTwophaseAndFmcTables();
  void prewarmCubingJs3x3Pattern();
}

async function prewarmProfileSelection(options = {}) {
  try {
    startBackgroundWarmups();
    const mode = normalizeMode(options.mode);
    const f2lMethod = normalizeF2LMethod(options.f2lMethod);
    const transitionProfileSolver =
      typeof options.transitionProfileSolver === "string" ? options.transitionProfileSolver.trim() : "";
    const enableOllPllPrediction = options.enableOllPllPrediction !== false;
    const ollPllPredictionWeight = Number.isFinite(Number(options.ollPllPredictionWeight))
      ? Math.max(0, Number(options.ollPllPredictionWeight))
      : 0.35;
    const styleProfile = options.styleProfile && typeof options.styleProfile === "object"
      ? options.styleProfile
      : undefined;

    const [{ getDefaultPattern }, { prewarm3x3StrictCfopLibraries, solve3x3StrictCfopFromPattern }] = await Promise.all([
      import("./context.js"),
      import("./cfop3x3.js"),
    ]);

    let f2lTransitionProfile = null;
    try {
      f2lTransitionProfile = await getF2LTransitionProfileForSolverLazy(transitionProfileSolver);
    } catch (_) {
      f2lTransitionProfile = null;
    }

    let f2lDownstreamProfile = null;
    if (enableOllPllPrediction) {
      try {
        f2lDownstreamProfile = await getF2LDownstreamProfileForSolverLazy(transitionProfileSolver);
      } catch (_) {
        f2lDownstreamProfile = null;
      }
    }

    let llFamilyCalibration = null;
    try {
      llFamilyCalibration = await getLlFamilyCalibrationForSolverLazy(transitionProfileSolver);
    } catch (_) {
      llFamilyCalibration = null;
    }

    await prewarm3x3StrictCfopLibraries();

    const solved = await getDefaultPattern("333");
    const pattern = solved.applyAlg(PROFILE_PREWARM_SCRAMBLE);
    const f2lStyleProfile = f2lMethod !== "legacy" ? f2lMethod : undefined;
    const effectiveStyleProfile = styleProfile !== undefined ? styleProfile : f2lStyleProfile;
    const profileSolveMode =
      effectiveStyleProfile && typeof effectiveStyleProfile === "object" && typeof effectiveStyleProfile.solveMode === "string"
        ? effectiveStyleProfile.solveMode.toLowerCase()
        : effectiveStyleProfile &&
            typeof effectiveStyleProfile === "object" &&
            typeof effectiveStyleProfile.primaryMethod === "string" &&
            effectiveStyleProfile.primaryMethod.toUpperCase() === "ZB"
          ? "zb"
          : null;
    const effectiveMode = profileSolveMode && profileSolveMode !== mode ? profileSolveMode : mode;

    const warmSolve = await solve3x3StrictCfopFromPattern(pattern, {
      mode: effectiveMode,
      scramble: PROFILE_PREWARM_SCRAMBLE,
      crossColor: "D",
      styleProfile: effectiveStyleProfile,
      f2lStyleProfile,
      transitionProfileSolver,
      f2lTransitionProfile,
      f2lDownstreamProfile,
      llFamilyCalibration,
      enableMixedCfopStages: f2lMethod === "top10-mixed",
      enableOllPllPrediction,
      ollPllPredictionWeight,
      allowRelaxedSearch: false,
    }).catch(() => null);

    return {
      ok: true,
      warmed: true,
      mode: effectiveMode,
      transitionProfileLoaded: Boolean(f2lTransitionProfile),
      downstreamProfileLoaded: Boolean(f2lDownstreamProfile),
      llFamilyCalibrationLoaded: Boolean(llFamilyCalibration),
      singleStageLibraryCacheReady: true,
      solveOk: warmSolve?.ok === true,
    };
  } catch (error) {
    return {
      ok: false,
      reason: String(error?.message || error || "PROFILE_PREWARM_FAILED"),
    };
  }
}

const api = {
  async ping() {
    // Start async warmups early; don't block ping response.
    startBackgroundWarmups();
    return { ok: true };
  },
  async prewarmProfile(options = {}) {
    return prewarmProfileSelection(options);
  },
  async solve(arg1, arg2, arg3, arg4, arg5, arg6) {
    let scramble;
    let eventId;
    let onProgress;
    let crossColor = "D";
    let mode = "strict";
    let f2lMethod = "mixed";
    let styleProfile;
    let transitionProfileSolver = "";
    let enableStyleFallback = true;
    let enableOllPllPrediction = true;
    let ollPllPredictionWeight = 0.35;
    if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
      scramble = arg1.scramble;
      eventId = arg1.eventId;
      onProgress = typeof arg2 === "function" ? arg2 : arg1.onProgress;
      if (typeof arg1.crossColor === "string" && arg1.crossColor) {
        crossColor = arg1.crossColor;
      }
      if (typeof arg1.mode === "string" && arg1.mode) {
        mode = arg1.mode;
      }
      if (typeof arg1.f2lMethod === "string" && arg1.f2lMethod) {
        f2lMethod = arg1.f2lMethod;
      }
      if (arg1.styleProfile && typeof arg1.styleProfile === "object") {
        styleProfile = arg1.styleProfile;
      }
      if (typeof arg1.transitionProfileSolver === "string") {
        transitionProfileSolver = arg1.transitionProfileSolver;
      }
      if (typeof arg1.enableStyleFallback === "boolean") {
        enableStyleFallback = arg1.enableStyleFallback;
      }
      if (typeof arg1.enableOllPllPrediction === "boolean") {
        enableOllPllPrediction = arg1.enableOllPllPrediction;
      }
      if (Number.isFinite(Number(arg1.ollPllPredictionWeight))) {
        ollPllPredictionWeight = Math.max(0, Number(arg1.ollPllPredictionWeight));
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
    startBackgroundWarmups();
    if (normalizedEventId === "333" && mode === "twophase") {
      return await solveWithInternal3x3TwoPhase(scramble, onProgress);
    }
    if (normalizedEventId === "333" && mode === "minmove") {
      return await solveWithInternal3x3Minmove(scramble, onProgress);
    }
    let f2lTransitionProfile = null;
    try {
      f2lTransitionProfile = await getF2LTransitionProfileForSolverLazy(transitionProfileSolver);
    } catch (_) {
      f2lTransitionProfile = null;
    }
    let f2lDownstreamProfile = null;
    if (enableOllPllPrediction !== false) {
      try {
        f2lDownstreamProfile = await getF2LDownstreamProfileForSolverLazy(transitionProfileSolver);
      } catch (_) {
        f2lDownstreamProfile = null;
      }
    }
    let llFamilyCalibration = null;
    try {
      llFamilyCalibration = await getLlFamilyCalibrationForSolverLazy(transitionProfileSolver);
    } catch (_) {
      llFamilyCalibration = null;
    }
    const hasStyleOptIn =
      (styleProfile !== undefined && styleProfile !== null) || f2lMethod !== "legacy";
    const hasTransitionOptIn = Boolean(f2lTransitionProfile);
    const hasDownstreamOptIn = enableOllPllPrediction !== false && Boolean(f2lDownstreamProfile);
    const allowWasm3x3FastPath =
      mode === "strict" && !hasStyleOptIn && !hasTransitionOptIn && !hasDownstreamOptIn;

    // 222 uses in-repo solver implementation.
    try {
      if (normalizedEventId === "222") {
        // 2x2 internal solver is IDA* based and already shortest-path oriented.
        return await solveWithInternal2x2(scramble);
      }
      if (normalizedEventId === "333") {
        if (allowWasm3x3FastPath) {
          const wasm3x3Result = await solveWithWasmIfAvailableLazy(scramble, "333");
          if (wasm3x3Result?.ok) {
            return {
              ...wasm3x3Result,
              source: "WASM_3X3",
            };
          }
        }

        if (mode === "fmc") {
          const fmcResult = await withTimeout(
            solveWithFMCSearchLazy(scramble, onProgress, {
              maxPremoveSets: 12,
              timeBudgetMs: 30000,
              sweepBudgetMs: 10000,
              sweepIncludeInverse: true,
              targetMoveCount: 20,
              allowCfopFallback: false,
              premoveAllowCfopFallback: false,
              preferNonCfop: true,
              directProfileLevel: "deep",
              directPhaseAttemptTimeoutMs: 4000,
              // directStageBudgetMs not set → defaults to min(8000, timeBudgetMs * 0.42) = 8000ms
              // nissStageBudgetMs not set → same
              sweepProfileLevel: "balanced",
              sweepPhaseAttemptTimeoutMs: 1600,
              sweepAttemptBudgetMs: 1600,
              sweepUseScout: true,
              sweepScoutProfileLevel: "light",
              sweepScoutPhaseAttemptTimeoutMs: 700,
              sweepScoutAttemptBudgetMs: 700,
              sweepScoutIncludeInverse: true,
              sweepRefineSets: 8,
              verifyLimit: 18,
              enableInsertions: true,
              insertionCandidateLimit: 3,
              insertionMaxPasses: 3,
              insertionMinWindow: 3,
              insertionMaxWindow: 7,
              insertionMaxDepth: 6,
              insertionTimeMs: 5000,
              insertionThreshold: 24,
              crossColors: normalizeCrossColorList(crossColor),
            }),
            FMC_333_TIMEOUT_MS,
          ).catch(() => ({ ok: false, reason: "FMC_TIMEOUT" }));
          if (fmcResult?.ok) {
            return fmcResult;
          }
          return fmcResult || { ok: false, reason: "FMC_FAILED" };
        }
        if (mode === "roux") {
          const [{ getDefaultPattern }, { solve3x3RouxFromPattern }] = await Promise.all([
            import("./context.js"),
            import("./roux3x3.js"),
          ]);
          const solved = await getDefaultPattern("333");
          const pattern = solved.applyAlg(scramble);
          const hardDeadlineTs = Date.now() + Math.max(1000, ROUX_333_TIMEOUT_MS - 250);
          const rouxResult = await withTimeout(
            (async () => {
              const fastDeadlineTs = Math.min(hardDeadlineTs, Date.now() + 5000);
              const fastResult = await solve3x3RouxFromPattern(pattern, {
                crossColor,
                deadlineTs: fastDeadlineTs,
                enableRecovery: true,
                onStageUpdate(progress) {
                  if (typeof onProgress === "function") {
                    try {
                      void onProgress(progress);
                    } catch (_) {}
                  }
                },
              });
              if (fastResult?.ok) {
                return fastResult;
              }
              return await solve3x3RouxFromPattern(pattern, {
                crossColor,
                deadlineTs: hardDeadlineTs,
                enableRecovery: true,
                onStageUpdate(progress) {
                  if (typeof onProgress === "function") {
                    try {
                      void onProgress(progress);
                    } catch (_) {}
                  }
                },
              });
            })(),
            ROUX_333_TIMEOUT_MS,
          ).catch(() => ({ ok: false, reason: "ROUX_TIMEOUT", stage: "ROUX" }));
          if (rouxResult?.ok) {
            return rouxResult;
          }
          
          // No CFOP fallback - return Roux failure directly
          return rouxResult;
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
          transitionProfileSolver,
          styleProfile,
          f2lTransitionProfile,
          enableStyleFallback,
          f2lDownstreamProfile,
          llFamilyCalibration,
          enableOllPllPrediction,
          ollPllPredictionWeight,
        });

        if (mode === "zb") {
          return strictResult;
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
          solveWithExternalSearchLazy(scramble, "333"),
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
