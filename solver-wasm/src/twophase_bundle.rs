use crate::minmove_bundle::{MoveTable, PackedTable};
use crate::minmove_core::{
    build_allowed_moves_by_last_face, encode_slice_from_ep, MoveData, MoveDataFile, EDGE_COUNT,
    LAST_FACE_FREE, MOVE_COUNT,
};

const BUNDLE_MAGIC: &[u8; 8] = b"TP3BNDL1";
const BUNDLE_VERSION: u32 = 1;
const PHASE2_MOVE_COUNT: usize = 10;
const PHASE2_MOVE_NAMES: [&str; PHASE2_MOVE_COUNT] = ["U", "U2", "U'", "D", "D2", "D'", "R2", "L2", "F2", "B2"];
const OPPOSITE_FACE: [u8; 6] = [3, 4, 5, 0, 1, 2];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum TableKind {
    Co = 1,
    Eo = 2,
    Slice = 3,
    Phase2Ep = 4,
    CoMove = 5,
    EoMove = 6,
    SliceMove = 7,
    Phase2CpSepJoint = 8,
    Phase2CpMove = 9,
    Phase2EpMove = 10,
    Phase2SepMove = 11,
}

impl TableKind {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Co),
            2 => Some(Self::Eo),
            3 => Some(Self::Slice),
            4 => Some(Self::Phase2Ep),
            5 => Some(Self::CoMove),
            6 => Some(Self::EoMove),
            7 => Some(Self::SliceMove),
            8 => Some(Self::Phase2CpSepJoint),
            9 => Some(Self::Phase2CpMove),
            10 => Some(Self::Phase2EpMove),
            11 => Some(Self::Phase2SepMove),
            _ => None,
        }
    }

    fn move_count(self) -> Option<usize> {
        match self {
            Self::CoMove | Self::EoMove | Self::SliceMove => Some(MOVE_COUNT),
            Self::Phase2CpMove | Self::Phase2EpMove | Self::Phase2SepMove => {
                Some(PHASE2_MOVE_COUNT)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TwophaseTables {
    pub move_data: MoveData,
    pub phase1_allowed_moves_by_last_face: Vec<Vec<u8>>,
    pub phase2_allowed_moves_by_last_face: Vec<Vec<u8>>,
    pub phase2_move_indices: [u8; PHASE2_MOVE_COUNT],
    pub phase2_move_faces: [u8; PHASE2_MOVE_COUNT],
    pub co: PackedTable,
    pub eo: PackedTable,
    pub slice: PackedTable,
    pub phase2_ep: PackedTable,
    pub phase2_cp_sep_joint: PackedTable,
    pub co_move: MoveTable,
    pub eo_move: MoveTable,
    pub slice_move: MoveTable,
    pub phase2_cp_move: MoveTable,
    pub phase2_ep_move: MoveTable,
    pub phase2_sep_move: MoveTable,
    pub solved_slice: u16,
}

pub enum BundleInput<'a> {
    Dist { kind: TableKind, values: &'a [u8] },
    Move { kind: TableKind, values: &'a [u16] },
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

fn resolve_phase2_move_indices(move_data: &MoveData) -> Result<[u8; PHASE2_MOVE_COUNT], String> {
    let mut indices = [0u8; PHASE2_MOVE_COUNT];
    for (slot, name) in PHASE2_MOVE_NAMES.iter().enumerate() {
        let Some(index) = move_data.move_names.iter().position(|candidate| candidate == name) else {
            return Err(format!("PHASE2_MOVE_INDEX_NOT_FOUND:{name}"));
        };
        indices[slot] = index as u8;
    }
    Ok(indices)
}

fn build_phase2_allowed_moves_by_last_face(phase2_move_faces: &[u8; PHASE2_MOVE_COUNT]) -> Vec<Vec<u8>> {
    let mut allowed = vec![Vec::new(); LAST_FACE_FREE as usize + 1];
    for last_face in 0..=LAST_FACE_FREE as usize {
        for (move_index, &face) in phase2_move_faces.iter().enumerate() {
            if last_face == LAST_FACE_FREE as usize {
                allowed[last_face].push(move_index as u8);
                continue;
            }
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
                buffer.push(0);
                push_u32(&mut buffer, values.len() as u32);
                push_u32(&mut buffer, payload.len() as u32);
                buffer.extend_from_slice(&payload);
            }
            BundleInput::Move { kind, values } => {
                buffer.push(*kind as u8);
                buffer.push(2u8);
                buffer.push(0u8);
                buffer.push(0u8);
                push_u32(&mut buffer, values.len() as u32);
                push_u32(&mut buffer, (values.len() * 2) as u32);
                for &value in *values {
                    buffer.extend_from_slice(&value.to_le_bytes());
                }
            }
        }
    }

    Ok(buffer)
}

pub fn load_bundle(bytes: &[u8]) -> Result<TwophaseTables, String> {
    if bytes.len() < BUNDLE_MAGIC.len() || &bytes[..BUNDLE_MAGIC.len()] != BUNDLE_MAGIC {
        return Err("invalid twophase bundle magic".into());
    }
    let mut offset = BUNDLE_MAGIC.len();
    let version = read_u32(bytes, &mut offset)?;
    if version != BUNDLE_VERSION {
        return Err(format!(
            "unsupported twophase bundle version: {version} (expected {BUNDLE_VERSION})"
        ));
    }

    let move_data_len = read_u32(bytes, &mut offset)? as usize;
    if bytes.len() < offset + move_data_len {
        return Err("bundle truncated while reading move data".into());
    }
    let move_data_file: MoveDataFile = serde_json::from_slice(&bytes[offset..offset + move_data_len])
        .map_err(|error| format!("failed to parse move data: {error}"))?;
    offset += move_data_len;

    let move_data = MoveData::try_from(move_data_file)?;
    let phase1_allowed_moves_by_last_face = build_allowed_moves_by_last_face(&move_data.move_face);
    let phase2_move_indices = resolve_phase2_move_indices(&move_data)?;
    let mut phase2_move_faces = [0u8; PHASE2_MOVE_COUNT];
    for (slot, &full_move_index) in phase2_move_indices.iter().enumerate() {
        phase2_move_faces[slot] = move_data.move_face[full_move_index as usize];
    }
    let phase2_allowed_moves_by_last_face =
        build_phase2_allowed_moves_by_last_face(&phase2_move_faces);

    let table_count = read_u32(bytes, &mut offset)? as usize;
    let mut co: Option<PackedTable> = None;
    let mut eo: Option<PackedTable> = None;
    let mut slice: Option<PackedTable> = None;
    let mut phase2_ep: Option<PackedTable> = None;
    let mut phase2_cp_sep_joint: Option<PackedTable> = None;
    let mut co_move: Option<MoveTable> = None;
    let mut eo_move: Option<MoveTable> = None;
    let mut slice_move: Option<MoveTable> = None;
    let mut phase2_cp_move: Option<MoveTable> = None;
    let mut phase2_ep_move: Option<MoveTable> = None;
    let mut phase2_sep_move: Option<MoveTable> = None;

    for _ in 0..table_count {
        if bytes.len() < offset + 4 {
            return Err("bundle truncated while reading table header".into());
        }
        let raw_kind = bytes[offset];
        let storage_kind = bytes[offset + 1];
        let meta = bytes[offset + 2];
        offset += 4;
        let entry_count = read_u32(bytes, &mut offset)? as usize;
        let payload_len = read_u32(bytes, &mut offset)? as usize;
        if bytes.len() < offset + payload_len {
            return Err("bundle truncated while reading table payload".into());
        }
        let kind = TableKind::from_u8(raw_kind);

        if storage_kind == 2 {
            let Some(kind) = kind else {
                offset += payload_len;
                continue;
            };
            let moves = kind
                .move_count()
                .ok_or_else(|| "unexpected move table kind".to_string())?;
            let mut values = Vec::with_capacity(entry_count);
            for index in 0..entry_count {
                let lo = bytes[offset + index * 2] as u16;
                let hi = bytes[offset + index * 2 + 1] as u16;
                values.push(lo | (hi << 8));
            }
            offset += payload_len;
            let table = MoveTable {
                states: if moves > 0 { entry_count / moves } else { 0 },
                moves,
                values,
            };
            match kind {
                TableKind::CoMove => co_move = Some(table),
                TableKind::EoMove => eo_move = Some(table),
                TableKind::SliceMove => slice_move = Some(table),
                TableKind::Phase2CpMove => phase2_cp_move = Some(table),
                TableKind::Phase2EpMove => phase2_ep_move = Some(table),
                TableKind::Phase2SepMove => phase2_sep_move = Some(table),
                _ => {}
            }
        } else {
            let nibble_packed = storage_kind == 1;
            let table = PackedTable {
                count: entry_count,
                max_distance: meta,
                nibble_packed,
                payload: bytes[offset..offset + payload_len].to_vec(),
            };
            offset += payload_len;
            match kind {
                Some(TableKind::Co) => co = Some(table),
                Some(TableKind::Eo) => eo = Some(table),
                Some(TableKind::Slice) => slice = Some(table),
                Some(TableKind::Phase2Ep) => phase2_ep = Some(table),
                Some(TableKind::Phase2CpSepJoint) => phase2_cp_sep_joint = Some(table),
                _ => {}
            }
        }
    }

    let solved_ep: [u8; EDGE_COUNT] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    Ok(TwophaseTables {
        move_data,
        phase1_allowed_moves_by_last_face,
        phase2_allowed_moves_by_last_face,
        phase2_move_indices,
        phase2_move_faces,
        co: co.ok_or_else(|| "twophase bundle missing CO table".to_string())?,
        eo: eo.ok_or_else(|| "twophase bundle missing EO table".to_string())?,
        slice: slice.ok_or_else(|| "twophase bundle missing Slice table".to_string())?,
        phase2_ep: phase2_ep.ok_or_else(|| "twophase bundle missing Phase2 EP table".to_string())?,
        phase2_cp_sep_joint: phase2_cp_sep_joint
            .ok_or_else(|| "twophase bundle missing Phase2 CPxSEP table".to_string())?,
        co_move: co_move.ok_or_else(|| "twophase bundle missing CO move table".to_string())?,
        eo_move: eo_move.ok_or_else(|| "twophase bundle missing EO move table".to_string())?,
        slice_move: slice_move
            .ok_or_else(|| "twophase bundle missing Slice move table".to_string())?,
        phase2_cp_move: phase2_cp_move
            .ok_or_else(|| "twophase bundle missing Phase2 CP move table".to_string())?,
        phase2_ep_move: phase2_ep_move
            .ok_or_else(|| "twophase bundle missing Phase2 EP move table".to_string())?,
        phase2_sep_move: phase2_sep_move
            .ok_or_else(|| "twophase bundle missing Phase2 SEP move table".to_string())?,
        solved_slice: encode_slice_from_ep(&solved_ep) as u16,
    })
}