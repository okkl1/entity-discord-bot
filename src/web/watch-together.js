import { Events, InviteTargetType, PermissionFlagsBits, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { WATCH_BUTTON_PREFIX, WATCH_END_PREFIX } from './entry-panel.js';

// Verified against Discord's public application RPC endpoint.
export const WATCH_TOGETHER_ID = '880218394199220334';
export const watchTogetherCommands = [
  new SlashCommandBuilder().setName('같이보기').setDescription('음성 채널에서 유튜브 Watch Together를 시작합니다.').setDMPermission(false),
  new SlashCommandBuilder().setName('유튜브방').setDescription('브라우저 없이 디스코드 유튜브 같이 보기에 참가합니다.').setDMPermission(false),
  new SlashCommandBuilder().setName('같이보기종료').setDescription('같이 보기 모드를 끝내고 봇 음악 재생을 허용합니다.').setDMPermission(false),
];

export function registerWatchTogether(client, { stopPlayback, stopRadio = () => {}, now = Date.now, panels } = {}) {
  const sessions = new Map();
  const remove = async guildId => {
    const session = sessions.get(guildId); if (!session) return;
    sessions.delete(guildId);
    await panels?.clearActivity(session.channel);
    await session.invite?.delete().catch(() => {});
  };
  const renew = async (guildId, session) => {
    session.starting = true;
    try {
      const invite = await session.channel.createInvite({ targetApplication: WATCH_TOGETHER_ID,
        targetType: InviteTargetType.EmbeddedApplication, maxAge: 3600, maxUses: 0, unique: true });
      if (sessions.get(guildId) !== session) { await invite.delete().catch(() => {}); return; }
      const previous = session.invite;
      session.invite = invite; session.startedAt = now();
      const published = await panels?.show({ voiceChannel: session.channel, activity: { url: invite.url } });
      if (!panels || published?.published) await previous?.delete().catch(() => {});
    } finally { session.starting = false; }
  };
  const refreshInvites = async () => {
    await Promise.allSettled([...sessions].filter(([, session]) => !session.starting && now() - session.startedAt > 3_000_000)
      .map(([guildId, session]) => renew(guildId, session)));
  };
  // Refresh the shared button before its one-hour invite expires, including late joins.
  const refreshTimer = setInterval(() => { void refreshInvites(); }, 60_000);
  refreshTimer.unref();
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const session = sessions.get(oldState.guild.id); if (!session) return;
    const channel = oldState.guild.channels.cache.get(session.channelId);
    if (!channel?.members.some(member => !member.user.bot)) void remove(oldState.guild.id);
  });
  client.on(Events.InteractionCreate, async interaction => {
    const isButton = interaction.isButton?.();
    const buttonEnd = isButton && interaction.customId.startsWith(WATCH_END_PREFIX);
    const buttonStart = isButton && interaction.customId.startsWith(WATCH_BUTTON_PREFIX);
    const slash = interaction.isChatInputCommand() && ['같이보기', '유튜브방', '같이보기종료'].includes(interaction.commandName);
    if (!slash && !buttonEnd && !buttonStart) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice?.channel;
      if (!channel) throw new Error('먼저 디스코드 음성 채널에 들어가주세요.');
      if (isButton && channel.id !== interaction.customId.slice((buttonEnd ? WATCH_END_PREFIX : WATCH_BUTTON_PREFIX).length)) throw new Error('이 참가 버튼의 음성 채널에 먼저 들어가주세요.');
      const old = sessions.get(interaction.guildId);
      if (buttonEnd || interaction.commandName === '같이보기종료') {
        if (!old) throw new Error('봇으로 시작한 같이 보기가 없습니다.');
        if (old.ownerId !== interaction.user.id && !member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('같이 보기를 시작한 사람 또는 서버 관리자만 종료할 수 있습니다.');
        if (old.starting) throw new Error('같이 보기를 준비하고 있습니다. 잠시 후 다시 종료해주세요.');
        await remove(interaction.guildId);
        return interaction.editReply('같이 보기 모드를 종료했습니다. **Watch Together 활동 창도 닫아주세요.** 이제 음악 퀴즈·라디오를 재생할 수 있습니다.');
      }
      if (old && old.channelId !== channel.id) throw new Error('이 서버의 다른 음성 채널에서 같이 보기가 진행 중입니다.');
      if (old?.starting) throw new Error('같이 보기를 이미 준비하고 있습니다. 잠시 후 다시 눌러주세요.');
      if (!channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.UseEmbeddedActivities)) throw new Error('이 음성 채널의 「활동 사용」 권한이 필요합니다.');
      if (!channel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) throw new Error('봇에 이 음성 채널의 「초대 코드 만들기」 권한을 주세요. 또는 음성 채널의 활동 메뉴에서 Watch Together를 직접 시작할 수 있습니다.');
      let session = old;
      if (session && now() - session.startedAt > 3_500_000) {
        await renew(interaction.guildId, session);
        if (sessions.get(interaction.guildId) !== session) throw new Error('음성 채널이 비어 같이 보기를 취소했습니다. 다시 참가해주세요.');
      }
      if (!session) {
        session = { ownerId: interaction.user.id, channelId: channel.id, channel, starting: true, startedAt: now() };
        sessions.set(interaction.guildId, session);
        try {
          // Prepare the invitation first; an API failure must preserve existing audio.
          session.invite = await channel.createInvite({ targetApplication: WATCH_TOGETHER_ID,
            targetType: InviteTargetType.EmbeddedApplication, maxAge: 3600, maxUses: 0, unique: true,
            reason: '엔티티 유튜브 같이 보기' });
          if (sessions.get(interaction.guildId) !== session) {
            await session.invite.delete().catch(() => {});
            throw new Error('음성 채널이 비어 같이 보기를 취소했습니다. 다시 참가해주세요.');
          }
          await stopPlayback?.(interaction.guildId);
          stopRadio(interaction.guildId);
          if (sessions.get(interaction.guildId) !== session) throw new Error('음성 채널이 비어 같이 보기를 취소했습니다.');
          session.starting = false;
        } catch (error) { await remove(interaction.guildId); throw error; }
      }
      const url = session.invite.url;
      const shared = await panels?.show({ voiceChannel: channel, fallbackChannel: interaction.channel, activity: { url } });
      if (sessions.get(interaction.guildId) !== session) throw new Error('음성 채널이 비어 같이 보기를 취소했습니다. 다시 참가해주세요.');
      await interaction.editReply({ content: `**유튜브 같이 보기**\n아래 버튼으로 디스코드 안에서 시작하세요. ${shared?.published ? `<#${shared.channelId}> 채팅에도 모두가 누를 수 있는 「유튜브 참가」 버튼을 표시했습니다.` : '친구들은 같은 음성 채널의 **활동 참가** 또는 /같이보기로 들어오면 됩니다.'}\n별도 웹방·Brave·CMD 실행이 필요 없습니다. 종료할 때는 /같이보기종료 또는 공유 패널의 종료 버튼을 누르세요.${shared?.reason ? `\n${shared.reason}` : ''}`,
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('디스코드에서 같이 보기').setURL(url))] });
    } catch (error) { await interaction.editReply({ content: error.message?.slice(0, 400) || '같이 보기를 시작하지 못했습니다.' }); }
  });
  return { isActive: guildId => sessions.has(guildId), refreshInvites, async close() { clearInterval(refreshTimer); await Promise.allSettled([...sessions.keys()].map(remove)); } };
}
