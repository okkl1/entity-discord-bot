import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { parseFlacInfo } from '../src/web/lossless-library.js';
import { verifyFlacFile } from '../src/web/lossless-integrity.js';

async function encode(bitDepth, samples = 8192) {
  const width = bitDepth / 8, pcm = Buffer.alloc(samples * 2 * width);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin(i * Math.PI / 32) * (2 ** (bitDepth - 2) - 1));
    pcm.writeIntLE(value, i * 2 * width, width); pcm.writeIntLE(-value, (i * 2 + 1) * width, width);
  }
  const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-f', `s${bitDepth}le`, '-ar', '44100', '-ac', '2',
    '-i', 'pipe:0', '-c:a', 'flac', '-f', 'flac', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = []; let error;
  child.on('error', value => { error = value; }); child.stderr.resume();
  const exit = new Promise(resolve => child.once('close', resolve));
  child.stdout.on('data', data => chunks.push(data)); child.stdin.end(pcm);
  assert.equal(await exit, 0); if (error) throw error;
  const flac = Buffer.concat(chunks);
  // Streaming encoders cannot seek back to fill STREAMINFO. Supply the known
  // source sample count and PCM checksum to test against independent data.
  flac.writeBigUInt64BE((flac.readBigUInt64BE(18) & ~((1n << 36n) - 1n)) | BigInt(samples), 18);
  createHash('md5').update(pcm).digest().copy(flac, 26);
  return flac;
}

test('real 16-bit and 24-bit FLAC decode to the source PCM checksum without altering the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entity-integrity-test-'));
  try {
    for (const depth of [16, 24]) {
      const payload = await encode(depth), path = join(root, `${depth}.flac`);
      await writeFile(path, payload); const before = createHash('sha256').update(payload).digest('hex');
      assert.equal(parseFlacInfo(payload).bitDepth, depth);
      assert.deepEqual(await verifyFlacFile(path, parseFlacInfo(payload)), { integrity: 'verified' });
      const { readFile } = await import('node:fs/promises');
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), before);
    }
  } finally { await cleanup(root); }
});

test('checksum mismatch, truncated audio and a wrong sample count are rejected before playback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entity-integrity-test-'));
  try {
    const payload = await encode(24), checksum = Buffer.from(payload), wrongLength = Buffer.from(payload);
    checksum[26] ^= 1;
    wrongLength.writeBigUInt64BE(wrongLength.readBigUInt64BE(18) + 1n, 18);
    for (const [name, value] of [['checksum', checksum], ['truncated', payload.subarray(0, payload.length - 100)], ['samples', wrongLength]]) {
      const path = join(root, `${name}.flac`); await writeFile(path, value);
      await assert.rejects(verifyFlacFile(path, parseFlacInfo(value)), /검증에 실패/);
    }
  } finally { await cleanup(root); }
});

test('a missing optional MD5 is reported as decode validation, and an aborted request never decodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entity-integrity-test-'));
  try {
    const payload = await encode(16); payload.fill(0, 26, 42);
    const path = join(root, 'no-checksum.flac'); await writeFile(path, payload);
    assert.deepEqual(await verifyFlacFile(path, parseFlacInfo(payload)), { integrity: 'decoded' });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await assert.rejects(verifyFlacFile(path, parseFlacInfo(payload), { signal: controller.signal }), /cancelled/);
  } finally { await cleanup(root); }
});

async function cleanup(root) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('entity-integrity-test-')) throw new Error('Unsafe test cleanup target.');
  await rm(root, { recursive: true, force: true });
}

test('a valid buffered prefix can start quickly while its full checksum remains pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'entity-integrity-test-'));
  try {
    const payload = await encode(24, 44100 * 5), path = join(root, 'growing.flac');
    await writeFile(path, payload.subarray(0, Math.ceil(payload.length * 0.8)));
    assert.deepEqual(await verifyFlacFile(path, parseFlacInfo(payload), { seconds: 2 }), { integrity: 'pending' });
    await assert.rejects(verifyFlacFile(path, parseFlacInfo(payload)), /검증에 실패/);
    await writeFile(path, payload);
    assert.deepEqual(await verifyFlacFile(path, parseFlacInfo(payload)), { integrity: 'verified' });
  } finally { await cleanup(root); }
});
