use crate::state::State;
use crate::tables::{MOVE_TABLE, NMOVES, NORI, NPERM};
use std::cmp::max;

pub fn ida_solve(state: State, max_depth: u8, prune: &PruneTables) -> Option<Vec<usize>> {
    let h = prune.heuristic(state);
    let mut bound = max(1, h);
    let mut path = Vec::with_capacity(20);
    while bound <= max_depth {
        if let Some(sol) = search(state, 0, bound, usize::MAX, prune, &mut path) {
            return Some(sol);
        }
        bound += 1;
    }
    None
}

fn search(
    state: State,
    depth: u8,
    bound: u8,
    last_face: usize,
    prune: &PruneTables,
    path: &mut Vec<usize>,
) -> Option<Vec<usize>> {
    let h = prune.heuristic(state);
    let f = depth + h;
    if f > bound {
        return None;
    }
    if h == 0 {
        return Some(path.clone());
    }
    for mv in 0..NMOVES {
        let face = mv / 3; // 0:U,1:F,2:R
        if face == last_face {
            continue;
        }
        let next = state.apply_move(mv);
        path.push(mv);
        if let Some(sol) = search(next, depth + 1, bound, face, prune, path) {
            return Some(sol);
        }
        path.pop();
    }
    None
}

pub struct PruneTables {
    // simple arrays: perm_prune[NPERM], ori_prune[NORI]
    pub perm: Vec<u8>,
    pub ori: Vec<u8>,
}

impl PruneTables {
    pub fn heuristic(&self, state: State) -> u8 {
        let p = self.perm[state.perm_index() as usize];
        let o = self.ori[state.ori_index() as usize];
        std::cmp::max(p, o)
    }
}

pub fn build_prune_tables() -> PruneTables {
    let perm = bfs_prune_perm();
    let ori = bfs_prune_ori();
    PruneTables { perm, ori }
}

fn bfs_prune_perm() -> Vec<u8> {
    let mut dist = vec![255u8; NPERM];
    let mut queue = std::collections::VecDeque::new();
    dist[0] = 0;
    queue.push_back(0u32);
    while let Some(idx) = queue.pop_front() {
        let d = dist[idx as usize];
        for mv in 0..NMOVES {
            let next = MOVE_TABLE.perm[idx as usize][mv];
            if dist[next as usize] == 255 {
                dist[next as usize] = d + 1;
                queue.push_back(next);
            }
        }
    }
    dist
}

fn bfs_prune_ori() -> Vec<u8> {
    let mut dist = vec![255u8; NORI];
    let mut queue = std::collections::VecDeque::new();
    dist[0] = 0;
    queue.push_back(0u32);
    while let Some(idx) = queue.pop_front() {
        let d = dist[idx as usize];
        for mv in 0..NMOVES {
            // orientation delta only: apply move on ori index only
            let next = apply_ori_index(idx, mv as u32);
            if dist[next as usize] == 255 {
                dist[next as usize] = d + 1;
                queue.push_back(next);
            }
        }
    }
    dist
}

fn apply_ori_index(idx: u32, mv: u32) -> u32 {
    // replicate apply_ori but on raw index to avoid State dependency here
    let mut val = idx;
    let delta = crate::tables::ORI_DELTA[mv as usize];
    let mut res = 0u32;
    let mut factor = 1u32;
    for i in 0..7 {
        let digit = val % 3;
        val /= 3;
        let new_d = (digit + delta[i]) % 3;
        res += new_d * factor;
        factor *= 3;
    }
    res
}
