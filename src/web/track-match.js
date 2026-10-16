// Compare song identity; availability alone must never select a different recording.
const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = text => normalize(text).replace(/ /g, '');
const noise = /\b(?:official\s*(?:music\s*)?(?:video|audio|mv|m\/v|visualizer)|official|music\s*video|lyrics?|lyric\s*video|hd|4k|8k|hq|audio|mv|m\/v)\b|공식\s*(?:뮤직비디오|영상)|가사/gi;
const clean = text => String(text ?? '').replace(/\s+[|ㅣl]\s*(?:lyrics?|가사|해석|자막)(?:\s*[/|·]\s*(?:lyrics?|가사|해석|자막))*\s*(?:\[[^\]]*\])?\s*$/i, ' ')
  .replace(/[\[(]([^\])]+)[\])]/g, (all, inner) => normalize(inner.replace(noise, '')) ? all : ' ')
  .replace(noise, ' ').replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
const versions = text => ['live', 'remix', 'instrumental', 'cover', 'acoustic', 'sped up', 'slowed', 'karaoke', '라이브', '리믹스', '반주', '커버', '어쿠스틱'].filter(v => /[a-z]/.test(v) ? ` ${normalize(text)} `.includes(` ${v} `) : normalize(text).includes(v));
const words = text => String(text ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const withoutFeaturing = text => {
  const wantedVersions = versions(text);
  const base = clean(text).replace(/[\[(]\s*(?:feat\.?|ft\.?|featuring|피처링|피쳐링)(?=\s|\.)\s*[^\])]*[\])]/gi, ' ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)(?=\s|\.)\s*.*$/i, '').replace(/\s+/g, ' ').trim();
  return [base, ...wantedVersions.filter(v => !versions(base).includes(v))].join(' ').trim();
};
export function shorterMusicQuery(query) {
  const terms = words(query).split(' '), meaningful = terms.filter(term => !/^(?:a|an|the|is|and|of|to|in|on|at|for|with)$/i.test(term));
  return meaningful.length >= 2 && meaningful.join(' ') !== terms.join(' ') ? meaningful.join(' ') : null;
}
function aliases(text) {
  const found = [...String(text).matchAll(/\(([^)]+)\)/g)].filter(m => !versions(m[1]).length &&
    ((/[가-힣]/.test(m[1]) && /[a-z]/i.test(text.replace(m[0], ''))) || (/[a-z]/i.test(m[1]) && /[가-힣]/.test(text.replace(m[0], '')))));
  return [...new Set([found.reduce((v, m) => v.replace(m[0], ''), text).trim(), ...found.map(m => m[1].trim())])].filter(Boolean);
}
export function songFromVideo(video) {
  const rawTitle = clean(video.track || video.title), title = withoutFeaturing(rawTitle);
  const parts = title.split(/\s+[-–—_]\s*|\s*[-–—_]\s+|\s+[|:]\s+/), split = !video.track && parts.length > 1;
  const quoted = !video.track && !split ? /^(.*?)\s+["'“‘]([^"'”’]+)["'”’]/.exec(String(video.title ?? '')) : null;
  const byArtist = !video.track && !split && !quoted && /^["'“‘].+["'”’]\s+by\s+/i.test(String(video.title ?? '')) ? /^(.+?)\s+by\s+(.+)$/i.exec(title) : null;
  // A label, lyrics uploader or fan channel is not the recording's artist.
  const topicArtist = /(?:\s*-?\s*Topic|VEVO)$/i.test(video.channel || '') ? String(video.channel).replace(/\s*-?\s*Topic$|VEVO$/i, '') : '';
  const artist = withoutFeaturing(video.artist || (split ? parts[0] : quoted?.[1] || byArtist?.[2] || topicArtist)).split(/\s*(?:,|\bfeat\.?)\s*/i)[0].trim();
  const song = withoutFeaturing(split ? parts.slice(1).join(' - ') : quoted?.[2] || byArtist?.[1] || title);
  if (compact(artist + song).length < 2 || song === '유튜브 링크 영상') throw new Error('영상에서 곡 제목을 읽지 못했습니다. 가수와 곡 제목으로 직접 검색해주세요.');
  const artistAliases = aliases(artist), titleAliases = aliases(song);
  const queryFor = (a, t) => words(`${a && !compact(t).includes(compact(a)) ? a + ' ' : ''}${t}`);
  const query = queryFor(artistAliases[0], titleAliases[0]);
  const alternate = queryFor(artistAliases.find(v => /[가-힣]/.test(v)) || artistAliases[0], titleAliases.find(v => /[가-힣]/.test(v)) || titleAliases[0]);
  const titleQuery = words(titleAliases[0]);
  return { artist, title: song, artistAliases, titleAliases, query, alternate: alternate !== query ? alternate : null,
    fallback: titleQuery !== query ? titleQuery : shorterMusicQuery(query), duration: video.duration, versions: versions(rawTitle) };
}
function similarity(wanted, actual) {
  const a = compact(wanted), b = compact(actual); if (!a || !b) return 0;
  if (a === b) return 1;
  const actualTokens = normalize(actual).split(' ');
  for (let i = 0; i < actualTokens.length; i++) {
    let joined = '';
    for (let j = i; j < actualTokens.length; j++) { joined += actualTokens[j]; if (joined === a) return 1; if (joined.length > a.length) break; }
  }
  if (/[가-힣]/.test(wanted) && a.length >= 3 && b.includes(a)) return 1;
  const tokens = normalize(wanted).split(' ').filter(Boolean);
  return tokens.filter(t => normalize(actual).split(' ').includes(t)).length / tokens.length;
}
export function matchTracks(video, tracks) {
  const song = songFromVideo(video);
  const hits = tracks.map(track => {
    const filename = String(track.filename || track.title).replace(/\.flac$/i, '').replace(/[\\/]/g, ' ');
    const titleScore = Math.max(...song.titleAliases.map(t => similarity(t, clean(track.title || filename))));
    const artistScore = Math.max(0, ...song.artistAliases.map(a => similarity(a, filename)));
    const difference = song.duration && track.duration ? Math.abs(song.duration - track.duration) : null;
    const durationOk = difference === null || difference <= Math.max(8, song.duration * 0.07);
    const actualVersions = versions(filename);
    const versionOk = song.versions.every(v => actualVersions.includes(v)) && actualVersions.every(v => song.versions.includes(v));
    const confident = titleScore === 1 && Boolean(song.artist) && artistScore === 1 && durationOk && versionOk;
    const score = Math.round(65 * titleScore + 25 * artistScore + (difference === null ? 3 : durationOk ? 10 : 0) - (versionOk ? 0 : 35));
    return { ...track, matchScore: Math.max(0, score), matchLabel: confident ? '곡명·가수 일치' : versionOk ? '제목을 확인해주세요' : '다른 버전일 수 있어요', confident };
  }).filter(t => t.matchScore >= 25).sort((a, b) => Number(b.confident) - Number(a.confident) || Number(b.freeSlot) - Number(a.freeSlot) || b.matchScore - a.matchScore || a.queueLength - b.queueLength);
  const matched = hits.find(t => t.confident);
  return { query: song.query, hits: hits.slice(0, 30), matchedId: matched?.id ?? null, playableMatch: Boolean(matched?.freeSlot) };
}

export async function searchMatchedTracks(video, search, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  const song = songFromVideo(video);
  const acceptHits = tracks => matchTracks(video, tracks).hits.some(track => track.confident && track.freeSlot);
  const partial = new Map();
  const jobs = [...new Set([song.query, song.alternate || song.fallback].filter(Boolean))].map(query => {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return { controller, promise: Promise.resolve().then(() => search(query, { signal: combined, acceptHits, searchTimeoutMs: 4000,
      onProgress: onProgress ? hits => {
        if (combined.aborted) return;
        partial.set(query, hits);
        onProgress(matchTracks(video, [...new Map([...partial.values()].flat().map(track => [track.id, track])).values()]));
      } : undefined })) };
  });
  try {
    if (jobs.length === 1) return matchTracks(video, await jobs[0].promise);
    // Both known spellings refer to this same song. Return an available exact
    // match from either spelling without waiting for the other full search.
    try {
      return await Promise.any(jobs.map(async job => {
        const hits = await job.promise;
        if (!acceptHits(hits)) throw new Error('No available exact match');
        return matchTracks(video, hits);
      }));
    } catch {
      signal?.throwIfAborted();
      const results = await Promise.allSettled(jobs.map(job => job.promise));
      const successful = results.filter(result => result.status === 'fulfilled');
      if (!successful.length) throw results[0].reason;
      const hits = [...new Map(successful.flatMap(result => result.value).map(track => [track.id, track])).values()];
      return matchTracks(video, hits);
    }
  } finally { for (const job of jobs) job.controller.abort(); }
}
