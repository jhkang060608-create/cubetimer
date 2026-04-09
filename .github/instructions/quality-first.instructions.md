---
description: "Use when: best result, 최고 품질, exhaustive, thorough, correctness-first, no concern for time/compute cost in this workspace."
name: "Quality First For CubeTimer"
applyTo:
  - "**/*.js"
  - "**/*.mjs"
  - "**/*.cjs"
  - "**/*.html"
  - "**/*.css"
  - "**/*.rs"
  - "**/*.toml"
  - "**/*.md"
---
# Quality-First Execution (CubeTimer)

- Prioritize correctness, robustness, and completeness over speed, token usage, or compute cost.
- Do not ship the first plausible patch when a more reliable fix is available; prefer deeper root-cause analysis and stronger validation.
- For solver changes, validate behavior with broader coverage, not only a single happy path.
- Treat the checks below as the default operating mode; if you skip one, explain why and note residual risk.

## Recommended Validation Depth (Default)

- If solver logic changes (files under solver/**), run:
  - node tools/solver-smoke.mjs --random-count 20 --random-length 10 --max-depth 16
- If 2x2 logic changes, add:
  - node tools/solver-smoke.mjs --random-count 20 --random-length 10 --max-depth 16 --include-2x2
- If dataset files are touched:
  - Never hand-edit solver/rouxDataset.js or solver/zbDataset.js as the primary fix.
  - Regenerate with node tools/generate-roux-dataset.cjs and/or node tools/generate-zb-dataset.cjs.
- If wasm or Rust solver code changes (solver-wasm/** or solver/wasmSolver.js), run:
  - cd solver-wasm && wasm-pack build --target web --out-dir ../public/solver-wasm

## Implementation Guidance

- Prefer explicit error handling and deterministic fallback behavior over silent failure.
- Keep worker boundaries clear: heavy solving stays in worker paths; avoid main-thread blocking changes.
- When uncertain, gather more codebase evidence first and test more deeply before finalizing.

## Existing Docs (Link, Do Not Duplicate)

- README.md: app usage and local static-server run flow.
- solver_project_readme.md: solver roadmap and phase context.
- solver-wasm/README.md: wasm build and integration notes.
