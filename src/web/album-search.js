import { createHash } from 'node:crypto';
import { topResults } from './top-results.js';

const normalize = value => String(value ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
const disc = /^(?:cd|disc|disk)\s*[-_. ]*\d+$/i;
const qualityFolder = /^(?:flac|lossless|(?:16|24|32)[-_. ]*bit(?:.*)?)$/i;
const label = value => value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);

// Search results contain filenames within shared folders, not authoritative
// album tags. Keep each peer/edition separate and never expose its full path.
export function groupMusicAlbums(hits, query, { maxAlbums = 12, maxTracks = 2000, paths = new WeakMap() } = {}) {
  const groups = new Map(), terms = normalize(query).toLowerCase().split(' ').filter(Boolean);
  for (const track of hits) {
    if (!track?.id || !track.username || !/\.flac$/i.test(track.filename || '')) continue;
    let path = paths.get(track);
    if (!path) {
      const parts = track.filename.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts.length < 2 || parts.some(part => part === '..' || part === '.')) continue;
      const file = parts.pop(), parent = parts.at(-1), discName = disc.test(parent) ? parts.pop() : '';
      if (!parts.length) continue;
      const folder = parts.join('/'), leaf = parts.at(-1);
      const title = qualityFolder.test(leaf) && parts.length > 1 ? `${parts.at(-2)} · ${leaf}` : leaf;
      path = { folder, title: label(title), order: `${discName ? Number(/\d+/.exec(discName)[0]) : 0}/${file}`, words: ` ${normalize(folder).toLowerCase()} ` };
      paths.set(track, path);
    }
    if (!terms.every(term => /[가-힣]/.test(term) ? path.words.includes(term) : path.words.includes(` ${term} `))) continue;
    const key = `${track.username}\0${path.folder}`;
    let album = groups.get(key);
    if (!album) {
      album = { id: createHash('sha256').update(key).digest('hex').slice(0, 32), title: path.title, tracks: [], seen: new Set(), freeSlot: false, queueLength: Infinity };
      groups.set(key, album);
    }
    if (album.seen.has(track.id)) continue;
    album.seen.add(track.id); album.tracks.push(track);
    album.freeSlot ||= Boolean(track.freeSlot); album.queueLength = Math.min(album.queueLength, Number(track.queueLength) || 0);
  }
  const selected = topResults(groups.values(), (a, b) => Number(b.freeSlot) - Number(a.freeSlot)
    || b.tracks.length - a.tracks.length || a.queueLength - b.queueLength || collator.compare(a.title, b.title), maxAlbums);
  let remaining = maxTracks;
  return selected.flatMap(album => {
    if (remaining <= 0) return [];
    const totalFound = album.tracks.length;
    album.tracks.sort((a, b) => collator.compare(paths.get(a).order, paths.get(b).order));
    const tracks = album.tracks.slice(0, remaining); remaining -= tracks.length;
    return [{ id: album.id, title: album.title, tracks, totalFound, truncated: tracks.length < totalFound, freeSlot: album.freeSlot }];
  });
}

export const publicTrack = ({ id, title, size, duration, bitDepth, sampleRate, freeSlot, queueLength }) =>
  ({ id, title: String(title || '').slice(0, 200), size, duration, bitDepth, sampleRate, freeSlot, queueLength });
export const publicAlbum = album => ({ id: album.id, title: album.title, trackCount: album.tracks.length,
  totalFound: album.totalFound, truncated: album.truncated, freeSlot: album.freeSlot,
  size: album.tracks.reduce((sum, track) => sum + (track.size || 0), 0) });

export async function searchMusicAlbums(input, search, { signal, onProgress } = {}) {
  const query = normalize(input).slice(0, 120);
  if (query.length < 2) throw new Error('가수·앨범명을 두 글자 이상 입력해주세요.');
  if (/^https?:\/\//i.test(String(input).trim())) throw new Error('앨범 검색에는 유튜브 주소 대신 가수·앨범명을 입력해주세요.');
  signal?.throwIfAborted();
  const paths = new WeakMap(), folderWords = new WeakMap(), terms = query.toLowerCase().split(' ');
  const relevant = track => {
    if (!folderWords.has(track)) folderWords.set(track, ` ${normalize(track.filename?.replace(/[^\\/]+$/, '')).toLowerCase()} `);
    const words = folderWords.get(track);
    return terms.every(term => /[가-힣]/.test(term) ? words.includes(term) : words.includes(` ${term} `));
  };
  const result = hits => ({ query, hits: [], albums: groupMusicAlbums(hits, query, { paths }), stage: 'albums' });
  const hits = await search(query, { signal, searchTimeoutMs: 6000,
    onProgress: hits => { signal?.throwIfAborted(); onProgress?.(result(hits)); },
    hasRelevantHits: hits => hits.some(relevant),
  });
  signal?.throwIfAborted(); return result(hits);
}
