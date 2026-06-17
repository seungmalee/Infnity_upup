# 온라인 배포 방법

이 프로젝트는 Node 서버 하나가 `outputs/index.html`을 제공하고, 접속자 상태/채팅/공격 이벤트를 서버 메모리에서 동기화합니다.

## 로컬 실행

```powershell
node server.js
```

브라우저에서 엽니다.

```text
http://localhost:3000
```

## Render 배포

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New` -> `Web Service`를 선택합니다.
3. 저장소를 연결합니다.
4. 설정값:

```text
Build Command: npm install
Start Command: npm start
```

5. 배포가 끝나면 Render가 제공하는 `https://...onrender.com` 주소를 친구들에게 공유합니다.

## Railway 배포

1. Railway에서 새 프로젝트를 만듭니다.
2. GitHub 저장소를 연결합니다.
3. Start Command가 필요하면 아래 값을 사용합니다.

```text
npm start
```

## 현재 서버 특징

- 같은 서버 주소에 접속한 사람끼리 같은 맵에서 플레이합니다.
- 채팅, 랭킹, 층수, 킬, 목숨이 동기화됩니다.
- 서버가 재시작되면 접속자/채팅 상태는 초기화됩니다.
- 장기 운영을 하려면 다음 단계에서 Redis 또는 DB 저장소를 붙이면 됩니다.
