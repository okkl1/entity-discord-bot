import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SoulseekClient } from './soulseek-client.js';
import { resources } from '../resource-profile.js';
import { trackMemoryProcess } from '../runtime-memory.js';

export function soulseekChildEnvironment(env = process.env, compact = resources.compact) {
  if (!compact) return { ...env };
  // This is one of several processes sharing 488 MiB. .NET's container default
  // permits its GC heap alone to use 75% of that entire budget.
  const defaults = { DOTNET_gcServer: '0', DOTNET_GCConserveMemory: '3' };
  if (!env.DOTNET_GCHeapHardLimit && !env.DOTNET_GCHeapHardLimitPercent)
    defaults.DOTNET_GCHeapHardLimit = '0xA000000'; // 160 MiB, hexadecimal as required by .NET.
  return { ...defaults, ...env };
}

export const losslessRoot = fileURLToPath(new URL('../../data/lossless/', import.meta.url));
const execute = promisify(execFile);
export function detectSoulseekLoginFailure(log) {
  const text = String(log).toLowerCase();
  const denied = text.lastIndexOf('invalid username or password'), duplicate = text.lastIndexOf('another client logged in using the same username');
  const success = Math.max(text.lastIndexOf('logged in to the soulseek server'), text.lastIndexOf('login succeeded'));
  if (Math.max(denied, duplicate) <= success) return null;
  if (denied > duplicate) return 'Soulseek가 사용자 이름 또는 비밀번호를 거절했습니다. 엔티티 폴더의 무손실음악 설정.cmd에서 Soulseek 계정을 다시 입력하고 봇을 재시작해주세요.';
  if (duplicate >= 0) return '같은 Soulseek 계정이 다른 프로그램에서 로그인되어 연결이 끊겼습니다. Soulseek Qt의 로그인을 종료한 뒤 봇을 재시작해주세요.';
  return null;
}
async function loginFailureSince(path, offset) {
  let handle;
  try {
    handle = await open(path, 'r'); const { size } = await handle.stat();
    const start = Math.max(offset, size - 64 * 1024), buffer = Buffer.alloc(Math.max(0, size - start));
    await handle.read(buffer, 0, buffer.length, start);
    return detectSoulseekLoginFailure(buffer.toString('utf8'));
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
export function createSoulseekRuntime({ root = losslessRoot, settingsFile = join(root, 'settings.json'),
  executable = process.env.SLSKD_EXECUTABLE || (process.platform === 'win32'
    ? fileURLToPath(new URL('../../bin/slskd/slskd.exe', import.meta.url)) : '/opt/slskd/slskd'),
  noConnect = false, credentials = process.env } = {}) {
  let starting, child, client, stopping = false, exitHandler, suspending;
  const plannedStops = new WeakSet();
  const cacheRoot = join(root, 'cache');
  async function stopChild() {
    client?.close(); client = null;
    const launched = child; child = null;
    if (launched && launched.exitCode === null && launched.signalCode === null) {
      plannedStops.add(launched);
      await new Promise((resolve, reject) => {
        let timer;
        const done = () => { clearTimeout(timer); resolve(); };
        launched.once('close', done);
        timer = setTimeout(() => {
          launched.kill('SIGKILL');
          timer = setTimeout(() => { launched.off('close', done); reject(new Error('Soulseek 연결 프로그램 종료가 지연되고 있습니다.')); }, 1000);
        }, 4000);
        launched.kill();
      });
    }
    if (exitHandler) { process.removeListener('exit', exitHandler); exitHandler = null; }
    await writeFile(join(root, 'slskd', 'slskd.yml'), '{}').catch(() => {});
  }
  async function settings() {
    // Northflank runtime variables never enter the git repository or image layers.
    // On Windows, the original local DPAPI settings file remains supported.
    if (credentials.SOULSEEK_USERNAME || credentials.SOULSEEK_PASSWORD) {
      if (!credentials.SOULSEEK_USERNAME || !credentials.SOULSEEK_PASSWORD) {
        throw new Error('SOULSEEK_USERNAME과 SOULSEEK_PASSWORD 환경변수 모두 설정해야 합니다.');
      }
      return { username: credentials.SOULSEEK_USERNAME, password: credentials.SOULSEEK_PASSWORD };
    }
    try { return JSON.parse((await readFile(settingsFile, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (e) { if (e.code === 'ENOENT') return null;
      throw new Error('무손실 음악 설정 파일을 읽지 못했습니다.', { cause: e }); }
  }
  return { cacheRoot,
    async configured() { const value = await settings(); return Boolean(value?.username && (value?.password || value?.passwordProtected)); },
    async start() {
      if (suspending) await suspending;
      if (stopping) throw new Error('Soulseek 연결 프로그램을 종료하고 있습니다.');
      if (client) return client;
      if (starting) return starting;
      starting = (async () => {
        const value = await settings();
        if (!value?.username || (!value.password && !value.passwordProtected)) throw new Error('Soulseek 계정을 설정해주세요. Northflank에서는 SOULSEEK_USERNAME / SOULSEEK_PASSWORD 런타임 변수가 필요합니다.');
        if (value.passwordProtected) {
          if (process.platform !== 'win32') throw new Error('Windows 전용 보호 암호는 Linux에서 복호화할 수 없습니다. SOULSEEK_USERNAME과 SOULSEEK_PASSWORD를 지정해주세요.');
          try {
            const powerEnv = { ...process.env, ENTITY_SLSK_SETTINGS: settingsFile };
            // PowerShell 7's inherited module path breaks Windows PowerShell 5's DPAPI cmdlets.
            for (const key of Object.keys(powerEnv)) if (key.toLowerCase() === 'psmodulepath') delete powerEnv[key];
            const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
              "$ErrorActionPreference = 'Stop'; $v = Get-Content -LiteralPath $env:ENTITY_SLSK_SETTINGS -Raw | ConvertFrom-Json; $s = ConvertTo-SecureString $v.passwordProtected; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write([Net.NetworkCredential]::new('', $s).Password)"],
              { windowsHide: true, timeout: 10_000, env: powerEnv });
            value.password = stdout;
          } catch { throw new Error('이 Windows 계정에서 암호를 읽지 못했습니다. 무손실음악 설정.cmd를 다시 실행해주세요.'); }
        }
        if (stopping) throw new Error('Soulseek 연결 프로그램을 종료하고 있습니다.');
        const appRoot = resolve(root, 'slskd');
        await mkdir(appRoot, { recursive: true });
        await mkdir(join(cacheRoot, 'incomplete'), { recursive: true }); await mkdir(join(cacheRoot, 'complete'), { recursive: true });
        const apiKey = randomBytes(32).toString('hex'), port = 5038;
        const config = { headless: true, no_version_check: true, no_share_scan: true, no_connect: noConnect,
          web: { port, ip_address: '127.0.0.1', https: { disabled: true }, authentication: {
            username: 'entity', password: randomBytes(24).toString('hex'), api_keys: { entity: { key: apiKey, role: 'readwrite', cidr: '127.0.0.1/32' } } } },
          soulseek: { username: value.username, password: value.password, listen_port: 2235,
            ...(resources.compact ? { distributed_network: { disable_children: true } } : {}) },
          directories: { incomplete: join(cacheRoot, 'incomplete'), downloads: join(cacheRoot, 'complete') },
          transfers: { download: { retry: { attempts: 2 }, destination: { exists: 'overwrite' } } },
          retention: { search: 5, files: { complete: 120, incomplete: 120 } },
          logger: { no_disk: true } };
        const configPath = join(appRoot, 'slskd.yml');
        await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
        const logPath = join(appRoot, 'runtime.log'), log = await open(logPath, 'a'), logOffset = (await log.stat()).size;
        try {
          child = spawn(executable, ['--app-dir', appRoot, '--config', configPath],
            { cwd: appRoot, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: soulseekChildEnvironment() });
        } finally { await log.close(); }
        let launchError; child.on('error', error => { launchError = error; });
        const launched = child;
        const untrack = trackMemoryProcess('soulseek', launched.pid);
        launched.once('exit', (code, signal) => {
          untrack();
          if (!stopping && !plannedStops.has(launched)) console.warn(`[soulseek] process exited: code=${code}, signal=${signal || 'none'}`);
        });
        console.log(`[soulseek] native=${process.env.ENTITY_SLSKD_BUILD || 'external'} memoryProfile=${resources.compact ? 'compact' : 'standard'}`);
        exitHandler = () => { launched.kill(); try { writeFileSync(configPath, '{}'); } catch {} };
        process.once('exit', exitHandler);
        const parentExitHandler = exitHandler;
        launched.once('exit', () => {
          if (child === launched) { client?.close(); client = null; child = null; }
          process.removeListener('exit', parentExitHandler);
          if (exitHandler === parentExitHandler) exitHandler = null;
        });
        const candidate = new SoulseekClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey, loginFailure: () => loginFailureSince(logPath, logOffset) });
        for (let i = 0; i < 60; i++) {
          if (stopping || launchError || launched.exitCode !== null || launched.signalCode !== null) break;
          try { await candidate.request('/application', { timeoutMs: 1000 }); client = candidate; return client; } catch {}
          await delay(500);
        }
        child?.kill(); child = null; candidate.close();
        if (exitHandler) process.removeListener('exit', exitHandler); exitHandler = null;
        await writeFile(configPath, '{}').catch(() => {});
        throw new Error('Soulseek 연결 프로그램이 시작되지 않았습니다. Linux slskd 실행 파일 및 5038 포트를 확인해주세요.');
      })();
      try { return await starting; } finally { starting = null; }
    },
    async suspend() {
      if (stopping) return;
      if (!suspending) suspending = (async () => { await starting?.catch(() => {}); await stopChild(); console.log('[soulseek] idle: stopped unused native process'); })();
      try { await suspending; } finally { suspending = null; }
    },
    async close() { stopping = true; await suspending?.catch(() => {}); await starting?.catch(() => {}); await stopChild(); },
  };
}
