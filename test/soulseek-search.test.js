import test from 'node:test';
import assert from 'node:assert/strict';
import { SoulseekClient } from '../src/web/soulseek-client.js';
import { matchTracks } from '../src/web/track-match.js';

const peer = (count = 10, extra = {}) => ({ username: 'test-peer', hasFreeUploadSlot: true, queueLength: 0,
  files: Array.from({ length: count }, (_, index) => ({ filename: `Artist\\Song ${index}.flac`, size: 1024 })), ...extra });

test('a short search keeps its REST fallback and one caller deadline does not cancel a shared longer lookup', async () => {
  const offline = fixture({ live: false, saved: [peer(1)] });
  try {
    assert.equal((await offline.client.search('song', { searchTimeoutMs: 750 })).length, 1);
    assert.equal(offline.time, 750);
  } finally { await offline.close(); }
  const shared = fixture({ updates: [{ at: 250, peer: peer(1) }, { at: 1500, peer: peer(1, { username: 'late-peer' }) }] });
  try {
    const early = shared.client.search('same', { searchTimeoutMs: 500 });
    const late = shared.client.search('same', { searchTimeoutMs: 2000 });
    assert.equal((await early).length, 1); assert.equal((await late).length, 2); assert.equal(shared.starts.size, 1);
  } finally { await shared.close(); }
});

test('a short search keeps its REST fallback and one caller deadline does not cancel a shared longer lookup', async () => {
  const offline = fixture({ live: false, saved: [peer(1)] });
  try {
    assert.equal((await offline.client.search('song', { searchTimeoutMs: 750 })).length, 1);
    assert.equal(offline.time, 750);
  } finally { await offline.close(); }
  const shared = fixture({ updates: [{ at: 250, peer: peer(1) }, { at: 1500, peer: peer(1, { username: 'late-peer' }) }] });
  try {
    const early = shared.client.search('same', { searchTimeoutMs: 500 });
    const late = shared.client.search('same', { searchTimeoutMs: 2000 });
    assert.equal((await early).length, 1); assert.equal((await late).length, 2); assert.equal(shared.starts.size, 1);
  } finally { await shared.close(); }
});

test('a sparse first FLAC is published before the full search finishes and later peers extend the choices', async () => {
  const f = fixture({ updates: [{ at: 250, peer: peer(1) }, { at: 3000, peer: peer(1, { username: 'late-peer' }) }] });
  const progress = [];
  try {
    const hits = await f.client.search('rare song', { onProgress: hits => progress.push({ at: f.time, count: hits.length }) });
    assert.deepEqual(progress, [{ at: 250, count: 1 }, { at: 3000, count: 2 }]);
    assert.equal(hits.length, 2); assert.ok(f.time >= 7000);
  } finally { await f.close(); }
});

test('a caller joining an existing search receives its first choices without waiting for a new peer', async () => {
  const f = fixture({ updates: [{ at: 250, peer: peer(1) }] }); let second;
  const firstProgress = [], secondProgress = [];
  try {
    const first = f.client.search('song', { onProgress: hits => {
      firstProgress.push(f.time);
      second = f.client.search(' SONG ', { onProgress: hits => secondProgress.push({ at: f.time, count: hits.length }) });
    } });
    await first; await second;
    assert.deepEqual(firstProgress, [250]); assert.deepEqual(secondProgress, [{ at: 250, count: 1 }]);
    assert.equal(f.starts.size, 1);
  } finally { await f.close(); }
});

function fixture({ live = true, updates = [{ at: 250, peer: peer() }], saved = [], naturalEnd = Infinity, nativeState, options = {} } = {}) {
  let time = 0;
  const calls = [], subscriptions = new Map(), starts = new Map(), sent = new Set(), stopped = new Set();
  const events = { async subscribe(id, listener) { if (!live) return null; subscriptions.set(id, listener); return () => subscriptions.delete(id); }, close() { subscriptions.clear(); } };
  const sleep = async (ms, value, { signal } = {}) => {
    signal?.throwIfAborted(); time += ms;
    for (const [id, listener] of subscriptions) for (let i = 0; i < updates.length; i++) {
      const key = `${id}:${i}`;
      if (starts.has(id) && time - starts.get(id) >= updates[i].at && !sent.has(key)) { sent.add(key); listener(updates[i].peer); }
    }
    signal?.throwIfAborted();
  };
  const fetchImpl = async (url, init) => {
    init.signal.throwIfAborted(); const route = new URL(url).pathname.replace('/api/v0', '');
    calls.push({ route, method: init.method, body: init.body && JSON.parse(init.body) });
    let value = {};
    const id = route.split('/')[2];
    if (route === '/server') value = { isLoggedIn: true };
    else if (route === '/searches' && init.method === 'POST') starts.set(calls.at(-1).body.id, time);
    else if (init.method === 'PUT') stopped.add(id);
    else if (route.endsWith('/responses')) value = saved;
    else if (init.method === 'GET') value = { state: nativeState, endedAt: stopped.has(id) || time - starts.get(id) >= naturalEnd ? 'now' : null };
    return new Response(JSON.stringify(value));
  };
  const client = new SoulseekClient({ baseUrl: 'http://localhost', apiKey: 'test-key', fetchImpl, searchEvents: events, now: () => time, sleep,
    extendedSearchMs: options.searchMs ?? 7000, ...options });
  return { client, calls, starts, stopped, subscriptions, get time() { return time; }, advance(ms) { time += ms; },
    async close() { client.close(); await Promise.allSettled([...client.cleanups]); } };
}

test('available FLAC candidates return after the collection window instead of a fixed seven seconds', async () => {
  const f = fixture();
  try {
    const hits = await f.client.search('Artist Song');
    assert.equal(hits.length, 10); assert.equal(f.time, 1500);
    assert.equal(f.calls.some(call => call.route.endsWith('/responses')), false, 'early results come from the live hub');
    await Promise.allSettled([...f.client.cleanups]);
    assert.ok(f.calls.some(call => call.method === 'PUT')); assert.ok(f.calls.some(call => call.method === 'DELETE'));
    assert.equal(f.subscriptions.size, 0);
  } finally { await f.close(); }
});

test('a fresh response extends the collection window so a slow second peer is not discarded immediately', async () => {
  const f = fixture({ updates: [{ at: 250, peer: peer() }, { at: 1500, peer: peer(2, { username: 'second-peer' }) }] });
  try { assert.equal((await f.client.search('song')).length, 12); assert.equal(f.time, 2000); }
  finally { await f.close(); }
});

test('matching waits for an available exact recording and does not end early for a live version', async () => {
  const video = { title: 'Artist - Song', duration: 200 };
  const wrong = peer(1, { files: [{ filename: 'Artist\\Song Live.flac', size: 1024, length: 200 }] });
  const right = peer(1, { username: 'right-peer', files: [{ filename: 'Artist\\Song.flac', size: 1024, length: 200 }] });
  const f = fixture({ updates: [{ at: 250, peer: wrong }, { at: 750, peer: right }] });
  try {
    const hits = await f.client.search('Artist Song', { acceptHits: tracks => matchTracks(video, tracks).hits.some(track => track.confident && track.freeSlot) });
    assert.equal(f.time, 750); assert.equal(matchTracks(video, hits).hits[0].username, 'right-peer');
  } finally { await f.close(); }
});

test('sparse results use the full search budget and fallback responses are read only after stopping', async () => {
  const f = fixture({ updates: [{ at: 250, peer: peer(1) }], saved: [peer(1, { username: 'saved-peer' })] });
  try {
    const hits = await f.client.search('rare song'); assert.equal(f.time, 7000); assert.equal(hits.length, 2);
    const stopped = f.calls.findIndex(call => call.method === 'PUT'), response = f.calls.findIndex(call => call.route.endsWith('/responses'));
    assert.ok(stopped > 0 && response > stopped); assert.equal(f.client.cache.get('rare song').complete, true);
  } finally { await f.close(); }
});

test('the REST fallback returns as soon as slskd has finalized, even when live events are unavailable', async () => {
  const f = fixture({ live: false, naturalEnd: 500, saved: [peer(1)] });
  try {
    assert.equal((await f.client.search('song')).length, 1); assert.equal(f.time, 1000);
    assert.equal(f.calls.some(call => call.method === 'PUT'), false);
  } finally { await f.close(); }
});

test('the unavailable live hub still preserves late REST results up to the normal deadline', async () => {
  const f = fixture({ live: false, saved: [peer(1)] });
  try { assert.equal((await f.client.search('song')).length, 1); assert.equal(f.time, 7000); }
  finally { await f.close(); }
});

test('repeated searches reuse normalized cache keys for two minutes, then start a fresh search', async () => {
  const f = fixture();
  try {
    const first = await f.client.search('ＡＲＴＩＳＴ   Song');
    assert.equal(await f.client.search('artist song'), first); assert.equal(f.starts.size, 1);
    f.advance(119_000); assert.equal(await f.client.search(' ARTIST\tSong '), first); assert.equal(f.starts.size, 1);
    f.advance(1001); await f.client.search('artist song'); assert.equal(f.starts.size, 2);
  } finally { await f.close(); }
});

test('an empty result cache expires promptly and a partial cache cannot suppress a missing exact recording', async () => {
  const empty = fixture({ live: false });
  try {
    await empty.client.search('empty'); await empty.client.search('EMPTY'); assert.equal(empty.starts.size, 1);
    empty.advance(5001); await empty.client.search('empty'); assert.equal(empty.starts.size, 2);
  } finally { await empty.close(); }
  const f = fixture();
  try {
    await f.client.search('song'); await f.client.search('song', { acceptHits: () => false });
    assert.equal(f.starts.size, 2); assert.equal(f.client.cache.get('song').complete, true);
  } finally { await f.close(); }
});

test('one cancelled browser cannot cancel another caller sharing the same normalized search', async () => {
  let release, sleeping;
  const entered = new Promise(resolve => { sleeping = resolve; });
  const f = fixture({ live: false, saved: [peer(1)], options: { searchMs: 1, sleep: (ms, value, { signal }) => {
    sleeping(); return new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  } } });
  // The clock must advance after releasing the one collection wait.
  const originalSleep = f.client.sleep;
  f.client.sleep = async (...args) => { await originalSleep(...args); f.advance(1); };
  const a = new AbortController();
  try {
    const first = f.client.search('Artist Song', { signal: a.signal }), second = f.client.search('artist  song');
    await entered; a.abort(); await assert.rejects(first, { name: 'AbortError' });
    assert.equal(f.client.pending.size, 1); release(); assert.equal((await second).length, 1); assert.equal(f.starts.size, 1);
  } finally { release?.(); await f.close(); }
});

test('cancelling the last caller frees the search slot, stops the request and does not cache cancelled results', async () => {
  let sleeping; const entered = new Promise(resolve => { sleeping = resolve; });
  const f = fixture({ live: false, options: { sleep: (ms, value, { signal }) => new Promise((resolve, reject) => {
    sleeping(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) } });
  const controller = new AbortController();
  try {
    const result = f.client.search('cancel me', { signal: controller.signal });
    await entered; controller.abort(); await assert.rejects(result, { name: 'AbortError' });
    await new Promise(setImmediate); assert.equal(f.client.pending.size, 0); assert.equal(f.client.cache.size, 0);
    assert.ok(f.calls.some(call => call.method === 'PUT'));
    await assert.rejects(f.client.search('already aborted', { signal: controller.signal }), { name: 'AbortError' });
  } finally { await f.close(); }
});

test('two different searches can run but their creation requests are serialized and extra jobs are bounded', async () => {
  let releasePost, entered; const firstPost = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { releasePost = resolve; });
  const f = fixture({ live: false, options: { searchMs: 1 } });
  const originalFetch = f.client.fetch; let active = 0, maxActive = 0, posts = 0;
  f.client.fetch = async (url, options) => {
    if (options.method !== 'POST') return originalFetch(url, options);
    active++; maxActive = Math.max(maxActive, active); posts++;
    if (posts === 1) { entered(); await gate; }
    try { return await originalFetch(url, options); } finally { active--; }
  };
  try {
    const one = f.client.search('one'), two = f.client.search('two');
    await firstPost; await assert.rejects(f.client.search('three'), /처리 중/);
    releasePost(); await Promise.all([one, two]); assert.equal(maxActive, 1); assert.equal(posts, 2);
  } finally { releasePost(); await f.close(); }
});

test('slow search-record deletion does not postpone usable results', async () => {
  let releaseDelete; const gate = new Promise(resolve => { releaseDelete = resolve; });
  const f = fixture(), originalFetch = f.client.fetch;
  f.client.fetch = async (url, options) => { if (options.method === 'DELETE') await gate; return originalFetch(url, options); };
  try {
    const result = await f.client.search('song'); assert.equal(result.length, 10); assert.equal(f.time, 1500);
    assert.equal(f.client.pending.size, 0); assert.ok(f.client.cleanups.size > 0);
  } finally { releaseDelete(); await f.close(); }
});

test('cleanup retries a record still being created and never deletes a record before finalization', async () => {
  const f = fixture(), originalFetch = f.client.fetch; let stops = 0, reads = 0;
  f.client.fetch = async (url, options) => {
    if (options.method === 'PUT' && ++stops < 3) return new Response('{}', { status: 404 });
    if (options.method === 'GET' && !url.endsWith('/server') && !url.endsWith('/responses')) {
      reads++; return new Response(JSON.stringify({ endedAt: reads >= 3 ? 'now' : null }));
    }
    return originalFetch(url, options);
  };
  try {
    await f.client.search('song'); await Promise.allSettled([...f.client.cleanups]);
    assert.equal(stops, 3); assert.equal(reads, 3); assert.ok(f.calls.some(call => call.method === 'DELETE'));
  } finally { await f.close(); }
  const unfinished = fixture(), fetchUnfinished = unfinished.client.fetch;
  unfinished.client.fetch = async (url, options) => options.method === 'GET' && !url.endsWith('/server') && !url.endsWith('/responses')
    ? new Response('{"endedAt":null}') : fetchUnfinished(url, options);
  try {
    await unfinished.client.search('song'); await Promise.allSettled([...unfinished.client.cleanups]);
    assert.equal(unfinished.calls.some(call => call.method === 'DELETE'), false);
  } finally { await unfinished.close(); }
});

test('closing the client aborts an outstanding search and closes live subscriptions', async () => {
  let sleeping; const entered = new Promise(resolve => { sleeping = resolve; });
  const f = fixture({ options: { sleep: (ms, value, { signal }) => new Promise((resolve, reject) => {
    sleeping(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) } });
  try {
    const result = f.client.search('song'); await entered; f.client.close(); await assert.rejects(result, { name: 'AbortError' });
    assert.equal(f.subscriptions.size, 0); await assert.rejects(f.client.search('song'), { name: 'AbortError' });
  } finally { await f.close(); }
});

test('a missing recording keeps listening for slow peers beyond seven seconds, including after unrelated early hits', async () => {
  const wrong = peer(120, { files: Array.from({ length: 120 }, (_, index) => ({ filename: `Artist\\Other ${index}.flac`, size: 1024 })) });
  const right = peer(1, { username: 'slow-peer', hasFreeUploadSlot: false, files: [{ filename: 'Artist\\Song.flac', size: 1024 }] });
  const wanted = tracks => tracks.some(track => track.title === 'Song');
  const f = fixture({ updates: [{ at: 250, peer: wrong }, { at: 12_000, peer: right }], options: { extendedSearchMs: 14_000 } });
  const progress = [];
  try {
    const hits = await f.client.search('Artist', { hasRelevantHits: wanted, acceptHits: wanted, onProgress: tracks => progress.push({ at: f.time, found: wanted(tracks) }) });
    assert.equal(hits.length, 121); assert.equal(wanted(hits), true); assert.equal(f.time, 12_000);
    assert.deepEqual(progress.map(data => data.at), [250, 12_000]);
    const post = f.calls.find(call => call.method === 'POST').body;
    assert.equal(post.searchTimeout, 14_000); assert.equal(post.fileLimit, 25_000);
  } finally { await f.close(); }
});

test('empty searches get the extended window but sparse relevant results and quick exact matches remain fast', async () => {
  const empty = fixture({ updates: [], options: { extendedSearchMs: 14_000 } });
  try { assert.deepEqual(await empty.client.search('missing'), []); assert.equal(empty.time, 14_000); }
  finally { await empty.close(); }
  const sparse = fixture({ updates: [{ at: 250, peer: peer(1) }], options: { extendedSearchMs: 14_000 } });
  try { await sparse.client.search('Song', { hasRelevantHits: tracks => tracks.length > 0, acceptHits: () => false }); assert.equal(sparse.time, 7000); }
  finally { await sparse.close(); }
  const fast = fixture({ options: { extendedSearchMs: 14_000 } });
  try { await fast.client.search('Song', { hasRelevantHits: tracks => tracks.length > 0, acceptHits: tracks => tracks.length >= 10 }); assert.equal(fast.time, 500); }
  finally { await fast.close(); }
});

test('a completed short cache with other songs cannot suppress an extended search for a missing recording', async () => {
  const f = fixture({ updates: [{ at: 250, peer: peer(1) }], options: { extendedSearchMs: 14_000 } });
  try {
    await f.client.search('Artist', { hasRelevantHits: () => true, acceptHits: () => false });
    assert.equal(f.client.cache.get('artist').complete, true); assert.equal(f.client.cache.get('artist').extended, false);
    await f.client.search('Artist', { hasRelevantHits: () => false, acceptHits: () => false });
    assert.equal(f.starts.size, 2); assert.equal(f.client.cache.get('artist').extended, true);
    await f.client.search('Artist', { hasRelevantHits: () => false, acceptHits: () => false }); assert.equal(f.starts.size, 2);
  } finally { await f.close(); }
});

test('a cancelled extended search stops waiting and does not cache a false empty result', async () => {
  const f = fixture({ updates: [], options: { extendedSearchMs: 14_000 } }), controller = new AbortController();
  const sleep = f.client.sleep;
  f.client.sleep = async (...args) => { await sleep(...args); if (f.time >= 8000) controller.abort(); };
  try {
    await assert.rejects(f.client.search('missing', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.client.pending.size, 0); assert.equal(f.client.cache.size, 0);
  } finally { await f.close(); }
});

test('an errored native search is never presented or cached as an empty search', async () => {
  for (const nativeState of [132, 'Completed, Errored']) {
    const f = fixture({ updates: [], naturalEnd: 500, nativeState });
    try {
      await assert.rejects(f.client.search('Artist Song'), /내부 오류로 중단/);
      assert.equal(f.client.pending.size, 0); assert.equal(f.client.cache.size, 0);
    } finally { await f.close(); }
  }
});
