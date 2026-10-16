import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, PermissionFlagsBits } from 'discord.js';

export const WATCH_BUTTON_PREFIX = 'entity_watch:';
export const WATCH_END_PREFIX = 'entity_watch_end:';

// One shared message per voice room. Web entry appears where the bot was called.
export function createEntryPanels(client) {
  const entries = new Map(), queues = new Map();
  let closed = false;
  const keyFor = channel => `${channel.guild.id}:${channel.id}`;
  const enqueue = (key, work) => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  };
  const canSend = channel => {
    if (!channel?.send) return false;
    const permissions = channel.permissionsFor?.(channel.guild?.members.me);
    return !channel.permissionsFor || Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions.has(channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages));
  };
  const visibleFallback = (voice, channel) => {
    if (!canSend(channel)) return false;
    if (!channel.permissionsFor) return true;
    return [...voice.members.values()].filter(member => !member.user.bot)
      .every(member => channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel));
  };
  function payload(entry) {
    const buttons = [];
    if (entry.room) {
      buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('웹방 입장').setCustomId(`q_web_join:${entry.room.id}`));
    }
    buttons.push(entry.activity
      ? new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('유튜브 참가').setURL(entry.activity.url)
      : new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel('디스코드 유튜브 같이 보기').setCustomId(`${WATCH_BUTTON_PREFIX}${entry.voice.id}`));
    if (entry.activity) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('같이 보기 종료').setCustomId(`${WATCH_END_PREFIX}${entry.voice.id}`));
    return { content: `**엔티티 · 함께하기**\n<#${entry.voice.id}>에 있는 친구들은 아래 버튼으로 참가하세요.\n${entry.activity ? '유튜브는 디스코드 활동 안에서 검색하고 함께 봅니다. 별도 브라우저·CMD 실행이 필요 없습니다.' : '음악 퀴즈·무손실 음악은 웹방에서, 유튜브는 디스코드 활동에서 함께 즐겨요.'}`,
      components: [new ActionRowBuilder().addComponents(buttons)], allowedMentions: { parse: [] } };
  }
  async function render(entry) {
    const data = payload(entry), fingerprint = JSON.stringify(data);
    const targets = entry.room ? [entry.webChannel].filter(Boolean) : [entry.voice];
    if (!entry.room && entry.fallback?.id !== entry.voice.id && visibleFallback(entry.voice, entry.fallback)) targets.push(entry.fallback);
    const existingTarget = targets.find(channel => channel.id === entry.message?.channelId);
    if (entry.message && existingTarget && canSend(existingTarget)) {
      try { await entry.message.edit(data); entry.fingerprint = fingerprint; return { published: true, channelId: entry.message.channelId }; }
      catch (error) {
        if (error.code !== 10008) return { published: false, reason: `공유 참가 버튼을 갱신하지 못했습니다. ${entry.room ? '봇을 호출한 채팅' : '음성 채널 채팅'}의 메시지 권한과 연결을 확인해주세요.` };
        entry.message = null;
      }
    }
    for (const target of targets) {
      if (!canSend(target)) continue;
      try {
        const previous = entry.message;
        entry.message = await target.send(data); entry.fingerprint = fingerprint;
        await previous?.delete().catch(() => {});
        return { published: true, channelId: target.id };
      }
      catch (error) { console.warn('[entry] 참가 패널 게시 실패:', error.code ?? 'network'); }
    }
    return { published: false, reason: `공유 참가 버튼을 표시하려면 봇에 ${entry.room ? '봇을 호출한 채팅' : '음성 채널 채팅'}의 「채널 보기·메시지 보내기」 권한을 주세요.` };
  }
  const removeMessage = async entry => { await entry.message?.delete().catch(() => {}); entry.message = null; };
  function show({ voiceChannel, fallbackChannel, room, activity }) {
    const key = keyFor(voiceChannel);
    return enqueue(key, async () => {
      if (closed) return { published: false };
      if (!voiceChannel.members.some(member => !member.user.bot)) return { published: false, reason: '음성 채널에 참가자가 없어 입장 안내를 정리했습니다.' };
      let entry = entries.get(key);
      if (!entry) { entry = { voice: voiceChannel }; entries.set(key, entry); }
      entry.voice = voiceChannel;
      if (room) { entry.room = { id: room.id, shareUrl: room.shareUrl }; entry.webChannel = fallbackChannel ?? entry.webChannel; }
      if (activity) { entry.activity = { url: activity.url }; entry.fallback = fallbackChannel ?? entry.fallback; }
      return render(entry);
    });
  }
  function clearPart(voiceChannel, part, roomId) {
    const key = keyFor(voiceChannel);
    return enqueue(key, async () => {
      const entry = entries.get(key);
      if (!entry || (roomId && entry.room?.id !== roomId)) return;
      delete entry[part];
      if (part === 'room') delete entry.webChannel;
      if (entry.room || entry.activity) await render(entry);
      else { entries.delete(key); await removeMessage(entry); }
    });
  }
  const onVoice = (oldState, newState) => {
    if (!oldState.channelId || oldState.channelId === newState.channelId) return;
    const voice = oldState.channel ?? oldState.guild.channels.cache.get(oldState.channelId);
    if (!voice || voice.members.some(member => !member.user.bot)) return;
    const key = keyFor(voice);
    void enqueue(key, async () => { const entry = entries.get(key); if (entry) { entries.delete(key); await removeMessage(entry); } });
  };
  client.on(Events.VoiceStateUpdate, onVoice);
  return { show,
    clearWeb: (voice, roomId) => clearPart(voice, 'room', roomId),
    clearActivity: voice => clearPart(voice, 'activity'),
    async close() {
      closed = true; client.off(Events.VoiceStateUpdate, onVoice);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...entries.values()].map(removeMessage)); entries.clear();
    }
  };
}

export function createWebEntryPublisher(panels, getWeb) {
  const tracked = new Map();
  return async ({ voiceChannel, fallbackChannel, room }) => {
    const web = getWeb();
    if (!web) return { published: false };
    if (!tracked.has(room.id)) {
      const untrack = web.trackRoomReply(room.id, async () => {
        tracked.delete(room.id); untrack(); await panels.clearWeb(voiceChannel, room.id);
      });
      tracked.set(room.id, untrack);
    }
    const result = await panels.show({ voiceChannel, fallbackChannel, room });
    if (result.published) web.setEntryChannel?.(room.id, result.channelId);
    return result;
  };
}
