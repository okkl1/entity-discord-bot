import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function startPublicTunnel(localUrl, { timeoutMs = 45_000 } = {}) {
  const executable = fileURLToPath(new URL('../../bin/cloudflared.exe', import.meta.url));
  if (!existsSync(executable)) throw new Error('bin/cloudflared.exe가 없습니다. 공개 주소 도구를 복원해주세요.');
  const child = spawn(executable, ['tunnel', '--no-autoupdate', '--url', localUrl],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let closing = false;
  const ready = new Promise((resolve, reject) => {
    let buffer = '', done = false;
    const finish = (error, url) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(url); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('공개 주소 연결 시간 초과. 인터넷 연결을 확인해주세요.')); }, timeoutMs);
    const onData = chunk => {
      buffer = (buffer + chunk.toString()).slice(-12_000);
      const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (url) finish(null, url[0]);
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (!done) finish(new Error(`공개 주소 연결 실패 (${code}).`));
      else if (!closing) console.warn('[web] 공개 주소 연결이 종료되었습니다. 봇을 재시작하면 새 주소를 만들 수 있습니다.');
    });
  });
  return { ready, close: () => { closing = true; child.kill(); } };
}
