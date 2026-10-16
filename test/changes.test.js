import test, { mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { monitorPlayback } from "../src/machugi/playback-monitor.js"

function playback() {
  const player = new EventEmitter()
  const ff = new EventEmitter()
  ff.stdout = new EventEmitter()
  const stream = new EventEmitter()
  return { player, ff, stream }
}

test("PCM output is required before a round can start", async () => {
  const { player, ff, stream } = playback()
  const monitor = monitorPlayback(player, ff, null, stream)
  let ready = false
  monitor.ready.then(() => { ready = true })
  ff.stdout.emit("data", Buffer.alloc(100))
  await Promise.resolve()
  assert.equal(ready, false)
  ff.stdout.emit("data", Buffer.alloc(3840))
  await monitor.ready
  assert.equal(ready, true)
  monitor.cleanup()
  assert.equal(ff.listenerCount("close"), 0)
})

test("deleted/empty videos and startup timeouts reject startup", async () => {
  const { player, ff, stream } = playback()
  const monitor = monitorPlayback(player, ff, null, stream)
  ff.emit("close", 0)
  await assert.rejects(monitor.ready, /변환 실패/)
  assert.match((await monitor.failure).message, /bytes=0/)
  monitor.cleanup()
  const timed = monitorPlayback(player, ff, null, stream, { timeoutMs: 5 })
  await assert.rejects(timed.ready, /시간 초과/)
  timed.cleanup()
})

test("runtime errors are reported once; intentional cleanup is safe", async () => {
  const { player, ff, stream } = playback()
  let failures = 0
  const monitor = monitorPlayback(player, ff, null, stream, { onFailure: () => failures++ })
  ff.stdout.emit("data", Buffer.alloc(3840))
  await monitor.ready
  player.emit("error", new Error("stream failed"))
  ff.emit("close", 1)
  assert.equal((await monitor.failure).message, "stream failed")
  assert.equal(failures, 1)
  monitor.cleanup()
  const clean = monitorPlayback(player, ff, null, stream)
  ff.stdout.emit("data", Buffer.alloc(3840))
  await clean.ready
  clean.cleanup()
  ff.emit("close", null)
})

test("source spawn failures reject startup", async () => {
  const { player, ff, stream } = playback()
  const source = new EventEmitter()
  const monitor = monitorPlayback(player, ff, source, stream)
  source.emit("error", new Error("ENOENT"))
  await assert.rejects(monitor.ready, /ENOENT/)
  monitor.cleanup()
})

let nextClip
function fakePlayer() {
  const player = new EventEmitter()
  player.state = { status: "playing" }
  player.stop = () => { player.state.status = "idle"; player.emit("idle") }
  return player
}
mock.module("../src/machugi/voice.js", { namedExports: {
  connectToVoice: async () => {}, createPlayer: fakePlayer,
  playYouTubeClip: async (_, options) => {
    if (nextClip instanceof Error) throw nextClip
    if (typeof nextClip === "function") return nextClip(options)
    return nextClip
  },
  prefetchQuizClip: async () => true, waitForPlayerIdle: async () => {},
  pausePlayer: () => {}, resumePlayer: () => {},
} })
const { QuizSession, startQuizSession } = await import("../src/machugi/quiz-session.js")
const { handleMessage } = await import("../src/machugi/commands.js")

function setup(canDelete = true) {
  const edits = [], deleted = []
  const client = new EventEmitter()
  client.user = { id: "bot" }
  const channel = {
    id: "text", client,
    permissionsFor: () => ({ has: () => canDelete }),
    bulkDelete: async ids => { deleted.push(ids) },
  }
  const params = {
    textChannel: channel, voiceChannel: { id: "voice", guild: { id: "guild" } },
    quiz: { title: "test" }, questions: [], questionTimeMs: 1000, starterId: "user",
  }
  const session = new QuizSession(params)
  session.panelMsg = { edit: async opts => { edits.push(opts) } }
  const message = (id, content) => ({
    id, content, client, channel, author: { id: "user", bot: false, username: "test" },
    react: () => Promise.resolve(),
  })
  return { session, channel, edits, deleted, message, params }
}

test("correct, wrong, paused and reveal-period guesses are deleted; commands are preserved", async () => {
  const { session, message, deleted } = setup()
  let result
  session.current = { question: { answer: ["정답"] }, resolveRound: r => { result = r } }
  session.messageHandler(message("1", "오답"))
  session.messageHandler(message("2", "정답"))
  session.messageHandler(message("3", "뒤늦은 정답"))
  session.current = null
  session.messageHandler(message("4", "결과 화면에서 입력한 답"))
  session.messageHandler(message("5", "<@bot> help"))
  session.messageHandler(message("6", "!스킵"))
  const outsider = message("7", "다른 채널")
  outsider.channel = { id: "other" }
  session.messageHandler(outsider)
  assert.equal(result.reason, "correct")
  assert.equal(session.scores.get("user").points, 1)
  await session.clearAnswerMessages()
  assert.deepEqual(deleted, [["1", "2", "3", "4"]])
  assert.equal(session.answerMessages.size, 0)
  session.destroy()
})

test("bulk deletion is split into batches and missing permission warns once", async () => {
  const a = setup()
  for (let i = 0; i < 205; i++) a.session.messageHandler(a.message(String(i), "답변"))
  await a.session.clearAnswerMessages()
  assert.deepEqual(a.deleted.map(batch => batch.length), [100, 100, 5])
  a.session.destroy()
  const b = setup(false)
  b.session.messageHandler(b.message("1", "답변"))
  await b.session.clearAnswerMessages()
  b.session.messageHandler(b.message("2", "답변"))
  await b.session.clearAnswerMessages()
  assert.equal(b.deleted.length, 0)
  assert.equal(b.edits.length, 1)
  b.session.destroy()
})

test("skip/stop also advance the answer screen and full-song playback", () => {
  const { session } = setup()
  let result
  session.resolveResult = r => { result = r }
  assert.equal(session.skipCurrent(), true)
  assert.equal(result, "next")
  session.resolveResult = null
  session.resolveFullPlay = r => { result = r }
  session.skipCurrent()
  assert.equal(result, "next")
  session.requestStop()
  assert.equal(result, "stop")
  session.destroy()
})

test("startup and mid-round audio failures advance without revealing an answer", async () => {
  const { session, edits } = setup()
  const question = { video_id: "deleted", answer: ["정답"] }
  nextClip = new Error("Video unavailable")
  await session.runRound(1, question)
  assert.equal(session.current, null)
  assert.equal(edits.length, 1)
  nextClip = { cleanup: () => {}, failure: Promise.resolve(new Error("HTTP 403")) }
  await session.runRound(2, question)
  assert.equal(session.current, null)
  assert.equal(edits.length, 2)
  assert.equal(session.scores.size, 0)
  assert.equal(session.playbackFailures, 2)
  await session.showResults()
  const result = edits.at(-1).embeds[0].data
  assert.equal(result.title, "⚠️ 퀴즈 재생 실패")
  assert.match(result.description, /2문제 모두 오디오 재생에 실패/)
  assert.doesNotMatch(result.description, /아무도 정답/)
  session.destroy()
})

test("participant shortcut requires the session text and voice channels", async () => {
  const { params, channel, message } = setup()
  const originalRun = QuizSession.prototype.run
  let finish, skips = 0, deletes = 0
  QuizSession.prototype.run = async function () {
    this.skipCurrent = () => { skips++; return true }
    await new Promise(resolve => { finish = resolve })
  }
  const running = startQuizSession(params)
  const msg = message("1", "!스킵")
  msg.guildId = "guild"
  msg.guild = {}
  msg.member = { voice: { channel: { id: "other" } } }
  msg.delete = async () => { deletes++ }
  await handleMessage(msg, {})
  assert.equal(skips, 0)
  msg.member.voice.channel.id = "voice"
  await handleMessage(msg, {})
  assert.equal(skips, 1)
  assert.equal(deletes, 1)
  msg.channel = { ...channel, id: "other" }
  await handleMessage(msg, {})
  assert.equal(skips, 1)
  finish()
  await running
  QuizSession.prototype.run = originalRun
})

test("skip and stop cancel loading without starting a stale round", async () => {
  nextClip = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
  const a = setup()
  const loading = a.session.runRound(1, { video_id: "slow", answer: ["답"] })
  assert.equal(a.session.skipCurrent(), true)
  await loading
  assert.equal(a.session.current, null)
  assert.equal(a.edits.length, 0)
  a.session.destroy()
  const b = setup()
  const full = b.session.playFullSong({ video_id: "slow" }, {})
  b.session.requestStop()
  await full
  assert.equal(b.session.stopped, true)
  b.session.destroy()
})

test("skip button stops audio, reveals the answer after slow edits and cleans guesses without awarding points", async () => {
  const { session, edits, message, deleted } = setup()
  const pendingEdits = []
  session.panelMsg.edit = options => new Promise(resolve => {
    edits.push(options)
    pendingEdits.push(resolve)
  })
  const collector = new EventEmitter()
  collector.stop = () => {}
  session.panelMsg.createMessageComponentCollector = () => collector
  session.setupButtons()
  session.answerRevealMs = 30
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const round = session.runRound(1, { video_id: "fast", answer: ["답"] })
  let finished = false
  round.then(() => { finished = true })
  await Promise.resolve()
  assert.ok(session.current)
  session.messageHandler(message("wrong", "오답"))
  collector.emit("collect", { customId: "q_skip", deferUpdate: async () => {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(session.current, null)
  assert.equal(session.player.state.status, "idle")
  assert.equal(session.scores.size, 0)
  assert.deepEqual(deleted, [["wrong"]])
  pendingEdits.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(edits[1].embeds[0].data.description, /스킵!.*\n정답: \*\*답\*\*/)
  assert.ok(edits[1].components[0].components.some(button => button.data.custom_id === "q_next"))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(finished, false, "reveal timer must wait for Discord to display the answer")
  pendingEdits.shift()()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(finished, false, "answer stays visible for the configured duration")
  await round
  session.destroy()
})

test("next button advances a skipped answer immediately", async () => {
  const { session, edits } = setup()
  const collector = new EventEmitter()
  collector.stop = () => {}
  session.panelMsg.createMessageComponentCollector = () => collector
  session.setupButtons()
  session.answerRevealMs = 5000
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const round = session.runRound(1, { video_id: "fast", answer: ["답"] })
  await Promise.resolve()
  session.skipCurrent()
  await new Promise(resolve => setImmediate(resolve))
  assert.match(edits.at(-1).embeds[0].data.description, /정답: \*\*답\*\*/)
  collector.emit("collect", { customId: "q_next", deferUpdate: async () => {} })
  await Promise.race([
    round,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("next waited for reveal timer")), 200); timer.unref() }),
  ])
  session.destroy()
})

test("correct answers use the configured reveal duration", async () => {
  const { session, message, deleted } = setup()
  session.answerRevealMs = 5
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const round = session.runRound(1, { video_id: "fast", answer: ["답"] })
  await Promise.resolve()
  session.messageHandler(message("winner", "답"))
  await Promise.race([
    round,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("reveal ignored setting")), 100); timer.unref() }),
  ])
  assert.deepEqual(deleted, [["winner"]])
  session.destroy()
})

test("web answers share scoring with Discord, hide answers until reveal and reject stale or duplicate wins", async () => {
  const { session } = setup()
  session.answerRevealMs = 5
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const round = session.runRound(1, { video_id: "secret-video", answer: ["숨겨진 정답"] })
  await Promise.resolve()
  const before = session.getWebState()
  assert.equal(before.phase, "question")
  assert.doesNotMatch(JSON.stringify(before), /숨겨진 정답|secret-video/)
  assert.equal(session.submitAnswer({ userId: "web:one", name: "웹 참가자", content: "숨겨진 정답", roundId: "old" }).accepted, false)
  assert.equal(session.submitAnswer({ userId: "web:one", name: "웹 참가자", content: "숨겨진정답", roundId: before.roundId }).correct, true)
  assert.equal(session.submitAnswer({ userId: "web:two", name: "다른 참가자", content: "숨겨진 정답", roundId: before.roundId }).accepted, false)
  await round
  assert.equal(session.scores.size, 1)
  assert.equal(session.scores.get("web:one").points, 1)
  assert.equal(session.getWebState().answer, "숨겨진 정답")
  assert.equal(session.getWebState().video.id, "secret-video")
  session.destroy()
})

test("game start panel provides a Discord identity entry button without publishing personal links", async () => {
  const { session, channel } = setup()
  const sent = []
  const collector = new EventEmitter()
  collector.stop = () => {}
  channel.send = async options => {
    sent.push(options)
    return { edit: async () => {}, createMessageComponentCollector: () => collector }
  }
  session.webRoomUrl = "https://quiz.example/r/public-room"
  session.webRoomId = "public-room"
  const fetchMock = mock.method(globalThis, "fetch", async () => ({ ok: true }))
  try {
    await session.run()
    assert.match(sent[0].content, /디스코드 닉네임/)
    assert.match(sent[0].content, /Ctrl\+E/)
    assert.doesNotMatch(sent[0].content, /#host=/)
    assert.equal(sent[0].components[0].components.at(-1).data.custom_id, "q_web_join:public-room")
  } finally { fetchMock.mock.restore(); session.destroy() }
})

test("reveal pause preserves the remaining time and resumes the shared video anchor", async () => {
  const { session } = setup()
  session.answerRevealMs = 40
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const round = session.runRound(1, { video_id: "video", answer: ["답"] })
  await Promise.resolve()
  session.skipCurrent()
  await new Promise(resolve => setImmediate(resolve))
  const anchor = session.getWebState().video.startedAt
  assert.equal(session.pause().ok, true)
  let finished = false
  round.then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(finished, false)
  assert.equal(session.getWebState().paused, true)
  assert.ok(session.getWebState().video.pausedAt)
  assert.equal(session.resume().ok, true)
  assert.ok(session.getWebState().video.startedAt >= anchor + 50)
  assert.equal(session.getWebState().video.pausedAt, undefined)
  await round
  assert.equal(session.phaseControl, null)
  session.destroy()
})

test("full-song playback can pause, resume, and stop without leaving its timer running", async () => {
  const { session } = setup()
  nextClip = { cleanup() {}, failure: new Promise(() => {}) }
  const playing = session.playFullSong({ video_id: "video" }, { title: "test" })
  assert.equal(session.getWebState().phase, "loading")
  assert.equal(session.getWebState().video, null)
  await Promise.resolve()
  assert.equal(session.getWebState().phase, "fullplay")
  assert.equal(session.pause().ok, true)
  assert.equal(session.getWebState().paused, true)
  assert.equal(session.resume().ok, true)
  assert.equal(session.getWebState().paused, false)
  session.skipCurrent()
  await playing
  assert.equal(session.phaseControl, null)
  session.destroy()
})

test("ending or failing a quiz removes its panel, URL and preparation messages", async () => {
  const originalRun = QuizSession.prototype.run
  try {
    for (const fail of [false, true]) {
      const { params } = setup()
      const removed = []
      const preparation = { delete: async () => { removed.push("preparation") } }
      const panel = { content: "웹 참가 주소", delete: async () => { removed.push("panel") } }
      QuizSession.prototype.run = async function () {
        this.panelMsg = panel
        if (fail) throw new Error("playback failed")
        this.requestStop()
      }
      const running = startQuizSession({ ...params, cleanupMessages: [preparation] })
      if (fail) await assert.rejects(running, /playback failed/)
      else await running
      assert.deepEqual(removed.sort(), ["panel", "preparation"])
    }
  } finally { QuizSession.prototype.run = originalRun }
})
