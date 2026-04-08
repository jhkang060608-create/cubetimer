// Precomputed move tables for 2x2 corners.
// perm_table size: 40320 states x 9 moves (U,U2,U',F,F2,F',R,R2,R')
// ori_delta: orientation delta for the 7 stored corners per move.
// For brevity and build speed, we generate at runtime once and cache.

use crate::permutation::permutation_to_index;
use once_cell::sync::Lazy;
use std::sync::LazyLock;

pub const NMOVES: usize = 9;
pub const NPERM: usize = 40320; // 8!
pub const NORI: usize = 2187; // 3^7

pub struct MoveTable {
    pub perm: Vec<[u32; NMOVES]>,
}

pub static MOVE_TABLE: Lazy<MoveTable> = Lazy::new(build_move_table);
pub static ORI_DELTA: LazyLock<[[u32; 7]; NMOVES]> = LazyLock::new(build_ori_delta);

fn build_move_table() -> MoveTable {
    let mut perm = vec![[0u32; NMOVES]; NPERM];
    for idx in 0..NPERM {
        let mut p = index_to_perm(idx as u32);
        for (m, &cycle) in MOVES.iter().enumerate() {
            apply_cycle(&mut p, cycle);
            perm[idx][m] = perm_to_index(&p);
            // undo for next move build
            apply_cycle_inv(&mut p, cycle);
        }
    }
    MoveTable { perm }
}

fn build_ori_delta() -> [[u32; 7]; NMOVES] {
    // U affects corners 0,1,2,3; F affects 0,3,4,5; R affects 0,1,5,4
    [
        [0, 0, 0, 0, 0, 0, 0], // U
        [0, 0, 0, 0, 0, 0, 0], // U2
        [0, 0, 0, 0, 0, 0, 0], // U'
        [2, 0, 0, 1, 1, 2, 0], // F (CW adds +1 to the 4 stickers, modulo 3)
        [0, 0, 0, 0, 0, 0, 0], // F2
        [1, 0, 0, 2, 2, 1, 0], // F'
        [1, 2, 0, 0, 2, 1, 0], // R
        [0, 0, 0, 0, 0, 0, 0], // R2
        [2, 1, 0, 0, 1, 2, 0], // R'
    ]
}

// Moves as corner index cycles (0..7)
const MOVES: [[usize; 4]; NMOVES] = [
    [0, 1, 2, 3], // U
    [0, 2, 1, 3], // U2 (apply twice U cycle)
    [0, 3, 2, 1], // U'
    [0, 4, 5, 3], // F
    [0, 5, 4, 3], // F2
    [0, 3, 5, 4], // F'
    [0, 1, 4, 5], // R
    [0, 4, 1, 5], // R2
    [0, 5, 4, 1], // R'
];

fn apply_cycle(p: &mut [u8; 8], cyc: [usize; 4]) {
    let tmp = p[cyc[0]];
    p[cyc[0]] = p[cyc[3]];
    p[cyc[3]] = p[cyc[2]];
    p[cyc[2]] = p[cyc[1]];
    p[cyc[1]] = tmp;
}
fn apply_cycle_inv(p: &mut [u8; 8], cyc: [usize; 4]) {
    let tmp = p[cyc[0]];
    p[cyc[0]] = p[cyc[1]];
    p[cyc[1]] = p[cyc[2]];
    p[cyc[2]] = p[cyc[3]];
    p[cyc[3]] = tmp;
}

fn index_to_perm(mut idx: u32) -> [u8; 8] {
    let mut elems = [0u8; 8];
    let mut used = [false; 8];
    for i in (0..8).rev() {
        let fact = factorial(i as u32);
        let pos = (idx / fact) as usize;
        idx %= fact;
        let mut count = 0;
        for n in 0..8 {
            if !used[n] {
                if count == pos {
                    elems[7 - i] = n as u8;
                    used[n] = true;
                    break;
                }
                count += 1;
            }
        }
    }
    elems
}

fn perm_to_index(p: &[u8; 8]) -> u32 {
    permutation_to_index(p.iter().map(|&x| x as usize)) as u32
}

fn factorial(n: u32) -> u32 {
    (1..=n).product::<u32>()
}
