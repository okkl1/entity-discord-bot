# 엔티티 Northflank 배포용 (원본 기능 보존 기반, Linux 호환 실험판)

2026-10-16 v3.1 수정사항과 적용 방법은 [배포_수정_안내.md](배포_수정_안내.md)를 먼저 확인하세요. GitHub 웹 업로드용 묶음은 64개 파일이며, 실행 버전을 `/api/health`와 시작 로그에서 확인할 수 있습니다. v3의 메모리 절약 및 v2의 검색·정지 수정도 포함합니다.

`봇.zip`의 원본 기능 소스(피어 재시도 로직 포함)를 기반으로 Linux용 slskd 실행 및 런타임 인증을 추가했습니다. 웹 업로드용 ZIP에는 실행에 필요한 파일을 포함하고, 테스트 코드는 로컬 작업 폴더에 보관합니다. **외부 클라우드에 실제 배포하거나 Soulseek 로그인/음원 다운로드를 실사용 검증한 것은 아닙니다.**

## GitHub 업로드

1. ZIP 압축을 풀고, `Dockerfile`, `package.json`, `package-lock.json`, `src/`, `bin/`가 저장소 맨 위에 오도록 GitHub **Private** 저장소에 업로드하세요.
2. `.env`/`settings.json`/`.auth.json`/`봇.zip`/원본 `data/` 및 계정정보는 올리지 않습니다. 보안상 비공개 저장소여도 비밀정보 커밋은 금지입니다.
3. Northflank 프로젝트 → `Create service` → `Combined` → GitHub 저장소 `main` 연결.
4. Build: `Dockerfile`; Dockerfile path `/Dockerfile`, build context `/`.
5. Runtime variables에 필수 5개 입력: `DISCORD_TOKEN`, `MACHUGI_TYPESENSE_HOST`, `MACHUGI_TYPESENSE_API_KEY`, `MACHUGI_FIREBASE_API_KEY`, `MACHUGI_FIREBASE_PROJECT_ID`.
6. 무손실 음악을 쓰려면 추가: `SOULSEEK_USERNAME`, `SOULSEEK_PASSWORD`. Windows DPAPI 보호 문자열이 아닌 **실제 Soulseek 계정 비밀번호**를 런타임 변수에 입력해야 합니다. `.env`/코드/로그에 쓰지 마세요.
7. Networking: HTTP public port `3000`, `WEB_PUBLIC_URL`은 배포 후 실제 발급된 `https://....code.run` 주소. 변경 후 재배포.
8. Resources: 서비스 인스턴스 `1`, 무료 Sandbox 허용 리소스 선택. 별도 포트 5038은 절대로 공개하지 않습니다.
9. 치지직 `/인증` 쿠키 저장은 `/app/data/chzzk/.auth.json`으로 이동했습니다. 환경변수 `LOSSLESS_MIN_FREE_MB=256`을 사용해 2GiB 안팎의 임시 저장공간을 고려했습니다. 음악 캐시는 컨테이너 교체 시 유실될 수 있습니다. 영구 보존이 필요하면 데이터 볼륨을 **`/app/data`에** 마운트하고 실제 비용과 권한을 확인하세요.
10. 서비스 실행 로그의 디스코드 로그인/슬래시 명령 등록을 확인하고 디스코드에서 퀴즈, 라디오, 웹방, 무손실 음악을 각자 시험하세요.
11. PC에서 기존 봇을 끄세요. 동일 Discord 토큰 및 Soulseek 계정을 PC와 Northflank에서 중복 실행하지 마세요.

## 주의
- Linux `slskd`는 공식 `ghcr.io/slskd/slskd:0.26.0` 이미지에서 가져옵니다. Northflank 빌드가 해당 레지스트리에 접근할 수 있어야 합니다.
- slskd API 포트 `5038`은 컨테이너 내부 루프백(127.0.0.1)에만 바인딩합니다. Northflank 외부 공개는 웹방의 HTTP 3000뿐입니다.
- Soulseek 피어 연결에는 일반 HTTP 이외의 TCP 통신이 필요할 수 있습니다. Northflank의 일반 공개 포트는 HTTP/HTTP2만 지원하므로 **일부 Soulseek 연결·다운로드는 실패할 수 있습니다.**
- 저장소/메모리 제한과 외부 스트리밍 제공업체 사정에 따라 동작이 제한될 수 있습니다.
- 유료 Persistent Volume을 붙이거나 유료 compute로 전환하면 과금됩니다. 무료 자원을 먼저 확인하세요.
- Windows 전용 브라우저 핫키, 로컬 프로그램 실행 .cmd/.ps1은 Northflank 환경에서 실행되지 않습니다.
- FFmpeg/yt-dlp가 포함되어도 YouTube 접속 제한·재생 실패가 가능하며 이 환경에서는 실제 재생은 확인하지 못했습니다.
- 외부에서 받은 파일을 재생하거나 공유할 때 이용권한과 저작권을 확인하세요.

## 로컬 코드 테스트

Node.js 22에서 `npm ci` 이후 `npm test`로 테스트합니다. 실제 Docker build와 외부 서비스 연동 테스트는 별도 환경에서 검증하세요.
