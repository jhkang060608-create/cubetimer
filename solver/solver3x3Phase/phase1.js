import { get3x3MoveTables } from "./tables3x3.js";

const CO_SIZE = 3 ** 7; // 2187
const EO_SIZE = 2 ** 11; // 2048
const SLICE_SIZE = 495; // C(12,4)
const MOVE_COUNT = 18;
const NOT_SET = 255;
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];
const SLICE_EDGE_IDS = new Set([8, 9, 10, 11]);

let initPromise = null;
let coMove = null;
let eoMove = null;
let sliceMove = null;
let coDist = null;
let eoDist = null;
let sliceDist = null;
let allowedMovesByLastFace = null;

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

function buildDistTable(moveTable, size) {
  const dist = new Uint8Array(size);
  dist.fill(NOT_SET);
  const queue = new Uint32Array(size);
  let head = 0;
  let tail = 0;
  dist[0] = 0;
  queue[tail++] = 0;
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
    const { cornerPermMap, cornerOriDelta, edgePermMap, edgeOriDelta, moveFace } = await get3x3MoveTables();

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

    coDist = buildDistTable(coMove, CO_SIZE);
    eoDist = buildDistTable(eoMove, EO_SIZE);
    sliceDist = buildDistTable(sliceMove, SLICE_SIZE);

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
  };
}

export async function solvePhase1(input) {
  await ensurePhase1Tables();
  const { coIdx, eoIdx, sliceIdx, maxDepth, nodeLimit } = input;
  if (coIdx === 0 && eoIdx === 0 && sliceIdx === 0) {
    return { ok: true, moves: [], depth: 0, nodes: 0 };
  }

  let bound = Math.max(coDist[coIdx], eoDist[eoIdx], sliceDist[sliceIdx], 1);
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;

  function dfs(co, eo, sl, depth, currentBound, lastFace) {
    const h = Math.max(coDist[co], eoDist[eo], sliceDist[sl]);
    const f = depth + h;
    if (f > currentBound) return f;
    if (co === 0 && eo === 0 && sl === 0) return true;

    let minNext = Infinity;
    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      if (nodeLimit > 0 && nodes >= nodeLimit) {
        nodeLimitHit = true;
        return Infinity;
      }
      const m = moves[i];
      nodes += 1;
      const nextCo = coMove[co * MOVE_COUNT + m];
      const nextEo = eoMove[eo * MOVE_COUNT + m];
      const nextSl = sliceMove[sl * MOVE_COUNT + m];
      const res = dfs(nextCo, nextEo, nextSl, depth + 1, currentBound, Math.floor(m / 3));
      if (res === true) {
        path.push(m);
        return true;
      }
      if (res < minNext) minNext = res;
    }
    return minNext;
  }

  while (bound <= maxDepth) {
    if (nodeLimitHit) break;
    path.length = 0;
    const res = dfs(coIdx, eoIdx, sliceIdx, 0, bound, 6);
    if (res === true) {
      path.reverse();
      const { MOVE_NAMES } = await get3x3MoveTables();
      return { ok: true, moves: path.map((m) => MOVE_NAMES[m]), depth: path.length, nodes };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }
  if (nodeLimitHit) {
    return { ok: false, reason: "PHASE1_SEARCH_LIMIT", nodes };
  }
  return { ok: false, reason: "PHASE1_NOT_FOUND", nodes };
}

