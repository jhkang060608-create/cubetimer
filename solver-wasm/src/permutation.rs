// Minimal factorial number system helpers for 8-element permutations.

pub fn permutation_to_index<I: Iterator<Item = usize>>(iter: I) -> usize {
    let mut elems: Vec<usize> = iter.collect();
    let n = elems.len();
    let mut idx = 0;
    for i in 0..n {
        let smaller = elems.iter().skip(i + 1).filter(|&&v| v < elems[i]).count();
        idx = idx * (n - i) + smaller;
    }
    idx
}
