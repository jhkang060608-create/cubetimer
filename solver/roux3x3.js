import { getDefaultPattern } from "./context.js";
import { ROUX_CASE_DB } from "./rouxCaseDb.js";
import { ROUX_FORMULAS } from "./rouxDataset.js";
import { solve3x3InternalPhase } from "./solver3x3Phase/index.js";

const FACE_TURN_MOVES = Object.freeze([
  "U",
  "U'",
  "U2",
  "R",
  "R'",
  "R2",
  "F",
  "F'",
  "F2",
  "D",
  "D'",
  "D2",
  "L",
  "L'",
  "L2",
  "B",
  "B'",
  "B2",
]);

const CMLL_BEAM_MOVES = Object.freeze([
  "U",
  "U'",
  "U2",
  "R",
  "R'",
  "R2",
  "L",
  "L'",
  "L2",
  "F",
  "F'",
  "F2",
  "B",
  "B'",
  "B2",
]);

const ROUX_FB_MOVES = Object.freeze([
  "U",
  "U'",
  "U2",
  "D",
  "D'",
  "D2",
  "R",
  "R'",
  "R2",
  "L",
  "L'",
  "L2",
  "F",
  "F'",
  "F2",
  "B",
  "B'",
  "B2",
  "M",
  "M'",
  "M2",
  "r",
  "r'",
  "r2",
  "u",
  "u'",
  "u2",
  "y",
  "y'",
  "y2",
]);

const ROUX_SB_MOVES = Object.freeze([...ROUX_FB_MOVES]);
const U_AUF = Object.freeze(["", "U", "U2", "U'"]);
const Y_ROTATIONS = Object.freeze(["", "y", "y2", "y'"]);

const DEFAULT_OPTIONS = Object.freeze({
  fbMaxDepth: 10,
  fbBeamWidth: 320,
  sbMaxDepth: 10,
  sbBeamWidth: 320,
  cmllMaxDepth: 8,
  cmllBeamWidth: 220,
  lseFormulaLimit: 260,
  fbCaseDbDepth: 7,
  sbCaseDbDepth: 8,
  caseDbMaxStates: 180000,
  caseDbMaxPerKey: 8,
  fbPhasePrefixMaxMoves: 16,
  sbPhasePrefixMaxMoves: 18,
});

let rouxContextPromise = null;
const ROUX_CASE_DB_SCHEMA_VERSION = "roux-case-db.v1";

function normalizePositiveInt(value, fallback, min = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const out = Math.floor(n);
  return out >= min ? out : fallback;
}

function splitAlgTokens(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function joinAlgTokens(tokens) {
  return Array.isArray(tokens) ? tokens.filter(Boolean).join(" ").trim() : "";
}

function parseMoveToken(token) {
  const text = String(token || "").trim();
  if (!text) return null;
  const face = text[0];
  if (!face) return null;
  const suffix = text.slice(1);
  if (!suffix) return { face, amount: 1 };
  if (suffix === "2") return { face, amount: 2 };
  if (suffix === "'") return { face, amount: 3 };
  return null;
}

function formatMoveToken(face, amount) {
  const normalized = ((Number(amount) || 0) % 4 + 4) % 4;
  if (!normalized) return "";
  if (normalized === 1) return face;
  if (normalized === 2) return `${face}2`;
  if (normalized === 3) return `${face}'`;
  return "";
}

function simplifyMoves(moves) {
  if (!Array.isArray(moves) || !moves.length) return [];
  const stack = [];
  for (const move of moves) {
    const parsed = parseMoveToken(move);
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
    .map((entry) => (entry.face ? formatMoveToken(entry.face, entry.amount) : entry.raw))
    .filter(Boolean);
}

function invertMove(move) {
  const parsed = parseMoveToken(move);
  if (!parsed) return String(move || "").trim();
  const invAmount = (4 - (parsed.amount % 4)) % 4;
  if (!invAmount) return "";
  return formatMoveToken(parsed.face, invAmount);
}

function invertMoves(moves) {
  if (!Array.isArray(moves) || !moves.length) return [];
  const out = [];
  for (let i = moves.length - 1; i >= 0; i--) {
    const inv = invertMove(moves[i]);
    if (inv) out.push(inv);
  }
  return simplifyMoves(out);
}

function pushCaseCandidate(table, key, moves, maxPerKey = 4) {
  if (!table || !key || !Array.isArray(moves)) return;
  const normalized = simplifyMoves(moves);
  const serialized = joinAlgTokens(normalized);
  const bucket = table.get(key) || [];
  if (bucket.some((entry) => entry.text === serialized)) return;
  bucket.push({ moves: normalized, text: serialized, len: normalized.length });
  bucket.sort((a, b) => a.len - b.len || a.text.localeCompare(b.text));
  if (bucket.length > maxPerKey) {
    bucket.length = maxPerKey;
  }
  table.set(key, bucket);
}

function createPrng(seed = 0x9e3779b9) {
  let state = (seed >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) & 0xffffffff) / 4294967296;
  };
}

function randomInt(rng, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(rng() * limit);
}

function collectChangedPositions(before, after) {
  const out = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) out.push(i);
  }
  return out;
}

function uniqueIntersection(lists) {
  if (!Array.isArray(lists) || !lists.length) return -1;
  let current = new Set(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    const next = new Set(lists[i]);
    current = new Set(Array.from(current).filter((value) => next.has(value)));
  }
  if (current.size !== 1) return -1;
  return Array.from(current)[0];
}

function buildStateKey(pattern) {
  const data = pattern?.patternData;
  if (!data?.CORNERS || !data?.EDGES) return "";
  return `${data.CORNERS.pieces.join(",")}|${data.CORNERS.orientation.join(",")}|${data.EDGES.pieces.join(",")}|${data.EDGES.orientation.join(",")}`;
}

function buildEntriesStateKey(pattern, entries) {
  const data = pattern?.patternData;
  if (!data || !Array.isArray(entries) || entries.length === 0) return buildStateKey(pattern);
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const orbit = data?.[entry.orbit];
    if (!orbit) continue;
    const pos = entry.position;
    parts.push(`${entry.orbit}:${pos}:${orbit.pieces[pos]}:${orbit.orientation[pos]}`);
  }
  return parts.join("|");
}

function buildCornersStateKey(pattern) {
  const data = pattern?.patternData;
  if (!data?.CORNERS) return "";
  return `C:${data.CORNERS.pieces.join(",")}|${data.CORNERS.orientation.join(",")}`;
}

function ensureDeadline(deadlineTs, reason) {
  if (!Number.isFinite(deadlineTs)) return;
  if (Date.now() > deadlineTs) {
    const error = new Error(reason || "ROUX_TIMEOUT");
    error.code = reason || "ROUX_TIMEOUT";
    throw error;
  }
}

function tryApplyAlg(pattern, alg) {
  const text = String(alg || "").trim();
  if (!text) return pattern;
  try {
    return pattern.applyAlg(text);
  } catch (_) {
    return null;
  }
}

function tryApplyMoves(pattern, moves) {
  if (!Array.isArray(moves) || moves.length === 0) return pattern;
  return tryApplyAlg(pattern, joinAlgTokens(moves));
}

function moveFamily(move) {
  const text = String(move || "");
  const head = text[0] || "";
  if (!head) return "";
  if (head >= "a" && head <= "z") {
    return head.toUpperCase();
  }
  return head;
}

function countSolvedEntries(data, solvedData, entries) {
  let solvedCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const orbitName = entry.orbit;
    const pos = entry.position;
    const orbit = data[orbitName];
    const solvedOrbit = solvedData[orbitName];
    if (!orbit || !solvedOrbit) continue;
    if (
      orbit.pieces[pos] === solvedOrbit.pieces[pos] &&
      orbit.orientation[pos] === solvedOrbit.orientation[pos]
    ) {
      solvedCount += 1;
    }
  }
  return solvedCount;
}

function scoreEntries(data, solvedData, entries) {
  let score = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const orbitName = entry.orbit;
    const pos = entry.position;
    const orbit = data[orbitName];
    const solvedOrbit = solvedData[orbitName];
    if (!orbit || !solvedOrbit) continue;
    const pieceSolved = orbit.pieces[pos] === solvedOrbit.pieces[pos];
    const oriSolved = orbit.orientation[pos] === solvedOrbit.orientation[pos];
    if (pieceSolved && oriSolved) {
      score += 4;
      continue;
    }
    if (pieceSolved) {
      score += 2;
    }
  }
  return score;
}

function countSolvedTopCorners(data, solvedData, positions) {
  let solvedCount = 0;
  const corners = data?.CORNERS;
  const solvedCorners = solvedData?.CORNERS;
  if (!corners || !solvedCorners) return 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    if (
      corners.pieces[pos] === solvedCorners.pieces[pos] &&
      corners.orientation[pos] === solvedCorners.orientation[pos]
    ) {
      solvedCount += 1;
    }
  }
  return solvedCount;
}

function scoreTopCorners(data, solvedData, positions) {
  let score = 0;
  const corners = data?.CORNERS;
  const solvedCorners = solvedData?.CORNERS;
  if (!corners || !solvedCorners) return score;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const pieceSolved = corners.pieces[pos] === solvedCorners.pieces[pos];
    const oriSolved = corners.orientation[pos] === solvedCorners.orientation[pos];
    if (pieceSolved && oriSolved) {
      score += 4;
      continue;
    }
    if (pieceSolved) {
      score += 2;
    }
  }
  return score;
}

function scoreRouxStage(data, solvedData, targetEntries, futureEntries, depth, weights = {}) {
  const targetMultiplier = Number.isFinite(weights.targetMultiplier) ? weights.targetMultiplier : 250;
  const futurePenalty = Number.isFinite(weights.futurePenalty) ? weights.futurePenalty : 80;
  const depthPenalty = Number.isFinite(weights.depthPenalty) ? weights.depthPenalty : 12;
  const targetScore = scoreEntries(data, solvedData, targetEntries);
  const futureScore = Array.isArray(futureEntries) && futureEntries.length
    ? scoreEntries(data, solvedData, futureEntries)
    : 0;
  return targetScore * targetMultiplier - futureScore * futurePenalty - depth * depthPenalty;
}

function emitStageUpdate(options, payload) {
  const fn = options?.onStageUpdate;
  if (typeof fn !== "function") return;
  try {
    fn(payload);
  } catch (_) {
    // Progress callback is best-effort.
  }
}

function beamSearchStage(startPattern, options) {
  const {
    isGoal,
    score,
    allowedMoves,
    maxDepth,
    beamWidth,
    deadlineTs,
    keyFn,
  } = options;

  let nodes = 0;
  let layer = [
    {
      pattern: startPattern,
      moves: [],
      lastFamily: "",
      score: score(startPattern, 0),
    },
  ];

  if (isGoal(startPattern)) {
    return { ok: true, moves: [], nodes };
  }

  for (let depth = 0; depth < maxDepth; depth++) {
    ensureDeadline(deadlineTs, "ROUX_STAGE_TIMEOUT");
    const nextMap = new Map();
    for (let i = 0; i < layer.length; i++) {
      const state = layer[i];
      for (let m = 0; m < allowedMoves.length; m++) {
        const move = allowedMoves[m];
        if (!move) continue;
        const family = moveFamily(move);
        if (state.lastFamily && family && family === state.lastFamily) continue;
        const nextPattern = tryApplyAlg(state.pattern, move);
        nodes += 1;
        if (!nextPattern) continue;
        const nextMoves = state.moves.concat(move);
        if (isGoal(nextPattern)) {
          return { ok: true, moves: nextMoves, nodes };
        }

        const key = typeof keyFn === "function" ? keyFn(nextPattern, nextMoves, depth + 1) : buildStateKey(nextPattern);
        if (!key) continue;
        const nextScore = score(nextPattern, nextMoves.length);
        const existing = nextMap.get(key);
        if (
          !existing ||
          nextScore > existing.score ||
          (nextScore === existing.score && nextMoves.length < existing.moves.length)
        ) {
          nextMap.set(key, {
            pattern: nextPattern,
            moves: nextMoves,
            lastFamily: family,
            score: nextScore,
          });
        }
      }
    }

    if (nextMap.size === 0) break;
    let nextLayer = Array.from(nextMap.values());
    nextLayer.sort((a, b) => b.score - a.score || a.moves.length - b.moves.length);
    if (nextLayer.length > beamWidth) {
      nextLayer = nextLayer.slice(0, beamWidth);
    }
    layer = nextLayer;
  }

  return { ok: false, moves: null, nodes };
}

function runAdaptiveBeamStage(startPattern, baseOptions, attempts) {
  let totalNodes = 0;
  const diagnostics = [];
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const result = beamSearchStage(startPattern, {
      ...baseOptions,
      maxDepth: attempt.maxDepth,
      beamWidth: attempt.beamWidth,
    });
    totalNodes += result.nodes;
    diagnostics.push({
      attempt: i + 1,
      maxDepth: attempt.maxDepth,
      beamWidth: attempt.beamWidth,
      nodes: result.nodes,
      ok: result.ok,
    });
    if (result.ok) {
      return {
        ok: true,
        moves: result.moves,
        nodes: totalNodes,
        diagnostics,
        attemptIndex: i + 1,
      };
    }
  }

  return {
    ok: false,
    moves: null,
    nodes: totalNodes,
    diagnostics,
    attemptIndex: attempts.length,
  };
}

function buildFormulaCandidates(formulas, options = {}) {
  const includeRotations = options.includeRotations === true;
  const limit = normalizePositiveInt(options.limit, formulas.length, 1);
  const out = [];
  for (let i = 0; i < formulas.length && out.length < limit; i++) {
    const formula = String(formulas[i] || "").trim();
    if (!formula) continue;
    if (includeRotations) {
      for (let r = 0; r < Y_ROTATIONS.length; r++) {
        const y = Y_ROTATIONS[r];
        out.push(y ? `${y} ${formula}` : formula);
      }
    } else {
      out.push(formula);
    }
  }
  return out;
}

function serializeCaseTable(table) {
  const out = {};
  if (!(table instanceof Map)) return out;
  for (const [key, bucket] of table.entries()) {
    if (!key || !Array.isArray(bucket) || bucket.length === 0) continue;
    const algs = bucket
      .map((entry) => String(entry?.text || joinAlgTokens(entry?.moves || [])).trim())
      .filter(Boolean);
    if (!algs.length) continue;
    out[key] = algs;
  }
  return out;
}

function hydrateCaseTable(serialized) {
  const table = new Map();
  if (!serialized || typeof serialized !== "object") return table;
  for (const [key, algs] of Object.entries(serialized)) {
    if (!Array.isArray(algs) || algs.length === 0) continue;
    const bucket = [];
    for (let i = 0; i < algs.length; i++) {
      const text = String(algs[i] || "").trim();
      if (!text) continue;
      const moves = splitAlgTokens(text);
      bucket.push({
        moves,
        text,
        len: moves.length,
      });
    }
    if (bucket.length) {
      bucket.sort((a, b) => a.len - b.len || a.text.localeCompare(b.text));
      table.set(key, bucket);
    }
  }
  return table;
}

function buildPartialCaseDatabase(solvedPattern, entries, options = {}) {
  const allowedMoves = Array.isArray(options.allowedMoves) && options.allowedMoves.length
    ? options.allowedMoves
    : ROUX_FB_MOVES;
  const maxDepth = normalizePositiveInt(
    options.maxDepth,
    DEFAULT_OPTIONS.fbCaseDbDepth,
    0,
  );
  const maxStates = normalizePositiveInt(
    options.maxStates,
    DEFAULT_OPTIONS.caseDbMaxStates,
  );
  const maxPerKey = normalizePositiveInt(
    options.maxPerKey,
    DEFAULT_OPTIONS.caseDbMaxPerKey,
  );
  const randomSampleCount = normalizePositiveInt(
    options.randomSampleCount,
    Math.max(2000, maxStates),
    0,
  );
  const randomMinDepth = normalizePositiveInt(
    options.randomMinDepth,
    Math.max(2, Math.min(5, maxDepth)),
    1,
  );
  const randomMaxDepth = normalizePositiveInt(
    options.randomMaxDepth,
    Math.max(randomMinDepth + 1, maxDepth + 4),
    randomMinDepth,
  );
  const bfsStateBudget = Math.max(1000, Math.floor(maxStates * 0.35));
  const rng = createPrng(Number(options.seed) || 0x74a7c15d);

  const table = new Map();
  const queue = [{ pattern: solvedPattern, path: [], lastFamily: "" }];
  const seen = new Set([buildStateKey(solvedPattern)]);
  let read = 0;

  while (read < queue.length && seen.size < bfsStateBudget) {
    const state = queue[read++];
    const key = buildEntriesStateKey(state.pattern, entries);
    if (key) {
      pushCaseCandidate(table, key, invertMoves(state.path), maxPerKey);
    }

    if (state.path.length >= maxDepth) continue;
    for (let i = 0; i < allowedMoves.length; i++) {
      const move = allowedMoves[i];
      const family = moveFamily(move);
      if (state.lastFamily && family && family === state.lastFamily) continue;
      const nextPattern = tryApplyAlg(state.pattern, move);
      if (!nextPattern) continue;
      const fullKey = buildStateKey(nextPattern);
      if (!fullKey || seen.has(fullKey)) continue;
      seen.add(fullKey);
      queue.push({
        pattern: nextPattern,
        path: state.path.concat(move),
        lastFamily: family,
      });
      if (seen.size >= bfsStateBudget) break;
    }
  }

  for (let sample = 0; sample < randomSampleCount; sample++) {
    let pattern = solvedPattern;
    const path = [];
    let lastFamily = "";
    const depth = randomMinDepth + randomInt(rng, randomMaxDepth - randomMinDepth + 1);
    for (let step = 0; step < depth; step++) {
      let picked = "";
      let pickedFamily = "";
      for (let retry = 0; retry < 8; retry++) {
        const move = allowedMoves[randomInt(rng, allowedMoves.length)];
        const family = moveFamily(move);
        if (lastFamily && family && family === lastFamily) continue;
        picked = move;
        pickedFamily = family;
        break;
      }
      if (!picked) continue;
      const nextPattern = tryApplyAlg(pattern, picked);
      if (!nextPattern) continue;
      pattern = nextPattern;
      path.push(picked);
      lastFamily = pickedFamily;
    }
    if (!path.length) continue;
    const key = buildEntriesStateKey(pattern, entries);
    if (!key) continue;
    pushCaseCandidate(table, key, invertMoves(path), maxPerKey);
    if (table.size >= maxStates) {
      break;
    }
  }

  return {
    table,
    meta: {
      entries: Array.isArray(entries) ? entries.length : 0,
      maxDepth,
      maxStates,
      exploredStates: seen.size,
      randomSamples: randomSampleCount,
      keyCount: table.size,
    },
  };
}

function buildFormulaCaseIndex(solvedPattern, formulas, keyFn, options = {}) {
  const maxPerKey = normalizePositiveInt(
    options.maxPerKey,
    DEFAULT_OPTIONS.caseDbMaxPerKey,
  );
  const includeAuf = options.includeAuf !== false;
  const preAufs = includeAuf ? U_AUF : [""];
  const postAufs = includeAuf ? U_AUF : [""];
  const table = new Map();
  let generated = 0;
  for (let i = 0; i < formulas.length; i++) {
    const formulaMoves = splitAlgTokens(formulas[i]);
    if (!formulaMoves.length) continue;
    for (let p = 0; p < preAufs.length; p++) {
      for (let s = 0; s < postAufs.length; s++) {
        const candidateMoves = simplifyMoves(
          splitAlgTokens(preAufs[p]).concat(formulaMoves, splitAlgTokens(postAufs[s])),
        );
        if (!candidateMoves.length) continue;
        const casePattern = tryApplyMoves(solvedPattern, invertMoves(candidateMoves));
        if (!casePattern) continue;
        const key = keyFn(casePattern);
        if (!key) continue;
        pushCaseCandidate(table, key, candidateMoves, maxPerKey);
        generated += 1;
      }
    }
  }
  return {
    table,
    meta: {
      formulas: formulas.length,
      generated,
      keyCount: table.size,
    },
  };
}

function tryCaseCandidatesStage(startPattern, caseTable, keyFn, goalFn, options = {}) {
  const deadlineTs = options.deadlineTs;
  if (goalFn(startPattern)) {
    return { ok: true, moves: [], nodes: 0, method: "case-index", reason: "PRE_SOLVED" };
  }
  if (!(caseTable instanceof Map) || typeof keyFn !== "function") {
    return { ok: false, moves: null, nodes: 0, method: "case-index", reason: "NO_CASE_TABLE" };
  }
  const key = keyFn(startPattern);
  const bucket = key ? caseTable.get(key) : null;
  if (!Array.isArray(bucket) || bucket.length === 0) {
    return {
      ok: false,
      moves: null,
      nodes: 0,
      method: "case-index",
      reason: "CASE_MISS",
      key: key || "",
    };
  }
  let nodes = 0;
  for (let i = 0; i < bucket.length; i++) {
    ensureDeadline(deadlineTs, "ROUX_STAGE_TIMEOUT");
    const entry = bucket[i];
    const candidateMoves = Array.isArray(entry?.moves) ? entry.moves : [];
    const nextPattern = tryApplyMoves(startPattern, candidateMoves);
    nodes += 1;
    if (!nextPattern || !goalFn(nextPattern)) continue;
    return {
      ok: true,
      moves: candidateMoves,
      nodes,
      method: "case-index",
      key,
      candidatesTried: i + 1,
      candidatesTotal: bucket.length,
    };
  }
  return {
    ok: false,
    moves: null,
    nodes,
    method: "case-index",
    reason: "CASE_VERIFY_FAILED",
    key,
    candidatesTotal: bucket.length,
  };
}

function chooseBoundaryPreservingPrefix(startPattern, moves, goalFn, boundaryFn, options = {}) {
  const rawMoves = simplifyMoves(Array.isArray(moves) ? moves : []);
  const deadlineTs = options.deadlineTs;
  if (!rawMoves.length) {
    if (goalFn(startPattern) && boundaryFn(startPattern)) {
      return {
        moves: [],
        afterPattern: startPattern,
        source: "pre-solved",
      };
    }
    return null;
  }

  const variants = [{ name: "raw", moves: rawMoves }];
  const optimized = simplifyMoves(
    optimizeGoalPrefixMoves(startPattern, rawMoves, goalFn, {
      deadlineTs,
      maxPasses: Number.isFinite(options.maxPasses) ? options.maxPasses : 2,
      maxWindow: Number.isFinite(options.maxWindow) ? options.maxWindow : 8,
    }),
  );
  if (optimized.length && joinAlgTokens(optimized) !== joinAlgTokens(rawMoves)) {
    variants.push({ name: "optimized", moves: optimized });
  }

  let best = null;
  for (let v = 0; v < variants.length; v++) {
    const variant = variants[v];
    let current = startPattern;
    for (let i = 0; i < variant.moves.length; i++) {
      ensureDeadline(deadlineTs, "ROUX_OPT_TIMEOUT");
      current = tryApplyAlg(current, variant.moves[i]);
      if (!current) break;
      if (!goalFn(current) || !boundaryFn(current)) continue;
      const prefixMoves = variant.moves.slice(0, i + 1);
      if (!best || prefixMoves.length < best.moves.length) {
        best = {
          moves: prefixMoves,
          afterPattern: current,
          source: variant.name,
        };
      }
      break;
    }
  }

  return best;
}

function trySingleFormulaStage(startPattern, formulas, goalFn, options = {}) {
  const deadlineTs = options.deadlineTs;
  if (goalFn(startPattern)) {
    return { ok: true, moves: [], nodes: 0 };
  }
  let best = null;
  let nodes = 0;
  for (let i = 0; i < formulas.length; i++) {
    const formula = formulas[i];
    for (let p = 0; p < U_AUF.length; p++) {
      for (let s = 0; s < U_AUF.length; s++) {
        ensureDeadline(deadlineTs, "ROUX_STAGE_TIMEOUT");
        const pre = U_AUF[p];
        const post = U_AUF[s];
        const alg = [pre, formula, post].filter(Boolean).join(" ").trim();
        const nextPattern = tryApplyAlg(startPattern, alg);
        nodes += 1;
        if (!nextPattern) continue;
        if (!goalFn(nextPattern)) continue;
        const moves = splitAlgTokens(alg);
        if (!best || moves.length < best.moves.length) {
          best = { moves, alg };
        }
      }
    }
  }
  if (!best) return { ok: false, moves: null, nodes };
  return { ok: true, moves: best.moves, nodes };
}

async function findGoalPrefixViaPhaseSolve(startPattern, goalFn, options = {}) {
  const deadlineTs = options.deadlineTs;
  ensureDeadline(deadlineTs, "ROUX_TIMEOUT");
  if (goalFn(startPattern)) {
    return { ok: true, moves: [], nodes: 0, method: "phase-prefix" };
  }

  const remainingMs = Number.isFinite(deadlineTs)
    ? Math.max(1000, Math.min(40000, deadlineTs - Date.now()))
    : 25000;
  const phaseResult = await solve3x3InternalPhase(startPattern, {
    phase1MaxDepth: normalizePositiveInt(options.phase1MaxDepth, 13),
    phase2MaxDepth: normalizePositiveInt(options.phase2MaxDepth, 20),
    phase1NodeLimit: normalizePositiveInt(options.phase1NodeLimit, 0, 0),
    phase2NodeLimit: normalizePositiveInt(options.phase2NodeLimit, 0, 0),
    timeCheckInterval: normalizePositiveInt(options.timeCheckInterval, 768),
    deadlineTs: Date.now() + remainingMs,
  });
  const nodes = Number(phaseResult?.nodes || 0);
  if (!phaseResult?.ok || phaseResult.solution == null) {
    return {
      ok: false,
      moves: null,
      nodes,
      method: "phase-prefix",
      reason: phaseResult?.reason || "PHASE_FAILED",
    };
  }

  const tokens = splitAlgTokens(phaseResult.solution);
  let current = startPattern;
  let best = null;
  let filteredBest = null;
  const acceptPrefix = typeof options.acceptPrefix === "function" ? options.acceptPrefix : null;
  const allowFilteredFallback = options.allowFilteredFallback !== false;
  const allowFilteredWhen =
    typeof options.allowFilteredWhen === "function" ? options.allowFilteredWhen : null;
  for (let i = 0; i < tokens.length; i++) {
    ensureDeadline(deadlineTs, "ROUX_TIMEOUT");
    current = tryApplyAlg(current, tokens[i]);
    if (!current) {
      return {
        ok: false,
        moves: null,
        nodes,
        method: "phase-prefix",
        reason: "PHASE_PREFIX_APPLY_FAILED",
      };
    }
    if (goalFn(current)) {
      const prefixMoves = tokens.slice(0, i + 1);
      const accepted = acceptPrefix ? Boolean(acceptPrefix(current, prefixMoves, i + 1)) : true;
      const prefixScore =
        typeof options.selectPrefixScore === "function"
          ? options.selectPrefixScore(current, prefixMoves, i + 1)
          : -prefixMoves.length;
      const canUseFiltered = accepted
        ? false
        : (allowFilteredWhen ? Boolean(allowFilteredWhen(current, prefixMoves, i + 1)) : true);
      const target = accepted ? "best" : (canUseFiltered ? "filteredBest" : "");
      if (!target) {
        continue;
      }
      const holder = accepted ? best : filteredBest;
      if (!holder || prefixScore > holder.score || (prefixScore === holder.score && prefixMoves.length < holder.moves.length)) {
        const next = {
          moves: prefixMoves,
          score: prefixScore,
          accepted,
        };
        if (target === "best") {
          best = next;
        } else {
          filteredBest = next;
        }
      }
      if (typeof options.selectPrefixScore !== "function") {
        if (accepted) break;
      }
    }
  }

  if (best) {
    return {
      ok: true,
      moves: best.moves,
      nodes,
      method: "phase-prefix",
    };
  }
  if (allowFilteredFallback && filteredBest) {
    return {
      ok: true,
      moves: filteredBest.moves,
      nodes,
      method: "phase-prefix",
      reason: "PHASE_PREFIX_FILTERED_FALLBACK",
    };
  }

  return {
    ok: false,
    moves: null,
    nodes,
    method: "phase-prefix",
    reason: filteredBest ? "PHASE_PREFIX_FILTERED_OUT" : "PHASE_PREFIX_NOT_FOUND",
  };
}

function buildRouxBaseContext(solvedPattern) {
  const solvedData = solvedPattern.patternData;
  const cornersByFace = {
    U: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("U").patternData.CORNERS.pieces,
    ),
    D: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("D").patternData.CORNERS.pieces,
    ),
    L: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("L").patternData.CORNERS.pieces,
    ),
    R: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("R").patternData.CORNERS.pieces,
    ),
    F: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("F").patternData.CORNERS.pieces,
    ),
    B: collectChangedPositions(
      solvedData.CORNERS.pieces,
      solvedPattern.applyMove("B").patternData.CORNERS.pieces,
    ),
  };
  const edgesByFace = {
    U: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("U").patternData.EDGES.pieces,
    ),
    D: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("D").patternData.EDGES.pieces,
    ),
    L: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("L").patternData.EDGES.pieces,
    ),
    R: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("R").patternData.EDGES.pieces,
    ),
    F: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("F").patternData.EDGES.pieces,
    ),
    B: collectChangedPositions(
      solvedData.EDGES.pieces,
      solvedPattern.applyMove("B").patternData.EDGES.pieces,
    ),
  };

  const leftBlockEntries = [
    { orbit: "CORNERS", position: uniqueIntersection([cornersByFace.U, cornersByFace.L, cornersByFace.B]) },
    { orbit: "CORNERS", position: uniqueIntersection([cornersByFace.D, cornersByFace.L, cornersByFace.B]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.U, edgesByFace.L]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.B, edgesByFace.L]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.D, edgesByFace.L]) },
  ].filter((entry) => entry.position >= 0);

  const rightBlockEntries = [
    { orbit: "CORNERS", position: uniqueIntersection([cornersByFace.U, cornersByFace.R, cornersByFace.B]) },
    { orbit: "CORNERS", position: uniqueIntersection([cornersByFace.D, cornersByFace.R, cornersByFace.B]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.U, edgesByFace.R]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.B, edgesByFace.R]) },
    { orbit: "EDGES", position: uniqueIntersection([edgesByFace.D, edgesByFace.R]) },
  ].filter((entry) => entry.position >= 0);

  const blockPlans = [
    {
      name: "LEFT_FIRST",
      firstBlockEntries: leftBlockEntries,
      secondBlockOnlyEntries: rightBlockEntries,
      secondBlockEntries: leftBlockEntries.concat(rightBlockEntries),
    },
    {
      name: "RIGHT_FIRST",
      firstBlockEntries: rightBlockEntries,
      secondBlockOnlyEntries: leftBlockEntries,
      secondBlockEntries: leftBlockEntries.concat(rightBlockEntries),
    },
  ];

  return {
    solvedPattern,
    solvedData,
    leftBlockEntries,
    rightBlockEntries,
    topCornerPositions: cornersByFace.U.slice(),
    firstBlockEntries: leftBlockEntries,
    secondBlockOnlyEntries: rightBlockEntries,
    secondBlockEntries: leftBlockEntries.concat(rightBlockEntries),
    blockPlans,
  };
}

function resolveRouxBlockPlans(ctx) {
  return Array.isArray(ctx?.blockPlans) && ctx.blockPlans.length
    ? ctx.blockPlans
    : [
      {
        name: "LEFT_FIRST",
        firstBlockEntries: ctx.leftBlockEntries,
        secondBlockOnlyEntries: ctx.rightBlockEntries,
        secondBlockEntries: ctx.leftBlockEntries.concat(ctx.rightBlockEntries),
      },
      {
        name: "RIGHT_FIRST",
        firstBlockEntries: ctx.rightBlockEntries,
        secondBlockOnlyEntries: ctx.leftBlockEntries,
        secondBlockEntries: ctx.leftBlockEntries.concat(ctx.rightBlockEntries),
      },
    ];
}

function rankRouxBlockPlans(pattern, ctx) {
  const blockPlans = resolveRouxBlockPlans(ctx);
  return blockPlans
    .map((plan) => ({
      ...plan,
      heuristic: scoreRouxStage(
        pattern.patternData,
        ctx.solvedData,
        plan.firstBlockEntries,
        plan.secondBlockOnlyEntries,
        0,
        {
          targetMultiplier: 300,
          futurePenalty: 100,
          depthPenalty: 0,
        },
      ),
    }))
    .sort((a, b) => b.heuristic - a.heuristic || a.name.localeCompare(b.name));
}

function buildRouxPlanContext(ctx, plan) {
  return {
    ...ctx,
    firstBlockEntries: plan.firstBlockEntries,
    secondBlockOnlyEntries: plan.secondBlockOnlyEntries,
    secondBlockEntries: plan.secondBlockEntries,
    rouxPlan: plan.name,
    caseDb: ctx.caseDbsByPlan?.[plan.name] || null,
  };
}

function buildRouxCaseDbArtifactsFromBaseContext(baseCtx) {
  const { solvedPattern, blockPlans } = baseCtx;
  const fbByPlan = {};
  const sbByPlan = {};
  const meta = {
    plans: {},
  };

  for (let i = 0; i < blockPlans.length; i++) {
    const plan = blockPlans[i];
    const fb = buildPartialCaseDatabase(solvedPattern, plan.firstBlockEntries, {
      allowedMoves: ROUX_FB_MOVES,
      maxDepth: DEFAULT_OPTIONS.fbCaseDbDepth,
      maxStates: DEFAULT_OPTIONS.caseDbMaxStates,
      maxPerKey: DEFAULT_OPTIONS.caseDbMaxPerKey,
      seed: plan.name === "LEFT_FIRST" ? 0x19d87a3b : 0x2f61c9ad,
    });
    const sb = buildPartialCaseDatabase(solvedPattern, plan.secondBlockEntries, {
      allowedMoves: ROUX_SB_MOVES,
      maxDepth: DEFAULT_OPTIONS.sbCaseDbDepth + 1,
      maxStates: Math.floor(DEFAULT_OPTIONS.caseDbMaxStates * 1.4),
      maxPerKey: Math.max(10, DEFAULT_OPTIONS.caseDbMaxPerKey),
      randomSampleCount: Math.max(5000, DEFAULT_OPTIONS.caseDbMaxStates * 2),
      randomMinDepth: Math.max(3, DEFAULT_OPTIONS.sbCaseDbDepth - 1),
      randomMaxDepth: Math.max(DEFAULT_OPTIONS.sbCaseDbDepth + 6, DEFAULT_OPTIONS.sbCaseDbDepth + 2),
      seed: plan.name === "LEFT_FIRST" ? 0x5b7e13c1 : 0x7f3ad449,
    });
    fbByPlan[plan.name] = serializeCaseTable(fb.table);
    sbByPlan[plan.name] = serializeCaseTable(sb.table);
    meta.plans[plan.name] = {
      fb: fb.meta,
      sb: sb.meta,
    };
  }

  const cmllFormulas = buildFormulaCandidates(
    Array.isArray(ROUX_FORMULAS?.CMLL) ? ROUX_FORMULAS.CMLL : [],
    { includeRotations: true },
  );
  const lseFormulas = buildFormulaCandidates(
    Array.isArray(ROUX_FORMULAS?.LSE) ? ROUX_FORMULAS.LSE : [],
    { includeRotations: false },
  );
  const cmllCaseIndex = buildFormulaCaseIndex(
    solvedPattern,
    cmllFormulas,
    (candidate) => buildCornersStateKey(candidate),
    { includeAuf: true, maxPerKey: DEFAULT_OPTIONS.caseDbMaxPerKey },
  );
  const lseCaseIndex = buildFormulaCaseIndex(
    solvedPattern,
    lseFormulas,
    (candidate) => buildStateKey(candidate),
    { includeAuf: true, maxPerKey: DEFAULT_OPTIONS.caseDbMaxPerKey },
  );

  return {
    schemaVersion: ROUX_CASE_DB_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    fbByPlan,
    sbByPlan,
    cmll: serializeCaseTable(cmllCaseIndex.table),
    lse: serializeCaseTable(lseCaseIndex.table),
    meta: {
      ...meta,
      cmll: cmllCaseIndex.meta,
      lse: lseCaseIndex.meta,
    },
  };
}

export async function buildRouxCaseDbArtifacts() {
  const solvedPattern = await getDefaultPattern("333");
  return buildRouxCaseDbArtifactsFromBaseContext(buildRouxBaseContext(solvedPattern));
}

async function getRouxContext() {
  if (rouxContextPromise) return rouxContextPromise;
  rouxContextPromise = (async () => {
    const solvedPattern = await getDefaultPattern("333");
    const baseCtx = buildRouxBaseContext(solvedPattern);
    const serializedCaseDb =
      ROUX_CASE_DB &&
      typeof ROUX_CASE_DB === "object" &&
      ROUX_CASE_DB.schemaVersion === ROUX_CASE_DB_SCHEMA_VERSION &&
      ROUX_CASE_DB.fbByPlan &&
      ROUX_CASE_DB.sbByPlan &&
      ROUX_CASE_DB.cmll &&
      ROUX_CASE_DB.lse
        ? ROUX_CASE_DB
        : buildRouxCaseDbArtifactsFromBaseContext(baseCtx);

    const caseDbsByPlan = {};
    for (let i = 0; i < baseCtx.blockPlans.length; i++) {
      const plan = baseCtx.blockPlans[i];
      caseDbsByPlan[plan.name] = {
        fb: {
          table: hydrateCaseTable(serializedCaseDb.fbByPlan?.[plan.name]),
          meta: serializedCaseDb.meta?.plans?.[plan.name]?.fb || null,
        },
        sb: {
          table: hydrateCaseTable(serializedCaseDb.sbByPlan?.[plan.name]),
          meta: serializedCaseDb.meta?.plans?.[plan.name]?.sb || null,
        },
      };
    }

    const cmllFormulas = buildFormulaCandidates(
      Array.isArray(ROUX_FORMULAS?.CMLL) ? ROUX_FORMULAS.CMLL : [],
      { includeRotations: true },
    );
    const lseFormulas = buildFormulaCandidates(
      Array.isArray(ROUX_FORMULAS?.LSE) ? ROUX_FORMULAS.LSE : [],
      { includeRotations: false },
    );

    return {
      ...baseCtx,
      caseDbsByPlan,
      cmllFormulas,
      lseFormulas,
      cmllCaseIndex: {
        table: hydrateCaseTable(serializedCaseDb.cmll),
        meta: serializedCaseDb.meta?.cmll || null,
      },
      lseCaseIndex: {
        table: hydrateCaseTable(serializedCaseDb.lse),
        meta: serializedCaseDb.meta?.lse || null,
      },
      rouxCaseDbMeta: serializedCaseDb.meta || null,
    };
  })();
  return rouxContextPromise;
}

function isFirstBlockSolved(pattern, ctx) {
  const data = pattern?.patternData;
  if (!data) return false;
  return (
    countSolvedEntries(data, ctx.solvedData, ctx.firstBlockEntries) === ctx.firstBlockEntries.length
  );
}

function isSecondBlockSolved(pattern, ctx) {
  const data = pattern?.patternData;
  if (!data) return false;
  return (
    countSolvedEntries(data, ctx.solvedData, ctx.secondBlockEntries) === ctx.secondBlockEntries.length
  );
}

function isCmllSolved(pattern, ctx) {
  const data = pattern?.patternData;
  if (!data) return false;
  if (!isSecondBlockSolved(pattern, ctx)) return false;
  return (
    countSolvedTopCorners(data, ctx.solvedData, ctx.topCornerPositions) ===
    ctx.topCornerPositions.length
  );
}

function isCubeSolved(pattern, ctx) {
  if (!pattern || !ctx?.solvedPattern) return false;
  return pattern.isIdentical(ctx.solvedPattern);
}

function buildFailure(reason, stage, nodes, stages, stageDiagnostics = []) {
  return {
    ok: false,
    reason,
    stage,
    nodes,
    stages,
    stageDiagnostics,
    source: "INTERNAL_3X3_ROUX",
  };
}

function optimizeGoalPrefixMoves(startPattern, moves, goalFn, options = {}) {
  let current = simplifyMoves(Array.isArray(moves) ? moves : []);
  if (current.length < 2) return current;

  const maxPasses = Number.isFinite(options.maxPasses) ? Math.max(1, Math.floor(options.maxPasses)) : 2;
  const minWindow = Number.isFinite(options.minWindow) ? Math.max(1, Math.floor(options.minWindow)) : 1;
  const maxWindow = Number.isFinite(options.maxWindow) ? Math.max(minWindow, Math.floor(options.maxWindow)) : 5;
  const deadlineTs = Number.isFinite(options.deadlineTs) ? options.deadlineTs : Date.now() + 500;

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    const windowCap = Math.min(maxWindow, current.length);

    outer: for (let window = windowCap; window >= minWindow; window--) {
      for (let start = 0; start + window <= current.length; start++) {
        ensureDeadline(deadlineTs, "ROUX_OPT_TIMEOUT");
        const next = simplifyMoves(current.slice(0, start).concat(current.slice(start + window)));
        if (next.length >= current.length) continue;
        const nextPattern = tryApplyMoves(startPattern, next);
        if (!nextPattern || !goalFn(nextPattern)) continue;
        current = next;
        improved = true;
        break outer;
      }
    }

    if (!improved) break;
  }

  return current;
}

function buildPrefixStates(startPattern, moves, deadlineTs) {
  const states = [startPattern];
  let current = startPattern;
  for (let i = 0; i < moves.length; i++) {
    ensureDeadline(deadlineTs, "ROUX_RECOVERY_TIMEOUT");
    current = tryApplyAlg(current, moves[i]);
    if (!current) return null;
    states.push(current);
  }
  return states;
}

function findFirstGoalIndex(states, startIndex, goalFn) {
  const begin = Math.max(0, Number(startIndex) || 0);
  for (let i = begin; i < states.length; i++) {
    if (goalFn(states[i])) return i;
  }
  return -1;
}

function findLastGoalIndex(states, startIndex, endIndex, goalFn) {
  const begin = Math.max(0, Number(startIndex) || 0);
  const end = Math.min(states.length - 1, Number(endIndex) || 0);
  for (let i = end; i >= begin; i--) {
    if (goalFn(states[i])) return i;
  }
  return -1;
}

function collectGoalIndices(states, startIndex, goalFn) {
  const begin = Math.max(0, Number(startIndex) || 0);
  const out = [];
  for (let i = begin; i < states.length; i++) {
    if (goalFn(states[i])) out.push(i);
  }
  return out;
}

function pickStrictRecoveryCuts(states, ctx) {
  if (!Array.isArray(states) || states.length < 2) return null;
  const solvedIndex = states.length - 1;
  if (!isCubeSolved(states[solvedIndex], ctx)) return null;

  const fbIndices = collectGoalIndices(
    states,
    1,
    (candidate) =>
      isFirstBlockSolved(candidate, ctx) &&
      !isSecondBlockSolved(candidate, ctx) &&
      !isCubeSolved(candidate, ctx),
  );

  for (let i = 0; i < fbIndices.length; i++) {
    const fb = fbIndices[i];
    const sbIndices = collectGoalIndices(
      states,
      fb + 1,
      (candidate) =>
        isSecondBlockSolved(candidate, ctx) &&
        !isCmllSolved(candidate, ctx) &&
        !isCubeSolved(candidate, ctx),
    );
    for (let j = 0; j < sbIndices.length; j++) {
      const sb = sbIndices[j];
      const cmllIndices = collectGoalIndices(
        states,
        sb + 1,
        (candidate) => isCmllSolved(candidate, ctx) && !isCubeSolved(candidate, ctx),
      );
      if (cmllIndices.length) {
        return {
          fb,
          sb,
          cmll: cmllIndices[0],
          solved: solvedIndex,
        };
      }
    }
  }
  return null;
}

function pickRecoveryFbCut(states, ctx) {
  const strict = collectGoalIndices(
    states,
    1,
    (candidate) =>
      isFirstBlockSolved(candidate, ctx) &&
      !isSecondBlockSolved(candidate, ctx) &&
      !isCubeSolved(candidate, ctx),
  );
  if (strict.length) return strict[0];
  const loose = collectGoalIndices(
    states,
    1,
    (candidate) => isFirstBlockSolved(candidate, ctx) && !isCubeSolved(candidate, ctx),
  );
  return loose.length ? loose[0] : -1;
}

function buildRecoveryStageResult(stageName, method, moves, afterPattern, nodes, reason = "") {
  return {
    ok: Boolean(afterPattern),
    moves: simplifyMoves(Array.isArray(moves) ? moves : []),
    afterPattern: afterPattern || null,
    nodes: Number(nodes || 0),
    diagnostics: [
      {
        stage: stageName,
        method,
        ok: Boolean(afterPattern),
        nodes: Number(nodes || 0),
        reason,
        moveCount: Array.isArray(moves) ? simplifyMoves(moves).length : 0,
      },
    ],
  };
}

async function solveCmllRecoveryStage(startPattern, ctx, deadlineTs) {
  if (!startPattern) {
    return buildRecoveryStageResult("CMLL", "recovery-precheck", [], null, 0, "NO_PATTERN");
  }
  if (isCmllSolved(startPattern, ctx)) {
    return buildRecoveryStageResult("CMLL", "recovery-precheck", [], startPattern, 0, "PRE_SOLVED");
  }

  let totalNodes = 0;
  const diagnostics = [];

  const cmllCaseResult = tryCaseCandidatesStage(
    startPattern,
    ctx.cmllCaseIndex?.table,
    (candidate) => buildCornersStateKey(candidate),
    (candidate) => isCmllSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += cmllCaseResult.nodes;
  diagnostics.push({
    stage: "CMLL",
    method: cmllCaseResult.method,
    ok: cmllCaseResult.ok,
    nodes: cmllCaseResult.nodes,
    reason: cmllCaseResult.reason || "",
  });
  if (cmllCaseResult.ok && Array.isArray(cmllCaseResult.moves)) {
    const moves = simplifyMoves(cmllCaseResult.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    if (afterPattern && isCmllSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  const cmllFormulas = Array.isArray(ctx.cmllFormulas) && ctx.cmllFormulas.length
    ? ctx.cmllFormulas
    : buildFormulaCandidates(
      Array.isArray(ROUX_FORMULAS?.CMLL) ? ROUX_FORMULAS.CMLL : [],
      { includeRotations: true },
    );
  const cmllFormulaResult = trySingleFormulaStage(
    startPattern,
    cmllFormulas,
    (candidate) => isCmllSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += cmllFormulaResult.nodes;
  if (cmllFormulaResult.ok && Array.isArray(cmllFormulaResult.moves)) {
    const moves = simplifyMoves(cmllFormulaResult.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    diagnostics.push({
      stage: "CMLL",
      method: "formula",
      ok: Boolean(afterPattern),
      nodes: cmllFormulaResult.nodes,
      reason: "",
    });
    if (afterPattern && isCmllSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  const cmllBeam = beamSearchStage(startPattern, {
    isGoal: (candidate) => isCmllSolved(candidate, ctx),
    score: (candidate, depth) => {
      const data = candidate.patternData;
      const blockScore = scoreEntries(data, ctx.solvedData, ctx.secondBlockEntries);
      const topCornerScore = scoreTopCorners(data, ctx.solvedData, ctx.topCornerPositions);
      return blockScore * 80 + topCornerScore * 120 - depth;
    },
    allowedMoves: CMLL_BEAM_MOVES,
    maxDepth: DEFAULT_OPTIONS.cmllMaxDepth,
    beamWidth: DEFAULT_OPTIONS.cmllBeamWidth,
    deadlineTs,
    keyFn: (candidate) =>
      buildEntriesStateKey(
        candidate,
        ctx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
      ),
  });
  totalNodes += cmllBeam.nodes;
  diagnostics.push({
    stage: "CMLL",
    method: "beam",
    ok: cmllBeam.ok,
    nodes: cmllBeam.nodes,
    reason: cmllBeam.ok ? "" : "BEAM_FAIL",
  });
  if (cmllBeam.ok && Array.isArray(cmllBeam.moves)) {
    const moves = simplifyMoves(cmllBeam.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    if (afterPattern && isCmllSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  const cmllPhaseFallback = await findGoalPrefixViaPhaseSolve(
    startPattern,
    (candidate) => isCmllSolved(candidate, ctx),
    {
      deadlineTs,
      acceptPrefix: (candidate) => !isCubeSolved(candidate, ctx),
      allowFilteredFallback: false,
    },
  );
  totalNodes += cmllPhaseFallback.nodes;
  diagnostics.push({
    stage: "CMLL",
    method: cmllPhaseFallback.method,
    ok: cmllPhaseFallback.ok,
    nodes: cmllPhaseFallback.nodes,
    reason: cmllPhaseFallback.reason || "",
  });
  if (cmllPhaseFallback.ok && Array.isArray(cmllPhaseFallback.moves)) {
    const moves = simplifyMoves(cmllPhaseFallback.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    if (afterPattern && isCmllSolved(afterPattern, ctx) && !isCubeSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  return {
    ok: false,
    moves: null,
    afterPattern: null,
    nodes: totalNodes,
    diagnostics,
    reason: "CMLL_RECOVERY_FAILED",
  };
}

async function solveLseRecoveryStage(startPattern, ctx, deadlineTs) {
  if (!startPattern) {
    return buildRecoveryStageResult("LSE", "recovery-precheck", [], null, 0, "NO_PATTERN");
  }
  if (isCubeSolved(startPattern, ctx)) {
    return buildRecoveryStageResult("LSE", "recovery-precheck", [], startPattern, 0, "PRE_SOLVED");
  }

  let totalNodes = 0;
  const diagnostics = [];

  const lseCaseResult = tryCaseCandidatesStage(
    startPattern,
    ctx.lseCaseIndex?.table,
    (candidate) => buildStateKey(candidate),
    (candidate) => isCubeSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += lseCaseResult.nodes;
  diagnostics.push({
    stage: "LSE",
    method: lseCaseResult.method,
    ok: lseCaseResult.ok,
    nodes: lseCaseResult.nodes,
    reason: lseCaseResult.reason || "",
  });
  if (lseCaseResult.ok && Array.isArray(lseCaseResult.moves)) {
    const moves = simplifyMoves(lseCaseResult.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    if (afterPattern && isCubeSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  const allLseFormulas = Array.isArray(ctx.lseFormulas) && ctx.lseFormulas.length
    ? ctx.lseFormulas
    : buildFormulaCandidates(
      Array.isArray(ROUX_FORMULAS?.LSE) ? ROUX_FORMULAS.LSE : [],
      { includeRotations: false },
    );
  const lseFormulas = allLseFormulas.slice(0, Math.max(1, DEFAULT_OPTIONS.lseFormulaLimit));
  const lseFormulaResult = trySingleFormulaStage(
    startPattern,
    lseFormulas,
    (candidate) => isCubeSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += lseFormulaResult.nodes;
  if (lseFormulaResult.ok && Array.isArray(lseFormulaResult.moves)) {
    const moves = simplifyMoves(lseFormulaResult.moves);
    const afterPattern = tryApplyMoves(startPattern, moves);
    diagnostics.push({
      stage: "LSE",
      method: "formula",
      ok: Boolean(afterPattern),
      nodes: lseFormulaResult.nodes,
      reason: "",
    });
    if (afterPattern && isCubeSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  const remainingMs = Number.isFinite(deadlineTs) ? Math.max(500, deadlineTs - Date.now()) : 25000;
  const phaseResult = await solve3x3InternalPhase(startPattern, {
    phase1MaxDepth: 13,
    phase2MaxDepth: 20,
    phase1NodeLimit: 0,
    phase2NodeLimit: 0,
    timeCheckInterval: 768,
    deadlineTs: Date.now() + remainingMs,
  });
  totalNodes += Number(phaseResult?.nodes || 0);
  diagnostics.push({
    stage: "LSE",
    method: "internal-phase",
    ok: Boolean(phaseResult?.ok),
    nodes: Number(phaseResult?.nodes || 0),
    reason: phaseResult?.reason || "",
  });
  if (phaseResult?.ok && phaseResult.solution != null) {
    const moves = simplifyMoves(splitAlgTokens(phaseResult.solution));
    const afterPattern = tryApplyMoves(startPattern, moves);
    if (afterPattern && isCubeSolved(afterPattern, ctx)) {
      return { ok: true, moves, afterPattern, nodes: totalNodes, diagnostics };
    }
  }

  return {
    ok: false,
    moves: null,
    afterPattern: null,
    nodes: totalNodes,
    diagnostics,
    reason: "LSE_RECOVERY_FAILED",
  };
}

async function solveFbRecoveryStage(startPattern, ctx, deadlineTs) {
  if (!startPattern) {
    return buildRecoveryStageResult("FB", "recovery-precheck", [], null, 0, "NO_PATTERN");
  }
  if (
    isFirstBlockSolved(startPattern, ctx) &&
    !isSecondBlockSolved(startPattern, ctx) &&
    !isCubeSolved(startPattern, ctx)
  ) {
    return buildRecoveryStageResult("FB", "recovery-precheck", [], startPattern, 0, "PRE_SOLVED");
  }

  let totalNodes = 0;
  const diagnostics = [];
  const boundaryFn = (candidate) => !isSecondBlockSolved(candidate, ctx) && !isCubeSolved(candidate, ctx);
  const looseBoundaryFn = (candidate) => !isCubeSolved(candidate, ctx);
  const pickCandidate = (moves, goalFn) => {
    const strictChoice = chooseBoundaryPreservingPrefix(startPattern, moves, goalFn, boundaryFn, {
      deadlineTs,
      maxPasses: 3,
      maxWindow: 8,
    });
    if (strictChoice) {
      return { choice: strictChoice, loose: false };
    }
    const looseChoice = chooseBoundaryPreservingPrefix(startPattern, moves, goalFn, looseBoundaryFn, {
      deadlineTs,
      maxPasses: 3,
      maxWindow: 8,
    });
    if (looseChoice) {
      return { choice: looseChoice, loose: true };
    }
    return null;
  };

  const fbCaseResult = tryCaseCandidatesStage(
    startPattern,
    ctx.caseDb?.fb?.table,
    (candidate) => buildEntriesStateKey(candidate, ctx.firstBlockEntries),
    (candidate) => isFirstBlockSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += fbCaseResult.nodes;
  diagnostics.push({
    stage: "FB",
    method: fbCaseResult.method,
    ok: fbCaseResult.ok,
    nodes: fbCaseResult.nodes,
    reason: fbCaseResult.reason || "",
  });
  if (fbCaseResult.ok && Array.isArray(fbCaseResult.moves)) {
    const picked = pickCandidate(fbCaseResult.moves, (candidate) => isFirstBlockSolved(candidate, ctx));
    if (picked?.choice?.afterPattern && isFirstBlockSolved(picked.choice.afterPattern, ctx)) {
      diagnostics.push({
        stage: "FB",
        method: picked.loose ? "case-index-boundary-prefix-loose" : "case-index-boundary-prefix",
        ok: true,
        nodes: 0,
        reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
      });
      return {
        ok: true,
        moves: picked.choice.moves,
        afterPattern: picked.choice.afterPattern,
        nodes: totalNodes,
        diagnostics,
      };
    }
  }

  const fbAttempts = [
    { maxDepth: DEFAULT_OPTIONS.fbMaxDepth, beamWidth: DEFAULT_OPTIONS.fbBeamWidth },
    {
      maxDepth: Math.min(DEFAULT_OPTIONS.fbMaxDepth + 2, 14),
      beamWidth: Math.min(DEFAULT_OPTIONS.fbBeamWidth * 2, 1280),
    },
  ];
  const fbResult = runAdaptiveBeamStage(
    startPattern,
    {
      isGoal: (candidate) => isFirstBlockSolved(candidate, ctx),
      score: (candidate, depth) =>
        scoreRouxStage(
          candidate.patternData,
          ctx.solvedData,
          ctx.firstBlockEntries,
          ctx.secondBlockOnlyEntries,
          depth,
          {
            targetMultiplier: 300,
            futurePenalty: 180,
            depthPenalty: 10,
          },
        ),
      allowedMoves: ROUX_FB_MOVES,
      deadlineTs,
      keyFn: (candidate) => buildEntriesStateKey(candidate, ctx.firstBlockEntries),
    },
    fbAttempts,
  );
  totalNodes += fbResult.nodes;
  diagnostics.push(...fbResult.diagnostics.map((entry) => ({ stage: "FB", ...entry })));
  if (fbResult.ok && Array.isArray(fbResult.moves)) {
    const picked = pickCandidate(fbResult.moves, (candidate) => isFirstBlockSolved(candidate, ctx));
    if (picked?.choice?.afterPattern && isFirstBlockSolved(picked.choice.afterPattern, ctx)) {
      diagnostics.push({
        stage: "FB",
        method: picked.loose ? "beam-boundary-prefix-loose" : "beam-boundary-prefix",
        ok: true,
        nodes: 0,
        reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
      });
      return {
        ok: true,
        moves: picked.choice.moves,
        afterPattern: picked.choice.afterPattern,
        nodes: totalNodes,
        diagnostics,
      };
    }
  }

  const fbPhaseFallback = await findGoalPrefixViaPhaseSolve(
    startPattern,
    (candidate) => isFirstBlockSolved(candidate, ctx),
    {
      deadlineTs,
      phase1MaxDepth: 16,
      phase2MaxDepth: 24,
      timeCheckInterval: 1024,
      acceptPrefix: (_candidate, _prefixMoves, depth) =>
        depth <= DEFAULT_OPTIONS.fbPhasePrefixMaxMoves,
      allowFilteredFallback: false,
      selectPrefixScore: (candidate, prefixMoves, depth) =>
        scoreRouxStage(
          candidate.patternData,
          ctx.solvedData,
          ctx.firstBlockEntries,
          ctx.secondBlockOnlyEntries,
          depth,
          {
            targetMultiplier: 320,
            futurePenalty: 220,
            depthPenalty: 12,
          },
        ) - depth * 8,
    },
  );
  totalNodes += fbPhaseFallback.nodes;
  diagnostics.push({
    stage: "FB",
    method: fbPhaseFallback.method,
    nodes: fbPhaseFallback.nodes,
    ok: fbPhaseFallback.ok,
    reason: fbPhaseFallback.reason || "",
  });
  if (!fbPhaseFallback.ok || !Array.isArray(fbPhaseFallback.moves)) {
    const fbLoosePhaseFallback = await findGoalPrefixViaPhaseSolve(
      startPattern,
      (candidate) => isFirstBlockSolved(candidate, ctx),
    {
      deadlineTs,
      phase1MaxDepth: 16,
      phase2MaxDepth: 24,
      timeCheckInterval: 1024,
      acceptPrefix: (_candidate, _prefixMoves, depth) =>
        depth <= Math.max(48, DEFAULT_OPTIONS.fbPhasePrefixMaxMoves),
      allowFilteredFallback: true,
      allowFilteredWhen: () => true,
      selectPrefixScore: (candidate, prefixMoves, depth) =>
          scoreRouxStage(
            candidate.patternData,
            ctx.solvedData,
            ctx.firstBlockEntries,
            ctx.secondBlockOnlyEntries,
            depth,
            {
              targetMultiplier: 320,
              futurePenalty: 220,
              depthPenalty: 12,
            },
          ) - depth * 8,
      },
    );
    totalNodes += fbLoosePhaseFallback.nodes;
    diagnostics.push({
      stage: "FB",
      method: fbLoosePhaseFallback.method,
      nodes: fbLoosePhaseFallback.nodes,
      ok: fbLoosePhaseFallback.ok,
      reason: fbLoosePhaseFallback.reason || "",
    });
    if (!fbLoosePhaseFallback.ok || !Array.isArray(fbLoosePhaseFallback.moves)) {
      return {
        ok: false,
        moves: null,
        afterPattern: null,
        nodes: totalNodes,
        diagnostics,
        reason: "FB_RECOVERY_FAILED",
      };
    }
    const pickedLoose = pickCandidate(fbLoosePhaseFallback.moves, (candidate) => isFirstBlockSolved(candidate, ctx));
    if (!pickedLoose?.choice?.afterPattern || !isFirstBlockSolved(pickedLoose.choice.afterPattern, ctx)) {
      return {
        ok: false,
        moves: null,
        afterPattern: null,
        nodes: totalNodes,
        diagnostics,
        reason: "FB_RECOVERY_FAILED",
      };
    }
    diagnostics.push({
      stage: "FB",
      method: pickedLoose.loose ? "phase-prefix-boundary-prefix-loose" : "phase-prefix-boundary-prefix",
      ok: true,
      nodes: 0,
      reason: pickedLoose.choice.source === "raw" ? "" : `PREFIX_${String(pickedLoose.choice.source || "").toUpperCase()}`,
    });
    return {
      ok: true,
      moves: pickedLoose.choice.moves,
      afterPattern: pickedLoose.choice.afterPattern,
      nodes: totalNodes,
      diagnostics,
    };
  }

  const picked = pickCandidate(fbPhaseFallback.moves, (candidate) => isFirstBlockSolved(candidate, ctx));
  if (!picked?.choice?.afterPattern || !isFirstBlockSolved(picked.choice.afterPattern, ctx)) {
    return {
      ok: false,
      moves: null,
      afterPattern: null,
      nodes: totalNodes,
      diagnostics,
      reason: "FB_RECOVERY_FAILED",
    };
  }

  diagnostics.push({
    stage: "FB",
    method: picked.loose ? "phase-prefix-boundary-prefix-loose" : "phase-prefix-boundary-prefix",
    ok: true,
    nodes: 0,
    reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
  });
  return {
    ok: true,
    moves: picked.choice.moves,
    afterPattern: picked.choice.afterPattern,
    nodes: totalNodes,
    diagnostics,
  };
}

async function solveDedicatedSbRecoveryStage(startPattern, ctx, deadlineTs) {
  if (!startPattern) {
    return buildRecoveryStageResult("SB", "recovery-precheck", [], null, 0, "NO_PATTERN");
  }
  if (
    isSecondBlockSolved(startPattern, ctx) &&
    !isCmllSolved(startPattern, ctx) &&
    !isCubeSolved(startPattern, ctx)
  ) {
    return buildRecoveryStageResult("SB", "recovery-precheck", [], startPattern, 0, "PRE_SOLVED");
  }

  let totalNodes = 0;
  const diagnostics = [];
  const boundaryFn = (candidate) => !isCmllSolved(candidate, ctx) && !isCubeSolved(candidate, ctx);
  const looseBoundaryFn = (candidate) => !isCubeSolved(candidate, ctx);
  const pickCandidate = (moves, goalFn) => {
    const strictChoice = chooseBoundaryPreservingPrefix(startPattern, moves, goalFn, boundaryFn, {
      deadlineTs,
      maxPasses: 3,
      maxWindow: 8,
    });
    if (strictChoice) {
      return { choice: strictChoice, loose: false };
    }
    const looseChoice = chooseBoundaryPreservingPrefix(startPattern, moves, goalFn, looseBoundaryFn, {
      deadlineTs,
      maxPasses: 3,
      maxWindow: 8,
    });
    if (looseChoice) {
      return { choice: looseChoice, loose: true };
    }
    return null;
  };

  const sbCaseResult = tryCaseCandidatesStage(
    startPattern,
    ctx.caseDb?.sb?.table,
    (candidate) => buildEntriesStateKey(candidate, ctx.secondBlockEntries),
    (candidate) => isSecondBlockSolved(candidate, ctx),
    { deadlineTs },
  );
  totalNodes += sbCaseResult.nodes;
  diagnostics.push({
    stage: "SB",
    method: sbCaseResult.method,
    ok: sbCaseResult.ok,
    nodes: sbCaseResult.nodes,
    reason: sbCaseResult.reason || "",
    candidatesTried: sbCaseResult.candidatesTried || 0,
    candidatesTotal: sbCaseResult.candidatesTotal || 0,
    tableKeys: Number(ctx.caseDb?.sb?.meta?.keyCount || 0),
  });
  if (sbCaseResult.ok && Array.isArray(sbCaseResult.moves)) {
    const picked = pickCandidate(sbCaseResult.moves, (candidate) => isSecondBlockSolved(candidate, ctx));
    if (picked?.choice?.afterPattern && isSecondBlockSolved(picked.choice.afterPattern, ctx)) {
      diagnostics.push({
        stage: "SB",
        method: picked.loose ? "case-index-boundary-prefix-loose" : "case-index-boundary-prefix",
        ok: true,
        nodes: 0,
        reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
      });
      return {
        ok: true,
        moves: picked.choice.moves,
        afterPattern: picked.choice.afterPattern,
        nodes: totalNodes,
        diagnostics,
      };
    }
  }

  const sbAttempts = [
    { maxDepth: DEFAULT_OPTIONS.sbMaxDepth, beamWidth: DEFAULT_OPTIONS.sbBeamWidth },
    {
      maxDepth: Math.min(DEFAULT_OPTIONS.sbMaxDepth + 2, 14),
      beamWidth: Math.min(DEFAULT_OPTIONS.sbBeamWidth * 2, 1280),
    },
    {
      maxDepth: Math.min(DEFAULT_OPTIONS.sbMaxDepth + 4, 16),
      beamWidth: Math.min(DEFAULT_OPTIONS.sbBeamWidth * 4, 2000),
    },
  ];
  const sbResult = runAdaptiveBeamStage(
    startPattern,
    {
      isGoal: (candidate) => isSecondBlockSolved(candidate, ctx),
      score: (candidate, depth) =>
        scoreRouxStage(
          candidate.patternData,
          ctx.solvedData,
          ctx.secondBlockEntries,
          ctx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
          depth,
          {
            targetMultiplier: 300,
            futurePenalty: 70,
            depthPenalty: 12,
          },
        ),
      allowedMoves: ROUX_SB_MOVES,
      deadlineTs,
      keyFn: (candidate) => buildEntriesStateKey(candidate, ctx.secondBlockEntries),
    },
    sbAttempts,
  );
  totalNodes += sbResult.nodes;
  diagnostics.push(...sbResult.diagnostics.map((entry) => ({ stage: "SB", ...entry })));
  if (sbResult.ok && Array.isArray(sbResult.moves)) {
    const picked = pickCandidate(sbResult.moves, (candidate) => isSecondBlockSolved(candidate, ctx));
    if (picked?.choice?.afterPattern && isSecondBlockSolved(picked.choice.afterPattern, ctx)) {
      diagnostics.push({
        stage: "SB",
        method: picked.loose ? "beam-boundary-prefix-loose" : "beam-boundary-prefix",
        ok: true,
        nodes: 0,
        reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
      });
      return {
        ok: true,
        moves: picked.choice.moves,
        afterPattern: picked.choice.afterPattern,
        nodes: totalNodes,
        diagnostics,
      };
    }
  }

  const minedSb = await mineDedicatedSbAugmentation(startPattern, ctx, {
    deadlineTs,
    requireCmllBoundary: true,
  });
  if (minedSb && minedSb.afterPattern && isSecondBlockSolved(minedSb.afterPattern, ctx)) {
    totalNodes += Number(minedSb.nodes || 0);
    diagnostics.push({
      stage: "SB",
      method: "phase-prefix-mined",
      ok: true,
      nodes: Number(minedSb.nodes || 0),
      reason: "",
      moveCount: Array.isArray(minedSb.moves) ? minedSb.moves.length : 0,
    });
    return {
      ok: true,
      moves: simplifyMoves(minedSb.moves),
      afterPattern: minedSb.afterPattern,
      nodes: totalNodes,
      diagnostics,
    };
  }

  const sbPhaseFallback = await findGoalPrefixViaPhaseSolve(
    startPattern,
    (candidate) => isSecondBlockSolved(candidate, ctx),
    {
      deadlineTs,
      phase1MaxDepth: 16,
      phase2MaxDepth: 24,
      timeCheckInterval: 1024,
      acceptPrefix: (candidate, prefixMoves, depth) =>
        depth <= DEFAULT_OPTIONS.sbPhasePrefixMaxMoves &&
        !isCmllSolved(candidate, ctx) &&
        !isCubeSolved(candidate, ctx),
      allowFilteredFallback: false,
      selectPrefixScore: (candidate, prefixMoves, depth) =>
        scoreRouxStage(
          candidate.patternData,
          ctx.solvedData,
          ctx.secondBlockEntries,
          ctx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
          depth,
          {
            targetMultiplier: 320,
            futurePenalty: 90,
            depthPenalty: 14,
          },
        ) - depth * 8,
    },
  );
  totalNodes += sbPhaseFallback.nodes;
  diagnostics.push({
    stage: "SB",
    method: sbPhaseFallback.method,
    nodes: sbPhaseFallback.nodes,
    ok: sbPhaseFallback.ok,
    reason: sbPhaseFallback.reason || "",
  });
  if (!sbPhaseFallback.ok || !Array.isArray(sbPhaseFallback.moves)) {
    const sbLoosePhaseFallback = await findGoalPrefixViaPhaseSolve(
      startPattern,
      (candidate) => isSecondBlockSolved(candidate, ctx),
      {
        deadlineTs,
        phase1MaxDepth: 16,
        phase2MaxDepth: 24,
        timeCheckInterval: 1024,
        acceptPrefix: (candidate, prefixMoves, depth) =>
          depth <= Math.max(48, DEFAULT_OPTIONS.sbPhasePrefixMaxMoves) &&
          !isCubeSolved(candidate, ctx),
        allowFilteredFallback: true,
        allowFilteredWhen: (candidate) => !isCubeSolved(candidate, ctx),
        selectPrefixScore: (candidate, prefixMoves, depth) =>
          scoreRouxStage(
            candidate.patternData,
            ctx.solvedData,
            ctx.secondBlockEntries,
            ctx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
            depth,
            {
              targetMultiplier: 320,
              futurePenalty: 90,
              depthPenalty: 14,
            },
          ) - depth * 8,
      },
    );
    totalNodes += sbLoosePhaseFallback.nodes;
    diagnostics.push({
      stage: "SB",
      method: sbLoosePhaseFallback.method,
      nodes: sbLoosePhaseFallback.nodes,
      ok: sbLoosePhaseFallback.ok,
      reason: sbLoosePhaseFallback.reason || "",
    });
    if (!sbLoosePhaseFallback.ok || !Array.isArray(sbLoosePhaseFallback.moves)) {
      return {
        ok: false,
        moves: null,
        afterPattern: null,
        nodes: totalNodes,
        diagnostics,
        reason: "SB_RECOVERY_FAILED",
      };
    }
    const pickedLoose = pickCandidate(sbLoosePhaseFallback.moves, (candidate) => isSecondBlockSolved(candidate, ctx));
    if (!pickedLoose?.choice?.afterPattern || !isSecondBlockSolved(pickedLoose.choice.afterPattern, ctx)) {
      return {
        ok: false,
        moves: null,
        afterPattern: null,
        nodes: totalNodes,
        diagnostics,
        reason: "SB_RECOVERY_FAILED",
      };
    }
    diagnostics.push({
      stage: "SB",
      method: pickedLoose.loose ? "phase-prefix-boundary-prefix-loose" : "phase-prefix-boundary-prefix",
      ok: true,
      nodes: 0,
      reason: pickedLoose.choice.source === "raw" ? "" : `PREFIX_${String(pickedLoose.choice.source || "").toUpperCase()}`,
    });
    return {
      ok: true,
      moves: pickedLoose.choice.moves,
      afterPattern: pickedLoose.choice.afterPattern,
      nodes: totalNodes,
      diagnostics,
    };
  }

  const picked = pickCandidate(sbPhaseFallback.moves, (candidate) => isSecondBlockSolved(candidate, ctx));
  if (!picked?.choice?.afterPattern || !isSecondBlockSolved(picked.choice.afterPattern, ctx)) {
    return {
      ok: false,
      moves: null,
      afterPattern: null,
      nodes: totalNodes,
      diagnostics,
      reason: "SB_RECOVERY_FAILED",
    };
  }

  diagnostics.push({
    stage: "SB",
    method: picked.loose ? "phase-prefix-boundary-prefix-loose" : "phase-prefix-boundary-prefix",
    ok: true,
    nodes: 0,
    reason: picked.choice.source === "raw" ? "" : `PREFIX_${String(picked.choice.source || "").toUpperCase()}`,
  });
  return {
    ok: true,
    moves: picked.choice.moves,
    afterPattern: picked.choice.afterPattern,
    nodes: totalNodes,
    diagnostics,
  };
}

async function recoverRouxViaPhaseSolve(startPattern, ctx, options = {}) {
  const deadlineTs = options.deadlineTs;
  ensureDeadline(deadlineTs, "ROUX_RECOVERY_TIMEOUT");
  const remainingMs = Number.isFinite(deadlineTs)
    ? Math.max(1500, Math.min(45000, deadlineTs - Date.now()))
    : 30000;
  const phaseResult = await solve3x3InternalPhase(startPattern, {
    phase1MaxDepth: 13,
    phase2MaxDepth: 20,
    phase1NodeLimit: 0,
    phase2NodeLimit: 0,
    timeCheckInterval: 768,
    deadlineTs: Date.now() + remainingMs,
  });
  const recoveryNodes = Number(phaseResult?.nodes || 0);
  const recoveryDiagnostics = [];
  if (!phaseResult?.ok || typeof phaseResult.solution !== "string" || !phaseResult.solution.trim()) {
    return {
      ok: false,
      reason: phaseResult?.reason || "ROUX_RECOVERY_PHASE_FAILED",
      nodes: recoveryNodes,
      stageDiagnostics: [
        {
          stage: "RECOVERY",
          method: "phase-recovery",
          ok: false,
          nodes: recoveryNodes,
          reason: phaseResult?.reason || "ROUX_RECOVERY_PHASE_FAILED",
        },
      ],
    };
  }

  const tokens = splitAlgTokens(phaseResult.solution);
  const prefixStates = buildPrefixStates(startPattern, tokens, deadlineTs);
  if (!prefixStates || prefixStates.length !== tokens.length + 1) {
    return {
      ok: false,
      reason: "ROUX_RECOVERY_PREFIX_APPLY_FAILED",
      nodes: recoveryNodes,
      stageDiagnostics: [
        {
          stage: "RECOVERY",
          method: "phase-recovery",
          ok: false,
          nodes: recoveryNodes,
          reason: "ROUX_RECOVERY_PREFIX_APPLY_FAILED",
        },
      ],
    };
  }

  const solvedIndex = prefixStates.length - 1;
  const strictCuts = pickStrictRecoveryCuts(prefixStates, ctx);
  if (strictCuts) {
    const stageMoves = [
      tokens.slice(0, strictCuts.fb),
      tokens.slice(strictCuts.fb, strictCuts.sb),
      tokens.slice(strictCuts.sb, strictCuts.cmll),
      tokens.slice(strictCuts.cmll),
    ];
    return {
      ok: true,
      solution: joinAlgTokens(tokens),
      moveCount: tokens.length,
      nodes: recoveryNodes,
      stages: [
        { name: "FB", solution: joinAlgTokens(stageMoves[0]) },
        { name: "SB", solution: joinAlgTokens(stageMoves[1]) },
        { name: "CMLL", solution: joinAlgTokens(stageMoves[2]) },
        { name: "LSE", solution: joinAlgTokens(stageMoves[3]) },
      ],
      stageDiagnostics: [
        {
          stage: "FB",
          method: "phase-recovery",
          ok: true,
          cutIndex: strictCuts.fb,
          moveCount: stageMoves[0].length,
          reason: stageMoves[0].length ? "" : "PRE_SOLVED",
        },
        {
          stage: "SB",
          method: "phase-recovery",
          ok: true,
          cutIndex: strictCuts.sb,
          moveCount: stageMoves[1].length,
          reason: stageMoves[1].length ? "" : "PRE_SOLVED",
        },
        {
          stage: "CMLL",
          method: "phase-recovery",
          ok: true,
          cutIndex: strictCuts.cmll,
          moveCount: stageMoves[2].length,
          reason: stageMoves[2].length ? "" : "PRE_SOLVED",
        },
        {
          stage: "LSE",
          method: "phase-recovery",
          ok: true,
          cutIndex: strictCuts.solved,
          moveCount: stageMoves[3].length,
          reason: stageMoves[3].length ? "" : "PRE_SOLVED",
        },
      ],
      source: "INTERNAL_3X3_ROUX_PHASE_RECOVERY",
    };
  }

  const fbRecovery = await solveFbRecoveryStage(startPattern, ctx, deadlineTs);
  recoveryDiagnostics.push({
    stage: "RECOVERY",
    method: "fb-recovery-summary",
    ok: Boolean(fbRecovery?.ok),
    nodes: Number(fbRecovery?.nodes || 0),
    reason: fbRecovery?.reason || "",
    afterPattern: Boolean(fbRecovery?.afterPattern),
  });
  if (fbRecovery?.ok && fbRecovery.afterPattern) {
    const sbRecovery = await solveDedicatedSbRecoveryStage(fbRecovery.afterPattern, ctx, deadlineTs);
    recoveryDiagnostics.push({
      stage: "RECOVERY",
      method: "sb-recovery-summary",
      ok: Boolean(sbRecovery?.ok),
      nodes: Number(sbRecovery?.nodes || 0),
      reason: sbRecovery?.reason || "",
      afterPattern: Boolean(sbRecovery?.afterPattern),
    });
    if (sbRecovery?.ok && sbRecovery.afterPattern) {
      const cmllStage = await solveCmllRecoveryStage(sbRecovery.afterPattern, ctx, deadlineTs);
      if (cmllStage.ok && cmllStage.afterPattern) {
        const lseStage = await solveLseRecoveryStage(cmllStage.afterPattern, ctx, deadlineTs);
        if (lseStage.ok && lseStage.afterPattern) {
          const fbMoves = simplifyMoves(fbRecovery.moves || []);
          const sbMoves = simplifyMoves(sbRecovery.moves || []);
          const cmllMoves = simplifyMoves(cmllStage.moves || []);
          const lseMoves = simplifyMoves(lseStage.moves || []);
          const solutionMoves = simplifyMoves([...fbMoves, ...sbMoves, ...cmllMoves, ...lseMoves]);
          return {
            ok: true,
            solution: joinAlgTokens(solutionMoves),
            moveCount: solutionMoves.length,
            nodes:
              recoveryNodes +
              Number(fbRecovery.nodes || 0) +
              Number(sbRecovery.nodes || 0) +
              Number(cmllStage.nodes || 0) +
              Number(lseStage.nodes || 0),
            stages: [
              { name: "FB", solution: joinAlgTokens(fbMoves) },
              { name: "SB", solution: joinAlgTokens(sbMoves) },
              { name: "CMLL", solution: joinAlgTokens(cmllMoves) },
              { name: "LSE", solution: joinAlgTokens(lseMoves) },
            ],
            stageDiagnostics: [
              ...(fbRecovery.diagnostics || []),
              ...(sbRecovery.diagnostics || []),
              ...(cmllStage.diagnostics || []),
              ...(lseStage.diagnostics || []),
            ],
            source: "INTERNAL_3X3_ROUX_PHASE_RECOVERY_RESTAGED_FROM_FB",
          };
        }
      } else if (sbRecovery?.diagnostics) {
        recoveryDiagnostics.push(
          ...(fbRecovery.diagnostics || []).map((entry) => ({
            stage: "RECOVERY",
            via: "fb-recovery",
            ...entry,
          })),
          ...(sbRecovery.diagnostics || []).map((entry) => ({
            stage: "RECOVERY",
            via: "sb-recovery",
            ...entry,
          })),
        );
      }
    } else if (fbRecovery?.diagnostics) {
      recoveryDiagnostics.push(
        ...(fbRecovery.diagnostics || []).map((entry) => ({
          stage: "RECOVERY",
          via: "fb-recovery",
          ...entry,
        })),
      );
    }
  }

  if (!isCubeSolved(prefixStates[solvedIndex], ctx)) {
    return {
      ok: false,
      reason: "ROUX_RECOVERY_STAGE_PARTITION_FAILED",
      nodes: recoveryNodes,
      stageDiagnostics: [
        {
          stage: "RECOVERY",
          method: "phase-recovery",
          ok: false,
          nodes: recoveryNodes,
          reason: "ROUX_RECOVERY_STAGE_PARTITION_FAILED",
        },
      ],
    };
  }

  const fbCut = pickRecoveryFbCut(prefixStates, ctx);
  if (fbCut < 0) {
    return {
      ok: false,
      reason: "ROUX_RECOVERY_FB_CUT_FAILED",
      nodes: recoveryNodes,
      stageDiagnostics: recoveryDiagnostics.concat([
        {
          stage: "RECOVERY",
          method: "phase-recovery-restaged",
          ok: false,
          nodes: recoveryNodes,
          reason: "ROUX_RECOVERY_FB_CUT_FAILED",
        },
      ]),
    };
  }

  const fbMoves = tokens.slice(0, fbCut);
  const afterFbPattern = prefixStates[fbCut];
  if (!afterFbPattern || !isFirstBlockSolved(afterFbPattern, ctx)) {
    return {
      ok: false,
      reason: "ROUX_RECOVERY_FB_STATE_INVALID",
      nodes: recoveryNodes,
      stageDiagnostics: recoveryDiagnostics.concat([
        {
          stage: "RECOVERY",
          method: "phase-recovery-restaged",
          ok: false,
          nodes: recoveryNodes,
          reason: "ROUX_RECOVERY_FB_STATE_INVALID",
        },
      ]),
    };
  }

  let totalNodes = recoveryNodes;
  const stageDiagnostics = [
    {
      stage: "FB",
      method: "phase-recovery-restaged",
      ok: true,
      cutIndex: fbCut,
      moveCount: fbMoves.length,
      reason: fbMoves.length ? "" : "PRE_SOLVED",
    },
  ];

  let sbMoves = [];
  let afterSbPattern = null;

  const minedSb = await mineDedicatedSbAugmentation(afterFbPattern, ctx, {
    deadlineTs,
    requireCmllBoundary: true,
  });
  if (minedSb) {
    sbMoves = simplifyMoves(minedSb.moves);
    afterSbPattern = minedSb.afterPattern;
    totalNodes += Number(minedSb.nodes || 0);
    stageDiagnostics.push({
      stage: "SB",
      method: "phase-recovery-restaged-sb-mined",
      ok: true,
      nodes: Number(minedSb.nodes || 0),
      reason: "",
      moveCount: sbMoves.length,
    });
  } else {
    const looseSbCut = findFirstGoalIndex(
      prefixStates,
      fbCut + 1,
      (candidate) => isSecondBlockSolved(candidate, ctx) && !isCubeSolved(candidate, ctx),
    );
    if (looseSbCut < 0) {
      return {
        ok: false,
        reason: "ROUX_RECOVERY_SB_REBUILD_FAILED",
        nodes: totalNodes,
        stageDiagnostics: stageDiagnostics.concat(recoveryDiagnostics, [
          {
            stage: "SB",
            method: "phase-recovery-restaged",
            ok: false,
            nodes: 0,
            reason: "ROUX_RECOVERY_SB_REBUILD_FAILED",
          },
        ]),
      };
    }
    sbMoves = tokens.slice(fbCut, looseSbCut);
    afterSbPattern = prefixStates[looseSbCut];
    stageDiagnostics.push({
      stage: "SB",
      method: "phase-recovery-restaged-loose",
      ok: true,
      nodes: 0,
      reason: isCmllSolved(afterSbPattern, ctx) ? "CMLL_PRESOLVED" : "",
      cutIndex: looseSbCut,
      moveCount: sbMoves.length,
    });
  }

  if (!afterSbPattern || !isSecondBlockSolved(afterSbPattern, ctx)) {
    return {
      ok: false,
      reason: "ROUX_RECOVERY_SB_STATE_INVALID",
      nodes: totalNodes,
      stageDiagnostics: stageDiagnostics.concat(recoveryDiagnostics, [
        {
          stage: "SB",
          method: "phase-recovery-restaged",
          ok: false,
          nodes: 0,
          reason: "ROUX_RECOVERY_SB_STATE_INVALID",
        },
      ]),
    };
  }

  const cmllStage = await solveCmllRecoveryStage(afterSbPattern, ctx, deadlineTs);
  totalNodes += Number(cmllStage.nodes || 0);
  stageDiagnostics.push(...(cmllStage.diagnostics || []));
  if (!cmllStage.ok || !cmllStage.afterPattern) {
    return {
      ok: false,
      reason: cmllStage.reason || "CMLL_RECOVERY_FAILED",
      nodes: totalNodes,
      stageDiagnostics,
    };
  }

  const lseStage = await solveLseRecoveryStage(cmllStage.afterPattern, ctx, deadlineTs);
  totalNodes += Number(lseStage.nodes || 0);
  stageDiagnostics.push(...(lseStage.diagnostics || []));
  if (!lseStage.ok || !lseStage.afterPattern) {
    return {
      ok: false,
      reason: lseStage.reason || "LSE_RECOVERY_FAILED",
      nodes: totalNodes,
      stageDiagnostics,
    };
  }

  const stageMoves = [
    simplifyMoves(fbMoves),
    simplifyMoves(sbMoves),
    simplifyMoves(cmllStage.moves || []),
    simplifyMoves(lseStage.moves || []),
  ];
  const solutionMoves = simplifyMoves(stageMoves.flat());
  return {
    ok: true,
    solution: joinAlgTokens(solutionMoves),
    moveCount: solutionMoves.length,
    nodes: totalNodes,
    stages: [
      { name: "FB", solution: joinAlgTokens(stageMoves[0]) },
      { name: "SB", solution: joinAlgTokens(stageMoves[1]) },
      { name: "CMLL", solution: joinAlgTokens(stageMoves[2]) },
      { name: "LSE", solution: joinAlgTokens(stageMoves[3]) },
    ],
    stageDiagnostics,
    source: "INTERNAL_3X3_ROUX_PHASE_RECOVERY_RESTAGED",
  };
}

function getStageMoveLists(stages) {
  const byName = new Map();
  if (Array.isArray(stages)) {
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const name = String(stage?.name || "").trim().toUpperCase();
      if (!name) continue;
      byName.set(name, splitAlgTokens(stage?.solution || ""));
    }
  }
  return {
    fb: byName.get("FB") || [],
    sb: byName.get("SB") || [],
    cmll: byName.get("CMLL") || [],
    lse: byName.get("LSE") || [],
  };
}

function evaluateRouxStagePartition(startPattern, ctx, stages) {
  const moveLists = getStageMoveLists(stages);
  const afterFb = tryApplyMoves(startPattern, moveLists.fb);
  const afterSb = afterFb ? tryApplyMoves(afterFb, moveLists.sb) : null;
  const afterCmll = afterSb ? tryApplyMoves(afterSb, moveLists.cmll) : null;
  const afterLse = afterCmll ? tryApplyMoves(afterCmll, moveLists.lse) : null;

  const sbPreservesCmllBoundary =
    Boolean(afterSb) &&
    isSecondBlockSolved(afterSb, ctx) &&
    !isCmllSolved(afterSb, ctx) &&
    !isCubeSolved(afterSb, ctx);

  const fbAccepted =
    Boolean(afterFb) &&
    moveLists.fb.length > 0 &&
    isFirstBlockSolved(afterFb, ctx) &&
    !isSecondBlockSolved(afterFb, ctx) &&
    !isCubeSolved(afterFb, ctx);

  const sbAccepted =
    Boolean(afterSb) &&
    moveLists.sb.length > 0 &&
    isSecondBlockSolved(afterSb, ctx) &&
    !isCmllSolved(afterSb, ctx) &&
    !isCubeSolved(afterSb, ctx);

  const cmllAccepted =
    Boolean(afterCmll) &&
    moveLists.cmll.length > 0 &&
    isCmllSolved(afterCmll, ctx) &&
    !isCubeSolved(afterCmll, ctx);

  const lseAccepted = Boolean(afterLse) && isCubeSolved(afterLse, ctx);

  return {
    moveLists,
    states: {
      afterFb,
      afterSb,
      afterCmll,
      afterLse,
    },
    accepted: {
      fb: fbAccepted,
      sb: sbAccepted,
      sbPreservesCmllBoundary,
      cmll: cmllAccepted,
      lse: lseAccepted,
    },
  };
}

function scoreRouxAugmentationCandidate(candidate) {
  if (!candidate) return -Infinity;
  const accepted = candidate.accepted || {};
  let score = 0;
  if (accepted.fb) score += 250;
  if (accepted.sb) score += 1200;
  if (accepted.sbPreservesCmllBoundary) score += 180;
  if (accepted.cmll) score += 120;
  if (accepted.lse) score += 40;
  score -= Number(candidate.totalMoves || 0);
  score -= Number(candidate.phaseNodes || 0) * 0.00001;
  return score;
}

function buildRouxAugmentationCandidate(startPattern, planCtx, result, source) {
  const stages = Array.isArray(result?.stages) ? result.stages : [];
  const evaluation = evaluateRouxStagePartition(startPattern, planCtx, stages);
  const fbKey = buildEntriesStateKey(startPattern, planCtx.firstBlockEntries);
  const sbKey = evaluation.states.afterFb
    ? buildEntriesStateKey(evaluation.states.afterFb, planCtx.secondBlockEntries)
    : "";
  const candidate = {
    planName: planCtx.rouxPlan,
    source: source || result?.source || "INTERNAL_3X3_ROUX",
    phaseNodes: Number(result?.nodes || 0),
    totalMoves: Number(result?.moveCount || 0),
    stages,
    stageDiagnostics: Array.isArray(result?.stageDiagnostics) ? result.stageDiagnostics : [],
    accepted: evaluation.accepted,
    fb: {
      key: fbKey,
      moves: evaluation.moveLists.fb,
      text: joinAlgTokens(evaluation.moveLists.fb),
    },
    sb: {
      key: sbKey,
      moves: evaluation.moveLists.sb,
      text: joinAlgTokens(evaluation.moveLists.sb),
    },
  };
  candidate.score = scoreRouxAugmentationCandidate(candidate);
  return candidate;
}

async function mineDedicatedSbAugmentation(afterFbPattern, planCtx, options = {}) {
  if (!afterFbPattern || !isFirstBlockSolved(afterFbPattern, planCtx)) {
    return null;
  }

  const deadlineTs = options.deadlineTs;
  const requireCmllBoundary = options.requireCmllBoundary !== false;
  const phasePrefix = await findGoalPrefixViaPhaseSolve(
    afterFbPattern,
    (candidate) => isSecondBlockSolved(candidate, planCtx),
    {
      deadlineTs,
      phase1MaxDepth: 16,
      phase2MaxDepth: 24,
      timeCheckInterval: 1024,
      acceptPrefix: (candidate, prefixMoves, depth) =>
        depth <= 48 &&
        !isCubeSolved(candidate, planCtx) &&
        (!requireCmllBoundary || !isCmllSolved(candidate, planCtx)),
      allowFilteredFallback: false,
      selectPrefixScore: (candidate, prefixMoves, depth) =>
        scoreRouxStage(
          candidate.patternData,
          planCtx.solvedData,
          planCtx.secondBlockEntries,
          planCtx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
          depth,
          {
            targetMultiplier: 340,
            futurePenalty: 70,
            depthPenalty: 12,
          },
        ) +
        (!isCmllSolved(candidate, planCtx) ? 160 : 0) -
        depth * 6,
    },
  );

  if (!phasePrefix?.ok || !Array.isArray(phasePrefix.moves)) {
    return null;
  }

  const chosen = chooseBoundaryPreservingPrefix(
    afterFbPattern,
    phasePrefix.moves,
    (candidate) => isSecondBlockSolved(candidate, planCtx),
    requireCmllBoundary
      ? (candidate) =>
          !isCubeSolved(candidate, planCtx) && !isCmllSolved(candidate, planCtx)
      : () => true,
    {
      deadlineTs,
      maxPasses: 3,
      maxWindow: 8,
    },
  );
  const afterSbPattern = chosen?.afterPattern || null;
  const sbPreservesCmllBoundary =
    Boolean(afterSbPattern) &&
    isSecondBlockSolved(afterSbPattern, planCtx) &&
    !isCmllSolved(afterSbPattern, planCtx) &&
    !isCubeSolved(afterSbPattern, planCtx);
  if (
    !chosen ||
    !afterSbPattern ||
    !isSecondBlockSolved(afterSbPattern, planCtx) ||
    (requireCmllBoundary && !sbPreservesCmllBoundary)
  ) {
    return null;
  }

  return {
    key: buildEntriesStateKey(afterFbPattern, planCtx.secondBlockEntries),
    moves: chosen.moves,
    text: joinAlgTokens(chosen.moves),
    sbPreservesCmllBoundary,
    sourceMethod: chosen.source === "raw" ? "phase-prefix-mined" : `phase-prefix-mined-${chosen.source}`,
    afterPattern: afterSbPattern,
    nodes: Number(phasePrefix.nodes || 0),
  };
}

async function tryRuntimeDedicatedSbMine(afterFbPattern, planCtx, options = {}) {
  const mined = await mineDedicatedSbAugmentation(afterFbPattern, planCtx, {
    ...options,
    requireCmllBoundary: true,
  });
  if (mined) {
    return {
      ok: true,
      moves: mined.moves,
      afterPattern: mined.afterPattern,
      method: "phase-prefix-mined-runtime",
      reason: "",
      nodes: mined.nodes,
      sbPreservesCmllBoundary: mined.sbPreservesCmllBoundary,
    };
  }
  const relaxed = await mineDedicatedSbAugmentation(afterFbPattern, planCtx, {
    ...options,
    requireCmllBoundary: false,
  });
  if (relaxed) {
    return {
      ok: true,
      moves: relaxed.moves,
      afterPattern: relaxed.afterPattern,
      method: "phase-prefix-mined-runtime-relaxed",
      reason: "",
      nodes: relaxed.nodes,
      sbPreservesCmllBoundary: relaxed.sbPreservesCmllBoundary,
    };
  }
  return {
    ok: false,
    moves: null,
    method: "phase-prefix-mined-runtime",
    reason: "SB_MINER_NO_BOUNDARY",
    nodes: 0,
  };
}

export async function buildRouxAugmentationCandidatesFromPattern(pattern, options = {}) {
  if (!pattern?.patternData) {
    return {
      ok: false,
      reason: "ROUX_NO_PATTERN",
      candidates: [],
      best: null,
    };
  }

  const ctx = await getRouxContext();
  const rankedPlans = rankRouxBlockPlans(pattern, ctx);
  const hardDeadlineTs = Number.isFinite(options.deadlineTs)
    ? options.deadlineTs
    : Date.now() + 30000;
  const tryAlternate = options.tryAlternate !== false;
  const trySolveFirst = options.trySolveFirst !== false;
  const collectAllCandidates = options.collectAllCandidates === true;
  const maxCandidates = normalizePositiveInt(
    options.maxCandidates,
    collectAllCandidates ? Math.max(4, rankedPlans.length * 2) : 1,
  );
  const candidates = [];
  const errors = [];

  if (trySolveFirst) {
    const solveFirstBudgetFactor = Number.isFinite(options.solveFirstBudgetFactor)
      ? Math.min(1, Math.max(0.5, options.solveFirstBudgetFactor))
      : 0.9;
    const solveBudgetMs = Math.max(
      2500,
      Math.min(
        30000,
        Math.floor(Math.max(2500, hardDeadlineTs - Date.now()) * solveFirstBudgetFactor),
      ),
    );
    try {
      const solveResult = await solve3x3RouxFromPattern(pattern, {
        deadlineTs: Date.now() + solveBudgetMs,
        enableRecovery: true,
      });
      if (solveResult?.ok && Array.isArray(solveResult.stages) && solveResult.rouxPlan) {
        const plan = rankedPlans.find((entry) => entry.name === solveResult.rouxPlan) || rankedPlans[0];
        const planCtx = buildRouxPlanContext(ctx, plan);
        const candidate = buildRouxAugmentationCandidate(
          pattern,
          planCtx,
          solveResult,
          solveResult.source || "INTERNAL_3X3_ROUX",
        );
        if (candidate.accepted.fb && !candidate.accepted.sb && candidate.fb?.moves?.length) {
          const dedicatedSb = await mineDedicatedSbAugmentation(
            evaluateRouxStagePartition(pattern, planCtx, solveResult.stages).states.afterFb,
            planCtx,
            { deadlineTs: hardDeadlineTs },
          );
          if (dedicatedSb) {
            candidate.sb = {
              key: dedicatedSb.key,
              moves: dedicatedSb.moves,
              text: dedicatedSb.text,
            };
            candidate.accepted.sb = true;
            candidate.accepted.sbPreservesCmllBoundary = dedicatedSb.sbPreservesCmllBoundary;
            candidate.source = `${candidate.source}+SB_MINED`;
            candidate.score = scoreRouxAugmentationCandidate(candidate);
          }
        }
        candidates.push(candidate);
        if (!collectAllCandidates && candidate.accepted.sb) {
          candidates.sort((a, b) => b.score - a.score || a.totalMoves - b.totalMoves);
          return {
            ok: true,
            reason: "",
            candidates,
            best: candidates[0] || null,
            errors,
          };
        }
        if (candidates.length >= maxCandidates) {
          candidates.sort((a, b) => b.score - a.score || a.totalMoves - b.totalMoves);
          return {
            ok: candidates.some((candidate) => candidate.accepted?.fb || candidate.accepted?.sb),
            reason: "",
            candidates,
            best: candidates[0] || null,
            errors,
          };
        }
      }
    } catch (error) {
      errors.push({
        plan: "SOLVE_FIRST",
        reason: String(error?.code || error?.message || "ROUX_AUGMENT_SOLVE_FIRST_ERROR"),
      });
    }
  }

  for (let i = 0; i < rankedPlans.length; i++) {
    if (i > 0 && !tryAlternate) break;
    ensureDeadline(hardDeadlineTs, "ROUX_AUGMENT_TIMEOUT");
    const plan = rankedPlans[i];
    const planCtx = buildRouxPlanContext(ctx, plan);
    const plansLeft = Math.max(1, rankedPlans.length - i);
    const remainingMs = Math.max(1500, hardDeadlineTs - Date.now());
    const localDeadlineTs = Date.now() + Math.max(1500, Math.floor(remainingMs / plansLeft));

    try {
      const recovery = await recoverRouxViaPhaseSolve(pattern, planCtx, {
        deadlineTs: localDeadlineTs,
      });
      if (!recovery?.ok) {
        errors.push({
          plan: plan.name,
          reason: recovery?.reason || "ROUX_RECOVERY_PHASE_FAILED",
        });
        continue;
      }

      const candidate = buildRouxAugmentationCandidate(
        pattern,
        planCtx,
        recovery,
        recovery.source || "INTERNAL_3X3_ROUX_PHASE_RECOVERY",
      );
      candidate.heuristic = Number(plan.heuristic || 0);
      if (candidate.accepted.fb && !candidate.accepted.sb && candidate.fb?.moves?.length) {
        const dedicatedSb = await mineDedicatedSbAugmentation(
          evaluateRouxStagePartition(pattern, planCtx, recovery.stages).states.afterFb,
          planCtx,
          { deadlineTs: localDeadlineTs },
        );
        if (dedicatedSb) {
          candidate.sb = {
            key: dedicatedSb.key,
            moves: dedicatedSb.moves,
            text: dedicatedSb.text,
          };
          candidate.accepted.sb = true;
          candidate.accepted.sbPreservesCmllBoundary = dedicatedSb.sbPreservesCmllBoundary;
          candidate.source = `${candidate.source}+SB_MINED`;
        }
      }
      candidate.score = scoreRouxAugmentationCandidate(candidate);
      candidates.push(candidate);

      if (!collectAllCandidates && candidate.accepted.sb) {
        break;
      }
      if (candidates.length >= maxCandidates) {
        break;
      }
    } catch (error) {
      errors.push({
        plan: plan.name,
        reason: String(error?.code || error?.message || "ROUX_AUGMENT_ERROR"),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.totalMoves - b.totalMoves);
  return {
    ok: candidates.some((candidate) => candidate.accepted?.fb || candidate.accepted?.sb),
    reason: candidates.length ? "" : (errors[0]?.reason || "ROUX_AUGMENT_NO_CANDIDATES"),
    candidates,
    best: candidates[0] || null,
    errors,
  };
}

export async function solve3x3RouxFromPattern(pattern, options = {}) {
  if (!pattern?.patternData) {
    return buildFailure("ROUX_NO_PATTERN", "FB", 0, []);
  }

  const ctx = await getRouxContext();
  const deadlineTs = Number.isFinite(options.deadlineTs) ? options.deadlineTs : Date.now() + 20000;
  const stageDiagnostics = [];

  const cfg = {
    fbMaxDepth: normalizePositiveInt(options.fbMaxDepth, DEFAULT_OPTIONS.fbMaxDepth),
    fbBeamWidth: normalizePositiveInt(options.fbBeamWidth, DEFAULT_OPTIONS.fbBeamWidth),
    sbMaxDepth: normalizePositiveInt(options.sbMaxDepth, DEFAULT_OPTIONS.sbMaxDepth),
    sbBeamWidth: normalizePositiveInt(options.sbBeamWidth, DEFAULT_OPTIONS.sbBeamWidth),
    cmllMaxDepth: normalizePositiveInt(options.cmllMaxDepth, DEFAULT_OPTIONS.cmllMaxDepth),
    cmllBeamWidth: normalizePositiveInt(options.cmllBeamWidth, DEFAULT_OPTIONS.cmllBeamWidth),
    lseFormulaLimit: normalizePositiveInt(
      options.lseFormulaLimit,
      DEFAULT_OPTIONS.lseFormulaLimit,
    ),
    fbPhasePrefixMaxMoves: normalizePositiveInt(
      options.fbPhasePrefixMaxMoves,
      DEFAULT_OPTIONS.fbPhasePrefixMaxMoves,
    ),
    sbPhasePrefixMaxMoves: normalizePositiveInt(
      options.sbPhasePrefixMaxMoves,
      DEFAULT_OPTIONS.sbPhasePrefixMaxMoves,
    ),
  };

  const rankedPlans = rankRouxBlockPlans(pattern, ctx);
  const activePlan = rankedPlans[0];
  const alternatePlan = rankedPlans.find((plan) => plan.name !== activePlan?.name) || null;
  const enableRecovery = options.enableRecovery === true;
  const allowDeepFallback = enableRecovery;

  let rouxCtx = buildRouxPlanContext(ctx, activePlan);
  const alternateRouxCtx = alternatePlan ? buildRouxPlanContext(ctx, alternatePlan) : null;

  let currentPattern = pattern;
  let totalNodes = 0;
  const stages = [];
  const allMoves = [];
  const totalStages = 4;

  const recoverOrFail = async (reason, stageName) => {
    if (!enableRecovery) {
      return buildFailure(reason, stageName, totalNodes, stages, stageDiagnostics);
    }
    if (typeof options?.onStageUpdate === "function") {
      emitStageUpdate(options, {
        type: "fallback_start",
        stageName: "Roux Recovery",
        reason,
      });
    }
    try {
      const recovery = await recoverRouxViaPhaseSolve(pattern, rouxCtx, { deadlineTs });
      const combinedNodes = totalNodes + Number(recovery?.nodes || 0);
      if (recovery?.ok) {
        emitStageUpdate(options, {
          type: "fallback_done",
          stageName: "Roux Recovery",
        });
        return {
          ...recovery,
          nodes: combinedNodes,
          stageDiagnostics: stageDiagnostics.concat(recovery.stageDiagnostics || []),
          fallbackFrom: reason,
          rouxPlan: rouxCtx.rouxPlan,
        };
      }
      emitStageUpdate(options, {
        type: "fallback_fail",
        stageName: "Roux Recovery",
      });
      return buildFailure(
        reason,
        stageName,
        combinedNodes,
        stages,
        stageDiagnostics.concat(recovery?.stageDiagnostics || []),
      );
    } catch (recoveryError) {
      emitStageUpdate(options, {
        type: "fallback_fail",
        stageName: "Roux Recovery",
      });
      return buildFailure(
        reason,
        stageName,
        totalNodes,
        stages,
        stageDiagnostics.concat([
          {
            stage: "RECOVERY",
            method: "phase-recovery",
            ok: false,
            reason: String(recoveryError?.code || recoveryError?.message || "ROUX_RECOVERY_ERROR"),
          },
        ]),
      );
    }
  };

  try {
    ensureDeadline(deadlineTs, "ROUX_TIMEOUT");

    emitStageUpdate(options, {
      type: "stage_start",
      stageIndex: 0,
      totalStages,
      stageName: "FB",
    });
    const fbAttempts = allowDeepFallback
      ? [
          { maxDepth: cfg.fbMaxDepth, beamWidth: cfg.fbBeamWidth },
          {
            maxDepth: Math.min(cfg.fbMaxDepth + 2, 14),
            beamWidth: Math.min(cfg.fbBeamWidth * 2, 1280),
          },
        ]
      : [{ maxDepth: cfg.fbMaxDepth, beamWidth: cfg.fbBeamWidth }];
    let fbMoves = null;
    const fbCaseResult = tryCaseCandidatesStage(
      currentPattern,
      rouxCtx.caseDb?.fb?.table,
      (candidate) => buildEntriesStateKey(candidate, rouxCtx.firstBlockEntries),
      (candidate) => isFirstBlockSolved(candidate, rouxCtx),
      { deadlineTs },
    );
    totalNodes += fbCaseResult.nodes;
    stageDiagnostics.push({
      stage: "FB",
      plan: rouxCtx.rouxPlan,
      method: fbCaseResult.method,
      ok: fbCaseResult.ok,
      nodes: fbCaseResult.nodes,
      reason: fbCaseResult.reason || "",
      candidatesTried: fbCaseResult.candidatesTried || 0,
      candidatesTotal: fbCaseResult.candidatesTotal || 0,
      tableKeys: Number(rouxCtx.caseDb?.fb?.meta?.keyCount || 0),
    });
    if (fbCaseResult.ok && Array.isArray(fbCaseResult.moves)) {
      fbMoves = simplifyMoves(fbCaseResult.moves);
    }

    if (!fbMoves && alternateRouxCtx) {
      const alternateCaseResult = tryCaseCandidatesStage(
        currentPattern,
        alternateRouxCtx.caseDb?.fb?.table,
        (candidate) => buildEntriesStateKey(candidate, alternateRouxCtx.firstBlockEntries),
        (candidate) => isFirstBlockSolved(candidate, alternateRouxCtx),
        { deadlineTs },
      );
      totalNodes += alternateCaseResult.nodes;
      stageDiagnostics.push({
        stage: "FB",
        plan: alternateRouxCtx.rouxPlan,
        alt: true,
        method: alternateCaseResult.method,
        ok: alternateCaseResult.ok,
        nodes: alternateCaseResult.nodes,
        reason: alternateCaseResult.reason || "",
        candidatesTried: alternateCaseResult.candidatesTried || 0,
        candidatesTotal: alternateCaseResult.candidatesTotal || 0,
        tableKeys: Number(alternateRouxCtx.caseDb?.fb?.meta?.keyCount || 0),
      });
      if (alternateCaseResult.ok && Array.isArray(alternateCaseResult.moves)) {
        rouxCtx = alternateRouxCtx;
        fbMoves = simplifyMoves(alternateCaseResult.moves);
      }
    }

    if (!fbMoves) {
      const fbResult = runAdaptiveBeamStage(
        currentPattern,
        {
          isGoal: (candidate) => isFirstBlockSolved(candidate, rouxCtx),
          score: (candidate, depth) =>
            scoreRouxStage(
              candidate.patternData,
              rouxCtx.solvedData,
              rouxCtx.firstBlockEntries,
              rouxCtx.secondBlockOnlyEntries,
              depth,
              {
                targetMultiplier: 300,
                futurePenalty: 90,
                depthPenalty: 12,
              },
            ),
          allowedMoves: ROUX_FB_MOVES,
          deadlineTs,
          keyFn: (candidate) => buildEntriesStateKey(candidate, rouxCtx.firstBlockEntries),
        },
        fbAttempts,
      );
      totalNodes += fbResult.nodes;
      stageDiagnostics.push(
        ...fbResult.diagnostics.map((entry) => ({
          stage: "FB",
          plan: rouxCtx.rouxPlan,
          ...entry,
        })),
      );
      if (fbResult.ok && Array.isArray(fbResult.moves)) {
        fbMoves = simplifyMoves(fbResult.moves);
      }
    }

    if (!fbMoves && alternateRouxCtx) {
      const alternateFbResult = runAdaptiveBeamStage(
        currentPattern,
        {
          isGoal: (candidate) => isFirstBlockSolved(candidate, alternateRouxCtx),
          score: (candidate, depth) =>
            scoreRouxStage(
              candidate.patternData,
              alternateRouxCtx.solvedData,
              alternateRouxCtx.firstBlockEntries,
              alternateRouxCtx.secondBlockOnlyEntries,
              depth,
              {
                targetMultiplier: 300,
                futurePenalty: 90,
                depthPenalty: 12,
              },
            ),
          allowedMoves: ROUX_FB_MOVES,
          deadlineTs,
          keyFn: (candidate) => buildEntriesStateKey(candidate, alternateRouxCtx.firstBlockEntries),
        },
        fbAttempts,
      );
      totalNodes += alternateFbResult.nodes;
      stageDiagnostics.push(
        ...alternateFbResult.diagnostics.map((entry) => ({
          stage: "FB",
          plan: alternateRouxCtx.rouxPlan,
          alt: true,
          ...entry,
        })),
      );
      if (alternateFbResult.ok && Array.isArray(alternateFbResult.moves)) {
        rouxCtx = alternateRouxCtx;
        fbMoves = simplifyMoves(alternateFbResult.moves);
      }
    }
    if (!fbMoves) {
      if (!allowDeepFallback) {
        return recoverOrFail("FB_FAILED", "FB");
      }
      const fbPhaseFallback = await findGoalPrefixViaPhaseSolve(
        currentPattern,
        (candidate) => isFirstBlockSolved(candidate, rouxCtx),
        {
          deadlineTs,
          acceptPrefix: (candidate, prefixMoves, depth) =>
            depth <= cfg.fbPhasePrefixMaxMoves &&
            !isSecondBlockSolved(candidate, rouxCtx) &&
            !isCubeSolved(candidate, rouxCtx),
          allowFilteredFallback: false,
          selectPrefixScore: (candidate, prefixMoves, depth) =>
            scoreRouxStage(
              candidate.patternData,
              rouxCtx.solvedData,
              rouxCtx.firstBlockEntries,
              rouxCtx.secondBlockOnlyEntries,
              depth,
              {
                targetMultiplier: 320,
                futurePenalty: 120,
                depthPenalty: 14,
              },
            ) - depth * 8,
        },
      );
      totalNodes += fbPhaseFallback.nodes;
      stageDiagnostics.push({
        stage: "FB",
        method: fbPhaseFallback.method,
        nodes: fbPhaseFallback.nodes,
        ok: fbPhaseFallback.ok,
        reason: fbPhaseFallback.reason || "",
      });
      if (!fbPhaseFallback.ok || !Array.isArray(fbPhaseFallback.moves)) {
        return recoverOrFail("FB_FAILED", "FB");
      }
      fbMoves = optimizeGoalPrefixMoves(
        currentPattern,
        fbPhaseFallback.moves,
        (candidate) => isFirstBlockSolved(candidate, rouxCtx),
        {
          deadlineTs,
          maxPasses: 3,
          maxWindow: 8,
        },
      );
    } else {
      fbMoves = simplifyMoves(fbMoves);
    }

    currentPattern = tryApplyMoves(currentPattern, fbMoves);
    if (!currentPattern || !isFirstBlockSolved(currentPattern, rouxCtx)) {
      return recoverOrFail("FB_NOT_SOLVED", "FB");
    }
    stages.push({ name: "FB", solution: joinAlgTokens(fbMoves) });
    allMoves.push(...fbMoves);
    emitStageUpdate(options, {
      type: "stage_done",
      stageIndex: 0,
      totalStages,
      stageName: "FB",
      moveCount: fbMoves.length,
    });

    if (isCubeSolved(currentPattern, rouxCtx)) {
      stages.push({ name: "SB", solution: "" });
      stages.push({ name: "CMLL", solution: "" });
      stages.push({ name: "LSE", solution: "" });
      stageDiagnostics.push(
        {
          stage: "SB",
          method: "pre-solved",
          ok: true,
          nodes: 0,
          reason: "PRE_SOLVED",
        },
        {
          stage: "CMLL",
          method: "pre-solved",
          ok: true,
          nodes: 0,
          reason: "PRE_SOLVED",
        },
        {
          stage: "LSE",
          method: "pre-solved",
          ok: true,
          nodes: 0,
          reason: "PRE_SOLVED",
        },
      );
      return {
        ok: true,
        solution: joinAlgTokens(allMoves),
        moveCount: allMoves.length,
        nodes: totalNodes,
        stages,
        stageDiagnostics,
        rouxPlan: rouxCtx.rouxPlan,
        source: "INTERNAL_3X3_ROUX",
      };
    }

    ensureDeadline(deadlineTs, "ROUX_TIMEOUT");
    emitStageUpdate(options, {
      type: "stage_start",
      stageIndex: 1,
      totalStages,
      stageName: "SB",
    });
    let sbMoves = null;
    let sbAfterPattern = null;
    const runRuntimeSbMiner = async (trigger) => {
      const minedSb = await tryRuntimeDedicatedSbMine(currentPattern, rouxCtx, { deadlineTs });
      totalNodes += minedSb.nodes;
      stageDiagnostics.push({
        stage: "SB",
        method: minedSb.method,
        nodes: minedSb.nodes,
        ok: minedSb.ok,
        reason: minedSb.reason || "",
        trigger,
      });
      if (minedSb.ok && Array.isArray(minedSb.moves)) {
        sbMoves = simplifyMoves(minedSb.moves);
        sbAfterPattern = minedSb.afterPattern || tryApplyMoves(currentPattern, sbMoves);
        return true;
      }
      return false;
    };
    const sbCaseResult = tryCaseCandidatesStage(
      currentPattern,
      rouxCtx.caseDb?.sb?.table,
      (candidate) => buildEntriesStateKey(candidate, rouxCtx.secondBlockEntries),
      (candidate) => isSecondBlockSolved(candidate, rouxCtx),
      { deadlineTs },
    );
    totalNodes += sbCaseResult.nodes;
    stageDiagnostics.push({
      stage: "SB",
      method: sbCaseResult.method,
      ok: sbCaseResult.ok,
      nodes: sbCaseResult.nodes,
      reason: sbCaseResult.reason || "",
      candidatesTried: sbCaseResult.candidatesTried || 0,
      candidatesTotal: sbCaseResult.candidatesTotal || 0,
      tableKeys: Number(rouxCtx.caseDb?.sb?.meta?.keyCount || 0),
    });
    if (sbCaseResult.ok && Array.isArray(sbCaseResult.moves)) {
      sbMoves = simplifyMoves(sbCaseResult.moves);
    }
    if (!sbMoves) {
      const sbResult = runAdaptiveBeamStage(currentPattern, {
        isGoal: (candidate) => isSecondBlockSolved(candidate, rouxCtx),
        score: (candidate, depth) =>
          scoreRouxStage(
            candidate.patternData,
            rouxCtx.solvedData,
            rouxCtx.secondBlockEntries,
            rouxCtx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
            depth,
            {
              targetMultiplier: 300,
              futurePenalty: 70,
              depthPenalty: 12,
            },
          ),
        allowedMoves: ROUX_SB_MOVES,
        deadlineTs,
        keyFn: (candidate) => buildEntriesStateKey(candidate, rouxCtx.secondBlockEntries),
      }, allowDeepFallback
        ? [
            { maxDepth: cfg.sbMaxDepth, beamWidth: cfg.sbBeamWidth },
            {
              maxDepth: Math.min(cfg.sbMaxDepth + 2, 14),
              beamWidth: Math.min(cfg.sbBeamWidth * 2, 1280),
            },
            {
              maxDepth: Math.min(cfg.sbMaxDepth + 4, 16),
              beamWidth: Math.min(cfg.sbBeamWidth * 4, 2000),
            },
          ]
        : [{ maxDepth: cfg.sbMaxDepth, beamWidth: cfg.sbBeamWidth }]);
      totalNodes += sbResult.nodes;
      stageDiagnostics.push(...sbResult.diagnostics.map((entry) => ({ stage: "SB", ...entry })));
      if (sbResult.ok && Array.isArray(sbResult.moves)) {
        sbMoves = sbResult.moves;
      }
    }
    if (!sbMoves) {
      if (!allowDeepFallback) {
        return recoverOrFail("SB_FAILED", "SB");
      }
      const sbPhaseFallback = await findGoalPrefixViaPhaseSolve(
        currentPattern,
        (candidate) => isSecondBlockSolved(candidate, rouxCtx),
        {
          deadlineTs,
          phase1MaxDepth: allowDeepFallback ? 16 : 12,
          phase2MaxDepth: allowDeepFallback ? 24 : 18,
          timeCheckInterval: allowDeepFallback ? 1024 : 768,
          acceptPrefix: (candidate, _prefixMoves, depth) =>
            depth <= cfg.sbPhasePrefixMaxMoves &&
            !isCmllSolved(candidate, rouxCtx) &&
            !isCubeSolved(candidate, rouxCtx),
          allowFilteredFallback: false,
          selectPrefixScore: (candidate, prefixMoves, depth) =>
            scoreRouxStage(
              candidate.patternData,
              rouxCtx.solvedData,
              rouxCtx.secondBlockEntries,
              rouxCtx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
              depth,
              {
                targetMultiplier: 320,
                futurePenalty: 90,
                depthPenalty: 14,
              },
            ) - depth * 8,
        },
      );
      totalNodes += sbPhaseFallback.nodes;
      stageDiagnostics.push({
        stage: "SB",
        method: sbPhaseFallback.method,
        nodes: sbPhaseFallback.nodes,
        ok: sbPhaseFallback.ok,
        reason: sbPhaseFallback.reason || "",
      });
      if (sbPhaseFallback.ok && Array.isArray(sbPhaseFallback.moves)) {
        sbMoves = optimizeGoalPrefixMoves(
          currentPattern,
          sbPhaseFallback.moves,
          (candidate) => isSecondBlockSolved(candidate, rouxCtx),
          {
            deadlineTs,
            maxPasses: 2,
            maxWindow: 6,
          },
        );
        sbAfterPattern = tryApplyMoves(currentPattern, sbMoves);
      } else if (allowDeepFallback) {
        const minedBeforePhase = await runRuntimeSbMiner("post-beam");
        if (minedBeforePhase) {
          sbMoves = simplifyMoves(sbMoves);
          sbAfterPattern = tryApplyMoves(currentPattern, sbMoves);
        }
      }
      if (!sbMoves) {
        return recoverOrFail("SB_FAILED", "SB");
      }
    } else {
      sbMoves = simplifyMoves(sbMoves);
      sbAfterPattern = tryApplyMoves(currentPattern, sbMoves);
    }

    currentPattern = sbAfterPattern || tryApplyMoves(currentPattern, sbMoves);
    if (!currentPattern || !isSecondBlockSolved(currentPattern, rouxCtx)) {
      return recoverOrFail("SB_NOT_SOLVED", "SB");
    }
    stages.push({ name: "SB", solution: joinAlgTokens(sbMoves) });
    allMoves.push(...sbMoves);
    emitStageUpdate(options, {
      type: "stage_done",
      stageIndex: 1,
      totalStages,
      stageName: "SB",
      moveCount: sbMoves.length,
    });

    ensureDeadline(deadlineTs, "ROUX_TIMEOUT");
    emitStageUpdate(options, {
      type: "stage_start",
      stageIndex: 2,
      totalStages,
      stageName: "CMLL",
    });
    let cmllMoves = [];
    const cmllCaseResult = tryCaseCandidatesStage(
      currentPattern,
      rouxCtx.cmllCaseIndex?.table,
      (candidate) => buildCornersStateKey(candidate),
      (candidate) => isCmllSolved(candidate, rouxCtx),
      { deadlineTs },
    );
    totalNodes += cmllCaseResult.nodes;
    stageDiagnostics.push({
      stage: "CMLL",
      method: cmllCaseResult.method,
      ok: cmllCaseResult.ok,
      nodes: cmllCaseResult.nodes,
      reason: cmllCaseResult.reason || "",
      candidatesTried: cmllCaseResult.candidatesTried || 0,
      candidatesTotal: cmllCaseResult.candidatesTotal || 0,
      tableKeys: Number(rouxCtx.cmllCaseIndex?.meta?.keyCount || 0),
    });
    if (cmllCaseResult.ok && Array.isArray(cmllCaseResult.moves)) {
      cmllMoves = simplifyMoves(cmllCaseResult.moves);
    } else {
      const cmllFormulas = Array.isArray(rouxCtx.cmllFormulas) && rouxCtx.cmllFormulas.length
        ? rouxCtx.cmllFormulas
        : buildFormulaCandidates(
          Array.isArray(ROUX_FORMULAS?.CMLL) ? ROUX_FORMULAS.CMLL : [],
          { includeRotations: true },
        );
      const cmllFormulaResult = trySingleFormulaStage(
        currentPattern,
        cmllFormulas,
        (candidate) => isCmllSolved(candidate, rouxCtx),
        { deadlineTs },
      );
      totalNodes += cmllFormulaResult.nodes;
      if (cmllFormulaResult.ok && Array.isArray(cmllFormulaResult.moves)) {
        cmllMoves = simplifyMoves(cmllFormulaResult.moves);
      } else {
        const cmllBeam = beamSearchStage(currentPattern, {
          isGoal: (candidate) => isCmllSolved(candidate, rouxCtx),
          score: (candidate, depth) => {
            const data = candidate.patternData;
            const blockScore = scoreEntries(data, rouxCtx.solvedData, rouxCtx.secondBlockEntries);
            const topCornerScore = scoreTopCorners(data, rouxCtx.solvedData, rouxCtx.topCornerPositions);
            return blockScore * 80 + topCornerScore * 120 - depth;
          },
          allowedMoves: CMLL_BEAM_MOVES,
          maxDepth: cfg.cmllMaxDepth,
          beamWidth: cfg.cmllBeamWidth,
          deadlineTs,
          keyFn: (candidate) =>
            buildEntriesStateKey(
              candidate,
              rouxCtx.topCornerPositions.map((position) => ({ orbit: "CORNERS", position })),
            ),
        });
        totalNodes += cmllBeam.nodes;
        stageDiagnostics.push({
          stage: "CMLL",
          formulaNodes: cmllFormulaResult.nodes,
          beamNodes: cmllBeam.nodes,
          ok: cmllBeam.ok,
        });
        if (!cmllBeam.ok || !Array.isArray(cmllBeam.moves)) {
          if (!allowDeepFallback) {
            return recoverOrFail("CMLL_FAILED", "CMLL");
          }
          const cmllPhaseFallback = await findGoalPrefixViaPhaseSolve(
            currentPattern,
            (candidate) => isCmllSolved(candidate, rouxCtx),
            { deadlineTs },
          );
          totalNodes += cmllPhaseFallback.nodes;
          stageDiagnostics.push({
            stage: "CMLL",
            method: cmllPhaseFallback.method,
            nodes: cmllPhaseFallback.nodes,
            ok: cmllPhaseFallback.ok,
            reason: cmllPhaseFallback.reason || "",
          });
          if (!cmllPhaseFallback.ok || !Array.isArray(cmllPhaseFallback.moves)) {
            return recoverOrFail("CMLL_FAILED", "CMLL");
          }
          cmllMoves = simplifyMoves(cmllPhaseFallback.moves);
        } else {
          cmllMoves = simplifyMoves(cmllBeam.moves);
        }
      }
    }
    currentPattern = tryApplyMoves(currentPattern, cmllMoves);
    if (!currentPattern || !isCmllSolved(currentPattern, rouxCtx)) {
      return recoverOrFail("CMLL_NOT_SOLVED", "CMLL");
    }
    stages.push({ name: "CMLL", solution: joinAlgTokens(cmllMoves) });
    allMoves.push(...cmllMoves);
    emitStageUpdate(options, {
      type: "stage_done",
      stageIndex: 2,
      totalStages,
      stageName: "CMLL",
      moveCount: cmllMoves.length,
    });

    ensureDeadline(deadlineTs, "ROUX_TIMEOUT");
    emitStageUpdate(options, {
      type: "stage_start",
      stageIndex: 3,
      totalStages,
      stageName: "LSE",
    });

    let lseMoves = [];
    const lseCaseResult = tryCaseCandidatesStage(
      currentPattern,
      rouxCtx.lseCaseIndex?.table,
      (candidate) => buildStateKey(candidate),
      (candidate) => isCubeSolved(candidate, rouxCtx),
      { deadlineTs },
    );
    totalNodes += lseCaseResult.nodes;
    stageDiagnostics.push({
      stage: "LSE",
      method: lseCaseResult.method,
      nodes: lseCaseResult.nodes,
      ok: lseCaseResult.ok,
      reason: lseCaseResult.reason || "",
      candidatesTried: lseCaseResult.candidatesTried || 0,
      candidatesTotal: lseCaseResult.candidatesTotal || 0,
      tableKeys: Number(rouxCtx.lseCaseIndex?.meta?.keyCount || 0),
    });
    if (lseCaseResult.ok && Array.isArray(lseCaseResult.moves)) {
      lseMoves = simplifyMoves(lseCaseResult.moves);
    } else {
      const allLseFormulas = Array.isArray(rouxCtx.lseFormulas) && rouxCtx.lseFormulas.length
        ? rouxCtx.lseFormulas
        : buildFormulaCandidates(
          Array.isArray(ROUX_FORMULAS?.LSE) ? ROUX_FORMULAS.LSE : [],
          { includeRotations: false },
        );
      const lseFormulas = allLseFormulas.slice(0, Math.max(1, cfg.lseFormulaLimit));
      const lseFormulaResult = trySingleFormulaStage(
        currentPattern,
        lseFormulas,
        (candidate) => isCubeSolved(candidate, rouxCtx),
        { deadlineTs },
      );
      totalNodes += lseFormulaResult.nodes;
      if (lseFormulaResult.ok && Array.isArray(lseFormulaResult.moves)) {
        lseMoves = simplifyMoves(lseFormulaResult.moves);
        stageDiagnostics.push({
          stage: "LSE",
          method: "formula",
          nodes: lseFormulaResult.nodes,
          ok: true,
        });
      } else {
        if (!allowDeepFallback) {
          return recoverOrFail("LSE_FAILED", "LSE");
        }
        const remainingMs = Number.isFinite(deadlineTs) ? Math.max(500, deadlineTs - Date.now()) : 25000;
        const phaseResult = await solve3x3InternalPhase(currentPattern, {
          phase1MaxDepth: 13,
          phase2MaxDepth: 20,
          phase1NodeLimit: 0,
          phase2NodeLimit: 0,
          timeCheckInterval: 768,
          deadlineTs: Date.now() + remainingMs,
        });
        stageDiagnostics.push({
          stage: "LSE",
          method: "internal-phase",
          nodes: Number(phaseResult?.nodes || 0),
          ok: Boolean(phaseResult?.ok),
          reason: phaseResult?.reason || "",
        });
        totalNodes += Number(phaseResult?.nodes || 0);
        if (!phaseResult?.ok || phaseResult.solution == null) {
          return recoverOrFail("LSE_FAILED", "LSE");
        }
        lseMoves = simplifyMoves(splitAlgTokens(phaseResult.solution));
      }
    }

    currentPattern = tryApplyMoves(currentPattern, lseMoves);
    if (!currentPattern || !isCubeSolved(currentPattern, rouxCtx)) {
      if (!allowDeepFallback) {
        return recoverOrFail("LSE_RECOVERY_FAILED", "LSE");
      }
      const lseRecovery = await solveLseRecoveryStage(currentPattern, rouxCtx, deadlineTs);
      totalNodes += Number(lseRecovery.nodes || 0);
      stageDiagnostics.push(...(lseRecovery.diagnostics || []));
      if (lseRecovery.ok && lseRecovery.afterPattern && isCubeSolved(lseRecovery.afterPattern, rouxCtx)) {
        lseMoves = simplifyMoves(lseRecovery.moves);
        currentPattern = lseRecovery.afterPattern;
      } else {
        return recoverOrFail("LSE_RECOVERY_FAILED", "LSE");
      }
    }
    stages.push({ name: "LSE", solution: joinAlgTokens(lseMoves) });
    allMoves.push(...lseMoves);
    emitStageUpdate(options, {
      type: "stage_done",
      stageIndex: 3,
      totalStages,
      stageName: "LSE",
      moveCount: lseMoves.length,
    });

    return {
      ok: true,
      solution: joinAlgTokens(allMoves),
      moveCount: allMoves.length,
      nodes: totalNodes,
      stages,
      stageDiagnostics,
      rouxPlan: rouxCtx.rouxPlan,
      source: "INTERNAL_3X3_ROUX",
    };
  } catch (error) {
    const reason = String(error?.code || error?.message || "ROUX_ERROR");
    return recoverOrFail(reason, "ROUX");
  }
}
