use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::minmove_core::{
    encode_co, encode_eo, encode_perm12, encode_perm8, encode_slice_from_ep, parse_scramble,
    solution_string_from_path, CubeState, LAST_FACE_FREE,
};
use crate::twophase_bundle::TwophaseTables;

const SEP_SIZE: usize = 24;
const PHASE1_FAIL_CACHE_LIMIT: usize = 220_000;
const PHASE2_FAIL_CACHE_LIMIT: usize = 260_000;
const PHASE1_EXACT_FAIL_CACHE_LIMIT: usize = 500_000;
const FOUND_SENTINEL: u16 = u16::MAX;
const STOP_SENTINEL: u16 = u16::MAX - 1;
const FACTORIAL_4: [usize; 5] = [1, 1, 2, 6, 24];

fn default_max_phase1_solutions() -> usize {
    12
}

fn default_phase1_max_depth() -> u8 {
    13
}

fn default_phase2_max_depth() -> u8 {
    20
}

#[derive(Clone, Debug, Deserialize)]
pub struct TwophasePrepareOptions {
    #[serde(rename = "maxPhase1Solutions", default = "default_max_phase1_solutions")]
    pub max_phase1_solutions: usize,
    #[serde(rename = "phase1MaxDepth", default = "default_phase1_max_depth")]
    pub phase1_max_depth: u8,
    #[serde(rename = "phase1NodeLimit", default)]
    pub phase1_node_limit: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TwophaseSearchOptions {
    #[serde(rename = "incumbentLength")]
    pub incumbent_length: Option<u8>,
    #[serde(rename = "phase2MaxDepth", default = "default_phase2_max_depth")]
    pub phase2_max_depth: u8,
    #[serde(rename = "phase2NodeLimit", default)]
    pub phase2_node_limit: u64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TwophaseExactOptions {
    #[serde(rename = "maxTotalDepth")]
    pub max_total_depth: u8,
    #[serde(rename = "phase1NodeLimit", default)]
    pub phase1_node_limit: u64,
    #[serde(rename = "phase2NodeLimit", default)]
    pub phase2_node_limit: u64,
}

#[derive(Clone, Copy, Debug)]
struct Phase1Input {
    co_idx: usize,
    eo_idx: usize,
    slice_idx: usize,
    max_depth: u8,
    node_limit: u64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Phase2Input {
    pub(crate) cp_idx: usize,
    pub(crate) ep_idx: usize,
    pub(crate) sep_idx: usize,
}

#[derive(Clone, Debug)]
struct Phase1SolveResult {
    ok: bool,
    moves: Vec<u8>,
    depth: u8,
    nodes: u64,
    reason: String,
}

#[derive(Clone, Debug)]
struct Phase1MultiResult {
    solutions: Vec<Vec<u8>>,
    min_depth: u8,
    nodes: u64,
    reason: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Phase2SolveResult {
    pub(crate) ok: bool,
    pub(crate) moves: Vec<u8>,
    pub(crate) depth: u8,
    pub(crate) nodes: u64,
    pub(crate) reason: String,
}

#[derive(Clone, Debug)]
struct Phase1Candidate {
    moves: Vec<u8>,
    phase2_input: Phase2Input,
}

#[derive(Clone, Debug)]
pub struct TwophaseSession {
    phase1_nodes: u64,
    phase1_min_depth: u8,
    candidates: Vec<Phase1Candidate>,
}

#[derive(Clone, Debug)]
pub struct TwophaseSearchResult {
    pub ok: bool,
    pub solution: String,
    pub move_count: u32,
    pub nodes: u64,
    pub phase1_nodes: u64,
    pub phase2_nodes: u64,
    pub phase1_depth: u8,
    pub phase2_depth: u8,
    pub candidate_count: usize,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct TwophaseExactSearchResult {
    pub ok: bool,
    pub found: bool,
    pub interrupted: bool,
    pub solution: String,
    pub move_count: u32,
    pub nodes: u64,
    pub phase1_nodes: u64,
    pub phase2_nodes: u64,
    pub bound: u8,
    pub reason: String,
}

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

fn build_phase1_input(state: &CubeState, max_depth: u8, node_limit: u64) -> Phase1Input {
    Phase1Input {
        co_idx: encode_co(&state.co),
        eo_idx: encode_eo(&state.eo),
        slice_idx: encode_slice_from_ep(&state.ep),
        max_depth,
        node_limit,
    }
}

fn build_phase2_input(state: &CubeState) -> Option<Phase2Input> {
    let mut sep = [0u8; 4];
    for position in 0..8 {
        if state.cp[position] > 7 || state.ep[position] > 7 {
            return None;
        }
    }
    for position in 0..4 {
        let piece = state.ep[8 + position];
        if !(8..=11).contains(&piece) {
            return None;
        }
        sep[position] = piece - 8;
    }
    Some(Phase2Input {
        cp_idx: encode_perm8(&state.cp),
        ep_idx: encode_perm8(&[
            state.ep[0], state.ep[1], state.ep[2], state.ep[3], state.ep[4], state.ep[5],
            state.ep[6], state.ep[7],
        ]),
        sep_idx: encode_perm4(&sep),
    })
}

struct Phase1SearchCtx<'a> {
    tables: &'a TwophaseTables,
    path: Vec<u8>,
    nodes: u64,
    node_limit: u64,
    node_limit_hit: bool,
    fail_cache: HashMap<u64, u32>,
}

impl<'a> Phase1SearchCtx<'a> {
    fn dfs(
        &mut self,
        co: usize,
        eo: usize,
        slice: usize,
        depth: u8,
        bound: u8,
        last_face: u8,
    ) -> u16 {
        if self.node_limit_hit {
            return STOP_SENTINEL;
        }
        let h = self
            .tables
            .co
            .get(co)
            .max(self.tables.eo.get(eo))
            .max(self.tables.slice.get(slice));
        let f = depth.saturating_add(h);
        if f > bound {
            return f as u16;
        }
        if co == 0 && eo == 0 && slice == self.tables.solved_slice as usize {
            return FOUND_SENTINEL;
        }

        let remaining = (bound - depth) as u32;
        let cache_key = ((((co as u64) * 2048 + eo as u64) * 495 + slice as u64) * 7)
            + last_face as u64;
        let seen_mask = self.fail_cache.get(&cache_key).copied().unwrap_or(0);
        let bit = 1u32 << remaining.min(31);
        if (seen_mask & bit) != 0 {
            return STOP_SENTINEL - 1;
        }

        let mut min_next: Option<u16> = None;
        for &move_index in &self.tables.phase1_allowed_moves_by_last_face[last_face as usize] {
            self.nodes += 1;
            if self.node_limit > 0 && self.nodes >= self.node_limit {
                self.node_limit_hit = true;
                return STOP_SENTINEL;
            }
            let next_co = self.tables.co_move.get(co, move_index as usize) as usize;
            let next_eo = self.tables.eo_move.get(eo, move_index as usize) as usize;
            let next_slice = self.tables.slice_move.get(slice, move_index as usize) as usize;
            self.path.push(move_index);
            let next_face = self.tables.move_data.move_face[move_index as usize];
            let result = self.dfs(next_co, next_eo, next_slice, depth + 1, bound, next_face);
            if result == FOUND_SENTINEL {
                return FOUND_SENTINEL;
            }
            self.path.pop();
            if self.node_limit_hit {
                return STOP_SENTINEL;
            }
            if result != STOP_SENTINEL {
                min_next = Some(min_next.map_or(result, |current| current.min(result)));
            }
        }

        if self.fail_cache.len() >= PHASE1_FAIL_CACHE_LIMIT {
            self.fail_cache.clear();
        }
        self.fail_cache.insert(cache_key, seen_mask | bit);
        min_next.unwrap_or((bound as u16) + 1)
    }
}

fn solve_phase1(input: &Phase1Input, tables: &TwophaseTables) -> Phase1SolveResult {
    if input.co_idx == 0 && input.eo_idx == 0 && input.slice_idx == tables.solved_slice as usize {
        return Phase1SolveResult {
            ok: true,
            moves: Vec::new(),
            depth: 0,
            nodes: 0,
            reason: String::new(),
        };
    }

    let mut bound = tables
        .co
        .get(input.co_idx)
        .max(tables.eo.get(input.eo_idx))
        .max(tables.slice.get(input.slice_idx))
        .max(1);
    let mut ctx = Phase1SearchCtx {
        tables,
        path: Vec::with_capacity(input.max_depth as usize),
        nodes: 0,
        node_limit: input.node_limit,
        node_limit_hit: false,
        fail_cache: HashMap::new(),
    };

    while bound <= input.max_depth {
        ctx.path.clear();
        let result = ctx.dfs(
            input.co_idx,
            input.eo_idx,
            input.slice_idx,
            0,
            bound,
            LAST_FACE_FREE,
        );
        if result == FOUND_SENTINEL {
            return Phase1SolveResult {
                ok: true,
                moves: ctx.path.clone(),
                depth: ctx.path.len() as u8,
                nodes: ctx.nodes,
                reason: String::new(),
            };
        }
        if ctx.node_limit_hit || result == STOP_SENTINEL {
            break;
        }
        if result > input.max_depth as u16 {
            break;
        }
        bound = result as u8;
    }

    Phase1SolveResult {
        ok: false,
        moves: Vec::new(),
        depth: 0,
        nodes: ctx.nodes,
        reason: if ctx.node_limit_hit {
            "PHASE1_SEARCH_LIMIT".into()
        } else {
            "PHASE1_NOT_FOUND".into()
        },
    }
}

fn solve_phase1_multi(
    input: &Phase1Input,
    tables: &TwophaseTables,
    max_count: usize,
) -> Phase1MultiResult {
    let first = solve_phase1(input, tables);
    if !first.ok {
        return Phase1MultiResult {
            solutions: Vec::new(),
            min_depth: 0,
            nodes: first.nodes,
            reason: first.reason,
        };
    }
    if max_count <= 1 || first.depth == 0 {
        return Phase1MultiResult {
            solutions: vec![first.moves],
            min_depth: first.depth,
            nodes: first.nodes,
            reason: String::new(),
        };
    }

    let mut seen: HashSet<Vec<u8>> = HashSet::new();
    let mut solutions = Vec::new();
    seen.insert(first.moves.clone());
    solutions.push(first.moves.clone());
    let mut enum_path = Vec::with_capacity((first.depth + 1) as usize);
    let mut enum_nodes = 0u64;

    fn enumerate(
        tables: &TwophaseTables,
        co: usize,
        eo: usize,
        slice: usize,
        depth: u8,
        target_depth: u8,
        last_face: u8,
        path: &mut Vec<u8>,
        seen: &mut HashSet<Vec<u8>>,
        solutions: &mut Vec<Vec<u8>>,
        max_count: usize,
        nodes: &mut u64,
    ) {
        if solutions.len() >= max_count {
            return;
        }
        let h = tables
            .co
            .get(co)
            .max(tables.eo.get(eo))
            .max(tables.slice.get(slice));
        if depth.saturating_add(h) > target_depth {
            return;
        }
        if co == 0 && eo == 0 && slice == tables.solved_slice as usize {
            if depth == target_depth {
                let candidate = path.clone();
                if seen.insert(candidate.clone()) {
                    solutions.push(candidate);
                }
            }
            return;
        }
        if depth >= target_depth {
            return;
        }
        for &move_index in &tables.phase1_allowed_moves_by_last_face[last_face as usize] {
            if solutions.len() >= max_count {
                return;
            }
            *nodes += 1;
            let next_co = tables.co_move.get(co, move_index as usize) as usize;
            let next_eo = tables.eo_move.get(eo, move_index as usize) as usize;
            let next_slice = tables.slice_move.get(slice, move_index as usize) as usize;
            path.push(move_index);
            let next_face = tables.move_data.move_face[move_index as usize];
            enumerate(
                tables,
                next_co,
                next_eo,
                next_slice,
                depth + 1,
                target_depth,
                next_face,
                path,
                seen,
                solutions,
                max_count,
                nodes,
            );
            path.pop();
        }
    }

    let mut target = first.depth;
    while solutions.len() < max_count && target <= input.max_depth {
        enumerate(
            tables,
            input.co_idx,
            input.eo_idx,
            input.slice_idx,
            0,
            target,
            LAST_FACE_FREE,
            &mut enum_path,
            &mut seen,
            &mut solutions,
            max_count,
            &mut enum_nodes,
        );
        target += 1;
    }

    Phase1MultiResult {
        solutions,
        min_depth: first.depth,
        nodes: first.nodes + enum_nodes,
        reason: String::new(),
    }
}

struct Phase2SearchCtx<'a> {
    tables: &'a TwophaseTables,
    path: Vec<u8>,
    nodes: u64,
    node_limit: u64,
    node_limit_hit: bool,
    fail_cache: HashMap<u64, u32>,
}

impl<'a> Phase2SearchCtx<'a> {
    fn dfs(
        &mut self,
        cp: usize,
        ep: usize,
        sep: usize,
        depth: u8,
        bound: u8,
        last_face: u8,
    ) -> u16 {
        if self.node_limit_hit {
            return STOP_SENTINEL;
        }
        let h = self
            .tables
            .phase2_cp_sep_joint
            .get(cp * SEP_SIZE + sep)
            .max(self.tables.phase2_ep.get(ep));
        let f = depth.saturating_add(h);
        if f > bound {
            return f as u16;
        }
        if cp == 0 && ep == 0 && sep == 0 {
            return FOUND_SENTINEL;
        }

        let remaining = (bound - depth) as u32;
        let cache_key = ((((cp as u64) * 40320 + ep as u64) * SEP_SIZE as u64 + sep as u64)
            * 7)
            + last_face as u64;
        let seen_mask = self.fail_cache.get(&cache_key).copied().unwrap_or(0);
        let bit = 1u32 << remaining.min(31);
        if (seen_mask & bit) != 0 {
            return STOP_SENTINEL - 1;
        }

        let mut min_next: Option<u16> = None;
        for &move_index in &self.tables.phase2_allowed_moves_by_last_face[last_face as usize] {
            self.nodes += 1;
            if self.node_limit > 0 && self.nodes >= self.node_limit {
                self.node_limit_hit = true;
                return STOP_SENTINEL;
            }
            let next_cp = self.tables.phase2_cp_move.get(cp, move_index as usize) as usize;
            let next_ep = self.tables.phase2_ep_move.get(ep, move_index as usize) as usize;
            let next_sep = self.tables.phase2_sep_move.get(sep, move_index as usize) as usize;
            self.path.push(move_index);
            let result = self.dfs(
                next_cp,
                next_ep,
                next_sep,
                depth + 1,
                bound,
                self.tables.phase2_move_faces[move_index as usize],
            );
            if result == FOUND_SENTINEL {
                return FOUND_SENTINEL;
            }
            self.path.pop();
            if self.node_limit_hit {
                return STOP_SENTINEL;
            }
            if result != STOP_SENTINEL {
                min_next = Some(min_next.map_or(result, |current| current.min(result)));
            }
        }

        if self.fail_cache.len() >= PHASE2_FAIL_CACHE_LIMIT {
            self.fail_cache.clear();
        }
        self.fail_cache.insert(cache_key, seen_mask | bit);
        min_next.unwrap_or((bound as u16) + 1)
    }
}

pub(crate) fn solve_phase2(input: &Phase2Input, tables: &TwophaseTables, max_depth: u8, node_limit: u64) -> Phase2SolveResult {
    if input.cp_idx == 0 && input.ep_idx == 0 && input.sep_idx == 0 {
        return Phase2SolveResult {
            ok: true,
            moves: Vec::new(),
            depth: 0,
            nodes: 0,
            reason: String::new(),
        };
    }

    let mut bound = tables
        .phase2_cp_sep_joint
        .get(input.cp_idx * SEP_SIZE + input.sep_idx)
        .max(tables.phase2_ep.get(input.ep_idx))
        .max(1);
    let mut ctx = Phase2SearchCtx {
        tables,
        path: Vec::with_capacity(max_depth as usize),
        nodes: 0,
        node_limit,
        node_limit_hit: false,
        fail_cache: HashMap::new(),
    };

    while bound <= max_depth {
        ctx.path.clear();
        let result = ctx.dfs(input.cp_idx, input.ep_idx, input.sep_idx, 0, bound, LAST_FACE_FREE);
        if result == FOUND_SENTINEL {
            return Phase2SolveResult {
                ok: true,
                moves: ctx.path.clone(),
                depth: ctx.path.len() as u8,
                nodes: ctx.nodes,
                reason: String::new(),
            };
        }
        if ctx.node_limit_hit || result == STOP_SENTINEL {
            break;
        }
        if result > max_depth as u16 {
            break;
        }
        bound = result as u8;
    }

    Phase2SolveResult {
        ok: false,
        moves: Vec::new(),
        depth: 0,
        nodes: ctx.nodes,
        reason: if ctx.node_limit_hit {
            "PHASE2_SEARCH_LIMIT".into()
        } else {
            "PHASE2_NOT_FOUND".into()
        },
    }
}

fn run_phase2_pass(
    candidates: &[Phase1Candidate],
    tables: &TwophaseTables,
    options: &TwophaseSearchOptions,
    target_total: Option<usize>,
    best_found_total: &mut Option<usize>,
    best_path: &mut Option<Vec<u8>>,
    best_phase1_depth: &mut u8,
    best_phase2_depth: &mut u8,
    phase2_nodes: &mut u64,
) {
    for candidate in candidates {
        let phase1_depth = candidate.moves.len();
        if let Some(target_total) = target_total {
            if phase1_depth >= target_total {
                continue;
            }
        }
        if let Some(best_total) = *best_found_total {
            if phase1_depth >= best_total {
                continue;
            }
        }

        let mut phase2_limit = options.phase2_max_depth as usize;
        if let Some(target_total) = target_total {
            phase2_limit = phase2_limit.min(target_total.saturating_sub(1).saturating_sub(phase1_depth));
        }
        if let Some(best_total) = *best_found_total {
            phase2_limit = phase2_limit.min(best_total.saturating_sub(1).saturating_sub(phase1_depth));
        }
        if phase2_limit > options.phase2_max_depth as usize {
            phase2_limit = options.phase2_max_depth as usize;
        }

        let phase2 = solve_phase2(
            &candidate.phase2_input,
            tables,
            phase2_limit.min(u8::MAX as usize) as u8,
            options.phase2_node_limit,
        );
        *phase2_nodes += phase2.nodes;
        if !phase2.ok {
            continue;
        }

        let mut full_path = candidate.moves.clone();
        for &phase2_move in &phase2.moves {
            full_path.push(tables.phase2_move_indices[phase2_move as usize]);
        }
        let total = full_path.len();
        if best_found_total.map_or(true, |best_total| total < best_total) {
            *best_phase1_depth = candidate.moves.len() as u8;
            *best_phase2_depth = phase2.depth;
            *best_found_total = Some(total);
            *best_path = Some(full_path);
        }
    }
}

struct ExactPhase1SearchCtx<'a> {
    tables: &'a TwophaseTables,
    path: Vec<u8>,
    phase1_nodes: u64,
    phase2_nodes: u64,
    phase1_node_limit: u64,
    phase2_node_limit: u64,
    interrupted: bool,
    interrupt_reason: String,
    fail_cache: HashMap<u128, u32>,
    found_path: Option<Vec<u8>>,
}

impl<'a> ExactPhase1SearchCtx<'a> {
    fn cache_key(&self, state: &CubeState, co: usize, eo: usize, last_face: u8) -> u128 {
        let cp_idx = encode_perm8(&state.cp) as u128;
        let ep_idx = encode_perm12(&state.ep) as u128;
        let mut key = cp_idx;
        key |= (co as u128) << 16;
        key |= (eo as u128) << 28;
        key |= ep_idx << 39;
        key |= (last_face as u128) << 68;
        key
    }

    fn remaining_phase2_budget(&self) -> u64 {
        if self.phase2_node_limit == 0 {
            0
        } else {
            self.phase2_node_limit.saturating_sub(self.phase2_nodes)
        }
    }

    fn dfs(
        &mut self,
        state: &CubeState,
        co: usize,
        eo: usize,
        slice: usize,
        depth: u8,
        target_phase1_depth: u8,
        total_bound: u8,
        last_face: u8,
    ) -> bool {
        if self.interrupted || self.found_path.is_some() {
            return self.found_path.is_some();
        }

        let phase1_h = self
            .tables
            .co
            .get(co)
            .max(self.tables.eo.get(eo))
            .max(self.tables.slice.get(slice));
        if depth.saturating_add(phase1_h) > target_phase1_depth {
            return false;
        }

        let remaining_phase1 = (target_phase1_depth - depth) as u32;
        let cache_key = self.cache_key(state, co, eo, last_face);
        if let Some(mask) = self.fail_cache.get(&cache_key) {
            if remaining_phase1 < 32 && (mask & (1u32 << remaining_phase1)) != 0 {
                return false;
            }
        }

        if depth == target_phase1_depth {
            if co != 0 || eo != 0 || slice != self.tables.solved_slice as usize {
                return false;
            }
            let Some(phase2_input) = build_phase2_input(state) else {
                return false;
            };
            if self.phase2_node_limit > 0 && self.remaining_phase2_budget() == 0 {
                self.interrupted = true;
                self.interrupt_reason = "PHASE2_SEARCH_LIMIT".into();
                return false;
            }
            let phase2 = solve_phase2(
                &phase2_input,
                self.tables,
                total_bound - target_phase1_depth,
                self.remaining_phase2_budget(),
            );
            self.phase2_nodes += phase2.nodes;
            if phase2.ok {
                let mut full_path = self.path.clone();
                for &phase2_move in &phase2.moves {
                    full_path.push(self.tables.phase2_move_indices[phase2_move as usize]);
                }
                self.found_path = Some(full_path);
                return true;
            }
            if phase2.reason == "PHASE2_SEARCH_LIMIT" {
                self.interrupted = true;
                self.interrupt_reason = phase2.reason;
                return false;
            }
            return false;
        }

        for &move_index in &self.tables.phase1_allowed_moves_by_last_face[last_face as usize] {
            self.phase1_nodes += 1;
            if self.phase1_node_limit > 0 && self.phase1_nodes >= self.phase1_node_limit {
                self.interrupted = true;
                self.interrupt_reason = "PHASE1_SEARCH_LIMIT".into();
                return false;
            }

            let next_co = self.tables.co_move.get(co, move_index as usize) as usize;
            let next_eo = self.tables.eo_move.get(eo, move_index as usize) as usize;
            let next_slice = self.tables.slice_move.get(slice, move_index as usize) as usize;
            let next_state = state.apply_move(move_index as usize, &self.tables.move_data);
            self.path.push(move_index);
            let next_face = self.tables.move_data.move_face[move_index as usize];
            if self.dfs(
                &next_state,
                next_co,
                next_eo,
                next_slice,
                depth + 1,
                target_phase1_depth,
                total_bound,
                next_face,
            ) {
                return true;
            }
            self.path.pop();
            if self.interrupted {
                return false;
            }
        }

        if remaining_phase1 < 32 {
            if self.fail_cache.len() >= PHASE1_EXACT_FAIL_CACHE_LIMIT {
                self.fail_cache.clear();
            }
            self.fail_cache
                .entry(cache_key)
                .and_modify(|entry| *entry |= 1u32 << remaining_phase1)
                .or_insert(1u32 << remaining_phase1);
        }
        false
    }
}

pub fn search_twophase_exact_bound(
    scramble: &str,
    tables: &TwophaseTables,
    options: &TwophaseExactOptions,
) -> TwophaseExactSearchResult {
    let moves = match parse_scramble(scramble, &tables.move_data) {
        Ok(moves) => moves,
        Err(reason) => {
            return TwophaseExactSearchResult {
                ok: false,
                found: false,
                interrupted: false,
                solution: String::new(),
                move_count: 0,
                nodes: 0,
                phase1_nodes: 0,
                phase2_nodes: 0,
                bound: options.max_total_depth,
                reason,
            };
        }
    };

    let initial_state = CubeState::solved().apply_moves(&moves, &tables.move_data);
    let co_idx = encode_co(&initial_state.co);
    let eo_idx = encode_eo(&initial_state.eo);
    let slice_idx = encode_slice_from_ep(&initial_state.ep);
    let mut ctx = ExactPhase1SearchCtx {
        tables,
        path: Vec::with_capacity(options.max_total_depth as usize),
        phase1_nodes: 0,
        phase2_nodes: 0,
        phase1_node_limit: options.phase1_node_limit,
        phase2_node_limit: options.phase2_node_limit,
        interrupted: false,
        interrupt_reason: String::new(),
        fail_cache: HashMap::new(),
        found_path: None,
    };

    let min_phase1_depth = tables
        .co
        .get(co_idx)
        .max(tables.eo.get(eo_idx))
        .max(tables.slice.get(slice_idx));
    let mut found = false;
    for target_phase1_depth in min_phase1_depth..=options.max_total_depth {
        ctx.path.clear();
        ctx.fail_cache.clear();
        if ctx.dfs(
            &initial_state,
            co_idx,
            eo_idx,
            slice_idx,
            0,
            target_phase1_depth,
            options.max_total_depth,
            LAST_FACE_FREE,
        ) {
            found = true;
            break;
        }
        if ctx.interrupted {
            break;
        }
    }

    if let Some(path) = ctx.found_path {
        let solution = solution_string_from_path(&path, &tables.move_data);
        return TwophaseExactSearchResult {
            ok: true,
            found,
            interrupted: false,
            move_count: path.len() as u32,
            nodes: ctx.phase1_nodes + ctx.phase2_nodes,
            phase1_nodes: ctx.phase1_nodes,
            phase2_nodes: ctx.phase2_nodes,
            bound: options.max_total_depth,
            solution,
            reason: String::new(),
        };
    }

    TwophaseExactSearchResult {
        ok: true,
        found: false,
        interrupted: ctx.interrupted,
        solution: String::new(),
        move_count: 0,
        nodes: ctx.phase1_nodes + ctx.phase2_nodes,
        phase1_nodes: ctx.phase1_nodes,
        phase2_nodes: ctx.phase2_nodes,
        bound: options.max_total_depth,
        reason: if ctx.interrupt_reason.is_empty() {
            String::new()
        } else {
            ctx.interrupt_reason
        },
    }
}

impl TwophaseSession {
    pub fn prepare(
        scramble: &str,
        tables: &TwophaseTables,
        options: &TwophasePrepareOptions,
    ) -> Result<Self, String> {
        let moves = parse_scramble(scramble, &tables.move_data)?;
        let initial_state = CubeState::solved().apply_moves(&moves, &tables.move_data);
        let phase1_input = build_phase1_input(
            &initial_state,
            options.phase1_max_depth,
            options.phase1_node_limit,
        );
        let phase1 = solve_phase1_multi(
            &phase1_input,
            tables,
            options.max_phase1_solutions.max(1),
        );
        if phase1.solutions.is_empty() {
            return Err(if phase1.reason.is_empty() {
                "PHASE1_NOT_FOUND".into()
            } else {
                phase1.reason
            });
        }

        let mut candidates = Vec::new();
        for solution in phase1.solutions {
            let phase1_state = initial_state.apply_moves(&solution, &tables.move_data);
            let Some(phase2_input) = build_phase2_input(&phase1_state) else {
                continue;
            };
            candidates.push(Phase1Candidate {
                moves: solution,
                phase2_input,
            });
        }
        if candidates.is_empty() {
            return Err("PHASE2_INPUT_INVALID".into());
        }

        Ok(Self {
            phase1_nodes: phase1.nodes,
            phase1_min_depth: phase1.min_depth,
            candidates,
        })
    }

    pub fn phase1_nodes(&self) -> u64 {
        self.phase1_nodes
    }

    pub fn phase1_min_depth(&self) -> u8 {
        self.phase1_min_depth
    }

    pub fn candidate_count(&self) -> usize {
        self.candidates.len()
    }

    pub fn search(
        &self,
        tables: &TwophaseTables,
        options: &TwophaseSearchOptions,
    ) -> TwophaseSearchResult {
        let mut best_path: Option<Vec<u8>> = None;
        let mut best_phase1_depth = 0u8;
        let mut best_phase2_depth = 0u8;
        let mut best_found_total: Option<usize> = None;
        let mut phase2_nodes = 0u64;

        run_phase2_pass(
            &self.candidates,
            tables,
            options,
            options.incumbent_length.map(|value| value as usize),
            &mut best_found_total,
            &mut best_path,
            &mut best_phase1_depth,
            &mut best_phase2_depth,
            &mut phase2_nodes,
        );
        if best_found_total.is_none() {
            run_phase2_pass(
                &self.candidates,
                tables,
                options,
                None,
                &mut best_found_total,
                &mut best_path,
                &mut best_phase1_depth,
                &mut best_phase2_depth,
                &mut phase2_nodes,
            );
        }

        if let Some(path) = best_path {
            let solution = solution_string_from_path(&path, &tables.move_data);
            return TwophaseSearchResult {
                ok: true,
                solution,
                move_count: path.len() as u32,
                nodes: self.phase1_nodes + phase2_nodes,
                phase1_nodes: self.phase1_nodes,
                phase2_nodes,
                phase1_depth: best_phase1_depth,
                phase2_depth: best_phase2_depth,
                candidate_count: self.candidates.len(),
                reason: String::new(),
            };
        }

        TwophaseSearchResult {
            ok: false,
            solution: String::new(),
            move_count: 0,
            nodes: self.phase1_nodes + phase2_nodes,
            phase1_nodes: self.phase1_nodes,
            phase2_nodes,
            phase1_depth: self.phase1_min_depth,
            phase2_depth: 0,
            candidate_count: self.candidates.len(),
            reason: "PHASE2_NOT_FOUND".into(),
        }
    }
}