import { getDefaultPattern } from "./context.js";
import { MOVE_NAMES } from "./moves.js";
import { SCDB_CFOP_ALGS } from "./scdbCfopAlgs.js";

const FACE_TO_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];
const STAGE_NOT_SET = 255;
const HEURISTIC_CACHE_LIMIT = 120000;
const FAIL_CACHE_LIMIT = 160000;
const FORMULA_ROTATIONS = ["", "y", "y2", "y'"];
const FORMULA_AUF = ["", "U", "U2", "U'"];
const FORMULA_F2L_MAX_STEPS = 12;
const F2L_ANCHOR_KEY_SIZE = 1 << 17; // cPos(3) cPiece(3) cOri(2) ePos(4) ePiece(4) eOri(1)
const F2L_CORNER_ORI_FACTOR = 81; // 3^4
const F2L_EDGE_ORI_FACTOR = 256; // 2^8
const F2L_CORNER_STATE_COUNT = 136080; // 8P4 * 3^4
const POPCOUNT_12 = new Uint8Array(1 << 12);
for (let i = 1; i < POPCOUNT_12.length; i++) {
  POPCOUNT_12[i] = POPCOUNT_12[i >> 1] + (i & 1);
}
const STRICT_CFOP_PROFILE = {
  crossMaxDepth: 8,
  f2lMaxDepth: 42,
  f2lFormulaMaxSteps: 14,
  f2lFormulaBeamWidth: 8,
  f2lFormulaExpansionLimit: 14,
  f2lFormulaMaxAttempts: 300000,
  f2lSearchMaxDepth: 12,
  f2lNodeLimit: 250000,
  ollMaxDepth: 14,
  pllMaxDepth: 20,
};
const FAST_CFOP_PROFILE = {
  crossMaxDepth: 7,
  f2lMaxDepth: 36,
  f2lFormulaMaxSteps: 10,
  f2lFormulaBeamWidth: 6,
  f2lFormulaExpansionLimit: 10,
  f2lFormulaMaxAttempts: 180000,
  f2lSearchMaxDepth: 8,
  f2lNodeLimit: 150000,
  ollMaxDepth: 12,
  pllMaxDepth: 18,
};
const CROSS_STATE_COUNT = 190080; // 12P4 * 2^4
const CROSS_RANK_FACTORS = [990, 90, 9, 1];
const CROSS_COLOR_ROTATION_CANDIDATES = {
  D: [""],
  U: ["x2"],
  F: ["x", "x'"],
  B: ["x'", "x"],
  R: ["z'", "z"],
  L: ["z", "z'"],
};
const CROSS_COLOR_LABELS = {
  D: "Yellow",
  U: "White",
  F: "Green",
  B: "Blue",
  R: "Red",
  L: "Orange",
};
const CROSS_EDGE_TARGETS = {
  D: ["DF", "DR", "DB", "DL"],
  U: ["UF", "UR", "UB", "UL"],
  F: ["FU", "FR", "FD", "FL"],
  B: ["BU", "BL", "BD", "BR"],
  R: ["RU", "RB", "RD", "RF"],
  L: ["LU", "LF", "LD", "LB"],
};
let f2lCaseLibraryPromise = null;

let contextPromise = null;

function collectChangedPositions(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push(i);
  }
  return out;
}

function orbitMatches(orbit, solvedOrbit, indices, checkPieces, checkOrientation) {
  if (!orbit || !solvedOrbit) return false;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (checkPieces && orbit.pieces[idx] !== solvedOrbit.pieces[idx]) return false;
    if (checkOrientation && orbit.orientation[idx] !== solvedOrbit.orientation[idx]) return false;
  }
  return true;
}

function countOrbitMismatches(orbit, solvedOrbit, indices, checkPieces, checkOrientation) {
  let pieceMismatch = 0;
  let orientationMismatch = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (checkPieces && orbit.pieces[idx] !== solvedOrbit.pieces[idx]) {
      pieceMismatch += 1;
    }
    if (checkOrientation && orbit.orientation[idx] !== solvedOrbit.orientation[idx]) {
      orientationMismatch += 1;
    }
  }
  return { pieceMismatch, orientationMismatch };
}

function stageHeuristicFromMismatch(pieceMismatch, orientationMismatch) {
  if (pieceMismatch === 0 && orientationMismatch === 0) return 0;
  const pieceBound = Math.ceil(pieceMismatch / 4);
  const orientationBound = Math.ceil(orientationMismatch / 4);
  const combinedBound = Math.ceil((pieceMismatch + orientationMismatch) / 8);
  return Math.max(pieceBound, orientationBound, combinedBound, 1);
}

function compareF2LRanking(a, b) {
  if (a.pairProgress !== b.pairProgress) return b.pairProgress - a.pairProgress;
  if (a.solvedSum !== b.solvedSum) return b.solvedSum - a.solvedSum;
  if (a.score !== b.score) return a.score - b.score;
  if (a.moveLen !== b.moveLen) return a.moveLen - b.moveLen;
  return 0;
}

function nthUnusedPosition(n, usedMask) {
  for (let pos = 0; pos < 12; pos++) {
    if (usedMask & (1 << pos)) continue;
    if (n === 0) return pos;
    n -= 1;
  }
  return -1;
}

function encodeCrossStateFromParts(p0, p1, p2, p3, o0, o1, o2, o3) {
  let usedMask = 0;
  let rank = 0;
  let lessUnused = 0;
  for (let probe = 0; probe < p0; probe++) {
    if ((usedMask & (1 << probe)) === 0) lessUnused += 1;
  }
  rank += lessUnused * CROSS_RANK_FACTORS[0];
  usedMask |= 1 << p0;

  lessUnused = 0;
  for (let probe = 0; probe < p1; probe++) {
    if ((usedMask & (1 << probe)) === 0) lessUnused += 1;
  }
  rank += lessUnused * CROSS_RANK_FACTORS[1];
  usedMask |= 1 << p1;

  lessUnused = 0;
  for (let probe = 0; probe < p2; probe++) {
    if ((usedMask & (1 << probe)) === 0) lessUnused += 1;
  }
  rank += lessUnused * CROSS_RANK_FACTORS[2];
  usedMask |= 1 << p2;

  lessUnused = 0;
  for (let probe = 0; probe < p3; probe++) {
    if ((usedMask & (1 << probe)) === 0) lessUnused += 1;
  }
  rank += lessUnused * CROSS_RANK_FACTORS[3];
  const oriBits = (o0 & 1) | ((o1 & 1) << 1) | ((o2 & 1) << 2) | ((o3 & 1) << 3);
  return (rank << 4) | oriBits;
}

function buildEdgeMoveTables(solvedPattern, solvedData) {
  const tables = [];
  for (let i = 0; i < MOVE_NAMES.length; i++) {
    const after = solvedPattern.applyMove(MOVE_NAMES[i]).patternData.EDGES;
    const newPosByPiece = new Map();
    for (let pos = 0; pos < 12; pos++) {
      newPosByPiece.set(after.pieces[pos], pos);
    }
    const edgePosMap = new Uint8Array(12);
    const edgeOriDelta = new Uint8Array(12);
    for (let oldPos = 0; oldPos < 12; oldPos++) {
      const pieceId = solvedData.EDGES.pieces[oldPos];
      const newPos = newPosByPiece.get(pieceId);
      edgePosMap[oldPos] = newPos;
      const beforeOri = solvedData.EDGES.orientation[oldPos] & 1;
      const afterOri = after.orientation[newPos] & 1;
      edgeOriDelta[oldPos] = (afterOri - beforeOri + 2) & 1;
    }
    tables.push({
      edgePosMap,
      edgeOriDelta,
    });
  }
  return tables;
}

function buildCornerMoveTables(solvedPattern, solvedData) {
  const tables = [];
  for (let i = 0; i < MOVE_NAMES.length; i++) {
    const after = solvedPattern.applyMove(MOVE_NAMES[i]).patternData.CORNERS;
    const newPosByPiece = new Map();
    for (let pos = 0; pos < 8; pos++) {
      newPosByPiece.set(after.pieces[pos], pos);
    }
    const cornerPosMap = new Uint8Array(8);
    const cornerOriDelta = new Uint8Array(8);
    for (let oldPos = 0; oldPos < 8; oldPos++) {
      const pieceId = solvedData.CORNERS.pieces[oldPos];
      const newPos = newPosByPiece.get(pieceId);
      cornerPosMap[oldPos] = newPos;
      const beforeOri = solvedData.CORNERS.orientation[oldPos] % 3;
      const afterOri = after.orientation[newPos] % 3;
      cornerOriDelta[oldPos] = (afterOri - beforeOri + 3) % 3;
    }
    tables.push({
      cornerPosMap,
      cornerOriDelta,
    });
  }
  return tables;
}

function encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri) {
  return ((((cornerPos * 3 + (cornerOri % 3)) * 12 + edgePos) * 2) + (edgeOri & 1));
}

function buildF2LPairPruneTable(pairDef, cornerMoveTables, edgeMoveTables, allowedMoveIndices) {
  const table = new Int8Array(576);
  table.fill(-1);
  const start = encodeF2LPairState(
    pairDef.cornerTargetPos,
    pairDef.cornerTargetOri,
    pairDef.edgeTargetPos,
    pairDef.edgeTargetOri,
  );
  const queue = new Uint16Array(576);
  let head = 0;
  let tail = 0;
  table[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const state = queue[head++];
    const depth = table[state];
    const edgeOri = state & 1;
    let rem = state >> 1;
    const edgePos = rem % 12;
    rem = Math.floor(rem / 12);
    const cornerOri = rem % 3;
    const cornerPos = Math.floor(rem / 3);

    for (let i = 0; i < allowedMoveIndices.length; i++) {
      const moveIndex = allowedMoveIndices[i];
      const cMap = cornerMoveTables[moveIndex];
      const eMap = edgeMoveTables[moveIndex];
      const nextCornerPos = cMap.cornerPosMap[cornerPos];
      const nextCornerOri = (cornerOri + cMap.cornerOriDelta[cornerPos]) % 3;
      const nextEdgePos = eMap.edgePosMap[edgePos];
      const nextEdgeOri = edgeOri ^ eMap.edgeOriDelta[edgePos];
      const next = encodeF2LPairState(nextCornerPos, nextCornerOri, nextEdgePos, nextEdgeOri);
      if (table[next] !== -1) continue;
      table[next] = depth + 1;
      queue[tail++] = next;
    }
  }
  return table;
}

function getF2LPairTablePenalty(data, ctx) {
  return getF2LPairTableMetrics(data, ctx).penalty;
}

function getF2LPairTableLowerBound(data, ctx) {
  return getF2LPairTableMetrics(data, ctx).lowerBound;
}

function getF2LPairTableMetrics(data, ctx) {
  if (!ctx.f2lPairDefs || !ctx.f2lPairDefs.length) {
    return { penalty: 0, lowerBound: 0 };
  }
  const cornerPosByPiece = new Int8Array(8);
  const edgePosByPiece = new Int8Array(12);
  cornerPosByPiece.fill(-1);
  edgePosByPiece.fill(-1);
  for (let pos = 0; pos < 8; pos++) {
    cornerPosByPiece[data.CORNERS.pieces[pos]] = pos;
  }
  for (let pos = 0; pos < 12; pos++) {
    edgePosByPiece[data.EDGES.pieces[pos]] = pos;
  }
  let penalty = 0;
  let lowerBound = 0;
  for (let i = 0; i < ctx.f2lPairDefs.length; i++) {
    const def = ctx.f2lPairDefs[i];
    const cornerPos = cornerPosByPiece[def.cornerPieceId];
    const edgePos = edgePosByPiece[def.edgePieceId];
    if (cornerPos < 0 || edgePos < 0) continue;
    const cornerOri = data.CORNERS.orientation[cornerPos] % 3;
    const edgeOri = data.EDGES.orientation[edgePos] & 1;
    const state = encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri);
    const dist = def.pruneTable[state];
    if (dist > 0) {
      penalty += dist;
      if (dist > lowerBound) lowerBound = dist;
    }
  }
  return { penalty, lowerBound };
}

function buildCrossPruneTable(bottomEdgePositions, solvedData, edgeMoveTables) {
  const p0 = bottomEdgePositions[0];
  const p1 = bottomEdgePositions[1];
  const p2 = bottomEdgePositions[2];
  const p3 = bottomEdgePositions[3];
  const o0 = solvedData.EDGES.orientation[p0] & 1;
  const o1 = solvedData.EDGES.orientation[p1] & 1;
  const o2 = solvedData.EDGES.orientation[p2] & 1;
  const o3 = solvedData.EDGES.orientation[p3] & 1;
  const startIndex = encodeCrossStateFromParts(p0, p1, p2, p3, o0, o1, o2, o3);

  const distance = new Int16Array(CROSS_STATE_COUNT);
  distance.fill(-1);
  const queue = new Uint32Array(CROSS_STATE_COUNT);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  distance[startIndex] = 0;

  while (head < tail) {
    const state = queue[head++];
    const baseDepth = distance[state];
    const oriBits = state & 15;
    let rankRemainder = state >> 4;
    let usedMask = 0;

    const d0 = Math.floor(rankRemainder / CROSS_RANK_FACTORS[0]);
    rankRemainder %= CROSS_RANK_FACTORS[0];
    const dp0 = nthUnusedPosition(d0, usedMask);
    usedMask |= 1 << dp0;

    const d1 = Math.floor(rankRemainder / CROSS_RANK_FACTORS[1]);
    rankRemainder %= CROSS_RANK_FACTORS[1];
    const dp1 = nthUnusedPosition(d1, usedMask);
    usedMask |= 1 << dp1;

    const d2 = Math.floor(rankRemainder / CROSS_RANK_FACTORS[2]);
    rankRemainder %= CROSS_RANK_FACTORS[2];
    const dp2 = nthUnusedPosition(d2, usedMask);
    usedMask |= 1 << dp2;

    const dp3 = nthUnusedPosition(rankRemainder, usedMask);

    const do0 = oriBits & 1;
    const do1 = (oriBits >> 1) & 1;
    const do2 = (oriBits >> 2) & 1;
    const do3 = (oriBits >> 3) & 1;

    for (let moveIndex = 0; moveIndex < edgeMoveTables.length; moveIndex++) {
      const move = edgeMoveTables[moveIndex];
      const np0 = move.edgePosMap[dp0];
      const np1 = move.edgePosMap[dp1];
      const np2 = move.edgePosMap[dp2];
      const np3 = move.edgePosMap[dp3];
      const no0 = do0 ^ move.edgeOriDelta[dp0];
      const no1 = do1 ^ move.edgeOriDelta[dp1];
      const no2 = do2 ^ move.edgeOriDelta[dp2];
      const no3 = do3 ^ move.edgeOriDelta[dp3];
      const nextState = encodeCrossStateFromParts(np0, np1, np2, np3, no0, no1, no2, no3);
      if (distance[nextState] !== -1) continue;
      distance[nextState] = baseDepth + 1;
      queue[tail++] = nextState;
    }
  }

  return distance;
}

function getCrossStateIndexFromData(data, ctx) {
  const pieces = data?.EDGES?.pieces;
  const orientation = data?.EDGES?.orientation;
  if (!pieces || !orientation) return -1;
  let found = 0;
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let o0 = 0;
  let o1 = 0;
  let o2 = 0;
  let o3 = 0;
  for (let pos = 0; pos < 12; pos++) {
    const pieceId = pieces[pos];
    const crossIdx = ctx.crossPieceIndexById.get(pieceId);
    if (crossIdx === undefined) continue;
    if (crossIdx === 0) {
      p0 = pos;
      o0 = orientation[pos] & 1;
      found |= 1;
    } else if (crossIdx === 1) {
      p1 = pos;
      o1 = orientation[pos] & 1;
      found |= 2;
    } else if (crossIdx === 2) {
      p2 = pos;
      o2 = orientation[pos] & 1;
      found |= 4;
    } else if (crossIdx === 3) {
      p3 = pos;
      o3 = orientation[pos] & 1;
      found |= 8;
    }
    if (found === 15) break;
  }
  if (found !== 15) return -1;
  return encodeCrossStateFromParts(p0, p1, p2, p3, o0, o1, o2, o3);
}

function getCrossPruneHeuristic(data, ctx) {
  const stateIndex = getCrossStateIndexFromData(data, ctx);
  if (stateIndex < 0) return null;
  const distance = ctx.crossPruneTable[stateIndex];
  if (!Number.isFinite(distance) || distance < 0) return null;
  return distance;
}

function encodeF2LAnchorKey(cPos, cPiece, cOri, ePos, ePiece, eOri) {
  return (
    (cPos & 7) |
    ((cPiece & 7) << 3) |
    ((cOri & 3) << 6) |
    ((ePos & 15) << 8) |
    ((ePiece & 15) << 12) |
    ((eOri & 1) << 16)
  );
}

function encodeF2LCornerState(data, positions) {
  const pieces = data.CORNERS.pieces;
  const orientation = data.CORNERS.orientation;
  let usedMask = 0;
  let permRank = 0;
  let oriCode = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const pieceId = pieces[pos];
    const lowerMask = (1 << pieceId) - 1;
    const usedLower = POPCOUNT_12[usedMask & lowerMask];
    const lessUnused = pieceId - usedLower;
    permRank = permRank * (8 - i) + lessUnused;
    usedMask |= 1 << pieceId;
    oriCode = oriCode * 3 + (orientation[pos] % 3);
  }
  return permRank * F2L_CORNER_ORI_FACTOR + oriCode;
}

function encodeF2LEdgeState(data, positions) {
  const pieces = data.EDGES.pieces;
  const orientation = data.EDGES.orientation;
  let usedMask = 0;
  let permRank = 0;
  let oriCode = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const pieceId = pieces[pos];
    const lowerMask = (1 << pieceId) - 1;
    const usedLower = POPCOUNT_12[usedMask & lowerMask];
    const lessUnused = pieceId - usedLower;
    permRank = permRank * (12 - i) + lessUnused;
    usedMask |= 1 << pieceId;
    oriCode = (oriCode << 1) | (orientation[pos] & 1);
  }
  return permRank * F2L_EDGE_ORI_FACTOR + oriCode;
}

function getF2LStateKey(data, ctx) {
  const cornerState = encodeF2LCornerState(data, ctx.f2lCornerPositions);
  const edgeState = encodeF2LEdgeState(data, ctx.f2lEdgePositions);
  return edgeState * F2L_CORNER_STATE_COUNT + cornerState;
}

function isBetterF2LRanking(a, b) {
  return !b || compareF2LRanking(a, b) < 0;
}

function countSolvedAtPositions(orbit, solvedOrbit, indices, checkPieces, checkOrientation) {
  let solved = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const pieceOk = !checkPieces || orbit.pieces[idx] === solvedOrbit.pieces[idx];
    const oriOk = !checkOrientation || orbit.orientation[idx] === solvedOrbit.orientation[idx];
    if (pieceOk && oriOk) solved += 1;
  }
  return solved;
}

function buildKeyForOrbit(orbit, indices, includePieces, includeOrientation) {
  const parts = [];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (includePieces) parts.push(`p${orbit.pieces[idx]}`);
    if (includeOrientation) parts.push(`o${orbit.orientation[idx]}`);
  }
  return parts.join(",");
}

function formatStageDisplay(stages, fullSolution) {
  const lines = stages.map((stage) => `${stage.name}: ${stage.solution || "-"}`);
  if (fullSolution) {
    lines.push("", `Full: ${fullSolution}`);
  }
  return lines.join("\n");
}

function splitMoves(alg) {
  if (!alg || typeof alg !== "string") return [];
  return alg
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinMoves(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function tryApplyAlg(pattern, algText) {
  if (!algText) return null;
  try {
    return pattern.applyAlg(algText);
  } catch (_) {
    return null;
  }
}

function tryApplyMoves(pattern, moves) {
  if (!moves || !moves.length) return null;
  try {
    let next = pattern;
    for (let i = 0; i < moves.length; i++) {
      next = next.applyMove(moves[i]);
    }
    return next;
  } catch (_) {
    return null;
  }
}

function tryBuildTransformation(pattern, algText) {
  if (!algText) return null;
  try {
    return pattern.applyAlg(algText).experimentalToTransformation();
  } catch (_) {
    return null;
  }
}

function tryApplyTransformation(pattern, transformation) {
  if (!pattern || !transformation) return null;
  try {
    return pattern.applyTransformation(transformation);
  } catch (_) {
    return null;
  }
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

function getF2LPairProgress(data, ctx) {
  const cornerSolved = countSolvedAtPositions(
    data.CORNERS,
    ctx.solvedData.CORNERS,
    ctx.f2lCornerPositions,
    true,
    true,
  );
  const edgeSolved = countSolvedAtPositions(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.f2lEdgePositions,
    true,
    true,
  );
  return Math.min(cornerSolved, edgeSolved);
}

function splitF2LMovesIntoPairs(startPattern, moves, ctx) {
  const segments = [];
  if (!moves || !moves.length) return segments;
  let pattern = startPattern;
  let currentPair = getF2LPairProgress(pattern.patternData, ctx);
  let segmentStart = 0;
  for (let i = 0; i < moves.length; i++) {
    pattern = pattern.applyMove(moves[i]);
    const nextPair = getF2LPairProgress(pattern.patternData, ctx);
    if (nextPair > currentPair) {
      const chunk = moves.slice(segmentStart, i + 1);
      for (let pair = currentPair + 1; pair <= nextPair && segments.length < 4; pair++) {
        segments.push({
          pair,
          moves: chunk,
        });
      }
      segmentStart = i + 1;
      currentPair = nextPair;
      if (currentPair >= 4) break;
    }
  }
  return segments;
}

function getCrossStageLabel(color) {
  const normalized = (color || "D").toUpperCase();
  const colorLabel = CROSS_COLOR_LABELS[normalized];
  const targets = CROSS_EDGE_TARGETS[normalized];
  if (!colorLabel || !targets) return "Cross";
  return `Cross (${colorLabel} | ${targets.join(" ")})`;
}

function normalizeCrossColor(color) {
  const normalized = (String(color || "D") || "D").toUpperCase();
  return CROSS_COLOR_ROTATION_CANDIDATES[normalized] !== undefined ? normalized : "D";
}

function getCrossRotationCandidates(color) {
  const normalized = normalizeCrossColor(color);
  const candidates = CROSS_COLOR_ROTATION_CANDIDATES[normalized];
  return Array.isArray(candidates) && candidates.length ? candidates : [""];
}

function normalizeSolveMode(mode) {
  return "strict";
}

function normalizeF2LMethod(method) {
  return "legacy";
}

function getCfopProfile(mode) {
  return STRICT_CFOP_PROFILE;
}

function isStrictSolvedPattern(pattern, data, ctx) {
  if (pattern && typeof pattern.experimentalIsSolved === "function") {
    try {
      return !!pattern.experimentalIsSolved({ ignorePuzzleOrientation: false });
    } catch (_) {
      // Fall back to cubie-level solved check below.
    }
  }
  return isPLLSolved(data, ctx);
}

function transformPatternForCrossColor(pattern, solvedPattern, rotationAlg) {
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

function relabelCrossProgress(progress, crossStageLabel) {
  if (!progress || typeof progress !== "object") return progress;
  if (progress.stageIndex !== 0) return progress;
  if (typeof progress.stageName === "string" && progress.stageName.startsWith("Cross")) {
    return {
      ...progress,
      stageName: crossStageLabel,
    };
  }
  return progress;
}

function invertToken(tok) {
  if (!tok) return tok;
  if (tok.endsWith("2")) return tok;
  if (tok.endsWith("'")) return tok.slice(0, -1);
  return `${tok}'`;
}

function invertAlg(algText) {
  const tokens = splitMoves(algText);
  const out = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    out.push(invertToken(tokens[i]));
  }
  return out.join(" ");
}

function invertRotation(rot) {
  if (!rot) return "";
  if (rot === "y2") return "y2";
  if (rot === "y") return "y'";
  if (rot === "y'") return "y";
  return "";
}

function buildFormulaCandidate(rot, preAuf, alg, postAuf = "") {
  // Use conjugation so rotation variants keep the global cube frame.
  // Example: y (alg) y'
  return joinMoves([rot, preAuf, alg, invertRotation(rot), postAuf]);
}

function normalizeDepth(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN > 0 ? intN : fallback;
}

async function getCfopContext() {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const solvedPattern = await getDefaultPattern("333");
    const solvedData = solvedPattern.patternData;
    const afterU = solvedPattern.applyMove("U").patternData;
    const afterD = solvedPattern.applyMove("D").patternData;

    const topEdgePositions = collectChangedPositions(solvedData.EDGES.pieces, afterU.EDGES.pieces);
    const topCornerPositions = collectChangedPositions(solvedData.CORNERS.pieces, afterU.CORNERS.pieces);
    const bottomEdgePositions = collectChangedPositions(solvedData.EDGES.pieces, afterD.EDGES.pieces);

    const topEdgeSet = new Set(topEdgePositions);
    const topCornerSet = new Set(topCornerPositions);

    const f2lEdgePositions = [];
    for (let i = 0; i < solvedData.EDGES.pieces.length; i++) {
      if (!topEdgeSet.has(i)) f2lEdgePositions.push(i);
    }
    const bottomEdgeSet = new Set(bottomEdgePositions);
    const middleEdgePositions = [];
    for (let i = 0; i < solvedData.EDGES.pieces.length; i++) {
      if (!topEdgeSet.has(i) && !bottomEdgeSet.has(i)) {
        middleEdgePositions.push(i);
      }
    }
    const isMiddleEdgePosition = new Uint8Array(solvedData.EDGES.pieces.length);
    for (let i = 0; i < middleEdgePositions.length; i++) {
      isMiddleEdgePosition[middleEdgePositions[i]] = 1;
    }
    const f2lCornerPositions = [];
    for (let i = 0; i < solvedData.CORNERS.pieces.length; i++) {
      if (!topCornerSet.has(i)) f2lCornerPositions.push(i);
    }

    const moveFace = MOVE_NAMES.map((move) => FACE_TO_INDEX[move[0]]);
    const allMoveIndices = MOVE_NAMES.map((_, idx) => idx);
    const noDMoveIndices = allMoveIndices.filter((idx) => moveFace[idx] !== FACE_TO_INDEX.D);
    const edgeMoveTables = buildEdgeMoveTables(solvedPattern, solvedData);
    const cornerMoveTables = buildCornerMoveTables(solvedPattern, solvedData);
    const crossPruneTable = buildCrossPruneTable(bottomEdgePositions, solvedData, edgeMoveTables);
    const crossEdgePieceIds = bottomEdgePositions.map((pos) => solvedData.EDGES.pieces[pos]);
    const crossPieceIndexById = new Map();
    for (let i = 0; i < crossEdgePieceIds.length; i++) {
      crossPieceIndexById.set(crossEdgePieceIds[i], i);
    }

    const f2lPairDefs = [];
    const pairCount = Math.min(f2lCornerPositions.length, middleEdgePositions.length);
    for (let i = 0; i < pairCount; i++) {
      const cornerTargetPos = f2lCornerPositions[i];
      const edgeTargetPos = middleEdgePositions[i];
      f2lPairDefs.push({
        cornerTargetPos,
        edgeTargetPos,
        cornerPieceId: solvedData.CORNERS.pieces[cornerTargetPos],
        edgePieceId: solvedData.EDGES.pieces[edgeTargetPos],
        cornerTargetOri: solvedData.CORNERS.orientation[cornerTargetPos] % 3,
        edgeTargetOri: solvedData.EDGES.orientation[edgeTargetPos] & 1,
        pruneTable: buildF2LPairPruneTable(
          {
            cornerTargetPos,
            edgeTargetPos,
            cornerTargetOri: solvedData.CORNERS.orientation[cornerTargetPos] % 3,
            edgeTargetOri: solvedData.EDGES.orientation[edgeTargetPos] & 1,
          },
          cornerMoveTables,
          edgeMoveTables,
          noDMoveIndices,
        ),
      });
    }

    return {
      solvedPattern,
      solvedData,
      topEdgePositions,
      topCornerPositions,
      bottomEdgePositions,
      f2lEdgePositions,
      middleEdgePositions,
      isMiddleEdgePosition,
      f2lCornerPositions,
      moveFace,
      allMoveIndices,
      noDMoveIndices,
      crossPruneTable,
      crossEdgePieceIds,
      crossPieceIndexById,
      f2lPairDefs,
    };
  })();
  return contextPromise;
}

async function getF2LCaseLibrary(ctx) {
  if (f2lCaseLibraryPromise) return f2lCaseLibraryPromise;
  f2lCaseLibraryPromise = (async () => {
    const formulas = SCDB_CFOP_ALGS.F2L || [];
    const solved = ctx.solvedPattern;
    const entries = [];
    const anchorIndex = new Array(F2L_ANCHOR_KEY_SIZE);
    const fallbackIndices = [];
    const formulaCandidates = [];
    const seenFormulaCandidate = new Set();
    for (let i = 0; i < formulas.length; i++) {
      const alg = formulas[i];
      for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
        const rot = FORMULA_ROTATIONS[r];
        for (let a = 0; a < FORMULA_AUF.length; a++) {
          const auf = FORMULA_AUF[a];
          const candidate = buildFormulaCandidate(rot, auf, alg);
          const inv = invertAlg(candidate);
          const casePattern = tryApplyAlg(solved, inv);
          if (!casePattern) continue;
          const caseData = casePattern.patternData;

          const cornerPos = [];
          const edgePos = [];
          for (let p = 0; p < 8; p++) {
            if (
              caseData.CORNERS.pieces[p] !== ctx.solvedData.CORNERS.pieces[p] ||
              caseData.CORNERS.orientation[p] !== ctx.solvedData.CORNERS.orientation[p]
            ) {
              cornerPos.push(p);
            }
          }
          for (let p = 0; p < 12; p++) {
            if (
              caseData.EDGES.pieces[p] !== ctx.solvedData.EDGES.pieces[p] ||
              caseData.EDGES.orientation[p] !== ctx.solvedData.EDGES.orientation[p]
            ) {
              edgePos.push(p);
            }
          }
          if (!cornerPos.length && !edgePos.length) continue;
          const moves = splitMoves(candidate);
          if (moves.length > 24) continue;
          const transformation = tryBuildTransformation(solved, candidate);
          if (!transformation) continue;
          const entry = {
            alg: candidate,
            moves,
            transformation,
            cornerPos,
            edgePos,
            cornerPieces: cornerPos.map((p) => caseData.CORNERS.pieces[p]),
            cornerOri: cornerPos.map((p) => caseData.CORNERS.orientation[p]),
            edgePieces: edgePos.map((p) => caseData.EDGES.pieces[p]),
            edgeOri: edgePos.map((p) => caseData.EDGES.orientation[p]),
          };
          const entryIndex = entries.length;
          entries.push(entry);
          if (!seenFormulaCandidate.has(candidate)) {
            seenFormulaCandidate.add(candidate);
            formulaCandidates.push({
              alg: candidate,
              moves,
              transformation,
            });
          }
          if (entry.cornerPos.length && entry.edgePos.length) {
            const key = encodeF2LAnchorKey(
              entry.cornerPos[0],
              entry.cornerPieces[0],
              entry.cornerOri[0],
              entry.edgePos[0],
              entry.edgePieces[0],
              entry.edgeOri[0],
            );
            const bucket = anchorIndex[key];
            if (bucket) {
              bucket.push(entryIndex);
            } else {
              anchorIndex[key] = [entryIndex];
            }
          } else {
            fallbackIndices.push(entryIndex);
          }
        }
      }
    }
    return {
      entries,
      anchorIndex,
      fallbackIndices,
      formulaCandidates,
      candidateMarkEpoch: 1,
      candidateMarks: new Uint32Array(entries.length),
    };
  })();
  return f2lCaseLibraryPromise;
}

function isCrossSolved(data, ctx) {
  return orbitMatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.bottomEdgePositions,
    true,
    true,
  );
}

function isF2LSolved(data, ctx) {
  if (!isCrossSolved(data, ctx)) return false;
  const cornersOk = orbitMatches(
    data.CORNERS,
    ctx.solvedData.CORNERS,
    ctx.f2lCornerPositions,
    true,
    true,
  );
  if (!cornersOk) return false;
  return orbitMatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.f2lEdgePositions,
    true,
    true,
  );
}

function isOLLSolved(data, ctx) {
  if (!isF2LSolved(data, ctx)) return false;
  const cornerOriOk = orbitMatches(
    data.CORNERS,
    ctx.solvedData.CORNERS,
    ctx.topCornerPositions,
    false,
    true,
  );
  if (!cornerOriOk) return false;
  return orbitMatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.topEdgePositions,
    false,
    true,
  );
}

function isPLLSolved(data, ctx) {
  const c = countOrbitMismatches(
    data.CORNERS,
    ctx.solvedData.CORNERS,
    [0, 1, 2, 3, 4, 5, 6, 7],
    true,
    true,
  );
  if (c.pieceMismatch || c.orientationMismatch) return false;
  const e = countOrbitMismatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    true,
    true,
  );
  return e.pieceMismatch === 0 && e.orientationMismatch === 0;
}

function getStageDefinitions(options, ctx, profile) {
  return [
    {
      name: "Cross",
      maxDepth: normalizeDepth(options.crossMaxDepth, profile.crossMaxDepth),
      moveIndices: ctx.allMoveIndices,
      isSolved: isCrossSolved,
      heuristic(data) {
        return getCrossPruneHeuristic(data, ctx);
      },
      mismatch(data) {
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.bottomEdgePositions,
          true,
          true,
        );
        return { pieceMismatch: e.pieceMismatch, orientationMismatch: e.orientationMismatch };
      },
      key(data) {
        return `E:${buildKeyForOrbit(data.EDGES, ctx.bottomEdgePositions, true, true)}`;
      },
    },
    {
      name: "F2L",
      // Formula-driven F2L commonly exceeds 16 moves; keep a larger cap here.
      maxDepth: normalizeDepth(options.f2lMaxDepth, profile.f2lMaxDepth),
      formulaMaxSteps: normalizeDepth(options.f2lFormulaMaxSteps, profile.f2lFormulaMaxSteps),
      formulaBeamWidth: normalizeDepth(options.f2lFormulaBeamWidth, profile.f2lFormulaBeamWidth),
      formulaExpansionLimit: normalizeDepth(
        options.f2lFormulaExpansionLimit,
        profile.f2lFormulaExpansionLimit,
      ),
      formulaMaxAttempts: normalizeDepth(options.f2lFormulaMaxAttempts, profile.f2lFormulaMaxAttempts),
      // Keep fallback almost disabled by default; SCDB formula beam does the heavy lifting.
      searchMaxDepth: normalizeDepth(options.f2lSearchMaxDepth, profile.f2lSearchMaxDepth),
      nodeLimit: normalizeDepth(options.f2lNodeLimit, profile.f2lNodeLimit),
      // Keep D fixed after cross to reduce branching and match CFOP move habits.
      moveIndices: ctx.noDMoveIndices,
      isSolved: isF2LSolved,
      usePairTable: true,
      heuristic(data) {
        const c = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          ctx.f2lCornerPositions,
          true,
          true,
        );
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.f2lEdgePositions,
          true,
          true,
        );
        const mismatchBound = stageHeuristicFromMismatch(
          c.pieceMismatch + e.pieceMismatch,
          c.orientationMismatch + e.orientationMismatch,
        );
        const pairTableBound = getF2LPairTableLowerBound(data, ctx);
        return Math.max(mismatchBound, pairTableBound);
      },
      mismatch(data) {
        const c = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          ctx.f2lCornerPositions,
          true,
          true,
        );
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.f2lEdgePositions,
          true,
          true,
        );
        return {
          pieceMismatch: c.pieceMismatch + e.pieceMismatch,
          orientationMismatch: c.orientationMismatch + e.orientationMismatch,
        };
      },
      key(data) {
        return getF2LStateKey(data, ctx);
      },
    },
    {
      name: "OLL",
      maxDepth: normalizeDepth(options.ollMaxDepth, profile.ollMaxDepth),
      moveIndices: ctx.noDMoveIndices,
      isSolved: isOLLSolved,
      mismatch(data) {
        const f2lC = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          ctx.f2lCornerPositions,
          true,
          true,
        );
        const f2lE = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.f2lEdgePositions,
          true,
          true,
        );
        const ollC = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          ctx.topCornerPositions,
          false,
          true,
        );
        const ollE = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.topEdgePositions,
          false,
          true,
        );
        return {
          pieceMismatch: f2lC.pieceMismatch + f2lE.pieceMismatch,
          orientationMismatch:
            f2lC.orientationMismatch +
            f2lE.orientationMismatch +
            ollC.orientationMismatch +
            ollE.orientationMismatch,
        };
      },
      key(data) {
        const f2lC = buildKeyForOrbit(data.CORNERS, ctx.f2lCornerPositions, true, true);
        const f2lE = buildKeyForOrbit(data.EDGES, ctx.f2lEdgePositions, true, true);
        const ollC = buildKeyForOrbit(data.CORNERS, ctx.topCornerPositions, false, true);
        const ollE = buildKeyForOrbit(data.EDGES, ctx.topEdgePositions, false, true);
        return `FC:${f2lC}|FE:${f2lE}|OC:${ollC}|OE:${ollE}`;
      },
    },
    {
      name: "PLL",
      maxDepth: normalizeDepth(options.pllMaxDepth, profile.pllMaxDepth),
      moveIndices: ctx.noDMoveIndices,
      isSolved: isPLLSolved,
      mismatch(data) {
        const c = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          [0, 1, 2, 3, 4, 5, 6, 7],
          true,
          true,
        );
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
          true,
          true,
        );
        return {
          pieceMismatch: c.pieceMismatch + e.pieceMismatch,
          orientationMismatch: c.orientationMismatch + e.orientationMismatch,
        };
      },
      key(data) {
        const c = buildKeyForOrbit(data.CORNERS, [0, 1, 2, 3, 4, 5, 6, 7], true, true);
        const e = buildKeyForOrbit(data.EDGES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], true, true);
        return `C:${c}|E:${e}`;
      },
    },
  ];
}

function getFormulaListForStage(stageName) {
  if (stageName === "F2L") return SCDB_CFOP_ALGS.F2L || [];
  if (stageName === "OLL") return SCDB_CFOP_ALGS.OLL || [];
  if (stageName === "PLL") return SCDB_CFOP_ALGS.PLL || [];
  return [];
}

function solveWithFormulaDbSingleStage(startPattern, stage, ctx) {
  const formulas = getFormulaListForStage(stage.name);
  if (!formulas.length) return null;

  let attempts = 0;
  const postAufList = stage.name === "PLL" ? FORMULA_AUF : [""];
  for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
    const rot = FORMULA_ROTATIONS[r];
    for (let a = 0; a < FORMULA_AUF.length; a++) {
      const preAuf = FORMULA_AUF[a];
      for (let i = 0; i < formulas.length; i++) {
        const alg = formulas[i];
        for (let p = 0; p < postAufList.length; p++) {
          const postAuf = postAufList[p];
          const candidate = buildFormulaCandidate(rot, preAuf, alg, postAuf);
          const nextPattern = tryApplyAlg(startPattern, candidate);
          attempts += 1;
          if (!nextPattern) continue;
          if (stage.isSolved(nextPattern.patternData, ctx)) {
            const moves = splitMoves(candidate);
            if (moves.length > stage.maxDepth) continue;
            return {
              ok: true,
              moves,
              depth: moves.length,
              nodes: attempts,
              bound: moves.length,
            };
          }
        }
      }
    }
  }
  return null;
}

function solveWithFormulaDbF2L(startPattern, stage, ctx) {
  const formulas = getFormulaListForStage("F2L");
  if (!formulas.length) return null;
  const metricsCache = new Map();
  const solvedCorners = ctx.solvedData.CORNERS;
  const solvedEdges = ctx.solvedData.EDGES;
  const cornerPositions = ctx.f2lCornerPositions;
  const edgePositions = ctx.f2lEdgePositions;
  const middleEdgeMask = ctx.isMiddleEdgePosition;

  function metricsFor(data, stateKey = null) {
    const key = stateKey === null ? stage.key(data) : stateKey;
    const cached = metricsCache.get(key);
    if (cached) return cached;
    const corners = data.CORNERS;
    const edges = data.EDGES;
    let pieceMismatch = 0;
    let orientationMismatch = 0;
    let cornerSolved = 0;
    let middleEdgeSolved = 0;
    for (let i = 0; i < cornerPositions.length; i++) {
      const pos = cornerPositions[i];
      const pieceOk = corners.pieces[pos] === solvedCorners.pieces[pos];
      const oriOk = corners.orientation[pos] === solvedCorners.orientation[pos];
      if (pieceOk && oriOk) {
        cornerSolved += 1;
      } else {
        if (!pieceOk) pieceMismatch += 1;
        if (!oriOk) orientationMismatch += 1;
      }
    }
    for (let i = 0; i < edgePositions.length; i++) {
      const pos = edgePositions[i];
      const pieceOk = edges.pieces[pos] === solvedEdges.pieces[pos];
      const oriOk = edges.orientation[pos] === solvedEdges.orientation[pos];
      if (!pieceOk) pieceMismatch += 1;
      if (!oriOk) orientationMismatch += 1;
      if (middleEdgeMask[pos] && pieceOk && oriOk) {
        middleEdgeSolved += 1;
      }
    }
    const score = pieceMismatch * 10 + orientationMismatch;
    const result = {
      score,
      cornerSolved,
      middleEdgeSolved,
      pairProgress: Math.min(cornerSolved, middleEdgeSolved),
      solvedSum: cornerSolved + middleEdgeSolved,
    };
    if (stage.usePairTable) {
      result.score += getF2LPairTablePenalty(data, ctx) * 2;
    }
    metricsCache.set(key, result);
    return result;
  }

  function improvesOver(next, cur) {
    return (
      next.pairProgress > cur.pairProgress ||
      (next.pairProgress === cur.pairProgress && next.solvedSum > cur.solvedSum) ||
      (next.pairProgress === cur.pairProgress && next.solvedSum === cur.solvedSum && next.score < cur.score)
    );
  }

  const maxAttempts = stage.formulaMaxAttempts || STRICT_CFOP_PROFILE.f2lFormulaMaxAttempts;
  const beamWidth = stage.formulaBeamWidth || STRICT_CFOP_PROFILE.f2lFormulaBeamWidth;
  const expansionLimit = stage.formulaExpansionLimit || STRICT_CFOP_PROFILE.f2lFormulaExpansionLimit;
  const attemptsRef = { count: 0 };

  function collectCandidates(node, nextFormulaDepth, bestDepthByState) {
    const currentPattern = node.pattern;
    const currentData = currentPattern.patternData;
    const currentMetrics = metricsFor(currentData, node.key);
    const improveMap = new Map();
    const fallbackMap = new Map();

    function consider(nextPattern, candidateMoves) {
      if (!nextPattern || !candidateMoves.length) return;
      if (node.moves.length + candidateMoves.length > stage.maxDepth) return;
      const nextData = nextPattern.patternData;
      if (!isCrossSolved(nextData, ctx)) return;
      const nextStateKey = stage.key(nextData);
      const seenDepth = bestDepthByState.get(nextStateKey);
      if (typeof seenDepth === "number" && nextFormulaDepth > seenDepth) return;
      const nextMetrics = metricsFor(nextData, nextStateKey);
      const ranking = {
        pairProgress: nextMetrics.pairProgress,
        solvedSum: nextMetrics.solvedSum,
        score: nextMetrics.score,
        moveLen: candidateMoves.length,
      };
      const candidate = {
        pattern: nextPattern,
        moves: candidateMoves,
        nextStateKey,
        ranking,
      };
      const targetMap = improvesOver(nextMetrics, currentMetrics) ? improveMap : fallbackMap;
      const prev = targetMap.get(nextStateKey);
      if (!prev || isBetterF2LRanking(ranking, prev.ranking)) {
        targetMap.set(nextStateKey, candidate);
      }
    }

    const libData = stage.f2lCaseLibrary || { entries: [] };
    const libEntries = Array.isArray(libData) ? libData : libData.entries || [];
    let candidateIndices = null;
    if (!Array.isArray(libData) && Array.isArray(libData.anchorIndex)) {
      const marks = libData.candidateMarks;
      let epoch = (libData.candidateMarkEpoch || 1) + 1;
      if (epoch >= 0xffffffff) {
        marks.fill(0);
        epoch = 1;
      }
      libData.candidateMarkEpoch = epoch;
      const addCandidateIndex = (idx) => {
        if (marks[idx] === epoch) return;
        marks[idx] = epoch;
        candidateIndices.push(idx);
      };
      candidateIndices = [];
      const fallback = libData.fallbackIndices || [];
      for (let i = 0; i < fallback.length; i++) {
        addCandidateIndex(fallback[i]);
      }
      const cornerPieces = currentData.CORNERS.pieces;
      const cornerOrientation = currentData.CORNERS.orientation;
      const edgePieces = currentData.EDGES.pieces;
      const edgeOrientation = currentData.EDGES.orientation;
      const anchorIndex = libData.anchorIndex;
      for (let cPos = 0; cPos < 8; cPos++) {
        const cPiece = cornerPieces[cPos];
        const cOri = cornerOrientation[cPos];
        for (let ePos = 0; ePos < 12; ePos++) {
          const key = encodeF2LAnchorKey(
            cPos,
            cPiece,
            cOri,
            ePos,
            edgePieces[ePos],
            edgeOrientation[ePos],
          );
          const bucket = anchorIndex[key];
          if (!bucket) continue;
          for (let b = 0; b < bucket.length; b++) addCandidateIndex(bucket[b]);
        }
      }
    }

    const scanAll = !candidateIndices;
    const scanLength = scanAll ? libEntries.length : candidateIndices.length;
    for (let i = 0; i < scanLength; i++) {
      if (attemptsRef.count >= maxAttempts) break;
      const entry = scanAll ? libEntries[i] : libEntries[candidateIndices[i]];
      let matches = true;
      for (let k = 0; k < entry.cornerPos.length; k++) {
        const pos = entry.cornerPos[k];
        if (
          currentData.CORNERS.pieces[pos] !== entry.cornerPieces[k] ||
          currentData.CORNERS.orientation[pos] !== entry.cornerOri[k]
        ) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      for (let k = 0; k < entry.edgePos.length; k++) {
        const pos = entry.edgePos[k];
        if (currentData.EDGES.pieces[pos] !== entry.edgePieces[k] || currentData.EDGES.orientation[pos] !== entry.edgeOri[k]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      const nextPattern = tryApplyTransformation(currentPattern, entry.transformation);
      attemptsRef.count += 1;
      if (!nextPattern) continue;
      consider(nextPattern, entry.moves);
    }

    if (improveMap.size === 0 && fallbackMap.size === 0) {
      const fallbackCandidates =
        !Array.isArray(libData) && Array.isArray(libData.formulaCandidates)
          ? libData.formulaCandidates
          : null;
      if (fallbackCandidates) {
        for (let i = 0; i < fallbackCandidates.length; i++) {
          if (attemptsRef.count >= maxAttempts) break;
          const nextPattern = tryApplyTransformation(currentPattern, fallbackCandidates[i].transformation);
          attemptsRef.count += 1;
          if (!nextPattern) continue;
          consider(nextPattern, fallbackCandidates[i].moves);
        }
      } else {
        let stop = false;
        for (let r = 0; r < FORMULA_ROTATIONS.length && !stop; r++) {
          const rot = FORMULA_ROTATIONS[r];
          for (let a = 0; a < FORMULA_AUF.length && !stop; a++) {
            const preAuf = FORMULA_AUF[a];
            for (let i = 0; i < formulas.length; i++) {
              if (attemptsRef.count >= maxAttempts) {
                stop = true;
                break;
              }
              const candidateText = buildFormulaCandidate(rot, preAuf, formulas[i]);
              const candidateMoves = splitMoves(candidateText);
              const nextPattern = tryApplyMoves(currentPattern, candidateMoves);
              attemptsRef.count += 1;
              if (!nextPattern) continue;
              consider(nextPattern, candidateMoves);
            }
          }
        }
      }
    }

    const improveOut = Array.from(improveMap.values());
    improveOut.sort((a, b) => compareF2LRanking(a.ranking, b.ranking));
    const fallbackOut = Array.from(fallbackMap.values());
    fallbackOut.sort((a, b) => compareF2LRanking(a.ranking, b.ranking));

    if (!improveOut.length) {
      if (fallbackOut.length > expansionLimit) return fallbackOut.slice(0, expansionLimit);
      return fallbackOut;
    }

    const fallbackQuota = Math.max(1, Math.floor(expansionLimit / 4));
    const improveQuota = Math.max(1, expansionLimit - fallbackQuota);
    const out = improveOut.slice(0, improveQuota);
    const seen = new Set(out.map((entry) => entry.nextStateKey));

    for (let i = 0; i < fallbackOut.length && out.length < expansionLimit; i++) {
      const entry = fallbackOut[i];
      if (seen.has(entry.nextStateKey)) continue;
      seen.add(entry.nextStateKey);
      out.push(entry);
    }

    if (out.length < expansionLimit) {
      for (let i = improveQuota; i < improveOut.length && out.length < expansionLimit; i++) {
        const entry = improveOut[i];
        if (seen.has(entry.nextStateKey)) continue;
        seen.add(entry.nextStateKey);
        out.push(entry);
      }
    }

    return out;
  }

  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const startKey = stage.key(startData);
  let beam = [{ pattern: startPattern, moves: [], key: startKey, ranking: metricsFor(startData) }];
  const bestDepthByState = new Map([[startKey, 0]]);

  const maxFormulaSteps = stage.formulaMaxSteps || FORMULA_F2L_MAX_STEPS;
  for (let step = 0; step < maxFormulaSteps; step++) {
    const nextByKey = new Map();
    const nextFormulaDepth = step + 1;

    for (let i = 0; i < beam.length; i++) {
      const node = beam[i];
      if (stage.isSolved(node.pattern.patternData, ctx)) {
        return {
          ok: true,
          moves: node.moves.slice(),
          depth: node.moves.length,
          nodes: attemptsRef.count,
          bound: node.moves.length,
        };
      }
      const candidates = collectCandidates(node, nextFormulaDepth, bestDepthByState);
      for (let c = 0; c < candidates.length; c++) {
        const candidate = candidates[c];
        const mergedMoves = node.moves.concat(candidate.moves);
        const entry = {
          pattern: candidate.pattern,
          moves: mergedMoves,
          key: candidate.nextStateKey,
          ranking: candidate.ranking,
        };
        const prev = nextByKey.get(candidate.nextStateKey);
        if (
          !prev ||
          isBetterF2LRanking(entry.ranking, prev.ranking) ||
          (compareF2LRanking(entry.ranking, prev.ranking) === 0 && entry.moves.length < prev.moves.length)
        ) {
          nextByKey.set(candidate.nextStateKey, entry);
        }
      }
    }

    if (!nextByKey.size) break;
    let nextBeam = Array.from(nextByKey.values());
    nextBeam.sort((a, b) => {
      const rankCmp = compareF2LRanking(a.ranking, b.ranking);
      if (rankCmp !== 0) return rankCmp;
      return a.moves.length - b.moves.length;
    });
    if (nextBeam.length > beamWidth) {
      nextBeam = nextBeam.slice(0, beamWidth);
    }
    beam = nextBeam;
    for (let i = 0; i < beam.length; i++) {
      const prevDepth = bestDepthByState.get(beam[i].key);
      if (typeof prevDepth !== "number" || nextFormulaDepth < prevDepth) {
        bestDepthByState.set(beam[i].key, nextFormulaDepth);
      }
      if (stage.isSolved(beam[i].pattern.patternData, ctx)) {
        return {
          ok: true,
          moves: beam[i].moves.slice(),
          depth: beam[i].moves.length,
          nodes: attemptsRef.count,
          bound: beam[i].moves.length,
        };
      }
    }
    if (attemptsRef.count >= maxAttempts) break;
  }

  return null;
}

function solveStageByFormulaDb(startPattern, stage, ctx) {
  if (stage.name === "F2L") {
    return solveWithFormulaDbF2L(startPattern, stage, ctx);
  }
  if (stage.name === "OLL" || stage.name === "PLL") {
    return solveWithFormulaDbSingleStage(startPattern, stage, ctx);
  }
  return null;
}

function solveStage(startPattern, stage, ctx) {
  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const formulaResult = solveStageByFormulaDb(startPattern, stage, ctx);
  if (formulaResult?.ok) {
    return formulaResult;
  }

  const heuristicCache = new Map();
  const failCache = new Map();
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  const nodeLimit = Number.isFinite(stage.nodeLimit) ? stage.nodeLimit : 0;

  function heuristic(data) {
    const key = stage.key(data);
    const cached = heuristicCache.get(key);
    if (typeof cached === "number") return cached;
    let h = null;
    if (typeof stage.heuristic === "function") {
      h = stage.heuristic(data, ctx);
    }
    if (!Number.isFinite(h) || h < 0) {
      const mismatch = stage.mismatch(data);
      h = stageHeuristicFromMismatch(mismatch.pieceMismatch, mismatch.orientationMismatch);
    } else {
      h = Math.floor(h);
    }
    if (heuristicCache.size > HEURISTIC_CACHE_LIMIT) heuristicCache.clear();
    heuristicCache.set(key, h);
    return h;
  }

  let bound = Math.max(heuristic(startData), 1);
  const searchMaxDepth = Number.isFinite(stage.searchMaxDepth) ? stage.searchMaxDepth : stage.maxDepth;

  function dfs(pattern, depth, currentBound, lastFace) {
    const data = pattern.patternData;
    const h = heuristic(data);
    const f = depth + h;
    if (f > currentBound) return f;
    if (stage.isSolved(data, ctx)) return true;

    const remaining = currentBound - depth;
    const stateKey = stage.key(data);
    const cacheKey = `${stateKey}|${lastFace}`;
    const seenMask = failCache.get(cacheKey) || 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    let minNext = Infinity;
    for (let i = 0; i < stage.moveIndices.length; i++) {
      if (nodeLimit > 0 && nodes >= nodeLimit) {
        nodeLimitHit = true;
        return Infinity;
      }
      const moveIndex = stage.moveIndices[i];
      const face = ctx.moveFace[moveIndex];
      if (lastFace !== 6) {
        if (face === lastFace) continue;
        if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
      }
      nodes += 1;
      const nextPattern = pattern.applyMove(MOVE_NAMES[moveIndex]);
      const res = dfs(nextPattern, depth + 1, currentBound, face);
      if (res === true) {
        path.push(moveIndex);
        return true;
      }
      if (res < minNext) minNext = res;
    }

    if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
    failCache.set(cacheKey, seenMask | bit);
    return minNext;
  }

  while (bound <= searchMaxDepth) {
    if (nodeLimitHit) break;
    path.length = 0;
    const res = dfs(startPattern, 0, bound, 6);
    if (res === true) {
      path.reverse();
      return {
        ok: true,
        moves: path.map((idx) => MOVE_NAMES[idx]),
        depth: path.length,
        nodes,
        bound,
      };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  if (nodeLimitHit) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
      nodes,
      bound: STAGE_NOT_SET,
    };
  }

  return {
    ok: false,
    reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
    nodes,
    bound: STAGE_NOT_SET,
  };
}

export async function solve3x3StrictCfopFromPattern(pattern, options = {}) {
  const ctx = await getCfopContext();
  const solveMode = normalizeSolveMode(options.mode);
  const modeProfile = getCfopProfile(solveMode);
  const crossColorRaw = normalizeCrossColor(options.crossColor);
  const crossStageLabel = getCrossStageLabel(crossColorRaw);
  const crossRotationCandidates = getCrossRotationCandidates(crossColorRaw).filter(Boolean);
  if (!options.__colorNeutralApplied && crossRotationCandidates.length) {
    const onStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;
    let selectedRotationAlg = "";
    let childResult = null;
    let firstFailResult = null;
    for (let i = 0; i < crossRotationCandidates.length; i++) {
      const crossRotationAlg = crossRotationCandidates[i];
      const transformedPattern = transformPatternForCrossColor(pattern, ctx.solvedPattern, crossRotationAlg);
      if (!transformedPattern) {
        if (!firstFailResult) {
          firstFailResult = {
            ok: false,
            reason: "CROSS_COLOR_TRANSFORM_FAILED",
            stage: "Cross",
            nodes: 0,
          };
        }
        continue;
      }
      const candidateResult = await solve3x3StrictCfopFromPattern(transformedPattern, {
        ...options,
        crossColor: "D",
        __colorNeutralApplied: true,
        onStageUpdate: onStageUpdate
          ? (progress) => {
              onStageUpdate(relabelCrossProgress(progress, crossStageLabel));
            }
          : undefined,
      });
      if (candidateResult?.ok) {
        selectedRotationAlg = crossRotationAlg;
        childResult = candidateResult;
        break;
      }
      if (!firstFailResult) firstFailResult = candidateResult;
      const reason = candidateResult?.reason || "";
      const isRetryable =
        reason === "FINAL_STATE_NOT_SOLVED" ||
        reason.endsWith("_NOT_FOUND") ||
        reason.endsWith("_SEARCH_LIMIT");
      if (!isRetryable) {
        return candidateResult;
      }
    }
    if (!childResult?.ok) {
      return firstFailResult || {
        ok: false,
        reason: "CROSS_COLOR_TRANSFORM_FAILED",
        stage: "Cross",
        nodes: 0,
      };
    }

    const setupMoves = splitMoves(selectedRotationAlg);
    const cleanupMoves = splitMoves(invertAlg(selectedRotationAlg));
    const coreMoves = splitMoves(childResult.solution || "");
    const fullMoves = simplifyMoves(setupMoves.concat(coreMoves, cleanupMoves));
    const fullSolution = joinMoves(fullMoves);
    const stages = Array.isArray(childResult.stages)
      ? childResult.stages.map((stage) => ({ ...stage }))
      : [];

    if (stages.length) {
      stages[0].name = crossStageLabel;
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

    const finalPattern = fullSolution ? pattern.applyAlg(fullSolution) : pattern;
    if (!isStrictSolvedPattern(finalPattern, finalPattern.patternData, ctx)) {
      return {
        ok: false,
        reason: "FINAL_STATE_NOT_SOLVED",
        stage: "PLL",
        nodes: childResult.nodes || 0,
      };
    }

    return {
      ...childResult,
      solution: fullSolution,
      moveCount: fullMoves.length,
      stages,
      solutionDisplay: formatStageDisplay(stages, fullSolution),
    };
  }

  const stages = getStageDefinitions(options, ctx, modeProfile);
  for (let i = 0; i < stages.length; i++) {
    if (stages[i].name === "F2L") {
      stages[i].f2lCaseLibrary = await getF2LCaseLibrary(ctx);
    }
  }
  const onStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;
  let currentPattern = pattern;
  const solvedStages = [];
  const allMoves = [];
  let totalNodes = 0;
  let totalBound = 0;

  if (onStageUpdate) {
    onStageUpdate({
      type: "start",
      totalStages: stages.length,
    });
  }

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const stageStartPattern = currentPattern;
    const stageLabel = stage.name === "Cross" ? crossStageLabel : stage.name;
    if (onStageUpdate) {
      onStageUpdate({
        type: "stage_start",
        stageIndex: i,
        totalStages: stages.length,
        stageName: stageLabel,
      });
    }
    const result = solveStage(stageStartPattern, stage, ctx);
    totalNodes += result.nodes || 0;
    if (typeof result.bound === "number" && result.bound !== STAGE_NOT_SET) {
      totalBound += result.bound;
    }
    if (!result.ok) {
      if (onStageUpdate) {
        onStageUpdate({
          type: "stage_fail",
          stageIndex: i,
          totalStages: stages.length,
          stageName: stageLabel,
          reason: result.reason || `${stage.name.toUpperCase()}_FAILED`,
        });
      }
      return {
        ok: false,
        reason: result.reason || `${stage.name.toUpperCase()}_FAILED`,
        stage: stage.name,
        nodes: totalNodes,
      };
    }

    const internalMoves = Array.isArray(result.moves) ? result.moves.slice() : [];
    const outputMoves = simplifyMoves(internalMoves);
    const moveText = joinMoves(outputMoves);
    const stageEntries = [];
    if (stage.name === "F2L") {
      const pairSegments = splitF2LMovesIntoPairs(stageStartPattern, internalMoves, ctx);
      if (pairSegments.length) {
        pairSegments.forEach((segment, index) => {
          const segmentMoves = simplifyMoves(segment.moves);
          stageEntries.push({
            name: `F2L ${segment.pair}`,
            solution: joinMoves(segmentMoves),
            moveCount: segmentMoves.length,
            depth: segmentMoves.length,
            nodes: index === 0 ? result.nodes : undefined,
          });
        });
      } else {
        stageEntries.push({
          name: stageLabel,
          solution: joinMoves(outputMoves),
          moveCount: outputMoves.length,
          depth: outputMoves.length,
          nodes: result.nodes,
        });
      }
    } else {
      stageEntries.push({
        name: stageLabel,
        solution: joinMoves(outputMoves),
        moveCount: outputMoves.length,
        depth: outputMoves.length,
        nodes: result.nodes,
      });
    }
    solvedStages.push(...stageEntries);
    if (onStageUpdate) {
      onStageUpdate({
        type: "stage_done",
        stageIndex: i,
        totalStages: stages.length,
        stageName: stageLabel,
        moveCount: outputMoves.length,
      });
    }
    allMoves.push(...outputMoves);
    if (moveText) {
      currentPattern = currentPattern.applyAlg(moveText);
    }
  }

  if (!isStrictSolvedPattern(currentPattern, currentPattern.patternData, ctx)) {
    return {
      ok: false,
      reason: "FINAL_STATE_NOT_SOLVED",
      nodes: totalNodes,
    };
  }

  const fullMoves = simplifyMoves(allMoves);
  const fullSolution = joinMoves(fullMoves);
  return {
    ok: true,
    solution: fullSolution,
    solutionDisplay: formatStageDisplay(solvedStages, fullSolution),
    moveCount: fullMoves.length,
    nodes: totalNodes,
    bound: totalBound,
    source: "INTERNAL_3X3_CFOP_STRICT",
    stages: solvedStages,
  };
}
