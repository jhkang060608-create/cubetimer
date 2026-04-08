use crate::tables::NMOVES;

// Parser that accepts WCA-style 2x2 tokens (all faces) and ignores leading "x:" style prefixes sometimes used in UWR/scramble.
pub fn parse_scramble(scramble: &str) -> Option<Vec<usize>> {
    let mut res = Vec::new();
    for token in scramble.split_whitespace() {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        // Ignore prefixes like "x:" if present
        let core = if let Some(pos) = t.find(':') {
            &t[pos + 1..]
        } else {
            t
        };
        let idx = match core {
            "U" => 0,
            "U2" => 1,
            "U'" => 2,
            "F" => 3,
            "F2" => 4,
            "F'" => 5,
            "R" => 6,
            "R2" => 7,
            "R'" => 8,
            "D" => 9,
            "D2" => 10,
            "D'" => 11,
            "L" => 12,
            "L2" => 13,
            "L'" => 14,
            "B" => 15,
            "B2" => 16,
            "B'" => 17,
            _ => return None,
        };
        res.push(idx);
    }
    Some(res)
}

pub fn apply_scramble_to_solved(moves: &[usize]) -> crate::state::State {
    let mut state = crate::state::State::solved();
    for &mv in moves {
        if mv >= NMOVES {
            continue;
        }
        state = state.apply_move(mv);
    }
    state
}
