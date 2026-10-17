import { randomUUID } from 'node:crypto';

export function createPlaybackQueue({ lossless, ownerPrefix, onChange = () => {} }) {
  let entries = [];
  const snapshot = () => entries.map(item => ({ id: item.id, kind: item.kind, title: item.pick.title,
    status: item.status, percent: item.percent || 0, bitDepth: item.pick.bitDepth, sampleRate: item.pick.sampleRate }));
  async function release(item) {
    if (!item) return;
    item.disposed = true; await item.pending;
    if (item.stream) { if (item.onProgress) item.stream.events.off('progress', item.onProgress); await lossless.release(item.stream.id, item.owner); }
  }
  function prime() {
    const item = entries[0]; if (!item || item.kind !== 'listen' || item.pending) return;
    item.status = 'preparing'; onChange();
    item.pending = (async () => {
      try {
        item.stream = await lossless.acquire(item.pick, item.owner);
        if (item.disposed) return;
        item.onProgress = progress => {
          const status = progress.status === 'error' ? 'failed' : item.buffered || progress.status === 'complete' ? 'ready'
            : progress.status === 'queued' ? 'queued' : progress.status === 'verifying' ? 'verifying' : 'preparing';
          if (progress.status === 'error') item.failed = true;
          if (item.status === status && item.percent === progress.percent) return;
          item.status = status; item.percent = progress.percent;
          if (!item.claimed && !item.disposed) onChange();
        };
        item.stream.events.on('progress', item.onProgress); item.onProgress(item.stream.status);
        void (item.pick.waitForComplete && item.stream.verified || item.stream.ready).then(() => {
          if (item.disposed || item.failed) return; item.buffered = true; item.status = 'ready';
          if (!item.claimed) onChange();
        }).catch(() => { item.failed = true; item.status = 'failed'; if (!item.disposed && !item.claimed) onChange(); });
      } catch { item.status = 'later'; if (!item.disposed && !item.claimed) onChange(); }
    })();
  }
  return { snapshot, prime,
    get size() { return entries.length; },
    add(kind, pick) {
      if (entries.some(item => item.kind === kind && item.pick.id === pick.id)) throw new Error('이미 예약한 곡입니다.');
      const id = randomUUID(); entries.push({ id, kind, pick, status: 'waiting', owner: `${ownerPrefix}:${id}` }); onChange(); prime(); return id;
    },
    addMany(kind, picks) {
      const known = new Set(entries.filter(item => item.kind === kind).map(item => item.pick.id)); let added = 0;
      for (const pick of picks) {
        if (known.has(pick.id)) continue;
        known.add(pick.id); const id = randomUUID();
        entries.push({ id, kind, pick, status: 'waiting', owner: `${ownerPrefix}:${id}` }); added++;
      }
      // One album is one change, rather than one full room broadcast per song.
      if (added) { onChange(); prime(); }
      return { added, skipped: picks.length - added };
    },
    async take() { const item = entries.shift(); if (!item) return null; item.claimed = true; onChange(); await item.pending; return item; },
    async remove(id) { const item = entries.find(i => i.id === id); if (!item) throw new Error('예약 목록이 바뀌었습니다.'); entries = entries.filter(i => i !== item); onChange(); await release(item); prime(); },
    async clear() { const previous = entries; entries = []; if (previous.length) onChange(); await Promise.allSettled(previous.map(release)); },
    release,
  };
}
