mod ida;
mod parser;
mod permutation;
mod state;
mod tables;
mod utils;

use ida::{build_prune_tables, ida_solve};
use serde::{Deserialize, Serialize};
use state::State;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
pub struct SolveRequest {
    pub scramble: String,
    pub event_id: String,
}

#[derive(Serialize, Deserialize)]
pub struct SolveResponse {
    pub ok: bool,
    pub solution: String,
    pub move_count: u32,
    pub reason: Option<String>,
}

static mut PRUNE: Option<ida::PruneTables> = None;

#[wasm_bindgen]
pub fn solve_json(req_json: &str) -> String {
    utils::set_panic_hook();
    let parsed: Result<SolveRequest, _> = serde_json::from_str(req_json);
    if let Err(err) = parsed {
        return error_resp(format!("invalid request: {err}"));
    }
    let req = parsed.unwrap();
    if req.scramble.trim().is_empty() {
        return error_resp("NO_SCRAMBLE".into());
    }
    match req.event_id.as_str() {
        "222" => solve_2x2(req.scramble),
        _ => error_resp("UNSUPPORTED_EVENT".into()),
    }
}

fn solve_2x2(_scramble: String) -> String {
    let prune = unsafe { PRUNE.get_or_insert_with(|| build_prune_tables()) };

    let moves = match parser::parse_scramble(&_scramble) {
        Some(v) => v,
        None => return error_resp("BAD_SCRAMBLE".into()),
    };
    let state = parser::apply_scramble_to_solved(&moves);
    if let Some(path) = ida_solve(state, 11, prune) {
        let moves = path_to_strings(path);
        return serde_json::to_string(&SolveResponse {
            ok: true,
            solution: moves.join(" "),
            move_count: moves.len() as u32,
            reason: None,
        })
        .unwrap();
    }
    error_resp("NO_SOLUTION".into())
}

fn path_to_strings(path: Vec<usize>) -> Vec<String> {
    path.into_iter()
        .map(|m| match m {
            0 => "U".into(),
            1 => "U2".into(),
            2 => "U'".into(),
            3 => "F".into(),
            4 => "F2".into(),
            5 => "F'".into(),
            6 => "R".into(),
            7 => "R2".into(),
            8 => "R'".into(),
            _ => unreachable!(),
        })
        .collect()
}

fn error_resp(reason: String) -> String {
    serde_json::to_string(&SolveResponse {
        ok: false,
        solution: String::new(),
        move_count: 0,
        reason: Some(reason),
    })
    .unwrap()
}
