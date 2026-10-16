import test from "node:test"
import assert from "node:assert/strict"
import { ClipCache } from "../src/machugi/clip-cache.js"
import { AudioUrlCache } from "../src/machugi/audio-url-cache.js"
import { PanelUpdateQueue } from "../src/machugi/panel-update-queue.js"
import { encodeClip, OpusPacketStream } from "../src/machugi/prepared-audio.js"
import prism from "prism-media"
import { performance } from "node:perf_hooks"
import { spawn } from "node:child_process"
import ffmpegPath from "ffmpeg-static"

const tick = () => new Promise(resolve => setImmediate(resolve))
const value = name => ({ packets: [Buffer.from(name)], bytes: name.length })

test("clip cache shares preparation, prioritizes playback and limits concurrency", async () => {
  const starts = [], finish = new Map()
  const cache = new ClipCache(name => new Promise(resolve => {
    starts.push(name)
    finish.set(name, () => resolve(value(name)))
  }), { concurrency: 1 })
  const a = cache.get("a", "a")
  const b = cache.get("b", "b")
  const c = cache.get("c", "c")
  const urgent = cache.get("c", "c", { priority: true })
  assert.deepEqual(starts, ["a"])
  finish.get("a")()
  await a
  assert.deepEqual(starts, ["a", "c"])
  finish.get("c")()
  assert.equal(await c, await urgent)
  assert.deepEqual(starts, ["a", "c", "b"])
  finish.get("b")()
  await b
  await cache.get("c", "c")
  assert.equal(starts.length, 3)
})

test("cancelled speculative work cannot block the next clip or cancel a shared consumer", async () => {
  const finish = new Map(), starts = []
  const cache = new ClipCache((name, signal) => new Promise((resolve, reject) => {
    starts.push(name)
    finish.set(name, () => resolve(value(name)))
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  }), { concurrency: 1 })
  const abandoned = new AbortController()
  const a = cache.get("a", "a", { signal: abandoned.signal }).catch(() => "cancelled")
  const kept = cache.get("a", "a")
  abandoned.abort()
  assert.equal(await a, "cancelled")
  assert.equal(cache.active, 1)
  finish.get("a")()
  await kept
  const cancel = new AbortController()
  const b = cache.get("b", "b", { signal: cancel.signal }).catch(() => "cancelled")
  const next = cache.get("next", "next", { priority: true })
  cancel.abort()
  assert.equal(await b, "cancelled")
  await tick()
  assert.deepEqual(starts, ["a", "b", "next"])
  finish.get("next")()
  await next
  assert.equal(cache.entries.has("b"), false)
})

test("cache respects memory bounds, expiry and failed-video cooldown", async () => {
  let time = 0, loads = 0
  const cache = new ClipCache(async name => {
    loads++
    if (name === "broken") throw Error("Video unavailable")
    return value(name)
  }, { maxBytes: 4, ttlMs: 10, failureTtlMs: 3, now: () => time })
  await cache.get("aaa", "aaa")
  await cache.get("bbb", "bbb")
  assert.equal(cache.entries.has("aaa"), false)
  assert.equal(cache.bytes, 3)
  await assert.rejects(cache.get("broken", "broken"))
  await assert.rejects(cache.get("broken", "broken"))
  assert.equal(loads, 3)
  time = 4
  await assert.rejects(cache.get("broken", "broken"))
  assert.equal(loads, 4)
  time = 11
  await cache.get("bbb", "bbb")
  assert.equal(loads, 5)
})

test("Discord panel edits are ordered and redundant pending states collapse", async () => {
  const calls = [], finish = []
  const queue = new PanelUpdateQueue(opts => new Promise(resolve => {
    calls.push(opts)
    finish.push(resolve)
  }))
  const a = queue.submit({ embeds: ["round1"] })
  const b = queue.submit({ embeds: ["result1"], content: "permission warning" })
  const c = queue.submit({ embeds: ["round2"] })
  assert.equal(calls.length, 1)
  finish[0]()
  await a
  assert.deepEqual(calls[1], { embeds: ["round2"], content: "permission warning" })
  finish[1]()
  await Promise.all([b, c])
  assert.equal(calls.length, 2)
})

test("real FFmpeg prepares valid Opus audio; cached replay avoids encoding", async () => {
  let loads = 0
  const cache = new ClipCache(async () => {
    loads++
    return encodeClip(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5"], 5)
  })
  const before = performance.now()
  const clip = await cache.get("fixture", {})
  const coldMs = performance.now() - before
  assert.ok(clip.packets.length >= 250 && clip.packets.length <= 252)
  assert.ok(clip.bytes > 0)
  const warmStart = performance.now()
  const cached = await cache.get("fixture", {})
  const warmMs = performance.now() - warmStart
  assert.equal(cached, clip)
  assert.equal(loads, 1)
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
  let pcmBytes = 0
  decoder.on("data", chunk => { pcmBytes += chunk.length })
  const decoded = new Promise((resolve, reject) => { decoder.on("end", resolve); decoder.on("error", reject) })
  const input = new OpusPacketStream(clip.packets, { loop: false })
  input.pipe(decoder)
  await decoded
  assert.equal(pcmBytes, clip.packets.length * 3840)
  const loop = new OpusPacketStream(clip.packets)
  let count = 0
  for await (const packet of loop) {
    assert.equal(packet, clip.packets[count % clip.packets.length])
    if (++count === clip.packets.length + 3) break
  }
  assert.equal(loop.destroyed, true)
  console.log(`[bench] 5s local fixture: cold=${coldMs.toFixed(1)}ms, cache=${warmMs.toFixed(3)}ms, bytes=${clip.bytes}`)
})

test("real FFmpeg preparation can be cancelled and rejects missing audio", async () => {
  const controller = new AbortController()
  const pending = encodeClip(["-re", "-f", "lavfi", "-i", "sine=duration=30"], 30, { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
  await assert.rejects(encodeClip(["-f", "lavfi", "-i", "sine=duration=0.1", "-ss", "10"], 1), /출력이 없습니다/)
})

test("pipe fallback prepares a finite excerpt and stops its source", async () => {
  const source = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=330:duration=5", "-f", "wav", "pipe:1"],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  const clip = await encodeClip(["-i", "pipe:0", "-ss", "1"], 1, { source })
  assert.ok(clip.packets.length >= 50)
  assert.ok(source.killed || source.exitCode === 0)
})

test("URL lookups share work, cancel abandoned requests and never exceed two extractors", async () => {
  const starts = [], finish = new Map()
  let active = 0, maxActive = 0
  const cache = new AudioUrlCache((key, signal) => new Promise((resolve, reject) => {
    active++
    maxActive = Math.max(maxActive, active)
    starts.push(key)
    let settled = false
    const end = cancelled => {
      if (settled) return
      settled = true
      active--
      if (cancelled) reject(signal.reason)
      else resolve(`https://example.test/${key}`)
    }
    signal.addEventListener("abort", () => end(true), { once: true })
    finish.set(key, () => end(false))
  }))
  const controller = new AbortController()
  const a = cache.get("a", { signal: controller.signal }).catch(() => "cancelled")
  const b = cache.get("b")
  const c = cache.get("c", { priority: true })
  assert.deepEqual(starts, ["a", "b"])
  controller.abort()
  assert.equal(await a, "cancelled")
  await tick()
  assert.deepEqual(starts, ["a", "b", "c"])
  finish.get("b")()
  finish.get("c")()
  await Promise.all([b, c])
  assert.equal(maxActive, 2)
  const cached = await cache.get("c")
  assert.equal(cached, "https://example.test/c")
  assert.equal(starts.length, 3)
})

test("URL cache honors signed expiry and preserves a newer URL during invalidation", async () => {
  let now = 0, loads = 0
  const cache = new AudioUrlCache(async () => { loads++; return `https://example.test/audio?expire=${loads * 120}&load=${loads}` }, { now: () => now })
  const first = await cache.get("video")
  assert.equal(await cache.get("video"), first)
  now = 61_000
  const second = await cache.get("video")
  assert.notEqual(second, first)
  cache.invalidate("video", first)
  assert.equal(await cache.get("video"), second)
  assert.equal(loads, 2)
})
