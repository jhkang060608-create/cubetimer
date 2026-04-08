import { getDefaultPattern } from "./context.js";
import { solve3x3StrictCfopFromPattern } from "./cfop3x3.js";
import { solve3x3InternalPhase } from "./solver3x3Phase/index.js";

const FMC_PREMOVE_SETS = [
  ["U"],
  ["U'"],
  ["U2"],
  ["R"],
  ["R'"],
  ["R2"],
  ["F"],
  ["F'"],
  ["F2"],
  ["U", "R"],
  ["R", "U"],
  ["U", "F"],
  ["F", "U"],
  ["R", "F"],
  ["F", "R"],
];
const FMC_PHASE_PROFILES = [
  {
    id: "phase-light",
    phase1MaxDepth: 12,
    phase2MaxDepth: 18,
    phase1NodeLimit: 350000,
    phase2NodeLimit: 450000,
  },
  {
    id: "phase-mid",
    phase1MaxDepth: 13,
    phase2MaxDepth: 19,
    phase1NodeLimit: 1200000,
    phase2NodeLimit: 1800000,
  },
  {
    id: "phase-deep",
    phase1MaxDepth: 13,
    phase2MaxDepth: 20,
    phase1NodeLimit: 2500000,
    phase2NodeLimit: 4000000,
  },
];

let solvedPatternPromise = null;

function splitMoves(alg) {
  if (!alg || typeof alg !== "string") return [];
  return alg
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function joinMoves(parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
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

function remainingMs(deadlineTs) {
  if (!Number.isFinite(deadlineTs)) return Infinity;
  return deadlineTs - Date.now();
}

function parseMove(move) {
  if (!move || typeof move !== "string") return null;
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(move);
  if (!match) return null;
  const suffix = match[2];
  const amount = suffix === "'" ? 3 : suffix === "2" || suffix === "2'" ? 2 : 1;
  return { face: match[1], amount };
}

function formatMove(face, amount) {
  if (!face) return null;
  if (amount === 1) return face;
  if (amount === 2) return `${face}2`;
  if (amount === 3) return `${face}'`;
  return null;
}

function simplifyMoves(moves) {
  if (!Array.isArray(moves) || !moves.length) return [];
  const stack = [];
  for (const move of moves) {
    const parsed = parseMove(move);
    if (!parsed) {
      stack.push({ face: null, raw: move });
      continue;
    }
    if (!stack.length || stack[stack.length - 1].face !== parsed.face) {
      const normalized = parsed.amount % 4;
      if (normalized) {
        stack.push({ face: parsed.face, amount: normalized });
      }
      continue;
    }
    const top = stack[stack.length - 1];
    const combined = (top.amount + parsed.amount) % 4;
    if (combined === 0) {
      stack.pop();
    } else {
      top.amount = combined;
    }
  }
  return stack
    .map((entry) => (entry.face ? formatMove(entry.face, entry.amount) : entry.raw))
    .filter(Boolean);
}

function invertToken(token) {
  if (!token) return token;
  if (token.endsWith("2")) return token;
  if (token.endsWith("'")) return token.slice(0, -1);
  return `${token}'`;
}

function invertMoves(moves) {
  const out = [];
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    out.push(invertToken(moves[i]));
  }
  return out;
}

function invertAlg(algText) {
  return joinMoves(invertMoves(splitMoves(algText)));
}

async function getSolvedPattern() {
  if (!solvedPatternPromise) {
    solvedPatternPromise = getDefaultPattern("333");
  }
  return solvedPatternPromise;
}

function normalizeCandidateMoves(moves) {
  return simplifyMoves(Array.isArray(moves) ? moves : []);
}

function createCandidate(source, strategy, moves) {
  const normalized = normalizeCandidateMoves(moves);
  if (!normalized.length) return null;
  return {
    source,
    strategy,
    moves: normalized,
    solution: joinMoves(normalized),
    moveCount: normalized.length,
  };
}

async function verifyCandidate(scramble, candidate) {
  if (!candidate || !candidate.solution) return false;
  try {
    const solvedPattern = await getSolvedPattern();
    const afterScramble = solvedPattern.applyAlg(scramble);
    const afterSolution = afterScramble.applyAlg(candidate.solution);
    if (typeof afterSolution.experimentalIsSolved === "function") {
      return !!afterSolution.experimentalIsSolved({ ignorePuzzleOrientation: false });
    }
    return JSON.stringify(afterSolution.patternData) === JSON.stringify(solvedPattern.patternData);
  } catch (_) {
    return false;
  }
}

function pushUniqueCandidate(list, candidate) {
  if (!candidate) return;
  if (!list.some((existing) => existing.solution === candidate.solution)) {
    list.push(candidate);
  }
}

function selectPhaseProfiles(profileLevel) {
  if (profileLevel === "light") return FMC_PHASE_PROFILES.slice(0, 1);
  if (profileLevel === "medium") return FMC_PHASE_PROFILES.slice(0, 2);
  return FMC_PHASE_PROFILES.slice();
}

async function solveInternal333(scrambleText, options = {}) {
  try {
    if (remainingMs(options.deadlineTs) <= 300) return null;
    const solvedPattern = await getSolvedPattern();
    if (remainingMs(options.deadlineTs) <= 300) return null;
    const pattern = solvedPattern.applyAlg(scrambleText);
    const phaseProfiles = selectPhaseProfiles(options.profileLevel || "medium");
    const phaseAttemptTimeoutMs = Number.isFinite(options.phaseAttemptTimeoutMs)
      ? Math.max(1000, Math.floor(options.phaseAttemptTimeoutMs))
      : 12000;

    for (let i = 0; i < phaseProfiles.length; i++) {
      const phaseRemaining = remainingMs(options.deadlineTs);
      if (phaseRemaining <= 600) return null;
      const phaseTimeoutMs = Math.max(500, Math.min(phaseAttemptTimeoutMs, phaseRemaining - 200));
      const profile = phaseProfiles[i];
      const phaseResult = await withTimeout(
        solve3x3InternalPhase(pattern, profile),
        phaseTimeoutMs,
      ).catch(() => null);
      if (phaseResult?.ok) {
        return {
          ...phaseResult,
          source: `INTERNAL_FMC_${profile.id.toUpperCase()}`,
        };
      }
    }

    if (options.allowCfopFallback === false) {
      return null;
    }

    const crossColors =
      Array.isArray(options.crossColors) && options.crossColors.length
        ? options.crossColors
        : ["D"];
    const cfopPerColorTimeoutMs = Number.isFinite(options.cfopPerColorTimeoutMs)
      ? Math.max(700, Math.floor(options.cfopPerColorTimeoutMs))
      : 3000;
    let bestCfop = null;
    for (let i = 0; i < crossColors.length; i++) {
      const cfopRemaining = remainingMs(options.deadlineTs);
      if (cfopRemaining <= 900) break;
      const boundedCfopTimeoutMs = Math.max(700, Math.min(cfopPerColorTimeoutMs, cfopRemaining - 200));
      const crossColor = crossColors[i];
      const cfopResult = await withTimeout(
        solve3x3StrictCfopFromPattern(pattern, {
          crossColor,
          mode: "strict",
          f2lMethod: "legacy",
        }),
        boundedCfopTimeoutMs,
      ).catch(() => null);
      if (!cfopResult?.ok) continue;
      if (!bestCfop || cfopResult.moveCount < bestCfop.moveCount) {
        bestCfop = {
          ...cfopResult,
          source: "INTERNAL_FMC_CFOP_FALLBACK",
        };
      }
    }
    if (bestCfop?.ok) return bestCfop;
    return null;
  } catch (_) {
    return null;
  }
}

export async function solveWithFMCSearch(scramble, onProgress, options = {}) {
  const maxPremoveSets = Number.isFinite(options.maxPremoveSets)
    ? Math.max(0, Math.floor(options.maxPremoveSets))
    : 4;
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs)
    ? Math.max(1000, Math.floor(options.timeBudgetMs))
    : 30000;
  const targetMoveCount = Number.isFinite(options.targetMoveCount)
    ? Math.max(1, Math.floor(options.targetMoveCount))
    : 24;
  const startedAt = Date.now();
  const deadlineTs = startedAt + timeBudgetMs;
  const inverseScramble = invertAlg(scramble);
  const candidates = [];
  let attempts = 0;
  const totalStages = 3;
  let bestMoveCount = Infinity;

  const notify = (progress) => {
    if (typeof onProgress !== "function") return;
    try {
      void onProgress(progress);
    } catch (_) {
      // Progress callbacks are best-effort.
    }
  };

  const trackCandidate = (candidate) => {
    if (!candidate) return;
    pushUniqueCandidate(candidates, candidate);
    if (candidate.moveCount < bestMoveCount) {
      bestMoveCount = candidate.moveCount;
    }
  };

  notify({ type: "stage_start", stageIndex: 0, totalStages, stageName: "FMC Direct" });
  const direct = await solveInternal333(scramble, {
    profileLevel: "medium",
    phaseAttemptTimeoutMs: 6000,
    cfopPerColorTimeoutMs: 2500,
    allowCfopFallback: true,
    crossColors: options.crossColors || ["D"],
    deadlineTs,
  });
  attempts += 1;
  if (direct?.solution) {
    trackCandidate(createCandidate("FMC_DIRECT", "direct", splitMoves(direct.solution)));
  }
  notify({
    type: "stage_done",
    stageIndex: 0,
    totalStages,
    stageName: "FMC Direct",
    moveCount: Number.isFinite(bestMoveCount) ? bestMoveCount : 0,
  });

  notify({ type: "stage_start", stageIndex: 1, totalStages, stageName: "FMC NISS" });
  const inverse =
    remainingMs(deadlineTs) > 1000
      ? await solveInternal333(inverseScramble, {
          profileLevel: "medium",
          phaseAttemptTimeoutMs: 6000,
          cfopPerColorTimeoutMs: 2500,
          allowCfopFallback: true,
          crossColors: options.crossColors || ["D"],
          deadlineTs,
        })
      : null;
  attempts += 1;
  if (inverse?.solution) {
    trackCandidate(createCandidate("FMC_NISS", "inverse", invertMoves(splitMoves(inverse.solution))));
  }
  notify({
    type: "stage_done",
    stageIndex: 1,
    totalStages,
    stageName: "FMC NISS",
    moveCount: Number.isFinite(bestMoveCount) ? bestMoveCount : 0,
  });

  notify({ type: "stage_start", stageIndex: 2, totalStages, stageName: "FMC Premove Sweep" });
  for (let i = 0; i < FMC_PREMOVE_SETS.length && i < maxPremoveSets; i += 1) {
    if (Date.now() - startedAt >= timeBudgetMs) break;
    if (remainingMs(deadlineTs) <= 1200) break;
    if (bestMoveCount <= targetMoveCount) break;
    const premove = FMC_PREMOVE_SETS[i];

    const directScrambleWithPremove = joinMoves([scramble, ...premove]);
    const directWithPremove = await solveInternal333(directScrambleWithPremove, {
      profileLevel: "light",
      phaseAttemptTimeoutMs: 2500,
      cfopPerColorTimeoutMs: 1600,
      allowCfopFallback: options.premoveAllowCfopFallback === true,
      crossColors: options.crossColors || ["D"],
      deadlineTs,
    });
    attempts += 1;
    if (directWithPremove?.solution) {
      const moves = premove.concat(splitMoves(directWithPremove.solution));
      trackCandidate(createCandidate("FMC_PREMOVE_DIRECT", `premove:${joinMoves(premove)}`, moves));
    }

    if (Date.now() - startedAt >= timeBudgetMs) break;
    if (remainingMs(deadlineTs) <= 1200) break;
    if (bestMoveCount <= targetMoveCount) break;

    const inverseScrambleWithPremove = joinMoves([inverseScramble, ...premove]);
    const inverseWithPremove = await solveInternal333(inverseScrambleWithPremove, {
      profileLevel: "light",
      phaseAttemptTimeoutMs: 2500,
      cfopPerColorTimeoutMs: 1600,
      allowCfopFallback: options.premoveAllowCfopFallback === true,
      crossColors: options.crossColors || ["D"],
      deadlineTs,
    });
    attempts += 1;
    if (inverseWithPremove?.solution) {
      const moves = invertMoves(splitMoves(inverseWithPremove.solution)).concat(invertMoves(premove));
      trackCandidate(createCandidate("FMC_PREMOVE_NISS", `niss:${joinMoves(premove)}`, moves));
    }
  }
  notify({
    type: "stage_done",
    stageIndex: 2,
    totalStages,
    stageName: "FMC Premove Sweep",
    moveCount: Number.isFinite(bestMoveCount) ? bestMoveCount : 0,
  });

  candidates.sort((a, b) => {
    if (a.moveCount !== b.moveCount) return a.moveCount - b.moveCount;
    return a.solution.localeCompare(b.solution);
  });

  const validCandidates = [];
  const verifyLimit = Math.min(candidates.length, 8);
  for (let i = 0; i < verifyLimit; i += 1) {
    const candidate = candidates[i];
    if (await verifyCandidate(scramble, candidate)) {
      validCandidates.push(candidate);
    }
  }
  if (!validCandidates.length) {
    return {
      ok: false,
      reason: "FMC_NO_VALID_SOLUTION",
      attempts,
    };
  }

  const best = validCandidates[0];
  const candidateLines = validCandidates
    .slice(0, 3)
    .map((candidate, index) => `${index + 1}. ${candidate.moveCount}수 [${candidate.source}] ${candidate.solution}`);

  return {
    ok: true,
    solution: best.solution,
    moveCount: best.moveCount,
    nodes: 0,
    bound: best.moveCount,
    source: best.source,
    attempts,
    stages: [
      { name: "FMC Direct", solution: direct?.solution || "-" },
      { name: "FMC NISS", solution: inverse?.solution ? invertAlg(inverse.solution) : "-" },
      { name: "FMC Best", solution: best.solution },
    ],
    solutionDisplay: [best.solution, "", "Top Candidates", ...candidateLines].join("\n"),
  };
}
