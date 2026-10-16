import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceSettings, releaseIdleMemory, onMemoryPressure } from '../src/resource-profile.js';
import { containerMemory, startMemoryMonitor } from '../src/runtime-memory.js';
import { ClipCache } from '../src/machugi/clip-cache.js';
import { topResults } from '../src/web/top-results.js';

test('compact changes retained caches and background work, preserving a next-song lookahead', () => {
  const value = resourceSettings({ ENTITY_MEMORY_PROFILE: 'compact' });
  assert.equal(value.quizLookahead, 1); assert.equal(value.clipConcurrency, 1);
  assert.equal(value.searchCacheTracks, 8000); assert.equal(value.clipCacheBytes, 4 * 1024 ** 2);
  assert.equal(resourceSettings({}).quizLookahead, 2);
});

test('bounded ranking exactly matches stable full sorting, including a late winner and ties', () => {
  const items = Array.from({ length: 25_000 }, (_, index) => ({ index, score: (index * 47) % 101 }));
  items.push({ index: 25_000, score: 1000 });
  const compare = (a, b) => b.score - a.score;
  assert.deepEqual(topResults(items, compare), [...items].sort(compare).slice(0, 100));
  assert.deepEqual(topResults(items, compare, 0), []);
});

test('container telemetry separates reclaimable file cache, Node RSS and real pressure', async () => {
  const mib = 1024 ** 2;
  const value = containerMemory(String(500 * mib), String(512 * mib), `inactive_file ${150 * mib}\n`, 'oom_kill 2\n');
  assert.equal(value.working, 350 * mib); assert.equal(value.oomKills, 2);
  assert.equal(containerMemory('123', 'max'), null);
  const logs = []; let calls = 0;
  const off = onMemoryPressure(() => { calls++; });
  const files = { 'memory.current': String(500 * mib), 'memory.max': String(512 * mib), 'memory.stat': 'inactive_file 0', 'memory.events': 'oom_kill 0' };
  const stop = startMemoryMonitor({ log: line => logs.push(line), read: async path => files[path.split('/').at(-1)], memory: () => ({ rss: 80 * mib, heapUsed: 30 * mib }) });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.match(logs[0], /nodeRSS=80MiB.*container=500\/512MiB/);
  } finally { stop(); off(); }
});

test('pressure drops cached clips without interrupting an active load or held playback packets', async () => {
  let finish;
  const cache = new ClipCache(async ({ pending }) => pending ? new Promise(resolve => { finish = resolve; }) : { bytes: 20, packets: ['playing'] });
  const playing = await cache.get('ready', {}), loading = cache.get('pending', { pending: true });
  const off = onMemoryPressure(() => cache.clear());
  try {
    releaseIdleMemory(); assert.equal(cache.bytes, 0); assert.equal(cache.jobs.size, 1); assert.deepEqual(playing.packets, ['playing']);
    finish({ bytes: 10 }); assert.equal((await loading).bytes, 10);
  } finally { off(); }
});
