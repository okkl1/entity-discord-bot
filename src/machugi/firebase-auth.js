import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const headers = { Referer: 'https://machugi.io/', Origin: 'https://machugi.io' };
const fingerprint = key => createHash('sha256').update(key).digest('hex');

export class FirebaseAuth {
  constructor({ fetchImpl = fetch, now = Date.now, cacheFile = null } = {}) {
    Object.assign(this, { fetchImpl, now, cacheFile });
    this.entries = new Map(); this.pending = new Map(); this.blockedUntil = new Map();
  }
  async getToken(apiKey) {
    if (!apiKey) throw new Error('퀴즈 인증 API 설정이 비어 있습니다.');
    const entry = this.entries.get(apiKey);
    if (entry?.idToken && entry.expiresAt > this.now() + 60_000) return entry.idToken;
    if (this.blockedUntil.get(apiKey) > this.now()) throw new Error('퀴즈 인증 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시작해주세요.');
    if (this.pending.has(apiKey)) return this.pending.get(apiKey);
    const request = this.acquire(apiKey);
    this.pending.set(apiKey, request);
    try { return await request; } finally { this.pending.delete(apiKey); }
  }
  async acquire(apiKey) {
    let entry = this.entries.get(apiKey);
    if (!entry && this.cacheFile) {
      try {
        const saved = JSON.parse(await readFile(this.cacheFile, 'utf8'));
        if (saved.keyHash === fingerprint(apiKey) && typeof saved.refreshToken === 'string' && typeof saved.idToken === 'string') {
          entry = saved; this.entries.set(apiKey, entry);
          if (entry.expiresAt > this.now() + 60_000) return entry.idToken;
        }
      } catch (error) { if (error.code !== 'ENOENT') console.warn('[quiz] 저장된 인증 캐시를 읽지 못했습니다.'); }
    }
    let data;
    if (entry?.refreshToken) {
      const res = await this.fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: entry.refreshToken }), signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json();
      if (res.ok) data = { idToken: body.id_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
      else if (!['INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND'].includes(body.error?.message)) this.fail(apiKey, res.status, body);
    }
    if (!data) {
      const res = await this.fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true }), signal: AbortSignal.timeout(10_000),
      });
      data = await res.json();
      if (!res.ok) this.fail(apiKey, res.status, data);
    }
    if (!data.idToken || !data.refreshToken || !Number.isFinite(Number(data.expiresIn)) || Number(data.expiresIn) <= 0) throw new Error('퀴즈 인증 응답이 올바르지 않습니다.');
    const saved = { keyHash: fingerprint(apiKey), idToken: data.idToken, refreshToken: data.refreshToken, expiresAt: this.now() + Number(data.expiresIn) * 1000 };
    this.entries.set(apiKey, saved);
    if (this.cacheFile) {
      try {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        const temp = `${this.cacheFile}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
        await rename(temp, this.cacheFile);
      } catch { console.warn('[quiz] 인증 캐시를 저장하지 못했습니다. 현재 프로세스의 인증은 유지됩니다.'); }
    }
    return saved.idToken;
  }
  fail(apiKey, status, body) {
    const code = body.error?.message ?? 'UNKNOWN';
    if (status === 429 || code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
      this.blockedUntil.set(apiKey, this.now() + 60_000);
      throw new Error('퀴즈 인증 요청이 일시적으로 제한되었습니다. 잠시 후 다시 시작해주세요.');
    }
    throw new Error(`퀴즈 인증 실패 (${status}: ${String(code).slice(0, 80)})`);
  }
}
