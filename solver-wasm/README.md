# solver-wasm (prototype)

Rust/WASM backend scaffold for CubeTimer. Includes a table-driven 2x2 solver using IDA* over packed corner permutation/orientation state.

## Build

```bash
cd solver-wasm
wasm-pack build --target web --out-dir ../public/solver-wasm
```

- Install wasm-pack first: https://rustwasm.github.io/wasm-pack/installer/
- Output goes to `public/solver-wasm` (adjust to your hosting path).

## JS integration sketch

- In the worker, import the generated init:
  ```js
  import init, { solve_json } from "../public/solver-wasm/solver_wasm.js";
  await init();
  const res = JSON.parse(solve_json(JSON.stringify({ scramble, event_id: "222" })));
  ```
- Keep this in a Web Worker to avoid blocking the main thread.
