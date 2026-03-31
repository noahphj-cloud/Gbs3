# 온라인/오프라인 게임 모음 배포본

## 포함된 기능
- 오프라인 플레이 유지
- 온라인 자동 매칭
- 서버 기준 턴 동기화
- 게임 중 채팅
- 에어하키 오프라인 전용 표시

## 온라인 지원 게임
- 축고정 사목
- 오목
- 콰리도
- 점과 상자

## 프로젝트 구조
- `server.js`: 매칭, SSE 이벤트, 채팅, 정적 파일 서빙
- `public/index.html`: 게임 UI와 기존 게임 로직
- `public/client.js`: 온라인 매칭/채팅/턴 처리 클라이언트
- `package.json`: 배포용 실행 설정
- `render.yaml`: Render 배포용 설정 예시

## 로컬 실행 방법
```bash
npm start
```
그 다음 브라우저에서 `http://localhost:3000` 접속

## 공개 배포 방법
### Render
1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 새 Web Service를 만듭니다.
3. 저장소를 연결합니다.
4. Start Command를 `node server.js`로 설정합니다.
5. 배포가 끝나면 Render가 공개 URL을 발급합니다.

### Railway
1. 저장소를 GitHub에 올립니다.
2. Railway에서 New Project -> Deploy from GitHub Repo 선택
3. 시작 명령을 `node server.js`로 맞춥니다.
4. 배포 후 발급된 도메인으로 접속합니다.

## 주의
- 현재 서버는 메모리 기반 매칭 서버입니다. 서버가 재시작되면 대기열/방 정보는 초기화됩니다.
- 브로커스, 오비토, 할마 계열 온라인화는 아직 미완성입니다.
- 장기 운영용으로는 방 만료 처리, 재접속 처리, 에러 로그, 보안 보완이 추가되면 좋습니다.
