use crate::minmove_core::{
    apply_move_to_edge_perm_subset_state, apply_move_to_edge_subset_state, choose, decode_co,
    decode_edge_perm_subset_state, decode_edge_subset_state, decode_eo, decode_perm8,
    decode_slice_index, encode_co, encode_edge_perm_subset_state, encode_edge_subset_state,
    encode_eo, encode_perm8, edge_subset_state_from_full,
    EdgePermSubsetState, EdgeSubsetState, MoveData, CO_SIZE, CORNER_COUNT, CORNER_FULL_SIZE,
    CP_SIZE, EDGE_COUNT, EDGE_PERM_SUBSET_A, EDGE_PERM_SUBSET_B, EDGE_PERM_SUBSET_SIZE,
    EDGE_SUBSET_A, EDGE_SUBSET_B, EDGE_SUBSET_C, EDGE_SUBSET_D, EDGE_SUBSET_SIZE, EO_SIZE,
    MOVE_COUNT, SLICE_SIZE,
};

const NOT_SET: u8 = 255;

#[derive(Clone, Debug)]
pub struct GeneratedTables {
    pub co: Vec<u8>,
    pub eo: Vec<u8>,
    pub slice: Vec<u8>,
    pub cp: Vec<u8>,
    /// Joint CO×Slice distance table, indexed as co_idx * SLICE_SIZE + slice_idx
    pub co_slice_joint: Vec<u8>,
    /// Joint CP×Slice distance table, indexed as cp_idx * SLICE_SIZE + slice_idx
    pub cp_slice_joint: Vec<u8>,
    /// Joint CP×EO distance table, indexed as cp_idx * EO_SIZE + eo_idx
    pub cp_eo_joint: Vec<u8>,
    pub edge_subset_a: Vec<u8>,
    pub edge_subset_b: Vec<u8>,
    pub edge_subset_c: Vec<u8>,
    pub edge_subset_d: Vec<u8>,
    pub edge_perm_subset_a: Vec<u8>,
    pub edge_perm_subset_b: Vec<u8>,
    /// Joint CO×EO distance table, indexed as co_idx * EO_SIZE + eo_idx
    pub co_eo_joint: Vec<u8>,
    /// Full 8-corner (CP + CO) joint table, indexed as cp_idx * CO_SIZE + co_idx
    pub corner_full: Vec<u8>,
    // Coordinate move tables (u16)
    pub co_move: Vec<u16>,
    pub eo_move: Vec<u16>,
    pub cp_move: Vec<u16>,
    pub slice_move: Vec<u16>,
}

fn bfs_from_move_table_u16(move_table: &[u16], size: usize, start_state: usize) -> Vec<u8> {
    let mut dist = vec![NOT_SET; size];
    let mut queue = vec![0u32; size];
    let mut head = 0usize;
    let mut tail = 0usize;
    dist[start_state] = 0;
    queue[tail] = start_state as u32;
    tail += 1;
    while head < tail {
        let state = queue[head] as usize;
        head += 1;
        let next_depth = dist[state] + 1;
        let base = state * MOVE_COUNT;
        for move_index in 0..MOVE_COUNT {
            let next_state = move_table[base + move_index] as usize;
            if dist[next_state] != NOT_SET {
                continue;
            }
            dist[next_state] = next_depth;
            queue[tail] = next_state as u32;
            tail += 1;
        }
    }
    dist
}

fn build_co_move_table(move_data: &MoveData) -> Vec<u16> {
    let mut table = vec![0u16; CO_SIZE * MOVE_COUNT];
    let mut state = [0u8; CORNER_COUNT];
    let mut next = [0u8; CORNER_COUNT];
    for index in 0..CO_SIZE {
        decode_co(index, &mut state);
        let base = index * MOVE_COUNT;
        for move_index in 0..MOVE_COUNT {
            let move_base = move_index * CORNER_COUNT;
            for position in 0..CORNER_COUNT {
                let old_pos = move_data.corner_perm_map[move_base + position] as usize;
                next[position] = (state[old_pos] + move_data.corner_ori_delta[move_base + position]) % 3;
            }
            table[base + move_index] = encode_co(&next) as u16;
        }
    }
    table
}

fn build_eo_move_table(move_data: &MoveData) -> Vec<u16> {
    let mut table = vec![0u16; EO_SIZE * MOVE_COUNT];
    let mut state = [0u8; EDGE_COUNT];
    let mut next = [0u8; EDGE_COUNT];
    for index in 0..EO_SIZE {
        decode_eo(index, &mut state);
        let base = index * MOVE_COUNT;
        for move_index in 0..MOVE_COUNT {
            let move_base = move_index * EDGE_COUNT;
            for position in 0..EDGE_COUNT {
                let old_pos = move_data.edge_perm_map[move_base + position] as usize;
                next[position] = (state[old_pos] + move_data.edge_ori_delta[move_base + position]) & 1;
            }
            table[base + move_index] = encode_eo(&next) as u16;
        }
    }
    table
}

fn build_cp_move_table(move_data: &MoveData) -> Vec<u16> {
    let mut table = vec![0u16; CP_SIZE * MOVE_COUNT];
    let mut state = [0u8; CORNER_COUNT];
    let mut next = [0u8; CORNER_COUNT];
    for index in 0..CP_SIZE {
        decode_perm8(index, &mut state);
        let base = index * MOVE_COUNT;
        for move_index in 0..MOVE_COUNT {
            let move_base = move_index * CORNER_COUNT;
            for position in 0..CORNER_COUNT {
                next[position] = state[move_data.corner_perm_map[move_base + position] as usize];
            }
            table[base + move_index] = encode_perm8(&next) as u16;
        }
    }
    table
}

fn encode_slice_from_occupancy(occupancy: &[u8; EDGE_COUNT]) -> usize {
    let mut index = 0usize;
    let mut remaining = 4usize;
    for position in (0..EDGE_COUNT).rev() {
        if occupancy[position] == 0 {
            continue;
        }
        index += choose(position, remaining);
        remaining -= 1;
        if remaining == 0 {
            break;
        }
    }
    index
}

fn build_slice_move_table(move_data: &MoveData) -> Vec<u16> {
    let mut table = vec![0u16; SLICE_SIZE * MOVE_COUNT];
    let mut state = [0u8; EDGE_COUNT];
    let mut next = [0u8; EDGE_COUNT];
    for index in 0..SLICE_SIZE {
        decode_slice_index(index, &mut state);
        let base = index * MOVE_COUNT;
        for move_index in 0..MOVE_COUNT {
            let move_base = move_index * EDGE_COUNT;
            for position in 0..EDGE_COUNT {
                next[position] = state[move_data.edge_perm_map[move_base + position] as usize];
            }
            table[base + move_index] = encode_slice_from_occupancy(&next) as u16;
        }
    }
    table
}

fn build_edge_subset_dist(move_data: &MoveData, subset: &[u8; 6]) -> Vec<u8> {
    let mut dist = vec![NOT_SET; EDGE_SUBSET_SIZE];
    let mut queue = vec![0u32; EDGE_SUBSET_SIZE];
    let mut head = 0usize;
    let mut tail = 0usize;
    let start = EdgeSubsetState::solved(subset);
    let start_index = encode_edge_subset_state(&start);
    dist[start_index] = 0;
    queue[tail] = start_index as u32;
    tail += 1;

    while head < tail {
        let state_index = queue[head] as usize;
        head += 1;
        let state = decode_edge_subset_state(state_index);
        let next_depth = dist[state_index] + 1;
        for move_index in 0..MOVE_COUNT {
            let next = apply_move_to_edge_subset_state(&state, move_index, move_data);
            let next_index = encode_edge_subset_state(&next);
            if dist[next_index] != NOT_SET {
                continue;
            }
            dist[next_index] = next_depth;
            queue[tail] = next_index as u32;
            tail += 1;
        }
    }

    dist
}

fn build_edge_perm_subset_dist(move_data: &MoveData, subset: &[u8; 8]) -> Vec<u8> {
    let mut dist = vec![NOT_SET; EDGE_PERM_SUBSET_SIZE];
    let mut queue = vec![0u32; EDGE_PERM_SUBSET_SIZE];
    let mut head = 0usize;
    let mut tail = 0usize;
    let start = EdgePermSubsetState::solved(subset);
    let start_index = encode_edge_perm_subset_state(&start);
    dist[start_index] = 0;
    queue[tail] = start_index as u32;
    tail += 1;

    while head < tail {
        let state_index = queue[head] as usize;
        head += 1;
        let state = decode_edge_perm_subset_state(state_index);
        let next_depth = dist[state_index] + 1;
        for move_index in 0..MOVE_COUNT {
            let next = apply_move_to_edge_perm_subset_state(&state, move_index, move_data);
            let next_index = encode_edge_perm_subset_state(&next);
            if dist[next_index] != NOT_SET {
                continue;
            }
            dist[next_index] = next_depth;
            queue[tail] = next_index as u32;
            tail += 1;
        }
    }

    dist
}

/// BFS over the joint (CO, EO) coordinate space.
/// Index: co_idx * EO_SIZE + eo_idx. Solved state = index 0.
pub fn build_co_eo_joint_dist(co_move: &[u16], eo_move: &[u16]) -> Vec<u8> {
    let size = CO_SIZE * EO_SIZE;
    let mut dist = vec![NOT_SET; size];
    let mut queue = Vec::with_capacity(size);
    dist[0] = 0;
    queue.push(0u32);
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head] as usize;
        head += 1;
        let co_idx = idx / EO_SIZE;
        let eo_idx = idx % EO_SIZE;
        let next_depth = dist[idx] + 1;
        let co_base = co_idx * MOVE_COUNT;
        let eo_base = eo_idx * MOVE_COUNT;
        for m in 0..MOVE_COUNT {
            let next_co = co_move[co_base + m] as usize;
            let next_eo = eo_move[eo_base + m] as usize;
            let next_idx = next_co * EO_SIZE + next_eo;
            if dist[next_idx] != NOT_SET {
                continue;
            }
            dist[next_idx] = next_depth;
            queue.push(next_idx as u32);
        }
    }
    dist
}

/// BFS over the joint (CO, Slice) coordinate space.
/// Index: co_idx * SLICE_SIZE + slice_idx. Solved state = 0 * SLICE_SIZE + solved_slice_idx.
pub fn build_co_slice_joint_dist(
    co_move: &[u16],
    slice_move: &[u16],
    solved_slice_idx: usize,
) -> Vec<u8> {
    let size = CO_SIZE * SLICE_SIZE;
    let mut dist = vec![NOT_SET; size];
    let mut queue = Vec::with_capacity(size);
    let start_idx = solved_slice_idx;
    dist[start_idx] = 0;
    queue.push(start_idx as u32);
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head] as usize;
        head += 1;
        let co_idx = idx / SLICE_SIZE;
        let slice_idx = idx % SLICE_SIZE;
        let next_depth = dist[idx] + 1;
        let co_base = co_idx * MOVE_COUNT;
        let slice_base = slice_idx * MOVE_COUNT;
        for m in 0..MOVE_COUNT {
            let next_co = co_move[co_base + m] as usize;
            let next_slice = slice_move[slice_base + m] as usize;
            let next_idx = next_co * SLICE_SIZE + next_slice;
            if dist[next_idx] != NOT_SET {
                continue;
            }
            dist[next_idx] = next_depth;
            queue.push(next_idx as u32);
        }
    }
    dist
}

/// BFS over the joint (CP, Slice) coordinate space.
/// Index: cp_idx * SLICE_SIZE + slice_idx. Solved state = 0 * SLICE_SIZE + solved_slice_idx.
pub fn build_cp_slice_joint_dist(cp_move: &[u16], slice_move: &[u16], solved_slice_idx: usize) -> Vec<u8> {
    let size = CP_SIZE * SLICE_SIZE;
    let mut dist = vec![NOT_SET; size];
    let mut queue = Vec::with_capacity(size);
    let start_idx = solved_slice_idx;
    dist[start_idx] = 0;
    queue.push(start_idx as u32);
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head] as usize;
        head += 1;
        let cp_idx = idx / SLICE_SIZE;
        let slice_idx = idx % SLICE_SIZE;
        let next_depth = dist[idx] + 1;
        let cp_base = cp_idx * MOVE_COUNT;
        let slice_base = slice_idx * MOVE_COUNT;
        for m in 0..MOVE_COUNT {
            let next_cp = cp_move[cp_base + m] as usize;
            let next_slice = slice_move[slice_base + m] as usize;
            let next_idx = next_cp * SLICE_SIZE + next_slice;
            if dist[next_idx] != NOT_SET {
                continue;
            }
            dist[next_idx] = next_depth;
            queue.push(next_idx as u32);
        }
    }
    dist
}

/// BFS over the joint (CP, EO) coordinate space.
/// Index: cp_idx * EO_SIZE + eo_idx. Solved state = index 0.
pub fn build_cp_eo_joint_dist(cp_move: &[u16], eo_move: &[u16]) -> Vec<u8> {
    let size = CP_SIZE * EO_SIZE;
    let mut dist = vec![NOT_SET; size];
    let mut queue = Vec::with_capacity(size);
    dist[0] = 0;
    queue.push(0u32);
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head] as usize;
        head += 1;
        let cp_idx = idx / EO_SIZE;
        let eo_idx = idx % EO_SIZE;
        let next_depth = dist[idx] + 1;
        let cp_base = cp_idx * MOVE_COUNT;
        let eo_base = eo_idx * MOVE_COUNT;
        for m in 0..MOVE_COUNT {
            let next_cp = cp_move[cp_base + m] as usize;
            let next_eo = eo_move[eo_base + m] as usize;
            let next_idx = next_cp * EO_SIZE + next_eo;
            if dist[next_idx] != NOT_SET {
                continue;
            }
            dist[next_idx] = next_depth;
            queue.push(next_idx as u32);
        }
    }
    dist
}

/// BFS over the full 8-corner (CP × CO) coordinate space.
/// Index: cp_idx * CO_SIZE + co_idx. Solved state = index 0.
/// This gives a strong lower bound (up to 14 for typical positions).
pub fn build_corner_full_dist(cp_move: &[u16], co_move: &[u16]) -> Vec<u8> {
    let mut dist = vec![NOT_SET; CORNER_FULL_SIZE];
    let mut queue: Vec<u32> = Vec::with_capacity(4_000_000);
    dist[0] = 0;
    queue.push(0u32);
    let mut head = 0usize;
    while head < queue.len() {
        let idx = queue[head] as usize;
        head += 1;
        let cp_idx = idx / CO_SIZE;
        let co_idx = idx % CO_SIZE;
        let next_depth = dist[idx] + 1;
        let cp_base = cp_idx * MOVE_COUNT;
        let co_base = co_idx * MOVE_COUNT;
        for m in 0..MOVE_COUNT {
            let next_cp = cp_move[cp_base + m] as usize;
            let next_co = co_move[co_base + m] as usize;
            let next_idx = next_cp * CO_SIZE + next_co;
            if dist[next_idx] != NOT_SET {
                continue;
            }
            dist[next_idx] = next_depth;
            queue.push(next_idx as u32);
        }
    }
    dist
}

pub fn build_all_tables(move_data: &MoveData) -> GeneratedTables {
    let co_move = build_co_move_table(move_data);
    let eo_move = build_eo_move_table(move_data);
    let cp_move = build_cp_move_table(move_data);
    let slice_move = build_slice_move_table(move_data);
    let slice_start = encode_slice_from_occupancy(&{
        let mut solved = [0u8; EDGE_COUNT];
        solved[8] = 1;
        solved[9] = 1;
        solved[10] = 1;
        solved[11] = 1;
        solved
    });

    let co_eo_joint = build_co_eo_joint_dist(&co_move, &eo_move);
    let co_slice_joint = build_co_slice_joint_dist(&co_move, &slice_move, slice_start);
    let cp_slice_joint = build_cp_slice_joint_dist(&cp_move, &slice_move, slice_start);
    let cp_eo_joint = build_cp_eo_joint_dist(&cp_move, &eo_move);

    eprintln!("[minmove] building corner full (CP×CO) table (88M states)...");
    let corner_full = build_corner_full_dist(&cp_move, &co_move);

    GeneratedTables {
        co: bfs_from_move_table_u16(&co_move, CO_SIZE, 0),
        eo: bfs_from_move_table_u16(&eo_move, EO_SIZE, 0),
        slice: bfs_from_move_table_u16(&slice_move, SLICE_SIZE, slice_start),
        cp: bfs_from_move_table_u16(&cp_move, CP_SIZE, 0),
        co_slice_joint,
        cp_slice_joint,
        cp_eo_joint,
        edge_subset_a: build_edge_subset_dist(move_data, &EDGE_SUBSET_A),
        edge_subset_b: build_edge_subset_dist(move_data, &EDGE_SUBSET_B),
        edge_subset_c: build_edge_subset_dist(move_data, &EDGE_SUBSET_C),
        edge_subset_d: build_edge_subset_dist(move_data, &EDGE_SUBSET_D),
        edge_perm_subset_a: build_edge_perm_subset_dist(move_data, &EDGE_PERM_SUBSET_A),
        edge_perm_subset_b: build_edge_perm_subset_dist(move_data, &EDGE_PERM_SUBSET_B),
        co_eo_joint,
        corner_full,
        co_move,
        eo_move,
        cp_move,
        slice_move,
    }
}

pub fn solved_edge_subset_indices() -> (usize, usize) {
    let solved_ep: [u8; EDGE_COUNT] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    let solved_eo = [0u8; EDGE_COUNT];
    let a = edge_subset_state_from_full(&solved_ep, &solved_eo, &EDGE_SUBSET_A);
    let b = edge_subset_state_from_full(&solved_ep, &solved_eo, &EDGE_SUBSET_B);
    (encode_edge_subset_state(&a), encode_edge_subset_state(&b))
}