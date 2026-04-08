import { getDefaultPattern } from "./context.js";
import { solve3x3StrictCfopFromPattern } from "./cfop3x3.js";

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
  for (let i = 0; i < moves.length; i++) {
    const parsed = parseMove(moves[i]);
    if (!parsed) {
      stack.push({ face: null, raw: moves[i] });
      continue;
    }
    if (!stack.length || stack[stack.length - 1].face !== parsed.face) {
      const normalized = parsed.amount % 4;
      if (normalized) stack.push({ face: parsed.face, amount: normalized });
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

function invertAlg(algText) {
  const tokens = splitMoves(algText);
  const out = [];
  for (let i = tokens.length - 1; i >= 0; i--) out.push(invertToken(tokens[i]));
  return joinMoves(out);
}

function transformPatternForRotation(pattern, solvedPattern, rotationAlg) {
  if (!rotationAlg) return pattern;
  try {
    const patternTransform = pattern.experimentalToTransformation();
    const rotationTransform = solvedPattern.applyAlg(rotationAlg).experimentalToTransformation();
    return rotationTransform
      .invert()
      .applyTransformation(patternTransform)
      .applyTransformation(rotationTransform)
      .toKPattern();
  } catch (_) {
    return null;
  }
}

function isSolvedPattern(pattern, solvedPattern) {
  if (!pattern) return false;
  try {
    return pattern.isIdentical(solvedPattern);
  } catch (_) {
    try {
      return !!pattern.experimentalIsSolved({ ignorePuzzleOrientation: false });
    } catch (_) {
      return false;
    }
  }
}

async function solveRouxCandidate(payload) {
  const scramble = typeof payload?.scramble === "string" ? payload.scramble : "";
  if (!scramble.trim()) return { ok: false, reason: "NO_SCRAMBLE" };
  const rotationAlg = String(payload?.rotationAlg || "").trim();
  const options = payload?.options && typeof payload.options === "object" ? payload.options : {};

  const solvedPattern = await getDefaultPattern("333");
  const basePattern = solvedPattern.applyAlg(scramble);
  const transformedPattern = transformPatternForRotation(basePattern, solvedPattern, rotationAlg);
  if (!transformedPattern) {
    return { ok: false, reason: "CROSS_COLOR_TRANSFORM_FAILED" };
  }

  const candidateResult = await solve3x3StrictCfopFromPattern(transformedPattern, {
    ...options,
    mode: "roux",
    crossColor: "D",
    __colorNeutralApplied: true,
    __rouxOrientationApplied: true,
    rouxSweepMaxChecks: 0,
  });
  if (!candidateResult?.ok) return candidateResult || { ok: false, reason: "ROUX_CANDIDATE_FAILED" };

  const setupMoves = splitMoves(rotationAlg);
  const cleanupMoves = splitMoves(invertAlg(rotationAlg));
  const coreMoves = splitMoves(candidateResult.solution || "");
  const fullMoves = simplifyMoves(setupMoves.concat(coreMoves, cleanupMoves));
  const fullSolution = joinMoves(fullMoves);

  const stages = Array.isArray(candidateResult.stages)
    ? candidateResult.stages.map((stage) => ({ ...stage }))
    : [];
  if (stages.length) {
    if (setupMoves.length) {
      const firstMoves = simplifyMoves(setupMoves.concat(splitMoves(stages[0].solution || "")));
      stages[0].solution = joinMoves(firstMoves);
      stages[0].moveCount = firstMoves.length;
      stages[0].depth = firstMoves.length;
    }
    const lastIndex = stages.length - 1;
    if (cleanupMoves.length) {
      const lastMoves = simplifyMoves(splitMoves(stages[lastIndex].solution || "").concat(cleanupMoves));
      stages[lastIndex].solution = joinMoves(lastMoves);
      stages[lastIndex].moveCount = lastMoves.length;
      stages[lastIndex].depth = lastMoves.length;
    }
  }

  const finalPattern = fullSolution ? basePattern.applyAlg(fullSolution) : basePattern;
  if (!isSolvedPattern(finalPattern, solvedPattern)) {
    return { ok: false, reason: "FINAL_STATE_NOT_SOLVED" };
  }

  return {
    ...candidateResult,
    ok: true,
    solution: fullSolution,
    moveCount: fullMoves.length,
    stages,
    rotationAlg,
    source: "INTERNAL_3X3_ROUX_PARALLEL_CANDIDATE",
  };
}

globalThis.addEventListener("message", async (event) => {
  try {
    const result = await solveRouxCandidate(event?.data || {});
    globalThis.postMessage(result);
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      reason: `ROUX_SUBWORKER_ERROR: ${error?.message || error}`,
    });
  }
});
