/**
 * @멘션 기반 메시지 명령어 정의와 실행 로직.
 *
 * 사용법:
 *   @봇이름 music [검색어]
 *   @봇이름 stop
 *   @봇이름 pause
 *   @봇이름 resume
 *   @봇이름 skip
 *   @봇이름 ping
 */

import {
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType,
  PermissionFlagsBits,
} from "discord.js"
import { searchMusicQuizzes, fetchQuizDetail, fetchMusicQuestions } from "./machugi.js"
import { deleteGameMessages, deleteGameMessageLater } from "./game-messages.js"
import {
  startQuizSession,
  hasSession,
  stopSession,
  skipCurrent,
  pauseSession,
  resumeSession,
  getSession,
} from "./quiz-session.js"

const QUESTION_TIME_MS = 25_000
const ANSWER_REVEAL_MS = 2_000

/**
 * 메시지에서 봇 멘션 프리픽스를 파싱해 { command, args } 를 반환.
 * 멘션이 아니면 null 반환.
 */
export function parseMention(message) {
  const botId = message.client.user.id
  // <@!botId> 또는 <@botId> 둘 다 처리
  const mentionRegex = new RegExp(`^<@!?${botId}>\\s*`)
  const match = message.content.match(mentionRegex)
  if (!match) return null

  const rest = message.content.slice(match[0].length).trim()
  const parts = rest.split(/\s+/)
  const command = (parts[0] || "").toLowerCase()
  const args = parts.slice(1).join(" ").trim()
  return { command, args }
}

/**
 * messageCreate 이벤트 핸들러.
 */
export async function handleMessage(message, env) {
  // DM이나 봇 메시지 무시
  if (message.author.bot) return
  if (!message.guild) return

  // 참가자 PC의 Shift+N 도구가 현재 채널에 보내는 명령.
  if (/^!(?:스킵|skip)$/i.test(message.content.trim())) {
    const session = getSession(message.guildId)
    if (!session || message.channel.id !== session.textChannel.id) return
    const voiceChannel = await resolveVoiceChannel(message)
    if (voiceChannel?.id !== session.voiceChannel.id) return
    session.skipCurrent()
    if (message.channel.permissionsFor(message.client.user)?.has(PermissionFlagsBits.ManageMessages)) {
      await message.delete().catch(() => {})
    }
    return
  }

  const parsed = parseMention(message)
  if (!parsed) return

  const { command, args } = parsed

  if (env.isWatchActive?.(message.guildId) && ["music", "뮤직", "노래", "random", "랜덤"].includes(command)) {
    return message.reply("디스코드 같이 보기가 진행 중입니다. `/같이보기종료` 후 활동 창을 닫고 퀴즈를 시작하세요.")
  }
  if (env.isRadioActive?.(message.guildId) && ["music", "뮤직", "노래", "random", "랜덤"].includes(command)) {
    return message.reply("이 서버에서 치지직 라디오가 재생 중입니다. `/정지` 후 음악 퀴즈를 시작하세요.")
  }

  console.log(
    `[v0] cmd '${command}' by ${message.author.tag} in guild=${message.guildId}`,
  )

  switch (command) {
    case "music":
    case "뮤직":
    case "노래":
      return handleMusicCommand(message, env, args)
    case "random":
    case "랜덤":
      return handleRandomCommand(message, env)
    case "stop":
    case "중지":
    case "중단":
      return handleStopCommand(message)
    case "pause":
    case "일시정지":
      return handlePauseCommand(message)
    case "resume":
    case "재개":
    case "재생":
      return handleResumeCommand(message)
    case "skip":
    case "스킵":
    case "넘기기":
      return handleSkipCommand(message)
    case "ping":
    case "핑":
      return handlePingCommand(message)
    case "help":
    case "도움":
    case "도움말":
    case "":
      return handleHelpCommand(message)
    default:
      return message.reply(
        `모르는 명령어예요. 사용법을 보려면 **<@${message.client.user.id}> help**를 입력해보세요.`,
      )
  }
}

/**
 * SelectMenu (드롭다운) 인터랙션 핸들러.
 */
export async function handleSelectInteraction(interaction) {
  // select menu 인터랙션은 여전히 interaction 기반이므로 별도 처리
  // (commands.js 에서는 collector로 처리하므로 이 함수는 fallback)
}

async function resolveVoiceChannel(message) {
  let voiceChannel = message.member?.voice?.channel ?? null
  console.log(
    `[v0]   initial voice: ${voiceChannel ? `#${voiceChannel.name}` : "null"}`,
  )
  if (voiceChannel) return voiceChannel

  try {
    const fresh = await message.guild.members.fetch({
      user: message.author.id,
      force: true,
    })
    voiceChannel = fresh?.voice?.channel ?? null
    console.log(
      `[v0]   after force fetch: ${voiceChannel ? `#${voiceChannel.name}` : "null"}`,
    )
  } catch (err) {
    console.error("[v0]   member fetch failed:", err.message)
  }
  return voiceChannel
}

async function handleHelpCommand(message) {
  const botMention = `<@${message.client.user.id}>`
  const embed = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle("🎵 machugi.io 음악 퀴즈 봇")
    .setDescription(
      `모든 명령어는 **${botMention}**을 붙여 사용합니다.\n\n` +
        `**${botMention} music [검색어]** — 음악 퀴즈 검색/시작\n` +
        `**${botMention} random** — 🎲 모든 퀴즈에서 랜덤 출제\n` +
        `**${botMention} stop** — 진행 중 퀴즈 중단\n` +
        `**${botMention} pause** — 일시정지\n` +
        `**${botMention} resume** — 재개\n` +
        `**${botMention} skip** — 현재 문제 넘기기\n` +
        `**${botMention} ping** — 봇 상태, 음성채널 감지 확인\n` +
        `**${botMention} help** — 이 도움말\n\n` +
        `퀴즈를 시작하면 **웹방 입장 링크가 자동으로 표시됩니다.**\n` +
        `**/퀴즈방** — 먼저 웹에서 퀴즈를 고르거나 방장 링크 받기\n` +
        `**Ctrl+E** — 웹에서 정답 입력 중에도 스킵\n` +
        `한국어도 지원: \`노래\`, \`랜덤\`, \`중지\`, \`스킵\`, \`핑\` 등\n` +
        `**!스킵** — 같은 음성 채널 참가자의 빠른 스킵\n` +
        `**Shift+N** — 참가자용 단축키 도구 실행 필요 (hotkey 폴더)\n` +
        `답변은 다음 판 전에 자동 삭제됩니다. 봇에 **메시지 관리** 권한을 주세요.`,
    )
    .setFooter({ text: "powered by machugi.io" })

  await message.reply({ embeds: [embed] })
}

async function handlePingCommand(message) {
  const vc = await resolveVoiceChannel(message)
  const lines = [
    `Pong! latency: ${Math.round(message.client.ws.ping)}ms`,
    `서버: **${message.guild?.name}**`,
    `당신의 음성 채널: ${vc ? `**#${vc.name}** ✅` : "**없음** ❌"}`,
  ]
  if (!vc) {
    lines.push("")
    lines.push("1. 지금 이 서버의 음성 채널에 들어가 있는지 확인")
    lines.push("2. 봇을 킥/재초대 했는지 (intent 변경 후 필수)")
    lines.push("3. Portal에서 **SERVER MEMBERS INTENT** 활성화")
  }
  await message.reply(lines.join("\n"))
}

async function handleStopCommand(message) {
  const ok = await stopSession(message.guildId)
  if (ok) message.react("⏹️").catch(() => {})
  else await message.reply("진행 중인 퀴즈가 없어요.")
}

async function handlePauseCommand(message) {
  const r = pauseSession(message.guildId)
  if (r.ok) message.react("⏸️").catch(() => {})
  else if (r.reason === "no-session") await message.reply("진행 중인 퀴즈가 없어요.")
  else message.react("❌").catch(() => {})
}

async function handleResumeCommand(message) {
  const r = resumeSession(message.guildId)
  if (r.ok) message.react("▶️").catch(() => {})
  else if (r.reason === "no-session") await message.reply("진행 중인 퀴즈가 없어요.")
  else message.react("❌").catch(() => {})
}

async function handleSkipCommand(message) {
  const ok = skipCurrent(message.guildId)
  if (ok) message.react("⏭️").catch(() => {})
  else await message.reply("넘길 문제가 없어요.")
}

async function handleMusicCommand(message, env, searchArg) {
  const voiceChannel = await resolveVoiceChannel(message)
  if (!voiceChannel) {
    const botMention = `<@${message.client.user.id}>`
    return message.reply(
      "먼저 음성 채널에 들어간 뒤 명령어를 사용해주세요.\n" +
        `이미 들어가 있는데도 이 메시지가 보이면 **${botMention} ping**으로 원인을 확인해 주세요.`,
    )
  }

  const me = message.guild.members.me
  const perms = voiceChannel.permissionsFor(me)
  if (!perms?.has("Connect") || !perms?.has("Speak")) {
    return message.reply(
      `봇이 **#${voiceChannel.name}** 채널에 **연결/말하기** 권한이 없어요.`,
    )
  }

  if (hasSession(message.guildId)) {
    const botMention = `<@${message.client.user.id}>`
    return message.reply(
      `이 서버에서 이미 퀴즈가 진행 중이에요. **${botMention} stop**으로 중단하세요.`,
    )
  }

  const search = searchArg || ""
  const count = 10

  const loadingMsg = await message.reply("🔎 퀴즈를 검색하는 중...")

  let result
  try {
    result = await searchMusicQuizzes({
      host: env.MACHUGI_TYPESENSE_HOST,
      apiKey: env.MACHUGI_TYPESENSE_API_KEY,
      query: search,
      perPage: count,
      page: 1,
      sortBy: "hits:desc",
    })
  } catch (err) {
    console.error("[v0] search failed:", err)
    deleteGameMessageLater(loadingMsg)
    return loadingMsg.edit(`검색에 실패했어요: ${err.message}`)
  }

  if (result.hits.length === 0) {
    deleteGameMessageLater(loadingMsg)
    return loadingMsg.edit("검색 결과가 없어요.")
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`quiz_pick:${message.author.id}`)
    .setPlaceholder("플레이할 퀴즈를 골라주세요")
    .addOptions(
      result.hits.slice(0, 25).map((q) => ({
        label: truncate(q.title, 95),
        description: truncate(
          `${formatHits(q.hits)}  ${(q.description || "").replace(/\n+/g, " ")}`,
          95,
        ),
        value: q.id,
      })),
    )
  const row = new ActionRowBuilder().addComponents(select)

  const embed = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle(
      search
        ? `"${search}" 검색 결과 (${result.found.toLocaleString()}개 중 ${result.hits.length})`
        : `음악 퀴즈 인기순 TOP ${result.hits.length}`,
    )
    .setDescription(
      result.hits
        .map((q, i) => `**${i + 1}. ${truncate(q.title, 60)}**  ${formatHits(q.hits)}플레이`)
        .join("\n"),
    )
    .setFooter({ text: "아래 드롭다운에서 퀴즈를 선택해 시작하세요" })

  const reply = await loadingMsg.edit({ content: null, embeds: [embed], components: [row] })

  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 60_000,
    filter: (i) => i.user.id === message.author.id,
  })

  collector.on("collect", async (selectInteraction) => {
    collector.stop("picked")
    const quizId = selectInteraction.values[0]
    await selectInteraction.update({ components: [] })
    await deleteGameMessages([loadingMsg])

    try {
      await launchQuiz({ message, env, quizId, voiceChannel })
    } catch (err) {
      console.error("[v0] launchQuiz failed:", err)
      const errorMessage = await message.channel.send(`퀴즈 시작에 실패했어요: ${err.message}`)
      deleteGameMessageLater(errorMessage)
    }
  })

  collector.on("end", (_c, reason) => {
    if (reason !== "picked") {
      void deleteGameMessages([loadingMsg])
    }
  })
}

async function launchQuiz({ message, env, quizId, voiceChannel }) {
  const loadingMsg = await message.channel.send("문제를 불러오는 중...")
  try {

  const detail = await fetchQuizDetail(quizId)
  if (detail.questionType !== "music") {
    await loadingMsg.edit("이 퀴즈는 음악 퀴즈가 아니에요.")
    return
  }
  const ids = detail.questionIds || []
  if (ids.length === 0) {
    await loadingMsg.edit("이 퀴즈에 등록된 문제가 없어요.")
    return
  }

  const questions = await fetchMusicQuestions({
    firebaseApiKey: env.MACHUGI_FIREBASE_API_KEY,
    firebaseProjectId: env.MACHUGI_FIREBASE_PROJECT_ID,
    quizId,
    questionIds: ids,
  })

  const valid = questions.filter(
    (q) => q && q.video_id && Array.isArray(q.answer) && q.answer.length,
  )
  if (valid.length === 0) {
    await loadingMsg.edit("재생 가능한 문제가 없어요.")
    return
  }

  shuffle(valid)

  await loadingMsg.edit(
    `**${detail.title}**  총 **${valid.length}문제**로 시작합니다!`,
  )

  if (env.isRadioActive?.(voiceChannel.guild.id)) {
    await loadingMsg.edit("라디오 또는 같이 보기가 시작되었습니다. `/정지` 또는 `/같이보기종료` 후 다시 퀴즈를 시작하세요.")
    return
  }

  await startQuizSession({
    textChannel: message.channel,
    voiceChannel,
    quiz: { id: detail.id, title: detail.title, thumbnail_url: detail.thumbnailUrl },
    questions: valid,
    questionTimeMs: QUESTION_TIME_MS,
    answerRevealMs: ANSWER_REVEAL_MS,
    starterId: message.author.id,
    cleanupMessages: [loadingMsg],
  })
  } finally { deleteGameMessageLater(loadingMsg) }
}

/**
 * @machugi random — 모든 퀴즈에서 문제를 가져와 랜덤으로 섞어 출제.
 */
async function handleRandomCommand(message, env) {
  const voiceChannel = await resolveVoiceChannel(message)
  if (!voiceChannel) {
    const botMention = `<@${message.client.user.id}>`
    return message.reply(
      "먼저 음성 채널에 들어간 뒤 명령어를 사용해주세요.\n" +
        `이미 들어가 있는데도 이 메시지가 보이면 **${botMention} ping**으로 원인을 확인해 주세요.`,
    )
  }

  const me = message.guild.members.me
  const perms = voiceChannel.permissionsFor(me)
  if (!perms?.has("Connect") || !perms?.has("Speak")) {
    return message.reply(
      `봇이 **#${voiceChannel.name}** 채널에 **연결/말하기** 권한이 없어요.`,
    )
  }

  if (hasSession(message.guildId)) {
    const botMention = `<@${message.client.user.id}>`
    return message.reply(
      `이 서버에서 이미 퀴즈가 진행 중이에요. **${botMention} stop**으로 중단하세요.`,
    )
  }

  const loadingMsg = await message.reply("🎲 모든 퀴즈에서 문제를 수집하는 중...")

  try {
    // 1단계: 퀴즈 목록 가져오기 (여러 페이지)
    const allQuizzes = []
    const PER_PAGE = 250
    let page = 1
    let totalFound = 0

    do {
      const result = await searchMusicQuizzes({
        host: env.MACHUGI_TYPESENSE_HOST,
        apiKey: env.MACHUGI_TYPESENSE_API_KEY,
        query: "*",
        perPage: PER_PAGE,
        page,
        sortBy: "hits:desc",
      })
      totalFound = result.found
      allQuizzes.push(...result.hits)
      page++
    } while (allQuizzes.length < totalFound && page <= 20) // 최대 20페이지

    if (allQuizzes.length === 0) {
      return loadingMsg.edit("퀴즈를 찾을 수 없어요.")
    }

    await loadingMsg.edit(
      `🎲 **${allQuizzes.length}개** 퀴즈 발견! 문제를 불러오는 중... (시간이 좀 걸릴 수 있어요)`,
    )

    // 2단계: 퀴즈에서 랜덤으로 골라서 문제 가져오기
    // 모든 퀴즈에서 가져오면 너무 오래 걸리므로, 랜덤으로 최대 15개 퀴즈를 골라 문제 수집
    shuffle(allQuizzes)
    const selectedQuizzes = allQuizzes.slice(0, 15)

    const allQuestions = []
    const quizTitles = []
    let fetchErrors = 0

    for (const quiz of selectedQuizzes) {
      try {
        const detail = await fetchQuizDetail(quiz.id)
        if (detail.questionType !== "music") continue
        const ids = detail.questionIds || []
        if (ids.length === 0) continue

        const questions = await fetchMusicQuestions({
          firebaseApiKey: env.MACHUGI_FIREBASE_API_KEY,
          firebaseProjectId: env.MACHUGI_FIREBASE_PROJECT_ID,
          quizId: quiz.id,
          questionIds: ids,
        })

        const valid = questions.filter(
          (q) => q && q.video_id && Array.isArray(q.answer) && q.answer.length,
        )
        if (valid.length > 0) {
          allQuestions.push(...valid)
          quizTitles.push(detail.title)
        }
      } catch (err) {
        fetchErrors++
        console.error(`[v0] random: failed to fetch quiz ${quiz.id}:`, err.message)
      }
    }

    if (allQuestions.length === 0) {
      return loadingMsg.edit("재생 가능한 문제를 찾지 못했어요.")
    }

    // 3단계: 전체 문제 셔플
    shuffle(allQuestions)

    // 최대 50문제로 제한 (너무 길어지지 않도록)
    const MAX_QUESTIONS = 50
    const finalQuestions = allQuestions.slice(0, MAX_QUESTIONS)

    await loadingMsg.edit(
      `🎲 **${quizTitles.length}개 퀴즈**에서 총 **${finalQuestions.length}문제** 랜덤 출제! 시작합니다!`,
    )

    if (env.isRadioActive?.(voiceChannel.guild.id)) {
      await loadingMsg.edit("라디오 또는 같이 보기가 시작되었습니다. `/정지` 또는 `/같이보기종료` 후 다시 퀴즈를 시작하세요.")
      return
    }

    await startQuizSession({
      textChannel: message.channel,
      voiceChannel,
      quiz: {
        id: "random-mix",
        title: `🎲 랜덤 믹스 (${quizTitles.length}개 퀴즈)`,
        thumbnail_url: null,
      },
      questions: finalQuestions,
      questionTimeMs: QUESTION_TIME_MS,
      answerRevealMs: ANSWER_REVEAL_MS,
      starterId: message.author.id,
      cleanupMessages: [loadingMsg],
    })
  } catch (err) {
    console.error("[v0] random command failed:", err)
    await deleteGameMessages([loadingMsg])
    const errorMessage = await message.channel.send(`랜덤 퀴즈 시작에 실패했어요: ${err.message}`)
    deleteGameMessageLater(errorMessage)
  } finally { deleteGameMessageLater(loadingMsg) }
}

function truncate(s, n) {
  if (!s) return ""
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function formatHits(h) {
  const n = Number(h) || 0
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`
  return `${n.toLocaleString()}`
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
