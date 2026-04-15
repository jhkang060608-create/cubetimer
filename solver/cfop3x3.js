import { getDefaultPattern } from "./context.js";
import { MOVE_NAMES } from "./moves.js";
import { SCDB_CFOP_ALGS } from "./scdbCfopAlgs.js";
import { ZB_FORMULAS } from "./zbDataset.js";

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
  f2lFormulaMaxSteps: 12,
  f2lFormulaBeamWidth: 7,
  f2lFormulaExpansionLimit: 12,
  f2lFormulaMaxAttempts: 240000,
  // Max ms the formula beam may run before falling through to compact IDA*.
  // Compact IDA* solves in ~15-30ms, so keeping the beam budget small avoids
  // wasting 250ms when the beam fails to find a style-matched solution.
  f2lFormulaBeamBudgetMs: 50,
  f2lSearchMaxDepth: 11,
  f2lNodeLimit: 220000,
  ollMaxDepth: 22,
  pllMaxDepth: 22,
};
const FAST_CFOP_PROFILE = {
  crossMaxDepth: 7,
  f2lMaxDepth: 36,
  f2lFormulaMaxSteps: 10,
  f2lFormulaBeamWidth: 6,
  f2lFormulaExpansionLimit: 10,
  f2lFormulaMaxAttempts: 180000,
  f2lFormulaBeamBudgetMs: 30,
  f2lSearchMaxDepth: 8,
  f2lNodeLimit: 150000,
  ollMaxDepth: 22,
  pllMaxDepth: 22,
};
const F2L_STYLE_PROFILE_LEGACY = Object.freeze({
  rotationWeight: 0,
  aufWeight: 0,
  wideTurnWeight: 0,
});
const F2L_STYLE_PROFILE_PRESETS = Object.freeze({
  legacy: F2L_STYLE_PROFILE_LEGACY,
  balanced: Object.freeze({
    rotationWeight: 2,
    aufWeight: 1,
    wideTurnWeight: 1,
  }),
  "top10-mixed": Object.freeze({
    rotationWeight: 2,
    aufWeight: 1,
    wideTurnWeight: 1,
  }),
  rotationless: Object.freeze({
    rotationWeight: 5,
    aufWeight: 1,
    wideTurnWeight: 2,
  }),
  "low-auf": Object.freeze({
    rotationWeight: 1,
    aufWeight: 4,
    wideTurnWeight: 1,
  }),
  speed: Object.freeze({
    rotationWeight: 5,
    aufWeight: 1,
    wideTurnWeight: 2,
  }),
});
const DEFAULT_F2L_DOWNSTREAM_WEIGHT = 0.35;
const MAX_F2L_DOWNSTREAM_PENALTY = 24;
const MAX_F2L_ZBLL_OPPORTUNITY_BONUS = 1.6;
const MAX_F2L_MIXED_LL_SIGNAL_BONUS = 3.2;
// LL merge tuning constants (derived from tools/tune-ll-merge.mjs)
const LL_MERGE_VARIANT_WEIGHT = 2;
const LL_MERGE_CANONICAL_ALIAS_WEIGHT = 0;
const LL_MERGE_CANONICAL_BOOST = 1;
const ZBLL_CASE_LABEL_RE = /\bZBLL\b/i;
const ZBLS_CASE_LABEL_RE = /\bZBLS\b/i;
const EO_CASE_LABEL_RE = /\bEO\b/i;
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
const CROSS_COLOR_SEQUENCE = ["D", "U", "F", "B", "R", "L"];
// Per-color budget for CN cross probe; keeps total probe time bounded regardless of IDA* depth.
const CN_CROSS_PROBE_BUDGET_MS = 150;
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
const formulaListCache = new Map();
const singleStageFormulaCaseLibraryCache = new Map();
const SINGLE_STAGE_LIBRARY_CACHE_LIMIT = 12;

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
  if (a.llPriority !== b.llPriority) return b.llPriority - a.llPriority;
  if (a.solvedSum !== b.solvedSum) return b.solvedSum - a.solvedSum;
  const activeStyleBias = Math.max(a.styleBiasLevel, b.styleBiasLevel);
  const activeTransitionBias = Math.max(a.transitionBiasLevel, b.transitionBiasLevel);
  const activeDownstreamBias = Math.max(a.downstreamBiasLevel, b.downstreamBiasLevel);
  if (activeStyleBias > 0 || activeTransitionBias > 0 || activeDownstreamBias > 0) {
    const compositeA =
      a.score +
      a.transitionPenalty * activeTransitionBias +
      a.stylePenalty * activeStyleBias +
      a.downstreamPenalty * activeDownstreamBias;
    const compositeB =
      b.score +
      b.transitionPenalty * activeTransitionBias +
      b.stylePenalty * activeStyleBias +
      b.downstreamPenalty * activeDownstreamBias;
    if (compositeA !== compositeB) return compositeA - compositeB;
  }
  if (a.score !== b.score) return a.score - b.score;
  if (a.transitionPenalty !== b.transitionPenalty) return a.transitionPenalty - b.transitionPenalty;
  if (a.stylePenalty !== b.stylePenalty) return a.stylePenalty - b.stylePenalty;
  if (a.downstreamPenalty !== b.downstreamPenalty) return a.downstreamPenalty - b.downstreamPenalty;
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

// Compact F2L pair move table: pairMoveTable[state * 18 + moveIndex] = nextState.
// All 18 HTM moves included; use same moveIndex as MOVE_NAMES.
function buildF2LPairMoveTable(pairDef, cornerMoveTables, edgeMoveTables) {
  const numMoves = cornerMoveTables.length; // 18
  const table = new Uint16Array(576 * numMoves);
  for (let state = 0; state < 576; state++) {
    const edgeOri = state & 1;
    let rem = state >> 1;
    const edgePos = rem % 12;
    rem = Math.floor(rem / 12);
    const cornerOri = rem % 3;
    const cornerPos = Math.floor(rem / 3);
    const base = state * numMoves;
    for (let mi = 0; mi < numMoves; mi++) {
      const cMap = cornerMoveTables[mi];
      const eMap = edgeMoveTables[mi];
      const np = cMap.cornerPosMap[cornerPos];
      const no = (cornerOri + cMap.cornerOriDelta[cornerPos]) % 3;
      const nep = eMap.edgePosMap[edgePos];
      const neo = edgeOri ^ eMap.edgeOriDelta[edgePos];
      table[base + mi] = encodeF2LPairState(np, no, nep, neo);
    }
  }
  return table;
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

// Compact cross move table: crossMoveTable[stateIdx * numMoves + moveIdx] = nextStateIdx.
// Enables pure-integer cross IDA* (~10x faster than KPattern IDA*).
function buildCrossMoveTable(edgeMoveTables) {
  const numMoves = edgeMoveTables.length;
  const table = new Uint32Array(CROSS_STATE_COUNT * numMoves);
  for (let state = 0; state < CROSS_STATE_COUNT; state++) {
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
    const base = state * numMoves;
    for (let moveIndex = 0; moveIndex < numMoves; moveIndex++) {
      const move = edgeMoveTables[moveIndex];
      const np0 = move.edgePosMap[dp0];
      const np1 = move.edgePosMap[dp1];
      const np2 = move.edgePosMap[dp2];
      const np3 = move.edgePosMap[dp3];
      const no0 = do0 ^ move.edgeOriDelta[dp0];
      const no1 = do1 ^ move.edgeOriDelta[dp1];
      const no2 = do2 ^ move.edgeOriDelta[dp2];
      const no3 = do3 ^ move.edgeOriDelta[dp3];
      table[base + moveIndex] = encodeCrossStateFromParts(np0, np1, np2, np3, no0, no1, no2, no3);
    }
  }
  return table;
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

function normalizeMoveToken(token) {
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(String(token || "").trim());
  if (!match) return "";
  const face = match[1];
  const suffix = match[2] || "";
  if (!face) return "";
  if (suffix === "2'" || suffix === "2") return `${face}2`;
  if (suffix === "'") return `${face}'`;
  return face;
}

function joinMoves(parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function normalizeAlgorithmText(text) {
  return splitMoves(text)
    .map((token) => normalizeMoveToken(token))
    .filter(Boolean)
    .join(" ");
}

const FRAME_ROTATION_TOKENS = new Set(["x", "x2", "x'", "z", "z2", "z'"]);

function stripOuterFrameRotations(tokens) {
  let start = 0;
  let end = Array.isArray(tokens) ? tokens.length : 0;
  while (start < end && FRAME_ROTATION_TOKENS.has(tokens[start])) start += 1;
  while (end > start && FRAME_ROTATION_TOKENS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end);
}

function normalizeFormulaMatchText(text) {
  const tokens = splitMoves(text)
    .map((token) => normalizeMoveToken(token))
    .filter(Boolean);
  return stripOuterFrameRotations(tokens).join(" ");
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

function isCubeRotationFace(face) {
  return face === "x" || face === "y" || face === "z" || face === "X" || face === "Y" || face === "Z";
}

function isWideTurnFace(face) {
  if (!face) return false;
  if (face.endsWith("w") || face.endsWith("W")) return true;
  return face === "u" || face === "r" || face === "f" || face === "d" || face === "l" || face === "b";
}

function getF2LStyleMetrics(moves) {
  let rotationCount = 0;
  let aufCount = 0;
  let wideTurnCount = 0;
  for (let i = 0; i < moves.length; i++) {
    const parsed = parseMove(moves[i]);
    if (!parsed) continue;
    const face = parsed.face;
    if (isCubeRotationFace(face)) {
      rotationCount += 1;
      continue;
    }
    if (face === "U") {
      aufCount += 1;
    }
    if (isWideTurnFace(face)) {
      wideTurnCount += 1;
    }
  }
  return {
    rotationCount,
    aufCount,
    wideTurnCount,
  };
}

function getF2LStylePenalty(moves, profile) {
  if (!profile) return 0;
  const metrics = getF2LStyleMetrics(moves);
  return (
    metrics.rotationCount * profile.rotationWeight +
    metrics.aufCount * profile.aufWeight +
    metrics.wideTurnCount * profile.wideTurnWeight
  );
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
      segments.push({
        pairStart: currentPair + 1,
        pairEnd: nextPair,
        moves: chunk,
      });
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
  if (
    normalized === "CN" ||
    normalized === "COLOR_NEUTRAL" ||
    normalized === "COLOR-NEUTRAL" ||
    normalized === "AUTO"
  ) {
    return "CN";
  }
  return CROSS_COLOR_ROTATION_CANDIDATES[normalized] !== undefined ? normalized : "D";
}

function getCrossRotationCandidates(color) {
  const normalized = normalizeCrossColor(color);
  if (normalized === "CN") return CROSS_COLOR_SEQUENCE.slice();
  const candidates = CROSS_COLOR_ROTATION_CANDIDATES[normalized];
  return Array.isArray(candidates) && candidates.length ? candidates : [""];
}

function getCrossStageRank(stageName) {
  const normalized = String(stageName || "");
  if (normalized.startsWith("XXCross")) return 2;
  if (normalized.startsWith("XCross")) return 1;
  return 0;
}

function compareCrossProbeResults(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (!!a.ok !== !!b.ok) return a.ok ? -1 : 1;
  const compositeA = Number(a.compositeScore);
  const compositeB = Number(b.compositeScore);
  if (Number.isFinite(compositeA) && Number.isFinite(compositeB) && compositeA !== compositeB) {
    return compositeA - compositeB;
  }
  if (a.stageRank !== b.stageRank) return b.stageRank - a.stageRank;
  if (a.moveCount !== b.moveCount) return a.moveCount - b.moveCount;
  if (a.bound !== b.bound) return a.bound - b.bound;
  if (a.nodes !== b.nodes) return a.nodes - b.nodes;
  return CROSS_COLOR_SEQUENCE.indexOf(a.color) - CROSS_COLOR_SEQUENCE.indexOf(b.color);
}

function normalizeCrossTargetPairsOverride(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const normalized = Math.max(0, Math.min(2, Math.floor(n)));
  return normalized;
}

function getColorNeutralProbeTargetPairs(solveMode, styleProfileInput) {
  const mixedCaseBias = normalizeMixedCaseBias(styleProfileInput);
  const prefersExtendedCross =
    isMixedCfopStyleProfile(styleProfileInput) ||
    mixedCaseBias.xcrossWeight > 1 ||
    mixedCaseBias.xxcrossWeight > 1 ||
    mixedCaseBias.xcrossRate > 0.05 ||
    mixedCaseBias.xxcrossRate > 0.01;
  if (solveMode === "zb") return [1, 0];
  if (prefersExtendedCross) return [2, 1, 0];
  return [0];
}

function normalizeSolveMode(mode) {
  const normalized = String(mode || "strict").toLowerCase();
  if (normalized === "zb") return "zb";
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

function normalizeStyleWeight(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(0, Math.min(16, Math.floor(n)));
  return clamped;
}

function normalizeCaseBiasWeight(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(12, Math.round(n)));
}

function toCaseBiasRate(weight) {
  return Math.max(0, Math.min(1, (normalizeCaseBiasWeight(weight, 1) - 1) / 11));
}

function hashStringToUnitInterval(text) {
  const source = String(text || "");
  if (!source) return 0.5;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  return unsigned / 4294967295;
}

function buildSolverDecisionSeed(options = {}) {
  const scrambleSeed = String(options.scramble || options.scrambleKey || "").trim();
  const solverName = String(
    options.transitionProfileSolver ||
      options.playerName ||
      options.solverName ||
      "",
  ).trim();
  const styleProfile =
    options.f2lStyleProfile !== undefined ? options.f2lStyleProfile : options.styleProfile;
  const styleSignature =
    styleProfile && typeof styleProfile === "object"
      ? [
          String(styleProfile.preset || ""),
          Number(styleProfile.rotationWeight || 0),
          Number(styleProfile.aufWeight || 0),
          Number(styleProfile.wideTurnWeight || 0),
          Number(styleProfile.xcrossWeight || styleProfile.caseBias?.xcrossWeight || 0),
          Number(styleProfile.xxcrossWeight || styleProfile.caseBias?.xxcrossWeight || 0),
          Number(styleProfile.zbllWeight || styleProfile.caseBias?.zbllWeight || 0),
          Number(styleProfile.zblsWeight || styleProfile.caseBias?.zblsWeight || 0),
        ].join(":")
      : String(styleProfile || "");
  return [scrambleSeed, solverName, styleSignature].filter(Boolean).join("|");
}

function normalizeMixedCaseBias(styleProfile) {
  if (!styleProfile || typeof styleProfile !== "object") {
    return {
      xcrossWeight: 1,
      xxcrossWeight: 1,
      zbllWeight: 1,
      zblsWeight: 1,
      xcrossRate: 0,
      xxcrossRate: 0,
      zbllRate: 0,
      zblsRate: 0,
      historicalXCrossRate: null,
      historicalXXCrossRate: null,
      historicalZbllRate: null,
      historicalZblsRate: null,
      zbllRateCap: null,
      zblsRateCap: null,
    };
  }
  const nested = styleProfile.caseBias && typeof styleProfile.caseBias === "object" ? styleProfile.caseBias : null;
  const xcrossWeight = normalizeCaseBiasWeight(
    nested?.xcrossWeight ?? styleProfile.xcrossWeight,
    1,
  );
  const xxcrossWeight = normalizeCaseBiasWeight(
    nested?.xxcrossWeight ?? styleProfile.xxcrossWeight,
    1,
  );
  const zbllWeight = normalizeCaseBiasWeight(
    nested?.zbllWeight ?? styleProfile.zbllWeight,
    1,
  );
  const zblsWeight = normalizeCaseBiasWeight(
    nested?.zblsWeight ?? styleProfile.zblsWeight,
    1,
  );
  const zbllRateCap = clampRate01(nested?.zbllRateCap ?? styleProfile.zbllRateCap);
  const zblsRateCap = clampRate01(nested?.zblsRateCap ?? styleProfile.zblsRateCap);
  const historicalXCrossRate = clampRate01(
    nested?.historicalXCrossRate ?? styleProfile.historicalXCrossRate,
    null,
  );
  const historicalXXCrossRate = clampRate01(
    nested?.historicalXXCrossRate ?? styleProfile.historicalXXCrossRate,
    null,
  );
  const historicalZbllRate = clampRate01(
    nested?.historicalZbllRate ?? styleProfile.historicalZbllRate,
    null,
  );
  const historicalZblsRate = clampRate01(
    nested?.historicalZblsRate ?? styleProfile.historicalZblsRate,
    null,
  );
  const rawXCrossRate = toCaseBiasRate(xcrossWeight);
  const rawXXCrossRate = toCaseBiasRate(xxcrossWeight);
  const xcrossRateOffset = Number(nested?.xcrossRateOffset ?? styleProfile.xcrossRateOffset);
  const xxcrossRateOffset = Number(nested?.xxcrossRateOffset ?? styleProfile.xxcrossRateOffset);
  const rawZbllRate = toCaseBiasRate(zbllWeight);
  const rawZblsRate = toCaseBiasRate(zblsWeight);
  const xcrossRateBase = historicalXCrossRate !== null ? historicalXCrossRate : rawXCrossRate;
  const xxcrossRateBase = historicalXXCrossRate !== null ? historicalXXCrossRate : rawXXCrossRate;
  const xcrossRate = clampRate01(
    xcrossRateBase + (Number.isFinite(xcrossRateOffset) ? xcrossRateOffset : 0),
  ) ?? xcrossRateBase;
  const xxcrossRatePre = clampRate01(
    xxcrossRateBase + (Number.isFinite(xxcrossRateOffset) ? xxcrossRateOffset : 0),
  ) ?? xxcrossRateBase;
  const xxcrossRate = Math.min(xcrossRate, xxcrossRatePre);
  const zbllRateBase = historicalZbllRate !== null ? historicalZbllRate : rawZbllRate;
  const zblsRateBase = historicalZblsRate !== null ? historicalZblsRate : rawZblsRate;
  return {
    xcrossWeight,
    xxcrossWeight,
    zbllWeight,
    zblsWeight,
    xcrossRate,
    xxcrossRate,
    zbllRate: zbllRateCap !== null ? Math.min(zbllRateBase, zbllRateCap) : zbllRateBase,
    zblsRate: zblsRateCap !== null ? Math.min(zblsRateBase, zblsRateCap) : zblsRateBase,
    historicalXCrossRate,
    historicalXXCrossRate,
    historicalZbllRate,
    historicalZblsRate,
    zbllRateCap,
    zblsRateCap,
    xcrossRateOffset: Number.isFinite(xcrossRateOffset) ? xcrossRateOffset : 0,
    xxcrossRateOffset: Number.isFinite(xxcrossRateOffset) ? xxcrossRateOffset : 0,
  };
}

function normalizeF2LStyleProfile(styleProfile) {
  if (!styleProfile) return F2L_STYLE_PROFILE_PRESETS.legacy;
  if (typeof styleProfile === "string") {
    const presetKey = styleProfile.toLowerCase();
    return F2L_STYLE_PROFILE_PRESETS[presetKey] || F2L_STYLE_PROFILE_PRESETS.legacy;
  }
  if (typeof styleProfile !== "object") return F2L_STYLE_PROFILE_PRESETS.legacy;
  const presetKey =
    typeof styleProfile.preset === "string" ? styleProfile.preset.toLowerCase() : "";
  const base = F2L_STYLE_PROFILE_PRESETS[presetKey] || F2L_STYLE_PROFILE_PRESETS.legacy;
  return {
    rotationWeight: normalizeStyleWeight(styleProfile.rotationWeight, base.rotationWeight),
    aufWeight: normalizeStyleWeight(styleProfile.aufWeight, base.aufWeight),
    wideTurnWeight: normalizeStyleWeight(styleProfile.wideTurnWeight, base.wideTurnWeight),
  };
}

function hasActiveF2LStyleProfile(styleProfile) {
  if (!styleProfile || typeof styleProfile !== "object") return false;
  return (
    Number(styleProfile.rotationWeight) > 0 ||
    Number(styleProfile.aufWeight) > 0 ||
    Number(styleProfile.wideTurnWeight) > 0
  );
}

function getF2LStyleBiasLevel(styleProfile) {
  if (!hasActiveF2LStyleProfile(styleProfile)) return 0;
  const sum =
    Number(styleProfile.rotationWeight || 0) +
    Number(styleProfile.aufWeight || 0) +
    Number(styleProfile.wideTurnWeight || 0);
  if (!Number.isFinite(sum) || sum <= 0) return 0;
  return Math.max(1, Math.min(6, Math.round(sum / 3)));
}

function isSameF2LStyleProfile(a, b) {
  if (!a || !b) return false;
  return (
    a.rotationWeight === b.rotationWeight &&
    a.aufWeight === b.aufWeight &&
    a.wideTurnWeight === b.wideTurnWeight
  );
}

function getBudgetAwareF2LStyleProfile(styleProfile, deadlineTs) {
  const normalized = normalizeF2LStyleProfile(styleProfile);
  if (!Number.isFinite(deadlineTs) || deadlineTs <= 0) return normalized;
  const remainingMs = deadlineTs - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return normalized;

  const balanced = F2L_STYLE_PROFILE_PRESETS.balanced;
  const legacy = F2L_STYLE_PROFILE_PRESETS.legacy;
  const isHeavyProfile =
    normalized.rotationWeight >= 4 ||
    normalized.aufWeight >= 4 ||
    normalized.wideTurnWeight >= 4;

  // Data-driven guardrail: short per-solve budgets tend to fail on heavily-biased F2L profiles.
  if (remainingMs < 2500) return legacy;
  if (remainingMs < 4200 && isHeavyProfile) return balanced;
  return normalized;
}

function isMixedCfopStyleProfile(styleProfile) {
  if (!styleProfile) return false;
  if (typeof styleProfile === "string") {
    const presetKey = styleProfile.toLowerCase();
    return presetKey === "top10-mixed" || presetKey === "elite-mixed" || presetKey === "mixed";
  }
  if (typeof styleProfile !== "object") return false;
  const presetKey = typeof styleProfile.preset === "string" ? styleProfile.preset.toLowerCase() : "";
  return presetKey === "top10-mixed" || presetKey === "elite-mixed" || presetKey === "mixed";
}

function normalizeTransitionStateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const total = Number(entry.total ?? entry.count ?? entry.transitionCount ?? 0);
  const uniqueNext = Number(entry.uniqueNext ?? entry.nextCount ?? 0);
  const keptCount = Number(entry.keptCount ?? 0);
  const droppedCount = Number(entry.droppedCount ?? 0);
  const nextSource = Array.isArray(entry.next)
    ? entry.next
    : Array.isArray(entry.transitions)
      ? entry.transitions
      : [];
  const nextMap = new Map();
  for (let i = 0; i < nextSource.length; i++) {
    const item = nextSource[i];
    let nextKey = null;
    let count = null;
    if (Array.isArray(item)) {
      nextKey = item[0];
      count = item[1];
    } else if (item && typeof item === "object") {
      nextKey = item.key ?? item.nextKey ?? item.stateKey ?? item.to;
      count = item.count ?? item.total ?? item.transitionCount;
    }
    const numericNextKey = Number(nextKey);
    const numericCount = Number(count);
    if (!Number.isFinite(numericNextKey) || !Number.isFinite(numericCount) || numericCount <= 0) {
      continue;
    }
    nextMap.set(String(numericNextKey), Math.floor(numericCount));
  }
  const normalizedTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return {
    total: normalizedTotal > 0 ? normalizedTotal : Array.from(nextMap.values()).reduce((acc, v) => acc + v, 0),
    uniqueNext: Number.isFinite(uniqueNext) && uniqueNext > 0 ? Math.floor(uniqueNext) : nextMap.size,
    keptCount: Number.isFinite(keptCount) && keptCount > 0 ? Math.floor(keptCount) : Array.from(nextMap.values()).reduce((acc, v) => acc + v, 0),
    droppedCount: Number.isFinite(droppedCount) && droppedCount >= 0 ? Math.floor(droppedCount) : 0,
    next: nextMap,
  };
}

function normalizeF2LTransitionProfile(transitionProfile, seen = new WeakSet()) {
  if (!transitionProfile || typeof transitionProfile !== "object") return null;
  const sourceProfile =
    transitionProfile.profile && typeof transitionProfile.profile === "object"
      ? transitionProfile.profile
      : transitionProfile;
  if (seen.has(sourceProfile)) return null;
  seen.add(sourceProfile);

  const stateEntries = Array.isArray(sourceProfile.states)
    ? sourceProfile.states
    : Array.isArray(sourceProfile.stateTransitions)
      ? sourceProfile.stateTransitions
      : [];
  const stateMap = new Map();
  for (let i = 0; i < stateEntries.length; i++) {
    const entry = normalizeTransitionStateEntry(stateEntries[i]);
    if (!entry) continue;
    const key = Number(
      stateEntries[i]?.key ?? stateEntries[i]?.fromKey ?? stateEntries[i]?.stateKey ?? stateEntries[i]?.from,
    );
    if (!Number.isFinite(key)) continue;
    if (!entry.total && !entry.next.size) continue;
    stateMap.set(String(key), entry);
  }

  const fallbackInput =
    transitionProfile.fallbackProfile && typeof transitionProfile.fallbackProfile === "object"
      ? transitionProfile.fallbackProfile
      : sourceProfile.fallbackProfile && typeof sourceProfile.fallbackProfile === "object"
        ? sourceProfile.fallbackProfile
        : null;

  const normalizedFallback = fallbackInput ? normalizeF2LTransitionProfile(fallbackInput, seen) : null;
  const solveCount = Number(sourceProfile.solveCount ?? sourceProfile.sampleCount ?? 0);
  const relevantStepCount = Number(sourceProfile.relevantStepCount ?? 0);
  const transitionCount = Number(sourceProfile.transitionCount ?? 0);
  const smoothingAlpha = Number(sourceProfile.smoothingAlpha);
  const maxNextStates = Number(sourceProfile.maxNextStates);

  return {
    solver: typeof sourceProfile.solver === "string" ? sourceProfile.solver : "",
    solveCount: Number.isFinite(solveCount) && solveCount > 0 ? Math.floor(solveCount) : 0,
    relevantStepCount:
      Number.isFinite(relevantStepCount) && relevantStepCount > 0 ? Math.floor(relevantStepCount) : 0,
    transitionCount:
      Number.isFinite(transitionCount) && transitionCount > 0 ? Math.floor(transitionCount) : 0,
    stateCount: stateMap.size,
    maxNextStates: Number.isFinite(maxNextStates) && maxNextStates > 0 ? Math.floor(maxNextStates) : 0,
    smoothingAlpha: Number.isFinite(smoothingAlpha) && smoothingAlpha >= 0 ? smoothingAlpha : 0.5,
    stateMap,
    fallbackProfile: normalizedFallback,
  };
}

function getF2LTransitionPenalty(transitionProfile, currentStateKey, nextStateKey) {
  if (!transitionProfile || typeof transitionProfile !== "object" || !transitionProfile.stateMap) {
    return null;
  }
  const currentEntry = transitionProfile.stateMap.get(String(currentStateKey));
  if (!currentEntry || !currentEntry.next || !currentEntry.next.size) {
    return transitionProfile.fallbackProfile
      ? getF2LTransitionPenalty(transitionProfile.fallbackProfile, currentStateKey, nextStateKey)
      : null;
  }
  const nextCount = Number(currentEntry.next.get(String(nextStateKey)) || 0);
  if (nextCount <= 0) {
    return transitionProfile.fallbackProfile
      ? getF2LTransitionPenalty(transitionProfile.fallbackProfile, currentStateKey, nextStateKey)
      : null;
  }
  const total = Number.isFinite(currentEntry.total) && currentEntry.total > 0 ? currentEntry.total : 0;
  const alpha = Number.isFinite(transitionProfile.smoothingAlpha) && transitionProfile.smoothingAlpha >= 0
    ? transitionProfile.smoothingAlpha
    : 0.5;
  const uniqueNext = Number.isFinite(currentEntry.uniqueNext) && currentEntry.uniqueNext > 0
    ? currentEntry.uniqueNext
    : currentEntry.next.size;
  const denom = total + alpha * (uniqueNext + 1);
  if (denom <= 0) return null;
  const prob = (nextCount + alpha) / denom;
  if (!Number.isFinite(prob) || prob <= 0) return null;
  return -Math.log(Math.max(1e-9, prob));
}

function normalizeF2LDownstreamWeight(value, fallback = DEFAULT_F2L_DOWNSTREAM_WEIGHT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(3, n));
}

function getF2LDownstreamBiasLevel(weight) {
  const normalized = normalizeF2LDownstreamWeight(weight, DEFAULT_F2L_DOWNSTREAM_WEIGHT);
  if (normalized <= 0) return 0;
  return Math.max(1, Math.min(4, Math.round(normalized * 3)));
}

function clampRate01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function normalizeDownstreamTopCases(entry) {
  const source = Array.isArray(entry?.topCases)
    ? entry.topCases
    : Array.isArray(entry?.caseCounts)
      ? entry.caseCounts
      : entry?.caseCounts && typeof entry.caseCounts === "object"
        ? Object.entries(entry.caseCounts)
        : [];
  const topCases = [];
  for (let i = 0; i < source.length; i++) {
    const item = source[i];
    let label = "";
    let count = 0;
    if (Array.isArray(item)) {
      label = String(item[0] ?? "").trim();
      count = Number(item[1] ?? 0);
    } else if (item && typeof item === "object") {
      label = String(item.label ?? item.case ?? item.tag ?? "").trim();
      count = Number(item.count ?? item.total ?? item.value ?? 0);
    }
    if (!label || !Number.isFinite(count) || count <= 0) continue;
    topCases.push([label, Math.floor(count)]);
  }
  return topCases;
}

function getDownstreamCaseRates(entry, sampleCount, topCases) {
  let caseTotal = 0;
  let zbllCount = 0;
  let zblsCount = 0;
  let eoLikeCount = 0;
  for (let i = 0; i < topCases.length; i++) {
    const [label, count] = topCases[i];
    const c = Number(count);
    if (!Number.isFinite(c) || c <= 0) continue;
    caseTotal += c;
    if (ZBLL_CASE_LABEL_RE.test(label)) {
      zbllCount += c;
      eoLikeCount += c;
      continue;
    }
    if (ZBLS_CASE_LABEL_RE.test(label)) {
      zblsCount += c;
      eoLikeCount += c;
      continue;
    }
    if (EO_CASE_LABEL_RE.test(label)) {
      eoLikeCount += c;
    }
  }

  const rateDenom = caseTotal > 0 ? caseTotal : sampleCount > 0 ? sampleCount : 0;
  const parsedZbllRate = clampRate01(entry?.zbllRate ?? entry?.zbllProbability ?? entry?.zbllLikelihood);
  const parsedZblsRate = clampRate01(entry?.zblsRate ?? entry?.zblsProbability ?? entry?.zblsLikelihood);
  const parsedEoLikeRate = clampRate01(entry?.eoLikeRate ?? entry?.eoRate ?? entry?.eoLikelihood);

  const computedZbllRate = rateDenom > 0 ? clampRate01(zbllCount / rateDenom) : null;
  const computedZblsRate = rateDenom > 0 ? clampRate01(zblsCount / rateDenom) : null;
  const computedEoLikeRate = rateDenom > 0 ? clampRate01(eoLikeCount / rateDenom) : null;

  return {
    zbllRate: parsedZbllRate ?? computedZbllRate ?? 0,
    zblsRate: parsedZblsRate ?? computedZblsRate ?? 0,
    eoLikeRate: parsedEoLikeRate ?? computedEoLikeRate ?? 0,
  };
}

function normalizeDownstreamStateEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const sampleCount = Number(entry.sampleCount ?? entry.count ?? entry.total ?? 0);
  const expectedOllMoves = Number(
    entry.expectedOllMoves ?? entry.expectedOll ?? entry.avgOllMoves ?? entry.ollMoves,
  );
  const expectedPllMoves = Number(
    entry.expectedPllMoves ?? entry.expectedPll ?? entry.avgPllMoves ?? entry.pllMoves,
  );
  const expectedLlMovesRaw = Number(
    entry.expectedLlMoves ?? entry.expectedLLMoves ?? entry.expectedLl ?? entry.avgLlMoves ?? entry.llMoves,
  );
  const expectedLlMoves = Number.isFinite(expectedLlMovesRaw)
    ? expectedLlMovesRaw
    : Number.isFinite(expectedOllMoves) || Number.isFinite(expectedPllMoves)
      ? (Number.isFinite(expectedOllMoves) ? expectedOllMoves : 0) +
        (Number.isFinite(expectedPllMoves) ? expectedPllMoves : 0)
      : NaN;
  const topCases = normalizeDownstreamTopCases(entry);
  const rates = getDownstreamCaseRates(entry, sampleCount, topCases);

  if (!Number.isFinite(expectedLlMoves)) return null;
  // Preserve top formulas and variant lists when present in the source entry
  const topFormulas = Array.isArray(entry?.topFormulas)
    ? entry.topFormulas
        .map((tf) => ({ family: String(tf.family || "").trim(), formula: String(tf.formula || tf.algorithm || tf.formulaKey || "").trim(), count: Number(tf.count || tf.sampleCount || 0) }))
        .filter((f) => f.formula && Number.isFinite(f.count) && f.count > 0)
    : [];
  const topFormulaVariants = Array.isArray(entry?.topFormulaVariants)
    ? entry.topFormulaVariants
        .map((v) => ({ family: String(v.family || "").trim(), canonicalFormula: String(v.canonicalFormula || v.canonical || v.canonicalKey || "").trim(), formula: String(v.formula || v.variant || "").trim(), count: Number(v.count || 0) }))
        .filter((v) => v.canonicalFormula && v.formula && Number.isFinite(v.count) && v.count > 0)
    : [];
  const llCaseStats = Array.isArray(entry?.llCaseStats)
    ? entry.llCaseStats
        .map((item) => ({
          stateKey: Number(item.stateKey ?? entry?.key ?? 0),
          stageKey: String(item.stageKey || "stage3").trim() || "stage3",
          family: normalizeLlCaseFamilyLabel(item.family || item.caseFamily || item.label || ""),
          caseTag: String(item.caseTag || item.label || "").trim(),
          canonicalFormula: String(item.canonicalFormula || item.canonical || "").trim(),
          variantFormula: String(item.variantFormula || item.formula || item.variant || "").trim(),
          count: Number(item.count || 0),
          sampleCount: Number(item.sampleCount || 0),
          playerWeight: Number(item.playerWeight),
          globalWeight: Number(item.globalWeight),
          familySampleCount: Number(item.familySampleCount || 0),
          stageFamilySampleCount: Number(item.stageFamilySampleCount || 0),
        }))
        .filter(
          (item) =>
            item.family &&
            Number.isFinite(item.count) &&
            item.count > 0 &&
            (item.canonicalFormula || item.variantFormula),
        )
    : [];

  return {
    sampleCount: Number.isFinite(sampleCount) && sampleCount > 0 ? Math.floor(sampleCount) : 0,
    expectedOllMoves: Number.isFinite(expectedOllMoves) ? expectedOllMoves : null,
    expectedPllMoves: Number.isFinite(expectedPllMoves) ? expectedPllMoves : null,
    expectedLlMoves,
    topCases,
    topFormulas,
    topFormulaVariants,
    llCaseStats,
    zbllRate: rates.zbllRate,
    zblsRate: rates.zblsRate,
    eoLikeRate: rates.eoLikeRate,
  };
}

function normalizeF2LDownstreamProfile(downstreamProfile, seen = new WeakSet()) {
  if (!downstreamProfile || typeof downstreamProfile !== "object") return null;
  const sourceProfile =
    downstreamProfile.profile && typeof downstreamProfile.profile === "object"
      ? downstreamProfile.profile
      : downstreamProfile;
  if (seen.has(sourceProfile)) return null;
  seen.add(sourceProfile);

  const stateEntries = Array.isArray(sourceProfile.states)
    ? sourceProfile.states
    : Array.isArray(sourceProfile.statePredictions)
      ? sourceProfile.statePredictions
      : [];
  const stateMap = new Map();
  for (let i = 0; i < stateEntries.length; i++) {
    const entry = normalizeDownstreamStateEntry(stateEntries[i]);
    if (!entry) continue;
    const key = Number(
      stateEntries[i]?.key ?? stateEntries[i]?.stateKey ?? stateEntries[i]?.fromKey ?? stateEntries[i]?.from,
    );
    if (!Number.isFinite(key)) continue;
    stateMap.set(String(key), entry);
  }

  const fallbackInput =
    downstreamProfile.fallbackProfile && typeof downstreamProfile.fallbackProfile === "object"
      ? downstreamProfile.fallbackProfile
      : sourceProfile.fallbackProfile && typeof sourceProfile.fallbackProfile === "object"
        ? sourceProfile.fallbackProfile
        : null;
  const normalizedFallback = fallbackInput ? normalizeF2LDownstreamProfile(fallbackInput, seen) : null;

  const globalExpectedOllMoves = Number(
    sourceProfile.globalExpectedOllMoves ??
      sourceProfile.expectedOllMoves ??
      sourceProfile.ollMean ??
      sourceProfile.profileExpectedOllMoves,
  );
  const globalExpectedPllMoves = Number(
    sourceProfile.globalExpectedPllMoves ??
      sourceProfile.expectedPllMoves ??
      sourceProfile.pllMean ??
      sourceProfile.profileExpectedPllMoves,
  );
  const globalExpectedLlMoves = Number(
    sourceProfile.globalExpectedLlMoves ??
      sourceProfile.expectedLlMoves ??
      sourceProfile.expectedLLMoves ??
      sourceProfile.llMean ??
      sourceProfile.profileExpectedLlMoves,
  );

  const baselineOll = Number.isFinite(globalExpectedOllMoves)
    ? globalExpectedOllMoves
    : Number.isFinite(globalExpectedLlMoves)
      ? globalExpectedLlMoves / 2
      : 0;
  const baselinePll = Number.isFinite(globalExpectedPllMoves)
    ? globalExpectedPllMoves
    : Number.isFinite(globalExpectedLlMoves)
      ? globalExpectedLlMoves - baselineOll
      : 0;
  const baselineLl = Number.isFinite(globalExpectedLlMoves)
    ? globalExpectedLlMoves
    : baselineOll + baselinePll;

  return {
    solver: typeof sourceProfile.solver === "string" ? sourceProfile.solver : "",
    solveCount: Number.isFinite(Number(sourceProfile.solveCount))
      ? Math.max(0, Math.floor(Number(sourceProfile.solveCount)))
      : 0,
    stateCount: stateMap.size,
    globalExpectedOllMoves: baselineOll,
    globalExpectedPllMoves: baselinePll,
    globalExpectedLlMoves: baselineLl,
    stateMap,
    fallbackProfile: normalizedFallback,
  };
}

function findF2LDownstreamStateEntry(downstreamProfile, nextStateKey) {
  if (!downstreamProfile || typeof downstreamProfile !== "object" || !downstreamProfile.stateMap) {
    return null;
  }
  const stateEntry = downstreamProfile.stateMap.get(String(nextStateKey));
  if (stateEntry) {
    return {
      profile: downstreamProfile,
      stateEntry,
    };
  }
  return downstreamProfile.fallbackProfile
    ? findF2LDownstreamStateEntry(downstreamProfile.fallbackProfile, nextStateKey)
    : null;
}

function findDirectF2LDownstreamStateEntry(downstreamProfile, nextStateKey) {
  if (!downstreamProfile || typeof downstreamProfile !== "object" || !downstreamProfile.stateMap) {
    return null;
  }
  return downstreamProfile.stateMap.get(String(nextStateKey)) || null;
}

function getF2LDownstreamPenalty(downstreamProfile, nextStateKey, predictionWeight = 1) {
  if (!downstreamProfile || typeof downstreamProfile !== "object" || !downstreamProfile.stateMap) {
    return null;
  }
  const match = findF2LDownstreamStateEntry(downstreamProfile, nextStateKey);
  if (!match) return null;
  const stateEntry = match.stateEntry;
  const profile = match.profile;
  const expectedLlMoves = Number(stateEntry.expectedLlMoves);
  if (!Number.isFinite(expectedLlMoves)) return null;

  const baseline = Number.isFinite(profile.globalExpectedLlMoves)
    ? profile.globalExpectedLlMoves
    : 0;
  const normalizedWeight = normalizeF2LDownstreamWeight(predictionWeight, DEFAULT_F2L_DOWNSTREAM_WEIGHT);
  if (normalizedWeight <= 0) return 0;
  const rawPenalty = (expectedLlMoves - baseline) * normalizedWeight;
  if (!Number.isFinite(rawPenalty)) return null;
  return Math.max(-MAX_F2L_DOWNSTREAM_PENALTY, Math.min(MAX_F2L_DOWNSTREAM_PENALTY, rawPenalty));
}

function normalizeLlCaseFamilyLabel(label) {
  const text = String(label || "").trim().toUpperCase();
  if (!text) return "OTHER";
  if (text.includes("NOT ZBLL")) return "OLL";
  if (text.includes("4TH PAIR/ZBLS") || text.includes("ZBLS")) return "ZBLS";
  if (text.includes("EO+ZBLL") || text.includes("ZBLL")) return "ZBLL";
  if (text.includes("EPLL") || text.includes("PLL")) return "PLL";
  if (text.includes("OLL")) return "OLL";
  if (text.includes("F2L")) return "F2L";
  return "OTHER";
}

function normalizeLlFormulaEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const family = normalizeLlCaseFamilyLabel(entry.family || entry.label || entry.caseFamily || "");
  const formula = String(entry.formula || entry.algorithm || entry.text || "").trim();
  const count = Number(entry.count ?? entry.sampleCount ?? entry.value ?? 0);
  if (!formula || !Number.isFinite(count) || count <= 0) return null;
  return {
    family,
    formula,
    count,
  };
}

function buildLlFamilyScoresFromStateEntry(stateEntry, mixedCaseBias = null) {
  const familyScores = {
    OLL: 0,
    PLL: 0,
    ZBLL: 0,
    ZBLS: 0,
    F2L: 0,
    OTHER: 0,
  };
  const topCases = Array.isArray(stateEntry?.topCases) ? stateEntry.topCases : [];
  const topFormulas = Array.isArray(stateEntry?.topFormulas) ? stateEntry.topFormulas : [];
  const formulaPriorityMap = new Map();
  const formulaFamilyScores = {
    OLL: 0,
    PLL: 0,
    ZBLL: 0,
    ZBLS: 0,
    F2L: 0,
    OTHER: 0,
  };
  const preferredFormulaByFamily = {};
  let topCaseTotal = 0;
  for (let i = 0; i < topCases.length; i++) {
    const entry = topCases[i];
    const label = Array.isArray(entry) ? entry[0] : entry?.label;
    const count = Number(Array.isArray(entry) ? entry[1] : entry?.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const family = normalizeLlCaseFamilyLabel(label);
    familyScores[family] = (familyScores[family] || 0) + count;
    topCaseTotal += count;
  }

  for (let i = 0; i < topFormulas.length; i++) {
    const normalized = normalizeLlFormulaEntry(topFormulas[i]);
    if (!normalized) continue;
    // Add counts under multiple lookup keys with canonical boost.
    const keys = new Set();
    keys.add(normalized.formula);
    const normKey = normalizeFormulaMatchText(normalized.formula);
    if (normKey) keys.add(normKey);
    const addCount = normalized.count * LL_MERGE_CANONICAL_BOOST;
    for (const k of keys) {
      formulaPriorityMap.set(k, (formulaPriorityMap.get(k) || 0) + addCount);
    }
    formulaFamilyScores[normalized.family] = (formulaFamilyScores[normalized.family] || 0) + addCount;
    const currentPreferred = preferredFormulaByFamily[normalized.family];
    if (!currentPreferred || addCount > currentPreferred.count) {
      preferredFormulaByFamily[normalized.family] = {
        formula: normalized.formula,
        count: addCount,
      };
    }
  }

  // Incorporate variant counts (same perm, different moves) by adding their counts
  // under variant, normalized, and canonical keys so lookups find the canonical preference.
  const topVariants = Array.isArray(stateEntry?.topFormulaVariants) ? stateEntry.topFormulaVariants : [];
  for (let v = 0; v < topVariants.length; v++) {
    const variantEntry = topVariants[v];
    if (!variantEntry || typeof variantEntry !== 'object') continue;
    const family = String(variantEntry.family || '').trim();
    const variantFormula = String(variantEntry.formula || variantEntry.variant || '').trim();
    const canonicalFormula = String(variantEntry.canonicalFormula || variantEntry.canonical || variantEntry.canonicalKey || '').trim();
    const count = Number(variantEntry.count || 0);
    if (!variantFormula || !Number.isFinite(count) || count <= 0) continue;
    const vNorm = normalizeFormulaMatchText(variantFormula) || variantFormula;
    const cNorm = canonicalFormula ? normalizeFormulaMatchText(canonicalFormula) || canonicalFormula : null;
    const variantAdd = count * LL_MERGE_VARIANT_WEIGHT;
    // add variant under raw and normalized keys
    formulaPriorityMap.set(variantFormula, (formulaPriorityMap.get(variantFormula) || 0) + variantAdd);
    formulaPriorityMap.set(vNorm, (formulaPriorityMap.get(vNorm) || 0) + variantAdd);
    // optionally add to canonical normalized key (alias mapping)
    if (cNorm && LL_MERGE_CANONICAL_ALIAS_WEIGHT > 0) {
      formulaPriorityMap.set(cNorm, (formulaPriorityMap.get(cNorm) || 0) + count * LL_MERGE_CANONICAL_ALIAS_WEIGHT);
    }
    if (family) {
      formulaFamilyScores[family] = (formulaFamilyScores[family] || 0) + variantAdd;
      const currentPreferred = preferredFormulaByFamily[family];
      const preferredCandidate = canonicalFormula || variantFormula;
      if (!currentPreferred || variantAdd > currentPreferred.count) {
        preferredFormulaByFamily[family] = { formula: preferredCandidate, count: variantAdd };
      }
    }
  }

  const sampleCount = Number(stateEntry?.sampleCount) || topCaseTotal || 0;
  const deltaExpectedLlMoves = Number(stateEntry?.deltaExpectedLlMoves);
  if (Number.isFinite(deltaExpectedLlMoves) && deltaExpectedLlMoves !== 0) {
    if (deltaExpectedLlMoves < 0) {
      familyScores.ZBLL += Math.min(2.2, -deltaExpectedLlMoves * 1.35);
    } else {
      familyScores.OLL += Math.min(1.6, deltaExpectedLlMoves * 1.1);
      familyScores.PLL += Math.min(1.5, deltaExpectedLlMoves * 0.85);
    }
  }

  const biasZbllRate = clampRate01(mixedCaseBias?.zbllRate) ?? 0;
  const biasZblsRate = clampRate01(mixedCaseBias?.zblsRate) ?? 0;
  const biasScale = Math.log1p(Math.max(1, sampleCount || topCaseTotal || 1));
  familyScores.ZBLL += biasZbllRate * biasScale * 0.18;
  familyScores.ZBLS += biasZblsRate * biasScale * 0.18;

  const orderedFamilies = Object.entries(familyScores)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([family]) => family);

  const totalScore = Object.values(familyScores).reduce((acc, value) => acc + (Number(value) || 0), 0);
  const primaryFamily = orderedFamilies[0] || "OLL";
  const secondaryFamily = orderedFamilies[1] || "OLL";
  const confidence = totalScore > 0 ? (familyScores[primaryFamily] || 0) / totalScore : 0;
  const preferredFormulaEntries = Array.from(formulaPriorityMap.entries())
    .map(([formula, count]) => ({ formula, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.formula.localeCompare(b.formula);
    });
  const preferredFormula = preferredFormulaEntries[0]?.formula || null;

  return {
    familyScores,
    formulaFamilyScores,
    orderedFamilies,
    primaryFamily,
    secondaryFamily,
    preferredNonZbFamily: familyScores.ZBLL >= familyScores.OLL ? "ZBLL" : "OLL",
    preferredZbStage3Family: familyScores.ZBLS >= familyScores.OLL ? "ZBLS" : "OLL",
    preferredZbStage4Family: familyScores.ZBLL >= familyScores.PLL ? "ZBLL" : "PLL",
    formulaPriorityMap,
    preferredFormula,
    preferredFormulaEntries,
    preferredFormulaByFamily,
    confidence,
    sampleCount,
    topCaseTotal,
    topFormulaTotal: topFormulas.length,
    deltaExpectedLlMoves: Number.isFinite(deltaExpectedLlMoves) ? deltaExpectedLlMoves : null,
  };
}

function addWeightedFormulaPreference(preferenceMap, formula, count) {
  const normalizedCount = Number(count);
  if (!formula || !Number.isFinite(normalizedCount) || normalizedCount <= 0) return;
  const rawFormula = String(formula || "").trim();
  if (!rawFormula) return;
  preferenceMap.set(rawFormula, (preferenceMap.get(rawFormula) || 0) + normalizedCount);
  const normalizedFormula = normalizeFormulaMatchText(rawFormula);
  if (normalizedFormula && normalizedFormula !== rawFormula) {
    preferenceMap.set(normalizedFormula, (preferenceMap.get(normalizedFormula) || 0) + normalizedCount);
  }
}

function buildFamilyOnlyFormulaPreferenceMap(stateEntry, family, weightMultiplier = 1) {
  if (!stateEntry || !family) return null;
  const preferenceMap = new Map();
  const normalizedFamily = normalizeLlCaseFamilyLabel(family);
  const topFormulas = Array.isArray(stateEntry.topFormulas) ? stateEntry.topFormulas : [];
  const topVariants = Array.isArray(stateEntry.topFormulaVariants) ? stateEntry.topFormulaVariants : [];
  for (let i = 0; i < topFormulas.length; i++) {
    const entry = normalizeLlFormulaEntry(topFormulas[i]);
    if (!entry || entry.family !== normalizedFamily) continue;
    addWeightedFormulaPreference(preferenceMap, entry.formula, entry.count * weightMultiplier);
  }
  for (let i = 0; i < topVariants.length; i++) {
    const entry = topVariants[i];
    const entryFamily = normalizeLlCaseFamilyLabel(entry?.family || "");
    const count = Number(entry?.count || 0);
    if (entryFamily !== normalizedFamily || !Number.isFinite(count) || count <= 0) continue;
    addWeightedFormulaPreference(preferenceMap, entry.formula, count * weightMultiplier * LL_MERGE_VARIANT_WEIGHT);
    addWeightedFormulaPreference(
      preferenceMap,
      entry.canonicalFormula,
      count * weightMultiplier * LL_MERGE_CANONICAL_BOOST,
    );
  }
  return preferenceMap.size ? preferenceMap : null;
}

function buildCaseAwareFormulaPreferenceMap(
  stateEntry,
  fallbackStateEntry,
  stageKey,
  family,
  basePreferenceMap = null,
) {
  const normalizedStageKey = stageKey === "stage4" ? "stage4" : "stage3";
  const normalizedFamily = normalizeLlCaseFamilyLabel(family);
  const combined = new Map();
  if (basePreferenceMap && typeof basePreferenceMap.get === "function") {
    for (const [formula, count] of basePreferenceMap.entries()) {
      addWeightedFormulaPreference(combined, formula, Number(count) || 0);
    }
  }

  const playerStats = Array.isArray(stateEntry?.llCaseStats) ? stateEntry.llCaseStats : [];
  const globalStats = Array.isArray(fallbackStateEntry?.llCaseStats) ? fallbackStateEntry.llCaseStats : [];
  const playerExact = playerStats.filter(
    (entry) => entry.stageKey === normalizedStageKey && entry.family === normalizedFamily,
  );
  const globalExact = globalStats.filter(
    (entry) => entry.stageKey === normalizedStageKey && entry.family === normalizedFamily,
  );

  for (let i = 0; i < playerExact.length; i++) {
    const entry = playerExact[i];
    const exactWeight =
      (Number(entry.playerWeight) > 0 ? Number(entry.playerWeight) * 180 : 0) +
      (Number(entry.count) || 0) * 18;
    addWeightedFormulaPreference(
      combined,
      entry.variantFormula,
      entry.variantFormula ? exactWeight * 1.1 : 0,
    );
    addWeightedFormulaPreference(combined, entry.canonicalFormula, exactWeight);
  }

  const playerFamilyMap = buildFamilyOnlyFormulaPreferenceMap(stateEntry, normalizedFamily, 2.75);
  if (playerFamilyMap) {
    for (const [formula, count] of playerFamilyMap.entries()) {
      addWeightedFormulaPreference(combined, formula, count);
    }
  }

  for (let i = 0; i < globalExact.length; i++) {
    const entry = globalExact[i];
    const globalWeight =
      (Number(entry.globalWeight) > 0 ? Number(entry.globalWeight) * 70 : 0) +
      (Number(entry.count) || 0) * 4;
    addWeightedFormulaPreference(combined, entry.variantFormula, entry.variantFormula ? globalWeight : 0);
    addWeightedFormulaPreference(combined, entry.canonicalFormula, globalWeight);
  }

  const globalFamilyMap = buildFamilyOnlyFormulaPreferenceMap(fallbackStateEntry, normalizedFamily, 0.9);
  if (globalFamilyMap) {
    for (const [formula, count] of globalFamilyMap.entries()) {
      addWeightedFormulaPreference(combined, formula, count);
    }
  }

  return combined.size ? combined : basePreferenceMap;
}

function getLlCaseFormulaPreferenceEntries(stateEntry, fallbackStateEntry, stageKey, family) {
  const normalizedStageKey = stageKey === "stage4" ? "stage4" : "stage3";
  const normalizedFamily = normalizeLlCaseFamilyLabel(family);
  const entries = [];
  const pushEntry = (formula, weight, source) => {
    const normalizedWeight = Number(weight);
    const text = String(formula || "").trim();
    if (!text || !Number.isFinite(normalizedWeight) || normalizedWeight <= 0) return;
    entries.push({
      formula: text,
      weight: normalizedWeight,
      source,
    });
  };

  const playerStats = Array.isArray(stateEntry?.llCaseStats) ? stateEntry.llCaseStats : [];
  for (let i = 0; i < playerStats.length; i++) {
    const entry = playerStats[i];
    if (entry.stageKey !== normalizedStageKey || entry.family !== normalizedFamily) continue;
    const playerWeight =
      (Number(entry.playerWeight) > 0 ? Number(entry.playerWeight) * 320 : 0) +
      (Number(entry.count) || 0) * 28;
    pushEntry(entry.variantFormula, playerWeight * 1.2, "player-variant");
    pushEntry(entry.canonicalFormula, playerWeight, "player-canonical");
  }

  const fallbackStats = Array.isArray(fallbackStateEntry?.llCaseStats) ? fallbackStateEntry.llCaseStats : [];
  for (let i = 0; i < fallbackStats.length; i++) {
    const entry = fallbackStats[i];
    if (entry.stageKey !== normalizedStageKey || entry.family !== normalizedFamily) continue;
    const globalWeight =
      (Number(entry.globalWeight) > 0 ? Number(entry.globalWeight) * 120 : 0) +
      (Number(entry.count) || 0) * 8;
    pushEntry(entry.variantFormula, globalWeight, "global-variant");
    pushEntry(entry.canonicalFormula, globalWeight * 0.9, "global-canonical");
  }

  return entries;
}

function buildExactCaseFormulaPreferenceMap(
  startPattern,
  stage,
  ctx,
  stateEntry,
  fallbackStateEntry,
  stageKey,
  family,
  basePreferenceMap = null,
) {
  if (!startPattern || !stage || !ctx || typeof stage.key !== "function") {
    return basePreferenceMap;
  }
  const startCaseKey = stage.key(startPattern.patternData);
  if (!startCaseKey) return basePreferenceMap;

  const exactEntries = getLlCaseFormulaPreferenceEntries(
    stateEntry,
    fallbackStateEntry,
    stageKey,
    family,
  );
  if (!exactEntries.length) return basePreferenceMap;

  const combined = new Map();
  if (basePreferenceMap && typeof basePreferenceMap.get === "function") {
    for (const [formula, count] of basePreferenceMap.entries()) {
      addWeightedFormulaPreference(combined, formula, Number(count) || 0);
    }
  }

  const exactMap = new Map();
  for (let i = 0; i < exactEntries.length; i++) {
    const entry = exactEntries[i];
    const casePattern = tryApplyAlg(ctx.solvedPattern, invertAlg(entry.formula));
    if (!casePattern) continue;
    const caseKey = stage.key(casePattern.patternData);
    if (caseKey !== startCaseKey) continue;
    addWeightedFormulaPreference(exactMap, entry.formula, entry.weight);
  }

  if (!exactMap.size) return basePreferenceMap || null;

  for (const [formula, count] of exactMap.entries()) {
    addWeightedFormulaPreference(combined, formula, count * 3.2);
  }
  return combined.size ? combined : basePreferenceMap;
}

function normalizeLlFamilyTemperature(value, fallback = 1.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.6, Math.min(3.5, n));
}

function normalizeOptionalLlRateCap(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  if (n >= 1) return 1;
  return n;
}

function normalizeLlFamilyCalibrationRecord(calibration) {
  if (!calibration || typeof calibration !== "object") {
    return {
      stage3Temperature: 1.4,
      stage4Temperature: 1.25,
      stage3ZbllCap: null,
      stage3ZblsCap: null,
      stage4ZbllCap: null,
      zbllScale: 1,
      zblsScale: 1,
    };
  }
  const nested =
    calibration.calibration && typeof calibration.calibration === "object"
      ? calibration.calibration
      : calibration;
  return {
    stage3Temperature: normalizeLlFamilyTemperature(nested.stage3Temperature, 1.4),
    stage4Temperature: normalizeLlFamilyTemperature(nested.stage4Temperature, 1.25),
    stage3ZbllCap: normalizeOptionalLlRateCap(nested.stage3ZbllCap),
    stage3ZblsCap: normalizeOptionalLlRateCap(nested.stage3ZblsCap),
    stage4ZbllCap: normalizeOptionalLlRateCap(nested.stage4ZbllCap),
    zbllScale: Math.max(0.25, Math.min(2.5, Number(nested.zbllScale) || 1)),
    zblsScale: Math.max(0.25, Math.min(2.5, Number(nested.zblsScale) || 1)),
  };
}

function computeLlFamilySelectionProbability(scoreA, scoreB, temperature) {
  const temp = normalizeLlFamilyTemperature(temperature, 1.5);
  const weightA = Math.pow(Math.max(1e-6, Number(scoreA) || 0), 1 / temp);
  const weightB = Math.pow(Math.max(1e-6, Number(scoreB) || 0), 1 / temp);
  const denom = weightA + weightB;
  if (!Number.isFinite(denom) || denom <= 0) return 0.5;
  return weightB / denom;
}

function chooseLlFamilyForStage({
  preference,
  mixedCaseBias,
  calibration,
  scrambleSeed,
  stateKey,
  useZbStages,
  stageKey,
}) {
  const normalizedCalibration = normalizeLlFamilyCalibrationRecord(calibration);
  const familyScores = preference?.familyScores || null;
  const confidence = Number(preference?.confidence) || 0;
  const sampleCount = Number(preference?.sampleCount) || 0;
  const stage3Temperature = normalizeLlFamilyTemperature(
    normalizedCalibration.stage3Temperature,
    1.4,
  );
  const stage4Temperature = normalizeLlFamilyTemperature(
    normalizedCalibration.stage4Temperature,
    1.25,
  );
  const stage3Cap = useZbStages
    ? clampRate01(
        (normalizedCalibration.stage3ZblsCap ?? mixedCaseBias?.zblsRate) *
          normalizedCalibration.zblsScale,
      )
    : clampRate01(
        (normalizedCalibration.stage3ZbllCap ?? mixedCaseBias?.zbllRate) *
          normalizedCalibration.zbllScale,
      );
  const stage4Cap = clampRate01(
    (normalizedCalibration.stage4ZbllCap ?? mixedCaseBias?.zbllRate) * normalizedCalibration.zbllScale,
  );

  let familyA = "OLL";
  let familyB = useZbStages ? "ZBLS" : "ZBLL";
  let probabilityB = 0.5;
  let temperature = stage3Temperature;
  let capB = stage3Cap;

  if (stageKey === "stage4") {
    familyA = "PLL";
    familyB = "ZBLL";
    temperature = stage4Temperature;
    capB = stage4Cap;
  }

  const baseA = Number(familyScores?.[familyA]) || 0;
  const baseB = Number(familyScores?.[familyB]) || 0;
  const primaryFamily = preference?.primaryFamily || null;
  const primaryFamilyBoost = primaryFamily === familyB ? Math.max(0.5, confidence * 2.5) : 0;
  const confidenceBoost = Math.max(0, confidence - 0.5);
  const sampleBoost = sampleCount < 24 ? 0.08 : sampleCount < 60 ? 0.03 : 0;
  const capBoost = Number.isFinite(capB) && capB !== null && capB < 0.2 ? 0.05 : 0;
  const effectiveTemperature = normalizeLlFamilyTemperature(
    temperature + confidenceBoost * 0.3 + sampleBoost + capBoost,
    temperature,
  );
  probabilityB = computeLlFamilySelectionProbability(baseA, baseB + primaryFamilyBoost, effectiveTemperature);
  if (Number.isFinite(capB) && capB !== null) {
    const capBlend = capB < 0.1 ? 0.55 : capB < 0.2 ? 0.45 : 0.35;
    probabilityB = probabilityB * (1 - capBlend) + capB * capBlend;
  }
  probabilityB = Math.max(0, Math.min(1, probabilityB));
  const rollSeed = `${scrambleSeed}|${stateKey}|${stageKey}|${familyA}|${familyB}|${effectiveTemperature.toFixed(3)}`;
  const roll = hashStringToUnitInterval(rollSeed);
  const selectedFamily = roll < probabilityB ? familyB : familyA;
  return {
    familyA,
    familyB,
    selectedFamily,
    alternateFamily: selectedFamily === familyA ? familyB : familyA,
    probabilityB,
    temperature: effectiveTemperature,
    capB,
    roll,
    confidence,
    sampleCount,
    familyScores,
  };
}

function isTopEdgeOrientationSolvedForLL(data, ctx) {
  return orbitMatches(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.topEdgePositions,
    false,
    true,
  );
}

function countTopEdgeOrientationSolvedForLL(data, ctx) {
  if (!data || !ctx?.solvedData?.EDGES || !Array.isArray(ctx.topEdgePositions)) return 0;
  return countSolvedAtPositions(
    data.EDGES,
    ctx.solvedData.EDGES,
    ctx.topEdgePositions,
    false,
    true,
  );
}

function getMixedCfopLlSignal(
  downstreamProfile,
  nextStateKey,
  nextData,
  ctx,
  pairProgress,
  targetPairs,
  predictionWeight = 1,
  mixedCaseBias = null,
) {
  if (!nextData || !ctx) {
    return {
      llPriority: 0,
      downstreamBonus: 0,
      preserveCandidate: false,
      exactEO: false,
      topEdgeOrientationSolvedCount: 0,
      topEdgeOrientationRate: 0,
      zbllRate: 0,
      zblsRate: 0,
      eoLikeRate: 0,
    };
  }
  const normalizedWeight = normalizeF2LDownstreamWeight(predictionWeight, DEFAULT_F2L_DOWNSTREAM_WEIGHT);
  const topEdgeCount = Array.isArray(ctx.topEdgePositions) ? ctx.topEdgePositions.length : 0;
  if (topEdgeCount <= 0) {
    return {
      llPriority: 0,
      downstreamBonus: 0,
      preserveCandidate: false,
      exactEO: false,
      topEdgeOrientationSolvedCount: 0,
      topEdgeOrientationRate: 0,
      zbllRate: 0,
      zblsRate: 0,
      eoLikeRate: 0,
    };
  }
  const minProgressForLLSignal = Math.max(1, targetPairs - 1);
  const orientedTopEdges = countTopEdgeOrientationSolvedForLL(nextData, ctx);
  const topEdgeOrientationRate = orientedTopEdges / topEdgeCount;
  const exactEO = orientedTopEdges >= topEdgeCount;
  const downstreamMatch =
    downstreamProfile && nextStateKey !== undefined && nextStateKey !== null
      ? findF2LDownstreamStateEntry(downstreamProfile, nextStateKey)
      : null;
  const downstreamStateEntry = downstreamMatch?.stateEntry || null;
  const llFamilyPreference = downstreamStateEntry
    ? buildLlFamilyScoresFromStateEntry(downstreamStateEntry, mixedCaseBias)
    : null;
  const zbllRate = clampRate01(downstreamStateEntry?.zbllRate) ?? 0;
  const zblsRate = clampRate01(downstreamStateEntry?.zblsRate) ?? 0;
  const eoLikeRate = clampRate01(downstreamStateEntry?.eoLikeRate) ?? 0;
  const biasXCrossRate = clampRate01(mixedCaseBias?.xcrossRate) ?? 0;
  const biasXXCrossRate = clampRate01(mixedCaseBias?.xxcrossRate) ?? 0;
  const biasZbllRate = clampRate01(mixedCaseBias?.zbllRate) ?? 0;
  const biasZblsRate = clampRate01(mixedCaseBias?.zblsRate) ?? 0;
  const preferredLlFamily = llFamilyPreference?.primaryFamily || "OLL";
  const preferredLlConfidence = llFamilyPreference?.confidence || 0;

  if (!Number.isFinite(pairProgress) || pairProgress < minProgressForLLSignal) {
    return {
      llPriority: 0,
      downstreamBonus: 0,
      preserveCandidate: false,
      exactEO,
      topEdgeOrientationSolvedCount: orientedTopEdges,
      topEdgeOrientationRate,
      zbllRate,
      zblsRate,
      eoLikeRate,
      preferredLlFamily,
      preferredLlConfidence,
    };
  }

  const isLastSlotWindow = pairProgress >= minProgressForLLSignal && pairProgress < targetPairs;
  const isLlWindow = pairProgress >= targetPairs;
  const llSupportRateBase = isLlWindow ? Math.max(zbllRate, eoLikeRate) : Math.max(zblsRate, eoLikeRate);
  const llSupportRate = clampRate01(
      llSupportRateBase +
      (isLlWindow ? biasZbllRate * 0.22 : biasZblsRate * 0.18) +
      biasXCrossRate * 0.08 +
      biasXXCrossRate * 0.06,
  ) ?? llSupportRateBase;
  const biasAggression = 1 + biasZbllRate * 0.45 + biasXCrossRate * 0.2 + biasXXCrossRate * 0.15;
  const familyAggression =
    preferredLlFamily === "ZBLL"
      ? 1.12
      : preferredLlFamily === "ZBLS"
        ? 1.08
        : preferredLlFamily === "PLL"
          ? 1.03
          : 1;
  let llPriority = 0;
  let downstreamBonus = 0;
  let preserveCandidate = false;

  if (exactEO) {
    llPriority = isLlWindow ? 4 : 3;
    if (isLlWindow && biasZbllRate >= 0.45) {
      llPriority = 5;
    }
    downstreamBonus = -Math.min(
      MAX_F2L_MIXED_LL_SIGNAL_BONUS,
      (1.2 + normalizedWeight * 1.25 + llSupportRate * 2.4 + preferredLlConfidence * 0.9) *
        biasAggression *
        familyAggression,
    );
    preserveCandidate = true;
  } else if (topEdgeOrientationRate >= 0.75) {
    llPriority = isLlWindow ? 2 : 1;
    downstreamBonus = -Math.min(
      MAX_F2L_ZBLL_OPPORTUNITY_BONUS,
      ((topEdgeOrientationRate - 0.5) * (1 + normalizedWeight) + llSupportRate * 1.75 + preferredLlConfidence * 0.55) *
        biasAggression *
        familyAggression,
    );
    preserveCandidate =
      llSupportRate >= 0.12 ||
      isLastSlotWindow ||
      biasZbllRate >= 0.35 ||
      preferredLlFamily === "ZBLL" ||
      preferredLlFamily === "ZBLS";
  } else if (isLastSlotWindow && llSupportRate >= 0.2) {
    llPriority = 1;
    downstreamBonus = -Math.min(
      MAX_F2L_ZBLL_OPPORTUNITY_BONUS * 0.9,
      (0.35 + llSupportRate * 1.4 + preferredLlConfidence * 0.35) * biasAggression * familyAggression,
    );
    preserveCandidate = true;
  }
  if (llPriority > 0 && llSupportRate >= 0.28) {
    llPriority = Math.min(5, llPriority + 1);
  }

  return {
    llPriority,
    downstreamBonus,
    preserveCandidate,
    exactEO,
    topEdgeOrientationSolvedCount: orientedTopEdges,
    topEdgeOrientationRate,
    zbllRate,
    zblsRate,
    eoLikeRate,
    preferredLlFamily,
    preferredLlConfidence,
  };
}

function buildF2LRescueProfiles(styleProfile) {
  const base = normalizeF2LStyleProfile(styleProfile);
  const out = [];
  const add = (candidate) => {
    if (!candidate || isSameF2LStyleProfile(candidate, base)) return;
    for (let i = 0; i < out.length; i++) {
      if (isSameF2LStyleProfile(out[i], candidate)) return;
    }
    out.push(candidate);
  };
  add(F2L_STYLE_PROFILE_PRESETS.balanced);
  add(F2L_STYLE_PROFILE_PRESETS.legacy);
  return out;
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

// Compose two y-axis rotations (90° increments: 0=none,1=y,2=y2,3=y')
const Y_ROT_TO_IDX = { "": 0, "y": 1, "y2": 2, "y'": 3 };
const IDX_TO_Y_ROT = ["", "y", "y2", "y'"];
function composeYRot(a, b) {
  const ia = Y_ROT_TO_IDX[a] ?? 0;
  const ib = Y_ROT_TO_IDX[b] ?? 0;
  return IDX_TO_Y_ROT[(ia + ib) % 4];
}

// Extract leading y-axis rotation token from an algorithm string, returning
// { leadingRot, rest }.  Non-y rotations are left in place.
function extractLeadingYRot(alg) {
  const tokens = splitMoves(alg);
  if (!tokens.length) return { leadingRot: "", rest: alg };
  const first = tokens[0];
  if (first === "y" || first === "y'" || first === "y2") {
    return { leadingRot: first, rest: tokens.slice(1).join(" ") };
  }
  return { leadingRot: "", rest: alg };
}

function buildFormulaCandidate(rot, preAuf, alg, postAuf = "") {
  // If the algorithm already starts with a y-rotation, absorb it into rot so
  // the conjugation bracket stays balanced and the net cube-frame change is zero.
  const { leadingRot, rest: strippedAlg } = extractLeadingYRot(alg);
  const combinedRot = composeYRot(rot, leadingRot);
  // Use conjugation so rotation variants keep the global cube frame.
  // Example: y (alg) y'
  return joinMoves([combinedRot, preAuf, strippedAlg, invertRotation(combinedRot), postAuf]);
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

function touchMapEntry(map, key, value) {
  map.delete(key);
  map.set(key, value);
}

function setBoundedMapEntry(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function maybePostOptimizeMoves(startPattern, moves, solveMode, options, ctx) {
  const enabledByMode = false;
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
    timeBudgetMs: normalizeDepth(options?.postInsertionTimeMs, enabledByMode ? 900 : 500),
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
    const edgeMoveTables = buildEdgeMoveTables(solvedPattern, solvedData);
    const cornerMoveTables = buildCornerMoveTables(solvedPattern, solvedData);
    const crossPruneTable = buildCrossPruneTable(bottomEdgePositions, solvedData, edgeMoveTables);
    const crossMoveTable = buildCrossMoveTable(edgeMoveTables);
    const solvedCrossStateIndex = (() => {
      const p0 = bottomEdgePositions[0];
      const p1 = bottomEdgePositions[1];
      const p2 = bottomEdgePositions[2];
      const p3 = bottomEdgePositions[3];
      return encodeCrossStateFromParts(
        p0, p1, p2, p3,
        solvedData.EDGES.orientation[p0] & 1,
        solvedData.EDGES.orientation[p1] & 1,
        solvedData.EDGES.orientation[p2] & 1,
        solvedData.EDGES.orientation[p3] & 1,
      );
    })();
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
        moveTable: buildF2LPairMoveTable(
          { cornerTargetPos, edgeTargetPos },
          cornerMoveTables,
          edgeMoveTables,
        ),
      });
    }

    const f2lSolvedPairStates = f2lPairDefs.map((def) =>
      encodeF2LPairState(def.cornerTargetPos, def.cornerTargetOri, def.edgeTargetPos, def.edgeTargetOri),
    );

    const ctx = {
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
      crossMoveTable,
      solvedCrossStateIndex,
      crossEdgePieceIds,
      crossPieceIndexById,
      f2lPairDefs,
      f2lSolvedPairStates,
      cornerMoveTables,
      edgeMoveTables,
    };

    // Pre-warm OLL and PLL case libraries so the first real solve doesn't pay
    // a 130ms + 210ms cold-start penalty for these stage formula lookups.
    _warmOllPllLibraries(ctx);

    return ctx;
  })();
  return contextPromise;
}

function _warmOllPllLibraries(ctx) {
  const ollStage = {
    name: "OLL",
    formulaKeys: ["OLL"],
    maxDepth: 22,
    formulaPreAufList: FORMULA_AUF,
    key(data) {
      const f2lC = buildKeyForOrbit(data.CORNERS, ctx.f2lCornerPositions, true, true);
      const f2lE = buildKeyForOrbit(data.EDGES, ctx.f2lEdgePositions, true, true);
      const ollC = buildKeyForOrbit(data.CORNERS, ctx.topCornerPositions, false, true);
      const ollE = buildKeyForOrbit(data.EDGES, ctx.topEdgePositions, false, true);
      return `FC:${f2lC}|FE:${f2lE}|OC:${ollC}|OE:${ollE}`;
    },
  };
  const pllStage = {
    name: "PLL",
    formulaKeys: ["PLL"],
    maxDepth: 22,
    formulaPreAufList: FORMULA_AUF,
    formulaPostAufList: FORMULA_AUF,
    key(data) {
      const c = buildKeyForOrbit(data.CORNERS, [0, 1, 2, 3, 4, 5, 6, 7], true, true);
      const e = buildKeyForOrbit(data.EDGES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], true, true);
      return `C:${c}|E:${e}`;
    },
  };

  // Use getFormulaListForStage (not getFormulaListByKey) to match the sanitization
  // and deduplication that solveWithFormulaDbSingleStage uses, ensuring cache key match.
  const ollFormulas = filterValidFormulas(getFormulaListForStage(ollStage), ctx);
  const pllFormulas = filterValidFormulas(getFormulaListForStage(pllStage), ctx);

  if (ollFormulas.length) {
    getSingleStageFormulaCaseLibrary(
      ollStage, ctx, ollFormulas, FORMULA_AUF, [""], ["OLL"], null, null, null,
    );
  }
  if (pllFormulas.length) {
    getSingleStageFormulaCaseLibrary(
      pllStage, ctx, pllFormulas, FORMULA_AUF, FORMULA_AUF, ["PLL"], null, null, null,
    );
  }

  // Pre-warm ZBLS and ZBLL case libraries — enables O(1) lookup so ZBLS never falls
  // back to the 280K-node brute formula search (which took 13s without this warmup).
  const zblsStage = {
    name: "ZBLS",
    formulaKeys: ["ZBLS"],
    maxDepth: 22,
    formulaPreAufList: FORMULA_AUF,
    key(data) {
      const f2lC = buildKeyForOrbit(data.CORNERS, ctx.f2lCornerPositions, true, true);
      const f2lE = buildKeyForOrbit(data.EDGES, ctx.f2lEdgePositions, true, true);
      const ollE = buildKeyForOrbit(data.EDGES, ctx.topEdgePositions, false, true);
      return `FC:${f2lC}|FE:${f2lE}|OE:${ollE}`;
    },
  };
  const zbllStage = {
    name: "ZBLL",
    formulaKeys: ["ZBLL"],
    maxDepth: 22,
    formulaPreAufList: FORMULA_AUF,
    formulaPostAufList: FORMULA_AUF,
    key(data) {
      const c = buildKeyForOrbit(data.CORNERS, [0, 1, 2, 3, 4, 5, 6, 7], true, true);
      const e = buildKeyForOrbit(data.EDGES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], true, true);
      return `C:${c}|E:${e}`;
    },
  };
  const zblsFormulas = filterValidFormulas(getFormulaListForStage(zblsStage), ctx);
  const zbllFormulas = filterValidFormulas(getFormulaListForStage(zbllStage), ctx);
  if (zblsFormulas.length) {
    getSingleStageFormulaCaseLibrary(
      zblsStage, ctx, zblsFormulas, FORMULA_AUF, [""], ["ZBLS"], null, null, null,
    );
  }
  if (zbllFormulas.length) {
    getSingleStageFormulaCaseLibrary(
      zbllStage, ctx, zbllFormulas, FORMULA_AUF, FORMULA_AUF, ["ZBLL"], null, null, null,
    );
  }
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
          const td = transformation.transformationData;
          const compactTransform = td
            ? {
                cPerm: new Uint8Array(td.CORNERS.permutation),
                cTwist: new Uint8Array(td.CORNERS.orientationDelta),
                ePerm: new Uint8Array(td.EDGES.permutation),
                eFlip: new Uint8Array(td.EDGES.orientationDelta),
              }
            : null;
          const entry = {
            alg: candidate,
            moves,
            transformation,
            compactTransform,
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
              compactTransform,
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
  const useZbStages = solveMode === "zb";
  const allowRelaxedSearch = options.allowRelaxedSearch !== false;
  const styleProfileInput =
    options.f2lStyleProfile !== undefined ? options.f2lStyleProfile : options.styleProfile;
  const transitionProfileInput =
    options.f2lTransitionProfile !== undefined
      ? options.f2lTransitionProfile
      : options.transitionProfile;
  const downstreamProfileInput =
    options.f2lDownstreamProfile !== undefined
      ? options.f2lDownstreamProfile
      : options.downstreamProfile;
  const llFamilyCalibrationInput =
    options.llFamilyCalibration !== undefined ? options.llFamilyCalibration : null;
  const hasStyleOptIn = styleProfileInput !== undefined && styleProfileInput !== null;
  const f2lStyleProfile = hasStyleOptIn
    ? normalizeF2LStyleProfile(styleProfileInput)
    : F2L_STYLE_PROFILE_PRESETS.legacy;
  const mixedCaseBias = normalizeMixedCaseBias(styleProfileInput);
  const mixedCfopStages = options.enableMixedCfopStages === true || isMixedCfopStyleProfile(styleProfileInput);
  const f2lTransitionProfile =
    transitionProfileInput !== undefined && transitionProfileInput !== null
      ? transitionProfileInput
      : null;
  const enableOllPllPrediction = options.enableOllPllPrediction !== false;
  const f2lDownstreamProfile =
    enableOllPllPrediction && downstreamProfileInput !== undefined && downstreamProfileInput !== null
      ? downstreamProfileInput
      : null;
  const f2lDownstreamWeight = normalizeF2LDownstreamWeight(
    options.ollPllPredictionWeight,
    DEFAULT_F2L_DOWNSTREAM_WEIGHT,
  );
  const llFamilyCalibration = normalizeLlFamilyCalibrationRecord(llFamilyCalibrationInput);
  const enableStyleFallback = hasStyleOptIn && options.enableStyleFallback !== false;
  const deadlineTs = normalizeNonNegativeDepth(options.deadlineTs, 0);
  const mixedXCrossRate = clampRate01(mixedCaseBias.xcrossRate) ?? 0;
  const mixedXXCrossRate = clampRate01(mixedCaseBias.xxcrossRate) ?? 0;
  const scrambleSeed = buildSolverDecisionSeed(options);
  const scrambleRoll = hashStringToUnitInterval(scrambleSeed);
  let crossTargetPairs = useZbStages ? 1 : 0;
  if (!useZbStages && mixedCfopStages) {
    const normalizedXCrossRate = Math.max(0, Math.min(0.98, mixedXCrossRate));
    const normalizedXXCrossRate = Math.max(0, Math.min(normalizedXCrossRate, mixedXXCrossRate));
    if (scrambleRoll < normalizedXXCrossRate) {
      crossTargetPairs = 2;
    } else if (scrambleRoll < normalizedXCrossRate) {
      crossTargetPairs = 1;
    } else {
      crossTargetPairs = 0;
    }
  }
  const crossTargetPairsOverride = normalizeCrossTargetPairsOverride(
    options.crossTargetPairsOverride,
    null,
  );
  if (crossTargetPairsOverride !== null) {
    crossTargetPairs = crossTargetPairsOverride;
  }
  const crossStageName =
    crossTargetPairs >= 2 ? "XXCross" : crossTargetPairs >= 1 ? "XCross" : "Cross";
  const mixedCrossDepthBoost =
    mixedCfopStages && !useZbStages
      ? Math.min(
          3,
          Math.round(
            mixedCaseBias.xcrossRate * 1.5 +
              mixedCaseBias.xxcrossRate * 2.2 +
              Math.max(0, crossTargetPairs - 1) * 0.6,
          ),
        )
      : 0;
  const f2lStageName = useZbStages ? "F2L2" : "F2L";
  const f2lStageDisplayName = useZbStages ? "F2L (2 Slots)" : "F2L";
  const f2lTargetPairs = useZbStages ? 3 : 4;
  const stage3Name = useZbStages ? "ZBLS" : "OLL";
  const stage3FormulaKeys = useZbStages ? ["ZBLS", "OLL"] : ["OLL"];
  const stage4Name = useZbStages ? "ZBLL" : "PLL";
  const stage4FormulaKeys = useZbStages ? ["ZBLL", "PLL"] : ["PLL"];
  const llFamilyPreferenceCache = new Map();
  const llFamilySelectionCache = new Map();

  function getLlFamilyPreference(startPattern) {
    if (!startPattern || !startPattern.patternData) return null;
    const stateKey = getF2LStateKey(startPattern.patternData, ctx);
    const cacheKey = `${stateKey}::${useZbStages ? "zb" : "cfop"}`;
    if (llFamilyPreferenceCache.has(cacheKey)) {
      return llFamilyPreferenceCache.get(cacheKey);
    }
    const downstreamMatch =
      f2lDownstreamProfile && stateKey !== undefined && stateKey !== null
        ? findF2LDownstreamStateEntry(f2lDownstreamProfile, stateKey)
        : null;
    const downstreamStateEntry = downstreamMatch?.stateEntry || null;
    const preference = downstreamStateEntry
      ? buildLlFamilyScoresFromStateEntry(downstreamStateEntry, mixedCaseBias)
      : null;
    llFamilyPreferenceCache.set(cacheKey, preference);
    return preference;
  }

  function getCaseAwareFormulaPreference(startPattern, stageKey, stage = null) {
    if (!startPattern || !startPattern.patternData) return null;
    const stateKey = getF2LStateKey(startPattern.patternData, ctx);
    const playerStateEntry =
      f2lDownstreamProfile && stateKey !== undefined && stateKey !== null
        ? findDirectF2LDownstreamStateEntry(f2lDownstreamProfile, stateKey)
        : null;
    const fallbackStateEntry =
      f2lDownstreamProfile?.fallbackProfile && stateKey !== undefined && stateKey !== null
        ? findDirectF2LDownstreamStateEntry(f2lDownstreamProfile.fallbackProfile, stateKey)
        : null;
    const selection = getLlFamilySelection(startPattern, stageKey);
    const selectedFamily = selection?.selectedFamily || (stageKey === "stage4" ? "PLL" : "OLL");
    const basePreferenceMap = getLlFamilyPreference(startPattern)?.formulaPriorityMap || null;
    const familyPreferenceMap = buildCaseAwareFormulaPreferenceMap(
      playerStateEntry,
      fallbackStateEntry,
      stageKey,
      selectedFamily,
      basePreferenceMap,
    );
    return buildExactCaseFormulaPreferenceMap(
      startPattern,
      stage,
      ctx,
      playerStateEntry,
      fallbackStateEntry,
      stageKey,
      selectedFamily,
      familyPreferenceMap,
    );
  }

  function getLlFamilySelection(startPattern, stageKey) {
    if (!startPattern || !startPattern.patternData) return null;
    const stateKey = getF2LStateKey(startPattern.patternData, ctx);
    const cacheKey = `${stateKey}::${useZbStages ? "zb" : "cfop"}::${stageKey}`;
    if (llFamilySelectionCache.has(cacheKey)) {
      return llFamilySelectionCache.get(cacheKey);
    }
    const preference = getLlFamilyPreference(startPattern);
    const selection = chooseLlFamilyForStage({
      preference,
      mixedCaseBias,
      calibration: llFamilyCalibration,
      scrambleSeed,
      stateKey,
      useZbStages,
      stageKey,
    });
    llFamilySelectionCache.set(cacheKey, selection);
    return selection;
  }

  function shouldPreferMixedZBLL(startPattern) {
    if (!mixedCfopStages || useZbStages) return false;
    return getLlFamilySelection(startPattern, "stage3")?.selectedFamily === "ZBLL";
  }

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

  return [
    {
      name: crossStageName,
      displayName: crossStageName,
      allowRelaxedSearch,
      isCrossLike: true,
      deadlineTs,
      maxDepth: normalizeDepth(
        options.crossMaxDepth,
        useZbStages
          ? profile.crossMaxDepth + 2
          : mixedCfopStages
            ? profile.crossMaxDepth + 1 + mixedCrossDepthBoost
            : profile.crossMaxDepth,
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
    {
      name: f2lStageName,
      displayName: f2lStageDisplayName,
      allowRelaxedSearch,
      formulaKeys: ["F2L"],
      mixedCfopStages,
      enableStyleFallback,
      deadlineTs,
      f2lStyleProfile,
      // Formula-driven F2L commonly exceeds 16 moves; keep a larger cap here.
      maxDepth: normalizeDepth(options.f2lMaxDepth, profile.f2lMaxDepth),
      formulaMaxSteps: normalizeDepth(options.f2lFormulaMaxSteps, profile.f2lFormulaMaxSteps),
      formulaBeamWidth: normalizeDepth(options.f2lFormulaBeamWidth, profile.f2lFormulaBeamWidth),
      formulaExpansionLimit: normalizeDepth(
        options.f2lFormulaExpansionLimit,
        profile.f2lFormulaExpansionLimit,
      ),
      formulaMaxAttempts: normalizeDepth(options.f2lFormulaMaxAttempts, profile.f2lFormulaMaxAttempts),
      formulaBeamBudgetMs: Number.isFinite(options.f2lFormulaBeamBudgetMs) && options.f2lFormulaBeamBudgetMs > 0
        ? options.f2lFormulaBeamBudgetMs
        : profile.f2lFormulaBeamBudgetMs,
      // compact IDA* runs as fallback inside solveStageByFormulaDb; disable the slow KPattern IDA*
      disableSearchFallback: true,
      searchMaxDepth: normalizeDepth(options.f2lSearchMaxDepth, profile.f2lSearchMaxDepth),
      nodeLimit: normalizeDepth(options.f2lNodeLimit, profile.f2lNodeLimit),
      f2lTargetPairs,
      // Keep D fixed after cross to reduce branching and match CFOP move habits.
      moveIndices: ctx.noDMoveIndices,
      isSolved(data) {
        return isCrossWithF2LPairTarget(data, ctx, f2lTargetPairs);
      },
      usePairTable: !useZbStages,
      f2lTransitionProfile,
      f2lDownstreamProfile,
      f2lDownstreamWeight,
      mixedCaseBias,
      heuristic(data) {
        const mismatch = getF2LMismatch(data);
        const mismatchBound = stageHeuristicFromMismatch(
          mismatch.pieceMismatch,
          mismatch.orientationMismatch,
        );
        const pairNeed = getF2LPairDeficit(data, ctx, f2lTargetPairs);
        if (useZbStages) {
          if (pairNeed === 0) return 0;
          return Math.max(pairNeed, Math.min(mismatchBound, pairNeed + 2));
        }
        const pairTableBound = getF2LPairTableLowerBound(data, ctx);
        return Math.max(mismatchBound, pairTableBound);
      },
      mismatch(data) {
        const mismatch = getF2LMismatch(data);
        if (!useZbStages) return mismatch;
        const pairNeed = getF2LPairDeficit(data, ctx, f2lTargetPairs);
        return {
          pieceMismatch: mismatch.pieceMismatch + pairNeed,
          orientationMismatch: mismatch.orientationMismatch,
        };
      },
      key(data) {
        return getF2LStateKey(data, ctx);
      },
    },
    {
      name: stage3Name,
      displayName: stage3Name,
      allowRelaxedSearch,
      formulaKeys: stage3FormulaKeys,
      getFormulaKeys(startPattern) {
        const selection = getLlFamilySelection(startPattern, "stage3");
        if (useZbStages) {
          return selection?.selectedFamily === "ZBLS" ? ["ZBLS"] : ["OLL"];
        }
        if (mixedCfopStages && selection?.selectedFamily === "ZBLL") {
          return ["ZBLL"];
        }
        return stage3FormulaKeys;
      },
      getFormulaPreferenceMap(startPattern) {
        return getCaseAwareFormulaPreference(startPattern, "stage3", this);
      },
      getFallbackFormulaKeys(startPattern) {
        if (useZbStages) {
          const selection = getLlFamilySelection(startPattern, "stage3");
          return selection?.selectedFamily === "ZBLS" ? ["OLL"] : ["ZBLS"];
        }
        if (mixedCfopStages) {
          const selection = getLlFamilySelection(startPattern, "stage3");
          return selection?.selectedFamily === "ZBLL" ? ["OLL"] : ["ZBLL"];
        }
        return null;
      },
      getDisplayName(startPattern) {
        if (useZbStages) {
          const selection = getLlFamilySelection(startPattern, "stage3");
          if (selection?.selectedFamily === "ZBLS") return "ZBLS (case policy)";
          return stage3Name;
        }
        if (mixedCfopStages && shouldPreferMixedZBLL(startPattern)) {
          return "ZBLL (case policy)";
        }
        return stage3Name;
      },
      getSolvedDisplayName(result, startPattern) {
        if (useZbStages) return stage3Name;
        if (!mixedCfopStages) return stage3Name;
        return result?.formulaKey === "ZBLL" ? "ZBLL" : "OLL";
      },
      acceptFormulaResult(nextPattern, formulaKey, startPattern) {
        if (useZbStages) {
          if (formulaKey === "ZBLS") {
            return isZBLSSolved(nextPattern.patternData, ctx);
          }
          if (formulaKey === "OLL") {
            return isOLLSolved(nextPattern.patternData, ctx);
          }
          return isZBLSSolved(nextPattern.patternData, ctx) || isOLLSolved(nextPattern.patternData, ctx);
        }
        if (formulaKey === "ZBLL") {
          return isStrictSolvedPattern(nextPattern, nextPattern.patternData, ctx);
        }
        return isOLLSolved(nextPattern.patternData, ctx);
      },
      deadlineTs,
      formulaPreAufList: FORMULA_AUF,
      formulaAttemptLimit: normalizeDepth(options.zblsFormulaAttemptLimit, useZbStages ? 40000 : 0),
      maxDepth: normalizeDepth(
        options.ollMaxDepth,
        mixedCfopStages ? Math.max(profile.ollMaxDepth, profile.pllMaxDepth) : profile.ollMaxDepth,
      ),
      searchMaxDepth: normalizeDepth(
        options.zblsSearchMaxDepth,
        useZbStages ? 11 : profile.ollMaxDepth,
      ),
      nodeLimit: normalizeDepth(options.zblsNodeLimit, useZbStages ? 280000 : 0),
      // ZBLS uses case library (O(1) lookup) — no IDA* fallback needed; missing case = OLL fallback
      disableSearchFallback: useZbStages,
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
      displayName: stage4Name,
      allowRelaxedSearch,
      formulaKeys: stage4FormulaKeys,
      getDisplayName(startPattern) {
        const selection = getLlFamilySelection(startPattern, "stage4");
        if (!useZbStages) {
          if (mixedCfopStages && selection?.selectedFamily === "ZBLL") {
            return "ZBLL (case policy)";
          }
          return stage4Name;
        }
        if (selection?.selectedFamily === "ZBLL") return "ZBLL (case policy)";
        return stage4Name;
      },
      getSolvedDisplayName(result, startPattern) {
        if (!useZbStages) return result?.formulaKey === "ZBLL" ? "ZBLL" : "PLL";
        return result?.formulaKey === "ZBLL" ? "ZBLL" : "PLL";
      },
      getFormulaKeys(startPattern) {
        const selection = getLlFamilySelection(startPattern, "stage4");
        if (!useZbStages) {
          if (mixedCfopStages && selection?.selectedFamily === "ZBLL") {
            return ["ZBLL"];
          }
          return stage4FormulaKeys;
        }
        return selection?.selectedFamily === "ZBLL" ? ["ZBLL"] : ["PLL"];
      },
      getFormulaPreferenceMap(startPattern) {
        return getCaseAwareFormulaPreference(startPattern, "stage4", this);
      },
      getFallbackFormulaKeys(startPattern) {
        const selection = getLlFamilySelection(startPattern, "stage4");
        if (!useZbStages) {
          if (mixedCfopStages) {
            return selection?.selectedFamily === "ZBLL" ? ["PLL"] : ["ZBLL"];
          }
          return null;
        }
        return selection?.selectedFamily === "ZBLL" ? ["PLL"] : ["ZBLL"];
      },
      omitIfNoMoves: mixedCfopStages === true,
      deadlineTs,
      formulaPreAufList: FORMULA_AUF,
      formulaPostAufList: FORMULA_AUF,
      formulaAttemptLimit: normalizeDepth(options.zbllFormulaAttemptLimit, useZbStages ? 50000 : 0),
      maxDepth: normalizeDepth(options.pllMaxDepth, profile.pllMaxDepth),
      searchMaxDepth: normalizeDepth(
        options.zbllSearchMaxDepth,
        useZbStages ? 10 : profile.pllMaxDepth,
      ),
      nodeLimit: normalizeDepth(options.zbllNodeLimit, useZbStages ? 180000 : 0),
      // ZBLL uses case library (O(1) lookup) — no IDA* fallback needed; missing case = PLL fallback
      disableSearchFallback: useZbStages,
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
  return [];
}

function resolveStageFormulaKeys(stageOrName, startPattern = null, ctx = null) {
  const stageName =
    typeof stageOrName === "string" ? stageOrName : stageOrName?.name || "";
  if (stageOrName && typeof stageOrName === "object") {
    if (typeof stageOrName.getFormulaKeys === "function") {
      try {
        const resolved = stageOrName.getFormulaKeys(startPattern, ctx);
        if (Array.isArray(resolved) && resolved.length) {
          return resolved.filter((key) => typeof key === "string" && key.trim());
        }
      } catch (_) {
        // Fall through to the static keys below.
      }
    }
    if (Array.isArray(stageOrName.formulaKeys) && stageOrName.formulaKeys.length) {
      return stageOrName.formulaKeys.slice();
    }
  }
  return stageName ? [stageName] : [];
}

function resolveStageDisplayName(stage, startPattern = null, ctx = null) {
  if (!stage || typeof stage !== "object") return "";
  if (typeof stage.getDisplayName === "function") {
    try {
      const resolved = stage.getDisplayName(startPattern, ctx);
      if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
    } catch (_) {
      // Fall through to the static display name below.
    }
  }
  return stage.displayName || stage.name || "";
}

function resolveSolvedStageDisplayName(stage, startPattern, result, ctx) {
  if (!stage || typeof stage !== "object") return "";
  if (typeof stage.getSolvedDisplayName === "function") {
    try {
      const resolved = stage.getSolvedDisplayName(result, startPattern, ctx);
      if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
    } catch (_) {
      // Fall through to the start label below.
    }
  }
  return resolveStageDisplayName(stage, startPattern, ctx);
}

function getFormulaListForStage(stageOrName, startPattern = null, ctx = null) {
  const stageName =
    typeof stageOrName === "string" ? stageOrName : stageOrName?.name || "";
  const keys = resolveStageFormulaKeys(stageOrName, startPattern, ctx);
  const cacheKey = `${stageName}::${keys.join("|")}`;
  const cached = formulaListCache.get(cacheKey);
  if (cached) return cached;
  const seen = new Set();
  const merged = [];
  for (let i = 0; i < keys.length; i++) {
    const formulas = getFormulaListByKey(keys[i]);
    for (let j = 0; j < formulas.length; j++) {
      const alg = sanitizeFormulaAlg(formulas[j]);
      if (!alg || seen.has(alg)) continue;
      seen.add(alg);
      merged.push(alg);
    }
  }
  formulaListCache.set(cacheKey, merged);
  if (formulaListCache.size > 24) {
    const oldest = formulaListCache.keys().next().value;
    if (oldest !== undefined) formulaListCache.delete(oldest);
  }
  return merged;
}

function stageHasFormulaKey(stage, key, startPattern = null, ctx = null) {
  return Boolean(stage && resolveStageFormulaKeys(stage, startPattern, ctx).includes(key));
}

function isSingleStageFormulaStage(stage) {
  if (!stage || typeof stage !== "object") return false;
  if (
    stage.name === "OLL" ||
    stage.name === "PLL" ||
    stage.name === "ZBLS" ||
    stage.name === "ZBLL" ||
    stage.name === "CMLL" ||
    stage.name === "LSE"
  ) {
    return true;
  }
  return (
    stageHasFormulaKey(stage, "OLL") ||
    stageHasFormulaKey(stage, "PLL") ||
    stageHasFormulaKey(stage, "ZBLS") ||
    stageHasFormulaKey(stage, "ZBLL") ||
    stageHasFormulaKey(stage, "CMLL") ||
    stageHasFormulaKey(stage, "LSE")
  );
}

function isPllLikeFormulaStage(stage) {
  return (
    stage?.name === "PLL" ||
    stage?.name === "ZBLL" ||
    stageHasFormulaKey(stage, "PLL") ||
    stageHasFormulaKey(stage, "ZBLL")
  );
}

function shouldUseSingleStageCaseLibrary(stage, formulas) {
  if (!stage || !Array.isArray(formulas) || !formulas.length) return false;
  return (
    stage.name === "CMLL" || stage.name === "LSE" ||
    stage.name === "OLL" || stage.name === "PLL" ||
    stage.name === "ZBLS" || stage.name === "ZBLL"
  );
}

function buildFormulaPreferenceSignature(formulaPreferenceMap, limit = 24) {
  if (!formulaPreferenceMap || typeof formulaPreferenceMap.size !== "number" || formulaPreferenceMap.size <= 0) {
    return "";
  }
  const entries = Array.from(formulaPreferenceMap.entries())
    .map(([formula, count]) => ({
      formula: String(formula || "").trim(),
      count: Number(count) || 0,
    }))
    .filter((entry) => entry.formula && entry.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.formula.localeCompare(b.formula);
    })
    .slice(0, Math.max(1, Math.floor(limit)));
  return `${formulaPreferenceMap.size}:${entries
    .map((entry) => `${entry.formula}:${entry.count}`)
    .join("|")}`;
}

function getFormulaPreferenceScore(formulaPreferenceMap, formula, formulaCanonicalLookup = null) {
  if (!formulaPreferenceMap || typeof formulaPreferenceMap.get !== "function") return 0;
  const normalized = normalizeFormulaMatchText(formula);
  if (!normalized) return 0;
  const directScore = Number(formulaPreferenceMap.get(formula) || 0);
  if (directScore > 0) return directScore;
  const canonicalFormula = formulaCanonicalLookup?.get(normalized) || normalized;
  const canonicalScore = Number(formulaPreferenceMap.get(canonicalFormula) || 0);
  if (canonicalScore > 0) return canonicalScore;
  return Number(formulaPreferenceMap.get(normalized) || 0);
}

function getFormulaKeyPreferenceScore(formulaKey, formulaPreferenceMap) {
  if (!formulaKey || !formulaPreferenceMap || typeof formulaPreferenceMap.get !== "function") return 0;
  const sourceFormulas = getFormulaListByKey(formulaKey);
  let total = 0;
  for (let i = 0; i < sourceFormulas.length; i++) {
    total += getFormulaPreferenceScore(formulaPreferenceMap, sourceFormulas[i]);
  }
  return total;
}

function sortFormulaKeysByPreference(formulaKeys, formulaPreferenceMap) {
  if (!Array.isArray(formulaKeys) || formulaKeys.length <= 1 || !formulaPreferenceMap) {
    return Array.isArray(formulaKeys) ? formulaKeys.slice() : [];
  }
  return formulaKeys
    .map((key, index) => ({
      key,
      index,
      score: getFormulaKeyPreferenceScore(key, formulaPreferenceMap),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.key);
}

function sortFormulasByPreference(formulas, formulaPreferenceMap) {
  if (!Array.isArray(formulas) || formulas.length <= 1 || !formulaPreferenceMap) {
    return Array.isArray(formulas) ? formulas.slice() : [];
  }
  return formulas
    .map((formula, index) => ({
      formula,
      index,
      score: getFormulaPreferenceScore(formulaPreferenceMap, formula),
      length: splitMoves(formula).length,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.length !== b.length) return a.length - b.length;
      if (a.formula !== b.formula) return a.formula.localeCompare(b.formula);
      return a.index - b.index;
    })
    .map((entry) => entry.formula);
}

function buildFormulaKeyLookup(formulaKeys) {
  const lookup = new Map();
  if (!Array.isArray(formulaKeys) || !formulaKeys.length) return lookup;
  for (let k = 0; k < formulaKeys.length; k++) {
    const formulaKey = formulaKeys[k];
    const sourceFormulas = getFormulaListByKey(formulaKey);
    for (let i = 0; i < sourceFormulas.length; i++) {
      const normalized = normalizeFormulaMatchText(sourceFormulas[i]);
      if (!normalized || lookup.has(normalized)) continue;
      lookup.set(normalized, formulaKey);
    }
  }
  return lookup;
}

function buildFormulaCanonicalLookup(formulaKeys) {
  const lookup = new Map();
  if (!Array.isArray(formulaKeys) || !formulaKeys.length) return lookup;
  for (let k = 0; k < formulaKeys.length; k++) {
    const formulaKey = formulaKeys[k];
    const sourceFormulas = getFormulaListByKey(formulaKey);
    for (let i = 0; i < sourceFormulas.length; i++) {
      const rawFormula = normalizeAlgorithmText(sourceFormulas[i]);
      if (!rawFormula) continue;
      for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
        const rot = FORMULA_ROTATIONS[r];
        for (let a = 0; a < FORMULA_AUF.length; a++) {
          const preAuf = FORMULA_AUF[a];
          for (let p = 0; p < FORMULA_AUF.length; p++) {
            const postAuf = FORMULA_AUF[p];
            const candidate = normalizeFormulaMatchText(
              buildFormulaCandidate(rot, preAuf, rawFormula, postAuf),
            );
            if (!candidate || lookup.has(candidate)) continue;
            lookup.set(candidate, rawFormula);
          }
        }
      }
    }
  }
  return lookup;
}

function getSingleStageCaseLibraryKey(
  stage,
  formulas,
  preAufList,
  postAufList,
  formulaKeys = null,
  formulaPreferenceSignature = "",
) {
  const keySig =
    Array.isArray(formulaKeys) && formulaKeys.length
      ? formulaKeys.join(",")
      : Array.isArray(stage?.formulaKeys) && stage.formulaKeys.length
        ? stage.formulaKeys.join(",")
        : stage?.name || "";
  return [
    stage?.name || "",
    keySig,
    formulas.length,
    formulaPreferenceSignature || "",
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
  formulaKeys = null,
  formulaPreferenceMap = null,
  formulaKeyLookup = null,
  formulaCanonicalLookup = null,
) {
  if (!shouldUseSingleStageCaseLibrary(stage, formulas)) return null;
  const formulaPreferenceSignature = buildFormulaPreferenceSignature(formulaPreferenceMap);
  const cacheKey = getSingleStageCaseLibraryKey(
    stage,
    formulas,
    preAufList,
    postAufList,
    formulaKeys,
    formulaPreferenceSignature,
  );
  const cached = singleStageFormulaCaseLibraryCache.get(cacheKey);
  if (cached) return cached;

  const caseMap = new Map();
  const solved = ctx?.solvedPattern;
  if (!solved) return null;

  for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
    const rot = FORMULA_ROTATIONS[r];
    for (let a = 0; a < preAufList.length; a++) {
      const preAuf = preAufList[a];
      for (let i = 0; i < formulas.length; i++) {
        const alg = formulas[i];
        for (let p = 0; p < postAufList.length; p++) {
          const postAuf = postAufList[p];
          const candidate = buildFormulaCandidate(rot, preAuf, alg, postAuf);
          const inverse = invertAlg(candidate);
          const casePattern = tryApplyAlg(solved, inverse);
          if (!casePattern) continue;
          const candidateMoves = splitMoves(candidate);
          if (!candidateMoves.length) continue;
          if (candidateMoves.length > stage.maxDepth) continue;
          const normalizedCandidate = normalizeFormulaMatchText(candidate);
          const formulaScore = getFormulaPreferenceScore(
            formulaPreferenceMap,
            normalizedCandidate,
            formulaCanonicalLookup,
          );
          const formulaKey = formulaKeyLookup?.get(normalizedCandidate) || null;
          const caseKey = stage.key(casePattern.patternData);
          const existing = caseMap.get(caseKey);
          if (
            !existing ||
            formulaScore > existing.formulaScore ||
            (formulaScore === existing.formulaScore && candidateMoves.length < existing.moves.length) ||
            (
              formulaScore === existing.formulaScore &&
              candidateMoves.length === existing.moves.length &&
              candidate < existing.text
            )
          ) {
            caseMap.set(caseKey, {
              text: candidate,
              normalizedText: normalizedCandidate,
              moves: candidateMoves,
              formulaScore,
              formulaKey,
            });
          }
        }
      }
    }
  }

  const library = { caseMap, preferenceSignature: formulaPreferenceSignature };
  singleStageFormulaCaseLibraryCache.set(cacheKey, library);
  if (singleStageFormulaCaseLibraryCache.size > SINGLE_STAGE_LIBRARY_CACHE_LIMIT) {
    const oldest = singleStageFormulaCaseLibraryCache.keys().next().value;
    if (oldest !== undefined) singleStageFormulaCaseLibraryCache.delete(oldest);
  }
  return library;
}

function solveWithFormulaDbSingleStage(startPattern, stage, ctx) {
  const formulaKeys = resolveStageFormulaKeys(stage, startPattern, ctx);
  const formulaPreferenceMap =
    typeof stage.getFormulaPreferenceMap === "function"
      ? stage.getFormulaPreferenceMap(startPattern, ctx)
      : null;
  const hasFormulaPreference =
    Boolean(formulaPreferenceMap && typeof formulaPreferenceMap.size === "number" && formulaPreferenceMap.size > 0);
  const orderedFormulaKeys = sortFormulaKeysByPreference(formulaKeys, formulaPreferenceMap);
  const formulaKeyLookup = buildFormulaKeyLookup(orderedFormulaKeys);
  const formulaCanonicalLookup = hasFormulaPreference ? buildFormulaCanonicalLookup(orderedFormulaKeys) : null;
  const formulas = filterValidFormulas(getFormulaListForStage(stage, startPattern, ctx), ctx);
  if (!formulas.length) return null;
  const acceptsFormulaResult =
    typeof stage.acceptFormulaResult === "function"
      ? (nextPattern, formulaKey) => stage.acceptFormulaResult(nextPattern, formulaKey, startPattern, ctx)
      : (nextPattern) => stage.isSolved(nextPattern.patternData, ctx);

  const stageDeadlineTs = Number.isFinite(stage.deadlineTs) && stage.deadlineTs > 0 ? stage.deadlineTs : 0;
  let attempts = 0;
  const preAufList =
    Array.isArray(stage.formulaPreAufList) && stage.formulaPreAufList.length
      ? stage.formulaPreAufList
      : FORMULA_AUF;
  const postAufList =
    Array.isArray(stage.formulaPostAufList) && stage.formulaPostAufList.length
      ? stage.formulaPostAufList
      : isPllLikeFormulaStage(stage)
        ? FORMULA_AUF
        : [""];
  const formulaAttemptLimit = Number.isFinite(stage.formulaAttemptLimit)
    ? Math.max(0, Math.floor(stage.formulaAttemptLimit))
    : 0;

  const library = getSingleStageFormulaCaseLibrary(
    stage,
    ctx,
    formulas,
    preAufList,
    postAufList,
    formulaKeys,
    formulaPreferenceMap,
    formulaKeyLookup,
    formulaCanonicalLookup,
  );
  if (library?.caseMap?.size) {
    const startKey = stage.key(startPattern.patternData);
    const direct = library.caseMap.get(startKey);
    if (direct && Array.isArray(direct.moves) && direct.moves.length <= stage.maxDepth) {
      const nextPattern = tryApplyMoves(startPattern, direct.moves);
      if (nextPattern && acceptsFormulaResult(nextPattern, direct.formulaKey || null)) {
        return {
          ok: true,
          moves: direct.moves.slice(),
          depth: direct.moves.length,
          nodes: 1,
          bound: direct.moves.length,
          formulaKey: direct.formulaKey || null,
        };
      }
    }
    // Library is comprehensive — state not in map means no formula applies
    return null;
  }

  for (let r = 0; r < FORMULA_ROTATIONS.length; r++) {
    const rot = FORMULA_ROTATIONS[r];
    for (let a = 0; a < preAufList.length; a++) {
      const preAuf = preAufList[a];
      const seen = new Set();
      for (let k = 0; k < orderedFormulaKeys.length; k++) {
        const formulaKey = orderedFormulaKeys[k];
        const keyFormulas = [];
        const sourceFormulas = getFormulaListByKey(formulaKey);
        for (let i = 0; i < sourceFormulas.length; i++) {
          const alg = sanitizeFormulaAlg(sourceFormulas[i]);
          if (!alg || seen.has(alg)) continue;
          seen.add(alg);
          keyFormulas.push(alg);
        }
        const validKeyFormulas = hasFormulaPreference
          ? sortFormulasByPreference(filterValidFormulas(keyFormulas, ctx), formulaPreferenceMap)
          : filterValidFormulas(keyFormulas, ctx);
        for (let i = 0; i < validKeyFormulas.length; i++) {
          const alg = validKeyFormulas[i];
          for (let p = 0; p < postAufList.length; p++) {
            if (stageDeadlineTs > 0 && (attempts & 63) === 0 && Date.now() >= stageDeadlineTs) {
              return null;
            }
            const postAuf = postAufList[p];
            const candidate = buildFormulaCandidate(rot, preAuf, alg, postAuf);
            const nextPattern = tryApplyAlg(startPattern, candidate);
            attempts += 1;
            if (formulaAttemptLimit > 0 && attempts >= formulaAttemptLimit) {
              return null;
            }
            if (!nextPattern) continue;
            if (acceptsFormulaResult(nextPattern, formulaKey)) {
              const moves = splitMoves(candidate);
              if (moves.length > stage.maxDepth) continue;
              return {
                ok: true,
                moves,
                depth: moves.length,
                nodes: attempts,
                bound: moves.length,
                formulaKey,
              };
            }
          }
        }
      }
    }
  }
  return null;
}

// Fast F2L IDA* using precomputed integer move tables — avoids KPattern allocations entirely.
// Solves each F2L pair SEQUENTIALLY (pair 0 → pair 1 → pair 2 → pair 3) so the
// heuristic stays tight (BFS-exact per pair).
// Uses pure state-index arithmetic: no per-node piece array updates.
// Heuristic = max(crossDist, pairDist[0..k]) keeps previously solved pairs from being disturbed.
function solveF2LCompactIDA(startPattern, stage, ctx) {
  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const deadlineTs = Number.isFinite(stage.deadlineTs) && stage.deadlineTs > 0 ? stage.deadlineTs : 0;
  if (deadlineTs > 0 && Date.now() >= deadlineTs) return null;

  const f2lPairDefs = ctx.f2lPairDefs;
  const f2lSolvedPairStates = ctx.f2lSolvedPairStates;
  if (!f2lPairDefs || !f2lSolvedPairStates) return null;

  const moveIndices = ctx.noDMoveIndices;
  const numMoves = moveIndices.length;
  const f2lTargetPairs = Math.min(
    Number.isFinite(stage.f2lTargetPairs) ? stage.f2lTargetPairs : 4,
    f2lPairDefs.length,
  );
  const MAX_PAIR_DEPTH = 18;
  const NODE_LIMIT = deadlineTs > 0 ? 200000000 : 12000000;
  const NPAIRS = f2lTargetPairs;
  const STACK_SIZE = MAX_PAIR_DEPTH + 2;

  // State stacks: one per cross + one per pair (all 4 pairs tracked simultaneously).
  const crossStack = new Int32Array(STACK_SIZE);
  const pairStacks = [];
  for (let j = 0; j < NPAIRS; j++) pairStacks.push(new Uint16Array(STACK_SIZE));

  const crossMoveTable = ctx.crossMoveTable;
  const crossPruneTable = ctx.crossPruneTable;
  const allNumMoves = ctx.allMoveIndices.length;
  const solvedCrossIdx = ctx.solvedCrossStateIndex;
  const pruneTables = f2lPairDefs.slice(0, NPAIRS).map((d) => d.pruneTable);
  const pairMoveTables = f2lPairDefs.slice(0, NPAIRS).map((d) => d.moveTable);

  // Compute initial cross state once.
  let initCrossState = getCrossStateIndexFromData(startData, ctx);
  if (initCrossState < 0) return null;

  // Compute initial pair states.
  const startCorners = startData.CORNERS;
  const startEdges = startData.EDGES;
  const cornerPosById = new Uint8Array(8);
  const edgePosById = new Uint8Array(12);
  for (let p = 0; p < 8; p++) cornerPosById[startCorners.pieces[p]] = p;
  for (let p = 0; p < 12; p++) edgePosById[startEdges.pieces[p]] = p;

  const initPairStates = new Uint16Array(NPAIRS);
  for (let j = 0; j < NPAIRS; j++) {
    const def = f2lPairDefs[j];
    const cpos = cornerPosById[def.cornerPieceId];
    const epos = edgePosById[def.edgePieceId];
    initPairStates[j] = encodeF2LPairState(cpos, startCorners.orientation[cpos] % 3, epos, startEdges.orientation[epos] & 1);
  }

  // movePath stores actual MOVE_NAMES indices (not moveIndices position).
  const movePath = new Uint8Array(MAX_PAIR_DEPTH + 1);
  let totalNodes = 0;
  let nodeLimitHit = false;
  let deadlineHit = false;
  const allMoves = [];

  // Running accumulated states (updated after each pair's solution).
  let curCrossState = initCrossState;
  const curPairStates = new Uint16Array(NPAIRS);
  for (let j = 0; j < NPAIRS; j++) curPairStates[j] = initPairStates[j];

  // Solve each pair sequentially.
  for (let k = 0; k < NPAIRS; k++) {
    const pruneTableK = pruneTables[k];
    const pairMoveTableK = pairMoveTables[k];
    const solvedPairStateK = f2lSolvedPairStates[k];

    // Seed stacks from accumulated running state.
    crossStack[0] = curCrossState;
    for (let j = 0; j < NPAIRS; j++) pairStacks[j][0] = curPairStates[j];

    // Check if already satisfied (cross + pairs 0..k all solved).
    let alreadySolved = crossStack[0] === solvedCrossIdx && pairStacks[k][0] === solvedPairStateK;
    if (alreadySolved) {
      for (let j = 0; j < k; j++) {
        if (pairStacks[j][0] !== f2lSolvedPairStates[j]) { alreadySolved = false; break; }
      }
    }
    if (alreadySolved) continue;

    let solutionDepth = -1;

    function dfs(level, bound, lastFace) {
      if ((totalNodes & 8191) === 0) {
        if (totalNodes >= NODE_LIMIT) { nodeLimitHit = true; return Infinity; }
        if (deadlineTs > 0 && Date.now() >= deadlineTs) { deadlineHit = true; return Infinity; }
      }
      // Heuristic: max(cross distance, pair distance for all pairs 0..k).
      // This prevents disturbing previously solved pairs (j < k) from going unpunished.
      let h = crossPruneTable[crossStack[level]];
      for (let j = 0; j <= k; j++) {
        const hj = pruneTables[j][pairStacks[j][level]];
        if (hj > h) h = hj;
      }
      const f = level + h;
      if (f > bound) return f;
      // Goal: cross solved AND pairs 0..k all solved.
      if (h === 0) {
        solutionDepth = level;
        return true;
      }
      const nextLevel = level + 1;
      let minNext = Infinity;
      for (let mi = 0; mi < numMoves; mi++) {
        const moveIndex = moveIndices[mi];
        const face = ctx.moveFace[moveIndex];
        if (lastFace !== -1) {
          if (face === lastFace) continue;
          if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        }
        totalNodes++;
        // Update all states via precomputed move tables — O(1) per state.
        crossStack[nextLevel] = crossMoveTable[crossStack[level] * allNumMoves + moveIndex];
        for (let j = 0; j < NPAIRS; j++) {
          pairStacks[j][nextLevel] = pairMoveTables[j][pairStacks[j][level] * allNumMoves + moveIndex];
        }
        movePath[level] = moveIndex;
        const res = dfs(nextLevel, bound, face);
        if (res === true) return true;
        if (nodeLimitHit || deadlineHit) return Infinity;
        if (res < minNext) minNext = res;
      }
      return minNext;
    }

    // Initial bound: max heuristic over cross + pairs 0..k.
    let bound = crossPruneTable[curCrossState];
    for (let j = 0; j <= k; j++) {
      const hj = pruneTables[j][curPairStates[j]];
      if (hj > bound) bound = hj;
    }
    bound = Math.max(bound, 1);

    let pairSolved = false;
    while (bound <= MAX_PAIR_DEPTH && !nodeLimitHit && !deadlineHit) {
      const res = dfs(0, bound, -1);
      if (res === true) { pairSolved = true; break; }
      if (!Number.isFinite(res)) break;
      bound = res;
    }

    if (!pairSolved) {
      return {
        ok: false,
        reason: nodeLimitHit
          ? "F2L_COMPACT_NODE_LIMIT"
          : deadlineHit
            ? "F2L_COMPACT_DEADLINE"
            : "F2L_COMPACT_NOT_FOUND",
        nodes: totalNodes,
        bound,
      };
    }

    // Collect moves and advance accumulated running states.
    for (let d = 0; d < solutionDepth; d++) {
      const mi = movePath[d];
      allMoves.push(MOVE_NAMES[mi]);
      curCrossState = crossMoveTable[curCrossState * allNumMoves + mi];
      for (let j = 0; j < NPAIRS; j++) {
        curPairStates[j] = pairMoveTables[j][curPairStates[j] * allNumMoves + mi];
      }
    }
  }

  return {
    ok: true,
    moves: allMoves,
    depth: allMoves.length,
    nodes: totalNodes,
    bound: allMoves.length,
  };
}

function solveWithFormulaDbF2L(startPattern, stage, ctx) {
  const formulas = filterValidFormulas(getFormulaListForStage(stage), ctx);
  if (!formulas.length) return null;
  const metricsCache = new Map();
  const stylePenaltyCache = new Map();
  const transitionPenaltyCache = new Map();
  const downstreamPenaltyCache = new Map();
  const deadlineTs = Number.isFinite(stage.deadlineTs) && stage.deadlineTs > 0 ? stage.deadlineTs : 0;
  // Tight beam-local deadline: don't let the formula beam run longer than formulaBeamBudgetMs.
  // Exceeding it causes the beam to bail early → compact IDA* takes over (fast path).
  const beamBudgetMs = Number.isFinite(stage.formulaBeamBudgetMs) && stage.formulaBeamBudgetMs > 0
    ? stage.formulaBeamBudgetMs
    : 250;
  const beamDeadlineTs = deadlineTs > 0
    ? Math.min(deadlineTs, Date.now() + beamBudgetMs)
    : Date.now() + beamBudgetMs;
  const styleFallbackEnabled = stage.enableStyleFallback !== false;
  const f2lStyleProfile = styleFallbackEnabled
    ? getBudgetAwareF2LStyleProfile(stage.f2lStyleProfile, beamDeadlineTs)
    : normalizeF2LStyleProfile(stage.f2lStyleProfile);
  const f2lTransitionProfile = normalizeF2LTransitionProfile(stage.f2lTransitionProfile);
  const f2lDownstreamProfile = normalizeF2LDownstreamProfile(stage.f2lDownstreamProfile);
  const downstreamWeight = normalizeF2LDownstreamWeight(
    stage.f2lDownstreamWeight,
    DEFAULT_F2L_DOWNSTREAM_WEIGHT,
  );
  const f2lTargetPairs = Number.isFinite(stage.f2lTargetPairs)
    ? Math.max(1, Math.floor(stage.f2lTargetPairs))
    : 4;
  const styleProfileActive = hasActiveF2LStyleProfile(f2lStyleProfile);
  const styleBiasLevel = styleProfileActive ? getF2LStyleBiasLevel(f2lStyleProfile) : 0;
  const transitionProfileActive = Boolean(f2lTransitionProfile && f2lTransitionProfile.stateMap);
  const transitionBiasLevel = transitionProfileActive ? 1 : 0;
  const downstreamProfileActive =
    Boolean(f2lDownstreamProfile && f2lDownstreamProfile.stateMap) && downstreamWeight > 0;
  const downstreamBiasLevel = downstreamProfileActive ? getF2LDownstreamBiasLevel(downstreamWeight) : 0;
  const mixedCfopStages = stage.mixedCfopStages === true;
  const mixedCaseBias = normalizeMixedCaseBias(stage.mixedCaseBias || stage.f2lStyleProfile);
  const isDeadlineExceeded = () => Date.now() >= beamDeadlineTs;
  const stylePenaltyGuard = styleProfileActive
    ? Math.max(
        10,
        (f2lStyleProfile.rotationWeight * 3 + f2lStyleProfile.aufWeight * 2 + f2lStyleProfile.wideTurnWeight * 2) * 2,
      )
    : Number.POSITIVE_INFINITY;
  const transitionPenaltyGuard = transitionProfileActive ? 2 : Number.POSITIVE_INFINITY;
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

  function stylePenaltyForMoves(candidateMoves, precomputedKey = null) {
    if (!candidateMoves.length) return 0;
    const key = precomputedKey !== null ? precomputedKey : joinMoves(candidateMoves);
    const cached = stylePenaltyCache.get(key);
    if (typeof cached === "number") return cached;
    const penalty = getF2LStylePenalty(candidateMoves, f2lStyleProfile);
    stylePenaltyCache.set(key, penalty);
    return penalty;
  }

  function transitionPenaltyForState(currentStateKey, nextStateKey) {
    if (!transitionProfileActive) return null;
    const key = `${currentStateKey}::${nextStateKey}`;
    if (transitionPenaltyCache.has(key)) {
      return transitionPenaltyCache.get(key);
    }
    const penalty = getF2LTransitionPenalty(f2lTransitionProfile, currentStateKey, nextStateKey);
    transitionPenaltyCache.set(key, penalty);
    return penalty;
  }

  function downstreamPenaltyForState(nextStateKey) {
    if (!downstreamProfileActive) return null;
    const key = String(nextStateKey);
    if (downstreamPenaltyCache.has(key)) {
      return downstreamPenaltyCache.get(key);
    }
    const penalty = getF2LDownstreamPenalty(f2lDownstreamProfile, nextStateKey, downstreamWeight);
    downstreamPenaltyCache.set(key, penalty);
    return penalty;
  }

  let maxAttempts = stage.formulaMaxAttempts || STRICT_CFOP_PROFILE.f2lFormulaMaxAttempts;
  let beamWidth = stage.formulaBeamWidth || STRICT_CFOP_PROFILE.f2lFormulaBeamWidth;
  const expansionLimit = stage.formulaExpansionLimit || STRICT_CFOP_PROFILE.f2lFormulaExpansionLimit;
  if (deadlineTs > 0) {
    const remainingMs = deadlineTs - Date.now();
    if (remainingMs <= 0) return null;
    if (remainingMs < 3500) {
      maxAttempts = Math.min(maxAttempts, 120000);
      beamWidth = Math.min(beamWidth, 5);
    } else if (remainingMs < 8000) {
      maxAttempts = Math.min(maxAttempts, 180000);
      beamWidth = Math.min(beamWidth, 6);
    }
  }
  const attemptsRef = { count: 0 };

  // Reusable output buffers for compact transform — avoids per-entry allocations in hot path
  const _outCPiece = new Uint8Array(8);
  const _outCOri = new Uint8Array(8);
  const _outEPiece = new Uint8Array(12);
  const _outEOri = new Uint8Array(12);
  // Shared mock data wrappers — fields reassigned per use; no new objects in hot path
  const _outMockData = { CORNERS: { pieces: _outCPiece, orientation: _outCOri }, EDGES: { pieces: _outEPiece, orientation: _outEOri } };
  const _nodeMockData = { CORNERS: { pieces: null, orientation: null }, EDGES: { pieces: null, orientation: null } };

  function collectCandidates(node, nextFormulaDepth, bestDepthByState) {
    if (isDeadlineExceeded()) return [];
    // Use compact state from node — avoids KPattern.patternData access in hot path
    const curCPiece = node.cPiece;
    const curCOri = node.cOri;
    const curEPiece = node.ePiece;
    const curEOri = node.eOri;
    const currentData = { CORNERS: { pieces: curCPiece, orientation: curCOri }, EDGES: { pieces: curEPiece, orientation: curEOri } };
    const currentMetrics = metricsFor(currentData, node.key);
    // Lazy KPattern — only computed if entries without compactTransform are encountered (rare)
    let _lazyPattern = node._pattern !== undefined ? node._pattern : null;
    function getCurrentPattern() {
      if (!_lazyPattern) _lazyPattern = startPattern.applyAlg(node.moves.join(' '));
      return _lazyPattern;
    }
    const improveMap = new Map();
    const fallbackMap = new Map();

    // Returns nextStateKey (number) if entry passes all filters, or null to reject.
    // Also populates _outCPiece/_outCOri/_outEPiece/_outEOri with the resulting state.
    function compactPreFilter(ct, candidateMoves, nextFormulaDepth, bestDepthByState) {
      const cPerm = ct.cPerm, cTwist = ct.cTwist;
      const ePerm = ct.ePerm, eFlip = ct.eFlip;
      for (let i = 0; i < 8; i++) {
        const src = cPerm[i];
        _outCPiece[i] = curCPiece[src];
        _outCOri[i] = (curCOri[src] + cTwist[i]) % 3;
      }
      for (let i = 0; i < 12; i++) {
        const src = ePerm[i];
        _outEPiece[i] = curEPiece[src];
        _outEOri[i] = (curEOri[src] + eFlip[i]) & 1;
      }
      if (node.moves.length + candidateMoves.length > stage.maxDepth) return null;
      if (!isCrossSolved(_outMockData, ctx)) return null;
      const nextStateKey = stage.key(_outMockData);
      const seenDepth = bestDepthByState.get(nextStateKey);
      if (typeof seenDepth === "number" && nextFormulaDepth > seenDepth) return null;
      return nextStateKey;
    }

    // Core ranking/storage logic. nextData may be a mock object (compact path) or real KPattern data.
    function considerCore(nextData, nextStateKey, candidateMoves) {
      const nextMetrics = metricsFor(nextData, nextStateKey);
      const isImprove = improvesOver(nextMetrics, currentMetrics);
      const stylePenalty = stylePenaltyForMoves(candidateMoves);
      const transitionPenaltyRaw = transitionPenaltyForState(node.key, nextStateKey);
      const transitionPenalty = Number.isFinite(transitionPenaltyRaw) ? transitionPenaltyRaw : 0;
      const downstreamPenaltyRaw = downstreamPenaltyForState(nextStateKey);
      const downstreamBasePenalty = Number.isFinite(downstreamPenaltyRaw) ? downstreamPenaltyRaw : 0;
      const mixedLlSignal = mixedCfopStages
        ? getMixedCfopLlSignal(
            f2lDownstreamProfile,
            nextStateKey,
            nextData,
            ctx,
            nextMetrics.pairProgress,
            f2lTargetPairs,
            downstreamWeight,
            mixedCaseBias,
          )
        : null;
      const llPriority = mixedLlSignal?.llPriority || 0;
      const zbllOpportunityBonus = mixedLlSignal?.downstreamBonus || 0;
      const effectiveDownstreamBiasLevel =
        mixedLlSignal && mixedLlSignal.downstreamBonus < 0
          ? Math.max(1, downstreamBiasLevel)
          : downstreamBiasLevel;
      if (
        styleProfileActive &&
        !isImprove &&
        stylePenalty > stylePenaltyGuard &&
        !mixedLlSignal?.preserveCandidate &&
        (!transitionProfileActive || transitionPenaltyRaw === null || transitionPenalty > transitionPenaltyGuard) &&
        (!downstreamProfileActive || downstreamPenaltyRaw === null || downstreamBasePenalty > -0.25)
      ) {
        return;
      }
      const downstreamPenalty = downstreamBasePenalty + zbllOpportunityBonus;
      const ranking = {
        pairProgress: nextMetrics.pairProgress,
        llPriority,
        solvedSum: nextMetrics.solvedSum,
        score: nextMetrics.score,
        transitionPenalty,
        transitionBiasLevel,
        stylePenalty,
        styleBiasLevel,
        downstreamPenalty,
        downstreamBiasLevel: effectiveDownstreamBiasLevel,
        moveLen: candidateMoves.length,
      };
      // Store compact arrays (copies from nextData) — no KPattern reference needed
      const candidate = {
        cPiece: new Uint8Array(nextData.CORNERS.pieces),
        cOri: new Uint8Array(nextData.CORNERS.orientation),
        ePiece: new Uint8Array(nextData.EDGES.pieces),
        eOri: new Uint8Array(nextData.EDGES.orientation),
        moves: candidateMoves,
        nextStateKey,
        ranking,
      };
      const targetMap = isImprove ? improveMap : fallbackMap;
      const prev = targetMap.get(nextStateKey);
      if (!prev || isBetterF2LRanking(ranking, prev.ranking)) {
        targetMap.set(nextStateKey, candidate);
      }
    }

    // Fast compact path: _outMockData already populated by compactPreFilter, cross/seenDepth already checked
    function considerCompact(candidateMoves, nextStateKey) {
      considerCore(_outMockData, nextStateKey, candidateMoves);
    }

    // Fallback path for entries without compactTransform (rare): extract data from real KPattern
    function consider(nextPattern, candidateMoves) {
      if (!nextPattern || !candidateMoves.length) return;
      if (node.moves.length + candidateMoves.length > stage.maxDepth) return;
      const nextData = nextPattern.patternData;
      if (!isCrossSolved(nextData, ctx)) return;
      const nextStateKey = stage.key(nextData);
      const seenDepth = bestDepthByState.get(nextStateKey);
      if (typeof seenDepth === "number" && nextFormulaDepth > seenDepth) return;
      considerCore(nextData, nextStateKey, candidateMoves);
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
      if ((i & 127) === 0 && isDeadlineExceeded()) break;
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
      attemptsRef.count += 1;
      if (entry.compactTransform) {
        const nextKey = compactPreFilter(entry.compactTransform, entry.moves, nextFormulaDepth, bestDepthByState);
        if (nextKey === null) continue;
        considerCompact(entry.moves, nextKey);
        continue;
      }
      const nextPattern = tryApplyTransformation(getCurrentPattern(), entry.transformation);
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
          if ((i & 63) === 0 && isDeadlineExceeded()) break;
          if (attemptsRef.count >= maxAttempts) break;
          const fc = fallbackCandidates[i];
          attemptsRef.count += 1;
          if (fc.compactTransform) {
            const nextKey = compactPreFilter(fc.compactTransform, fc.moves, nextFormulaDepth, bestDepthByState);
            if (nextKey === null) continue;
            considerCompact(fc.moves, nextKey);
            continue;
          }
          const nextPattern = tryApplyTransformation(getCurrentPattern(), fc.transformation);
          if (!nextPattern) continue;
          consider(nextPattern, fc.moves);
        }
      } else {
        let stop = false;
        for (let r = 0; r < FORMULA_ROTATIONS.length && !stop; r++) {
          const rot = FORMULA_ROTATIONS[r];
          for (let a = 0; a < FORMULA_AUF.length && !stop; a++) {
            const preAuf = FORMULA_AUF[a];
            for (let i = 0; i < formulas.length; i++) {
              if ((i & 63) === 0 && isDeadlineExceeded()) {
                stop = true;
                break;
              }
              if (attemptsRef.count >= maxAttempts) {
                stop = true;
                break;
              }
              const candidateText = buildFormulaCandidate(rot, preAuf, formulas[i]);
              const candidateMoves = splitMoves(candidateText);
              const nextPattern = tryApplyMoves(getCurrentPattern(), candidateMoves);
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
  const startMetrics = metricsFor(startData, startKey);
  let beam = [
    {
      cPiece: new Uint8Array(startData.CORNERS.pieces),
      cOri: new Uint8Array(startData.CORNERS.orientation),
      ePiece: new Uint8Array(startData.EDGES.pieces),
      eOri: new Uint8Array(startData.EDGES.orientation),
      _pattern: startPattern,
      moves: [],
      key: startKey,
      ranking: {
        pairProgress: startMetrics.pairProgress,
        llPriority: 0,
        solvedSum: startMetrics.solvedSum,
        score: startMetrics.score,
        transitionPenalty: 0,
        transitionBiasLevel,
        stylePenalty: 0,
        styleBiasLevel,
        downstreamPenalty: 0,
        downstreamBiasLevel,
        moveLen: 0,
      },
    },
  ];
  const bestDepthByState = new Map([[startKey, 0]]);

  const maxFormulaSteps = stage.formulaMaxSteps || FORMULA_F2L_MAX_STEPS;
  for (let step = 0; step < maxFormulaSteps; step++) {
    if (isDeadlineExceeded()) break;
    const nextByKey = new Map();
    const nextFormulaDepth = step + 1;

    for (let i = 0; i < beam.length; i++) {
      if (isDeadlineExceeded()) break;
      const node = beam[i];
      _nodeMockData.CORNERS.pieces = node.cPiece;
      _nodeMockData.CORNERS.orientation = node.cOri;
      _nodeMockData.EDGES.pieces = node.ePiece;
      _nodeMockData.EDGES.orientation = node.eOri;
      if (stage.isSolved(_nodeMockData, ctx)) {
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
        if ((c & 31) === 0 && isDeadlineExceeded()) break;
        const candidate = candidates[c];
        const mergedMoves = node.moves.concat(candidate.moves);
        const entry = {
          cPiece: candidate.cPiece,
          cOri: candidate.cOri,
          ePiece: candidate.ePiece,
          eOri: candidate.eOri,
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
      _nodeMockData.CORNERS.pieces = beam[i].cPiece;
      _nodeMockData.CORNERS.orientation = beam[i].cOri;
      _nodeMockData.EDGES.pieces = beam[i].ePiece;
      _nodeMockData.EDGES.orientation = beam[i].eOri;
      if (stage.isSolved(_nodeMockData, ctx)) {
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
  if (
    stage.name === "F2L" ||
    (Array.isArray(stage.formulaKeys) && stage.formulaKeys.includes("F2L"))
  ) {
    const beamResult = solveWithFormulaDbF2L(startPattern, stage, ctx);
    if (beamResult?.ok) return beamResult;
    // Beam failed — fall back to compact integer-state IDA* (100x faster than KPattern IDA*)
    return solveF2LCompactIDA(startPattern, stage, ctx);
  }
  if (isSingleStageFormulaStage(stage)) {
    const primary = solveWithFormulaDbSingleStage(startPattern, stage, ctx);
    if (primary?.ok) return primary;

    const fallbackKeys =
      typeof stage.getFallbackFormulaKeys === "function"
        ? stage.getFallbackFormulaKeys(startPattern, ctx)
        : Array.isArray(stage.fallbackFormulaKeys)
          ? stage.fallbackFormulaKeys
          : null;
    if (Array.isArray(fallbackKeys) && fallbackKeys.length) {
      const fallbackStage = {
        ...stage,
        formulaKeys: fallbackKeys.slice(),
        getFormulaKeys: undefined,
        getFallbackFormulaKeys: undefined,
      };
      return solveWithFormulaDbSingleStage(startPattern, fallbackStage, ctx);
    }
    return primary;
  }
  return null;
}

// Pure-integer cross IDA* using precomputed move tables.
// Only used for plain "Cross" stage (no pair targets). ~10x faster than KPattern IDA*.
function solveCrossCompact(startPattern, stage, ctx) {
  const startStateIdx = getCrossStateIndexFromData(startPattern.patternData, ctx);
  if (startStateIdx < 0) return null;
  const solvedStateIdx = ctx.solvedCrossStateIndex;
  const pruneTable = ctx.crossPruneTable;
  const crossMoveTable = ctx.crossMoveTable;
  const numMoves = ctx.allMoveIndices.length;
  const moveFace = ctx.moveFace;
  const maxDepth = Number.isFinite(stage.maxDepth) ? stage.maxDepth : 8;
  const deadlineTs = Number.isFinite(stage.deadlineTs) && stage.deadlineTs > 0 ? stage.deadlineTs : 0;

  if (startStateIdx === solvedStateIdx) {
    return { ok: true, moves: [], solution: "", nodes: 0, bound: 0, moveCount: 0 };
  }

  const movePath = new Int32Array(maxDepth + 1);
  let nodes = 0;
  let deadlineHit = false;
  let solutionDepth = -1;

  function dfs(stateIdx, depth, bound, lastFace) {
    if ((nodes & 4095) === 0 && deadlineTs > 0 && Date.now() >= deadlineTs) {
      deadlineHit = true;
      return Infinity;
    }
    nodes++;
    const h = pruneTable[stateIdx];
    const f = depth + h;
    if (f > bound) return f;
    if (h === 0) {
      solutionDepth = depth;
      return true;
    }
    const remaining = bound - depth;
    if (remaining === 0) return f;
    const base = stateIdx * numMoves;
    let minExcess = Infinity;
    for (let mi = 0; mi < numMoves; mi++) {
      const face = moveFace[mi];
      if (face === lastFace) continue;
      const nextState = crossMoveTable[base + mi];
      movePath[depth] = mi;
      const result = dfs(nextState, depth + 1, bound, face);
      if (result === true) return true;
      if (result === Infinity) return Infinity;
      if (result < minExcess) minExcess = result;
    }
    return minExcess;
  }

  let bound = Math.max(pruneTable[startStateIdx], 1);
  while (bound <= maxDepth && !deadlineHit) {
    const result = dfs(startStateIdx, 0, bound, -1);
    if (result === true) {
      const moves = Array.from(movePath.slice(0, solutionDepth)).map((idx) => MOVE_NAMES[idx]);
      const solution = moves.join(" ");
      return { ok: true, moves, solution, nodes, bound: solutionDepth, moveCount: solutionDepth };
    }
    if (result === Infinity) break;
    bound = result;
  }
  return null;
}

function solveStage(startPattern, stage, ctx) {
  const startData = startPattern.patternData;
  if (stage.isSolved(startData, ctx)) {
    return { ok: true, moves: [], depth: 0, nodes: 0, bound: 0 };
  }

  const stageDeadlineTs = Number.isFinite(stage.deadlineTs) && stage.deadlineTs > 0 ? stage.deadlineTs : 0;

  // For plain cross stage: use compact integer IDA* (~10x faster than KPattern).
  // XCross/XXCross require pair tracking which the compact solver doesn't support.
  if (stage.isCrossLike && stage.name === "Cross" && ctx.crossMoveTable) {
    const compactResult = solveCrossCompact(startPattern, stage, ctx);
    if (compactResult?.ok) return compactResult;
    if (stageDeadlineTs > 0 && Date.now() >= stageDeadlineTs) {
      return { ok: false, reason: "CROSS_SEARCH_LIMIT", nodes: compactResult?.nodes || 0, bound: STAGE_NOT_SET };
    }
    // Fall through to KPattern IDA* only if compact solver returned null (shouldn't happen)
  }

  const formulaResult = solveStageByFormulaDb(startPattern, stage, ctx);
  if (formulaResult?.ok) {
    return formulaResult;
  }
  if (stageDeadlineTs > 0 && Date.now() >= stageDeadlineTs) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
      nodes: formulaResult?.nodes || 0,
      bound: STAGE_NOT_SET,
    };
  }
  if (stage.disableSearchFallback) {
    return {
      ok: false,
      reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
      nodes: formulaResult?.nodes || 0,
      bound: STAGE_NOT_SET,
    };
  }

  const heuristicCache = new Map();
  const failCache = new Map();
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  let deadlineHit = false;
  const nodeLimit = Number.isFinite(stage.nodeLimit) ? stage.nodeLimit : 0;

  function heuristic(data) {
    const key = stage.key(data);
    const cached = heuristicCache.get(key);
    if (typeof cached === "number") {
      touchMapEntry(heuristicCache, key, cached);
      return cached;
    }
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
    setBoundedMapEntry(heuristicCache, key, h, HEURISTIC_CACHE_LIMIT);
    return h;
  }

  let bound = Math.max(heuristic(startData), 1);
  const searchMaxDepth = Number.isFinite(stage.searchMaxDepth) ? stage.searchMaxDepth : stage.maxDepth;

  function dfs(pattern, depth, currentBound, lastFace) {
    if ((nodes & 255) === 0 && stageDeadlineTs > 0 && Date.now() >= stageDeadlineTs) {
      deadlineHit = true;
      return Infinity;
    }
    const data = pattern.patternData;
    const h = heuristic(data);
    const f = depth + h;
    if (f > currentBound) return f;
    if (stage.isSolved(data, ctx)) return true;

    const remaining = currentBound - depth;
    const stateKey = stage.key(data);
    const cacheKey = `${stateKey}|${lastFace}`;
    const seenMask = failCache.get(cacheKey) || 0;
    if (seenMask) {
      touchMapEntry(failCache, cacheKey, seenMask);
    }
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

    setBoundedMapEntry(failCache, cacheKey, seenMask | bit, FAIL_CACHE_LIMIT);
    return minNext;
  }

  while (bound <= searchMaxDepth) {
    if (nodeLimitHit || deadlineHit) break;
    if (stageDeadlineTs > 0 && Date.now() >= stageDeadlineTs) {
      deadlineHit = true;
      break;
    }
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

  const baseFailure = nodeLimitHit
    || deadlineHit
    ? {
        ok: false,
        reason: `${stage.name.toUpperCase()}_SEARCH_LIMIT`,
        nodes,
        bound: STAGE_NOT_SET,
      }
    : {
        ok: false,
        reason: `${stage.name.toUpperCase()}_NOT_FOUND`,
        nodes,
        bound: STAGE_NOT_SET,
      };

  const hasRelaxTimeBudget = stageDeadlineTs === 0 || stageDeadlineTs - Date.now() > 1200;
  const styleFallbackEnabled = stage.enableStyleFallback !== false;
  const hasPllFormulas = stage.name === "PLL" || stageHasFormulaKey(stage, "PLL");
  const hasZblsFormulas = stage.name === "ZBLS" || stageHasFormulaKey(stage, "ZBLS");
  const hasZbllFormulas = stage.name === "ZBLL" || stageHasFormulaKey(stage, "ZBLL");

  const canRelaxSearch =
    (stage.name === "XCross" ||
      stage.name === "F2L" ||
      hasPllFormulas ||
      hasZblsFormulas ||
      hasZbllFormulas) &&
    stage.allowRelaxedSearch !== false &&
    hasRelaxTimeBudget &&
    !stage.__relaxedSearchTried &&
    !stage.disableSearchFallback;
  if (canRelaxSearch) {
    const baseSearchMaxDepth = normalizeDepth(stage.searchMaxDepth, stage.maxDepth);
    const baseNodeLimit = normalizeDepth(stage.nodeLimit, 0);
    const baseFormulaAttemptLimit = normalizeDepth(stage.formulaAttemptLimit, 0);

    let relaxedSearchMaxDepth = baseSearchMaxDepth + 1;
    let relaxedNodeLimit = baseNodeLimit;
    let relaxedFormulaAttemptLimit = baseFormulaAttemptLimit;

    if (stage.name === "XCross") {
      // Cross+1 can need a slightly wider search than plain cross in dense top10-style positions.
      relaxedSearchMaxDepth = baseSearchMaxDepth + 1;
      relaxedNodeLimit = Math.max(baseNodeLimit, 260000);
    } else if (stage.name === "F2L") {
      // Rare fallback for tough F2L states: expand search and allow D turns once.
      relaxedSearchMaxDepth = baseSearchMaxDepth + 2;
      relaxedNodeLimit = Math.max(baseNodeLimit, 340000);
      relaxedFormulaAttemptLimit = Math.max(
        normalizeDepth(stage.formulaMaxAttempts, 0),
        320000,
      );
    } else if (hasPllFormulas) {
      // PLL should usually be formula-fast; if not, allow a wider emergency search.
      relaxedNodeLimit = Math.max(baseNodeLimit, 220000);
    } else {
      // Last-stage ZB failures are usually limit-bound; allow wider move set and deeper cap once.
      relaxedNodeLimit = Math.max(baseNodeLimit, 380000);
      relaxedFormulaAttemptLimit = Math.max(
        baseFormulaAttemptLimit,
        hasZblsFormulas ? 45000 : 35000,
      );
    }

    const relaxedStage = {
      ...stage,
      __relaxedSearchTried: true,
      moveIndices: ctx.allMoveIndices,
      searchMaxDepth: relaxedSearchMaxDepth,
      nodeLimit: relaxedNodeLimit,
      formulaAttemptLimit: relaxedFormulaAttemptLimit,
      formulaMaxAttempts: stage.name === "F2L" ? relaxedFormulaAttemptLimit : stage.formulaMaxAttempts,
      formulaBeamWidth:
        stage.name === "F2L"
          ? Math.max(normalizeDepth(stage.formulaBeamWidth, STRICT_CFOP_PROFILE.f2lFormulaBeamWidth), 9)
          : stage.formulaBeamWidth,
      formulaExpansionLimit:
        stage.name === "F2L"
          ? Math.max(normalizeDepth(stage.formulaExpansionLimit, STRICT_CFOP_PROFILE.f2lFormulaExpansionLimit), 16)
          : stage.formulaExpansionLimit,
    };
    const relaxedResult = solveStage(startPattern, relaxedStage, ctx);
    if (relaxedResult?.ok) return relaxedResult;
    const relaxedNodes = relaxedResult?.nodes || 0;
    if (relaxedNodes > baseFailure.nodes) baseFailure.nodes = relaxedNodes;
  }

  const canTryF2LStyleFallback =
    stage.name === "F2L" &&
    hasRelaxTimeBudget &&
    styleFallbackEnabled &&
    !stage.__styleFallbackTried &&
    !stage.disableSearchFallback;
  if (canTryF2LStyleFallback) {
    const styleRescueProfiles = buildF2LRescueProfiles(stage.f2lStyleProfile);
    for (let i = 0; i < styleRescueProfiles.length; i++) {
      const rescueStage = {
        ...stage,
        __styleFallbackTried: true,
        // Avoid recursive widening loops; this pass is for style simplification only.
        __relaxedSearchTried: true,
        f2lStyleProfile: styleRescueProfiles[i],
        formulaBeamWidth: Math.max(
          normalizeDepth(stage.formulaBeamWidth, STRICT_CFOP_PROFILE.f2lFormulaBeamWidth),
          8,
        ),
        formulaExpansionLimit: Math.max(
          normalizeDepth(stage.formulaExpansionLimit, STRICT_CFOP_PROFILE.f2lFormulaExpansionLimit),
          14,
        ),
        formulaMaxAttempts: Math.max(
          normalizeDepth(stage.formulaMaxAttempts, STRICT_CFOP_PROFILE.f2lFormulaMaxAttempts),
          260000,
        ),
      };
      const rescueResult = solveStage(startPattern, rescueStage, ctx);
      if (rescueResult?.ok) {
        return {
          ...rescueResult,
          recoveredByStyleFallback: true,
        };
      }
      const rescueNodes = rescueResult?.nodes || 0;
      if (rescueNodes > baseFailure.nodes) baseFailure.nodes = rescueNodes;
    }
  }

  return baseFailure;
}

export async function solve3x3StrictCfopFromPattern(pattern, options = {}) {
  const ctx = await getCfopContext();
  const solveMode = normalizeSolveMode(options.mode);
  const modeProfile = getCfopProfile(solveMode, options);
  const styleProfileInput =
    options.f2lStyleProfile !== undefined ? options.f2lStyleProfile : options.styleProfile;
  const mixedCfopStages = options.enableMixedCfopStages === true || isMixedCfopStyleProfile(styleProfileInput);
  const crossFailureStageName = solveMode === "zb" || mixedCfopStages ? "XCross" : "Cross";
  const crossColorRaw = normalizeCrossColor(options.crossColor);
  if (crossColorRaw === "CN" && !options.__colorNeutralProbeApplied) {
    const onStageUpdate = typeof options.onStageUpdate === "function" ? options.onStageUpdate : null;
    const f2lStyleProfile =
      styleProfileInput !== undefined && styleProfileInput !== null
        ? normalizeF2LStyleProfile(styleProfileInput)
        : F2L_STYLE_PROFILE_PRESETS.legacy;
    const mixedCaseBias = normalizeMixedCaseBias(styleProfileInput);
    const enableOllPllPrediction = options.enableOllPllPrediction !== false;
    const downstreamProfileInput =
      enableOllPllPrediction &&
      options.f2lDownstreamProfile !== undefined &&
      options.f2lDownstreamProfile !== null
        ? options.f2lDownstreamProfile
        : enableOllPllPrediction &&
            options.downstreamProfile !== undefined &&
            options.downstreamProfile !== null
          ? options.downstreamProfile
          : null;
    const f2lDownstreamProfile = downstreamProfileInput || null;
    const f2lDownstreamWeight = normalizeF2LDownstreamWeight(
      options.ollPllPredictionWeight,
      DEFAULT_F2L_DOWNSTREAM_WEIGHT,
    );
    const targetPairCandidates = getColorNeutralProbeTargetPairs(solveMode, styleProfileInput);
    const scrambleSeedBase = buildSolverDecisionSeed(options);
    if (onStageUpdate) {
      onStageUpdate({
        type: "fallback_start",
        stageName: "Color Neutral Cross Probe",
        reason: mixedCfopStages ? "BEST_XCROSS_SCAN" : "BEST_CROSS_SCAN",
      });
    }

    const probeStages = getStageDefinitions(options, ctx, modeProfile, solveMode);
    const crossProbeStage = probeStages[0];
    let bestProbe = null;
    // Compute per-color deadline; guarantees all 6 probes finish quickly.
    const overallDeadline = Number.isFinite(options.deadlineTs) && options.deadlineTs > 0 ? options.deadlineTs : 0;

    for (let i = 0; i < CROSS_COLOR_SEQUENCE.length; i++) {
      const candidateColor = CROSS_COLOR_SEQUENCE[i];
      const rotationCandidates = getCrossRotationCandidates(candidateColor);
      let bestColorProbe = null;
      const colorProbeDeadline = overallDeadline > 0
        ? Math.min(overallDeadline, Date.now() + CN_CROSS_PROBE_BUDGET_MS)
        : Date.now() + CN_CROSS_PROBE_BUDGET_MS;

      for (let r = 0; r < rotationCandidates.length; r++) {
        const rotationAlg = rotationCandidates[r];
        const transformedPattern = transformPatternForCrossColor(pattern, ctx.solvedPattern, rotationAlg);
        if (!transformedPattern) continue;

        for (let t = 0; t < targetPairCandidates.length; t++) {
          const targetPairs = targetPairCandidates[t];
          const probeStageOptions = {
            ...options,
            deadlineTs: colorProbeDeadline,
            scrambleKey: `${scrambleSeedBase}|CN|${candidateColor}|${targetPairs}`,
            crossTargetPairsOverride: targetPairs,
          };
          const probeStages = getStageDefinitions(probeStageOptions, ctx, modeProfile, solveMode);
          const probeCrossStage = probeStages[0] || crossProbeStage;
          const probeResult = solveStage(transformedPattern, probeCrossStage, ctx);
          const probeMoves = splitMoves(probeResult?.solution || "");
          const stylePenalty = getF2LStylePenalty(probeMoves, f2lStyleProfile);
          let downstreamPenalty = 0;
          let llBiasBonus = 0;
          if (probeResult?.ok && f2lDownstreamProfile) {
            const afterCrossPattern = probeMoves.length
              ? transformedPattern.applyAlg(joinMoves(probeMoves))
              : transformedPattern;
            const nextStateKey = getF2LStateKey(afterCrossPattern.patternData, ctx);
            const rawDownstreamPenalty = getF2LDownstreamPenalty(
              f2lDownstreamProfile,
              nextStateKey,
              f2lDownstreamWeight,
            );
            downstreamPenalty = Number.isFinite(rawDownstreamPenalty) ? rawDownstreamPenalty : 0;
            const downstreamMatch = findF2LDownstreamStateEntry(f2lDownstreamProfile, nextStateKey);
            const stateEntry = downstreamMatch?.stateEntry || null;
            if (stateEntry) {
              const zbllRate = clampRate01(stateEntry.zbllRate) ?? 0;
              const zblsRate = clampRate01(stateEntry.zblsRate) ?? 0;
              llBiasBonus =
                zbllRate * mixedCaseBias.zbllWeight * 2.2 +
                zblsRate * mixedCaseBias.zblsWeight * 1.2;
            }
          }
          const xcrossBonus =
            (targetPairs >= 1 ? mixedCaseBias.xcrossWeight * 2.0 : 0) +
            (targetPairs >= 2 ? mixedCaseBias.xxcrossWeight * 3.2 : 0);
          const candidateProbe = {
            color: candidateColor,
            ok: !!probeResult?.ok,
            stageRank: targetPairs,
            moveCount: Number.isFinite(probeResult?.moveCount) ? probeResult.moveCount : Number.MAX_SAFE_INTEGER,
            bound: Number.isFinite(probeResult?.bound) ? probeResult.bound : Number.MAX_SAFE_INTEGER,
            nodes: Number.isFinite(probeResult?.nodes) ? probeResult.nodes : Number.MAX_SAFE_INTEGER,
            compositeScore:
              (Number.isFinite(probeResult?.moveCount) ? probeResult.moveCount : 999) +
              stylePenalty * 0.35 +
              downstreamPenalty -
              xcrossBonus -
              llBiasBonus,
          };
          if (!bestColorProbe || compareCrossProbeResults(candidateProbe, bestColorProbe) < 0) {
            bestColorProbe = candidateProbe;
          }
        }
      }

      if (bestColorProbe && (!bestProbe || compareCrossProbeResults(bestColorProbe, bestProbe) < 0)) {
        bestProbe = bestColorProbe;
      }
      // Early exit: a short cross (≤6 moves) is good enough — no need to probe remaining colors.
      if (bestProbe && bestProbe.ok && bestProbe.moveCount <= 6) break;
    }

    const selectedCrossColor = bestProbe?.color || "D";
    if (onStageUpdate) {
      onStageUpdate({
        type: "fallback_done",
        stageName: `Color Neutral -> ${getCrossStageLabel(selectedCrossColor)}`,
      });
    }

    const colorNeutralResult = await solve3x3StrictCfopFromPattern(pattern, {
      ...options,
      crossColor: selectedCrossColor,
      __colorNeutralProbeApplied: true,
    });
    if (colorNeutralResult && typeof colorNeutralResult === "object") {
      return {
        ...colorNeutralResult,
        selectedCrossColor:
          typeof colorNeutralResult.selectedCrossColor === "string"
            ? colorNeutralResult.selectedCrossColor
            : selectedCrossColor,
      };
    }
    return colorNeutralResult;
  }
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
            stage: crossFailureStageName,
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
        stage: solveMode === "zb" ? "ZBLL" : "PLL",
        nodes: childResult.nodes || 0,
        stageDiagnostics: Array.isArray(childResult.stageDiagnostics)
          ? childResult.stageDiagnostics.slice()
          : [],
      };
    }

    return {
      ...childResult,
      selectedCrossColor: crossColorRaw,
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
  const stageDiagnostics = [];
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
    const stageStartedAt = Date.now();
    const stageDisplayName = resolveStageDisplayName(stage, stageStartPattern, ctx);
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
    const result = solveStage(stageStartPattern, stage, ctx);
    totalNodes += result.nodes || 0;
    if (typeof result.bound === "number" && result.bound !== STAGE_NOT_SET) {
      totalBound += result.bound;
    }
    if (!result.ok) {
      stageDiagnostics.push({
        stageIndex: i,
        stageName: stage.name,
        ok: false,
        reason: result.reason || `${stage.name.toUpperCase()}_FAILED`,
        nodes: result.nodes || 0,
        bound: result.bound,
        elapsedMs: Math.max(1, Date.now() - stageStartedAt),
      });
      const canAttemptZbRecovery =
        solveMode === "zb" &&
        (stage.name === "ZBLS" || stage.name === "ZBLL") &&
        !options.__zbRecoveryAttempted &&
        (String(result.reason || "").endsWith("_SEARCH_LIMIT") ||
          String(result.reason || "").endsWith("_NOT_FOUND"));
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
          mode: "strict",
          crossColor: "D",
          __colorNeutralApplied: true,
          __zbRecoveryAttempted: true,
          onStageUpdate: undefined,
          // Give recovery a fresh budget — the original deadlineTs may be near-expired
          // from the ZBLS IDA* search, which would cause all recovery stages to fail immediately.
          deadlineTs: Date.now() + 25000,
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
          stageDiagnostics.push({
            stageIndex: i,
            stageName: recoveryStageName,
            ok: true,
            reason: "RECOVERED",
            nodes: recoveryResult.nodes || 0,
            bound: recoveryResult.bound,
            elapsedMs: Math.max(1, Date.now() - stageStartedAt),
          });
          break;
        }

        if (onStageUpdate) {
          onStageUpdate({
            type: "fallback_fail",
            stageName: recoveryStageName,
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
        stageDiagnostics,
      };
    }

    const internalMoves = Array.isArray(result.moves) ? result.moves.slice() : [];
    const outputMoves = simplifyMoves(internalMoves);
    const moveText = joinMoves(outputMoves);
    const solvedStageDisplayName = resolveSolvedStageDisplayName(stage, stageStartPattern, result, ctx);
    const solvedStageLabel = stage.isCrossLike
      ? getCrossLikeStageLabel(stage.name, crossStageLabel)
      : solvedStageDisplayName;
    const stageEntries = [];
    if (stage.name === "F2L") {
      const pairSegments = splitF2LMovesIntoPairs(stageStartPattern, internalMoves, ctx);
      if (pairSegments.length) {
        pairSegments.forEach((segment, index) => {
          const segmentMoves = simplifyMoves(segment.moves);
          const pairLabel =
            segment.pairStart === segment.pairEnd
              ? `${segment.pairStart}`
              : `${segment.pairStart}-${segment.pairEnd}`;
          stageEntries.push({
            name: `F2L ${pairLabel}`,
            solution: joinMoves(segmentMoves),
            moveCount: segmentMoves.length,
            depth: segmentMoves.length,
            nodes: index === 0 ? result.nodes : undefined,
          });
        });
      } else if (outputMoves.length || stage.omitIfNoMoves !== true || stage.includeWhenEmpty === true) {
        stageEntries.push({
          name: solvedStageLabel,
          solution: joinMoves(outputMoves),
          moveCount: outputMoves.length,
          depth: outputMoves.length,
          nodes: result.nodes,
        });
      }
    } else if (outputMoves.length || stage.omitIfNoMoves !== true || stage.includeWhenEmpty === true) {
      stageEntries.push({
        name: solvedStageLabel,
        solution: joinMoves(outputMoves),
        moveCount: outputMoves.length,
        depth: outputMoves.length,
        nodes: result.nodes,
      });
    }
    solvedStages.push(...stageEntries);
    stageDiagnostics.push({
      stageIndex: i,
      stageName: stage.name,
      ok: true,
      reason: result.recoveredByStyleFallback ? "RECOVERED_BY_STYLE_FALLBACK" : "OK",
      nodes: result.nodes || 0,
      bound: result.bound,
      elapsedMs: Math.max(1, Date.now() - stageStartedAt),
      moveCount: outputMoves.length,
    });
    if (onStageUpdate) {
      onStageUpdate({
        type: "stage_done",
        stageIndex: i,
        totalStages: stages.length,
        stageName: solvedStageLabel,
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
      stageDiagnostics,
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
    selectedCrossColor: crossColorRaw === "CN" ? "D" : crossColorRaw,
    source:
      solveMode === "zb" ? "INTERNAL_3X3_CFOP_ZB_HYBRID" : "INTERNAL_3X3_CFOP_STRICT",
    stages: solvedStages,
    stageDiagnostics,
  };
}
