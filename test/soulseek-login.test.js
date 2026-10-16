import test from 'node:test';
import assert from 'node:assert/strict';
import { SoulseekClient } from '../src/web/soulseek-client.js';

test('a timed-out peer lookup is identified as a transfer failure and never replays its enqueue', async () => {
  let calls = 0;
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test', searchEvents: false,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify('System.TimeoutException: GetUserEndPointInternalAsync private user'), { status: 500 }); } });
  try {
    await assert.rejects(client.enqueue({ username: 'peer', filename: 'song.flac', size: 1024 }, 'batch'), error => {
      assert.equal(error.kind, 'peer_timeout'); assert.match(error.message, /공유자의 연결 확인/); assert.doesNotMatch(error.message, /검색해주세요|private|로그인/); return true;
    }); assert.equal(calls, 1);
  } finally { client.close(); }
});

test('a rejected Soulseek login fails promptly with a helpful message and allows a later retry', async () => {
  let loggedIn = false; const calls = [];
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test-key', searchMs: 1, searchEvents: false,
    loginFailure: async () => 'Soulseek가 사용자 이름 또는 비밀번호를 거절했습니다.',
    fetchImpl: async (url, options) => { calls.push({ url, method: options.method }); return new Response(JSON.stringify(url.endsWith('/server') ? { isLoggedIn: loggedIn } : url.endsWith('/responses') ? [] : { endedAt: 'now' })); } });
  try {
    await assert.rejects(client.search('가수 노래'), /비밀번호를 거절/);
    assert.equal(calls.some(c => c.method === 'POST'), false); assert.equal(client.searching, null);
    loggedIn = true; assert.deepEqual(await client.search('가수 노래'), []);
    assert.equal(calls.some(c => c.method === 'POST'), true);
  } finally { client.close(); }
});

test('malformed slskd responses cannot surface raw HTML or JSON syntax errors', async () => {
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test-key', fetchImpl: async () => new Response('<!DOCTYPE html>private error page') });
  try { await assert.rejects(client.request('/server'), error => { assert.match(error.message, /응답을 읽지/); assert.doesNotMatch(error.message, /DOCTYPE|private|Unexpected/); return true; }); }
  finally { client.close(); }
});

test('internal errors identify search database failures without exposing exception data or blaming an account', async () => {
  for (const body of [JSON.stringify('DbUpdateConcurrencyException: private username and path'),
    JSON.stringify({ detail: 'The database operation was expected to affect 1 row(s), but actually affected 0 row(s). private password' })]) {
    const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test', fetchImpl: async () => new Response(body, { status: 500 }) });
    try { await assert.rejects(client.request('/searches', { method: 'POST' }), error => {
      assert.equal(error.status, 500); assert.equal(error.kind, 'search_database'); assert.match(error.message, /검색 기록.*충돌/);
      assert.doesNotMatch(error.message, /private|password|username|DbUpdateConcurrencyException|계정/); return true;
    }); } finally { client.close(); }
  }
});

test('unknown HTML 500 failures remain safe service errors and transient search reads retry once', async () => {
  let calls = 0, sleeps = 0;
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test', sleep: async () => { sleeps++; },
    fetchImpl: async () => ++calls === 1 ? new Response('<!DOCTYPE html>private account details', { status: 500 }) : new Response('{"endedAt":"now"}') });
  try { assert.deepEqual(await client.request('/searches/test'), { endedAt: 'now' }); assert.equal(calls, 2); assert.equal(sleeps, 1); }
  finally { client.close(); }
  let posts = 0;
  const failing = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test',
    fetchImpl: async () => { posts++; return new Response('<!DOCTYPE html>private password', { status: 500 }); } });
  try { await assert.rejects(failing.request('/searches', { method: 'POST' }), error => {
    assert.equal(error.status, 500); assert.match(error.message, /내부 오류/); assert.doesNotMatch(error.message, /private|DOCTYPE|password|계정|상대방/); return true;
  }); assert.equal(posts, 1); }
  finally { failing.close(); }
});

test('repeated read failures stop after one retry and cancellation interrupts the retry delay', async () => {
  let calls = 0;
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test', sleep: async () => {},
    fetchImpl: async () => { calls++; return new Response('timeout waiting for remote peer', { status: 500 }); } });
  try { await assert.rejects(client.request('/searches/test/responses'), /내부 오류/); assert.equal(calls, 2); }
  finally { client.close(); }
  const controller = new AbortController();
  const cancelled = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test',
    sleep: async (ms, value, { signal }) => { controller.abort(); signal.throwIfAborted(); },
    fetchImpl: async () => new Response('temporary error', { status: 500 }) });
  try { await assert.rejects(cancelled.request('/searches/test', { signal: controller.signal }), { name: 'AbortError' }); }
  finally { cancelled.close(); }
});
