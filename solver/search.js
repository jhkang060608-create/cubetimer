import { ensureSolverReady } from "./context.js";
import { SolverState } from "./state.js";
import { nextMovesExcludingFace } from "./tables.js";
import { faceOfMove } from "./moves.js";
import { estimateDistance } from "./heuristic.js";
import { metrics } from "./metrics.js";

export async function solveScramble(scramble, options = {}) {
  const { maxDepth = 14, eventId = "333" } = options;
  await ensureSolverReady(eventId);
  metrics.reset();
  const startState = await SolverState.fromScramble(scramble, eventId);
  const initialHeuristic = await estimateDistance(startState);
  let bound = Math.max(initialHeuristic, 1);
  while (bound <= maxDepth) {
    const result = await depthSearch(startState, 0, bound, null);
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

async function depthSearch(state, g, bound, lastFace) {
  const heuristic = await estimateDistance(state);
  const f = g + heuristic;
  if (f > bound) {
    return f;
  }
  if (await state.isSolved()) {
    return [];
  }
  let minBound = Infinity;
  for (const move of nextMovesExcludingFace(lastFace)) {
    metrics.increment();
    const nextState = state.applyMove(move);
    const nextFace = faceOfMove(move);
    const result = await depthSearch(nextState, g + 1, bound, nextFace);
    if (Array.isArray(result)) {
      return [move, ...result];
    }
    if (typeof result === "number" && result < minBound) {
      minBound = result;
    }
  }
  return minBound;
}
