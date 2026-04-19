/// FMC Insertion Optimizer (WASM)
///
/// Replaces the JavaScript cubing.js-based insertion search with a fast Rust
/// bidirectional BFS over integer CubeState representations.
///
/// JS equivalent: `optimizeSolutionWithInsertions` in fmcSolver.js.
use std::collections::HashMap;

use crate::fmc_search::{simplify_moves, MOVE_INVERSE, OPPOSITE_FACE};
use crate::minmove_core::{parse_scramble, solution_string_from_path, CubeState, CORNER_COUNT, EDGE_COUNT, LAST_FACE_FREE, MOVE_COUNT};
use crate::twophase_bundle::TwophaseTables;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// State key (40 bytes = cp[8] + co[8] + ep[12] + eo[12])
// ---------------------------------------------------------------------------
type StateKey = [u8; 40];

fn state_key(s: &CubeState) -> StateKey {
    let mut key = [0u8; 40];
    key[..CORNER_COUNT].copy_from_slice(&s.cp);
    key[CORNER_COUNT..CORNER_COUNT * 2].copy_from_slice(&s.co);
    key[CORNER_COUNT * 2..CORNER_COUNT * 2 + EDGE_COUNT].copy_from_slice(&s.ep);
    key[CORNER_COUNT * 2 + EDGE_COUNT..].copy_from_slice(&s.eo);
    key
}

// ---------------------------------------------------------------------------
// Move face / axis info  (move ordering: U=0,R=1,F=2,D=3,L=4,B=5, each *3)
// ---------------------------------------------------------------------------
const FACE_AXIS: [u8; 6] = [0, 1, 2, 0, 1, 2]; // U/D=0, R/L=1, F/B=2

#[inline(always)]
fn move_face(m: u8) -> u8 {
    m / 3
}
#[inline(always)]
fn move_axis(m: u8) -> u8 {
    FACE_AXIS[(m / 3) as usize]
}
#[inline(always)]
fn is_half_turn(m: u8) -> bool {
    m % 3 == 2
}

// ---------------------------------------------------------------------------
// Bidirectional BFS frontier
//
// For `backward=false`:
//   Start from `root`, apply move `m`, store `m` in path.
//   map[state] = moves that take root → state
//
// For `backward=true`:
//   Start from `root`, apply INVERSE(m), store `m` in path.
//   map[state] = moves that take state → root  (i.e. forward path from meeting point to root)
// ---------------------------------------------------------------------------
fn bfs_frontier(
    root: &CubeState,
    depth: u8,
    backward: bool,
    move_face_table: &[u8],
    move_data: &crate::minmove_core::MoveData,
) -> HashMap<StateKey, Vec<u8>> {
    let mut map: HashMap<StateKey, Vec<u8>> = HashMap::with_capacity(1 << (depth * 4).min(20));
    map.insert(state_key(root), vec![]);
    if depth == 0 {
        return map;
    }

    struct Node {
        state: CubeState,
        path: Vec<u8>,
        last_face: u8,
    }

    let mut queue = vec![Node {
        state: *root,
        path: vec![],
        last_face: LAST_FACE_FREE,
    }];

    for _ in 0..depth {
        let mut next_queue = Vec::with_capacity(queue.len() * 10);
        for node in &queue {
            for m in 0..MOVE_COUNT as u8 {
                let face = move_face_table[m as usize];
                let last = node.last_face;
                // Skip same face
                if last < LAST_FACE_FREE && face == last {
                    continue;
                }
                // Skip canonical duplicate for opposite-face pairs
                if last < LAST_FACE_FREE && OPPOSITE_FACE[face as usize] == last && face < last {
                    continue;
                }

                let apply_m = if backward { MOVE_INVERSE[m as usize] } else { m };
                let next_state = node.state.apply_move(apply_m as usize, move_data);
                let key = state_key(&next_state);
                if map.contains_key(&key) {
                    continue;
                }

                let path: Vec<u8> = if backward {
                    // prepend m so the path reads: meeting_point → root
                    let mut p = vec![m];
                    p.extend_from_slice(&node.path);
                    p
                } else {
                    let mut p = node.path.clone();
                    p.push(m);
                    p
                };

                map.insert(key, path.clone());
                // next_queue last_face uses the actual applied face for pruning
                let next_last_face = face; // face of m == face of MOVE_INVERSE[m]
                next_queue.push(Node {
                    state: next_state,
                    path,
                    last_face: next_last_face,
                });
            }
        }
        queue = next_queue;
    }

    map
}

// ---------------------------------------------------------------------------
// MITM segment search
//
// Find moves (length < current_len, depth <= max_depth) such that
//   start.apply(found) == target
// Returns None if no shorter replacement exists.
// ---------------------------------------------------------------------------
type InsertionCache = HashMap<(StateKey, StateKey, u8, u8), Option<Vec<u8>>>;

fn find_shorter_segment(
    start: &CubeState,
    target: &CubeState,
    max_depth: u8,
    current_len: usize,
    cache: &mut InsertionCache,
    move_face_table: &[u8],
    move_data: &crate::minmove_core::MoveData,
) -> Option<Vec<u8>> {
    if current_len <= 1 {
        return None;
    }
    let search_depth = (max_depth as usize).min(current_len - 1) as u8;
    let sk = state_key(start);
    let tk = state_key(target);

    // Identity: already a zero-move replacement
    if sk == tk {
        return Some(vec![]);
    }

    let cache_key = (sk, tk, search_depth, current_len as u8);
    if let Some(cached) = cache.get(&cache_key) {
        return cached.clone();
    }

    let fwd_depth = search_depth / 2;
    let bwd_depth = search_depth - fwd_depth;

    let fwd_map = bfs_frontier(start, fwd_depth, false, move_face_table, move_data);
    let bwd_map = bfs_frontier(target, bwd_depth, true, move_face_table, move_data);

    let mut best: Option<Vec<u8>> = None;
    for (key, left) in &fwd_map {
        if let Some(right) = bwd_map.get(key) {
            let total_len = left.len() + right.len();
            if total_len < current_len {
                if best.is_none() || total_len < best.as_ref().unwrap().len() {
                    let mut combined = left.clone();
                    combined.extend_from_slice(right);
                    best = Some(combined);
                }
            }
        }
    }

    cache.insert(cache_key, best.clone());
    best
}

// ---------------------------------------------------------------------------
// Window ranking — mirrors JS `buildRankedInsertionWindows`
// ---------------------------------------------------------------------------
fn build_ranked_windows(
    moves: &[u8],
    min_window: usize,
    max_window: usize,
) -> Vec<(usize, usize, usize)> {
    let n = moves.len();
    let window_cap = max_window.min(n);
    let mut windows: Vec<(i32, usize, usize, usize)> = Vec::new(); // (score, start, end, window)

    for window in (min_window..=window_cap).rev() {
        for start in 0..=(n - window) {
            let end = start + window;
            let mut score = (window * 8) as i32;

            let left_face = if start > 0 { move_face(moves[start - 1]) as i32 } else { -1 };
            let first_face = move_face(moves[start]) as i32;
            let last_face = move_face(moves[end - 1]) as i32;
            let right_face = if end < n { move_face(moves[end]) as i32 } else { -1 };
            let left_axis = if start > 0 { move_axis(moves[start - 1]) as i32 } else { -1 };
            let first_axis = move_axis(moves[start]) as i32;
            let last_axis = move_axis(moves[end - 1]) as i32;
            let right_axis = if end < n { move_axis(moves[end]) as i32 } else { -1 };

            // Same-face boundary cancellation
            if left_face >= 0 && left_face == first_face {
                score += 16;
            }
            if right_face >= 0 && right_face == last_face {
                score += 16;
            }
            // Same-axis boundary
            if left_axis >= 0 && left_axis == first_axis {
                score += 7;
            }
            if right_axis >= 0 && right_axis == last_axis {
                score += 7;
            }
            // Conjugate bracketing
            if left_axis >= 0 && right_axis >= 0 && left_axis == right_axis {
                score += 9;
            }
            // Commutator structure (short windows)
            if first_axis >= 0 && first_axis == last_axis && window <= 6 {
                score += 5;
            }
            // Interior half-turns
            for k in start..end {
                if is_half_turn(moves[k]) {
                    score += 3;
                }
            }

            windows.push((score, start, end, window));
        }
    }

    // Sort: highest score first; tie-break: larger window, then lower start
    windows.sort_unstable_by(|a, b| {
        b.0.cmp(&a.0)
            .then(b.3.cmp(&a.3))
            .then(a.1.cmp(&b.1))
    });

    windows.into_iter().map(|(_, s, e, w)| (s, e, w)).collect()
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
pub struct InsertionOptions {
    #[serde(rename = "maxPasses", default = "default_max_passes")]
    pub max_passes: usize,
    #[serde(rename = "minWindow", default = "default_min_window")]
    pub min_window: usize,
    #[serde(rename = "maxWindow", default = "default_max_window")]
    pub max_window: usize,
    #[serde(rename = "maxDepth", default = "default_max_depth")]
    pub max_depth: u8,
}
fn default_max_passes() -> usize { 3 }
fn default_min_window() -> usize { 3 }
fn default_max_window() -> usize { 7 }
fn default_max_depth() -> u8 { 6 }

// ---------------------------------------------------------------------------
// Core entry point: optimize a solution with insertion-style MITM search
// ---------------------------------------------------------------------------
pub fn optimize_with_insertions(
    scramble: &str,
    moves_str: &str,
    options: &InsertionOptions,
    tables: &TwophaseTables,
) -> Option<Vec<u8>> {
    let scramble_moves = parse_scramble(scramble, &tables.move_data).ok()?;
    let solution_moves = parse_scramble(moves_str, &tables.move_data).ok()?;
    let mut current = simplify_moves(&solution_moves);
    if current.is_empty() {
        return None;
    }

    let scramble_state = CubeState::solved().apply_moves(&scramble_moves, &tables.move_data);
    let move_face_table = &tables.move_data.move_face;

    // Per-call MITM cache to avoid recomputing identical (start, target) pairs across passes
    let mut cache: InsertionCache = HashMap::new();

    for _ in 0..options.max_passes {
        let mut improved = false;
        let n = current.len();

        // Build intermediate states at all positions: states[i] = state after moves[0..i]
        let mut states = Vec::with_capacity(n + 1);
        states.push(scramble_state);
        for &m in &current {
            let next = states.last().unwrap().apply_move(m as usize, &tables.move_data);
            states.push(next);
        }

        let windows = build_ranked_windows(&current, options.min_window, options.max_window);

        'outer: for (start, end, window_size) in windows {
            let depth_cap = (options.max_depth as usize).min(window_size - 1) as u8;
            let replacement = find_shorter_segment(
                &states[start],
                &states[end],
                depth_cap,
                window_size,
                &mut cache,
                move_face_table,
                &tables.move_data,
            );

            if let Some(repl) = replacement {
                let mut next = Vec::with_capacity(n);
                next.extend_from_slice(&current[..start]);
                next.extend_from_slice(&repl);
                next.extend_from_slice(&current[end..]);
                let simplified = simplify_moves(&next);
                if simplified.len() < n {
                    current = simplified;
                    improved = true;
                    break 'outer;
                }
            }
        }

        if !improved {
            break;
        }
    }

    Some(current)
}

// ---------------------------------------------------------------------------
// WASM entry point
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct OptimizeInsertionRequest {
    scramble: String,
    moves: String,
    #[serde(flatten)]
    options: InsertionOptions,
}

pub fn optimize_insertion_wasm_impl(
    scramble: &str,
    moves_str: &str,
    options_json: &str,
    tables: &TwophaseTables,
) -> String {
    let options: InsertionOptions = match serde_json::from_str(options_json) {
        Ok(o) => o,
        Err(e) => {
            return serde_json::json!({
                "ok": false,
                "reason": format!("BAD_OPTIONS: {e}")
            })
            .to_string()
        }
    };

    let result = optimize_with_insertions(scramble, moves_str, &options, tables);

    match result {
        Some(improved_moves) => {
            let solution = solution_string_from_path(&improved_moves, &tables.move_data);
            serde_json::json!({
                "ok": true,
                "solution": solution,
                "moveCount": improved_moves.len(),
            })
            .to_string()
        }
        None => serde_json::json!({"ok": false, "reason": "NO_SOLUTION"}).to_string(),
    }
}
