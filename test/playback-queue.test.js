import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPlaybackQueue } from '../src/web/playback-queue.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const streams = new Map(), calls = [], removed = [];
  const lossless = { async acquire(pick, owner) {
    calls.push(pick.id); let stream = streams.get(pick.id);
    if (!stream) { let resolve, reject; const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
      ready.catch(() => {}); stream = { id: pick.id, owners: new Set(), events: new EventEmitter(), status: { status: 'receiving', percent: 25 }, ready, resolve, reject }; streams.set(pick.id, stream); }
    stream.owners.add(owner); return stream;
  }, async release(id, owner) { const stream = streams.get(id); stream.owners.delete(owner); if (!stream.owners.size) removed.push(id); } };
  const queue = createPlaybackQueue({ lossless, ownerPrefix: 'queue:room' }); return { queue, lossless, streams, calls, removed };
}
test('only the next FLAC is prefetched, and transfer ownership preserves it when playback starts', async () => {
  const f = fixture();
  f.queue.add('listen', { id: 'a', title: 'A', username: 'private' }); f.queue.add('listen', { id: 'b', title: 'B' }); await tick();
  assert.deepEqual(f.calls, ['a']); assert.doesNotMatch(JSON.stringify(f.queue.snapshot()), /private/);
  f.streams.get('a').resolve(); await tick(); assert.equal(f.queue.snapshot()[0].status, 'ready');
  f.streams.get('a').events.emit('progress', { status: 'receiving', percent: 50 }); assert.equal(f.queue.snapshot()[0].status, 'ready');
  const next = await f.queue.take(); await f.lossless.acquire(next.pick, 'playing-room'); await f.queue.release(next);
  assert.equal(f.removed.includes('a'), false); f.queue.prime(); await tick(); assert.ok(f.calls.includes('b'));
  await f.queue.clear(); assert.ok(f.removed.includes('b')); assert.equal(f.removed.includes('a'), false);
  await f.lossless.release('a', 'playing-room'); assert.ok(f.removed.includes('a'));
});
test('clearing a queue while prefetch starts also releases the newly acquired temporary stream', async () => {
  let resolve, released = 0;
  const queue = createPlaybackQueue({ ownerPrefix: 'test', lossless: {
    acquire: () => new Promise(yes => { resolve = yes; }), release: async () => { released++; } } });
  queue.add('listen', { id: 'song', title: 'Song' }); const clearing = queue.clear();
  resolve({ id: 'stream', events: new EventEmitter(), ready: Promise.resolve() }); await clearing;
  assert.equal(queue.size, 0); assert.equal(released, 1);
});
test('failed prefetch is marked for skipping, and queue limits and duplicate protection bound reservations', async () => {
  const f = fixture(); const id = f.queue.add('listen', { id: 'a', title: 'A' }); await tick();
  f.streams.get('a').reject(new Error('Peer disconnected')); await tick(); assert.equal(f.queue.snapshot()[0].status, 'failed');
  await f.queue.remove(id); assert.deepEqual(f.removed, ['a']);
  for (let i = 0; i < 20; i++) f.queue.add('watch', { id: String(i), title: String(i) });
  assert.throws(() => f.queue.add('watch', { id: 'extra' }), /20곡/); await f.queue.clear();
  f.queue.add('watch', { id: 'repeat' }); assert.throws(() => f.queue.add('watch', { id: 'repeat' }), /이미 예약/); await f.queue.clear();
});
