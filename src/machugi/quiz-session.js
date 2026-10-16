/**
 * 길드(서버) 단위 퀴즈 세션 — 서버당 동시에 하나만.
 *
 * UI: 고정 패널 하나를 계속 edit 하면서 상태를 표시.
 *     버튼으로 일시정지 / 스킵 / 중지 제어.
 *     메시지를 새로 보내지 않으므로 알림음이 울리지 않음.
 */

import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  PermissionFlagsBits,
} from "discord.js"
import { isCorrect } from "./answer.js"
import {
  connectToVoice,
  createPlayer,
  playYouTubeClip,
  prefetchQuizClip,
  waitForPlayerIdle,
  pausePlayer,
  resumePlayer,
} from "./voice.js"
import { AudioPlayerStatus, getVoiceConnection } from "@discordjs/voice"
import { pingQuizPage } from "./machugi.js"
import { PanelUpdateQueue } from "./panel-update-queue.js"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { resources } from "../resource-profile.js"
import { deleteGameMessages, deleteGameMessageLater } from "./game-messages.js"

const sessions = new Map()
export const quizEvents = new EventEmitter()

export function getSession(guildId) {
  return sessions.get(guildId)
}
export function hasSession(guildId) {
  return sessions.has(guildId)
}

export async function startQuizSession(params) {
  const guildId = params.voiceChannel.guild.id
  if (sessions.has(guildId)) throw new Error("이미 이 서버에서 퀴즈가 진행 중이에요.")
  const session = new QuizSession(params)
  sessions.set(guildId, session)
  try {
    quizEvents.emit("start", session)
    await session.run()
  } finally {
    sessions.delete(guildId)
    await session.clearAnswerMessages()
    session.destroy()
    await session.clearGameMessages()
    quizEvents.emit("end", session)
  }
}

export async function stopSession(guildId) {
  const s = sessions.get(guildId)
  if (!s) return false
  s.requestStop()
  return true
}
export function skipCurrent(guildId) {
  const s = sessions.get(guildId)
  if (!s) return false
  return s.skipCurrent()
}
export function pauseSession(guildId) {
  const s = sessions.get(guildId)
  if (!s) return { ok: false, reason: "no-session" }
  return s.pause()
}
export function resumeSession(guildId) {
  const s = sessions.get(guildId)
  if (!s) return { ok: false, reason: "no-session" }
  return s.resume()
}

/* ------------------------------------------------------------------ */

export class QuizSession {
  constructor({
    textChannel, voiceChannel, quiz, questions,
    questionTimeMs, answerRevealMs, starterId, cleanupMessages = [],
  }) {
    this.textChannel = textChannel
    this.voiceChannel = voiceChannel
    this.quiz = quiz
    this.questions = questions
    this.questionTimeMs = questionTimeMs
    this.answerRevealMs = answerRevealMs
    this.starterId = starterId
    this.cleanupMessages = cleanupMessages
    this.events = new EventEmitter()
    this.sessionId = randomUUID()
    this.webState = { phase: "waiting", title: quiz.title, total: questions.length, index: 0,
      roundId: null, deadlineMs: null, paused: false, answer: null, video: null }

    this.scores = new Map()
    this.playedRounds = 0
    this.playbackFailures = 0
    this.current = null
    this.stopped = false
    this.keepVoiceConnection = false
    this.retainedVoiceConnection = null
    this.player = createPlayer()
    this.player.setMaxListeners(30)
    this.cleanupFns = []

    this.panelMsg = null
    this.btnCollector = null
    this.resolveResult = null
    this.resolveFullPlay = null
    this.answerMessages = new Map()
    this.cleanupWarningShown = false
    this.loadingController = null
    this.prefetchJobs = new Map()
    this.panelUpdates = new PanelUpdateQueue(opts => this.panelMsg?.edit(opts))

    this.messageHandler = this.messageHandler.bind(this)
  }

  /* ---------- buttons ---------- */
  getWebState() {
    return { ...this.webState, serverTime: Date.now(),
      scores: [...this.scores.values()].sort((a, b) => b.points - a.points).map(({ name, points }) => ({ name, points })) }
  }
  publishWebState(patch) {
    Object.assign(this.webState, patch)
    this.events.emit("state", this.getWebState())
  }
  submitAnswer({ userId, name, content, roundId }) {
    const round = this.current
    if (!round || round.ended || round.answered || round.paused ||
        (roundId && roundId !== this.webState.roundId)) return { accepted: false, correct: false }
    const correct = isCorrect(content, round.question.answer)
    if (correct) {
      round.answered = true
      this.addScore(userId, name)
      round.resolveRound({ reason: "correct", winnerName: name })
    }
    this.events.emit("guess", { name, content, correct, roundId: this.webState.roundId })
    return { accepted: true, correct }
  }
  makeButtons(paused = false, disabled = false) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("q_fullplay")
        .setLabel("전체듣기")
        .setEmoji("🎵")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("q_pause")
        .setLabel(paused ? "재개" : "일시정지")
        .setEmoji(paused ? "▶️" : "⏸️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("q_skip")
        .setLabel("스킵")
        .setEmoji("⏭️")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("q_stop")
        .setLabel("중지")
        .setEmoji("⏹️")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    )
    return this.addWebHostButton(row)
  }
  addWebHostButton(row) {
    if (this.webRoomId) row.addComponents(new ButtonBuilder()
      .setCustomId(`q_web_join:${this.webRoomId}`).setLabel("웹방 입장").setStyle(ButtonStyle.Secondary))
    return row
  }

  /* ---------- score text ---------- */
  scoreField() {
    const sorted = [...this.scores.entries()].sort((a, b) => b[1].points - a[1].points)
    if (sorted.length === 0) return null
    const medals = ["🥇", "🥈", "🥉"]
    return {
      name: "🏆 점수",
      value: sorted.slice(0, 8).map(([, v], i) =>
        `${medals[i] ?? `${i + 1}.`} **${v.name}** — ${v.points}점`
      ).join("\n"),
      inline: false,
    }
  }

  /* ---------- edit helper ---------- */
  async editPanel(opts) {
    if (!this.panelMsg) return
    return this.panelUpdates.submit(opts)
  }

  warmQuestions(index) {
    for (const [position, controller] of this.prefetchJobs) {
      if (position < index || position > index + resources.quizLookahead) {
        controller.abort()
        this.prefetchJobs.delete(position)
      }
    }
    for (let position = index; position <= index + resources.quizLookahead && position < this.questions.length; position++) {
      if (this.prefetchJobs.has(position)) continue
      const controller = new AbortController()
      this.prefetchJobs.set(position, controller)
      void prefetchQuizClip(this.questions[position], { signal: controller.signal })
    }
  }

  cancelPrefetch() {
    for (const controller of this.prefetchJobs.values()) controller.abort()
    this.prefetchJobs.clear()
  }

  /* ---------- lifecycle ---------- */
  requestStop({ keepVoiceConnection = false } = {}) {
    this.keepVoiceConnection = keepVoiceConnection
    this.stopped = true
    this.current?.resolveRound?.({ reason: "stopped" })
    this.resolveResult?.("stop")
    this.resolveFullPlay?.("stop")
    this.loadingController?.abort()
    this.cancelPrefetch()
  }
  skipCurrent() {
    if (this.resolveFullPlay) { this.resolveFullPlay("next"); return true }
    if (this.resolveResult) { this.resolveResult("next"); return true }
    if (this.loadingController) { this.loadingController.abort(); return true }
    if (!this.current || this.current.ended) return false
    this.current.ended = true
    this.current.resolveRound?.({ reason: "skipped" })
    return true
  }
  pause() {
    if (!this.current) return this.phaseControl?.pause() ?? { ok: false, reason: "no-round" }
    if (this.current.paused) return { ok: false, reason: "already" }
    const elapsed = Date.now() - this.current.roundStartedAt
    this.current.remainingMs = Math.max(0, this.current.remainingMs - elapsed)
    clearTimeout(this.current.timer)
    this.current.timer = null
    this.current.paused = true
    this.publishWebState({ paused: true, deadlineMs: null, remainingMs: this.current.remainingMs })
    pausePlayer(this.player)
    this.editPanel({ components: [this.makeButtons(true)] })
    return { ok: true }
  }
  resume() {
    if (!this.current) return this.phaseControl?.resume() ?? { ok: false, reason: "no-round" }
    if (!this.current.paused) return { ok: false, reason: "not-paused" }
    resumePlayer(this.player)
    this.current.paused = false
    this.current.roundStartedAt = Date.now()
    const remaining = this.current.remainingMs
    this.publishWebState({ paused: false, deadlineMs: Date.now() + remaining, remainingMs: remaining })
    this.current.timer = setTimeout(() => {
      this.current?.resolveRound?.({ reason: "timeout" })
    }, remaining)
    this.editPanel({ components: [this.makeButtons(false)] })
    return { ok: true, remainingMs: remaining }
  }
  presentationTimer(durationMs, expire, audio = false) {
    let timer, startedAt, ready = false, pausedAt = null, remainingMs = durationMs
    const control = {
      start: () => {
        ready = true
        if (pausedAt !== null) return
        startedAt = Date.now()
        timer = setTimeout(expire, remainingMs)
        this.publishWebState({ deadlineMs: audio ? null : startedAt + remainingMs, remainingMs })
      },
      pause: () => {
        if (pausedAt !== null) return { ok: false, reason: "already" }
        pausedAt = Date.now()
        if (startedAt) remainingMs = Math.max(0, remainingMs - (pausedAt - startedAt))
        clearTimeout(timer)
        if (audio) pausePlayer(this.player)
        this.publishWebState({ paused: true, remainingMs, deadlineMs: null,
          video: this.webState.video ? { ...this.webState.video, pausedAt } : null })
        return { ok: true }
      },
      resume: () => {
        if (pausedAt === null) return { ok: false, reason: "not-paused" }
        const delay = Date.now() - pausedAt
        const video = this.webState.video ? { ...this.webState.video, startedAt: this.webState.video.startedAt + delay } : null
        if (video) delete video.pausedAt
        pausedAt = null
        if (audio) resumePlayer(this.player)
        this.publishWebState({ paused: false, video })
        if (ready) control.start()
        return { ok: true, remainingMs }
      },
      cleanup: () => { clearTimeout(timer); if (this.phaseControl === control) this.phaseControl = null },
    }
    this.phaseControl = control
    return control
  }
  destroy() {
    this.phaseControl?.cleanup()
    this.cancelPrefetch()
    this.loadingController?.abort()
    this.current?.controller?.abort()
    clearTimeout(this.current?.timer)
    try { this.current?.clip?.cleanup() } catch {}
    this.current = null
    try { this.player.stop(true) } catch {}
    for (const fn of this.cleanupFns.splice(0)) { try { fn() } catch {} }
    this.textChannel.client.off("messageCreate", this.messageHandler)
    this.btnCollector?.stop()
    const connection = getVoiceConnection(this.voiceChannel.guild.id)
    if (connection?.joinConfig.channelId === this.voiceChannel.id) {
      if (this.keepVoiceConnection) this.retainedVoiceConnection = connection
      else { try { connection.destroy() } catch {} }
    }
  }
  releaseVoiceConnection() {
    // A canceled handoff must not leave an idle bot connected. Reset the flag
    // too, in case session cleanup has not reached destroy() yet.
    this.keepVoiceConnection = false
    const connection = this.retainedVoiceConnection
    this.retainedVoiceConnection = null
    if (connection && getVoiceConnection(this.voiceChannel.guild.id) === connection) {
      try { connection.destroy() } catch {}
    }
  }

  addScore(userId, name) {
    const cur = this.scores.get(userId)
    if (cur) { cur.points += 1; cur.name = name }
    else this.scores.set(userId, { points: 1, name })
  }

  async clearGameMessages() {
    const messages = [this.panelMsg, ...this.cleanupMessages]
    this.panelMsg = null
    this.cleanupMessages = []
    await deleteGameMessages(messages)
  }

  async clearAnswerMessages() {
    const messages = [...this.answerMessages.values()]
    this.answerMessages.clear()
    if (!messages.length) return
    if (!this.textChannel.permissionsFor(this.textChannel.client.user)?.has(PermissionFlagsBits.ManageMessages)) {
      if (!this.cleanupWarningShown) {
        this.cleanupWarningShown = true
        await this.editPanel({ content: "⚠️ 답변 자동 삭제를 위해 봇에 이 채널의 **메시지 관리** 권한을 주세요." })
      }
      return
    }
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100)
      try {
        await this.textChannel.bulkDelete(batch.map(msg => msg.id), true)
      } catch (err) {
        // 이미 삭제된 메시지가 있어도 나머지 답변은 정리한다.
        for (const msg of batch) {
          try { await msg.delete() } catch (error) {
            if (error.code !== 10008) console.warn("[v0] answer cleanup failed:", error.message)
          }
        }
      }
    }
  }

  /* ---------- answer detection ---------- */
  messageHandler(msg) {
    if (msg.author.bot) return
    if (msg.channel.id !== this.textChannel.id) return
    const botId = msg.client.user.id
    if (new RegExp(`^<@!?${botId}>`).test(msg.content)) return
    if (msg.content.startsWith("/") || msg.content.startsWith("!")) return
    this.answerMessages.set(msg.id, msg)
    if (!this.current || this.current.ended || this.current.answered || this.current.paused) return

    const result = this.submitAnswer({ userId: msg.author.id,
      name: msg.member?.displayName ?? msg.author.username, content: msg.content })
    if (result.correct) {
      msg.react("✅").catch(() => {})
    }
  }

  /* ---------- button handler ---------- */
  setupButtons() {
    this.btnCollector = this.panelMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
    })
    this.btnCollector.on("collect", async (i) => {
      if (/^q_web_(host|join):/.test(i.customId)) return
      void i.deferUpdate().catch(() => {})
      if (i.customId === "q_fullplay") {
        if (this.current && !this.current.answered) {
          await this.playFullCurrent()
          return
        }
        this.resolveResult?.("fullplay")
      } else if (i.customId === "q_pause") {
        if (this.current?.paused) this.resume()
        else this.pause()
      } else if (i.customId === "q_skip") {
        this.skipCurrent()
      } else if (i.customId === "q_stop") {
        this.requestStop()
        this.resolveResult?.("stop")
        this.resolveFullPlay?.("stop")
      } else if (i.customId === "q_next") {
        this.resolveResult?.("next")
        this.resolveFullPlay?.("next")
      }
    })
  }

  /* ---------- full play ---------- */
  async playFullCurrent() {
    if (!this.current || !this.current.clipInfo) return
    const round = this.current
    if (round.restarting || round.ended) return
    round.restarting = true
    console.log("[v0] playFullCurrent requested")

    // 1. 타이머 정지 (시간 초과 무효화)
    if (this.current.timer) {
      clearTimeout(this.current.timer)
      this.current.timer = null
      this.current.isFullPlaying = true

      // 임베드 텍스트 업데이트 (타이머 제거)
      try {
        const embed = EmbedBuilder.from(this.panelMsg.embeds[0])
        if (embed.data.description) {
          const newDesc = embed.data.description.replace(/\n⏱️ <t:\d+:R> 종료/, "\n⏱️ **전체듣기 중 (타이머 정지)**")
          embed.setDescription(newDesc)
          void this.editPanel({ embeds: [embed] })
        }
      } catch (e) {
        console.error("[v0] failed to update embed on fullplay:", e)
      }
    }

    // 2. 기존 클립 정리
    if (this.current !== round || round.ended || this.stopped) { round.restarting = false; return }
    try { round.clip?.cleanup() } catch {}
    try {
      if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true)
    } catch {}

    // 3. 처음부터 전체 다시 재생
    try {
      const clip = await playYouTubeClip(this.player, {
        videoId: round.clipInfo.videoId,
        startSeconds: 0,
        endSeconds: 300, // 최대 5분
        signal: round.controller.signal,
      })
      if (this.current !== round || round.ended || this.stopped) { clip.cleanup(); return }
      round.clip = clip
      this.publishWebState({ deadlineMs: null, video: null, fullListening: true })
      clip.failure.then(error => round.resolveRound?.({ reason: "unplayable", error }))

      // 노래가 끝날 때까지 정답이 안 나오면 시간 초과 처리
      const onIdle = () => {
        if (this.current === round && !round.answered && !round.ended && round.isFullPlaying) {
          round.resolveRound?.({ reason: "timeout" })
        }
      }
      this.player.once(AudioPlayerStatus.Idle, onIdle)
      round.fullIdleHandler = onIdle
      if (this.player.state.status === AudioPlayerStatus.Idle) onIdle()
    } catch (err) {
      console.error("[v0] playFullCurrent failed:", err.message)
      round.resolveRound?.({ reason: "unplayable", error: err })
    } finally {
      round.restarting = false
    }
  }

  /* ---------- main ---------- */
  async run() {
    const client = this.textChannel.client
    client.on("messageCreate", this.messageHandler)
    // 첫 곡 조회를 음성 채널 접속과 겹쳐서 시작 지연을 줄인다.
    this.warmQuestions(0)

    try {
      await connectToVoice(this.voiceChannel)
    } catch (err) {
      console.error("[v0] connectToVoice failed:", err)
      const errorMessage = await this.textChannel.send(
        `음성 채널 접속 실패: ${err.message}\nWindows 방화벽/백신/VPN이 Node.js의 UDP를 차단하고 있을 수 있어요.`,
      )
      deleteGameMessageLater(errorMessage)
      return
    }

    const connection = getVoiceConnection(this.voiceChannel.guild.id)
    const sub = connection?.subscribe(this.player)
    if (sub) this.cleanupFns.push(() => sub.unsubscribe())

    // 패널 생성
    const startEmbed = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle(`🎵 ${this.quiz.title}`)
      .setDescription(
        `총 **${this.questions.length}문제** · 문제당 ${Math.round(this.questionTimeMs / 1000)}초\n` +
        `채팅으로 정답을 입력하세요!`,
      )
      .setThumbnail(this.quiz.thumbnail_url || this.quiz.thumbnailUrl || null)
      .setFooter({ text: "machugi.io · 준비 중…" })

    this.panelMsg = await this.textChannel.send({
      content: this.webRoomUrl ? `🌐 아래 **웹방 입장** 버튼으로 디스코드 닉네임을 자동 적용해 참가하세요. 스킵: **Ctrl+E**` : undefined,
      embeds: [startEmbed],
      components: [this.makeButtons()],
    })
    this.setupButtons()
    pingQuizPage(this.quiz.id).catch(() => {})

    for (let i = 0; i < this.questions.length; i++) {
      if (this.stopped) break
      this.warmQuestions(i)
      try {
        await this.runRound(i + 1, this.questions[i])
      } finally {
        await this.clearAnswerMessages()
      }
      if (this.stopped) break
    }
    await this.clearAnswerMessages()
    this.cancelPrefetch()
    await this.showResults()
  }

  /* ---------- round ---------- */
  async runRound(idx, question) {
    const controller = new AbortController()
    const start = Number(question.start_seconds || 0)
    const end = Number(question.end_seconds || start + 5)
    const total = this.questions.length
    this.publishWebState({ phase: "loading", index: idx, roundId: `${this.sessionId}:${idx}`,
      answer: null, video: null, deadlineMs: null, paused: false, fullListening: false })

    const clipInfo = { videoId: question.video_id, startSeconds: start, endSeconds: end, loop: true, signal: controller.signal }
    let clip
    try {
      this.loadingController = controller
      clip = await playYouTubeClip(this.player, clipInfo)
    } catch (err) {
      if (controller.signal.aborted) return
      this.playbackFailures++
      if (["YOUTUBE_AUTH_REQUIRED", "AUDIO_PROCESS_TERMINATED", "ENOENT", "EACCES", "ENOEXEC"].includes(err.code)) {
        this.playbackError = err.message
        this.stopped = true
        this.cancelPrefetch()
      }
      console.error("[v0] clip error:", err)
      void this.editPanel({
        embeds: [new EmbedBuilder().setColor(0xef4444)
          .setTitle(`🎵 ${this.quiz.title}`)
          .setDescription(this.playbackError ? `❌ ${this.playbackError}` : `❌ ${idx}번 문제 재생 실패, 건너뜁니다…`)],
        components: [this.makeButtons()],
      })
      return
    } finally {
      if (this.loadingController === controller) this.loadingController = null
    }

    if (this.stopped) {
      clip.cleanup()
      return
    }

    // 문제 패널
    const endTs = Math.floor((Date.now() + this.questionTimeMs) / 1000)
    const embed = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle(`🎵 ${this.quiz.title}`)
      .setDescription(
        `**📀 ${idx} / ${total}번 문제**\n` +
        `🎼 구간: ${fmt(start)} ~ ${fmt(end)} · 🔁 자동 반복\n` +
        `⏱️ <t:${endTs}:R> 종료`,
      )
      .setFooter({ text: "machugi.io · 채팅으로 정답을 입력하세요!" })
    const sf = this.scoreField()
    if (sf) embed.addFields(sf)

    // 라운드 대기
    let resolveRound
    const promise = new Promise(r => (resolveRound = r))
    this.current = {
      question, answered: false, ended: false, resolveRound,
      timer: null, roundStartedAt: Date.now(),
      remainingMs: this.questionTimeMs, paused: false,
      clipInfo, clip, controller,
    }
    this.current.timer = setTimeout(
      () => resolveRound({ reason: "timeout" }),
      this.questionTimeMs,
    )
    this.publishWebState({ phase: "question", deadlineMs: Date.now() + this.questionTimeMs,
      remainingMs: this.questionTimeMs })

    const onIdle = () => {
      if (this.current?.clip === clip && !this.current.restarting) resolveRound({ reason: "unplayable" })
    }
    this.player.on(AudioPlayerStatus.Idle, onIdle)
    // 정답 판정과 스킵은 Discord 패널 편집 응답을 기다리지 않는다.
    void this.editPanel({ embeds: [embed], components: [this.makeButtons()] })
    if (this.player.state.status === AudioPlayerStatus.Idle) onIdle()
    const result = await Promise.race([
      promise,
      clip.failure.then(error => ({ reason: "unplayable", error })),
    ])
    this.current.ended = true
    this.player.off(AudioPlayerStatus.Idle, onIdle)
    if (this.current.fullIdleHandler) this.player.off(AudioPlayerStatus.Idle, this.current.fullIdleHandler)
    controller.abort()
    if (this.current?.timer) clearTimeout(this.current.timer)
    try { this.current?.clip?.cleanup() } catch {}
    try {
      if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true)
    } catch {}
    await waitForPlayerIdle(this.player, 500)
    this.current = null

    // 결과 표시
    if (result.reason === "stopped") return
    if (result.reason === "unplayable") {
      this.playbackFailures++
      console.warn(`[v0] skipping unplayable video ${question.video_id}:`, result.error?.message ?? "재생 중단")
      return
    }
    this.playedRounds++
    this.publishWebState({ phase: "reveal", reason: result.reason, answer: question.answer[0],
      winnerName: result.winnerName ?? null, deadlineMs: null, paused: false,
      video: { id: question.video_id, startSeconds: start, startedAt: Date.now() } })
    let color, desc
    if (result.reason === "correct") {
      color = 0x22c55e
      desc = `**✅ ${idx}번 — ${result.winnerName} 정답!**\n정답: **${question.answer[0]}**`
    } else if (result.reason === "timeout") {
      color = 0xef4444
      desc = `**⏰ ${idx}번 — 시간 초과!**\n정답: **${question.answer[0]}**`
    } else if (result.reason === "skipped") {
      color = 0xf59e0b
      desc = `**⏭️ ${idx}번 — 스킵!**\n정답: **${question.answer[0]}**`
    }

    const resEmbed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎵 ${this.quiz.title}`)
      .setDescription(desc)
      .setFooter({ text: `machugi.io · ${idx} / ${total}` })
    const sf2 = this.scoreField()
    if (sf2) resEmbed.addFields(sf2)

    // 영상 정보 조회 없이 기존 ID로 미리보기를 만든다.
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(question.video_id)}&t=${Math.max(0, Math.floor(start))}s`
    if (result.reason === "skipped") {
      resEmbed
        .setURL(videoUrl)
        .setImage(`https://i.ytimg.com/vi/${encodeURIComponent(question.video_id)}/hqdefault.jpg`)
    }

    // 결과 버튼: 전체듣기 / 다음문제 / 중지
    const resultRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("q_fullplay").setLabel("전체듣기").setEmoji("🎵").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("q_next").setLabel("다음문제").setEmoji("▶️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("q_stop").setLabel("중지").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    )
    if (result.reason === "skipped") {
      resultRow.addComponents(
        new ButtonBuilder().setLabel("유튜브 열기").setEmoji("📺").setStyle(ButtonStyle.Link).setURL(videoUrl),
      )
    }
    this.addWebHostButton(resultRow)
    let resultResolved = false
    const actionPromise = new Promise(resolve => {
      this.resolveResult = action => {
        resultResolved = true
        resolve(action)
      }
    })
    const revealTimer = this.presentationTimer(this.answerRevealMs ?? 2_000, () => this.resolveResult?.("timeout"))
    void this.editPanel({ embeds: [resEmbed], components: [resultRow] }).then(() => {
      // Discord가 정답 화면을 반영한 뒤 표시 시간을 센다.
      if (!resultResolved) {
        revealTimer.start()
      }
    })
    // 정답 표시 시간과 답변 정리를 겹쳐서 다음 판의 대기를 줄인다.
    const cleanup = this.clearAnswerMessages()
    if (this.stopped) this.resolveResult?.("stop")
    const action = await actionPromise
    await cleanup
    revealTimer.cleanup()
    this.resolveResult = null

    if (action === "fullplay" && !this.stopped) {
      await this.playFullSong(question, resEmbed)
    }
  }

  /* ---------- full play ---------- */
  async playFullSong(question, resEmbed) {
    // Release browser audio before requesting the Discord audio source.
    this.publishWebState({ phase: "loading", video: null, paused: false, deadlineMs: null })
    const controller = new AbortController()
    console.log(`[v0] full play: ${question.video_id}`)
    let fullClip
    try {
      this.loadingController = controller
      fullClip = await playYouTubeClip(this.player, {
        videoId: question.video_id,
        startSeconds: 0,
        endSeconds: 300, // 최대 5분
        signal: controller.signal,
      })
    } catch (err) {
      console.error("[v0] full play failed:", err.message)
      return
    } finally {
      if (this.loadingController === controller) this.loadingController = null
    }
    if (this.stopped) { fullClip.cleanup(); return }
    this.publishWebState({ phase: "fullplay", deadlineMs: null, paused: false,
      video: { id: question.video_id, startSeconds: 0, startedAt: Date.now() } })

    // 재생 중 패널: 다음문제 / 중지만 표시
    const playingRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("q_next").setLabel("다음문제").setEmoji("⏭️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("q_stop").setLabel("중지").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
    )
    this.addWebHostButton(playingRow)
    const playEmbed = EmbedBuilder.from(resEmbed)
      .setFooter({ text: "machugi.io · 🎵 전체듣기 재생 중…" })
    const playbackPromise = new Promise(resolve => {
      let done = false
      const finish = r => {
        if (done) return
        done = true
        this.player.off(AudioPlayerStatus.Idle, onIdle)
        fullTimer.cleanup()
        resolve(r)
      }
      const onIdle = () => finish("ended")
      const fullTimer = this.presentationTimer(300_000, () => finish("timeout"), true)
      fullTimer.start()
      this.resolveFullPlay = finish
      this.player.once(AudioPlayerStatus.Idle, onIdle)
      fullClip.failure.then(() => finish("unplayable"))
      if (this.player.state.status === AudioPlayerStatus.Idle) finish("ended")
    })
    void this.editPanel({ embeds: [playEmbed], components: [playingRow] })
    if (this.stopped) this.resolveFullPlay?.("stop")
    const reason = await playbackPromise
    this.resolveFullPlay = null

    console.log(`[v0] full play ended: ${reason}`)
    try { fullClip.cleanup() } catch {}
    try {
      if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true)
    } catch {}
    await waitForPlayerIdle(this.player, 500)
  }

  /* ---------- results ---------- */
  async showResults() {
    this.publishWebState({ phase: "finished", answer: null, video: null, deadlineMs: null, paused: false,
      playbackFailures: this.playbackFailures, stopped: this.stopped })
    const sorted = [...this.scores.entries()].sort((a, b) => b[1].points - a[1].points)
    const playbackFailed = this.playedRounds === 0 && this.playbackFailures > 0
    let desc = this.playbackError || (playbackFailed
      ? `**${this.playbackFailures}문제 모두 오디오 재생에 실패했습니다.**\n재생 도구 경로, 영상 상태 또는 네트워크를 확인해주세요. 상세 원인은 봇 실행 창에 표시됩니다.`
      : sorted.length === 0
      ? "아무도 정답을 맞추지 못했어요."
      : sorted.slice(0, 10).map(([, v], i) =>
          `${["🥇", "🥈", "🥉"][i] ?? `${i + 1}위.`} **${v.name}**  ${v.points}점`
        ).join("\n"))
    if (!playbackFailed && this.playbackFailures > 0) {
      desc += `\n\n⚠️ 재생 실패로 ${this.playbackFailures}문제를 건너뛰었습니다.`
    }

    const embed = new EmbedBuilder()
      .setColor(0x0ea5e9)
      .setTitle(playbackFailed ? "⚠️ 퀴즈 재생 실패" : "🏆 퀴즈 종료!")
      .setDescription(desc)
      .setFooter({ text: `machugi.io · ${this.quiz.title}` })

    await this.editPanel({
      content: null,
      embeds: [embed],
      components: [this.makeButtons(false, true)],
    })
  }
}

/* ------------------------------------------------------------------ */
function fmt(s) {
  s = Math.floor(Number(s) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
