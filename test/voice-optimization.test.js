import test, { mock } from "node:test"
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import ffmpegPath from "ffmpeg-static"
import { AudioPlayerStatus, entersState } from "@discordjs/voice"
import { performance } from "node:perf_hooks"

let fixtureUrl, lookups = 0, lookupError, pipeFallbacks = 0
const lookup = () => { throw Error("unexpected callback API") }
lookup[promisify.custom] = async (_, args) => {
  lookups++
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${process.execPath}`)
  if (lookupError) throw lookupError
  return { stdout: fixtureUrl, stderr: "" }
}
mock.module("node:child_process", { namedExports: { ...childProcess, execFile: lookup,
  spawn: (file, args, options) => {
    if (file === process.env.YT_DLP_PATH) pipeFallbacks++
    return childProcess.spawn(file, args, options)
  },
} })
const { prefetchQuizClip, playYouTubeClip, createPlayer, pausePlayer, resumePlayer } = await import("../src/machugi/voice.js")

test("prepared clips play, loop, pause and replace on the real Discord audio player", async () => {
  const exec = promisify(childProcess.execFile)
  const { stdout: wav } = await exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=440:duration=1", "-f", "wav", "pipe:1"], { encoding: "buffer" })
  const server = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "")
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
    response.writeHead(range ? 206 : 200, {
      "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": end - start + 1,
      ...(range ? { "content-range": `bytes ${start}-${end}/${wav.length}` } : {}),
    })
    response.end(wav.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture.wav`
  const player = createPlayer()
  const question = { video_id: "local-fixture", start_seconds: 0, end_seconds: 0.1 }
  let first, second
  try {
    assert.equal(await prefetchQuizClip(question), true)
    const startedAt = performance.now()
    first = await playYouTubeClip(player, { videoId: question.video_id, startSeconds: 0, endSeconds: 0.1, loop: true })
    const warmMs = performance.now() - startedAt
    assert.equal(first.resource.edges.length, 0, "ready Opus packets bypass transcoding")
    await entersState(player, AudioPlayerStatus.Playing, 2000)
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.equal(player.state.status, AudioPlayerStatus.Playing, "short clip keeps looping")
    assert.ok(first.resource.playbackDuration >= 600)
    assert.equal(pausePlayer(player), true)
    assert.equal(player.state.status, AudioPlayerStatus.Paused)
    assert.equal(resumePlayer(player), true)
    await entersState(player, AudioPlayerStatus.Playing, 2000)
    second = await playYouTubeClip(player, { videoId: question.video_id, startSeconds: 0, endSeconds: 0.1, loop: true })
    first.cleanup()
    assert.equal(player.state.resource, second.resource, "old cleanup preserves the new song")
    await entersState(player, AudioPlayerStatus.Playing, 2000)
    assert.equal(lookups, 1, "prefetch and repeated playback share one lookup")
    second.cleanup()
    assert.equal(player.state.status, AudioPlayerStatus.Idle)
    console.log(`[bench] actual audio player cached start=${warmMs.toFixed(2)}ms; repeat had no transcoding`)
  } finally {
    first?.cleanup()
    second?.cleanup()
    player.stop(true)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

test("server bot verification does not repeat the same blocked request through pipe fallback", async () => {
  lookupError = Object.assign(new Error('blocked'), { stderr: 'Sign in to confirm you’re not a bot.' })
  const player = createPlayer()
  try {
    await assert.rejects(playYouTubeClip(player, { videoId: 'blocked-fixture', startSeconds: 0, endSeconds: 12, loop: true }), { code: 'YOUTUBE_AUTH_REQUIRED' })
    assert.equal(pipeFallbacks, 0)
  } finally { lookupError = null; player.stop(true) }
})
