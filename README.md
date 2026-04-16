# CubeTimer

브라우저에서 바로 실행되는 큐브 타이머 겸 분석 도구입니다.  
실시간 타이머, 세션/기록 관리, Ao5/Ao12 통계, 기록 그래프, 2D 스크램블 미리보기, 그리고 CFOP/FMC/ROUX 기반 솔버를 한 화면에서 사용할 수 있도록 구성되어 있습니다.

## 주요 기능

- WCA 스타일 타이머
  스페이스바와 터치 입력을 모두 지원하며 `hold -> ready -> running -> stopped` 흐름으로 동작합니다.
- 인스펙션 지원
  15초 인스펙션, 음성 카운트, `+2`/`DNF` 처리까지 포함합니다.
- 세션별 기록 관리
  세션 추가, 이름 변경, 삭제, 초기화, 기록 공유/수정/삭제를 지원합니다.
- 통계 표시
  `Best`, `Mean`, `Ao5`, `Ao12`를 실시간으로 계산해 보여줍니다.
- 기록 그래프
  단일 기록과 평균 흐름을 시각화하고 확대/축소도 가능합니다.
- 스크램블 미리보기
  현재 스크램블을 2D 전개도로 바로 확인할 수 있습니다.
- 테마/강조색 커스터마이징
  시스템/라이트/다크 테마와 강조색을 저장해 다음 방문 때 복원합니다.
- 모바일 반응형 UI
  터치 입력, 카드 배치, 설정 모달, 기록 패널 등 모바일 화면에 맞게 조정됩니다.
- 내장 솔버
  2x2, 3x3, CFOP, FMC, ROUX 관련 솔버와 데이터셋, 워커 기반 비동기 실행을 포함합니다.

## 스크린 구성

### 메인 화면

- 좌측 패널
  세션 선택, 세션 관리 버튼, 최근 기록 목록
- 중앙 영역
  스크램블, 이벤트 선택, 타이머, 요약 통계
- 우측 하단
  기록 그래프와 스크램블 미리보기

### 기록 메뉴

- 기록 공유
- 페널티 변경 (`OK`, `+2`, `DNF`)
- 개별 기록 삭제

### 설정

- 테마 선택
- 강조색 선택
- 스크램블 미리보기 표시 여부
- 기록 그래프 표시 여부
- Ao5/Ao12 표시 여부
- 인스펙션 사용 여부

### 솔버 모달

- Cross 색상 선택
- 탐색 모드 선택
- F2L 스타일 선택
- 스타일 로드 기능
- 해 탐색 결과 확인 및 복사

## 실행 방법

별도 번들러 없이 정적 파일 서버만 있으면 실행할 수 있습니다.

```bash
python3 -m http.server 5173
```

브라우저에서 `http://localhost:5173`를 열면 됩니다.

다른 정적 서버를 써도 괜찮습니다. 예:

```bash
npx serve .
```

## 데이터 저장 방식

앱 상태는 브라우저 `localStorage`에 저장됩니다.

- 세션 목록 및 현재 활성 세션
- 각 세션의 기록 목록
- 테마/강조색
- 그래프/미리보기 표시 여부
- 인스펙션 사용 여부
- Ao5/Ao12 토글 상태
- 솔버 관련 설정 일부

즉, 서버 없이도 로컬에서 상태를 유지할 수 있습니다.

## 프로젝트 구조

### 루트

- [index.html](/home/jhkang/cubetimer/index.html)
  메인 레이아웃과 모달 마크업
- [styles.css](/home/jhkang/cubetimer/styles.css)
  전체 테마, 반응형 레이아웃, 카드/모달/그래프 스타일
- [main.js](/home/jhkang/cubetimer/main.js)
  타이머 상태 관리, 세션/기록 로직, 그래프 렌더링, UI 이벤트, 설정 저장

### solver/

- [solver/solverWorker.js](/home/jhkang/cubetimer/solver/solverWorker.js)
  워커 진입점. 무거운 탐색을 메인 스레드와 분리합니다.
- [solver/cfop3x3.js](/home/jhkang/cubetimer/solver/cfop3x3.js)
  3x3 CFOP 솔버 핵심 로직
- [solver/fmcSolver.js](/home/jhkang/cubetimer/solver/fmcSolver.js)
  FMC 스타일 탐색 로직
- [solver/roux3x3.js](/home/jhkang/cubetimer/solver/roux3x3.js)
  ROUX 기반 탐색 로직
- [solver/solver2x2.js](/home/jhkang/cubetimer/solver/solver2x2.js)
  2x2 솔버
- [solver/search.js](/home/jhkang/cubetimer/solver/search.js)
  탐색 공통 유틸리티
- [solver/moves.js](/home/jhkang/cubetimer/solver/moves.js)
  move 정의 및 변환 헬퍼
- [solver/state.js](/home/jhkang/cubetimer/solver/state.js)
  상태 표현 및 조작
- [solver/metrics.js](/home/jhkang/cubetimer/solver/metrics.js)
  성능/탐색 메트릭 수집
- [solver/llFamilyCalibration.js](/home/jhkang/cubetimer/solver/llFamilyCalibration.js)
  LL 계열 보정 데이터/보조 로직

### solver/solver3x3Phase/

- phase 기반 3x3 솔버용 상태/테이블/phase 구현이 분리되어 있습니다.

### vendor/

- `cubing` 관련 라이브러리
- 스크램블 생성/표시
- Comlink
- 기타 서드파티 정적 의존성

## 타이머 동작 개요

1. 사용자가 스페이스바를 누르거나 화면을 터치합니다.
2. 홀드 시간이 충족되면 타이머가 `ready` 상태로 바뀝니다.
3. 입력을 놓으면 측정이 시작됩니다.
4. 다시 입력하면 기록이 저장됩니다.
5. 저장 직후 통계, 최근 기록, 그래프, 스크램블 미리보기가 함께 갱신됩니다.

## 최근 기록과 통계

각 solve에는 다음 정보가 포함됩니다.

- 시간
- 이벤트
- 스크램블
- 생성 시각
- 페널티 상태 (`OK`, `+2`, `DNF`)

이 데이터를 바탕으로 다음 값을 계산합니다.

- 현재 세션 기준 `Best`
- 전체 평균 `Mean`
- 최근 5개 평균 `Ao5`
- 최근 12개 평균 `Ao12`

## 그래프

기록 그래프는 캔버스로 직접 그립니다.

- 단일 기록 라인
- Ao5 라인
- Ao12 라인
- 휠/버튼 기반 확대 축소
- 포인터 위치 기반 툴팁

모바일에서는 기본적으로 그래프를 감춘 상태로 시작할 수 있고, 사용자가 설정에서 다시 켤 수 있습니다.

## 스크램블과 미리보기

- 이벤트 선택 시 해당 이벤트용 스크램블을 생성합니다.
- 현재 스크램블은 텍스트와 2D 미리보기로 함께 표시됩니다.
- 이전/다음 스크램블 이동도 지원합니다.

## 솔버 개요

솔버는 메인 UI를 막지 않도록 워커에서 동작합니다.

- CFOP 기반 3x3 탐색
- FMC 스타일 해법 탐색
- ROUX 실험 모드
- 2x2 솔버
- 스타일/데이터셋 기반 후보 정렬
- 메트릭 수집 및 보고

탐색 모드와 F2L 스타일, cross 색상은 UI에서 바꿀 수 있으며 결과는 모달 내부에서 확인합니다.

## UI/UX 특징

- 글래스 스타일 카드 기반 레이아웃
- 라이트/다크 테마
- 강조색 프리셋
- 데스크톱/모바일 분기 레이아웃
- 기록 메뉴와 설정 모달의 반응형 버튼 디자인
- 모바일에서 정보 밀도를 유지하도록 카드 간격과 높이를 조정

## 개발 메모

- 이 프로젝트는 정적 HTML/CSS/JS 구조라서 빠르게 수정하고 바로 브라우저에서 확인하기 좋습니다.
- 상태 저장은 프런트엔드 로컬 저장소에 의존하므로, 브라우저 데이터를 지우면 세션/기록도 함께 초기화됩니다.
- UI 변경 시에는 데스크톱과 모바일, 라이트와 다크 모드를 같이 확인하는 편이 안전합니다.

## 문서와 참고 파일

- [ROUX_IMPLEMENTATION_REPORT.md](/home/jhkang/cubetimer/ROUX_IMPLEMENTATION_REPORT.md)
- [ROUX_PROGRESS.md](/home/jhkang/cubetimer/ROUX_PROGRESS.md)
- [ROUX_FINAL_REPORT.md](/home/jhkang/cubetimer/ROUX_FINAL_REPORT.md)

ROUX 관련 구현 경과나 성능/설계 메모는 위 문서들에 정리되어 있습니다.
