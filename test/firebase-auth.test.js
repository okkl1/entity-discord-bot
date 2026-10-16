import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FirebaseAuth } from '../src/machugi/firebase-auth.js';

const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const token = { idToken: 'fixture-id-token', refreshToken: 'fixture-refresh-token', expiresIn: '3600' };

test('fifty concurrent question requests share a single Firebase authentication request', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const auth = new FirebaseAuth({ fetchImpl: async () => { calls++; await gate; return response(token); } });
  const requests = Array.from({ length: 50 }, () => auth.getToken('fixture-key'));
  assert.equal(calls, 1); release();
  assert.deepEqual(new Set(await Promise.all(requests)), new Set(['fixture-id-token']));
  assert.equal(await auth.getToken('fixture-key'), 'fixture-id-token');
  assert.equal(calls, 1);
});

test('saved anonymous credentials survive restarts and refresh without creating a new account', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'entity-auth-test-'));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'auth.json');
  let clock = 1000, calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.includes('securetoken')) {
      assert.equal(options.body.get('refresh_token'), 'fixture-refresh-token');
      return response({ id_token: 'refreshed-token', refresh_token: 'fixture-refresh-token', expires_in: '3600' });
    }
    return response(token);
  };
  assert.equal(await new FirebaseAuth({ fetchImpl, now: () => clock, cacheFile: file }).getToken('fixture-key'), token.idToken);
  assert.equal(await new FirebaseAuth({ fetchImpl, now: () => clock, cacheFile: file }).getToken('fixture-key'), token.idToken);
  assert.equal(calls.length, 1);
  clock += 3_550_000;
  assert.equal(await new FirebaseAuth({ fetchImpl, now: () => clock, cacheFile: file }).getToken('fixture-key'), 'refreshed-token');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /securetoken/);
  assert.doesNotMatch(await readFile(file, 'utf8'), /fixture-key/);
});

test('service throttling propagates clearly and repeated starts do not hammer authentication', async () => {
  let calls = 0;
  const auth = new FirebaseAuth({ fetchImpl: async () => { calls++; return response({ error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } }, 400); } });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => auth.getToken('fixture-key')));
  assert.ok(results.every(r => r.status === 'rejected' && /일시적으로 제한/.test(r.reason.message)));
  await assert.rejects(auth.getToken('fixture-key'), /일시적으로 제한/);
  assert.equal(calls, 1);
});
