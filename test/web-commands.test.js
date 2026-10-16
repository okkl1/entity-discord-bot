import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { registerWebCommands } from '../src/web/commands.js';

test('web room commands publish entry for everyone while owner credentials remain private', async () => {
  const client = new EventEmitter(), publications = [], replies = [];
  const voice = { id: 'voice', permissionsFor: () => ({ has: () => true }) };
  let owner = false;
  const existing = () => ({ id: 'room', shareUrl: 'https://example.com/r/room', joinUrl: `https://example.com/r/room${owner ? '#host=SECRET' : ''}`, owner, occupied: true });
  const web = { getVoiceRoom: existing, getDiscordJoinLink: async (id, userId, options) => {
    assert.equal(options.guildId, 'guild'); return `https://example.com/r/room#join=${userId}-PRIVATE`;
  }, trackRoomReply: () => () => {} };
  registerWebCommands(client, { getWeb: () => web, isRadioActive: () => false,
    publishEntry: async data => { publications.push(data); return { published: true, channelId: data.fallbackChannel.id }; } });
  const interaction = { isChatInputCommand: () => true, isButton: () => false, commandName: '웹방',
    guildId: 'guild', guild: { members: { me: {}, fetch: async () => ({ voice: { channel: voice } }) } },
    user: { id: 'guest' }, channel: { id: 'text' }, deferReply: async () => {}, editReply: async data => replies.push(data), deleteReply: async () => {} };
  await client.listeners(Events.InteractionCreate)[0](interaction);
  assert.match(replies[0].content, /<#text>/); assert.doesNotMatch(replies[0].content, /SECRET/);
  assert.equal(publications[0].fallbackChannel, interaction.channel);
  assert.equal(publications[0].room.shareUrl, 'https://example.com/r/room');
  owner = true; interaction.user.id = 'owner';
  await client.listeners(Events.InteractionCreate)[0](interaction);
  assert.match(replies[1].content, /#join=owner-PRIVATE/); assert.equal(publications.length, 2);
  assert.doesNotMatch(JSON.stringify(publications), /PRIVATE/);
});

test('the shared web button defers privately and supplies an identity link only to its clicking user', async () => {
  const client = new EventEmitter(), replies = [], requests = [];
  const web = { getDiscordJoinLink: async (...args) => { requests.push(args); return 'https://example.com/r/room#join=PERSONAL'; }, trackRoomReply: () => () => {} };
  registerWebCommands(client, { getWeb: () => web, isRadioActive: () => false });
  const interaction = { isButton: () => true, customId: 'q_web_join:room', user: { id: 'guest' }, guildId: 'guild',
    deferReply: async options => { assert.equal(options.flags, 64); }, editReply: async data => replies.push(data), deleteReply: async () => {} };
  await client.listeners(Events.InteractionCreate)[0](interaction);
  assert.deepEqual(requests, [['room', 'guest', { guildId: 'guild', hostOnly: false }]]);
  assert.equal(replies[0].components[0].toJSON().components[0].url, 'https://example.com/r/room#join=PERSONAL');
  assert.match(replies[0].content, /디스코드 닉네임/); assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  interaction.customId = 'q_web_host:room'; await client.listeners(Events.InteractionCreate)[0](interaction);
  assert.equal(requests[1][2].hostOnly, false, 'legacy creator buttons also permit every voice participant');
});

test('failed Discord identity validation displays its error without leaking an entry link', async () => {
  const client = new EventEmitter(), replies = [];
  registerWebCommands(client, { getWeb: () => ({ getDiscordJoinLink: async () => { throw new Error('먼저 음성 채널에 들어가주세요.'); } }), isRadioActive: () => false });
  await client.listeners(Events.InteractionCreate)[0]({ isButton: () => true, customId: 'q_web_join:room', user: { id: 'guest' }, guildId: 'guild',
    deferReply: async () => {}, editReply: async data => replies.push(data) });
  assert.match(replies[0].content, /음성 채널/); assert.equal(replies[0].components, undefined);
});

test('web handler leaves the YouTube room alias to the native activity handler', async () => {
  const client = new EventEmitter(); let handled = false;
  registerWebCommands(client, { getWeb: () => null, isRadioActive: () => false });
  await client.listeners(Events.InteractionCreate)[0]({ commandName: '유튜브방', isChatInputCommand: () => true,
    isButton: () => false, deferReply: async () => { handled = true; } });
  assert.equal(handled, false);
});
