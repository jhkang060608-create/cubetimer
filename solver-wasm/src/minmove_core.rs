use serde::{Deserialize, Serialize};

pub const MOVE_COUNT: usize = 18;
pub const CORNER_COUNT: usize = 8;
pub const EDGE_COUNT: usize = 12;
pub const LAST_FACE_FREE: u8 = 6;
pub const CO_SIZE: usize = 3usize.pow(7);
pub const EO_SIZE: usize = 1usize << 11;
pub const SLICE_SIZE: usize = 495;
pub const CP_SIZE: usize = 40320;
pub const EDGE_SUBSET_SIZE: usize = 42_577_920;
pub const EDGE_PERM_SUBSET_SIZE: usize = 19_958_400;
pub const EDGE_SUBSET_A: [u8; 6] = [0, 1, 2, 3, 4, 5];
pub const EDGE_SUBSET_B: [u8; 6] = [6, 7, 8, 9, 10, 11];
pub const EDGE_SUBSET_C: [u8; 6] = [0, 1, 4, 5, 8, 9];
pub const EDGE_SUBSET_D: [u8; 6] = [2, 3, 6, 7, 10, 11];
pub const EDGE_PERM_SUBSET_A: [u8; 8] = [0, 1, 2, 3, 8, 9, 10, 11];
pub const EDGE_PERM_SUBSET_B: [u8; 8] = [4, 5, 6, 7, 8, 9, 10, 11];
/// Combined 8-corner (CO + CP) state space: CP_SIZE * CO_SIZE = 40320 * 2187 = 88,179,840
pub const CORNER_FULL_SIZE: usize = 88_179_840;

const OPPOSITE_FACE: [u8; 6] = [3, 4, 5, 0, 1, 2];
const FACTORIAL: [usize; 13] = [
    1,
    1,
    2,
    6,
    24,
    120,
    720,
    5040,
    40320,
    362880,
    3628800,
    39916800,
    479001600,
];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveDataFile {
    pub move_names: Vec<String>,
    pub move_face: Vec<u8>,
    pub corner_perm_map: Vec<u8>,
    pub corner_ori_delta: Vec<u8>,
    pub edge_perm_map: Vec<u8>,
    pub edge_ori_delta: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct MoveData {
    pub move_names: Vec<String>,
    pub move_face: Vec<u8>,
    pub corner_perm_map: Vec<u8>,
    pub corner_ori_delta: Vec<u8>,
    pub edge_perm_map: Vec<u8>,
    pub edge_ori_delta: Vec<u8>,
    pub edge_new_pos_map: Vec<u8>,
}

impl TryFrom<MoveDataFile> for MoveData {
    type Error = String;

    fn try_from(value: MoveDataFile) -> Result<Self, Self::Error> {
        if value.move_names.len() != MOVE_COUNT {
            return Err("invalid move_names length".into());
        }
        if value.move_face.len() != MOVE_COUNT {
            return Err("invalid move_face length".into());
        }
        if value.corner_perm_map.len() != MOVE_COUNT * CORNER_COUNT {
            return Err("invalid corner_perm_map length".into());
        }
        if value.corner_ori_delta.len() != MOVE_COUNT * CORNER_COUNT {
            return Err("invalid corner_ori_delta length".into());
        }
        if value.edge_perm_map.len() != MOVE_COUNT * EDGE_COUNT {
            return Err("invalid edge_perm_map length".into());
        }
        if value.edge_ori_delta.len() != MOVE_COUNT * EDGE_COUNT {
            return Err("invalid edge_ori_delta length".into());
        }

        let mut edge_new_pos_map = vec![0u8; MOVE_COUNT * EDGE_COUNT];
        for move_index in 0..MOVE_COUNT {
            let base = move_index * EDGE_COUNT;
            for new_pos in 0..EDGE_COUNT {
                let old_pos = value.edge_perm_map[base + new_pos] as usize;
                if old_pos >= EDGE_COUNT {
                    return Err("invalid edge_perm_map entry".into());
                }
                edge_new_pos_map[base + old_pos] = new_pos as u8;
            }
        }

        Ok(Self {
            move_names: value.move_names,
            move_face: value.move_face,
            corner_perm_map: value.corner_perm_map,
            corner_ori_delta: value.corner_ori_delta,
            edge_perm_map: value.edge_perm_map,
            edge_ori_delta: value.edge_ori_delta,
            edge_new_pos_map,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CubeState {
    pub cp: [u8; CORNER_COUNT],
    pub co: [u8; CORNER_COUNT],
    pub ep: [u8; EDGE_COUNT],
    pub eo: [u8; EDGE_COUNT],
}

impl CubeState {
    pub fn solved() -> Self {
        let mut cp = [0u8; CORNER_COUNT];
        let mut ep = [0u8; EDGE_COUNT];
        for index in 0..CORNER_COUNT {
            cp[index] = index as u8;
        }
        for index in 0..EDGE_COUNT {
            ep[index] = index as u8;
        }
        Self {
            cp,
            co: [0u8; CORNER_COUNT],
            ep,
            eo: [0u8; EDGE_COUNT],
        }
    }

    pub fn apply_move(&self, move_index: usize, move_data: &MoveData) -> Self {
        let mut next = CubeState::solved();
        let corner_base = move_index * CORNER_COUNT;
        let edge_base = move_index * EDGE_COUNT;
        for pos in 0..CORNER_COUNT {
            let old_pos = move_data.corner_perm_map[corner_base + pos] as usize;
            next.cp[pos] = self.cp[old_pos];
            next.co[pos] = (self.co[old_pos] + move_data.corner_ori_delta[corner_base + pos]) % 3;
        }
        for pos in 0..EDGE_COUNT {
            let old_pos = move_data.edge_perm_map[edge_base + pos] as usize;
            next.ep[pos] = self.ep[old_pos];
            next.eo[pos] = (self.eo[old_pos] + move_data.edge_ori_delta[edge_base + pos]) & 1;
        }
        next
    }

    pub fn apply_moves(&self, moves: &[u8], move_data: &MoveData) -> Self {
        let mut current = *self;
        for move_index in moves {
            current = current.apply_move(*move_index as usize, move_data);
        }
        current
    }

    pub fn is_solved(&self) -> bool {
        for index in 0..CORNER_COUNT {
            if self.cp[index] != index as u8 || self.co[index] != 0 {
                return false;
            }
        }
        for index in 0..EDGE_COUNT {
            if self.ep[index] != index as u8 || self.eo[index] != 0 {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgeSubsetState {
    pub positions: [u8; 6],
    pub flips: [u8; 6],
}

impl EdgeSubsetState {
    pub fn solved(subset: &[u8; 6]) -> Self {
        Self {
            positions: *subset,
            flips: [0u8; 6],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EdgePermSubsetState {
    pub positions: [u8; 8],
}

impl EdgePermSubsetState {
    pub fn solved(subset: &[u8; 8]) -> Self {
        Self { positions: *subset }
    }
}

pub fn parse_scramble(scramble: &str, move_data: &MoveData) -> Result<Vec<u8>, String> {
    let mut result = Vec::new();
    for token in scramble.split_whitespace() {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        let core = if let Some(pos) = trimmed.find(':') {
            &trimmed[pos + 1..]
        } else {
            trimmed
        };
        let index = move_data
            .move_names
            .iter()
            .position(|name| name == core)
            .ok_or_else(|| format!("BAD_SCRAMBLE_TOKEN:{core}"))?;
        result.push(index as u8);
    }
    Ok(result)
}

pub fn solution_string_from_path(path: &[u8], move_data: &MoveData) -> String {
    path.iter()
        .map(|move_index| move_data.move_names[*move_index as usize].as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build_allowed_moves_by_last_face(move_face: &[u8]) -> Vec<Vec<u8>> {
    let mut allowed = vec![Vec::new(); 7];
    for last_face in 0..=LAST_FACE_FREE as usize {
        for move_index in 0..MOVE_COUNT {
            if last_face == LAST_FACE_FREE as usize {
                allowed[last_face].push(move_index as u8);
                continue;
            }
            let face = move_face[move_index];
            if face == last_face as u8 {
                continue;
            }
            if face == OPPOSITE_FACE[last_face] && face < last_face as u8 {
                continue;
            }
            allowed[last_face].push(move_index as u8);
        }
    }
    allowed
}

pub fn encode_co(co: &[u8; CORNER_COUNT]) -> usize {
    let mut index = 0usize;
    for &value in co.iter().take(7) {
        index = index * 3 + value as usize;
    }
    index
}

pub fn decode_co(mut index: usize, out: &mut [u8; CORNER_COUNT]) {
    let mut sum = 0usize;
    for position in (0..7).rev() {
        let value = (index % 3) as u8;
        index /= 3;
        out[position] = value;
        sum += value as usize;
    }
    out[7] = ((3 - (sum % 3)) % 3) as u8;
}

pub fn encode_eo(eo: &[u8; EDGE_COUNT]) -> usize {
    let mut index = 0usize;
    for &value in eo.iter().take(11) {
        index = (index << 1) | ((value as usize) & 1);
    }
    index
}

pub fn decode_eo(mut index: usize, out: &mut [u8; EDGE_COUNT]) {
    let mut sum = 0usize;
    for position in (0..11).rev() {
        let value = (index & 1) as u8;
        out[position] = value;
        sum += value as usize;
        index >>= 1;
    }
    out[11] = (sum & 1) as u8;
}

pub fn encode_perm8(perm: &[u8; 8]) -> usize {
    let mut index = 0usize;
    for i in 0..8 {
        let mut smaller = 0usize;
        for j in (i + 1)..8 {
            if perm[j] < perm[i] {
                smaller += 1;
            }
        }
        index += smaller * FACTORIAL[7 - i];
    }
    index
}

pub fn decode_perm8(mut index: usize, out: &mut [u8; 8]) {
    let mut pool = Vec::from([0u8, 1, 2, 3, 4, 5, 6, 7]);
    for i in 0..8 {
        let factor = FACTORIAL[7 - i];
        let digit = index / factor;
        index %= factor;
        out[i] = pool.remove(digit);
    }
}

pub fn encode_perm12(perm: &[u8; 12]) -> usize {
    let mut index = 0usize;
    for i in 0..12 {
        let mut smaller = 0usize;
        for j in (i + 1)..12 {
            if perm[j] < perm[i] {
                smaller += 1;
            }
        }
        index += smaller * FACTORIAL[11 - i];
    }
    index
}

pub fn choose(n: usize, k: usize) -> usize {
    if k > n {
        return 0;
    }
    let target = k.min(n - k);
    if target == 0 {
        return 1;
    }
    let mut result = 1usize;
    for i in 0..target {
        result = result * (n - i) / (i + 1);
    }
    result
}

pub fn encode_slice_from_ep(ep: &[u8; EDGE_COUNT]) -> usize {
    let mut index = 0usize;
    let mut remaining = 4usize;
    for position in (0..EDGE_COUNT).rev() {
        let piece = ep[position];
        if piece < 8 {
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

pub fn decode_slice_index(mut index: usize, out: &mut [u8; EDGE_COUNT]) {
    out.fill(0);
    let mut remaining = 4usize;
    for position in (0..EDGE_COUNT).rev() {
        if remaining == 0 {
            break;
        }
        let comb = choose(position, remaining);
        if index >= comb {
            out[position] = 1;
            index -= comb;
            remaining -= 1;
        }
    }
}

pub fn edge_subset_state_from_full(
    ep: &[u8; EDGE_COUNT],
    eo: &[u8; EDGE_COUNT],
    subset: &[u8; 6],
) -> EdgeSubsetState {
    let mut positions = [0u8; 6];
    let mut flips = [0u8; 6];
    for (piece_index, piece_id) in subset.iter().enumerate() {
        for position in 0..EDGE_COUNT {
            if ep[position] == *piece_id {
                positions[piece_index] = position as u8;
                flips[piece_index] = eo[position] & 1;
                break;
            }
        }
    }
    EdgeSubsetState { positions, flips }
}

pub fn edge_perm_subset_state_from_full(
    ep: &[u8; EDGE_COUNT],
    subset: &[u8; 8],
) -> EdgePermSubsetState {
    let mut positions = [0u8; 8];
    for (piece_index, piece_id) in subset.iter().enumerate() {
        for position in 0..EDGE_COUNT {
            if ep[position] == *piece_id {
                positions[piece_index] = position as u8;
                break;
            }
        }
    }
    EdgePermSubsetState { positions }
}

pub fn encode_edge_subset_state(state: &EdgeSubsetState) -> usize {
    // Use a 12-bit mask to track available positions — no heap allocation.
    let mut avail_mask: u16 = 0x0FFF;
    let mut position_rank = 0usize;
    for piece_index in 0..6 {
        let pos = state.positions[piece_index] as usize;
        let lower = avail_mask & ((1u16 << pos).wrapping_sub(1));
        let digit = lower.count_ones() as usize;
        let remaining = avail_mask.count_ones() as usize;
        position_rank = position_rank * remaining + digit;
        avail_mask &= !(1u16 << pos);
    }
    let mut flip_bits = 0usize;
    for piece_index in 0..6 {
        flip_bits |= ((state.flips[piece_index] as usize) & 1) << (5 - piece_index);
    }
    position_rank * 64 + flip_bits
}

pub fn decode_edge_subset_state(mut index: usize) -> EdgeSubsetState {
    let flip_bits = index % 64;
    index /= 64;

    let mut digits = [0usize; 6];
    for piece_index in (0..6).rev() {
        let base = EDGE_COUNT - piece_index;
        digits[piece_index] = index % base;
        index /= base;
    }

    // Use a 12-bit mask to reconstruct positions — no heap allocation.
    let mut avail_mask: u16 = 0x0FFF;
    let mut positions = [0u8; 6];
    for piece_index in 0..6 {
        let d = digits[piece_index];
        let mut count = 0usize;
        let mut pos = 0usize;
        loop {
            if (avail_mask >> pos) & 1 == 1 {
                if count == d { break; }
                count += 1;
            }
            pos += 1;
        }
        positions[piece_index] = pos as u8;
        avail_mask &= !(1u16 << pos);
    }

    let mut flips = [0u8; 6];
    for piece_index in 0..6 {
        flips[piece_index] = ((flip_bits >> (5 - piece_index)) & 1) as u8;
    }

    EdgeSubsetState { positions, flips }
}

pub fn encode_edge_perm_subset_state(state: &EdgePermSubsetState) -> usize {
    let mut avail_mask: u16 = 0x0FFF;
    let mut position_rank = 0usize;
    for piece_index in 0..8 {
        let pos = state.positions[piece_index] as usize;
        let lower = avail_mask & ((1u16 << pos).wrapping_sub(1));
        let digit = lower.count_ones() as usize;
        let remaining = avail_mask.count_ones() as usize;
        position_rank = position_rank * remaining + digit;
        avail_mask &= !(1u16 << pos);
    }
    position_rank
}

pub fn decode_edge_perm_subset_state(mut index: usize) -> EdgePermSubsetState {
    let mut digits = [0usize; 8];
    for piece_index in (0..8).rev() {
        let base = EDGE_COUNT - piece_index;
        digits[piece_index] = index % base;
        index /= base;
    }

    let mut avail_mask: u16 = 0x0FFF;
    let mut positions = [0u8; 8];
    for piece_index in 0..8 {
        let d = digits[piece_index];
        let mut count = 0usize;
        let mut pos = 0usize;
        loop {
            if (avail_mask >> pos) & 1 == 1 {
                if count == d {
                    break;
                }
                count += 1;
            }
            pos += 1;
        }
        positions[piece_index] = pos as u8;
        avail_mask &= !(1u16 << pos);
    }

    EdgePermSubsetState { positions }
}

pub fn apply_move_to_edge_subset_state(
    state: &EdgeSubsetState,
    move_index: usize,
    move_data: &MoveData,
) -> EdgeSubsetState {
    let mut next = EdgeSubsetState {
        positions: [0u8; 6],
        flips: [0u8; 6],
    };
    let base = move_index * EDGE_COUNT;
    for piece_index in 0..6 {
        let old_pos = state.positions[piece_index] as usize;
        let new_pos = move_data.edge_new_pos_map[base + old_pos] as usize;
        next.positions[piece_index] = new_pos as u8;
        next.flips[piece_index] = (state.flips[piece_index] + move_data.edge_ori_delta[base + new_pos]) & 1;
    }
    next
}

pub fn apply_move_to_edge_perm_subset_state(
    state: &EdgePermSubsetState,
    move_index: usize,
    move_data: &MoveData,
) -> EdgePermSubsetState {
    let mut next = EdgePermSubsetState { positions: [0u8; 8] };
    let base = move_index * EDGE_COUNT;
    for piece_index in 0..8 {
        let old_pos = state.positions[piece_index] as usize;
        let new_pos = move_data.edge_new_pos_map[base + old_pos] as usize;
        next.positions[piece_index] = new_pos as u8;
    }
    next
}