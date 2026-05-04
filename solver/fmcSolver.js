import { getDefaultPattern } from "./context.js";
import { findShortEOSequences, solveDomino } from "./solver3x3Phase/phase1.js";
import { buildPhase2Input, solvePhase2 } from "./solver3x3Phase/phase2.js";
import { MOVE_NAMES } from "./moves.js";
import { parsePatternToCoords3x3 } from "./solver3x3Phase/state3x3.js";
import {
  ensureTwophase333Ready,
  prepareTwophase333,
  searchTwophase333,
  dropTwophase333Search,
  buildFmcTablesWasm,
  solveFmcWasm,
  optimizeInsertionWasm,
  verifyFmcSolutionWasm,
} from "./wasmSolver.js";

const FMC_PREMOVE_TURNS = ["", "'", "2"];
const FMC_PREMOVE_SINGLE_FACES = ["U", "R", "F", "D", "L", "B"];
const FMC_PREMOVE_PAIR_FACES = [
  ["U", "R"],
  ["R", "U"],
  ["U", "F"],
  ["F", "U"],
  ["R", "F"],
  ["F", "R"],
  ["D", "L"],
  ["L", "D"],
  ["D", "B"],
  ["B", "D"],
  ["L", "B"],
  ["B", "L"],
  ["U", "D"],
  ["D", "U"],
  ["R", "L"],
  ["L", "R"],
  ["F", "B"],
  ["B", "F"],
];

function buildFmcPremoveSets() {
  const sets = [];
  const seen = new Set();
  const pushSet = (moves) => {
    const normalized = simplifyMoves(moves);
    if (!normalized.length || normalized.length > 2) return;
    const key = normalized.join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    sets.push(normalized);
  };

  for (let i = 0; i < FMC_PREMOVE_SINGLE_FACES.length; i += 1) {
    const face = FMC_PREMOVE_SINGLE_FACES[i];
    for (let t = 0; t < FMC_PREMOVE_TURNS.length; t += 1) {
      pushSet([`${face}${FMC_PREMOVE_TURNS[t]}`]);
    }
  }

  for (let a = 0; a < FMC_PREMOVE_TURNS.length; a += 1) {
    for (let b = 0; b < FMC_PREMOVE_TURNS.length; b += 1) {
      for (let i = 0; i < FMC_PREMOVE_PAIR_FACES.length; i += 1) {
        const [faceA, faceB] = FMC_PREMOVE_PAIR_FACES[i];
        const first = `${faceA}${FMC_PREMOVE_TURNS[a]}`;
        const second = `${faceB}${FMC_PREMOVE_TURNS[b]}`;
        pushSet([first, second]);
      }
    }
  }

  return sets;
}

const FMC_PREMOVE_SETS = buildFmcPremoveSets();

// Face indices: U=0, D=1, R=2, L=3, F=4, B=5
const FACE_TO_IDX = { U: 0, D: 1, R: 2, L: 3, F: 4, B: 5 };
const IDX_TO_FACE = ["U", "D", "R", "L", "F", "B"];
const FACE_AXIS = { U: 0, D: 0, R: 1, L: 1, F: 2, B: 2 };

// EO axis configurations for multi-axis FMC solving.
// scramble_map: original_face_idx → rotated_frame_face_idx (to express scramble in rotated frame)
// solution_map: rotated_frame_face_idx → original_face_idx (to convert solution back)
// Axes use conjugation by cube rotations: x (for FB axis), z (for RL axis).
// x rotation: F→U, U→B, B→D, D→F, R→R, L→L
// z rotation: U→R, R→D, D→L, L→U, F→F, B→B
const EO_AXIS_CONFIGS = [
  { name: "UD", identity: true,  scramble_map: [0, 1, 2, 3, 4, 5], solution_map: [0, 1, 2, 3, 4, 5] },
  { name: "FB", identity: false, scramble_map: [5, 4, 2, 3, 0, 1], solution_map: [4, 5, 2, 3, 1, 0] },
  { name: "RL", identity: false, scramble_map: [2, 3, 1, 0, 4, 5], solution_map: [3, 2, 0, 1, 4, 5] },
];

function conjugateMove(moveStr, faceMap) {
  if (!moveStr || typeof moveStr !== "string") return moveStr;
  const letter = moveStr[0].toUpperCase();
  const faceIdx = FACE_TO_IDX[letter];
  if (faceIdx === undefined) return moveStr; // cube rotations (x/y/z), wide moves, etc.
  return IDX_TO_FACE[faceMap[faceIdx]] + moveStr.slice(1);
}

function conjugateMoves(moves, faceMap) {
  return moves.map((m) => conjugateMove(m, faceMap));
}

let solvedPatternPromise = null;
const FMC_INSERTION_MOVE_NAMES = MOVE_NAMES.slice();

// Canonical face ordering (Kociemba convention: U=0, R=1, F=2, D=3, L=4, B=5)
// Used to prune equivalent commuting-move sequences in the BFS frontier.
const FRON_FACE_TO_IDX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const FRON_OPP_FACE = [3, 4, 5, 0, 1, 2]; // opposite face index for each face
const FMC_INSERTION_MOVE_FACE_IDX = FMC_INSERTION_MOVE_NAMES.map((m) => FRON_FACE_TO_IDX[m[0]] ?? -1);
const PATTERN_STATE_KEY_CACHE = new WeakMap();

// Module-level insertion replacement cache: persists across solves.
// findShorterEquivalentSegment results depend only on cube state pairs, not on scramble,
// so sharing them across solves is safe and avoids redundant bidirectional BFS work.
const MODULE_INSERTION_CACHE_LIMIT = 8000;
const moduleInsertionReplacementCache = new Map();
function _evictInsertionCache() {
  if (moduleInsertionReplacementCache.size <= MODULE_INSERTION_CACHE_LIMIT) return;
  const cutoff = Math.floor(MODULE_INSERTION_CACHE_LIMIT * 0.25);
  let pruned = 0;
  for (const key of moduleInsertionReplacementCache.keys()) {
    moduleInsertionReplacementCache.delete(key);
    if (++pruned >= cutoff) break;
  }
}

function splitMoves(alg) {
  if (!alg || typeof alg !== "string") return [];
  return alg
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function joinMoves(parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyMovesToPattern(pattern, moves) {
  if (!pattern || !Array.isArray(moves) || !moves.length) return pattern;
  let current = pattern;
  for (let i = 0; i < moves.length; i += 1) {
    current = current.applyMove(moves[i]);
  }
  return current;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT_${timeoutMs}MS`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function remainingMs(deadlineTs) {
  if (!Number.isFinite(deadlineTs)) return Infinity;
  return deadlineTs - Date.now();
}

function clampAttemptDeadline(deadlineTs, attemptMs, reserveMs = 120) {
  const now = Date.now();
  if (!Number.isFinite(deadlineTs)) {
    return now + Math.max(100, Math.floor(attemptMs));
  }
  const remaining = deadlineTs - now;
  if (remaining <= reserveMs) return now;
  const bounded = Math.max(80, Math.min(Math.floor(attemptMs), remaining - reserveMs));
  return now + bounded;
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

function invertToken(token) {
  if (!token) return token;
  if (token.endsWith("2")) return token;
  if (token.endsWith("'")) return token.slice(0, -1);
  return `${token}'`;
}

function invertMoves(moves) {
  const out = [];
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    out.push(invertToken(moves[i]));
  }
  return out;
}

function invertAlg(algText) {
  return joinMoves(invertMoves(splitMoves(algText)));
}

function canonicalizeAlg(algText) {
  return joinMoves(simplifyMoves(splitMoves(algText)));
}

function isReverseScrambleSolution(solutionText, reverseScrambleCanonical) {
  if (!solutionText || !reverseScrambleCanonical) return false;
  return canonicalizeAlg(solutionText) === reverseScrambleCanonical;
}

function orbitStateKey(orbit) {
  if (!orbit) return "";
  const pieces = Array.isArray(orbit.pieces) ? orbit.pieces : [];
  const orientation = Array.isArray(orbit.orientation) ? orbit.orientation : [];
  return `${pieces.join(",")}/${orientation.join(",")}`;
}

function patternStateKey(pattern) {
  if (pattern && PATTERN_STATE_KEY_CACHE.has(pattern)) {
    return PATTERN_STATE_KEY_CACHE.get(pattern);
  }
  const data = pattern?.patternData;
  if (!data) return "";
  const key = `C:${orbitStateKey(data.CORNERS)}|E:${orbitStateKey(data.EDGES)}|N:${orbitStateKey(data.CENTERS)}`;
  if (pattern) {
    PATTERN_STATE_KEY_CACHE.set(pattern, key);
  }
  return key;
}

function getMoveAxis(move) {
  const face = typeof move === "string" && move.length ? move[0].toUpperCase() : "";
  return face in FACE_AXIS ? FACE_AXIS[face] : -1;
}

function computeFmcStructureMetrics(moves) {
  const normalizedMoves = Array.isArray(moves) ? moves : [];
  let halfTurnCount = 0;
  let axisSwitches = 0;
  let sameAxisAdjacency = 0;
  let cancellationPotential = 0;
  let previousAxis = -1;

  for (let i = 0; i < normalizedMoves.length; i += 1) {
    const move = normalizedMoves[i];
    const axis = getMoveAxis(move);
    if (typeof move === "string" && move.includes("2")) {
      halfTurnCount += 1;
    }
    if (axis >= 0 && previousAxis >= 0) {
      if (axis !== previousAxis) {
        axisSwitches += 1;
      } else {
        sameAxisAdjacency += 1;
      }
    }
    previousAxis = axis;
  }

  for (let i = 0; i < normalizedMoves.length; i += 1) {
    const left = i > 0 ? normalizedMoves[i - 1] : "";
    const current = normalizedMoves[i];
    const right = i + 1 < normalizedMoves.length ? normalizedMoves[i + 1] : "";
    const currentAxis = getMoveAxis(current);
    if (typeof current === "string" && current.includes("2")) {
      cancellationPotential += 1;
    }
    if (left && right) {
      const leftAxis = getMoveAxis(left);
      const rightAxis = getMoveAxis(right);
      if (leftAxis >= 0 && leftAxis === rightAxis && leftAxis !== currentAxis) {
        cancellationPotential += 3;
      }
    }
    if (left && current && left[0] === current[0]) {
      cancellationPotential += 2;
    }
    if (right && current && right[0] === current[0]) {
      cancellationPotential += 2;
    }
  }

  return {
    halfTurnCount,
    axisSwitches,
    sameAxisAdjacency,
    cancellationPotential,
    insertionPotential: cancellationPotential * 4 + halfTurnCount * 2 + sameAxisAdjacency - axisSwitches,
  };
}

function compareFmcCandidatePriority(a, b) {
  if (!a) return 1;
  if (!b) return -1;
  if (a.moveCount !== b.moveCount) return a.moveCount - b.moveCount;
  const insertionDelta = (b.insertionPotential || 0) - (a.insertionPotential || 0);
  if (insertionDelta !== 0) return insertionDelta;
  const cancellationDelta = (b.cancellationPotential || 0) - (a.cancellationPotential || 0);
  if (cancellationDelta !== 0) return cancellationDelta;
  const axisDelta = (a.axisSwitches || 0) - (b.axisSwitches || 0);
  if (axisDelta !== 0) return axisDelta;
  return String(a.solution || "").localeCompare(String(b.solution || ""));
}

function pushRankedUniqueCandidate(list, candidate, limit = Infinity) {
  if (!candidate) return;
  const existingIndex = list.findIndex((entry) => entry.solution === candidate.solution);
  if (existingIndex >= 0) {
    if (compareFmcCandidatePriority(candidate, list[existingIndex]) < 0) {
      list[existingIndex] = candidate;
    }
  } else {
    list.push(candidate);
  }
  list.sort(compareFmcCandidatePriority);
  if (Number.isFinite(limit) && limit > 0 && list.length > limit) {
    list.length = limit;
  }
}

const FMC_SEARCH_PROFILE_PRESETS = Object.freeze({
  micro: Object.freeze({
    candidateLimit: 3,
    axisCandidateLimit: 1,
    eoSequenceLimit: 3,
    refineScale: 0.4,
  }),
  light: Object.freeze({
    candidateLimit: 4,
    axisCandidateLimit: 1,
    eoSequenceLimit: 4,
    refineScale: 0.65,
  }),
  balanced: Object.freeze({
    candidateLimit: 6,
    axisCandidateLimit: 2,
    eoSequenceLimit: 5,
    refineScale: 0.85,
  }),
  deep: Object.freeze({
    candidateLimit: 7,
    axisCandidateLimit: 2,
    eoSequenceLimit: 6,
    refineScale: 1,
  }),
});

function normalizeFmcSearchProfileLevel(level, fallback = "balanced") {
  const normalized = String(level || fallback).trim().toLowerCase();
  if (normalized === "micro") return "micro";
  if (normalized === "light") return "light";
  if (normalized === "deep") return "deep";
  return "balanced";
}

function normalizeFmcAttemptBudgetMs(value, fallback = 0) {
  const budgetMs = Number(value);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return fallback;
  return Math.max(250, Math.floor(budgetMs));
}

function getFmcMoveCountGap(currentBestMoveCount, targetMoveCount) {
  if (!Number.isFinite(currentBestMoveCount)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(targetMoveCount)) return Math.max(0, Math.floor(currentBestMoveCount));
  return Math.max(0, Math.floor(currentBestMoveCount) - Math.floor(targetMoveCount));
}

function buildFmcAttemptProfile(profileLevel, currentBestMoveCount, targetMoveCount, overrides = {}) {
  const normalizedLevel = normalizeFmcSearchProfileLevel(profileLevel);
  const preset = FMC_SEARCH_PROFILE_PRESETS[normalizedLevel] || FMC_SEARCH_PROFILE_PRESETS.balanced;
  const gapToTarget = getFmcMoveCountGap(currentBestMoveCount, targetMoveCount);
  let candidateLimit = preset.candidateLimit;
  let axisCandidateLimit = preset.axisCandidateLimit;
  let eoSequenceLimit = preset.eoSequenceLimit;

  if (gapToTarget <= 1) {
    candidateLimit = Math.max(2, candidateLimit - 2);
    axisCandidateLimit = 1;
    eoSequenceLimit = Math.max(2, eoSequenceLimit - 1);
  } else if (gapToTarget <= 3) {
    candidateLimit = Math.max(2, candidateLimit - 1);
    eoSequenceLimit = Math.max(3, eoSequenceLimit - (normalizedLevel === "deep" ? 0 : 1));
  }

  if (Number.isFinite(Number(overrides.axisCandidateLimit))) {
    axisCandidateLimit = Math.max(1, Math.floor(Number(overrides.axisCandidateLimit)));
  }
  if (Number.isFinite(Number(overrides.candidateLimit))) {
    candidateLimit = Math.max(axisCandidateLimit, Math.floor(Number(overrides.candidateLimit)));
  } else {
    candidateLimit = Math.max(axisCandidateLimit, candidateLimit);
  }
  if (Number.isFinite(Number(overrides.eoSequenceLimit))) {
    eoSequenceLimit = Math.max(1, Math.floor(Number(overrides.eoSequenceLimit)));
  }

  return {
    profileLevel: normalizedLevel,
    gapToTarget,
    candidateLimit,
    axisCandidateLimit,
    eoSequenceLimit,
    refineScale: preset.refineScale,
  };
}

function getFmcSweepRefineCount(requestedCount, availableCount, currentBestMoveCount, targetMoveCount, profileLevel) {
  const normalizedLevel = normalizeFmcSearchProfileLevel(profileLevel);
  const preset = FMC_SEARCH_PROFILE_PRESETS[normalizedLevel] || FMC_SEARCH_PROFILE_PRESETS.balanced;
  const gapToTarget = getFmcMoveCountGap(currentBestMoveCount, targetMoveCount);
  let factor = preset.refineScale;
  if (gapToTarget <= 1) {
    factor *= 0.45;
  } else if (gapToTarget <= 3) {
    factor *= 0.7;
  }
  const requested = Math.max(1, Math.floor(requestedCount));
  const available = Math.max(1, Math.floor(availableCount));
  return Math.min(available, Math.max(1, Math.round(requested * factor)));
}

/**
 * Per-solve session cache. Avoids redundant EO enumeration, DR solves, and
 * axis-conjugate pattern builds when the scout and sweep phases revisit the
 * same premove pattern on the same EO axis.
 */
class FmcSearchSessionCache {
  constructor() {
    this.eoSeqCache = new Map();      // patternKey → { seqs: string[][], searchLimit: number }
    this.drCache = new Map();         // patternKey → { result: drResult|null, depthSearched: number }
    this.axisPatternCache = new Map(); // algKey (string) → pattern
    this.hits = { eoSeq: 0, dr: 0, axisPattern: 0 };
    this.misses = { eoSeq: 0, dr: 0, axisPattern: 0 };
  }

  getEoSeqs(patternKey, neededLimit) {
    const entry = this.eoSeqCache.get(patternKey);
    if (!entry) { this.misses.eoSeq++; return null; }
    // Reuse if the cached search covered at least as many sequences as needed,
    // or if the result was exhaustive (fewer seqs than the search limit).
    if (entry.searchLimit >= neededLimit || entry.seqs.length < entry.searchLimit) {
      this.hits.eoSeq++;
      return entry.seqs;
    }
    this.misses.eoSeq++;
    return null;
  }

  setEoSeqs(patternKey, seqs, searchLimit) {
    const existing = this.eoSeqCache.get(patternKey);
    if (!existing || searchLimit > existing.searchLimit || seqs.length > existing.seqs.length) {
      this.eoSeqCache.set(patternKey, { seqs, searchLimit });
    }
  }

  getDrResult(patternKey, depthCap) {
    const entry = this.drCache.get(patternKey);
    if (!entry) { this.misses.dr++; return undefined; }
    if (entry.result !== null) {
      // A successful result is valid for any cap that would accept its length.
      if (entry.result.moves.length < depthCap) { this.hits.dr++; return entry.result; }
    } else {
      // A null result is valid only if we searched at least as deep as the current cap.
      if (entry.depthSearched >= depthCap) { this.hits.dr++; return null; }
    }
    this.misses.dr++;
    return undefined;
  }

  setDrResult(patternKey, result, depthCap) {
    const existing = this.drCache.get(patternKey);
    if (!existing || depthCap > existing.depthSearched ||
        (result !== null && existing.result === null)) {
      this.drCache.set(patternKey, { result, depthSearched: depthCap });
    }
  }

  getAxisPattern(algKey) {
    const p = this.axisPatternCache.get(algKey);
    if (p !== undefined) { this.hits.axisPattern++; return p; }
    this.misses.axisPattern++;
    return null;
  }

  setAxisPattern(algKey, pattern) {
    this.axisPatternCache.set(algKey, pattern);
  }

  summarize() {
    return {
      eoSeq: { hits: this.hits.eoSeq, misses: this.misses.eoSeq, entries: this.eoSeqCache.size },
      dr: { hits: this.hits.dr, misses: this.misses.dr, entries: this.drCache.size },
      axisPattern: { hits: this.hits.axisPattern, misses: this.misses.axisPattern, entries: this.axisPatternCache.size },
    };
  }
}

function buildPatternFrontier(rootPattern, depthLimit, direction = "forward") {
  const map = new Map();
  const rootKey = patternStateKey(rootPattern);
  map.set(rootKey, []);
  if (!Number.isFinite(depthLimit) || depthLimit <= 0) return map;

  const queue = [{ pattern: rootPattern, path: [], depth: 0, lastFace: "", lastFaceIdx: -1 }];
  let head = 0;

  while (head < queue.length) {
    const node = queue[head++];
    if (node.depth >= depthLimit) continue;

    const lastFaceIdx = node.lastFaceIdx;
    for (let i = 0; i < FMC_INSERTION_MOVE_NAMES.length; i += 1) {
      const move = FMC_INSERTION_MOVE_NAMES[i];
      const faceIdx = FMC_INSERTION_MOVE_FACE_IDX[i];
      // Skip same face
      if (faceIdx === lastFaceIdx) continue;
      // Canonical opposite-face pruning: skip F→B, R→L, U→D sequences
      // (only allow the "higher-index face first" ordering to prevent duplicate states)
      if (lastFaceIdx >= 0 && FRON_OPP_FACE[faceIdx] === lastFaceIdx && faceIdx < lastFaceIdx) continue;

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
        lastFace: move[0],
        lastFaceIdx: faceIdx,
      });
    }
  }

  return map;
}

function findShorterEquivalentSegment(startPattern, targetPattern, maxDepth, currentLength, cache = null) {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0 || currentLength <= 1) return null;
  const startKey = patternStateKey(startPattern);
  const targetKey = patternStateKey(targetPattern);
  if (!startKey || !targetKey) return null;
  const cacheKey = `${startKey}|${targetKey}|${Math.floor(maxDepth)}|${Math.floor(currentLength)}`;
  const effectiveCache = cache || moduleInsertionReplacementCache;
  if (effectiveCache.has(cacheKey)) {
    return effectiveCache.get(cacheKey);
  }
  if (startKey === targetKey) return [];

  const searchDepth = Math.max(1, Math.min(Math.floor(maxDepth), currentLength - 1));
  const forwardDepth = Math.floor(searchDepth / 2);
  const backwardDepth = searchDepth - forwardDepth;
  const forwardMap = buildPatternFrontier(startPattern, forwardDepth, "forward");
  const backwardMap = buildPatternFrontier(targetPattern, backwardDepth, "backward");

  let best = null;
  let bestText = "";

  for (const [key, leftPath] of forwardMap.entries()) {
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

  effectiveCache.set(cacheKey, best);
  if (effectiveCache === moduleInsertionReplacementCache) {
    _evictInsertionCache();
  }
  return best;
}

function buildPatternStates(scramblePattern, moves) {
  const states = new Array(moves.length + 1);
  states[0] = scramblePattern;
  for (let i = 0; i < moves.length; i += 1) {
    states[i + 1] = states[i].applyMove(moves[i]);
  }
  return states;
}

function buildRankedInsertionWindows(moves, minWindow, maxWindow) {
  const windows = [];
  const n = moves.length;
  const windowCap = Math.min(maxWindow, n);

  // Precompute per-move data for fast access in the inner loop
  const faceChar = new Array(n);
  const axisIdx = new Int8Array(n);
  const isHalfTurn = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = moves[i];
    faceChar[i] = typeof m === "string" && m.length ? m[0] : "";
    axisIdx[i] = getMoveAxis(m);
    isHalfTurn[i] = typeof m === "string" && m.includes("2") ? 1 : 0;
  }

  for (let window = windowCap; window >= minWindow; window -= 1) {
    for (let start = 0; start + window <= n; start += 1) {
      const end = start + window;
      let score = window * 8;

      const leftFace = start > 0 ? faceChar[start - 1] : "";
      const firstFace = faceChar[start];
      const lastFace = faceChar[end - 1];
      const rightFace = end < n ? faceChar[end] : "";
      const leftAxis = start > 0 ? axisIdx[start - 1] : -1;
      const firstAxis = axisIdx[start];
      const lastAxis = axisIdx[end - 1];
      const rightAxis = end < n ? axisIdx[end] : -1;

      // Immediate same-face cancellation at boundary — highest value
      if (leftFace && leftFace === firstFace) score += 16;
      if (rightFace && rightFace === lastFace) score += 16;
      // Same-axis boundary (adjacent moves on same axis commute, easier replacement)
      if (leftAxis >= 0 && leftAxis === firstAxis) score += 7;
      if (rightAxis >= 0 && rightAxis === lastAxis) score += 7;
      // Conjugate bracketing: window is inside a same-axis sandwich
      if (leftAxis >= 0 && rightAxis >= 0 && leftAxis === rightAxis) score += 9;
      // Commutator structure: window starts/ends on same axis (short windows only)
      if (firstAxis >= 0 && firstAxis === lastAxis && window <= 6) score += 5;

      // Interior half-turns are easier to replace via the bidirectional BFS
      let halfTurns = 0;
      for (let k = start; k < end; k++) halfTurns += isHalfTurn[k];
      score += halfTurns * 3;

      windows.push({ start, end, window, score });
    }
  }

  windows.sort((a, b) => b.score - a.score || b.window - a.window || a.start - b.start);
  return windows;
}

function optimizeSolutionWithInsertions(scramblePattern, moves, options = {}) {
  let current = simplifyMoves(Array.isArray(moves) ? moves : []);
  if (!current.length) return current;

  const maxPasses = Number.isFinite(options.maxPasses) ? Math.max(1, Math.floor(options.maxPasses)) : 4;
  const minWindow = Number.isFinite(options.minWindow) ? Math.max(2, Math.floor(options.minWindow)) : 3;
  // Increase max window for short solutions — they have more insertion headroom
  const defaultMaxWindow = current.length <= 22 ? 9 : 7;
  const maxWindow = Number.isFinite(options.maxWindow) ? Math.max(minWindow, Math.floor(options.maxWindow)) : defaultMaxWindow;
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(1, Math.floor(options.maxDepth)) : 6;
  const replacementCache = options.replacementCache || null;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;
    const states = buildPatternStates(scramblePattern, current);
    const rankedWindows = buildRankedInsertionWindows(current, minWindow, maxWindow);

    outer: for (let index = 0; index < rankedWindows.length; index += 1) {
      const { start, end, window } = rankedWindows[index];
      const depthCap = Math.min(maxDepth, window - 1);
      const replacement = findShorterEquivalentSegment(
        states[start],
        states[end],
        depthCap,
        window,
        replacementCache,
      );
      if (!replacement) continue;
      const next = simplifyMoves(current.slice(0, start).concat(replacement, current.slice(end)));
      if (next.length >= current.length) continue;
      current = next;
      improved = true;
      break outer;
    }

    if (!improved) break;
  }

  return current;
}

/**
 * Tries to improve a solution by replacing small windows of moves with shorter equivalents.
 */
async function getSolvedPattern() {
  if (!solvedPatternPromise) {
    solvedPatternPromise = getDefaultPattern("333");
  }
  return solvedPatternPromise;
}

function normalizeCandidateMoves(moves) {
  return simplifyMoves(Array.isArray(moves) ? moves : []);
}

function createCandidate(source, strategy, moves) {
  const normalized = normalizeCandidateMoves(moves);
  if (!normalized.length) return null;
  const metadata = strategy && typeof strategy === "object" ? strategy : { tag: strategy };
  const structureMetrics = computeFmcStructureMetrics(normalized);
  return {
    source,
    strategy: metadata.tag || "",
    usesCfop: !!metadata.usesCfop,
    innerSource: metadata.innerSource || "",
    axisName: metadata.axisName || "",
    eoLength: Number.isFinite(metadata.eoLength) ? metadata.eoLength : null,
    drLength: Number.isFinite(metadata.drLength) ? metadata.drLength : null,
    p2Length: Number.isFinite(metadata.p2Length) ? metadata.p2Length : null,
    eoMoves: Array.isArray(metadata.eoMoves) ? metadata.eoMoves : null,
    drMoves: Array.isArray(metadata.drMoves) ? metadata.drMoves : null,
    finishMoves: Array.isArray(metadata.finishMoves) ? metadata.finishMoves : null,
    premoveMoves: Array.isArray(metadata.premoveMoves) ? metadata.premoveMoves : null,
    skeletonMoves: Array.isArray(metadata.skeletonMoves) ? metadata.skeletonMoves : null,
    insertionBaseMoves: Array.isArray(metadata.insertionBaseMoves) ? metadata.insertionBaseMoves : null,
    moves: normalized,
    solution: joinMoves(normalized),
    moveCount: normalized.length,
    ...structureMetrics,
  };
}

async function verifyCandidate(scramblePattern, candidate, options = {}) {
  if (!candidate || !candidate.solution) return false;
  const cache = options.cache || null;
  if (cache && cache.has(candidate.solution)) {
    return cache.get(candidate.solution);
  }
  let verified = false;
  try {
    // Fast WASM path (no cubing.js overhead)
    const scramble = options.scrambleString || null;
    if (scramble) {
      const wasmResult = await verifyFmcSolutionWasm(scramble, candidate.solution);
      if (wasmResult && wasmResult.ok) {
        verified = !!wasmResult.solved;
        if (cache) cache.set(candidate.solution, verified);
        return verified;
      }
    }
    // Fallback: cubing.js
    const solvedPattern = options.solvedPattern || await getSolvedPattern();
    const afterSolution = scramblePattern.applyAlg(candidate.solution);
    verified = typeof afterSolution.experimentalIsSolved === "function"
      ? !!afterSolution.experimentalIsSolved({ ignorePuzzleOrientation: false })
      : JSON.stringify(afterSolution.patternData) === JSON.stringify(solvedPattern.patternData);
  } catch (_) {
    verified = false;
  }
  if (cache) cache.set(candidate.solution, verified);
  return verified;
}

function pushUniqueCandidate(list, candidate) {
  pushRankedUniqueCandidate(list, candidate);
}

function incrementCounter(counterMap, key, delta = 1) {
  const normalizedKey = String(key || "UNKNOWN");
  counterMap[normalizedKey] = (counterMap[normalizedKey] || 0) + delta;
}

function buildMoveCountDistribution(candidates) {
  const distribution = {};
  const list = Array.isArray(candidates) ? candidates : [];
  for (let i = 0; i < list.length; i += 1) {
    const moveCount = Number.isFinite(list[i]?.moveCount) ? list[i].moveCount : null;
    if (moveCount === null) continue;
    incrementCounter(distribution, moveCount, 1);
  }
  return distribution;
}

function snapshotTopCandidates(candidates, limit = 5) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  return candidates.slice(0, limit).map((candidate) => ({
    source: candidate.source || "",
    strategy: candidate.strategy || "",
    moveCount: Number.isFinite(candidate.moveCount) ? candidate.moveCount : null,
    innerSource: candidate.innerSource || "",
    usesCfop: candidate.usesCfop === true,
  }));
}

/**
 * EO-first step: given a pattern already in UD-axis domino frame orientation,
 * find short EO sequences, then run DR (domino reduction), then Phase 2 finish.
 * Returns the best (shortest) solution found, or null.
 */
async function solveFmcEOFirst(pattern, options = {}) {
  try {
    const {
      deadlineTs,
      maxDRDepth = 14,
      maxP2Depth = 18,
      candidateLimit = 3,
      eoSequenceLimit,
      currentBestMoveCount = Infinity,
      targetMoveCount = Infinity,
      axisName = "UD",
      sessionCache = null,
    } = options;

    const coords = parsePatternToCoords3x3(pattern);
    if (!coords) return null;

    const effectiveEoSequenceLimit = Number.isFinite(eoSequenceLimit)
      ? Math.max(1, Math.floor(eoSequenceLimit))
      : Number.isFinite(currentBestMoveCount) && currentBestMoveCount <= targetMoveCount + 2
        ? 4
        : 6;

    // Fetch slightly more EO sequences than immediately needed so that a follow-up
    // refine pass (which uses a higher limit) gets a cache hit instead of re-running
    // the EO DFS. The cost of finding one or two extra solutions is marginal since
    // findShortEOSequences stops as soon as it reaches the fetch limit.
    const EO_CACHE_PREFETCH_LIMIT = 4;
    const eoFetchLimit = sessionCache
      ? Math.max(effectiveEoSequenceLimit, EO_CACHE_PREFETCH_LIMIT)
      : effectiveEoSequenceLimit;

    const patternKey = sessionCache ? patternStateKey(pattern) : null;
    let eoSeqs = patternKey ? sessionCache.getEoSeqs(patternKey, effectiveEoSequenceLimit) : null;
    if (!eoSeqs) {
      const fetchedSeqs = await findShortEOSequences(coords, 8, eoFetchLimit).catch(() => []);
      if (patternKey && fetchedSeqs.length) {
        sessionCache.setEoSeqs(patternKey, fetchedSeqs, eoFetchLimit);
      }
      eoSeqs = effectiveEoSequenceLimit < fetchedSeqs.length
        ? fetchedSeqs.slice(0, effectiveEoSequenceLimit)
        : fetchedSeqs;
    }
    if (!eoSeqs.length) return null;

    const ranked = [];
    let bestMoveCount = Number.isFinite(currentBestMoveCount) ? currentBestMoveCount : Infinity;

    for (const eoMoves of eoSeqs) {
      if (remainingMs(deadlineTs) <= 150) break;
      if (eoMoves.length >= bestMoveCount) continue;

      const patternAfterEO = eoMoves.length ? applyMovesToPattern(pattern, eoMoves) : pattern;
      const coordsAfterEO = parsePatternToCoords3x3(patternAfterEO);
      if (!coordsAfterEO) continue;

      const drDepthCap = Number.isFinite(bestMoveCount)
        ? Math.min(maxDRDepth, Math.max(1, bestMoveCount - eoMoves.length))
        : maxDRDepth;

      const drPatternKey = sessionCache ? patternStateKey(patternAfterEO) : null;
      const cachedDr = drPatternKey !== null ? sessionCache.getDrResult(drPatternKey, drDepthCap) : undefined;
      let drResult;
      if (cachedDr !== undefined) {
        drResult = cachedDr;
      } else {
        drResult = await solveDomino(coordsAfterEO, {
          maxDepth: drDepthCap,
          nodeLimit: Number.isFinite(bestMoveCount) && bestMoveCount <= targetMoveCount + 2 ? 2000000 : 4000000,
          deadlineTs: clampAttemptDeadline(deadlineTs, 5000, 150),
        }).catch(() => null);
        if (drPatternKey !== null) {
          sessionCache.setDrResult(drPatternKey, drResult?.ok ? drResult : null, drDepthCap);
        }
      }
      if (!drResult?.ok) continue;

      const partialLength = eoMoves.length + drResult.moves.length;
      if (partialLength >= bestMoveCount) continue;

      const patternAfterDR = drResult.moves.length
        ? applyMovesToPattern(patternAfterEO, drResult.moves)
        : patternAfterEO;
      const p2DepthCap = Number.isFinite(bestMoveCount)
        ? Math.min(maxP2Depth, Math.max(1, bestMoveCount - partialLength))
        : maxP2Depth;
      const p2Input = buildPhase2Input(patternAfterDR, {
        phase2MaxDepth: p2DepthCap,
        phase2NodeLimit: Number.isFinite(bestMoveCount) && bestMoveCount <= targetMoveCount + 2 ? 1000000 : 2000000,
        deadlineTs: clampAttemptDeadline(deadlineTs, 3000, 100),
      });
      const p2Result = await solvePhase2(p2Input).catch(() => null);
      if (!p2Result?.ok) continue;

      const allMoves = [...eoMoves, ...drResult.moves, ...p2Result.moves];
      const simplified = simplifyMoves(allMoves);
      if (!simplified.length) continue;

      const rankedCandidate = {
        ok: true,
        source: "EO_DR_P2",
        axisName,
        eoLength: eoMoves.length,
        drLength: drResult.moves.length,
        p2Length: p2Result.moves.length,
        eoMoves: eoMoves.slice(),
        drMoves: drResult.moves.slice(),
        finishMoves: p2Result.moves.slice(),
        moves: simplified,
        solution: joinMoves(simplified),
        moveCount: simplified.length,
        ...computeFmcStructureMetrics(simplified),
      };
      pushRankedUniqueCandidate(ranked, rankedCandidate, candidateLimit);
      if (ranked.length) {
        bestMoveCount = Math.min(bestMoveCount, ranked[0].moveCount);
      }
      if (ranked.length && ranked[0].moveCount <= targetMoveCount) {
        break;
      }
    }

    if (!ranked.length) return null;
    const best = ranked[0];
    return {
      ok: true,
      source: best.source,
      axisName: best.axisName,
      solution: best.solution,
      moves: best.moves,
      moveCount: best.moveCount,
      candidates: ranked,
    };
  } catch (_) {
    return null;
  }
}

/**
 * FMC solve: tries EO-first on all 3 EO axes (UD, FB, RL) via scramble conjugation.
 * Generic full-cube phase fallback is intentionally disabled so callers can observe
 * native FMC misses directly.
 * @param {string|null} scrambleText
 * @param {{startPattern?, premoveMoves?, deadlineTs?, maxDrDepth?, maxP2Depth?}} options
 */
async function solveFmcEO(scrambleText, options = {}) {
  try {
    const requestedDeadlineTs = options.deadlineTs;
    const attemptTimeBudgetMs = normalizeFmcAttemptBudgetMs(options.attemptTimeBudgetMs, 0);
    const deadlineTs = attemptTimeBudgetMs > 0
      ? clampAttemptDeadline(requestedDeadlineTs, attemptTimeBudgetMs, 150)
      : requestedDeadlineTs;
    if (remainingMs(deadlineTs) <= 250) return null;

    const maxDrDepth = options.maxDrDepth ?? 14;
    const maxP2Depth = options.maxP2Depth ?? 18;
    const premoveMoves = options.premoveMoves || [];
    const startPattern = options.startPattern || null;
    const sessionCache = options.sessionCache || null;
    const targetMoveCount = Number.isFinite(options.targetMoveCount) ? options.targetMoveCount : Infinity;
    const currentBestMoveCount = Number.isFinite(options.currentBestMoveCount)
      ? options.currentBestMoveCount
      : Infinity;
    const broadenSearch = !Number.isFinite(currentBestMoveCount) || currentBestMoveCount > targetMoveCount + 1;
    const axisCandidateLimit = Number.isFinite(options.axisCandidateLimit)
      ? Math.max(1, Math.floor(options.axisCandidateLimit))
      : broadenSearch
        ? 2
        : 1;
    const candidateLimit = Number.isFinite(options.candidateLimit)
      ? Math.max(axisCandidateLimit, Math.floor(options.candidateLimit))
      : broadenSearch
        ? 6
        : 3;
    const eoSequenceLimit = Number.isFinite(options.eoSequenceLimit)
      ? Math.max(1, Math.floor(options.eoSequenceLimit))
      : broadenSearch
        ? 6
        : 4;

    const solvedPattern = await getSolvedPattern();
    if (remainingMs(deadlineTs) <= 250) return null;

    const scrambleMoves = splitMoves(scrambleText || "");
    const hasScrambleText = scrambleMoves.length > 0;
    const effectiveMoves = hasScrambleText ? [...scrambleMoves, ...premoveMoves] : [];

    // Try EO-first on each EO axis. FB/RL axes require converting moves to that axis's frame.
    const rankedCandidates = [];
    const axisConfigs = hasScrambleText ? EO_AXIS_CONFIGS : [EO_AXIS_CONFIGS[0]];
    // Each axis gets the same time slice; running all in parallel via Promise.all lets them
    // interleave at async IDA* yield points, cutting total wall-clock to ~max(axis times).
    const axisTimeBudget = Math.max(280, Math.floor(remainingMs(deadlineTs) - 450));
    if (remainingMs(deadlineTs) <= 400) return null;

    // Build axis patterns upfront (synchronous, cached via sessionCache)
    const axisEntries = axisConfigs.map((axisConfig) => {
      let patternForAxis;
      if (axisConfig.identity) {
        patternForAxis = startPattern || solvedPattern.applyAlg(joinMoves(effectiveMoves));
      } else {
        const rotatedMoves = conjugateMoves(effectiveMoves, axisConfig.scramble_map);
        const algKey = joinMoves(rotatedMoves);
        patternForAxis = sessionCache ? sessionCache.getAxisPattern(algKey) : null;
        if (!patternForAxis) {
          patternForAxis = solvedPattern.applyAlg(algKey);
          if (sessionCache) sessionCache.setAxisPattern(algKey, patternForAxis);
        }
      }
      return { axisConfig, patternForAxis };
    });

    // Launch all axis searches simultaneously — they interleave at each internal await
    const axisDeadline = clampAttemptDeadline(deadlineTs, axisTimeBudget, 200);
    const axisResultsRaw = await Promise.all(
      axisEntries.map(({ axisConfig, patternForAxis }) =>
        solveFmcEOFirst(patternForAxis, {
          deadlineTs: axisDeadline,
          maxDRDepth: maxDrDepth,
          maxP2Depth: maxP2Depth,
          candidateLimit: axisCandidateLimit,
          eoSequenceLimit,
          currentBestMoveCount,
          targetMoveCount,
          axisName: axisConfig.name,
          sessionCache,
        }).catch(() => null),
      ),
    );

    // Merge all axis results into ranked candidates
    let bestResult = null;
    for (let ax = 0; ax < axisEntries.length; ax += 1) {
      const result = axisResultsRaw[ax];
      const { axisConfig } = axisEntries[ax];
      if (!result?.ok) continue;

      const axisItems = Array.isArray(result.candidates) && result.candidates.length ? result.candidates : [result];
      for (let i = 0; i < axisItems.length; i += 1) {
        const axisItem = axisItems[i];
        const solutionMoves = Array.isArray(axisItem.moves) ? axisItem.moves : splitMoves(axisItem.solution);
        const originalMoves = axisConfig.identity
          ? solutionMoves
          : conjugateMoves(solutionMoves, axisConfig.solution_map);
        const simplified = simplifyMoves(originalMoves);
        if (!simplified.length) continue;
        // Convert segment moves through axis frame
        const convertedEoMoves = Array.isArray(axisItem.eoMoves)
          ? (axisConfig.identity ? axisItem.eoMoves : conjugateMoves(axisItem.eoMoves, axisConfig.solution_map))
          : null;
        const convertedDrMoves = Array.isArray(axisItem.drMoves)
          ? (axisConfig.identity ? axisItem.drMoves : conjugateMoves(axisItem.drMoves, axisConfig.solution_map))
          : null;
        const convertedTriggerMoves = Array.isArray(axisItem.triggerMoves)
          ? (axisConfig.identity ? axisItem.triggerMoves : conjugateMoves(axisItem.triggerMoves, axisConfig.solution_map))
          : null;
        const convertedFinishMoves = Array.isArray(axisItem.finishMoves)
          ? (axisConfig.identity ? axisItem.finishMoves : conjugateMoves(axisItem.finishMoves, axisConfig.solution_map))
          : null;
        const converted = {
          ok: true,
          source: `FMC_EO_${axisConfig.name}`,
          innerSource: axisItem.source || "EO_DR_P2",
          axisName: axisConfig.name,
          eoLength: axisItem.eoLength,
          drLength: axisItem.drLength,
          p2Length: axisItem.p2Length,
          eoMoves: convertedEoMoves,
          drMoves: convertedDrMoves,
          triggerMoves: convertedTriggerMoves,
          finishMoves: convertedFinishMoves,
          moves: simplified,
          solution: joinMoves(simplified),
          moveCount: simplified.length,
          ...computeFmcStructureMetrics(simplified),
        };
        pushRankedUniqueCandidate(rankedCandidates, converted, candidateLimit);
        if (!bestResult || compareFmcCandidatePriority(converted, bestResult) < 0) {
          bestResult = converted;
        }
      }
    }

    if (bestResult) {
      return {
        ...bestResult,
        candidates: rankedCandidates,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function buildFmcParts(candidate) {
  if (!candidate) return [];
  const parts = [];
  const hasPremove = Array.isArray(candidate.premoveMoves) && candidate.premoveMoves.length > 0;
  const hasEo = Array.isArray(candidate.eoMoves) && candidate.eoMoves.length > 0;
  const hasDr = Array.isArray(candidate.drMoves) && candidate.drMoves.length > 0;
  const hasFinish = Array.isArray(candidate.finishMoves) && candidate.finishMoves.length > 0;
  const hasSegments = hasEo || hasDr || hasFinish;
  const isInsertion = candidate.source === "FMC_INSERTION";
  const hasInsertionBase = Array.isArray(candidate.insertionBaseMoves) && candidate.insertionBaseMoves.length > 0;
  // NISS candidates store segments as inv(EO_inv), inv(DR_inv), inv(Finish_inv).
  // Their execution order on the original scramble is: finishMoves → drMoves → eoMoves [→ postmove if any].
  // FMC_PREMOVE_NISS: NISS solve from premove sweep; premoveMoves is a post-move applied at the end.
  // FMC_INSERTION derived from a NISS base: strategy tag encodes the base source.
  const isNiss =
    candidate.source === "FMC_NISS" ||
    candidate.source === "FMC_PREMOVE_SCOUT_NISS" ||
    candidate.source === "FMC_PREMOVE_NISS" ||
    /^FMC_(PREMOVE_)?NISS(_|$)/.test(candidate.source || "") ||
    (candidate.source === "FMC_INSERTION" && /FMC_(PREMOVE_)?NISS/.test(candidate.strategy || ""));

  const sourceNote = candidate.source
    ? candidate.source.replace(/^FMC_/, "").replace(/_/g, " ")
    : "";
  const axisNote = candidate.axisName ? `axis ${candidate.axisName}` : "";
  const nissNote = isNiss ? "NISS" : "";
  const rzpNote = candidate.rzpUsed ? "RZP" : "";

  // For non-NISS: premove comes BEFORE EO/DR/Finish in execution order.
  // For NISS: premoveMoves is a post-move; it is appended AFTER EO/DR/Finish (see below).
  if (hasPremove && !isNiss) {
    const sol = joinMoves(candidate.premoveMoves);
    parts.push({
      name: "Premove",
      solution: sol,
      moveCount: candidate.premoveMoves.length,
      notes: "",
    });
  }

  if (isNiss) {
    // For NISS, execution order on original scramble is: Finish → DR → EO
    // (stored moves are already the inverted segments from the inverse solve)
    if (hasFinish) {
      parts.push({
        name: "Finish",
        solution: joinMoves(candidate.finishMoves),
        moveCount: candidate.finishMoves.length,
        notes: [nissNote, axisNote].filter(Boolean).join(", "),
      });
    } else if (hasSegments && Number.isFinite(candidate.p2Length) && candidate.p2Length > 0) {
      parts.push({
        name: "Finish",
        solution: "",
        moveCount: candidate.p2Length,
        notes: [`${candidate.p2Length}수`, nissNote, axisNote].filter(Boolean).join(", "),
      });
    }
    if (hasDr) {
      parts.push({
        name: "DR",
        solution: joinMoves(candidate.drMoves),
        moveCount: candidate.drMoves.length,
        notes: [nissNote, rzpNote].filter(Boolean).join(", "),
      });
    } else if (hasSegments && Number.isFinite(candidate.drLength) && candidate.drLength > 0) {
      parts.push({
        name: "DR",
        solution: "",
        moveCount: candidate.drLength,
        notes: [`${candidate.drLength}수`, nissNote, rzpNote].filter(Boolean).join(", "),
      });
    }
    if (hasEo) {
      parts.push({
        name: "EO",
        solution: joinMoves(candidate.eoMoves),
        moveCount: candidate.eoMoves.length,
        notes: nissNote,
      });
    } else if (hasSegments && Number.isFinite(candidate.eoLength) && candidate.eoLength > 0) {
      parts.push({
        name: "EO",
        solution: "",
        moveCount: candidate.eoLength,
        notes: [`${candidate.eoLength}수`, nissNote].filter(Boolean).join(", "),
      });
    }
    // For NISS with premove: the premove is a post-move applied AFTER Finish → DR → EO.
    if (hasPremove) {
      parts.push({
        name: "Postmove",
        solution: joinMoves(candidate.premoveMoves),
        moveCount: candidate.premoveMoves.length,
        notes: nissNote,
      });
    }
  } else {
    if (hasEo) {
      parts.push({
        name: "EO",
        solution: joinMoves(candidate.eoMoves),
        moveCount: candidate.eoMoves.length,
        notes: axisNote,
      });
    } else if (hasSegments && Number.isFinite(candidate.eoLength) && candidate.eoLength > 0) {
      parts.push({
        name: "EO",
        solution: "",
        moveCount: candidate.eoLength,
        notes: `${candidate.eoLength}수` + (axisNote ? `, ${axisNote}` : ""),
      });
    }
    if (hasDr) {
      parts.push({
        name: "DR",
        solution: joinMoves(candidate.drMoves),
        moveCount: candidate.drMoves.length,
        notes: "",
      });
    } else if (hasSegments && Number.isFinite(candidate.drLength) && candidate.drLength > 0) {
      parts.push({
        name: "DR",
        solution: "",
        moveCount: candidate.drLength,
        notes: `${candidate.drLength}수`,
      });
    }
    if (hasFinish) {
      parts.push({
        name: "Finish",
        solution: joinMoves(candidate.finishMoves),
        moveCount: candidate.finishMoves.length,
        notes: "",
      });
    } else if (hasSegments && Number.isFinite(candidate.p2Length) && candidate.p2Length > 0) {
      parts.push({
        name: "Finish",
        solution: "",
        moveCount: candidate.p2Length,
        notes: `${candidate.p2Length}수`,
      });
    }
  }

  // Insertion info (only show when insertion actually happened)
  if (isInsertion && hasInsertionBase) {
    const baseMoveCount = candidate.insertionBaseMoves.length;
    const finalMoveCount = candidate.moveCount;
    parts.push({
      name: "Insertion",
      solution: "",
      moveCount: 0,
      notes: baseMoveCount !== finalMoveCount
        ? `${baseMoveCount} → ${finalMoveCount}`
        : "no improvement",
      isSummary: true,
    });
  }

  // Final
  parts.push({
    name: "Final",
    solution: candidate.solution,
    moveCount: candidate.moveCount,
    notes: [sourceNote, axisNote].filter(Boolean).join(", "),
  });

  return parts;
}

export async function solveWithFMCSearch(scramble, onProgress, options = {}) {
  const maxPremoveSets = Number.isFinite(options.maxPremoveSets)
    ? Math.max(0, Math.floor(options.maxPremoveSets))
    : 4;
  const forceRzp = options.forceRzp === true;
  const timeBudgetMs = Number.isFinite(options.timeBudgetMs)
    ? Math.max(1000, Math.floor(options.timeBudgetMs))
    : 30000;
  const targetMoveCount = Number.isFinite(options.targetMoveCount)
    ? Math.max(1, Math.floor(options.targetMoveCount))
    : 20;
  const sweepBudgetMs = Number.isFinite(options.sweepBudgetMs)
    ? Math.max(500, Math.floor(options.sweepBudgetMs))
    : Math.max(1500, Math.min(8000, Math.floor(timeBudgetMs * 0.35)));
  const sweepIncludeInverse = options.sweepIncludeInverse !== false;
  const startedAt = Date.now();
  const deadlineTs = startedAt + timeBudgetMs;
  const sweepDeadlineTs = startedAt + sweepBudgetMs;
  const directStageBudgetMs = Number.isFinite(options.directStageBudgetMs)
    ? Math.max(800, Math.floor(options.directStageBudgetMs))
    : Math.max(1200, Math.min(8000, Math.floor(timeBudgetMs * 0.42)));
  const nissStageBudgetMs = Number.isFinite(options.nissStageBudgetMs)
    ? Math.max(800, Math.floor(options.nissStageBudgetMs))
    : Math.max(1200, Math.min(8000, Math.floor(timeBudgetMs * 0.42)));
  const sweepAttemptBudgetMs = Number.isFinite(options.sweepAttemptBudgetMs)
    ? Math.max(500, Math.floor(options.sweepAttemptBudgetMs))
    : Math.max(700, Math.min(1800, Math.floor(sweepBudgetMs * 0.35)));
  const sweepUseScout = options.sweepUseScout !== false;
  const sweepScoutAttemptBudgetMs = Number.isFinite(options.sweepScoutAttemptBudgetMs)
    ? Math.max(300, Math.floor(options.sweepScoutAttemptBudgetMs))
    : Math.max(350, Math.min(900, Math.floor(sweepAttemptBudgetMs * 0.55)));
  const sweepScoutIncludeInverse = options.sweepScoutIncludeInverse !== false;
  const sweepLimit = Math.min(maxPremoveSets, FMC_PREMOVE_SETS.length);
  const sweepRefineSets = Number.isFinite(options.sweepRefineSets)
    ? Math.max(1, Math.floor(options.sweepRefineSets))
    : Math.max(6, Math.floor(sweepLimit * 0.45));
  const enableInsertions = options.enableInsertions !== false;
  const insertionCandidateLimit = Number.isFinite(options.insertionCandidateLimit)
    ? Math.max(1, Math.floor(options.insertionCandidateLimit))
    : 3;
  const insertionMaxPasses = Number.isFinite(options.insertionMaxPasses)
    ? Math.max(1, Math.floor(options.insertionMaxPasses))
    : 3;
  const insertionMinWindow = Number.isFinite(options.insertionMinWindow)
    ? Math.max(2, Math.floor(options.insertionMinWindow))
    : 3;
  const insertionMaxWindow = Number.isFinite(options.insertionMaxWindow)
    ? Math.max(insertionMinWindow, Math.floor(options.insertionMaxWindow))
    : 7;
  const insertionMaxDepth = Number.isFinite(options.insertionMaxDepth)
    ? Math.max(1, Math.floor(options.insertionMaxDepth))
    : 6;
  const insertionTimeMs = Number.isFinite(options.insertionTimeMs)
    ? Math.max(600, Math.floor(options.insertionTimeMs))
    : Math.max(1200, Math.min(16000, Math.floor(timeBudgetMs * 0.22)));
  const insertionThreshold = Number.isFinite(options.insertionThreshold)
    ? Math.max(1, Math.floor(options.insertionThreshold))
    : Math.max(targetMoveCount + 2, 22);
  const directProfileLevel = normalizeFmcSearchProfileLevel(options.directProfileLevel, "balanced");
  const sweepProfileLevel = normalizeFmcSearchProfileLevel(options.sweepProfileLevel, "balanced");
  const sweepScoutProfileLevel = normalizeFmcSearchProfileLevel(options.sweepScoutProfileLevel, "light");
  const directPhaseAttemptTimeoutMs = normalizeFmcAttemptBudgetMs(options.directPhaseAttemptTimeoutMs, 0);
  const nissPhaseAttemptTimeoutMs = normalizeFmcAttemptBudgetMs(
    options.nissPhaseAttemptTimeoutMs,
    directPhaseAttemptTimeoutMs,
  );
  const sweepPhaseAttemptTimeoutMs = normalizeFmcAttemptBudgetMs(options.sweepPhaseAttemptTimeoutMs, 0);
  const sweepScoutPhaseAttemptTimeoutMs = normalizeFmcAttemptBudgetMs(
    options.sweepScoutPhaseAttemptTimeoutMs,
    0,
  );
  const inverseScramble = invertAlg(scramble);
  const reverseScrambleCanonical = canonicalizeAlg(inverseScramble);
  const candidates = [];
  const verificationCache = new Map();
  const directPremovePatternCache = new Map();
  const inversePremovePatternCache = new Map();
  const fmcSessionCache = new FmcSearchSessionCache();
  let attempts = 0;
  const hasSweep = maxPremoveSets > 0;
  const totalStages = hasSweep ? 3 : 2;
  let bestMoveCount = Infinity;
  const diagnostics = {
    solver: "fmc",
    totalBudgetMs: timeBudgetMs,
    sweepBudgetMs,
    searchProfiles: {
      direct: directProfileLevel,
      sweep: sweepProfileLevel,
      scout: sweepScoutProfileLevel,
    },
    phaseTimingsMs: {
      direct: 0,
      niss: 0,
      premoveSweep: 0,
      scout: 0,
      insertion: 0,
      verification: 0,
    },
    phaseRuns: {
      direct: { calls: 0, successes: 0, bestMoveCount: null, bestSource: null },
      niss: { calls: 0, successes: 0, bestMoveCount: null, bestSource: null },
      premoveSweep: { calls: 0, successes: 0, bestMoveCount: null, bestSource: null },
      scout: { calls: 0, successes: 0, bestMoveCount: null, bestSource: null },
      insertion: { calls: 0, successes: 0, bestMoveCount: null },
    },
    candidateCounts: {
      beforeVerification: 0,
      verified: 0,
      reverseAware: 0,
      ranked: 0,
      preferredNonCfop: 0,
    },
    sourceCounts: {
      generated: {},
      verified: {},
      reverseAware: {},
      ranked: {},
    },
    moveCountDistribution: {
      generated: {},
      verified: {},
      reverseAware: {},
      ranked: {},
    },
    topCandidates: {
      generated: [],
      verified: [],
      reverseAware: [],
      ranked: [],
    },
  };
  const finalizeDiagnostics = () => ({
    ...diagnostics,
    sessionCacheStats: fmcSessionCache.summarize(),
    insertionCacheSize: moduleInsertionReplacementCache.size,
    totalElapsedMs: Math.max(1, Date.now() - startedAt),
  });

  const getPremovePattern = (basePattern, premove, cache) => {
    const cacheKey = joinMoves(premove);
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    const pattern = applyMovesToPattern(basePattern, premove);
    cache.set(cacheKey, pattern);
    return pattern;
  };

  const extractPortfolioCandidates = (result) => {
    if (Array.isArray(result?.candidates) && result.candidates.length) {
      return result.candidates;
    }
    if (result?.solution) {
      return [result];
    }
    return [];
  };

  const notify = (progress) => {
    if (typeof onProgress !== "function") return;
    try {
      void onProgress(progress);
    } catch (_) {
      // Progress callbacks are best-effort.
    }
  };

  const recordPhaseCall = (phaseKey, result, elapsedMs) => {
    const phase = diagnostics.phaseRuns[phaseKey];
    if (!phase) return;
    diagnostics.phaseTimingsMs[phaseKey] += Math.max(0, elapsedMs);
    phase.calls += 1;
    if (!result?.ok) return;
    phase.successes += 1;
    if (!Number.isFinite(phase.bestMoveCount) || result.moveCount < phase.bestMoveCount) {
      phase.bestMoveCount = Number.isFinite(result.moveCount) ? result.moveCount : phase.bestMoveCount;
      phase.bestSource = result.source || null;
    }
  };

  const trackCandidate = (candidate) => {
    if (!candidate) return;
    pushRankedUniqueCandidate(candidates, candidate);
    if (candidate.moveCount < bestMoveCount) {
      bestMoveCount = candidate.moveCount;
    }
  };
  const currentTargetMoveCount = () =>
    Number.isFinite(bestMoveCount) ? Math.max(targetMoveCount, bestMoveCount - 1) : targetMoveCount;
  const trackResultCandidates = (source, result, buildStrategy, transformMoves = (moves) => moves) => {
    const created = [];
    const portfolioCandidates = extractPortfolioCandidates(result);
    for (let i = 0; i < portfolioCandidates.length; i += 1) {
      const item = portfolioCandidates[i];
      const itemMoves = Array.isArray(item.moves) ? item.moves : splitMoves(item.solution);
      const candidate = createCandidate(source, buildStrategy(item), transformMoves(itemMoves));
      if (!candidate) continue;
      trackCandidate(candidate);
      created.push(candidate);
    }
    return created;
  };

  // === WASM FMC fast path: run entire EO→DR→P2 pipeline (3 axes, NISS, premove sweep) in WASM ===
  // Run this FIRST — if it succeeds, skip twophase seed and JS fallback entirely.
  let wasmFmcDone = false;
  try {
    const wasmFmcStartedAt = Date.now();
    const fmcTablesOk = await buildFmcTablesWasm();
    console.warn(`[FMC WASM] buildFmcTablesWasm: ok=${fmcTablesOk}, elapsed=${Date.now() - wasmFmcStartedAt}ms`);
    if (fmcTablesOk) {
      const solveStartedAt = Date.now();
      const wasmResult = await solveFmcWasm(scramble, {
        maxPremoveSets: maxPremoveSets > 0 ? Math.min(maxPremoveSets * 20, 180) : 0,
        forceRzp,
      });
      console.warn(`[FMC WASM] solveFmcWasm: ok=${wasmResult?.ok}, moveCount=${wasmResult?.moveCount}, elapsed=${Date.now() - solveStartedAt}ms`);
      if (wasmResult && wasmResult.ok && Array.isArray(wasmResult.candidates)) {
        for (const wc of wasmResult.candidates) {
          if (!wc.ok || !wc.solution) continue;
          const wcMoves = typeof wc.solution === "string" ? wc.solution.split(/\s+/).filter(Boolean) : wc.moves;
          // NISS candidates store raw segments from the inverse solve; invert them to match JS convention
          const wcIsNiss = /^FMC_(PREMOVE_)?NISS(_|$)/.test(wc.source || "");
          const maybeInvert = (arr) => (wcIsNiss && Array.isArray(arr) && arr.length ? invertMoves(arr) : (Array.isArray(arr) && arr.length ? arr : null));
          const candidate = createCandidate(wc.source || "FMC_WASM", {
            tag: wc.source || "wasm",
            axisName: wc.axisName || "",
            eoLength: wc.eoLength,
            drLength: wc.drLength,
            p2Length: wc.p2Length,
            eoMoves: maybeInvert(wc.eoMoves),
            drMoves: maybeInvert(wc.drMoves),
            finishMoves: maybeInvert(wc.finishMoves),
            premoveMoves: wc.premoves ? wc.premoves.split(/\s+/).filter(Boolean) : null,
          }, wcMoves);
          if (candidate) trackCandidate(candidate);
        }
        wasmFmcDone = true;
        const wasmElapsedMs = Date.now() - wasmFmcStartedAt;
        diagnostics.phaseTimingsMs.direct += wasmElapsedMs;
        diagnostics.phaseRuns.direct.calls += 1;
        if (wasmResult.moveCount) {
          diagnostics.phaseRuns.direct.successes += 1;
          diagnostics.phaseRuns.direct.bestMoveCount = wasmResult.moveCount;
          diagnostics.phaseRuns.direct.bestSource = "WASM_FMC";
        }
      }
    }
  } catch (err) {
    console.warn("[FMC WASM] Exception:", err);
  }

  if (!wasmFmcDone) {
    return {
      ok: false,
      reason: "FMC_WASM_NOT_READY",
      attempts,
      performanceDiagnostics: finalizeDiagnostics(),
    };
  }

  candidates.sort(compareFmcCandidatePriority);
  diagnostics.candidateCounts.beforeVerification = candidates.length;
  diagnostics.moveCountDistribution.generated = buildMoveCountDistribution(candidates);
  diagnostics.topCandidates.generated = snapshotTopCandidates(candidates);
  for (let i = 0; i < candidates.length; i += 1) {
    incrementCounter(diagnostics.sourceCounts.generated, candidates[i]?.source || "UNKNOWN");
  }

  const validCandidates = [];
  const requestedVerifyLimit = Number.isFinite(options.verifyLimit)
    ? Math.max(8, Math.floor(options.verifyLimit))
    : 24;
  const verifyLimit = Math.min(candidates.length, requestedVerifyLimit);
  const verificationStartedAt = Date.now();
  for (let i = 0; i < verifyLimit; i += 1) {
    const candidate = candidates[i];
    if (await verifyCandidate(null, candidate, { cache: verificationCache, scrambleString: scramble })) {
      validCandidates.push(candidate);
    }
  }
  if (!validCandidates.length && verifyLimit < candidates.length) {
    for (let i = verifyLimit; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (await verifyCandidate(null, candidate, { cache: verificationCache, scrambleString: scramble })) {
        validCandidates.push(candidate);
        if (validCandidates.length >= 3) break;
      }
    }
  }
  diagnostics.phaseTimingsMs.verification += Math.max(0, Date.now() - verificationStartedAt);
  if (!validCandidates.length) {
    return {
      ok: false,
      reason: "FMC_NO_VALID_SOLUTION",
      attempts,
      performanceDiagnostics: finalizeDiagnostics(),
    };
  }
  const bestValidatedMoveCount = validCandidates.reduce(
    (best, candidate) => Math.min(best, candidate.moveCount),
    Infinity,
  );
  if (enableInsertions && bestValidatedMoveCount <= insertionThreshold && remainingMs(deadlineTs) > 900) {
    const insertionStartedAt = Date.now();
    const insertionDeadlineTs = Math.min(deadlineTs, Date.now() + insertionTimeMs);
    const insertionTargets = validCandidates
      .slice()
      .sort(compareFmcCandidatePriority)
      .slice(0, Math.min(insertionCandidateLimit, validCandidates.length));

    if (insertionTargets.length) {
      for (let i = 0; i < insertionTargets.length; i += 1) {
        if (remainingMs(insertionDeadlineTs) <= 250) break;
        if (remainingMs(deadlineTs) <= 250) break;
        diagnostics.phaseRuns.insertion.calls += 1;
        const target = insertionTargets[i];
        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "fallback_start",
              stageName: `FMC Insertion ${i + 1}/${insertionTargets.length}`,
              reason: `${target.moveCount}T`,
            });
          } catch (_) {}
        }

        const optimizedMoves = await (async () => {
          // WASM fast path: integer BFS, ~50x faster than cubing.js pattern BFS
          try {
            const wasmResult = await optimizeInsertionWasm(scramble, target.solution, {
              maxPasses: insertionMaxPasses,
              minWindow: insertionMinWindow,
              maxWindow: insertionMaxWindow,
              maxDepth: insertionMaxDepth,
            });
            if (wasmResult && wasmResult.ok && typeof wasmResult.solution === "string") {
              const wasmMoves = wasmResult.solution.split(/\s+/).filter(Boolean);
              if (wasmMoves.length < target.moveCount) {
                return wasmMoves;
              }
              return target.moves; // WASM found no improvement — skip JS fallback
            }
          } catch (_) {}
          // WASM insertion failed or found no improvement — return original moves
          return target.moves;
        })();

        if (optimizedMoves.length < target.moveCount) {
          const insertionCandidate = createCandidate(
            "FMC_INSERTION",
            {
              tag: `insertion:${target.source}`,
              usesCfop: target.usesCfop,
              innerSource: target.innerSource || target.source,
              axisName: target.axisName,
              eoMoves: target.eoMoves,
              drMoves: target.drMoves,
              finishMoves: target.finishMoves,
              premoveMoves: target.premoveMoves,
              skeletonMoves: target.moves.slice(),
              insertionBaseMoves: target.moves.slice(),
            },
            optimizedMoves,
          );
          if (
            insertionCandidate &&
            (await verifyCandidate(null, insertionCandidate, { cache: verificationCache, scrambleString: scramble }))
          ) {
            if (!validCandidates.some((existing) => existing.solution === insertionCandidate.solution)) {
              validCandidates.push(insertionCandidate);
              validCandidates.sort(compareFmcCandidatePriority);
              pushRankedUniqueCandidate(candidates, insertionCandidate);
              if (insertionCandidate.moveCount < bestMoveCount) {
                bestMoveCount = insertionCandidate.moveCount;
              }
              diagnostics.phaseRuns.insertion.successes += 1;
              if (
                !Number.isFinite(diagnostics.phaseRuns.insertion.bestMoveCount) ||
                insertionCandidate.moveCount < diagnostics.phaseRuns.insertion.bestMoveCount
              ) {
                diagnostics.phaseRuns.insertion.bestMoveCount = insertionCandidate.moveCount;
              }
            }

            diagnostics.candidateCounts.verified = validCandidates.length;
            diagnostics.moveCountDistribution.verified = buildMoveCountDistribution(validCandidates);
            diagnostics.topCandidates.verified = snapshotTopCandidates(validCandidates);
            diagnostics.sourceCounts.verified = {};
            for (let i = 0; i < validCandidates.length; i += 1) {
              incrementCounter(diagnostics.sourceCounts.verified, validCandidates[i]?.source || "UNKNOWN");
            }
          }
        }

        if (typeof onProgress === "function") {
          try {
            void onProgress({
              type: "fallback_done",
              stageName: `FMC Insertion ${i + 1}/${insertionTargets.length}`,
            });
          } catch (_) {}
        }
      }
    }
    diagnostics.phaseTimingsMs.insertion += Math.max(0, Date.now() - insertionStartedAt);
  }

  const preferNonCfop = options.preferNonCfop === true;
  // FMC rule: a solution that is simply the inverse scramble is not allowed.
  const reverseAwareCandidates = validCandidates.filter(
    (candidate) => !isReverseScrambleSolution(candidate.solution, reverseScrambleCanonical),
  );
  diagnostics.candidateCounts.reverseAware = reverseAwareCandidates.length;
  diagnostics.moveCountDistribution.reverseAware = buildMoveCountDistribution(reverseAwareCandidates);
  diagnostics.topCandidates.reverseAware = snapshotTopCandidates(reverseAwareCandidates);
  for (let i = 0; i < reverseAwareCandidates.length; i += 1) {
    incrementCounter(diagnostics.sourceCounts.reverseAware, reverseAwareCandidates[i]?.source || "UNKNOWN");
  }
  if (!reverseAwareCandidates.length) {
    return {
      ok: false,
      reason: "FMC_NO_VALID_SOLUTION",
      attempts,
      performanceDiagnostics: finalizeDiagnostics(),
    };
  }
  const nonCfopCandidates = preferNonCfop ? reverseAwareCandidates.filter((candidate) => !candidate.usesCfop) : [];
  diagnostics.candidateCounts.preferredNonCfop = nonCfopCandidates.length;
  const rankedCandidates = (nonCfopCandidates.length ? nonCfopCandidates : reverseAwareCandidates)
    .slice()
    .sort(compareFmcCandidatePriority);
  diagnostics.candidateCounts.ranked = rankedCandidates.length;
  diagnostics.moveCountDistribution.ranked = buildMoveCountDistribution(rankedCandidates);
  diagnostics.topCandidates.ranked = snapshotTopCandidates(rankedCandidates);
  for (let i = 0; i < rankedCandidates.length; i += 1) {
    incrementCounter(diagnostics.sourceCounts.ranked, rankedCandidates[i]?.source || "UNKNOWN");
  }
  const best = rankedCandidates[0];
  diagnostics.selectedCandidate = {
    source: best?.source || null,
    innerSource: best?.innerSource || null,
    moveCount: Number.isFinite(best?.moveCount) ? best.moveCount : null,
    usesCfop: best?.usesCfop === true,
  };
  const candidateLines = rankedCandidates
    .slice(0, 3)
    .map((candidate, index) => `${index + 1}. ${candidate.moveCount}수 [${candidate.source}] ${candidate.solution}`);

  // Build FMC part breakdown for the best candidate
  const parts = buildFmcParts(best);

  // Use parts directly as stages — preserves isSummary, moveCount, notes for all rows
  // (Skeleton, Insertion summary rows are included; renderSolverStages handles isSummary correctly)
  const fmcStages = parts.length > 0 ? parts : [
    { name: "FMC Direct", solution: direct?.solution || "-" },
    { name: "FMC NISS", solution: inverse?.solution ? invertAlg(inverse.solution) : "-" },
    { name: "FMC Best", solution: best.solution },
  ];

  // solutionDisplay holds top candidates supplementary info.
  // Parts breakdown is carried via stages (= parts) and rendered as stageLines in the UI.
  const solutionDisplaySections = ["Top Candidates", ...candidateLines];

  return {
    ok: true,
    solution: best.solution,
    moveCount: best.moveCount,
    nodes: 0,
    bound: best.moveCount,
    source: best.source,
    attempts,
    stages: fmcStages,
    parts,
    solutionDisplay: solutionDisplaySections.join("\n"),
    performanceDiagnostics: finalizeDiagnostics(),
  };
}
