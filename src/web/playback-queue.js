import { randomUUID } from 'node:crypto';

export function createPlaybackQueue({ lossless, ownerPrefix, onChange = () => {}, canPrime = () => true, retryMs = 2000 }) {
  let entries = [], retryTimer;
  const retiring = new Set();
  const snapshot = () => entries.map(item => ({ id: item.id, kind: item.kind, title: item.pick.title,
    status: item.status, percent: item.percent || 0, bitDepth: item.pick.bitDepth, sampleRate: item.pick.sampleRate }));
  async function release(item) {
    if (!item) return;
    item.disposed = true; await item.pending;
    if (item.stream) { if (item.onProgress) item.stream.events.off('progress', item.onProgress); await lossless.release(item.stream.id, item.owner); }
  }
  function prime() {
    clearTimeout(retryTimer); retryTimer = null;
    const item = entries[0]; if (!item || item.kind !== 'listen' || item.pending) return;
    if (!canPrime()) {
      if (item.status !== 'deferred') { item.status = 'deferred'; onChange(); }
      retryTimer = setTimeout(prime, retryMs); retryTimer.unref(); return;
    }
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
    defer() {
      clearTimeout(retryTimer); retryTimer = null;
      const item = entries[0]; if (!item || item.kind !== 'listen' || item.claimed || !item.pending ||
        (item.failed && item.stream?.error?.code !== 'LOSSLESS_MEMORY_PRESSURE') || item.stream?.complete) return;
      entries[0] = { id: item.id, kind: item.kind, pick: item.pick, status: 'deferred', owner: `${ownerPrefix}:${randomUUID()}` };
      const cleanup = release(item).catch(() => {}); retiring.add(cleanup);
      void cleanup.finally(() => { retiring.delete(cleanup); prime(); });
      onChange();
    },
    get size() { return entries.length; },
    get next() { return entries[0] || null; },
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
    async take() { clearTimeout(retryTimer); retryTimer = null; const item = entries.shift(); if (!item) return null; item.claimed = true; onChange(); await item.pending; return item; },
    async remove(id) { const item = entries.find(i => i.id === id); if (!item) throw new Error('예약 목록이 바뀌었습니다.'); entries = entries.filter(i => i !== item); onChange(); await release(item); prime(); },
    async clear() { clearTimeout(retryTimer); retryTimer = null; const previous = entries; entries = []; if (previous.length) onChange(); await Promise.allSettled([...previous.map(release), ...retiring]); },
    release,
  };
}
