/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const build_fmc_tables_wasm: () => [number, number];
export const drop_minmove_search: (a: number) => void;
export const drop_twophase_search: (a: number) => void;
export const load_minmove_333_bundle: (a: number, b: number) => [number, number];
export const load_twophase_333_bundle: (a: number, b: number) => [number, number];
export const optimize_insertion_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
export const prepare_minmove_333: (a: number, b: number) => [number, number];
export const prepare_twophase_333: (a: number, b: number, c: number, d: number) => [number, number];
export const search_minmove_bound: (a: number, b: number, c: number) => [number, number];
export const search_twophase_333: (a: number, b: number, c: number) => [number, number];
export const search_twophase_exact_333: (a: number, b: number, c: number, d: number) => [number, number];
export const solve_fmc_wasm: (a: number, b: number, c: number, d: number) => [number, number];
export const solve_json: (a: number, b: number) => [number, number];
export const solve_phase2_direct: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const verify_fmc_solution_wasm: (a: number, b: number, c: number, d: number) => [number, number];
export const warm_minmove_333: () => [number, number];
export const warm_twophase_333: () => [number, number];
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
