// Offline streaming preview. No Discord login or Soulseek account is used.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ffmpeg from 'ffmpeg-static';
import { createLosslessLibrary, trackCachePaths } from './lossless-library.js';
import { createQuizWebServer } from './server.js';

const root = await mkdtemp(join(tmpdir(), 'entity-lossless-preview-'));
const { stdout: payload } = await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
  '-i', 'anoisesrc=color=white:amplitude=0.015:sample_rate=48000:d=20', '-ac', '2', '-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac', 'pipe:1'],
  { windowsHide: true, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 });
// A streamed encoder cannot fill total samples; real on-disk FLAC files include it.
payload.writeBigUInt64BE((payload.readBigUInt64BE(18) & ~((1n << 36n) - 1n)) | 960000n, 18);
const source = { id: 'sample-flac', username: 'preview', filename: 'Preview Artist\\01 연결 테스트.flac', title: '01 연결 테스트',
  size: payload.length, duration: 20, bitDepth: 24, sampleRate: 48000, freeSlot: true, queueLength: 0 };
const nextSource = { ...source, id: 'sample-next-flac', filename: 'Preview Artist\\02 다음 곡.flac', title: '02 다음 곡' };
const jobs = new Map();
const api = {
  search: async query => /다음/.test(query) ? [nextSource] : [source],
  async enqueue(track, id) {
    const paths = trackCachePaths(root, track, id), job = { complete: false, controller: new AbortController() }; jobs.set(id, job);
    await mkdir(dirname(paths.incomplete), { recursive: true }); await writeFile(paths.incomplete, Buffer.alloc(0));
    job.work = (async () => {
      for (let position = 0; position < payload.length; position += 64 * 1024) {
        job.controller.signal.throwIfAborted(); await appendFile(paths.incomplete, payload.subarray(position, position + 64 * 1024));
        await delay(250, undefined, { signal: job.controller.signal });
      }
      await mkdir(dirname(paths.complete), { recursive: true }); await rename(paths.incomplete, paths.complete); job.complete = true;
    })().catch(() => {});
    return { id };
  },
  transfer: async id => ({ id, state: jobs.get(id)?.complete ? 'Completed, Succeeded' : 'InProgress' }),
  cancel: async id => { const job = jobs.get(id); if (job) { job.controller.abort(); await job.work; } },
};
const library = createLosslessLibrary({ runtime: { cacheRoot: root, configured: async () => true, start: async () => api, close: async () => {} } });
const web = createQuizWebServer({ requireDiscordIdentity: false, lossless: library, busy: () => false, search: async () => ({ found: 0, hits: [] }), videoSearch: async () => [
  { id: 'abcdefghijk', title: 'Preview Artist - 연결 테스트 (Official Audio)', channel: 'Preview Artist - Topic', duration: 20 },
  { id: 'lmnopqrstuv', title: 'Preview Artist - 다음 곡 (Official Audio)', channel: 'Preview Artist - Topic', duration: 20 },
] });
const url = await web.listen({ port: Number(process.env.WEB_PREVIEW_PORT || 3012) });
const guild = { id: 'preview', members: { fetch: async () => ({ voice: { channelId: 'voice' } }) } };
const room = web.createRoom({ ownerId: 'preview-owner', voiceChannel: { id: 'voice', name: '무손실 테스트방', guild }, textChannel: { id: 'text' } });
console.log(JSON.stringify({ hostUrl: room.hostUrl, guestUrl: room.shareUrl, size: payload.length, cacheRoot: root }));
let closing = false;
async function close() {
  if (closing) return; closing = true; await web.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('entity-lossless-preview-')) throw new Error('Unsafe preview cleanup target.');
  await rm(root, { recursive: true, force: true }); process.exit(0);
}
process.once('SIGINT', close); process.once('SIGTERM', close);
process.stdin.on('data', value => { if (String(value).trim() === 'stop') void close(); });
