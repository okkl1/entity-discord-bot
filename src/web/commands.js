import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const webCommands = [new SlashCommandBuilder().setName('퀴즈방')
  .setDescription('웹에서 함께 정답을 입력하는 음악 퀴즈 방을 만듭니다.').setDMPermission(false),
  new SlashCommandBuilder().setName('웹방').setDescription('명령을 호출한 채팅에 웹방 참가 버튼을 표시합니다.').setDMPermission(false)];

function cleanUpPrivateLink(web, roomId, interaction) {
  let done = false, timer;
  let untrack = () => {};
  const cleanup = async () => {
    if (done) return;
    done = true; clearTimeout(timer); untrack();
    try { await interaction.deleteReply(); }
    catch (error) { if (![10008, 10015, 10062].includes(error.code)) console.warn('[web] 방장 링크 삭제 실패:', error.message); }
  };
  untrack = web.trackRoomReply(roomId, cleanup);
  timer = setTimeout(() => { void cleanup(); }, 60_000);
  timer.unref();
}

export function registerWebCommands(client, { getWeb, isRadioActive, publishEntry = async () => ({ published: false }) }) {
  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isButton?.() && /^(q_web_host|q_web_join):/.test(interaction.customId)) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const web = getWeb();
        if (!web) throw new Error('웹 서버가 준비되지 않았습니다.');
        const roomId = interaction.customId.split(':')[1];
        const url = await web.getDiscordJoinLink(roomId, interaction.user.id, { guildId: interaction.guildId, hostOnly: false });
        await interaction.editReply({ content: '디스코드 닉네임으로 바로 참가합니다. 아래 개인 입장 버튼을 누르세요.',
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('웹방 열기').setURL(url))], allowedMentions: { parse: [] } });
        cleanUpPrivateLink(web, roomId, interaction);
      } catch (error) { await interaction.editReply({ content: error.message, allowedMentions: { parse: [] } }).catch(() => {}); }
      return;
    }
    if (!interaction.isChatInputCommand() || !['퀴즈방', '웹방'].includes(interaction.commandName)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const web = getWeb();
      if (!web) throw new Error('웹 서버가 준비되지 않았습니다. 봇 실행 창을 확인해주세요.');
      const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      const voiceChannel = member.voice.channel;
      if (!voiceChannel) throw new Error('먼저 디스코드 음성 채널에 들어가주세요.');
      const existing = web.getVoiceRoom(interaction.guildId, voiceChannel.id, interaction.user.id);
      if (existing && (interaction.commandName === '웹방' || existing.owner || existing.occupied)) {
        const joinUrl = await web.getDiscordJoinLink(existing.id, interaction.user.id, { guildId: interaction.guildId });
        const shared = await publishEntry({ room: existing, voiceChannel, fallbackChannel: interaction.channel });
        await interaction.editReply({ content: `🌐 **[웹방 입장${existing.owner ? ' (방장)' : ''}](<${joinUrl}>)**\n디스코드 닉네임으로 자동 참가합니다.\n${shared.published ? `<#${shared.channelId}> 채팅에 모두가 보는 참가 버튼을 표시했습니다. 친구들도 그 버튼으로 바로 들어오세요.` : shared.reason || '친구도 같은 음성 채널에서 /웹방을 입력하면 참가할 수 있습니다.'}`, allowedMentions: { parse: [] } });
        cleanUpPrivateLink(web, existing.id, interaction); return;
      }
      const perms = voiceChannel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) throw new Error('봇에 이 음성 채널의 연결·말하기 권한이 필요합니다.');
      if (isRadioActive(interaction.guildId)) throw new Error('라디오는 /정지, 디스코드 같이 보기는 /같이보기종료 후 방을 만들어주세요.');
      const room = web.createRoom({ textChannel: interaction.channel, voiceChannel, ownerId: interaction.user.id,
        title: '엔티티 라운지' });
      const joinUrl = await web.getDiscordJoinLink(room.id, interaction.user.id, { guildId: interaction.guildId });
      const shared = await publishEntry({ room, voiceChannel, fallbackChannel: interaction.channel });
      await interaction.editReply({ content: `**웹방을 만들었습니다.**\n🌐 **[웹방 입장 (방장)](<${joinUrl}>)**\n디스코드 닉네임으로 자동 참가합니다.\n${shared.published ? `<#${shared.channelId}> 채팅에 「웹방 입장 / 디스코드 유튜브 같이 보기」 버튼이 표시됩니다. 친구에게 주소를 따로 보낼 필요 없습니다.` : shared.reason || '친구도 같은 음성 채널에서 /웹방을 입력하면 참가할 수 있습니다.'}\n개인 입장 링크는 본인만 사용하세요.`, allowedMentions: { parse: [] } });
      cleanUpPrivateLink(web, room.id, interaction);
    } catch (error) { await interaction.editReply({ content: error.message }); }
  });
}
