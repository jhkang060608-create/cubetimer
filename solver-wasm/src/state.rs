use crate::tables::{MOVE_TABLE, ORI_DELTA};

// 2x2 state packed into u64: lower 32 bits for permutation (factorial base),
// upper 32 bits for orientation base-3 (7 corners, last determined).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct State(pub u64);

impl State {
    pub fn solved() -> Self {
        State(0)
    }

    pub fn from_scramble_indices(perm_index: u32, ori_index: u32) -> Self {
        let packed = (ori_index as u64) << 32 | perm_index as u64;
        State(packed)
    }

    pub fn perm_index(self) -> u32 {
        self.0 as u32
    }

    pub fn ori_index(self) -> u32 {
        (self.0 >> 32) as u32
    }

    pub fn apply_move(self, mv: usize) -> Self {
        let new_perm = MOVE_TABLE.perm[self.perm_index() as usize][mv];
        let new_ori = apply_ori(self.ori_index(), mv);
        State::from_scramble_indices(new_perm, new_ori)
    }
}

fn apply_ori(ori_index: u32, mv: usize) -> u32 {
    let mut idx = ori_index;
    let delta = ORI_DELTA[mv];
    let mut sum = 0;
    let mut res = 0u32;
    let mut factor = 1u32;
    for i in 0..7 {
        let digit = idx % 3;
        idx /= 3;
        let new_d = (digit + delta[i]) % 3;
        res += new_d * factor;
        factor *= 3;
        sum += new_d;
    }
    // 8th corner orientation determined so no need to store.
    res
}
