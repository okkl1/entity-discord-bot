import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createQuizWebServer } from '../src/web/server.js';
import { readTrackSearchResponse } from '../src/web/public/track-search-response.js';
import { createMusicIdentityLookup } from '../src/web/music-identity.js';

function inbox(ws) {
  const messages = [], waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    const index = waiters.findIndex(w => w.match(message));
    if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    else messages.push(message);
  });
  return match => {
    const predicate = typeof match === 'string' ? m => m.type === match : match;
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match: predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Message timeout')); }, 2000) };
      waiters.push(waiter);
    });
  };
}
async function fixture(overrides = {}) {
  const events = new EventEmitter();
  const guild = { id: 'test-guild', members: { fetch: async () => ({ voice: { channelId: 'voice' } }) } };
  const params = { textChannel: { id: 'text' }, voiceChannel: { id: 'voice', name: '우리의 음악방', guild }, ownerId: 'owner' };
  const web = createQuizWebServer({ events, requireDiscordIdentity: false, busy: () => false,
    search: async () => ({ found: 1, hits: [{ id: 'quiz', title: '인기 음악', hits: 123, privateAnswers: ['secret'] }] }), musicIdentity: async () => null, ...overrides });
  const base = await web.listen({ port: 0 });
  const links = web.createRoom(params);
  const clients = [];
  async function join({ name = '참가자', host = false, resumeToken, joinToken } = {}) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/socket?room=${links.id}`, { origin: base });
    clients.push(ws); const next = inbox(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', name, joinToken, hostToken: host ? links.hostUrl.split('#host=')[1] : undefined, resumeToken }));
    const identity = await next('joined'); const initialState = await next('state');
    return { ws, next, identity, initialState, send: data => ws.send(JSON.stringify(data)) };
  }
  return { web, base, links, join, params, events, async close() { for (const ws of clients) ws.terminate(); await web.close(); } };
}

test('streamed candidates are private, playable before completion and cancel when the browser leaves', async () => {
  const track = { id: 'early', title: '첫 곡', filename: 'private\\song.flac', username: 'private-user', size: 8192 };
  let searchSignal, gotProgress; const first = new Promise(resolve => { gotProgress = resolve; });
  const stream = { id: randomUUID(), events: new EventEmitter(), status: {}, ready: Promise.resolve({ duration: 200 }) };
  const f = await fixture({ lossless: { configured: async () => true,
    search: (query, { signal, onProgress }) => new Promise((resolve, reject) => {
      searchSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); onProgress([track]);
    }), acquire: async () => stream, release: async () => {}, close: async () => {} } });
  const controller = new AbortController(); let reading;
  try {
    const host = await f.join({ host: true });
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
    reading = readTrackSearchResponse(response, { signal: controller.signal, onProgress: data => {
      assert.doesNotMatch(JSON.stringify(data), /private|filename|username/);
      if (data.hits.length) gotProgress(data);
    } });
    // Install rejection handling before intentionally interrupting the stream.
    const ended = reading.catch(error => error);
    assert.equal((await first).hits[0].id, 'early');
    host.send({ type: 'listen', trackId: 'early' });
    const state = await host.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    assert.equal(state.video, null);
    controller.abort(); assert.equal((await ended).name, 'AbortError');
    for (let i = 0; i < 20 && !searchSignal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(searchSignal.aborted, true);
  } finally { controller.abort(); await reading?.catch(() => {}); await f.close(); }
});

test('the playing direct YouTube video can find FLAC without stopping it, and stale switches are rejected', async () => {
  const track = { id: 'same-song', title: 'Song', filename: 'Artist\\Song.flac', size: 8192, duration: 200, freeSlot: true };
  const stream = { id: randomUUID(), events: new EventEmitter(), status: {}, ready: Promise.resolve({ duration: 200 }) };
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'Artist - Song', duration: 200 }],
    lossless: { configured: async () => true, search: async (q, options) => { options.onProgress?.([track]); return [track]; },
      acquire: async () => stream, release: async () => {}, close: async () => {} } });
  try {
    const host = await f.join({ host: true }), guest = await f.join();
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' });
    const watch = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.equal(f.web.rooms.get(f.links.id).videoPicks.size, 0);
    const params = new URLSearchParams({ video: watch.video.id, current: '1', round: watch.roundId });
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?${params}`, { headers: { Accept: 'application/x-ndjson' } });
    const result = await readTrackSearchResponse(response);
    assert.equal(result.matchedId, 'same-song'); assert.equal(f.web.rooms.get(f.links.id).state.phase, 'watch');
    const source = { sourceRoundId: watch.roundId, sourceVideoId: watch.video.id };
    guest.send({ type: 'listen', trackId: result.matchedId, ...source, sourceRoundId: 'old-video' }); assert.match((await guest.next('error')).message, /영상이 바뀌/);
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' });
    const newWatch = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing && m.roundId !== watch.roundId);
    host.send({ type: 'listen', trackId: result.matchedId, ...source }); assert.match((await host.next('error')).message, /영상이 바뀌/);
    host.send({ type: 'queueAdd', kind: 'listen', trackId: result.matchedId, ...source }); assert.match((await host.next('error')).message, /영상이 바뀌/);
    const stale = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?${params}`); assert.equal(stale.status, 502);
    guest.send({ type: 'listen', trackId: result.matchedId, sourceRoundId: newWatch.roundId, sourceVideoId: newWatch.video.id });
    const playing = await guest.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    assert.equal(playing.video, null); assert.equal(f.web.rooms.get(f.links.id).watch, false);
  } finally { await f.close(); }
});

test('authenticated guests can prepare the local music service before typing a search', async () => {
  let warmups = 0;
  const f = await fixture({ lossless: { configured: async () => true, warmup: async () => { warmups++; }, close: async () => {} } });
  try {
    const guest = await f.join(); guest.send({ type: 'prepareLossless' }); guest.send({ type: 'ping', sentAt: 1 });
    await guest.next('pong'); assert.equal(warmups, 1);
  } finally { await f.close(); }
});

test('an error after search headers are sent remains a readable stream error', async () => {
  const f = await fixture({ lossless: { configured: async () => true, search: async () => { throw new Error('Soulseek 로그인 실패'); }, close: async () => {} } });
  try {
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`, { headers: { Accept: 'application/x-ndjson' } });
    await assert.rejects(readTrackSearchResponse(response), /Soulseek 로그인 실패/);
  } finally { await f.close(); }
});

test('the music search accepts a copied YouTube title and a video URL, without sending feat and MV words to Soulseek', async () => {
  const track = { id: 'camo', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', size: 8192, duration: 186, freeSlot: true };
  const queries = [];
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'CAMO - Life is Wet (feat.JMIN) [Official Music Video]', duration: 186 }],
    lossless: { configured: async () => true, search: async (query, options) => { queries.push(query); const hits = /CAMO|Life Wet/.test(query) ? [track] : []; options.onProgress?.(hits); return hits; }, close: async () => {} } });
  try {
    const search = q => fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=${encodeURIComponent(q)}`).then(response => response.json());
    assert.equal((await search('Life is Wet')).hits[0].title, 'Life is Wet');
    const copied = await search('CAMO - Life is Wet (feat.JMIN) [Official Music Video]'); assert.equal(copied.hits.length, 1);
    const url = await search('https://youtu.be/M7lc1UVf-VE'); assert.equal(url.matchedId, 'camo'); assert.equal(url.playableMatch, true);
    assert.ok(queries.includes('Life Wet')); assert.ok(queries.includes('CAMO Life is Wet'));
    assert.ok(queries.every(query => !/feat|JMIN|Official|Video|https:/i.test(query)));
    assert.doesNotMatch(JSON.stringify(url), /filename|username/);
  } finally { await f.close(); }
});

test('manual searches identify the recording before native queries and accept a separately entered artist', async () => {
  const queries = [], progress = []; let lookups = 0;
  const track = { id: 'camo', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', username: 'private-peer', size: 8192, freeSlot: true };
  const f = await fixture({ musicIdentity: createMusicIdentityLookup(async () => { lookups++; return [
    { id: 'vadat46yfwg', title: 'CAMO - Life is Wet (feat. JMIN) [Official Music Video]' },
    { id: 'NAKP8fPTsFI', title: 'CAMO (카모) - Life is Wet (Feat. JMIN) l Lyrics / 가사' }
  ]; }), lossless: { configured: async () => true, search: async (query, options) => {
    queries.push(query); options.onProgress?.([track]); return [track];
  }, close: async () => {} } });
  try {
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=${encodeURIComponent('Life is Wet (feat. JMIN) [Official Music Video]')}`, { headers: { Accept: 'application/x-ndjson' } });
    const result = await readTrackSearchResponse(response, { onProgress: data => progress.push(data) });
    assert.equal(lookups, 1); assert.deepEqual(queries, ['Life is Wet', 'CAMO Life is Wet', '카모 Life is Wet']);
    assert.deepEqual(result.identity, { artist: 'CAMO (카모)', title: 'Life is Wet' });
    assert.ok(progress.some(data => data.stage === 'identity')); assert.equal(result.matchedId, undefined);
    assert.doesNotMatch(JSON.stringify({ result, progress }), /username|filename|private-peer/);
    queries.length = 0;
    const direct = await (await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?artist=CAMO&q=Life%20is%20Wet`)).json();
    assert.deepEqual(direct.identity, { artist: 'CAMO', title: 'Life is Wet' });
    assert.deepEqual(queries, ['CAMO Life is Wet', 'Life is Wet']); assert.equal(lookups, 1, 'explicit artist bypasses remote identification');
  } finally { await f.close(); }
});

test('zero title results stream recovered artist candidates with relation labels and keep peer identity private', async () => {
  const queries = [], progress = [];
  const tracks = [
    { id: 'other', title: 'Other Song', filename: 'CAMO\\Other Song.flac', username: 'private-peer', size: 8192, freeSlot: true },
    { id: 'exact', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', username: 'private-peer', size: 8192, duration: 186, freeSlot: true }
  ];
  const stream = { id: randomUUID(), events: new EventEmitter(), status: {}, ready: Promise.resolve({ duration: 186 }) };
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'CAMO - Life is Wet (feat.JMIN) [MV]', duration: 186 }],
    lossless: { configured: async () => true, search: async (query, { onProgress }) => {
      queries.push(query); const hits = query === 'CAMO' ? tracks : []; onProgress?.(hits); return hits;
    }, acquire: async () => stream, release: async () => {}, close: async () => {} } });
  try {
    const host = await f.join({ host: true });
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=Life%20is%20Wet`, { headers: { Accept: 'application/x-ndjson' } });
    const result = await readTrackSearchResponse(response, { onProgress: data => progress.push(data) });
    assert.equal(result.stage, 'related'); assert.ok(result.searchedQueries.includes('CAMO'));
    assert.deepEqual(result.hits.map(track => track.id), ['exact', 'other']);
    assert.equal(result.hits[1].relatedLabel, '같은 가수의 연관 곡'); assert.equal(result.hits[1].relatedArtist, 'CAMO');
    assert.equal(result.matchedId, undefined); assert.equal(result.playableMatch, undefined);
    assert.equal(f.web.rooms.get(f.links.id).state.phase, 'waiting', 'related search alone cannot start a song');
    assert.ok(progress.some(data => data.stage === 'related' && !data.hits.length));
    assert.doesNotMatch(JSON.stringify({ result, progress }), /filename|username|private-peer/);
    host.send({ type: 'listen', trackId: 'other' });
    const playing = await host.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    assert.equal(playing.audio.title, 'Other Song'); assert.equal(queries.length, 4);
  } finally { await f.close(); }
});

test('an unmatched YouTube song also exposes related artist choices without automatically changing the video', async () => {
  const track = { id: 'other', title: 'Other Song', filename: 'CAMO\\Other Song.flac', size: 8192, freeSlot: true };
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'CAMO - Life is Wet', duration: 186 }],
    lossless: { configured: async () => true, search: async query => query === 'CAMO' ? [track] : [], close: async () => {} } });
  try {
    const host = await f.join({ host: true });
    await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=Life`);
    host.send({ type: 'watch', videoId: 'M7lc1UVf-VE' }); const watch = await host.next(m => m.type === 'state' && m.phase === 'watch');
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=M7lc1UVf-VE&current=1&round=${watch.roundId}`);
    const result = await response.json();
    assert.equal(result.hits[0].id, 'other'); assert.equal(result.hits[0].relatedLabel, '같은 가수의 연관 곡');
    assert.equal(result.matchedId, null); assert.equal(result.playableMatch, false);
    assert.equal(f.web.rooms.get(f.links.id).state.phase, 'watch');
  } finally { await f.close(); }
});

test('a title-only video resolves artist metadata before sending its structured song query to Soulseek', async () => {
  let releaseMetadata, resolving; const metadata = new Promise(resolve => { releaseMetadata = resolve; });
  const first = new Promise(resolve => { resolving = resolve; }); const queries = [];
  const track = { id: 'camo', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', size: 8192, duration: 186, freeSlot: true };
  const f = await fixture({ videoSearch: async (query, options) => {
    if (options?.metadata) { await metadata; return [{ id: 'M7lc1UVf-VE', title: 'Life is Wet', artist: 'CAMO', track: 'Life is Wet', duration: 186 }]; }
    return [{ id: 'M7lc1UVf-VE', title: 'Life is Wet', channel: 'Music Uploads', duration: 186 }];
  }, lossless: { configured: async () => true, search: async (query, options) => {
    queries.push(query); options.onProgress?.([track]);
    assert.equal(options.acceptHits([track]), true); return [track];
  }, close: async () => {} } });
  try {
    await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=Life`);
    const response = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=M7lc1UVf-VE`, { headers: { Accept: 'application/x-ndjson' } });
    const events = [], reading = readTrackSearchResponse(response, { onProgress: data => { events.push(data); if (data.stage === 'identity') resolving(data); } });
    await first; assert.deepEqual(queries, [], 'an uploader name cannot become an artist query');
    releaseMetadata(); const result = await reading;
    assert.equal(result.matchedId, 'camo'); assert.equal(result.playableMatch, true);
    assert.equal(queries[0], 'CAMO Life is Wet'); assert.deepEqual(result.identity, { artist: 'CAMO', title: 'Life is Wet' });
    assert.ok(events.some(data => data.playableMatch && data.query === 'CAMO Life is Wet'));
  } finally { releaseMetadata(); await f.close(); }
});

test('selecting a FLAC publishes its preparation screen before old transfer cleanup finishes', async () => {
  let finishCleanup, acquisitions = 0; const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const tracks = [{ id: 'one', title: '첫 곡', size: 8192 }, { id: 'two', title: '다음 곡', size: 8192 }];
  const f = await fixture({ lossless: { configured: async () => true, search: async () => tracks,
    acquire: async () => { acquisitions++; return { id: randomUUID(), events: new EventEmitter(), status: {}, ready: Promise.resolve({ duration: 200 }) }; },
    release: async () => { if (acquisitions === 1) await cleanup; }, close: async () => {} } });
  try {
    const host = await f.join({ host: true }); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    host.send({ type: 'listen', trackId: 'one' }); await host.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    host.send({ type: 'listen', trackId: 'two' });
    const preparing = await host.next(m => m.type === 'state' && m.phase === 'loading' && m.title === '다음 곡');
    assert.equal(preparing.preparingKind, 'listen'); assert.equal(preparing.audio, null); assert.equal(preparing.video, null); assert.equal(acquisitions, 1);
    finishCleanup(); await host.next(m => m.type === 'state' && m.phase === 'listen' && m.title === '다음 곡');
    assert.equal(acquisitions, 2);
  } finally { finishCleanup(); await f.close(); }
});

test('a failed FLAC acquisition restores the previous YouTube video and playback clock', async () => {
  const f = await fixture({ lossless: { configured: async () => true, search: async () => [{ id: 'bad', title: 'song', size: 8192 }],
    acquire: async () => { throw new Error('전송 실패'); }, close: async () => {} } });
  try {
    const host = await f.join({ host: true }); host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' });
    const watch = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`); host.send({ type: 'listen', trackId: 'bad' });
    await host.next(m => m.type === 'state' && m.phase === 'watch' && m.pendingAudio);
    await host.next('error');
    const restored = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.deepEqual(restored.video, watch.video); assert.equal(f.web.rooms.get(f.links.id).watch, true);
  } finally { await f.close(); }
});

test('voice room lookup supplies private controls only to its owner', async () => {
  const f = await fixture();
  try {
    assert.equal(f.web.getVoiceRoom('test-guild', 'voice', 'owner').joinUrl, f.links.hostUrl);
    assert.equal(f.web.getVoiceRoom('test-guild', 'voice', 'guest').joinUrl, f.links.shareUrl);
    assert.equal(f.web.getVoiceRoom('test-guild', 'other', 'owner'), null);
  } finally { await f.close(); }
});

test('YouTube stays active during FLAC preparation and an exact match continues at the current shared position', async () => {
  let prepared;
  const stream = { id: randomUUID(), events: new EventEmitter(), status: { percent: 0 }, ready: new Promise(resolve => { prepared = resolve; }) };
  const pick = { id: 'flac', title: 'Song', filename: 'Artist\\Song.flac', size: 8192, duration: 200, freeSlot: true };
  const released = [];
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'Artist - Song', duration: 200 }],
    lossless: { configured: async () => true, search: async () => [pick], acquire: async () => stream,
      release: async (id, owner) => released.push(owner), close: async () => {} } });
  try {
    const guest = await f.join(); await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=Song`);
    guest.send({ type: 'watch', videoId: 'M7lc1UVf-VE' }); const watch = await guest.next(m => m.phase === 'watch');
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=M7lc1UVf-VE`);
    const room = f.web.rooms.get(f.links.id); room.state.video.startedAt = Date.now() - 25_000;
    guest.send({ type: 'listen', trackId: pick.id, sourceRoundId: watch.roundId, sourceVideoId: watch.video.id });
    const pending = await guest.next(m => m.pendingAudio);
    assert.equal(pending.phase, 'watch'); assert.equal(pending.preparing, false); assert.equal(room.watch, true);
    stream.events.emit('progress', { percent: 30, status: 'receiving' });
    assert.equal((await guest.next(m => m.pendingAudio?.percent === 30)).phase, 'watch');
    prepared({ duration: 200, integrity: 'pending' }); const listening = await guest.next(m => m.phase === 'listen' && m.audio?.startedAt);
    assert.ok(listening.audio.startSeconds >= 25 && listening.audio.startSeconds < 27); assert.equal(listening.pendingAudio, null);
    assert.ok(released.some(owner => owner.startsWith('handoff:'))); assert.equal(released.includes(room.id), false);
  } finally { prepared({ duration: 200 }); await f.close(); }
});

test('cancelling a fully verified handoff keeps YouTube and releases only the preparation cache', async () => {
  let verified;
  const stream = { id: randomUUID(), events: new EventEmitter(), status: {}, ready: Promise.resolve({ duration: 200 }),
    verified: new Promise(resolve => { verified = resolve; }) };
  const released = [];
  const f = await fixture({ lossless: { configured: async () => true, search: async () => [{ id: 'song', title: 'Song' }], acquire: async () => stream,
    release: async (id, owner) => released.push(owner), close: async () => {} } });
  try {
    const guest = await f.join(); guest.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' }); const watch = await guest.next(m => m.phase === 'watch');
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=Song`);
    guest.send({ type: 'listen', trackId: 'song', playbackMode: 'verified' }); const pending = await guest.next(m => m.pendingAudio);
    guest.send({ type: 'cancelFlac' }); const cancelled = await guest.next(m => m.phase === 'watch' && m.pendingAudio === null && m.revision > pending.revision);
    assert.deepEqual(cancelled.video, watch.video); verified({ duration: 200 });
    await new Promise(setImmediate); assert.ok(released.every(owner => owner.startsWith('handoff:')));
    assert.equal(f.web.rooms.get(f.links.id).state.phase, 'watch');
  } finally { verified({ duration: 200 }); await f.close(); }
});

test('a peer endpoint timeout automatically tries another exact FLAC while keeping YouTube active', async () => {
  const timeout = Object.assign(new Error('공유자 연결 시간 초과'), { kind: 'peer_timeout' });
  const tracks = ['offline', 'available'].map(username => ({ id: username, username, filename: 'Artist\\Song.flac', title: 'Song',
    size: 8192, duration: 200, freeSlot: true, bitDepth: 24, sampleRate: 96000 }));
  const streams = new Map(), attempted = [], released = [];
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: 'Artist - Song', duration: 200 }], lossless: {
    configured: async () => true, search: async () => tracks,
    acquire: async track => {
      if (!streams.has(track.id)) {
        attempted.push(track.username);
        const ready = track.id === 'offline' ? Promise.reject(timeout) : Promise.resolve({ duration: 200 }); ready.catch(() => {});
        streams.set(track.id, { id: randomUUID(), events: new EventEmitter(), status: {}, ready });
      }
      return streams.get(track.id);
    }, release: async (id, owner) => released.push(id), close: async () => {},
  } });
  try {
    const guest = await f.join(); await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=Song`);
    guest.send({ type: 'watch', videoId: 'M7lc1UVf-VE' }); const watch = await guest.next(m => m.phase === 'watch');
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=M7lc1UVf-VE`);
    guest.send({ type: 'listen', trackId: 'offline', sourceRoundId: watch.roundId, sourceVideoId: watch.video.id });
    assert.equal((await guest.next(m => m.pendingAudio?.status === 'retrying')).phase, 'watch');
    const played = await guest.next(m => m.phase === 'listen' && m.audio?.startedAt);
    assert.equal(played.audio.id, streams.get('available').id); assert.deepEqual(attempted, ['offline', 'available']);
    assert.ok(released.includes(streams.get('offline').id));
  } finally { await f.close(); }
});

test('normal FLAC playback retries another peer before sound starts', async () => {
  const timeout = Object.assign(new Error('공유자 연결 시간 초과'), { kind: 'peer_timeout' });
  const tracks = ['offline', 'available'].map(username => ({ id: username, username, filename: 'Artist\\Song.flac', title: 'Song',
    size: 8192, duration: 200, freeSlot: true }));
  const streams = new Map();
  const f = await fixture({ lossless: { configured: async () => true, search: async () => tracks,
    acquire: async track => {
      if (!streams.has(track.id)) {
        const ready = track.id === 'offline' ? Promise.reject(timeout) : Promise.resolve({ duration: 200 }); ready.catch(() => {});
        streams.set(track.id, { id: randomUUID(), events: new EventEmitter(), status: {}, ready });
      }
      return streams.get(track.id);
    }, release: async () => {}, close: async () => {},
  } });
  try {
    const guest = await f.join(); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=Song&artist=Artist`);
    guest.send({ type: 'listen', trackId: 'offline' });
    const played = await guest.next(m => m.phase === 'listen' && m.audio?.startedAt);
    assert.equal(played.audio.id, streams.get('available').id); assert.equal(streams.size, 2);
  } finally { await f.close(); }
});

test('the web participant guide follows the chat where its entry panel was published', async () => {
  const f = await fixture();
  try {
    const info = () => fetch(`${f.base}/api/rooms/${f.links.id}`).then(response => response.json());
    assert.equal((await info()).discordChannelUrl, 'https://discord.com/channels/test-guild/text');
    const guest = await f.join(); assert.equal(guest.identity.discordChannelUrl, 'https://discord.com/channels/test-guild/text');
    f.web.setEntryChannel(f.links.id, 'other-text');
    assert.equal((await guest.next('entryChannel')).discordChannelUrl, 'https://discord.com/channels/test-guild/other-text');
    assert.equal((await info()).discordChannelUrl, 'https://discord.com/channels/test-guild/other-text');
    assert.equal(f.web.rooms.get(f.links.id).voiceChannel.id, 'voice');
    f.web.setEntryChannel('missing', 'text');
  } finally { await f.close(); }
});

test('native handoff stops web video and publishes an empty stage to all clients', async () => {
  const f = await fixture();
  try {
    const host = await f.join({ host: true }), guest = await f.join();
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' });
    await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.equal(f.web.isWatchingGuild('test-guild'), true);
    await f.web.stopPlayback('test-guild');
    const stopped = await guest.next(m => m.type === 'state' && m.phase === 'waiting' && m.revision > 1);
    assert.equal(stopped.video, null); assert.equal(f.web.isWatchingGuild('test-guild'), false);
  } finally { await f.close(); }
});

test('native handoff cancels an old quiz load even after a new load clears the cancellation flag', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const launches = [];
  const f = await fixture({ load: async id => { if (id === 'old') await pending; return { quiz: { id }, questions: [] }; },
    launch: async ({ quiz }) => { launches.push(quiz.id); } });
  try {
    const host = await f.join({ host: true });
    host.send({ type: 'start', quizId: 'old' });
    await host.next(m => m.type === 'state' && m.preparing);
    await f.web.stopPlayback('test-guild');
    await host.next(m => m.type === 'state' && m.phase === 'waiting' && !m.preparing);
    host.send({ type: 'start', quizId: 'new' });
    await host.next(m => m.type === 'state' && m.preparing);
    await new Promise(resolve => setTimeout(resolve, 20));
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(launches, ['new']);
  } finally { release(); await f.close(); }
});

test('watch mode lets every participant control playback and rejects stale requests', async () => {
  const f = await fixture({ videoSearch: async () => [{ id: 'M7lc1UVf-VE', title: '영상', channel: 'Google', duration: 600, startSeconds: 5, secret: 'private' }] });
  try {
    const result = await (await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=test`)).json();
    assert.equal(result.hits[0].title, '영상'); assert.equal(result.hits[0].secret, undefined);
    const a = await f.join({ host: true, name: '방장' }), b = await f.join({ name: '손님' });
    b.send({ type: 'watch', videoId: 'M7lc1UVf-VE' });
    const first = await a.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    const second = await b.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.deepEqual(first.video, second.video); assert.equal(first.video.startSeconds, 5);
    const control = { roundId: first.roundId, phase: 'watch' };
    b.send({ type: 'watchSeek', seconds: 40, ...control }); await b.next(m => m.type === 'state' && m.video?.startSeconds === 40);
    a.send({ type: 'pause', ...control });
    const paused = await a.next(m => m.type === 'state' && m.paused);
    assert.deepEqual(paused.video, (await b.next(m => m.type === 'state' && m.paused)).video);
    a.send({ type: 'watchSeek', seconds: 90, ...control });
    const seek = await a.next(m => m.type === 'state' && m.video?.startSeconds === 90);
    assert.equal(seek.paused, true); assert.equal(seek.video.pausedAt, seek.video.startedAt);
    const late = await f.join({ name: '늦은 친구' });
    assert.equal(late.initialState.video.startSeconds, 90); assert.equal(late.initialState.paused, true); assert.equal(late.identity.host, false);
    a.send({ type: 'pause', ...control }); await a.next(m => m.type === 'state' && m.phase === 'watch' && !m.paused && m.video.startSeconds === 90);
    a.send({ type: 'watchSeek', seconds: -1, ...control }); assert.match((await a.next('error')).message, /올바른/);
    a.send({ type: 'stop', roundId: 'old-video', phase: 'watch' }); assert.match((await a.next('error')).message, /영상이 바뀌/);
    a.send({ type: 'stop', ...control }); await a.next(m => m.type === 'state' && m.phase === 'waiting' && !m.preparing && m.revision > seek.revision);
    assert.equal(f.web.rooms.get(f.links.id).watch, false);
  } finally { await f.close(); }
});

test('watch selection stops the quiz, waits for cleanup and preserves room links', async () => {
  let running = true, deleted = 0;
  const f = await fixture({ busy: () => running });
  const previous = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old', scores: [] }),
    requestStop: () => { running = false; f.events.emit('end', previous); } };
  try {
    f.events.emit('start', previous); f.web.trackRoomReply(f.links.id, () => { deleted++; });
    const host = await f.join({ host: true });
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE?t=15' });
    const watching = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.equal(watching.video.startSeconds, 15); assert.equal(deleted, 1);
    assert.equal(f.web.rooms.get(f.links.id).session, null);
    assert.equal((await fetch(f.links.shareUrl)).status, 200);
  } finally { await f.close(); }
});

test('failed quiz selection preserves watch mode and successful quiz replaces it', async () => {
  let fail = true;
  const f = await fixture({ load: async () => { if (fail) throw new Error('퀴즈 실패'); return { quiz: {}, questions: [] }; }, launch: async args => {
    f.events.emit('start', { ...args, events: new EventEmitter(), getWebState: () => ({ phase: 'question', roundId: 'new', scores: [] }) });
  } });
  try {
    const host = await f.join({ host: true });
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' }); await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    host.send({ type: 'start', quizId: 'test' }); assert.match((await host.next('error')).message, /퀴즈 실패/);
    assert.equal(f.web.rooms.get(f.links.id).state.phase, 'watch');
    fail = false; host.send({ type: 'start', quizId: 'test' }); await host.next(m => m.type === 'state' && m.phase === 'question');
    assert.equal(f.web.rooms.get(f.links.id).watch, false); assert.equal(f.web.rooms.get(f.links.id).watchTimer, null);
  } finally { await f.close(); }
});

test('web room only serves public assets and safe quiz metadata', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/.env`)).status, 404);
    assert.equal((await fetch(`${f.base}/src/chzzk/.auth.json`)).status, 404);
    const html = await (await fetch(f.links.shareUrl)).text();
    assert.match(html, /id="answer-form"/);
    assert.doesNotMatch(html, new RegExp(f.links.hostUrl.split('#host=')[1]));
    const search = await (await fetch(`${f.base}/api/rooms/${f.links.id}/quizzes`)).json();
    assert.equal(search.hits[0].title, '인기 음악');
    assert.doesNotMatch(JSON.stringify(search), /secret|privateAnswers/);
    assert.equal((await fetch(`${f.base}/api/rooms/missing`)).status, 404);
  } finally { await f.close(); }
});

test('resuming a creator token does not grant creator identity but participant controls remain available', async () => {
  let loads = 0; const f = await fixture({ load: async () => { loads++; throw new Error('test load reached'); } });
  try {
    const host = await f.join({ name: '방장', host: true });
    assert.equal(host.identity.host, true);
    const guest = await f.join({ name: '손님', resumeToken: host.identity.resumeToken });
    assert.equal(guest.identity.host, false);
    guest.send({ type: 'start', quizId: 'quiz' });
    assert.match((await guest.next('error')).message, /test load reached/); assert.equal(loads, 1);
  } finally { await f.close(); }
});

test('two browsers receive the same reveal timestamp and stale answers are rejected', async () => {
  const f = await fixture();
  try {
    const a = await f.join({ name: '하나' }), b = await f.join({ name: '둘' });
    const session = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
      getWebState: () => ({ phase: 'question', roundId: 'round:1', answer: null, video: null, scores: [] }),
      submitAnswer: ({ roundId }) => ({ accepted: roundId === 'round:1', correct: false }), skipCurrent: () => {} };
    f.events.emit('start', session);
    await a.next('state'); await b.next('state');
    a.send({ type: 'answer', roundId: 'old-round', content: '뒤늦은 답' });
    assert.match((await a.next('error')).message, /문제가 바뀌었습니다/);
    const video = { id: 'M7lc1UVf-VE', startSeconds: 30, startedAt: Date.now() };
    session.events.emit('state', { phase: 'reveal', roundId: 'round:1', answer: '정답', video, scores: [] });
    const [one, two] = await Promise.all([a.next('state'), b.next('state')]);
    assert.deepEqual(one.video, two.video);
    assert.deepEqual(one.video, video);
    assert.equal(one.answer, '정답');
  } finally { await f.close(); }
});

test('concurrent host starts load and launch a game only once', async () => {
  let loads = 0, launches = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ load: async () => { loads++; await pending; return { quiz: { title: '테스트' }, questions: [] }; },
    launch: async () => { launches++; } });
  try {
    const a = await f.join({ name: '방장', host: true }), b = await f.join({ name: '방장2', host: true });
    a.send({ type: 'start', quizId: 'quiz' }); await a.next(m => m.type === 'state' && m.phase === 'loading');
    b.send({ type: 'start', quizId: 'quiz' });
    assert.match((await b.next('error')).message, /이미 진행/);
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(loads, 1); assert.equal(launches, 1);
  } finally { release(); await f.close(); }
});

test('foreign browser origins cannot open a room connection', async () => {
  const f = await fixture();
  try {
    const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/socket?room=${f.links.id}`, { origin: 'https://unrelated.example' });
    await assert.rejects(new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }), /403/);
  } finally { await f.close(); }
});

test('Discord quiz starts create a public room automatically and reuse it for the next game', async () => {
  const events = new EventEmitter();
  const web = createQuizWebServer({ events, requireDiscordIdentity: false });
  const base = await web.listen({ port: 0 });
  let ws;
  const voiceChannel = { id: 'voice', name: '음악방', guild: { id: 'automatic-guild' } };
  const session = { starterId: 'starter', textChannel: { id: 'text' }, voiceChannel,
    quiz: { title: '자동 퀴즈' }, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', title: '자동 퀴즈', roundId: 'first:1', index: 1, total: 10, scores: [] }) };
  try {
    events.emit('start', session);
    assert.equal(web.rooms.size, 1);
    const room = [...web.rooms.values()][0];
    assert.equal(room.ownerId, 'starter');
    assert.equal(session.webRoomUrl, `${base}/r/${room.id}`);
    assert.doesNotMatch(session.webRoomUrl, /#host=/);
    assert.equal((await fetch(`${base}/api/rooms/${room.id}`)).status, 200);
    ws = new WebSocket(`${base.replace('http:', 'ws:')}/socket?room=${room.id}`, { origin: base });
    const next = inbox(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', name: '참가자' }));
    assert.equal((await next('joined')).host, false);
    const first = await next('state');
    assert.equal(first.phase, 'question');
    assert.equal(first.roundId, 'first:1');
    assert.doesNotMatch(JSON.stringify(first), new RegExp(room.hostToken));
    events.emit('end', session);
    await next(m => m.type === 'state' && m.phase === 'finished');
    const second = { ...session, textChannel: { id: 'new-text' }, events: new EventEmitter(),
      getWebState: () => ({ phase: 'question', title: '다음 게임', roundId: 'second:1', index: 1, total: 5, scores: [] }) };
    events.emit('start', second);
    assert.equal(second.webRoomUrl, session.webRoomUrl);
    assert.equal(web.rooms.size, 1);
    assert.equal(room.textChannel.id, 'new-text');
    assert.equal(session.events.listenerCount('state'), 0);
    assert.equal((await next(m => m.type === 'state' && m.roundId === 'second:1')).title, '다음 게임');
  } finally { ws?.terminate(); await web.close(); }
});

test('host link lookup only permits the Discord quiz owner', async () => {
  const f = await fixture();
  try {
    assert.equal(f.web.getHostLink(f.links.id, 'owner'), f.links.hostUrl);
    assert.throws(() => f.web.getHostLink(f.links.id, 'guest'), /방장만/);
    assert.throws(() => f.web.getHostLink('missing', 'owner'), /만료/);
  } finally { await f.close(); }
});

test('web quiz replacement loads first, keeps voice connected, and rejects concurrent changes', async () => {
  let release, loads = 0, launches = 0, stops = 0, running = true, stopOptions;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ busy: () => running, load: async () => { loads++; await pending; return { quiz: { title: '새 퀴즈' }, questions: [] }; }, launch: async () => { launches++; } });
  const old = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old:1', scores: [], paused: false }),
    requestStop: options => { stopOptions = options; stops++; running = false; f.events.emit('end', old); } };
  try {
    f.events.emit('start', old);
    const a = await f.join({ host: true, name: '방장' }), b = await f.join({ host: true, name: '방장2' }), guest = await f.join();
    guest.send({ type: 'replace', quizId: 'new' });
    await a.next(m => m.type === 'state' && m.preparing);
    assert.equal(stops, 0, 'old playback continues until the new quiz loads');
    b.send({ type: 'replace', quizId: 'another' });
    assert.match((await b.next('error')).message, /이미 진행/);
    release();
    await a.next(m => m.type === 'state' && m.phase === 'finished' && !m.preparing);
    assert.equal(loads, 1); assert.equal(stops, 1); assert.equal(launches, 1);
    assert.deepEqual(stopOptions, { keepVoiceConnection: true });
  } finally { release(); await f.close(); }
});

test('failed launch after stopping the old quiz releases its retained voice connection', async () => {
  let running = true, released = 0;
  const f = await fixture({ busy: () => running, load: async () => ({ quiz: {}, questions: [] }),
    launch: async () => { throw new Error('새 퀴즈 재생 실패'); } });
  const old = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old:1', scores: [] }),
    requestStop: options => { assert.equal(options.keepVoiceConnection, true); running = false; f.events.emit('end', old); },
    releaseVoiceConnection: () => { released++; } };
  try {
    f.events.emit('start', old); const host = await f.join({ host: true });
    host.send({ type: 'replace', quizId: 'new' });
    assert.match((await host.next('error')).message, /새 퀴즈 재생 실패/);
    assert.equal(released, 1);
  } finally { await f.close(); }
});

test('canceling replacement during old-session cleanup releases the voice handoff without launching', async () => {
  let running = true, released = 0, launches = 0, stopping, canceled;
  const stopEntered = new Promise(resolve => { stopping = resolve; });
  const cancelEntered = new Promise(resolve => { canceled = resolve; });
  const f = await fixture({ busy: () => running, load: async () => ({ quiz: {}, questions: [] }),
    launch: async () => { launches++; } });
  const old = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old:1', scores: [] }),
    requestStop: options => { if (options?.keepVoiceConnection) stopping(); else canceled(); },
    releaseVoiceConnection: () => { released++; } };
  try {
    f.events.emit('start', old); const host = await f.join({ host: true });
    host.send({ type: 'replace', quizId: 'new' }); await stopEntered;
    host.send({ type: 'stop' }); await cancelEntered;
    running = false; f.events.emit('end', old);
    await host.next(m => m.type === 'state' && m.phase === 'finished' && !m.preparing);
    assert.equal(launches, 0); assert.equal(released, 1);
  } finally { await f.close(); }
});

test('failed replacement preserves the current game and clears the loading lock', async () => {
  let stops = 0;
  const f = await fixture({ busy: () => true, load: async () => { throw new Error('인증 제한'); } });
  const old = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old:1', scores: [], paused: false }), requestStop: () => { stops++; } };
  try {
    f.events.emit('start', old);
    const host = await f.join({ host: true });
    host.send({ type: 'replace', quizId: 'new' });
    assert.match((await host.next('error')).message, /인증 제한/);
    await host.next(m => m.type === 'state' && !m.preparing && m.roundId === 'old:1');
    assert.equal(stops, 0);
    assert.equal(f.web.rooms.get(f.links.id).session, old);
  } finally { await f.close(); }
});

test('a new Discord starter updates creator identity without revoking participant controls', async () => {
  const f = await fixture();
  try {
    const oldHost = await f.join({ host: true });
    const session = { starterId: 'new-owner', textChannel: f.params.textChannel, voiceChannel: f.params.voiceChannel,
      events: new EventEmitter(), getWebState: () => ({ phase: 'question', roundId: 'new:1', scores: [], paused: false }), pause: () => ({ ok: true }) };
    f.events.emit('start', session);
    assert.equal((await oldHost.next('hostRole')).host, false);
    await oldHost.next('state');
    assert.throws(() => f.web.getHostLink(f.links.id, 'owner'), /방장만/);
    const url = f.web.getHostLink(f.links.id, 'new-owner');
    assert.notEqual(url, f.links.hostUrl);
    oldHost.send({ type: 'pause', roundId: 'new:1', phase: 'question' });
    oldHost.send({ type: 'ping', sentAt: 123 }); await oldHost.next('pong');
  } finally { await f.close(); }
});

test('ending a game while a replacement loads cancels the new launch', async () => {
  let release, launches = 0, running = true;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture({ busy: () => running, load: async () => { await pending; return { quiz: {}, questions: [] }; }, launch: async () => { launches++; } });
  const old = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
    getWebState: () => ({ phase: 'question', roundId: 'old:1', scores: [], paused: false }),
    requestStop: () => { running = false; f.events.emit('end', old); } };
  try {
    f.events.emit('start', old);
    const host = await f.join({ host: true });
    host.send({ type: 'replace', quizId: 'new' });
    await host.next(m => m.type === 'state' && m.preparing);
    host.send({ type: 'stop' });
    await host.next(m => m.type === 'state' && m.phase === 'finished');
    release();
    await host.next(m => m.type === 'state' && m.phase === 'finished' && !m.preparing);
    assert.equal(launches, 0);
  } finally { release(); await f.close(); }
});

test('ending a room game deletes its tracked private address replies once', async () => {
  const f = await fixture();
  let deleted = 0;
  try {
    const session = { voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
      getWebState: () => ({ phase: 'question', roundId: 'one', scores: [] }) };
    f.events.emit('start', session);
    f.web.trackRoomReply(f.links.id, async () => { deleted++; });
    f.events.emit('end', session);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deleted, 1);
    assert.equal(f.web.rooms.get(f.links.id).replyCleanups.size, 0);
    assert.equal((await fetch(f.links.shareUrl)).status, 200, 'web stays open for choosing another quiz');
  } finally { await f.close(); }
  assert.equal(deleted, 1);
});

test('lossless mode hides peer paths and lets all participants share playback controls', async () => {
  const stream = { id: '12345678-1234-1234-1234-123456789012', events: new EventEmitter(),
    status: { status: 'receiving', bytes: 1024, size: 8192, percent: 12 },
    ready: Promise.resolve({ duration: 300, sampleRate: 96000, bitDepth: 24 }) };
  const released = [], served = [];
  const library = { configured: async () => true, search: async () => [{ id: 'pick', title: '테스트 음악', size: 8192,
    filename: 'private\\song.flac', username: 'source-user', sampleRate: 96000, bitDepth: 24 }],
    acquire: async () => stream, release: async (id, room) => released.push({ id, room }), close: async () => {},
    serve: async (id, req, res) => { served.push(id); res.end('FLAC'); } };
  const f = await fixture({ lossless: library });
  try {
    const host = await f.join({ host: true }), guest = await f.join();
    const result = await (await fetch(`${f.links.shareUrl.replace('/r/', '/api/rooms/')}/tracks?q=song`)).json();
    assert.doesNotMatch(JSON.stringify(result), /source-user|private|filename/);
    guest.send({ type: 'listen', trackId: 'pick' });
    const initial = await host.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    const other = await guest.next(m => m.type === 'state' && m.phase === 'listen' && m.audio.startedAt);
    assert.equal(initial.audio.startedAt, other.audio.startedAt); assert.equal(initial.video, null);
    assert.equal(f.web.isWatchingGuild('test-guild'), true);
    const late = await f.join(); assert.equal(late.initialState.audio.startedAt, initial.audio.startedAt);
    assert.equal(await (await fetch(f.base + initial.audio.url)).text(), 'FLAC');
    assert.equal(served.length, 1);
    host.send({ type: 'pause', phase: 'listen', roundId: initial.roundId });
    const paused = await guest.next(m => m.type === 'state' && m.phase === 'listen' && m.paused);
    assert.ok(paused.audio.pausedAt);
    host.send({ type: 'audioSeek', phase: 'listen', roundId: 'stale', seconds: 20 });
    assert.match((await host.next('error')).message, /곡이 바뀌/);
    host.send({ type: 'audioSeek', phase: 'listen', roundId: initial.roundId, seconds: 20 });
    const sought = await guest.next(m => m.type === 'state' && m.audio?.startSeconds === 20);
    assert.equal(sought.paused, true);
    host.send({ type: 'stop', phase: 'listen', roundId: initial.roundId });
    await guest.next(m => m.type === 'state' && m.phase === 'waiting' && m.revision > sought.revision);
    assert.equal(released.length, 1); assert.equal((await fetch(f.base + initial.audio.url)).status, 404);
    assert.equal(f.web.isWatchingGuild('test-guild'), false);
  } finally { await f.close(); }
});

test('slow FLAC reception freezes the shared clock and resumes from the same position after refilling', async () => {
  const stream = { id: randomUUID(), events: new EventEmitter(), status: { bytes: 100_000, size: 2_000_000, status: 'receiving' }, ready: Promise.resolve({ duration: 200 }) };
  const f = await fixture({ lossless: { configured: async () => true, search: async () => [{ id: 'pick', title: 'song' }],
    acquire: async () => stream, release: async () => {}, close: async () => {} } });
  try {
    const a = await f.join({ host: true }), b = await f.join(); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    b.send({ type: 'listen', trackId: 'pick' }); await a.next(m => m.audio?.startedAt); await b.next(m => m.audio?.startedAt);
    const room = f.web.rooms.get(f.links.id); room.state.audio.startedAt = Date.now() - 9000;
    stream.events.emit('progress', { bytes: 100_000, size: 2_000_000, status: 'receiving' });
    const paused = await a.next(m => m.buffering), peer = await b.next(m => m.buffering);
    assert.equal(paused.paused, true); assert.deepEqual(paused.audio, peer.audio); assert.equal(room.audioTimer, null);
    const frozen = paused.audio.startSeconds + (paused.audio.pausedAt - paused.audio.startedAt) / 1000;
    b.send({ type: 'pause', phase: 'listen', roundId: paused.roundId }); assert.match((await b.next('error')).message, /자동 재개/);
    stream.events.emit('progress', { bytes: 500_000, size: 2_000_000, status: 'receiving' });
    const resumed = await a.next(m => m.phase === 'listen' && !m.paused && !m.buffering && m.revision > paused.revision);
    assert.equal(resumed.audio.startSeconds, frozen); assert.equal(resumed.audio.pausedAt, undefined);
    assert.ok(resumed.audio.startedAt >= resumed.serverTime); assert.deepEqual(resumed.audio, (await b.next(m => !m.paused && m.revision > peer.revision)).audio);
    b.send({ type: 'pause', phase: 'listen', roundId: resumed.roundId }); const manual = await b.next(m => m.paused && !m.buffering);
    stream.events.emit('progress', { bytes: 2_000_000, size: 2_000_000, status: 'complete' });
    const completed = await b.next(m => m.audio?.status === 'complete'); assert.equal(completed.paused, true); assert.equal(completed.audio.pausedAt, manual.audio.pausedAt);
  } finally { await f.close(); }
});

test('a Discord participant can start a quiz even when its original creator has left voice', async () => {
  const requested = []; let loads = 0;
  const f = await fixture({ requireDiscordIdentity: true, load: async () => { loads++; throw new Error('load reached'); } });
  f.params.voiceChannel.guild.members.fetch = async ({ user }) => { requested.push(user); return { displayName: '참가자', voice: { channelId: user === 'guest' ? 'voice' : null } }; };
  try {
    const link = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    const guest = await f.join({ joinToken: new URLSearchParams(new URL(link).hash.slice(1)).get('join') });
    guest.send({ type: 'start', quizId: 'quiz' }); assert.match((await guest.next('error')).message, /load reached/);
    assert.equal(loads, 1); assert.deepEqual(requested, ['guest', 'guest']); assert.equal(guest.identity.host, false);
  } finally { await f.close(); }
});

test('switching from lossless listening to a web video releases its temporary track', async () => {
  let released = 0;
  const stream = { id: '12345678-1234-1234-1234-123456789012', events: new EventEmitter(),
    status: { bytes: 1024, size: 8192 }, ready: Promise.resolve({ duration: 300 }) };
  const f = await fixture({ lossless: { configured: async () => true, search: async () => [{ id: 'pick', title: '곡' }],
    acquire: async () => stream, release: async () => { released++; }, close: async () => {} } });
  try {
    const host = await f.join({ host: true });
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    host.send({ type: 'listen', trackId: 'pick' }); await host.next(m => m.type === 'state' && m.phase === 'listen' && !m.preparing);
    host.send({ type: 'watch', url: 'https://youtu.be/M7lc1UVf-VE' });
    const watching = await host.next(m => m.type === 'state' && m.phase === 'watch' && !m.preparing);
    assert.equal(watching.audio, null); assert.equal(released, 1);
  } finally { await f.close(); }
});

function queueLibrary({ pendingId } = {}) {
  const picks = ['a', 'b', 'c'].map(id => ({ id, title: `Artist - Song ${id}`, filename: `Artist\\Song ${id}.flac`, username: 'private-peer', size: 8192, duration: 200 }));
  const streams = new Map(), acquired = [], released = []; let resolvePending;
  return { picks, streams, acquired, released, resolvePending: () => resolvePending(), configured: async () => true,
    search: async () => picks, close: async () => {},
    async acquire(pick, owner) {
      acquired.push({ id: pick.id, owner });
      if (pick.id === pendingId) await new Promise(resolve => { resolvePending = resolve; });
      if (!streams.has(pick.id)) streams.set(pick.id, { id: randomUUID(), events: new EventEmitter(), status: { status: 'complete', percent: 100, size: 8192, bytes: 8192 }, ready: Promise.resolve({ duration: 200 }) });
      return streams.get(pick.id);
    },
    release: async (id, owner) => { released.push({ id, owner }); },
  };
}
test('reservations are shared, prefetch only the next FLAC and transfer to synchronized playback', async () => {
  const library = queueLibrary(), f = await fixture({ lossless: library });
  try {
    const host = await f.join({ host: true }), guest = await f.join(); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    host.send({ type: 'listen', trackId: 'a' }); const first = await host.next(m => m.phase === 'listen' && m.audio?.startedAt && !m.preparing);
    guest.send({ type: 'queueAdd', kind: 'listen', trackId: 'b' }); await guest.next('queueAck');
    const queued = await guest.next(m => m.queue?.[0]?.status === 'ready');
    assert.doesNotMatch(JSON.stringify(queued), /private-peer|filename/);
    host.send({ type: 'queueAdd', kind: 'listen', trackId: 'c' }); await host.next('queueAck');
    assert.equal(library.acquired.filter(v => v.id === 'c').length, 0);
    host.send({ type: 'next', phase: 'listen', roundId: first.roundId });
    const next = await host.next(m => m.phase === 'listen' && m.audio?.id === library.streams.get('b')?.id && m.audio.startedAt && !m.preparing);
    const other = await guest.next(m => m.phase === 'listen' && m.audio?.id === next.audio.id && m.audio.startedAt && !m.preparing);
    assert.equal(next.audio.startedAt, other.audio.startedAt); assert.ok(next.audio.startedAt - next.serverTime <= 1000);
    assert.ok(library.released.some(v => v.id === first.audio.id)); assert.equal(next.queue[0].title, 'Artist - Song c');
    host.send({ type: 'stop', phase: 'listen', roundId: next.roundId }); const stopped = await host.next(m => m.phase === 'waiting' && m.revision > next.revision);
    assert.deepEqual(stopped.queue, []); assert.ok(library.released.some(v => v.owner.startsWith('queue:')));
  } finally { await f.close(); }
});
test('a finished web video automatically starts its FLAC reservation and keeps the room entry link', async () => {
  const library = queueLibrary(); let removedLinks = 0;
  const f = await fixture({ lossless: library, videoSearch: async () => [{ id: 'abcdefghijk', title: 'Short video', duration: 0.2 }] });
  try {
    const host = await f.join({ host: true }); f.web.trackRoomReply(f.links.id, () => { removedLinks++; });
    await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`); await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=song`);
    host.send({ type: 'watch', videoId: 'abcdefghijk' }); await host.next(m => m.phase === 'watch' && !m.preparing);
    host.send({ type: 'queueAdd', kind: 'listen', trackId: 'b' }); await host.next('queueAck');
    await host.next(m => m.phase === 'listen' && m.title === 'Artist - Song b' && m.audio.startedAt);
    assert.equal(removedLinks, 0);
  } finally { await f.close(); }
});
test('ending playback while a claimed reservation is still acquiring prevents a late start', async () => {
  const library = queueLibrary({ pendingId: 'b' }), f = await fixture({ lossless: library });
  try {
    const host = await f.join({ host: true }); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    host.send({ type: 'listen', trackId: 'a' }); const initial = await host.next(m => m.phase === 'listen' && m.audio?.startedAt && !m.preparing);
    host.send({ type: 'queueAdd', kind: 'listen', trackId: 'b' }); await host.next('queueAck');
    host.send({ type: 'next', phase: 'listen', roundId: initial.roundId }); const loading = await host.next(m => m.phase === 'loading');
    host.send({ type: 'start', quizId: 'test' }); assert.match((await host.next('error')).message, /이미 진행/);
    host.send({ type: 'stop', phase: 'loading', roundId: null }); await host.next(m => m.phase === 'waiting' && m.revision > loading.revision);
    library.resolvePending(); await new Promise(resolve => setTimeout(resolve, 25));
    const room = f.web.rooms.get(f.links.id); assert.equal(room.state.phase, 'waiting'); assert.equal(room.audioTrack, null);
    assert.equal(library.acquired.filter(v => v.id === 'b' && v.owner === f.links.id).length, 0);
    assert.ok(library.released.some(v => v.id === library.streams.get('b').id));
  } finally { library.resolvePending(); await f.close(); }
});
test('failed quiz loading keeps the current FLAC, its playback clock and the reservations intact', async () => {
  let rejectLoad;
  const library = queueLibrary(), f = await fixture({ lossless: library, load: () => new Promise((resolve, reject) => { rejectLoad = reject; }) });
  try {
    const host = await f.join({ host: true }); await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?q=song`);
    host.send({ type: 'listen', trackId: 'a' }); const first = await host.next(m => m.phase === 'listen' && m.audio?.startedAt && !m.preparing);
    host.send({ type: 'queueAdd', kind: 'listen', trackId: 'b' }); await host.next('queueAck');
    host.send({ type: 'start', quizId: 'test' });
    const loading = await host.next(m => m.preparing && m.phase === 'listen' && m.revision > first.revision && m.queue?.length === 1);
    assert.deepEqual(loading.audio, first.audio); assert.equal(loading.queue.length, 1);
    rejectLoad(new Error('퀴즈 검색 실패')); assert.match((await host.next('error')).message, /퀴즈 검색 실패/);
    const room = f.web.rooms.get(f.links.id); assert.equal(room.state.phase, 'listen'); assert.equal(room.starting, false);
    assert.equal(room.state.audio.startedAt, first.audio.startedAt); assert.equal(room.queue.size, 1);
    assert.equal(library.released.length, 0);
  } finally { rejectLoad?.(new Error('test finished')); await f.close(); }
});

test('YouTube-to-FLAC matching uses server metadata, protects peer details and never supplies a guess as an exact match', async () => {
  const queries = [];
  const f = await fixture({ videoSearch: async () => [{ id: 'abcdefghijk', title: '[MV] Artist - Song (Official Audio)', channel: 'Music', duration: 200 }],
    lossless: { configured: async () => true, search: async query => { queries.push(query); return [
      { id: 'right', title: 'Song', filename: 'Artist\\Song.flac', username: 'private-peer', duration: 200, size: 1000 },
      { id: 'wrong', title: 'Song Live', filename: 'Artist\\Song Live.flac', username: 'private-peer', duration: 200, size: 1000 },
    ]; }, close: async () => {}, release: async () => {} } });
  try {
    await fetch(`${f.base}/api/rooms/${f.links.id}/videos?q=song`);
    const result = await (await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=abcdefghijk`)).json();
    assert.deepEqual(queries, ['Artist Song', 'Song']); assert.equal(result.matchedId, 'right');
    assert.doesNotMatch(JSON.stringify(result), /private-peer|filename|username/);
    const unknown = await fetch(`${f.base}/api/rooms/${f.links.id}/tracks?video=unknown`); assert.equal(unknown.status, 502);
  } finally { await f.close(); }
});

test('Discord entry chooses the server nickname, ignores forged browser names and host tokens, and shares the Discord score identity', async () => {
  const f = await fixture({ requireDiscordIdentity: true }); let submitted;
  f.params.voiceChannel.guild.members.fetch = async ({ user }) => ({ displayName: user === 'owner' ? '방장 서버닉' : '참가자 서버닉', user: { id: user, bot: false }, voice: { channelId: 'voice' } });
  const token = url => new URLSearchParams(new URL(url).hash.slice(1)).get('join');
  try {
    const ownerUrl = await f.web.getDiscordJoinLink(f.links.id, 'owner', { guildId: 'test-guild' });
    const guestUrl = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    assert.notEqual(ownerUrl, guestUrl); assert.doesNotMatch(guestUrl, /host=|서버닉/);
    const owner = await f.join({ joinToken: token(ownerUrl), name: '위조한 이름' });
    const guest = await f.join({ joinToken: token(guestUrl), name: '위조한 이름', host: true, resumeToken: owner.identity.resumeToken });
    assert.equal(owner.identity.name, '방장 서버닉'); assert.equal(owner.identity.host, true);
    assert.equal(guest.identity.name, '참가자 서버닉'); assert.equal(guest.identity.host, false);
    const publicRoom = await (await fetch(`${f.base}/api/rooms/${f.links.id}`)).json();
    assert.equal(publicRoom.requireDiscordIdentity, true);
    assert.doesNotMatch(JSON.stringify(publicRoom), new RegExp(`${token(ownerUrl)}|${token(guestUrl)}|서버닉`));
    const session = { starterId: 'owner', voiceChannel: f.params.voiceChannel, events: new EventEmitter(),
      getWebState: () => ({ phase: 'question', roundId: 'round', scores: [] }), submitAnswer: data => { submitted = data; return { accepted: true, correct: true }; } };
    f.events.emit('start', session); await guest.next(m => m.phase === 'question');
    guest.send({ type: 'answer', content: '정답', roundId: 'round' }); await guest.next('answerAck');
    assert.equal(submitted.userId, 'guest'); assert.equal(submitted.name, '참가자 서버닉');
  } finally { await f.close(); }
});

test('re-entering with a changed Discord nickname updates the name without a duplicate player or score identity', async () => {
  const f = await fixture({ requireDiscordIdentity: true }); let nickname = '첫 닉네임';
  f.params.voiceChannel.guild.members.fetch = async () => ({ displayName: nickname, voice: { channelId: 'voice' }, user: { bot: false } });
  try {
    const firstUrl = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    const joinToken = new URLSearchParams(new URL(firstUrl).hash.slice(1)).get('join');
    const first = await f.join({ joinToken });
    nickname = '바뀐 서버닉';
    const nextUrl = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    assert.equal(nextUrl, firstUrl);
    const second = await f.join({ joinToken }); assert.equal(second.identity.name, nickname);
    assert.equal(second.identity.resumeToken, first.identity.resumeToken);
    assert.equal(f.web.rooms.get(f.links.id).players.size, 1); assert.equal(f.web.rooms.get(f.links.id).clients.size, 1);
  } finally { await f.close(); }
});

test('public room links, old host tokens and expired identity links cannot impersonate a Discord member', async () => {
  const f = await fixture({ requireDiscordIdentity: true });
  f.params.voiceChannel.guild.members.fetch = async () => ({ displayName: '닉네임', voice: { channelId: 'voice' } });
  try {
    const link = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    const joinToken = new URLSearchParams(new URL(link).hash.slice(1)).get('join');
    f.web.rooms.get(f.links.id).discordEntries.get(joinToken).expires = Date.now() - 1;
    for (const provided of [undefined, 'fake-token', joinToken]) {
      const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/socket?room=${f.links.id}`), next = inbox(ws);
      try {
        await new Promise(resolve => ws.once('open', resolve));
        ws.send(JSON.stringify({ type: 'join', joinToken: provided, name: '임의 이름', hostToken: f.links.hostUrl.split('#host=')[1] }));
        const error = await next('error'); assert.equal(error.code, 'DISCORD_JOIN_REQUIRED');
        assert.match(error.message, /웹방 입장/);
      } finally { ws.terminate(); }
    }
    assert.equal(f.web.rooms.get(f.links.id).players.size, 0);
  } finally { await f.close(); }
});

test('Discord identity links validate server membership, voice channel and optional owner control', async () => {
  const f = await fixture({ requireDiscordIdentity: true }); let fetches = 0, channelId = 'other';
  f.params.voiceChannel.guild.members.fetch = async () => { fetches++; return { user: { globalName: '프로필 이름' }, voice: { channelId } }; };
  try {
    await assert.rejects(f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'wrong' }), /이 디스코드 서버/);
    await assert.rejects(f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild', hostOnly: true }), /방장만/);
    assert.equal(fetches, 0);
    await assert.rejects(f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' }), /음성 채널/);
    channelId = 'voice'; const link = await f.web.getDiscordJoinLink(f.links.id, 'guest', { guildId: 'test-guild' });
    const guest = await f.join({ joinToken: new URLSearchParams(new URL(link).hash.slice(1)).get('join') });
    assert.equal(guest.identity.name, '프로필 이름');
    await assert.rejects(f.web.getDiscordJoinLink('missing', 'guest', { guildId: 'test-guild' }), /만료/);
  } finally { await f.close(); }
});
