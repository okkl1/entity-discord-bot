// Keep Discord edits ordered and collapse queued updates to the newest state.
export class PanelUpdateQueue {
  constructor(edit) {
    this.edit = edit
    this.pending = null
    this.running = false
  }
  submit(options) {
    if (!this.pending) this.pending = { options: {}, waiters: [] }
    Object.assign(this.pending.options, options)
    const promise = new Promise(resolve => this.pending.waiters.push(resolve))
    void this.drain()
    return promise
  }
  async drain() {
    if (this.running) return
    this.running = true
    while (this.pending) {
      const update = this.pending
      this.pending = null
      try { await this.edit(update.options) }
      catch (error) { console.warn("[v0] panel edit failed:", error.message) }
      for (const finish of update.waiters) finish()
    }
    this.running = false
  }
}
