import { get3x3MoveTables } from "./tables3x3.js";

const PHASE2_MOVE_NAMES = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"];
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];
const FAIL_CACHE_LIMIT = 150000;

let solvedPatternPromise = null;
let phase2MovesWithFacePromise = null;

async function getSolvedPattern() {
  if (solvedPatternPromise) return solvedPatternPromise;
  solvedPatternPromise = (async () => (await get3x3MoveTables()).solvedPattern)();
  return solvedPatternPromise;
}

async function getPhase2MovesWithFace() {
  if (phase2MovesWithFacePromise) return phase2MovesWithFacePromise;
  phase2MovesWithFacePromise = Promise.resolve(
    PHASE2_MOVE_NAMES.map((move) => ({
      move,
      face: move[0],
      faceIndex: ({ U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 })[move[0]],
    })),
  );
  return phase2MovesWithFacePromise;
}

function mismatchHeuristic(patternData, solvedData) {
  let cPerm = 0;
  let ePerm = 0;
  for (let i = 0; i < solvedData.CORNERS.pieces.length; i++) {
    if (patternData.CORNERS.pieces[i] !== solvedData.CORNERS.pieces[i]) cPerm += 1;
  }
  for (let i = 0; i < solvedData.EDGES.pieces.length; i++) {
    if (patternData.EDGES.pieces[i] !== solvedData.EDGES.pieces[i]) ePerm += 1;
  }
  return Math.max(Math.ceil(cPerm / 4), Math.ceil(ePerm / 8), Math.ceil((cPerm + ePerm) / 12));
}

function makeStateKey(patternData) {
  return `${patternData.CORNERS.pieces.join(",")}|${patternData.EDGES.pieces.join(",")}`;
}

export function buildPhase2Input(pattern, options = {}) {
  return {
    pattern,
    maxDepth: options.phase2MaxDepth ?? 18,
    nodeLimit: options.phase2NodeLimit ?? 450000,
  };
}

export async function solvePhase2(input) {
  const solved = await getSolvedPattern();
  const solvedData = solved.patternData;
  const moves = await getPhase2MovesWithFace();
  const { pattern, maxDepth, nodeLimit } = input;

  if (pattern.isIdentical(solved)) {
    return { ok: true, moves: [], depth: 0, nodes: 0 };
  }

  let bound = Math.max(mismatchHeuristic(pattern.patternData, solvedData), 1);
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  let failCache = new Map();

  function dfs(currentPattern, depth, currentBound, lastFaceIndex) {
    const h = mismatchHeuristic(currentPattern.patternData, solvedData);
    const f = depth + h;
    if (f > currentBound) return f;
    if (currentPattern.isIdentical(solved)) return true;

    const remaining = currentBound - depth;
    const key = makeStateKey(currentPattern.patternData);
    const cacheKey = `${key}|${lastFaceIndex}`;
    const seenMask = failCache.get(cacheKey) || 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    let minNext = Infinity;
    for (let i = 0; i < moves.length; i++) {
      if (nodeLimit > 0 && nodes >= nodeLimit) {
        nodeLimitHit = true;
        return Infinity;
      }
      const { move, faceIndex } = moves[i];
      if (lastFaceIndex !== 6) {
        if (faceIndex === lastFaceIndex) continue;
        if (faceIndex === OPPOSITE_FACE[lastFaceIndex] && faceIndex < lastFaceIndex) continue;
      }
      nodes += 1;
      const nextPattern = currentPattern.applyMove(move);
      const res = dfs(nextPattern, depth + 1, currentBound, faceIndex);
      if (res === true) {
        path.push(move);
        return true;
      }
      if (res < minNext) minNext = res;
    }
    if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
    failCache.set(cacheKey, seenMask | bit);
    return minNext;
  }

  while (bound <= maxDepth) {
    if (nodeLimitHit) break;
    path.length = 0;
    failCache = new Map();
    const res = dfs(pattern, 0, bound, 6);
    if (res === true) {
      path.reverse();
      return { ok: true, moves: path.slice(), depth: path.length, nodes };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  if (nodeLimitHit) {
    return { ok: false, reason: "PHASE2_SEARCH_LIMIT", nodes };
  }

  return { ok: false, reason: "PHASE2_NOT_FOUND", nodes };
}

