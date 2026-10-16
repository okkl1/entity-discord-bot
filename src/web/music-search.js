import { songFromVideo, shorterMusicQuery, matchTracks } from './track-match.js';
import { topResults } from './top-results.js';
const compareRelated = (a, b) => (b.relatedScore ?? 90) - (a.relatedScore ?? 90) || Number(b.freeSlot) - Number(a.freeSlot) || (a.queueLength || 0) - (b.queueLength || 0) || (b.uploadSpeed || 0) - (a.uploadSpeed || 0);

const words = text => String(text ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const key = text => words(text).toLowerCase();
const folded = text => key(text).normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
const terms = text => key(text).split(' ').filter(term => term && !/^(?:a|an|the|is|and|of|to|in|on|at|for|with)$/i.test(term));
const coverage = (wanted, actual) => {
  const tokens = terms(folded(wanted)), text = folded(actual), actualTokens = text.split(' ');
  const compact = tokens.join('');
  for (let index = 0; compact && index < actualTokens.length; index++) {
    let joined = '';
    for (let end = index; end < actualTokens.length && joined.length <= compact.length; end++) {
      joined += actualTokens[end]; if (joined === compact) return 1;
    }
  }
  return tokens.length ? tokens.filter(term => actualTokens.includes(term) || /[가-힣]/.test(term) && term.length >= 2 && text.includes(term)).length / tokens.length : 0;
};

function inputSong(input, artist = '') {
  if (!String(input ?? '').trim() || key(`${artist} ${input}`).length < 2) throw new Error('가수나 곡 제목을 두 글자 이상 입력해주세요.');
  const parsed = artist.trim() && key(input).length < 2 ? songFromVideo({ artist, track: input }) : songFromVideo({ title: String(input ?? '') });
  if (!artist.trim()) return parsed;
  let title = parsed.title;
  if (!parsed.artist && key(title).startsWith(key(artist) + ' ')) title = words(title).slice(words(artist).length).trim();
  return songFromVideo({ artist, track: title });
}
const queriesFor = song => [...new Set([song.query, song.alternate || song.fallback || shorterMusicQuery(song.query)].filter(query => query?.length >= 2))];
export function musicSearchQueries(input, artist = '') {
  const song = inputSong(input, artist);
  return queriesFor(song);
}

// Keep two native searches per wave. Reserve room for a title-only search even
// when English/Korean artist variants occupied both initial search slots.
export function relatedMusicQueries(input, videos = []) {
  const original = songFromVideo({ title: input }), seen = new Set(musicSearchQueries(input).map(key)), queries = [];
  const add = (query, song, kind) => {
    query = words(query).slice(0, 120);
    if (query.length < 2 || seen.has(key(query))) return;
    seen.add(key(query)); queries.push({ query, song, kind });
  };
  const artistQueries = song => {
    for (const title of song.titleAliases) add(title, song, 'title');
    if (song.artistAliases[0]) add(song.artistAliases[0], song, 'artist');
    const shorter = shorterMusicQuery(song.titleAliases[0]);
    if (shorter) add(shorter, song, 'title');
    for (const artist of song.artistAliases) {
      add(artist, song, 'artist');
      const title = shorter || terms(song.title).filter(term => term.length >= 3).at(-1);
      if (title) add(`${artist} ${title}`, song, 'title');
    }
    const plain = folded(song.titleAliases[0]);
    if (plain !== key(song.titleAliases[0])) add(plain, song, 'title');
  };
  if (original.artist) artistQueries(original);
  const candidates = videos.flatMap(video => {
    try {
      const song = songFromVideo(video), relevance = coverage(original.query, `${song.artist} ${song.title}`);
      if (!song.artist || relevance < 0.5 || original.artist && coverage(original.artist, song.artist) < 0.5) return [];
      return [{ song, relevance }];
    } catch { return []; }
  }).sort((a, b) => b.relevance - a.relevance).slice(0, 2);
  for (const { song } of candidates) {
    add(song.query, song, 'video');
    // Prefer the artist-only form over another near-identical long title.
    for (const artist of song.artistAliases) add(artist, song, 'artist');
  }
  const meaningful = terms(original.title).filter(term => term.length >= 2);
  if (meaningful.length > 1) {
    add(meaningful.join(''), original, 'title');
    if (meaningful.length > 2) {
      add(meaningful.slice(0, -1).join(' '), original, 'title');
      add(meaningful.slice(1).join(' '), original, 'title');
    }
    for (const term of [...meaningful].sort((a, b) => b.length - a.length)) if (term.length >= 3) add(term, original, 'title');
  }
  return queries.slice(0, 4);
}

function relatedTrack(track, descriptor, original) {
  const filename = track.filename || track.title;
  const titleScore = Math.max(...original.titleAliases.map(title => coverage(title, track.title || filename)));
  const sameArtist = descriptor.song.artistAliases.some(artist => coverage(artist, filename) === 1);
  if (titleScore === 1 && sameArtist) {
    const compared = matchTracks({ artist: original.artist || descriptor.song.artist, track: original.title, duration: original.duration }, [track]).hits[0];
    if (compared?.confident) return { relatedScore: 100, relatedLabel: '곡명·가수 일치', relatedArtist: descriptor.song.artistAliases[0] };
    if (compared?.matchLabel === '다른 버전일 수 있어요') return { relatedScore: 55,
      relatedLabel: compared.matchLabel, relatedArtist: descriptor.song.artistAliases[0] };
  }
  return { relatedScore: Math.round(50 * titleScore + (sameArtist ? 35 : 0)),
    relatedArtist: sameArtist ? descriptor.song.artistAliases[0] : undefined,
    relatedLabel: sameArtist ? titleScore === 1 ? '같은 가수 · 곡명 유사' : '같은 가수의 연관 곡'
      : titleScore === 1 ? '곡명 일치 · 가수 확인' : titleScore > 0 ? '검색어 일부 일치' : '관련성 확인 필요' };
}

const relevantTitle = (track, descriptor, original) => {
  const title = track.title || track.filename;
  const titleMatches = original.titleAliases.some(alias => coverage(alias, title) === 1);
  const artistMatches = descriptor.song.artistAliases.some(alias => coverage(alias, track.filename || title) === 1);
  if (!titleMatches || descriptor.song.artist && !artistMatches) return false;
  const actual = songFromVideo({ artist: descriptor.song.artist, track: title }).versions;
  const versionMatches = original.versions.every(version => actual.includes(version)) && actual.every(version => original.versions.includes(version));
  const durationMatches = !original.duration || !track.duration || Math.abs(original.duration - track.duration) <= Math.max(8, original.duration * 0.07);
  return versionMatches && durationMatches;
};

// Optional metadata runs alongside the first search, has a bounded wait and
// cannot keep a cancelled browser search alive or hide a Soulseek login error.
function discoverWithin(discoverVideos, input, signal, timeoutMs) {
  if (!discoverVideos) return { promise: Promise.resolve([]), start() {}, close() {} };
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let start;
  const promise = new Promise(resolve => {
    let finished = false, started = false, deadline;
    const finish = videos => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(deadline); combined.removeEventListener('abort', abort); resolve(Array.isArray(videos) ? videos : []); };
    const abort = () => finish([]);
    start = () => {
      if (finished || started) return;
      started = true; clearTimeout(timer);
      deadline = setTimeout(() => controller.abort(), timeoutMs);
      Promise.resolve().then(() => { combined.throwIfAborted(); return discoverVideos(input, { signal: combined }); }).then(finish, () => finish([]));
    };
    // Most useful cached/streamed title hits arrive before this. Avoid launching
    // yt-dlp at all for those requests, while overlapping genuinely empty ones.
    const timer = setTimeout(start, 750);
    combined.addEventListener('abort', abort, { once: true });
    if (combined.aborted) return abort();
  });
  return { promise, start: () => start(), close() { controller.abort(); } };
}

// The user selects a manual search result. Broader queries aid discovery, but
// never trigger automatic playback or bypass the YouTube identity comparison.
export async function searchMusicTracks(input, search, { signal, onProgress, discoverVideos, discoveryMs = 6000, artist = '', identifySong, initialHits = [], skipQueries = [] } = {}) {
  signal?.throwIfAborted();
  let original = inputSong(input, artist), queries = queriesFor(original), identity;
  const partial = new Map(initialHits.length ? [['initial', initialHits]] : []), searchedQueries = [...skipQueries], errors = [];
  let discovery, stage = 'direct', successes = 0;
  const combine = () => {
    const unique = new Map();
    for (const track of [...partial.values()].flat()) {
      const previous = unique.get(track.id);
      if (!previous || (track.relatedScore ?? 90) > (previous.relatedScore ?? 90)) unique.set(track.id, track);
    }
    return topResults(unique.values(), compareRelated);
  };
  const result = () => ({ query: queries[0], stage, identity, searchedQueries: [...searchedQueries], hits: combine() });
  const completedQueries = new Set(skipQueries);
  const wave = async (descriptors, parentSignal = signal) => {
    if (!descriptors.length) return;
    const jobs = descriptors.map(descriptor => {
      searchedQueries.push(descriptor.query);
      const controller = new AbortController(), combined = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
      const relevance = new WeakMap(), scores = new WeakMap();
      const relevant = track => {
        if (!relevance.has(track)) relevance.set(track, relevantTitle(track, descriptor, original));
        return relevance.get(track);
      };
      const hasRelevantHits = hits => hits.some(relevant);
      const accept = hits => {
        if (combined.aborted) return;
        if (stage === 'direct' && hasRelevantHits(hits)) discovery?.close();
        function* ranked() {
          for (const track of hits) {
            if (!scores.has(track)) scores.set(track, relatedTrack(track, descriptor, original));
            yield { ...track, ...scores.get(track) };
          }
        }
        partial.set(descriptor.query, topResults(ranked(), compareRelated));
        onProgress?.(result());
      };
      return { controller, hasRelevantHits, promise: Promise.resolve().then(async () => {
        const hits = await search(descriptor.query, { signal: combined, onProgress: accept, hasRelevantHits,
          searchTimeoutMs: stage === 'related' ? 3000 : 4000,
          acceptHits: hits => hits.length >= 3 && hits.some(track => track.freeSlot && relevant(track)) });
        combined.throwIfAborted(); successes++; completedQueries.add(descriptor.query); accept(hits); return hits;
      }) };
    });
    onProgress?.(result());
    try {
      try {
        await Promise.any(jobs.map(async job => { const hits = await job.promise; if (!job.hasRelevantHits(hits)) throw new Error('No matching title'); return hits; }));
      } catch {
        signal?.throwIfAborted();
        const settled = await Promise.allSettled(jobs.map(job => job.promise));
        for (const item of settled) if (item.status === 'rejected' && item.reason?.name !== 'AbortError') errors.push(item.reason);
      }
      signal?.throwIfAborted();
    } finally { for (const job of jobs) job.controller.abort(); }
  };
  try {
    if (!original.artist && identifySong) {
      stage = 'identity'; onProgress?.(result());
      const early = new AbortController(), earlySignal = signal ? AbortSignal.any([signal, early.signal]) : early.signal;
      const lookup = discoverWithin(async (q, options) => {
        const song = await identifySong(q, options); return song ? [song] : [];
      }, input, signal, discoveryMs);
      try {
        lookup.start();
        const raw = wave([{ query: original.query, song: original, kind: 'title' }], earlySignal).then(async () => {
          if (!successes && errors.some(error => /로그인|인증|설정|login|auth/i.test(error.message))) throw errors[0];
          if ([...partial.values()].flat().some(track => relevantTitle(track, { song: original }, original))) return { early: true };
          return { videos: await lookup.promise };
        });
        const identified = await Promise.race([lookup.promise.then(videos => ({ videos })), raw]);
        signal?.throwIfAborted();
        if (identified.early) { stage = 'direct'; return result(); }
        const [video] = identified.videos;
        if (video) original = songFromVideo(video);
      } finally { early.abort(); lookup.close(); }
    }
    if (original.artist) identity = { artist: original.artist, title: original.title };
    queries = queriesFor(original); stage = 'direct';
    discovery = discoverWithin(original.artist ? null : discoverVideos, input, signal, discoveryMs);
    const direct = queries.filter(query => !completedQueries.has(query)).map(query => ({ query, song: original, kind: 'identity' }));
    await wave(direct);
    const foundTitle = () => combine().some(track => relevantTitle(track, { song: original }, original));
    if (foundTitle()) return result();
    if (!successes && errors.length) throw errors[0];
    const fatal = errors.find(error => /로그인|인증|설정|login|auth/i.test(error.message));
    if (fatal) throw fatal;
    stage = 'related'; onProgress?.(result());
    discovery.start();
    const videos = await discovery.promise;
    signal?.throwIfAborted();
    const related = relatedMusicQueries(identity ? `${original.artist} - ${original.title}` : input, videos);
    for (let index = 0; index < related.length; index += 2) {
      await wave(related.slice(index, index + 2));
      if (foundTitle()) return result();
      const fatal = errors.find(error => /로그인|인증|설정|login|auth/i.test(error.message));
      if (fatal) throw fatal;
    }
    if (errors.length && !combine().length) throw errors[0];
    return result();
  } finally { discovery?.close(); }
}
