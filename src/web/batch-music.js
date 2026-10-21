import { setTimeout as delay } from 'node:timers/promises';
import { songFromVideo, matchTracks } from './track-match.js';
import { searchMusicTracks } from './music-search.js';

export function parseBatchQueries(text) {
  if (typeof text !== 'string' || text.length > 14000) throw new Error('검색어는 한 번에 100줄까지 입력해주세요.');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 100) throw new Error('검색어를 한 줄에 한 곡씩, 1~100줄 입력해주세요.');
  if (lines.some(line => line.length < 2 || line.length > 120 || /[\u0000-\u001f\u007f]/.test(line))) throw new Error('각 검색어는 2~120자로 입력해주세요.');
  if (lines.some(line => /^https?:\/\//i.test(line))) throw new Error('여러 곡 예약에는 주소 대신 가수·곡명을 입력해주세요.');
  // Repeat lines are intentional requests, but do not reserve duplicate copies.
  const unique = new Map();
  for (const line of lines) {
    const key = line.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    if (!unique.has(key)) unique.set(key, line);
  }
  return [...unique.values()];
}

export function selectBatchTrack(query, result) {
  const video = result.identity ? { artist: result.identity.artist, track: result.identity.title } : { title: query };
  const song = songFromVideo(video);
  const candidates = matchTracks(video, result.hits || []).hits.filter(track =>
    song.artist ? track.confident : track.matchScore >= 68 && track.matchLabel !== '다른 버전일 수 있어요');
  // Relevance precedes transfer availability. Do not auto-select a remix/cover
  // merely because that peer has a free slot.
  candidates.sort((a, b) => b.matchScore - a.matchScore || Number(b.freeSlot) - Number(a.freeSlot) ||
    (a.queueLength || 0) - (b.queueLength || 0) || (b.uploadSpeed || 0) - (a.uploadSpeed || 0));
  const pick = candidates[0];
  return pick ? { ...pick, ...(song.artist ? { recording: { artist: song.artist, track: song.title, duration: pick.duration } } : {}) } : null;
}

export async function findBatchTrack(query, search, { signal, identifySong } = {}) {
  let result = await searchMusicTracks(query, search, { signal });
  let pick = selectBatchTrack(query, result);
  // Avoid spawning YouTube metadata work for every line of a large playlist.
  // Resolve an artist only when the direct/related title searches found no match.
  if (!pick && identifySong && !songFromVideo({ title: query }).artist) {
    const lookupSignal = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(6500)]);
    const identity = await identifySong(query, { signal: lookupSignal }).catch(() => null);
    signal?.throwIfAborted();
    if (identity) {
      const song = songFromVideo(identity);
      result = await searchMusicTracks(song.title, search, { signal, artist: song.artist });
      pick = selectBatchTrack(query, result);
    }
  }
  return pick;
}

export async function runBatchMusic({ queries, signal, find, enqueue, canRun = () => true,
  publish = () => {}, wait = signal => delay(2000, undefined, { signal }) }) {
  const rows = [];
  const report = (status, query = '') => publish({ status, query, total: queries.length,
    processed: rows.length, added: rows.filter(row => row.status === 'added').length, rows: [...rows] });
  try {
    for (const query of queries) {
      signal.throwIfAborted();
      while (!canRun()) { report('waiting', query); await wait(signal); signal.throwIfAborted(); }
      report('searching', query);
      try {
        const pick = await find(query, { signal });
        signal.throwIfAborted();
        if (!pick) rows.push({ query, status: 'missing', message: '일치하는 곡을 찾지 못했어요. 직접 검색으로 확인해주세요.' });
        else {
          const added = await enqueue(pick);
          rows.push({ query, status: added ? 'added' : 'duplicate', title: String(pick.title).slice(0, 200) });
        }
      } catch (error) {
        signal.throwIfAborted();
        // Keep peer paths/credentials and raw upstream errors off the wire.
        rows.push({ query, status: 'error', message: '검색 또는 예약에 실패했어요. 직접 검색으로 다시 시도해주세요.' });
      }
      report('searching');
    }
    report('done');
  } catch (error) {
    if (!signal.aborted) throw error;
    report('cancelled');
  }
}
