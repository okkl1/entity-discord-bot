import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { ffmpegPath, ffmpegFailure } from "../ffmpeg.js"
import prism from "prism-media"
import { acquireTranscode, audioInputOptions, opusOutputOptions, trackMediaProcess } from "../media-resources.js"

export const MAX_PREPARED_SECONDS = 30

// Decode and encode a finite excerpt once, using FFmpeg's native Opus encoder.
export async function encodeClip(inputArgs, duration, { signal, timeoutMs = 20_000, source } = {}) {
  signal?.throwIfAborted()
  const sourceFailure = new AbortController()
  const earlySourceError = error => sourceFailure.abort(error)
  source?.on('error', earlySourceError)
  const queueSignal = source ? AbortSignal.any([sourceFailure.signal, ...(signal ? [signal] : [])]) : signal
  let release
  try { release = await acquireTranscode({ signal: queueSignal }) }
  catch (error) { source?.kill(); throw error }
  finally { source?.off('error', earlySourceError) }
  const fade = Math.min(0.015, duration / 4)
  const ff = trackMediaProcess('ffmpeg', spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", ...audioInputOptions(), ...inputArgs,
    "-t", String(duration), "-vn",
    "-af", `volume=0.6,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`,
    ...opusOutputOptions(),
  ], { stdio: [source ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true }), release)
  const demuxer = new prism.opus.OggDemuxer()
  const packets = []
  let bytes = 0, stderr = "", closed = false, ended = false, done = false
  return new Promise((resolve, reject) => {
    const finish = error => {
      if (done) return
      if (!error && (!closed || !ended)) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      ff.stdout.unpipe(demuxer)
      demuxer.destroy()
      source?.stdout.unpipe(ff.stdin)
      source?.kill()
      if (error) { ff.kill(); reject(error) }
      else if (!packets.length) reject(new Error("영상에서 오디오 출력이 없습니다."))
      else resolve({ packets, bytes, durationMs: packets.length * 20 })
    }
    const abort = () => finish(signal.reason ?? new Error("재생 준비 취소"))
    const timer = setTimeout(() => finish(new Error("오디오 준비 시간 초과")), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    ff.on("error", finish)
    ff.stdout.on("error", finish)
    source?.on("error", finish)
    source?.on("close", code => {
      if (code !== 0 && !done) finish(new Error(`영상 다운로드 실패 (${code}): ${stderr.trim()}`))
    })
    source?.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000) })
    if (source) {
      ff.stdin.on("error", error => {
        if (!["EPIPE", "EOF", "ERR_STREAM_DESTROYED"].includes(error.code)) finish(error)
      })
      source.stdout.pipe(ff.stdin)
    }
    demuxer.on("error", finish)
    ff.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000) })
    demuxer.on("data", packet => {
      bytes += packet.length
      if (bytes > 2 * 1024 * 1024) { finish(new Error("재생 구간 캐시 크기 초과")); return }
      packets.push(Buffer.from(packet))
    })
    demuxer.on("end", () => { ended = true; finish() })
    ff.on("close", (code, signal) => {
      closed = true
      if (code !== 0) finish(ffmpegFailure(code, signal, { bytes, stderr }))
      else finish()
    })
    ff.stdout.pipe(demuxer)
  })
}

// Start on the first encoded frame, keeping compressed frames for subsequent
// loops. A three-minute excerpt no longer retains minutes of decoded PCM or
// re-encodes the same samples on every repetition.
export class GrowingOpusLoop extends Readable {
  constructor({ maxBytes = 8 * 1024 * 1024 } = {}) {
    super({ objectMode: true, highWaterMark: 4 })
    this.maxBytes = maxBytes; this.bytes = 0; this.packets = []; this.index = 0
    this.complete = false; this.demand = false; this.pumping = false
  }
  append(packet) {
    if (this.destroyed || this.complete) return
    if (this.bytes + packet.length > this.maxBytes) {
      this.destroy(new Error("반복 재생 구간이 너무 큽니다. 더 짧은 구간의 퀴즈를 선택해주세요.")); return
    }
    this.bytes += packet.length; this.packets.push(Buffer.from(packet)); this.pump()
  }
  finishInput() { this.complete = true; this.pump() }
  _read() { this.demand = true; this.pump() }
  pump() {
    if (this.pumping || this.destroyed) return
    this.pumping = true
    try {
      while (this.demand && !this.destroyed) {
        if (this.index === this.packets.length) {
          if (!this.complete) break
          if (!this.packets.length) { this.push(null); break }
          this.index = 0
        }
        this.demand = this.push(this.packets[this.index++])
      }
    } finally { this.pumping = false }
  }
  _destroy(error, callback) { this.packets = []; this.bytes = 0; callback(error) }
}

export class OpusPacketStream extends Readable {
  constructor(packets, { loop = true } = {}) {
    super({ objectMode: true, highWaterMark: 4 })
    this.packets = packets
    this.loop = loop
    this.index = 0
  }
  _read() {
    if (!this.packets.length) { this.push(null); return }
    do {
      if (this.index === this.packets.length) {
        if (!this.loop) { this.push(null); return }
        this.index = 0
      }
    } while (this.push(this.packets[this.index++]))
  }
  _destroy(error, callback) {
    this.packets = []
    callback(error)
  }
}
