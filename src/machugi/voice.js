/**
 * Discord 음성 채널 연결 + 유튜브 스트리밍 (yt-dlp 기반).
 *
 * @distube/ytdl-core 대신 yt-dlp를 사용합니다.
 * - ytdl-core는 YouTube API 변경에 취약하여 "Failed to find any playable formats" 에러 빈발
 * - yt-dlp는 독립 바이너리로 업데이트가 빠르고 안정적
 *
 * 전략:
 * 1) yt-dlp --get-url 로 직접 오디오 URL 획득
 * 2) ffmpeg가 해당 URL에서 -ss(input seeking) + -t(duration) 으로 구간 재생
 *    → HTTP URL 입력이므로 input seeking이 정상 작동
 * 3) 실패 시 fallback: yt-dlp → pipe → ffmpeg
 *
 * "The operation was aborted" 방지 전략:
 * 1) 암호화 라이브러리(libsodium + tweetnacl)를 첫 연결 전에 미리 로드
 * 2) Disconnected 상태에서 자동 재연결 (Signalling/Connecting 5초 경쟁)
 * 3) entersState(Ready) 실패해도 connection을 파괴하지 않음
 * 4) 기존 connection이 남아있으면 반드시 새로 생성 (stale 연결 재사용 금지)
 */

import { spawn, execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PassThrough } from "node:stream"
import { promisify } from "node:util"
import ffmpegPath from "ffmpeg-static"
import { AudioUrlCache } from "./audio-url-cache.js"
import { resolveYtDlpPath } from "./yt-dlp-path.js"
import { ytDlpOptions, youtubeFailure } from "./yt-dlp-options.js"
import { clipLoopFilter } from "./audio-loop.js"
import { monitorPlayback } from "./playback-monitor.js"
import { ClipCache } from "./clip-cache.js"
import { resources, onMemoryPressure } from "../resource-profile.js"
import { encodeClip, OpusPacketStream, MAX_PREPARED_SECONDS } from "./prepared-audio.js"
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  AudioPlayerStatus,
  getVoiceConnection,
  generateDependencyReport,
} from "@discordjs/voice"

const execFileAsync = promisify(execFile)

// yt-dlp 바이너리 경로 — PATH에 없으면 절대경로 사용
const YT_DLP_PATH =
  resolveYtDlpPath(process.env.YT_DLP_PATH,
    fileURLToPath(new URL("../../bin/yt-dlp.exe", import.meta.url)))

let cryptoReady = null
let reportPrinted = false
const audioUrls = new AudioUrlCache(fetchAudioUrl)
const unavailableVideos = new Map()
const preparedClips = new ClipCache(async ({ videoId, startSeconds, duration }, signal) => {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
  let audioUrl
  try {
    audioUrl = await getAudioUrl(videoUrl, { signal })
  } catch (err) {
    signal.throwIfAborted()
    if (youtubeFailure(err) || isUnavailableError(err) || unavailableVideos.get(videoUrl) > Date.now()) throw err
    const source = spawn(YT_DLP_PATH, [...ytDlpOptions(), "--no-playlist", "-f", "bestaudio", "-o", "-", videoUrl],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    return encodeClip(["-i", "pipe:0", "-ss", String(startSeconds)], duration, { signal, source })
  }
  signal.throwIfAborted()
  try {
    return await encodeClip(["-rw_timeout", "8000000", "-ss", String(startSeconds), "-i", audioUrl], duration, { signal })
  } catch (err) {
    if (!signal.aborted) audioUrls.invalidate(videoUrl, audioUrl)
    throw err
  }
}, { concurrency: resources.clipConcurrency, maxBytes: resources.clipCacheBytes })

onMemoryPressure(() => preparedClips.clear())

function preparedClip(videoId, startSeconds, duration, options) {
  return preparedClips.get(JSON.stringify([videoId, startSeconds, duration]), { videoId, startSeconds, duration }, options)
}

export function prefetchQuizClip(question, { signal } = {}) {
  if (!question?.video_id) return Promise.resolve(false)
  const start = Number(question.start_seconds || 0)
  const end = Number(question.end_seconds || start + 5)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return Promise.resolve(false)
  const duration = Math.max(0.5, end - start)
  const ready = duration <= MAX_PREPARED_SECONDS
    ? preparedClip(question.video_id, start, duration, { signal })
    : getAudioUrl(`https://www.youtube.com/watch?v=${question.video_id}`, { signal })
  return ready.then(() => true, err => {
    if (!signal?.aborted) console.warn(`[v0] clip prefetch failed (${question.video_id}):`, err.message)
    return false
  })
}

function startPreparedClip(player, clip, signal) {
  signal?.throwIfAborted()
  const stream = new OpusPacketStream(clip.packets)
  const resource = createAudioResource(stream, { inputType: StreamType.Opus, silencePaddingFrames: 2 })
  let resolveFailure
  const failure = new Promise(resolve => { resolveFailure = resolve })
  const onError = error => { if (player.state.resource === resource || error.resource === resource) resolveFailure(error) }
  const onStreamError = error => resolveFailure(error)
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    signal?.removeEventListener("abort", cleanup)
    player.off("error", onError)
    stream.off("error", onStreamError)
    if (player.state.resource === resource) player.stop(true)
    stream.destroy()
  }
  player.on("error", onError)
  stream.on("error", onStreamError)
  signal?.addEventListener("abort", cleanup, { once: true })
  try { player.play(resource) } catch (error) { cleanup(); throw error }
  return { resource, cleanup, failure }
}

function isUnavailableError(err) {
  return /video unavailable|private video|video has been removed|video has been deleted|not available in your country|blocked.*copyright|account.*terminated|members.only|sign in to confirm your age/i.test(String(err?.stderr ?? err?.message ?? err))
}

async function getAudioUrl(videoUrl, options) {
  const blockedUntil = unavailableVideos.get(videoUrl)
  if (blockedUntil > Date.now()) throw new Error("재생 불가능한 영상 (임시 제외)")
  unavailableVideos.delete(videoUrl)
  try {
    return await audioUrls.get(videoUrl, options)
  } catch (err) {
    if (isUnavailableError(err)) unavailableVideos.set(videoUrl, Date.now() + 30 * 60_000)
    throw err
  }
}

/**
 * 암호화 라이브러리를 초기화한다. 한 번만 수행되고 이후 호출은 캐시됨.
 * 이 초기화가 안 되면 UDP 핸드셰이크가 실패해 abort 된다.
 *
 * 우선순위: sodium-native > libsodium-wrappers > tweetnacl
 */
function initCrypto() {
  if (cryptoReady) return cryptoReady
  cryptoReady = (async () => {
    // sodium-native — 네이티브 C 바인딩, 가장 빠르고 안정적
    try {
      await import("sodium-native")
      console.log("[v0] voice: sodium-native ready ✅")
      return // 하나라도 성공하면 충분
    } catch (err) {
      console.warn("[v0] voice: sodium-native 로드 실패:", err.message)
    }
    // libsodium-wrappers — WASM 기반 (ESM에서 깨질 수 있음)
    try {
      const sodium = await import("libsodium-wrappers")
      await sodium.default.ready
      console.log("[v0] voice: libsodium-wrappers ready ✅")
      return
    } catch (err) {
      console.warn("[v0] voice: libsodium-wrappers 로드 실패:", err.message)
    }
    // tweetnacl — 순수 JS
    try {
      await import("tweetnacl")
      console.log("[v0] voice: tweetnacl ready ✅")
    } catch (err) {
      console.warn("[v0] voice: tweetnacl 로드 실패:", err.message)
      console.error("[v0] voice: ⚠️ 암호화 라이브러리를 하나도 로드하지 못했습니다!")
      console.error("[v0] voice: 음성 연결이 실패할 수 있습니다.")
    }
  })()
  return cryptoReady
}

function printReportOnce() {
  if (reportPrinted) return
  reportPrinted = true
  console.log("[v0] voice dependency report:\n" + generateDependencyReport())
}

/**
 * 봇을 음성 채널에 연결한다.
 * - 기존 stale connection은 반드시 파괴 후 새로 생성
 * - Ready 대기 최대 15초, 실패 시 최대 3회 재시도
 * - debug 이벤트로 UDP 핸드셰이크 과정을 상세 로깅
 */
export async function connectToVoice(voiceChannel) {
  await initCrypto()
  printReportOnce()

  // 같은 채널에 이미 Ready 상태면 그대로 재사용
  const existing = getVoiceConnection(voiceChannel.guild.id)
  if (
    existing &&
    existing.joinConfig.channelId === voiceChannel.id &&
    existing.state.status === VoiceConnectionStatus.Ready
  ) {
    console.log("[v0] voice: reusing existing Ready connection")
    return existing
  }
  if (existing) {
    console.log(`[v0] voice: destroying stale connection (status=${existing.state.status})`)
    try {
      existing.destroy()
    } catch {}
    // 파괴 후 잠시 대기
    await new Promise(r => setTimeout(r, 500))
  }

  const MAX_RETRIES = 3
  const READY_TIMEOUT = 15_000

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[v0] voice: joining channel ${voiceChannel.name} (attempt ${attempt}/${MAX_RETRIES})`)

    // 이전 시도의 연결이 남아있으면 정리
    if (attempt > 1) {
      const prev = getVoiceConnection(voiceChannel.guild.id)
      if (prev) {
        try { prev.destroy() } catch {}
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,

    })

    // 상태 전이 로깅
    connection.on("stateChange", (oldState, newState) => {
      console.log(`[v0] voice: state ${oldState.status} -> ${newState.status}`)
    })



    connection.on("error", (err) => {
      console.error("[v0] voice: connection error:", err.message)
    })

    // Disconnected 상태 복구
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ])
        console.log("[v0] voice: disconnect recovered (reconnecting)")
      } catch {
        console.warn("[v0] voice: disconnect unrecoverable, destroying")
        try {
          connection.destroy()
        } catch {}
      }
    })

    // Ready 대기
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT)
      console.log("[v0] voice: Ready ✅")
      return connection
    } catch (err) {
      console.warn(
        `[v0] voice: Ready 대기 실패 (attempt ${attempt}) —`,
        err.message,
      )
      if (attempt < MAX_RETRIES) {
        console.log("[v0] voice: 재시도합니다...")
        try { connection.destroy() } catch {}
        await new Promise(r => setTimeout(r, 2000))
      } else {
        console.warn("[v0] voice: 모든 재시도 실패. 현재 연결로 재생을 시도합니다.")
        console.warn("[v0] voice: Windows 방화벽 → 앱 허용에서 Node.js를 허용해 주세요.")
        return connection
      }
    }
  }
}

export function createPlayer() {
  return createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  })
}

/**
 * yt-dlp로 YouTube 영상의 직접 오디오 URL을 가져온다.
 */
async function fetchAudioUrl(videoUrl, signal) {
  const startedAt = Date.now()
  console.log(`[v0] yt-dlp: getting audio URL for ${videoUrl}`)
  try {
    const { stdout } = await execFileAsync(YT_DLP_PATH, [
      ...ytDlpOptions(),
      "--no-playlist",
      "-f", "bestaudio",
      "--get-url",
      videoUrl,
    ], { timeout: 15_000, windowsHide: true, signal })

    const url = stdout.trim()
    if (!url) throw new Error("yt-dlp returned empty URL")
    console.log(`[v0] yt-dlp: got audio URL in ${Date.now() - startedAt}ms (${url.length} chars)`)
    return url
  } catch (err) {
    const authError = youtubeFailure(err)
    if (!signal?.aborted) console.error(`[v0] yt-dlp --get-url failed:`, authError?.message || err.message)
    throw authError || err
  }
}

// 다음 문제는 현재 문제 진행/음성 연결 중 준비한다. 실패하면 재생 시 재시도.
export function prefetchYouTubeAudio(videoId) {
  if (!videoId) return Promise.resolve(false)
  return getAudioUrl(`https://www.youtube.com/watch?v=${videoId}`).then(
    () => true,
    err => {
      console.warn(`[v0] audio prefetch failed (${videoId}):`, err.message)
      return false
    },
  )
}

/**
 * 유튜브 영상을 [start, end] 구간만 재생.
 *
 * yt-dlp로 직접 오디오 URL을 획득한 뒤, ffmpeg가 해당 URL에서 직접 읽음.
 * HTTP URL 입력이므로 -ss (input seeking)가 정상 작동.
 */
export async function playYouTubeClip(player, { videoId, startSeconds, endSeconds, loop = false, signal }) {
  signal?.throwIfAborted()
  if (!videoId || !Number.isFinite(startSeconds) || startSeconds < 0 ||
      (endSeconds != null && (!Number.isFinite(endSeconds) || endSeconds <= startSeconds))) {
    throw new Error("영상 또는 재생 구간이 올바르지 않아요.")
  }
  const duration = Math.max(0.5, (endSeconds ?? startSeconds + 5) - startSeconds)
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`

  console.log(`[v0] voice: playing ${videoUrl} (${startSeconds}s ~ ${endSeconds}s, duration=${duration}s)`)
  if (loop && duration <= MAX_PREPARED_SECONDS) {
    const startedAt = Date.now()
    const clip = await preparedClip(videoId, startSeconds, duration, { signal, priority: true })
    const playing = startPreparedClip(player, clip, signal)
    console.log(`[v0] voice: prepared clip started in ${Date.now() - startedAt}ms (${clip.packets.length} Opus frames)`)
    return playing
  }

  let audioUrl
  try {
    audioUrl = await getAudioUrl(videoUrl, { signal, priority: true })
  } catch (err) {
    signal?.throwIfAborted()
    if (youtubeFailure(err) || isUnavailableError(err) || unavailableVideos.get(videoUrl) > Date.now()) throw err
    console.error("[v0] Failed to get audio URL, trying pipe fallback...")
    return playYouTubeClipPipe(player, { videoId, startSeconds, endSeconds, duration, videoUrl, loop, signal })
  }
  signal?.throwIfAborted()

  // ffmpeg가 HTTP URL에서 직접 읽음 — input seeking 가능
  const ff = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel", "warning",
      "-ss", String(startSeconds),
      "-t", String(duration),
      "-i", audioUrl,
      ...(loop ? ["-af", clipLoopFilter(0, duration)] : []),
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  )

  return setupFfmpegPlayer(player, ff, null, () => audioUrls.invalidate(videoUrl, audioUrl), signal)
}

/**
 * Fallback: yt-dlp → pipe → ffmpeg
 * (--get-url 실패 시)
 */
function playYouTubeClipPipe(player, { videoId, startSeconds, duration, videoUrl, loop = false, signal }) {
  console.log(`[v0] voice: pipe fallback for ${videoUrl}`)

  const ytdlp = spawn(YT_DLP_PATH, [
    ...ytDlpOptions(),
    "--no-playlist",
    "-f", "bestaudio",
    "-o", "-",
    videoUrl,
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })

  ytdlp.stderr.on("data", (chunk) => {
    console.log(`[v0] yt-dlp stderr: ${chunk.toString().trim()}`)
  })

  const ff = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel", "warning",
      "-i", "pipe:0",
      ...(loop
        ? ["-af", clipLoopFilter(startSeconds, duration)]
        : ["-ss", String(startSeconds), "-t", String(duration)]),
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  )

  // yt-dlp stdout → ffmpeg stdin
  ytdlp.stdout.pipe(ff.stdin)

  ytdlp.on("error", (err) => {
    console.error("[v0] yt-dlp spawn error:", err.message)
  })

  ytdlp.on("close", (code) => {
    console.log(`[v0] yt-dlp pipe closed with code ${code}`)
    try { ff.stdin.end() } catch {}
  })

  // ffmpeg stdin EPIPE 무시
  ff.stdin.on("error", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return
    console.error("[v0] ffmpeg stdin error:", err.message)
  })

  return setupFfmpegPlayer(player, ff, ytdlp, undefined, signal)
}

/**
 * ffmpeg 프로세스의 stdout을 AudioPlayer에 연결하는 공통 로직.
 */
async function setupFfmpegPlayer(player, ff, ytdlpProcess, onFailure = () => {}, signal) {
  const passthrough = new PassThrough()
  const monitor = monitorPlayback(player, ff, ytdlpProcess, passthrough, { onFailure })

  // ffmpeg stderr 로깅
  let ffmpegStderr = ""
  ff.stderr.on("data", (chunk) => {
    const msg = chunk.toString()
    ffmpegStderr += msg
    console.log(`[v0] ffmpeg stderr: ${msg.trim()}`)
  })

  // stdout 데이터 흐름 확인
  let ffmpegBytesOut = 0
  ff.stdout.on("data", (chunk) => {
    ffmpegBytesOut += chunk.length
    if (ffmpegBytesOut === chunk.length) {
      console.log(`[v0] ffmpeg: first output chunk (${chunk.length} bytes)`)
    }
  })

  ff.stdout.pipe(passthrough)

  ff.on("error", (err) => {
    onFailure()
    console.error("[v0] ffmpeg spawn error:", err.message)
    passthrough.destroy(err)
  })

  ff.on("close", (code) => {
    console.log(`[v0] ffmpeg closed with code ${code}, total output: ${ffmpegBytesOut} bytes`)
    if (code && code !== 0) {
      console.warn(`[v0] ffmpeg exited with code ${code}`)
      if (ffmpegStderr) {
        console.warn(`[v0] ffmpeg stderr: ${ffmpegStderr.trim().slice(0, 500)}`)
      }
    }
    if (ffmpegBytesOut === 0) {
      if (code !== null) onFailure()
      console.error("[v0] ⚠️ ffmpeg produced 0 bytes of output! Audio will not play.")
    }
  })

  const resource = createAudioResource(passthrough, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  })
  resource.volume?.setVolume(0.6)

  // AudioPlayer 상태 전이 로깅
  const playerStateHandler = (oldState, newState) => {
    console.log(`[v0] AudioPlayer: ${oldState.status} -> ${newState.status}`)
  }
  player.on("stateChange", playerStateHandler)

  const playerErrorHandler = (err) => {
    console.error(`[v0] AudioPlayer error: ${err.message}`)
  }
  player.on("error", playerErrorHandler)

  player.play(resource)
  console.log(`[v0] voice: player.play() called`)

  const cleanup = () => {
    signal?.removeEventListener("abort", abortPlayback)
    monitor.cleanup()
    player.off("stateChange", playerStateHandler)
    player.off("error", playerErrorHandler)
    try {
      if (player.state.resource === resource) player.stop(true)
    } catch {}
    try {
      ff.kill("SIGKILL")
    } catch {}
    try {
      passthrough.destroy()
    } catch {}
    if (ytdlpProcess) {
      try {
        ytdlpProcess.kill("SIGKILL")
      } catch {}
    }
  }

  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = reject })
  const abortPlayback = () => {
    rejectAbort(signal.reason ?? new Error("재생 취소"))
    cleanup()
  }
  signal?.addEventListener("abort", abortPlayback, { once: true })
  try {
    if (signal?.aborted) abortPlayback()
    await Promise.race([monitor.ready, aborted])
  } catch (err) {
    cleanup()
    throw err
  }
  return { resource, cleanup, failure: monitor.failure }
}

export async function waitForPlayerIdle(player, timeoutMs) {
  if (player.state.status === AudioPlayerStatus.Idle) return
  return new Promise((resolve) => {
    let done = false
    let timer
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      player.off(AudioPlayerStatus.Idle, finish)
      resolve()
    }
    player.once(AudioPlayerStatus.Idle, finish)
    timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })
}

export function pausePlayer(player) {
  try {
    return player.pause(true)
  } catch {
    return false
  }
}

export function resumePlayer(player) {
  try {
    return player.unpause()
  } catch {
    return false
  }
}
