import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const radioCommands = [
  new SlashCommandBuilder().setName('라디오').setDescription('치지직 방송을 음성 채널에서 재생합니다.')
    .addStringOption(option => option.setName('채널').setDescription('치지직 채널명 또는 채널 ID').setRequired(true)),
  new SlashCommandBuilder().setName('정지').setDescription('치지직 라디오 재생을 종료합니다.'),
  new SlashCommandBuilder().setName('정보').setDescription('재생 중인 치지직 방송 정보를 표시합니다.'),
  new SlashCommandBuilder().setName('인증').setDescription('성인 방송용 네이버 쿠키를 등록합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setDMPermission(false)
];
