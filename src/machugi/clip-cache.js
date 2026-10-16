// Bounded, shared preparation queue. Foreground requests outrank speculative work.
export class ClipCache {
  constructor(load, { concurrency = 2, maxBytes = 16 * 1024 * 1024,
    maxEntries = 64, ttlMs = 15 * 60_000, failureTtlMs = 30_000, now = Date.now } = {}) {
    Object.assign(this, { load, concurrency, maxBytes, maxEntries, ttlMs, failureTtlMs, now })
    this.entries = new Map()
    this.jobs = new Map()
    this.queue = []
    this.active = 0
    this.bytes = 0
  }

  get(key, options, { signal, priority = false } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    this.prune()
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.value)
    }
    let job = this.jobs.get(key)
    if (!job) {
      job = { key, options, controller: new AbortController(), consumers: new Set(), priority, started: false }
      this.jobs.set(key, job)
      this.queue.push(job)
    }
    if (priority) job.priority = true
    const promise = new Promise((resolve, reject) => {
      const consumer = { resolve, reject, signal, abort: null }
      consumer.abort = () => {
        signal.removeEventListener("abort", consumer.abort)
        job.consumers.delete(consumer)
        reject(signal.reason ?? new Error("재생 준비 취소"))
        if (!job.consumers.size) {
          if (this.jobs.get(key) === job) this.jobs.delete(key)
          this.queue = this.queue.filter(queued => queued !== job)
          job.controller.abort()
        }
      }
      job.consumers.add(consumer)
      signal?.addEventListener("abort", consumer.abort, { once: true })
      if (signal?.aborted) consumer.abort()
    })
    this.pump()
    return promise
  }

  prune() {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) {
        this.bytes -= entry.bytes
        this.entries.delete(key)
      }
    }
  }

  clear() { this.entries.clear(); this.bytes = 0 }

  store(job, value, error) {
    const bytes = value?.bytes ?? 0
    if (bytes > this.maxBytes) return
    this.prune()
    this.entries.set(job.key, { value, error, bytes,
      expiresAt: this.now() + (error ? this.failureTtlMs : this.ttlMs) })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      this.bytes -= this.entries.get(oldest).bytes
      this.entries.delete(oldest)
    }
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const preferred = this.queue.findIndex(job => job.priority)
      const [job] = this.queue.splice(preferred < 0 ? 0 : preferred, 1)
      if (!job.consumers.size) continue
      job.started = true
      this.active++
      void this.execute(job)
    }
  }

  async execute(job) {
    let value, error
    try { value = await this.load(job.options, job.controller.signal) }
    catch (err) { error = err }
    if (!job.controller.signal.aborted) this.store(job, value, error)
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    for (const consumer of job.consumers) {
      consumer.signal?.removeEventListener("abort", consumer.abort)
      if (error) consumer.reject(error)
      else consumer.resolve(value)
    }
    job.consumers.clear()
    this.active--
    this.pump()
  }
}
