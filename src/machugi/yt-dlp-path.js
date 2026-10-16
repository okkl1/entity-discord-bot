import { existsSync } from "node:fs"

// Copied .env files can point to a checkout that was moved or removed.
export function resolveYtDlpPath(configured, bundled, exists = existsSync) {
  if (configured && exists(configured)) return configured
  if (exists(bundled)) return bundled
  throw new Error("yt-dlp.exe를 찾을 수 없습니다. 봇의 bin 폴더 또는 YT_DLP_PATH 설정을 확인하세요.")
}
