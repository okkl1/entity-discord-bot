import { songFromVideo } from './track-match.js';

const normalized = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const meaningful = value => normalized(value).split(' ').filter(term => term && !/^(?:a|an|the|is|and|of|to|in|on|at|for|with|by)$/.test(term)).sort().join(' ');
const equivalent = (a, b) => Boolean(normalized(a)) && (normalized(a).replace(/ /g, '') === normalized(b).replace(/ /g, '') || meaningful(a) && meaningful(a) === meaningful(b));

export function identifyMusicSong(input, videos) {
  const wanted = songFromVideo({ title: input }), candidates = [];
  for (const video of videos ?? []) {
    try {
      const song = songFromVideo(video);
      if (!song.artist || wanted.artist && !wanted.artistAliases.some(a => song.artistAliases.some(b => equivalent(a, b)))) continue;
      const sameTitle = wanted.titleAliases.some(a => song.titleAliases.some(b => equivalent(a, b)));
      const sameCombined = equivalent(wanted.query, song.query);
      if (!sameTitle && !sameCombined) continue;
      candidates.push({ video, song });
    } catch {}
  }
  const selected = candidates[0]; if (!selected) return null;
  const artistAliases = [...selected.song.artistAliases], titleAliases = [...selected.song.titleAliases];
  for (const { song } of candidates.slice(1)) {
    if (!song.artistAliases.some(a => artistAliases.some(b => equivalent(a, b))) || !song.titleAliases.some(a => titleAliases.some(b => equivalent(a, b)))) continue;
    for (const alias of song.artistAliases) if (!artistAliases.some(a => equivalent(a, alias))) artistAliases.push(alias);
    for (const alias of song.titleAliases) if (!titleAliases.some(a => equivalent(a, alias))) titleAliases.push(alias);
  }
  const spelling = aliases => [aliases[0], ...aliases.slice(1).map(alias => `(${alias})`)].join(' ');
  // This is a search identity suggestion. Manual discovery never uses it as
  // permission to automatically play a different recording.
  return { title: selected.video.title, artist: spelling(artistAliases), track: spelling(titleAliases), duration: selected.video.duration, source: 'youtube' };
}

export function createMusicIdentityLookup(videoSearch) {
  return async (input, { signal } = {}) => {
    signal?.throwIfAborted();
    const wanted = songFromVideo({ title: input });
    const videos = await videoSearch(wanted.query, { signal });
    signal?.throwIfAborted();
    const identified = identifyMusicSong(input, videos);
    if (identified) return identified;
    // A flat playlist entry often omits YouTube Music's artist/track fields.
    // Inspect one title-matching entry before giving up on structured metadata.
    const titleOnly = videos.find(video => {
      try { return !songFromVideo(video).artist && equivalent(wanted.title, songFromVideo(video).title); }
      catch { return false; }
    });
    if (!/^[\w-]{11}$/.test(titleOnly?.id ?? '')) return null;
    const details = await videoSearch(`https://www.youtube.com/watch?v=${titleOnly.id}`, { metadata: true, signal });
    signal?.throwIfAborted();
    return identifyMusicSong(input, details.filter(video => video.id === titleOnly.id));
  };
}

export async function readVideoMusicMetadata(video, videoSearch, { signal, timeoutMs = 6500 } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer, cancel;
  const interrupted = new Promise(resolve => {
    cancel = () => resolve(null); combined.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try {
    const result = await Promise.race([interrupted, Promise.resolve().then(async () => {
      combined.throwIfAborted();
      const details = await videoSearch(`https://www.youtube.com/watch?v=${video.id}`, { metadata: true, signal: combined });
      return details.find(detail => detail.id === video.id) || null;
    }).catch(() => null)]);
    signal?.throwIfAborted(); return result;
  } finally { clearTimeout(timer); combined.removeEventListener('abort', cancel); controller.abort(); }
}
