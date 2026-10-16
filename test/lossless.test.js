import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, appendFile, rename, stat, rm, readFile, open } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createLosslessLibrary, parseFlacInfo, parseRange, trackCachePaths, startupBufferBytes } from '../src/web/lossless-library.js';
import { normalizeTracks, SoulseekClient } from '../src/web/soulseek-client.js';

function flac(size = 8192) {
  const value = Buffer.alloc(size, 127); value.write('fLaC'); value[4] = 128;
  value.writeUIntBE(34, 5, 3);
  value.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (23n << 36n) | 480000n, 18);
  return value;
}
const track = { username: 'peer', filename: '@@abcde\\Album\\song.flac', title: 'song', size: 8192 };

test('startup buffers scale with FLAC bitrate and give slow peers enough of a head start', () => {
  const size = 30_000_000, duration = 200;
  assert.equal(startupBufferBytes(size, duration, 1_000_000), 1_800_000);
  assert.equal(startupBufferBytes(size, duration, 100_000), 11_200_000);
  assert.equal(startupBufferBytes(90_000_000, duration, 1_000_000), 5_400_000);
  assert.equal(startupBufferBytes(1000, 5, 50), 1000);
  assert.equal(startupBufferBytes(size, null, 100_000), 512 * 1024);
});

test('opening music search prepares the runtime once, shares initialization with a search and respects missing settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entity-flac-test-')); let starts = 0, configured = false, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const library = createLosslessLibrary({ runtime: { cacheRoot: root, configured: async () => configured,
    start: async () => { starts++; await gate; return { search: async () => [track] }; }, close: async () => {} } });
  try {
    await library.warmup(); assert.equal(starts, 0);
    configured = true;
    const warmup = library.warmup(), search = library.search('song');
    finish(); await warmup; assert.deepEqual(await search, [track]);
    await library.warmup(); assert.equal(starts, 1);
  } finally {
    finish(); await library.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('entity-flac-test-')) throw new Error('Unsafe test cleanup target.');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'entity-flac-test-')), payload = flac();
  let complete = false, paths, id, canceled = 0, finish, markEnqueued;
  const enqueued = new Promise(resolve => { markEnqueued = resolve; });
  const client = {
    search: async () => [track],
    async enqueue(value, streamId) {
      id = streamId; paths = trackCachePaths(root, value, id);
      await mkdir(dirname(paths.incomplete), { recursive: true });
      await writeFile(paths.incomplete, payload.subarray(0, 1024));
      finish = async () => {
        await appendFile(paths.incomplete, payload.subarray(1024));
        await mkdir(dirname(paths.complete), { recursive: true });
        await rename(paths.incomplete, paths.complete); complete = true;
      };
      markEnqueued();
      return { id, transfers: [{ id: 'transfer', state: 'InProgress' }] };
    },
    transfer: async () => ({ id: 'transfer', state: complete ? 'Completed, Succeeded' : 'InProgress' }),
    cancel: async () => { canceled++; },
  };
  const library = createLosslessLibrary({ runtime: { cacheRoot: root, configured: async () => true, start: async () => client, close: async () => {} },
    initialBytes: 512, initialBufferSeconds: 0, pollMs: 5, waitForComplete: false, verifyPrefix: async () => ({ integrity: 'pending' }), verify: async () => ({ integrity: 'verified' }), ...options });
  let stream;
  const server = createServer((req, res) => library.serve(stream.id, req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { library, root, payload, client, enqueued, setStream(value) { stream = value; }, finish: async () => { await enqueued; return finish(); },
    get paths() { return paths; }, get canceled() { return canceled; }, get complete() { return complete; },
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await library.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('entity-flac-test-')) throw new Error('Unsafe test cleanup target.');
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('FLAC headers preserve original sample rate, bit depth, channels and duration', () => {
  assert.deepEqual(parseFlacInfo(flac()), { sampleRate: 48000, bitDepth: 24, channels: 2, duration: 10 });
  assert.equal(parseFlacInfo(Buffer.alloc(10)), null);
  assert.throws(() => parseFlacInfo(Buffer.alloc(42)), /FLAC/);
});

test('HTTP ranges support seeking and suffixes while rejecting malformed or impossible ranges', () => {
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19, partial: true });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99, partial: true });
  for (const value of ['bytes=101-', 'bytes=20-10', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'bytes=1.2-5']) assert.equal(parseRange(value, 100), null);
});

test('search accepts only usable FLAC files, prefers free slots and never trusts traversal paths', () => {
  const hits = normalizeTracks([
    { username: 'queued', files: [{ filename: 'a.flac', size: 1024 }] },
    { username: 'free', hasFreeUploadSlot: true, files: [
      { filename: 'b.flac', size: 1024, bitDepth: 24, sampleRate: 96000 },
      { filename: 'fake.mp3', size: 1024 }, { filename: '..\\escape.flac', size: 1024 },
      { filename: 'locked.flac', size: 1024, isLocked: true }, { filename: 'huge.flac', size: 1024 ** 3 },
    ] },
  ]);
  assert.equal(hits.length, 2); assert.equal(hits[0].username, 'free');
  assert.equal(hits[0].bitDepth, 24); assert.equal(hits[0].sampleRate, 96000);
  assert.throws(() => trackCachePaths('C:/cache', { ...track, filename: '..\\escape.flac' }, randomUUID()));
  assert.throws(() => trackCachePaths('C:/cache', track, '../escape'));
});

test('original bytes stream before completion, survive the final file move, then delete on release', async () => {
  const f = await fixture();
  try {
    const stream = await f.library.acquire(track, 'room'); f.setStream(stream); await stream.ready;
    assert.equal(f.complete, false, 'playback is ready before the whole file downloads');
    const response = await fetch(f.url);
    assert.equal(response.headers.get('content-type'), 'audio/flac'); assert.equal(response.status, 200);
    const reader = response.body.getReader(); const chunks = [];
    const first = await reader.read(); chunks.push(Buffer.from(first.value));
    assert.equal(f.complete, false); assert.deepEqual(chunks[0], f.payload.subarray(0, chunks[0].length));
    await f.finish();
    while (true) { const part = await reader.read(); if (part.done) break; chunks.push(Buffer.from(part.value)); }
    assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), createHash('sha256').update(f.payload).digest('hex'));
    await f.library.release(stream.id, 'room');
    for (const path of Object.values(f.paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.equal(f.canceled, 1);
  } finally { await f.close(); }
});

test('stable playback waits for the complete file and validation before sending original bytes', async () => {
  let finishValidation, validations = 0;
  const validation = new Promise(resolve => { finishValidation = resolve; });
  const f = await fixture({ waitForComplete: true, verify: async () => { validations++; await validation; return { integrity: 'verified' }; } });
  try {
    const stream = await f.library.acquire(track, 'room'); f.setStream(stream);
    let ready = false, responded = false; stream.ready.then(() => { ready = true; });
    const response = fetch(f.url).then(value => { responded = true; return value; });
    await delay(30); assert.equal(ready, false); assert.equal(responded, false);
    await f.finish(); while (!validations) await delay(5);
    assert.equal(stream.status.status, 'verifying'); assert.equal(stream.status.percent, 100);
    assert.equal(ready, false); assert.equal(responded, false);
    finishValidation(); const info = await stream.ready;
    assert.equal(info.integrity, 'verified'); assert.equal(info.status, 'complete'); assert.equal(validations, 1);
    assert.deepEqual(Buffer.from(await (await response).arrayBuffer()), f.payload);
    const shared = await f.library.acquire(track, 'friend'); await shared.ready; assert.equal(validations, 1);
    await f.library.release(stream.id, 'room'); await f.library.release(stream.id, 'friend');
    for (const path of Object.values(f.paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
  } finally { finishValidation(); await f.close(); }
});

test('fast playback validates its prefix once, then finishes full verification in the background', async () => {
  let checks = 0, verified = false;
  const f = await fixture({ verifyPrefix: async () => { checks++; } });
  try {
    const stream = await f.library.acquire(track, 'room'); stream.verified.then(() => { verified = true; });
    assert.equal((await stream.ready).integrity, 'pending'); assert.equal(checks, 1); assert.equal(verified, false);
    await f.finish(); assert.equal((await stream.verified).integrity, 'verified'); assert.equal(checks, 1);
  } finally { await f.close(); }
});

test('large FLAC metadata is not counted as playable buffered audio', async () => {
  const f = await fixture();
  f.payload[4] = 0; f.payload[42] = 129; f.payload.writeUIntBE(4096, 43, 3);
  try {
    const stream = await f.library.acquire(track, 'room'); let ready = false; stream.ready.then(() => { ready = true; }, () => {});
    await f.enqueued;
    if (!stream.status.bytes) await new Promise(resolve => stream.events.once('progress', resolve));
    assert.equal(ready, false); assert.equal(stream.status.bufferTarget, track.size);
    await f.finish(); await stream.ready; assert.equal(ready, true);
  } finally { await f.close(); }
});

test('completion between reading STREAMINFO and opening metadata uses the final path', async t => {
  const f = await fixture({ waitForComplete: true });
  const probePath = join(f.root, 'probe'); await writeFile(probePath, 'test');
  const probe = await open(probePath, 'r'), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read; await probe.close();
  let moved = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!moved && args[2] === 42) { moved = true; await f.finish(); }
    return result;
  });
  try {
    const stream = await f.library.acquire(track, 'room');
    assert.equal((await stream.ready).integrity, 'verified'); assert.equal(moved, true);
  } finally { await f.close(); }
});

test('a damaged complete file never becomes playable and its temporary cache is deleted', async () => {
  const f = await fixture({ waitForComplete: true, verify: async () => { throw new Error('FLAC 음원 검증에 실패했습니다.'); } });
  try {
    const stream = await f.library.acquire(track, 'room'); await delay(15); await f.finish();
    await assert.rejects(stream.ready, /검증/); await stream.task; await delay(0); await stream.disposal;
    assert.equal(stream.complete, undefined);
    for (const path of Object.values(f.paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('stopping during validation aborts the verifier and deletes the completed cache', async () => {
  let validating;
  const started = new Promise(resolve => { validating = resolve; });
  const f = await fixture({ waitForComplete: true, verify: async (path, info, { signal }) => {
    validating(); await delay(10_000, undefined, { signal }); return { integrity: 'verified' };
  } });
  try {
    const stream = await f.library.acquire(track, 'room'); await delay(15); await f.finish(); await started;
    await f.library.release(stream.id, 'room'); await assert.rejects(stream.ready, /취소/);
    for (const path of Object.values(f.paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('future byte ranges wait for arriving bytes instead of returning truncated FLAC', async () => {
  const f = await fixture();
  try {
    const stream = await f.library.acquire(track, 'room'); f.setStream(stream); await stream.ready;
    const response = await fetch(f.url, { headers: { Range: 'bytes=4096-5000' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 4096-5000/8192');
    let ended = false; const body = response.arrayBuffer().then(value => { ended = true; return value; });
    await delay(20); assert.equal(ended, false);
    await f.finish(); assert.deepEqual(Buffer.from(await body), f.payload.subarray(4096, 5001));
  } finally { await f.close(); }
});

test('a stale file size during final completion cannot truncate a waiting byte range', async t => {
  const f = await fixture(); let releaseStat;
  try {
    const stream = await f.library.acquire(track, 'room'); f.setStream(stream); await stream.ready;
    const probe = await open(f.paths.incomplete, 'r'), prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat;
    await probe.close();
    let sawStat; const statStarted = new Promise(resolve => { sawStat = resolve; });
    const gate = new Promise(resolve => { releaseStat = resolve; }); let held = false;
    t.mock.method(prototype, 'stat', async function (...args) {
      const snapshot = await originalStat.apply(this, args);
      if (!held) { held = true; sawStat(); await gate; }
      return snapshot;
    });
    const response = await fetch(f.url, { headers: { Range: 'bytes=4096-5000' } });
    const body = response.arrayBuffer(); body.catch(() => {}); await statStarted;
    await f.finish();
    while (!stream.complete) await delay(5);
    releaseStat(); assert.deepEqual(Buffer.from(await body), f.payload.subarray(4096, 5001));
  } finally { releaseStat?.(); t.mock.restoreAll(); await f.close(); }
});

test('shared tracks retain the cache until the final room stops', async () => {
  const f = await fixture();
  try {
    const a = await f.library.acquire(track, 'a'), b = await f.library.acquire(track, 'b');
    assert.equal(a.id, b.id); await a.ready;
    await f.library.release(a.id, 'a'); assert.equal((await stat(f.paths.incomplete)).size, 1024);
    await f.library.release(b.id, 'b'); await assert.rejects(stat(f.paths.incomplete), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('concurrent downloads reserve full file sizes and cannot exceed the shared cache budget', async () => {
  let allow; const gate = new Promise(resolve => { allow = resolve; });
  const f = await fixture({ cacheLimitBytes: track.size, freeSpace: async () => { await gate; return 10 * 1024 ** 3; } });
  try {
    const a = f.library.acquire(track, 'room'), b = f.library.acquire({ ...track, filename: 'other.flac' }, 'queue');
    allow(); const results = await Promise.allSettled([a, b]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /캐시 한도/);
    const stream = results.find(result => result.status === 'fulfilled').value; await stream.ready;
    assert.equal(f.canceled, 0);
  } finally { allow(); await f.close(); }
});

test('disk guard reserves space for remaining downloads and existing shared tracks do not consume another reservation', async () => {
  let available = 100_000;
  const f = await fixture({ minFreeBytes: 10_000, freeSpace: async () => available });
  try {
    const stream = await f.library.acquire(track, 'room'); await stream.ready;
    available = 10_000 + track.size - stream.status.bytes + track.size - 1;
    await assert.rejects(f.library.acquire({ ...track, filename: 'another.flac' }, 'queue'), /여유 공간/);
    available = 0;
    const shared = await f.library.acquire(track, 'friend'); assert.equal(shared.id, stream.id);
    await f.library.release(stream.id, 'room'); assert.equal((await stat(f.paths.incomplete)).size, 1024);
  } finally { await f.close(); }
});

test('concurrent requests for the same song share one cache reservation', async () => {
  const f = await fixture({ cacheLimitBytes: track.size });
  try {
    const [a, b] = await Promise.all([f.library.acquire(track, 'room'), f.library.acquire(track, 'queue')]);
    assert.equal(a.id, b.id); assert.deepEqual([...a.owners].sort(), ['queue', 'room']); await a.ready;
  } finally { await f.close(); }
});

test('a failed prefetched download deletes its partial file even while its queue owner remains', async () => {
  const f = await fixture();
  try {
    const stream = await f.library.acquire(track, 'queue'); await stream.ready;
    f.client.transfer = async () => ({ state: 'Completed, Errored' });
    await stream.task; await delay(0); assert.ok(stream.error); await stream.disposal;
    for (const path of Object.values(f.paths)) await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.equal(f.canceled, 1);
  } finally { await f.close(); }
});

test('a stalled partial transfer is cancelled and removed without waiting for playback to end', async () => {
  const f = await fixture({ stallMs: 20 });
  try {
    const stream = await f.library.acquire(track, 'room'); await stream.ready;
    await stream.task; await delay(0); assert.match(stream.error.message, /전송이.*진행되지/); await stream.disposal;
    assert.equal(f.canceled, 1); await assert.rejects(stat(f.paths.incomplete), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('restart removes only recorded temporary tracks and leaves unrelated files alone', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), paths = trackCachePaths(f.root, track, id), other = join(f.root, 'complete', 'keep.flac');
    await mkdir(dirname(paths.manifest), { recursive: true }); await mkdir(dirname(paths.incomplete), { recursive: true }); await mkdir(dirname(other), { recursive: true });
    await writeFile(paths.manifest, JSON.stringify({ id, track })); await writeFile(paths.incomplete, 'partial'); await writeFile(other, 'untouched');
    await f.library.search('song'); await assert.rejects(stat(paths.incomplete), { code: 'ENOENT' });
    assert.equal(await readFile(other, 'utf8'), 'untouched');
  } finally { await f.close(); }
});

test('Soulseek REST integration creates searches, filters results and queues a separate batch directory', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data; requests.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null, key: req.headers['x-api-key'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/server')) res.end(JSON.stringify({ isLoggedIn: true }));
    else if (req.url.endsWith('/responses')) res.end(JSON.stringify([{ username: 'peer', files: [{ filename: 'song.flac', size: 1024 }] }]));
    else if (req.method === 'POST' && req.url.endsWith('/batches')) res.end(JSON.stringify({ batch: { id: 'batch' }, failures: [] }));
    else res.end(JSON.stringify({ endedAt: 'now' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new SoulseekClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'private-test-key', searchMs: 1, searchEvents: false });
    const hits = await client.search('song'); assert.equal(hits.length, 1);
    const id = randomUUID(); await client.enqueue(hits[0], id);
    assert.equal(requests.at(-1).body.options.destination, id);
    assert.equal(requests.at(-1).body.files[0].filename, 'song.flac');
    assert.ok(requests.every(r => r.key === 'private-test-key'));
    const requestCount = requests.length;
    assert.equal((await client.search('song')).length, 1); assert.equal(requests.length, requestCount, 'repeat searches use the short cache');
    assert.ok(requests.some(r => r.method === 'PUT'), 'active searches are cancelled before their saved responses are read');
    client.close();
  } finally { await new Promise(resolve => server.close(resolve)); }
});
