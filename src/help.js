import { Events, MessageFlags, SlashCommandBuilder } from 'discord.js';

export const helpCommands = [new SlashCommandBuilder().setName('help').setDescription('통합 봇 사용법을 표시합니다.')];

export function registerHelp(client) {
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'help') return;
    try {
      await interaction.reply({
        content: '**통합 봇 명령어**\n`/같이보기` 또는 `/유튜브방` 디스코드 안에서 유튜브 활동 · `/같이보기종료` 음악 재생 허용\n`/웹방` 호출한 채팅에 웹방 참가 버튼 표시 · `/퀴즈방` 웹 퀴즈\n`/라디오` 치지직 재생 · `/정지` 라디오 종료 · `/정보` 방송 정보\n`@봇 music` 음악 퀴즈 검색 · `@봇 random` 랜덤 퀴즈 · `@봇 help` 퀴즈 사용법',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) { console.error('[help] 사용법 표시 실패:', error.code || error.name); }
  });
}
