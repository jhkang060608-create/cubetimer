import { getDefaultPattern } from "./context.js";
import { MOVE_NAMES } from "./moves.js";
import { SCDB_CFOP_ALGS } from "./scdbCfopAlgs.js";
import { ZB_FORMULAS } from "./zbDataset.js";
import { ROUX_FORMULAS } from "./rouxDataset.js";

const FACE_TO_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5, M: 6 };
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2, 6];
const NO_FACE_INDEX = OPPOSITE_FACE.length;
const STAGE_NOT_SET = 255;
const HEURISTIC_CACHE_LIMIT = 120000;
const FAIL_CACHE_LIMIT = 160000;
const FREE_F2L_PAIR_METRICS_CACHE_LIMIT = 120000;
const SB_BLOCK_TABLE_CACHE_LIMIT = 120000;
const FORMULA_ROTATIONS = ["", "y", "y2", "y'"];
const FORMULA_AUF = ["", "U", "U2", "U'"];
const SINGLE_MOVE_TOKEN_RE = /^[A-Za-z]+(2'?|')?$/;
const LSE_REDUCED_PRIMARY_MOVES = Object.freeze(["U", "U'", "U2", "M", "M'", "M2"]);
const LSE_REDUCED_EXTENDED_MOVES = Object.freeze([
  "U",
  "U'",
  "U2",
  "M",
  "M'",
  "M2",
  "R",
  "R'",
  "R2",
  "L",
  "L'",
  "L2",
]);
const SOLVED_ORIENTATION_ALIGN_ALGS = [
  "",
  "y",
  "y2",
  "y'",
  "x",
  "x y",
  "x y2",
  "x y'",
  "x2",
  "x2 y",
  "x2 y2",
  "x2 y'",
  "x'",
  "x' y",
  "x' y2",
  "x' y'",
  "z",
  "z y",
  "z y2",
  "z y'",
  "z'",
  "z' y",
  "z' y2",
  "z' y'",
];
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
  f2lFormulaMaxSteps: 12,
  f2lFormulaBeamWidth: 7,
  f2lFormulaExpansionLimit: 12,
  f2lFormulaMaxAttempts: 240000,
  f2lSearchMaxDepth: 11,
  f2lNodeLimit: 220000,
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
const ROUX_PROFILE = {
  crossMaxDepth: 10,
  f2lMaxDepth: 38,
  f2lFormulaMaxSteps: 12,
  f2lFormulaBeamWidth: 7,
  f2lFormulaExpansionLimit: 12,
  f2lFormulaMaxAttempts: 240000,
  f2lSearchMaxDepth: 10,
  f2lNodeLimit: 200000,
  ollMaxDepth: 18,
  pllMaxDepth: 24,
};
const ROUX_ORIENTATION_SWEEP_CANDIDATES = Object.freeze(["", "x", "x'", "z", "z'", "x2"]);
const ROUX_COLOR_LOCKED_SWEEP_CANDIDATES = Object.freeze(["", "y", "y'", "y2"]);
const POST_OPT_MOVE_NAMES = MOVE_NAMES.slice();
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
const formulaValidityCache = new Map();
const singleStageFormulaCaseLibraryCache = new Map();
const SINGLE_STAGE_LIBRARY_CACHE_LIMIT = 12;

let contextPromise = null;
const getNowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

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
  if (a.moveLen !== b.moveLen) return a.moveLen - b.moveLen;
  if (a.score !== b.score) return a.score - b.score;
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

function buildF2LPairStateTransitionTables(cornerMoveTables, edgeMoveTables) {
  const transitionByMove = new Array(MOVE_NAMES.length);
  for (let moveIndex = 0; moveIndex < MOVE_NAMES.length; moveIndex++) {
    const cMap = cornerMoveTables[moveIndex];
    const eMap = edgeMoveTables[moveIndex];
    const table = new Uint16Array(576);
    for (let state = 0; state < 576; state++) {
      const edgeOri = state & 1;
      let rem = state >> 1;
      const edgePos = rem % 12;
      rem = Math.floor(rem / 12);
      const cornerOri = rem % 3;
      const cornerPos = Math.floor(rem / 3);
      const nextCornerPos = cMap.cornerPosMap[cornerPos];
      const nextCornerOri = (cornerOri + cMap.cornerOriDelta[cornerPos]) % 3;
      const nextEdgePos = eMap.edgePosMap[edgePos];
      const nextEdgeOri = edgeOri ^ eMap.edgeOriDelta[edgePos];
      table[state] = encodeF2LPairState(nextCornerPos, nextCornerOri, nextEdgePos, nextEdgeOri);
    }
    transitionByMove[moveIndex] = table;
  }
  return transitionByMove;
}

function buildRouxSbBlockPairPruneTable(pairDefA, pairDefB, transitionByMove, allowedMoveIndices) {
  const stride = 576;
  const totalStates = stride * stride;
  const distance = new Int16Array(totalStates);
  distance.fill(-1);
  const startA = encodeF2LPairState(
    pairDefA.cornerTargetPos,
    pairDefA.cornerTargetOri,
    pairDefA.edgeTargetPos,
    pairDefA.edgeTargetOri,
  );
  const startB = encodeF2LPairState(
    pairDefB.cornerTargetPos,
    pairDefB.cornerTargetOri,
    pairDefB.edgeTargetPos,
    pairDefB.edgeTargetOri,
  );
  const startState = startA * stride + startB;
  const queue = new Uint32Array(totalStates);
  let head = 0;
  let tail = 0;
  distance[startState] = 0;
  queue[tail++] = startState;

  while (head < tail) {
    const state = queue[head++];
    const baseDepth = distance[state];
    const stateA = Math.floor(state / stride);
    const stateB = state - stateA * stride;

    for (let i = 0; i < allowedMoveIndices.length; i++) {
      const moveIndex = allowedMoveIndices[i];
      const nextA = transitionByMove[moveIndex][stateA];
      const nextB = transitionByMove[moveIndex][stateB];
      const nextState = nextA * stride + nextB;
      if (distance[nextState] !== -1) continue;
      distance[nextState] = baseDepth + 1;
      queue[tail++] = nextState;
    }
  }
  return distance;
}

function buildRouxSbBlockTables(pairDefs) {
  if (!Array.isArray(pairDefs) || pairDefs.length < 2) return [];
  const pairCount = Math.min(4, pairDefs.length);
  const tables = [];
  for (let a = 0; a < pairCount; a++) {
    for (let b = a + 1; b < pairCount; b++) {
      tables.push({
        pairA: a,
        pairB: b,
        key: `${a}:${b}`,
      });
    }
  }
  return tables;
}

function ensureRouxSbBlockTables(ctx) {
  if (!ctx) return [];
  if (Array.isArray(ctx.rouxSbBlockTables)) return ctx.rouxSbBlockTables;
  ctx.rouxSbBlockTables = buildRouxSbBlockTables(ctx.f2lPairDefs);
  if (!(ctx.rouxSbBlockPairTableCache instanceof Map)) {
    ctx.rouxSbBlockPairTableCache = new Map();
  }
  return ctx.rouxSbBlockTables;
}

function getRouxSbBlockTableLowerBound(data, ctx) {
  const sbBlockTables = ensureRouxSbBlockTables(ctx);
  if (!sbBlockTables.length || !Array.isArray(ctx?.f2lPairDefs) || !ctx.f2lPairDefs.length) return 0;
  const cacheKey = getF2LStateKey(data, ctx);
  const cache = ctx.rouxSbBlockTableCache || (ctx.rouxSbBlockTableCache = new Map());
  const cached = cache.get(cacheKey);
  if (typeof cached === "number") return cached;

  const pairCount = Math.min(4, ctx.f2lPairDefs.length);
  const pairStates = new Int16Array(pairCount);
  let lowerBound = 0;
  for (let i = 0; i < pairCount; i++) {
    const pairDef = ctx.f2lPairDefs[i];
    const pairState = getF2LPairStateForDef(data, pairDef);
    pairStates[i] = pairState;
    if (pairState < 0) continue;
    const pruneTable = pairDef?.pruneTableNoD || pairDef?.pruneTable || null;
    if (!pruneTable) continue;
    const dist = pruneTable[pairState];
    if (!Number.isFinite(dist) || dist < 0) continue;
    if (dist > lowerBound) lowerBound = dist;
  }

  for (let pairA = 0; pairA < pairCount; pairA++) {
    for (let pairB = pairA + 1; pairB < pairCount; pairB++) {
      const stateA = pairStates[pairA];
      const stateB = pairStates[pairB];
      if (stateA < 0 || stateB < 0) continue;
      const pairKey = `${pairA}:${pairB}`;
      let blockTable = ctx.rouxSbBlockPairTableCache.get(pairKey) || null;
      if (!blockTable) {
        const pairDefA = ctx.f2lPairDefs[pairA];
        const pairDefB = ctx.f2lPairDefs[pairB];
        blockTable = buildRouxSbBlockPairPruneTable(
          pairDefA,
          pairDefB,
          ctx.f2lPairStateTransitionByMove,
          ctx.noDMoveIndices,
        );
        ctx.rouxSbBlockPairTableCache.set(pairKey, blockTable);
      }
      const dist = blockTable[stateA * 576 + stateB];
      if (Number.isFinite(dist) && dist > lowerBound) {
        lowerBound = dist;
      }
    }
  }

  if (cache.size > SB_BLOCK_TABLE_CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, lowerBound);
  return lowerBound;
}

function getF2LPairTablePenalty(data, ctx) {
  return getF2LPairTableMetrics(data, ctx).penalty;
}

function getF2LPairTableLowerBound(data, ctx) {
  return getF2LPairTableMetrics(data, ctx).lowerBound;
}

function getF2LPairTableMetrics(data, ctx) {
  if (!ctx.f2lPairDefs || !ctx.f2lPairDefs.length) {
    return {
      penalty: 0,
      lowerBound: 0,
      solvedPairs: getF2LPairProgress(data, ctx),
      nearestUnsolved: 0,
    };
  }
  const cornerPosByPiece =
    ctx.f2lCornerPosScratch || (ctx.f2lCornerPosScratch = new Int8Array(8));
  const edgePosByPiece = ctx.f2lEdgePosScratch || (ctx.f2lEdgePosScratch = new Int8Array(12));
  for (let pos = 0; pos < 8; pos++) {
    cornerPosByPiece[data.CORNERS.pieces[pos]] = pos;
  }
  for (let pos = 0; pos < 12; pos++) {
    edgePosByPiece[data.EDGES.pieces[pos]] = pos;
  }
  let penalty = 0;
  let lowerBound = 0;
  let solvedPairs = 0;
  let nearestUnsolved = Infinity;
  for (let i = 0; i < ctx.f2lPairDefs.length; i++) {
    const def = ctx.f2lPairDefs[i];
    const cornerPos = cornerPosByPiece[def.cornerPieceId];
    const edgePos = edgePosByPiece[def.edgePieceId];
    if (cornerPos < 0 || edgePos < 0) continue;
    const cornerOri = data.CORNERS.orientation[cornerPos] % 3;
    const edgeOri = data.EDGES.orientation[edgePos] & 1;
    const state = encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri);
    const dist = def.pruneTable[state];
    if (dist === 0) {
      solvedPairs += 1;
      continue;
    }
    if (dist > 0) {
      penalty += dist;
      if (dist > lowerBound) lowerBound = dist;
      if (dist < nearestUnsolved) nearestUnsolved = dist;
    }
  }
  if (!Number.isFinite(nearestUnsolved)) nearestUnsolved = 0;
  return { penalty, lowerBound, solvedPairs, nearestUnsolved };
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

function sanitizeFormulaAlg(rawAlg) {
  let text = String(rawAlg || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Strip common AUF wrappers used in imported datasets.
  text = text.replace(/^\((U2|U'|U)\)\s*/i, "");
  text = text.replace(/^\((U2|U'|U)\)\s*/i, "");
  // Flatten grouping notation to plain move sequence.
  text = text.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (!/^[URFDLBMESXYZurfdlbmesxyzw'2\s]+$/.test(text)) return "";
  return text;
}

function filterValidFormulas(formulas, ctx) {
  if (!Array.isArray(formulas) || !formulas.length) return [];
  if (!ctx?.solvedPattern) return formulas;
  const valid = [];
  for (let i = 0; i < formulas.length; i++) {
    const alg = formulas[i];
    let ok = formulaValidityCache.get(alg);
    if (ok === undefined) {
      ok = !!tryApplyAlg(ctx.solvedPattern, alg);
      formulaValidityCache.set(alg, ok);
    }
    if (ok) valid.push(alg);
  }
  return valid;
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

function normalizeSearchMoveTokens(input, fallback = []) {
  const source = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/\s+/)
      : fallback;
  if (!Array.isArray(source) || !source.length) return [];
  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < source.length; i++) {
    const token = String(source[i] || "").trim();
    if (!token || seen.has(token)) continue;
    if (!SINGLE_MOVE_TOKEN_RE.test(token)) continue;
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
}

function getMoveAxisGroup(move) {
  const face = String(move || "").charAt(0);
  if (
    face === "U" ||
    face === "D" ||
    face === "E" ||
    face === "u" ||
    face === "d" ||
    face === "y" ||
    face === "Y"
  ) {
    return "UD";
  }
  if (
    face === "R" ||
    face === "L" ||
    face === "M" ||
    face === "r" ||
    face === "l" ||
    face === "x" ||
    face === "X"
  ) {
    return "RL";
  }
  if (
    face === "F" ||
    face === "B" ||
    face === "S" ||
    face === "f" ||
    face === "b" ||
    face === "z" ||
    face === "Z"
  ) {
    return "FB";
  }
  return face || "?";
}

function orbitStateKey(orbit) {
  if (!orbit) return "";
  const pieces = orbit.pieces;
  const orientation = orbit.orientation;
  if (!pieces || !orientation) return "";
  return `${pieces.join(",")}/${orientation.join(",")}`;
}

function patternStateKey(pattern) {
  const data = pattern?.patternData;
  if (!data) return "";
  return `C:${orbitStateKey(data.CORNERS)}|E:${orbitStateKey(data.EDGES)}|N:${orbitStateKey(data.CENTERS)}`;
}

function buildPatternFrontier(rootPattern, depthLimit, deadlineTs, direction = "forward") {
  const map = new Map();
  const rootKey = patternStateKey(rootPattern);
  map.set(rootKey, []);
  if (!Number.isFinite(depthLimit) || depthLimit <= 0) return map;

  const queue = [{ pattern: rootPattern, path: [], depth: 0, lastFace: "" }];
  let head = 0;

  while (head < queue.length) {
    if (Number.isFinite(deadlineTs) && Date.now() >= deadlineTs) break;
    const node = queue[head++];
    if (node.depth >= depthLimit) continue;

    for (let i = 0; i < POST_OPT_MOVE_NAMES.length; i++) {
      if (Number.isFinite(deadlineTs) && Date.now() >= deadlineTs) break;
      const move = POST_OPT_MOVE_NAMES[i];
      const face = move[0];
      if (face === node.lastFace) continue;

      const stepMove = direction === "forward" ? move : invertToken(move);
      const nextPattern = node.pattern.applyMove(stepMove);
      const nextPath = direction === "forward" ? node.path.concat(move) : [move].concat(node.path);
      const key = patternStateKey(nextPattern);
      const existing = map.get(key);
      if (existing && existing.length <= nextPath.length) continue;
      map.set(key, nextPath);
      queue.push({
        pattern: nextPattern,
        path: nextPath,
        depth: node.depth + 1,
        lastFace: face,
      });
    }
  }

  return map;
}

function findShorterEquivalentSegment(startPattern, targetPattern, maxDepth, currentLength, deadlineTs) {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0 || currentLength <= 1) return null;
  if (Number.isFinite(deadlineTs) && Date.now() >= deadlineTs) return null;
  const startKey = patternStateKey(startPattern);
  const targetKey = patternStateKey(targetPattern);
  if (!startKey || !targetKey) return null;
  if (startKey === targetKey) return [];

  const searchDepth = Math.max(1, Math.min(Math.floor(maxDepth), currentLength - 1));
  const forwardDepth = Math.floor(searchDepth / 2);
  const backwardDepth = searchDepth - forwardDepth;
  const forwardMap = buildPatternFrontier(startPattern, forwardDepth, deadlineTs, "forward");
  const backwardMap = buildPatternFrontier(targetPattern, backwardDepth, deadlineTs, "backward");

  let best = null;
  let bestText = "";

  for (const [key, leftPath] of forwardMap.entries()) {
    if (Number.isFinite(deadlineTs) && Date.now() >= deadlineTs) break;
    const rightPath = backwardMap.get(key);
    if (!rightPath) continue;
    const merged = leftPath.concat(rightPath);
    if (merged.length >= currentLength || merged.length > searchDepth) continue;
    const mergedText = joinMoves(merged);
    if (!best || merged.length < best.length || (merged.length === best.length && mergedText < bestText)) {
      best = merged;
      bestText = mergedText;
    }
  }

  return best;
}

function buildPatternStates(startPattern, moves) {
  const states = new Array(moves.length + 1);
  states[0] = startPattern;
  for (let i = 0; i < moves.length; i++) {
    states[i + 1] = states[i].applyMove(moves[i]);
  }
  return states;
}

function optimizeMovesByInsertions(startPattern, moves, options = {}) {
  let current = simplifyMoves(Array.isArray(moves) ? moves : []);
  if (!current.length) return current;

  const maxPasses = Number.isFinite(options.maxPasses) ? Math.max(1, Math.floor(options.maxPasses)) : 2;
  const minWindow = Number.isFinite(options.minWindow) ? Math.max(2, Math.floor(options.minWindow)) : 3;
  const maxWindow = Number.isFinite(options.maxWindow)
    ? Math.max(minWindow, Math.floor(options.maxWindow))
    : 7;
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, Math.floor(options.maxDepth)) : 5;
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs) ? Math.max(100, Math.floor(options.timeBudgetMs)) : 800;
  const deadlineTs = Date.now() + timeBudgetMs;

  for (let pass = 0; pass < maxPasses; pass++) {
    if (Date.now() >= deadlineTs) break;
    let improved = false;
    const states = buildPatternStates(startPattern, current);
    const windowCap = Math.min(maxWindow, current.length);

    outer: for (let window = windowCap; window >= minWindow; window--) {
      for (let start = 0; start + window <= current.length; start++) {
        if (Date.now() >= deadlineTs) break outer;
        const end = start + window;
        const depthCap = Math.min(maxDepth, window - 1);
        const replacement = findShorterEquivalentSegment(
          states[start],
          states[end],
          depthCap,
          window,
          deadlineTs,
        );
        if (!replacement) continue;
        const next = simplifyMoves(current.slice(0, start).concat(replacement, current.slice(end)));
        if (next.length >= current.length) continue;
        current = next;
        improved = true;
        break outer;
      }
    }

    if (!improved) break;
  }

  return current;
}

function getF2LPairProgress(data, ctx) {
  if (!ctx?.f2lPairDefs || !ctx.f2lPairDefs.length) {
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
  let solvedPairs = 0;
  for (let i = 0; i < ctx.f2lPairDefs.length; i++) {
    const def = ctx.f2lPairDefs[i];
    const cPos = def.cornerTargetPos;
    const ePos = def.edgeTargetPos;
    const cornerSolved =
      data.CORNERS.pieces[cPos] === def.cornerPieceId &&
      (data.CORNERS.orientation[cPos] % 3) === def.cornerTargetOri;
    if (!cornerSolved) continue;
    const edgeSolved =
      data.EDGES.pieces[ePos] === def.edgePieceId &&
      (data.EDGES.orientation[ePos] & 1) === def.edgeTargetOri;
    if (edgeSolved) solvedPairs += 1;
  }
  return solvedPairs;
}

function getSolvedF2LPairMask(data, ctx) {
  if (!ctx?.f2lPairDefs || !ctx.f2lPairDefs.length) return 0;
  let solvedMask = 0;
  const maxPairs = Math.min(31, ctx.f2lPairDefs.length);
  for (let i = 0; i < maxPairs; i++) {
    const def = ctx.f2lPairDefs[i];
    const cPos = def.cornerTargetPos;
    const ePos = def.edgeTargetPos;
    const cornerSolved =
      data.CORNERS.pieces[cPos] === def.cornerPieceId &&
      (data.CORNERS.orientation[cPos] % 3) === def.cornerTargetOri;
    if (!cornerSolved) continue;
    const edgeSolved =
      data.EDGES.pieces[ePos] === def.edgePieceId &&
      (data.EDGES.orientation[ePos] & 1) === def.edgeTargetOri;
    if (edgeSolved) solvedMask |= 1 << i;
  }
  return solvedMask;
}

function popcount32(value) {
  let n = value >>> 0;
  let count = 0;
  while (n) {
    n &= n - 1;
    count += 1;
  }
  return count;
}

function getRouxBlockDefs(ctx) {
  if (Array.isArray(ctx?.rouxBlockDefs) && ctx.rouxBlockDefs.length) {
    return ctx.rouxBlockDefs;
  }
  const pairCount = Math.min(4, Array.isArray(ctx?.f2lPairDefs) ? ctx.f2lPairDefs.length : 0);
  if (pairCount < 2) return [];
  const fallbackMasks = pairCount >= 4 ? [0b0011, 0b1100] : [(1 << pairCount) - 1];
  return fallbackMasks.map((pairMask) => ({
    pairMask,
    bottomEdgePos: -1,
    bottomEdgePieceId: -1,
    bottomEdgeTargetOri: 0,
  }));
}

function getRouxBlockPairMasks(ctx) {
  const blockDefs = getRouxBlockDefs(ctx);
  return blockDefs.map((def) => def.pairMask).filter((mask) => Number.isFinite(mask) && mask > 0);
}

function isRouxBlockBottomEdgeSolved(data, blockDef) {
  const pos = Number.isFinite(blockDef?.bottomEdgePos) ? Math.floor(blockDef.bottomEdgePos) : -1;
  if (pos < 0) return true;
  if (!data?.EDGES?.pieces || !data?.EDGES?.orientation || pos >= data.EDGES.pieces.length) return true;
  const targetPieceId = Number.isFinite(blockDef.bottomEdgePieceId)
    ? Math.floor(blockDef.bottomEdgePieceId)
    : -1;
  const targetOri = Number.isFinite(blockDef.bottomEdgeTargetOri)
    ? Math.floor(blockDef.bottomEdgeTargetOri) & 1
    : 0;
  return data.EDGES.pieces[pos] === targetPieceId && (data.EDGES.orientation[pos] & 1) === targetOri;
}

function getRouxFbTargetUnits(ctx, targetPairs) {
  const target = Math.max(1, Math.floor(targetPairs || 0));
  return target;
}

function getRouxBestBlockSolvedMetrics(data, ctx) {
  const blockDefs = getRouxBlockDefs(ctx);
  if (!blockDefs.length) {
    return {
      solvedPairMask: 0,
      bestMask: 0,
      bestSolvedPairs: 0,
      bestBottomSolved: false,
      bestSolvedUnits: 0,
    };
  }
  const solvedPairMask = getSolvedF2LPairMask(data, ctx);
  let bestMask = 0;
  let bestSolvedPairs = 0;
  let bestBottomSolved = false;
  let bestSolvedUnits = 0;
  for (let i = 0; i < blockDefs.length; i++) {
    const def = blockDefs[i];
    const mask = Number.isFinite(def?.pairMask) ? Math.floor(def.pairMask) : 0;
    if (mask <= 0) continue;
    const solvedPairs = popcount32(solvedPairMask & mask);
    const bottomSolved = isRouxBlockBottomEdgeSolved(data, def);
    const solvedUnits = solvedPairs + (bottomSolved ? 1 : 0);
    if (
      solvedUnits > bestSolvedUnits ||
      (solvedUnits === bestSolvedUnits && solvedPairs > bestSolvedPairs) ||
      (solvedUnits === bestSolvedUnits && solvedPairs === bestSolvedPairs && mask > bestMask)
    ) {
      bestMask = mask;
      bestSolvedPairs = solvedPairs;
      bestBottomSolved = bottomSolved;
      bestSolvedUnits = solvedUnits;
    }
  }
  return {
    solvedPairMask,
    bestMask,
    bestSolvedPairs,
    bestBottomSolved,
    bestSolvedUnits,
  };
}

function getRouxFbPairDeficit(data, ctx, targetPairs) {
  const targetUnits = getRouxFbTargetUnits(ctx, targetPairs);
  const { bestSolvedUnits } = getRouxBestBlockSolvedMetrics(data, ctx);
  return Math.max(0, targetUnits - bestSolvedUnits);
}

function getRouxFbBlockLowerBound(data, ctx, targetPairs = 2) {
  const deficitBound = getRouxFbPairDeficit(data, ctx, targetPairs);
  const blockDefs = getRouxBlockDefs(ctx);
  if (!blockDefs.length || !Array.isArray(ctx?.f2lPairDefs) || !ctx.f2lPairDefs.length) {
    return deficitBound;
  }

  const target = Math.max(1, Math.floor(targetPairs || 0));
  const cacheKey = `${target}:${getF2LStateKey(data, ctx)}`;
  const cache = ctx.rouxFbLowerBoundCache || (ctx.rouxFbLowerBoundCache = new Map());
  const cached = cache.get(cacheKey);
  if (typeof cached === "number") return cached;

  const maxPairCount = Math.min(31, ctx.f2lPairDefs.length);
  const cornerPosByPiece = ctx.f2lCornerPosScratch || (ctx.f2lCornerPosScratch = new Int8Array(8));
  const edgePosByPiece = ctx.f2lEdgePosScratch || (ctx.f2lEdgePosScratch = new Int8Array(12));
  for (let pos = 0; pos < 8; pos++) {
    cornerPosByPiece[data.CORNERS.pieces[pos]] = pos;
  }
  for (let pos = 0; pos < 12; pos++) {
    edgePosByPiece[data.EDGES.pieces[pos]] = pos;
  }

  let pairDistByIndex = ctx.rouxFbPairDistScratch;
  if (!(pairDistByIndex instanceof Int16Array) || pairDistByIndex.length < maxPairCount) {
    pairDistByIndex = new Int16Array(Math.max(8, maxPairCount));
    ctx.rouxFbPairDistScratch = pairDistByIndex;
  }
  pairDistByIndex.fill(-1, 0, maxPairCount);
  for (let i = 0; i < maxPairCount; i++) {
    const pairDef = ctx.f2lPairDefs[i];
    if (!pairDef) continue;
    const cornerPos = cornerPosByPiece[pairDef.cornerPieceId];
    const edgePos = edgePosByPiece[pairDef.edgePieceId];
    if (cornerPos < 0 || edgePos < 0) continue;
    const cornerOri = data.CORNERS.orientation[cornerPos] % 3;
    const edgeOri = data.EDGES.orientation[edgePos] & 1;
    const state = encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri);
    const pruneTable = pairDef.pruneTableAll || pairDef.pruneTable;
    if (!pruneTable) continue;
    const dist = pruneTable[state];
    if (Number.isFinite(dist) && dist >= 0) pairDistByIndex[i] = dist;
  }

  let bestBlockBound = Infinity;
  for (let b = 0; b < blockDefs.length; b++) {
    const blockDef = blockDefs[b];
    const mask = Number.isFinite(blockDef?.pairMask) ? Math.floor(blockDef.pairMask) : 0;
    if (mask <= 0) continue;
    let pairBound = 0;
    for (let i = 0; i < maxPairCount; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const dist = pairDistByIndex[i];
      if (dist > pairBound) pairBound = dist;
    }
    const edgeNeed = isRouxBlockBottomEdgeSolved(data, blockDef)
      ? 0
      : Number.isFinite(blockDef?.bottomEdgePos) && Math.floor(blockDef.bottomEdgePos) >= 0
        ? 1
        : 0;
    const blockBound = Math.max(pairBound, edgeNeed);
    if (blockBound < bestBlockBound) bestBlockBound = blockBound;
  }
  if (!Number.isFinite(bestBlockBound)) bestBlockBound = 0;
  const lowerBound = Math.max(deficitBound, bestBlockBound);
  if (cache.size > HEURISTIC_CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, lowerBound);
  return lowerBound;
}

function getRouxPrimaryBlockMask(data, ctx, targetPairs = 2) {
  const targetUnits = getRouxFbTargetUnits(ctx, targetPairs);
  const { bestMask, bestSolvedUnits } = getRouxBestBlockSolvedMetrics(data, ctx);
  if (!bestMask || bestSolvedUnits < targetUnits) return 0;
  return bestMask;
}

function isRouxFbBlockSolved(data, ctx, targetPairs) {
  return getRouxFbPairDeficit(data, ctx, targetPairs) === 0;
}

function getRouxBlockDefByMask(ctx, pairMask) {
  const targetMask = Number.isFinite(pairMask) ? Math.floor(pairMask) : 0;
  if (targetMask <= 0) return null;
  const blockDefs = getRouxBlockDefs(ctx);
  for (let i = 0; i < blockDefs.length; i++) {
    const def = blockDefs[i];
    if (Math.floor(def?.pairMask || 0) === targetMask) return def;
  }
  return null;
}

function getRouxBlockTargetUnitCount(blockDef) {
  const pairMask = Number.isFinite(blockDef?.pairMask) ? Math.floor(blockDef.pairMask) : 0;
  if (pairMask <= 0) return 0;
  let units = popcount32(pairMask);
  if (Number.isFinite(blockDef?.bottomEdgePos) && Math.floor(blockDef.bottomEdgePos) >= 0) {
    units += 1;
  }
  return units;
}

function getRouxBlockSolvedUnitCount(data, blockDef, solvedPairMask) {
  const pairMask = Number.isFinite(blockDef?.pairMask) ? Math.floor(blockDef.pairMask) : 0;
  if (pairMask <= 0) return 0;
  const solvedPairs = popcount32((solvedPairMask >>> 0) & pairMask);
  const bottomSolved = isRouxBlockBottomEdgeSolved(data, blockDef) ? 1 : 0;
  return solvedPairs + bottomSolved;
}

function getRouxBlockDeficitUnitCount(data, blockDef, solvedPairMask) {
  const targetUnits = getRouxBlockTargetUnitCount(blockDef);
  const solvedUnits = getRouxBlockSolvedUnitCount(data, blockDef, solvedPairMask);
  return Math.max(0, targetUnits - solvedUnits);
}

function isRouxF2BSolved(data, ctx) {
  const blockDefs = getRouxBlockDefs(ctx);
  if (!blockDefs.length) return getF2LPairProgress(data, ctx) >= 4;
  const solvedPairMask = getSolvedF2LPairMask(data, ctx);
  for (let i = 0; i < blockDefs.length; i++) {
    if (getRouxBlockDeficitUnitCount(data, blockDefs[i], solvedPairMask) > 0) {
      return false;
    }
  }
  return true;
}

function getRouxSbObjectiveMetrics(data, ctx, lockedPairMask = 0) {
  const blockDefs = getRouxBlockDefs(ctx);
  const solvedPairMask = getSolvedF2LPairMask(data, ctx);
  if (!blockDefs.length) {
    const pairNeed = getF2LPairDeficit(data, ctx, 4);
    return {
      solvedPairMask,
      primaryMask: 0,
      secondaryMask: 0,
      primaryDeficit: pairNeed,
      secondaryDeficit: pairNeed,
      secondaryBottomNeed: 0,
      totalDeficit: pairNeed,
    };
  }

  const normalizedLockedMask = Number.isFinite(lockedPairMask) ? Math.floor(lockedPairMask) : 0;
  let primaryDef = null;
  if (normalizedLockedMask > 0) {
    for (let i = 0; i < blockDefs.length; i++) {
      const defMask = Math.floor(blockDefs[i]?.pairMask || 0);
      if (!defMask) continue;
      if ((defMask & normalizedLockedMask) === normalizedLockedMask || defMask === normalizedLockedMask) {
        primaryDef = blockDefs[i];
        break;
      }
    }
  }
  if (!primaryDef) {
    let bestUnits = -1;
    for (let i = 0; i < blockDefs.length; i++) {
      const solvedUnits = getRouxBlockSolvedUnitCount(data, blockDefs[i], solvedPairMask);
      if (solvedUnits > bestUnits) {
        bestUnits = solvedUnits;
        primaryDef = blockDefs[i];
      }
    }
  }

  let secondaryDef = null;
  for (let i = 0; i < blockDefs.length; i++) {
    if (blockDefs[i] !== primaryDef) {
      secondaryDef = blockDefs[i];
      break;
    }
  }

  const primaryMask = Math.floor(primaryDef?.pairMask || 0);
  const secondaryMask = Math.floor(secondaryDef?.pairMask || 0);
  const primaryDeficit = getRouxBlockDeficitUnitCount(data, primaryDef, solvedPairMask);
  const secondaryDeficit = secondaryDef
    ? getRouxBlockDeficitUnitCount(data, secondaryDef, solvedPairMask)
    : 0;
  const secondaryBottomNeed =
    secondaryDef &&
    Number.isFinite(secondaryDef?.bottomEdgePos) &&
    Math.floor(secondaryDef.bottomEdgePos) >= 0 &&
    !isRouxBlockBottomEdgeSolved(data, secondaryDef)
      ? 1
      : 0;

  let totalDeficit = 0;
  for (let i = 0; i < blockDefs.length; i++) {
    totalDeficit += getRouxBlockDeficitUnitCount(data, blockDefs[i], solvedPairMask);
  }

  return {
    solvedPairMask,
    primaryMask,
    secondaryMask,
    primaryDeficit,
    secondaryDeficit,
    secondaryBottomNeed,
    totalDeficit,
  };
}

function getRouxPairMaskLowerBound(data, ctx, pairMask, useNoDPrune = true) {
  const normalizedMask = Number.isFinite(pairMask) ? Math.floor(pairMask) : 0;
  if (normalizedMask <= 0 || !Array.isArray(ctx?.f2lPairDefs) || !ctx.f2lPairDefs.length) return 0;

  const cacheKey = `${useNoDPrune ? 1 : 0}:${normalizedMask}:${getF2LStateKey(data, ctx)}`;
  const cache = ctx.rouxPairMaskLowerBoundCache || (ctx.rouxPairMaskLowerBoundCache = new Map());
  const cached = cache.get(cacheKey);
  if (typeof cached === "number") return cached;

  const cornerPosByPiece = ctx.f2lCornerPosScratch || (ctx.f2lCornerPosScratch = new Int8Array(8));
  const edgePosByPiece = ctx.f2lEdgePosScratch || (ctx.f2lEdgePosScratch = new Int8Array(12));
  for (let pos = 0; pos < 8; pos++) {
    cornerPosByPiece[data.CORNERS.pieces[pos]] = pos;
  }
  for (let pos = 0; pos < 12; pos++) {
    edgePosByPiece[data.EDGES.pieces[pos]] = pos;
  }

  let lowerBound = 0;
  const maxPairCount = Math.min(31, ctx.f2lPairDefs.length);
  for (let i = 0; i < maxPairCount; i++) {
    if ((normalizedMask & (1 << i)) === 0) continue;
    const pairDef = ctx.f2lPairDefs[i];
    if (!pairDef) continue;
    const cornerPos = cornerPosByPiece[pairDef.cornerPieceId];
    const edgePos = edgePosByPiece[pairDef.edgePieceId];
    if (cornerPos < 0 || edgePos < 0) continue;
    const cornerOri = data.CORNERS.orientation[cornerPos] % 3;
    const edgeOri = data.EDGES.orientation[edgePos] & 1;
    const state = encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri);
    const pruneTable = useNoDPrune
      ? pairDef.pruneTableNoD || pairDef.pruneTableAll || pairDef.pruneTable
      : pairDef.pruneTableAll || pairDef.pruneTable;
    if (!pruneTable) continue;
    const dist = pruneTable[state];
    if (Number.isFinite(dist) && dist > lowerBound) lowerBound = dist;
  }

  if (cache.size > HEURISTIC_CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, lowerBound);
  return lowerBound;
}

function getRouxSbF2bLowerBound(data, ctx, lockedPairMask = 0) {
  const metrics = getRouxSbObjectiveMetrics(data, ctx, lockedPairMask);
  if (metrics.totalDeficit <= 0) return 0;

  let lowerBound = 0;
  const coupledBound = getRouxSbBlockTableLowerBound(data, ctx);
  if (coupledBound > lowerBound) lowerBound = coupledBound;

  const secondaryPairBound = getRouxPairMaskLowerBound(data, ctx, metrics.secondaryMask, true);
  if (secondaryPairBound > lowerBound) lowerBound = secondaryPairBound;
  if (metrics.secondaryBottomNeed > lowerBound) lowerBound = metrics.secondaryBottomNeed;

  if (metrics.primaryDeficit > 0) {
    const primaryPairBound = getRouxPairMaskLowerBound(data, ctx, metrics.primaryMask, true);
    if (primaryPairBound > lowerBound) lowerBound = primaryPairBound;
  }

  if (lowerBound <= 0) lowerBound = 1;
  return lowerBound;
}

function getRouxSbStateKey(data, ctx, lockedPairMask = 0) {
  const normalizedLockedMask = Number.isFinite(lockedPairMask) ? Math.floor(lockedPairMask) : 0;
  return `SB2:${normalizedLockedMask}:${getF2LStateKey(data, ctx)}`;
}

function getRouxSbMovePriorityByMoveIndex(ctx) {
  if (ctx.rouxSbMovePriorityByMoveIndex instanceof Int8Array) {
    return ctx.rouxSbMovePriorityByMoveIndex;
  }
  const priority = new Int8Array(MOVE_NAMES.length);
  priority.fill(6);
  for (let i = 0; i < MOVE_NAMES.length; i++) {
    const token = MOVE_NAMES[i];
    const face = token.charAt(0);
    let rank = 4;
    if (face === "R" || face === "L" || face === "M") rank = 0;
    else if (face === "U") rank = 1;
    else if (face === "F" || face === "B") rank = 2;
    else if (face === "D") rank = 5;
    if (token.endsWith("2")) rank += 1;
    priority[i] = rank;
  }
  ctx.rouxSbMovePriorityByMoveIndex = priority;
  return priority;
}

function getInverseMoveIndexByMoveIndex(ctx) {
  if (ctx.inverseMoveIndexByMoveIndex instanceof Int16Array) {
    return ctx.inverseMoveIndexByMoveIndex;
  }
  const tokenToIndex = new Map();
  for (let i = 0; i < MOVE_NAMES.length; i++) {
    tokenToIndex.set(MOVE_NAMES[i], i);
  }
  const inverse = new Int16Array(MOVE_NAMES.length);
  for (let i = 0; i < MOVE_NAMES.length; i++) {
    const invToken = invertToken(MOVE_NAMES[i]);
    const invIndex = tokenToIndex.get(invToken);
    inverse[i] = Number.isFinite(invIndex) ? invIndex : i;
  }
  ctx.inverseMoveIndexByMoveIndex = inverse;
  return inverse;
}

function getRouxSbGoalMacroTable(ctx, moveIndices, maxDepth, nodeLimit) {
  if (!Array.isArray(moveIndices) || !moveIndices.length) return new Map();
  const normalizedDepth = Math.max(1, Math.min(10, normalizeDepth(maxDepth, 6)));
  const normalizedNodeLimit = Math.max(1000, normalizeDepth(nodeLimit, 220000));
  const signature = `${moveIndices.join(",")}|${normalizedDepth}|${normalizedNodeLimit}`;
  if (!(ctx.rouxSbGoalMacroTableCache instanceof Map)) {
    ctx.rouxSbGoalMacroTableCache = new Map();
  }
  const cache = ctx.rouxSbGoalMacroTableCache;
  const cached = cache.get(signature);
  if (cached instanceof Map) return cached;

  const inverseMoveIndexByMoveIndex = getInverseMoveIndexByMoveIndex(ctx);
  const table = new Map();
  const bestDepthByKey = new Map();
  const queue = [];
  const solvedKey = getF2LStateKey(ctx.solvedData, ctx);
  bestDepthByKey.set(solvedKey, 0);
  table.set(solvedKey, []);
  queue.push({
    pattern: ctx.solvedPattern,
    depth: 0,
    lastFace: NO_FACE_INDEX,
    tailMoves: [],
  });

  let head = 0;
  let expanded = 0;
  while (head < queue.length && expanded < normalizedNodeLimit) {
    const item = queue[head++];
    if (item.depth >= normalizedDepth) continue;

    for (let i = 0; i < moveIndices.length; i++) {
      if (expanded >= normalizedNodeLimit) break;
      const moveIndex = moveIndices[i];
      const face = ctx.moveFace[moveIndex];
      if (item.lastFace !== NO_FACE_INDEX) {
        if (face === item.lastFace) continue;
        if (face === OPPOSITE_FACE[item.lastFace] && face < item.lastFace) continue;
      }
      expanded += 1;

      const nextPattern = item.pattern.applyMove(MOVE_NAMES[moveIndex]);
      const nextData = nextPattern.patternData;
      const nextDepth = item.depth + 1;
      const key = getF2LStateKey(nextData, ctx);
      const prevDepth = bestDepthByKey.get(key);
      if (Number.isFinite(prevDepth) && prevDepth <= nextDepth) {
        continue;
      }
      const invMove = inverseMoveIndexByMoveIndex[moveIndex];
      const tailMoves = [invMove].concat(item.tailMoves);
      bestDepthByKey.set(key, nextDepth);
      table.set(key, tailMoves);
      queue.push({
        pattern: nextPattern,
        depth: nextDepth,
        lastFace: face,
        tailMoves,
      });
    }
  }

  cache.set(signature, table);
  if (cache.size > 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return table;
}

function getGoalMacroTableByMoveEntries(
  ctx,
  solvedPattern,
  moveEntries,
  keyFn,
  maxDepth,
  nodeLimit,
  cacheProp = "goalMacroTableCache",
) {
  if (
    !solvedPattern ||
    typeof keyFn !== "function" ||
    !Array.isArray(moveEntries) ||
    !moveEntries.length
  ) {
    return new Map();
  }
  const normalizedDepth = Math.max(1, Math.min(12, normalizeDepth(maxDepth, 8)));
  const normalizedNodeLimit = Math.max(1000, normalizeDepth(nodeLimit, 320000));
  const moveSignature = moveEntries.map((entry) => entry.move).join("|");
  const signature = `${moveSignature}|${normalizedDepth}|${normalizedNodeLimit}`;
  if (!(ctx[cacheProp] instanceof Map)) {
    ctx[cacheProp] = new Map();
  }
  const cache = ctx[cacheProp];
  const cached = cache.get(signature);
  if (cached instanceof Map) return cached;

  const allowedMoves = new Set(moveEntries.map((entry) => entry.move));
  const usableEntries = [];
  for (let i = 0; i < moveEntries.length; i++) {
    const entry = moveEntries[i];
    const invMove = invertToken(entry.move);
    if (!allowedMoves.has(invMove)) continue;
    usableEntries.push({
      move: entry.move,
      inverse: invMove,
      face: entry.face,
      axis: entry.axis,
    });
  }
  if (!usableEntries.length) {
    const empty = new Map();
    cache.set(signature, empty);
    return empty;
  }

  const table = new Map();
  const bestDepthByKey = new Map();
  const queue = [];
  const solvedKey = keyFn(solvedPattern.patternData);
  bestDepthByKey.set(solvedKey, 0);
  table.set(solvedKey, []);
  queue.push({
    pattern: solvedPattern,
    depth: 0,
    lastFace: "",
    lastAxis: "",
    tailMoves: [],
  });

  let head = 0;
  let expanded = 0;
  while (head < queue.length && expanded < normalizedNodeLimit) {
    const item = queue[head++];
    if (item.depth >= normalizedDepth) continue;

    for (let i = 0; i < usableEntries.length; i++) {
      if (expanded >= normalizedNodeLimit) break;
      const entry = usableEntries[i];
      if (entry.face === item.lastFace) continue;
      if (item.lastAxis && entry.axis === item.lastAxis && entry.face < item.lastFace) continue;
      expanded += 1;

      let nextPattern = null;
      try {
        nextPattern = item.pattern.applyMove(entry.move);
      } catch (_) {
        continue;
      }
      const nextDepth = item.depth + 1;
      const nextKey = keyFn(nextPattern.patternData);
      const prevDepth = bestDepthByKey.get(nextKey);
      if (Number.isFinite(prevDepth) && prevDepth <= nextDepth) continue;
      const tailMoves = [entry.inverse].concat(item.tailMoves);
      bestDepthByKey.set(nextKey, nextDepth);
      table.set(nextKey, tailMoves);
      queue.push({
        pattern: nextPattern,
        depth: nextDepth,
        lastFace: entry.face,
        lastAxis: entry.axis,
        tailMoves,
      });
    }
  }

  cache.set(signature, table);
  if (cache.size > 10) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return table;
}

function estimateRouxSbDifficulty(data, ctx, lockedPairMask = 0) {
  const metrics = getRouxSbObjectiveMetrics(data, ctx, lockedPairMask);
  const lb = getRouxSbF2bLowerBound(data, ctx, lockedPairMask);
  const coupled = getRouxSbBlockTableLowerBound(data, ctx);
  return lb * 100 + coupled * 30 + metrics.secondaryDeficit * 12 + metrics.primaryDeficit * 8 + metrics.totalDeficit;
}

function getF2LPairStateForDef(data, pairDef) {
  if (!pairDef) return -1;
  let cornerPos = -1;
  let edgePos = -1;
  for (let pos = 0; pos < 8; pos++) {
    if (data.CORNERS.pieces[pos] === pairDef.cornerPieceId) {
      cornerPos = pos;
      break;
    }
  }
  for (let pos = 0; pos < 12; pos++) {
    if (data.EDGES.pieces[pos] === pairDef.edgePieceId) {
      edgePos = pos;
      break;
    }
  }
  if (cornerPos < 0 || edgePos < 0) return -1;
  const cornerOri = data.CORNERS.orientation[cornerPos] % 3;
  const edgeOri = data.EDGES.orientation[edgePos] & 1;
  return encodeF2LPairState(cornerPos, cornerOri, edgePos, edgeOri);
}

function getF2LPairDistanceForDef(data, pairDef) {
  if (!pairDef || !pairDef.pruneTable) return -1;
  const state = getF2LPairStateForDef(data, pairDef);
  if (state < 0) return -1;
  return pairDef.pruneTable[state];
}

function getF2LPairDeficit(data, ctx, targetPairs) {
  return Math.max(0, targetPairs - getF2LPairProgress(data, ctx));
}

function isCrossWithF2LPairTarget(data, ctx, targetPairs) {
  if (!isCrossSolved(data, ctx)) return false;
  return getF2LPairProgress(data, ctx) >= targetPairs;
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

function getCrossLikeStageLabel(stageName, crossStageLabel) {
  if (String(stageName || "").startsWith("XCross")) {
    return crossStageLabel.startsWith("Cross")
      ? `X${crossStageLabel}`
      : `XCross (${crossStageLabel})`;
  }
  return crossStageLabel;
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
  const normalized = String(mode || "strict").toLowerCase();
  if (normalized === "roux") return "roux";
  if (normalized === "zz") return "zb";
  if (normalized === "zb") return "zb";
  return "strict";
}

function normalizeF2LMethod(method) {
  const normalized = String(method || "legacy").trim().toLowerCase();
  if (normalized === "search") {
    return "search";
  }
  if (
    normalized === "fast" ||
    normalized === "hybrid" ||
    normalized === "free" ||
    normalized === "nodb" ||
    normalized === "no-db"
  ) {
    return "hybrid";
  }
  return "legacy";
}

function getCfopProfile(mode) {
  if (mode === "roux") return ROUX_PROFILE;
  return STRICT_CFOP_PROFILE;
}

function isStrictSolvedPattern(pattern, data, ctx) {
  let strictSolved = false;
  if (pattern && typeof pattern.experimentalIsSolved === "function") {
    try {
      strictSolved = !!pattern.experimentalIsSolved({ ignorePuzzleOrientation: false });
    } catch (_) {
      strictSolved = false;
    }
  }
  if (strictSolved) return true;
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
  if (typeof progress.stageName === "string") {
    if (progress.stageName.startsWith("Cross")) {
      return {
        ...progress,
        stageName: crossStageLabel,
      };
    }
    if (progress.stageName.startsWith("XCross")) {
      return {
        ...progress,
        stageName: getCrossLikeStageLabel("XCross", crossStageLabel),
      };
    }
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

function normalizeNonNegativeDepth(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intN = Math.floor(n);
  return intN >= 0 ? intN : fallback;
}

function normalizeDeadlineTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return n;
}

function isDeadlineExceeded(deadlineTs) {
  return Number.isFinite(deadlineTs) && Date.now() >= deadlineTs;
}

function maybePostOptimizeMoves(startPattern, moves, solveMode, options, ctx) {
  const enabledByMode = solveMode === "roux";
  const enabled =
    options?.enablePostInsertionOptimization === true ||
    (enabledByMode && options?.enablePostInsertionOptimization !== false);
  if (!enabled) return simplifyMoves(moves);

  const input = simplifyMoves(moves);
  if (input.length < 10) return input;

  const optimized = optimizeMovesByInsertions(startPattern, input, {
    maxPasses: normalizeDepth(options?.postInsertionMaxPasses, enabledByMode ? 2 : 1),
    minWindow: normalizeDepth(options?.postInsertionMinWindow, 3),
    maxWindow: normalizeDepth(options?.postInsertionMaxWindow, enabledByMode ? 7 : 6),
    maxDepth: normalizeDepth(options?.postInsertionMaxDepth, enabledByMode ? 5 : 4),
    timeBudgetMs: normalizeDepth(options?.postInsertionTimeMs, enabledByMode ? 550 : 500),
  });
  if (optimized.length >= input.length) return input;
  const maybeSolvedPattern = tryApplyMoves(startPattern, optimized);
  if (!maybeSolvedPattern) return input;
  if (!isStrictSolvedPattern(maybeSolvedPattern, maybeSolvedPattern.patternData, ctx)) return input;
  return optimized;
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
    const quarterMoveIndexByFace = new Int8Array(NO_FACE_INDEX);
    quarterMoveIndexByFace.fill(-1);
    for (let i = 0; i < MOVE_NAMES.length; i++) {
      if (MOVE_NAMES[i].length === 1) {
        quarterMoveIndexByFace[moveFace[i]] = i;
      }
    }
    const edgeMoveTables = buildEdgeMoveTables(solvedPattern, solvedData);
    const cornerMoveTables = buildCornerMoveTables(solvedPattern, solvedData);
    const f2lPairStateTransitionByMove = buildF2LPairStateTransitionTables(
      cornerMoveTables,
      edgeMoveTables,
    );
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
      let noDbFaceMask = 1 << FACE_TO_INDEX.U;
      for (let face = 0; face < NO_FACE_INDEX; face++) {
        if (face === FACE_TO_INDEX.U || face === FACE_TO_INDEX.D) continue;
        const quarterMoveIndex = quarterMoveIndexByFace[face];
        if (quarterMoveIndex < 0) continue;
        const cMap = cornerMoveTables[quarterMoveIndex];
        const eMap = edgeMoveTables[quarterMoveIndex];
        const touchesCorner = cMap.cornerPosMap[cornerTargetPos] !== cornerTargetPos;
        const touchesEdge = eMap.edgePosMap[edgeTargetPos] !== edgeTargetPos;
        if (touchesCorner || touchesEdge) {
          noDbFaceMask |= 1 << face;
        }
      }
      const pairNoDbMoveIndices = noDMoveIndices.filter(
        (idx) => (noDbFaceMask & (1 << moveFace[idx])) !== 0,
      );
      const pairBaseDef = {
        cornerTargetPos,
        edgeTargetPos,
        cornerTargetOri: solvedData.CORNERS.orientation[cornerTargetPos] % 3,
        edgeTargetOri: solvedData.EDGES.orientation[edgeTargetPos] & 1,
      };
      const pruneTableNoD = buildF2LPairPruneTable(
        pairBaseDef,
        cornerMoveTables,
        edgeMoveTables,
        noDMoveIndices,
      );
      const pruneTableAll = buildF2LPairPruneTable(
        pairBaseDef,
        cornerMoveTables,
        edgeMoveTables,
        allMoveIndices,
      );
      f2lPairDefs.push({
        cornerTargetPos,
        edgeTargetPos,
        cornerPieceId: solvedData.CORNERS.pieces[cornerTargetPos],
        edgePieceId: solvedData.EDGES.pieces[edgeTargetPos],
        cornerTargetOri: solvedData.CORNERS.orientation[cornerTargetPos] % 3,
        edgeTargetOri: solvedData.EDGES.orientation[edgeTargetPos] & 1,
        noDbMoveIndices: pairNoDbMoveIndices.length ? pairNoDbMoveIndices : noDMoveIndices,
        pruneTableNoD,
        pruneTableAll,
        // Keep old key for existing F2L table metric access paths.
        pruneTable: pruneTableNoD,
      });
    }

    const quarterLIndex = quarterMoveIndexByFace[FACE_TO_INDEX.L];
    const quarterRIndex = quarterMoveIndexByFace[FACE_TO_INDEX.R];
    const quarterLCornerMap = quarterLIndex >= 0 ? cornerMoveTables[quarterLIndex] : null;
    const quarterLEdgeMap = quarterLIndex >= 0 ? edgeMoveTables[quarterLIndex] : null;
    const quarterRCornerMap = quarterRIndex >= 0 ? cornerMoveTables[quarterRIndex] : null;
    const quarterREdgeMap = quarterRIndex >= 0 ? edgeMoveTables[quarterRIndex] : null;
    let rouxLeftBlockPairMask = 0;
    let rouxRightBlockPairMask = 0;
    for (let i = 0; i < f2lPairDefs.length; i++) {
      const pairDef = f2lPairDefs[i];
      if (quarterLCornerMap && quarterLEdgeMap) {
        const touchesLCorner =
          quarterLCornerMap.cornerPosMap[pairDef.cornerTargetPos] !== pairDef.cornerTargetPos;
        const touchesLEdge = quarterLEdgeMap.edgePosMap[pairDef.edgeTargetPos] !== pairDef.edgeTargetPos;
        if (touchesLCorner || touchesLEdge) {
          rouxLeftBlockPairMask |= 1 << i;
        }
      }
      if (quarterRCornerMap && quarterREdgeMap) {
        const touchesRCorner =
          quarterRCornerMap.cornerPosMap[pairDef.cornerTargetPos] !== pairDef.cornerTargetPos;
        const touchesREdge = quarterREdgeMap.edgePosMap[pairDef.edgeTargetPos] !== pairDef.edgeTargetPos;
        if (touchesRCorner || touchesREdge) {
          rouxRightBlockPairMask |= 1 << i;
        }
      }
    }
    const rouxBlockPairMasks = [];
    if (rouxLeftBlockPairMask) rouxBlockPairMasks.push(rouxLeftBlockPairMask);
    if (rouxRightBlockPairMask && rouxRightBlockPairMask !== rouxLeftBlockPairMask) {
      rouxBlockPairMasks.push(rouxRightBlockPairMask);
    }
    const findBottomEdgePosTouchedByMap = (edgeMap) => {
      if (!edgeMap) return -1;
      for (let i = 0; i < bottomEdgePositions.length; i++) {
        const pos = bottomEdgePositions[i];
        if (edgeMap.edgePosMap[pos] !== pos) return pos;
      }
      return -1;
    };
    const leftBottomEdgePos = findBottomEdgePosTouchedByMap(quarterLEdgeMap);
    const rightBottomEdgePos = findBottomEdgePosTouchedByMap(quarterREdgeMap);
    const rouxBlockDefs = [];
    if (rouxLeftBlockPairMask) {
      rouxBlockDefs.push({
        pairMask: rouxLeftBlockPairMask,
        bottomEdgePos: leftBottomEdgePos,
        bottomEdgePieceId: leftBottomEdgePos >= 0 ? solvedData.EDGES.pieces[leftBottomEdgePos] : -1,
        bottomEdgeTargetOri: leftBottomEdgePos >= 0 ? solvedData.EDGES.orientation[leftBottomEdgePos] & 1 : 0,
      });
    }
    if (rouxRightBlockPairMask && rouxRightBlockPairMask !== rouxLeftBlockPairMask) {
      rouxBlockDefs.push({
        pairMask: rouxRightBlockPairMask,
        bottomEdgePos: rightBottomEdgePos,
        bottomEdgePieceId: rightBottomEdgePos >= 0 ? solvedData.EDGES.pieces[rightBottomEdgePos] : -1,
        bottomEdgeTargetOri: rightBottomEdgePos >= 0 ? solvedData.EDGES.orientation[rightBottomEdgePos] & 1 : 0,
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
      f2lPairStateTransitionByMove,
      crossEdgePieceIds,
      crossPieceIndexById,
      f2lPairDefs,
      rouxBlockPairMasks,
      rouxBlockDefs,
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

function isZBLSSolved(data, ctx) {
  if (!isF2LSolved(data, ctx)) return false;
  return orbitMatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.topEdgePositions,
    false,
    true,
  );
}

function isCMLLSolved(data, ctx) {
  return orbitMatches(
    data.CORNERS,
    ctx.solvedData.CORNERS,
    [0, 1, 2, 3, 4, 5, 6, 7],
    true,
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

function getStageDefinitions(options, ctx, profile, solveMode) {
  const useRouxStages = solveMode === "roux";
  // Roux는 LSE가 가장 무거워서, 별도 옵션으로 끄지 않는 한 fast profile을 기본값으로 쓴다.
  const useRouxFastProfile = useRouxStages && options.rouxParallelFastProfile !== false;
  const useZbStages = solveMode === "zb";
  const f2lMethod = normalizeF2LMethod(options?.f2lMethod);
  const useNoDbSearchF2L = solveMode === "strict" && f2lMethod === "search";
  const useHybridF2L = solveMode === "strict" && f2lMethod === "hybrid";
  const crossStageName = useZbStages ? "XCross" : "Cross";
  const crossTargetPairs = useZbStages ? 1 : 0;
  const f2lStageName = useZbStages ? "F2L2" : "F2L";
  const f2lStageDisplayName = useZbStages
    ? "F2L (2 Slots)"
    : useHybridF2L
      ? "F2L (DB Seed + No-DB)"
      : useNoDbSearchF2L
        ? "F2L (No-DB Search)"
        : "F2L";
  const f2lTargetPairs = useZbStages ? 3 : 4;
  const stage3Name = useZbStages ? "ZBLS" : "OLL";
  const stage3FormulaKeys = useZbStages ? ["ZBLS", "OLL"] : ["OLL"];
  const stage4Name = useZbStages ? "ZBLL" : "PLL";
  const stage4FormulaKeys = useZbStages ? ["ZBLL", "PLL"] : ["PLL"];

  function getF2LMismatch(data) {
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
  }

  if (useRouxStages) {
    const fbTargetPairs = 2;
    const sbTargetPairs = 4;
    return [
      {
        name: "FB",
        displayName: "FB",
        maxDepth: normalizeDepth(options.fbMaxDepth, Math.max(profile.crossMaxDepth, 12)),
        searchMaxDepth: normalizeDepth(
          options.fbSearchMaxDepth,
          normalizeDepth(options.fbMaxDepth, Math.max(profile.crossMaxDepth, 12)),
        ),
        nodeLimit: normalizeDepth(options.fbNodeLimit, 850000),
        moveIndices: options.fbNoDMoves === true ? ctx.noDMoveIndices : ctx.allMoveIndices,
        enableMoveOrdering: true,
        moveOrderingMaxDepth: normalizeDepth(options.fbMoveOrderingDepth, 6),
        isSolved(data) {
          return isRouxFbBlockSolved(data, ctx, fbTargetPairs);
        },
        prune(data, depth, currentBound, stageCtx) {
          const remaining = currentBound - depth;
          if (remaining < 0) return true;
          const fbBound = getRouxFbBlockLowerBound(data, stageCtx, fbTargetPairs);
          return fbBound > remaining;
        },
        heuristic(data) {
          return getRouxFbBlockLowerBound(data, ctx, fbTargetPairs);
        },
        mismatch(data) {
          const pairNeed = getRouxFbPairDeficit(data, ctx, fbTargetPairs);
          return {
            pieceMismatch: pairNeed * 2,
            orientationMismatch: 0,
          };
        },
        key(data) {
          return `FB:${getF2LStateKey(data, ctx)}`;
        },
      },
      {
        name: "SB",
        displayName: "SB",
        formulaKeys: ["F2L"],
        skipFormulaDb: false,
        customSearch: solveRouxSbCustomSearch,
        customSearchFallback: "continue",
        maxDepth: normalizeDepth(options.sbMaxDepth, profile.f2lMaxDepth),
        formulaMaxSteps: normalizeDepth(
          options.sbFormulaMaxSteps,
          normalizeDepth(options.f2lFormulaMaxSteps, Math.max(profile.f2lFormulaMaxSteps, 14)),
        ),
        formulaBeamWidth: normalizeDepth(
          options.sbFormulaBeamWidth,
          normalizeDepth(options.f2lFormulaBeamWidth, Math.max(profile.f2lFormulaBeamWidth, 10)),
        ),
        formulaExpansionLimit: normalizeDepth(
          options.sbFormulaExpansionLimit,
          normalizeDepth(
            options.f2lFormulaExpansionLimit,
            Math.max(profile.f2lFormulaExpansionLimit, 16),
          ),
        ),
        formulaMaxAttempts: normalizeDepth(
          options.sbFormulaMaxAttempts,
          normalizeDepth(options.f2lFormulaMaxAttempts, Math.max(profile.f2lFormulaMaxAttempts, 900000)),
        ),
        searchMaxDepth: normalizeDepth(options.sbSearchMaxDepth, 15),
        nodeLimit: normalizeDepth(options.sbNodeLimit, 1400000),
        sbBridgeFallback: options.sbBridgeFallback !== false,
        sbBridgeFrontierLimit: Math.max(8, normalizeDepth(options.sbBridgeFrontierLimit, 24)),
        sbBridgeDepthCap: normalizeDepth(options.sbBridgeDepthCap, 8),
        sbBridgeMinDepth: normalizeDepth(options.sbBridgeMinDepth, 3),
        sbBridgeNodeLimit: normalizeDepth(options.sbBridgeNodeLimit, 1800000),
        sbGoalMacroEnabled: options.sbGoalMacroEnabled !== false,
        sbGoalMacroDepth: normalizeDepth(options.sbGoalMacroDepth, 8),
        sbGoalMacroNodeLimit: normalizeDepth(options.sbGoalMacroNodeLimit, 650000),
        sbGoalMacroMaxTailLength: normalizeDepth(options.sbGoalMacroMaxTailLength, 8),
        moveIndices: ctx.noDMoveIndices,
        movePriorityByIndex: getRouxSbMovePriorityByMoveIndex(ctx),
        isSolved(data) {
          return isRouxF2BSolved(data, ctx) || getF2LPairProgress(data, ctx) >= sbTargetPairs;
        },
        usePairTable: true,
        enableMoveOrdering: true,
        moveOrderingMaxDepth: normalizeDepth(options.sbMoveOrderingDepth, 7),
        prune(data, depth, currentBound, stageCtx) {
          const remaining = currentBound - depth;
          if (remaining < 0) return true;
          const lockedMask =
            Number.isFinite(this.sbLockedPairMask) && this.sbLockedPairMask > 0
              ? Math.floor(this.sbLockedPairMask)
              : 0;
          const lockDepthLimit =
            Number.isFinite(this.sbLockPreserveDepth) && this.sbLockPreserveDepth >= 0
              ? Math.floor(this.sbLockPreserveDepth)
              : 6;
          if (lockedMask && depth <= lockDepthLimit) {
            const solvedMask = getSolvedF2LPairMask(data, stageCtx);
            if ((solvedMask & lockedMask) !== lockedMask) {
              return true;
            }
          }
          const f2bBound = getRouxSbF2bLowerBound(data, stageCtx, lockedMask);
          return f2bBound > remaining;
        },
        heuristic(data) {
          const lockedMask =
            Number.isFinite(this.sbLockedPairMask) && this.sbLockedPairMask > 0
              ? Math.floor(this.sbLockedPairMask)
              : 0;
          return getRouxSbF2bLowerBound(data, ctx, lockedMask);
        },
        mismatch(data) {
          const lockedMask =
            Number.isFinite(this.sbLockedPairMask) && this.sbLockedPairMask > 0
              ? Math.floor(this.sbLockedPairMask)
              : 0;
          const metrics = getRouxSbObjectiveMetrics(data, ctx, lockedMask);
          return {
            pieceMismatch: metrics.totalDeficit * 2,
            orientationMismatch: 0,
          };
        },
        key(data) {
          const lockedMask =
            Number.isFinite(this.sbLockedPairMask) && this.sbLockedPairMask > 0
              ? Math.floor(this.sbLockedPairMask)
              : 0;
          return getRouxSbStateKey(data, ctx, lockedMask);
        },
        buildLegacyFallbackStage() {
          const legacyLockedMask = 0;
          const legacyLockDepth = 0;
          return {
            ...this,
            skipFormulaDb: false,
            customSearch: null,
            customSearchFallback: undefined,
            searchMaxDepth: Math.max(normalizeDepth(this.searchMaxDepth, this.maxDepth), 15),
            nodeLimit: Math.max(normalizeDepth(this.nodeLimit, 0), 1600000),
            formulaMaxAttempts: Math.max(normalizeDepth(this.formulaMaxAttempts, 0), 900000),
            formulaBeamWidth: Math.max(normalizeDepth(this.formulaBeamWidth, 0), 12),
            formulaExpansionLimit: Math.max(normalizeDepth(this.formulaExpansionLimit, 0), 20),
            isSolved(data) {
              return isCrossWithF2LPairTarget(data, ctx, sbTargetPairs);
            },
            prune(data, depth, currentBound, stageCtx) {
              const remaining = currentBound - depth;
              if (remaining < 0) return true;
              if (legacyLockedMask && depth <= legacyLockDepth) {
                const solvedMask = getSolvedF2LPairMask(data, stageCtx);
                if ((solvedMask & legacyLockedMask) !== legacyLockedMask) {
                  return true;
                }
              }
              const pairLowerBound = getF2LPairTableLowerBound(data, stageCtx);
              if (pairLowerBound > remaining) return true;
              const sbBlockBound = getRouxSbBlockTableLowerBound(data, stageCtx);
              if (sbBlockBound > remaining) return true;
              return false;
            },
            heuristic(data) {
              const mismatch = getF2LMismatch(data);
              const mismatchBound = stageHeuristicFromMismatch(
                mismatch.pieceMismatch,
                mismatch.orientationMismatch,
              );
              const pairNeed = getF2LPairDeficit(data, ctx, sbTargetPairs);
              const sbBlockBound = getRouxSbBlockTableLowerBound(data, ctx);
              if (pairNeed === 0) return 0;
              return Math.max(pairNeed, sbBlockBound, Math.min(mismatchBound, pairNeed + 2));
            },
            mismatch(data) {
              const mismatch = getF2LMismatch(data);
              const pairNeed = getF2LPairDeficit(data, ctx, sbTargetPairs);
              return {
                pieceMismatch: mismatch.pieceMismatch + pairNeed,
                orientationMismatch: mismatch.orientationMismatch,
              };
            },
            key(data) {
              return `SB:${getF2LStateKey(data, ctx)}`;
            },
          };
        },
      },
      {
        name: "CMLL",
        displayName: "CMLL",
        formulaKeys: ["CMLL", "OLL", "PLL"],
        formulaPreAufList: FORMULA_AUF,
        formulaPostAufList: [""],
        formulaAttemptLimit: normalizeDepth(options.cmllFormulaAttemptLimit, 130000),
        maxDepth: normalizeDepth(options.cmllMaxDepth, profile.ollMaxDepth),
        searchMaxDepth: normalizeDepth(options.cmllSearchMaxDepth, 13),
        nodeLimit: normalizeDepth(options.cmllNodeLimit, 600000),
        moveIndices: ctx.noDMoveIndices,
        isSolved: isCMLLSolved,
        mismatch(data) {
          const c = countOrbitMismatches(
            data.CORNERS,
            ctx.solvedData.CORNERS,
            [0, 1, 2, 3, 4, 5, 6, 7],
            true,
            true,
          );
          return {
            pieceMismatch: c.pieceMismatch,
            orientationMismatch: c.orientationMismatch,
          };
        },
        key(data) {
          const c = buildKeyForOrbit(data.CORNERS, [0, 1, 2, 3, 4, 5, 6, 7], true, true);
          return `CMLL:C:${c}`;
        },
      },
      {
        name: "LSE",
        displayName: "LSE",
        // 1차는 LSE 전용으로 빠르게 시도하고, PLL 포함은 2차 품질보존 fallback에서 사용한다.
        // LSE DB 커버리지 바깥 케이스를 줄이기 위해 PLL 케이스도 함께 허용한다.
        formulaKeys: ["LSE", "PLL"],
        secondaryLseQualityFallback: options.lsePllFallback !== false,
        secondaryFormulaKeys: ["LSE", "PLL"],
        secondaryFormulaAttemptLimit: normalizeDepth(
          options.lseSecondaryFormulaAttemptLimit,
          useRouxFastProfile
            ? Math.max(normalizeDepth(options.lseFormulaAttemptLimit, 120000), 220000)
            : Math.max(normalizeDepth(options.lseFormulaAttemptLimit, 160000), 260000),
        ),
        secondarySearchMaxDepth: normalizeDepth(
          options.lseSecondarySearchMaxDepth,
          normalizeDepth(options.lseSearchMaxDepth, useRouxFastProfile ? 15 : 16),
        ),
        secondaryNodeLimit: normalizeDepth(
          options.lseSecondaryNodeLimit,
          normalizeDepth(options.lseNodeLimit, useRouxFastProfile ? 2200000 : 2600000),
        ),
        secondaryMoveIndices: ctx.allMoveIndices,
        formulaPreAufList: FORMULA_AUF,
        formulaPostAufList: FORMULA_AUF,
        formulaAttemptLimit: normalizeDepth(
          options.lseFormulaAttemptLimit,
          useRouxFastProfile ? 180000 : 220000,
        ),
        caseLibraryBuildLimit: normalizeDepth(
          options.lseCaseLibraryBuildLimit,
          useRouxFastProfile ? 12000 : 18000,
        ),
        caseLibraryBuildTimeMs: normalizeDepth(
          options.lseCaseLibraryBuildTimeMs,
          useRouxFastProfile ? 1200 : 2200,
        ),
        compositeMaxDepth: normalizeDepth(
          options.lseCompositeMaxDepth,
          Math.max(normalizeDepth(options.lseMaxDepth, profile.pllMaxDepth), useRouxFastProfile ? 32 : 36),
        ),
        bridgeAttemptLimit: normalizeDepth(
          options.lseBridgeAttemptLimit,
          useRouxFastProfile ? 140000 : 200000,
        ),
        bridgeFrontierLimit: normalizeDepth(
          options.lseBridgeFrontierLimit,
          useRouxFastProfile ? 48 : 72,
        ),
        bridgeCandidateLimit: normalizeDepth(
          options.lseBridgeCandidateLimit,
          useRouxFastProfile ? 22000 : 28000,
        ),
        maxDepth: normalizeDepth(options.lseMaxDepth, profile.pllMaxDepth),
        searchMaxDepth: normalizeDepth(options.lseSearchMaxDepth, useRouxFastProfile ? 14 : 15),
        nodeLimit: normalizeDepth(options.lseNodeLimit, useRouxFastProfile ? 1200000 : 1800000),
        lseReducedSearchMaxDepth: normalizeDepth(
          options.lseReducedSearchMaxDepth,
          useRouxFastProfile ? 17 : 18,
        ),
        lseReducedNodeLimit: normalizeDepth(
          options.lseReducedNodeLimit,
          useRouxFastProfile ? 800000 : 1100000,
        ),
        lseReducedExtendedSearchMaxDepth: normalizeDepth(
          options.lseReducedExtendedSearchMaxDepth,
          useRouxFastProfile ? 19 : 20,
        ),
        lseReducedExtendedNodeLimit: normalizeDepth(
          options.lseReducedExtendedNodeLimit,
          useRouxFastProfile ? 1800000 : 2400000,
        ),
        lseReducedGoalMacroEnabled: options.lseReducedGoalMacroEnabled !== false,
        lseReducedGoalMacroDepth: normalizeDepth(
          options.lseReducedGoalMacroDepth,
          useRouxFastProfile ? 9 : 10,
        ),
        lseReducedGoalMacroNodeLimit: normalizeDepth(
          options.lseReducedGoalMacroNodeLimit,
          useRouxFastProfile ? 420000 : 620000,
        ),
        lseReducedGoalMacroMaxTailLength: normalizeDepth(
          options.lseReducedGoalMacroMaxTailLength,
          useRouxFastProfile ? 9 : 10,
        ),
        allowReducedTimeoutFallback: options.lseReducedTimeoutFallback !== false,
        moveIndices: ctx.noDMoveIndices,
        // 기본은 탐색 fallback을 켜서 LSE_NOT_FOUND를 줄인다. false로 명시하면 끈다.
        disableSearchFallback: options.lseSearchFallback === false,
        enableMoveOrdering: true,
        moveOrderingMaxDepth: normalizeDepth(
          options.lseMoveOrderingDepth,
          useRouxFastProfile ? 8 : 10,
        ),
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
          return `LSE:C:${c}|E:${e}`;
        },
      },
    ];
  }

  function getNoDbF2LDefaults(targetPairs) {
    return {
      depth: targetPairs >= 4 ? 20 : targetPairs >= 3 ? 18 : 15,
      nodeLimit: targetPairs >= 4 ? 2400000 : targetPairs >= 3 ? 1800000 : 1200000,
      pairTryLimit: targetPairs >= 4 ? 6 : targetPairs >= 3 ? 5 : 4,
      candidateLimit: targetPairs >= 4 ? 320 : targetPairs >= 3 ? 220 : 140,
      slackDepth: targetPairs >= 4 ? 8 : targetPairs >= 3 ? 6 : 4,
    };
  }

  function buildF2LStage(targetPairs, stageIndex, stageMode = "legacy") {
    const useNoDbMode = stageMode === "nodb" || stageMode === "nodb-hybrid";
    const useHybridNoDbStage = stageMode === "nodb-hybrid";
    const useDbSeedMode = stageMode === "seed";
    const partialTargetPairs = targetPairs < f2lTargetPairs;
    const noDbDefaults = getNoDbF2LDefaults(targetPairs);
    if (useHybridNoDbStage) {
      noDbDefaults.depth = Math.max(12, noDbDefaults.depth - 1);
      noDbDefaults.nodeLimit = Math.max(900000, Math.floor(noDbDefaults.nodeLimit * 0.72));
      noDbDefaults.pairTryLimit = Math.max(2, noDbDefaults.pairTryLimit - 1);
      noDbDefaults.candidateLimit = Math.max(96, Math.floor(noDbDefaults.candidateLimit * 0.72));
      noDbDefaults.slackDepth = Math.max(2, noDbDefaults.slackDepth - 1);
    }
    const noDbPairMetricsCache = useNoDbMode ? new Map() : null;
    function getNoDbPairMetrics(data) {
      if (!useNoDbMode) return null;
      const cacheKey = getF2LStateKey(data, ctx) * 8 + targetPairs;
      const cached = noDbPairMetricsCache.get(cacheKey);
      if (cached) return cached;
      const pairMetrics = getF2LPairTableMetrics(data, ctx);
      const value = {
        solvedPairs: pairMetrics.solvedPairs,
        nearestUnsolved: pairMetrics.nearestUnsolved,
      };
      if (noDbPairMetricsCache.size > FREE_F2L_PAIR_METRICS_CACHE_LIMIT) {
        noDbPairMetricsCache.clear();
      }
      noDbPairMetricsCache.set(cacheKey, value);
      return value;
    }

    const seedDefaultDepth = targetPairs < f2lTargetPairs ? Math.min(profile.f2lMaxDepth, 16) : profile.f2lMaxDepth;
    const seedDefaultSearchDepth = targetPairs < f2lTargetPairs
      ? Math.min(seedDefaultDepth, profile.f2lSearchMaxDepth + 1)
      : profile.f2lSearchMaxDepth;
    const seedDefaultNodeLimit = targetPairs < f2lTargetPairs
      ? Math.min(profile.f2lNodeLimit, 180000)
      : profile.f2lNodeLimit;
    const seedDefaultFormulaAttempts = targetPairs < f2lTargetPairs
      ? Math.min(profile.f2lFormulaMaxAttempts, 70000)
      : profile.f2lFormulaMaxAttempts;
    const seedDefaultFormulaMaxSteps = targetPairs < f2lTargetPairs
      ? Math.min(profile.f2lFormulaMaxSteps, 8)
      : profile.f2lFormulaMaxSteps;
    const seedDefaultBeamWidth = targetPairs < f2lTargetPairs
      ? Math.min(profile.f2lFormulaBeamWidth, 5)
      : profile.f2lFormulaBeamWidth;
    const seedDefaultExpansionLimit = targetPairs < f2lTargetPairs
      ? Math.min(profile.f2lFormulaExpansionLimit, 8)
      : profile.f2lFormulaExpansionLimit;
    const stage = {
      name: useNoDbMode || useDbSeedMode ? "F2L" : f2lStageName,
      displayName: useNoDbMode
        ? `F2L ${stageIndex + 1}/4 (No-DB)`
        : useDbSeedMode
          ? "F2L 1/4 (DB Seed)"
          : f2lStageDisplayName,
      formulaKeys: useNoDbMode ? [] : ["F2L"],
      // Formula-driven F2L commonly exceeds 16 moves; keep a larger cap here.
      maxDepth: normalizeDepth(
        useNoDbMode ? options.f2lPairMaxDepth : useDbSeedMode ? options.f2lSeedMaxDepth : options.f2lMaxDepth,
        useNoDbMode ? noDbDefaults.depth : seedDefaultDepth,
      ),
      formulaMaxSteps: normalizeDepth(options.f2lFormulaMaxSteps, seedDefaultFormulaMaxSteps),
      formulaBeamWidth: normalizeDepth(options.f2lFormulaBeamWidth, seedDefaultBeamWidth),
      formulaExpansionLimit: normalizeDepth(
        options.f2lFormulaExpansionLimit,
        seedDefaultExpansionLimit,
      ),
      formulaMaxAttempts: normalizeDepth(options.f2lFormulaMaxAttempts, seedDefaultFormulaAttempts),
      searchMaxDepth: normalizeDepth(
        useNoDbMode
          ? options.f2lPairSearchMaxDepth
          : useDbSeedMode
            ? options.f2lSeedSearchMaxDepth
            : options.f2lSearchMaxDepth,
        useNoDbMode ? noDbDefaults.depth : seedDefaultSearchDepth,
      ),
      nodeLimit: normalizeDepth(
        useNoDbMode ? options.f2lPairNodeLimit : useDbSeedMode ? options.f2lSeedNodeLimit : options.f2lNodeLimit,
        useNoDbMode ? noDbDefaults.nodeLimit : seedDefaultNodeLimit,
      ),
      // Keep D fixed after cross to reduce branching and match CFOP move habits.
      moveIndices: ctx.noDMoveIndices,
      noDbMode: useNoDbMode,
      noDbTargetPairs: targetPairs,
      noDbPairTryLimit: normalizeDepth(options.f2lPairTryLimit, noDbDefaults.pairTryLimit),
      noDbCandidateLimit: normalizeDepth(options.f2lPairCandidateLimit, noDbDefaults.candidateLimit),
      noDbSlackDepth: normalizeDepth(options.f2lPairSlackDepth, noDbDefaults.slackDepth),
      isSolved(data) {
        if (!isCrossSolved(data, ctx)) return false;
        if (!useNoDbMode) return getF2LPairProgress(data, ctx) >= targetPairs;
        return getNoDbPairMetrics(data).solvedPairs >= targetPairs;
      },
      prune() {
        return false;
      },
      usePairTable: !useZbStages && !useNoDbMode && !partialTargetPairs,
      heuristic(data) {
        const mismatch = getF2LMismatch(data);
        const mismatchBound = stageHeuristicFromMismatch(
          mismatch.pieceMismatch,
          mismatch.orientationMismatch,
        );
        if (useNoDbMode) {
          const pairMetrics = getNoDbPairMetrics(data);
          const pairNeed = Math.max(0, targetPairs - pairMetrics.solvedPairs);
          if (pairNeed === 0) return 0;
          const pairAdvanceBound = pairMetrics.nearestUnsolved > 0 ? pairMetrics.nearestUnsolved : 1;
          const crossBound = getCrossPruneHeuristic(data, ctx);
          const crossNeed = Number.isFinite(crossBound) && crossBound > 0 ? crossBound : 0;
          return Math.max(pairNeed, pairAdvanceBound, Math.min(mismatchBound, pairNeed + 2), crossNeed);
        }
        const pairNeed = getF2LPairDeficit(data, ctx, targetPairs);
        if (useZbStages || partialTargetPairs) {
          if (pairNeed === 0) return 0;
          return Math.max(pairNeed, Math.min(mismatchBound, pairNeed + 2));
        }
        const pairTableBound = getF2LPairTableLowerBound(data, ctx);
        return Math.max(mismatchBound, pairTableBound);
      },
      mismatch(data) {
        const mismatch = getF2LMismatch(data);
        if (!useZbStages && !useNoDbMode && !partialTargetPairs) return mismatch;
        const pairNeed = useNoDbMode
          ? Math.max(0, targetPairs - getNoDbPairMetrics(data).solvedPairs)
          : getF2LPairDeficit(data, ctx, targetPairs);
        return {
          pieceMismatch: mismatch.pieceMismatch + pairNeed,
          orientationMismatch: mismatch.orientationMismatch,
        };
      },
      key(data) {
        if (useNoDbMode) return `F2LFREE:${targetPairs}:${getF2LStateKey(data, ctx)}`;
        if (partialTargetPairs) return `F2LSEED:${targetPairs}:${getF2LStateKey(data, ctx)}`;
        return getF2LStateKey(data, ctx);
      },
    };

    return stage;
  }

  const f2lStagePlan = [];
  if (useHybridF2L) {
    f2lStagePlan.push({ targetPairs: 1, stageMode: "seed" });
    f2lStagePlan.push({ targetPairs: 2, stageMode: "nodb-hybrid" });
    f2lStagePlan.push({ targetPairs: 3, stageMode: "nodb-hybrid" });
    f2lStagePlan.push({ targetPairs: 4, stageMode: "nodb-hybrid" });
  } else if (useNoDbSearchF2L) {
    f2lStagePlan.push({ targetPairs: 1, stageMode: "nodb" });
    f2lStagePlan.push({ targetPairs: 2, stageMode: "nodb" });
    f2lStagePlan.push({ targetPairs: 3, stageMode: "nodb" });
    f2lStagePlan.push({ targetPairs: 4, stageMode: "nodb" });
  } else {
    f2lStagePlan.push({ targetPairs: f2lTargetPairs, stageMode: "legacy" });
  }

  const f2lStages = f2lStagePlan.map((entry, stageIndex) =>
    buildF2LStage(entry.targetPairs, stageIndex, entry.stageMode),
  );

  return [
    {
      name: crossStageName,
      displayName: crossStageName,
      isCrossLike: true,
      maxDepth: normalizeDepth(
        options.crossMaxDepth,
        useZbStages ? profile.crossMaxDepth + 2 : profile.crossMaxDepth,
      ),
      moveIndices: ctx.allMoveIndices,
      isSolved(data) {
        return isCrossWithF2LPairTarget(data, ctx, crossTargetPairs);
      },
      heuristic(data) {
        const crossBound = getCrossPruneHeuristic(data, ctx);
        const pairNeed = getF2LPairDeficit(data, ctx, crossTargetPairs);
        if (Number.isFinite(crossBound) && crossBound >= 0) {
          return Math.max(crossBound, pairNeed);
        }
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.bottomEdgePositions,
          true,
          true,
        );
        const crossFallback = stageHeuristicFromMismatch(e.pieceMismatch, e.orientationMismatch);
        return Math.max(crossFallback, pairNeed);
      },
      mismatch(data) {
        const e = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.bottomEdgePositions,
          true,
          true,
        );
        const pairNeed = getF2LPairDeficit(data, ctx, crossTargetPairs);
        return {
          pieceMismatch: e.pieceMismatch + pairNeed * 2,
          orientationMismatch: e.orientationMismatch,
        };
      },
      key(data) {
        if (crossTargetPairs > 0) {
          return `XF:${getF2LStateKey(data, ctx)}`;
        }
        return `E:${buildKeyForOrbit(data.EDGES, ctx.bottomEdgePositions, true, true)}`;
      },
    },
    ...f2lStages,
    {
      name: stage3Name,
      formulaKeys: stage3FormulaKeys,
      formulaPreAufList: FORMULA_AUF,
      formulaAttemptLimit: normalizeDepth(
        useZbStages ? options.zblsFormulaAttemptLimit : options.ollFormulaAttemptLimit,
        useZbStages ? 180000 : 160000,
      ),
      maxDepth: normalizeDepth(options.ollMaxDepth, profile.ollMaxDepth),
      searchMaxDepth: normalizeDepth(
        useZbStages ? options.zblsSearchMaxDepth : options.ollSearchMaxDepth,
        useZbStages ? 15 : profile.ollMaxDepth,
      ),
      nodeLimit: normalizeDepth(
        useZbStages ? options.zblsNodeLimit : options.ollNodeLimit,
        useZbStages ? 2200000 : 1800000,
      ),
      moveIndices: ctx.noDMoveIndices,
      isSolved: useZbStages ? isZBLSSolved : isOLLSolved,
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
        const ollE = countOrbitMismatches(
          data.EDGES,
          ctx.solvedData.EDGES,
          ctx.topEdgePositions,
          false,
          true,
        );
        if (useZbStages) {
          return {
            pieceMismatch: f2lC.pieceMismatch + f2lE.pieceMismatch,
            orientationMismatch:
              f2lC.orientationMismatch + f2lE.orientationMismatch + ollE.orientationMismatch,
          };
        }
        const ollC = countOrbitMismatches(
          data.CORNERS,
          ctx.solvedData.CORNERS,
          ctx.topCornerPositions,
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
        const ollE = buildKeyForOrbit(data.EDGES, ctx.topEdgePositions, false, true);
        if (useZbStages) {
          return `FC:${f2lC}|FE:${f2lE}|OE:${ollE}`;
        }
        const ollC = buildKeyForOrbit(data.CORNERS, ctx.topCornerPositions, false, true);
        return `FC:${f2lC}|FE:${f2lE}|OC:${ollC}|OE:${ollE}`;
      },
    },
    {
      name: stage4Name,
      formulaKeys: stage4FormulaKeys,
      formulaPreAufList: FORMULA_AUF,
      formulaPostAufList: FORMULA_AUF,
      formulaAttemptLimit: normalizeDepth(
        useZbStages ? options.zbllFormulaAttemptLimit : options.pllFormulaAttemptLimit,
        useZbStages ? 240000 : 220000,
      ),
      maxDepth: normalizeDepth(options.pllMaxDepth, profile.pllMaxDepth),
      searchMaxDepth: normalizeDepth(
        useZbStages ? options.zbllSearchMaxDepth : options.pllSearchMaxDepth,
        useZbStages ? 16 : profile.pllMaxDepth,
      ),
      nodeLimit: normalizeDepth(
        useZbStages ? options.zbllNodeLimit : options.pllNodeLimit,
        useZbStages ? 2600000 : 2600000,
      ),
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

function getFormulaListByKey(key) {
  if (key === "F2L") return SCDB_CFOP_ALGS.F2L || [];
  if (key === "OLL") return SCDB_CFOP_ALGS.OLL || [];
  if (key === "PLL") return SCDB_CFOP_ALGS.PLL || [];
  if (key === "ZBLS") return ZB_FORMULAS.ZBLS || [];
  if (key === "ZBLL") return ZB_FORMULAS.ZBLL || [];
  if (key === "CMLL") return ROUX_FORMULAS.CMLL || [];
  if (key === "LSE") return ROUX_FORMULAS.LSE || [];
  return [];
}

function getFormulaListForStage(stageOrName) {
  const stageName =
    typeof stageOrName === "string" ? stageOrName : stageOrName?.name || "";
  const includeInverseFormulas = stageName === "LSE" || stageName === "CMLL";
  const keys =
    stageOrName && typeof stageOrName === "object" && Array.isArray(stageOrName.formulaKeys)
      ? stageOrName.formulaKeys
      : [stageName];
  const seen = new Set();
  const merged = [];
  for (let i = 0; i < keys.length; i++) {
    const formulas = getFormulaListByKey(keys[i]);
    for (let j = 0; j < formulas.length; j++) {
      const alg = sanitizeFormulaAlg(formulas[j]);
      if (!alg || seen.has(alg)) continue;
      seen.add(alg);
      merged.push(alg);
      if (includeInverseFormulas) {
        const inverseAlg = sanitizeFormulaAlg(invertAlg(alg));
        if (inverseAlg && !seen.has(inverseAlg)) {
          seen.add(inverseAlg);
          merged.push(inverseAlg);
        }
      }
    }
  }
  return merged;
}

function shouldUseSingleStageCaseLibrary(stage, formulas) {
  if (!stage || !Array.isArray(formulas) || !formulas.length) return false;
  // ZBLS/ZBLL case-library generation can stall the UI thread due to very large formula spaces.
  // Keep them on direct formula probing + bounded search path instead.
  if (stage.name === "ZBLS" || stage.name === "ZBLL") return false;
  if (stage.name === "CMLL" || stage.name === "LSE") return true;
  return formulas.length >= 160;
}

function getSingleStageCaseLibraryKey(stage, formulas, preAufList, postAufList) {
  const keySig =
    Array.isArray(stage?.formulaKeys) && stage.formulaKeys.length
      ? stage.formulaKeys.join(",")
      : stage?.name || "";
  return [
    stage?.name || "",
    keySig,
    formulas.length,
    Number.isFinite(stage?.caseLibraryBuildLimit) ? Math.floor(stage.caseLibraryBuildLimit) : 0,
    preAufList.join("|"),
    postAufList.join("|"),
  ].join("::");
}

function getSingleStageFormulaCaseLibrary(
  stage,
  ctx,
  formulas,
  preAufList,
  postAufList,
  deadlineTs = Infinity,
) {
  if (!shouldUseSingleStageCaseLibrary(stage, formulas)) return null;
  const cacheKey = getSingleStageCaseLibraryKey(stage, formulas, preAufList, postAufList);
  const cached = singleStageFormulaCaseLibraryCache.get(cacheKey);
  if (cached) return cached;

  const caseMap = new Map();
  const solved = ctx?.solvedPattern;
  if (!solved) return null;
  if (isDeadlineExceeded(deadlineTs)) return null;
  const buildLimit = Number.isFinite(stage?.caseLibraryBuildLimit)
    ? Math.max(0, Math.floor(stage.caseLibraryBuildLimit))
    : 0;
  const buildTimeBudgetMs = Number.isFinite(stage?.caseLibraryBuildTimeMs)
    ? Math.max(50, Math.floor(stage.caseLibraryBuildTimeMs))
    : 0;
  const nowTs = Date.now();
  const buildDeadlineTs = Number.isFinite(deadlineTs)
    ? buildTimeBudgetMs > 0
      ? Math.min(deadlineTs, nowTs + buildTimeBudgetMs)
      : deadlineTs
    : buildTimeBudgetMs > 0
      ? nowTs + buildTimeBudgetMs
      : Infinity;

  let buildSteps = 0;
  const seenCandidate = new Set();

  caseBuildLoop:
  for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
    const rot = FORMULA_ROTATIONS[r];
    for (let a = 0; a < preAufList.length; a++) {
      const preAuf = preAufList[a];
      for (let i = 0; i < formulas.length; i++) {
        const alg = formulas[i];
        for (let p = 0; p < postAufList.length; p++) {
          buildSteps += 1;
          if (buildLimit > 0 && buildSteps > buildLimit) {
            break caseBuildLoop;
          }
          if ((buildSteps & 31) === 0 && isDeadlineExceeded(buildDeadlineTs)) {
            break caseBuildLoop;
          }
          const postAuf = postAufList[p];
          const candidate = buildFormulaCandidate(rot, preAuf, alg, postAuf);
          if (seenCandidate.has(candidate)) continue;
          seenCandidate.add(candidate);
          const inverse = invertAlg(candidate);
          const casePattern = tryApplyAlg(solved, inverse);
          if (!casePattern) continue;
          const candidateMoves = splitMoves(candidate);
          if (!candidateMoves.length) continue;
          if (candidateMoves.length > stage.maxDepth) continue;
          const caseKey = stage.key(casePattern.patternData);
          const existing = caseMap.get(caseKey);
          if (
            !existing ||
            candidateMoves.length < existing.moves.length ||
            (candidateMoves.length === existing.moves.length && candidate < existing.text)
          ) {
            caseMap.set(caseKey, {
              text: candidate,
              moves: candidateMoves,
            });
          }
        }
      }
    }
  }

  if (isDeadlineExceeded(deadlineTs)) {
    return null;
  }
  if (!caseMap.size) return null;

  const library = { caseMap };
  singleStageFormulaCaseLibraryCache.set(cacheKey, library);
  if (singleStageFormulaCaseLibraryCache.size > SINGLE_STAGE_LIBRARY_CACHE_LIMIT) {
    const oldest = singleStageFormulaCaseLibraryCache.keys().next().value;
    if (oldest !== undefined) singleStageFormulaCaseLibraryCache.delete(oldest);
  }
  return library;
}

function solveWithFormulaDbSingleStage(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }
  let formulas = filterValidFormulas(getFormulaListForStage(stage), ctx);
  if (!formulas.length) return null;
  if (stage.name === "CMLL" && formulas.length > 1) {
    const formulaLengthCache = new Map();
    formulas = formulas.slice().sort((a, b) => {
      let lenA = formulaLengthCache.get(a);
      if (lenA === undefined) {
        lenA = splitMoves(a).length;
        formulaLengthCache.set(a, lenA);
      }
      let lenB = formulaLengthCache.get(b);
      if (lenB === undefined) {
        lenB = splitMoves(b).length;
        formulaLengthCache.set(b, lenB);
      }
      if (lenA !== lenB) return lenA - lenB;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  let attempts = 0;
  const preAufList =
    Array.isArray(stage.formulaPreAufList) && stage.formulaPreAufList.length
      ? stage.formulaPreAufList
      : FORMULA_AUF;
  const postAufList =
    Array.isArray(stage.formulaPostAufList) && stage.formulaPostAufList.length
      ? stage.formulaPostAufList
      : stage.name === "PLL" || stage.name === "ZBLL"
        ? FORMULA_AUF
        : [""];
  const formulaAttemptLimit = Number.isFinite(stage.formulaAttemptLimit)
    ? Math.max(0, Math.floor(stage.formulaAttemptLimit))
    : 0;
  const compositeMaxDepth = Number.isFinite(stage.compositeMaxDepth)
    ? Math.max(normalizeDepth(stage.maxDepth, 24), Math.floor(stage.compositeMaxDepth))
    : Math.max(normalizeDepth(stage.maxDepth, 24), 32);
  const bridgeAttemptLimit = Number.isFinite(stage.bridgeAttemptLimit)
    ? Math.max(0, Math.floor(stage.bridgeAttemptLimit))
    : formulaAttemptLimit > 0
      ? Math.max(0, formulaAttemptLimit * 2)
      : 0;
  const directSolveMaxDepth = stage.name === "LSE"
    ? compositeMaxDepth
    : normalizeDepth(stage.maxDepth, compositeMaxDepth);
  const formulaTimeBudgetMs = Number.isFinite(stage.formulaTimeBudgetMs)
    ? Math.max(100, Math.floor(stage.formulaTimeBudgetMs))
    : 0;
  const formulaDeadlineTs = Number.isFinite(deadlineTs)
    ? formulaTimeBudgetMs > 0
      ? Math.min(deadlineTs, Date.now() + formulaTimeBudgetMs)
      : deadlineTs
    : formulaTimeBudgetMs > 0
      ? Date.now() + formulaTimeBudgetMs
      : Infinity;

  function timeoutResultOrNull(nodes) {
    if (!isDeadlineExceeded(deadlineTs)) return null;
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes,
      bound: STAGE_NOT_SET,
    };
  }

  function findOrientationAlignmentMoves(pattern) {
    if (stage.name !== "LSE" || !pattern) return null;
    if (typeof pattern.experimentalIsSolved !== "function") return null;
    try {
      if (!pattern.experimentalIsSolved({ ignorePuzzleOrientation: true })) {
        return null;
      }
    } catch (_) {
      return null;
    }

    for (let i = 0; i < SOLVED_ORIENTATION_ALIGN_ALGS.length; i++) {
      const alignAlg = SOLVED_ORIENTATION_ALIGN_ALGS[i];
      const alignedPattern = alignAlg ? tryApplyAlg(pattern, alignAlg) : pattern;
      if (!alignedPattern) continue;
      if (!stage.isSolved(alignedPattern.patternData, ctx)) continue;
      return splitMoves(alignAlg);
    }
    return null;
  }

  function finalizeStageMoves(baseMoves, endPattern, maxDepthLimit) {
    const merged = simplifyMoves(baseMoves);
    if (!merged.length) return null;
    if (Number.isFinite(maxDepthLimit) && merged.length > maxDepthLimit) return null;

    let workingPattern = endPattern;
    if (!workingPattern) {
      workingPattern = tryApplyMoves(startPattern, merged);
      if (!workingPattern) return null;
    }

    if (stage.isSolved(workingPattern.patternData, ctx)) {
      return merged;
    }

    const alignMoves = findOrientationAlignmentMoves(workingPattern);
    if (!alignMoves || !alignMoves.length) return null;
    const alignedMoves = simplifyMoves(merged.concat(alignMoves));
    if (!alignedMoves.length) return null;
    if (Number.isFinite(maxDepthLimit) && alignedMoves.length > maxDepthLimit) return null;
    const alignedPattern = tryApplyMoves(startPattern, alignedMoves);
    if (!alignedPattern) return null;
    if (!stage.isSolved(alignedPattern.patternData, ctx)) return null;
    return alignedMoves;
  }

  const library = getSingleStageFormulaCaseLibrary(
    stage,
    ctx,
    formulas,
    preAufList,
    postAufList,
    formulaDeadlineTs,
  );
  const lseTailLookupCache = stage.name === "LSE" ? new Map() : null;

  function getTailLookupForPattern(pattern) {
    if (!library?.caseMap?.size || !pattern) return null;
    const stateKey = stage.key(pattern.patternData);
    if (lseTailLookupCache && lseTailLookupCache.has(stateKey)) {
      return lseTailLookupCache.get(stateKey);
    }

    let lookup = null;
    const direct = library.caseMap.get(stateKey);
    if (direct && Array.isArray(direct.moves) && direct.moves.length) {
      lookup = { tail: direct, prefixMoves: [] };
    } else if (stage.name === "LSE") {
      for (let i = 1; i < SOLVED_ORIENTATION_ALIGN_ALGS.length; i++) {
        const alignAlg = SOLVED_ORIENTATION_ALIGN_ALGS[i];
        const rotated = tryApplyAlg(pattern, alignAlg);
        if (!rotated) continue;
        const rotatedTail = library.caseMap.get(stage.key(rotated.patternData));
        if (!rotatedTail || !Array.isArray(rotatedTail.moves) || !rotatedTail.moves.length) {
          continue;
        }
        lookup = {
          tail: rotatedTail,
          prefixMoves: splitMoves(alignAlg),
        };
        break;
      }
    }

    if (lseTailLookupCache) {
      lseTailLookupCache.set(stateKey, lookup);
    }
    return lookup;
  }

  if (library?.caseMap?.size) {
    const startTailLookup = getTailLookupForPattern(startPattern);
    if (startTailLookup?.tail) {
      const directMoves = simplifyMoves(
        startTailLookup.prefixMoves.concat(startTailLookup.tail.moves),
      );
      const solvedPattern = directMoves.length
        ? tryApplyMoves(startPattern, directMoves)
        : null;
      const solvedMoves = finalizeStageMoves(
        directMoves,
        solvedPattern,
        directSolveMaxDepth,
      );
      if (solvedMoves) {
        return {
          ok: true,
          moves: solvedMoves,
          depth: solvedMoves.length,
          nodes: 1,
          bound: solvedMoves.length,
        };
      }
    }
  }

  directFormulaLoop:
  for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
    const rot = FORMULA_ROTATIONS[r];
    for (let a = 0; a < preAufList.length; a++) {
      const preAuf = preAufList[a];
      for (let i = 0; i < formulas.length; i++) {
        if ((attempts & 63) === 0 && isDeadlineExceeded(formulaDeadlineTs)) {
          const timeout = timeoutResultOrNull(attempts);
          if (timeout) return timeout;
          break directFormulaLoop;
        }
        const alg = formulas[i];
        for (let p = 0; p < postAufList.length; p++) {
          if (formulaAttemptLimit > 0 && attempts >= formulaAttemptLimit) {
            break directFormulaLoop;
          }
          const postAuf = postAufList[p];
          const candidate = buildFormulaCandidate(rot, preAuf, alg, postAuf);
          const nextPattern = tryApplyAlg(startPattern, candidate);
          attempts += 1;
          if (!nextPattern) continue;
          const solvedMoves = finalizeStageMoves(
            splitMoves(candidate),
            nextPattern,
            directSolveMaxDepth,
          );
          if (solvedMoves) {
            return {
              ok: true,
              moves: solvedMoves,
              depth: solvedMoves.length,
              nodes: attempts,
              bound: solvedMoves.length,
            };
          }
        }
      }
    }
  }

  // LSE는 단일 공식 매칭 실패 시 3-매크로(공식 A + 공식 B + 라이브러리 종결)까지 확장 탐색한다.
  const allowPartialLseBridgeFallback = stage.allowPartialLseBridgeFallback !== false;
  const bridgeDeadlineTs =
    stage.name === "LSE" && allowPartialLseBridgeFallback && isDeadlineExceeded(formulaDeadlineTs)
      ? deadlineTs
      : formulaDeadlineTs;
  const canRunLseBridge =
    stage.name === "LSE" &&
    library?.caseMap?.size &&
    !isDeadlineExceeded(bridgeDeadlineTs);
  if (canRunLseBridge) {
    const bridgeFrontierLimit = Number.isFinite(stage.bridgeFrontierLimit)
      ? Math.max(8, Math.floor(stage.bridgeFrontierLimit))
      : 64;
    const bridgeCandidateLimit = Number.isFinite(stage.bridgeCandidateLimit)
      ? Math.max(bridgeFrontierLimit, Math.floor(stage.bridgeCandidateLimit))
      : Math.max(bridgeFrontierLimit * 180, 18000);
    const bridgeCandidateMap = new Map();
    let bridgeSeedChecks = 0;

    buildBridgeCandidatesLoop:
    for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
      const rot = FORMULA_ROTATIONS[r];
      for (let a = 0; a < preAufList.length; a++) {
        const preAuf = preAufList[a];
        for (let i = 0; i < formulas.length; i++) {
          const alg = formulas[i];
          for (let p = 0; p < postAufList.length; p++) {
            bridgeSeedChecks += 1;
            if ((bridgeSeedChecks & 255) === 0 && isDeadlineExceeded(bridgeDeadlineTs)) {
              const timeout = timeoutResultOrNull(attempts);
              if (timeout) return timeout;
              break buildBridgeCandidatesLoop;
            }
            const postAuf = postAufList[p];
            const text = buildFormulaCandidate(rot, preAuf, alg, postAuf);
            const moves = splitMoves(text);
            if (!moves.length || moves.length >= compositeMaxDepth) continue;
            const normalizedMoves = simplifyMoves(moves);
            if (!normalizedMoves.length || normalizedMoves.length >= compositeMaxDepth) continue;
            const normalizedText = joinMoves(normalizedMoves);
            if (!normalizedText) continue;
            const prev = bridgeCandidateMap.get(normalizedText);
            if (!prev || normalizedMoves.length < prev.moves.length) {
              bridgeCandidateMap.set(normalizedText, {
                text: normalizedText,
                moves: normalizedMoves,
              });
            }
            if (bridgeCandidateMap.size >= bridgeCandidateLimit * 2) {
              break buildBridgeCandidatesLoop;
            }
          }
        }
      }
    }

    let bridgeCandidates = Array.from(bridgeCandidateMap.values());
    if (!bridgeCandidates.length) {
      return null;
    }
    bridgeCandidates.sort(
      (a, b) =>
        a.moves.length - b.moves.length ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    );
    if (bridgeCandidates.length > bridgeCandidateLimit) {
      bridgeCandidates = bridgeCandidates.slice(0, bridgeCandidateLimit);
    }

    let bridgeAttempts = 0;
    let bestMoves = null;
    const frontierByKey = new Map();

    function scoreLseFrontier(data, moveLen) {
      const mismatch = stage.mismatch(data);
      const mismatchBound = stageHeuristicFromMismatch(
        mismatch.pieceMismatch,
        mismatch.orientationMismatch,
      );
      return mismatchBound * 100 + moveLen;
    }

    function pushFrontier(pattern, moves, stateKey) {
      const score = scoreLseFrontier(pattern.patternData, moves.length);
      const prev = frontierByKey.get(stateKey);
      if (
        !prev ||
        score < prev.score ||
        (score === prev.score && moves.length < prev.moves.length)
      ) {
        frontierByKey.set(stateKey, {
          pattern,
          moves,
          score,
        });
      }
    }

    firstBridgeLoop:
    for (let i = 0; i < bridgeCandidates.length; i++) {
      if ((bridgeAttempts & 63) === 0 && isDeadlineExceeded(bridgeDeadlineTs)) {
        const timeout = timeoutResultOrNull(attempts + bridgeAttempts);
        if (timeout) return timeout;
        break firstBridgeLoop;
      }
      if (bridgeAttemptLimit > 0 && bridgeAttempts >= bridgeAttemptLimit) {
        break firstBridgeLoop;
      }
      const candidate = bridgeCandidates[i];
      const midPattern = tryApplyAlg(startPattern, candidate.text);
      bridgeAttempts += 1;
      if (!midPattern) continue;

      const midKey = stage.key(midPattern.patternData);
      const tailLookup = getTailLookupForPattern(midPattern);
      if (tailLookup?.tail) {
        const mergedMoves = simplifyMoves(
          candidate.moves.concat(tailLookup.prefixMoves, tailLookup.tail.moves),
        );
        const solvedPattern = mergedMoves.length ? tryApplyMoves(startPattern, mergedMoves) : null;
        const solvedMoves = finalizeStageMoves(mergedMoves, solvedPattern, compositeMaxDepth);
        if (!solvedMoves) continue;
        if (bestMoves && solvedMoves.length >= bestMoves.length) continue;
        bestMoves = solvedMoves;
        if (bestMoves.length <= stage.maxDepth) {
          break firstBridgeLoop;
        }
      } else {
        pushFrontier(midPattern, candidate.moves, midKey);
      }
    }

    if (!bestMoves && frontierByKey.size) {
      const frontier = Array.from(frontierByKey.values())
        .sort((a, b) => a.score - b.score || a.moves.length - b.moves.length)
        .slice(0, bridgeFrontierLimit);
      const secondFrontierByKey = new Map();

      function pushSecondFrontier(pattern, moves, stateKey) {
        const score = scoreLseFrontier(pattern.patternData, moves.length);
        const prev = secondFrontierByKey.get(stateKey);
        if (
          !prev ||
          score < prev.score ||
          (score === prev.score && moves.length < prev.moves.length)
        ) {
          secondFrontierByKey.set(stateKey, {
            pattern,
            moves,
            score,
          });
        }
      }

      secondBridgeLoop:
      for (let f = 0; f < frontier.length; f++) {
        const base = frontier[f];
        for (let i = 0; i < bridgeCandidates.length; i++) {
          if ((bridgeAttempts & 63) === 0 && isDeadlineExceeded(bridgeDeadlineTs)) {
            const timeout = timeoutResultOrNull(attempts + bridgeAttempts);
            if (timeout) return timeout;
            break secondBridgeLoop;
          }
          if (bridgeAttemptLimit > 0 && bridgeAttempts >= bridgeAttemptLimit) {
            break secondBridgeLoop;
          }
          const candidate = bridgeCandidates[i];
          const partialMoves = simplifyMoves(base.moves.concat(candidate.moves));
          if (!partialMoves.length) continue;
          if (partialMoves.length >= compositeMaxDepth) continue;

          const secondPattern = tryApplyMoves(base.pattern, candidate.moves);
          bridgeAttempts += 1;
          if (!secondPattern) continue;

          const secondKey = stage.key(secondPattern.patternData);
          const tailLookup = getTailLookupForPattern(secondPattern);
          if (tailLookup?.tail) {
            const mergedMoves = simplifyMoves(
              partialMoves.concat(tailLookup.prefixMoves, tailLookup.tail.moves),
            );
            const solvedPattern = mergedMoves.length ? tryApplyMoves(startPattern, mergedMoves) : null;
            const solvedMoves = finalizeStageMoves(mergedMoves, solvedPattern, compositeMaxDepth);
            if (!solvedMoves) continue;
            if (bestMoves && solvedMoves.length >= bestMoves.length) continue;
            bestMoves = solvedMoves;
            if (bestMoves.length <= stage.maxDepth) {
              break secondBridgeLoop;
            }
          } else if (partialMoves.length + 2 < compositeMaxDepth) {
            pushSecondFrontier(secondPattern, partialMoves, secondKey);
          }
        }
      }

      if (!bestMoves && secondFrontierByKey.size) {
        const thirdFrontierLimit = Math.max(8, Math.floor(bridgeFrontierLimit / 2));
        const secondFrontier = Array.from(secondFrontierByKey.values())
          .sort((a, b) => a.score - b.score || a.moves.length - b.moves.length)
          .slice(0, thirdFrontierLimit);

        thirdBridgeLoop:
        for (let f = 0; f < secondFrontier.length; f++) {
          const base = secondFrontier[f];
          for (let i = 0; i < bridgeCandidates.length; i++) {
            if ((bridgeAttempts & 63) === 0 && isDeadlineExceeded(bridgeDeadlineTs)) {
              const timeout = timeoutResultOrNull(attempts + bridgeAttempts);
              if (timeout) return timeout;
              break thirdBridgeLoop;
            }
            if (bridgeAttemptLimit > 0 && bridgeAttempts >= bridgeAttemptLimit) {
              break thirdBridgeLoop;
            }
            const candidate = bridgeCandidates[i];
            const partialMoves = simplifyMoves(base.moves.concat(candidate.moves));
            if (!partialMoves.length) continue;
            if (partialMoves.length >= compositeMaxDepth) continue;

            const thirdPattern = tryApplyMoves(base.pattern, candidate.moves);
            bridgeAttempts += 1;
            if (!thirdPattern) continue;

            const tailLookup = getTailLookupForPattern(thirdPattern);
            if (!tailLookup?.tail) continue;

            const mergedMoves = simplifyMoves(
              partialMoves.concat(tailLookup.prefixMoves, tailLookup.tail.moves),
            );
            const solvedPattern = mergedMoves.length ? tryApplyMoves(startPattern, mergedMoves) : null;
            const solvedMoves = finalizeStageMoves(mergedMoves, solvedPattern, compositeMaxDepth);
            if (!solvedMoves) continue;
            if (bestMoves && solvedMoves.length >= bestMoves.length) continue;
            bestMoves = solvedMoves;
            if (bestMoves.length <= stage.maxDepth) {
              break thirdBridgeLoop;
            }
          }
        }
      }
    }

    attempts += bridgeAttempts;
    if (bestMoves) {
      return {
        ok: true,
        moves: bestMoves.slice(),
        depth: bestMoves.length,
        nodes: attempts,
        bound: bestMoves.length,
      };
    }
  }

  return null;
}

function solveWithFormulaDbF2L(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }
  const formulas = filterValidFormulas(getFormulaListForStage(stage), ctx);
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
    if (isDeadlineExceeded(deadlineTs)) return null;
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
      const preferShortMoveRanking = stage.name === "F2L";
      const ranking = {
        pairProgress: nextMetrics.pairProgress,
        solvedSum: nextMetrics.solvedSum,
        score: nextMetrics.score,
        moveLen: preferShortMoveRanking ? node.moves.length + candidateMoves.length : 0,
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
      if ((attemptsRef.count & 255) === 0 && isDeadlineExceeded(deadlineTs)) return null;
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
          if ((attemptsRef.count & 255) === 0 && isDeadlineExceeded(deadlineTs)) return null;
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
              if ((attemptsRef.count & 255) === 0 && isDeadlineExceeded(deadlineTs)) return null;
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
    if (isDeadlineExceeded(deadlineTs)) {
      return {
        ok: false,
        reason: `${stage.name.toUpperCase()}_TIMEOUT`,
        nodes: attemptsRef.count,
        bound: STAGE_NOT_SET,
      };
    }
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
      if (candidates === null) {
        return {
          ok: false,
          reason: `${stage.name.toUpperCase()}_TIMEOUT`,
          nodes: attemptsRef.count,
          bound: STAGE_NOT_SET,
        };
      }
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

function collectNoDbPairSequences(
  startState,
  pruneTable,
  transitionByMove,
  moveIndices,
  moveFace,
  depthLimit,
  maxSequences,
  deadlineTs = Infinity,
) {
  const sequences = [];
  const path = [];
  let nodes = 0;
  let timedOut = false;

  function dfs(state, depth, lastFace) {
    if ((nodes & 255) === 0 && isDeadlineExceeded(deadlineTs)) {
      timedOut = true;
      return;
    }
    if (timedOut) return;
    if (sequences.length >= maxSequences) return;
    const dist = pruneTable[state];
    if (dist < 0) return;
    if (dist === 0) {
      sequences.push(path.slice());
      return;
    }
    if (depth >= depthLimit) return;
    if (depth + dist > depthLimit) return;

    for (let i = 0; i < moveIndices.length; i++) {
      const moveIndex = moveIndices[i];
      const face = moveFace[moveIndex];
      if (lastFace !== NO_FACE_INDEX) {
        if (face === lastFace) continue;
        if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
      }
      nodes += 1;
      path.push(moveIndex);
      dfs(transitionByMove[moveIndex][state], depth + 1, face);
      path.pop();
      if (sequences.length >= maxSequences) return;
      if (timedOut) return;
    }
  }

  dfs(startState, 0, NO_FACE_INDEX);
  return { sequences, nodes, timedOut };
}

function solveNoDbF2LStageUsingPairPrune(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }
  if (!stage?.noDbMode || !ctx?.f2lPairDefs?.length || !ctx.f2lPairStateTransitionByMove) return null;
  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const depthCap = Math.min(
    normalizeDepth(stage.maxDepth, 14),
    normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 14)),
  );
  const pairTryLimit = Math.max(1, normalizeDepth(stage.noDbPairTryLimit, 3));
  const candidateLimit = Math.max(16, normalizeDepth(stage.noDbCandidateLimit, 100));
  const slackDepth = Math.max(0, normalizeDepth(stage.noDbSlackDepth, 4));
  const targetPairs = Math.max(1, normalizeDepth(stage.noDbTargetPairs, 1));
  const preferWideNoDbMoves = targetPairs >= 3;
  const allowAllFaceMoves = targetPairs >= 4;
  const wideMoveIndices = allowAllFaceMoves ? ctx.allMoveIndices : stage.moveIndices;
  const minFrontierPairProgress = Math.max(0, targetPairs - 2);
  const firstPassFrontierLimit = Math.max(10, Math.min(40, Math.floor(candidateLimit / 6) + pairTryLimit));
  const secondPassStateLimit = Math.max(6, Math.min(20, Math.floor(candidateLimit / 10) + pairTryLimit));
  const secondPassPairTryLimit = Math.max(1, Math.min(pairTryLimit, targetPairs >= 4 ? 4 : 3));
  const secondPassCandidateLimit = Math.max(14, Math.min(96, Math.floor(candidateLimit / 2)));
  const secondPassSlackDepth = Math.max(1, Math.min(slackDepth, targetPairs >= 4 ? 6 : 4));

  let best = null;
  let totalNodes = 0;
  const frontierByKey = new Map();

  function makeTimeout() {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: totalNodes,
      bound: STAGE_NOT_SET,
    };
  }

  function buildPairEntriesForData(data, moveIndicesForPrune) {
    const useAllPrune = moveIndicesForPrune === ctx.allMoveIndices;
    const entries = [];
    for (let i = 0; i < ctx.f2lPairDefs.length; i++) {
      const pairDef = ctx.f2lPairDefs[i];
      const startState = getF2LPairStateForDef(data, pairDef);
      if (startState < 0) continue;
      const pruneTable = useAllPrune
        ? pairDef.pruneTableAll || pairDef.pruneTable
        : pairDef.pruneTableNoD || pairDef.pruneTable;
      if (!pruneTable) continue;
      const dist = pruneTable[startState];
      if (dist <= 0) continue;
      entries.push({
        pairDef,
        startState,
        dist,
        pruneTable,
      });
    }
    entries.sort((a, b) => a.dist - b.dist);
    return entries;
  }

  function scoreCandidate(movesLen, pairProgress, mismatch) {
    return (
      movesLen * 1000 +
      (4 - Math.min(pairProgress, 4)) * 120 +
      mismatch.pieceMismatch * 12 +
      mismatch.orientationMismatch
    );
  }

  function resolveStageMismatch(data) {
    if (typeof stage?.mismatch === "function") {
      const mismatch = stage.mismatch(data);
      if (
        mismatch &&
        Number.isFinite(mismatch.pieceMismatch) &&
        Number.isFinite(mismatch.orientationMismatch)
      ) {
        return mismatch;
      }
    }

    const cornerMismatch = countOrbitMismatches(
      data.CORNERS,
      ctx.solvedData.CORNERS,
      ctx.f2lCornerPositions,
      true,
      true,
    );
    const edgeMismatch = countOrbitMismatches(
      data.EDGES,
      ctx.solvedData.EDGES,
      ctx.f2lEdgePositions,
      true,
      true,
    );
    const targetPairs = Math.max(1, normalizeDepth(stage?.noDbTargetPairs, 4));
    const pairNeed = Math.max(0, targetPairs - getF2LPairProgress(data, ctx));
    return {
      pieceMismatch: cornerMismatch.pieceMismatch + edgeMismatch.pieceMismatch + pairNeed,
      orientationMismatch: cornerMismatch.orientationMismatch + edgeMismatch.orientationMismatch,
    };
  }

  function pushFrontier(nextPattern, moves, pairProgress, score) {
    const key = `${pairProgress}:${getF2LStateKey(nextPattern.patternData, ctx)}`;
    const prev = frontierByKey.get(key);
    if (
      !prev ||
      pairProgress > prev.pairProgress ||
      score < prev.score ||
      (score === prev.score && moves.length < prev.moves.length)
    ) {
      frontierByKey.set(key, {
        pattern: nextPattern,
        moves,
        pairProgress,
        score,
      });
      if (frontierByKey.size > firstPassFrontierLimit * 4) {
        const frontier = Array.from(frontierByKey.values())
          .sort((a, b) => {
            if (a.pairProgress !== b.pairProgress) return b.pairProgress - a.pairProgress;
            if (a.score !== b.score) return a.score - b.score;
            return a.moves.length - b.moves.length;
          })
          .slice(0, firstPassFrontierLimit * 2);
        frontierByKey.clear();
        for (let i = 0; i < frontier.length; i++) {
          const entry = frontier[i];
          const trimKey = `${entry.pairProgress}:${getF2LStateKey(entry.pattern.patternData, ctx)}`;
          frontierByKey.set(trimKey, entry);
        }
      }
    }
  }

  function considerCandidate(nextPattern, moves, collectFrontier) {
    const nextData = nextPattern.patternData;
    if (!isCrossSolved(nextData, ctx)) return;
    const pairProgress = getF2LPairProgress(nextData, ctx);
    const mismatch = resolveStageMismatch(nextData);
    const score = scoreCandidate(moves.length, pairProgress, mismatch);
    if (pairProgress >= targetPairs) {
      if (!best || score < best.score || (score === best.score && moves.length < best.moves.length)) {
        best = { score, moves };
      }
      return;
    }
    if (collectFrontier && pairProgress >= minFrontierPairProgress) {
      pushFrontier(nextPattern, moves, pairProgress, score);
    }
  }

  function explorePatternWithPairPrune(
    basePattern,
    baseMoves,
    localPairTryLimit,
    localCandidateLimit,
    localSlackDepth,
    collectFrontier,
    moveIndicesForPrune,
  ) {
    const remainingDepthCap = depthCap - baseMoves.length;
    if (remainingDepthCap <= 0) return { timedOut: false };
    const pairEntries = buildPairEntriesForData(basePattern.patternData, moveIndicesForPrune);
    if (!pairEntries.length) return { timedOut: false };
    const pairCount = Math.min(pairEntries.length, localPairTryLimit);
    for (let p = 0; p < pairCount; p++) {
      if (isDeadlineExceeded(deadlineTs)) return { timedOut: true };
      const entry = pairEntries[p];
      const pairMoveIndices = preferWideNoDbMoves
        ? moveIndicesForPrune
        : Array.isArray(entry.pairDef.noDbMoveIndices) && entry.pairDef.noDbMoveIndices.length
          ? entry.pairDef.noDbMoveIndices
          : moveIndicesForPrune;
      const minDepth = Math.max(0, entry.dist);
      const maxDepth = Math.min(remainingDepthCap, minDepth + localSlackDepth);
      if (maxDepth < minDepth) continue;

      for (let depth = minDepth; depth <= maxDepth; depth++) {
        const { sequences, nodes, timedOut } = collectNoDbPairSequences(
          entry.startState,
          entry.pruneTable,
          ctx.f2lPairStateTransitionByMove,
          pairMoveIndices,
          ctx.moveFace,
          depth,
          localCandidateLimit,
          deadlineTs,
        );
        totalNodes += nodes;
        if (timedOut) return { timedOut: true };
        if (!sequences.length) continue;
        for (let s = 0; s < sequences.length; s++) {
          const segmentMoves = sequences[s].map((moveIndex) => MOVE_NAMES[moveIndex]);
          const nextPattern = tryApplyMoves(basePattern, segmentMoves);
          if (!nextPattern) continue;
          const mergedMoves = baseMoves.length ? baseMoves.concat(segmentMoves) : segmentMoves;
          considerCandidate(nextPattern, mergedMoves, collectFrontier);
        }
        if (best) return { timedOut: false };
      }
      if (best) return { timedOut: false };
    }
    return { timedOut: false };
  }

  const firstPass = explorePatternWithPairPrune(
    startPattern,
    [],
    pairTryLimit,
    candidateLimit,
    slackDepth,
    true,
    wideMoveIndices,
  );
  if (firstPass.timedOut) return makeTimeout();

  if (!best && frontierByKey.size && targetPairs > 1) {
    const frontier = Array.from(frontierByKey.values())
      .sort((a, b) => {
        if (a.pairProgress !== b.pairProgress) return b.pairProgress - a.pairProgress;
        if (a.score !== b.score) return a.score - b.score;
        return a.moves.length - b.moves.length;
      })
      .slice(0, secondPassStateLimit);

    for (let i = 0; i < frontier.length; i++) {
      if (isDeadlineExceeded(deadlineTs)) return makeTimeout();
      const item = frontier[i];
      const secondPass = explorePatternWithPairPrune(
        item.pattern,
        item.moves,
        secondPassPairTryLimit,
        secondPassCandidateLimit,
        secondPassSlackDepth,
        false,
        wideMoveIndices,
      );
      if (secondPass.timedOut) return makeTimeout();
      if (best) break;
    }
  }

  if (!best) return null;
  return {
    ok: true,
    moves: best.moves,
    depth: best.moves.length,
    nodes: totalNodes,
    bound: best.moves.length,
  };
}

function solveRouxSbCustomSearch(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }

  const startData = startPattern.patternData;
  if (isRouxF2BSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const moveIndices =
    Array.isArray(stage.moveIndices) && stage.moveIndices.length ? stage.moveIndices : ctx.noDMoveIndices;
  if (!Array.isArray(moveIndices) || !moveIndices.length) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }

  const lockedMask =
    Number.isFinite(stage.sbLockedPairMask) && stage.sbLockedPairMask > 0
      ? Math.floor(stage.sbLockedPairMask)
      : 0;
  const lockDepthLimit =
    Number.isFinite(stage.sbLockPreserveDepth) && stage.sbLockPreserveDepth >= 0
      ? Math.floor(stage.sbLockPreserveDepth)
      : 2;
  const searchMaxDepth = Number.isFinite(stage.searchMaxDepth) ? stage.searchMaxDepth : stage.maxDepth;
  const nodeLimit = Number.isFinite(stage.nodeLimit) ? stage.nodeLimit : 0;
  const bridgeEnabled = stage.sbBridgeFallback !== false;
  const bridgeFrontierLimit = Math.max(6, normalizeDepth(stage.sbBridgeFrontierLimit, 24));
  const bridgeDepthCap = Math.max(2, Math.min(searchMaxDepth, normalizeDepth(stage.sbBridgeDepthCap, 8)));
  const bridgeMinDepth = Math.min(
    bridgeDepthCap,
    Math.max(1, normalizeDepth(stage.sbBridgeMinDepth, 3)),
  );
  const bridgeNodeLimit = Math.max(0, normalizeDepth(stage.sbBridgeNodeLimit, 900000));
  const movePriority = getRouxSbMovePriorityByMoveIndex(ctx);
  const goalMacroEnabled = stage.sbGoalMacroEnabled !== false;
  const goalMacroDepth = Math.max(2, normalizeDepth(stage.sbGoalMacroDepth, 6));
  const goalMacroNodeLimit = Math.max(10000, normalizeDepth(stage.sbGoalMacroNodeLimit, 220000));
  const goalMacroTable = goalMacroEnabled
    ? getRouxSbGoalMacroTable(ctx, moveIndices, goalMacroDepth, goalMacroNodeLimit)
    : null;
  const startStateKey = getRouxSbStateKey(startData, ctx, lockedMask);
  const moveSignature = moveIndices.join(",");
  const continuation =
    stage.__continuation && typeof stage.__continuation === "object" ? stage.__continuation : null;
  const canResumeContinuation =
    continuation?.type === "roux-sb" &&
    continuation.startStateKey === startStateKey &&
    continuation.lockedMask === lockedMask &&
    continuation.moveSignature === moveSignature &&
    continuation.heuristicCache instanceof Map &&
    continuation.failCache instanceof Map &&
    continuation.bestSeenDepthByState instanceof Map &&
    continuation.bridgeFrontierByKey instanceof Map;

  const heuristicCache = canResumeContinuation ? continuation.heuristicCache : new Map();
  const failCache = canResumeContinuation ? continuation.failCache : new Map();
  const bestSeenDepthByState = canResumeContinuation ? continuation.bestSeenDepthByState : new Map();
  const bridgeFrontierByKey = canResumeContinuation ? continuation.bridgeFrontierByKey : new Map();
  const trace = [];
  let solvedPath = null;
  let nodes = canResumeContinuation ? Math.max(0, normalizeDepth(continuation.nodes, 0)) : 0;
  let nodeLimitHit = false;
  let timedOut = false;

  function buildContinuation(nextBoundHint) {
    return {
      type: "roux-sb",
      stageName: stage.name,
      startStateKey,
      lockedMask,
      moveSignature,
      heuristicCache,
      failCache,
      bestSeenDepthByState,
      bridgeFrontierByKey,
      nodes,
      nextBound: Math.max(
        1,
        Number.isFinite(nextBoundHint) ? Math.floor(nextBoundHint) : Math.max(1, normalizeDepth(stage.searchMaxDepth, 1)),
      ),
    };
  }

  function lockBroken(data, depth) {
    if (!lockedMask || depth > lockDepthLimit) return false;
    return (getSolvedF2LPairMask(data, ctx) & lockedMask) !== lockedMask;
  }

  function heuristic(data) {
    const key = getRouxSbStateKey(data, ctx, lockedMask);
    const cached = heuristicCache.get(key);
    if (typeof cached === "number") return cached;
    const h = getRouxSbF2bLowerBound(data, ctx, lockedMask);
    if (heuristicCache.size > HEURISTIC_CACHE_LIMIT) heuristicCache.clear();
    heuristicCache.set(key, h);
    return h;
  }

  function compareBridgeRank(a, b) {
    if (a.secondaryDeficit !== b.secondaryDeficit) return a.secondaryDeficit - b.secondaryDeficit;
    if (a.primaryDeficit !== b.primaryDeficit) return a.primaryDeficit - b.primaryDeficit;
    if (a.totalDeficit !== b.totalDeficit) return a.totalDeficit - b.totalDeficit;
    if (a.projectedDepth !== b.projectedDepth) return a.projectedDepth - b.projectedDepth;
    if (a.depth !== b.depth) return b.depth - a.depth;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0;
  }

  function trimBridgeFrontier(maxKeep = bridgeFrontierLimit * 2) {
    if (bridgeFrontierByKey.size <= maxKeep) return;
    const frontier = Array.from(bridgeFrontierByKey.entries())
      .sort((a, b) => compareBridgeRank(a[1].rank, b[1].rank) || a[1].moves.length - b[1].moves.length)
      .slice(0, maxKeep);
    bridgeFrontierByKey.clear();
    for (let i = 0; i < frontier.length; i++) {
      const [key, entry] = frontier[i];
      bridgeFrontierByKey.set(key, entry);
    }
  }

  function maybePushBridgeCandidate(nextPattern, nextData, depth, face, nextH, metrics, priority) {
    if (!bridgeEnabled) return;
    if (depth < bridgeMinDepth || depth > bridgeDepthCap) return;
    if (!metrics) return;

    const rank = {
      secondaryDeficit: metrics.secondaryDeficit,
      primaryDeficit: metrics.primaryDeficit,
      totalDeficit: metrics.totalDeficit,
      projectedDepth: depth + nextH,
      depth,
      priority,
    };
    const stateKey = getRouxSbStateKey(nextData, ctx, lockedMask);
    const frontierKey = stateKey;
    const existing = bridgeFrontierByKey.get(frontierKey);
    if (existing && compareBridgeRank(existing.rank, rank) <= 0) {
      return;
    }

    bridgeFrontierByKey.set(frontierKey, {
      pattern: nextPattern,
      moves: trace.slice(0, depth),
      rank,
    });
    if (bridgeFrontierByKey.size > bridgeFrontierLimit * 4) {
      trimBridgeFrontier();
    }
  }

  function tryResolveWithGoalMacro(pattern, depth) {
    if (!(goalMacroTable instanceof Map) || !goalMacroTable.size) return false;
    const key = getF2LStateKey(pattern.patternData, ctx);
    const tailMoveIndices = goalMacroTable.get(key);
    if (!Array.isArray(tailMoveIndices)) return false;
    if (!tailMoveIndices.length) {
      if (isRouxF2BSolved(pattern.patternData, ctx)) {
        solvedPath = trace.slice();
        return true;
      }
      return false;
    }

    const maxTailLen = Math.max(2, normalizeDepth(stage.sbGoalMacroMaxTailLength, goalMacroDepth));
    if (tailMoveIndices.length > maxTailLen) return false;
    let workingPattern = pattern;
    for (let i = 0; i < tailMoveIndices.length; i++) {
      const moveIndex = tailMoveIndices[i];
      workingPattern = workingPattern.applyMove(MOVE_NAMES[moveIndex]);
      if (lockBroken(workingPattern.patternData, depth + i + 1)) {
        return false;
      }
    }
    if (!isRouxF2BSolved(workingPattern.patternData, ctx)) return false;
    solvedPath = trace.concat(tailMoveIndices);
    return true;
  }

  function dfs(pattern, depth, currentBound, lastFace, presetHeuristic = null) {
    if ((nodes & 511) === 0 && isDeadlineExceeded(deadlineTs)) {
      timedOut = true;
      return Infinity;
    }
    if (timedOut) return Infinity;
    const data = pattern.patternData;
    if (isRouxF2BSolved(data, ctx)) {
      solvedPath = trace.slice();
      return true;
    }
    if (lockBroken(data, depth)) return Infinity;
    if (typeof stage.prune === "function" && stage.prune(data, depth, currentBound, ctx)) {
      return Infinity;
    }

    const h = Number.isFinite(presetHeuristic) ? Math.floor(presetHeuristic) : heuristic(data);
    const f = depth + h;
    if (f > currentBound) return f;
    if (tryResolveWithGoalMacro(pattern, depth)) {
      return true;
    }

    const remaining = currentBound - depth;
    const stateKey = getRouxSbStateKey(data, ctx, lockedMask);
    const failKey = `${stateKey}|${lastFace}`;
    const bestSeenDepth = bestSeenDepthByState.get(failKey);
    if (Number.isFinite(bestSeenDepth) && bestSeenDepth <= depth) return Infinity;
    if (bestSeenDepthByState.size > FAIL_CACHE_LIMIT * 2) bestSeenDepthByState.clear();
    bestSeenDepthByState.set(failKey, depth);
    const seenMask = failCache.get(failKey) || 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    let minNext = Infinity;
    const shouldOrderMoves =
      moveIndices.length > 6 && depth <= normalizeDepth(stage.moveOrderingMaxDepth, 8);
    if (shouldOrderMoves) {
      const candidates = [];
      for (let i = 0; i < moveIndices.length; i++) {
        if (timedOut) return Infinity;
        if (nodeLimit > 0 && nodes >= nodeLimit) {
          nodeLimitHit = true;
          return Infinity;
        }
        const moveIndex = moveIndices[i];
        const face = ctx.moveFace[moveIndex];
        if (lastFace !== NO_FACE_INDEX) {
          if (face === lastFace) continue;
          if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        }
        nodes += 1;
        const nextPattern = pattern.applyMove(MOVE_NAMES[moveIndex]);
        const nextData = nextPattern.patternData;
        if (lockBroken(nextData, depth + 1)) continue;
        const nextH = heuristic(nextData);
        const nextF = depth + 1 + nextH;
        if (nextF > currentBound) {
          if (nextF < minNext) minNext = nextF;
          continue;
        }
        const metrics = getRouxSbObjectiveMetrics(nextData, ctx, lockedMask);
        candidates.push({
          moveIndex,
          face,
          nextPattern,
          nextData,
          nextH,
          priority: movePriority[moveIndex] || 0,
          metrics,
          secondaryDeficit: metrics.secondaryDeficit,
          primaryDeficit: metrics.primaryDeficit,
          totalDeficit: metrics.totalDeficit,
        });
      }

      candidates.sort(
        (a, b) =>
          a.nextH - b.nextH ||
          a.secondaryDeficit - b.secondaryDeficit ||
          a.primaryDeficit - b.primaryDeficit ||
          a.totalDeficit - b.totalDeficit ||
          a.priority - b.priority ||
          a.moveIndex - b.moveIndex,
      );

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        trace.push(candidate.moveIndex);
        maybePushBridgeCandidate(
          candidate.nextPattern,
          candidate.nextData,
          depth + 1,
          candidate.face,
          candidate.nextH,
          candidate.metrics,
          candidate.priority,
        );
        const res = dfs(candidate.nextPattern, depth + 1, currentBound, candidate.face, candidate.nextH);
        if (res === true) {
          return true;
        }
        trace.pop();
        if (res < minNext) minNext = res;
      }
    } else {
      for (let i = 0; i < moveIndices.length; i++) {
        if (timedOut) return Infinity;
        if (nodeLimit > 0 && nodes >= nodeLimit) {
          nodeLimitHit = true;
          return Infinity;
        }
        const moveIndex = moveIndices[i];
        const face = ctx.moveFace[moveIndex];
        if (lastFace !== NO_FACE_INDEX) {
          if (face === lastFace) continue;
          if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        }
        nodes += 1;
        const nextPattern = pattern.applyMove(MOVE_NAMES[moveIndex]);
        const nextData = nextPattern.patternData;
        if (lockBroken(nextData, depth + 1)) continue;
        const nextH = heuristic(nextData);
        const nextF = depth + 1 + nextH;
        if (nextF > currentBound) {
          if (nextF < minNext) minNext = nextF;
          continue;
        }
        const metrics = bridgeEnabled ? getRouxSbObjectiveMetrics(nextData, ctx, lockedMask) : null;
        trace.push(moveIndex);
        if (metrics) {
          maybePushBridgeCandidate(nextPattern, nextData, depth + 1, face, nextH, metrics, movePriority[moveIndex] || 0);
        }
        const res = dfs(nextPattern, depth + 1, currentBound, face, nextH);
        if (res === true) {
          return true;
        }
        trace.pop();
        if (res < minNext) minNext = res;
      }
    }

    if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
    failCache.set(failKey, seenMask | bit);
    return minNext;
  }

  let bound = Math.max(
    canResumeContinuation ? normalizeDepth(continuation.nextBound, 1) : heuristic(startData),
    1,
  );
  while (bound <= searchMaxDepth) {
    if (isDeadlineExceeded(deadlineTs)) {
      timedOut = true;
      break;
    }
    if (nodeLimitHit) break;
    trace.length = 0;
    solvedPath = null;
    const res = dfs(startPattern, 0, bound, NO_FACE_INDEX);
    if (res === true) {
      const moves = Array.isArray(solvedPath) ? solvedPath.slice() : [];
      return {
        ok: true,
        moves: moves.map((idx) => MOVE_NAMES[idx]),
        depth: moves.length,
        nodes,
        bound,
      };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  if (bridgeEnabled && !isDeadlineExceeded(deadlineTs) && bridgeFrontierByKey.size) {
    const bridgeStage = {
      name: stage.name,
      noDbMode: true,
      maxDepth: Math.max(12, normalizeDepth(stage.searchMaxDepth, stage.maxDepth)),
      searchMaxDepth: Math.max(12, normalizeDepth(stage.searchMaxDepth, stage.maxDepth)),
      moveIndices: ctx.noDMoveIndices,
      noDbPairTryLimit: Math.max(2, normalizeDepth(stage.sbBridgePairTryLimit, 4)),
      noDbCandidateLimit: Math.max(32, normalizeDepth(stage.sbBridgeCandidateLimit, 120)),
      noDbSlackDepth: Math.max(2, normalizeDepth(stage.sbBridgeSlackDepth, 5)),
      noDbTargetPairs: 4,
      isSolved(data) {
        return isRouxF2BSolved(data, ctx) || getF2LPairProgress(data, ctx) >= 4;
      },
    };
    const frontier = Array.from(bridgeFrontierByKey.values())
      .sort((a, b) => compareBridgeRank(a.rank, b.rank) || a.moves.length - b.moves.length)
      .slice(0, bridgeFrontierLimit);
    let bridgeNodes = 0;
    let bridgeNodeLimitHit = false;

    for (let i = 0; i < frontier.length; i++) {
      if (isDeadlineExceeded(deadlineTs)) {
        timedOut = true;
        break;
      }
      if (bridgeNodeLimit > 0 && bridgeNodes >= bridgeNodeLimit) {
        bridgeNodeLimitHit = true;
        break;
      }

      const attemptsLeft = Math.max(1, frontier.length - i);
      let bridgeDeadlineTs = deadlineTs;
      if (Number.isFinite(deadlineTs)) {
        const remainingMs = deadlineTs - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }
        const sliceMs = Math.max(750, Math.floor(remainingMs / attemptsLeft));
        bridgeDeadlineTs = Math.min(deadlineTs, Date.now() + sliceMs);
      }

      const entry = frontier[i];
      const bridgeResult = solveNoDbF2LStageUsingPairPrune(
        entry.pattern,
        bridgeStage,
        ctx,
        bridgeDeadlineTs,
      );
      bridgeNodes += bridgeResult?.nodes || 0;

      if (bridgeResult?.ok) {
        const tailMoves = Array.isArray(bridgeResult.moves) ? bridgeResult.moves : [];
        const prefixMoves = entry.moves.map((idx) => MOVE_NAMES[idx]);
        const mergedMoves = simplifyMoves(prefixMoves.concat(tailMoves));
        return {
          ok: true,
          moves: mergedMoves,
          depth: mergedMoves.length,
          nodes: nodes + bridgeNodes,
          bound: mergedMoves.length,
        };
      }
    }

    nodes += bridgeNodes;
    if (bridgeNodeLimitHit) {
      nodeLimitHit = true;
    }
  }

  return nodeLimitHit
    ? {
        ok: false,
        reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
        nodes,
        bound: STAGE_NOT_SET,
        __continuation: buildContinuation(bound),
      }
    : timedOut
      ? {
          ok: false,
          reason: `${stage.name.toUpperCase()}_TIMEOUT`,
          nodes,
          bound: STAGE_NOT_SET,
          __continuation: buildContinuation(bound),
        }
      : {
          ok: false,
          reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
          nodes,
          bound: STAGE_NOT_SET,
          __continuation: buildContinuation(bound),
        };
}

function solveRouxFbWithCandidates(startPattern, stage, ctx, options, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }

  const candidateLimit = Math.max(1, Math.min(8, normalizeDepth(options.rouxFbCandidateCount, 3)));
  const sbEntryMaxLowerBound = Math.max(2, normalizeDepth(options.rouxFbSbEntryMaxLowerBound, 8));
  const earlyStopDifficulty = Math.max(0, normalizeDepth(options.rouxFbEarlyStopDifficulty, 4));
  const earlyStopMoveCount = Math.max(4, normalizeDepth(options.rouxFbEarlyStopMoveCount, 10));
  const variants = [];
  const seenVariant = new Set();
  const pushVariant = (label, patch = {}) => {
    const variantStage = {
      ...stage,
      ...patch,
    };
    const moveKey = Array.isArray(variantStage.moveIndices)
      ? variantStage.moveIndices.join(",")
      : "";
    const key = `${moveKey}|${normalizeDepth(variantStage.maxDepth, stage.maxDepth)}|${normalizeDepth(
      variantStage.searchMaxDepth,
      stage.searchMaxDepth,
    )}|${normalizeDepth(variantStage.nodeLimit, stage.nodeLimit)}`;
    if (seenVariant.has(key)) return;
    seenVariant.add(key);
    variants.push({ label, stage: variantStage });
  };

  pushVariant("base", {});
  if (stage.moveIndices !== ctx.noDMoveIndices) {
    pushVariant("no-d", {
      moveIndices: ctx.noDMoveIndices,
    });
  }
  pushVariant("deep", {
    maxDepth: normalizeDepth(stage.maxDepth, 10) + 1,
    searchMaxDepth: normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 10)) + 1,
    nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 520000),
  });
  if (stage.moveIndices !== ctx.noDMoveIndices) {
    pushVariant("no-d-deep", {
      moveIndices: ctx.noDMoveIndices,
      maxDepth: normalizeDepth(stage.maxDepth, 10) + 1,
      searchMaxDepth: normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 10)) + 1,
      nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 520000),
    });
  }
  pushVariant("deeper", {
    maxDepth: normalizeDepth(stage.maxDepth, 10) + 2,
    searchMaxDepth: normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 10)) + 2,
    nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 900000),
  });
  if (stage.moveIndices !== ctx.noDMoveIndices) {
    pushVariant("no-d-deeper", {
      moveIndices: ctx.noDMoveIndices,
      maxDepth: normalizeDepth(stage.maxDepth, 10) + 2,
      searchMaxDepth: normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 10)) + 2,
      nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 900000),
    });
  }

  const legacyFallbackStage =
    options.rouxFbLegacyFallback === false
      ? null
      : {
          ...stage,
          isSolved(data) {
            return isCrossWithF2LPairTarget(data, ctx, 1);
          },
          heuristic(data) {
            const crossBound = getCrossPruneHeuristic(data, ctx);
            const pairNeed = getF2LPairDeficit(data, ctx, 1);
            if (Number.isFinite(crossBound) && crossBound >= 0) {
              return Math.max(crossBound, pairNeed);
            }
            const e = countOrbitMismatches(
              data.EDGES,
              ctx.solvedData.EDGES,
              ctx.bottomEdgePositions,
              true,
              true,
            );
            const crossFallback = stageHeuristicFromMismatch(e.pieceMismatch, e.orientationMismatch);
            return Math.max(crossFallback, pairNeed);
          },
          mismatch(data) {
            const e = countOrbitMismatches(
              data.EDGES,
              ctx.solvedData.EDGES,
              ctx.bottomEdgePositions,
              true,
              true,
            );
            const pairNeed = getF2LPairDeficit(data, ctx, 1);
            return {
              pieceMismatch: e.pieceMismatch + pairNeed * 2,
              orientationMismatch: e.orientationMismatch,
            };
          },
          key(data) {
            return `FB_LEGACY:${getF2LStateKey(data, ctx)}`;
          },
          maxDepth: Math.max(normalizeDepth(stage.maxDepth, 10), 10),
          searchMaxDepth: Math.max(
            normalizeDepth(stage.searchMaxDepth, normalizeDepth(stage.maxDepth, 10)),
            10,
          ),
          nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 520000),
        };

  let totalNodes = 0;
  let bestSuccess = null;
  let firstFailure = null;

  function considerSuccess(candidateResult, variantOrder) {
    const internalMoves = Array.isArray(candidateResult.moves) ? candidateResult.moves.slice() : [];
    const outputMoves = simplifyMoves(internalMoves);
    const moveText = joinMoves(outputMoves);
    const endPattern = moveText ? startPattern.applyAlg(moveText) : startPattern;
    const lockedMask = getRouxPrimaryBlockMask(endPattern.patternData, ctx, 2);
    const sbLowerBound = getRouxSbF2bLowerBound(endPattern.patternData, ctx, lockedMask);
    if (sbLowerBound > sbEntryMaxLowerBound) {
      return false;
    }
    const sbBlockBound = getRouxSbBlockTableLowerBound(endPattern.patternData, ctx);
    const sbDifficulty = estimateRouxSbDifficulty(endPattern.patternData, ctx, lockedMask);
    const rank = {
      sbLowerBound,
      sbDifficulty,
      sbBlockBound,
      moveCount: outputMoves.length,
      bound: Number.isFinite(candidateResult.bound) ? candidateResult.bound : outputMoves.length,
      variantOrder,
    };
    if (
      !bestSuccess ||
      rank.sbLowerBound < bestSuccess.rank.sbLowerBound ||
      (rank.sbLowerBound === bestSuccess.rank.sbLowerBound &&
        rank.sbDifficulty < bestSuccess.rank.sbDifficulty) ||
      (rank.sbLowerBound === bestSuccess.rank.sbLowerBound &&
        rank.sbDifficulty === bestSuccess.rank.sbDifficulty &&
        rank.sbBlockBound < bestSuccess.rank.sbBlockBound) ||
      (rank.sbLowerBound === bestSuccess.rank.sbLowerBound &&
        rank.sbDifficulty === bestSuccess.rank.sbDifficulty &&
        rank.sbBlockBound === bestSuccess.rank.sbBlockBound &&
        rank.moveCount < bestSuccess.rank.moveCount) ||
      (rank.sbLowerBound === bestSuccess.rank.sbLowerBound &&
        rank.sbDifficulty === bestSuccess.rank.sbDifficulty &&
        rank.sbBlockBound === bestSuccess.rank.sbBlockBound &&
        rank.moveCount === bestSuccess.rank.moveCount &&
        rank.bound < bestSuccess.rank.bound) ||
      (rank.sbLowerBound === bestSuccess.rank.sbLowerBound &&
        rank.sbDifficulty === bestSuccess.rank.sbDifficulty &&
        rank.sbBlockBound === bestSuccess.rank.sbBlockBound &&
        rank.moveCount === bestSuccess.rank.moveCount &&
        rank.bound === bestSuccess.rank.bound &&
        rank.variantOrder < bestSuccess.rank.variantOrder)
    ) {
      bestSuccess = {
        rank,
        result: {
          ...candidateResult,
          moves: outputMoves,
          depth: outputMoves.length,
        },
      };
      return true;
    }
    return false;
  }

  function isEarlyStopSatisfied() {
    if (!bestSuccess) return false;
    if (bestSuccess.rank.sbLowerBound > Math.min(2, sbEntryMaxLowerBound)) return false;
    if (bestSuccess.rank.sbDifficulty > earlyStopDifficulty) return false;
    return bestSuccess.rank.moveCount <= earlyStopMoveCount;
  }

  for (let i = 0; i < variants.length && i < candidateLimit; i++) {
    if (isDeadlineExceeded(deadlineTs)) break;
    const attemptsLeft = Math.max(1, Math.min(candidateLimit, variants.length) - i);
    let candidateDeadlineTs = deadlineTs;
    if (Number.isFinite(deadlineTs)) {
      const remainingMs = deadlineTs - Date.now();
      if (remainingMs <= 0) break;
      const sliceMs = Math.max(2500, Math.floor(remainingMs / attemptsLeft));
      candidateDeadlineTs = Math.min(deadlineTs, Date.now() + sliceMs);
    }
    const variant = variants[i];
    const candidateResult = solveStage(startPattern, variant.stage, ctx, candidateDeadlineTs);
    totalNodes += candidateResult?.nodes || 0;

    if (candidateResult?.ok) {
      considerSuccess(candidateResult, i);
      if (isEarlyStopSatisfied()) {
        break;
      }
      continue;
    }

    if (!firstFailure) {
      firstFailure = candidateResult;
    }
  }

  if (!bestSuccess?.result && legacyFallbackStage && !isDeadlineExceeded(deadlineTs)) {
    const legacyResult = solveStage(startPattern, legacyFallbackStage, ctx, deadlineTs);
    totalNodes += legacyResult?.nodes || 0;
    if (legacyResult?.ok) {
      considerSuccess(legacyResult, 99);
    } else if (!firstFailure) {
      firstFailure = legacyResult;
    }
  }

  if (bestSuccess?.result) {
    return {
      ...bestSuccess.result,
      nodes: totalNodes,
    };
  }
  if (firstFailure) {
    return {
      ...firstFailure,
      nodes: Math.max(totalNodes, firstFailure.nodes || 0),
    };
  }
  return {
    ok: false,
    reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
    nodes: totalNodes,
    bound: STAGE_NOT_SET,
  };
}

function solveStageByFormulaDb(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (stage.noDbMode) {
    const noDbResult = solveNoDbF2LStageUsingPairPrune(startPattern, stage, ctx, deadlineTs);
    if (noDbResult && !noDbResult.ok && String(noDbResult.reason || "").endsWith("_TIMEOUT")) {
      return noDbResult;
    }
    if (noDbResult?.ok) return noDbResult;
  }
  if (
    stage.name === "F2L" ||
    (Array.isArray(stage.formulaKeys) && stage.formulaKeys.includes("F2L"))
  ) {
    return solveWithFormulaDbF2L(startPattern, stage, ctx, deadlineTs);
  }
  if (
    stage.name === "OLL" ||
    stage.name === "PLL" ||
    stage.name === "ZBLS" ||
    stage.name === "ZBLL" ||
    stage.name === "CMLL" ||
    stage.name === "LSE"
  ) {
    return solveWithFormulaDbSingleStage(startPattern, stage, ctx, deadlineTs);
  }
  return null;
}

function solveLseReducedMoveSearch(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (stage?.name !== "LSE") return null;

  const probePattern = ctx?.solvedPattern || startPattern;
  const reducedDepthCap = Math.max(
    normalizeDepth(stage.searchMaxDepth, stage.maxDepth),
    normalizeDepth(stage.maxDepth, 20),
  );
  const reducedSearchMaxDepth = Math.max(
    1,
    Math.min(reducedDepthCap, normalizeDepth(stage.lseReducedSearchMaxDepth, 16)),
  );
  const reducedNodeLimit = normalizeDepth(
    stage.lseReducedNodeLimit,
    Math.max(200000, Math.min(normalizeDepth(stage.nodeLimit, 0) || 300000, 380000)),
  );

  function buildMoveEntries(rawTokens, fallbackTokens) {
    const tokens = normalizeSearchMoveTokens(rawTokens, fallbackTokens);
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < tokens.length; i++) {
      const move = tokens[i];
      if (!move || seen.has(move)) continue;
      if (!tryApplyAlg(probePattern, move)) continue;
      seen.add(move);
      entries.push({
        move,
        face: move.charAt(0),
        axis: getMoveAxisGroup(move),
      });
    }
    return entries;
  }

  function runReducedSearch(moveEntries, searchMaxDepth, nodeLimit) {
    if (isDeadlineExceeded(deadlineTs)) {
      return {
        ok: false,
        reason: `${stage.name.toUpperCase()}_TIMEOUT`,
        nodes: 0,
        bound: STAGE_NOT_SET,
      };
    }
    const startData = startPattern.patternData;
    if (stage.isSolved(startData, ctx)) {
      return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
    }
    const startStateKey = stage.key(startData);
    const moveSignature = moveEntries.map((entry) => entry.move).join("|");
    const continuation =
      stage.__continuation && typeof stage.__continuation === "object" ? stage.__continuation : null;
    const canResumeContinuation =
      continuation?.type === "lse-reduced" &&
      continuation.startStateKey === startStateKey &&
      continuation.moveSignature === moveSignature &&
      continuation.heuristicCache instanceof Map &&
      continuation.failCache instanceof Map &&
      continuation.bestSeenDepthByState instanceof Map;

    const heuristicCache = canResumeContinuation ? continuation.heuristicCache : new Map();
    const failCache = canResumeContinuation ? continuation.failCache : new Map();
    const bestSeenDepthByState = canResumeContinuation ? continuation.bestSeenDepthByState : new Map();
    const goalMacroEnabled = stage.lseReducedGoalMacroEnabled !== false;
    const goalMacroDepth = Math.max(2, normalizeDepth(stage.lseReducedGoalMacroDepth, 9));
    const goalMacroNodeLimit = Math.max(
      1000,
      normalizeDepth(stage.lseReducedGoalMacroNodeLimit, 420000),
    );
    const goalMacroMaxTailLength = Math.max(
      2,
      normalizeDepth(stage.lseReducedGoalMacroMaxTailLength, goalMacroDepth),
    );
    const goalMacroTable = goalMacroEnabled
      ? getGoalMacroTableByMoveEntries(
          ctx,
          ctx.solvedPattern || probePattern,
          moveEntries,
          (data) => stage.key(data),
          goalMacroDepth,
          goalMacroNodeLimit,
          "lseReducedGoalMacroTableCache",
        )
      : null;
    const path = [];
    let goalTailOnSuccess = null;
    let nodes = canResumeContinuation ? Math.max(0, normalizeDepth(continuation.nodes, 0)) : 0;
    let nodeLimitHit = false;
    let timedOut = false;

    function buildContinuation(nextBoundHint) {
      return {
        type: "lse-reduced",
        stageName: stage.name,
        startStateKey,
        moveSignature,
        heuristicCache,
        failCache,
        bestSeenDepthByState,
        nodes,
        nextBound: Math.max(1, Number.isFinite(nextBoundHint) ? Math.floor(nextBoundHint) : 1),
      };
    }

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

    function tryResolveWithGoalMacro(pattern, depth, currentBound) {
      if (!(goalMacroTable instanceof Map) || !goalMacroTable.size) return false;
      const stateKey = stage.key(pattern.patternData);
      const tailMoves = goalMacroTable.get(stateKey);
      if (!Array.isArray(tailMoves)) return false;
      if (!tailMoves.length) {
        if (stage.isSolved(pattern.patternData, ctx)) {
          goalTailOnSuccess = [];
          return true;
        }
        return false;
      }
      if (tailMoves.length > goalMacroMaxTailLength) return false;
      if (depth + tailMoves.length > currentBound) return false;
      let workingPattern = pattern;
      for (let i = 0; i < tailMoves.length; i++) {
        try {
          workingPattern = workingPattern.applyMove(tailMoves[i]);
        } catch (_) {
          return false;
        }
      }
      if (!stage.isSolved(workingPattern.patternData, ctx)) return false;
      goalTailOnSuccess = tailMoves.slice();
      return true;
    }

    function dfs(pattern, depth, currentBound, lastFace, lastAxis, presetHeuristic = null) {
      if ((nodes & 255) === 0 && isDeadlineExceeded(deadlineTs)) {
        timedOut = true;
        return Infinity;
      }
      if (timedOut) return Infinity;
      const data = pattern.patternData;
      if (stage.isSolved(data, ctx)) {
        goalTailOnSuccess = [];
        return true;
      }
      if (typeof stage.prune === "function" && stage.prune(data, depth, currentBound, ctx)) {
        return Infinity;
      }

      const h = Number.isFinite(presetHeuristic) ? Math.floor(presetHeuristic) : heuristic(data);
      const f = depth + h;
      if (f > currentBound) return f;
      if (tryResolveWithGoalMacro(pattern, depth, currentBound)) {
        return true;
      }

      const remaining = currentBound - depth;
      const stateKey = stage.key(data);
      const failKey = `${stateKey}|${lastFace}`;
      const bestSeenDepth = bestSeenDepthByState.get(failKey);
      if (Number.isFinite(bestSeenDepth) && bestSeenDepth <= depth) return Infinity;
      if (bestSeenDepthByState.size > FAIL_CACHE_LIMIT * 2) bestSeenDepthByState.clear();
      bestSeenDepthByState.set(failKey, depth);
      const seenMask = failCache.get(failKey) || 0;
      const bit = 1 << Math.min(remaining, 30);
      if (seenMask & bit) return Infinity;

      let minNext = Infinity;
      const shouldOrderMoves =
        stage.enableMoveOrdering === true &&
        moveEntries.length > 6 &&
        depth <= normalizeDepth(stage.lseReducedMoveOrderingDepth, 7);

      if (shouldOrderMoves) {
        const candidates = [];
        for (let i = 0; i < moveEntries.length; i++) {
          if (timedOut) return Infinity;
          if (nodeLimit > 0 && nodes >= nodeLimit) {
            nodeLimitHit = true;
            return Infinity;
          }
          const entry = moveEntries[i];
          if (entry.face === lastFace) continue;
          if (lastAxis && entry.axis === lastAxis && entry.face < lastFace) continue;
          nodes += 1;

          let nextPattern = null;
          try {
            nextPattern = pattern.applyMove(entry.move);
          } catch (_) {
            continue;
          }

          const nextH = heuristic(nextPattern.patternData);
          const nextF = depth + 1 + nextH;
          if (nextF > currentBound) {
            if (nextF < minNext) minNext = nextF;
            continue;
          }
          candidates.push({
            entry,
            nextPattern,
            nextH,
          });
        }

        candidates.sort(
          (a, b) =>
            a.nextH - b.nextH ||
            (a.entry.move < b.entry.move ? -1 : a.entry.move > b.entry.move ? 1 : 0),
        );
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const res = dfs(
            candidate.nextPattern,
            depth + 1,
            currentBound,
            candidate.entry.face,
            candidate.entry.axis,
            candidate.nextH,
          );
          if (res === true) {
            path.push(candidate.entry.move);
            return true;
          }
          if (res < minNext) minNext = res;
        }
      } else {
        for (let i = 0; i < moveEntries.length; i++) {
          if (timedOut) return Infinity;
          if (nodeLimit > 0 && nodes >= nodeLimit) {
            nodeLimitHit = true;
            return Infinity;
          }
          const entry = moveEntries[i];
          if (entry.face === lastFace) continue;
          if (lastAxis && entry.axis === lastAxis && entry.face < lastFace) continue;
          nodes += 1;

          let nextPattern = null;
          try {
            nextPattern = pattern.applyMove(entry.move);
          } catch (_) {
            continue;
          }

          const nextH = heuristic(nextPattern.patternData);
          const nextF = depth + 1 + nextH;
          if (nextF > currentBound) {
            if (nextF < minNext) minNext = nextF;
            continue;
          }
          const res = dfs(
            nextPattern,
            depth + 1,
            currentBound,
            entry.face,
            entry.axis,
            nextH,
          );
          if (res === true) {
            path.push(entry.move);
            return true;
          }
          if (res < minNext) minNext = res;
        }
      }

      if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
      failCache.set(failKey, seenMask | bit);
      return minNext;
    }

    let bound = Math.max(
      canResumeContinuation ? normalizeDepth(continuation.nextBound, 1) : heuristic(startData),
      1,
    );
    while (bound <= searchMaxDepth) {
      if (isDeadlineExceeded(deadlineTs)) {
        timedOut = true;
        break;
      }
      if (nodeLimitHit) break;
      path.length = 0;
      goalTailOnSuccess = null;
      const res = dfs(startPattern, 0, bound, "", "");
      if (res === true) {
        path.reverse();
        const fullMoves =
          Array.isArray(goalTailOnSuccess) && goalTailOnSuccess.length
            ? path.concat(goalTailOnSuccess)
            : path.slice();
        return {
          ok: true,
          moves: fullMoves,
          depth: fullMoves.length,
          nodes,
          bound,
        };
      }
      if (!Number.isFinite(res)) break;
      bound = res;
    }

    return nodeLimitHit
      ? {
          ok: false,
          reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
          nodes,
          bound: STAGE_NOT_SET,
          __continuation: buildContinuation(bound),
        }
      : timedOut
        ? {
            ok: false,
            reason: `${stage.name.toUpperCase()}_TIMEOUT`,
            nodes,
            bound: STAGE_NOT_SET,
            __continuation: buildContinuation(bound),
          }
        : {
            ok: false,
            reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
            nodes,
            bound: STAGE_NOT_SET,
            __continuation: buildContinuation(bound),
          };
  }

  const primaryMoves = buildMoveEntries(stage.lseReducedMoveSet, LSE_REDUCED_PRIMARY_MOVES);
  if (!primaryMoves.length) return null;

  const primaryResult = runReducedSearch(primaryMoves, reducedSearchMaxDepth, reducedNodeLimit);
  if (!primaryResult || primaryResult.ok) return primaryResult;
  const primaryTimedOut = String(primaryResult.reason || "").endsWith("_TIMEOUT");

  if (stage.lseReducedExtended === false) return primaryResult;
  const extendedMoves = buildMoveEntries(
    stage.lseReducedExtendedMoveSet,
    LSE_REDUCED_EXTENDED_MOVES,
  );
  if (!extendedMoves.length) return primaryResult;

  let sameMoveSet = extendedMoves.length === primaryMoves.length;
  if (sameMoveSet) {
    for (let i = 0; i < extendedMoves.length; i++) {
      if (extendedMoves[i].move !== primaryMoves[i].move) {
        sameMoveSet = false;
        break;
      }
    }
  }
  if (sameMoveSet) return primaryResult;

  const extendedSearchMaxDepth = Math.max(
    reducedSearchMaxDepth,
    Math.min(
      reducedDepthCap,
      normalizeDepth(stage.lseReducedExtendedSearchMaxDepth, reducedSearchMaxDepth + 1),
    ),
  );
  const extendedNodeLimit = Math.max(
    reducedNodeLimit,
    normalizeDepth(stage.lseReducedExtendedNodeLimit, Math.floor(reducedNodeLimit * 1.35)),
  );
  const extendedResult = runReducedSearch(
    extendedMoves,
    extendedSearchMaxDepth,
    extendedNodeLimit,
  );
  if (!extendedResult) return primaryResult;
  if (!extendedResult.ok && primaryTimedOut && String(extendedResult.reason || "").endsWith("_TIMEOUT")) {
    return {
      ...extendedResult,
      nodes: Math.max(extendedResult.nodes || 0, primaryResult.nodes || 0),
    };
  }
  return {
    ...extendedResult,
    nodes: (extendedResult.nodes || 0) + (primaryResult.nodes || 0),
  };
}

function solveStage(startPattern, stage, ctx, deadlineTs = Infinity) {
  if (isDeadlineExceeded(deadlineTs)) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_TIMEOUT`,
      nodes: 0,
      bound: STAGE_NOT_SET,
    };
  }
  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  let preSearchNodes = 0;
  const resumeContinuation =
    stage.__resumeFromContinuation === true && stage.__continuation && typeof stage.__continuation === "object"
      ? stage.__continuation
      : null;
  const resumeContinuationType = String(resumeContinuation?.type || "");
  const skipFormulaDbForResume =
    resumeContinuation &&
    (resumeContinuationType === "roux-sb" ||
      resumeContinuationType === "lse-reduced" ||
      resumeContinuationType === "stage-ida");
  const skipLseReducedForResume = resumeContinuation && resumeContinuationType === "stage-ida";

  if (typeof stage.customSearch === "function") {
    const customResult = stage.customSearch(startPattern, stage, ctx, deadlineTs);
    if (customResult?.ok) {
      return customResult;
    }
    if (customResult) {
      preSearchNodes += customResult.nodes || 0;
      const allowFallback = stage.customSearchFallback === "continue";
      if (!allowFallback || String(customResult.reason || "").endsWith("_TIMEOUT")) {
        return {
          ...customResult,
          nodes: preSearchNodes,
        };
      }
    }
  }

  let formulaResult = null;
  if (stage.skipFormulaDb !== true && !skipFormulaDbForResume) {
    formulaResult = solveStageByFormulaDb(startPattern, stage, ctx, deadlineTs);
  }
  if (formulaResult?.ok) {
    return {
      ...formulaResult,
      nodes: preSearchNodes + (formulaResult.nodes || 0),
    };
  }
  if (formulaResult && !formulaResult.ok && String(formulaResult.reason || "").endsWith("_TIMEOUT")) {
    const canFallbackAfterFormulaTimeout =
      !stage.disableSearchFallback &&
      (stage.allowFormulaTimeoutFallback === true ||
        stage.name === "LSE" ||
        stage.name === "ZBLS" ||
        stage.name === "ZBLL" ||
        stage.name === "F2L" ||
        stage.name === "OLL" ||
        stage.name === "PLL" ||
        stage.name === "CMLL");
    if (!canFallbackAfterFormulaTimeout) {
      return {
        ...formulaResult,
        nodes: preSearchNodes + (formulaResult.nodes || 0),
      };
    }
  }
  preSearchNodes += formulaResult?.nodes || 0;

  if (stage.disableSearchFallback) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
      nodes: preSearchNodes,
      bound: STAGE_NOT_SET,
    };
  }

  const canRunLseReducedSearch =
    stage.name === "LSE" &&
    !stage.__lseReducedMoveSearchTried &&
    !stage.disableSearchFallback &&
    !skipLseReducedForResume;
  if (canRunLseReducedSearch) {
    const reducedResult = solveLseReducedMoveSearch(
      startPattern,
      {
        ...stage,
        __lseReducedMoveSearchTried: true,
      },
      ctx,
      deadlineTs,
    );
    if (reducedResult?.ok) {
      return {
        ...reducedResult,
        nodes: preSearchNodes + (reducedResult.nodes || 0),
      };
    }
    if (reducedResult) {
      preSearchNodes += reducedResult.nodes || 0;
      const reducedTimedOut = !reducedResult.ok && String(reducedResult.reason || "").endsWith("_TIMEOUT");
      const canFallbackAfterReducedTimeout =
        stage.name === "LSE" && stage.allowReducedTimeoutFallback !== false && !stage.disableSearchFallback;
      if (reducedTimedOut && !canFallbackAfterReducedTimeout) {
        return {
          ...reducedResult,
          nodes: preSearchNodes,
        };
      }
    }
  }

  const moveIndices =
    Array.isArray(stage.moveIndices) && stage.moveIndices.length ? stage.moveIndices : ctx.allMoveIndices;
  const stageStartStateKey = stage.key(startData);
  const moveSignature = moveIndices.join(",");
  const canResumeStageContinuation =
    resumeContinuation?.type === "stage-ida" &&
    resumeContinuation.stageName === stage.name &&
    resumeContinuation.startStateKey === stageStartStateKey &&
    resumeContinuation.moveSignature === moveSignature &&
    resumeContinuation.heuristicCache instanceof Map &&
    resumeContinuation.failCache instanceof Map &&
    resumeContinuation.bestSeenDepthByState instanceof Map;

  const heuristicCache = canResumeStageContinuation ? resumeContinuation.heuristicCache : new Map();
  const failCache = canResumeStageContinuation ? resumeContinuation.failCache : new Map();
  const bestSeenDepthByState = canResumeStageContinuation ? resumeContinuation.bestSeenDepthByState : new Map();
  const path = [];
  let nodes = canResumeStageContinuation ? Math.max(0, normalizeDepth(resumeContinuation.nodes, 0)) : 0;
  let nodeLimitHit = false;
  let timedOut = false;
  const nodeLimit = Number.isFinite(stage.nodeLimit) ? stage.nodeLimit : 0;
  const searchMaxDepth = Number.isFinite(stage.searchMaxDepth) ? stage.searchMaxDepth : stage.maxDepth;
  const movePriorityByIndex =
    stage.movePriorityByIndex instanceof Int8Array ? stage.movePriorityByIndex : null;

  function buildStageContinuation(nextBoundHint) {
    return {
      type: "stage-ida",
      stageName: stage.name,
      startStateKey: stageStartStateKey,
      moveSignature,
      heuristicCache,
      failCache,
      bestSeenDepthByState,
      nodes,
      nextBound: Math.max(
        1,
        Number.isFinite(nextBoundHint)
          ? Math.floor(nextBoundHint)
          : Math.max(1, normalizeDepth(stage.searchMaxDepth, stage.maxDepth)),
      ),
    };
  }

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

  let bound = Math.max(
    canResumeStageContinuation ? normalizeDepth(resumeContinuation.nextBound, 1) : heuristic(startData),
    1,
  );

  function dfs(pattern, depth, currentBound, lastFace, presetHeuristic = null) {
    if ((nodes & 511) === 0 && isDeadlineExceeded(deadlineTs)) {
      timedOut = true;
      return Infinity;
    }
    if (timedOut) return Infinity;
    const data = pattern.patternData;
    if (stage.isSolved(data, ctx)) return true;
    if (typeof stage.prune === "function" && stage.prune(data, depth, currentBound, ctx)) {
      return Infinity;
    }
    const h = Number.isFinite(presetHeuristic) ? Math.floor(presetHeuristic) : heuristic(data);
    const f = depth + h;
    if (f > currentBound) return f;

    const remaining = currentBound - depth;
    const stateKey = stage.key(data);
    const failKey = `${stateKey}|${lastFace}`;
    const bestSeenDepth = bestSeenDepthByState.get(failKey);
    if (Number.isFinite(bestSeenDepth) && bestSeenDepth <= depth) return Infinity;
    if (bestSeenDepthByState.size > FAIL_CACHE_LIMIT * 2) bestSeenDepthByState.clear();
    bestSeenDepthByState.set(failKey, depth);
    const seenMasks = failCache.get(stateKey);
    const seenMask = seenMasks && seenMasks.length > lastFace ? seenMasks[lastFace] || 0 : 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    const shouldOrderMoves =
      stage.enableMoveOrdering === true &&
      moveIndices.length > 6 &&
      depth <= normalizeDepth(stage.moveOrderingMaxDepth, 7);
    let minNext = Infinity;
    if (shouldOrderMoves) {
      const candidates = [];
      for (let i = 0; i < moveIndices.length; i++) {
        if (timedOut) return Infinity;
        if (nodeLimit > 0 && nodes >= nodeLimit) {
          nodeLimitHit = true;
          return Infinity;
        }
        const moveIndex = moveIndices[i];
        const face = ctx.moveFace[moveIndex];
        if (lastFace !== NO_FACE_INDEX) {
          if (face === lastFace) continue;
          if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        }
        nodes += 1;
        const nextPattern = pattern.applyMove(MOVE_NAMES[moveIndex]);
        const nextH = heuristic(nextPattern.patternData);
        const nextF = depth + 1 + nextH;
        if (nextF > currentBound) {
          if (nextF < minNext) minNext = nextF;
          continue;
        }
        candidates.push({
          moveIndex,
          face,
          nextPattern,
          nextH,
        });
      }
      candidates.sort((a, b) => {
        if (a.nextH !== b.nextH) return a.nextH - b.nextH;
        if (movePriorityByIndex) {
          const ap = movePriorityByIndex[a.moveIndex] || 0;
          const bp = movePriorityByIndex[b.moveIndex] || 0;
          if (ap !== bp) return ap - bp;
        }
        return a.moveIndex - b.moveIndex;
      });
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const res = dfs(
          candidate.nextPattern,
          depth + 1,
          currentBound,
          candidate.face,
          candidate.nextH,
        );
        if (res === true) {
          path.push(candidate.moveIndex);
          return true;
        }
        if (res < minNext) minNext = res;
      }
    } else {
      for (let i = 0; i < moveIndices.length; i++) {
        if (timedOut) return Infinity;
        if (nodeLimit > 0 && nodes >= nodeLimit) {
          nodeLimitHit = true;
          return Infinity;
        }
        const moveIndex = moveIndices[i];
        const face = ctx.moveFace[moveIndex];
        if (lastFace !== NO_FACE_INDEX) {
          if (face === lastFace) continue;
          if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        }
        nodes += 1;
        const nextPattern = pattern.applyMove(MOVE_NAMES[moveIndex]);
        const nextH = heuristic(nextPattern.patternData);
        const nextF = depth + 1 + nextH;
        if (nextF > currentBound) {
          if (nextF < minNext) minNext = nextF;
          continue;
        }
        const res = dfs(nextPattern, depth + 1, currentBound, face, nextH);
        if (res === true) {
          path.push(moveIndex);
          return true;
        }
        if (res < minNext) minNext = res;
      }
    }

    if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
    let nextSeenMasks = failCache.get(stateKey);
    if (!(nextSeenMasks && nextSeenMasks.length > NO_FACE_INDEX)) {
      nextSeenMasks = new Uint32Array(NO_FACE_INDEX + 1);
      failCache.set(stateKey, nextSeenMasks);
    }
    nextSeenMasks[lastFace] = seenMask | bit;
    return minNext;
  }

  while (bound <= searchMaxDepth) {
    if (isDeadlineExceeded(deadlineTs)) {
      timedOut = true;
      break;
    }
    if (nodeLimitHit) break;
    path.length = 0;
    bestSeenDepthByState.clear();
    const res = dfs(startPattern, 0, bound, NO_FACE_INDEX);
    if (res === true) {
      path.reverse();
      return {
        ok: true,
        moves: path.map((idx) => MOVE_NAMES[idx]),
        depth: path.length,
        nodes: nodes + preSearchNodes,
        bound,
      };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  const baseFailure = nodeLimitHit
    ? {
        ok: false,
        reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
        nodes: nodes + preSearchNodes,
        bound: STAGE_NOT_SET,
        __continuation: buildStageContinuation(bound),
      }
    : timedOut
      ? {
          ok: false,
          reason: `${stage.name.toUpperCase()}_TIMEOUT`,
          nodes: nodes + preSearchNodes,
          bound: STAGE_NOT_SET,
          __continuation: buildStageContinuation(bound),
        }
    : {
        ok: false,
        reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
        nodes: nodes + preSearchNodes,
        bound: STAGE_NOT_SET,
        __continuation: buildStageContinuation(bound),
      };

  const canRelaxSbSearch =
    stage.name === "SB" &&
    !stage.__relaxedSbSearch &&
    !stage.disableSearchFallback &&
    !timedOut;
  if (canRelaxSbSearch) {
    const relaxedSbStage = {
      ...stage,
      __resumeFromContinuation: false,
      __continuation: null,
      __relaxedSbSearch: true,
      sbLockedPairMask: 0,
      searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 2,
      nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 560000),
      formulaMaxAttempts: Math.max(
        normalizeDepth(stage.formulaMaxAttempts, 0),
        320000,
      ),
    };
    const relaxedSbResult = solveStage(startPattern, relaxedSbStage, ctx, deadlineTs);
    if (relaxedSbResult?.ok) return relaxedSbResult;
    const relaxedNodes = relaxedSbResult?.nodes || 0;
    if (relaxedNodes > baseFailure.nodes) baseFailure.nodes = relaxedNodes;
  }

  const relaxedSearchPass = normalizeDepth(stage.__relaxedSearchPass, 0);
  const canRelaxSearch =
    (stage.name === "ZBLS" || stage.name === "ZBLL") &&
    relaxedSearchPass < 2 &&
    !stage.disableSearchFallback;
  if (canRelaxSearch) {
    const nextRelaxedPass = relaxedSearchPass + 1;
    const relaxedBaseMoveIndices =
      Array.isArray(stage.__relaxedBaseMoveIndices) && stage.__relaxedBaseMoveIndices.length
        ? stage.__relaxedBaseMoveIndices
        : Array.isArray(stage.moveIndices) && stage.moveIndices.length
          ? stage.moveIndices
          : ctx.noDMoveIndices;
    const relaxedStage = {
      ...stage,
      __resumeFromContinuation: false,
      __continuation: null,
      __relaxedSearchPass: nextRelaxedPass,
      __relaxedSearchTried: nextRelaxedPass >= 2,
      __relaxedBaseMoveIndices: relaxedBaseMoveIndices,
      // Relaxed ZB passes should spend time on broadened search, not re-running the same formula scan.
      skipFormulaDb: true,
      // Last-stage ZB failures are usually limit-bound; escalate in two distinct passes.
      moveIndices: nextRelaxedPass === 1 ? ctx.allMoveIndices : relaxedBaseMoveIndices,
      searchMaxDepth:
        normalizeDepth(stage.searchMaxDepth, stage.maxDepth) +
        (stage.name === "ZBLS"
          ? nextRelaxedPass === 1
            ? 2
            : 3
          : nextRelaxedPass === 1
            ? 1
            : 2),
      nodeLimit: Math.max(
        normalizeDepth(stage.nodeLimit, 0),
        stage.name === "ZBLS"
          ? nextRelaxedPass === 1
            ? 900000
            : 1500000
          : nextRelaxedPass === 1
            ? 700000
            : 1200000,
      ),
      formulaAttemptLimit: Math.max(
        normalizeDepth(stage.formulaAttemptLimit, 0),
        stage.name === "ZBLS"
          ? nextRelaxedPass === 1
            ? 70000
            : 130000
          : nextRelaxedPass === 1
            ? 90000
            : 150000,
      ),
    };
    const relaxedResult = solveStage(startPattern, relaxedStage, ctx, deadlineTs);
    if (relaxedResult?.ok) return relaxedResult;
    const relaxedNodes = relaxedResult?.nodes || 0;
    if (relaxedNodes > baseFailure.nodes) baseFailure.nodes = relaxedNodes;
  }

  const canRunZbQualityFallback =
    (stage.name === "ZBLS" || stage.name === "ZBLL") &&
    !stage.__zbSecondaryAttempted &&
    !stage.disableSearchFallback;
  if (canRunZbQualityFallback) {
    const isZblsStage = stage.name === "ZBLS";
    const secondaryStage = {
      ...stage,
      __resumeFromContinuation: false,
      __continuation: null,
      __zbSecondaryAttempted: true,
      moveIndices: ctx.allMoveIndices,
      searchMaxDepth:
        normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + (isZblsStage ? 2 : 1),
      nodeLimit: Math.max(
        normalizeDepth(stage.nodeLimit, 0),
        isZblsStage ? 3000000 : 3400000,
      ),
      formulaAttemptLimit: Math.max(
        normalizeDepth(stage.formulaAttemptLimit, 0),
        isZblsStage ? 300000 : 380000,
      ),
    };
    const secondaryResult = solveStage(startPattern, secondaryStage, ctx, deadlineTs);
    if (secondaryResult?.ok) return secondaryResult;
    if (secondaryResult?.nodes > baseFailure.nodes) {
      baseFailure.nodes = secondaryResult.nodes;
    }

    const canRunZbEmergencyFallback =
      !stage.__zbEmergencyAttempted &&
      !stage.disableSearchFallback;
    if (canRunZbEmergencyFallback) {
      const emergencyStage = {
        ...stage,
        __resumeFromContinuation: false,
        __continuation: null,
        __zbSecondaryAttempted: true,
        __zbEmergencyAttempted: true,
        skipFormulaDb: true,
        moveIndices: ctx.allMoveIndices,
        searchMaxDepth:
          normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + (isZblsStage ? 3 : 2),
        nodeLimit: Math.max(
          normalizeDepth(stage.nodeLimit, 0),
          isZblsStage ? 4200000 : 5000000,
        ),
        formulaAttemptLimit: Math.max(
          normalizeDepth(stage.formulaAttemptLimit, 0),
          isZblsStage ? 340000 : 460000,
        ),
      };
      const emergencyResult = solveStage(startPattern, emergencyStage, ctx, deadlineTs);
      if (emergencyResult?.ok) return emergencyResult;
      if (emergencyResult?.nodes > baseFailure.nodes) {
        baseFailure.nodes = emergencyResult.nodes;
      }
      return emergencyResult || secondaryResult || baseFailure;
    }

    return secondaryResult || baseFailure;
  }

  const canRunLseQualityFallback =
    stage.name === "LSE" &&
    stage.secondaryLseQualityFallback !== false &&
    !stage.__lseSecondaryAttempted &&
    !stage.disableSearchFallback;
  if (canRunLseQualityFallback) {
    const secondaryStage = {
      ...stage,
      __resumeFromContinuation: false,
      __continuation: null,
      __lseSecondaryAttempted: true,
      formulaKeys:
        Array.isArray(stage.secondaryFormulaKeys) && stage.secondaryFormulaKeys.length
          ? stage.secondaryFormulaKeys
          : stage.formulaKeys,
      moveIndices:
        Array.isArray(stage.secondaryMoveIndices) && stage.secondaryMoveIndices.length
          ? stage.secondaryMoveIndices
          : stage.moveIndices,
      formulaAttemptLimit: Math.max(
        normalizeDepth(stage.formulaAttemptLimit, 0),
        normalizeDepth(stage.secondaryFormulaAttemptLimit, 0),
      ),
      searchMaxDepth: Math.max(
        normalizeDepth(stage.searchMaxDepth, stage.maxDepth),
        normalizeDepth(stage.secondarySearchMaxDepth, stage.maxDepth),
      ),
      nodeLimit: Math.max(
        normalizeDepth(stage.nodeLimit, 0),
        normalizeDepth(stage.secondaryNodeLimit, 0),
      ),
    };
    const secondaryResult = solveStage(startPattern, secondaryStage, ctx, deadlineTs);
    if (secondaryResult?.ok) return secondaryResult;
    if (secondaryResult?.nodes > baseFailure.nodes) {
      baseFailure.nodes = secondaryResult.nodes;
    }

    const canRunLseEmergencyFallback =
      stage.name === "LSE" &&
      !stage.__lseEmergencyAttempted &&
      !stage.disableSearchFallback;
    if (canRunLseEmergencyFallback) {
      const emergencyStage = {
        ...stage,
        __resumeFromContinuation: false,
        __continuation: null,
        __lseEmergencyAttempted: true,
        __lseSecondaryAttempted: true,
        secondaryLseQualityFallback: false,
        formulaKeys: ["LSE", "PLL"],
        moveIndices:
          Array.isArray(stage.secondaryMoveIndices) && stage.secondaryMoveIndices.length
            ? stage.secondaryMoveIndices
            : ctx.allMoveIndices,
        formulaAttemptLimit: Math.max(
          normalizeDepth(stage.formulaAttemptLimit, 0),
          normalizeDepth(stage.secondaryFormulaAttemptLimit, 0),
          360000,
        ),
        searchMaxDepth: Math.max(
          normalizeDepth(stage.searchMaxDepth, stage.maxDepth),
          normalizeDepth(stage.secondarySearchMaxDepth, stage.maxDepth),
          16,
        ),
        nodeLimit: Math.max(
          normalizeDepth(stage.nodeLimit, 0),
          normalizeDepth(stage.secondaryNodeLimit, 0),
          2200000,
        ),
        lseReducedSearchMaxDepth: Math.max(normalizeDepth(stage.lseReducedSearchMaxDepth, 0), 18),
        lseReducedNodeLimit: Math.max(normalizeDepth(stage.lseReducedNodeLimit, 0), 1400000),
        lseReducedExtendedSearchMaxDepth: Math.max(
          normalizeDepth(stage.lseReducedExtendedSearchMaxDepth, 0),
          20,
        ),
        lseReducedExtendedNodeLimit: Math.max(
          normalizeDepth(stage.lseReducedExtendedNodeLimit, 0),
          2800000,
        ),
      };
      const emergencyResult = solveStage(startPattern, emergencyStage, ctx, deadlineTs);
      if (emergencyResult?.ok) return emergencyResult;
      if (emergencyResult?.nodes > baseFailure.nodes) {
        baseFailure.nodes = emergencyResult.nodes;
      }
      return emergencyResult || secondaryResult || baseFailure;
    }

    // Secondary LSE fallback already includes its own relaxed search path.
    // Avoid duplicating deep LSE retries in the outer call.
    return secondaryResult || baseFailure;
  }

  const canRelaxRouxLastLayerSearch =
    (stage.name === "CMLL" || stage.name === "LSE") &&
    !stage.__relaxedRouxSearchTried &&
    !stage.disableSearchFallback &&
    !timedOut;
  if (canRelaxRouxLastLayerSearch) {
    const relaxedRouxStage = {
      ...stage,
      __resumeFromContinuation: false,
      __continuation: null,
      __relaxedRouxSearchTried: true,
      searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
      nodeLimit: Math.max(
        normalizeDepth(stage.nodeLimit, 0),
        stage.name === "CMLL" ? 900000 : 1300000,
      ),
      formulaAttemptLimit: Math.max(
        normalizeDepth(stage.formulaAttemptLimit, 0),
        stage.name === "CMLL" ? 220000 : 280000,
      ),
    };
    const relaxedRouxResult = solveStage(startPattern, relaxedRouxStage, ctx, deadlineTs);
    if (relaxedRouxResult?.ok) return relaxedRouxResult;
    const relaxedNodes = relaxedRouxResult?.nodes || 0;
    if (relaxedNodes > baseFailure.nodes) baseFailure.nodes = relaxedNodes;
  }

  return baseFailure;
}

export async function solve3x3StrictCfopFromPattern(pattern, options = {}) {
  const ctx = await getCfopContext();
  const solveDeadlineTs = normalizeDeadlineTs(options.deadlineTs);
  const enableCfopStageRecovery = options.enableCfopStageRecovery === true;
  const recoveryGraceMs = normalizeDepth(options.recoveryGraceMs, enableCfopStageRecovery ? 25000 : 0);
  const getRecoveryDeadlineTs = () =>
    Number.isFinite(solveDeadlineTs) ? Math.max(solveDeadlineTs, Date.now() + recoveryGraceMs) : solveDeadlineTs;
  const solveMode = normalizeSolveMode(options.mode);
  const crossFailureStageName =
    solveMode === "roux" ? "FB" : solveMode === "zb" ? "XCross" : "Cross";
  const modeProfile = getCfopProfile(solveMode);
  const crossColorRaw = normalizeCrossColor(options.crossColor);
  const crossStageLabel = getCrossStageLabel(crossColorRaw);
  const crossRotationCandidates = getCrossRotationCandidates(crossColorRaw);
  const colorNeutralRotationCandidates = crossRotationCandidates.filter(Boolean);
  const allowRouxOrientationSweep = options.rouxOrientationSweep !== false;
  if (solveMode === "roux" && allowRouxOrientationSweep && !options.__rouxOrientationApplied) {
    const onStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;
    const sweepTriggerMoveCount = normalizeDepth(options.rouxSweepTriggerMoveCount, 48);
    const sweepStopMoveCount = normalizeDepth(options.rouxSweepStopMoveCount, 44);
    const sweepMaxChecks = normalizeNonNegativeDepth(options.rouxSweepMaxChecks, 3);
    const defaultRouxSweepCandidates =
      crossColorRaw === "D" ? ROUX_ORIENTATION_SWEEP_CANDIDATES : ROUX_COLOR_LOCKED_SWEEP_CANDIDATES;
    const customCandidates =
      Array.isArray(options.rouxOrientationCandidates) && options.rouxOrientationCandidates.length
        ? options.rouxOrientationCandidates
        : defaultRouxSweepCandidates;
    const orientationCandidates = [];
    const seenRotation = new Set();
    for (let i = 0; i < customCandidates.length; i++) {
      const rotationAlg = String(customCandidates[i] || "").trim();
      if (seenRotation.has(rotationAlg)) continue;
      seenRotation.add(rotationAlg);
      orientationCandidates.push(rotationAlg);
    }
    if (!seenRotation.has("")) {
      orientationCandidates.unshift("");
    }

    const baseCrossRotations = crossRotationCandidates.length ? crossRotationCandidates : [""];
    const allRotationCandidates = [];
    const seenCombinedRotation = new Set();
    const pushRotationCandidate = (baseRotation, orientationRotation = "") => {
      const combinedRotation = joinMoves(
        simplifyMoves(splitMoves(`${String(baseRotation || "").trim()} ${String(orientationRotation || "").trim()}`)),
      );
      if (seenCombinedRotation.has(combinedRotation)) return;
      seenCombinedRotation.add(combinedRotation);
      allRotationCandidates.push(combinedRotation);
    };
    for (let i = 0; i < baseCrossRotations.length; i++) {
      pushRotationCandidate(baseCrossRotations[i], "");
    }
    const primaryBaseRotation = String(baseCrossRotations[0] || "").trim();
    for (let i = 0; i < orientationCandidates.length; i++) {
      const orientationRotation = String(orientationCandidates[i] || "").trim();
      if (!orientationRotation) continue;
      pushRotationCandidate(primaryBaseRotation, orientationRotation);
    }
    if (!allRotationCandidates.length) {
      allRotationCandidates.push("");
    }

    async function runRouxCandidate(rotationAlg, emitProgress) {
      if (isDeadlineExceeded(solveDeadlineTs)) {
        return {
          ok: false,
          reason: "ROUX_TIMEOUT",
          stage: "FB",
          nodes: 0,
        };
      }
      const transformedPattern = rotationAlg
        ? transformPatternForCrossColor(pattern, ctx.solvedPattern, rotationAlg)
        : pattern;
      if (!transformedPattern) {
        return {
          ok: false,
          reason: "CROSS_COLOR_TRANSFORM_FAILED",
          stage: "FB",
          nodes: 0,
        };
      }
      const candidateResult = await solve3x3StrictCfopFromPattern(transformedPattern, {
        ...options,
        deadlineTs: solveDeadlineTs,
        crossColor: "D",
        __rouxOrientationApplied: true,
        __colorNeutralApplied: true,
        onStageUpdate: emitProgress ? onStageUpdate : undefined,
      });
      if (!candidateResult?.ok) return candidateResult;

      const setupMoves = splitMoves(rotationAlg);
      const cleanupMoves = splitMoves(invertAlg(rotationAlg));
      const coreMoves = splitMoves(candidateResult.solution || "");
      let fullMoves = simplifyMoves(setupMoves.concat(coreMoves, cleanupMoves));
      fullMoves = maybePostOptimizeMoves(pattern, fullMoves, solveMode, options, ctx);
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

      const finalPattern = fullSolution ? pattern.applyAlg(fullSolution) : pattern;
      if (!isStrictSolvedPattern(finalPattern, finalPattern.patternData, ctx)) {
        return {
          ok: false,
          reason: "FINAL_STATE_NOT_SOLVED",
          stage: "LSE",
          nodes: candidateResult.nodes || 0,
        };
      }

      return {
        ...candidateResult,
        solution: fullSolution,
        moveCount: fullMoves.length,
        stages,
        solutionDisplay: formatStageDisplay(stages, fullSolution),
      };
    }

    const baseRotationAlg = allRotationCandidates[0] || "";
    const extraRotationCandidates = allRotationCandidates.slice(1);
    const mandatoryCrossChecks = Math.max(0, Math.min(baseCrossRotations.length - 1, extraRotationCandidates.length));
    let bestResult = await runRouxCandidate(baseRotationAlg, true);
    if (!bestResult?.ok) {
      let firstFailure = bestResult || null;
      for (let i = 0; i < mandatoryCrossChecks; i++) {
        if (isDeadlineExceeded(solveDeadlineTs)) {
          return {
            ok: false,
            reason: "ROUX_TIMEOUT",
            stage: "FB",
            nodes: firstFailure?.nodes || 0,
          };
        }
        const rotationAlg = extraRotationCandidates[i];
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: `Roux Base Color ${i + 2}/${baseCrossRotations.length}`,
            reason: rotationAlg || "identity",
          });
        }
        const candidate = await runRouxCandidate(rotationAlg, false);
        if (candidate?.ok) {
          bestResult = candidate;
          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: `Roux Base Color ${i + 2}/${baseCrossRotations.length}`,
            });
          }
          break;
        }
        if (!firstFailure) firstFailure = candidate;
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: `Roux Base Color ${i + 2}/${baseCrossRotations.length}`,
          });
        }
      }
      if (!bestResult?.ok) {
        return firstFailure || {
          ok: false,
          reason: "ROUX_ORIENTATION_BASE_FAILED",
          stage: "FB",
          nodes: 0,
        };
      }
    }

    if (bestResult.moveCount <= sweepStopMoveCount || bestResult.moveCount <= sweepTriggerMoveCount) {
      return bestResult;
    }

    const sweepCandidates = extraRotationCandidates.slice(mandatoryCrossChecks);
    const checkCount = Math.min(sweepCandidates.length, sweepMaxChecks);
    for (let i = 0; i < checkCount; i++) {
      if (isDeadlineExceeded(solveDeadlineTs)) {
        return {
          ok: false,
          reason: "ROUX_TIMEOUT",
          stage: "FB",
          nodes: bestResult?.nodes || 0,
        };
      }
      const rotationAlg = sweepCandidates[i];
      if (onStageUpdate) {
        onStageUpdate({
          type: "fallback_start",
          stageName: `Roux Orientation ${i + 1}/${checkCount}`,
          reason: rotationAlg || "identity",
        });
      }
      const candidate = await runRouxCandidate(rotationAlg, false);
      if (!candidate?.ok) {
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: `Roux Orientation ${i + 1}/${checkCount}`,
          });
        }
        continue;
      }
      if (onStageUpdate) {
        onStageUpdate({
          type: "fallback_done",
          stageName: `Roux Orientation ${i + 1}/${checkCount}`,
        });
      }
      if (candidate.moveCount < bestResult.moveCount) {
        bestResult = candidate;
      }
      if (bestResult.moveCount <= sweepStopMoveCount) {
        break;
      }
    }
    return bestResult;
  }
  if (solveMode !== "roux" && !options.__colorNeutralApplied && colorNeutralRotationCandidates.length) {
    const onStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;
    let selectedRotationAlg = "";
    let childResult = null;
    let firstFailResult = null;
    for (let i = 0; i < colorNeutralRotationCandidates.length; i++) {
      if (isDeadlineExceeded(solveDeadlineTs)) {
        return {
          ok: false,
          reason: `${crossFailureStageName.toUpperCase()}_TIMEOUT`,
          stage: crossFailureStageName,
          nodes: 0,
        };
      }
      const crossRotationAlg = colorNeutralRotationCandidates[i];
      const transformedPattern = transformPatternForCrossColor(pattern, ctx.solvedPattern, crossRotationAlg);
      if (!transformedPattern) {
        if (!firstFailResult) {
          firstFailResult = {
            ok: false,
            reason: "CROSS_COLOR_TRANSFORM_FAILED",
            stage: crossFailureStageName,
            nodes: 0,
          };
        }
        continue;
      }
      const candidateResult = await solve3x3StrictCfopFromPattern(transformedPattern, {
        ...options,
        deadlineTs: solveDeadlineTs,
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
        stage: crossFailureStageName,
        nodes: 0,
      };
    }

    const setupMoves = splitMoves(selectedRotationAlg);
    const cleanupMoves = splitMoves(invertAlg(selectedRotationAlg));
    const coreMoves = splitMoves(childResult.solution || "");
    let fullMoves = simplifyMoves(setupMoves.concat(coreMoves, cleanupMoves));
    fullMoves = maybePostOptimizeMoves(pattern, fullMoves, solveMode, options, ctx);
    const fullSolution = joinMoves(fullMoves);
    const stages = Array.isArray(childResult.stages)
      ? childResult.stages.map((stage) => ({ ...stage }))
      : [];

    if (stages.length) {
      stages[0].name = getCrossLikeStageLabel(stages[0].name, crossStageLabel);
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
        stage: solveMode === "roux" ? "LSE" : solveMode === "zb" ? "ZBLL" : "PLL",
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

  const stages = getStageDefinitions(options, ctx, modeProfile, solveMode);
  for (let i = 0; i < stages.length; i++) {
    if (Array.isArray(stages[i].formulaKeys) && stages[i].formulaKeys.includes("F2L")) {
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
    if (isDeadlineExceeded(solveDeadlineTs)) {
      return {
        ok: false,
        reason: `${String(stages[i]?.name || "SOLVE").toUpperCase()}_TIMEOUT`,
        stage: stages[i]?.name || "SOLVE",
        nodes: totalNodes,
      };
    }
    let stage = stages[i];
    const stageStartedAtMs = getNowMs();
    const stageStartPattern = currentPattern;
    if (solveMode === "roux" && stage?.name === "SB") {
      const primarySolvedPairMask = getRouxPrimaryBlockMask(stageStartPattern.patternData, ctx, 2);
      if (primarySolvedPairMask) {
        stage = {
          ...stage,
          sbLockedPairMask: primarySolvedPairMask,
          sbLockPreserveDepth: normalizeDepth(options.sbLockPreserveDepth, 2),
        };
      }
    }
    const stageDisplayName = stage.displayName || stage.name;
    const stageLabel = stage.isCrossLike
      ? getCrossLikeStageLabel(stage.name, crossStageLabel)
      : stageDisplayName;
    if (onStageUpdate) {
      onStageUpdate({
        type: "stage_start",
        stageIndex: i,
        totalStages: stages.length,
        stageName: stageLabel,
      });
    }
    let stageDeadlineTs = solveDeadlineTs;
    if (Number.isFinite(solveDeadlineTs)) {
      const applyStageBudgetCap = (configuredBudgetMs) => {
        if (!Number.isFinite(configuredBudgetMs) || configuredBudgetMs <= 0) return;
        const nowTs = Date.now();
        const remainingMs = solveDeadlineTs - nowTs;
        if (remainingMs <= 0) {
          stageDeadlineTs = nowTs;
          return;
        }
        const remainingStageCount = Math.max(1, stages.length - i);
        const fairShareMs = Math.max(0, Math.floor(remainingMs / remainingStageCount));
        const softBudgetMs = Math.max(configuredBudgetMs, fairShareMs);
        stageDeadlineTs = Math.min(stageDeadlineTs, nowTs + softBudgetMs);
      };
      if (solveMode === "roux" && stage?.name === "SB") {
        const sbStageTimeBudgetMs = normalizeDepth(options.sbStageTimeBudgetMs, 30000);
        applyStageBudgetCap(sbStageTimeBudgetMs);
      } else if (solveMode === "roux" && stage?.name === "LSE") {
        const lseStageTimeBudgetMs = normalizeDepth(options.lseStageTimeBudgetMs, 35000);
        applyStageBudgetCap(lseStageTimeBudgetMs);
      } else if (solveMode === "strict" && stage?.name === "OLL") {
        const ollStageTimeBudgetMs = normalizeDepth(options.ollStageTimeBudgetMs, 22000);
        applyStageBudgetCap(ollStageTimeBudgetMs);
      } else if (solveMode === "strict" && stage?.name === "PLL") {
        const pllStageTimeBudgetMs = normalizeDepth(options.pllStageTimeBudgetMs, 26000);
        applyStageBudgetCap(pllStageTimeBudgetMs);
      } else if (solveMode === "zb" && stage?.name === "ZBLS") {
        const zblsStageTimeBudgetMs = normalizeDepth(options.zblsStageTimeBudgetMs, 30000);
        applyStageBudgetCap(zblsStageTimeBudgetMs);
      } else if (solveMode === "zb" && stage?.name === "ZBLL") {
        const zbllStageTimeBudgetMs = normalizeDepth(options.zbllStageTimeBudgetMs, 30000);
        applyStageBudgetCap(zbllStageTimeBudgetMs);
      }
    }

    let result =
      solveMode === "roux" &&
      stage?.name === "FB" &&
      options.rouxFbMultiCandidate !== false
        ? solveRouxFbWithCandidates(stageStartPattern, stage, ctx, options, stageDeadlineTs)
        : solveStage(stageStartPattern, stage, ctx, stageDeadlineTs);
    if (
      !result.ok &&
      stage?.name === "SB" &&
      result.reason === "SB_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "SB_SEARCH_LIMIT",
      };
    }
    if (
      !result.ok &&
      stage?.name === "LSE" &&
      result.reason === "LSE_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "LSE_SEARCH_LIMIT",
      };
    }
    if (
      !result.ok &&
      stage?.name === "ZBLS" &&
      result.reason === "ZBLS_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "ZBLS_SEARCH_LIMIT",
      };
    }
    if (
      !result.ok &&
      stage?.name === "ZBLL" &&
      result.reason === "ZBLL_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "ZBLL_SEARCH_LIMIT",
      };
    }
    if (
      !result.ok &&
      stage?.name === "OLL" &&
      result.reason === "OLL_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "OLL_SEARCH_LIMIT",
      };
    }
    if (
      !result.ok &&
      stage?.name === "PLL" &&
      result.reason === "PLL_TIMEOUT" &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs)
    ) {
      result = {
        ...result,
        reason: "PLL_SEARCH_LIMIT",
      };
    }
    const canRunStageBudgetRetry =
      !result.ok &&
      Number.isFinite(stageDeadlineTs) &&
      Number.isFinite(solveDeadlineTs) &&
      stageDeadlineTs < solveDeadlineTs &&
      !isDeadlineExceeded(solveDeadlineTs) &&
      ((stage?.name === "SB" && result.reason === "SB_SEARCH_LIMIT") ||
        (stage?.name === "LSE" && result.reason === "LSE_SEARCH_LIMIT") ||
        (stage?.name === "ZBLS" && result.reason === "ZBLS_SEARCH_LIMIT") ||
        (stage?.name === "ZBLL" && result.reason === "ZBLL_SEARCH_LIMIT") ||
        (stage?.name === "OLL" && result.reason === "OLL_SEARCH_LIMIT") ||
        (stage?.name === "PLL" && result.reason === "PLL_SEARCH_LIMIT"));
    if (canRunStageBudgetRetry) {
      let stageBudgetRetryMs = 0;
      if (stage?.name === "SB") {
        stageBudgetRetryMs = normalizeDepth(options.sbStageRetryTimeBudgetMs, 25000);
      } else if (stage?.name === "LSE") {
        stageBudgetRetryMs = normalizeDepth(options.lseStageRetryTimeBudgetMs, 30000);
      } else if (stage?.name === "ZBLS") {
        stageBudgetRetryMs = normalizeDepth(options.zblsStageRetryTimeBudgetMs, 35000);
      } else if (stage?.name === "ZBLL") {
        stageBudgetRetryMs = normalizeDepth(options.zbllStageRetryTimeBudgetMs, 35000);
      } else if (stage?.name === "OLL") {
        stageBudgetRetryMs = normalizeDepth(options.ollStageRetryTimeBudgetMs, 26000);
      } else if (stage?.name === "PLL") {
        stageBudgetRetryMs = normalizeDepth(options.pllStageRetryTimeBudgetMs, 32000);
      }
      if (stageBudgetRetryMs > 0) {
        const stageBudgetRetryStageName = `${stageLabel} Budget Retry`;
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: stageBudgetRetryStageName,
            reason: result.reason || `${stage.name}_SEARCH_LIMIT`,
          });
        }
        const retryStageDeadlineTs = Math.min(solveDeadlineTs, Date.now() + stageBudgetRetryMs);
        const retryContinuation =
          result && result.__continuation && typeof result.__continuation === "object"
            ? result.__continuation
            : null;
        const retryStageBase = {
          ...stage,
          __stageBudgetRetryAttempted: true,
          ...(retryContinuation
            ? {
                __continuation: retryContinuation,
                __resumeFromContinuation: true,
              }
            : {}),
        };
        const retryStage =
          stage?.name === "SB"
            ? {
                ...retryStageBase,
                searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 2200000),
                formulaMaxAttempts: Math.max(normalizeDepth(stage.formulaMaxAttempts, 0), 1400000),
              }
            : stage?.name === "LSE"
              ? {
                  ...retryStageBase,
                  searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                  nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 2200000),
                  formulaAttemptLimit: Math.max(normalizeDepth(stage.formulaAttemptLimit, 0), 360000),
                }
              : stage?.name === "ZBLS"
                ? {
                    ...retryStageBase,
                    searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                    nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 2600000),
                    formulaAttemptLimit: Math.max(normalizeDepth(stage.formulaAttemptLimit, 0), 240000),
                  }
                : stage?.name === "ZBLL"
                  ? {
                      ...retryStageBase,
                      searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                      nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 3200000),
                      formulaAttemptLimit: Math.max(normalizeDepth(stage.formulaAttemptLimit, 0), 320000),
                    }
                  : stage?.name === "OLL"
                    ? {
                        ...retryStageBase,
                        searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                        nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 2400000),
                        formulaAttemptLimit: Math.max(normalizeDepth(stage.formulaAttemptLimit, 0), 200000),
                      }
                    : stage?.name === "PLL"
                      ? {
                          ...retryStageBase,
                          searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + 1,
                          nodeLimit: Math.max(normalizeDepth(stage.nodeLimit, 0), 3400000),
                          formulaAttemptLimit: Math.max(normalizeDepth(stage.formulaAttemptLimit, 0), 320000),
                        }
                  : retryStageBase;
        let retryResult = solveStage(stageStartPattern, retryStage, ctx, retryStageDeadlineTs);
        if (
          !retryResult.ok &&
          stage?.name === "SB" &&
          retryResult.reason === "SB_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "SB_SEARCH_LIMIT",
          };
        }
        if (
          !retryResult.ok &&
          stage?.name === "LSE" &&
          retryResult.reason === "LSE_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "LSE_SEARCH_LIMIT",
          };
        }
        if (
          !retryResult.ok &&
          stage?.name === "ZBLS" &&
          retryResult.reason === "ZBLS_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "ZBLS_SEARCH_LIMIT",
          };
        }
        if (
          !retryResult.ok &&
          stage?.name === "ZBLL" &&
          retryResult.reason === "ZBLL_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "ZBLL_SEARCH_LIMIT",
          };
        }
        if (
          !retryResult.ok &&
          stage?.name === "OLL" &&
          retryResult.reason === "OLL_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "OLL_SEARCH_LIMIT",
          };
        }
        if (
          !retryResult.ok &&
          stage?.name === "PLL" &&
          retryResult.reason === "PLL_TIMEOUT" &&
          Number.isFinite(retryStageDeadlineTs) &&
          Number.isFinite(solveDeadlineTs) &&
          retryStageDeadlineTs < solveDeadlineTs &&
          !isDeadlineExceeded(solveDeadlineTs)
        ) {
          retryResult = {
            ...retryResult,
            reason: "PLL_SEARCH_LIMIT",
          };
        }
        const combinedNodes = retryContinuation
          ? Math.max(result.nodes || 0, retryResult.nodes || 0)
          : (result.nodes || 0) + (retryResult.nodes || 0);
        result = {
          ...retryResult,
          nodes: combinedNodes,
        };
        if (onStageUpdate) {
          onStageUpdate({
            type: result.ok ? "fallback_done" : "fallback_fail",
            stageName: stageBudgetRetryStageName,
          });
        }
      }
    }

    const canRunRouxSbLegacyFallback =
      !result.ok &&
      solveMode === "roux" &&
      stage?.name === "SB" &&
      options.rouxSbLegacyFallback !== false &&
      typeof stage.buildLegacyFallbackStage === "function" &&
      (String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
        String(result.reason || "").endsWith("_NOT_FOUND") ||
        String(result.reason || "").endsWith("_TIMEOUT"));
    if (canRunRouxSbLegacyFallback) {
      const fallbackStageName = "Roux SB Legacy Fallback";
      if (onStageUpdate) {
        onStageUpdate({
          type: "fallback_start",
          stageName: fallbackStageName,
          reason: result.reason || "SB_F2B_FAILED",
        });
      }
      const previousNodes = result.nodes || 0;
      const legacyStage = {
        ...stage.buildLegacyFallbackStage(),
        __rouxSbLegacyFallbackAttempted: true,
      };
      const legacyResult = solveStage(stageStartPattern, legacyStage, ctx, solveDeadlineTs);
      const combinedNodes = previousNodes + (legacyResult.nodes || 0);
      if (legacyResult?.ok) {
        result = {
          ...legacyResult,
          nodes: combinedNodes,
        };
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_done",
            stageName: fallbackStageName,
          });
        }
      } else {
        result = {
          ...result,
          nodes: combinedNodes,
        };
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: fallbackStageName,
          });
        }
      }
    }

    totalNodes += result.nodes || 0;
    if (typeof result.bound === "number" && result.bound !== STAGE_NOT_SET) {
      totalBound += result.bound;
    }
    if (!result.ok) {
      const allowRouxSbDeepRetry = options.sbDeepRetry === true;
      const allowRouxLastLayerDeepRetry = options.rouxLastLayerDeepRetry === true;
      const canAttemptRouxDeepRetry =
        solveMode === "roux" &&
        ((stage.name === "SB" && allowRouxSbDeepRetry) ||
          ((stage.name === "CMLL" || stage.name === "LSE") && allowRouxLastLayerDeepRetry)) &&
        (String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
          String(result.reason || "").endsWith("_NOT_FOUND"));
      if (canAttemptRouxDeepRetry) {
        const deepRetryStageName = `Roux ${stage.name} Deep Retry`;
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: deepRetryStageName,
            reason: result.reason || "ROUX_STAGE_FAILED",
          });
        }
        const deepRetryStage = {
          ...stage,
          __rouxDeepRetryAttempted: true,
          searchMaxDepth: normalizeDepth(stage.searchMaxDepth, stage.maxDepth) + (stage.name === "SB" ? 2 : 1),
          nodeLimit: Math.max(
            normalizeDepth(stage.nodeLimit, 0),
            stage.name === "SB" ? 2600000 : stage.name === "CMLL" ? 1400000 : 1800000,
          ),
          ...(stage.name === "SB"
            ? {
                sbLockedPairMask: 0,
                formulaMaxAttempts: Math.max(normalizeDepth(stage.formulaMaxAttempts, 0), 900000),
                formulaBeamWidth: Math.max(normalizeDepth(stage.formulaBeamWidth, 0), 12),
                formulaExpansionLimit: Math.max(normalizeDepth(stage.formulaExpansionLimit, 0), 20),
              }
            : {
                formulaAttemptLimit: Math.max(
                  normalizeDepth(stage.formulaAttemptLimit, 0),
                  stage.name === "CMLL" ? 320000 : 360000,
                ),
              }),
        };
        const deepRetryResult = solveStage(stageStartPattern, deepRetryStage, ctx, solveDeadlineTs);
        totalNodes += deepRetryResult.nodes || 0;
        if (typeof deepRetryResult.bound === "number" && deepRetryResult.bound !== STAGE_NOT_SET) {
          totalBound += deepRetryResult.bound;
        }
        if (deepRetryResult?.ok) {
          result = deepRetryResult;
          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: deepRetryStageName,
            });
          }
        } else if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: deepRetryStageName,
          });
        }
      }
    }
    if (!result.ok) {
      const allowRouxCfopStageRecovery =
        enableCfopStageRecovery && options.rouxAllowCfopStageRecovery === true;
      const recoverableRouxStage =
        stage.name === "LSE" ||
        (options.rouxRecoverAllStages === true &&
          (stage.name === "SB" || stage.name === "CMLL"));
      const canAttemptRouxSbRecovery =
        allowRouxCfopStageRecovery &&
        solveMode === "roux" &&
        recoverableRouxStage &&
        !options.__rouxSbRecoveryAttempted &&
        (String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
          String(result.reason || "").endsWith("_NOT_FOUND") ||
          String(result.reason || "").endsWith("_TIMEOUT"));
      if (canAttemptRouxSbRecovery) {
        const recoveryStageName = `Roux ${stage.name} Recovery (CFOP)`;
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: recoveryStageName,
            reason: result.reason || "ROUX_STAGE_FAILED",
          });
        }
        const recoveryResult = await solve3x3StrictCfopFromPattern(stageStartPattern, {
          ...options,
          deadlineTs: getRecoveryDeadlineTs(),
          mode: "strict",
          f2lMethod: "legacy",
          crossColor: "D",
          __colorNeutralApplied: true,
          __rouxSbRecoveryAttempted: true,
          onStageUpdate: undefined,
        });
        if (recoveryResult?.ok) {
          const recoveryMoves = simplifyMoves(splitMoves(recoveryResult.solution || ""));
          const recoveryText = joinMoves(recoveryMoves);
          if (recoveryMoves.length) {
            allMoves.push(...recoveryMoves);
            const recoveryStages = Array.isArray(recoveryResult.stages) ? recoveryResult.stages : [];
            for (let r = 0; r < recoveryStages.length; r++) {
              const entry = recoveryStages[r];
              const entryMoves = simplifyMoves(splitMoves(entry?.solution || ""));
              if (!entryMoves.length) continue;
              solvedStages.push({
                ...entry,
                name: `Roux Recovery ${entry.name || "Stage"}`,
                solution: joinMoves(entryMoves),
                moveCount: entryMoves.length,
                depth: entryMoves.length,
              });
            }
            currentPattern = currentPattern.applyAlg(recoveryText);
          }
          totalNodes += recoveryResult.nodes || 0;
          if (typeof recoveryResult.bound === "number" && recoveryResult.bound !== STAGE_NOT_SET) {
            totalBound += recoveryResult.bound;
          }
          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: recoveryStageName,
            });
          }
          break;
        }
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: recoveryStageName,
          });
        }
      }

      const normalizedF2LMethod = normalizeF2LMethod(options.f2lMethod);
      const canAttemptNoDbRecovery =
        solveMode === "strict" &&
        stage.noDbMode === true &&
        !options.__noDbStageRecoveryAttempted &&
        (normalizedF2LMethod === "hybrid" || normalizedF2LMethod === "search");
      if (canAttemptNoDbRecovery) {
        const recoveryStageName = "No-DB F2L Recovery (Legacy)";
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: recoveryStageName,
            reason: result.reason || "F2L_NO_DB_FAILED",
          });
        }
        const recoveryResult = await solve3x3StrictCfopFromPattern(stageStartPattern, {
          ...options,
          deadlineTs: getRecoveryDeadlineTs(),
          mode: "strict",
          f2lMethod: "legacy",
          crossColor: "D",
          __colorNeutralApplied: true,
          __noDbStageRecoveryAttempted: true,
          onStageUpdate: undefined,
        });
        if (recoveryResult?.ok) {
          const recoveryMoves = simplifyMoves(splitMoves(recoveryResult.solution || ""));
          const recoveryText = joinMoves(recoveryMoves);
          if (recoveryMoves.length) {
            allMoves.push(...recoveryMoves);
            const recoveryStages = Array.isArray(recoveryResult.stages) ? recoveryResult.stages : [];
            for (let r = 0; r < recoveryStages.length; r++) {
              const entry = recoveryStages[r];
              const entryMoves = simplifyMoves(splitMoves(entry?.solution || ""));
              if (!entryMoves.length) continue;
              solvedStages.push({
                ...entry,
                name: `No-DB Recovery ${entry.name || "Stage"}`,
                solution: joinMoves(entryMoves),
                moveCount: entryMoves.length,
                depth: entryMoves.length,
              });
            }
            currentPattern = currentPattern.applyAlg(recoveryText);
          }
          totalNodes += recoveryResult.nodes || 0;
          if (typeof recoveryResult.bound === "number" && recoveryResult.bound !== STAGE_NOT_SET) {
            totalBound += recoveryResult.bound;
          }
          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: recoveryStageName,
            });
          }
          break;
        }
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: recoveryStageName,
          });
        }
      }

      const allowZbCfopStageRecovery = enableCfopStageRecovery && options.zbAllowCfopStageRecovery === true;
      const canAttemptZbRecovery =
        allowZbCfopStageRecovery &&
        solveMode === "zb" &&
        (stage.name === "ZBLS" || stage.name === "ZBLL") &&
        !options.__zbRecoveryAttempted &&
        (String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
          String(result.reason || "").endsWith("_NOT_FOUND") ||
          String(result.reason || "").endsWith("_TIMEOUT"));
      if (canAttemptZbRecovery) {
        const recoveryStageName =
          stage.name === "ZBLL" ? "ZBLL Recovery (CFOP Finish)" : "ZBLS Recovery (CFOP Finish)";
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: recoveryStageName,
            reason: result.reason || `${stage.name}_FAILED`,
          });
        }

        const recoveryResult = await solve3x3StrictCfopFromPattern(stageStartPattern, {
          ...options,
          deadlineTs: getRecoveryDeadlineTs(),
          mode: "strict",
          crossColor: "D",
          __colorNeutralApplied: true,
          __zbRecoveryAttempted: true,
          onStageUpdate: undefined,
        });
        if (recoveryResult?.ok) {
          const recoveryStages = Array.isArray(recoveryResult.stages) ? recoveryResult.stages : [];
          const filteredRecoveryStages = [];
          for (let r = 0; r < recoveryStages.length; r++) {
            const entry = recoveryStages[r];
            const entryMoves = splitMoves(entry?.solution || "");
            if (!entryMoves.length) continue;
            const mappedName = r === 0 ? `ZBLS Recovery ${entry.name || "F2L"}` : entry.name;
            filteredRecoveryStages.push({
              ...entry,
              name: mappedName,
              moveCount: entryMoves.length,
              depth: entryMoves.length,
            });
          }

          const recoveryMoves = simplifyMoves(splitMoves(recoveryResult.solution || ""));
          const recoveryText = joinMoves(recoveryMoves);
          if (recoveryMoves.length) {
            allMoves.push(...recoveryMoves);
            solvedStages.push(...filteredRecoveryStages);
            currentPattern = currentPattern.applyAlg(recoveryText);
          }
          totalNodes += recoveryResult.nodes || 0;
          if (typeof recoveryResult.bound === "number" && recoveryResult.bound !== STAGE_NOT_SET) {
            totalBound += recoveryResult.bound;
          }

          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: recoveryStageName,
            });
          }
          break;
        }

        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: recoveryStageName,
          });
        }
      }

      const canAttemptRouxNoDReplay =
        solveMode === "roux" &&
        stage.name === "LSE" &&
        options.fbNoDMoves !== true &&
        !options.__rouxNoDReplayAttempted &&
        (String(result.reason || "").endsWith("_TIMEOUT") ||
          String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
          String(result.reason || "").endsWith("_NOT_FOUND"));
      if (canAttemptRouxNoDReplay) {
        const replayStageName = "Roux LSE Replay (No-D FB)";
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_start",
            stageName: replayStageName,
            reason: result.reason || "ROUX_LSE_FAILED",
          });
        }
        const replayResult = await solve3x3StrictCfopFromPattern(pattern, {
          ...options,
          deadlineTs: getRecoveryDeadlineTs(),
          fbNoDMoves: true,
          __rouxNoDReplayAttempted: true,
          __rouxOrientationApplied: true,
          onStageUpdate: undefined,
        });
        if (replayResult?.ok) {
          if (onStageUpdate) {
            onStageUpdate({
              type: "fallback_done",
              stageName: replayStageName,
            });
          }
          return {
            ...replayResult,
            source: replayResult.source || "INTERNAL_3X3_ROUX_HYBRID",
            fallbackFrom: result.reason || "LSE_FAILED",
          };
        }
        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: replayStageName,
          });
        }
      }

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
    const stageElapsedMs = Math.max(1, Math.round(getNowMs() - stageStartedAtMs));
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
            elapsedMs: stageElapsedMs,
          });
        });
      } else {
        stageEntries.push({
          name: stageLabel,
          solution: joinMoves(outputMoves),
          moveCount: outputMoves.length,
          depth: outputMoves.length,
          nodes: result.nodes,
          elapsedMs: stageElapsedMs,
        });
      }
    } else {
      stageEntries.push({
        name: stageLabel,
        solution: joinMoves(outputMoves),
        moveCount: outputMoves.length,
        depth: outputMoves.length,
        nodes: result.nodes,
        elapsedMs: stageElapsedMs,
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
        elapsedMs: stageElapsedMs,
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

  let fullMoves = simplifyMoves(allMoves);
  fullMoves = maybePostOptimizeMoves(pattern, fullMoves, solveMode, options, ctx);
  const fullSolution = joinMoves(fullMoves);
  return {
    ok: true,
    solution: fullSolution,
    solutionDisplay: formatStageDisplay(solvedStages, fullSolution),
    moveCount: fullMoves.length,
    nodes: totalNodes,
    bound: totalBound,
    source:
      solveMode === "roux"
        ? "INTERNAL_3X3_ROUX_HYBRID"
        : solveMode === "zb"
          ? "INTERNAL_3X3_CFOP_ZB_HYBRID"
          : "INTERNAL_3X3_CFOP_STRICT",
    stages: solvedStages,
  };
}
