import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createSoulseekSearchEvents } from './soulseek-search-events.js';
import { resources, onMemoryPressure } from '../resource-profile.js';
const compareTracks = (a, b) => Number(b.freeSlot) - Number(a.freeSlot) || a.queueLength - b.queueLength || b.uploadSpeed - a.uploadSpeed;

function requestError(status, body, path) {
  let details = '';
  if (!/^\s*</.test(body)) {
    try {
      const value = JSON.parse(body);
      details = typeof value === 'string' ? value : [value?.message, value?.detail, value?.error].filter(value => typeof value === 'string').join(' ');
    } catch { details = body.slice(0, 16_384); }
  }
  let message, kind = 'service';
  if (status === 401 || status === 403) { kind = 'auth'; message = 'Soulseek 연결 인증이 맞지 않습니다. Soulseek 계정 환경변수와 연결 설정을 확인해주세요.'; }
  else if (/DbUpdateConcurrencyException|expected to affect.*actually affected|database is (?:locked|busy)|SQLITE_BUSY/i.test(details)) {
    kind = 'search_database'; message = 'Soulseek 검색 기록 처리 중 충돌이 발생했습니다. 다시 검색해주세요. 반복되면 봇을 재시작해주세요.';
  } else if (/not (?:connected|logged in)|must be (?:connected|logged in)|ConnectionException|SocketException|TimeoutException|timed out|connection.*closed/i.test(details)) {
    kind = 'connection'; message = 'Soulseek 연결이 끊겼거나 응답이 지연되고 있습니다. 잠시 후 다시 검색해주세요.';
    if (path.startsWith('/transfers/') && /GetUserEndPoint|TimeoutException|timed out/i.test(details)) {
      kind = 'peer_timeout'; message = '이 음원 공유자의 연결 확인 시간이 초과됐습니다. 전송 슬롯이 있는 다른 검색 결과를 선택해주세요.';
    }
  } else if (status === 429) { kind = 'busy'; message = 'Soulseek에서 이전 검색을 준비 중입니다. 잠시 후 다시 검색해주세요.'; }
  else if (status >= 500) message = `Soulseek 연결 프로그램에서 내부 오류(${status})가 발생했습니다. 다시 검색해주세요. 반복되면 봇을 재시작해주세요.`;
  else message = `Soulseek 요청 실패 (${status}). 다시 검색해주세요.`;
  return Object.assign(new Error(message), { status, kind });
}
const searchErrored = status => typeof status?.state === 'number' ? Boolean(status.state & 128)
  : /(?:^|[,\s])Errored(?:$|[,\s])/i.test(String(status?.state ?? ''));
const requestStage = path => path === '/server' ? 'login' : path === '/application' ? 'startup'
  : path === '/searches' ? 'search-create' : path.endsWith('/responses') ? 'search-results'
  : path.startsWith('/searches/') ? 'search-state' : path.startsWith('/transfers/') ? 'transfer' : 'service';
const stageLabel = stage => ({ login: '로그인 상태 확인', startup: '프로그램 시작 확인',
  'search-create': '검색 요청', 'search-results': '검색 결과 수신', 'search-state': '검색 상태 확인', transfer: '음원 전송 확인' })[stage] || '응답 확인';

export function normalizeTracks(responses) {
  const hits = [], seen = new Set();
  for (const peer of responses ?? []) for (const file of peer.files ?? []) {
    const filename = String(file.filename ?? '');
    if (!/\.flac$/i.test(filename) || file.isLocked || !Number.isSafeInteger(file.size) || file.size < 42 || file.size > 512 * 1024 * 1024) continue;
    if (filename.split(/[\\/]/).some(part => part === '..' || part === '.')) continue;
    const key = `${peer.username}\0${filename}`;
    if (seen.has(key)) continue; seen.add(key);
    hits.push({ id: createHash('sha256').update(key).digest('hex').slice(0, 32), username: peer.username,
      filename, title: filename.split(/[\\/]/).at(-1).replace(/\.flac$/i, ''), size: file.size,
      duration: Number(file.length) > 0 ? Number(file.length) : null,
      sampleRate: Number(file.sampleRate) > 0 ? Number(file.sampleRate) : null,
      bitDepth: Number(file.bitDepth) > 0 ? Number(file.bitDepth) : null,
      queueLength: Math.max(0, Number(peer.queueLength) || 0), freeSlot: Boolean(peer.hasFreeUploadSlot),
      uploadSpeed: Math.max(0, Number(peer.uploadSpeed) || 0) });
  }
  // Keep the native candidate pool intact. The caller ranks the requested song
  // before imposing its display limit; an artist's fast peers may share many
  // unrelated tracks before the right file arrives from a queued peer.
  return hits.sort(compareTracks).slice(0, 25_000);
}

export class SoulseekClient {
  constructor({ baseUrl, apiKey, fetchImpl = fetch, searchMs = 7000, extendedSearchMs = searchMs * 2, pollMs = 250,
    minSearchMs = 1500, settleMs = 500, minHits = 10, matchMs = 500,
    now = Date.now, sleep = delay, searchEvents, loginFailure = async () => null, loginWaitMs = 20_000,
    cacheMaxTracks = resources.searchCacheTracks, cacheMaxEntries = resources.searchCacheEntries }) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.apiKey = apiKey; this.fetch = fetchImpl; this.searchMs = searchMs;
    this.extendedSearchMs = Math.max(searchMs, extendedSearchMs);
    this.pollMs = pollMs; this.minSearchMs = minSearchMs; this.settleMs = settleMs; this.minHits = minHits; this.matchMs = matchMs;
    this.now = now; this.sleep = sleep; this.pending = new Map(); this.cache = new Map(); this.controller = new AbortController();
    this.searchEvents = searchEvents === false ? null : searchEvents ?? createSoulseekSearchEvents({ baseUrl: this.baseUrl, apiKey });
    this.posts = Promise.resolve(); this.cleanups = new Set();
    this.loginFailure = loginFailure;
    this.loginWaitMs = loginWaitMs;
    this.cacheMaxTracks = cacheMaxTracks; this.cacheMaxEntries = cacheMaxEntries;
    this.pruneTimer = setInterval(() => this.pruneCache(), 30_000); this.pruneTimer.unref();
    this.offPressure = onMemoryPressure(() => this.pruneCache(Math.min(this.cacheMaxTracks, 2000)));
  }
  pruneCache(maxTracks = this.cacheMaxTracks) {
    for (const [key, value] of this.cache) if (value.until <= this.now()) this.cache.delete(key);
    let count = [...this.cache.values()].reduce((sum, value) => sum + value.hits.length, 0);
    while (this.cache.size && (count > maxTracks || this.cache.size > this.cacheMaxEntries)) {
      const key = this.cache.keys().next().value; count -= this.cache.get(key).hits.length; this.cache.delete(key);
    }
  }
  get searching() { return this.pending.values().next().value ?? null; }
  async request(path, { method = 'GET', body, signal, timeoutMs = 45_000 } = {}) {
    // Retry only search reads. A failed POST may already have created a native
    // search or transfer, so replaying mutations could duplicate the operation.
    const readAttempts = method === 'GET' && (path.startsWith('/searches/') || path === '/server') ? 2 : 1;
    for (let attempt = 0; attempt < readAttempts; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([this.controller.signal, timeout, ...(signal ? [signal] : [])]);
      let response, text;
      try {
        response = await this.fetch(`${this.baseUrl}/api/v0${path}`, { method,
          headers: { 'X-API-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: combined });
        text = await response.text();
      } catch (error) {
        this.controller.signal.throwIfAborted(); signal?.throwIfAborted();
        if (attempt + 1 < readAttempts) {
          await this.sleep(150, undefined, { signal: AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]) }); continue;
        }
        const stage = requestStage(path), timedOut = timeout.aborted || error.name === 'TimeoutError';
        throw Object.assign(new Error(timedOut
          ? `Soulseek ${stageLabel(stage)} 시간이 초과됐습니다. 연결 프로그램이 지연되고 있습니다. 잠시 후 다시 시도해주세요.`
          : `Soulseek ${stageLabel(stage)} 중 연결이 끊겼습니다. 봇의 연결 상태를 확인한 뒤 다시 시도해주세요.`),
          { kind: timedOut ? 'local_timeout' : 'local_connection', stage, code: timedOut ? 'SOULSEEK_LOCAL_TIMEOUT' : 'SOULSEEK_LOCAL_CONNECTION' });
      }
      if (!response.ok) {
        if (response.status >= 500 && attempt + 1 < readAttempts) {
          await this.sleep(150, undefined, { signal: AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]) }); continue;
        }
        throw Object.assign(requestError(response.status, text, path), { stage: requestStage(path) });
      }
      try { return text ? JSON.parse(text) : null; }
      catch { throw new Error('Soulseek 연결 프로그램의 응답을 읽지 못했습니다. 봇을 재시작한 뒤 다시 검색해주세요.'); }
    }
  }
  async waitForLogin(signal) {
    const deadline = this.now() + this.loginWaitMs;
    let lastError;
    while (this.now() < deadline) {
      try {
        const status = await this.request('/server', { signal, timeoutMs: Math.max(1, Math.min(3000, Math.floor((deadline - this.now()) / 2))) });
        if (status?.isLoggedIn) return;
      } catch (error) {
        if (!['local_timeout', 'local_connection'].includes(error.kind) && !(error.status >= 500)) throw error;
        lastError = error;
      }
      const failure = await this.loginFailure(); if (failure) throw new Error(failure);
      const remaining = deadline - this.now(); if (remaining <= 0) break;
      await this.sleep(Math.min(500, remaining), undefined, { signal });
    }
    if (lastError) throw lastError;
    throw Object.assign(new Error('Soulseek에 로그인하지 못했습니다. SOULSEEK_USERNAME / SOULSEEK_PASSWORD 설정과 서버 연결을 확인해주세요.'), { kind: 'login', stage: 'login', code: 'SOULSEEK_LOGIN_TIMEOUT' });
  }
  async search(query, { signal, acceptHits, hasRelevantHits, onProgress, searchTimeoutMs } = {}) {
    signal?.throwIfAborted(); this.controller.signal.throwIfAborted();
    query = String(query ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (query.length < 2) throw new Error('가수나 곡 제목을 두 글자 이상 입력해주세요.');
    this.pruneCache();
    const key = query.toLowerCase(), cached = this.cache.get(key);
    if (cached?.until > this.now() && (!acceptHits || acceptHits(cached.hits) ||
      cached.complete && (cached.extended || !hasRelevantHits || hasRelevantHits(cached.hits)))) {
      this.cache.delete(key); this.cache.set(key, cached);
      onProgress?.(cached.hits); return cached.hits;
    }
    let job = this.pending.get(key);
    if (!job && this.pending.size >= 2) {
      throw new Error('다른 Soulseek 검색을 처리 중입니다. 잠시 후 다시 검색해주세요.');
    }
    if (!job) {
      job = { query, key, id: randomUUID(), controller: new AbortController(), waiters: new Set() };
      this.pending.set(key, job);
      // Defer until the first caller has subscribed. Each caller owns only its
      // own cancellation, so one browser cannot cancel another's same search.
      void Promise.resolve().then(() => this.runSearch(job));
    }
    return new Promise((resolve, reject) => {
      const waiter = { acceptHits, hasRelevantHits, onProgress, resolve, reject, signal, revision: -1,
        timeoutMs: Number.isFinite(searchTimeoutMs) && searchTimeoutMs > 0 ? searchTimeoutMs : Infinity };
      waiter.abort = () => {
        this.finishWaiter(job, waiter, null, signal.reason);
        if (!job.waiters.size) { if (this.pending.get(key) === job) this.pending.delete(key); job.controller.abort(); }
      };
      job.waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
      else if (job.hits?.length) this.progress(job, waiter);
    });
  }
  progress(job, waiter) {
    if (!waiter.onProgress || waiter.revision === job.revision) return;
    waiter.revision = job.revision;
    try { waiter.onProgress(job.hits); }
    catch (error) { this.finishWaiter(job, waiter, null, error); }
  }
  finishWaiter(job, waiter, hits, error) {
    if (!job.waiters.delete(waiter)) return;
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve(hits);
  }
  async runSearch(job) {
    const { id } = job, signal = AbortSignal.any([job.controller.signal, this.controller.signal]);
    let created = false, unsubscribe, complete = false, extended = false, hits = [], changedAt = 0, statusReadError;
    const responses = new Map(); let responseRevision = 0, normalizedRevision = -1;
    try {
      signal.throwIfAborted();
      // The local API can become ready before the Soulseek login finishes.
      await this.waitForLogin(signal);
      unsubscribe = await this.searchEvents?.subscribe(id, peer => {
        if (!peer?.username || !Array.isArray(peer.files) || responses.size >= 250 && !responses.has(peer.username)) return;
        // Retain only normalized FLAC fields, not the peer's entire multi-format listing.
        // Unchanged peers keep the same track objects across progress updates.
        responses.set(peer.username, normalizeTracks([peer])); changedAt = this.now(); responseRevision++;
      });
      signal.throwIfAborted();
      const post = this.posts.catch(() => {}).then(async () => {
        signal.throwIfAborted(); created = true;
        // This bundled slskd version uses milliseconds, despite its API comment.
        return this.request('/searches', { method: 'POST', body: { id, searchText: job.query,
          searchTimeout: Math.max(5, this.extendedSearchMs), responseLimit: 250, fileLimit: 25_000 }, signal, timeoutMs: 5000 });
      });
      this.posts = post; await post;
      const started = this.now(); let checkedAt = started;
      while (job.waiters.size) {
        const elapsed = this.now() - started;
        const expired = [...job.waiters].filter(waiter => elapsed >= waiter.timeoutMs);
        // Without live responses, finalize and read the native saved list even
        // for a short search. A disconnected hub must not turn hits into zero.
        if (expired.length === job.waiters.size && (!responses.size || (!hits.length && statusReadError))) break;
        for (const waiter of expired) this.finishWaiter(job, waiter, hits);
        if (!job.waiters.size) break;
        const missing = [...job.waiters].some(waiter => waiter.hasRelevantHits ? !waiter.hasRelevantHits(hits)
          : waiter.acceptHits ? !waiter.acceptHits(hits) : !hits.length);
        const budget = missing ? this.extendedSearchMs : this.searchMs;
        if (elapsed >= budget) break;
        if (elapsed >= this.searchMs) extended = true;
        const nextDeadline = Math.min(...[...job.waiters].map(waiter => waiter.timeoutMs - elapsed));
        await this.sleep(Math.min(this.pollMs, budget - elapsed, nextDeadline), undefined, { signal });
        // Show the first peer immediately while the same search continues to
        // collect more choices. No minimum candidate count applies to display.
        if (responses.size && responseRevision !== normalizedRevision) {
          normalizedRevision = responseRevision; hits = [...responses.values()].flat().sort(compareTracks).slice(0, 25_000);
          job.hits = hits; job.revision = responseRevision;
          if (hits.length) for (const waiter of [...job.waiters]) this.progress(job, waiter);
        }
        if (!job.waiters.size) break;
        if (this.now() - checkedAt >= 1000) {
          let status;
          try { status = await this.request(`/searches/${id}`, { signal, timeoutMs: 2000 }); statusReadError = null; }
          catch (error) {
            if (!['local_timeout', 'local_connection'].includes(error.kind)) throw error;
            statusReadError = error;
          }
          checkedAt = this.now();
          if (searchErrored(status)) throw new Error('Soulseek 검색이 내부 오류로 중단되었습니다. 이미 도착한 후보는 선택할 수 있으며, 새 검색도 다시 시도할 수 있습니다.');
          if (status?.endedAt) { complete = true; break; }
        }
        if (!responses.size) continue;
        const collectedMs = this.now() - started;
        for (const waiter of [...job.waiters]) {
          const ready = waiter.acceptHits
            ? collectedMs >= this.matchMs && waiter.acceptHits(hits)
            : collectedMs >= this.minSearchMs && this.now() - changedAt >= this.settleMs && hits.length >= this.minHits && hits.some(track => track.freeSlot);
          if (ready) this.finishWaiter(job, waiter, hits);
        }
      }
      if (job.waiters.size) {
        // Cancelling first makes slskd persist responses already received; it
        // also caps a search that keeps extending its inactivity timeout.
        if (!complete) complete = await this.stopSearch(id, signal);
        const saved = await this.request(`/searches/${id}/responses`, { signal, timeoutMs: 3000 });
        const unique = new Map();
        for (const track of [...responses.values()].flat().concat(normalizeTracks(Array.isArray(saved) ? saved : []))) if (!unique.has(track.id)) unique.set(track.id, track);
        hits = [...unique.values()].sort(compareTracks).slice(0, 25_000);
        if (!hits.length && statusReadError) throw statusReadError;
        for (const waiter of [...job.waiters]) this.finishWaiter(job, waiter, hits);
      }
      if (this.pending.get(job.key) === job) {
        // Broad artist queries can contain thousands of candidates. Bound the
        // shared cache by candidate count as well as number of query keys.
        this.cache.delete(job.key);
        // Large searches still return every candidate. Avoid caching a truncated
        // list that could later hide the requested recording from a warm lookup.
        if (hits.length <= this.cacheMaxTracks) this.cache.set(job.key, { hits, complete, extended, until: this.now() + (hits.length ? 120_000 : 5000) });
        this.pruneCache();
      }
    } catch (error) {
      for (const waiter of [...job.waiters]) this.finishWaiter(job, waiter, null, error);
    } finally {
      unsubscribe?.();
      responses.clear(); job.hits = null;
      if (this.pending.get(job.key) === job) this.pending.delete(job.key);
      if (created) {
        // Local cleanup must not add up to five seconds to a usable result.
        const cleanup = (async () => {
          const ended = complete || await this.stopSearch(id);
          if (ended) await this.request(`/searches/${id}`, { method: 'DELETE', timeoutMs: 2000 });
        })().catch(() => {});
        this.cleanups.add(cleanup); void cleanup.finally(() => this.cleanups.delete(cleanup));
      }
    }
  }
  async stopSearch(id, signal) {
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        try { await this.request(`/searches/${id}`, { method: 'PUT', signal, timeoutMs: 2000 }); break; }
        catch (error) {
          // A browser can cancel its POST before the local service has created
          // the record. Give that record a bounded chance to appear.
          if (error.status !== 404 || attempt === 7) throw error;
          await this.sleep(100, undefined, { signal });
        }
      }
      // Completed can be published before the response list is saved. EndedAt
      // belongs to the final persisted record, so wait for that instead.
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await this.request(`/searches/${id}`, { signal, timeoutMs: 2000 });
        if (result?.endedAt) return true;
        await this.sleep(100, undefined, { signal });
      }
    } catch (error) { if (signal?.aborted || this.controller.signal.aborted) throw error; }
    return false;
  }
  async enqueue(track, id) {
    const result = await this.request('/transfers/downloads/batches', { method: 'POST', body: {
      id, username: track.username, files: [{ filename: track.filename, size: track.size }], options: { destination: id } }, timeoutMs: 10_000 });
    if (result.failures?.length) throw Object.assign(new Error('이 파일은 이미 받는 중이거나 상대방이 전송을 거부했습니다. 다른 검색 결과를 선택해주세요.'), { kind: 'peer_unavailable' });
    return result.batch;
  }
  async transfer(id, { signal, timeoutMs } = {}) { const batch = await this.request(`/transfers/downloads/batches/${id}`, { signal, timeoutMs }); return batch.transfers?.[0]; }
  async cancel(id) {
    const transfer = await this.transfer(id, { timeoutMs: 5000 }).catch(error => { if (error.status === 404) return null; throw error; });
    if (transfer) await this.request(`/transfers/downloads/${encodeURIComponent(transfer.username)}/${transfer.id}?remove=true`, { method: 'DELETE', timeoutMs: 5000 });
  }
  close() { clearInterval(this.pruneTimer); this.offPressure(); this.controller.abort(); this.searchEvents?.close(); this.cache.clear(); }
}
