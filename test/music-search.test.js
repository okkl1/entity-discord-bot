import test from 'node:test';
import assert from 'node:assert/strict';
import { musicSearchQueries, relatedMusicQueries, searchMusicTracks } from '../src/web/music-search.js';

test('Life is Wet and copied YouTube titles produce useful searches without promotional and featuring words', () => {
  assert.deepEqual(musicSearchQueries('Life is wet'), ['Life is wet', 'Life wet']);
  assert.deepEqual(musicSearchQueries('CAMO - Life is Wet (feat.JMIN) [Official Music Video]'), ['CAMO Life is Wet', 'Life is Wet']);
  assert.deepEqual(musicSearchQueries('CAMO “Life is Wet” (feat. JMIN) [MV]'), ['CAMO Life is Wet', 'Life is Wet']);
  assert.deepEqual(musicSearchQueries('Features'), ['Features']);
  assert.deepEqual(musicSearchQueries('Song (Features)'), ['Song Features']);
  assert.throws(() => musicSearchQueries(' '), /두 글자/);
});

test('a useful broader query returns without waiting for an unresponsive original query', async () => {
  const queries = [], signals = [];
  const hits = [{ id: 'life-wet', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', freeSlot: true }];
  const progress = [];
  const result = await searchMusicTracks('Life is Wet', (query, { signal, onProgress }) => {
    queries.push(query); signals.push(signal);
    if (query === 'Life is Wet') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    onProgress(hits); return Promise.resolve(hits);
  }, { onProgress: data => progress.push(data) });
  assert.deepEqual(queries, ['Life is Wet', 'Life Wet']); assert.equal(result.hits[0].id, hits[0].id);
  assert.equal(progress.find(data => data.hits.length).hits[0].id, hits[0].id); assert.equal(result.matchedId, undefined);
  assert.equal(result.hits[0].relatedLabel, '곡명 일치 · 가수 확인');
  assert.ok(signals.every(signal => signal.aborted));
});

test('manual discovery preserves real empty results, usable partial results and login errors', async () => {
  assert.deepEqual((await searchMusicTracks('Life is Wet', async () => [])).hits, []);
  const hits = [{ id: 'one', title: 'Life is Wet' }];
  assert.equal((await searchMusicTracks('Life is Wet', async query => { if (query.includes(' is ')) throw new Error('busy'); return hits; })).hits[0].id, hits[0].id);
  await assert.rejects(searchMusicTracks('Life is Wet', async () => { throw new Error('로그인 실패'); }), /로그인 실패/);
});

test('cancelling a manual search interrupts both query branches', async () => {
  const controller = new AbortController(), signals = [];
  const result = searchMusicTracks('Life is Wet', (query, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (signals.length === 2) controller.abort();
  }), { signal: controller.signal });
  await assert.rejects(result, { name: 'AbortError' }); assert.ok(signals.every(signal => signal.aborted));
});

const camoVideo = { title: 'CAMO - Life is Wet (feat.JMIN) [Official Music Video]', duration: 186 };

test('usable title results arrive while slow song identification is still pending', async () => {
  let cancelled = false;
  const result = await searchMusicTracks('Life is Wet', async (query, options) => {
    assert.equal(query, 'Life is Wet'); assert.equal(options.searchTimeoutMs, 4000);
    return [{ id: 'fast', title: 'Life is Wet', freeSlot: true }];
  }, { identifySong: (query, { signal }) => new Promise(resolve => { signal.addEventListener('abort', () => { cancelled = true; resolve(null); }); }) });
  assert.equal(result.hits[0].id, 'fast'); assert.equal(cancelled, true);
});

test('usable title results arrive while slow song identification is still pending', async () => {
  let cancelled = false;
  const result = await searchMusicTracks('Life is Wet', async (query, options) => {
    assert.equal(query, 'Life is Wet'); assert.equal(options.searchTimeoutMs, 4000);
    return [{ id: 'fast', title: 'Life is Wet', freeSlot: true }];
  }, { identifySong: (query, { signal }) => new Promise(resolve => { signal.addEventListener('abort', () => { cancelled = true; resolve(null); }); }) });
  assert.equal(result.hits[0].id, 'fast'); assert.equal(cancelled, true);
});

test('related queries recover the artist and discard unrelated video titles, bounded to four extra searches', () => {
  const queries = relatedMusicQueries('Life is Wet', [{ title: 'Different Artist - Completely Different Song' }, camoVideo]);
  assert.deepEqual(queries.slice(0, 2).map(item => item.query), ['CAMO Life is Wet', 'CAMO']);
  assert.equal(queries.length, 4);
  assert.ok(queries.every(item => !/feat|JMIN|Official|Different/i.test(item.query)));
  assert.equal(new Set(queries.map(item => item.query.toLowerCase())).size, queries.length);
  assert.ok(relatedMusicQueries('CAMO - Life is Wet')[0].query === 'CAMO');
  assert.ok(relatedMusicQueries('아이유 (IU) - 밤편지 (Through the Night)').some(item => item.query === 'IU'));
});

test('empty title searches expand to the recovered artist, rank the requested song first and never auto-select related songs', async () => {
  const exact = { id: 'exact', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', duration: 186, freeSlot: false };
  const other = { id: 'other', title: 'Different Song', filename: 'CAMO\\Different Song.flac', duration: 210, freeSlot: true };
  const queries = [], progress = []; let active = 0, maximum = 0;
  const result = await searchMusicTracks('Life is Wet', async (query, { onProgress }) => {
    queries.push(query); active++; maximum = Math.max(maximum, active); await new Promise(setImmediate); active--;
    const hits = query === 'CAMO' ? [other, exact, exact] : [];
    onProgress(hits); return hits;
  }, { discoverVideos: async () => [camoVideo], onProgress: data => progress.push(data) });
  assert.deepEqual(queries, ['Life is Wet', 'Life Wet', 'CAMO Life is Wet', 'CAMO']);
  assert.ok(maximum <= 2); assert.equal(result.stage, 'related');
  assert.deepEqual(result.hits.map(track => track.id), ['exact', 'other']);
  assert.equal(result.hits[0].relatedLabel, '곡명·가수 일치');
  assert.equal(result.hits[1].relatedLabel, '같은 가수의 연관 곡');
  assert.equal(result.matchedId, undefined); assert.equal(result.playableMatch, undefined);
  assert.ok(progress.some(data => data.stage === 'related' && !data.hits.length));
  assert.ok(progress.some(data => data.hits.length === 2));
});

test('without artist metadata the search tries partial title keywords rather than stopping at zero results', async () => {
  const queries = [];
  const result = await searchMusicTracks('Life is Wet', async query => {
    queries.push(query); return query === 'wet' ? [{ id: 'related', title: 'Wet Song', filename: 'Someone\\Wet Song.flac' }] : [];
  }, { discoverVideos: async () => { throw new Error('YouTube offline'); } });
  assert.ok(queries.includes('wet')); assert.ok(queries.length <= 6);
  assert.equal(result.hits[0].relatedLabel, '검색어 일부 일치'); assert.equal(result.matchedId, undefined);
});

test('a different song recovered from a partially related video is labelled as related, never as the requested exact song', async () => {
  const result = await searchMusicTracks('Life is Wet', async query => query === 'CAMO' ? [{ id: 'other', title: 'Another Life', filename: 'CAMO\\Another Life.flac' }] : [], {
    discoverVideos: async () => [{ title: 'CAMO - Another Life' }]
  });
  assert.equal(result.hits[0].relatedLabel, '같은 가수의 연관 곡'); assert.ok(result.hits[0].relatedScore < 100);
});

test('fast title results finish without waiting for or launching related searches', async () => {
  let discoveries = 0; const queries = [];
  const result = await searchMusicTracks('Life is Wet', async query => { queries.push(query); return [{ id: 'fast', title: 'Life is Wet' }]; }, {
    discoverVideos: () => { discoveries++; return new Promise(() => {}); }
  });
  assert.deepEqual(queries, ['Life is Wet', 'Life Wet']); assert.equal(result.stage, 'direct'); assert.equal(result.hits[0].id, 'fast');
  assert.equal(discoveries, 0);
});

test('an unresponsive metadata lookup has a bounded wait and still permits partial title search', async () => {
  let discoverySignal;
  const result = await searchMusicTracks('Life is Wet', async query => query === 'lifewet' ? [{ id: 'compact', title: 'LifeWet' }] : [], {
    discoveryMs: 10, discoverVideos: (query, { signal }) => { discoverySignal = signal; return new Promise(() => {}); }
  });
  assert.equal(result.hits[0].id, 'compact'); assert.equal(discoverySignal.aborted, true);
});

test('cancellation during related artist searches interrupts both branches and suppresses late progress', async () => {
  const controller = new AbortController(), relatedSignals = [], progress = [];
  await assert.rejects(searchMusicTracks('Life is Wet', (query, { signal, onProgress }) => {
    if (!query.startsWith('CAMO')) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      relatedSignals.push(signal); signal.addEventListener('abort', () => { onProgress([{ id: 'late' }]); reject(signal.reason); }, { once: true });
      if (relatedSignals.length === 2) controller.abort();
    });
  }, { signal: controller.signal, discoverVideos: async () => [camoVideo], onProgress: data => progress.push(data) }), { name: 'AbortError' });
  assert.ok(relatedSignals.every(signal => signal.aborted)); assert.ok(progress.every(data => !data.hits.length));
});

test('an empty related search reports attempted queries while authentication failures remain errors', async () => {
  const result = await searchMusicTracks('Life is Wet', async () => [], { discoverVideos: async () => [camoVideo] });
  assert.deepEqual(result.hits, []); assert.equal(result.searchedQueries.length, 6);
  await assert.rejects(searchMusicTracks('Life is Wet', async query => {
    if (query === 'Life is Wet') throw new Error('Soulseek 로그인 실패'); return [];
  }, { discoverVideos: async () => [camoVideo] }), /로그인 실패/);
  await assert.rejects(searchMusicTracks('Life is Wet', async query => {
    if (query.startsWith('CAMO')) throw new Error('Soulseek 인증 실패'); return [];
  }, { discoverVideos: async () => [camoVideo] }), /인증 실패/);
});

test('irrelevant early FLAC replies cannot cancel a slower branch with the requested artist and title', async () => {
  const queries = [], progress = [], cancelled = [];
  const wrong = Array.from({ length: 120 }, (_, index) => ({ id: `other-${index}`, title: `Other Song ${index}`, filename: `CAMO\\Other Song ${index}.flac`, freeSlot: true }));
  const exact = { id: 'wanted', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', freeSlot: false };
  const result = await searchMusicTracks('Life is Wet', async (query, { signal, onProgress, hasRelevantHits, acceptHits }) => {
    queries.push(query); signal.addEventListener('abort', () => cancelled.push(query), { once: true });
    if (query.startsWith('CAMO')) {
      assert.equal(hasRelevantHits(wrong), false); assert.equal(acceptHits(wrong), false); onProgress(wrong); return wrong;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(signal.aborted, false); assert.equal(hasRelevantHits([exact]), true); onProgress([exact]); return [exact];
  }, { artist: 'CAMO', onProgress: data => progress.push(data) });
  assert.deepEqual(queries, ['CAMO Life is Wet', 'Life is Wet']);
  assert.equal(result.hits.length, 100); assert.equal(result.hits[0].id, 'wanted');
  assert.equal(result.hits[0].relatedLabel, '곡명·가수 일치'); assert.equal(result.matchedId, undefined);
  assert.ok(progress.some(data => data.hits[0]?.id === 'wanted')); assert.equal(cancelled.length, 2);
});

test('bilingual artist searches retain a title-only fallback and do not stop on the artist catalogue', async () => {
  const queries = [], exact = { id: 'wanted', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac' };
  const result = await searchMusicTracks('CAMO (카모) - Life is Wet', async query => {
    queries.push(query);
    if (query === 'CAMO') return [{ id: 'related', title: 'Other Song', filename: 'CAMO\\Other Song.flac' }];
    if (query === 'Life is Wet') { await new Promise(resolve => setTimeout(resolve, 10)); return [exact]; }
    return [];
  });
  assert.deepEqual(queries, ['CAMO Life is Wet', '카모 Life is Wet', 'Life is Wet', 'CAMO']);
  assert.equal(result.hits[0].id, 'wanted'); assert.equal(result.hits[1].id, 'related');
});

test('same-title live recordings cannot finish discovery before the requested studio recording', async () => {
  const wrong = { id: 'live', title: 'Life is Wet Live', filename: 'CAMO\\Life is Wet Live.flac', freeSlot: true };
  const right = { id: 'studio', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac', freeSlot: true };
  const result = await searchMusicTracks('CAMO - Life is Wet', async (query, { signal, hasRelevantHits }) => {
    if (query.startsWith('CAMO')) { assert.equal(hasRelevantHits([wrong]), false); return [wrong]; }
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(signal.aborted, false); return [right];
  });
  assert.deepEqual(result.hits.map(track => track.id), ['studio', 'live']);
  assert.equal(result.hits[1].relatedLabel, '다른 버전일 수 있어요');
});

test('related catalogue hits continue to title keywords and filename spacing variants', async () => {
  const queries = [];
  const result = await searchMusicTracks('CAMO - Life is Wet', async query => {
    queries.push(query);
    if (query === 'CAMO') return [{ id: 'other', title: 'Other Song', filename: 'CAMO\\Other Song.flac' }];
    return query === 'lifewet' ? [{ id: 'spacing', title: 'LifeWet', filename: 'CAMO\\LifeWet.flac' }] : [];
  });
  assert.ok(queries.includes('lifewet')); assert.ok(queries.length <= 6);
  assert.equal(result.hits[0].id, 'spacing'); assert.equal(result.hits[1].id, 'other');
});

test('unrelated substrings remain uncertain choices while Korean titles and accent differences rank as relevant', async () => {
  const wrong = await searchMusicTracks('wet', async () => [{ id: 'unrelated', title: 'Sweater' }]);
  assert.equal(wrong.hits[0].relatedScore, 0); assert.equal(wrong.hits[0].relatedLabel, '관련성 확인 필요');
  const korean = await searchMusicTracks('밤편지', async () => [{ id: 'korean', title: '아이유 밤편지' }]);
  assert.equal(korean.hits[0].id, 'korean');
  const accents = await searchMusicTracks('Beyoncé - Déjà Vu', async () => [{ id: 'accent', title: 'Deja Vu', filename: 'Beyonce\\Deja Vu.flac' }]);
  assert.equal(accents.hits[0].id, 'accent');
});
