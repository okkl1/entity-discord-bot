import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { handleMessage } from './machugi/commands.js';
import { hasSession, getSession, quizEvents, stopSession } from './machugi/quiz-session.js';
import { registerRadio, isRadioActive, stopRadio, stopAllRadio } from './chzzk/radio.js';
import { registerHelp } from './help.js';
import { createQuizWebServer } from './web/server.js';
import { registerWebCommands } from './web/commands.js';
import { startPublicTunnel } from './web/tunnel.js';
import { registerWatchTogether } from './web/watch-together.js';
import { syncSlashCommands, syncGuildCommands } from './discord-commands.js';
import { createEntryPanels, createWebEntryPublisher } from './web/entry-panel.js';
import { resources, RELEASE } from './resource-profile.js';
import { startMemoryMonitor } from './runtime-memory.js';
import { ffmpegPath } from './ffmpeg.js';
import { discordCache } from './discord-cache.js';

let web = null, tunnel = null, watchTogether;
console.log(`[entity] release=${RELEASE} memoryProfile=${resources.compact ? 'compact' : 'standard'}`);
console.log(`[audio] FFmpeg=${ffmpegPath}`);
const stopMemoryMonitor = resources.compact ? startMemoryMonitor() : () => {};
const isOtherPlaybackActive = id => isRadioActive(id) || Boolean(watchTogether?.isActive(id));

function requireEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`.env에 ${key} 값이 필요합니다.`);
  return value;
}

const env = {
  DISCORD_TOKEN: requireEnv('DISCORD_TOKEN'),
  MACHUGI_TYPESENSE_HOST: requireEnv('MACHUGI_TYPESENSE_HOST'),
  MACHUGI_TYPESENSE_API_KEY: requireEnv('MACHUGI_TYPESENSE_API_KEY'),
  MACHUGI_FIREBASE_API_KEY: requireEnv('MACHUGI_FIREBASE_API_KEY'),
  MACHUGI_FIREBASE_PROJECT_ID: requireEnv('MACHUGI_FIREBASE_PROJECT_ID'),
  isRadioActive: isOtherPlaybackActive,
  isWatchActive: id => Boolean(watchTogether?.isActive(id))
};
const guildId = process.env.DISCORD_GUILD_ID || undefined;

const client = new Client({
  makeCache: discordCache(resources.compact),
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.User]
});

const entryPanels = createEntryPanels(client);
const publishEntry = createWebEntryPublisher(entryPanels, () => web);
watchTogether = registerWatchTogether(client, {
  panels: entryPanels,
  stopRadio,
  stopPlayback: async id => {
    await web?.stopPlayback(id);
    const session = getSession(id);
    if (!session) return;
    await new Promise((resolve, reject) => {
      const onEnd = ended => { if (ended === session) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('퀴즈 정리가 지연되고 있습니다. 잠시 후 다시 시도해주세요.')); }, 15_000);
      const cleanup = () => { clearTimeout(timer); quizEvents.off('end', onEnd); };
      quizEvents.on('end', onEnd);
      try { session.requestStop(); } catch (error) { cleanup(); reject(error); }
    });
  }
});
registerRadio(client, { isQuizActive: id => hasSession(id) || watchTogether.isActive(id) || Boolean(web?.isWatchingGuild(id)) });
registerHelp(client);
process.once('exit', () => tunnel?.close());
registerWebCommands(client, { getWeb: () => web, isRadioActive: isOtherPlaybackActive, publishEntry });
if (process.env.WEB_ENABLED !== '0') {
  try {
    web = createQuizWebServer({ env, isRadioActive: isOtherPlaybackActive, publicUrl: process.env.WEB_PUBLIC_URL || '',
      runtimeStatus: () => ({ discordReady: client.isReady() }) });
    const localUrl = await web.listen({ port: Number(process.env.WEB_PORT || 3000), host: process.env.WEB_HOST || '127.0.0.1' });
    console.log(`[web] 로컬 퀴즈 페이지: ${localUrl}`);
    if (process.env.WEB_TUNNEL === '1' && !process.env.WEB_PUBLIC_URL) {
      tunnel = startPublicTunnel(localUrl);
      web.setPublicUrl(await tunnel.ready);
      console.log('[web] 외부 공유 주소 준비 완료. 디스코드에서 /퀴즈방을 사용하세요.');
    }
  } catch (error) { console.error('[web] 웹 연결 실패:', error.message); }
}

quizEvents.on('start', session => {
  const room = web?.getVoiceRoom(session.voiceChannel.guild.id, session.voiceChannel.id, session.starterId);
  if (room) void publishEntry({ room, voiceChannel: session.voiceChannel, fallbackChannel: session.textChannel })
    .catch(error => console.warn('[entry] 자동 참가 안내 실패:', error.code ?? 'network'));
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`통합 봇 로그인: ${readyClient.user.tag} · 서버 ${readyClient.guilds.cache.size}개`);
  readyClient.user.setPresence({ activities: [] });
  try {
    const result = await syncSlashCommands(client.application.commands, { guildIds: readyClient.guilds.cache.keys(), primaryGuildId: guildId });
    console.log(`슬래시 명령 등록 완료 · 중복·이전 명령 ${result.removed}개 정리`);
  } catch (error) { console.error('슬래시 명령 등록 실패:', error); }

});

client.on(Events.GuildCreate, guild => {
  syncGuildCommands(client.application.commands, guild.id, { primaryGuildId: guildId })
    .catch(error => console.error(`${guild.name}: 슬래시 명령 등록 실패:`, error.message));
});

client.on(Events.MessageCreate, async message => {
  try { await handleMessage(message, env); }
  catch (error) {
    console.error('퀴즈 메시지 처리 실패:', error);
    await message.reply(`오류가 발생했어요: ${error.message}`).catch(() => {});
  }
});

client.on('error', error => console.error('디스코드 클라이언트:', error));
client.on('shardError', error => console.error('디스코드 연결:', error));
client.on(Events.ShardDisconnect, (event, shardId) => console.warn(`[discord] disconnected: shard=${shardId} code=${event.code}`));
client.on(Events.ShardReconnecting, shardId => console.warn(`[discord] reconnecting: shard=${shardId}`));
client.on(Events.ShardResume, (shardId, replayed) => console.log(`[discord] resumed: shard=${shardId} replayed=${replayed}`));
process.on('unhandledRejection', error => console.error('처리되지 않은 오류:', error));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[entity] shutdown: signal=${signal || 'unknown'} uptimeSeconds=${Math.floor(process.uptime())}`);
  stopMemoryMonitor();
  for (const guildId of client.guilds.cache.keys()) await stopSession(guildId);
  stopAllRadio();
  await watchTogether.close();
  tunnel?.close();
  await web?.close();
  await entryPanels.close();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

client.login(env.DISCORD_TOKEN).catch(error => {
  console.error('디스코드 로그인 실패:', error);
  process.exitCode = 1;
  stopMemoryMonitor();
  tunnel?.close();
  web?.close().catch(() => {});
});
