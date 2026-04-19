use crate::minmove_core::{
    build_allowed_moves_by_last_face, edge_subset_state_from_full, encode_edge_subset_state,
    encode_slice_from_ep, MoveData, MoveDataFile, EDGE_SUBSET_A, EDGE_SUBSET_B, MOVE_COUNT,
};

const BUNDLE_MAGIC: &[u8; 8] = b"MM3BNDL1";
const BUNDLE_VERSION: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TableKind {
    Co = 1,
    Eo = 2,
    Slice = 3,
    Cp = 4,
    EdgeSubsetA = 5,
    EdgeSubsetB = 6,
    /// u16 coordinate move table: CO_SIZE × MOVE_COUNT entries
    CoMove = 7,
    /// u16 coordinate move table: EO_SIZE × MOVE_COUNT entries
    EoMove = 8,
    /// u16 coordinate move table: CP_SIZE × MOVE_COUNT entries
    CpMove = 9,
    /// u16 coordinate move table: SLICE_SIZE × MOVE_COUNT entries
    SliceMove = 10,
    /// u8 nibble-packed joint distance: CO_SIZE × EO_SIZE entries
    CoEoJoint = 11,
    /// u8 nibble-packed joint distance: CP_SIZE × SLICE_SIZE entries
    CpSliceJoint = 12,
    /// u8 nibble-packed joint distance: CO_SIZE × SLICE_SIZE entries
    CoSliceJoint = 13,
    /// u8 nibble-packed joint distance: CP_SIZE × EO_SIZE entries
    CpEoJoint = 14,
    EdgePermSubsetA = 15,
    EdgePermSubsetB = 16,
    /// u8 distance table: full 8-corner (CP × CO), indexed as cp_idx * CO_SIZE + co_idx
    CornerFullJoint = 17,
    EdgeSubsetC = 18,
    EdgeSubsetD = 19,
}

impl TableKind {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Co),
            2 => Some(Self::Eo),
            3 => Some(Self::Slice),
            4 => Some(Self::Cp),
            5 => Some(Self::EdgeSubsetA),
            6 => Some(Self::EdgeSubsetB),
            7 => Some(Self::CoMove),
            8 => Some(Self::EoMove),
            9 => Some(Self::CpMove),
            10 => Some(Self::SliceMove),
            11 => Some(Self::CoEoJoint),
            12 => Some(Self::CpSliceJoint),
            13 => Some(Self::CoSliceJoint),
            14 => Some(Self::CpEoJoint),
            15 => Some(Self::EdgePermSubsetA),
            16 => Some(Self::EdgePermSubsetB),
            17 => Some(Self::CornerFullJoint),
            18 => Some(Self::EdgeSubsetC),
            19 => Some(Self::EdgeSubsetD),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PackedTable {
    pub count: usize,
    pub max_distance: u8,
    pub nibble_packed: bool,
    pub payload: Vec<u8>,
}

impl PackedTable {
    pub fn get(&self, index: usize) -> u8 {
        if !self.nibble_packed {
            return self.payload[index];
        }
        let byte = self.payload[index / 2];
        if index % 2 == 0 {
            byte & 0x0f
        } else {
            byte >> 4
        }
    }
}

/// u16 coordinate move table. `values[state * moves + move_idx]` gives the next state index.
#[derive(Clone, Debug)]
pub struct MoveTable {
    pub states: usize,
    pub moves: usize,
    pub values: Vec<u16>,
}

impl MoveTable {
    #[inline(always)]
    pub fn get(&self, state: usize, move_idx: usize) -> u16 {
        self.values[state * self.moves + move_idx]
    }
}

#[derive(Clone, Debug)]
pub struct MinmoveTables {
    pub move_data: MoveData,
    pub allowed_moves_by_last_face: Vec<Vec<u8>>,
    // Distance pruning tables
    pub co: PackedTable,
    pub eo: PackedTable,
    pub slice: PackedTable,
    pub cp: PackedTable,
    /// Joint CO×Slice distance table (stronger lower bound than max(co, slice) separately)
    pub co_slice_joint: PackedTable,
    /// Joint CP×Slice distance table (stronger lower bound than max(cp, slice) separately)
    pub cp_slice_joint: PackedTable,
    /// Joint CP×EO distance table (stronger lower bound than max(cp, eo) separately)
    pub cp_eo_joint: PackedTable,
    pub edge_subset_a: PackedTable,
    pub edge_subset_b: PackedTable,
    pub edge_subset_c: PackedTable,
    pub edge_subset_d: PackedTable,
    pub edge_perm_subset_a: PackedTable,
    pub edge_perm_subset_b: PackedTable,
    /// Full 8-corner (CP × CO) joint table — strongest lower bound table
    pub corner_full: PackedTable,
    /// Joint CO×EO distance table (stronger lower bound than max(co, eo) separately)
    pub co_eo_joint: PackedTable,
    // Coordinate move tables (u16 per entry)
    pub co_move: MoveTable,
    pub eo_move: MoveTable,
    pub cp_move: MoveTable,
    pub slice_move: MoveTable,
    // Pre-computed solved-state coordinate indices
    pub solved_slice: u16,
    pub solved_esa: u32,
    pub solved_esb: u32,
}

/// Input to the bundle builder.
pub enum BundleInput<'a> {
    /// u8 distance table; nibble-packed automatically when max distance < 16.
    Dist { kind: TableKind, values: &'a [u8] },
    /// u16 coordinate move table, stored as little-endian pairs.
    Move { kind: TableKind, values: &'a [u16] },
}

/// Kept for backward compatibility; wraps as BundleInput::Dist.
pub struct BundleTableInput<'a> {
    pub kind: TableKind,
    pub values: &'a [u8],
}

fn pack_distances(values: &[u8]) -> (Vec<u8>, bool, u8) {
    let max_distance = values.iter().copied().max().unwrap_or(0);
    if max_distance < 16 {
        let mut packed = Vec::with_capacity((values.len() + 1) / 2);
        let mut index = 0usize;
        while index < values.len() {
            let lo = values[index] & 0x0f;
            let hi = if index + 1 < values.len() {
                (values[index + 1] & 0x0f) << 4
            } else {
                0
            };
            packed.push(lo | hi);
            index += 2;
        }
        return (packed, true, max_distance);
    }
    (values.to_vec(), false, max_distance)
}

fn push_u32(buffer: &mut Vec<u8>, value: u32) {
    buffer.extend_from_slice(&value.to_le_bytes());
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32, String> {
    if bytes.len() < *offset + 4 {
        return Err("bundle truncated while reading u32".into());
    }
    let value = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
    *offset += 4;
    Ok(value)
}

pub fn build_bundle_bytes(
    move_data_file: &MoveDataFile,
    inputs: &[BundleInput<'_>],
) -> Result<Vec<u8>, String> {
    let move_data_json = serde_json::to_vec(move_data_file)
        .map_err(|error| format!("failed to serialize move data: {error}"))?;
    let mut buffer = Vec::new();
    buffer.extend_from_slice(BUNDLE_MAGIC);
    push_u32(&mut buffer, BUNDLE_VERSION);
    push_u32(&mut buffer, move_data_json.len() as u32);
    buffer.extend_from_slice(&move_data_json);
    push_u32(&mut buffer, inputs.len() as u32);

    for input in inputs {
        match input {
            BundleInput::Dist { kind, values } => {
                let (payload, nibble_packed, max_distance) = pack_distances(values);
                buffer.push(*kind as u8);
                buffer.push(if nibble_packed { 1 } else { 0 });
                buffer.push(max_distance);
                buffer.push(0); // padding
                push_u32(&mut buffer, values.len() as u32);
                push_u32(&mut buffer, payload.len() as u32);
                buffer.extend_from_slice(&payload);
            }
            BundleInput::Move { kind, values } => {
                buffer.push(*kind as u8);
                buffer.push(2u8); // storage_kind = 2 means u16 LE
                buffer.push(0u8);
                buffer.push(0u8);
                push_u32(&mut buffer, values.len() as u32);
                push_u32(&mut buffer, (values.len() * 2) as u32);
                for &v in *values {
                    buffer.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
    }

    Ok(buffer)
}

pub fn load_bundle(bytes: &[u8]) -> Result<MinmoveTables, String> {
    if bytes.len() < BUNDLE_MAGIC.len() || &bytes[..BUNDLE_MAGIC.len()] != BUNDLE_MAGIC {
        return Err("invalid minmove bundle magic".into());
    }
    let mut offset = BUNDLE_MAGIC.len();
    let version = read_u32(bytes, &mut offset)?;
    if version != 7 && version != BUNDLE_VERSION {
        return Err(format!("unsupported minmove bundle version: {version} (expected 7 or {BUNDLE_VERSION}); please regenerate the bundle"));
    }
    let move_data_len = read_u32(bytes, &mut offset)? as usize;
    if bytes.len() < offset + move_data_len {
        return Err("bundle truncated while reading move data".into());
    }
    let move_data_file: MoveDataFile = serde_json::from_slice(&bytes[offset..offset + move_data_len])
        .map_err(|error| format!("failed to parse move data: {error}"))?;
    offset += move_data_len;

    let move_data = MoveData::try_from(move_data_file)?;
    let table_count = read_u32(bytes, &mut offset)? as usize;
    let mut co: Option<PackedTable> = None;
    let mut eo: Option<PackedTable> = None;
    let mut slice: Option<PackedTable> = None;
    let mut cp: Option<PackedTable> = None;
    let mut co_slice_joint: Option<PackedTable> = None;
    let mut cp_slice_joint: Option<PackedTable> = None;
    let mut cp_eo_joint: Option<PackedTable> = None;
    let mut edge_subset_a: Option<PackedTable> = None;
    let mut edge_subset_b: Option<PackedTable> = None;
    let mut edge_subset_c: Option<PackedTable> = None;
    let mut edge_subset_d: Option<PackedTable> = None;
    let mut edge_perm_subset_a: Option<PackedTable> = None;
    let mut edge_perm_subset_b: Option<PackedTable> = None;
    let mut corner_full: Option<PackedTable> = None;
    let mut co_eo_joint: Option<PackedTable> = None;
    let mut co_move: Option<MoveTable> = None;
    let mut eo_move: Option<MoveTable> = None;
    let mut cp_move: Option<MoveTable> = None;
    let mut slice_move: Option<MoveTable> = None;

    for _ in 0..table_count {
        if bytes.len() < offset + 4 {
            return Err("bundle truncated while reading table header".into());
        }
        let raw_kind = bytes[offset];
        let storage_kind = bytes[offset + 1];
        let meta = bytes[offset + 2]; // max_distance for dist tables, reserved for move tables
        offset += 4;
        let entry_count = read_u32(bytes, &mut offset)? as usize;
        let payload_len = read_u32(bytes, &mut offset)? as usize;
        if bytes.len() < offset + payload_len {
            return Err("bundle truncated while reading table payload".into());
        }

        if storage_kind == 2 {
            // u16 LE move table
            let mut values = Vec::with_capacity(entry_count);
            for i in 0..entry_count {
                let lo = bytes[offset + i * 2] as u16;
                let hi = bytes[offset + i * 2 + 1] as u16;
                values.push(lo | (hi << 8));
            }
            offset += payload_len;
            let states = if MOVE_COUNT > 0 { entry_count / MOVE_COUNT } else { 0 };
            let table = MoveTable { states, moves: MOVE_COUNT, values };
            match TableKind::from_u8(raw_kind) {
                Some(TableKind::CoMove) => co_move = Some(table),
                Some(TableKind::EoMove) => eo_move = Some(table),
                Some(TableKind::CpMove) => cp_move = Some(table),
                Some(TableKind::SliceMove) => slice_move = Some(table),
                _ => {} // skip unknown move table kinds
            }
        } else {
            // u8 distance table (raw or nibble-packed)
            let nibble_packed = storage_kind == 1;
            let table = PackedTable {
                count: entry_count,
                max_distance: meta,
                nibble_packed,
                payload: bytes[offset..offset + payload_len].to_vec(),
            };
            offset += payload_len;
            match TableKind::from_u8(raw_kind) {
                Some(TableKind::Co) => co = Some(table),
                Some(TableKind::Eo) => eo = Some(table),
                Some(TableKind::Slice) => slice = Some(table),
                Some(TableKind::Cp) => cp = Some(table),
                Some(TableKind::CoSliceJoint) => co_slice_joint = Some(table),
                Some(TableKind::CpSliceJoint) => cp_slice_joint = Some(table),
                Some(TableKind::CpEoJoint) => cp_eo_joint = Some(table),
                Some(TableKind::EdgeSubsetA) => edge_subset_a = Some(table),
                Some(TableKind::EdgeSubsetB) => edge_subset_b = Some(table),
                Some(TableKind::EdgeSubsetC) => edge_subset_c = Some(table),
                Some(TableKind::EdgeSubsetD) => edge_subset_d = Some(table),
                Some(TableKind::EdgePermSubsetA) => edge_perm_subset_a = Some(table),
                Some(TableKind::EdgePermSubsetB) => edge_perm_subset_b = Some(table),
                Some(TableKind::CornerFullJoint) => corner_full = Some(table),
                Some(TableKind::CoEoJoint) => co_eo_joint = Some(table),
                _ => {} // skip unknown dist table kinds
            }
        }
    }

    // Pre-compute solved-state coordinate indices
    let solved_ep: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    let solved_eo_arr = [0u8; 12];
    let solved_slice_val = encode_slice_from_ep(&solved_ep) as u16;
    let esa_s = edge_subset_state_from_full(&solved_ep, &solved_eo_arr, &EDGE_SUBSET_A);
    let solved_esa_val = encode_edge_subset_state(&esa_s) as u32;
    let esb_s = edge_subset_state_from_full(&solved_ep, &solved_eo_arr, &EDGE_SUBSET_B);
    let solved_esb_val = encode_edge_subset_state(&esb_s) as u32;

    let allowed_moves_by_last_face = build_allowed_moves_by_last_face(&move_data.move_face);
    Ok(MinmoveTables {
        move_data,
        allowed_moves_by_last_face,
        co: co.ok_or_else(|| "missing CO table".to_string())?,
        eo: eo.ok_or_else(|| "missing EO table".to_string())?,
        slice: slice.ok_or_else(|| "missing slice table".to_string())?,
        cp: cp.ok_or_else(|| "missing CP table".to_string())?,
        co_slice_joint: co_slice_joint.ok_or_else(|| "missing CO+Slice joint table".to_string())?,
        cp_slice_joint: cp_slice_joint.ok_or_else(|| "missing CP+Slice joint table".to_string())?,
        cp_eo_joint: cp_eo_joint.ok_or_else(|| "missing CP+EO joint table".to_string())?,
        edge_subset_a: edge_subset_a.ok_or_else(|| "missing edge subset A table".to_string())?,
        edge_subset_b: edge_subset_b.ok_or_else(|| "missing edge subset B table".to_string())?,
        edge_subset_c: if version == 7 {
            PackedTable {
                count: 1,
                max_distance: 0,
                nibble_packed: false,
                payload: vec![0],
            }
        } else {
            edge_subset_c.ok_or_else(|| "missing edge subset C table".to_string())?
        },
        edge_subset_d: if version == 7 {
            PackedTable {
                count: 1,
                max_distance: 0,
                nibble_packed: false,
                payload: vec![0],
            }
        } else {
            edge_subset_d.ok_or_else(|| "missing edge subset D table".to_string())?
        },
        edge_perm_subset_a: edge_perm_subset_a.ok_or_else(|| "missing edge permutation subset A table".to_string())?,
        edge_perm_subset_b: edge_perm_subset_b.ok_or_else(|| "missing edge permutation subset B table".to_string())?,
        corner_full: corner_full.ok_or_else(|| "missing corner full (CP×CO) table".to_string())?,
        co_eo_joint: co_eo_joint.ok_or_else(|| "missing CO+EO joint table".to_string())?,
        co_move: co_move.ok_or_else(|| "missing CO move table".to_string())?,
        eo_move: eo_move.ok_or_else(|| "missing EO move table".to_string())?,
        cp_move: cp_move.ok_or_else(|| "missing CP move table".to_string())?,
        slice_move: slice_move.ok_or_else(|| "missing slice move table".to_string())?,
        solved_slice: solved_slice_val,
        solved_esa: solved_esa_val,
        solved_esb: solved_esb_val,
    })
}