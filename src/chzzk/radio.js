import {
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
} from "discord.js"
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
} from "@discordjs/voice"
import { ChzzkClient } from "chzzk"
import ffmpegPath from "ffmpeg-static"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/* ------------------------------------------------------------------
 * 초기 설정
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
 * 치지직 19금 인증 (NID_AUT / NID_SES 쿠키 관리)
 *
 * 봇 프로세스 안에서 직접 쿠키를 등록/갱신할 수 있도록
 *  1) 시작 시 .auth.json → .env 순으로 기존 쿠키를 불러와 ChzzkClient 를 만든다.
 *  2) /인증 커맨드로 Discord 모달을 띄워 새 쿠키를 입력받고
 *     네이버 API 로 검증 후 .auth.json 에 저장한다.
 *  3) 새 쿠키로 ChzzkClient 를 재생성하고, ffmpeg 에 전달하는 Cookie 헤더도 갱신한다.
 * ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FILE = process.env.CHZZK_AUTH_FILE
  ? path.resolve(process.env.CHZZK_AUTH_FILE)
  : path.resolve(__dirname, ".auth.json")

function loadStoredAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null
    const raw = fs.readFileSync(AUTH_FILE, "utf8")
    const data = JSON.parse(raw)
    if (data?.nidAuth && data?.nidSession) {
      return { nidAuth: data.nidAuth, nidSession: data.nidSession }
    }
  } catch (err) {
    console.error("[auth] 저장된 쿠키를 읽는 중 오류:", err.message)
  }
  return null
}

function saveStoredAuth(auth) {
  const payload = {
    nidAuth: auth.nidAuth,
    nidSession: auth.nidSession,
    savedAt: new Date().toISOString(),
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
}

/** 저장된 쿠키가 있으면 최우선, 없으면 환경변수 fallback. */
let currentAuth =
  loadStoredAuth() ??
  (process.env.NID_AUT && process.env.NID_SES
    ? { nidAuth: process.env.NID_AUT, nidSession: process.env.NID_SES }
    : null)

let chzzk = new ChzzkClient(currentAuth ?? undefined)

function hasAuth() {
  return Boolean(currentAuth?.nidAuth && currentAuth?.nidSession)
}

function currentCookieHeader() {
  return hasAuth()
    ? `NID_AUT=${currentAuth.nidAuth}; NID_SES=${currentAuth.nidSession}`
    : null
}

function rebuildChzzkClient(auth) {
  currentAuth = auth
  chzzk = new ChzzkClient(auth ?? undefined)
}

/**
 * 전달받은 NID 쿠키가 실제로 네이버 치지직 계정에 로그인 가능한지,
 * 그리고 해당 계정이 성인 인증 상태인지 확인한다.
 */
async function verifyChzzkAuth({ nidAuth, nidSession }) {
  try {
    const res = await fetch(
      "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus",
      {
        headers: {
          Cookie: `NID_AUT=${nidAuth}; NID_SES=${nidSession}`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Referer: "https://chzzk.naver.com/",
          Origin: "https://chzzk.naver.com",
        },
      },
    )
    if (!res.ok) return { ok: false, reason: `네이버 응답 오류 (HTTP ${res.status})` }
    const json = await res.json().catch(() => null)
    const content = json?.content
    if (!content || content.loggedIn !== true) {
      return { ok: false, reason: "로그인 상태가 아닙니다. 쿠키가 만료되었거나 잘못되었을 수 있습니다." }
    }
    // 성인 인증 여부 필드명이 API 버전마다 다를 수 있어 방어적으로 체크
    const adultVerified = Boolean(
      content.adultMode ||
        content.adultVerified ||
        content.verifiedAdult ||
        content.adult,
    )
    return {
      ok: true,
      nickname: content.nickname || content.userIdHash || "알 수 없음",
      adultVerified,
    }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
}

let client = null

/** guildId -> { connection, player, ffmpeg, liveInfo, voiceChannelId, channelId } */
const sessions = new Map()
const startingGuilds = new Set()
const cancelledStarts = new Map()

/* ------------------------------------------------------------------
 * 유틸
 * ------------------------------------------------------------------ */
function cleanupSession(guildId) {
  const s = sessions.get(guildId)
  if (!s) return
  try {
    s.player.stop(true)
  } catch {}
  try {
    s.ffmpeg?.kill("SIGKILL")
  } catch {}
  try {
    s.connection.destroy()
  } catch {}
  sessions.delete(guildId)
}

async function resolveChannelId(query) {
  // 치지직 채널 ID 는 32자리 hex
  if (/^[a-f0-9]{32}$/i.test(query)) return query
  const result = await chzzk.search.channels(query)
  if (!result?.channels?.length) return null
  return result.channels[0].channelId
}

function isAdultLive(detail) {
  // chzzk 라이브러리 버전에 따라 필드명이 다를 수 있어 방어적으로 체크
  return Boolean(
    detail?.adult ||
      detail?.adultBroadcasting ||
      detail?.livePlayback?.meta?.adult ||
      detail?.channel?.adult,
  )
}

async function getLiveStream(channelId) {
  const detail = await chzzk.live.detail(channelId)
  if (!detail) return { error: "채널 정보를 불러올 수 없습니다." }
  if (detail.status !== "OPEN")
    return { error: "현재 방송 중이 아닙니다." }

  const adult = isAdultLive(detail)

  const media = detail.livePlayback?.media ?? []
  const hls =
    media.find((m) => m.mediaId === "HLS") ??
    media.find((m) => m.mediaId === "LLHLS")

  if (!hls) {
    if (adult && !hasAuth()) {
      return {
        error:
          "🔞 19금 방송입니다. `/인증` 명령으로 성인 인증된 네이버 계정의 NID_AUT / NID_SES 쿠키를 먼저 등록해주세요.",
      }
    }
    if (adult) {
      return {
        error:
          "🔞 19금 방송 스트림을 가져오지 못했습니다. `/인증` 으로 쿠키를 다시 등록하거나, 네이버 계정이 성인 인증된 상태인지 확인해주세요.",
      }
    }
    return { error: "HLS 스트림을 찾을 수 없습니다." }
  }
  return { url: hls.path, detail, adult }
}

/**
 * HLS 주소를 ffmpeg 로 PCM(s16le, 48kHz, stereo) 으로 변환해서 읽을 수 있는 stream 으로 반환.
 * 오디오만 추출해 대역폭을 아낀다.
 *
 * 19금 방송의 HLS URL은 네이버 로그인 쿠키가 있어야 접근할 수 있으므로
 * ffmpeg 요청 헤더에 NID 쿠키를 함께 실어 보낸다.
 */
function createFfmpegStream(url, { adult = false } = {}) {
  const args = [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
  ]

  // 19금 방송이면 쿠키 헤더를 ffmpeg가 HLS/세그먼트 요청에 사용하도록 전달.
  // (입력 URL 앞에 와야 해당 입력에 적용됨)
  const cookieHeader = currentCookieHeader()
  if (adult && cookieHeader) {
    args.push(
      "-headers",
      `Cookie: ${cookieHeader}\r\n` +
        `Referer: https://chzzk.naver.com/\r\n` +
        `Origin: https://chzzk.naver.com\r\n`,
      "-user_agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    )
  }

  args.push(
    "-i", url,
    "-vn",                 // 영상 제거
    "-analyzeduration", "0",
    "-loglevel", "error",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  )

  const ff = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] })
  ff.stderr.on("data", (d) =>
    console.error("[ffmpeg]", d.toString().trim()),
  )
  return ff
}

function buildLiveEmbed(detail, title = "📻 재생 중") {
  return new EmbedBuilder()
    .setColor(0x00ffa3)
    .setTitle(title)
    .setDescription(
      `**${detail.channel?.channelName ?? "알 수 없는 채널"}**\n` +
        `${detail.liveTitle ?? ""}`,
    )
    .setThumbnail(detail.channel?.channelImageUrl ?? null)
    .addFields(
      {
        name: "카테고리",
        value:
          detail.liveCategoryValue ||
          detail.liveCategory ||
          "없음",
        inline: true,
      },
      {
        name: "시청자",
        value: String(detail.concurrentUserCount ?? 0),
        inline: true,
      },
    )
}

/* ------------------------------------------------------------------
 * 이벤트 핸들러
 * ------------------------------------------------------------------ */
export function registerRadio(botClient, { isQuizActive = () => false } = {}) {
client = botClient
client.on("interactionCreate", async (interaction) => {
  try {
  /* -------- 모달 제출 처리 (/인증 모달) -------- */
  if (interaction.isModalSubmit()) {
    if (interaction.customId !== "chzzk-auth-modal") return
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const nidAuth = interaction.fields.getTextInputValue("nid_aut").trim()
    const nidSession = interaction.fields.getTextInputValue("nid_ses").trim()

    if (!nidAuth || !nidSession) {
      return interaction.editReply("쿠키 값이 비어 있습니다.")
    }

    const result = await verifyChzzkAuth({ nidAuth, nidSession })
    if (!result.ok) {
      return interaction.editReply(
        `❌ 인증 실패: ${result.reason}\n쿠키가 올바른지, 만료되지 않았는지 확인해주세요.`,
      )
    }

    try {
      saveStoredAuth({ nidAuth, nidSession })
    } catch (err) {
      return interaction.editReply(
        `인증은 성공했지만 저장에 실패했습니다: ${err.message}`,
      )
    }
    rebuildChzzkClient({ nidAuth, nidSession })

    const lines = [
      `✅ 치지직 로그인 확인 — **${result.nickname}**`,
      result.adultVerified
        ? "🔞 성인 인증 상태가 확인되었습니다. 이제 19금 방송도 `/라디오`로 재생할 수 있습니다."
        : "⚠️ 로그인은 되었지만 이 계정의 성인 인증 상태를 확인할 수 없었습니다. 19금 방송 재생 시 실패하면 네이버에서 성인 인증을 완료한 계정의 쿠키를 다시 등록해주세요.",
      "쿠키는 봇 로컬의 `.auth.json` 에 저장되었습니다 (외부로 유출되지 않도록 주의).",
    ]
    return interaction.editReply(lines.join("\n"))
  }

  if (!interaction.isChatInputCommand()) return
  if (!["인증", "라디오", "정지", "정보"].includes(interaction.commandName)) return
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "이 명령은 서버에서만 사용할 수 있습니다.",
      flags: MessageFlags.Ephemeral,
    })
  }

  const { commandName } = interaction

  /* ---------------- /인증 ---------------- */
  if (commandName === "인증") {
    // 권한 제한: BOT_OWNER_ID 환경변수가 설정되어 있으면 그 사용자만,
    // 아니면 서버 관리자 권한을 가진 사용자만 실행 가능.
    const ownerId = process.env.BOT_OWNER_ID
    const isOwner = ownerId && interaction.user.id === ownerId
    const isAdmin = interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator,
    )
    if (!isOwner && !isAdmin) {
      return interaction.reply({
        content: "이 명령은 서버 관리자 또는 봇 소유자만 사용할 수 있습니다.",
        flags: MessageFlags.Ephemeral,
      })
    }

    const modal = new ModalBuilder()
      .setCustomId("chzzk-auth-modal")
      .setTitle("치지직 19금 인증 쿠키 입력")

    const autInput = new TextInputBuilder()
      .setCustomId("nid_aut")
      .setLabel("NID_AUT 쿠키")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(true)
      .setPlaceholder(
        "chzzk.naver.com 로그인 후 DevTools > Application > Cookies 에서 복사",
      )

    const sesInput = new TextInputBuilder()
      .setCustomId("nid_ses")
      .setLabel("NID_SES 쿠키")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(4000)
      .setRequired(true)
      .setPlaceholder("같은 위치에서 NID_SES 값을 복사해 붙여넣어 주세요.")

    modal.addComponents(
      new ActionRowBuilder().addComponents(autInput),
      new ActionRowBuilder().addComponents(sesInput),
    )
    return interaction.showModal(modal)
  }

  /* ---------------- /라디오 ---------------- */
  if (commandName === "라디오") {
    await interaction.deferReply()

    if (isQuizActive(interaction.guildId)) {
      return interaction.editReply("이 서버에서 퀴즈 또는 같이 보기가 진행 중입니다. 먼저 종료한 뒤 라디오를 시작하세요. 디스코드 활동은 /같이보기종료 후 활동 창도 닫아주세요.")
    }
    if (startingGuilds.has(interaction.guildId)) {
      return interaction.editReply("라디오 연결을 이미 진행 중입니다.")
    }
    startingGuilds.add(interaction.guildId)
    const generation = cancelledStarts.get(interaction.guildId) ?? 0
    try {

    const query = interaction.options.getString("채널", true)
    const member = await interaction.guild.members.fetch(interaction.user.id)
    const voiceChannel = member.voice?.channel

    if (!voiceChannel) {
      return interaction.editReply("먼저 음성 채널에 접속해주세요.")
    }

    const channelId = await resolveChannelId(query)
    if (!channelId) {
      return interaction.editReply(`\`${query}\` 채널을 찾지 못했습니다.`)
    }

    const { url, detail, adult, error } = await getLiveStream(channelId)
    if (error) return interaction.editReply(error)
    if (generation !== (cancelledStarts.get(interaction.guildId) ?? 0) || isQuizActive(interaction.guildId)) return interaction.editReply("재생 모드가 바뀌어 라디오 연결을 취소했습니다.")

    // 기존 세션 정리
    cleanupSession(interaction.guildId)

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true,
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000)
    } catch {
      connection.destroy()
      return interaction.editReply("음성 채널 연결에 실패했습니다.")
    }

    if (generation !== (cancelledStarts.get(interaction.guildId) ?? 0) || isQuizActive(interaction.guildId)) {
      connection.destroy()
      return interaction.editReply("재생 모드가 바뀌어 라디오 연결을 취소했습니다.")
    }
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    })

    const ffmpeg = createFfmpegStream(url, { adult })
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    })

    player.play(resource)
    connection.subscribe(player)

    player.on("error", (err) => console.error("[player error]", err))
    player.on(AudioPlayerStatus.Idle, () => {
      // 스트림이 끊기면 세션 종료 (방송 종료 등)
      cleanupSession(interaction.guildId)
    })

    ffmpeg.on("exit", (code) => {
      console.log("[ffmpeg] exited", code)
    })

    sessions.set(interaction.guildId, {
      connection,
      player,
      ffmpeg,
      liveInfo: detail,
      voiceChannelId: voiceChannel.id,
      channelId,
    })

    return interaction.editReply({ embeds: [buildLiveEmbed(detail)] })
    } finally {
      startingGuilds.delete(interaction.guildId)
    }
  }

  /* ---------------- /정지 ---------------- */
  if (commandName === "정지") {
    const session = sessions.get(interaction.guildId)
    if (!session) {
      return interaction.reply({
        content: "재생 중인 방송이 없습니다.",
        flags: MessageFlags.Ephemeral,
      })
    }
    cleanupSession(interaction.guildId)
    return interaction.reply("📴 재생을 중지하고 음성 채널을 나갔습니다.")
  }

  /* ---------------- /정보 ---------------- */
  if (commandName === "정보") {
    const session = sessions.get(interaction.guildId)
    if (!session) {
      return interaction.reply({
        content: "재생 중인 방송이 없습니다.",
        flags: MessageFlags.Ephemeral,
      })
    }
    // 최신 정보로 갱신
    const detail = await chzzk.live.detail(session.channelId).catch(() => null)
    const embed = buildLiveEmbed(detail ?? session.liveInfo, "📡 현재 방송 ��보")
    return interaction.reply({ embeds: [embed] })
  }
  } catch (error) {
    console.error('[chzzk] 명령 처리 실패:', error)
    const message = `라디오 명령 처리에 실패했습니다: ${error.message}`
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {})
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {})
  }
})

/* 음성 채널에 사람이 아무도 없으면 자동 퇴장 */
client.on("voiceStateUpdate", (oldState) => {
  const session = sessions.get(oldState.guild.id)
  if (!session) return
  const channel = oldState.guild.channels.cache.get(session.voiceChannelId)
  if (!channel) return
  const humans = channel.members.filter((m) => !m.user.bot).size
  if (humans === 0) cleanupSession(oldState.guild.id)
})

/* 안전한 종료 */
}

export function isRadioActive(guildId) {
  return sessions.has(guildId) || startingGuilds.has(guildId)
}

export function stopAllRadio() {
  for (const id of sessions.keys()) cleanupSession(id)
}

export function stopRadio(guildId) {
  cancelledStarts.set(guildId, (cancelledStarts.get(guildId) ?? 0) + 1)
  cleanupSession(guildId)
}
