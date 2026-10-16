import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, InviteTargetType } from 'discord.js';
import { registerWatchTogether, WATCH_TOGETHER_ID } from '../src/web/watch-together.js';

function fixture(options = {}) {
  const client = new EventEmitter(), order = [];
  let invited = 0, deleted = 0;
  const invite = { url: 'https://discord.gg/example', delete: async () => { deleted++; } };
  const member = { user: { bot: false }, voice: {}, permissions: { has: () => false } };
  const channel = { id: 'voice', members: new Map([['owner', member]]), permissionsFor: () => ({ has: () => true }),
    createInvite: async data => { invited++; order.push('invite'); assert.equal(data.targetApplication, WATCH_TOGETHER_ID); assert.equal(data.targetType, InviteTargetType.EmbeddedApplication); return invite; } };
  // Discord Collection.some is supplied by the production channel cache.
  channel.members.some = predicate => [...channel.members.values()].some(predicate);
  member.voice.channel = channel;
  const guild = { id: 'guild', members: { me: {}, fetch: async () => member }, channels: { cache: new Map([['voice', channel]]) } };
  const controller = registerWatchTogether(client, { stopPlayback: async () => order.push('stop'), stopRadio: () => order.push('radio'), ...options });
  async function command(name = '같이보기', user = 'owner', buttonId) {
    const replies = [];
    const interaction = { commandName: name, customId: buttonId, isButton: () => Boolean(buttonId), isChatInputCommand: () => !buttonId, guildId: 'guild', guild, user: { id: user },
      deferReply: async () => {}, editReply: async content => { order.push('reply'); replies.push(content); } };
    await client.listeners(Events.InteractionCreate)[0](interaction);
    return replies.at(-1);
  }
  return { client, guild, channel, member, controller, command, order, get invited() { return invited; }, get deleted() { return deleted; } };
}

test('native Watch Together requires no quiz and stops bot audio before returning its activity link', async () => {
  const f = fixture();
  try {
    const reply = await f.command();
    assert.deepEqual(f.order, ['invite', 'stop', 'radio', 'reply']);
    assert.equal(f.controller.isActive('guild'), true);
    assert.equal(reply.components[0].toJSON().components[0].url, 'https://discord.gg/example');
    assert.match(reply.content, /활동 참가/);
    await f.command('같이보기', 'guest');
    assert.equal(f.invited, 1);
    assert.equal(f.order.filter(value => value === 'stop').length, 1);
    const denied = await f.command('같이보기종료', 'guest');
    assert.match(denied.content, /서버 관리자만/);
    await f.command('같이보기종료');
    assert.equal(f.controller.isActive('guild'), false); assert.equal(f.deleted, 1);
  } finally { await f.controller.close(); }
});

test('failed native invitation preserves audio and releases the playback lock', async () => {
  const f = fixture(); f.channel.createInvite = async () => { throw new Error('초대 실패'); };
  const reply = await f.command();
  assert.match(reply.content, /초대 실패/); assert.equal(f.controller.isActive('guild'), false);
  assert.deepEqual(f.order, ['reply']);
});

test('native invitation cancelled by an empty voice channel cannot revive the session or stop audio', async () => {
  const f = fixture(); let resolveInvite;
  f.channel.createInvite = () => new Promise(resolve => { resolveInvite = resolve; });
  const pending = f.command();
  await new Promise(resolve => setImmediate(resolve));
  f.channel.members.clear();
  f.client.emit(Events.VoiceStateUpdate, { guild: f.guild }, { guild: f.guild });
  resolveInvite({ url: 'https://discord.gg/late', delete: async () => f.order.push('delete') });
  const reply = await pending;
  assert.match(reply.content, /비어/); assert.equal(f.controller.isActive('guild'), false);
  assert.deepEqual(f.order, ['delete', 'reply']);
});

test('native watch invitation failures on missing permissions do not stop playback', async () => {
  const f = fixture(); f.channel.permissionsFor = () => ({ has: () => false });
  const reply = await f.command(); assert.match(reply.content, /활동 사용/);
  assert.equal(f.invited, 0); assert.equal(f.controller.isActive('guild'), false);
});

test('native watch start failures clean up invitations and free the lock', async () => {
  const f = fixture({ stopPlayback: async () => { throw new Error('정리 실패'); } });
  const reply = await f.command(); assert.match(reply.content, /정리 실패/);
  assert.equal(f.deleted, 1); assert.equal(f.controller.isActive('guild'), false);
});

test('YouTube room alias launches the native activity and publishes its entry for other members', async () => {
  const publications = [], cleared = [];
  const f = fixture({ panels: { show: async data => { publications.push(data); return { published: true, channelId: 'voice' }; }, clearActivity: async channel => cleared.push(channel.id) } });
  try {
    const reply = await f.command('유튜브방');
    assert.match(reply.content, /<#voice>/); assert.match(reply.content, /별도 웹방·Brave·CMD 실행이 필요 없습니다/);
    assert.equal(publications[0].activity.url, 'https://discord.gg/example');
    assert.equal(publications[0].voiceChannel.id, 'voice');
    await f.command('같이보기종료'); assert.deepEqual(cleared, ['voice']);
  } finally { await f.controller.close(); }
});

test('shared watch buttons require their actual voice channel and restrict ending to the starter', async () => {
  const f = fixture();
  try {
    const denied = await f.command('button', 'owner', 'entity_watch:other');
    assert.match(denied.content, /이 참가 버튼의 음성 채널/); assert.equal(f.invited, 0);
    await f.command('button', 'owner', 'entity_watch:voice');
    assert.equal(f.controller.isActive('guild'), true);
    const endDenied = await f.command('button', 'guest', 'entity_watch_end:voice');
    assert.match(endDenied.content, /서버 관리자만/); assert.equal(f.controller.isActive('guild'), true);
    await f.command('button', 'owner', 'entity_watch_end:voice'); assert.equal(f.controller.isActive('guild'), false);
  } finally { await f.controller.close(); }
});

test('shared activity links renew before expiry without restarting audio or requiring another command', async () => {
  let clock = 0, count = 0;
  const links = [], removed = [];
  const f = fixture({ now: () => clock, panels: { show: async data => { links.push(data.activity.url); return { published: true, channelId: 'voice' }; }, clearActivity: async () => {} } });
  f.channel.createInvite = async () => {
    const id = ++count; return { url: `https://discord.gg/entry${id}`, delete: async () => { removed.push(id); } };
  };
  try {
    await f.command(); clock = 3_100_000; await f.controller.refreshInvites();
    assert.deepEqual(links, ['https://discord.gg/entry1', 'https://discord.gg/entry2']);
    assert.deepEqual(removed, [1]); assert.equal(f.order.filter(item => item === 'stop').length, 1);
    await f.command('같이보기', 'guest'); assert.equal(count, 2);
  } finally { await f.controller.close(); }
});
