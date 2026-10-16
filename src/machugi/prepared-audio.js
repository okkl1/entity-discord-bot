import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { ffmpegPath, ffmpegFailure } from "../ffmpeg.js"
import prism from "prism-media"

export const MAX_PREPARED_SECONDS = 30

// Decode and encode a finite excerpt once, using FFmpeg's native Opus encoder.
export function encodeClip(inputArgs, duration, { signal, timeoutMs = 20_000, source } = {}) {
  signal?.throwIfAborted()
  const fade = Math.min(0.015, duration / 4)
  const ff = spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-nostdin", ...inputArgs,
    "-t", String(duration), "-vn",
    "-af", `volume=0.6,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`,
    "-ar", "48000", "-ac", "2", "-c:a", "libopus", "-b:a", "96k",
    "-frame_duration", "20", "-application", "audio", "-f", "ogg",
    "-page_duration", "20000", "pipe:1",
  ], { stdio: [source ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true })
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
