import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { quizEvents, getSession, hasSession, startQuizSession } from '../machugi/quiz-session.js';
import { searchMusicQuizzes, fetchQuizDetail, fetchMusicQuestions } from '../machugi/machugi.js';
import { createYouTubeSearch, parseYouTubeInput } from './youtube-search.js';
import { createLosslessLibrary } from './lossless-library.js';
import { createPlaybackQueue } from './playback-queue.js';
import { createPeerFallback } from './peer-fallback.js';
import { searchMatchedTracks, songFromVideo, matchTracks } from './track-match.js';
import { searchMusicTracks } from './music-search.js';
import { createMusicIdentityLookup, readVideoMusicMetadata } from './music-identity.js';

const secret = () => randomBytes(24).toString('base64url');
const sameSecret = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const phases = new Set(['question', 'reveal', 'fullplay']);
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/input-guard.js', ['input-guard.js', 'text/javascript; charset=utf-8']],
  ['/api-response.js', ['api-response.js', 'text/javascript; charset=utf-8']],
  ['/track-search-response.js', ['track-search-response.js', 'text/javascript; charset=utf-8']],
  ['/lossless-player.js', ['lossless-player.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);

export function createQuizWebServer({ env = {}, requireDiscordIdentity = true, isRadioActive = () => false,
  busy = hasSession, launch = startQuizSession, events = quizEvents,
  search = options => searchMusicQuizzes(options),
  videoSearch = createYouTubeSearch(),
  musicIdentity = createMusicIdentityLookup(videoSearch),
  lossless = createLosslessLibrary(),
  load = async (quizId, count) => {
    const detail = await fetchQuizDetail(quizId);
    if (detail.questionType !== 'music') throw new Error('음악 퀴즈를 선택해주세요.');
    const ids = [...(detail.questionIds ?? [])];
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const questions = await fetchMusicQuestions({ firebaseApiKey: env.MACHUGI_FIREBASE_API_KEY,
      firebaseProjectId: env.MACHUGI_FIREBASE_PROJECT_ID, quizId, questionIds: ids.slice(0, count) });
    const valid = questions.filter(q => q?.video_id && Array.isArray(q.answer) && q.answer.length);
    if (!valid.length) throw new Error('문제를 불러오지 못했습니다. 다른 퀴즈를 선택해주세요.');
    return { quiz: { id: detail.id, title: detail.title, thumbnail_url: detail.thumbnailUrl }, questions: valid };
  }, publicUrl = '' } = {}) {
  const rooms = new Map(), guildRooms = new Map(), httpLimits = new Map();
  let baseUrl = publicUrl.replace(/\/$/, '');
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('웹 주소는 http 또는 https여야 합니다.');
    baseUrl = parsed.origin;
  }
  const staticFiles = new Map();
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.close(1013, 'Connection too slow'); return; }
    ws.send(JSON.stringify(data));
  };
  const broadcast = (room, data) => { for (const ws of room.clients.keys()) send(ws, data); };
  const entryChannelUrl = room => `https://discord.com/channels/${room.guildId}/${room.entryChannelId || room.textChannel?.id || room.voiceChannel.id}`;
  const presence = room => broadcast(room, { type: 'presence', players: [...room.clients.values()].map(p => ({ name: p.name, host: p.host })) });
  const state = (room, value) => {
    value = { ...value, queue: room.queue?.snapshot() || [], pendingAudio: room.handoff?.status || null };
    room.state = value;
    room.revision++;
    broadcast(room, { type: 'state', ...value, preparing: Boolean(room.starting || room.advancing), revision: room.revision, serverTime: Date.now() });
  };
  const cleanupReplies = room => {
    const cleanups = [...room.replyCleanups]; room.replyCleanups.clear();
    for (const cleanup of cleanups) void Promise.resolve().then(cleanup).catch(error => console.warn('[web] 주소 안내 삭제 실패:', error.code ?? 'network'));
  };
  const cancelHandoff = (room, publish = true) => {
    const job = room.handoff; if (!job) return;
    room.handoff = null; job.controller.abort();
    if (job.stream) {
      if (job.onProgress) job.stream.events.off('progress', job.onProgress);
      void lossless.release(job.stream.id, job.owner).catch(error => console.warn('[lossless] 전환 취소:', error.message));
    }
    if (publish) state(room, room.state);
  };
  const clearWatch = room => { cancelHandoff(room, false); clearTimeout(room.watchTimer); room.watchTimer = null; room.watch = false; room.watchPick = null; };
  const clearQueue = room => { room.queueEpoch++; room.queueSearchController?.abort(); room.queueSearchController = null; return room.queue?.clear(); };
  const clearAudio = async room => {
    clearTimeout(room.audioTimer); room.audioTimer = null;
    const current = room.audioTrack; room.audioTrack = null;
    if (!current) return;
    current.retryController?.abort();
    current.stream.events.off('progress', current.onProgress);
    await lossless.release(current.stream.id, room.id);
  };
  const endAudio = room => {
    void clearQueue(room);
    void clearAudio(room).catch(error => console.warn('[lossless] 캐시 정리:', error.message));
    state(room, { phase: 'waiting', title: room.title, roundId: null, audio: null, video: null, answer: null, paused: false, scores: [] });
    cleanupReplies(room);
  };
  const audioTimer = room => {
    clearTimeout(room.audioTimer); room.audioTimer = null;
    const audio = room.state.audio;
    if (!room.audioTrack || room.state.paused || !audio?.startedAt || !audio.duration) return;
    const remaining = audio.duration - audio.startSeconds - Math.max(0, (Date.now() - audio.startedAt) / 1000);
    const roundId = room.state.roundId;
    room.audioTimer = setTimeout(() => { if (room.state.roundId === roundId) finishPlayback(room); }, Math.min(2_147_483_647, Math.max(0, remaining * 1000) + 250));
    room.audioTimer.unref();
  };
  const endWatch = room => { void clearQueue(room); clearWatch(room); state(room, { phase: 'waiting', title: room.title, roundId: null, audio: null, video: null, answer: null, paused: false, scores: [] }); cleanupReplies(room); };
  const watchTimer = room => {
    clearTimeout(room.watchTimer);
    const { video, paused } = room.state;
    if (!room.watch || paused || !video?.duration) return;
    const remaining = video.duration - video.startSeconds - Math.max(0, (Date.now() - video.startedAt) / 1000);
    const roundId = room.state.roundId;
    room.watchTimer = setTimeout(() => { if (room.state.roundId === roundId) finishPlayback(room); }, Math.min(2_147_483_647, Math.max(0, remaining * 1000)));
    room.watchTimer.unref();
  };
  const afterPreparation = (room, job) => {
    if (room.startJob !== job) return;
    room.starting = false; room.startJob = null; state(room, room.state); room.queue.prime();
    if (!room.advancing) {
      const pending = room.endPending; room.endPending = null;
      if (pending && pending === room.state.roundId) queueMicrotask(() => finishPlayback(room));
    }
  };
  const prepareWatchFlac = async (room, pick) => {
    if (room.handoff) throw new Error('FLAC을 준비하고 있습니다. 전환 취소 후 다른 곡을 선택해주세요.');
    const job = { owner: `handoff:${room.id}:${secret()}`, roundId: room.state.roundId, controller: new AbortController(), status: { title: pick.title, percent: 0, status: 'queued' } };
    room.handoff = job; state(room, room.state);
    try {
      const fallback = createPeerFallback(pick, room.watchPick);
      let stream, info;
      while (room.handoff === job) {
        try {
          stream = await lossless.acquire(pick, job.owner); job.stream = stream;
          if (room.handoff !== job) return;
          job.onProgress = progress => {
            if (room.handoff !== job) return;
            job.status = { title: pick.title, percent: progress.percent || 0, status: progress.status, attempt: pick.retryAttempt || 1 };
            state(room, room.state);
          };
          stream.events.on('progress', job.onProgress); job.onProgress(stream.status);
          info = await (pick.waitForComplete && stream.verified || stream.ready);
          break;
        } catch (error) {
          if (room.handoff !== job) return;
          if (job.stream) {
            if (job.onProgress) job.stream.events.off('progress', job.onProgress);
            await lossless.release(job.stream.id, job.owner); job.stream = null; job.onProgress = null;
          }
          job.status = { title: pick.title, percent: 0, status: 'retrying' }; state(room, room.state);
          const next = await fallback.next(error, [...room.trackPicks.values()], (q, options) => lossless.search(q, options), { signal: job.controller.signal });
          if (!next) throw fallback.failure(error);
          pick = next;
        }
      }
      if (room.handoff !== job || !room.watch || room.state.roundId !== job.roundId) return;
      await lossless.acquire(pick, room.id);
      if (room.handoff !== job || !room.watch || room.state.roundId !== job.roundId) {
        if (room.audioTrack?.stream.id !== stream.id) await lossless.release(stream.id, room.id);
        return;
      }
      const video = room.state.video;
      const seconds = pick.confident ? video.startSeconds + Math.max(0, ((room.state.paused ? video.pausedAt : Date.now()) - video.startedAt) / 1000) : 0;
      const handoffPaused = room.state.paused;
      room.handoff = null; job.committing = true; stream.events.off('progress', job.onProgress);
      try { await playListen(room, { ...pick, handoffPaused, handoffPosition: Math.min(seconds, Math.max(0, (info.duration || pick.duration || Infinity) - 1)) }, null, true); }
      finally { if (room.audioTrack?.stream.id !== stream.id) await lossless.release(stream.id, room.id); }
    } catch (error) {
      if (room.handoff === job || job.committing) { cancelHandoff(room); broadcast(room, { type: 'error', message: error.message }); }
    } finally {
      if (job.stream) { if (job.onProgress) job.stream.events.off('progress', job.onProgress); await lossless.release(job.stream.id, job.owner); }
    }
  };
  const playListen = async (room, pick, queuedItem = null, preparedHandoff = false, peerFallback = null) => {
    if (room.starting || (room.advancing && !queuedItem) || (!room.session && busy(room.guildId)) || isRadioActive(room.guildId)) throw new Error('다른 재생을 준비 중입니다. 디스코드 활동은 /같이보기종료 후 선택해주세요.');
    if (room.watch && !queuedItem && !preparedHandoff) {
      if (room.handoff) throw new Error('FLAC 전환을 준비하고 있습니다. 취소 후 다시 선택해주세요.');
      void prepareWatchFlac(room, pick).catch(error => broadcast(room, { type: 'error', message: error.message })); return;
    }
    const job = { kind: 'listen' }; room.startJob = job; room.starting = true; room.cancelStart = false;
    const previousWatch = room.watch ? { state: room.state, pick: room.watchPick } : null;
    clearWatch(room);
    const preparing = () => state(room, { phase: 'loading', title: pick.title, roundId: null, video: null, audio: null, answer: null, paused: false, scores: [], preparingKind: 'listen' });
    preparing(); let stream;
    try {
      await stopPrevious(room);
      if (room.cancelStart || room.startJob !== job) return;
      preparing();
      await clearAudio(room);
      if (room.cancelStart || room.startJob !== job) return;
      if (busy(room.guildId) || isRadioActive(room.guildId)) throw new Error('다른 음악 재생이 시작되었습니다.');
      stream = await lossless.acquire(pick, room.id);
      if (room.cancelStart || room.startJob !== job) { await lossless.release(stream.id, room.id); return; }
      clearWatch(room);
      const onProgress = progress => {
        if (room.audioTrack?.stream !== stream) return;
        if (progress.status === 'error') {
          if (room.state.audio?.startedAt) { broadcast(room, { type: 'error', message: progress.message }); finishPlayback(room); }
          return;
        }
        const audio = { ...room.state.audio, ...progress, duration: progress.duration || room.state.audio.duration || null };
        let paused = room.state.paused, buffering = Boolean(room.state.buffering);
        const time = Date.now();
        if (audio.startedAt && time >= audio.startedAt && audio.duration && audio.size && Number.isFinite(audio.bytes)) {
          const position = audio.startSeconds + Math.max(0, ((paused ? audio.pausedAt : time) - audio.startedAt) / 1000);
          const ahead = audio.duration * audio.bytes / audio.size - position;
          if (!paused && progress.status !== 'complete' && ahead < 3) {
            paused = buffering = true; audio.pausedAt = time;
          } else if (buffering && (ahead >= 12 || progress.status === 'complete')) {
            paused = buffering = false; audio.startSeconds = position; audio.startedAt = time + 1000; delete audio.pausedAt;
          }
        }
        state(room, { ...room.state, paused, buffering, audio }); audioTimer(room);
      };
      room.audioTrack = { stream, onProgress }; stream.events.on('progress', onProgress);
      state(room, { phase: 'listen', title: pick.title, roundId: 'audio:' + stream.id, video: null, answer: null, paused: false, scores: [],
        audio: { ...stream.status, id: stream.id, title: pick.title, url: '/api/rooms/' + room.id + '/audio/' + stream.id,
          duration: pick.duration, bitDepth: pick.bitDepth, sampleRate: pick.sampleRate, startSeconds: pick.handoffPosition || 0, startedAt: null } });
      void (pick.waitForComplete && stream.verified || stream.ready).then(info => {
        if (room.audioTrack?.stream !== stream) return;
        const startedAt = Date.now() + 1000;
        state(room, { ...room.state, paused: Boolean(pick.handoffPaused), audio: { ...room.state.audio, ...info, duration: info.duration || pick.duration || null,
          startedAt, ...(pick.handoffPaused ? { pausedAt: startedAt } : {}) } }); audioTimer(room);
      }).catch(async error => {
        if (room.audioTrack?.stream !== stream) return;
        const fallback = peerFallback || createPeerFallback(pick);
        const controller = room.audioTrack.retryController = new AbortController();
        try {
          state(room, { ...room.state, audio: { ...room.state.audio, status: 'retrying' } });
          const next = await fallback.next(error, [...room.trackPicks.values()], (q, options) => lossless.search(q, options), { signal: controller.signal });
          if (room.audioTrack?.stream !== stream) return;
          if (next) {
            try { await playListen(room, next, queuedItem, false, fallback); }
            catch (retryError) { broadcast(room, { type: 'error', message: retryError.message }); }
            return;
          }
          error = fallback.failure(error);
        } catch (retryError) {
          if (room.audioTrack?.stream !== stream || controller.signal.aborted) return;
          error = retryError;
        }
        if (room.audioTrack?.stream === stream) { broadcast(room, { type: 'error', message: error.message }); finishPlayback(room); }
      });
    } catch (error) {
      if (stream && room.audioTrack?.stream !== stream) await lossless.release(stream.id, room.id);
      if (previousWatch && !room.cancelStart && room.startJob === job && !room.audioTrack) {
        room.watch = true; room.watchPick = previousWatch.pick; state(room, previousWatch.state); watchTimer(room);
      } else if (!room.session && !room.watch && !room.audioTrack) state(room, { ...room.state, phase: 'waiting', preparingKind: null, audio: null, video: null });
      throw error;
    } finally { afterPreparation(room, job); }
  };
  const playWatch = async (room, pick, queuedItem = null) => {
    if (room.starting || (room.advancing && !queuedItem) || (!room.session && busy(room.guildId)) || isRadioActive(room.guildId)) throw new Error('다른 재생을 준비 중입니다.');
    const job = { kind: 'watch' }; room.startJob = job; room.starting = true; room.cancelStart = false; state(room, room.state);
    try {
      await stopPrevious(room);
      if (room.cancelStart || room.startJob !== job) return;
      await clearAudio(room);
      if (room.cancelStart || room.startJob !== job) return;
      if (busy(room.guildId) || isRadioActive(room.guildId)) throw new Error('다른 퀴즈·라디오·같이 보기가 시작되었습니다.');
      clearWatch(room); room.watch = true; room.watchPick = { ...pick };
      state(room, { phase: 'watch', title: pick.title, roundId: 'watch:' + secret(), audio: null, answer: null, paused: false, scores: [],
        video: { id: pick.id, startSeconds: Math.min(pick.startSeconds || 0, pick.duration || 86400), startedAt: Date.now(), duration: pick.duration } });
      watchTimer(room);
    } finally { afterPreparation(room, job); }
  };
  const advance = async room => {
    if (room.starting || room.advancing) return;
    if (!room.queue.size) { if (room.audioTrack) endAudio(room); else endWatch(room); return; }
    room.advancing = true; const epoch = room.queueEpoch;
    try {
      const cleanup = clearAudio(room); clearWatch(room);
      state(room, { phase: 'loading', title: '예약한 다음 곡 준비 중', roundId: null, audio: null, video: null, answer: null, paused: false, scores: [] });
      await cleanup;
      while (room.queue.size && epoch === room.queueEpoch) {
        const item = await room.queue.take();
        try {
          if (epoch !== room.queueEpoch) return;
          let fallback;
          if (item.failed && item.kind === 'listen') {
            fallback = createPeerFallback(item.pick);
            const controller = room.queueSearchController = new AbortController();
            let next;
            try { next = await fallback.next(item.stream?.error, [...room.trackPicks.values()], (q, options) => lossless.search(q, options), { signal: controller.signal }); }
            finally { if (room.queueSearchController === controller) room.queueSearchController = null; }
            if (epoch !== room.queueEpoch) return;
            if (next) { item.pick = next; item.failed = false; }
          }
          if (item.failed) throw new Error('예약한 음원 전송이 중단되어 다음 곡으로 넘깁니다.');
          if (item.kind === 'listen') await playListen(room, item.pick, item, false, fallback); else await playWatch(room, item.pick, item);
          if (room.audioTrack || room.watch) return;
        } catch (error) { if (epoch !== room.queueEpoch) return; broadcast(room, { type: 'error', message: error.message }); }
        finally { await room.queue.release(item).catch(error => console.warn('[lossless] 예약 캐시 정리:', error.message)); }
      }
      if (epoch === room.queueEpoch) endWatch(room);
    } finally {
      room.advancing = false; state(room, room.state); room.queue.prime();
      const pending = room.endPending; room.endPending = null;
      if (pending && pending === room.state.roundId) queueMicrotask(() => finishPlayback(room));
    }
  };
  const finishPlayback = room => {
    if (room.starting || room.advancing) { room.endPending = room.state.roundId; return; }
    void advance(room).catch(error => { broadcast(room, { type: 'error', message: error.message }); if (room.audioTrack) endAudio(room); else endWatch(room); });
  };
  const stopPrevious = async (room, options = {}) => {
    const previous = room.session;
    if (!previous) return;
    await new Promise((resolve, reject) => {
      const finished = ended => { if (ended === previous) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('이전 게임 정리가 지연되고 있습니다. 잠시 후 다시 선택해주세요.')); }, 15_000);
      const cleanup = () => { clearTimeout(timer); events.off('end', finished); };
      events.on('end', finished);
      try { previous.requestStop(options); } catch (error) { cleanup(); reject(error); }
    });
  };
  const attach = session => {
    let room = guildRooms.get(session.voiceChannel.guild.id);
    if (!room && session.starterId && session.textChannel) {
      try {
        createRoom({ textChannel: session.textChannel, voiceChannel: session.voiceChannel,
          ownerId: session.starterId, title: session.quiz?.title }, { attachCurrent: false });
        room = guildRooms.get(session.voiceChannel.guild.id);
      } catch (error) {
        console.warn('[web] 자동 퀴즈방 생성 실패:', error.message);
        return;
      }
    }
    if (!room) return;
    void clearQueue(room); clearWatch(room); void clearAudio(room).catch(error => console.warn('[lossless] 캐시 정리:', error.message));
    room.detach?.();
    if (session.starterId && room.ownerId !== session.starterId) {
      room.ownerId = session.starterId;
      room.hostToken = secret();
      for (const participant of room.players.values()) participant.host = false;
      for (const [ws, participant] of room.clients) {
        participant.host = false;
        send(ws, { type: 'hostRole', host: false });
      }
      presence(room);
    }
    room.textChannel = session.textChannel ?? room.textChannel;
    room.voiceChannel = session.voiceChannel;
    room.touchedAt = Date.now();
    session.webRoomUrl = `${baseUrl}/r/${room.id}`;
    session.webRoomId = room.id;
    room.session = session;
    room.starting = false;
    const onState = value => state(room, value);
    const onGuess = value => broadcast(room, { type: 'guess', ...value });
    session.events.on('state', onState);
    session.events.on('guess', onGuess);
    room.detach = () => { session.events.off('state', onState); session.events.off('guess', onGuess); };
    state(room, { ...session.getWebState(), audio: null });
  };
  const finish = session => {
    const room = guildRooms.get(session.voiceChannel.guild.id);
    if (!room || room.session !== session) return;
    if (room.state.phase !== 'finished') state(room, { ...session.getWebState(), phase: 'finished', video: null, answer: null, deadlineMs: null });
    room.detach?.(); room.detach = null; room.session = null;
    cleanupReplies(room);
  };
  events.on('start', attach); events.on('end', finish);

  const server = createServer(async (req, res) => {
    const headers = (code, type) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self'; img-src 'self' https://i.ytimg.com data:; connect-src 'self'; frame-src https://www.youtube.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    };
    const reply = (code, data, type = 'application/json; charset=utf-8') => {
      headers(code, type); res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const audioRoute = /^\/api\/rooms\/([\w-]+)\/audio\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (audioRoute && ['GET', 'HEAD'].includes(req.method)) {
        const room = rooms.get(audioRoute[1]);
        if (!room?.audioTrack || room.audioTrack.stream.id !== audioRoute[2]) return reply(404, { error: '재생 중인 음원이 아닙니다.' });
        return await lossless.serve(audioRoute[2], req, res);
      }
      if (req.method !== 'GET') return reply(405, { error: 'GET only' });
      if (url.pathname === '/opensource/slskd-source.zip') return reply(200,
        await readFile(new URL('../../bin/slskd/slskd-source.zip', import.meta.url)), 'application/zip');
      if (url.pathname === '/opensource/slskd-license.txt') return reply(200,
        await readFile(new URL('../../bin/slskd/LICENSE', import.meta.url)), 'text/plain; charset=utf-8');
      if (url.pathname === '/api/health') return reply(200, { ok: true });
      const roomRoute = /^\/api\/rooms\/([\w-]+)(\/(?:quizzes|videos|tracks))?$/.exec(url.pathname);
      if (roomRoute) {
        const room = rooms.get(roomRoute[1]);
        if (!room) return reply(404, { error: '방을 찾을 수 없습니다. 디스코드에서 새 방을 만들어주세요.' });
        if (!roomRoute[2]) return reply(200, { title: room.title, voiceName: room.voiceChannel.name, roomId: room.id,
          requireDiscordIdentity, discordChannelUrl: entryChannelUrl(room), losslessConfigured: await lossless.configured() });
        const ip = req.socket.remoteAddress;
        const limit = httpLimits.get(ip) ?? { since: Date.now(), count: 0 };
        if (Date.now() - limit.since > 60_000) { limit.since = Date.now(); limit.count = 0; }
        httpLimits.set(ip, limit);
        if (++limit.count > 60) return reply(429, { error: '검색이 많습니다. 잠시 후 다시 시도해주세요.' });
        const q = (url.searchParams.get('q') ?? '').slice(0, 120);
        if (roomRoute[2] === '/tracks') {
          const controller = new AbortController(); res.once('close', () => controller.abort());
          const streaming = String(req.headers.accept || '').includes('application/x-ndjson');
          const publish = (result, type = 'progress') => {
            if (controller.signal.aborted) return;
            for (const track of result.hits) { if (room.trackPicks.size >= 200 && !room.trackPicks.has(track.id)) room.trackPicks.delete(room.trackPicks.keys().next().value); room.trackPicks.set(track.id, { ...track, ...(result.identity ? { recording: { artist: result.identity.artist, track: result.identity.title, duration: track.duration } } : {}) }); }
            const data = { query: result.query, matchedId: result.matchedId, playableMatch: result.playableMatch,
              stage: result.stage, identity: result.identity, searchedQueries: result.searchedQueries,
              hits: result.hits.map(({ id, title, size, duration, bitDepth, sampleRate, freeSlot, queueLength, matchScore, matchLabel, relatedLabel, relatedArtist }) => ({ id, title, size, duration, bitDepth, sampleRate, freeSlot, queueLength, matchScore, matchLabel, relatedLabel, relatedArtist })) };
            if (!streaming) return data;
            if (res.writableLength > 1024 * 1024) { controller.abort(); res.destroy(); return; }
            res.write(JSON.stringify({ type, ...data }) + '\n');
          };
          const directInput = /^https?:\/\//i.test(q) ? parseYouTubeInput(q) : null;
          const videoId = url.searchParams.get('video') || directInput?.id, current = url.searchParams.get('current') === '1'; let result;
          if (current && (room.state.phase !== 'watch' || room.state.video?.id !== videoId || room.state.roundId !== url.searchParams.get('round'))) throw new Error('재생 영상이 바뀌었습니다. 현재 영상에서 다시 눌러주세요.');
          if (streaming) { headers(200, 'application/x-ndjson; charset=utf-8'); res.flushHeaders(); publish({ hits: [] }); }
          if (videoId) {
            let video = current ? { ...room.watchPick } : room.videoPicks.get(videoId) || (directInput?.id === videoId ? { id: videoId, title: '유튜브 링크 영상' } : null);
            if (!video?.id) throw new Error('유튜브 검색 결과에서 곡을 선택해주세요.');
            video = { ...video };
            const hint = String(url.searchParams.get('title') || '').trim().slice(0, 200);
            if (video.title === '유튜브 링크 영상' && hint && hint !== '유튜브 링크 영상') video.title = hint;
            const rememberVideo = () => {
              if (room.videoPicks.size >= 100 && !room.videoPicks.has(video.id)) room.videoPicks.delete(room.videoPicks.keys().next().value);
              room.videoPicks.set(video.id, { ...video });
              if (current && room.state.roundId === url.searchParams.get('round')) room.watchPick = { ...video };
            };
            if (video.title === '유튜브 링크 영상') {
              if (streaming) publish({ hits: [], stage: 'identity' });
              const detail = await readVideoMusicMetadata(video, videoSearch, { signal: controller.signal });
              if (!detail) throw new Error('영상 제목을 찾지 못했습니다. 가수명과 곡 제목을 직접 입력해주세요.');
              controller.signal.throwIfAborted();
              Object.assign(video, detail); rememberVideo();
            }
            if (!songFromVideo(video).artist) {
              if (streaming) publish({ hits: [], stage: 'identity' });
              const detail = await readVideoMusicMetadata(video, videoSearch, { signal: controller.signal });
              if (detail) { Object.assign(video, detail); rememberVideo(); }
            }
            const songIdentity = songFromVideo(video), identity = songIdentity.artist ? { artist: songIdentity.artist, title: songIdentity.title } : undefined;
            const report = value => { if (streaming) publish({ ...value, identity }); };
            result = await searchMatchedTracks(video, (query, options) => lossless.search(query, options), {
              signal: controller.signal, onProgress: report });
            result = { ...result, identity };
            if (!result.matchedId) {
              const song = songFromVideo(video);
              const reportRelated = value => {
                const compared = matchTracks(video, value.hits);
                report({ ...value, ...compared });
              };
              const related = await searchMusicTracks(`${song.artist ? song.artist + ' - ' : ''}${song.title}`, (query, options) => lossless.search(query, options), {
                signal: controller.signal, onProgress: reportRelated, discoverVideos: async () => [video], initialHits: result.hits,
                skipQueries: [...new Set([song.query, song.alternate || song.fallback].filter(Boolean))] });
              const combined = [...new Map([...result.hits, ...related.hits].map(track => [track.id, track])).values()];
              result = { ...related, ...matchTracks(video, combined), identity };
            }
          }
          if (!result) result = await searchMusicTracks(q, (query, options) => lossless.search(query, options), {
            signal: controller.signal, onProgress: streaming ? publish : undefined, discoverVideos: videoSearch,
            artist: (url.searchParams.get('artist') || '').trim().slice(0, 80), identifySong: musicIdentity });
          const hits = result.hits;
          const data = publish({ ...result, hits }, 'done');
          if (streaming) return res.end();
          return reply(200, data);
        }
        if (roomRoute[2] === '/videos') {
          const controller = new AbortController(); res.once('close', () => controller.abort());
          const streaming = String(req.headers.accept || '').includes('application/x-ndjson');
          const publish = (results, type = 'progress') => {
            if (controller.signal.aborted) return;
            const hits = results.filter(v => /^[\w-]{11}$/.test(v.id)).slice(0, 8).map(v => ({ id: v.id,
            title: String(v.title || '유튜브 영상').slice(0, 200), channel: String(v.channel || '').slice(0, 100),
            duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
            artist: typeof v.artist === 'string' ? v.artist.slice(0, 100) : undefined, track: typeof v.track === 'string' ? v.track.slice(0, 200) : undefined,
            startSeconds: Math.min(86400, Math.max(0, Number(v.startSeconds) || 0)), thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` }));
            for (const video of hits) { if (room.videoPicks.size >= 100 && !room.videoPicks.has(video.id)) room.videoPicks.delete(room.videoPicks.keys().next().value); room.videoPicks.set(video.id, video); }
            if (!streaming) return { hits };
            if (res.writableLength > 1024 * 1024) { controller.abort(); res.destroy(); return; }
            res.write(JSON.stringify({ type, hits }) + '\n');
          };
          if (streaming) { headers(200, 'application/x-ndjson; charset=utf-8'); res.flushHeaders(); publish([]); }
          const results = await videoSearch(q, { signal: controller.signal, onProgress: streaming ? publish : undefined });
          const data = publish(results, 'done');
          if (streaming) return res.end();
          return reply(200, data);
        }
        const result = await search({ host: env.MACHUGI_TYPESENSE_HOST, apiKey: env.MACHUGI_TYPESENSE_API_KEY,
          query: q, perPage: 50, page: 1, sortBy: 'hits:desc' });
        return reply(200, { found: result.found, hits: result.hits.map(({ id, title, hits, description }) => ({ id, title, hits, description })) });
      }
      const assetPath = /^\/r\/[\w-]+$/.test(url.pathname) ? '/' : url.pathname;
      const asset = assets.get(assetPath);
      if (!asset) return reply(404, { error: 'Not found' });
      if (!staticFiles.has(asset[0])) staticFiles.set(asset[0], await readFile(new URL(`./public/${asset[0]}`, import.meta.url)));
      reply(200, staticFiles.get(asset[0]), asset[1]);
    } catch (error) {
      if (res.destroyed) return;
      const kind = /\/tracks(?:\?|$)/.test(req.url) ? 'flac-search'
        : /\/videos(?:\?|$)/.test(req.url) ? 'youtube-search'
        : /\/quizzes(?:\?|$)/.test(req.url) ? 'quiz-search' : 'request';
      console.warn(`[web] ${kind} failed:`, error.name === 'TimeoutError' ? 'upstream timeout' : error.code || error.kind || 'upstream error',
        ...(error.stage && /^[a-z-]{1,24}$/.test(error.stage) ? [`stage=${error.stage}`] : []));
      const trackRequest = /\/tracks(?:\?|$)/.test(req.url);
      if (res.headersSent) return res.end(JSON.stringify({ type: 'error', error: error.message }) + '\n');
      reply(502, { error: trackRequest || error.code === 'YOUTUBE_AUTH_REQUIRED' ? error.message : '검색 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하거나 유튜브 주소를 입력해주세요.' });
    }
  });
  server.requestTimeout = 20_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const room = rooms.get(url.searchParams.get('room'));
      if (url.pathname !== '/socket' || !room || room.clients.size >= 32) throw new Error('Invalid room');
      if (req.headers.origin) {
        const allowed = new Set([req.headers.host, ...(baseUrl ? [new URL(baseUrl).host] : [])]);
        if (!allowed.has(new URL(req.headers.origin).host)) throw new Error('Invalid origin');
      }
      wss.handleUpgrade(req, socket, head, ws => { ws.room = room; wss.emit('connection', ws); });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });

  wss.on('connection', ws => {
    const room = ws.room;
    let player, since = Date.now(), commands = 0;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const joinTimer = setTimeout(() => ws.close(1008, 'Join required'), 10_000);
    ws.on('error', () => {});
    ws.on('message', async raw => {
      try {
        if (Date.now() - since > 1000) { since = Date.now(); commands = 0; }
        if (++commands > 12) throw new Error('입력이 너무 빠릅니다. 잠시 기다려주세요.');
        const message = JSON.parse(raw);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('요청 형식이 올바르지 않습니다.');
        if (message.type === 'ping') return send(ws, { type: 'pong', sentAt: message.sentAt, serverTime: Date.now() });
        if (message.type === 'join' && !player) {
          const identity = room.discordEntries.get(message.joinToken);
          if (requireDiscordIdentity && (!identity || identity.expires < Date.now())) throw Object.assign(
            new Error('디스코드의 「웹방 입장」 버튼이나 /웹방으로 다시 참가해주세요. 닉네임이 자동으로 적용됩니다.'), { code: 'DISCORD_JOIN_REQUIRED' });
          const discord = identity && identity.expires >= Date.now() ? identity : null;
          const host = discord ? discord.userId === room.ownerId : sameSecret(message.hostToken, room.hostToken);
          const resumed = discord ? [...room.players.values()].find(p => p.discordId === discord.userId) : room.players.get(message.resumeToken);
          let name = String(discord?.name ?? message.name ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, discord ? 32 : 24);
          if (!name) throw new Error('닉네임을 입력해주세요.');
          if (room.players.size >= 128 && !resumed) throw new Error('방이 가득 찼습니다. 새 방을 만들어주세요.');
          player = resumed ?? { token: secret(), id: secret(), name, host: false };
          // A resume token alone cannot grant host controls.
          player = { ...player, host, name, discordId: discord?.userId };
          const duplicate = [...room.clients.values()].some(p => p.id !== player.id && p.name === name);
          if (duplicate && !discord) player.name = `${name.slice(0, 18)}·${player.id.slice(0, 4)}`;
          for (const [other, p] of room.clients) if (p.id === player.id) { room.clients.delete(other); other.close(1000, 'Reconnected'); }
          room.players.set(player.token, player);
          room.clients.set(ws, player); room.touchedAt = Date.now(); clearTimeout(joinTimer);
          send(ws, { type: 'joined', resumeToken: player.token, name: player.name, host,
            voiceName: room.voiceChannel.name, discordChannelUrl: entryChannelUrl(room), shareUrl: `${baseUrl}/r/${room.id}` });
          send(ws, { type: 'state', ...room.state, preparing: Boolean(room.starting || room.advancing), revision: room.revision, serverTime: Date.now() });
          presence(room); return;
        }
        if (!player) throw new Error('먼저 방에 참가해주세요.');
        room.touchedAt = Date.now();
        if (message.type === 'answer') {
          if (typeof message.content !== 'string' || !message.content.trim() || message.content.length > 200) throw new Error('답은 1~200자로 입력해주세요.');
          if (typeof message.roundId !== 'string' || message.roundId !== room.state.roundId) throw new Error('문제가 바뀌었습니다. 다시 입력해주세요.');
          const result = room.session?.submitAnswer({ userId: player.discordId ?? (player.host ? room.ownerId : `web:${player.id}`),
            name: player.name, content: message.content.trim(), roundId: message.roundId });
          if (!result?.accepted) throw new Error('지금은 정답을 입력할 수 없습니다.');
          return send(ws, { type: 'answerAck', correct: result.correct });
        }
        if (message.type === 'skip') {
          if (message.roundId !== room.state.roundId || message.phase !== room.state.phase) throw new Error('문제 화면이 바뀌었습니다. 다시 눌러주세요.');
          if (!room.session || !phases.has(room.state.phase)) throw new Error('진행 중인 문제가 없습니다.');
          room.session.skipCurrent(); return;
        }
        if (message.type === 'prepareLossless') {
          void lossless.warmup?.().catch(() => {}); return;
        }
        if (message.type === 'cancelFlac') { cancelHandoff(room); return; }
        if (message.sourceRoundId !== undefined && (room.state.phase !== 'watch' || message.sourceRoundId !== room.state.roundId || message.sourceVideoId !== room.state.video?.id)) throw new Error('재생 영상이 바뀌었습니다. 현재 영상에서 다시 눌러주세요.');
        if (message.type === 'queueAdd') {
          if (room.session || room.startJob?.kind === 'quiz' || busy(room.guildId) || isRadioActive(room.guildId)) throw new Error('음악 감상이나 웹 유튜브 방에서 예약해주세요.');
          const kind = message.kind;
          const pick = kind === 'listen' ? room.trackPicks.get(message.trackId) : kind === 'watch' ? room.videoPicks.get(message.videoId) : null;
          if (!pick) throw new Error('검색 결과에서 예약할 곡을 선택해주세요.');
          room.queue.add(kind, { ...pick, waitForComplete: message.playbackMode === 'verified' }); send(ws, { type: 'queueAck', title: pick.title });
          if (!room.audioTrack && !room.watch && !room.starting && !room.advancing) finishPlayback(room);
          return;
        }
        if (message.type === 'queueRemove') { await room.queue.remove(message.id); return; }
        if (message.type === 'queueClear') { await room.queue.clear(); return; }
        if (message.type === 'next' && !room.session) {
          if ((!room.audioTrack && !room.watch) || message.roundId !== room.state.roundId || message.phase !== room.state.phase) throw new Error('곡이 바뀌었습니다. 다시 눌러주세요.');
          if (room.starting || room.advancing) throw new Error('다음 곡을 준비하고 있습니다.');
          await advance(room); return;
        }
        if (message.type === 'listen') {
          const pick = room.trackPicks.get(message.trackId); if (!pick) throw new Error('무손실 음악 검색 결과에서 곡을 선택해주세요.');
          await playListen(room, { ...pick, waitForComplete: message.playbackMode === 'verified' }); return;
        }
        if (message.type === 'watch') {
          const direct = typeof message.url === 'string' ? parseYouTubeInput(message.url) : null;
          const pick = direct ? { id: direct.id, title: '유튜브 링크 영상', startSeconds: direct.seconds, duration: null } : room.videoPicks.get(message.videoId);
          if (!pick) throw new Error('유튜브를 검색하거나 영상 주소를 입력해주세요.');
          await playWatch(room, pick); return;
        }
        if (message.type === 'start' || message.type === 'replace') {
          const replacing = message.type === 'replace';
          if (room.starting || room.advancing || (!replacing && (room.session || busy(room.guildId))) || isRadioActive(room.guildId)) throw new Error('퀴즈·라디오·같이 보기가 이미 진행 중입니다. 디스코드 활동은 /같이보기종료 후 선택해주세요.');
          if (replacing && !room.session && busy(room.guildId)) throw new Error('다른 퀴즈가 이미 진행 중입니다.');
          if (typeof message.quizId !== 'string' || !/^[\w-]{1,100}$/.test(message.quizId)) throw new Error('퀴즈를 선택해주세요.');
          const job = { kind: 'quiz' };
          room.startJob = job;
          room.starting = true;
          room.cancelStart = false;
          if (room.session || room.watch || room.audioTrack) state(room, room.state);
          else state(room, { phase: 'loading', title: '문제 준비 중', index: 0, total: 0, roundId: null, answer: null, video: null, scores: [] });
          let voiceHandoff;
          try {
            const requester = await room.voiceChannel.guild.members.fetch({ user: player.discordId ?? room.ownerId, force: true });
            if (requester.voice.channelId !== room.voiceChannel.id) throw new Error('연결된 디스코드 음성 채널에 먼저 들어가주세요.');
            const count = Math.min(50, Math.max(1, Number(message.count) || 10));
            const data = await load(message.quizId, count);
            if (room.cancelStart || room.startJob !== job) return;
            if (replacing && room.session) {
              if (room.session.voiceChannel.id === room.voiceChannel.id) voiceHandoff = room.session;
              await stopPrevious(room, { keepVoiceConnection: Boolean(voiceHandoff) });
            }
            if (room.cancelStart || room.startJob !== job) return;
            if (busy(room.guildId) || isRadioActive(room.guildId)) throw new Error('다른 퀴즈·라디오·같이 보기가 시작되었습니다.');
            await clearQueue(room); clearWatch(room); await clearAudio(room);
            if (room.cancelStart || room.startJob !== job) return;
            await launch({ textChannel: room.textChannel, voiceChannel: room.voiceChannel,
              ...data, questionTimeMs: 25_000, answerRevealMs: 8_000, starterId: room.ownerId });
          } catch (error) {
            state(room, room.session ? room.session.getWebState() : room.watch || room.audioTrack ? room.state : { ...room.state, phase: 'waiting', audio: null, video: null, answer: null, deadlineMs: null });
            throw error;
          } finally {
            // launch lasts for the new session's lifetime. Its cleanup owns
            // the reused connection; release only if no new session took it.
            if (voiceHandoff && (room.session === voiceHandoff || !busy(room.guildId))) voiceHandoff.releaseVoiceConnection?.();
            afterPreparation(room, job);
          }
          return;
        }
        if (message.type === 'stop') {
          room.cancelStart = true;
          if (!room.session) {
            room.startJob = null; room.starting = false;
            if (room.audioTrack) endAudio(room); else endWatch(room);
            return;
          }
          room.session.requestStop(); return;
        }
        if (room.audioTrack) {
          if (message.roundId !== room.state.roundId || message.phase !== 'listen') throw new Error('곡이 바뀌었습니다. 다시 눌러주세요.');
          if (message.type === 'stop') { endAudio(room); return; }
          if (message.type === 'audioEnded') {
            const a = room.state.audio;
            if (a.startedAt && !room.state.paused && (!a.duration || a.startSeconds + (Date.now() - a.startedAt) / 1000 >= a.duration - 1)) finishPlayback(room);
            return;
          }
          const audio = { ...room.state.audio }, time = Date.now();
          if (!audio.startedAt) throw new Error('아직 음원을 받고 있습니다. 잠시 기다려주세요.');
          if (message.type === 'pause') {
            if (room.state.buffering) throw new Error('끊김을 줄이기 위해 음원을 더 받고 있습니다. 준비되면 자동 재개됩니다.');
            const paused = typeof message.paused === 'boolean' ? message.paused : !room.state.paused;
            if (paused === Boolean(room.state.paused)) { state(room, room.state); return; }
            if (paused) audio.pausedAt = time;
            else { audio.startedAt += time - audio.pausedAt; delete audio.pausedAt; }
            state(room, { ...room.state, paused, audio }); audioTimer(room);
          } else if (message.type === 'audioSeek') {
            if (!Number.isFinite(message.seconds) || message.seconds < 0 || message.seconds > 86400) throw new Error('올바른 재생 위치를 입력해주세요.');
            audio.startSeconds = Math.min(message.seconds, audio.duration ? Math.max(0, audio.duration - 0.1) : 86400);
            audio.startedAt = time + 1000; if (room.state.paused) audio.pausedAt = time + 1000;
            state(room, { ...room.state, audio }); audioTimer(room);
          } else throw new Error('음악 감상에서 사용할 수 없는 동작입니다.');
          return;
        }
        if (room.watch) {
          if (message.roundId !== room.state.roundId || message.phase !== 'watch') throw new Error('영상이 바뀌었습니다. 다시 눌러주세요.');
          if (message.type === 'stop') { endWatch(room); return; }
          if (message.type === 'watchEnded') { finishPlayback(room); return; }
          const video = { ...room.state.video }, time = Date.now();
          if (message.type === 'pause') {
            const paused = typeof message.paused === 'boolean' ? message.paused : !room.state.paused;
            if (paused === Boolean(room.state.paused)) { state(room, room.state); return; }
            if (paused) video.pausedAt = time;
            else { video.startedAt += time - video.pausedAt; delete video.pausedAt; }
            state(room, { ...room.state, paused, video });
          } else if (message.type === 'watchSeek') {
            if (!Number.isFinite(message.seconds) || message.seconds < 0) throw new Error('올바른 재생 위치를 입력해주세요.');
            video.startSeconds = Math.min(message.seconds, video.duration ? Math.max(0, video.duration - 0.1) : 86400);
            video.startedAt = time; if (room.state.paused) video.pausedAt = time;
            state(room, { ...room.state, video });
          } else throw new Error('함께 보기에서 사용할 수 없는 동작입니다.');
          watchTimer(room); return;
        }
        if (!room.session) throw new Error('진행 중인 게임이 없습니다.');
        if (message.type !== 'stop' && (message.roundId !== room.state.roundId || message.phase !== room.state.phase)) throw new Error('문제 화면이 바뀌었습니다. 다시 눌러주세요.');
        if (message.type === 'pause') {
          if (typeof message.paused === 'boolean' && message.paused === Boolean(room.state.paused)) { state(room, room.state); return; }
          const result = room.state.paused ? room.session.resume() : room.session.pause();
          if (!result?.ok) throw new Error('지금은 재생을 정지할 수 없습니다. 노래가 준비된 뒤 다시 눌러주세요.');
        }
        else if (message.type === 'next') room.session.skipCurrent();
        else if (message.type === 'stop') room.session.requestStop();
        else if (message.type === 'fullplay') {
          if (room.session.resolveResult) room.session.resolveResult('fullplay');
          else throw new Error('정답 공개 후 전체듣기를 사용할 수 있습니다.');
        } else throw new Error('지원하지 않는 동작입니다.');
      } catch (error) {
        send(ws, { type: 'error', code: error.code === 'DISCORD_JOIN_REQUIRED' ? error.code : undefined, message: error.message?.slice(0, 200) ?? '요청 실패' });
        if (error.code === 'DISCORD_JOIN_REQUIRED') ws.close(1008, 'Discord entry required');
      }
    });
    ws.on('close', () => { clearTimeout(joinTimer); room.clients.delete(ws); room.touchedAt = Date.now(); presence(room); });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const room of rooms.values()) if ((room.audioTrack || room.watch || room.advancing || room.queue.size) && !room.clients.size && Date.now() - room.touchedAt > 30_000) {
      room.cancelStart = true; room.startJob = null; room.starting = false;
      if (room.audioTrack) endAudio(room); else endWatch(room);
    }
    for (const [id, room] of rooms) if (!room.clients.size && !room.session && !room.starting && Date.now() - room.touchedAt > 6 * 60 * 60_000) {
      room.detach?.(); clearWatch(room); void clearQueue(room); void clearAudio(room).catch(error => console.warn('[lossless] 캐시 정리:', error.message)); cleanupReplies(room); rooms.delete(id); guildRooms.delete(room.guildId);
    }
    for (const [ip, limit] of httpLimits) if (Date.now() - limit.since > 60_000) httpLimits.delete(ip);
  }, 30_000);
  heartbeat.unref();
  function createRoom({ textChannel, voiceChannel, ownerId, title = '엔티티 음악 퀴즈' }, { attachCurrent = true } = {}) {
    if (!baseUrl) throw new Error('웹 접속 주소 준비 중입니다. 잠시 후 다시 시도해주세요.');
    const guildId = voiceChannel.guild.id;
    let room = guildRooms.get(guildId);
    if (room && (room.ownerId !== ownerId || room.voiceChannel.id !== voiceChannel.id)) {
      if (room.session || room.audioTrack || room.starting || room.advancing || room.queue.size || room.clients.size) throw new Error('이 서버에 다른 방장이 만든 방이 있습니다.');
      room.detach?.(); clearWatch(room); void clearQueue(room); cleanupReplies(room); rooms.delete(room.id); guildRooms.delete(guildId); room = null;
    }
    if (!room) {
      if (rooms.size >= 32) throw new Error('방이 많습니다. 잠시 후 다시 시도해주세요.');
      room = { id: secret(), hostToken: secret(), title, guildId, ownerId, textChannel, voiceChannel,
        players: new Map(), clients: new Map(), discordEntries: new Map(), videoPicks: new Map(), trackPicks: new Map(), replyCleanups: new Set(), revision: 0, touchedAt: Date.now(), starting: false, queueEpoch: 0,
        state: { phase: 'waiting', title, index: 0, total: 0, roundId: null, answer: null, video: null, scores: [] } };
      const created = room;
      room.queue = createPlaybackQueue({ lossless, ownerPrefix: `queue:${room.id}`, onChange: () => state(created, created.state) });
      rooms.set(room.id, room); guildRooms.set(guildId, room);
      const active = getSession(guildId); if (attachCurrent && active) attach(active);
    }
    return { id: room.id, shareUrl: `${baseUrl}/r/${room.id}`, hostUrl: `${baseUrl}/r/${room.id}#host=${room.hostToken}` };
  }
  return {
    server, rooms, createRoom,
    setEntryChannel(roomId, channelId) {
      const room = rooms.get(roomId); if (!room || typeof channelId !== 'string' || !channelId || room.entryChannelId === channelId) return;
      room.entryChannelId = channelId; broadcast(room, { type: 'entryChannel', discordChannelUrl: entryChannelUrl(room) });
    },
    async getDiscordJoinLink(roomId, userId, { guildId, hostOnly = false } = {}) {
      const room = rooms.get(roomId);
      if (!room) throw new Error('방이 만료됐습니다. /웹방으로 다시 참가해주세요.');
      if (guildId !== room.guildId) throw new Error('이 디스코드 서버의 방이 아닙니다.');
      if (hostOnly && room.ownerId !== userId) throw new Error('퀴즈를 시작한 방장만 사용할 수 있습니다. 「웹방 입장」 버튼으로 참가해주세요.');
      const member = await room.voiceChannel.guild.members.fetch({ user: userId, force: true });
      if (rooms.get(roomId) !== room || (hostOnly && room.ownerId !== userId)) throw new Error('방이 바뀌었습니다. /웹방으로 다시 참가해주세요.');
      if (member.user?.bot || member.voice.channelId !== room.voiceChannel.id) throw new Error('먼저 이 방의 디스코드 음성 채널에 들어가주세요.');
      const name = String(member.displayName || member.nickname || member.user?.globalName || member.user?.username || '').normalize('NFC')
        .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
      if (!name) throw new Error('디스코드 닉네임을 읽지 못했습니다. 잠시 후 다시 참가해주세요.');
      for (const [key, value] of room.discordEntries) if (value.expires < Date.now()) room.discordEntries.delete(key);
      let token = [...room.discordEntries].find(([, value]) => value.userId === userId)?.[0];
      if (!token && room.discordEntries.size >= 128) throw new Error('방이 가득 찼습니다. 새로운 웹방을 만들어주세요.');
      token ||= secret(); room.discordEntries.set(token, { userId, name, expires: Date.now() + 24 * 60 * 60_000 });
      return `${baseUrl}/r/${room.id}#join=${token}`;
    },
    isWatchingGuild(guildId) { const room = guildRooms.get(guildId); return Boolean(room?.watch || room?.audioTrack || room?.starting || room?.advancing); },
    async stopPlayback(guildId) {
      const room = guildRooms.get(guildId);
      if (!room) return;
      room.cancelStart = true;
      room.startJob = null; room.starting = false;
      await clearQueue(room);
      await stopPrevious(room);
      await clearAudio(room);
      endWatch(room);
    },
    getVoiceRoom(guildId, channelId, userId) {
      const room = guildRooms.get(guildId);
      if (!room || room.voiceChannel.id !== channelId) return null;
      return { id: room.id, shareUrl: `${baseUrl}/r/${room.id}`, joinUrl: `${baseUrl}/r/${room.id}${room.ownerId === userId ? `#host=${room.hostToken}` : ''}`, owner: room.ownerId === userId,
        occupied: Boolean(room.session || room.audioTrack || room.starting || room.advancing || room.queue.size || room.clients.size) };
    },
    trackRoomReply(roomId, cleanup) {
      const room = rooms.get(roomId);
      if (!room) return () => {};
      room.replyCleanups.add(cleanup);
      return () => room.replyCleanups.delete(cleanup);
    },
    getHostLink(roomId, userId) {
      const room = rooms.get(roomId);
      if (!room) throw new Error('방이 만료됐습니다. 새 퀴즈를 시작해주세요.');
      if (room.ownerId !== userId) throw new Error('퀴즈를 시작한 방장만 사용할 수 있습니다. 위 참가 주소로 접속해주세요.');
      return `${baseUrl}/r/${room.id}#host=${room.hostToken}`;
    },
    setPublicUrl(url) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid web URL'); baseUrl = parsed.origin; },
    async listen({ port = 3000, host = '127.0.0.1' } = {}) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      const local = `http://127.0.0.1:${server.address().port}`;
      if (!baseUrl) baseUrl = local;
      return local;
    },
    async close() {
      clearInterval(heartbeat); events.off('start', attach); events.off('end', finish);
      const replyCleanups = [];
      for (const room of rooms.values()) { room.detach?.(); clearWatch(room); await clearQueue(room); await clearAudio(room); replyCleanups.push(...room.replyCleanups); room.replyCleanups.clear(); }
      await lossless.close();
      await Promise.allSettled(replyCleanups.map(cleanup => Promise.resolve().then(cleanup)));
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
