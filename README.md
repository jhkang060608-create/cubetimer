# CubeTimer — Version 2 (2026 Algorithmic Rewrite)

이 릴리스(Version 2)는 UI나 파라미터 튜닝보다 '알고리즘적 구조의 재설계'에 초점을 둔 메이저 업데이트입니다. 목표는 "같은 탐색량을 유지하면서도 후보 당 비용을 획기적으로 줄여 전체 대기시간을 낮추는 것"입니다.

---

## Version 2 — Algorithmic Highlights (핵심 변경점)

1) F2L 핫패스의 '문자열 -> 숫자' 전환
- 기존: `${stateKey}::${nextStateKey}` 같은 문자열 합성 키를 Map에 사용. 많은 문자열 할당과 GC 발생.
- 변경: 상태/전이 키를 비트-패킹한 숫자(composite numeric key) 또는 2단계 숫자 맵으로 대체하여 문자열 할당을 제거하고 Map locality를 개선했습니다.
- 관련: solver/cfop3x3.js (F2L 키 빌더, transition cache)

2) 랭킹 비용의 선계산 (precompute)
- 각 F2L 포뮬러에 대해 이동수, 회전/AUF 카운트, wide-turn 수, 그리고 스타일 페널티를 라이브러리 빌드 시 미리 계산하여, 빔 스캔 중 중복 연산을 제거했습니다.
- 결과: 후보 정렬 비용이 크게 감소합니다.
- 관련: solver/cfop3x3.js (getF2LCaseLibrary)

3) 빔 확장 시 할당 제거 및 버퍼 재사용
- 후보 노드당 객체/배열을 새로 만들지 않고, 재사용 가능한 TypedArray 버퍼(슬랩)와 평탄화된 랭킹 배열을 사용합니다.
- 실제로 살아남은 최종 후보만 복제(materialize)하여 나머지 단계에서는 얕은 뷰를 유지합니다.
- 관련: solver/cfop3x3.js (considerCore / beam expansion)

4) 콤팩트 변환(compactTransform) 우선 보장
- 라이브러리 항목 대부분에 compactTransform을 보장하고, tryApplyTransformation / KPattern 재구성은 최후의 수단으로 축소했습니다. startPattern.applyAlg()가 핫 루프에서 호출되는 경우를 제거합니다.

5) 데이터 레이아웃 최적화
- 케이스 라이브러리 엔트리를 캐시 친화적 순서로 재배치하고, 코너/엣지 매치 데이터를 고정 레이아웃 TypedArray로 저장하여 스캔 루프의 브랜치와 인덱싱 비용을 낮췄습니다.

6) 라이브러리 조기 워밍업 및 병렬 초기화
- Worker 초기화 시 F2L/OLL/PLL/ZB 라이브러리를 미리 빌드하고, 독립적인 준비 작업을 병렬로 겹치게 하여 콜드 스타트 비용을 줄였습니다.
- 관련: solver/solverWorker.js

7) FMC: Kociemba 종속성 제거 + "move-count-first" 포트폴리오
- 기존 fallback(FMC_PHASE1_PHASE2) 경로를 제거하고, Kociemba에서 영감을 받은 핵심 아이디어(EO-axis, DR/domino, phase-2 skeleton 등)를 자체 구현으로 재구성했습니다.
- 예산(시간) 배분을 "최종 이동수 개선 우선"으로 재조정하여 FMC 후보 탐색의 효율성을 높였습니다.
- 관련: solver/fmcSolver.js, solver/solverWorker.js

8) 검증용 메트릭과 검색-볼륨 패리티
- 단계별 wall-time, F2L attemptsRef.count, beam-depth progression, 캐시 히트율, 핫패스 이스케이프 횟수 등을 측정해 "탐색량은 동일하게, 후보 비용만 감소"하는지를 자동 검증할 수 있습니다.

---

## 왜 이것이 중요한가?
- 단순히 beam width나 depth를 줄여 빠르게 보이는 최적화가 아니라, 후보 1개당 비용을 줄여 벤치마크 상의 p50/p95를 실제로 개선합니다.
- FMC는 더 이상 다른 알고리즘의 빠른 답을 빌려오지 않으며, 자체 포트폴리오만으로 품질(이동수)과 속도를 동시에 개선합니다.

---

(아래 섹션은 기존 README의 실행/테스트/벤치마크/라이선스 정보를 유지합니다.)
---

이 프로그램은 OpenAI의 GPT-5.2 Codex로 만들어졌습니다.

## 실행 방법
정적 파일만 사용합니다. 로컬 서버로 열어주세요.

```bash
python3 -m http.server 5173
```

브라우저에서 [http://localhost:5173](http://localhost:5173) 접속

---

## 업데이트
- v1.1: 모바일/그래프 레이아웃 관련 버그 수정
- v1.2: 모바일에서 미리보기/그래프가 세로로 쌓이도록 레이아웃 수정
- v1.3: 솔브 직후 입력이 유지될 때 다음 인스펙션이 자동 시작되는 문제 방지
- v1.4: inputLock 처리 보완 및 한국어 주석 추가
- v1.5: 사이드바 UI 순서 재배열 (스크램블 옵션/세션)
- v1.6: 그래프 드래그 이동 및 말풍선(툴팁) 기능 추가
- v1.7: 그래프 드래그/렌더 안정화, 모바일 터치 드래그 및 말풍선 탭 지원
- v1.8: 그래프 최신 위치 자동 추적(오토팔로우) 및 스케일 고정
- v1.9: 해결/인스펙션 중 전체화면 타이머 및 집중 모드 UI
- v1.10: solver 추가 (beta)
- v1.11: 버전업, FMC 기능 추가, CFOP 알고리즘 개선

## Reconstruction 데이터 수집 (초안)
`reco.nz`의 3x3 목록 데이터를 수집하고 선수별 요약 통계를 생성하는 스크립트를 추가했습니다.

```bash
# 1) 3x3 목록 수집 (파일럿 예시)
node tools/fetch-reco-3x3-index.cjs --start-page 1 --end-page 40 --delay-ms 250 --output vendor-data/reco/reco-3x3-index.json

# 1-b) 전체 이벤트 목록 수집 (약 13,000+ solve)
node tools/fetch-reco-3x3-index.cjs --start-page 1 --end-page 500 --puzzle all --delay-ms 120 --stop-on-empty 10 --output vendor-data/reco/reco-all-index.json

# 2) 선수별 요약 생성
node tools/analyze-reco-3x3-index.cjs --input vendor-data/reco/reco-3x3-index.json --output vendor-data/reco/reco-3x3-player-summary.json --min-solves 10

# 3) 개별 solve 상세 수집 (scramble / solution / stage stats)
node tools/fetch-reco-3x3-details.cjs --input vendor-data/reco/reco-3x3-index.json --output vendor-data/reco/reco-3x3-details.json --delay-ms 120 --concurrency 4 --resume true

# 3-b) 전체 이벤트 상세 수집 (장시간)
node tools/fetch-reco-3x3-details.cjs --input vendor-data/reco/reco-all-index.json --puzzle all --output vendor-data/reco/reco-all-details.json --delay-ms 80 --concurrency 6 --resume true --checkpoint-every 100

# 4) 상세 기반 선수 스타일 프로파일 생성
node tools/analyze-reco-3x3-details.cjs --input vendor-data/reco/reco-3x3-details.json --output vendor-data/reco/reco-3x3-style-profiles.json --min-solves 20

# 4-b) 전체 이벤트 상세 분석
node tools/analyze-reco-3x3-details.cjs --input vendor-data/reco/reco-all-details.json --puzzle all --output vendor-data/reco/reco-all-style-profiles.json --min-solves 20

# 4-c) solve 단위 스타일 피처 + 무결성 검증(샘플) 산출
node tools/build-reco-3x3-style-features.cjs --input vendor-data/reco/reco-3x3-details.json --output vendor-data/reco/reco-3x3-style-features.json --verify-sample 200 --verify-all false

# 4-d) 선수별 LL 변형/동의어 학습 프로파일 재생성
node --experimental-default-type=module tools/build-reco-3x3-f2l-ll-prediction.cjs --input vendor-data/reco/reco-all-3x3-gte100-details.json --output vendor-data/reco/reco-3x3-f2l-ll-prediction.json --puzzle 3x3 --methods CFOP,ZB --smoothing-alpha 2 --max-cases 8 --max-formulas 24

# 5) F2L 스타일 A/B 벤치마크 (strict/zb 동시, 스타일 거리 + 게이트 판정)
node tools/benchmark-f2l-style-ab.mjs --input vendor-data/reco/reco-3x3-details.json --style-profile-input vendor-data/reco/reco-3x3-style-features.json --limit 60 --modes strict,zb --styles legacy,balanced,rotationless,low-auf --output vendor-data/reco/reco-3x3-style-benchmark.json

# 6) 100+ solves + (CFOP/ZB) 통합 수동 배치 파이프라인
node tools/build-reco-3x3-gte100-pipeline.cjs --index-input vendor-data/reco/reco-all-3x3-index.json --details-input vendor-data/reco/reco-all-3x3-details.json --min-solves 100 --methods CFOP,ZB --benchmark-per-solver-limit 12

# 6-b) 현재 benchmark vs top10 baseline 비교 리포트 + mixed 활성 요약
node tools/report-reco-style-benchmark.mjs

# 6-c) benchmark / learned / mixed / main.js 회귀 검증
node tools/validate-reco-style-pipeline.mjs

# 7) Roux 웹 알고리즘 DB 갱신 (CMLL + EO4A/ELL 기반 LSE)
node tools/fetch-roux-web-dataset.cjs --output solver/rouxDataset.js

# 8) Roux 오프라인 case DB 생성 (FB/SB/CMLL/LSE)
node tools/generate-roux-case-db.mjs --output solver/rouxCaseDb.js

# 8-b) 100+ dataset 기반 FB/SB augmentation까지 같이 생성
node tools/generate-roux-case-db.mjs --output solver/rouxCaseDb.js --augment-input vendor-data/reco/reco-all-3x3-gte100-details.json --augment-limit 100 --augment-deadline-ms 15000

# 9) Roux recovery/실패 분석 리포트 생성
node tools/report-roux-recovery-cases.mjs --input vendor-data/reco/reco-all-3x3-gte100-details.json --output vendor-data/reco/roux-recovery-report.json --limit 100
```

기본 timeout은 `strict=3000ms`, `zb=5000ms`입니다. 필요하면 `STRICT_TIMEOUT_MS`, `ZB_TIMEOUT_MS`, `TIMEOUT_MS`로 조정하세요.
Roux 웹 DB 갱신은 네트워크가 필요합니다. 실패 시 에러 메시지(HTTP 코드/timeout)를 확인해 재시도하세요.
배치 벤치는 기본값으로 기존 batch 결과를 지우고 전체를 새로 실행합니다. 이어서 돌리고 싶을 때만 `BATCH_RESUME=1 ./run-full-style-dataset-batched.sh` 또는 `BATCH_RESUME=1 ./run-both-style-benchmarks.sh` 를 사용하세요.
강제로 fresh rerun 의도를 명확히 하려면 `BENCH_FORCE=1` 도 같이 사용할 수 있습니다.

옵션 확인:

```bash
node tools/fetch-reco-3x3-index.cjs --help
node tools/analyze-reco-3x3-index.cjs --help
node tools/fetch-reco-3x3-details.cjs --help
node tools/analyze-reco-3x3-details.cjs --help
node tools/build-reco-3x3-style-features.cjs --help
node tools/benchmark-f2l-style-ab.mjs --help
node tools/fetch-roux-web-dataset.cjs --help
node tools/generate-roux-case-db.mjs --help
node tools/report-roux-recovery-cases.mjs --help
```

## 주요 기능
- WCA 종목 스크램블 생성 + 2D 전개도 미리보기
- 실시간 타이머 (스페이스바 홀드로 시작)
- 세션 관리 (추가/이름 변경/삭제/초기화)
- 기록 저장 (localStorage)
- 패널티 적용 (`+2`, `DNF`) 및 인스펙션 자동 적용
- 기록 수정/삭제, 공유/내보내기 (팝업 텍스트)
- 통계: Best, 평균, Ao5, Ao12 (기록 단위 Ao5/Ao12 포함)
- 기록 변화 그래프 (휠/버튼으로 범위 조절)
- 설정: 라이트/다크/시스템, 버튼 컬러 테마, 미리보기/그래프 표시
- 모바일 레이아웃 대응
- solver 기능 (beta)

## 개발/벤치마크/테스트
- `Space`: 0.3초 홀드 후 시작 / 정지
- 타이머 영역 클릭/터치로도 동일 동작

## 구조/알고리즘 개요
- 스크램블: `cubing.js`의 `randomScrambleForEvent("eventId")`
- 미리보기: `scramble-display` 웹 컴포넌트 (2D 전개도)
  - `vendor/`에 로컬 포함되어 CDN 없이 동작합니다.

## 라이선스

- `scramble-display` (GPL-3.0) 포함, 전체 프로젝트 GPL-3.0

---

## 이전 README 백업: `README.old`

---

**문의/기여/이슈**: [github.com/3lown4way/cubetimer](https://github.com/3lown4way/cubetimer)
