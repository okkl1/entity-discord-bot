import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, stat, statfs, open, unlink, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSoulseekRuntime } from './soulseek-runtime.js';
import { verifyFlacFile } from './lossless-integrity.js';
import { resources, onMemoryPressure, backgroundWorkAllowed, memoryWorkAllowed } from '../resource-profile.js';

const uuid = /^[a-f0-9-]{36}$/;
const maxFile = 512 * 1024 * 1024;
export function parseFlacInfo(bytes) {
  if (bytes.length < 42) return null;
  if (bytes.toString('ascii', 0, 4) !== 'fLaC' || (bytes[4] & 127) !== 0 || bytes.readUIntBE(5, 3) !== 34) throw new Error('실제 FLAC 파일이 아닙니다. 다른 검색 결과를 선택해주세요.');
  const info = bytes.readBigUInt64BE(18), sampleRate = Number(info >> 44n),
    channels = Number((info >> 41n) & 7n) + 1, bitDepth = Number((info >> 36n) & 31n) + 1,
    samples = Number(info & ((1n << 36n) - 1n));
  if (!sampleRate || bitDepth < 4) throw new Error('FLAC 헤더를 읽지 못했습니다.');
  return { sampleRate, channels, bitDepth, duration: samples ? samples / sampleRate : null };
}
const segment = text => {
  text = String(text); if (!text || text === '.' || text === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) throw new Error('지원하지 않는 파일 경로입니다.');
  return text.replace(/[<>:"|?*\x00-\x1f\\/]/g, '_');
};
export function trackCachePaths(root, track, id) {
  if (!uuid.test(id) || !/\.flac$/i.test(track.filename) || track.filename.split(/[\\/]/).some(v => v === '..' || v === '.')) throw new Error('잘못된 음원 경로입니다.');
  const unrooted = track.filename.replace(/^[a-z]:[\\/]?/i, '').replace(/^[\\/]{2}[^\\/]+[\\/]?/, '').replace(/^@@[a-z0-9]{5,}[\\/]?/i, '');
  const parts = unrooted.split(/[\\/]/).filter(Boolean).map(segment), name = segment(track.filename.split(/[\\/]/).at(-1));
  return { incomplete: resolve(root, 'incomplete', segment(track.username), ...parts),
    complete: resolve(root, 'complete', id, name), manifest: resolve(root, 'manifests', `${id}.json`) };
}
export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

export function startupBufferBytes(size, duration, speed, { initialBytes = 512 * 1024, bufferSeconds = 12 } = {}) {
  if (!(duration > 0)) return Math.min(size, initialBytes);
  const playbackRate = size / duration;
  const reserve = Math.min(duration, bufferSeconds);
  // Slow peers need a larger head start so receiving can finish before playback
  // consumes the cache. Original FLAC bytes are never transcoded.
  const deficit = speed > 0 ? size - speed * Math.max(0, duration - reserve) : 0;
  return Math.min(size, Math.ceil(Math.max(initialBytes, playbackRate * reserve, deficit)));
}

export function createLosslessLibrary({ runtime = createSoulseekRuntime(), pollMs = resources.compact ? 1000 : 250, initialBytes = 512 * 1024, initialBufferSeconds = 16,
  idleMs = resources.compact ? 15_000 : 0,
  waitForComplete = false, verify = verifyFlacFile, verifyPrefix = (path, info, options) => verifyFlacFile(path, info, { ...options, seconds: 2 }),
  waitMs = 10 * 60_000, stallMs = 90_000, cacheLimitBytes = 512 * 1024 * 1024, minFreeBytes = (() => { const mb = Number(process.env.LOSSLESS_MIN_FREE_MB); return Number.isFinite(mb) && mb >= 0 && process.env.LOSSLESS_MIN_FREE_MB !== undefined ? mb * 1024 ** 2 : 2 * 1024 ** 3; })(),
  freeSpace = async path => { const disk = await statfs(path); return disk.bavail * disk.bsize; } } = {}) {
  const root = resolve(runtime.cacheRoot), streams = new Map(), keys = new Map(); let initialized, client, closing = false;
  let activeOperations = 0, idleTimer, suspending, protecting;
  const hasIncomplete = () => [...streams.values()].some(stream => !stream.complete && !stream.disposal);
  function suspendNative(emergency = false) {
    if (suspending || !runtime.suspend) return suspending;
    initialized = null; client = null;
    suspending = Promise.resolve().then(() => runtime.suspend({ emergency })).catch(error => console.warn('[lossless] 유휴 연결 정리:', error.message));
    return suspending;
  }
  function armIdle() {
    clearTimeout(idleTimer);
    if (closing || activeOperations || hasIncomplete() || !initialized || !runtime.suspend || !(idleMs > 0)) return;
    idleTimer = setTimeout(() => {
      if (closing || activeOperations || hasIncomplete()) return;
      suspendNative();
    }, idleMs); idleTimer.unref();
  }
  const offPressure = onMemoryPressure(detail => {
    if (!resources.compact || !detail?.level || closing) return;
    if (!hasIncomplete() && !activeOperations) { if (initialized) suspendNative(detail.level === 'critical'); return; }
    if (detail.level !== 'critical' || protecting || !runtime.suspend) return;
    const interrupted = [...streams.values()].filter(stream => !stream.complete && !stream.disposal);
    const error = Object.assign(new Error('서버 메모리 보호를 위해 음원 수신을 중단했습니다. 잠시 후 다시 선택해주세요.'), { code: 'LOSSLESS_MEMORY_PRESSURE' });
    for (const stream of interrupted) {
      stream.error = error; stream.rejectReady(error); stream.rejectVerified(error);
      update(stream, { status: 'error', message: error.message }); stream.controller.abort(error);
    }
    // Completed files remain owned by their listeners and keep streaming. Only
    // the native worker and unfinished downloads are stopped before an OOM kill.
    console.warn('[lossless] memory protection: stopping native worker; completed audio retained');
    protecting = Promise.resolve(suspendNative(true)).then(() => Promise.allSettled(interrupted.map(dispose))).finally(() => { protecting = null; });
  });
  async function operate(task) {
    activeOperations++; clearTimeout(idleTimer);
    try { return await task(); } finally { activeOperations--; armIdle(); }
  }
  async function checkedPath(path) {
    const rel = relative(root, resolve(path)); if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Cache path escaped its root.');
    // Verify every existing parent; a junction must never redirect cleanup elsewhere.
    let current = resolve(path);
    while (current !== root) {
      try { const actual = await realpath(current); const r = relative(root, actual); if (r.startsWith('..') || isAbsolute(r)) throw new Error('Cache path redirected outside its root.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      current = resolve(current, '..');
    }
    return resolve(path);
  }
  async function remove(path) {
    await checkedPath(path);
    for (let i = 0; i < 10; i++) {
      try { await unlink(path); return; } catch (error) { if (error.code === 'ENOENT') return; if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; await delay(200); }
    }
    throw new Error('임시 음원 파일을 삭제하지 못했습니다. 다음 실행 때 다시 정리합니다.');
  }
  async function clean(record) {
    let cancelError;
    if (client) await client.cancel(record.id).catch(error => { cancelError = error; });
    const paths = trackCachePaths(root, record.track, record.id);
    await remove(paths.incomplete); await remove(paths.complete);
    // Keep the recovery record if cancellation was not confirmed.
    if (cancelError) throw cancelError;
    await remove(paths.manifest);
  }
  async function initialize() {
    if (protecting) await protecting;
    if (suspending) { await suspending; suspending = null; }
    if (closing) throw new Error('음악 서비스를 종료하고 있습니다.');
    if (client?.controller?.signal.aborted) { initialized = null; client = null; }
    if (initialized) return initialized;
    if (!memoryWorkAllowed(96 * 1024 ** 2)) throw new Error('서버 메모리 여유를 기다리고 있습니다. 잠시 후 다시 시도해주세요.');
    initialized = (async () => {
      client = await runtime.start(); await mkdir(join(root, 'manifests'), { recursive: true });
      for (const name of await readdir(join(root, 'manifests'))) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        // A stopped native worker can restart while completed FLACs are still
        // being served. Recovery must never delete those live cache files.
        if (streams.has(name.slice(0, -5))) continue;
        const record = JSON.parse(await readFile(await checkedPath(join(root, 'manifests', name)), 'utf8'));
        if (record.id + '.json' !== name) throw new Error('임시 음원 기록이 손상됐습니다.');
        await clean(record);
      }
    })();
    try { await initialized; } catch (error) { initialized = null; throw error; }
  }
  async function fileFor(stream) {
    const first = stream.filePath || stream.paths.incomplete;
    const second = first === stream.paths.complete ? stream.paths.incomplete : stream.paths.complete;
    // Prefer the last existing location. Keep path validation, and recheck the
    // first location in case the native final rename raced both stat calls.
    for (const path of [first, second, first]) {
      try { const value = await stat(await checkedPath(path)); if (value.isFile()) { stream.filePath = path; return { path, size: value.size }; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return null;
  }
  function update(stream, patch) {
    const changed = Object.entries(patch).some(([name, value]) => !Object.is(stream.status[name], value));
    Object.assign(stream.status, patch);
    // Keep a one-second heartbeat for the shared starvation guard, without
    // repeatedly broadcasting identical queued states to every participant.
    if (!changed && Date.now() - (stream.publishedAt || 0) < 1000) return;
    stream.publishedAt = Date.now(); stream.events.emit('progress', { ...stream.status });
  }
  async function audioOffset(path, available, size) {
    const handle = await open(path, 'r');
    try {
      let offset = 4; const header = Buffer.alloc(4);
      for (let blocks = 0; blocks < 256; blocks++) {
        if (available < offset + 4) return null;
        if ((await handle.read(header, 0, 4, offset)).bytesRead !== 4) return null;
        offset += 4 + header.readUIntBE(1, 3);
        if (offset >= size) throw new Error('FLAC 메타데이터 크기가 잘못되었습니다. 다른 파일을 선택해주세요.');
        if (available < offset) return null;
        if (header[0] & 128) return offset;
      }
      throw new Error('FLAC 메타데이터를 확인하지 못했습니다. 다른 파일을 선택해주세요.');
    } finally { await handle.close(); }
  }
  async function receive(stream) {
    const signal = stream.controller.signal;
    await mkdir(join(root, 'manifests'), { recursive: true });
    await writeFile(stream.paths.manifest, JSON.stringify({ id: stream.id, track: stream.track }), { mode: 0o600 });
    stream.enqueuing = client.enqueue(stream.track, stream.id); await stream.enqueuing;
    const started = Date.now(); let ready = false, lastBytes = 0, lastProgress = started, prefixTask, prefixError;
    const prefixController = new AbortController();
    try { while (!signal.aborted) {
      if (prefixError) throw prefixError;
      if (Date.now() - started > waitMs) throw new Error('Soulseek 전송 대기가 길어졌습니다. 다른 검색 결과를 선택해주세요.');
      const transfer = await client.transfer(stream.id, { signal, timeoutMs: 5000 });
      if (!transfer) throw new Error('음원 전송을 찾지 못했습니다.');
      if (/Errored|Rejected|Cancelled|TimedOut/i.test(String(transfer.state))) throw Object.assign(new Error('상대방의 음원 전송이 중단됐습니다. 다른 검색 결과를 선택해주세요.'), { kind: 'peer_unavailable' });
      const file = await fileFor(stream), bytes = Math.min(stream.track.size, file?.size ?? lastBytes);
      if (file?.size > stream.track.size) throw new Error('음원 크기가 검색 결과와 다릅니다. 다른 파일을 선택해주세요.');
      const complete = bytes === stream.track.size && /Succeeded/i.test(String(transfer.state));
      if (bytes > lastBytes) { lastBytes = bytes; lastProgress = Date.now(); }
      else if (!complete && Date.now() - lastProgress >= stallMs) throw Object.assign(new Error('음원 전송이 진행되지 않아 임시 캐시를 정리합니다. 다른 검색 결과를 선택해주세요.'), { kind: 'peer_stalled' });
      if (file && bytes >= 42 && !stream.info) {
        let handle;
        try { handle = await open(file.path, 'r'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try { const buffer = Buffer.alloc(42); await handle.read(buffer, 0, 42, 0); stream.info = parseFlacInfo(buffer); } finally { await handle.close(); }
      }
      if (file && stream.info && stream.audioOffset == null) {
        try { stream.audioOffset = await audioOffset(file.path, bytes, stream.track.size); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      }
      const offset = stream.audioOffset ?? stream.track.size;
      const bufferTarget = waitForComplete ? stream.track.size : offset + startupBufferBytes(stream.track.size - offset, stream.info?.duration || stream.track.duration,
        Math.max(0, Number(transfer.averageSpeed) || 0) * 0.8, { initialBytes, bufferSeconds: initialBufferSeconds });
      update(stream, { bytes, bufferTarget, audioOffset: stream.audioOffset, percent: Math.floor(bytes / stream.track.size * 100), status: complete ? 'verifying' : bytes ? 'receiving' : 'queued',
        ...(stream.info ?? {}) });
      if (complete && file) {
        // Finish or cancel the short check before starting a full decode. A
        // queued prefix must not hold a second conversion or stale file handle.
        prefixController.abort(); await prefixTask;
        let validation;
        try { validation = await verify(file.path, stream.info, { signal }); }
        catch (error) { if ((await fileFor(stream))?.path !== file.path) continue; throw error; }
        signal.throwIfAborted();
        stream.complete = true; update(stream, { status: 'complete', ...validation });
        stream.resolveVerified({ ...stream.status });
        if (!ready) { ready = true; stream.resolveReady({ ...stream.status }); }
        return;
      }
      if (file && !waitForComplete && !ready && !prefixTask && stream.info && bytes >= bufferTarget) {
        // Continue observing disk progress while FFmpeg waits for a slot or
        // validates. Otherwise a reservation appears frozen at its old percent.
        prefixTask = (async () => {
          try {
            await verifyPrefix(file.path, stream.info, { signal: AbortSignal.any([signal, prefixController.signal]) });
            if (signal.aborted || prefixController.signal.aborted) return;
            update(stream, { integrity: 'pending' });
            ready = true; stream.resolveReady({ ...stream.status });
          } catch (error) {
            if (signal.aborted || prefixController.signal.aborted) return;
            try { if ((await fileFor(stream))?.path === file.path) prefixError = error; }
            catch (pathError) { prefixError = pathError; }
          } finally { prefixTask = null; }
        })();
      }
      await delay(pollMs, undefined, { signal });
    } } finally { prefixController.abort(); await prefixTask; }
  }
  async function dispose(stream) {
    if (stream.disposal) return stream.disposal;
    stream.disposal = (async () => {
      stream.controller.abort(); const cancelled = new Error('음원 재생이 취소됐습니다.'); stream.rejectReady(cancelled); stream.rejectVerified(cancelled);
      for (const response of stream.responses) response.destroy();
      await stream.task?.catch(() => {}); await stream.enqueuing?.catch(() => {});
      try { await clean({ id: stream.id, track: stream.track }); }
      finally {
        // Keep a recovery manifest on disk when native cancellation fails, but
        // do not retain failed transfer objects and listeners in RAM forever.
        streams.delete(stream.id); if (keys.get(stream.key) === stream) keys.delete(stream.key);
        stream.events.removeAllListeners(); armIdle();
      }
    })(); return stream.disposal;
  }
  return {
    configured: () => runtime.configured(),
    canPrefetch: () => !closing && !protecting && backgroundWorkAllowed() && !hasIncomplete() && !activeOperations && !client?.searching && !client?.cleanups?.size,
    warmup() { return operate(async () => { if (!closing && await runtime.configured()) await initialize(); }); },
    search(query, options) { return operate(async () => { await initialize(); if (closing) throw new Error('음악 서비스를 종료하고 있습니다.'); return client.search(query, options); }); },
    acquire(track, owner) { return operate(async () => {
      if (closing) throw new Error('음악 서비스를 종료하고 있습니다.');
      if (!Number.isSafeInteger(track.size) || track.size < 42 || track.size > maxFile) throw new Error('음원 파일 크기를 확인해주세요.');
      const key = `${track.username}\0${track.filename}`; let stream = keys.get(key);
      // A ready reservation changes owners without waking the native worker.
      if (stream && !stream.disposal && !stream.error) { stream.owners.add(owner); return stream; }
      await initialize();
      if (closing) throw new Error('음악 서비스를 종료하고 있습니다.');
      stream = keys.get(key);
      if (stream && !stream.disposal && !stream.error) { stream.owners.add(owner); return stream; }
      if (stream) {
        await dispose(stream);
        const replacement = keys.get(key);
        if (replacement && !replacement.disposal && !replacement.error) { replacement.owners.add(owner); return replacement; }
      }
      if (closing) throw new Error('음악 서비스를 종료하고 있습니다.');
      const available = await freeSpace(root);
      if (!Number.isFinite(available) || available < 0) throw new Error('드라이브의 여유 공간을 확인하지 못했습니다. 새 음원 수신을 중단합니다.');
      // Another caller may have acquired this same file during the disk check.
      stream = keys.get(key);
      if (stream && !stream.disposal && !stream.error) { stream.owners.add(owner); return stream; }
      if (closing) throw new Error('음악 서비스를 종료하고 있습니다.');
      const reserved = [...streams.values()].reduce((sum, value) => sum + value.track.size, 0);
      const remaining = [...streams.values()].reduce((sum, value) => sum + Math.max(0, value.track.size - (value.status.bytes || 0)), 0);
      if (reserved + track.size > cacheLimitBytes) throw new Error('음악 캐시 한도(512MB)에 도달했습니다. 현재 곡이 끝나거나 예약을 지운 뒤 다시 선택해주세요.');
      if (available - remaining - track.size < minFreeBytes) throw new Error(`드라이브의 여유 공간 ${Math.ceil(minFreeBytes / (1024 ** 2))}MB를 유지하기 위해 새 음원 수신을 중단했습니다. 공간을 확보한 뒤 다시 선택해주세요.`);
      if (streams.size >= 4) throw new Error('동시에 받을 수 있는 음악은 네 곡입니다. 다른 방의 재생이 끝난 후 선택해주세요.');
      stream = { id: randomUUID(), key, track, owners: new Set([owner]), events: new EventEmitter(),
        controller: new AbortController(), responses: new Set(), status: { status: 'queued', bytes: 0, percent: 0, size: track.size } };
      stream.paths = trackCachePaths(root, track, stream.id);
      stream.ready = new Promise((resolve, reject) => { stream.resolveReady = resolve; stream.rejectReady = reject; });
      stream.verified = new Promise((resolve, reject) => { stream.resolveVerified = resolve; stream.rejectVerified = reject; }); stream.verified.catch(() => {});
      // Errors are also reported to the room; an early stop must not reject unhandled.
      stream.ready.catch(() => {}); streams.set(stream.id, stream); keys.set(key, stream);
      stream.task = receive(stream).catch(error => {
        if (stream.controller.signal.aborted) return;
        stream.error = error; stream.rejectReady(error); stream.rejectVerified(error); update(stream, { status: 'error', message: error.message });
        // Failed prefetched songs must not retain partial files until their turn
        // in the queue. Do not await disposal here: it awaits this receive task.
        queueMicrotask(() => { void dispose(stream).catch(error => console.warn('[lossless] 실패한 음원 캐시 정리:', error.message)); });
      }).finally(armIdle);
      return stream;
    }); },
    async release(id, owner) {
      const stream = streams.get(id); if (!stream) return;
      stream.owners.delete(owner); if (!stream.owners.size) await dispose(stream);
    },
    async serve(id, req, res) {
      const stream = streams.get(id); if (!stream || stream.disposal || stream.error) { res.writeHead(410); res.end(); return; }
      if (stream.responses.size >= 64) { res.writeHead(429); res.end(); return; }
      const range = parseRange(req.headers.range, stream.track.size);
      if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${stream.track.size}` }); res.end(); return; }
      stream.responses.add(res);
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, stream.controller.signal]);
      res.once('close', () => controller.abort()); let handle;
      try {
        signal.throwIfAborted();
        let rejectWait;
        const aborted = new Promise((_, reject) => { rejectWait = () => reject(signal.reason); signal.addEventListener('abort', rejectWait, { once: true }); });
        try { await Promise.race([stream.ready, aborted]); } finally { signal.removeEventListener('abort', rejectWait); }
        signal.throwIfAborted();
        res.writeHead(range.partial ? 206 : 200, { 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes',
          'Content-Length': range.end - range.start + 1, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stream.track.size}` } : {}) });
        res.flushHeaders();
        if (req.method === 'HEAD') { res.end(); return; }
        for (let attempt = 0; attempt < 3 && !handle; attempt++) {
          const file = await fileFor(stream);
          try { handle = await open(file.path, 'r'); }
          catch (error) { if (error.code !== 'ENOENT' || attempt === 2) throw error; }
        }
        let position = range.start, stalled = Date.now(), knownSize = 0; const buffer = Buffer.alloc(64 * 1024);
        while (position <= range.end && !signal.aborted) {
          if (stream.error) throw stream.error;
          // Completion can arrive while stat is in flight. Only reject an empty
          // range after a stat that began with the final file already complete.
          const completedBeforeStat = stream.complete;
          // Reuse the known extent until consumed, rather than issue one stat
          // for every 64 KiB sent to each listener. Refresh at the growing edge.
          if (knownSize <= position) knownSize = (await handle.stat()).size;
          const available = knownSize - position;
          if (available <= 0) {
            if (Date.now() - stalled > 90_000 || completedBeforeStat) throw new Error('음원 수신이 중단됐습니다.');
            await delay(pollMs, undefined, { signal }); continue;
          }
          const length = Math.min(buffer.length, available, range.end - position + 1);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (!bytesRead) { await delay(pollMs, undefined, { signal }); continue; }
          position += bytesRead; stalled = Date.now();
          if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) await once(res, 'drain', { signal });
        }
        if (!signal.aborted) res.end();
      } catch (error) {
        if (!res.headersSent && !res.destroyed) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('음원을 불러오지 못했습니다.'); }
        else if (!res.destroyed) res.destroy();
      } finally { await handle?.close().catch(() => {}); stream.responses.delete(res); }
    },
    async close() { closing = true; offPressure(); clearTimeout(idleTimer); await protecting?.catch(() => {}); await suspending?.catch(() => {}); await initialized?.catch(() => {}); await Promise.allSettled([...streams.values()].map(dispose)); client?.close?.(); await runtime.close(); },
  };
}
