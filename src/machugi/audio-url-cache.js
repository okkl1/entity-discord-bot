// Short-lived signed YouTube URLs: share lookups and reuse only before expiry.
import { ClipCache } from "./clip-cache.js"

export class AudioUrlCache {
  constructor(load, { ttlMs = 15 * 60_000, maxEntries = 100, now = Date.now, concurrency = 2 } = {}) {
    this.load = load
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.entries = new Map()
    this.requests = new ClipCache(async ({ key }, signal) => ({ url: await this.load(key, signal), bytes: 0 }),
      { concurrency, maxEntries: 0, now })
    this.pending = this.requests.jobs
  }

  get(key, options = {}) {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt > this.now()) {
      this.entries.delete(key)
      this.entries.set(key, entry)
      return Promise.resolve(entry.url)
    }
    this.entries.delete(key)
    return this.requests.get(key, { key }, options).then(({ url }) => {
      const now = this.now()
      let expiresAt = now + this.ttlMs
      try {
        const expiry = Number(new URL(url).searchParams.get("expire"))
        if (Number.isFinite(expiry) && expiry > 0) {
          expiresAt = Math.min(expiresAt, expiry * 1000 - 60_000)
        }
      } catch {}

      for (const [cachedKey, cached] of this.entries) {
        if (cached.expiresAt <= now) this.entries.delete(cachedKey)
      }
      if (expiresAt > now) {
        this.entries.set(key, { url, expiresAt })
        while (this.entries.size > this.maxEntries) {
          this.entries.delete(this.entries.keys().next().value)
        }
      }
      return url
    })
  }

  invalidate(key, expectedUrl) {
    if (expectedUrl === undefined || this.entries.get(key)?.url === expectedUrl) {
      this.entries.delete(key)
    }
  }
}
