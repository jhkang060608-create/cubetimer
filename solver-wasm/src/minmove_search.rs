use rustc_hash::FxHashMap;
use std::sync::Arc;

use crate::minmove_bundle::MinmoveTables;
use crate::minmove_core::{
    apply_move_to_edge_perm_subset_state, apply_move_to_edge_subset_state,
    edge_perm_subset_state_from_full, edge_subset_state_from_full, encode_co,
    encode_edge_perm_subset_state, encode_edge_subset_state, encode_eo, encode_perm8,
    encode_slice_from_ep, parse_scramble, solution_string_from_path, CubeState,
    EdgePermSubsetState, EdgeSubsetState, CO_SIZE, EDGE_PERM_SUBSET_A, EDGE_PERM_SUBSET_B,
    EDGE_SUBSET_A, EDGE_SUBSET_B, EDGE_SUBSET_C, EDGE_SUBSET_D, EO_SIZE, LAST_FACE_FREE,
    MOVE_COUNT,
};

const FAIL_CACHE_LIMIT: usize = 4_000_000;
const REVERSE_FRONTIER_MAX_DEPTH: u8 = 5;
const REVERSE_FRONTIER_MAX_STATES: usize = 1_000_000;
const MOVE_BITS: u64 = 5;

/// Lightweight DFS node that tracks coordinate indices for fast move/pruning
/// plus incrementally maintained edge-subset states for heuristic lookups.
#[derive(Clone, Copy, Debug)]
pub struct CoordNode {
    pub co: u16,
    pub eo: u16,
    pub slice: u16,
    pub cp: u16,
    pub esa_idx: u32,
    pub esb_idx: u32,
    pub esc_idx: u32,
    pub esd_idx: u32,
    pub epsa_idx: u32,
    pub epsb_idx: u32,
    /// Combined 8-corner index: cp * CO_SIZE + co. Used for the corner_full PDB table.
    pub corner_full_idx: u32,
    pub esa: EdgeSubsetState,
    pub esb: EdgeSubsetState,
    pub esc: EdgeSubsetState,
    pub esd: EdgeSubsetState,
    pub epsa: EdgePermSubsetState,
    pub epsb: EdgePermSubsetState,
}

fn coord_node_from_state(state: &CubeState) -> CoordNode {
    let esa = edge_subset_state_from_full(&state.ep, &state.eo, &EDGE_SUBSET_A);
    let esb = edge_subset_state_from_full(&state.ep, &state.eo, &EDGE_SUBSET_B);
    let esc = edge_subset_state_from_full(&state.ep, &state.eo, &EDGE_SUBSET_C);
    let esd = edge_subset_state_from_full(&state.ep, &state.eo, &EDGE_SUBSET_D);
    let epsa = edge_perm_subset_state_from_full(&state.ep, &EDGE_PERM_SUBSET_A);
    let epsb = edge_perm_subset_state_from_full(&state.ep, &EDGE_PERM_SUBSET_B);
    let cp_idx = encode_perm8(&state.cp) as u32;
    let co_idx = encode_co(&state.co) as u32;
    CoordNode {
        co: co_idx as u16,
        eo: encode_eo(&state.eo) as u16,
        slice: encode_slice_from_ep(&state.ep) as u16,
        cp: cp_idx as u16,
        esa_idx: encode_edge_subset_state(&esa) as u32,
        esb_idx: encode_edge_subset_state(&esb) as u32,
        esc_idx: encode_edge_subset_state(&esc) as u32,
        esd_idx: encode_edge_subset_state(&esd) as u32,
        epsa_idx: encode_edge_perm_subset_state(&epsa) as u32,
        epsb_idx: encode_edge_perm_subset_state(&epsb) as u32,
        corner_full_idx: cp_idx * CO_SIZE as u32 + co_idx,
        esa,
        esb,
        esc,
        esd,
        epsa,
        epsb,
    }
}

/// Apply a move to a CoordNode using precomputed coordinate move tables.
/// Edge-subset states are updated incrementally instead of re-scanning full edges.
#[inline(always)]
fn apply_move_coord(node: CoordNode, move_idx: usize, tables: &MinmoveTables) -> CoordNode {
    let new_co = tables.co_move.get(node.co as usize, move_idx);
    let new_eo = tables.eo_move.get(node.eo as usize, move_idx);
    let new_slice = tables.slice_move.get(node.slice as usize, move_idx);
    let new_cp = tables.cp_move.get(node.cp as usize, move_idx);
    let new_esa = apply_move_to_edge_subset_state(&node.esa, move_idx, &tables.move_data);
    let new_esb = apply_move_to_edge_subset_state(&node.esb, move_idx, &tables.move_data);
    let new_esc = apply_move_to_edge_subset_state(&node.esc, move_idx, &tables.move_data);
    let new_esd = apply_move_to_edge_subset_state(&node.esd, move_idx, &tables.move_data);
    let new_epsa = apply_move_to_edge_perm_subset_state(&node.epsa, move_idx, &tables.move_data);
    let new_epsb = apply_move_to_edge_perm_subset_state(&node.epsb, move_idx, &tables.move_data);
    CoordNode {
        co: new_co,
        eo: new_eo,
        slice: new_slice,
        cp: new_cp,
        esa_idx: encode_edge_subset_state(&new_esa) as u32,
        esb_idx: encode_edge_subset_state(&new_esb) as u32,
        esc_idx: encode_edge_subset_state(&new_esc) as u32,
        esd_idx: encode_edge_subset_state(&new_esd) as u32,
        epsa_idx: encode_edge_perm_subset_state(&new_epsa) as u32,
        epsb_idx: encode_edge_perm_subset_state(&new_epsb) as u32,
        corner_full_idx: new_cp as u32 * CO_SIZE as u32 + new_co as u32,
        esa: new_esa,
        esb: new_esb,
        esc: new_esc,
        esd: new_esd,
        epsa: new_epsa,
        epsb: new_epsb,
    }
}

struct NodeEval {
    lower_bound: u8,
}

#[derive(Clone, Copy, Debug)]
struct ReverseEntry {
    depth: u8,
    path_code: u64,
}

#[derive(Debug)]
struct ReverseFrontier {
    max_depth: u8,
    entries: FxHashMap<u128, ReverseEntry>,
}

#[derive(Debug)]
pub struct MinmoveBidirectionalContext {
    pub reverse_depth: u8,
    pub reverse_states: usize,
    reverse_frontier: ReverseFrontier,
    inverse_moves: [u8; MOVE_COUNT],
}

#[derive(Clone, Copy, Debug)]
struct ReverseBuildNode {
    node: CoordNode,
    path_code: u64,
}

#[inline(always)]
fn append_path_code(path_code: u64, move_index: u8, depth: u8) -> u64 {
    path_code | ((move_index as u64) << ((depth as u64) * MOVE_BITS))
}

#[inline(always)]
fn exact_state_key(node: &CoordNode) -> u128 {
    let mut key = node.cp as u128;
    key |= (node.co as u128) << 16;
    key |= (node.esa_idx as u128) << 28;
    key |= (node.esb_idx as u128) << 54;
    key
}

fn inverse_move_name(name: &str) -> String {
    if name.ends_with('2') {
        return name.to_string();
    }
    if let Some(stripped) = name.strip_suffix('\'') {
        return stripped.to_string();
    }
    format!("{name}'")
}

fn build_inverse_moves(tables: &MinmoveTables) -> Result<[u8; MOVE_COUNT], String> {
    let mut inverse = [0u8; MOVE_COUNT];
    for (move_index, name) in tables.move_data.move_names.iter().enumerate() {
        let inverse_name = inverse_move_name(name);
        let Some(inverse_index) = tables
            .move_data
            .move_names
            .iter()
            .position(|candidate| candidate == &inverse_name)
        else {
            return Err(format!("missing inverse move for {name}"));
        };
        inverse[move_index] = inverse_index as u8;
    }
    Ok(inverse)
}

fn build_reverse_frontier(tables: &MinmoveTables) -> ReverseFrontier {
    let solved_node = coord_node_from_state(&CubeState::solved());
    let solved_key = exact_state_key(&solved_node);
    let mut entries = FxHashMap::default();
    entries.reserve(REVERSE_FRONTIER_MAX_STATES.min(65_536));
    entries.insert(
        solved_key,
        ReverseEntry {
            depth: 0,
            path_code: 0,
        },
    );

    let mut current_layer = vec![ReverseBuildNode {
        node: solved_node,
        path_code: 0,
    }];
    let mut completed_depth = 0u8;

    for next_depth in 1..=REVERSE_FRONTIER_MAX_DEPTH {
        let prior_depth = next_depth - 1;
        let mut pending: FxHashMap<u128, ReverseBuildNode> = FxHashMap::default();
        for current in &current_layer {
            for move_index in 0..MOVE_COUNT {
                let next_node = apply_move_coord(current.node, move_index, tables);
                let key = exact_state_key(&next_node);
                if entries.contains_key(&key) || pending.contains_key(&key) {
                    continue;
                }
                pending.insert(
                    key,
                    ReverseBuildNode {
                        node: next_node,
                        path_code: append_path_code(current.path_code, move_index as u8, prior_depth),
                    },
                );
            }
        }

        if pending.is_empty() || entries.len().saturating_add(pending.len()) > REVERSE_FRONTIER_MAX_STATES {
            break;
        }

        let mut next_layer = Vec::with_capacity(pending.len());
        for (key, build_node) in pending.into_iter() {
            entries.insert(
                key,
                ReverseEntry {
                    depth: next_depth,
                    path_code: build_node.path_code,
                },
            );
            next_layer.push(build_node);
        }
        current_layer = next_layer;
        completed_depth = next_depth;
    }

    ReverseFrontier {
        max_depth: completed_depth,
        entries,
    }
}

pub fn build_bidirectional_context(
    tables: &MinmoveTables,
) -> Result<Arc<MinmoveBidirectionalContext>, String> {
    let reverse_frontier = build_reverse_frontier(tables);
    let inverse_moves = build_inverse_moves(tables)?;
    Ok(Arc::new(MinmoveBidirectionalContext {
        reverse_depth: reverse_frontier.max_depth,
        reverse_states: reverse_frontier.entries.len(),
        reverse_frontier,
        inverse_moves,
    }))
}

/// Evaluate a node: compute edge-subset indices and lower bound.
/// Lower bound = max of the available admissible quotient tables.
/// If lower_bound == 0, the cube is solved (proven by parity for the 2 uncovered edges).
#[inline(always)]
fn eval_node(node: &CoordNode, tables: &MinmoveTables) -> NodeEval {
    let esa_idx = node.esa_idx as usize;
    let esb_idx = node.esb_idx as usize;
    let esc_idx = node.esc_idx as usize;
    let esd_idx = node.esd_idx as usize;
    let epsa_idx = node.epsa_idx as usize;
    let epsb_idx = node.epsb_idx as usize;
    let co_eo_idx = node.co as usize * EO_SIZE + node.eo as usize;
    let co_slice_idx = node.co as usize * crate::minmove_core::SLICE_SIZE + node.slice as usize;
    let cp_slice_idx = node.cp as usize * crate::minmove_core::SLICE_SIZE + node.slice as usize;
    let cp_eo_idx = node.cp as usize * EO_SIZE + node.eo as usize;
    let corner_full_idx = node.corner_full_idx as usize;
    let lb = tables.co_eo_joint.get(co_eo_idx)
        .max(tables.co_slice_joint.get(co_slice_idx))
        .max(tables.cp_slice_joint.get(cp_slice_idx))
        .max(tables.cp_eo_joint.get(cp_eo_idx))
        .max(tables.corner_full.get(corner_full_idx))
        .max(tables.cp.get(node.cp as usize))
        .max(tables.slice.get(node.slice as usize))
        .max(tables.edge_subset_a.get(esa_idx))
        .max(tables.edge_subset_b.get(esb_idx))
        .max(tables.edge_subset_c.get(esc_idx.min(tables.edge_subset_c.count.saturating_sub(1))))
        .max(tables.edge_subset_d.get(esd_idx.min(tables.edge_subset_d.count.saturating_sub(1))))
        .max(tables.edge_perm_subset_a.get(epsa_idx))
        .max(tables.edge_perm_subset_b.get(epsb_idx));
    NodeEval { lower_bound: lb }
}

#[derive(Debug)]
pub struct SearchSession {
    pub initial_node: CoordNode,
    pub lower_bound: u8,
    pub reverse_depth: u8,
    pub reverse_states: usize,
    bidirectional: Arc<MinmoveBidirectionalContext>,
    fail_cache: FxHashMap<u128, u64>,
}

#[derive(Clone, Debug)]
pub struct SearchBoundResult {
    pub found: bool,
    /// True when the DFS was stopped early because the node budget was exhausted.
    /// In this case `found` is always false and the bound is unproven.
    pub interrupted: bool,
    pub bound: u8,
    pub nodes: u64,
    pub path: Vec<u8>,
}

impl SearchSession {
    pub fn prepare(
        scramble: &str,
        tables: &MinmoveTables,
        bidirectional: Arc<MinmoveBidirectionalContext>,
    ) -> Result<Self, String> {
        let moves = parse_scramble(scramble, &tables.move_data)?;
        let state = CubeState::solved().apply_moves(&moves, &tables.move_data);
        let initial_node = coord_node_from_state(&state);
        let eval = eval_node(&initial_node, tables);
        Ok(Self {
            initial_node,
            lower_bound: eval.lower_bound,
            reverse_depth: bidirectional.reverse_depth,
            reverse_states: bidirectional.reverse_states,
            bidirectional,
            fail_cache: FxHashMap::default(),
        })
    }

    pub fn search_bound(&mut self, tables: &MinmoveTables, bound: u8, max_nodes: u64) -> SearchBoundResult {
        let mut nodes = 0u64;
        let mut path = Vec::with_capacity(bound as usize);
        let mut interrupted = false;
        let initial = self.initial_node;
        let found = self.dfs(
            initial,
            tables,
            0,
            bound,
            LAST_FACE_FREE,
            &mut path,
            &mut nodes,
            max_nodes,
            &mut interrupted,
        );
        SearchBoundResult { found, interrupted, bound, nodes, path }
    }

    fn dfs(
        &mut self,
        node: CoordNode,
        tables: &MinmoveTables,
        depth: u8,
        bound: u8,
        last_face: u8,
        path: &mut Vec<u8>,
        nodes: &mut u64,
        max_nodes: u64,
        interrupted: &mut bool,
    ) -> bool {
        *nodes += 1;
        if *nodes >= max_nodes {
            *interrupted = true;
            return false;
        }

        let remaining_depth = bound.saturating_sub(depth);
        if self.try_reverse_meet(node, remaining_depth, path) {
            return true;
        }
        if remaining_depth <= self.reverse_depth {
            return false;
        }

        let eval = eval_node(&node, tables);
        // lb == 0 ↔ cube solved (CO+EO joint, CP+Slice joint, CP, Slice, ESA, ESB all at solved indices;
        // the 2 uncovered edges must also be solved by parity of a valid cube state).
        if eval.lower_bound == 0 {
            return true;
        }
        if depth.saturating_add(eval.lower_bound) > bound {
            return false;
        }

        let remaining_depth = remaining_depth as usize;

        // Cache key uses corners plus both 6-edge subset coordinates. These two subset
        // coordinates together still capture the full edge permutation+orientation state.
        let cache_key = {
            let mut key = node.cp as u128;
            key |= (node.co as u128) << 16;
            key |= (node.esa_idx as u128) << 32;
            key |= (node.esb_idx as u128) << 58;
            key |= (last_face as u128) << 84;
            key
        };
        if let Some(mask) = self.fail_cache.get(&cache_key) {
            if remaining_depth < 64 && (mask & (1u64 << remaining_depth)) != 0 {
                return false;
            }
        }

        let allowed_moves = &tables.allowed_moves_by_last_face[last_face as usize];
        for &move_index in allowed_moves {
            let next_node = apply_move_coord(node, move_index as usize, tables);
            path.push(move_index);
            let next_face = tables.move_data.move_face[move_index as usize];
            if self.dfs(next_node, tables, depth + 1, bound, next_face, path, nodes, max_nodes, interrupted) {
                return true;
            }
            path.pop();
            if *interrupted {
                return false;
            }
        }

        if !*interrupted && remaining_depth < 64 {
            if self.fail_cache.len() >= FAIL_CACHE_LIMIT {
                self.fail_cache.clear();
            }
            let mask = 1u64 << remaining_depth;
            self.fail_cache
                .entry(cache_key)
                .and_modify(|entry| *entry |= mask)
                .or_insert(mask);
        }
        false
    }

    fn try_reverse_meet(&self, node: CoordNode, remaining_depth: u8, path: &mut Vec<u8>) -> bool {
        let Some(entry) = self.bidirectional.reverse_frontier.entries.get(&exact_state_key(&node)) else {
            return false;
        };
        if entry.depth > remaining_depth {
            return false;
        }
        for reverse_index in (0..entry.depth).rev() {
            let move_index = ((entry.path_code >> ((reverse_index as u64) * MOVE_BITS)) & 0x1f) as u8;
            path.push(self.bidirectional.inverse_moves[move_index as usize]);
        }
        true
    }
}

pub fn search_to_string(result: &SearchBoundResult, tables: &MinmoveTables) -> String {
    solution_string_from_path(&result.path, &tables.move_data)
}