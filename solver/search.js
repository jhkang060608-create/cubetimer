import { getDefaultPattern } from "./context.js";
import { SolverState } from "./state.js";
import { nextMovesExcludingFace } from "./tables.js";
import { faceOfMove } from "./moves.js";
import { estimateDistance } from "./heuristic.js";
import { metrics } from "./metrics.js";

export async function solveScramble(scramble, options = {}) {
  const {
    maxDepth = 14,
    eventId = "333",
    deadlineTs = Infinity,
    maxNodes = Infinity,
  } = options;
  metrics.reset();
  const [startState, solvedPattern] = await Promise.all([
    SolverState.fromScramble(scramble, eventId),
    getDefaultPattern(eventId),
  ]);
  const initialHeuristic = await estimateDistance(startState);
  if (initialHeuristic === 0) {
    return {
      solution: [],
      depth: 0,
      nodes: metrics.nodes,
      bound: 0,
    };
  }

  const searchLimits = {
    deadlineTs,
    maxNodes,
  };
  let bound = Math.max(initialHeuristic, 1);
  while (bound <= maxDepth) {
    if (shouldAbortSearch(searchLimits)) {
      break;
    }
    const result = await depthSearch(startState, solvedPattern, 0, bound, null, searchLimits);
    if (Array.isArray(result)) {
      return {
        solution: result,
        depth: result.length,
        nodes: metrics.nodes,
        bound,
      };
    }
    if (result === Infinity) {
      break;
    }
    bound = result;
  }
  return null;
}

async function depthSearch(state, solvedPattern, g, bound, lastFace, searchLimits) {
  if (shouldAbortSearch(searchLimits)) {
    return Infinity;
  }
  const heuristic = await estimateDistance(state);
  const f = g + heuristic;
  if (f > bound) {
    return f;
  }
  if (state.pattern.isIdentical(solvedPattern)) {
    return [];
  }
  if (g === bound) {
    return bound + 1;
  }
  let minBound = Infinity;
  for (const move of nextMovesExcludingFace(lastFace)) {
    if (shouldAbortSearch(searchLimits)) {
      return Infinity;
    }
    metrics.increment();
    const nextState = state.applyMove(move);
    const nextFace = faceOfMove(move);
    const result = await depthSearch(nextState, solvedPattern, g + 1, bound, nextFace, searchLimits);
    if (Array.isArray(result)) {
      return [move, ...result];
    }
    if (typeof result === "number" && result < minBound) {
      minBound = result;
    }
  }
  return minBound;
}

function shouldAbortSearch(searchLimits) {
  if (Date.now() >= searchLimits.deadlineTs) {
    return true;
  }
  if (metrics.nodes >= searchLimits.maxNodes) {
    return true;
  }
  return false;
}
