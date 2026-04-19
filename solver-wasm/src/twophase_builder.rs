use crate::minmove_core::{
    choose, decode_co, decode_eo, decode_perm8, decode_slice_index, encode_co, encode_eo,
    encode_perm8, MoveData, CO_SIZE, CORNER_COUNT, CP_SIZE, EDGE_COUNT, EO_SIZE, MOVE_COUNT,
    SLICE_SIZE,
};

const NOT_SET: u8 = 255;
const SEP_SIZE: usize = 24;
const PHASE2_MOVE_COUNT: usize = 10;
const PHASE2_MOVE_NAMES: [&str; PHASE2_MOVE_COUNT] = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"];
const FACTORIAL_4: [usize; 5] = [1, 1, 2, 6, 24];

#[derive(Clone, Debug)]
pub struct GeneratedTwophaseTables {
    pub co: Vec<u8>,
    pub eo: Vec<u8>,
    pub slice: Vec<u8>,
    pub phase2_ep: Vec<u8>,
    pub phase2_cp_sep_joint: Vec<u8>,
    pub co_move: Vec<u16>,
    pub eo_move: Vec<u16>,
    pub slice_move: Vec<u16>,
    pub phase2_cp_move: Vec<u16>,
    pub phase2_ep_move: Vec<u16>,
    pub phase2_sep_move: Vec<u16>,
}

fn bfs_from_move_table_u16(
    move_table: &[u16],
    size: usize,
    start_state: usize,
    moves_per_state: usize,
) -> Vec<u8> {
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
        let base = state * moves_per_state;
        for move_index in 0..moves_per_state {
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

fn resolve_phase2_move_indices(move_data: &MoveData) -> Result<[usize; PHASE2_MOVE_COUNT], String> {
    let mut indices = [0usize; PHASE2_MOVE_COUNT];
    for (slot, name) in PHASE2_MOVE_NAMES.iter().enumerate() {
        let Some(index) = move_data.move_names.iter().position(|candidate| candidate == name) else {
            return Err(format!("PHASE2_MOVE_INDEX_NOT_FOUND:{name}"));
        };
        indices[slot] = index;
    }
    Ok(indices)
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
                next[position] =
                    (state[old_pos] + move_data.corner_ori_delta[move_base + position]) % 3;
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
                next[position] =
                    (state[old_pos] + move_data.edge_ori_delta[move_base + position]) & 1;
            }
            table[base + move_index] = encode_eo(&next) as u16;
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

fn decode_perm4(mut index: usize, out: &mut [u8; 4]) {
    let mut pool = vec![0u8, 1, 2, 3];
    for (i, slot) in out.iter_mut().enumerate() {
        let factor = FACTORIAL_4[3 - i];
        let digit = index / factor;
        index %= factor;
        *slot = pool.remove(digit);
    }
}

fn build_phase2_cp_move_table(
    move_data: &MoveData,
    phase2_move_indices: &[usize; PHASE2_MOVE_COUNT],
) -> Vec<u16> {
    let mut table = vec![0u16; CP_SIZE * PHASE2_MOVE_COUNT];
    let mut state = [0u8; CORNER_COUNT];
    let mut next = [0u8; CORNER_COUNT];
    for index in 0..CP_SIZE {
        decode_perm8(index, &mut state);
        let base = index * PHASE2_MOVE_COUNT;
        for (phase2_move_index, &move_index) in phase2_move_indices.iter().enumerate() {
            let move_base = move_index * CORNER_COUNT;
            for position in 0..CORNER_COUNT {
                next[position] = state[move_data.corner_perm_map[move_base + position] as usize];
            }
            table[base + phase2_move_index] = encode_perm8(&next) as u16;
        }
    }
    table
}

fn build_phase2_ep_move_table(
    move_data: &MoveData,
    phase2_move_indices: &[usize; PHASE2_MOVE_COUNT],
) -> Result<Vec<u16>, String> {
    let mut table = vec![0u16; CP_SIZE * PHASE2_MOVE_COUNT];
    let mut state = [0u8; CORNER_COUNT];
    let mut next = [0u8; CORNER_COUNT];
    for index in 0..CP_SIZE {
        decode_perm8(index, &mut state);
        let base = index * PHASE2_MOVE_COUNT;
        for (phase2_move_index, &move_index) in phase2_move_indices.iter().enumerate() {
            let move_base = move_index * EDGE_COUNT;
            for position in 0..CORNER_COUNT {
                let old_pos = move_data.edge_perm_map[move_base + position] as usize;
                if old_pos >= CORNER_COUNT {
                    return Err("PHASE2_EDGE_MOVE_INVALID".into());
                }
                next[position] = state[old_pos];
            }
            table[base + phase2_move_index] = encode_perm8(&next) as u16;
        }
    }
    Ok(table)
}

fn build_phase2_sep_move_table(
    move_data: &MoveData,
    phase2_move_indices: &[usize; PHASE2_MOVE_COUNT],
) -> Result<Vec<u16>, String> {
    let mut table = vec![0u16; SEP_SIZE * PHASE2_MOVE_COUNT];
    let mut state = [0u8; 4];
    let mut next = [0u8; 4];
    for index in 0..SEP_SIZE {
        decode_perm4(index, &mut state);
        let base = index * PHASE2_MOVE_COUNT;
        for (phase2_move_index, &move_index) in phase2_move_indices.iter().enumerate() {
            let move_base = move_index * EDGE_COUNT;
            for position in 0..4 {
                let old_pos = move_data.edge_perm_map[move_base + 8 + position] as i16 - 8;
                if !(0..=3).contains(&old_pos) {
                    return Err("PHASE2_SLICE_MOVE_INVALID".into());
                }
                next[position] = state[old_pos as usize];
            }
            table[base + phase2_move_index] = encode_perm4(&next) as u16;
        }
    }
    Ok(table)
}

fn build_phase2_cp_sep_joint_dist(cp_move: &[u16], sep_move: &[u16]) -> Vec<u8> {
    let size = CP_SIZE * SEP_SIZE;
    let mut dist = vec![NOT_SET; size];
    let mut queue = vec![0u32; size];
    let mut head = 0usize;
    let mut tail = 0usize;
    dist[0] = 0;
    queue[tail] = 0;
    tail += 1;
    while head < tail {
        let index = queue[head] as usize;
        head += 1;
        let cp = index / SEP_SIZE;
        let sep = index % SEP_SIZE;
        let next_depth = dist[index] + 1;
        let cp_base = cp * PHASE2_MOVE_COUNT;
        let sep_base = sep * PHASE2_MOVE_COUNT;
        for move_index in 0..PHASE2_MOVE_COUNT {
            let next_cp = cp_move[cp_base + move_index] as usize;
            let next_sep = sep_move[sep_base + move_index] as usize;
            let next_index = next_cp * SEP_SIZE + next_sep;
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

pub fn build_all_tables(move_data: &MoveData) -> Result<GeneratedTwophaseTables, String> {
    let co_move = build_co_move_table(move_data);
    let eo_move = build_eo_move_table(move_data);
    let slice_move = build_slice_move_table(move_data);
    let mut solved_slice_occupancy = [0u8; EDGE_COUNT];
    solved_slice_occupancy[8] = 1;
    solved_slice_occupancy[9] = 1;
    solved_slice_occupancy[10] = 1;
    solved_slice_occupancy[11] = 1;
    let solved_slice = encode_slice_from_occupancy(&solved_slice_occupancy);

    let phase2_move_indices = resolve_phase2_move_indices(move_data)?;
    let phase2_cp_move = build_phase2_cp_move_table(move_data, &phase2_move_indices);
    let phase2_ep_move = build_phase2_ep_move_table(move_data, &phase2_move_indices)?;
    let phase2_sep_move = build_phase2_sep_move_table(move_data, &phase2_move_indices)?;

    Ok(GeneratedTwophaseTables {
        co: bfs_from_move_table_u16(&co_move, CO_SIZE, 0, MOVE_COUNT),
        eo: bfs_from_move_table_u16(&eo_move, EO_SIZE, 0, MOVE_COUNT),
        slice: bfs_from_move_table_u16(&slice_move, SLICE_SIZE, solved_slice, MOVE_COUNT),
        phase2_ep: bfs_from_move_table_u16(&phase2_ep_move, CP_SIZE, 0, PHASE2_MOVE_COUNT),
        phase2_cp_sep_joint: build_phase2_cp_sep_joint_dist(&phase2_cp_move, &phase2_sep_move),
        co_move,
        eo_move,
        slice_move,
        phase2_cp_move,
        phase2_ep_move,
        phase2_sep_move,
    })
}