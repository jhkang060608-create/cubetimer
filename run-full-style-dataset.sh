#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECO_DIR="${RECO_DIR:-$ROOT_DIR/vendor-data/reco}"

INPUT="${INPUT:-$RECO_DIR/reco-all-3x3-gte100-details.json}"
STYLE_PROFILE_INPUT="${STYLE_PROFILE_INPUT:-$RECO_DIR/reco-3x3-style-features.json}"
STYLE_DETAILS_INPUT="${STYLE_DETAILS_INPUT:-$RECO_DIR/reco-3x3-style-details.json}"

STRICT_OUT="${STRICT_OUT:-$RECO_DIR/reco-3x3-style-benchmark-strict.json}"
ZB_OUT="${ZB_OUT:-$RECO_DIR/reco-3x3-style-benchmark-zb.json}"
MERGED_OUT="${MERGED_OUT:-$RECO_DIR/reco-3x3-style-benchmark.json}"
LEARNED_OUT="${LEARNED_OUT:-$RECO_DIR/reco-3x3-learned-style-weights.json}"
MIXED_OUT="${MIXED_OUT:-$RECO_DIR/reco-3x3-mixed-cfop-profile.json}"

STRICT_LOG="${STRICT_LOG:-$RECO_DIR/benchmark-strict.full.log}"
ZB_LOG="${ZB_LOG:-$RECO_DIR/benchmark-zb.full.log}"

METHODS="${METHODS:-CFOP,ZB}"
STYLES="${STYLES:-legacy,balanced,rotationless,low-auf}"
SCRAMBLE_CONCURRENCY="${SCRAMBLE_CONCURRENCY:-2}"
AUTO_SCRAMBLE_CONCURRENCY="${AUTO_SCRAMBLE_CONCURRENCY:-1}"
MAX_SCRAMBLE_CONCURRENCY="${MAX_SCRAMBLE_CONCURRENCY:-4}"
SAFE_MODE="${SAFE_MODE:-0}"
NODE_MAX_OLD_SPACE_MB="${NODE_MAX_OLD_SPACE_MB:-0}"
STRICT_TIMEOUT_MS="${STRICT_TIMEOUT_MS:-3000}"
ZB_TIMEOUT_MS="${ZB_TIMEOUT_MS:-5000}"
LIMIT="${LIMIT:-20000}"
PER_SOLVER_LIMIT="${PER_SOLVER_LIMIT:-0}"
MIN_SAMPLES="${MIN_SAMPLES:-10}"
LEARN_OBJECTIVE="${LEARN_OBJECTIVE:-aggressive}"
MIN_SOLVES="${MIN_SOLVES:-100}"
PROGRESS="${PROGRESS:-0}"
PROGRESS_INTERVAL="${PROGRESS_INTERVAL:-10}"
PROGRESS_LINES="${PROGRESS_LINES:-3}"

total_scrambles() {
  node -e "const fs=require('fs'); const p=process.argv[1]; const methodsRaw=process.argv[2]||''; const perSolverLimit=parseInt(process.argv[3]||'0',10)||0; const limit=parseInt(process.argv[4]||'0',10)||0; const data=JSON.parse(fs.readFileSync(p,'utf8')); const records=Array.isArray(data)? data : (data.records||[]); const methods=new Set(methodsRaw.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean)); if (perSolverLimit>0){ const grouped=new Map(); const solverOrder=[]; for (const row of records){ if (!row||!row.ok) continue; const puzzle=String(row?.meta?.puzzle||row?.puzzle||'').trim(); if (puzzle!=='3x3') continue; const sourceSolver=String(row?.meta?.solver||row?.solver||'').trim(); if (!sourceSolver) continue; const sourceMethod=String(row.method||row?.meta?.method||'').trim().toUpperCase(); if (methods.size && !methods.has(sourceMethod)) continue; const scramble=String(row.scramble||'').trim(); if (!scramble) continue; let bucket=grouped.get(sourceSolver); if(!bucket){ bucket={seen:new Set(), rows:[]}; grouped.set(sourceSolver,bucket); solverOrder.push(sourceSolver);} if(bucket.seen.has(scramble)) continue; bucket.seen.add(scramble); bucket.rows.push(scramble);} let total=0; for (const solver of solverOrder){ const bucket=grouped.get(solver); if(!bucket||bucket.rows.length<perSolverLimit) continue; total+=perSolverLimit; } console.log(total); process.exit(0); } const seen=new Set(); let total=0; for (const row of records){ if (!row||!row.ok) continue; const puzzle=String(row?.meta?.puzzle||row?.puzzle||'').trim(); if (puzzle!=='3x3') continue; const sourceMethod=String(row.method||row?.meta?.method||'').trim().toUpperCase(); if (methods.size && !methods.has(sourceMethod)) continue; const scramble=String(row.scramble||'').trim(); if (!scramble) continue; if (seen.has(scramble)) continue; seen.add(scramble); total++; } if (limit>0 && total>limit) total=limit; console.log(total);" "$INPUT" "$METHODS" "$PER_SOLVER_LIMIT" "$LIMIT"
}

latest_sample() {
  local log="$1"
  local sample
  sample="$(tail -n 200 "$log" | grep -Eo 'sample [0-9]+' | tail -n 1 | awk '{print $2}')"
  if [[ -z "$sample" ]]; then
    echo 0
  else
    echo "$sample"
  fi
}

mkdir -p "$RECO_DIR"

if [[ "$NODE_MAX_OLD_SPACE_MB" -gt 0 ]]; then
  export NODE_OPTIONS="--max-old-space-size=$NODE_MAX_OLD_SPACE_MB"
fi

if [[ "$SAFE_MODE" -eq 1 ]]; then
  AUTO_SCRAMBLE_CONCURRENCY=0
  SCRAMBLE_CONCURRENCY=1
  MAX_SCRAMBLE_CONCURRENCY=1
fi

if [[ "$AUTO_SCRAMBLE_CONCURRENCY" -eq 1 && -z "${SCRAMBLE_CONCURRENCY_OVERRIDE:-}" ]]; then
  cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"
  if [[ -z "$cpu_count" || "$cpu_count" -lt 1 ]]; then
    cpu_count="$(command -v nproc >/dev/null 2>&1 && nproc || echo 2)"
  fi
  styles_count="$(awk -F',' '{print NF}' <<<"$STYLES")"
  if [[ -z "$styles_count" || "$styles_count" -lt 1 ]]; then
    styles_count=1
  fi
  auto_conc="$((cpu_count / styles_count))"
  if [[ "$auto_conc" -lt 1 ]]; then
    auto_conc=1
  fi
  if [[ -n "$MAX_SCRAMBLE_CONCURRENCY" && "$MAX_SCRAMBLE_CONCURRENCY" -gt 0 && "$auto_conc" -gt "$MAX_SCRAMBLE_CONCURRENCY" ]]; then
    auto_conc="$MAX_SCRAMBLE_CONCURRENCY"
  fi
  SCRAMBLE_CONCURRENCY="$auto_conc"
fi

echo "[1/4] strict/zb benchmark 병렬 실행 시작..."
echo "  input: $INPUT"
echo "  style profile input: $STYLE_PROFILE_INPUT"
echo "  strict log: $STRICT_LOG"
echo "  zb log: $ZB_LOG"
echo "  scramble concurrency: $SCRAMBLE_CONCURRENCY"
if [[ "$NODE_MAX_OLD_SPACE_MB" -gt 0 ]]; then
  echo "  node max old space: ${NODE_MAX_OLD_SPACE_MB} MB"
fi

node "$ROOT_DIR/tools/benchmark-f2l-style-ab.mjs" \
  --input "$INPUT" \
  --style-profile-input "$STYLE_PROFILE_INPUT" \
  --mode strict \
  --methods "$METHODS" \
  --styles "$STYLES" \
  --per-solver-limit "$PER_SOLVER_LIMIT" \
  --limit "$LIMIT" \
  --scramble-concurrency "$SCRAMBLE_CONCURRENCY" \
  --strict-timeout-ms "$STRICT_TIMEOUT_MS" \
  --output "$STRICT_OUT" \
  > "$STRICT_LOG" 2>&1 &
STRICT_PID=$!

node "$ROOT_DIR/tools/benchmark-f2l-style-ab.mjs" \
  --input "$INPUT" \
  --style-profile-input "$STYLE_PROFILE_INPUT" \
  --mode zb \
  --methods "$METHODS" \
  --styles "$STYLES" \
  --per-solver-limit "$PER_SOLVER_LIMIT" \
  --limit "$LIMIT" \
  --scramble-concurrency "$SCRAMBLE_CONCURRENCY" \
  --zb-timeout-ms "$ZB_TIMEOUT_MS" \
  --output "$ZB_OUT" \
  > "$ZB_LOG" 2>&1 &
ZB_PID=$!

STRICT_STATUS=0
ZB_STATUS=0

if [[ "$PROGRESS" -eq 1 ]]; then
  total="$(total_scrambles || echo 0)"
  if [[ -n "$total" && "$total" -gt 0 ]]; then
    echo "  total scrambles: $total"
  fi
  start_ts="$(date +%s)"
  echo ""
  echo "진행상황 보기 활성화 (interval=${PROGRESS_INTERVAL}s, lines=${PROGRESS_LINES})"
  while kill -0 "$STRICT_PID" 2>/dev/null || kill -0 "$ZB_PID" 2>/dev/null; do
    ts="$(date '+%H:%M:%S')"
    strict_sample="$(latest_sample "$STRICT_LOG")"
    zb_sample="$(latest_sample "$ZB_LOG")"
    now_ts="$(date +%s)"
    elapsed="$((now_ts - start_ts))"
    if [[ "$elapsed" -lt 1 ]]; then
      elapsed=1
    fi
    if [[ -n "$total" && "$total" -gt 0 ]]; then
      strict_pct="$(awk -v s="$strict_sample" -v t="$total" 'BEGIN{ if(t<=0) {print "0.0"} else {printf "%.1f", (s*100)/t} }')"
      zb_pct="$(awk -v s="$zb_sample" -v t="$total" 'BEGIN{ if(t<=0) {print "0.0"} else {printf "%.1f", (s*100)/t} }')"
      strict_eta="--"
      zb_eta="--"
      if [[ "$strict_sample" -gt 0 ]]; then
        strict_rate="$(awk -v s="$strict_sample" -v e="$elapsed" 'BEGIN{ if(e<=0) {print 0} else {printf "%.6f", s/e} }')"
        strict_rem="$((total - strict_sample))"
        if [[ "$strict_rem" -lt 0 ]]; then
          strict_rem=0
        fi
        strict_eta_sec="$(awk -v r="$strict_rem" -v rate="$strict_rate" 'BEGIN{ if(rate<=0) {print 0} else {printf "%d", r/rate} }')"
        strict_eta="$(date -u -d "@$strict_eta_sec" '+%H:%M:%S' 2>/dev/null || date -u -r "$strict_eta_sec" '+%H:%M:%S')"
      fi
      if [[ "$zb_sample" -gt 0 ]]; then
        zb_rate="$(awk -v s="$zb_sample" -v e="$elapsed" 'BEGIN{ if(e<=0) {print 0} else {printf "%.6f", s/e} }')"
        zb_rem="$((total - zb_sample))"
        if [[ "$zb_rem" -lt 0 ]]; then
          zb_rem=0
        fi
        zb_eta_sec="$(awk -v r="$zb_rem" -v rate="$zb_rate" 'BEGIN{ if(rate<=0) {print 0} else {printf "%d", r/rate} }')"
        zb_eta="$(date -u -d "@$zb_eta_sec" '+%H:%M:%S' 2>/dev/null || date -u -r "$zb_eta_sec" '+%H:%M:%S')"
      fi
      echo ""
      echo "[$ts] strict progress: ${strict_sample}/${total} (${strict_pct}%) ETA ${strict_eta}"
      echo "[$ts] zb progress: ${zb_sample}/${total} (${zb_pct}%) ETA ${zb_eta}"
    fi
    echo ""
    echo "[$ts] strict tail:"
    tail -n "$PROGRESS_LINES" "$STRICT_LOG" || true
    echo "[$ts] zb tail:"
    tail -n "$PROGRESS_LINES" "$ZB_LOG" || true
    sleep "$PROGRESS_INTERVAL"
  done
fi

wait "$STRICT_PID" || STRICT_STATUS=$?
wait "$ZB_PID" || ZB_STATUS=$?

if [[ "$STRICT_STATUS" -ne 0 || "$ZB_STATUS" -ne 0 ]]; then
  echo "Benchmark failed: strict=$STRICT_STATUS zb=$ZB_STATUS" >&2
  echo "Check logs:"
  echo "  $STRICT_LOG"
  echo "  $ZB_LOG"
  exit 1
fi

echo "[2/4] benchmark 병합..."
node "$ROOT_DIR/tools/merge-reco-style-benchmark.cjs" \
  --inputs "$STRICT_OUT,$ZB_OUT" \
  --output "$MERGED_OUT"

echo "[3/4] player style weight 재학습..."
node "$ROOT_DIR/tools/learn-reco-player-style-weights.cjs" \
  --benchmarks "$MERGED_OUT" \
  --players "$STYLE_DETAILS_INPUT" \
  --modes strict,zb \
  --min-samples "$MIN_SAMPLES" \
  --objective "$LEARN_OBJECTIVE" \
  --output "$LEARNED_OUT"

echo "[4/4] mixed cfop profile 재생성..."
node "$ROOT_DIR/tools/build-reco-3x3-top10-mixed-cfop-profile.cjs" \
  --details "$INPUT" \
  --style-details "$STYLE_DETAILS_INPUT" \
  --methods "$METHODS" \
  --min-solves "$MIN_SOLVES" \
  --output "$MIXED_OUT"

echo ""
echo "완료:"
echo "  strict: $STRICT_OUT"
echo "  zb: $ZB_OUT"
echo "  merged: $MERGED_OUT"
echo "  learned: $LEARNED_OUT"
echo "  mixed: $MIXED_OUT"
echo "로그:"
echo "  $STRICT_LOG"
echo "  $ZB_LOG"
