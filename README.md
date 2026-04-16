# 🧊 CubeTimer 2026 — The Algorithmic Revolution

> **“Speed is not just about searching less. It’s about making every candidate count.”**

CubeTimer 2026 is not a UI facelift. It’s a ground-up, algorithm-first rewrite that redefines what’s possible in browser-based cube solving. Every line is engineered for raw speed, search-volume parity, and method purity. Welcome to the new era of cubing software.

---

## 🚀 What Makes v2 a Revolution?

### 1. **Numeric-Only Hot Path**
- All F2L state and transition keys are now bit-packed numbers, not strings. No more `${stateKey}::${nextStateKey}`. This slashes GC, boosts Map locality, and makes the beam search *fly*.

### 2. **Precomputed Style Intelligence**
- Every F2L formula is pre-analyzed for move count, AUF, wide turns, and style penalty. The beam never wastes time recalculating what the library already knows.

### 3. **Zero-Allocation Beam Expansion**
- No more per-candidate object churn. TypedArray slabs and flat ranking arrays mean only the survivors get materialized. The rest? Lightning-fast, buffer-reused, and cache-friendly.

### 4. **Compact Transform Guarantee**
- The library ensures nearly every entry has a compactTransform. Fallbacks like tryApplyTransformation or KPattern are now true last resorts, never hot-path bottlenecks.

### 5. **Cache-Optimized Data Layout**
- F2L entries are packed for scan efficiency. Corner/edge match data is stored in fixed-layout TypedArrays, minimizing branch and index overhead in the scan loop.

### 6. **Aggressive Early Library Warmup & Parallel Prep**
- All heavy libraries (F2L/OLL/PLL/ZB) are built at worker init, with independent prep tasks running in parallel. Cold start? Practically gone.

### 7. **FMC: Pure, Kociemba-Free, Move-Count-First**
- No more generic fallback. The FMC solver is now a native, Kociemba-inspired engine that prioritizes move count and quality, not just “any solution.”

### 8. **Metrics-Driven, Search-Volume Parity**
- Every optimization is validated: wall time, F2L attempts, beam depth, cache hit rates, and more. If search volume drops, it’s a bug—not a feature.

---

## 💡 Why Does This Matter?
- **No more “fake” speedups.** We don’t shrink the search—just the cost per candidate. p50/p95 latency drops, but the solver’s depth and quality remain.
- **FMC is now truly native.** No more borrowing from other methods. Every solution is earned, not borrowed.

---

## 🛠️ Quick Start

```bash
python3 -m http.server 5173
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 📝 Full Feature List, Data Tools, and Benchmarks
(See below for all legacy and advanced features, data scripts, and benchmarking tools.)

---

## 📅 업데이트
- v2.0 (2026): **대규모 알고리즘/디자인 리라이트**
    - 완전한 F2L/CFOP/FMC 내부 구조 재설계: 모든 핫패스 키를 숫자화, GC/할당 최소화, 콤팩트 변환 보장
    - FMC: Kociemba-style fallback 완전 제거, 자체 엔진으로 move-count-first 포트폴리오 구현
    - 라이브러리 조기 워밍업, 병렬 초기화, 캐시 최적화, 데이터 레이아웃 개선
    - UI: 다크/라이트 테마 개선, 모바일 터치 최적화, 그래프/통계 시각화 업그레이드
    - 벤치마크/메트릭: 단계별 wall-time, 탐색량, 캐시 히트율 등 자동 검증 도구 내장
    - README/문서: v2.0 혁신점과 구조적 차별성 강조, 백업 README.old 제공
- v1.1~v1.11: 모바일/그래프/타이머/세션/solver 등 기능 및 버그 수정(아래 참고)

**Built with OpenAI GPT-5.2 Codex.**

---

## 이전 README 백업: `README.old`

---

**문의/기여/이슈**: [github.com/3lown4way/cubetimer](https://github.com/3lown4way/cubetimer)
