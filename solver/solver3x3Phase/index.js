import { buildPhase1Input, solvePhase1 } from "./phase1.js";
import { buildPhase2Input, solvePhase2 } from "./phase2.js";
import { parsePatternToCoords3x3 } from "./state3x3.js";

function applyMoves(pattern, moves) {
  let current = pattern;
  for (let i = 0; i < moves.length; i++) {
    current = current.applyMove(moves[i]);
  }
  return current;
}

export async function solve3x3InternalPhase(pattern, options = {}) {
  const coords = parsePatternToCoords3x3(pattern);
  const phase1Input = buildPhase1Input(coords, options);
  const phase1 = await solvePhase1(phase1Input);
  if (!phase1.ok) {
    return { ok: false, reason: phase1.reason || "PHASE1_FAILED", phase1Nodes: phase1.nodes || 0 };
  }

  const afterPhase1 = applyMoves(pattern, phase1.moves);
  const phase2Input = buildPhase2Input(afterPhase1, options);
  const phase2 = await solvePhase2(phase2Input);
  if (!phase2.ok) {
    return {
      ok: false,
      reason: phase2.reason || "PHASE2_FAILED",
      phase1Depth: phase1.depth,
      phase1Nodes: phase1.nodes || 0,
      phase2Nodes: phase2.nodes || 0,
    };
  }

  const fullMoves = phase1.moves.concat(phase2.moves);
  return {
    ok: true,
    solution: fullMoves.join(" "),
    moveCount: fullMoves.length,
    nodes: (phase1.nodes || 0) + (phase2.nodes || 0),
    bound: fullMoves.length,
    phase1Depth: phase1.depth,
    phase2Depth: phase2.depth,
    source: "INTERNAL_3X3_PHASE",
  };
}

