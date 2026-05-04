/* @ts-self-types="./solver_wasm.d.ts" */

class HTRSubset {
    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(HTRSubset.prototype);
        obj.__wbg_ptr = ptr;
        HTRSubsetFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HTRSubsetFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_htrsubset_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get cxe_type() {
        const ret = wasm.__wbg_get_htrsubset_cxe_type(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get qt_estimate() {
        const ret = wasm.__wbg_get_htrsubset_qt_estimate(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get quality() {
        const ret = wasm.__wbg_get_htrsubset_quality(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set cxe_type(arg0) {
        wasm.__wbg_set_htrsubset_cxe_type(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set qt_estimate(arg0) {
        wasm.__wbg_set_htrsubset_qt_estimate(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set quality(arg0) {
        wasm.__wbg_set_htrsubset_quality(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) HTRSubset.prototype[Symbol.dispose] = HTRSubset.prototype.free;
exports.HTRSubset = HTRSubset;

/**
 * @returns {string}
 */
function build_fmc_tables_wasm() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.build_fmc_tables_wasm();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.build_fmc_tables_wasm = build_fmc_tables_wasm;

/**
 * @param {number} cp_idx
 * @param {number} ep_idx
 * @param {number} sep_idx
 * @returns {HTRSubset}
 */
function classify_htr_subset(cp_idx, ep_idx, sep_idx) {
    const ret = wasm.classify_htr_subset(cp_idx, ep_idx, sep_idx);
    return HTRSubset.__wrap(ret);
}
exports.classify_htr_subset = classify_htr_subset;

/**
 * @param {number} cp_idx
 * @param {number} ep_idx
 * @param {number} sep_idx
 * @returns {string}
 */
function create_htr_subset_json(cp_idx, ep_idx, sep_idx) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.create_htr_subset_json(cp_idx, ep_idx, sep_idx);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.create_htr_subset_json = create_htr_subset_json;

/**
 * @param {number} search_id
 */
function drop_minmove_search(search_id) {
    wasm.drop_minmove_search(search_id);
}
exports.drop_minmove_search = drop_minmove_search;

/**
 * @param {number} search_id
 */
function drop_twophase_search(search_id) {
    wasm.drop_twophase_search(search_id);
}
exports.drop_twophase_search = drop_twophase_search;

/**
 * @param {number} quality
 * @returns {string}
 */
function get_htr_quality_name(quality) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_htr_quality_name(quality);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.get_htr_quality_name = get_htr_quality_name;

/**
 * @param {number} cxe_type
 * @returns {string}
 */
function get_htr_subset_name(cxe_type) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_htr_subset_name(cxe_type);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.get_htr_subset_name = get_htr_subset_name;

/**
 * @param {Uint8Array} bytes
 */
function load_minmove_333_bundle(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_minmove_333_bundle(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.load_minmove_333_bundle = load_minmove_333_bundle;

/**
 * @param {Uint8Array} bytes
 */
function load_twophase_333_bundle(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.load_twophase_333_bundle(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.load_twophase_333_bundle = load_twophase_333_bundle;

/**
 * @param {string} scramble
 * @param {string} moves_str
 * @param {string} options_json
 * @returns {string}
 */
function optimize_insertion_wasm(scramble, moves_str, options_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(moves_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.optimize_insertion_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}
exports.optimize_insertion_wasm = optimize_insertion_wasm;

/**
 * @param {string} scramble
 * @returns {string}
 */
function prepare_minmove_333(scramble) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.prepare_minmove_333(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
exports.prepare_minmove_333 = prepare_minmove_333;

/**
 * @param {string} scramble
 * @param {string} options_json
 * @returns {string}
 */
function prepare_twophase_333(scramble, options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.prepare_twophase_333(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.prepare_twophase_333 = prepare_twophase_333;

/**
 * @param {number} search_id
 * @param {number} bound
 * @param {number} max_nodes
 * @returns {string}
 */
function search_minmove_bound(search_id, bound, max_nodes) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.search_minmove_bound(search_id, bound, max_nodes);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.search_minmove_bound = search_minmove_bound;

/**
 * @param {number} search_id
 * @param {string} options_json
 * @returns {string}
 */
function search_twophase_333(search_id, options_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.search_twophase_333(search_id, ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
exports.search_twophase_333 = search_twophase_333;

/**
 * @param {string} scramble
 * @param {string} options_json
 * @returns {string}
 */
function search_twophase_exact_333(scramble, options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.search_twophase_exact_333(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.search_twophase_exact_333 = search_twophase_exact_333;

/**
 * @param {string} scramble
 * @param {string} options_json
 * @returns {string}
 */
function solve_fmc_wasm(scramble, options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.solve_fmc_wasm(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.solve_fmc_wasm = solve_fmc_wasm;

/**
 * @param {string} req_json
 * @returns {string}
 */
function solve_json(req_json) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(req_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.solve_json(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}
exports.solve_json = solve_json;

/**
 * @param {number} cp_idx
 * @param {number} ep_idx
 * @param {number} sep_idx
 * @param {number} max_depth
 * @param {number} node_limit
 * @returns {string}
 */
function solve_phase2_direct(cp_idx, ep_idx, sep_idx, max_depth, node_limit) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.solve_phase2_direct(cp_idx, ep_idx, sep_idx, max_depth, node_limit);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.solve_phase2_direct = solve_phase2_direct;

/**
 * Verify that `scramble` followed by `solution` returns to the solved state.
 * Returns JSON: `{"ok": true, "solved": bool}` or `{"ok": false, "reason": "..."}`.
 * @param {string} scramble
 * @param {string} solution
 * @returns {string}
 */
function verify_fmc_solution_wasm(scramble, solution) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(scramble, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(solution, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.verify_fmc_solution_wasm(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
exports.verify_fmc_solution_wasm = verify_fmc_solution_wasm;

function warm_minmove_333() {
    const ret = wasm.warm_minmove_333();
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.warm_minmove_333 = warm_minmove_333;

function warm_twophase_333() {
    const ret = wasm.warm_twophase_333();
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}
exports.warm_twophase_333 = warm_twophase_333;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./solver_wasm_bg.js": import0,
    };
}

const HTRSubsetFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_htrsubset_free(ptr >>> 0, 1));

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/solver_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasm = new WebAssembly.Instance(wasmModule, __wbg_get_imports()).exports;
wasm.__wbindgen_start();
