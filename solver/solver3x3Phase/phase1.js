import { get3x3MoveTables } from "./tables3x3.js";
import { MOVE_NAMES } from "../moves.js";

const CO_SIZE = 3 ** 7; // 2187
const EO_SIZE = 2 ** 11; // 2048
const SLICE_SIZE = 495; // C(12,4)
const MOVE_COUNT = 18;
const NOT_SET = 255;
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];
const SLICE_EDGE_IDS = new Set([8, 9, 10, 11]);
const FAIL_CACHE_LIMIT = 220000;

// DR reverse frontier constants
// CO*SLICE state key: co * SLICE_SIZE + sl
// Pack move index into 5 bits per depth slot (≤18 moves, fits in 5 bits)
const DR_REVERSE_DEPTH = 5;
const DR_REVERSE_MAX_STATES = 200_000;
// Inverse map for DR_EO_MOVE_INDICES:
// U=0↔U'=1, U2=2 self, R=3↔R'=4, R2=5 self, F2=8 self,
// D=9↔D'=10, D2=11 self, L=12↔L'=13, L2=14 self, B2=17 self
// In terms of DR_EO_MOVE_INDICES array positions (0..13 → actual MOVE_NAMES indices):
// [0,1,2,3,4,5,8,9,10,11,12,13,14,17] → positions 0..13
// Inverse by move: MOVE_NAMES index: 0↔1, 2 self, 3↔4, 5 self, 8 self, 9↔10, 11 self, 12↔13, 14 self, 17 self
const DR_EO_INVERSE_BY_FULL_INDEX = new Array(18).fill(0).map((_, i) => i);
// U(0)↔U'(1), R(3)↔R'(4), D(9)↔D'(10), L(12)↔L'(13)
(function() {
  const pairs = [[0,1],[3,4],[9,10],[12,13]];
  for (const [a,b] of pairs) { DR_EO_INVERSE_BY_FULL_INDEX[a]=b; DR_EO_INVERSE_BY_FULL_INDEX[b]=a; }
})();
const SOLVED_SLICE_OCC = (() => {
  const occ = new Uint8Array(12);
  occ[8] = 1;
  occ[9] = 1;
  occ[10] = 1;
  occ[11] = 1;
  return occ;
})();

// Domino Reduction move set: U, U', U2, D, D', D2, R2, L2, F2, B2
// These preserve edge orientation AND corners oriented and E-slice — the full Phase2 invariants.
// Indices into MOVE_NAMES = ['U','U\'','U2','R','R\'','R2','F','F\'','F2','D','D\'','D2','L','L\'','L2','B','B\'','B2']
const DR_MOVE_INDICES = [0, 1, 2, 5, 8, 9, 10, 11, 14, 17];

// EO-preserving moves: U, U', U2, D, D', D2, R, R', R2, L, L', L2, F2, B2
// These preserve edge orientation but may change CO and E-slice occupancy.
// Used for the EO→DR phase: from an EO-complete state, find moves that achieve DR
// (CO=0 + E-slice in E-slice) using the full EO-preserving subgroup.
const DR_EO_MOVE_INDICES = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 17];

let initPromise = null;
let coMove = null;
let eoMove = null;
let sliceMove = null;
let coDist = null;
let eoDist = null;
let sliceDist = null;
let allowedMovesByLastFace = null;
let drAllowedMovesByLastFace = null;
let drEoAllowedMovesByLastFace = null;
let moveFace = null;
let coSliceDist = null;
let coSliceFirstMove = null; // BFS first-move table: instant optimal DR lookup
// DR reverse frontier: Map<coSliceKey, {depth, pathCode}>
let drReverseFrontier = null;
let drReverseDepth = 0;
let drReverseComplete = false;

const combMemo = new Map();
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const key = `${n}|${k}`;
  if (combMemo.has(key)) return combMemo.get(key);
  const v = comb(n - 1, k - 1) + comb(n - 1, k);
  combMemo.set(key, v);
  return v;
}

function encodeCO(ori) {
  let idx = 0;
  for (let i = 0; i < 7; i++) idx = idx * 3 + ori[i];
  return idx;
}

function decodeCO(idx, out) {
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    const v = idx % 3;
    out[i] = v;
    sum += v;
    idx = (idx / 3) | 0;
  }
  out[7] = (3 - (sum % 3)) % 3;
}

function encodeEO(ori) {
  let idx = 0;
  for (let i = 0; i < 11; i++) idx = (idx << 1) | (ori[i] & 1);
  return idx;
}

function decodeEO(idx, out) {
  let sum = 0;
  for (let i = 10; i >= 0; i--) {
    const v = idx & 1;
    out[i] = v;
    sum += v;
    idx >>= 1;
  }
  out[11] = sum & 1;
}

function encodeSliceFromOccupancy(occ) {
  let idx = 0;
  let r = 4;
  for (let i = 11; i >= 0; i--) {
    if (!occ[i]) continue;
    idx += comb(i, r);
    r -= 1;
    if (r === 0) break;
  }
  return idx;
}

function decodeSliceToOccupancy(idx, occ) {
  occ.fill(0);
  let r = 4;
  for (let i = 11; i >= 0; i--) {
    if (idx >= comb(i, r)) {
      occ[i] = 1;
      idx -= comb(i, r);
      r -= 1;
      if (r === 0) break;
    }
  }
}

function buildDistTable(moveTable, size, startState = 0) {
  const dist = new Uint8Array(size);
  dist.fill(NOT_SET);
  const queue = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  dist[startState] = 0;
  queue[tail++] = startState;
  while (head < tail) {
    const s = queue[head++];
    const d = dist[s] + 1;
    const base = s * MOVE_COUNT;
    for (let m = 0; m < MOVE_COUNT; m++) {
      const n = moveTable[base + m];
      if (dist[n] !== NOT_SET) continue;
      dist[n] = d;
      queue[tail++] = n;
    }
  }
  return dist;
}

async function ensurePhase1Tables() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { cornerPermMap, cornerOriDelta, edgePermMap, edgeOriDelta, moveFace: mf } = await get3x3MoveTables();
    moveFace = mf;

    coMove = new Uint16Array(CO_SIZE * MOVE_COUNT);
    eoMove = new Uint16Array(EO_SIZE * MOVE_COUNT);
    sliceMove = new Uint16Array(SLICE_SIZE * MOVE_COUNT);

    const co = new Uint8Array(8);
    const nextCo = new Uint8Array(8);
    for (let s = 0; s < CO_SIZE; s++) {
      decodeCO(s, co);
      const base = s * MOVE_COUNT;
      for (let m = 0; m < MOVE_COUNT; m++) {
        const mb = m * 8;
        for (let i = 0; i < 8; i++) {
          const oldPos = cornerPermMap[mb + i];
          nextCo[i] = (co[oldPos] + cornerOriDelta[mb + i]) % 3;
        }
        coMove[base + m] = encodeCO(nextCo);
      }
    }

    const eo = new Uint8Array(12);
    const nextEo = new Uint8Array(12);
    for (let s = 0; s < EO_SIZE; s++) {
      decodeEO(s, eo);
      const base = s * MOVE_COUNT;
      for (let m = 0; m < MOVE_COUNT; m++) {
        const mb = m * 12;
        for (let i = 0; i < 12; i++) {
          const oldPos = edgePermMap[mb + i];
          nextEo[i] = (eo[oldPos] + edgeOriDelta[mb + i]) & 1;
        }
        eoMove[base + m] = encodeEO(nextEo);
      }
    }

    const occ = new Uint8Array(12);
    const nextOcc = new Uint8Array(12);
    for (let s = 0; s < SLICE_SIZE; s++) {
      decodeSliceToOccupancy(s, occ);
      const base = s * MOVE_COUNT;
      for (let m = 0; m < MOVE_COUNT; m++) {
        const mb = m * 12;
        for (let i = 0; i < 12; i++) {
          nextOcc[i] = occ[edgePermMap[mb + i]];
        }
        sliceMove[base + m] = encodeSliceFromOccupancy(nextOcc);
      }
    }

    const solvedSliceIdx = encodeSliceFromOccupancy(SOLVED_SLICE_OCC);
    coDist = buildDistTable(coMove, CO_SIZE, 0);
    eoDist = buildDistTable(eoMove, EO_SIZE, 0);
    sliceDist = buildDistTable(sliceMove, SLICE_SIZE, solvedSliceIdx);

    // Build joint CO+slice pruning table for the EO→DR phase.
    // coSliceDist[co * SLICE_SIZE + sl] = min moves (using EO-preserving moves) to reach co=0, sl=solvedSliceIdx.
    // EO-preserving moves = U,U',U2,D,D',D2,R,R',R2,L,L',L2,F2,B2.
    // BFS backwards from the solved DR state.
    const CO_SLICE_SIZE = CO_SIZE * SLICE_SIZE;
    coSliceDist = new Uint8Array(CO_SLICE_SIZE).fill(255);
    coSliceFirstMove = new Uint8Array(CO_SLICE_SIZE).fill(255);
    const drEoMoves = DR_EO_MOVE_INDICES;
    const startKey = 0 * SLICE_SIZE + solvedSliceIdx;
    coSliceDist[startKey] = 0;
    let frontier = [startKey];
    for (let depth = 1; frontier.length > 0 && depth <= 20; depth++) {
      const next = [];
      for (let fi = 0; fi < frontier.length; fi++) {
        const key = frontier[fi];
        const co = (key / SLICE_SIZE) | 0;
        const sl = key % SLICE_SIZE;
        for (let di = 0; di < drEoMoves.length; di++) {
          const m = drEoMoves[di];
          const nco = coMove[co * MOVE_COUNT + m];
          const nsl = sliceMove[sl * MOVE_COUNT + m];
          const nkey = nco * SLICE_SIZE + nsl;
          if (coSliceDist[nkey] === 255) {
            coSliceDist[nkey] = depth;
            coSliceFirstMove[nkey] = DR_EO_INVERSE_BY_FULL_INDEX[m];
            next.push(nkey);
          }
        }
      }
      frontier = next;
    }

    allowedMovesByLastFace = Array.from({ length: 7 }, () => []);
    for (let last = 0; last <= 6; last++) {
      for (let m = 0; m < MOVE_COUNT; m++) {
        if (last === 6) {
          allowedMovesByLastFace[last].push(m);
          continue;
        }
        const current = moveFace[m];
        if (current === last) continue;
        if (current === OPPOSITE_FACE[last] && current < last) continue;
        allowedMovesByLastFace[last].push(m);
      }
    }

    drAllowedMovesByLastFace = Array.from({ length: 7 }, () => []);
    for (let last = 0; last <= 6; last++) {
      for (let di = 0; di < DR_MOVE_INDICES.length; di++) {
        const m = DR_MOVE_INDICES[di];
        if (last === 6) {
          drAllowedMovesByLastFace[last].push(m);
          continue;
        }
        const current = moveFace[m];
        if (current === last) continue;
        if (current === OPPOSITE_FACE[last] && current < last) continue;
        drAllowedMovesByLastFace[last].push(m);
      }
    }

    drEoAllowedMovesByLastFace = Array.from({ length: 7 }, () => []);
    for (let last = 0; last <= 6; last++) {
      for (let di = 0; di < DR_EO_MOVE_INDICES.length; di++) {
        const m = DR_EO_MOVE_INDICES[di];
        if (last === 6) {
          drEoAllowedMovesByLastFace[last].push(m);
          continue;
        }
        const current = moveFace[m];
        if (current === last) continue;
        if (current === OPPOSITE_FACE[last] && current < last) continue;
        drEoAllowedMovesByLastFace[last].push(m);
      }
    }

    // Build DR reverse frontier: BFS from solved DR state (co=0, sl=solvedSliceIdx)
    // using DR_EO_MOVE_INDICES moves, storing all states within DR_REVERSE_DEPTH steps.
    drReverseFrontier = new Map();
    drReverseFrontier.set(0 * SLICE_SIZE + solvedSliceIdx, { depth: 0, pathCode: 0 });
    let drFrontierLayer = [{ co: 0, sl: solvedSliceIdx, pathCode: 0 }];
    let drCompletedDepth = 0;
    for (let d = 1; d <= DR_REVERSE_DEPTH; d++) {
      const pending = new Map();
      for (let li = 0; li < drFrontierLayer.length; li++) {
        const { co, sl, pathCode } = drFrontierLayer[li];
        for (let di = 0; di < DR_EO_MOVE_INDICES.length; di++) {
          const m = DR_EO_MOVE_INDICES[di];
          const nco = coMove[co * MOVE_COUNT + m];
          const nsl = sliceMove[sl * MOVE_COUNT + m];
          const key = nco * SLICE_SIZE + nsl;
          if (drReverseFrontier.has(key) || pending.has(key)) continue;
          pending.set(key, { co: nco, sl: nsl, pathCode: pathCode | (m << ((d - 1) * 5)) });
        }
      }
      if (pending.size === 0) { drCompletedDepth = DR_REVERSE_DEPTH; break; }
      if (drReverseFrontier.size + pending.size > DR_REVERSE_MAX_STATES) break;
      const nextLayer = [];
      for (const [key, entry] of pending) {
        drReverseFrontier.set(key, { depth: d, pathCode: entry.pathCode });
        nextLayer.push({ co: entry.co, sl: entry.sl, pathCode: entry.pathCode });
      }
      drFrontierLayer = nextLayer;
      drCompletedDepth = d;
    }
    drReverseDepth = drCompletedDepth;
    drReverseComplete = drCompletedDepth >= DR_REVERSE_DEPTH;
  })();
  return initPromise;
}

export function buildPhase1Input(coords, options = {}) {
  const cornerOri = coords.corners.orientation;
  const edgeOri = coords.edges.orientation;
  const edgePieces = coords.edges.pieces;
  const occ = new Uint8Array(12);
  for (let i = 0; i < 12; i++) occ[i] = SLICE_EDGE_IDS.has(edgePieces[i]) ? 1 : 0;
  return {
    coIdx: encodeCO(cornerOri),
    eoIdx: encodeEO(edgeOri),
    sliceIdx: encodeSliceFromOccupancy(occ),
    maxDepth: options.phase1MaxDepth ?? 12,
    nodeLimit: options.phase1NodeLimit ?? 350000,
    deadlineTs: options.deadlineTs,
    timeCheckInterval: options.timeCheckInterval,
  };
}

export async function solvePhase1(input) {
  await ensurePhase1Tables();
  const { coIdx, eoIdx, sliceIdx, maxDepth, nodeLimit, deadlineTs, timeCheckInterval } = input;
  const solvedSliceIdx = encodeSliceFromOccupancy(SOLVED_SLICE_OCC);
  if (coIdx === 0 && eoIdx === 0 && sliceIdx === solvedSliceIdx) {
    return { ok: true, moves: [], depth: 0, nodes: 0 };
  }

  let bound = Math.max(coDist[coIdx], eoDist[eoIdx], sliceDist[sliceIdx], 1);
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  let timeLimitHit = false;
  const hasDeadline = Number.isFinite(deadlineTs);
  const checkInterval = Number.isFinite(timeCheckInterval)
    ? Math.max(128, Math.floor(timeCheckInterval))
    : 1024;
  let checkCounter = 0;
  // Fail cache persists across IDA* iterations: "from (state, lastFace) with N remaining moves, no solution exists"
  // This is valid across bound increases because the state space doesn't change.
  let failCache = new Map();

  function shouldStopSearch() {
    if (nodeLimit > 0 && nodes >= nodeLimit) {
      nodeLimitHit = true;
      return true;
    }
    if (!hasDeadline) return false;
    checkCounter += 1;
    if (checkCounter < checkInterval) return false;
    checkCounter = 0;
    if (Date.now() >= deadlineTs) {
      timeLimitHit = true;
      return true;
    }
    return false;
  }

  function dfs(co, eo, sl, depth, currentBound, lastFace) {
    if (timeLimitHit || nodeLimitHit) return Infinity;
    const h = Math.max(coDist[co], eoDist[eo], sliceDist[sl]);
    const f = depth + h;
    if (f > currentBound) return f;
    if (co === 0 && eo === 0 && sl === solvedSliceIdx) return true;
    const remaining = currentBound - depth;
    const cacheKey = ((((co * EO_SIZE + eo) * SLICE_SIZE + sl) * 7) + lastFace);
    const seenMask = failCache.get(cacheKey) || 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    let minNext = Infinity;
    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      if (shouldStopSearch()) {
        return Infinity;
      }
      const m = moves[i];
      nodes += 1;
      const nextCo = coMove[co * MOVE_COUNT + m];
      const nextEo = eoMove[eo * MOVE_COUNT + m];
      const nextSl = sliceMove[sl * MOVE_COUNT + m];
      const nextH = Math.max(coDist[nextCo], eoDist[nextEo], sliceDist[nextSl]);
      const nextF = depth + 1 + nextH;
      if (nextF > currentBound) {
        if (nextF < minNext) minNext = nextF;
        continue;
      }
      const res = dfs(nextCo, nextEo, nextSl, depth + 1, currentBound, Math.floor(m / 3));
      if (res === true) {
        path.push(m);
        return true;
      }
      if (res < minNext) minNext = res;
    }
    if (failCache.size > FAIL_CACHE_LIMIT) failCache.clear();
    failCache.set(cacheKey, seenMask | bit);
    return minNext;
  }

  while (bound <= maxDepth) {
    if (nodeLimitHit || timeLimitHit) break;
    if (hasDeadline && Date.now() >= deadlineTs) {
      timeLimitHit = true;
      break;
    }
    path.length = 0;
    const res = dfs(coIdx, eoIdx, sliceIdx, 0, bound, 6);
    if (res === true) {
      path.reverse();
      return { ok: true, moves: path.map((m) => MOVE_NAMES[m]), depth: path.length, nodes };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }
  if (nodeLimitHit) {
    return { ok: false, reason: "PHASE1_SEARCH_LIMIT", nodes };
  }
  if (timeLimitHit) {
    return { ok: false, reason: "PHASE1_TIMEOUT", nodes };
  }
  return { ok: false, reason: "PHASE1_NOT_FOUND", nodes };
}

/**
 * Find short move sequences that solve edge orientation (EO) from a given state.
 * Uses the EO distance table and IDA* DFS to enumerate all solutions up to maxDepth.
 * Returns an array of move-name arrays (string[][]).
 * For FMC: use results as targeted EO premoves before the main phase solve.
 */
export async function findShortEOSequences(coords, maxDepth = 5, maxCount = 8) {
  await ensurePhase1Tables();
  const edgeOri = coords.edges?.orientation;
  if (!Array.isArray(edgeOri) || edgeOri.length < 11) return [];

  let eoIdx = 0;
  for (let i = 0; i < 11; i++) eoIdx = (eoIdx << 1) | (edgeOri[i] & 1);
  if (eoIdx === 0) return [[]]; // Already EO solved

  const minDist = eoDist[eoIdx];
  if (minDist > maxDepth) return [];

  const solutions = [];
  const path = [];

  function dfs(eoIdx, lastFace, depth) {
    if (solutions.length >= maxCount) return;
    if (eoIdx === 0) {
      solutions.push(path.map((m) => MOVE_NAMES[m]));
      return;
    }
    if (depth === 0) return;
    if (eoDist[eoIdx] > depth) return;

    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      if (solutions.length >= maxCount) return;
      const m = moves[i];
      const nextEo = eoMove[eoIdx * MOVE_COUNT + m];
      path.push(m);
      dfs(nextEo, Math.floor(m / 3), depth - 1);
      path.pop();
    }
  }

  for (let d = minDist; d <= maxDepth && solutions.length < maxCount; d++) {
    dfs(eoIdx, 6, d);
  }
  return solutions;
}

/**
 * Like solvePhase1 but collects up to maxCount solutions at the minimum IDA* depth.
 * Uses solvePhase1 to find the minimum depth, then enumerates more solutions at that
 * depth (and minDepth+1) via a targeted fixed-depth DFS.
 * Returns { solutions: [{moves}], minDepth, nodes }
 */
export async function solvePhase1Multi(input, maxCount = 4) {
  // Step 1: find first solution + minimum depth with standard IDA*
  const first = await solvePhase1(input);
  if (!first.ok) {
    return { solutions: [], minDepth: -1, nodes: first.nodes || 0 };
  }
  const minDepth = first.depth;
  const solutions = [{ moves: first.moves }];
  if (maxCount <= 1 || first.nodes === 0 /* trivial */ ) {
    return { solutions, minDepth, nodes: first.nodes };
  }

  // Step 2: enumerate more solutions at minDepth and minDepth+1 via fixed-depth DFS
  await ensurePhase1Tables();
  const { coIdx, eoIdx, sliceIdx, maxDepth, nodeLimit, deadlineTs, timeCheckInterval } = input;
  const solvedSliceIdx = encodeSliceFromOccupancy(SOLVED_SLICE_OCC);
  // seenKeys uses move-name keys for consistent deduplication with first.moves (strings)
  const seenKeys = new Set([first.moves.join(",")]);
  let nodes = first.nodes;
  let timeLimitHit = false;
  const hasDeadline = Number.isFinite(deadlineTs);
  const checkInterval = Number.isFinite(timeCheckInterval)
    ? Math.max(128, Math.floor(timeCheckInterval))
    : 1024;
  let checkCounter = 0;
  const enumPath = []; // stores integer move indices during DFS

  function shouldStop() {
    if (timeLimitHit) return true;
    if (hasDeadline) {
      checkCounter += 1;
      if (checkCounter >= checkInterval) {
        checkCounter = 0;
        if (Date.now() >= deadlineTs) { timeLimitHit = true; return true; }
      }
    }
    return false;
  }

  function enumerate(co, eo, sl, depth, targetDepth, lastFace) {
    if (solutions.length >= maxCount || shouldStop()) return;
    const h = Math.max(coDist[co], eoDist[eo], sliceDist[sl]);
    if (depth + h > targetDepth) return;
    if (co === 0 && eo === 0 && sl === solvedSliceIdx) {
      if (depth === targetDepth) {
        // Convert indices to move names before dedup/storing
        const names = enumPath.map((m) => MOVE_NAMES[m]);
        const key = names.join(",");
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          solutions.push({ moves: names });
        }
      }
      return;
    }
    if (depth >= targetDepth) return;
    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      if (solutions.length >= maxCount || shouldStop()) return;
      const m = moves[i];
      nodes += 1;
      const nextCo = coMove[co * MOVE_COUNT + m];
      const nextEo = eoMove[eo * MOVE_COUNT + m];
      const nextSl = sliceMove[sl * MOVE_COUNT + m];
      if (depth + 1 + Math.max(coDist[nextCo], eoDist[nextEo], sliceDist[nextSl]) > targetDepth) continue;
      enumPath.push(m);
      enumerate(nextCo, nextEo, nextSl, depth + 1, targetDepth, Math.floor(m / 3));
      enumPath.pop();
    }
  }

  // Enumerate at minDepth (avoid duplicate of first solution via seenKeys)
  enumerate(coIdx, eoIdx, sliceIdx, 0, minDepth, 6);

  // If still need more and time allows, try minDepth+1
  if (solutions.length < maxCount && !timeLimitHit && minDepth + 1 <= (maxDepth || 12)) {
    enumerate(coIdx, eoIdx, sliceIdx, 0, minDepth + 1, 6);
  }

  return { solutions, minDepth, nodes };
}

// MOVE_NAMES index face and quarter-turn for DR_EO_MOVE_INDICES moves:
// Face: U=0, R=1, F=2, D=3, L=4, B=5 (index / 3 within MOVE_NAMES)
// Quarter: 1=CW, 2=half, 3=CCW (index % 3 + 1)
function simplifyDrSlots(slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const m = slots[i];
    const face = (m / 3) | 0; // MOVE_NAMES index: 0-2=U,3-5=R,6-8=F,9-11=D,12-14=L,15-17=B
    if (out.length > 0 && ((out[out.length - 1] / 3) | 0) === face) {
      const qt = (m % 3) + 1; // 1=cw, 2=half, 3=ccw
      const prevQt = (out[out.length - 1] % 3) + 1;
      const combined = (prevQt + qt) & 3; // mod 4 (0 = cancel)
      out.pop();
      if (combined !== 0) out.push(face * 3 + combined - 1);
    } else {
      out.push(m);
    }
  }
  return out;
}

/**
 * Domino Reduction (DR) solver: given a state where EO is already solved,
 * find a sequence of domino moves (U,U',U2, D,D',D2, R2,L2,F2,B2) that achieves
 * CO=0 AND all E-slice edges in E-slice positions.
 * Called after findShortEOSequences to complete the EO→DR step of FMC technique.
 */
export async function solveDomino(coords, options = {}) {
  await ensurePhase1Tables();
  const cornerOri = coords.corners?.orientation;
  const edgePieces = coords.edges?.pieces;
  if (!Array.isArray(cornerOri) || cornerOri.length < 7) return { ok: false, nodes: 0, reason: 'DR_BAD_INPUT' };
  if (!Array.isArray(edgePieces) || edgePieces.length < 12) return { ok: false, nodes: 0, reason: 'DR_BAD_INPUT' };

  const occ = new Uint8Array(12);
  for (let i = 0; i < 12; i++) occ[i] = SLICE_EDGE_IDS.has(edgePieces[i]) ? 1 : 0;
  const coIdx = encodeCO(cornerOri);
  const sliceIdx = encodeSliceFromOccupancy(occ);
  const solvedSliceIdx = encodeSliceFromOccupancy(SOLVED_SLICE_OCC);

  if (coIdx === 0 && sliceIdx === solvedSliceIdx) {
    return { ok: true, moves: [], depth: 0, nodes: 0 };
  }

  // Fast path: follow BFS first-move table for instant optimal DR solution (O(depth), no search)
  if (coSliceFirstMove !== null) {
    const fastPath = [];
    let fco = coIdx, fsl = sliceIdx;
    while (fco !== 0 || fsl !== solvedSliceIdx) {
      const fkey = fco * SLICE_SIZE + fsl;
      const fm = coSliceFirstMove[fkey];
      if (fm === 255 || fastPath.length > 20) break;
      fastPath.push(fm);
      fco = coMove[fco * MOVE_COUNT + fm];
      fsl = sliceMove[fsl * MOVE_COUNT + fm];
    }
    if (fco === 0 && fsl === solvedSliceIdx) {
      return { ok: true, moves: fastPath.map(m => MOVE_NAMES[m]), depth: fastPath.length, nodes: 0 };
    }
  }

  // Fallback: IDA* search (only if first-move table unavailable or state unreachable)
  const maxDepth = options.maxDepth ?? 14;
  const nodeLimit = Number.isFinite(options.nodeLimit) ? options.nodeLimit : 2000000;
  const deadlineTs = options.deadlineTs;
  const hasDeadline = Number.isFinite(deadlineTs);

  let bound = coSliceDist[coIdx * SLICE_SIZE + sliceIdx];
  if (bound === 255) bound = Math.max(coDist[coIdx], sliceDist[sliceIdx], 1);
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  let timeLimitHit = false;

  function dfs(co, sl, depth, currentBound, lastFace) {
    if (timeLimitHit || nodeLimitHit) return Infinity;
    const h = coSliceDist[co * SLICE_SIZE + sl];
    const hBound = h === 255 ? Math.max(coDist[co], sliceDist[sl]) : h;
    const f = depth + hBound;
    if (f > currentBound) return f;

    const remaining = currentBound - depth;

    // Bidirectional meet-in-the-middle: check DR reverse frontier
    const rfKey = co * SLICE_SIZE + sl;
    const rfEntry = drReverseFrontier !== null ? drReverseFrontier.get(rfKey) : undefined;
    if (rfEntry !== undefined && rfEntry.depth <= remaining) {
      // Append inverse of reverse path (frontier stores BFS from solved → this state)
      for (let i = 0; i < rfEntry.depth; i++) {
        const slot = (rfEntry.pathCode >> (i * 5)) & 0x1f;
        path.push(DR_EO_INVERSE_BY_FULL_INDEX[slot]);
      }
      return true;
    }
    // If frontier is complete and remaining ≤ reverseDepth, any state not in frontier
    // is further than reverseDepth from solved → prune
    if (drReverseComplete && remaining <= drReverseDepth) {
      return Infinity;
    }

    if (co === 0 && sl === solvedSliceIdx) return true;

    let minNext = Infinity;
    const moves = drEoAllowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      nodes++;
      if (nodeLimit > 0 && nodes >= nodeLimit) { nodeLimitHit = true; return Infinity; }
      if (hasDeadline && (nodes & 1023) === 0 && Date.now() >= deadlineTs) { timeLimitHit = true; return Infinity; }

      const nextCo = coMove[co * MOVE_COUNT + m];
      const nextSl = sliceMove[sl * MOVE_COUNT + m];
      const nextH = coSliceDist[nextCo * SLICE_SIZE + nextSl];
      const nextHBound = nextH === 255 ? Math.max(coDist[nextCo], sliceDist[nextSl]) : nextH;
      const nextF = depth + 1 + nextHBound;
      if (nextF > currentBound) {
        if (nextF < minNext) minNext = nextF;
        continue;
      }
      const res = dfs(nextCo, nextSl, depth + 1, currentBound, moveFace[m]);
      if (res === true) {
        path.push(m);
        return true;
      }
      if (res < minNext) minNext = res;
    }
    return minNext;
  }

  while (bound <= maxDepth) {
    if (nodeLimitHit || timeLimitHit) break;
    if (hasDeadline && Date.now() >= deadlineTs) { timeLimitHit = true; break; }
    path.length = 0;
    const res = dfs(coIdx, sliceIdx, 0, bound, 6);
    if (res === true) {
      path.reverse();
      // Simplify: bidirectional junction may have cancellable moves
      const simplified = simplifyDrSlots(path);
      return { ok: true, moves: simplified.map((m) => MOVE_NAMES[m]), depth: simplified.length, nodes };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  return {
    ok: false, nodes,
    reason: nodeLimitHit ? 'DR_NODE_LIMIT' : timeLimitHit ? 'DR_TIMEOUT' : 'DR_NOT_FOUND',
  };
}
