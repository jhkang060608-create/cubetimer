#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="${INPUT:-$ROOT_DIR/vendor-data/reco/reco-all-3x3-gte100-details.json}"
STYLE_PROFILE_INPUT="${STYLE_PROFILE_INPUT:-$ROOT_DIR/vendor-data/reco/reco-3x3-style-features.json}"
OUTPUT_STRICT="${OUTPUT_STRICT:-$ROOT_DIR/vendor-data/reco/reco-3x3-style-benchmark-strict.json}"
OUTPUT_ZB="${OUTPUT_ZB:-$ROOT_DIR/vendor-data/reco/reco-3x3-style-benchmark-zb.json}"
OUTPUT_MERGED="${OUTPUT_MERGED:-$ROOT_DIR/vendor-data/reco/reco-3x3-style-benchmark.json}"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/vendor-data/reco}"
LIMIT="${LIMIT:-60}"
PER_SOLVER_LIMIT="${PER_SOLVER_LIMIT:-12}"
SCRAMBLE_CONCURRENCY="${SCRAMBLE_CONCURRENCY:-2}"
STRICT_TIMEOUT_MS="${STRICT_TIMEOUT_MS:-${TIMEOUT_MS:-3000}}"
ZB_TIMEOUT_MS="${ZB_TIMEOUT_MS:-${TIMEOUT_MS:-5000}}"
STYLES="${STYLES:-legacy,balanced,rotationless,low-auf}"

mkdir -p "$LOG_DIR"

run_mode() {
  local mode="$1"
  local output="$2"
  local logfile="$3"
  local timeout_flag="$4"
  local timeout_ms="$5"

  stdbuf -oL -eL node "$ROOT_DIR/tools/benchmark-f2l-style-ab.mjs" \
    --input "$INPUT" \
    --style-profile-input "$STYLE_PROFILE_INPUT" \
    --output "$output" \
    --limit "$LIMIT" \
    --per-solver-limit "$PER_SOLVER_LIMIT" \
    --scramble-concurrency "$SCRAMBLE_CONCURRENCY" \
    --"$timeout_flag" "$timeout_ms" \
    --mode "$mode" \
    --methods "CFOP,ZB" \
    --styles "$STYLES" \
    2>&1 | sed -u "s/^/[$mode] /" | tee "$logfile"
}

STRICT_STATUS=0
ZB_STATUS=0

cleanup() {
  [[ -n "${CURRENT_PID:-}" ]] && kill "$CURRENT_PID" 2>/dev/null || true
}

trap cleanup INT TERM

run_mode strict "$OUTPUT_STRICT" "$LOG_DIR/benchmark-strict.log" strict-timeout-ms "$STRICT_TIMEOUT_MS" &
CURRENT_PID=$!
wait "$CURRENT_PID" || STRICT_STATUS=$?

if [[ "$STRICT_STATUS" -ne 0 ]]; then
  echo "Benchmark failed: strict=$STRICT_STATUS" >&2
  exit 1
fi

run_mode zb "$OUTPUT_ZB" "$LOG_DIR/benchmark-zb.log" zb-timeout-ms "$ZB_TIMEOUT_MS" &
CURRENT_PID=$!
wait "$CURRENT_PID" || ZB_STATUS=$?

if [[ "$ZB_STATUS" -ne 0 ]]; then
  echo "Benchmark failed: zb=$ZB_STATUS" >&2
  exit 1
fi

node "$ROOT_DIR/tools/merge-reco-style-benchmark.cjs" \
  --inputs "$OUTPUT_STRICT,$OUTPUT_ZB" \
  --output "$OUTPUT_MERGED"

echo "Benchmark complete."
echo "Merged output: $OUTPUT_MERGED"
