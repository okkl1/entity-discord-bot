import { matchTracks, searchMatchedTracks } from './track-match.js';

const retryable = new Set(['peer_timeout', 'peer_unavailable', 'peer_stalled']);
export function createPeerFallback(pick, video, { maxAttempts = 3 } = {}) {
  let recording = null;
  for (const guessed of [pick.recording, video, pick.relatedArtist ? { artist: pick.relatedArtist, track: pick.title, duration: pick.duration } : null]) {
    try { if (guessed && matchTracks(guessed, [pick]).hits.some(track => track.id === pick.id && track.confident)) { recording = guessed; break; } } catch {}
  }
  const attempted = new Set([pick.username]); let attempts = 1, searched = false, discoveries = [];
  return {
    failure(error) {
      if (attempts < 2 || !retryable.has(error?.kind)) return error;
      return Object.assign(new Error(`같은 곡의 공유자 ${attempts}명에게 연결하지 못했습니다. 잠시 후 다시 검색하거나 다른 결과를 선택해주세요.`), { kind: error.kind });
    },
    async next(error, candidates, search, { signal } = {}) {
      signal?.throwIfAborted();
      if (!recording || !retryable.has(error?.kind) || attempts >= maxAttempts) return null;
      const usable = hits => hits.filter(track => track.username && !attempted.has(track.username) && track.freeSlot &&
        (!pick.bitDepth || track.bitDepth === pick.bitDepth) && (!pick.sampleRate || track.sampleRate === pick.sampleRate));
      const choose = hits => matchTracks(recording, usable(hits)).hits.find(track => track.confident);
      let selected = choose([...candidates, ...discoveries]);
      if (!selected && !searched && search) {
        searched = true;
        const result = await searchMatchedTracks(recording, (query, options) => search(query, {
          ...options, acceptHits: hits => options.acceptHits(usable(hits)),
          onProgress: options.onProgress ? hits => options.onProgress(usable(hits)) : undefined,
        }).then(usable), { signal });
        signal?.throwIfAborted(); discoveries = result.hits; selected = choose(discoveries);
      }
      if (!selected) return null;
      attempted.add(selected.username); attempts++;
      return { ...selected, recording, waitForComplete: pick.waitForComplete, retryAttempt: attempts };
    },
  };
}
