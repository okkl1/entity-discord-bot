import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupLegacyWatches } from '../src/binance/cleanup.js';

test('이전 시세판 중 봇 자신의 메시지만 삭제한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'futures-cleanup-test-'));
  const statePath = join(dir, 'watches.json');
  const deleted = [];
  await writeFile(statePath, JSON.stringify([
    { channelId: '123', messageId: '456' },
    { channelId: '123', messageId: '789' }
  ]));
  const client = { user: { id: 'bot' }, channels: { fetch: async () => ({ messages: { fetch: async id => ({
    author: { id: id === '456' ? 'bot' : 'other' }, delete: async () => deleted.push(id)
  }) } }) } };
  try {
    assert.deepEqual(await cleanupLegacyWatches(client, statePath), { removed: 1, pending: 0 });
    assert.deepEqual(deleted, ['456']);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
