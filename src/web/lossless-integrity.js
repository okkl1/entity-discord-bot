import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { ffmpegPath, ffmpegFailure } from '../ffmpeg.js';

// Decode only for validation. PCM stays in memory; listeners receive the
// original FLAC, with its original sample rate, channels and bit depth.
export async function verifyFlacFile(path, info, { signal, timeoutMs = 120_000, seconds = 0 } = {}) {
  const invalid = () => new Error('FLAC 음원 검증에 실패했습니다. 손상됐거나 잘린 파일일 수 있으니 다른 검색 결과를 선택해주세요.');
  if (!info || info.bitDepth < 4 || info.bitDepth > 32 || !info.channels || !info.sampleRate) throw invalid();
  signal?.throwIfAborted();
  const header = Buffer.alloc(42), handle = await open(path, 'r');
  try { const { bytesRead } = await handle.read(header, 0, 42, 0); if (bytesRead !== 42 || header.toString('ascii', 0, 4) !== 'fLaC') throw invalid(); }
  finally { await handle.close(); }
  const expected = header.subarray(26, 42), hasChecksum = expected.some(byte => byte !== 0);
  const samples = Number(header.readBigUInt64BE(18) & ((1n << 36n) - 1n));
  const width = Math.ceil(info.bitDepth / 8), shift = width * 8 - info.bitDepth;
  const format = width === 1 ? 's8' : `s${width * 8}le`;
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
  const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-err_detect', 'explode',
    '-f', 'flac', '-i', path, ...(seconds > 0 ? ['-t', String(seconds)] : []), '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', `pcm_${format}`, '-f', format, 'pipe:1'],
  { windowsHide: true, signal: combined, stdio: ['ignore', 'pipe', 'pipe'] });
  let processError, decoderError = false, total = 0, carry = Buffer.alloc(0);
  child.on('error', error => { processError = error; });
  child.stderr.on('data', () => { decoderError = true; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))), hash = createHash('md5');
  try {
    for await (const chunk of child.stdout) {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const length = bytes.length - bytes.length % width;
      // FLAC's MD5 uses signed, little-endian samples, rounded up to whole
      // bytes. FFmpeg left-aligns uncommon depths such as 12 and 20 bits.
      if (shift) for (let i = 0; i < length; i += width) bytes.writeIntLE(bytes.readIntLE(i, width) >> shift, i, width);
      hash.update(bytes.subarray(0, length)); total += length; carry = Buffer.from(bytes.subarray(length));
    }
    const { code, signal: exitSignal } = await closed;
    signal?.throwIfAborted();
    if (combined.aborted) throw new Error('FLAC 음원 검증 시간이 초과됐습니다. 다른 검색 결과를 선택해주세요.');
    if (exitSignal) throw ffmpegFailure(code, exitSignal, { bytes: total });
    const expectedSamples = seconds > 0 ? Math.min(samples || Infinity, Math.round(seconds * info.sampleRate)) : samples;
    if (processError || code !== 0 || decoderError || carry.length || !total || (expectedSamples && total !== expectedSamples * info.channels * width)) throw invalid();
    if (seconds > 0) return { integrity: 'pending' };
    if (hasChecksum && !hash.digest().equals(expected)) throw invalid();
    return { integrity: hasChecksum ? 'verified' : 'decoded' };
  } catch (error) {
    controller.abort(); await closed;
    if (signal?.aborted) throw signal.reason;
    if (combined.aborted && processError?.name === 'AbortError') throw new Error('FLAC 음원 검증 시간이 초과됐습니다. 다른 검색 결과를 선택해주세요.');
    if (error.code === 'AUDIO_PROCESS_TERMINATED' || error.message?.startsWith('FLAC 음원 검증')) throw error;
    throw invalid();
  } finally { clearTimeout(timer); }
}
