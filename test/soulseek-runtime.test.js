import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSoulseekRuntime, detectSoulseekLoginFailure } from '../src/web/soulseek-runtime.js';

test('login diagnostics describe rejected credentials or duplicate login without exposing raw log contents', () => {
  assert.equal(detectSoulseekLoginFailure('startup: private username'), null);
  const denied = detectSoulseekLoginFailure('private credentials\nDisconnected from the Soulseek server: invalid username or password');
  assert.match(denied, /사용자 이름 또는 비밀번호/); assert.doesNotMatch(denied, /private credentials/);
  assert.match(detectSoulseekLoginFailure('another client logged in using the same username'), /Soulseek Qt/);
  assert.equal(detectSoulseekLoginFailure('invalid username or password\nLogged in to the Soulseek server'), null);
});

test('bundled Windows runtime decrypts local settings, serves only localhost and stops without retaining a password', { timeout: 60_000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows self-contained runtime');
  const executable = new URL('../bin/slskd/slskd.exe', import.meta.url);
  try { await access(executable); } catch { return t.skip('slskd binary is not installed'); }
  const root = await mkdtemp(join(tmpdir(), 'entity-slskd-test-')), settingsFile = join(root, 'settings.json');
  const runtime = createSoulseekRuntime({ root, settingsFile, noConnect: true });
  try {
    const powerEnv = { ...process.env, ENTITY_TEST_SETTINGS: settingsFile };
    for (const key of Object.keys(powerEnv)) if (key.toLowerCase() === 'psmodulepath') delete powerEnv[key];
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; $s = ConvertTo-SecureString 'offline-test-only' -AsPlainText -Force; $v = @{username='offline-entity-test'; passwordProtected=(ConvertFrom-SecureString $s)}; [IO.File]::WriteAllText($env:ENTITY_TEST_SETTINGS, ($v | ConvertTo-Json), [Text.UTF8Encoding]::new($false))"],
      { windowsHide: true, env: powerEnv });
    assert.equal(await runtime.configured(), true);
    assert.doesNotMatch(await readFile(settingsFile, 'utf8'), /offline-test-only/);
    const client = await runtime.start(); assert.ok(await client.request('/application'));
    const unsubscribe = await client.searchEvents.subscribe('offline-hub-test', () => {});
    assert.equal(typeof unsubscribe, 'function', 'the bundled SignalR hub accepts the local API key and JSON handshake'); unsubscribe();
    const config = JSON.parse(await readFile(join(root, 'slskd', 'slskd.yml'), 'utf8'));
    assert.equal(config.soulseek.password, 'offline-test-only'); assert.equal(config.no_connect, true);
    assert.equal(config.web.ip_address, '127.0.0.1');
    assert.equal(config.web.authentication.api_keys.entity.cidr, '127.0.0.1/32');
    await runtime.close();
    assert.equal(await readFile(join(root, 'slskd', 'slskd.yml'), 'utf8'), '{}');
    await assert.rejects(fetch('http://127.0.0.1:5038/api/v0/application', { signal: AbortSignal.timeout(2000) }));
  } catch (error) {
    const log = await readFile(join(root, 'slskd', 'runtime.log'), 'utf8').catch(() => 'No runtime log');
    throw new Error(`Offline runtime test failed: ${log.slice(-6000)}`, { cause: error });
  } finally {
    await runtime.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('entity-slskd-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
