use crate::minmove_core::{
    encode_co, encode_eo, encode_perm8, encode_slice_from_ep, parse_scramble,
    solution_string_from_path, CubeState, CO_SIZE, EDGE_COUNT, EO_SIZE, LAST_FACE_FREE,
    MOVE_COUNT, SLICE_SIZE,
};
use crate::twophase_bundle::TwophaseTables;
use crate::twophase_search::{solve_phase2, Phase2Input};

// --- Constants ---

/// Inverse of each move: U↔U', U2↔U2, R↔R', etc.
pub const MOVE_INVERSE: [u8; 18] = [1, 0, 2, 4, 3, 5, 7, 6, 8, 10, 9, 11, 13, 12, 14, 16, 15, 17];

/// EO-preserving moves for DR solving (all except F, F', B, B').
/// U(0),U'(1),U2(2), R(3),R'(4),R2(5), F2(8), D(9),D'(10),D2(11), L(12),L'(13),L2(14), B2(17)
const DR_EO_MOVE_INDICES: [u8; 14] = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 17];

/// Quarter-turn amounts for move suffix index (0→1 CW, 1→3 CCW, 2→2 half).
const TURN_AMOUNTS: [u8; 3] = [1, 3, 2];

/// Opposite face lookup (move-face convention: U=0,R=1,F=2,D=3,L=4,B=5).
pub const OPPOSITE_FACE: [u8; 6] = [3, 4, 5, 0, 1, 2];

/// Joint CO×Slice size for the DR BFS table.
const CO_SLICE_SIZE: usize = CO_SIZE * SLICE_SIZE;

/// Maximum EO depth to search.
const FMC_MAX_EO_DEPTH: u8 = 5;

/// Maximum DR depth (via first-move table chase).
const FMC_MAX_DR_DEPTH: u8 = 14;

/// Maximum P2 depth.
const FMC_MAX_P2_DEPTH: u8 = 18;

/// P2 node limit per call.
const FMC_P2_NODE_LIMIT: u64 = 2_000_000;

/// Premove P2 node limit (tighter for speed).
const FMC_PM_P2_NODE_LIMIT: u64 = 500_000;

/// EO sequence limit per axis for direct/NISS.
const FMC_EO_LIMIT: usize = 6;

/// EO sequence limit per axis for premove sweep.
const FMC_PM_EO_LIMIT: usize = 3;

/// Enable RZP-assisted DR candidate expansion.
const FMC_RZP_ENABLED: bool = true;

/// Maximum EO-preserving setup depth before attempting a DR tail.
const FMC_RZP_SETUP_DEPTH: u8 = 2;

/// Maximum number of DR routes to evaluate per EO sequence.
const FMC_DR_ROUTE_LIMIT: usize = 8;

/// Allow RZP-derived DR routes up to this many moves longer than the direct shortest DR route.
const FMC_DR_SLACK: usize = 3;

// --- Axis conjugation ---
// JS convention: U=0,D=1,R=2,L=3,F=4,B=5
// Move convention: U=0,R=1,F=2,D=3,L=4,B=5

/// Maps move-face convention to JS face convention.
const MOVE_FACE_TO_JS: [usize; 6] = [0, 2, 4, 1, 3, 5];
/// Maps JS face convention to move-face convention.
const JS_TO_MOVE_FACE: [usize; 6] = [0, 3, 1, 4, 2, 5];

/// Axis scramble maps in JS face convention.
const AXIS_SCRAMBLE_MAPS_JS: [[u8; 6]; 3] = [
    [0, 1, 2, 3, 4, 5], // UD: identity
    [5, 4, 2, 3, 0, 1], // FB: U→B, D→F, R→R, L→L, F→U, B→D
    [2, 3, 1, 0, 4, 5], // RL: U→R, D→L, R→D, L→U, F→F, B→B
];

/// Axis solution maps (inverse of scramble maps) in JS face convention.
const AXIS_SOLUTION_MAPS_JS: [[u8; 6]; 3] = [
    [0, 1, 2, 3, 4, 5], // UD: identity
    [4, 5, 2, 3, 1, 0], // FB: U→F, D→B, R→R, L→L, F→D, B→U
    [3, 2, 0, 1, 4, 5], // RL: U→L, D→R, R→U, L→D, F→F, B→B
];

const AXIS_NAMES: [&str; 3] = ["UD", "FB", "RL"];

const FACTORIAL_4: [usize; 5] = [1, 1, 2, 6, 24];

// --- FMC Tables ---

pub struct FmcTables {
    /// CO×Slice BFS distance table (using EO-preserving moves).
    pub co_slice_dist: Vec<u8>,
    /// First-move table for instant optimal DR lookup.
    pub co_slice_first_move: Vec<u8>,
    /// EO BFS distance table.
    pub eo_dist: Vec<u8>,
    /// EO-preserving move allowed lists by last face.
    pub dr_eo_allowed_by_last_face: Vec<Vec<u8>>,
    /// Move conjugation tables for each axis: move_index → conjugated_index.
    pub axis_scramble_move_map: [[u8; 18]; 3],
    /// Inverse conjugation for converting solution back to original frame.
    pub axis_solution_move_map: [[u8; 18]; 3],
}

fn build_move_conjugation(js_face_map: &[u8; 6]) -> [u8; 18] {
    let mut result = [0u8; 18];
    for move_idx in 0..18usize {
        let face = move_idx / 3;
        let turn = move_idx % 3;
        let js_face = MOVE_FACE_TO_JS[face];
        let mapped_js_face = js_face_map[js_face] as usize;
        let mapped_face = JS_TO_MOVE_FACE[mapped_js_face];
        result[move_idx] = (mapped_face * 3 + turn) as u8;
    }
    result
}

pub fn build_fmc_tables(tables: &TwophaseTables) -> FmcTables {
    let solved_slice = tables.solved_slice as usize;

    // Build EO distance table (BFS from solved EO=0, using all 18 moves)
    let mut eo_dist = vec![255u8; EO_SIZE];
    eo_dist[0] = 0;
    let mut frontier: Vec<usize> = vec![0];
    let mut depth = 0u8;
    while !frontier.is_empty() && depth < 15 {
        depth += 1;
        let mut next = Vec::new();
        for &state in &frontier {
            for m in 0..MOVE_COUNT {
                let ns = tables.eo_move.get(state, m) as usize;
                if eo_dist[ns] == 255 {
                    eo_dist[ns] = depth;
                    next.push(ns);
                }
            }
        }
        frontier = next;
    }

    // Build CO×Slice BFS distance + first-move table (from solved DR, using EO-preserving moves)
    let mut co_slice_dist = vec![255u8; CO_SLICE_SIZE];
    let mut co_slice_first_move = vec![255u8; CO_SLICE_SIZE];
    let start_key = solved_slice; // co=0, slice=solved_slice
    co_slice_dist[start_key] = 0;
    let mut frontier: Vec<usize> = vec![start_key];
    let mut depth = 0u8;
    while !frontier.is_empty() && depth < 20 {
        depth += 1;
        let mut next = Vec::new();
        for &key in &frontier {
            let co = key / SLICE_SIZE;
            let sl = key % SLICE_SIZE;
            for &m in &DR_EO_MOVE_INDICES {
                let nco = tables.co_move.get(co, m as usize) as usize;
                let nsl = tables.slice_move.get(sl, m as usize) as usize;
                let nkey = nco * SLICE_SIZE + nsl;
                if co_slice_dist[nkey] == 255 {
                    co_slice_dist[nkey] = depth;
                    // Store inverse move: to go FROM nkey TOWARDS solved, apply inverse(m).
                    co_slice_first_move[nkey] = MOVE_INVERSE[m as usize];
                    next.push(nkey);
                }
            }
        }
        frontier = next;
    }

    // Build DR EO-preserving allowed moves by last face
    let mut dr_eo_allowed: Vec<Vec<u8>> = vec![Vec::new(); LAST_FACE_FREE as usize + 1];
    for last_face in 0..=LAST_FACE_FREE as usize {
        for &m in &DR_EO_MOVE_INDICES {
            let face = m / 3;
            if last_face == LAST_FACE_FREE as usize {
                dr_eo_allowed[last_face].push(m);
                continue;
            }
            if face == last_face as u8 {
                continue;
            }
            if face == OPPOSITE_FACE[last_face] && face < last_face as u8 {
                continue;
            }
            dr_eo_allowed[last_face].push(m);
        }
    }

    // Build axis conjugation tables
    let mut axis_scramble_move_map = [[0u8; 18]; 3];
    let mut axis_solution_move_map = [[0u8; 18]; 3];
    for i in 0..3 {
        axis_scramble_move_map[i] = build_move_conjugation(&AXIS_SCRAMBLE_MAPS_JS[i]);
        axis_solution_move_map[i] = build_move_conjugation(&AXIS_SOLUTION_MAPS_JS[i]);
    }

    FmcTables {
        co_slice_dist,
        co_slice_first_move,
        eo_dist,
        dr_eo_allowed_by_last_face: dr_eo_allowed,
        axis_scramble_move_map,
        axis_solution_move_map,
    }
}

// --- EO Sequence Search (IDA*) ---

struct EoSearchCtx<'a> {
    tables: &'a TwophaseTables,
    eo_dist: &'a [u8],
    path: Vec<u8>,
    solutions: Vec<Vec<u8>>,
    limit: usize,
}

impl<'a> EoSearchCtx<'a> {
    fn dfs(&mut self, eo: usize, depth: u8, bound: u8, last_face: u8) -> u8 {
        if self.solutions.len() >= self.limit {
            return 255;
        }
        let h = self.eo_dist[eo];
        let f = depth.saturating_add(h);
        if f > bound {
            return f;
        }
        if eo == 0 {
            self.solutions.push(self.path.clone());
            return 255; // found, continue searching at this depth
        }

        let mut min_next = 255u8;
        for &m in &self.tables.phase1_allowed_moves_by_last_face[last_face as usize] {
            if self.solutions.len() >= self.limit {
                return 255;
            }
            let next_eo = self.tables.eo_move.get(eo, m as usize) as usize;
            let face = self.tables.move_data.move_face[m as usize];
            self.path.push(m);
            let result = self.dfs(next_eo, depth + 1, bound, face);
            self.path.pop();
            if result < min_next {
                min_next = result;
            }
        }
        min_next
    }
}

fn find_eo_sequences(
    eo_idx: usize,
    tables: &TwophaseTables,
    fmc_tables: &FmcTables,
    max_depth: u8,
    limit: usize,
) -> Vec<Vec<u8>> {
    if eo_idx == 0 {
        return vec![vec![]]; // already solved
    }

    let min_depth = fmc_tables.eo_dist[eo_idx];
    if min_depth > max_depth {
        return vec![]; // unreachable within budget
    }

    let mut ctx = EoSearchCtx {
        tables,
        eo_dist: &fmc_tables.eo_dist,
        path: Vec::with_capacity(max_depth as usize),
        solutions: Vec::new(),
        limit,
    };

    for d in min_depth..=max_depth {
        if ctx.solutions.len() >= limit {
            break;
        }
        ctx.path.clear();
        ctx.dfs(eo_idx, 0, d, LAST_FACE_FREE);
    }

    ctx.solutions
}

// --- DR Solving (first-move table chase) ---

fn solve_dr(
    co_idx: usize,
    slice_idx: usize,
    fmc_tables: &FmcTables,
    tables: &TwophaseTables,
    max_depth: u8,
) -> Option<Vec<u8>> {
    let solved_slice = tables.solved_slice as usize;

    if co_idx == 0 && slice_idx == solved_slice {
        return Some(vec![]);
    }

    let key = co_idx * SLICE_SIZE + slice_idx;
    if fmc_tables.co_slice_dist[key] > max_depth {
        return None;
    }

    let mut path = Vec::new();
    let mut co = co_idx;
    let mut sl = slice_idx;
    while co != 0 || sl != solved_slice {
        let k = co * SLICE_SIZE + sl;
        let fm = fmc_tables.co_slice_first_move[k];
        if fm == 255 || path.len() > max_depth as usize {
            return None;
        }
        path.push(fm);
        co = tables.co_move.get(co, fm as usize) as usize;
        sl = tables.slice_move.get(sl, fm as usize) as usize;
    }
    Some(path)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct RzpDefect {
    bad_c: u8,
    bad_e: u8,
}

#[derive(Clone, Debug)]
struct DrRoute {
    moves: Vec<u8>,
    rzp_setup_len: u8,
    rzp_defect: Option<RzpDefect>,
}

fn rzp_defect_from_state(state: &CubeState) -> RzpDefect {
    let bad_c = state.co.iter().filter(|&&ori| ori != 0).count() as u8;

    let bad_e_ud_positions = (0..8)
        .filter(|&pos| state.ep[pos] >= 8)
        .count() as u8;

    let bad_e_slice_positions = (8..EDGE_COUNT)
        .filter(|&pos| state.ep[pos] < 8)
        .count() as u8;

    RzpDefect {
        bad_c,
        bad_e: bad_e_ud_positions + bad_e_slice_positions,
    }
}

fn rzp_priority(defect: RzpDefect) -> Option<u8> {
    match (defect.bad_c, defect.bad_e) {
        (0, 0) => Some(0),
        (3, 2) => Some(1),
        (4, 2) => Some(1),
        (4, 4) => Some(2),
        (7, 8) => Some(3),
        (8, 8) => Some(3),
        _ => None,
    }
}

fn last_face_of_moves(moves: &[u8], tables: &TwophaseTables) -> u8 {
    moves
        .last()
        .map(|&m| tables.move_data.move_face[m as usize])
        .unwrap_or(LAST_FACE_FREE)
}

fn solve_dr_routes_via_rzp(
    state_after_eo: &CubeState,
    fmc_tables: &FmcTables,
    tables: &TwophaseTables,
    max_depth: u8,
    last_face_before_dr: u8,
) -> Vec<DrRoute> {
    let mut routes: Vec<DrRoute> = Vec::new();
    let mut seen = std::collections::HashSet::<Vec<u8>>::new();

    let co0 = encode_co(&state_after_eo.co);
    let sl0 = encode_slice_from_ep(&state_after_eo.ep);

    let direct = solve_dr(co0, sl0, fmc_tables, tables, max_depth);
    let direct_len = direct.as_ref().map(|m| m.len()).unwrap_or(usize::MAX);

    if let Some(moves) = direct {
        if seen.insert(moves.clone()) {
            routes.push(DrRoute {
                moves,
                rzp_setup_len: 0,
                rzp_defect: Some(rzp_defect_from_state(state_after_eo)),
            });
        }
    }

    if !FMC_RZP_ENABLED || max_depth == 0 {
        return routes;
    }

    fn dfs(
        state: CubeState,
        setup: &mut Vec<u8>,
        routes: &mut Vec<DrRoute>,
        seen: &mut std::collections::HashSet<Vec<u8>>,
        fmc_tables: &FmcTables,
        tables: &TwophaseTables,
        max_depth: u8,
        direct_len: usize,
        depth_left: u8,
        last_face: u8,
    ) {
        if routes.len() >= FMC_DR_ROUTE_LIMIT {
            return;
        }

        let defect = rzp_defect_from_state(&state);

        if rzp_priority(defect).is_some() && setup.len() <= max_depth as usize {
            let remaining = max_depth.saturating_sub(setup.len() as u8);
            let co = encode_co(&state.co);
            let sl = encode_slice_from_ep(&state.ep);

            if let Some(tail) = solve_dr(co, sl, fmc_tables, tables, remaining) {
                let mut full = setup.clone();
                full.extend_from_slice(&tail);

                let within_cap = full.len() <= max_depth as usize;
                let within_slack = direct_len == usize::MAX
                    || full.len() <= direct_len.saturating_add(FMC_DR_SLACK);

                if within_cap && within_slack && seen.insert(full.clone()) {
                    routes.push(DrRoute {
                        moves: full,
                        rzp_setup_len: setup.len() as u8,
                        rzp_defect: Some(defect),
                    });
                }
            }
        }

        if depth_left == 0 {
            return;
        }

        for &m in &fmc_tables.dr_eo_allowed_by_last_face[last_face as usize] {
            let face = tables.move_data.move_face[m as usize];
            let next_state = state.apply_move(m as usize, &tables.move_data);

            setup.push(m);
            dfs(
                next_state,
                setup,
                routes,
                seen,
                fmc_tables,
                tables,
                max_depth,
                direct_len,
                depth_left - 1,
                face,
            );
            setup.pop();

            if routes.len() >= FMC_DR_ROUTE_LIMIT {
                return;
            }
        }
    }

    let mut setup = Vec::new();
    dfs(
        *state_after_eo,
        &mut setup,
        &mut routes,
        &mut seen,
        fmc_tables,
        tables,
        max_depth,
        direct_len,
        FMC_RZP_SETUP_DEPTH,
        last_face_before_dr,
    );

    routes.sort_by_key(|route| {
        let priority = route
            .rzp_defect
            .and_then(rzp_priority)
            .unwrap_or(99);

        (route.moves.len(), priority, route.rzp_setup_len)
    });

    routes.truncate(FMC_DR_ROUTE_LIMIT);
    routes
}

// --- P2 Input Building ---

fn encode_perm4(perm: &[u8; 4]) -> usize {
    let mut index = 0usize;
    for i in 0..4 {
        let mut smaller = 0usize;
        for j in (i + 1)..4 {
            if perm[j] < perm[i] {
                smaller += 1;
            }
        }
        index += smaller * FACTORIAL_4[3 - i];
    }
    index
}

fn build_p2_input(state: &CubeState) -> Option<Phase2Input> {
    // Verify edges are in DR configuration: UD edges (0-7) in UD positions, E-slice (8-11) in E-slice.
    for i in 0..8 {
        if state.ep[i] >= 8 {
            return None;
        }
    }
    for i in 8..12 {
        if state.ep[i] < 8 {
            return None;
        }
    }

    let cp_idx = encode_perm8(&state.cp);
    let ep8: [u8; 8] = [
        state.ep[0], state.ep[1], state.ep[2], state.ep[3],
        state.ep[4], state.ep[5], state.ep[6], state.ep[7],
    ];
    let ep_idx = encode_perm8(&ep8);
    let sep: [u8; 4] = [
        state.ep[8] - 8,
        state.ep[9] - 8,
        state.ep[10] - 8,
        state.ep[11] - 8,
    ];
    let sep_idx = encode_perm4(&sep);

    Some(Phase2Input {
        cp_idx,
        ep_idx,
        sep_idx,
    })
}

// --- Move Simplification ---

fn turn_to_suffix(combined: u8) -> u8 {
    match combined {
        1 => 0,
        3 => 1,
        2 => 2,
        _ => unreachable!(),
    }
}

/// Simplify a move sequence by cancelling adjacent same-face and opposite-face sandwiches.
/// Iterates until no more simplifications possible.
pub fn simplify_moves(input: &[u8]) -> Vec<u8> {
    let mut result = input.to_vec();
    loop {
        let new_result = simplify_pass(&result);
        if new_result.len() == result.len() {
            break;
        }
        result = new_result;
    }
    result
}

fn simplify_pass(input: &[u8]) -> Vec<u8> {
    let mut result: Vec<u8> = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        // Check for same-face merge with next
        if i + 1 < input.len() && input[i] / 3 == input[i + 1] / 3 {
            let face = input[i] / 3;
            let ta = TURN_AMOUNTS[(input[i] % 3) as usize];
            let tb = TURN_AMOUNTS[(input[i + 1] % 3) as usize];
            let combined = (ta + tb) & 3;
            if combined != 0 {
                result.push(face * 3 + turn_to_suffix(combined));
            }
            i += 2;
            continue;
        }
        // Check for opposite-face sandwich: A B C where A.face == C.face and B.face == opposite(A.face)
        if i + 2 < input.len() {
            let af = input[i] / 3;
            let bf = input[i + 1] / 3;
            let cf = input[i + 2] / 3;
            if af == cf && bf == OPPOSITE_FACE[af as usize] {
                let ta = TURN_AMOUNTS[(input[i] % 3) as usize];
                let tc = TURN_AMOUNTS[(input[i + 2] % 3) as usize];
                let combined = (ta + tc) & 3;
                if combined != 0 {
                    result.push(af * 3 + turn_to_suffix(combined));
                }
                result.push(input[i + 1]);
                i += 3;
                continue;
            }
        }
        result.push(input[i]);
        i += 1;
    }
    result
}

// --- State Inversion ---

fn invert_state(state: &CubeState) -> CubeState {
    let mut inv = CubeState::solved();
    for i in 0..8 {
        let j = state.cp[i] as usize;
        inv.cp[j] = i as u8;
        inv.co[j] = (3 - state.co[i] % 3) % 3;
    }
    for i in 0..12 {
        let j = state.ep[i] as usize;
        inv.ep[j] = i as u8;
        inv.eo[j] = state.eo[i];
    }
    inv
}

fn invert_moves(moves: &[u8]) -> Vec<u8> {
    moves
        .iter()
        .rev()
        .map(|&m| MOVE_INVERSE[m as usize])
        .collect()
}

// --- Premove Sets ---

fn build_premove_sets() -> Vec<Vec<u8>> {
    let mut sets: Vec<Vec<u8>> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let push_set = |moves: Vec<u8>, sets: &mut Vec<Vec<u8>>, seen: &mut std::collections::HashSet<Vec<u8>>| {
        let simplified = simplify_moves(&moves);
        if simplified.is_empty() || simplified.len() > 2 {
            return;
        }
        if seen.insert(simplified.clone()) {
            sets.push(simplified);
        }
    };

    // Single-face premoves (18)
    for face in 0..6u8 {
        for turn in 0..3u8 {
            push_set(vec![face * 3 + turn], &mut sets, &mut seen);
        }
    }

    // Double-face premoves: various face pairs
    // Matching the JS FMC_PREMOVE_PAIR_FACES order
    let pair_faces: [(u8, u8); 18] = [
        (0, 1), (1, 0), (0, 2), (2, 0), (1, 2), (2, 1), // U-R, R-U, U-F, F-U, R-F, F-R
        (3, 4), (4, 3), (3, 5), (5, 3), (4, 5), (5, 4), // D-L, L-D, D-B, B-D, L-B, B-L
        (0, 3), (3, 0), (1, 4), (4, 1), (2, 5), (5, 2), // U-D, D-U, R-L, L-R, F-B, B-F
    ];

    for &(fa, fb) in &pair_faces {
        for ta in 0..3u8 {
            for tb in 0..3u8 {
                push_set(vec![fa * 3 + ta, fb * 3 + tb], &mut sets, &mut seen);
            }
        }
    }

    sets
}

// --- Result Types ---

#[derive(Clone, Debug)]
pub struct FmcCandidate {
    pub moves: Vec<u8>,
    pub eo_len: u8,
    pub dr_len: u8,
    pub p2_len: u8,
    /// Individual segment moves in the axis frame (already converted to original axis)
    pub eo_moves: Vec<u8>,
    pub dr_moves: Vec<u8>,
    pub finish_moves: Vec<u8>,
    pub axis: u8,
    /// 0=direct, 1=niss, 2=premove_direct, 3=premove_niss
    pub source_tag: u8,
    pub premove_moves: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct FmcResult {
    pub ok: bool,
    pub candidates: Vec<FmcCandidate>,
}

// --- Single-Axis EO→DR→P2 Pipeline ---

/// Runs the EO→DR→P2 pipeline for a single cube state (already conjugated to axis frame).
/// Returns a list of (simplified_moves, eo_len, dr_len, p2_len).
fn solve_fmc_single_axis(
    state: &CubeState,
    tables: &TwophaseTables,
    fmc_tables: &FmcTables,
    max_eo_depth: u8,
    eo_limit: usize,
    max_dr_depth: u8,
    max_p2_depth: u8,
    p2_node_limit: u64,
    current_best: &mut usize,
) -> Vec<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)> {
    // Returns: (combined_simplified, eo_moves_raw, dr_moves_raw, p2_moves_raw)
    let mut results = Vec::new();

    let eo_idx = encode_eo(&state.eo);
    let eo_seqs = find_eo_sequences(eo_idx, tables, fmc_tables, max_eo_depth, eo_limit);

    for eo_seq in &eo_seqs {
        if eo_seq.len() >= *current_best {
            continue;
        }

        // Apply EO moves to state
        let state_after_eo = state.apply_moves(eo_seq, &tables.move_data);
        let co_after = encode_co(&state_after_eo.co);
        let slice_after = encode_slice_from_ep(&state_after_eo.ep);

        // Solve DR routes via RZP
        let dr_cap = (*current_best - eo_seq.len()).min(max_dr_depth as usize) as u8;
        let last_face_before_dr = last_face_of_moves(eo_seq, tables);

        let dr_routes = solve_dr_routes_via_rzp(
            &state_after_eo,
            fmc_tables,
            tables,
            dr_cap,
            last_face_before_dr,
        );

        if dr_routes.is_empty() {
            continue;
        }

        for dr_route in dr_routes {
            let dr_moves = &dr_route.moves;

            let partial_len = eo_seq.len() + dr_moves.len();
            if partial_len >= *current_best {
                continue;
            }

            let state_after_dr = state_after_eo.apply_moves(dr_moves, &tables.move_data);

            let p2_input = match build_p2_input(&state_after_dr) {
                Some(input) => input,
                None => continue,
            };

            let p2_cap = (*current_best - partial_len).min(max_p2_depth as usize) as u8;
            let p2_result = solve_phase2(&p2_input, tables, p2_cap, p2_node_limit);
            if !p2_result.ok {
                continue;
            }
            let p2_global: Vec<u8> = p2_result
                .moves
                .iter()
                .map(|&local| tables.phase2_move_indices[local as usize])
                .collect();

            let mut all_moves = Vec::with_capacity(eo_seq.len() + dr_moves.len() + p2_global.len());
            all_moves.extend_from_slice(eo_seq);
            all_moves.extend_from_slice(dr_moves);
            all_moves.extend_from_slice(&p2_global);

            let simplified = simplify_moves(&all_moves);
            if simplified.is_empty() {
                continue;
            }

            if simplified.len() < *current_best {
                *current_best = simplified.len();
            }

            results.push((
                simplified,
                eo_seq.clone(),
                dr_moves.clone(),
                p2_global.clone(),
            ));
        }
    }

    results
}

// --- Full FMC Solver ---

pub fn solve_fmc(
    scramble: &str,
    tables: &TwophaseTables,
    fmc_tables: &FmcTables,
    max_premove_sets: usize,
) -> FmcResult {
    // Parse scramble
    let scramble_moves = match parse_scramble(scramble, &tables.move_data) {
        Ok(m) => m,
        Err(_) => {
            return FmcResult {
                ok: false,
                candidates: vec![],
            }
        }
    };

    let mut all_candidates: Vec<FmcCandidate> = Vec::new();
    let mut best_count = 40usize;

    // --- Phase 1: Direct solve across 3 axes ---
    for axis in 0..3u8 {
        let conjugated: Vec<u8> = scramble_moves
            .iter()
            .map(|&m| fmc_tables.axis_scramble_move_map[axis as usize][m as usize])
            .collect();
        let state = CubeState::solved().apply_moves(&conjugated, &tables.move_data);

        let results = solve_fmc_single_axis(
            &state,
            tables,
            fmc_tables,
            FMC_MAX_EO_DEPTH,
            FMC_EO_LIMIT,
            FMC_MAX_DR_DEPTH,
            FMC_MAX_P2_DEPTH,
            FMC_P2_NODE_LIMIT,
            &mut best_count,
        );

        for (moves_in_axis_frame, eo_raw, dr_raw, p2_raw) in results {
            let cvt = |v: &Vec<u8>| -> Vec<u8> {
                v.iter().map(|&m| fmc_tables.axis_solution_move_map[axis as usize][m as usize]).collect()
            };
            let original: Vec<u8> = cvt(&moves_in_axis_frame);
            let simplified = simplify_moves(&original);
            if !simplified.is_empty() && simplified.len() <= best_count {
                best_count = simplified.len();
                all_candidates.push(FmcCandidate {
                    moves: simplified,
                    eo_len: eo_raw.len() as u8,
                    dr_len: dr_raw.len() as u8,
                    p2_len: p2_raw.len() as u8,
                    eo_moves: cvt(&eo_raw),
                    dr_moves: cvt(&dr_raw),
                    finish_moves: cvt(&p2_raw),
                    axis,
                    source_tag: 0,
                    premove_moves: vec![],
                });
            }
        }
    }

    // --- Phase 2: NISS (inverse scramble) across 3 axes ---
    let inv_scramble_moves = invert_moves(&scramble_moves);
    for axis in 0..3u8 {
        let conjugated: Vec<u8> = inv_scramble_moves
            .iter()
            .map(|&m| fmc_tables.axis_scramble_move_map[axis as usize][m as usize])
            .collect();
        let state = CubeState::solved().apply_moves(&conjugated, &tables.move_data);

        let results = solve_fmc_single_axis(
            &state,
            tables,
            fmc_tables,
            FMC_MAX_EO_DEPTH,
            FMC_EO_LIMIT,
            FMC_MAX_DR_DEPTH,
            FMC_MAX_P2_DEPTH,
            FMC_P2_NODE_LIMIT,
            &mut best_count,
        );

        for (moves_in_axis_frame, eo_raw, dr_raw, p2_raw) in results {
            let cvt = |v: &Vec<u8>| -> Vec<u8> {
                v.iter().map(|&m| fmc_tables.axis_solution_move_map[axis as usize][m as usize]).collect()
            };
            let original: Vec<u8> = cvt(&moves_in_axis_frame);
            // NISS: invert the solution
            let inverted = invert_moves(&original);
            let simplified = simplify_moves(&inverted);
            if !simplified.is_empty() && simplified.len() <= best_count {
                best_count = simplified.len();
                all_candidates.push(FmcCandidate {
                    moves: simplified,
                    eo_len: eo_raw.len() as u8,
                    dr_len: dr_raw.len() as u8,
                    p2_len: p2_raw.len() as u8,
                    // NISS: store original (pre-inversion) segments from inverse solve
                    eo_moves: cvt(&eo_raw),
                    dr_moves: cvt(&dr_raw),
                    finish_moves: cvt(&p2_raw),
                    axis,
                    source_tag: 1,
                    premove_moves: vec![],
                });
            }
        }
    }

    // --- Phase 3: Premove sweep ---
    let premove_sets = build_premove_sets();
    let pm_limit = max_premove_sets.min(premove_sets.len());

    for pm_idx in 0..pm_limit {
        let pm_set = &premove_sets[pm_idx];

        // Direct with premoves: effective = scramble + premoves
        {
            let mut effective = scramble_moves.clone();
            effective.extend_from_slice(pm_set);

            for axis in 0..3u8 {
                let conjugated: Vec<u8> = effective
                    .iter()
                    .map(|&m| fmc_tables.axis_scramble_move_map[axis as usize][m as usize])
                    .collect();
                let state = CubeState::solved().apply_moves(&conjugated, &tables.move_data);

                // Use a tighter budget check: skip if premove_len + best possible pipeline >= best
                let pm_len = pm_set.len();

                let results = solve_fmc_single_axis(
                    &state,
                    tables,
                    fmc_tables,
                    FMC_MAX_EO_DEPTH,
                    FMC_PM_EO_LIMIT,
                    FMC_MAX_DR_DEPTH,
                    FMC_MAX_P2_DEPTH,
                    FMC_PM_P2_NODE_LIMIT,
                    &mut best_count,
                );

                for (moves_in_axis, eo_raw, dr_raw, p2_raw) in results {
                    let cvt = |v: &Vec<u8>| -> Vec<u8> {
                        v.iter().map(|&m| fmc_tables.axis_solution_move_map[axis as usize][m as usize]).collect()
                    };
                    let original: Vec<u8> = cvt(&moves_in_axis);
                    // Direct premove: solution = premoves + pipeline_solution
                    let mut full = pm_set.clone();
                    full.extend_from_slice(&original);
                    let simplified = simplify_moves(&full);
                    if !simplified.is_empty() && simplified.len() <= best_count {
                        best_count = simplified.len();
                        all_candidates.push(FmcCandidate {
                            moves: simplified,
                            eo_len: eo_raw.len() as u8,
                            dr_len: dr_raw.len() as u8,
                            p2_len: p2_raw.len() as u8,
                            eo_moves: cvt(&eo_raw),
                            dr_moves: cvt(&dr_raw),
                            finish_moves: cvt(&p2_raw),
                            axis,
                            source_tag: 2,
                            premove_moves: pm_set.clone(),
                        });
                    }
                }
            }
        }

        // NISS with premoves: effective = inv_scramble + premoves
        {
            let mut inv_effective = inv_scramble_moves.clone();
            inv_effective.extend_from_slice(pm_set);

            for axis in 0..3u8 {
                let conjugated: Vec<u8> = inv_effective
                    .iter()
                    .map(|&m| fmc_tables.axis_scramble_move_map[axis as usize][m as usize])
                    .collect();
                let state = CubeState::solved().apply_moves(&conjugated, &tables.move_data);

                let results = solve_fmc_single_axis(
                    &state,
                    tables,
                    fmc_tables,
                    FMC_MAX_EO_DEPTH,
                    FMC_PM_EO_LIMIT,
                    FMC_MAX_DR_DEPTH,
                    FMC_MAX_P2_DEPTH,
                    FMC_PM_P2_NODE_LIMIT,
                    &mut best_count,
                );

                for (moves_in_axis, eo_raw, dr_raw, p2_raw) in results {
                    let cvt = |v: &Vec<u8>| -> Vec<u8> {
                        v.iter().map(|&m| fmc_tables.axis_solution_move_map[axis as usize][m as usize]).collect()
                    };
                    let original: Vec<u8> = cvt(&moves_in_axis);
                    // NISS premove: solution = inv(pipeline) + inv(premoves)
                    let mut full = invert_moves(&original);
                    full.extend_from_slice(&invert_moves(pm_set));
                    let simplified = simplify_moves(&full);
                    if !simplified.is_empty() && simplified.len() <= best_count {
                        best_count = simplified.len();
                        all_candidates.push(FmcCandidate {
                            moves: simplified,
                            eo_len: eo_raw.len() as u8,
                            dr_len: dr_raw.len() as u8,
                            p2_len: p2_raw.len() as u8,
                            // NISS: store original (pre-inversion) segments
                            eo_moves: cvt(&eo_raw),
                            dr_moves: cvt(&dr_raw),
                            finish_moves: cvt(&p2_raw),
                            axis,
                            source_tag: 3,
                            premove_moves: pm_set.clone(),
                        });
                    }
                }
            }
        }
    }

    // Sort by move count
    all_candidates.sort_by_key(|c| c.moves.len());

    // Deduplicate by solution
    let mut seen = std::collections::HashSet::new();
    all_candidates.retain(|c| seen.insert(c.moves.clone()));

    // Keep top candidates
    all_candidates.truncate(10);

    FmcResult {
        ok: !all_candidates.is_empty(),
        candidates: all_candidates,
    }
}

/// Convert FmcCandidate to a JSON-friendly representation.
pub fn candidate_to_json(
    candidate: &FmcCandidate,
    tables: &TwophaseTables,
) -> serde_json::Value {
    let solution = solution_string_from_path(&candidate.moves, &tables.move_data);
    let premove_str = if candidate.premove_moves.is_empty() {
        String::new()
    } else {
        solution_string_from_path(&candidate.premove_moves, &tables.move_data)
    };
    let source = match candidate.source_tag {
        0 => format!("FMC_EO_{}", AXIS_NAMES[candidate.axis as usize]),
        1 => format!("FMC_NISS_{}", AXIS_NAMES[candidate.axis as usize]),
        2 => format!("FMC_PREMOVE_{}", AXIS_NAMES[candidate.axis as usize]),
        3 => format!(
            "FMC_PREMOVE_NISS_{}",
            AXIS_NAMES[candidate.axis as usize]
        ),
        _ => "FMC_UNKNOWN".into(),
    };

    let eo_moves_str: Vec<&str> = candidate.eo_moves.iter()
        .map(|&m| tables.move_data.move_names[m as usize].as_str()).collect();
    let dr_moves_str: Vec<&str> = candidate.dr_moves.iter()
        .map(|&m| tables.move_data.move_names[m as usize].as_str()).collect();
    let finish_moves_str: Vec<&str> = candidate.finish_moves.iter()
        .map(|&m| tables.move_data.move_names[m as usize].as_str()).collect();

    serde_json::json!({
        "ok": true,
        "solution": solution,
        "moveCount": candidate.moves.len(),
        "eoLength": candidate.eo_len,
        "drLength": candidate.dr_len,
        "p2Length": candidate.p2_len,
        "eoMoves": eo_moves_str,
        "drMoves": dr_moves_str,
        "finishMoves": finish_moves_str,
        "axisName": AXIS_NAMES[candidate.axis as usize],
        "source": source,
        "premoves": premove_str,
        "moves": solution.split_whitespace().collect::<Vec<_>>(),
    })
}
