import test from 'node:test';
import assert from 'node:assert/strict';
import { SoulseekClient } from '../src/web/soulseek-client.js';
import { searchMusicTracks } from '../src/web/music-search.js';
import { matchTracks } from '../src/web/track-match.js';

test('related expansion uses the real client lifecycle without exceeding two native searches, and cached choices remain usable', async () => {
  const subscriptions = new Map(), stopped = new Set(), active = new Set(), queries = [], timers = new Set();
  let maximum = 0;
  const client = new SoulseekClient({ baseUrl: 'http://offline-test', apiKey: 'test-only', searchMs: 80, pollMs: 5,
    minSearchMs: 15, settleMs: 5, minHits: 2,
    searchEvents: { subscribe: async (id, handler) => { subscriptions.set(id, handler); return () => { subscriptions.delete(id); active.delete(id); }; }, close() {} },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace('/api/v0', ''), id = route.split('/')[2]; let value = {};
      if (route === '/server') value = { isLoggedIn: true };
      else if (route === '/searches' && options.method === 'POST') {
        const body = JSON.parse(options.body); queries.push(body.searchText); active.add(body.id); maximum = Math.max(maximum, active.size);
        if (body.searchText === 'CAMO') {
          const timer = setTimeout(() => {
            timers.delete(timer); subscriptions.get(body.id)?.({ username: 'private-peer', hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 100,
              files: ['Life is Wet', 'Other Song'].map(title => ({ filename: `CAMO\\${title}.flac`, size: 8192, length: 186 })) });
          }, 8); timers.add(timer);
        }
      } else if (options.method === 'PUT') { stopped.add(id); active.delete(id); }
      else if (route.endsWith('/responses')) value = [];
      else if (options.method === 'GET') value = { endedAt: stopped.has(id) ? 'now' : null };
      return new Response(JSON.stringify(value));
    } });
  const discovery = { discoverVideos: async () => [{ title: 'CAMO - Life is Wet [MV]', duration: 186 }] };
  try {
    const result = await searchMusicTracks('Life is Wet', (...args) => client.search(...args), discovery);
    assert.equal(maximum, 2); assert.deepEqual(queries, ['Life is Wet', 'Life Wet', 'CAMO Life is Wet', 'CAMO']);
    assert.deepEqual(result.hits.map(track => track.title), ['Life is Wet', 'Other Song']);
    assert.equal(result.hits[0].relatedLabel, '곡명·가수 일치'); assert.equal(result.hits[1].relatedLabel, '같은 가수의 연관 곡');
    const cached = await searchMusicTracks('life IS wet', (...args) => client.search(...args), discovery);
    assert.deepEqual(cached.hits.map(track => track.id), result.hits.map(track => track.id));
    assert.equal(queries.filter(query => query === 'CAMO').length, 1, 'the artist result is served from the shared cache');
    assert.equal(client.pending.size, 0);
  } finally { client.close(); for (const timer of timers) clearTimeout(timer); await Promise.allSettled([...client.cleanups]); }
});

test('a large artist response is ranked before the display limit for manual discovery and YouTube matching', async () => {
  const subscriptions = new Map(), stopped = new Set();
  const responses = [
    { username: 'fast-peer', hasFreeUploadSlot: true, queueLength: 0, files: Array.from({ length: 1500 }, (_, index) => ({ filename: `CAMO\\Other ${index}.flac`, size: 8192 })) },
    { username: 'queued-peer', hasFreeUploadSlot: false, queueLength: 10, files: [{ filename: 'CAMO\\Life is Wet.flac', size: 8192, length: 186 }] }
  ];
  const client = new SoulseekClient({ baseUrl: 'http://offline-test', apiKey: 'test-only', searchMs: 20, pollMs: 5,
    searchEvents: { subscribe: async (id, handler) => { subscriptions.set(id, handler); return () => subscriptions.delete(id); }, close() {} },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname.replace('/api/v0', ''), id = route.split('/')[2]; let value = {};
      if (route === '/server') value = { isLoggedIn: true };
      else if (route === '/searches' && options.method === 'POST') {
        const body = JSON.parse(options.body); for (const peer of responses) subscriptions.get(body.id)?.(peer);
      } else if (options.method === 'PUT') stopped.add(id);
      else if (route.endsWith('/responses')) value = responses;
      else if (options.method === 'GET') value = { endedAt: stopped.has(id) ? 'now' : null };
      return new Response(JSON.stringify(value));
    } });
  try {
    const result = await searchMusicTracks('Life is Wet', (...args) => client.search(...args), { artist: 'CAMO' });
    assert.equal(result.hits.length, 100); assert.equal(result.hits[0].title, 'Life is Wet');
    assert.equal(result.hits[0].freeSlot, false); assert.equal(result.hits[0].relatedLabel, '곡명·가수 일치');
    const nativeHits = await client.search('CAMO Life is Wet'); assert.equal(nativeHits.length, 1501);
    const matched = matchTracks({ artist: 'CAMO', track: 'Life is Wet', duration: 186 }, nativeHits);
    assert.equal(matched.hits[0].title, 'Life is Wet'); assert.equal(matched.hits[0].confident, true);
    assert.equal(matched.playableMatch, false);
  } finally { client.close(); await Promise.allSettled([...client.cleanups]); }
});
