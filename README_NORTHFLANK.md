# 엔티티 디스코드 봇 — Northflank 배포 안내

이 압축파일은 업로드된 Windows용 원본에서 **소스 코드만 추려 안전하게 정리한 클라우드 배포본**입니다.
원본에 들어 있던 `.env`, 치지직 인증파일, 개인 설정, 데이터베이스, Windows `.exe`, `node_modules`는 포함하지 않았습니다.
개발 언어는 **Node.js 22 (JavaScript)** 이며, 실행 명령은 `npm start` = `node src/index.js`입니다.

## 1. GitHub 비공개 저장소 만들기
1. 이 ZIP을 PC에서 압축 해제합니다. **ZIP만 GitHub에 올리면 실행되지 않습니다.**
2. github.com -> New repository -> `entity-discord-bot` -> Private -> Create.
3. 압축 해제한 폴더의 파일과 하위 폴더들을 그대로 업로드합니다. `Dockerfile`, `package.json`, `package-lock.json`, `src`가 저장소 최상위에 있어야 합니다.
4. `.env`나 원본 `엔티티.zip`은 절대로 GitHub에 올리지 않습니다.

## 2. Northflank
1. northflank.com에서 가입하고 Developer Sandbox 무료 플랜을 선택합니다. 신용카드 등 **결제수단 등록이 필요**합니다. 유료 자원 선택 금지 및 결제 설정/알림 확인.
2. 프로젝트 생성 (Create project).
3. `Create service` → `Combined service` 선택 후 GitHub 연결, 위 Private 저장소와 `main` 브랜치를 고릅니다.
4. Build options: `Dockerfile`, 경로 `Dockerfile`(저장소 루트).
5. Resources: 무료 플랜에서 선택 가능한 자원 중 하나, instances = 1. 오토스케일 불필요.
6. Networking: 웹방이 필요하면 port `3000`을 **Public HTTP**로 노출. 웹방이 필요 없다면 WEB_ENABLED=0으로 설정하고 공개 포트를 생략해도 됩니다.
7. Environment variables → **runtime** 변수에 아래 5개 실제 값을 PC에 있는 원본 `.env`에서 복사하여 입력합니다. 값을 GitHub에 기록하지 않습니다.
    - DISCORD_TOKEN
    - MACHUGI_TYPESENSE_HOST
    - MACHUGI_TYPESENSE_API_KEY
    - MACHUGI_FIREBASE_API_KEY
    - MACHUGI_FIREBASE_PROJECT_ID
8. 선택 항목: DISCORD_GUILD_ID, NID_AUT, NID_SES, PRICE_SYMBOL.
9. 웹방 사용 시: WEB_ENABLED=1, WEB_HOST=0.0.0.0, WEB_PORT=3000, WEB_TUNNEL=0.
10. 배포 후 Northflank의 Public HTTPS 도메인이 생기면 `WEB_PUBLIC_URL=https://생성된주소`를 runtime 변수에 추가하고 재배포합니다. 끝의 슬래시는 넣지 않습니다.
11. 배포 로그에 `통합 봇 로그인` 및 `슬래시 명령 등록 완료`가 보이면 Discord에서 `@봇 ping`, `/price` 등을 테스트합니다.
12. 로컬 PC에서 동일한 Discord 토큰으로 구동 중인 봇은 끕니다 (중복 실행 방지).

## 기능별 제약 / 경고
- **지원 대상으로 준비한 기능:** Discord 메시지·슬래시명령·가격 상태, 기본 웹방, yt-dlp/FFmpeg 기반 음성 퀴즈/라디오 **실행 환경**. 실 배포/외부 API/음성 재생의 동작까지 이곳에서 검증한 것은 아닙니다.
- **무손실 FLAC(Soulseek) 기능은 미지원:** 원본은 Windows `slskd.exe`, `powershell.exe`, Windows DPAPI 암호를 사용합니다. 이 배포본에는 Windows 프로그램이나 원본 계정정보가 없으므로 현재 상태에서 정상 동작하지 않습니다. Linux용 slskd 설치 및 인증/스토리지 로직 수정이 따로 필요합니다.
- `bin/cloudflared.exe`도 Windows 전용이므로 사용하지 않습니다. Northflank 공개 HTTP 포트와 WEB_PUBLIC_URL을 사용합니다.
- Linux용 yt-dlp를 이미지 빌드 중 별도 설치합니다. 유튜브의 데이터센터 접속 제한이나 API 변화로 일부 영상 재생에 실패할 수 있습니다.
- 디스코드 토큰/치지직 쿠키가 들어 있던 **원본 ZIP을 외부 공개하거나 GitHub에 올렸다면** 디스코드 토큰, 네이버 로그인 쿠키 등 즉시 재발급/폐기 후 재설정하세요.
- 무료 Sandbox의 CPU/RAM 한도 내에서만 작동합니다. 퀴즈 음성 인코딩과 웹방, 동시 유저, 오디오 캐시가 많으면 자원 부족으로 재시작될 수 있습니다. 상시 가동을 절대 보장하지 않습니다.
- Northflank 컨테이너의 일반 데이터 파일은 교체/재시작 때 지워질 수 있습니다. 설정된 `/symbol` 종목/쿠키/캐시의 영속 보존은 별도 저장소 구성이 필요합니다. **영구 볼륨은 유료일 수 있으니 요금 확인**이 우선입니다.

## 필수 설정 참고
자세한 변수 이름은 `.env.example`에 있습니다. 원본 `.env`의 비밀 값은 배포 ZIP에 들어 있지 않습니다.
