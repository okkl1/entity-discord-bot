import test from 'node:test';
import assert from 'node:assert/strict';
import { songFromVideo, matchTracks, searchMatchedTracks } from '../src/web/track-match.js';

test('Life is Wet without featuring credits in the FLAC filename is a valid match, but a different recording is not', () => {
  const video = { title: 'CAMO - Life is Wet (feat.JMIN) [Official Music Video]', duration: 186 };
  const song = songFromVideo(video); assert.equal(song.query, 'CAMO Life is Wet'); assert.equal(song.fallback, 'Life is Wet');
  const good = { id: 'original', title: 'Life is Wet', filename: 'CAMO\\Singles\\Life is Wet.flac', duration: 186, freeSlot: true };
  const wrong = { ...good, id: 'wrong', filename: 'Someone Else\\Life is Wet.flac' };
  const live = { ...good, id: 'live', title: 'Life is Wet Live', filename: 'CAMO\\Life is Wet Live.flac' };
  const result = matchTracks(video, [wrong, live, good]);
  assert.equal(result.matchedId, 'original'); assert.equal(result.playableMatch, true);
  assert.equal(result.hits.find(hit => hit.id === 'wrong').confident, false);
  assert.equal(result.hits.find(hit => hit.id === 'live').confident, false);
  assert.equal(matchTracks({ title: 'Life is Wet', channel: 'Lyrics Channel' }, [good]).matchedId, null);
});

test('an available matching recording is selected ahead of a higher-scoring queued copy', () => {
  const base = { title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac' };
  const result = matchTracks({ title: 'CAMO - Life is Wet', duration: 186 }, [
    { ...base, id: 'queued', duration: 186, freeSlot: false }, { ...base, id: 'available', duration: null, freeSlot: true },
  ]);
  assert.equal(result.matchedId, 'available'); assert.equal(result.playableMatch, true);
  assert.equal(matchTracks({ title: 'CAMO - Life is Wet' }, [{ ...base, id: 'queued', freeSlot: false }]).playableMatch, false);
});

test('progress from both song spellings keeps matching labels and merges candidates before either search completes', async () => {
  const progress = [];
  const result = await searchMatchedTracks({ title: 'IU(아이유) _ Good Day(좋은 날)' }, async (query, options) => {
    const track = query.includes('아이유') ? { id: 'kr', title: '좋은 날', filename: '아이유\\좋은 날.flac' }
      : { id: 'en', title: 'Good Day Live', filename: 'IU\\Good Day Live.flac' };
    options.onProgress([track]); return [track];
  }, { onProgress: data => progress.push(data) });
  assert.equal(progress.length, 2);
  assert.equal(progress[0].matchedId, null); assert.equal(progress[1].matchedId, 'kr');
  assert.deepEqual(new Set(progress[1].hits.map(track => track.id)), new Set(['kr', 'en']));
  assert.equal(result.matchedId, 'kr');
});

test('YouTube song queries remove promotional tags and preserve recording versions and Unicode titles', () => {
  assert.equal(songFromVideo({ title: "[MV] IU - '좋은 날' (Official Music Video)", channel: '1theK' }).query, 'IU 좋은 날');
  assert.equal(songFromVideo({ title: 'Artist — Song [4K]', channel: 'Music' }).query, 'Artist Song');
  assert.equal(songFromVideo({ title: 'Song', channel: 'Artist - Topic' }).query, 'Artist Song');
  assert.equal(songFromVideo({ title: 'Ignored title', artist: 'Artist', track: 'Song' }).query, 'Artist Song');
  assert.ok(songFromVideo({ title: 'Artist - Song (Live)', channel: '' }).versions.includes('live'));
  assert.deepEqual(songFromVideo({ title: 'Olivia - Alive', channel: '' }).versions, []);
  assert.throws(() => songFromVideo({ title: '유튜브 링크 영상' }), /곡 제목/);
  const bilingual = songFromVideo({ title: '[MV] IU(아이유) _ Good Day(좋은 날)', channel: '1theK' });
  assert.equal(bilingual.query, 'IU Good Day'); assert.equal(bilingual.alternate, '아이유 좋은 날');
  assert.equal(matchTracks({ title: 'IU(아이유) _ Good Day(좋은 날)' }, [{ id: 'kr', title: '좋은 날', filename: '아이유\\좋은 날.flac' }]).matchedId, 'kr');
});
test('matching prefers the same artist, title, duration and version instead of the fastest wrong file', () => {
  const video = { title: 'Artist - Song (Official Audio)', duration: 200 };
  const base = { title: '01 Song', filename: 'Artist\\Album\\01 Song.flac', duration: 202, freeSlot: false, queueLength: 10 };
  const result = matchTracks(video, [
    { ...base, id: 'live', title: 'Song Live', filename: 'Artist\\Song Live.flac', freeSlot: true },
    { ...base, id: 'different-artist', filename: 'Someone Else\\Song.flac', freeSlot: true },
    { ...base, id: 'short-clip', duration: 30, freeSlot: true },
    { ...base, id: 'correct' },
    { ...base, id: 'remix', filename: 'Artist\\Song Remix.flac', title: 'Song Remix' },
  ]);
  assert.equal(result.matchedId, 'correct'); assert.equal(result.hits[0].id, 'correct');
  assert.equal(result.hits.find(t => t.id === 'live').confident, false);
  assert.equal(result.hits.find(t => t.id === 'different-artist').confident, false);
  assert.equal(result.hits.find(t => t.id === 'short-clip').confident, false);
});
test('ambiguous candidates never trigger automatic playback, while availability breaks equal identity scores', () => {
  const video = { title: 'Artist - Song', duration: 200 };
  assert.equal(matchTracks(video, [{ id: 'ambiguous', title: 'Song', filename: 'Unknown\\Song.flac' }]).matchedId, null);
  assert.equal(matchTracks(video, []).matchedId, null);
  const candidates = [{ id: 'queued', title: 'Song', filename: 'Artist\\Song.flac', freeSlot: false },
    { id: 'free', title: 'Song', filename: 'Artist\\Song.flac', freeSlot: true }];
  assert.equal(matchTracks(video, candidates).matchedId, 'free');
  assert.equal(matchTracks(video, [{ id: 'different-title', title: 'Songwriter', filename: 'Artist\\Songwriter.flac', duration: 200 }]).matchedId, null);
});

test('both known song spellings search together and a fast exact FLAC cancels the slower spelling', async () => {
  const queries = [], signals = [];
  const result = await searchMatchedTracks({ title: 'IU(아이유) _ Good Day(좋은 날)', duration: 200 }, async (query, options) => {
    queries.push(query); signals.push(options.signal);
    if (query === 'IU Good Day') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    const hits = [{ id: 'kr', title: '좋은 날', filename: '아이유\\좋은 날.flac', duration: 200, freeSlot: true }];
    assert.equal(options.acceptHits(hits), true); return hits;
  });
  assert.deepEqual(queries, ['IU Good Day', '아이유 좋은 날']); assert.equal(result.matchedId, 'kr');
  assert.ok(signals.every(signal => signal.aborted));
});

test('parallel spellings merge uncertain candidates and preserve exact-match checks when one search fails', async () => {
  const video = { title: 'IU(아이유) _ Good Day(좋은 날)' };
  const unknown = { id: 'maybe', title: 'Good Day', filename: 'Unknown\\Good Day.flac', freeSlot: true };
  const queued = { id: 'kr', title: '좋은 날', filename: '아이유\\좋은 날.flac', freeSlot: false };
  const merged = await searchMatchedTracks(video, async query => query.includes('IU') ? [unknown] : [queued]);
  assert.equal(merged.matchedId, 'kr'); assert.equal(merged.hits.length, 2);
  const partial = await searchMatchedTracks(video, async query => { if (query.includes('IU')) throw new Error('busy'); return [unknown]; });
  assert.equal(partial.matchedId, null); assert.equal(partial.hits[0].id, 'maybe');
  await assert.rejects(searchMatchedTracks(video, async () => { throw new Error('Soulseek login failed'); }), /Soulseek login failed/);
});

test('a cancelled YouTube match cancels both spellings and an already cancelled search does not start', async () => {
  const controller = new AbortController(); let started = 0;
  const result = searchMatchedTracks({ title: 'IU(아이유) _ Good Day(좋은 날)' }, (query, { signal }) => new Promise((resolve, reject) => {
    started++; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (started === 2) controller.abort();
  }), { signal: controller.signal });
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(started, 2);
  await assert.rejects(searchMatchedTracks({ title: 'Artist - Song' }, () => { started++; }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(started, 2);
});
