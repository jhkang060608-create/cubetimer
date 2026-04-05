# CubeTimer

웹 기반 큐브 타이머 (스크램블 + 2D 전개도 미리보기 + 세션 + 통계 + 그래프)
이 프로그램은 OpenAI의 GPT-5.2 Codex로 만들어졌습니다.

## 실행
정적 파일만 사용합니다. 로컬 서버로 열어주세요.

```bash
python3 -m http.server 5173
```

브라우저에서 `http://localhost:5173` 접속.

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
