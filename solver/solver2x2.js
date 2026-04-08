import { getDefaultPattern } from "./context.js";
import { MOVE_NAMES } from "./moves.js";

const ORI_SIZE = 3 ** 7; // 2187
const PERM_SIZE = 40320; // 8!
const MOVE_COUNT = MOVE_NAMES.length; // 18
const NOT_SET = 255;
const MAX_DEPTH = 14;
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];
const FAIL_CACHE_LIMIT = 300000;

let initPromise = null;
let permMoveTable = null;
let oriMoveTable = null;
let permDistTable = null;
let oriDistTable = null;
let movePermMap = null;
let moveOriDelta = null;
let moveFace = null; // 0..5 face index (U,R,F,D,L,B)
let solvedPattern = null;
let allowedMovesByLastFace = null;

const FACE_TO_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];

function encodeOrientation(orientation) {
  let idx = 0;
  for (let i = 0; i < 7; i++) {
    idx = idx * 3 + orientation[i];
  }
  return idx;
}

function decodeOrientation(idx, out) {
  let sum = 0;
  for (let i = 6; i >= 0; i--) {
    const v = idx % 3;
    out[i] = v;
    sum += v;
    idx = (idx / 3) | 0;
  }
  out[7] = (3 - (sum % 3)) % 3;
}

function encodePermutation(perm) {
  let idx = 0;
  for (let i = 0; i < 7; i++) {
    idx *= 8 - i;
    for (let j = i + 1; j < 8; j++) {
      if (perm[j] < perm[i]) idx += 1;
    }
  }
  return idx;
}

function decodePermutation(idx, out) {
  const elems = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < 8; i++) {
    const f = FACT[7 - i];
    const q = (idx / f) | 0;
    idx %= f;
    out[i] = elems[q];
    elems.splice(q, 1);
  }
}

function buildDistanceTable(moveTable, stateSize) {
  const dist = new Uint8Array(stateSize);
  dist.fill(NOT_SET);
  const queue = new Uint32Array(stateSize);
  let head = 0;
  let tail = 0;
  dist[0] = 0;
  queue[tail++] = 0;

  while (head < tail) {
    const state = queue[head++];
    const nextDepth = dist[state] + 1;
    const base = state * MOVE_COUNT;
    for (let m = 0; m < MOVE_COUNT; m++) {
      const next = moveTable[base + m];
      if (dist[next] === NOT_SET) {
        dist[next] = nextDepth;
        queue[tail++] = next;
      }
    }
  }
  return dist;
}

async function initialize2x2Tables() {
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    solvedPattern = await getDefaultPattern("222");

    movePermMap = new Uint8Array(MOVE_COUNT * 8);
    moveOriDelta = new Uint8Array(MOVE_COUNT * 8);
    moveFace = new Uint8Array(MOVE_COUNT);

    for (let m = 0; m < MOVE_COUNT; m++) {
      const moved = solvedPattern.applyMove(MOVE_NAMES[m]).patternData.CORNERS;
      const faceChar = MOVE_NAMES[m][0];
      moveFace[m] = FACE_TO_INDEX[faceChar];
      for (let i = 0; i < 8; i++) {
        movePermMap[m * 8 + i] = moved.pieces[i];
        moveOriDelta[m * 8 + i] = moved.orientation[i];
      }
    }

    allowedMovesByLastFace = Array.from({ length: 7 }, () => []);
    for (let lastFace = 0; lastFace <= 6; lastFace++) {
      for (let m = 0; m < MOVE_COUNT; m++) {
        if (lastFace === 6) {
          allowedMovesByLastFace[lastFace].push(m);
          continue;
        }
        const currentFace = moveFace[m];
        // Rule 1: avoid same-face repetitions (already handled before, now table-driven).
        if (currentFace === lastFace) continue;
        // Rule 2: canonicalize opposite-face commuting sequences.
        // Keep only one ordering between opposite faces, e.g. prefer U then D over D then U.
        if (currentFace === OPPOSITE_FACE[lastFace] && currentFace < lastFace) continue;
        allowedMovesByLastFace[lastFace].push(m);
      }
    }

    oriMoveTable = new Uint16Array(ORI_SIZE * MOVE_COUNT);
    permMoveTable = new Uint32Array(PERM_SIZE * MOVE_COUNT);

    const ori = new Uint8Array(8);
    const nextOri = new Uint8Array(8);
    for (let state = 0; state < ORI_SIZE; state++) {
      decodeOrientation(state, ori);
      const base = state * MOVE_COUNT;
      for (let m = 0; m < MOVE_COUNT; m++) {
        const mapBase = m * 8;
        for (let i = 0; i < 8; i++) {
          const oldPos = movePermMap[mapBase + i];
          nextOri[i] = (ori[oldPos] + moveOriDelta[mapBase + i]) % 3;
        }
        oriMoveTable[base + m] = encodeOrientation(nextOri);
      }
    }

    const perm = new Uint8Array(8);
    const nextPerm = new Uint8Array(8);
    for (let state = 0; state < PERM_SIZE; state++) {
      decodePermutation(state, perm);
      const base = state * MOVE_COUNT;
      for (let m = 0; m < MOVE_COUNT; m++) {
        const mapBase = m * 8;
        for (let i = 0; i < 8; i++) {
          nextPerm[i] = perm[movePermMap[mapBase + i]];
        }
        permMoveTable[base + m] = encodePermutation(nextPerm);
      }
    }

    oriDistTable = buildDistanceTable(oriMoveTable, ORI_SIZE);
    permDistTable = buildDistanceTable(permMoveTable, PERM_SIZE);
  })();
  return initPromise;
}

export async function solve2x2Scramble(scramble) {
  await initialize2x2Tables();

  const pattern = scramble ? solvedPattern.applyAlg(scramble) : solvedPattern;
  const corners = pattern.patternData.CORNERS;
  const startPerm = encodePermutation(corners.pieces);
  const startOri = encodeOrientation(corners.orientation);

  if (startPerm === 0 && startOri === 0) {
    return { solution: "", moveCount: 0, nodes: 0, bound: 0 };
  }

  let bound = Math.max(permDistTable[startPerm], oriDistTable[startOri], 1);
  const path = [];
  let nodes = 0;
  let failCache = new Map();

  function dfs(permState, oriState, depth, currentBound, lastFace) {
    const h = Math.max(permDistTable[permState], oriDistTable[oriState]);
    const f = depth + h;
    if (f > currentBound) return f;
    if (permState === 0 && oriState === 0) return true;

    const remaining = currentBound - depth;
    const cacheBase = (permState * ORI_SIZE + oriState) * 8 + lastFace;
    const visitedMask = failCache.get(cacheBase) || 0;
    const remainingBit = 1 << remaining;
    if ((visitedMask & remainingBit) !== 0) {
      return Infinity;
    }

    let minNextBound = Infinity;
    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      nodes += 1;
      const nextPerm = permMoveTable[permState * MOVE_COUNT + m];
      const nextOri = oriMoveTable[oriState * MOVE_COUNT + m];
      const res = dfs(nextPerm, nextOri, depth + 1, currentBound, moveFace[m]);
      if (res === true) {
        path.push(MOVE_NAMES[m]);
        return true;
      }
      if (res < minNextBound) minNextBound = res;
    }
    if (failCache.size >= FAIL_CACHE_LIMIT) {
      failCache.clear();
    }
    failCache.set(cacheBase, visitedMask | remainingBit);
    return minNextBound;
  }

  while (bound <= MAX_DEPTH) {
    path.length = 0;
    failCache = new Map();
    const result = dfs(startPerm, startOri, 0, bound, 6);
    if (result === true) {
      path.reverse();
      return {
        solution: path.join(" "),
        moveCount: path.length,
        nodes,
        bound,
      };
    }
    if (!Number.isFinite(result)) break;
    bound = result;
  }

  return null;
}
