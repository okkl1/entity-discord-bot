/**
 * 봇 설정을 진단하고 초대 링크를 출력합니다.
 *
 * 사용: npm run doctor
 *
 * - .env 값이 다 들어있는지
 * - Discord API에 토큰이 유효한지 (application info 조회)
 * - 올바른 intent + scope로 된 초대 링크 출력
 */

import "dotenv/config"

const token = process.env.DISCORD_TOKEN
const clientId = process.env.DISCORD_CLIENT_ID
const guildId = process.env.DISCORD_GUILD_ID

console.log("[v0] === machugi discord bot doctor ===\n")

const required = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "MACHUGI_TYPESENSE_HOST",
  "MACHUGI_TYPESENSE_API_KEY",
  "MACHUGI_FIREBASE_API_KEY",
  "MACHUGI_FIREBASE_PROJECT_ID",
]

let envOk = true
for (const k of required) {
  const v = process.env[k]
  if (!v) {
    console.error(`  [MISSING] ${k}`)
    envOk = false
  } else {
    const preview = k.includes("TOKEN") || k.includes("KEY") ? "***" : v
    console.log(`  [OK] ${k} = ${preview}`)
  }
}
if (!envOk) {
  console.error("\n[v0] .env에 필수값이 빠져있어요. 중단합니다.")
  process.exit(1)
}

// 토큰 유효성 + application info
console.log("\n[v0] Discord API에 토큰 확인 중...")
try {
  const res = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
    headers: { Authorization: `Bot ${token}` },
  })
  if (!res.ok) {
    console.error(`  [FAIL] 토큰 유효성 확인 실패: ${res.status} ${await res.text()}`)
    console.error("         Developer Portal에서 Reset Token을 다시 해보세요.")
    process.exit(1)
  }
  const app = await res.json()
  console.log(`  [OK] application: ${app.name} (id: ${app.id})`)
  if (app.id !== clientId) {
    console.warn(
      `  [WARN] DISCORD_CLIENT_ID(${clientId})가 토큰의 app id(${app.id})와 달라요. CLIENT_ID를 ${app.id}로 맞추세요.`,
    )
  }
  const flags = app.flags ?? 0
  const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18
  const GATEWAY_MESSAGE_CONTENT = 1 << 19
  const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15
  const GATEWAY_GUILD_MEMBERS = 1 << 14
  const hasMsgContent = !!(flags & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED))
  const hasMembers = !!(flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED))
  console.log(`  [${hasMsgContent ? "OK" : "NOT SET"}] Privileged: MESSAGE CONTENT`)
  console.log(`  [${hasMembers ? "OK" : "NOT SET"}] Privileged: SERVER MEMBERS`)
  if (!hasMsgContent || !hasMembers) {
    console.warn("")
    console.warn("  [WARN] 필수 Privileged Intent가 꺼져 있습니다.")
    console.warn(`         https://discord.com/developers/applications/${app.id}/bot`)
    console.warn("         Privileged Gateway Intents에서 두 개 모두 ON + Save 하세요.")
  }
} catch (err) {
  console.error("[v0] API 호출 실패:", err.message)
  process.exit(1)
}

// 초대 링크
// 퍼미션: View Channels(1024) + Send Messages(2048) + Embed Links(16384)
//       + Attach Files(32768) + Read Message History(65536) + Use External Emojis(262144)
//       + Connect(1048576) + Speak(2097152) + Use Slash Commands(=applications.commands scope)
//       + Add Reactions(64) + Use Voice Activity(33554432)
const permissions = (
  1024n +
  2048n +
  16384n +
  32768n +
  65536n +
  262144n +
  1048576n +
  2097152n +
  64n +
  33554432n
).toString()

const base = "https://discord.com/api/oauth2/authorize"
const params = new URLSearchParams({
  client_id: clientId,
  scope: "bot applications.commands",
  permissions,
})
console.log("\n[v0] 봇 초대 링크 (이 링크로 재초대하세요):")
console.log("  " + base + "?" + params.toString())

if (guildId) {
  console.log(`\n[v0] 슬래시 커맨드 배포 대상: guild ${guildId} (즉시 반영)`)
} else {
  console.log("\n[v0] 슬래시 커맨드 배포 대상: GLOBAL (반영까지 최대 1시간)")
  console.log("     빠른 테스트를 원하면 .env의 DISCORD_GUILD_ID를 채우세요.")
}

console.log("\n[v0] 이제 다음을 순서대로 실행:")
console.log("  1) 위의 초대 링크로 봇을 서버에 (재)초대")
console.log("  2) npm run deploy    # 기존 슬래시 커맨드 제거 (한 번만)")
console.log("  3) npm start         # 봇 실행")
console.log("  4) 디스코드에서 음성 채널 입장 후 @봇이름 ping 으로 voice 감지 확인")
console.log("  5) 문제 없으면 @봇이름 music 사용")
