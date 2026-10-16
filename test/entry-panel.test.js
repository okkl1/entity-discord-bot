import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, PermissionFlagsBits } from 'discord.js';
import { createEntryPanels, createWebEntryPublisher } from '../src/web/entry-panel.js';

function fixture() {
  const client = new EventEmitter(), posts = [], edits = [], removed = [];
  const bot = { id: 'bot', user: { bot: true } }, user = { id: 'user', user: { bot: false } };
  const guild = { id: 'guild', members: { me: bot }, channels: { cache: new Map() } };
  const members = new Map([['user', user]]); members.some = predicate => [...members.values()].some(predicate);
  const makeChannel = id => ({ id, guild, members, permissionsFor: () => ({ has: () => true }),
    send: async data => {
      posts.push({ id, data });
      const message = { channelId: id, edit: async data => { edits.push(data); }, delete: async () => { removed.push(id); } };
      return message;
    } });
  const voice = makeChannel('voice'), text = makeChannel('text'); guild.channels.cache.set('voice', voice);
  const panels = createEntryPanels(client), room = { id: 'room', shareUrl: 'https://example.com/r/room', hostUrl: 'https://example.com/r/room#host=PRIVATE' };
  return { client, panels, voice, text, room, posts, edits, removed, bot, user, makeChannel };
}

test('web entry is published in the calling chat instead of voice chat and never publishes private credentials', async () => {
  const f = fixture();
  try {
    const result = await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    assert.deepEqual(result, { published: true, channelId: 'text' }); assert.equal(f.posts[0].id, 'text');
    const json = JSON.stringify(f.posts[0].data); assert.doesNotMatch(json, /PRIVATE|host=/);
    const buttons = f.posts[0].data.components[0].toJSON().components;
    assert.equal(buttons[0].custom_id, 'q_web_join:room'); assert.equal(buttons[0].url, undefined); assert.equal(buttons[1].custom_id, 'entity_watch:voice');
    assert.equal(buttons.length, 2); assert.doesNotMatch(json, /방장 제어|q_web_host/);
    assert.deepEqual(f.posts[0].data.allowedMentions, { parse: [] });
  } finally { await f.panels.close(); }
});

test('concurrent entry requests and a switch to native video reuse one shared message', async () => {
  const f = fixture();
  try {
    await Promise.all([f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room }), f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room })]);
    await f.panels.show({ voiceChannel: f.voice, activity: { url: 'https://discord.gg/activity' } });
    assert.equal(f.posts.length, 1); assert.equal(f.edits.length, 2);
    const buttons = f.edits.at(-1).components[0].toJSON().components;
    assert.equal(buttons[1].url, 'https://discord.gg/activity');
    await f.panels.clearWeb(f.voice, f.room.id);
    assert.deepEqual(f.removed, ['text']); assert.deepEqual(f.posts.map(p => p.id), ['text', 'voice']);
    assert.doesNotMatch(JSON.stringify(f.edits.at(-1)), /example\.com/);
    await f.panels.clearActivity(f.voice);
    assert.deepEqual(f.removed, ['text', 'voice']);
  } finally { await f.panels.close(); }
});

test('web entry honors the calling chat and reports its permission failure without posting to voice chat', async () => {
  const f = fixture();
  try {
    f.text.permissionsFor = () => ({ has: () => false });
    const result = await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    assert.equal(result.published, false); assert.match(result.reason, /봇을 호출한 채팅/);
    assert.equal(f.posts.length, 0);
    f.text.permissionsFor = member => ({ has: () => member.id === 'bot' });
    const retry = await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    assert.equal(retry.channelId, 'text'); assert.equal(f.posts.length, 1);
  } finally { await f.panels.close(); }
});

test('calling web entry from another chat moves the shared panel only after a successful send', async () => {
  const f = fixture(), other = f.makeChannel('other-text'), send = other.send;
  try {
    await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    other.send = async () => { throw Object.assign(new Error('permission'), { code: 50013 }); };
    assert.equal((await f.panels.show({ voiceChannel: f.voice, fallbackChannel: other, room: f.room })).published, false);
    assert.deepEqual(f.posts.map(p => p.id), ['text']); assert.deepEqual(f.removed, []);
    other.send = send;
    const moved = await f.panels.show({ voiceChannel: f.voice, fallbackChannel: other, room: f.room });
    assert.equal(moved.channelId, 'other-text'); assert.deepEqual(f.posts.map(p => p.id), ['text', 'other-text']);
    assert.deepEqual(f.removed, ['text']);
    await f.panels.show({ voiceChannel: f.voice, fallbackChannel: other, room: f.room });
    assert.equal(f.posts.length, 2); assert.equal(f.edits.length, 1);
    await f.panels.clearWeb(f.voice, f.room.id); assert.deepEqual(f.removed, ['text', 'other-text']);
  } finally { await f.panels.close(); }
});

test('web entry can be sent to the calling thread with thread message permission', async () => {
  const f = fixture(), thread = f.makeChannel('thread');
  thread.isThread = () => true;
  thread.permissionsFor = () => ({ has: permission => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads].includes(permission) });
  try {
    assert.equal((await f.panels.show({ voiceChannel: f.voice, fallbackChannel: thread, room: f.room })).channelId, 'thread');
    assert.deepEqual(f.posts.map(p => p.id), ['thread']);
  } finally { await f.panels.close(); }
});

test('native activity keeps voice chat as the default and rejects a hidden fallback channel', async () => {
  const f = fixture();
  try {
    f.voice.permissionsFor = () => ({ has: permission => permission !== PermissionFlagsBits.SendMessages });
    f.text.permissionsFor = member => ({ has: () => member.id === 'bot' });
    const activity = { url: 'https://discord.gg/activity' };
    assert.equal((await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, activity })).published, false);
    assert.equal(f.posts.length, 0);
    f.text.permissionsFor = () => ({ has: () => true });
    assert.equal((await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, activity })).channelId, 'text');
  } finally { await f.panels.close(); }
});

test('an externally deleted entry panel is recreated; transient edit failures never duplicate it', async () => {
  const f = fixture(); let saved;
  const send = f.text.send;
  f.text.send = async data => { saved = await send(data); return saved; };
  try {
    await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    saved.edit = async () => { throw Object.assign(new Error('network'), { code: 50013 }); };
    assert.equal((await f.panels.show({ voiceChannel: f.voice, room: f.room })).published, false);
    assert.equal(f.posts.length, 1);
    saved.edit = async () => { throw Object.assign(new Error('deleted'), { code: 10008 }); };
    assert.equal((await f.panels.show({ voiceChannel: f.voice, room: f.room })).published, true);
    assert.equal(f.posts.length, 2);
  } finally { await f.panels.close(); }
});

test('leaving an empty voice channel removes its shared panel and permits a later new entry', async () => {
  const f = fixture();
  try {
    await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    f.voice.members.clear();
    f.client.emit(Events.VoiceStateUpdate, { channelId: 'voice', channel: f.voice }, { channelId: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.removed, ['text']);
    f.voice.members.set('user', f.user);
    await f.panels.show({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    assert.equal(f.posts.length, 2);
  } finally { await f.panels.close(); }
});

test('web room publications track one cleanup and remove public links on game end', async () => {
  const f = fixture(), callbacks = new Set(), entryChannels = [];
  const web = { trackRoomReply: (id, fn) => { callbacks.add(fn); return () => callbacks.delete(fn); }, setEntryChannel: (roomId, channelId) => entryChannels.push({ roomId, channelId }) };
  const publish = createWebEntryPublisher(f.panels, () => web);
  try {
    await publish({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    await publish({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room });
    assert.equal(callbacks.size, 1);
    await [...callbacks][0]();
    assert.equal(callbacks.size, 0); assert.deepEqual(f.removed, ['text']);
    await publish({ voiceChannel: f.voice, fallbackChannel: f.text, room: f.room }); assert.equal(callbacks.size, 1);
    assert.deepEqual(entryChannels, Array(3).fill({ roomId: 'room', channelId: 'text' }));
  } finally { await f.panels.close(); }
});
