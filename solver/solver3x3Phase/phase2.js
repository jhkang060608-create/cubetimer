import { get3x3MoveTables } from "./tables3x3.js";
import { solvePhase2Direct as wasmSolvePhase2 } from "../wasmSolver.js";

const PHASE2_MOVE_NAMES = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"];
const PHASE2_MOVE_COUNT = PHASE2_MOVE_NAMES.length;
const OPPOSITE_FACE = [3, 4, 5, 0, 1, 2];
const NOT_SET = 255;
const CP_SIZE = 40320; // 8!
const EP_SIZE = 40320; // 8!
const SEP_SIZE = 24; // 4!
const FAIL_CACHE_LIMIT = 260000;
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];

// Bidirectional search constants
// P2 move slots: 0=U 1=U2 2=U' 3=D 4=D2 5=D' 6=R2 7=L2 8=F2 9=B2
const INVERSE_P2_SLOT = [2, 1, 0, 5, 4, 3, 6, 7, 8, 9]; // U↔U', D↔D', rest self-inverse
// Face per slot (0=U,1=D,2=R,3=L,4=F,5=B)
const P2_SLOT_FACE = [0, 0, 0, 1, 1, 1, 2, 3, 4, 5];
// Quarter-turn value per slot (1=CW, 2=half, 3=CCW)
const P2_SLOT_QUARTER = [1, 2, 3, 1, 2, 3, 2, 2, 2, 2];
// Base slot for each face (slot of X quarter-turn)
const P2_FACE_BASE_SLOT = [0, 3, 6, 7, 8, 9];
// P2 state key multipliers: key = cp * EP_SIZE * SEP_SIZE + ep * SEP_SIZE + sep
const P2_KEY_CP_MUL = EP_SIZE * SEP_SIZE; // 40320 * 24 = 967680
const P2_REVERSE_DEPTH = 7;
const P2_REVERSE_MAX_STATES = 2_000_000;

let initPromise = null;
let cpMove = null;
let epMove = null;
let sepMove = null;
let cpDist = null;
let epDist = null;
let sepDist = null;
let cpSepDist = null; // joint (CP × SEP) pruning table — tighter lower bound than max(cpDist, sepDist)
let phase2MoveFaces = null;
// Bidirectional reverse frontier: Map<stateKey, {depth, pathCode}>
// pathCode packs move slots 4-bits each: bits 0-3 = slot for move0, bits 4-7 = slot for move1, etc.
let p2ReverseFrontier = null;
let p2ReverseDepth = 0;     // how many layers were fully built
let p2ReverseComplete = false; // true if frontier covers ALL states ≤ p2ReverseDepth steps from solved
let allowedMovesByLastFace = null;

function encodePerm8(perm) {
  let idx = 0;
  for (let i = 0; i < 8; i++) {
    let smaller = 0;
    const current = perm[i];
    for (let j = i + 1; j < 8; j++) {
      if (perm[j] < current) smaller += 1;
    }
    idx += smaller * FACT[7 - i];
  }
  return idx;
}

function decodePerm8(idx, out) {
  const pool = [0, 1, 2, 3, 4, 5, 6, 7];
  let len = 8;
  for (let i = 0; i < 8; i++) {
    const f = FACT[7 - i];
    const digit = (idx / f) | 0;
    idx %= f;
    out[i] = pool[digit];
    for (let j = digit; j < len - 1; j++) {
      pool[j] = pool[j + 1];
    }
    len -= 1;
  }
}

function encodePerm4(perm) {
  let idx = 0;
  for (let i = 0; i < 4; i++) {
    let smaller = 0;
    const current = perm[i];
    for (let j = i + 1; j < 4; j++) {
      if (perm[j] < current) smaller += 1;
    }
    idx += smaller * FACT[3 - i];
  }
  return idx;
}

function decodePerm4(idx, out) {
  const pool = [0, 1, 2, 3];
  let len = 4;
  for (let i = 0; i < 4; i++) {
    const f = FACT[3 - i];
    const digit = (idx / f) | 0;
    idx %= f;
    out[i] = pool[digit];
    for (let j = digit; j < len - 1; j++) {
      pool[j] = pool[j + 1];
    }
    len -= 1;
  }
}

// Build joint (CP × SEP) pruning table via BFS. Gives a tighter lower bound
// than max(cpDist[cp], sepDist[sep]) because it accounts for interactions.
function buildCpSepDistTable() {
  const total = CP_SIZE * SEP_SIZE; // 967,680
  const dist = new Uint8Array(total);
  dist.fill(NOT_SET);
  const queue = new Uint32Array(total);
  let head = 0;
  let tail = 0;
  dist[0] = 0;
  queue[tail++] = 0; // (cp=0, sep=0) → key = 0
  while (head < tail) {
    const key = queue[head++];
    const cp = (key / SEP_SIZE) | 0;
    const sep = key % SEP_SIZE;
    const nextDepth = dist[key] + 1;
    const cpBase = cp * PHASE2_MOVE_COUNT;
    const sepBase = sep * PHASE2_MOVE_COUNT;
    for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
      const ncp = cpMove[cpBase + m];
      const nsep = sepMove[sepBase + m];
      const nkey = ncp * SEP_SIZE + nsep;
      if (dist[nkey] !== NOT_SET) continue;
      dist[nkey] = nextDepth;
      queue[tail++] = nkey;
    }
  }
  return dist;
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
    const state = queue[head++];
    const nextDepth = dist[state] + 1;
    const base = state * PHASE2_MOVE_COUNT;
    for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
      const nextState = moveTable[base + m];
      if (dist[nextState] !== NOT_SET) continue;
      dist[nextState] = nextDepth;
      queue[tail++] = nextState;
    }
  }
  return dist;
}

function parsePhase2Coords(pattern) {
  const corners = pattern?.patternData?.CORNERS?.pieces;
  const edges = pattern?.patternData?.EDGES?.pieces;
  if (!Array.isArray(corners) || corners.length < 8) return null;
  if (!Array.isArray(edges) || edges.length < 12) return null;

  const cp = new Uint8Array(8);
  const ep = new Uint8Array(8);
  const sep = new Uint8Array(4);

  for (let i = 0; i < 8; i++) {
    const cornerPiece = corners[i];
    const edgePiece = edges[i];
    if (!Number.isInteger(cornerPiece) || cornerPiece < 0 || cornerPiece > 7) return null;
    if (!Number.isInteger(edgePiece) || edgePiece < 0 || edgePiece > 7) return null;
    cp[i] = cornerPiece;
    ep[i] = edgePiece;
  }

  for (let i = 0; i < 4; i++) {
    const edgePiece = edges[8 + i];
    if (!Number.isInteger(edgePiece) || edgePiece < 8 || edgePiece > 11) return null;
    sep[i] = edgePiece - 8;
  }

  return {
    cpIdx: encodePerm8(cp),
    epIdx: encodePerm8(ep),
    sepIdx: encodePerm4(sep),
  };
}

async function ensurePhase2Tables() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const { cornerPermMap, edgePermMap, MOVE_NAMES } = await get3x3MoveTables();

    const phase2MoveIndices = PHASE2_MOVE_NAMES.map((name) => MOVE_NAMES.indexOf(name));
    if (phase2MoveIndices.some((idx) => idx < 0)) {
      throw new Error("PHASE2_MOVE_INDEX_NOT_FOUND");
    }

    const faceIndexByMove = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
    phase2MoveFaces = PHASE2_MOVE_NAMES.map((name) => faceIndexByMove[name[0]]);

    allowedMovesByLastFace = Array.from({ length: 7 }, () => []);
    for (let lastFace = 0; lastFace <= 6; lastFace++) {
      for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
        if (lastFace === 6) {
          allowedMovesByLastFace[lastFace].push(m);
          continue;
        }
        const face = phase2MoveFaces[m];
        if (face === lastFace) continue;
        if (face === OPPOSITE_FACE[lastFace] && face < lastFace) continue;
        allowedMovesByLastFace[lastFace].push(m);
      }
    }

    cpMove = new Uint16Array(CP_SIZE * PHASE2_MOVE_COUNT);
    epMove = new Uint16Array(EP_SIZE * PHASE2_MOVE_COUNT);
    sepMove = new Uint8Array(SEP_SIZE * PHASE2_MOVE_COUNT);

    const cp = new Uint8Array(8);
    const cpNext = new Uint8Array(8);
    for (let s = 0; s < CP_SIZE; s++) {
      decodePerm8(s, cp);
      const base = s * PHASE2_MOVE_COUNT;
      for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
        const moveIdx = phase2MoveIndices[m];
        const mapBase = moveIdx * 8;
        for (let i = 0; i < 8; i++) {
          cpNext[i] = cp[cornerPermMap[mapBase + i]];
        }
        cpMove[base + m] = encodePerm8(cpNext);
      }
    }

    const ep = new Uint8Array(8);
    const epNext = new Uint8Array(8);
    for (let s = 0; s < EP_SIZE; s++) {
      decodePerm8(s, ep);
      const base = s * PHASE2_MOVE_COUNT;
      for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
        const moveIdx = phase2MoveIndices[m];
        const mapBase = moveIdx * 12;
        for (let i = 0; i < 8; i++) {
          const oldPos = edgePermMap[mapBase + i];
          if (oldPos > 7) throw new Error("PHASE2_EDGE_MOVE_INVALID");
          epNext[i] = ep[oldPos];
        }
        epMove[base + m] = encodePerm8(epNext);
      }
    }

    const sep = new Uint8Array(4);
    const sepNext = new Uint8Array(4);
    for (let s = 0; s < SEP_SIZE; s++) {
      decodePerm4(s, sep);
      const base = s * PHASE2_MOVE_COUNT;
      for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
        const moveIdx = phase2MoveIndices[m];
        const mapBase = moveIdx * 12;
        for (let i = 0; i < 4; i++) {
          const oldPos = edgePermMap[mapBase + 8 + i] - 8;
          if (oldPos < 0 || oldPos > 3) throw new Error("PHASE2_SLICE_MOVE_INVALID");
          sepNext[i] = sep[oldPos];
        }
        sepMove[base + m] = encodePerm4(sepNext);
      }
    }

    cpDist = buildDistTable(cpMove, CP_SIZE);
    epDist = buildDistTable(epMove, EP_SIZE);
    sepDist = buildDistTable(sepMove, SEP_SIZE);
    cpSepDist = buildCpSepDistTable(); // joint pruning — must come after cpMove/sepMove are built
  })();
  return initPromise;
}

/**
 * Build reverse frontier (BFS from solved state) for bidirectional P2 search.
 * Stores all states reachable from solved in ≤ P2_REVERSE_DEPTH moves.
 * Must be called after ensurePhase2Tables().
 */
function buildP2ReverseFrontier() {
  if (p2ReverseFrontier !== null) return; // already built

  const frontier = new Map();
  frontier.set(0, { depth: 0, pathCode: 0 }); // solved: cp=0, ep=0, sep=0 → key=0

  let currentLayer = [{ cp: 0, ep: 0, sep: 0, pathCode: 0 }];
  let completedDepth = 0;

  for (let d = 1; d <= P2_REVERSE_DEPTH; d++) {
    const pending = new Map();
    for (let li = 0; li < currentLayer.length; li++) {
      const { cp, ep, sep, pathCode } = currentLayer[li];
      const cpBase = cp * PHASE2_MOVE_COUNT;
      const epBase = ep * PHASE2_MOVE_COUNT;
      const sepBase = sep * PHASE2_MOVE_COUNT;
      for (let m = 0; m < PHASE2_MOVE_COUNT; m++) {
        const ncp = cpMove[cpBase + m];
        const nep = epMove[epBase + m];
        const nsep = sepMove[sepBase + m];
        const key = ncp * P2_KEY_CP_MUL + nep * SEP_SIZE + nsep;
        if (frontier.has(key) || pending.has(key)) continue;
        pending.set(key, {
          cp: ncp, ep: nep, sep: nsep,
          pathCode: pathCode | (m << ((d - 1) << 2)), // pack slot into 4 bits at position (d-1)
        });
      }
    }

    if (pending.size === 0) {
      // Entire P2 group covered — frontier is complete
      completedDepth = P2_REVERSE_DEPTH;
      break;
    }
    if (frontier.size + pending.size > P2_REVERSE_MAX_STATES) {
      // Hit state limit; only layers 0..d-1 are complete
      break;
    }

    const nextLayer = [];
    for (const [key, entry] of pending) {
      frontier.set(key, { depth: d, pathCode: entry.pathCode });
      nextLayer.push({ cp: entry.cp, ep: entry.ep, sep: entry.sep, pathCode: entry.pathCode });
    }
    currentLayer = nextLayer;
    completedDepth = d;
  }

  p2ReverseFrontier = frontier;
  p2ReverseDepth = completedDepth;
  // Complete = we finished all P2_REVERSE_DEPTH layers without hitting state limit
  p2ReverseComplete = completedDepth >= P2_REVERSE_DEPTH;
}

/**
 * Simplify an array of P2 move slots by cancelling adjacent same-face moves.
 * Uses a stack-based scan to handle chain cancellations.
 */
function simplifyP2Slots(slots) {
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const m = slots[i];
    if (out.length > 0 && P2_SLOT_FACE[out[out.length - 1]] === P2_SLOT_FACE[m]) {
      const combined = (P2_SLOT_QUARTER[out[out.length - 1]] + P2_SLOT_QUARTER[m]) & 3;
      out.pop();
      if (combined !== 0) {
        out.push(P2_FACE_BASE_SLOT[P2_SLOT_FACE[m]] + combined - 1);
      }
    } else {
      out.push(m);
    }
  }
  return out;
}

export function buildPhase2Input(pattern, options = {}) {
  const coords = parsePhase2Coords(pattern);
  return {
    cpIdx: coords?.cpIdx ?? -1,
    epIdx: coords?.epIdx ?? -1,
    sepIdx: coords?.sepIdx ?? -1,
    valid: !!coords,
    maxDepth: options.phase2MaxDepth ?? 18,
    nodeLimit: options.phase2NodeLimit ?? 450000,
    deadlineTs: options.deadlineTs,
    timeCheckInterval: options.timeCheckInterval,
  };
}

export async function solvePhase2(input) {
  const { cpIdx, epIdx, sepIdx, valid, maxDepth, nodeLimit, deadlineTs, timeCheckInterval } = input;
  if (!valid || cpIdx < 0 || epIdx < 0 || sepIdx < 0) {
    return { ok: false, reason: "PHASE2_INVALID_INPUT", nodes: 0 };
  }

  if (cpIdx === 0 && epIdx === 0 && sepIdx === 0) {
    return { ok: true, moves: [], depth: 0, nodes: 0 };
  }

  // WASM fast path: use Rust IDA* (10-50x faster per node than JS)
  try {
    const wasmResult = await wasmSolvePhase2(cpIdx, epIdx, sepIdx, maxDepth, nodeLimit || 0);
    if (wasmResult && wasmResult.ok) {
      return { ok: true, moves: wasmResult.moves, depth: wasmResult.depth, nodes: wasmResult.nodes || 0 };
    }
  } catch (_) { /* fall through to JS solver */ }

  // JS fallback with meet-in-the-middle
  await ensurePhase2Tables();
  buildP2ReverseFrontier();

  let bound = Math.max(cpSepDist[cpIdx * SEP_SIZE + sepIdx], epDist[epIdx], 1);
  const path = [];
  let nodes = 0;
  let nodeLimitHit = false;
  let timeLimitHit = false;
  const hasDeadline = Number.isFinite(deadlineTs);
  const checkInterval = Number.isFinite(timeCheckInterval)
    ? Math.max(128, Math.floor(timeCheckInterval))
    : 1024;
  let checkCounter = 0;
  // Fail cache persists across IDA* iterations: valid since remaining-budget bits are bound-independent.
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

  function dfs(cp, ep, sep, depth, currentBound, lastFace) {
    if (timeLimitHit || nodeLimitHit) return Infinity;
    const h = Math.max(cpSepDist[cp * SEP_SIZE + sep], epDist[ep]);
    const f = depth + h;
    if (f > currentBound) return f;

    const remaining = currentBound - depth;

    // Bidirectional meet-in-the-middle: check reverse frontier
    const stateKey = cp * P2_KEY_CP_MUL + ep * SEP_SIZE + sep;
    const rfEntry = p2ReverseFrontier !== null ? p2ReverseFrontier.get(stateKey) : undefined;
    if (rfEntry !== undefined && rfEntry.depth <= remaining) {
      // Found a meeting point: append the inverse reverse-path
      // rfEntry.path encodes BFS moves from solved → this state (slots packed 4 bits each).
      // To go from this state → solved: apply inverse moves in forward order.
      for (let i = 0; i < rfEntry.depth; i++) {
        path.push(INVERSE_P2_SLOT[(rfEntry.pathCode >> (i << 2)) & 0xf]);
      }
      return true;
    }
    // Prune: if frontier is complete and remaining ≤ reverseDepth,
    // any state not in frontier is further than reverseDepth from solved → can't solve.
    if (p2ReverseComplete && remaining <= p2ReverseDepth) {
      return Infinity;
    }

    if (cp === 0 && ep === 0 && sep === 0) return true;

    const cacheKey = ((((cp * EP_SIZE + ep) * SEP_SIZE + sep) * 7) + lastFace);
    const seenMask = failCache.get(cacheKey) || 0;
    const bit = 1 << Math.min(remaining, 30);
    if (seenMask & bit) return Infinity;

    let minNext = Infinity;
    const moves = allowedMovesByLastFace[lastFace];
    for (let i = 0; i < moves.length; i++) {
      if (shouldStopSearch()) return Infinity;
      const m = moves[i];
      nodes += 1;
      const nextCp = cpMove[cp * PHASE2_MOVE_COUNT + m];
      const nextEp = epMove[ep * PHASE2_MOVE_COUNT + m];
      const nextSep = sepMove[sep * PHASE2_MOVE_COUNT + m];
      const nextH = Math.max(cpSepDist[nextCp * SEP_SIZE + nextSep], epDist[nextEp]);
      const nextF = depth + 1 + nextH;
      if (nextF > currentBound) {
        if (nextF < minNext) minNext = nextF;
        continue;
      }
      const res = dfs(nextCp, nextEp, nextSep, depth + 1, currentBound, phase2MoveFaces[m]);
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
    const res = dfs(cpIdx, epIdx, sepIdx, 0, bound, 6);
    if (res === true) {
      path.reverse();
      // Simplify: bidirectional path may have cancellable moves at the junction
      const simplified = simplifyP2Slots(path);
      return { ok: true, moves: simplified.map((m) => PHASE2_MOVE_NAMES[m]), depth: simplified.length, nodes };
    }
    if (!Number.isFinite(res)) break;
    bound = res;
  }

  if (nodeLimitHit) {
    return { ok: false, reason: "PHASE2_SEARCH_LIMIT", nodes };
  }
  if (timeLimitHit) {
    return { ok: false, reason: "PHASE2_TIMEOUT", nodes };
  }
  return { ok: false, reason: "PHASE2_NOT_FOUND", nodes };
}
