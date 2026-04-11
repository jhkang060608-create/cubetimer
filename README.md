# CubeTimer

이 프로그램은 OpenAI의 GPT-5.2 Codex로 만들어졌습니다.

## 실행
정적 파일만 사용합니다. 로컬 서버로 열어주세요.

```bash
python3 -m http.server 5173
```

브라우저에서 `http://localhost:5173` 접속.

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

# 5) F2L 스타일 A/B 벤치마크 (strict/zb 동시, 스타일 거리 + 게이트 판정)
node tools/benchmark-f2l-style-ab.mjs --input vendor-data/reco/reco-3x3-details.json --style-profile-input vendor-data/reco/reco-3x3-style-features.json --limit 60 --modes strict,zb --styles legacy,balanced,rotationless,low-auf --output vendor-data/reco/reco-3x3-style-benchmark.json

# 6) 100+ solves + (CFOP/ZB) 통합 수동 배치 파이프라인
node tools/build-reco-3x3-gte100-pipeline.cjs --index-input vendor-data/reco/reco-all-3x3-index.json --details-input vendor-data/reco/reco-all-3x3-details.json --min-solves 100 --methods CFOP,ZB --benchmark-per-solver-limit 12
```

기본 timeout은 `strict=3000ms`, `zb=5000ms`입니다. 필요하면 `STRICT_TIMEOUT_MS`, `ZB_TIMEOUT_MS`, `TIMEOUT_MS`로 조정하세요.

옵션 확인:

```bash
node tools/fetch-reco-3x3-index.cjs --help
node tools/analyze-reco-3x3-index.cjs --help
node tools/fetch-reco-3x3-details.cjs --help
node tools/analyze-reco-3x3-details.cjs --help
node tools/build-reco-3x3-style-features.cjs --help
node tools/benchmark-f2l-style-ab.mjs --help
```

## 기능
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

## 조작
- `Space`: 0.3초 홀드 후 시작 / 정지
- 타이머 영역 클릭/터치로도 동일 동작

## 스크램블/미리보기 구현
- 스크램블: `cubing.js`의 `randomScrambleForEvent("eventId")`
- 미리보기: `scramble-display` 웹 컴포넌트 (2D 전개도)
  - `vendor/`에 로컬 포함되어 CDN 없이 동작합니다.

## 인스펙션 (옵션)
- 설정에서 15초 인스펙션을 켤 수 있습니다.
- 8초/12초에 TTS 안내 (`"8 seconds"`, `"12 seconds"`)
- 15초 초과 시 `+2`, 17초 초과 시 `DNF` 자동 적용

## 내보내기 포맷
- 기록 공유/내보내기:
  - `Genrated by  CubeTimer in YY-MM-DD HH:MM:SS`
  - `1. NN.NN scramble`
- 세션 내보내기:
  - `Genrated by  CubeTimer in YY-MM-DD-HH-MM-SS`
  - `Current Ao5/Best Ao5/Current Ao12/Best Ao12` 포함

> 참고: 공식 TNoodle(=WCA 공식 스크램블 프로그램)은 Java 기반입니다. 현재 프로젝트는 브라우저에서 바로 동작하도록 `cubing.js` 기반 스크램블을 사용합니다. 필요하면 TNoodle 서버 연동/빌드로 교체 가능합니다.

## 라이선스
`scramble-display`가 GPL-3.0 라이선스이므로, 본 프로젝트도 GPL-3.0으로 배포합니다.
