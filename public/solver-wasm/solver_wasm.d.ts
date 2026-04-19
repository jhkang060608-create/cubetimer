/* tslint:disable */
/* eslint-disable */

export function build_fmc_tables_wasm(): string;

export function drop_minmove_search(search_id: number): void;

export function drop_twophase_search(search_id: number): void;

export function load_minmove_333_bundle(bytes: Uint8Array): void;

export function load_twophase_333_bundle(bytes: Uint8Array): void;

export function optimize_insertion_wasm(scramble: string, moves_str: string, options_json: string): string;

export function prepare_minmove_333(scramble: string): string;

export function prepare_twophase_333(scramble: string, options_json: string): string;

export function search_minmove_bound(search_id: number, bound: number, max_nodes: number): string;

export function search_twophase_333(search_id: number, options_json: string): string;

export function search_twophase_exact_333(scramble: string, options_json: string): string;

export function solve_fmc_wasm(scramble: string, options_json: string): string;

export function solve_json(req_json: string): string;

export function solve_phase2_direct(cp_idx: number, ep_idx: number, sep_idx: number, max_depth: number, node_limit: number): string;

/**
 * Verify that `scramble` followed by `solution` returns to the solved state.
 * Returns JSON: `{"ok": true, "solved": bool}` or `{"ok": false, "reason": "..."}`.
 */
export function verify_fmc_solution_wasm(scramble: string, solution: string): string;

export function warm_minmove_333(): void;

export function warm_twophase_333(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_fmc_tables_wasm: () => [number, number];
    readonly drop_minmove_search: (a: number) => void;
    readonly drop_twophase_search: (a: number) => void;
    readonly load_minmove_333_bundle: (a: number, b: number) => [number, number];
    readonly load_twophase_333_bundle: (a: number, b: number) => [number, number];
    readonly optimize_insertion_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly prepare_minmove_333: (a: number, b: number) => [number, number];
    readonly prepare_twophase_333: (a: number, b: number, c: number, d: number) => [number, number];
    readonly search_minmove_bound: (a: number, b: number, c: number) => [number, number];
    readonly search_twophase_333: (a: number, b: number, c: number) => [number, number];
    readonly search_twophase_exact_333: (a: number, b: number, c: number, d: number) => [number, number];
    readonly solve_fmc_wasm: (a: number, b: number, c: number, d: number) => [number, number];
    readonly solve_json: (a: number, b: number) => [number, number];
    readonly solve_phase2_direct: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly verify_fmc_solution_wasm: (a: number, b: number, c: number, d: number) => [number, number];
    readonly warm_minmove_333: () => [number, number];
    readonly warm_twophase_333: () => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
