import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyMusicSong, createMusicIdentityLookup, readVideoMusicMetadata } from '../src/web/music-identity.js';
import { songFromVideo } from '../src/web/track-match.js';
import { searchMusicTracks, musicSearchQueries } from '../src/web/music-search.js';

const video = { id: 'vadat46yfwg', title: 'CAMO - Life is Wet (feat. JMIN) [Official Music Video]', channel: '502', duration: 181 };

test('real public title formats resolve artist and song separately without retaining promotional or lyric suffixes', () => {
  const identity = identifyMusicSong('Life is Wet', [video]);
  assert.equal(identity.artist, 'CAMO'); assert.equal(identity.track, 'Life is Wet');
  assert.equal(identifyMusicSong('CAMO Life is Wet', [video]).artist, 'CAMO');
  assert.equal(identifyMusicSong('Life Wet', [video]).track, 'Life is Wet');
  const lyric = songFromVideo({ title: 'CAMO (카모) - Life is Wet (Feat. JMIN) l Lyrics / 가사' });
  assert.equal(lyric.title, 'Life is Wet'); assert.deepEqual(lyric.artistAliases, ['CAMO', '카모']);
  assert.deepEqual(musicSearchQueries('“Life is Wet” by CAMO [Official Audio]'), ['CAMO Life is Wet', 'Life is Wet']);
  assert.equal(songFromVideo({ title: 'Death by a Thousand Cuts' }).artist, '');
  assert.equal(identifyMusicSong('Life is Wet by CAMO', [video]).artist, 'CAMO');
});

test('identity lookup rejects wrong artists, partial title overlap and arbitrary uploader channels', () => {
  assert.equal(identifyMusicSong('Life is Wet', [{ title: 'CAMO - Another Life' }]), null);
  assert.equal(identifyMusicSong('IU - Life is Wet', [video]), null);
  assert.equal(identifyMusicSong('Life is Wet', [{ title: 'Life is Wet', channel: 'Some Music Label' }]), null);
  assert.equal(identifyMusicSong('Life is Wet', [{ title: 'Life is Wet', channel: 'CAMO - Topic' }]).artist, 'CAMO');
  assert.equal(identifyMusicSong('Life is Wet', [{ title: 'CAMO - Life is Wet LIVE at HIPHOPPLAYA FESTIVAL 2026' }]), null);
});

test('corroborated bilingual artist spellings become separate native searches without inventing a translation', () => {
  const result = identifyMusicSong('Life is Wet', [video, { ...video, title: 'CAMO (카모) - Life is Wet (Feat. JMIN) l Lyrics / 가사' }, { ...video, title: 'Other Artist - Life is Wet' }]);
  assert.equal(result.artist, 'CAMO (카모)');
  assert.deepEqual(musicSearchQueries(result.track, result.artist), ['CAMO Life is Wet', '카모 Life is Wet']);
});

test('flat titles missing the artist receive one full metadata lookup for the same video', async () => {
  const calls = [];
  const identify = createMusicIdentityLookup(async (query, options) => {
    calls.push({ query, metadata: options?.metadata });
    return options?.metadata ? [{ ...video, title: 'Life is Wet', artist: 'CAMO', track: 'Life is Wet' }]
      : [{ ...video, title: 'Life is Wet', channel: '502' }];
  });
  const result = await identify('Life is Wet [Official Music Video]');
  assert.equal(result.artist, 'CAMO'); assert.equal(result.track, 'Life is Wet');
  assert.deepEqual(calls.map(call => call.query), ['Life is Wet', 'https://www.youtube.com/watch?v=vadat46yfwg']);
  assert.equal(calls[1].metadata, true);
});

test('the first native queries use recovered artist and track, never the raw promotional YouTube title', async () => {
  const queries = [], progress = [];
  const result = await searchMusicTracks('Life is Wet (feat. JMIN) [Official Music Video]', async query => {
    queries.push(query); return query === 'CAMO Life is Wet' ? [{ id: 'one', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac' }] : [];
  }, { identifySong: createMusicIdentityLookup(async () => [video]), onProgress: data => progress.push(data) });
  assert.equal(progress[0].stage, 'identity'); assert.deepEqual(queries, ['Life is Wet', 'CAMO Life is Wet']);
  assert.deepEqual(result.identity, { artist: 'CAMO', title: 'Life is Wet' });
  assert.equal(result.hits[0].relatedLabel, '곡명·가수 일치'); assert.equal(result.matchedId, undefined);
});

test('a directly entered artist bypasses remote identification and handles short song titles and duplicate artist prefixes', async () => {
  const queries = []; let lookups = 0;
  const result = await searchMusicTracks('CAMO Life is Wet', async query => { queries.push(query); return [{ id: 'one', title: 'Life is Wet', filename: 'CAMO\\Life is Wet.flac' }]; }, {
    artist: 'CAMO', identifySong: async () => { lookups++; throw Error('must not run'); }
  });
  assert.equal(lookups, 0); assert.deepEqual(queries, ['CAMO Life is Wet', 'Life is Wet']);
  assert.equal(result.identity.title, 'Life is Wet');
  assert.deepEqual(musicSearchQueries('I', 'TAEYEON'), ['TAEYEON I']);
});

test('failed or timed-out song identification falls back to cleaned title searches and cancellation starts no native search', async () => {
  const queries = [];
  await searchMusicTracks('Life is Wet', async query => { queries.push(query); return [{ id: 'one', title: 'Life is Wet' }]; }, {
    identifySong: async () => { throw Error('metadata unavailable'); }
  });
  assert.deepEqual(queries, ['Life is Wet', 'Life Wet']);
  const timed = await searchMusicTracks('Life is Wet', async () => [{ id: 'one', title: 'Life is Wet' }], { discoveryMs: 10, identifySong: () => new Promise(() => {}) });
  assert.equal(timed.hits[0].id, 'one');
  const controller = new AbortController(); let started = 0;
  await assert.rejects(searchMusicTracks('Life is Wet', async () => { started++; return []; }, {
    signal: controller.signal, identifySong: async () => { controller.abort(); return video; }
  }), { name: 'AbortError' });
  assert.ok(started <= 1, 'cancellation stops the speculative title lookup before additional searches');
});

test('video metadata lookup is bounded, ignores foreign ids and honors a cancelled request', async () => {
  assert.equal(await readVideoMusicMetadata(video, async () => [{ ...video, id: 'abcdefghijk' }]), null);
  assert.equal(await readVideoMusicMetadata(video, () => new Promise(() => {}), { timeoutMs: 10 }), null);
  const controller = new AbortController();
  await assert.rejects(readVideoMusicMetadata(video, async () => { controller.abort(); return [video]; }, { signal: controller.signal }), { name: 'AbortError' });
});
