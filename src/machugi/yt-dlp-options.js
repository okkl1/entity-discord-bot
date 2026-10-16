import { copyFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cookieCopies = new Map();
process.once('exit', () => {
  for (const { directory } of cookieCopies.values()) {
    try { rmSync(directory, { recursive: true, force: true }); } catch {}
  }
});

// yt-dlp updates its cookie jar. Keep a runtime copy so mounted secrets can be read-only.
function writableCookieCopy(source) {
  if (cookieCopies.has(source)) return cookieCopies.get(source).path;
  const directory = mkdtempSync(join(tmpdir(), 'entity-ytdlp-'));
  const path = join(directory, 'cookies.txt');
  try {
    chmodSync(directory, 0o700);
    copyFileSync(source, path);
    chmodSync(path, 0o600);
    cookieCopies.set(source, { directory, path });
    return path;
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('유튜브 쿠키 파일을 읽지 못했습니다. YT_DLP_COOKIES_FILE과 파일 읽기 권한을 확인해주세요.');
  }
}

export function ytDlpOptions({ env = process.env, nodePath = process.execPath } = {}) {
  return ['--ignore-config', '--js-runtimes', `node:${nodePath}`,
    ...(env.YT_DLP_COOKIES_FILE ? ['--cookies', writableCookieCopy(env.YT_DLP_COOKIES_FILE)] : [])];
}

export function youtubeFailure(error) {
  if (error?.code === 'YOUTUBE_AUTH_REQUIRED') return error;
  const details = String(error?.stderr || error?.message || '');
  if (!/sign in to confirm you.re not a bot|login required|authentication required/i.test(details)) return null;
  return Object.assign(new Error('서버의 유튜브 요청에 로그인 확인이 필요합니다. 관리자에게 YT_DLP_COOKIES_FILE 설정을 요청해주세요. 쿠키 설정 후에도 서버 접속 제한이 계속될 수 있습니다.'),
    { code: 'YOUTUBE_AUTH_REQUIRED' });
}
