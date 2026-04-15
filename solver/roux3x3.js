/**
 * Pure Roux 3x3 Solver - FB → SB → CMLL → LSE
 * 
 * FB: Beam search (all moves)
 * SB: Beam search (FB-preserving moves: U, R, M, r)
 * CMLL: Algorithm lookup + IDA* search
 * LSE: Algorithm lookup + IDA* search
 * 
 * Phase solver fallback when beam search fails
 * 
 * Piece indices (verified via cubing.js kpuzzle):
 *   U → corners [0,1,2,3], edges [0,1,2,3]
 *   D → corners [4,5,6,7], edges [4,5,6,7]
 *   L → corners [2,3,5,6], edges [3,7,9,11]
 *   R → corners [0,1,4,7], edges [1,5,8,10]
 *   F → corners [0,3,4,5], edges [0,4,8,9]
 *   B → corners [1,2,6,7], edges [2,6,10,11]
 *   M → edges [0,2,4,6]
 */

import { 
  buildAllPruneTables,
  getFBPruneHeuristic, 
  getSBPruneHeuristic,
  encodeFBCornerState, encodeFBEdgeState,
  encodeSBCornerState, encodeSBEdgeState,
  encodeLSEState, getMCenterState, LSE_MOVES,
  applyMoveToCornerEnc, applyMoveToEdgeEnc, applyMoveToLSEEnc,
} from './rouxPruneTables.js';

// ============================================================
// Prune Table Cache
// ============================================================
let pruneTables = null;

async function ensurePruneTables(getDefaultPatternFn) {
  if (!pruneTables) pruneTables = await buildAllPruneTables(getDefaultPatternFn);
}


// FB (First Block) = DL 1x2x3 block
//   Corners: DLF(5), DLB(6)  — intersection of D[4,5,6,7] ∩ L[2,3,5,6]
//   Edges:   DL(7), FL(9), BL(11)  — L edges[3,7,9,11] minus U edges[0,1,2,3]
const FB_CORNERS = [5, 6];
const FB_EDGES   = [7, 9, 11];

// SB (Second Block) = DR 1x2x3 block
//   Corners: DRF(4), DRB(7)  — intersection of D[4,5,6,7] ∩ R[0,1,4,7]
//   Edges:   DR(5), FR(8), BR(10)  — R edges[1,5,8,10] minus U edges[0,1,2,3]
const SB_CORNERS = [4, 7];
const SB_EDGES   = [5, 8, 10];

// CMLL = U-layer corners (all 4, after FB+SB are solved)
const CMLL_CORNERS = [0, 1, 2, 3];

// LSE = M-slice edges: UF(0), UB(2), DF(4), DB(6)
const LSE_EDGES = [0, 2, 4, 6];

// ============================================================
// Move Sets
// ============================================================

const ALL_MOVES = ["U", "U'", "U2", "D", "D'", "D2", "R", "R'", "R2", "L", "L'", "L2", "F", "F'", "F2", "B", "B'", "B2"];

// SB_MOVES: only moves that do NOT break FB
// FB pieces are only moved by L, D, F, B face turns
// Safe for SB: U, R, M, r (r = R + M combined, doesn't touch L/D/F/B pieces)
const SB_MOVES = ["U", "U'", "U2", "R", "R'", "R2", "M", "M'", "M2", "r", "r'", "r2"];

// CMLL_MOVES: R, U (standard CMLL moves, preserve both blocks)
// Some CMLL algs also use F/L but those are handled via alg lookup
const CMLL_MOVES = ["U", "U'", "U2", "R", "R'", "R2", "L", "L'", "L2", "F", "F'", "F2"];

// LSE_MOVES defined in rouxPruneTables.js (imported above): ["U","U'","U2","M","M'","M2"]
// This ordering defines the face groups for compact IDA*: group 0=U, group 1=M
const LSE_FALLBACK_MOVES = ["M", "M'", "M2", "U", "U'", "U2"]; // for beam/IDA* fallback only

// ============================================================
// Stage Detection
// ============================================================

function isFBSolved(p, s) {
  const d = p.patternData, sv = s.patternData;
  for (const i of FB_CORNERS) {
    if (d.CORNERS.pieces[i] !== sv.CORNERS.pieces[i] || d.CORNERS.orientation[i] !== sv.CORNERS.orientation[i]) return false;
  }
  for (const i of FB_EDGES) {
    if (d.EDGES.pieces[i] !== sv.EDGES.pieces[i] || d.EDGES.orientation[i] !== sv.EDGES.orientation[i]) return false;
  }
  return true;
}

function isSBSolvedOnly(p, s) {
  // Check ONLY SB pieces (assumes FB is already solved)
  const d = p.patternData, sv = s.patternData;
  for (const i of SB_CORNERS) {
    if (d.CORNERS.pieces[i] !== sv.CORNERS.pieces[i] || d.CORNERS.orientation[i] !== sv.CORNERS.orientation[i]) return false;
  }
  for (const i of SB_EDGES) {
    if (d.EDGES.pieces[i] !== sv.EDGES.pieces[i] || d.EDGES.orientation[i] !== sv.EDGES.orientation[i]) return false;
  }
  return true;
}

function isSBSolved(p, s) {
  return isFBSolved(p, s) && isSBSolvedOnly(p, s);
}

function isCMLLSolvedOnly(p, s) {
  // Check ONLY CMLL corners (assumes FB+SB already solved)
  const d = p.patternData, sv = s.patternData;
  for (const i of CMLL_CORNERS) {
    if (d.CORNERS.pieces[i] !== sv.CORNERS.pieces[i] || d.CORNERS.orientation[i] !== sv.CORNERS.orientation[i]) return false;
  }
  return true;
}

function isCMLLSolved(p, s) {
  return isSBSolved(p, s) && isCMLLSolvedOnly(p, s);
}

function isCubeSolved(p, s) { return p.isIdentical(s); }

// ============================================================
// Scoring Functions
// ============================================================

function scoreFB(pattern, solved) {
  if (pruneTables) {
    const h = getFBPruneHeuristic(pattern, pruneTables);
    if (h < 99) return 1000 - h * 10;
  }
  // Fallback piece counting (0–750), stays below prune-table range (920–1000)
  const d = pattern.patternData, s = solved.patternData;
  let score = 0;
  for (const i of FB_CORNERS) {
    if (d.CORNERS.pieces[i] === s.CORNERS.pieces[i]) {
      score += 100;
      if (d.CORNERS.orientation[i] === s.CORNERS.orientation[i]) score += 50;
    }
  }
  for (const i of FB_EDGES) {
    if (d.EDGES.pieces[i] === s.EDGES.pieces[i]) {
      score += 100;
      if (d.EDGES.orientation[i] === s.EDGES.orientation[i]) score += 50;
    }
  }
  return score;
}

function scoreSB(pattern, solved) {
  if (pruneTables) {
    const h = getSBPruneHeuristic(pattern, pruneTables);
    if (h < 99) return 1000 - h * 10;
  }
  // Fallback piece counting (0–750), stays below prune-table range (920–1000)
  const d = pattern.patternData, s = solved.patternData;
  let score = 0;
  // Only SB pieces - FB is already preserved by move set
  for (const i of SB_CORNERS) {
    if (d.CORNERS.pieces[i] === s.CORNERS.pieces[i]) {
      score += 100;
      if (d.CORNERS.orientation[i] === s.CORNERS.orientation[i]) score += 50;
    }
  }
  for (const i of SB_EDGES) {
    if (d.EDGES.pieces[i] === s.EDGES.pieces[i]) {
      score += 100;
      if (d.EDGES.orientation[i] === s.EDGES.orientation[i]) score += 50;
    }
  }
  return score;
}

function scoreCMLL(pattern, solved) {
  const d = pattern.patternData, s = solved.patternData;
  let score = 0;
  // CMLL corners: primary target (high weight)
  for (const i of CMLL_CORNERS) {
    if (d.CORNERS.pieces[i] === s.CORNERS.pieces[i]) {
      score += 200;
      if (d.CORNERS.orientation[i] === s.CORNERS.orientation[i]) score += 100;
    }
  }
  // Reduced penalty for broken FB/SB: CMLL algs (especially L-based) temporarily disrupt them.
  // Use a lighter weight so the beam still explores those paths.
  for (const i of [...FB_CORNERS, ...SB_CORNERS]) {
    if (d.CORNERS.pieces[i] === s.CORNERS.pieces[i]) score += 75;
  }
  for (const i of [...FB_EDGES, ...SB_EDGES]) {
    if (d.EDGES.pieces[i] === s.EDGES.pieces[i]) score += 75;
  }
  return score;
}

function scoreLSE(pattern, solved) {
  const d = pattern.patternData, s = solved.patternData;
  let score = 0;
  // All 8 corners must stay solved during LSE (M, U moves only)
  for (let i = 0; i < 8; i++) {
    if (d.CORNERS.pieces[i] === s.CORNERS.pieces[i]) score += 200;
  }
  // Non-M-slice edges: keep them solved (high weight)
  for (let i = 0; i < 12; i++) {
    if (!LSE_EDGES.includes(i) && d.EDGES.pieces[i] === s.EDGES.pieces[i]) {
      score += 200;
    }
  }
  // M-slice edges (UF=0, UB=2, DF=4, DB=6)
  for (const i of LSE_EDGES) {
    if (d.EDGES.pieces[i] === s.EDGES.pieces[i]) {
      score += 100;
      if (d.EDGES.orientation[i] === s.EDGES.orientation[i]) score += 50;
    }
  }
  return score;
}

// ============================================================
// Beam Search
// ============================================================

function beamSearch(startPattern, solvedPattern, isGoal, allowedMoves, maxDepth, beamWidth, deadlineTs, scoreFn) {
  if (isGoal(startPattern, solvedPattern)) {
    return { ok: true, moves: [], pattern: startPattern, nodes: 0 };
  }

  let beam = [{ pattern: startPattern, moves: [], score: scoreFn(startPattern, solvedPattern) }];
  let nodes = 0;
  const seen = new Set([stateKeyPartial(startPattern)]);

  for (let depth = 0; depth < maxDepth; depth++) {
    if (Date.now() > deadlineTs) return { ok: false, moves: null, nodes, reason: "TIMEOUT" };

    const nextBeam = [];

    for (const state of beam) {
      const lastMove = state.moves.length > 0 ? state.moves[state.moves.length - 1] : null;
      const lastFace = lastMove ? moveFace(lastMove) : null;
      
      for (const move of allowedMoves) {
        const face = moveFace(move);
        if (lastFace === face) continue;

        let nextPattern;
        try { nextPattern = state.pattern.applyAlg(move); } catch { continue; }

        const key = stateKeyPartial(nextPattern);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes++;

        if (isGoal(nextPattern, solvedPattern)) {
          return { ok: true, moves: [...state.moves, move], pattern: nextPattern, nodes };
        }

        const score = scoreFn(nextPattern, solvedPattern);
        nextBeam.push({ pattern: nextPattern, moves: [...state.moves, move], score });
      }
    }

    nextBeam.sort((a, b) => b.score - a.score);
    beam = nextBeam.slice(0, beamWidth);
    if (beam.length === 0) break;
  }

  return { ok: false, moves: null, nodes, reason: "NOT_FOUND" };
}

// Extract the face from a move (handles r, M, etc.)
function moveFace(move) {
  return move[0];
}

// State key including orientations to avoid skipping valid states
function stateKeyPartial(pattern) {
  const d = pattern.patternData;
  return d.CORNERS.pieces.join(",") + "|" + d.CORNERS.orientation.join(",") + "|" + d.EDGES.pieces.join(",") + "|" + d.EDGES.orientation.join(",");
}

// ============================================================
// CMLL Algorithm Database
// Complete set covering all 42 CMLL cases + common AUF variants
// Algs use only U, R, L, F moves to preserve FB+SB blocks
// ============================================================

const CMLL_ALGS = [
  // Complete set of 42 CMLL cases (speedcubedb canonical algorithms)
  // H cases
  "R U R' U R U' R' U R U2' R'",                // H Columns
  "F U R U' R' U R U' R' U R U' R' F'",         // H Rows
  "F U R U' R' U R U2' R' U' R U R' F' U'",     // H Column
  "r' F R F' r U' R' U' R U' R' U",             // H Row
  // Pi cases
  "F U R U' R' U R U' R' F'",                   // Pi Right Bar
  "R U2 R' U' R U R' U2' R' F R F' U'",         // Pi Down Slash
  "F U R U' R' U F' U' R' F' R U",              // Pi X
  "F R' F' R U2 R U' R' U R U2' R'",            // Pi Up Slash
  "r U' r2' D' r U' r' D r2 U r' U",            // Pi Columns
  "R' U2' R U R' F R' F' R U R U",              // Pi Left Bar
  // U cases
  "R U2' R D R' U2' R D' R2' U2'",              // U Up Slash
  "R' U2' R' D' R U2' R' D R2",                 // U Down Slash
  "R' F' R U R2' F2' U' F' U F' R2",            // U Bottom Row
  "F U R2 D R' U' R D' R2' F' U",               // U Rows
  "r' D' r U r' D r U' r U r' U2'",             // U X
  "F U R U' R' F' U",                           // U Upper Row
  // T cases
  "F R' F' r U R U' r' U",                      // T Left Bar
  "F' L F l' U' L' U l U'",                     // T Right Bar
  "F2' R U' R' U R U R2' F' R F'",              // T Rows
  "R' F R' F' R2 U2 r' U' r",                   // T Bottom Row
  "r U' r' U r' D' r U' r' D r",                // T Top Row
  "R' U R2 D r' U2' r D' R2' U' R",             // T Columns
  // Sune cases
  "R U2' R' U' R U' R' U'",                     // Sune Left Bar
  "F' L F L' U2 L' U2' L U'",                   // Sune X
  "R U2 R' U2' R' F R F' U'",                   // Sune Up Slash
  "R2 D R' U R D' R' U R' U' R U' R'",          // Sune Columns
  "R U2 R' F R' F' R U' R U' R' U",             // Sune Right Bar
  "L' U R U' L U R' U'",                        // Sune Down Slash
  // Anti-Sune cases
  "R' U2 R U R' U R U'",                        // Anti Sune Right Bar
  "R U R' U R U' R D R' U' R D' R2' U",         // Anti Sune Columns
  "L' U2' L U2 L F' L' F U",                    // Anti Sune Down Slash
  "F R' F' R U2' R U2 R' U",                    // Anti Sune X
  "R U' L' U R' U' L U",                        // Anti Sune Up Slash
  "R' U' F R' F' R U' R U R' U R",              // Anti Sune Left Bar
  // L cases
  "R' U' R' D' R U R' D R2",                    // L Best
  "r U R' U' r' F R F' U2'",                    // L Good
  "R U R' U R U' R' U R U' R' U R U2' R'",      // L Pure
  "F R' F' R U2' F R' F' R U' R U' R'",         // L Front Commutator
  "R2' F' R U R U' R' F R U' R' U R",           // L Diagonal
  "R2' D' R U2' R' D R U2' R U'",               // L Back Commutator
  // O cases
  "R U R2' F' R U R U' R' F R U' R'",           // O Adjacent
  "F R' F' R U R U' R' F R U' R' U R U R' F'",  // O Diagonal

  // --- Additional algorithms for broader coverage ---
  "R U R' U R U2 R'",                           // Sune
  "R U2 R' U' R U' R'",                         // Anti-Sune
  "L' U' L U' L' U2 L",                         // Sune mirror
  "L' U2 L U L' U L",                           // Anti-Sune mirror
  "R U R' U' R' F R F'",
  "L' U' L U L F' L' F",
  "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R",
  "R' F' R U R U' R' F",
  "F R' F' R U R U' R'",
  "R U R' U R U' R' F' R U R' U' F",
  "R' U' R' F R F' U R",
  "R U2 R' U' R U' R' L' U2 L U L' U L",
  "R U R' U R U2 R' L' U' L U' L' U2 L",
  "R' F R F' R U R' U' F' R U R'",
  "R U R' F' R U R' U' R' F R2 U' R'",
  "R U R' U' R' F R2 U' R' U' R U R' F'",
  "R' U L U' R U L'",
  "R U' L' U R' U' L",
];

// ============================================================
// LSE Algorithm Database  
// Complete set: M-slice last 6 edges (UF,UB,DF,DB + UR,UL positions)
// LSE uses only M and U moves (M=middle slice, clockwise from front)
// ============================================================

const LSE_ALGS = [
  // EO cases (edge orientation)
  "M U M'",
  "M' U M",
  "M U' M'",
  "M' U' M",
  "M U2 M'",
  "M' U2 M",
  "M2 U M2 U2 M2 U M2",
  "M2 U M2",
  "M2 U' M2",
  "M2 U2 M2",
  // Full LSE algorithms (4b full set)
  "M' U M' U M' U2 M U M U M",
  "M' U' M' U' M' U2 M U' M U' M",
  "M2 U2 M' U2 M2",
  "M' U2 M U2 M' U2 M",
  "M U2 M' U2 M U2 M'",
  // 4b partial cases
  "M' U' M U",
  "M' U M U'",
  "M U M' U'",
  "M U' M' U",
  "U M' U2 M",
  "U' M U2 M'",
  "U M U2 M'",
  "U' M' U2 M",
  "U2 M U2 M'",
  "U2 M' U2 M",
  // EOLR/UBLB cases
  "M' U2 M U2 M' U M",
  "M U2 M' U2 M U' M'",
  "M' U M U2 M' U' M",
  "M U' M' U2 M U M'",
  "M' U M U M' U2 M U' M U",
  "M U' M' U' M U2 M' U M' U'",
  "M2 U M U M' U M2 U M U2 M'",
  "M2 U' M' U' M U' M2 U' M' U2 M",
];

// ============================================================
// Helper: Solve with algorithm lookup + IDA* search
// ============================================================

async function solveWithAlgs(startPattern, solvedPattern, isGoal, knownAlgs, allowedMoves, maxDepth, beamWidth, deadlineTs, scoreFn, stageName) {
  if (isGoal(startPattern, solvedPattern)) {
    return { ok: true, moves: [], pattern: startPattern, nodes: 0 };
  }

  // Try known algorithms (with all 4 AUF variants before and after)
  if (knownAlgs && knownAlgs.length > 0) {
    const AUF = ["", "U", "U'", "U2"];
    for (const alg of knownAlgs) {
      if (Date.now() > deadlineTs) break;
      for (const preAuf of AUF) {
        const fullAlg = [preAuf, alg].filter(Boolean).join(" ");
        try {
          const after = startPattern.applyAlg(fullAlg);
          if (isGoal(after, solvedPattern)) {
            console.log(`[Roux] ${stageName}: Algorithm lookup`);
            return { ok: true, moves: fullAlg.split(/\s+/).filter(Boolean), pattern: after, nodes: 0 };
          }
          // Also try with postAUF
          for (const postAuf of ["U", "U'", "U2"]) {
            const fullAlg2 = [preAuf, alg, postAuf].filter(Boolean).join(" ");
            try {
              const after2 = startPattern.applyAlg(fullAlg2);
              if (isGoal(after2, solvedPattern)) {
                console.log(`[Roux] ${stageName}: Algorithm lookup (AUF)`);
                return { ok: true, moves: fullAlg2.split(/\s+/).filter(Boolean), pattern: after2, nodes: 0 };
              }
            } catch {}
          }
        } catch {}
      }
    }
  }

  // IDA* search only for very small move sets (e.g. LSE with 6 moves).
  // For CMLL (12 moves) IDA* at depth 12 is too slow — skip to beam search.
  if (allowedMoves.length <= 6 && maxDepth <= 16) {
    console.log(`[Roux] ${stageName}: IDA* search (max depth ${maxDepth})`);
    const idaResult = idaSearch(startPattern, solvedPattern, isGoal, allowedMoves, maxDepth, deadlineTs);
    if (idaResult.ok) return idaResult;
  }

  // Beam search fallback
  console.log(`[Roux] ${stageName}: Beam search (depth=${maxDepth}, beam=${beamWidth})`);
  return beamSearch(startPattern, solvedPattern, isGoal, allowedMoves, maxDepth, beamWidth, deadlineTs, scoreFn);
}

// IDA* : complete search (finds solution if exists within maxDepth)
function idaSearch(startPattern, solvedPattern, isGoal, allowedMoves, maxDepth, deadlineTs) {
  let nodes = 0;
  const checkInterval = 1000;
  function dfs(pattern, moves, depth) {
    if (nodes % checkInterval === 0 && Date.now() > deadlineTs) return null;
    if (isGoal(pattern, solvedPattern)) return moves;
    if (depth === 0) return null;
    const lastMove = moves.length > 0 ? moves[moves.length - 1] : null;
    const lastFace = lastMove ? moveFace(lastMove) : null;
    const secondLastMove = moves.length > 1 ? moves[moves.length - 2] : null;
    const secondLastFace = secondLastMove ? moveFace(secondLastMove) : null;
    for (const move of allowedMoves) {
      const face = moveFace(move);
      if (face === lastFace) continue;
      // Skip redundant opposite-face pairs (e.g. D after U after D)
      if (face === secondLastFace && lastFace === oppositeOf(face)) continue;
      nodes++;
      let next;
      try { next = pattern.applyAlg(move); } catch { continue; }
      const result = dfs(next, [...moves, move], depth - 1);
      if (result !== null) return result;
    }
    return null;
  }
  for (let d = 1; d <= maxDepth; d++) {
    if (Date.now() > deadlineTs) break;
    const result = dfs(startPattern, [], d);
    if (result !== null) return { ok: true, moves: result, pattern: startPattern.applyAlg(result.join(" ")), nodes };
  }
  return { ok: false, reason: "IDA_NOT_FOUND", nodes };
}

function oppositeOf(face) {
  const opp = { U: "D", D: "U", R: "L", L: "R", F: "B", B: "F", M: null };
  return opp[face] || null;
}

// ============================================================
// IDA* in compact prune-table state space (fast: ~50ns/node)
// ============================================================

function fbIDASearch(startPattern, tables) {
  if (!tables) return { ok: false, reason: "no_tables", nodes: 0 };
  const { fbCornerTable, fbEdgeTable, fbSolvedCornerEnc, fbSolvedEdgeEnc, allMovesTrans } = tables;
  const { cornerPerm, cornerTwist, edgePerm, edgeFlip } = allMovesTrans;
  const nMoves = ALL_MOVES.length;
  const MAX_DEPTH = 14;
  const moveSeq = new Int8Array(MAX_DEPTH);
  let nodes = 0;
  let foundDepth = -1;

  const initCEnc = encodeFBCornerState(startPattern.patternData);
  const initEEnc = encodeFBEdgeState(startPattern.patternData);
  if (initCEnc === fbSolvedCornerEnc && initEEnc === fbSolvedEdgeEnc) {
    return { ok: true, moves: [], pattern: startPattern, nodes: 0 };
  }

  function dfs(depth, maxDepth, cEnc, eEnc, lastFG) {
    if (cEnc === fbSolvedCornerEnc && eEnc === fbSolvedEdgeEnc) {
      foundDepth = depth; return true;
    }
    const h = Math.max(fbCornerTable.get(cEnc) ?? 0, fbEdgeTable.get(eEnc) ?? 0);
    if (depth + h > maxDepth) return false;
    nodes++;
    for (let mi = 0; mi < nMoves; mi++) {
      const fg = (mi / 3) | 0;
      if (fg === lastFG) continue;
      moveSeq[depth] = mi;
      if (dfs(depth + 1, maxDepth,
          applyMoveToCornerEnc(cEnc, mi, cornerPerm, cornerTwist),
          applyMoveToEdgeEnc(eEnc, mi, edgePerm, edgeFlip),
          fg)) return true;
    }
    return false;
  }

  const initH = Math.max(fbCornerTable.get(initCEnc) ?? 0, fbEdgeTable.get(initEEnc) ?? 0);
  for (let bound = initH; bound <= MAX_DEPTH; bound++) {
    if (dfs(0, bound, initCEnc, initEEnc, -1)) {
      const moves = Array.from(moveSeq.slice(0, foundDepth)).map(mi => ALL_MOVES[mi]);
      const resultPattern = moves.length ? startPattern.applyAlg(moves.join(" ")) : startPattern;
      return { ok: true, moves, pattern: resultPattern, nodes };
    }
    if (nodes > 3_000_000) break;
  }
  return { ok: false, reason: "IDA_LIMIT", nodes };
}

function sbIDASearch(startPattern, tables) {
  if (!tables) return { ok: false, reason: "no_tables", nodes: 0 };
  const { sbCornerTable, sbEdgeTable, sbSolvedCornerEnc, sbSolvedEdgeEnc, sbMovesTrans } = tables;
  const { cornerPerm, cornerTwist, edgePerm, edgeFlip } = sbMovesTrans;
  const nMoves = SB_MOVES.length;
  const MAX_DEPTH = 18;
  const moveSeq = new Int8Array(MAX_DEPTH);
  let nodes = 0;
  let foundDepth = -1;

  const initCEnc = encodeSBCornerState(startPattern.patternData);
  const initEEnc = encodeSBEdgeState(startPattern.patternData);
  if (initCEnc === sbSolvedCornerEnc && initEEnc === sbSolvedEdgeEnc) {
    return { ok: true, moves: [], pattern: startPattern, nodes: 0 };
  }

  function dfs(depth, maxDepth, cEnc, eEnc, lastFG) {
    if (cEnc === sbSolvedCornerEnc && eEnc === sbSolvedEdgeEnc) {
      foundDepth = depth; return true;
    }
    const h = Math.max(sbCornerTable.get(cEnc) ?? 0, sbEdgeTable.get(eEnc) ?? 0);
    if (depth + h > maxDepth) return false;
    nodes++;
    for (let mi = 0; mi < nMoves; mi++) {
      const fg = (mi / 3) | 0;
      if (fg === lastFG) continue;
      moveSeq[depth] = mi;
      if (dfs(depth + 1, maxDepth,
          applyMoveToCornerEnc(cEnc, mi, cornerPerm, cornerTwist),
          applyMoveToEdgeEnc(eEnc, mi, edgePerm, edgeFlip),
          fg)) return true;
    }
    return false;
  }

  const initH = Math.max(sbCornerTable.get(initCEnc) ?? 0, sbEdgeTable.get(initEEnc) ?? 0);
  for (let bound = initH; bound <= MAX_DEPTH; bound++) {
    if (dfs(0, bound, initCEnc, initEEnc, -1)) {
      const moves = Array.from(moveSeq.slice(0, foundDepth)).map(mi => SB_MOVES[mi]);
      const resultPattern = moves.length ? startPattern.applyAlg(moves.join(" ")) : startPattern;
      return { ok: true, moves, pattern: resultPattern, nodes };
    }
    if (nodes > 5_000_000) break;
  }
  return { ok: false, reason: "IDA_LIMIT", nodes };
}

function lseIDASearch(startPattern, tables) {
  if (!tables?.lseTable) return { ok: false, reason: "no_tables", nodes: 0 };
  const { lseTable, lseSolvedEnc, lseMovesTrans: { lsePerm, lseFlip, uDelta, mDelta } } = tables;
  const nMoves = 6; // LSE_MOVES length
  const MAX_DEPTH = 14;
  const moveSeq = new Int8Array(MAX_DEPTH);
  let nodes = 0, foundDepth = -1;

  // Full encoding = (edgeEnc<<4) | (mCenter<<2) | uRot
  // After CMLL: corners are solved → uRot=0
  // Centers may be shifted by r/r' moves in SB → read actual mCenter from pattern
  const edgeEnc = encodeLSEState(startPattern.patternData);
  const mCenter = getMCenterState(startPattern.patternData);
  const initEnc = (edgeEnc << 4) | (mCenter << 2);
  if (initEnc === lseSolvedEnc) {
    return { ok: true, moves: [], pattern: startPattern, nodes: 0 };
  }

  function dfs(depth, maxDepth, enc, lastFG) {
    if (enc === lseSolvedEnc) { foundDepth = depth; return true; }
    const h = lseTable.get(enc) ?? 0;
    if (depth + h > maxDepth) return false;
    nodes++;
    for (let mi = 0; mi < nMoves; mi++) {
      const fg = (mi / 3) | 0; // 0=U group, 1=M group
      if (fg === lastFG) continue;
      moveSeq[depth] = mi;
      if (dfs(depth + 1, maxDepth, applyMoveToLSEEnc(enc, mi, lsePerm, lseFlip, uDelta, mDelta), fg)) return true;
    }
    return false;
  }

  const initH = lseTable.get(initEnc) ?? 0;
  for (let bound = initH; bound <= MAX_DEPTH; bound++) {
    if (dfs(0, bound, initEnc, -1)) {
      const moves = Array.from(moveSeq.slice(0, foundDepth)).map(mi => LSE_MOVES[mi]);
      const resultPattern = moves.length ? startPattern.applyAlg(moves.join(" ")) : startPattern;
      return { ok: true, moves, pattern: resultPattern, nodes };
    }
    if (nodes > 5_000_000) break;
  }
  return { ok: false, reason: "LSE_IDA_LIMIT", nodes };
}

// Rotation to apply (via conjugation) so that the selected face becomes D for the FB.
// Matches the first rotation candidate used by CFOP for each cross color.
const ROUX_FACE_ROTATION = {
  D: "",
  U: "x2",
  F: "x",
  B: "x'",
  R: "z'",
  L: "z",
};

const ROTATION_INVERSE = {
  "x": "x'", "x'": "x", "x2": "x2",
  "z": "z'", "z'": "z", "z2": "z2",
  "y": "y'", "y'": "y", "y2": "y2",
};

// Conjugation: R^{-1} * P * R — transforms the pattern into the rotated reference frame
// so the standard DL 1x2x3 FB solver targets the selected face.
function transformPatternForRouxFace(pattern, solvedPattern, rotationAlg) {
  if (!rotationAlg) return pattern;
  try {
    const patternTransform = pattern.experimentalToTransformation();
    const rotationTransform = solvedPattern.applyAlg(rotationAlg).experimentalToTransformation();
    return rotationTransform.invert()
      .applyTransformation(patternTransform)
      .applyTransformation(rotationTransform)
      .toKPattern();
  } catch (_) {
    return null;
  }
}

// ============================================================
// Main Solve Function - FB → SB → CMLL → LSE
// ============================================================

export async function solve3x3RouxFromPattern(pattern, options = {}) {
  const { getDefaultPattern } = await import('./context.js');
  await ensurePruneTables(getDefaultPattern);
  const solvedPattern = await getDefaultPattern("333");

  // Apply a rotation (via conjugation) so the selected cross color face is treated as D.
  const rawCrossColor = String(options.crossColor || "D").toUpperCase();
  const colorKey =
    rawCrossColor === "CN" || rawCrossColor === "COLOR_NEUTRAL" ? "D" : rawCrossColor;
  const preRotation = ROUX_FACE_ROTATION[colorKey] ?? "";

  const workingPattern = preRotation
    ? transformPatternForRouxFace(pattern, solvedPattern, preRotation)
    : pattern;

  if (!workingPattern) {
    return { ok: false, reason: "CROSS_COLOR_TRANSFORM_FAILED", source: "INTERNAL_3X3_ROUX" };
  }

  const result = await _solveRouxFromPattern(workingPattern, options, solvedPattern);

  if (result?.ok && preRotation) {
    const invRotation = ROTATION_INVERSE[preRotation] || "";
    const rotMoves = preRotation.split(" ").filter(Boolean);
    const solMoves = result.solution ? result.solution.split(/\s+/).filter(Boolean) : [];
    const invMoves = invRotation ? invRotation.split(" ").filter(Boolean) : [];
    const combined = simplifyMoves([...rotMoves, ...solMoves, ...invMoves]);
    return {
      ...result,
      solution: combined.join(" "),
      moveCount: combined.length,
    };
  }
  return result;
}

async function _solveRouxFromPattern(pattern, options = {}, solvedPatternArg) {
  const deadlineTs = options.deadlineTs || Date.now() + 60000;
  const stageDeadlineMs = 6000; // Max time per Roux stage before fallback

  const { getDefaultPattern } = await import('./context.js');
  await ensurePruneTables(getDefaultPattern);
  const solvedPattern = solvedPatternArg || await getDefaultPattern("333");

  let currentPattern = pattern;
  const stages = [];
  const allMoves = [];
  let totalNodes = 0;

  // ============================================================
  // Stage 1: FB (IDA* in compact state space)
  // ============================================================
  console.log("[Roux] === FB ===");
  let fbResult = fbIDASearch(currentPattern, pruneTables);
  console.log(`[Roux] FB IDA*: ${fbResult.ok ? "OK" : fbResult.reason} (${fbResult.nodes} nodes)`);
  if (!fbResult.ok) {
    // IDA* exceeded node limit — fall back to beam search
    const fbDeadline = Math.min(deadlineTs, Date.now() + stageDeadlineMs);
    const fbAttempts = [
      { maxDepth: 10, beamWidth: 10000 },
      { maxDepth: 12, beamWidth: 20000 },
    ];
    for (let i = 0; i < fbAttempts.length; i++) {
      const remaining = fbDeadline - Date.now();
      if (remaining < 500) break;
      const attempt = fbAttempts[i];
      fbResult = beamSearch(currentPattern, solvedPattern, isFBSolved, ALL_MOVES, attempt.maxDepth, attempt.beamWidth, Math.min(fbDeadline, Date.now() + remaining / (fbAttempts.length - i)), scoreFB);
      console.log(`[Roux] FB beam fallback: ${fbResult.ok ? "OK" : fbResult.reason} (${fbResult.nodes} nodes)`);
      if (fbResult.ok) break;
    }
  }
  if (!fbResult || !fbResult.ok) {
    console.log("[Roux] FB beam failed, using phase solver fallback...");
    return await phaseSolverFallback(pattern, deadlineTs);
  }

  currentPattern = fbResult.pattern;
  stages.push({ name: "FB", solution: fbResult.moves.join(" ") || "(skip)" });
  allMoves.push(...fbResult.moves);
  totalNodes += fbResult.nodes;
  console.log(`[Roux] ✓ FB: ${fbResult.moves.join(" ")} (${fbResult.moves.length} moves)\n`);

  // ============================================================
  // Stage 2: SB (IDA* in compact state space, FB-preserving moves)
  // ============================================================
  console.log("[Roux] === SB ===");
  let sbResult = sbIDASearch(currentPattern, pruneTables);
  console.log(`[Roux] SB IDA*: ${sbResult.ok ? "OK" : sbResult.reason} (${sbResult.nodes} nodes)`);
  if (!sbResult.ok) {
    // IDA* exceeded node limit — fall back to beam search
    const sbDeadline = Math.min(deadlineTs, Date.now() + stageDeadlineMs);
    const sbGoal = (p, s) => isSBSolvedOnly(p, s) && isFBSolved(p, s);
    const sbAttempts = [
      { maxDepth: 14, beamWidth: 24000 },
      { maxDepth: 16, beamWidth: 40000 },
    ];
    for (let i = 0; i < sbAttempts.length; i++) {
      const remaining = sbDeadline - Date.now();
      if (remaining < 500) break;
      const attempt = sbAttempts[i];
      sbResult = beamSearch(currentPattern, solvedPattern, sbGoal, SB_MOVES, attempt.maxDepth, attempt.beamWidth, Math.min(sbDeadline, Date.now() + remaining / (sbAttempts.length - i)), scoreSB);
      console.log(`[Roux] SB beam fallback: ${sbResult.ok ? "OK" : sbResult.reason} (${sbResult.nodes} nodes)`);
      if (sbResult.ok) break;
    }
  }
  // Verify FB is still solved after SB moves (SB_MOVES are FB-preserving by construction)
  if (sbResult.ok && !isFBSolved(sbResult.pattern, solvedPattern)) {
    console.warn("[Roux] SB broke FB — retrying with beam + FB check");
    sbResult.ok = false;
  }
  
  if (!sbResult || !sbResult.ok) {
    console.log("[Roux] SB beam failed, using phase solver fallback...");
    return await phaseSolverFallback(pattern, deadlineTs);
  }

  currentPattern = sbResult.pattern;
  stages.push({ name: "SB", solution: sbResult.moves.join(" ") || "(skip)" });
  allMoves.push(...sbResult.moves);
  totalNodes += sbResult.nodes;
  console.log(`[Roux] ✓ SB: ${sbResult.moves.join(" ")} (${sbResult.moves.length} moves)\n`);

  // ============================================================
  // Stage 3: CMLL (algorithm lookup + IDA*)
  // CMLL algs preserve FB+SB by design, but arbitrary IDA* sequences 
  // of R/L/F/U can break the blocks. So we verify full state.
  // ============================================================
  console.log("[Roux] === CMLL ===");
  const cmllDeadline = Math.min(deadlineTs, Date.now() + stageDeadlineMs);
  
  // Use full isCMLLSolved (checks FB+SB+CMLL corners all correct)
  const cmllGoal = (p, s) => isCMLLSolved(p, s);
  
  const cmllResult = await solveWithAlgs(
    currentPattern, solvedPattern, cmllGoal, CMLL_ALGS, CMLL_MOVES,
    14, 15000, cmllDeadline, scoreCMLL, "CMLL"
  );
  if (!cmllResult.ok) {
    console.log(`[Roux] CMLL failed (${cmllResult.reason}), using phase solver fallback...`);
    return await phaseSolverFallback(pattern, deadlineTs);
  }
  
  currentPattern = cmllResult.pattern;
  stages.push({ name: "CMLL", solution: cmllResult.moves.join(" ") || "(skip)" });
  allMoves.push(...cmllResult.moves);
  totalNodes += cmllResult.nodes;
  console.log(`[Roux] ✓ CMLL: ${cmllResult.moves.join(" ")} (${cmllResult.moves.length} moves)\n`);

  // ============================================================
  // Stage 4: LSE (compact IDA* in state space — fast)
  // ============================================================
  console.log("[Roux] === LSE ===");
  let lseResult = lseIDASearch(currentPattern, pruneTables);
  console.log(`[Roux] LSE IDA*: ${lseResult.ok ? "OK" : lseResult.reason} (${lseResult.nodes} nodes)`);
  if (!lseResult.ok) {
    // IDA* limit exceeded — fall back to pattern-based search
    const lseDeadline = Math.min(deadlineTs, Date.now() + stageDeadlineMs);
    lseResult = await solveWithAlgs(
      currentPattern, solvedPattern, isCubeSolved, LSE_ALGS, LSE_FALLBACK_MOVES,
      14, 8000, lseDeadline, scoreLSE, "LSE"
    );
  }
  if (!lseResult.ok) {
    console.log("[Roux] LSE failed, using phase solver fallback...");
    return await phaseSolverFallback(pattern, deadlineTs);
  }
  
  currentPattern = lseResult.pattern;
  stages.push({ name: "LSE", solution: lseResult.moves.join(" ") || "(skip)" });
  allMoves.push(...lseResult.moves);
  totalNodes += lseResult.nodes;
  console.log(`[Roux] ✓ LSE: ${lseResult.moves.join(" ")} (${lseResult.moves.length} moves)\n`);

  // Verify
  if (!isCubeSolved(currentPattern, solvedPattern)) {
    return { ok: false, reason: "FINAL_NOT_SOLVED", stages, nodes: totalNodes, source: "INTERNAL_3X3_ROUX" };
  }

  const finalMoves = simplifyMoves(allMoves);
  console.log(`[Roux] ✅ Solution: ${finalMoves.join(" ")} (${finalMoves.length} moves)`);

  return {
    ok: true,
    solution: finalMoves.join(" "),
    moveCount: finalMoves.length,
    nodes: totalNodes,
    stages,
    source: "INTERNAL_3X3_ROUX",
  };
}

// ============================================================
// Phase Solver Fallback (with Roux stage extraction)
// ============================================================

async function phaseSolverFallback(pattern, deadlineTs) {
  // Strategy 1: Phase solver with generous settings
  try {
    const { solve3x3InternalPhase } = await import('./solver3x3Phase/index.js');
    // Always give phase solver at least 20s regardless of overall deadline
    const phaseDeadline = Math.max(deadlineTs, Date.now() + 20000);
    const phaseResult = await solve3x3InternalPhase(pattern, {
      deadlineTs: phaseDeadline,
      phase1MaxDepth: 15,
      phase2MaxDepth: 22,
      phase1NodeLimit: 0,
      phase2NodeLimit: 0,
    });
    if (phaseResult?.ok && phaseResult.solution) {
      return formatFallbackResult(pattern, phaseResult);
    }
    console.log(`[Roux] Phase solver failed: ${phaseResult?.reason}`);
  } catch (e) {
    console.log(`[Roux] Phase fallback error: ${e.message}`);
  }
  
  // Strategy 2: CFOP solver (handles broader scramble space)
  try {
    const [{ getDefaultPattern }, { solve3x3StrictCfopFromPattern }] = await Promise.all([
      import('./context.js'),
      import('./cfop3x3.js'),
    ]);
    const solved = await getDefaultPattern("333");
    const cfopDeadline = Math.max(deadlineTs, Date.now() + 20000);
    const cfopResult = await solve3x3StrictCfopFromPattern(pattern, {
      deadlineTs: cfopDeadline,
    });
    if (cfopResult?.ok && cfopResult.solution) {
      return formatFallbackResult(pattern, cfopResult);
    }
    console.log(`[Roux] CFOP fallback failed: ${cfopResult?.reason}`);
  } catch (e) {
    console.log(`[Roux] CFOP fallback error: ${e.message}`);
  }
  
  // Strategy 3: External solver (cubing.js)
  try {
    const { solveWithExternalSearch } = await import('./externalSolver.js');
    const extResult = await solveWithExternalSearch(null, "333", pattern);
    if (extResult?.ok && extResult.solution) {
      return formatFallbackResult(pattern, extResult);
    }
  } catch (e) {
    console.log(`[Roux] External fallback error: ${e.message}`);
  }
  
  return {
    ok: false,
    reason: "ROUX_FAILED",
    stages: [],
    nodes: 0,
    source: "INTERNAL_3X3_ROUX",
    message: "Could not solve using Roux method"
  };
}

async function formatFallbackResult(pattern, solverResult) {
  const phaseMoves = solverResult.solution.split(/\s+/).filter(Boolean);
  console.log(`[Roux] ✓ Fallback solver: ${phaseMoves.length} moves`);
  
  // Try to extract Roux stages from the solution
  const { getDefaultPattern } = await import('./context.js');
  const solvedPattern = await getDefaultPattern("333");
  const extractedStages = extractRouxStages(pattern, solvedPattern, phaseMoves);
  
  const finalMoves = simplifyMoves(phaseMoves);
  return {
    ok: true,
    solution: finalMoves.join(" "),
    moveCount: finalMoves.length,
    nodes: solverResult.nodes || 0,
    stages: extractedStages,
    source: "INTERNAL_3X3_ROUX",
  };
}

// Extract Roux stages from a complete solution
function extractRouxStages(startPattern, solvedPattern, moves) {
  let current = startPattern;
  let fbEnd = -1;
  let sbEnd = -1;
  let cmllEnd = -1;
  
  for (let i = 0; i < moves.length; i++) {
    try {
      current = current.applyAlg(moves[i]);
    } catch {
      continue;
    }
    
    if (fbEnd < 0 && isFBSolved(current, solvedPattern)) {
      fbEnd = i;
    }
    if (fbEnd >= 0 && sbEnd < 0 && isSBSolved(current, solvedPattern)) {
      sbEnd = i;
    }
    if (sbEnd >= 0 && cmllEnd < 0 && isCMLLSolved(current, solvedPattern)) {
      cmllEnd = i;
    }
  }
  
  // Require distinct stage boundaries: FB must finish before the cube is fully solved,
  // and each stage must have a unique ending point.
  const lastIdx = moves.length - 1;
  if (fbEnd >= 0 && fbEnd < lastIdx && sbEnd >= 0 && sbEnd > fbEnd && cmllEnd >= 0 && cmllEnd >= sbEnd) {
    return [
      { name: "FB", solution: moves.slice(0, fbEnd + 1).join(" ") || "(skip)" },
      { name: "SB", solution: moves.slice(fbEnd + 1, sbEnd + 1).join(" ") || "(skip)" },
      { name: "CMLL", solution: moves.slice(sbEnd + 1, cmllEnd + 1).join(" ") || "(skip)" },
      { name: "LSE", solution: moves.slice(cmllEnd + 1).join(" ") || "(skip)" },
    ];
  }
  
  // Could not extract stages cleanly (phase solver produced non-Roux solution)
  return [
    { name: "FB", solution: "(phase solver)", note: "approximate" },
    { name: "SB", solution: "(phase solver)", note: "approximate" },
    { name: "CMLL", solution: "(phase solver)", note: "approximate" },
    { name: "LSE", solution: "(phase solver)", note: "approximate" },
  ];
}

// ============================================================
// Move Simplification
// ============================================================

function simplifyMoves(moves) {
  if (!moves.length) return [];
  const stack = [];
  for (const move of moves) {
    const m = parseMove(move);
    if (!m) { stack.push(move); continue; }
    if (!stack.length || stack[stack.length - 1].face !== m.face) {
      if (m.amount % 4) stack.push({ face: m.face, amount: m.amount });
      continue;
    }
    const top = stack[stack.length - 1];
    const combined = (top.amount + m.amount) % 4;
    if (combined === 0) stack.pop(); else top.amount = combined;
  }
  return stack.map(m => formatMove(m.face, m.amount));
}

function parseMove(move) {
  // Handle "X2'" notation (e.g. U2', R2') — same as "X2" (180° is self-inverse)
  const m = String(move).trim().match(/^([UDLRFBMESxyzru])(2'|2|')?$/);
  if (!m) return null;
  return { face: m[1], amount: m[2] === "'" ? 3 : (m[2] === "2" || m[2] === "2'") ? 2 : 1 };
}

function formatMove(face, amount) {
  if (amount === 1) return face;
  if (amount === 2) return face + "2";
  if (amount === 3) return face + "'";
  return "";
}
