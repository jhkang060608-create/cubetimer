import { MOVE_NAMES, faceOfMove } from "./moves.js";

const movesExcludingFaceMap = new Map();
for (const move of MOVE_NAMES) {
  const face = faceOfMove(move);
  if (!movesExcludingFaceMap.has(face)) {
    movesExcludingFaceMap.set(face, MOVE_NAMES.filter((candidate) => faceOfMove(candidate) !== face));
  }
}

export function nextMovesExcludingFace(face) {
  if (!face) {
    return MOVE_NAMES;
  }
  return movesExcludingFaceMap.get(face) || MOVE_NAMES;
}
