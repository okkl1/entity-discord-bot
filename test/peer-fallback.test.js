import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerFallback } from '../src/web/peer-fallback.js';

const video = { artist: 'Artist', track: 'Song', duration: 200 };
const pick = { id: 'first', username: 'offline', filename: 'Artist\\Song.flac', title: 'Song', duration: 200,
  bitDepth: 24, sampleRate: 96000, freeSlot: true, recording: video, waitForComplete: true };
const unavailable = Object.assign(new Error('peer endpoint timeout'), { kind: 'peer_timeout' });
const peer = (username, patch = {}) => ({ ...pick, id: username, username, ...patch });

test('peer fallback preserves artist, recording version and quality and tries at most three different peers', async () => {
  const fallback = createPeerFallback(pick);
  const candidates = [peer('offline', { id: 'another-file' }), peer('wrong-artist', { filename: 'Elsewhere\\Song.flac' }),
    peer('live', { title: 'Song Live', filename: 'Artist\\Song Live.flac' }), peer('lower-quality', { bitDepth: 16 }),
    peer('queued', { freeSlot: false }), peer('second'), peer('third'), peer('fourth')];
  const second = await fallback.next(unavailable, candidates);
  assert.equal(second.username, 'second'); assert.equal(second.waitForComplete, true); assert.equal(second.retryAttempt, 2);
  assert.equal((await fallback.next(unavailable, candidates)).username, 'third');
  assert.equal(await fallback.next(unavailable, candidates), null);
});

test('an ambiguous title or a local service failure never triggers an automatic substitute', async () => {
  const unknown = createPeerFallback({ ...pick, recording: undefined });
  assert.equal(await unknown.next(unavailable, [peer('other')]), null);
  const fallback = createPeerFallback(pick); let searches = 0;
  assert.equal(await fallback.next(Object.assign(new Error('login error'), { kind: 'auth' }), [], async () => { searches++; return []; }), null);
  assert.equal(searches, 0);
});

test('a fresh lookup ignores failed peers even when a cached result calls them available', async () => {
  const fallback = createPeerFallback(pick); let queries = 0;
  const search = async (query, options) => {
    queries++; assert.equal(options.acceptHits([pick]), false);
    const hits = [pick, peer('second'), peer('third')]; assert.equal(options.acceptHits(hits), true); return hits;
  };
  assert.equal((await fallback.next(unavailable, [], search)).username, 'second');
  assert.equal((await fallback.next(unavailable, [], search)).username, 'third');
  assert.ok(queries <= 2);
});

test('a cancelled fallback stops lookup and cannot return a replacement', async () => {
  const controller = new AbortController(), fallback = createPeerFallback(pick);
  const searching = fallback.next(unavailable, [], (query, { signal }) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort();
  }), { signal: controller.signal });
  await assert.rejects(searching, { name: 'AbortError' });
});
