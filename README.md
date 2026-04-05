# CubeTimer

웹 기반 큐브 타이머 (스크램블 + 3D 미리보기 + 세션 + 통계)

## 실행
정적 파일만 사용합니다. 로컬 서버로 열어주세요.

```bash
python3 -m http.server 5173
```

브라우저에서 `http://localhost:5173` 접속.

## 기능
- 스크램블 생성 + 2D 전개도 미리보기
- 세션 관리 (추가/이름 변경/삭제)
- 기록 저장 (localStorage)
- 패널티 적용 (`+2`, `DNF`)
- 기록 수정/삭제
- 기록 내보내기 (팝업 텍스트)
- 통계: Best, 평균, ao5, ao12
- 종목 선택 (2x2~7x7, OH, BLD, Clock, Minx, Pyraminx, Skewb, SQ-1)
- 매 솔브 완료 시 자동 스크램블 갱신

## 키보드
- `Space`: 0.5초 홀드 후 시작 / 정지
- `R`: 리셋

## 스크램블/미리보기 구현
- 스크램블: `cubing.js`의 `randomScrambleForEvent("eventId")`
- 미리보기: `scramble-display` 웹 컴포넌트 (2D 전개도)
  - `vendor/`에 로컬로 포함되어 CDN 없이 동작합니다.

> 참고: 공식 TNoodle(=WCA 공식 스크램블 프로그램)은 Java 기반입니다. 현재 프로젝트는 브라우저에서 바로 동작하도록 `cubing.js` 기반 스크램블을 사용합니다. 필요하면 TNoodle 서버 연동/빌드로 교체 가능합니다.

## 라이선스
`scramble-display`가 GPL-3.0 라이선스이므로, 본 프로젝트도 GPL-3.0으로 배포합니다.
