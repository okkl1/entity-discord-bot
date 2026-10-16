import test from 'node:test';
import assert from 'node:assert/strict';
import { radioCommands } from '../src/chzzk/commands.js';
import { binanceCommands } from '../src/binance/plugin.js';
import { handleMessage } from '../src/machugi/commands.js';
import { webCommands } from '../src/web/commands.js';
import { watchTogetherCommands } from '../src/web/watch-together.js';

test('라디오와 선물 명령어 이름이 충돌하지 않는다', () => {
  const names = [...radioCommands, ...binanceCommands, ...webCommands, ...watchTogetherCommands].map(command => command.toJSON().name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, ['라디오', '정지', '정보', '인증', 'price', 'symbol', 'help', '퀴즈방', '웹방', '같이보기', '유튜브방', '같이보기종료']);
});

test('라디오가 재생 중이면 음악 퀴즈 시작을 거절한다', async () => {
  const replies = [];
  const message = {
    author: { bot: false, tag: 'tester' }, guild: { id: 'guild' }, guildId: 'guild',
    content: '<@123> music', client: { user: { id: '123' } },
    reply: async text => replies.push(text)
  };
  await handleMessage(message, { isRadioActive: guildId => guildId === 'guild' });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /라디오가 재생 중/);
});

test('native watch mode rejects quiz playback and points to its actual stop command', async () => {
  const replies = [];
  await handleMessage({ author: { bot: false }, guild: { id: 'guild' }, guildId: 'guild',
    content: '<@123> music', client: { user: { id: '123' } }, reply: async text => replies.push(text) },
    { isWatchActive: () => true });
  assert.equal(replies.length, 1); assert.match(replies[0], /같이보기종료/);
});
