# solver-wasm

Rust/WASM backend for CubeTimer.

- `solve_json(...)` keeps the existing 2x2 table-driven solver path.
- `minmove` adds a separate exact 3x3 HTM solver path backed by a lazily loaded bundle.
- `twophase` adds a practical 3x3 Kociemba-style path backed by a separate WASM bundle and session API.

## Build

```bash
node tools/export-minmove-move-data.mjs
cargo run --manifest-path solver-wasm/Cargo.toml --bin build_minmove_tables
cargo run --manifest-path solver-wasm/Cargo.toml --bin build_twophase_tables
cd solver-wasm
wasm-pack build --target web --out-dir ../public/solver-wasm
```

- Install wasm-pack first: https://rustwasm.github.io/wasm-pack/installer/
- The move-data export step copies the current JS 3x3 move convention into `solver-wasm/assets/minmove_move_data.json`.
- The minmove bundle step writes `public/solver-wasm/minmove/minmove-333-v4.bin`.
- The twophase bundle step writes `public/solver-wasm/twophase/twophase-333-v1.bin`.
- The wasm-pack step writes the runtime module into `public/solver-wasm`.

## Native validation

```bash
cargo run --manifest-path solver-wasm/Cargo.toml --bin minmove_cli -- --scramble "R U R' U'" --max-bound 8
cargo run --manifest-path solver-wasm/Cargo.toml --bin twophase_cli -- --scramble "R U R' U'" --frontiers 12
```

- `minmove_cli` uses the same shared search core as the WASM runtime.
- `twophase_cli` uses the same shared phase1/phase2 session core as the WASM runtime.
- Use them to smoke-test the native search paths before rebuilding the web bundle.

## JS integration sketch

- In the worker, import the generated init:
  ```js
  import init, {
    load_minmove_333_bundle,
    prepare_minmove_333,
    search_minmove_bound,
    solve_json,
  } from "../public/solver-wasm/solver_wasm.js";
  await init();
  const res = JSON.parse(solve_json(JSON.stringify({ scramble, event_id: "222" })));
  ```
- Keep this in a Web Worker to avoid blocking the main thread.
- For `minmove`, fetch `public/solver-wasm/minmove/minmove-333-v4.bin`, pass it to `load_minmove_333_bundle(...)`, then call `prepare_minmove_333(...)` and `search_minmove_bound(...)` bound by bound.
- For `twophase`, fetch `public/solver-wasm/twophase/twophase-333-v1.bin`, pass it to `load_twophase_333_bundle(...)`, then call `prepare_twophase_333(...)` and `search_twophase_333(...)`.
