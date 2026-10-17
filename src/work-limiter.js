// Share expensive extractors across web searches, foreground audio and prefetch.
export class WorkLimiter {
  constructor(limit = 1) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire({ signal, priority = false } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const job = { signal, priority, resolve, reject };
      job.abort = () => { this.queue = this.queue.filter(value => value !== job); reject(signal.reason); };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  pump() {
    while (this.active < this.limit && this.queue.length) {
      const preferred = this.queue.findIndex(job => job.priority);
      const [job] = this.queue.splice(preferred < 0 ? 0 : preferred, 1);
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      this.active++; let released = false;
      job.resolve(() => { if (released) return; released = true; this.active--; this.pump(); });
    }
  }
  async run(task, options) {
    const release = await this.acquire(options);
    try { options?.signal?.throwIfAborted(); return await task(); } finally { release(); }
  }
}
