import { Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { resolve } from 'node:path';
import { PriceFeed } from './feed.js';
import { PriceStatus } from './status.js';
import { cleanupLegacyWatches } from './cleanup.js';
import { formatPrice, getPrice, normalizeSymbol, validateSymbols } from './market.js';

export const binanceCommands = [
  new SlashCommandBuilder().setName('price').setDescription('USDT-M 선물 종목의 현재 가격을 조회합니다.')
    .addStringOption(option => option.setName('symbol').setDescription('예: BTCUSDT 또는 BTC').setRequired(true)),
  new SlashCommandBuilder().setName('symbol').setDescription('봇 활동 상태에 표시할 USDT-M 종목을 변경합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('symbol').setDescription('예: ETHUSDT 또는 ETH').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('통합 봇 사용법을 표시합니다.')
];

export function registerBinance(client, { dataDir }) {
  const feed = new PriceFeed();
  const status = new PriceStatus({
    client, feed, statePath: resolve(dataDir, 'status.json'),
    initialSymbol: process.env.PRICE_SYMBOL || 'BTCUSDT'
  });
  const oldWatchPath = resolve(dataDir, 'watches.json');
  feed.on('warning', error => console.warn('[binance] 스트림:', error.message));

  client.once(Events.ClientReady, async () => {
    try {
      await status.start();
      console.log(`[binance] ${status.symbol} 가격 활동 상태 시작`);
    } catch (error) { console.error('[binance] 활동 상태 시작 실패:', error); }
    try {
      const result = await cleanupLegacyWatches(client, oldWatchPath);
      if (result.removed || result.pending) console.log(`[binance] 이전 가격판 ${result.removed}개 삭제, ${result.pending}개 대기`);
    } catch (error) { console.error('[binance] 가격판 정리 실패:', error); }
  });

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || !['price', 'symbol', 'help'].includes(interaction.commandName)) return;
    try {
      if (interaction.commandName === 'help') {
        await interaction.reply({
          content: '**통합 봇 명령어**\n`/같이보기` 또는 `/유튜브방` 디스코드 안에서 유튜브 활동 · `/같이보기종료` 음악 재생 허용\n`/웹방` 음성 채널에 공유 참가 버튼 표시 · `/퀴즈방` 웹 퀴즈\n`/price` 선물 가격 조회 · `/symbol` 활동 상태 종목 변경\n`/라디오` 치지직 재생 · `/정지` 라디오 종료 · `/정보` 방송 정보\n`@봇 music` 음악 퀴즈 검색 · `@봇 random` 랜덤 퀴즈 · `@봇 help` 퀴즈 사용법',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const symbol = normalizeSymbol(interaction.options.getString('symbol', true));
      await validateSymbols([symbol]);
      if (interaction.commandName === 'price') {
        const quote = await getPrice(symbol);
        await interaction.editReply(`${symbol} 현재 가격: **${formatPrice(quote.price)} USDT** · 바이낸스 응답 시각 <t:${Math.floor(quote.time / 1000)}:R>`);
      } else {
        if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))
          throw new Error('서버 관리 권한이 필요합니다.');
        await status.setSymbol(symbol);
        await interaction.editReply(`활동 상태의 표시 종목을 ${symbol}(으)로 변경했습니다. 모든 서버에 같은 가격이 표시됩니다.`);
      }
    } catch (error) {
      console.error('[binance] 명령어 오류:', error);
      const message = `처리하지 못했습니다: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(console.error);
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(console.error);
    }
  });

  return {
    async close() {
      status.close();
      await cleanupLegacyWatches(client, oldWatchPath);
    }
  };
}
