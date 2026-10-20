import { protectComposition } from './input-guard.js';
import { createLosslessPlayer } from './lossless-player.js';
import { readApiResponse } from './api-response.js';
import { readTrackSearchResponse } from './track-search-response.js';
import { createRoomConnection } from './room-connection.js';

const $ = id => document.getElementById(id);
for (const form of document.querySelectorAll('form')) protectComposition(form);
const roomId = /^\/r\/([\w-]+)$/.exec(location.pathname)?.[1];
const providedHostToken = new URLSearchParams(location.hash.slice(1)).get('host') ?? '';
const providedJoinToken = new URLSearchParams(location.hash.slice(1)).get('join') ?? '';
let hostToken = providedHostToken, joinToken = providedJoinToken, requireDiscordIdentity = false, discordChannelUrl = '';
try {
  const key = `entity-host:${roomId}`;
  if (providedHostToken) sessionStorage.setItem(key, providedHostToken);
  else hostToken = sessionStorage.getItem(key) ?? '';
  const joinKey = `entity-discord:${roomId}`;
  if (providedJoinToken) sessionStorage.setItem(joinKey, providedJoinToken);
  else joinToken = sessionStorage.getItem(joinKey) ?? '';
} catch {}
// Keep the private host token out of URLs passed to embedded video players.
if (providedHostToken || providedJoinToken) history.replaceState(null, '', location.pathname + location.search);
let socket, joined = false, host = false, state, revision = -1, offset = 0, bestRtt = Infinity;
let player, playerReady = false, videoKey = '', noticeTimer, searchController;
let videoSoundEnabled = true, videoAutoplayBlocked = false, videoWasPaused = false;
let youtubeController, trackController, matchController, matchingAction, matchingSource;
let pendingPause;
function clearPendingPause() { if (pendingPause) clearTimeout(pendingPause.timer); pendingPause = null; }
function localPlaybackState(value) {
  return pendingPause?.paused && pendingPause.roundId === value?.roundId
    ? { ...value, paused: true, audio: value.audio ? { ...value.audio, pausedAt: pendingPause.at } : null } : value;
}
let losslessConfigured = false, losslessPrepared = false;
const trackCards = new Map();
const albumCards = new Map();
let mode = new URLSearchParams(location.search).get('mode') === 'watch' ? 'watch' : 'quiz';
let scoreKey = '', presenceKey = '', queueKey = '', searchedQuizzes = false;
function selectMode(value) {
  mode = value;
  $('catalog').hidden = value !== 'quiz'; $('youtube-catalog').hidden = value !== 'watch';
  $('lossless-catalog').hidden = value !== 'listen';
  $('mode-quiz').setAttribute('aria-selected', String(value === 'quiz'));
  $('mode-watch').setAttribute('aria-selected', String(value === 'watch'));
  $('mode-listen').setAttribute('aria-selected', String(value === 'listen'));
  if (value === 'quiz' && joined && !searchedQuizzes) { searchedQuizzes = true; void searchQuizzes(); }
  if (value === 'listen' && joined && losslessConfigured && !losslessPrepared) {
    losslessPrepared = true; socket.send(JSON.stringify({ type: 'prepareLossless' }));
  }
}
$('mode-quiz').onclick = () => selectMode('quiz');
$('mode-watch').onclick = () => selectMode('watch');
$('mode-listen').onclick = () => selectMode('listen');
selectMode(mode);
const storageGet = key => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } };
const storageSet = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
$('lossless-mode').value = storageGet('entity-lossless-mode') === 'verified' ? 'verified' : 'fast';
$('lossless-mode').onchange = () => storageSet('entity-lossless-mode', $('lossless-mode').value);
const playbackMode = () => $('lossless-mode').value;
$('track-search-kind').value = storageGet('entity-lossless-search-kind') === 'albums' ? 'albums' : 'tracks';
const albumSearch = () => $('track-search-kind').value === 'albums';
function updateSearchKind() {
  $('track-search').placeholder = albumSearch() ? '가수·앨범명 (예: Toby Fox - UNDERTALE)' : '가수·곡명 또는 유튜브 제목·주소';
}
$('track-search-kind').onchange = () => {
  storageSet('entity-lossless-search-kind', $('track-search-kind').value); trackController?.abort();
  clearTrackResults(albumSearch() ? '앨범명을 입력하면 같은 폴더의 FLAC을 묶어 보여드려요.' : '가수·곡명 또는 유튜브 주소를 입력하세요.');
  $('track-search-status').textContent = ''; updateSearchKind();
};
updateSearchKind();
const resumeKey = `entity-room:${roomId}`;
const resumeGet = () => { try { return sessionStorage.getItem(resumeKey) ?? ''; } catch { return ''; } };
const resumeSet = value => { try { sessionStorage.setItem(resumeKey, value); } catch {} };
const notify = text => { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500); };
const send = data => { if (socket?.readyState !== WebSocket.OPEN || !joined) { notify('방 연결을 기다려주세요.'); return false; } socket.send(JSON.stringify(data)); return true; };
const now = () => Date.now() + offset;
const losslessPlayer = createLosslessPlayer($('lossless-audio'), { preloadAudio: $('lossless-next-audio'), now, onNotice: notify, onEnded: data => { if (joined) send({ type: 'audioEnded', ...data }); }, onStatus: value => {
  $('audio-enable').textContent = value.blocked || !value.enabled ? '이 기기에서 소리 켜기' : '이 기기 소리 끄기';
  $('audio-enable').dataset.enabled = String(value.enabled && !value.blocked);
  $('audio-buffer').textContent = value.buffering ? state?.audio?.status === 'verifying' ? '음원 손상 여부를 확인하고 있어요 · 확인 후 자동 재생' : '끊김을 줄이기 위해 음원을 준비하고 있어요 · 준비되면 자동 재생' : state?.audio?.integrity === 'verified' ? '원본 무결성 확인 · FLAC 원본 재생' : state?.audio?.integrity === 'pending' ? 'FLAC 원본 재생 · 전체 검사 중' : '디코딩 확인 · FLAC 원본 재생';
} });
const phaseLabels = { waiting: '시작 대기', loading: '다음 곡 준비', question: '노래 맞히는 중', reveal: '정답 공개', fullplay: '전체듣기', finished: '게임 종료', watch: '유튜브 함께 보기' };
const videoPosition = () => !state?.video ? 0 : state.video.startSeconds + Math.max(0, ((state.paused ? state.video.pausedAt : now()) - state.video.startedAt) / 1000);
const browserAudioAllowed = () => joined && ['reveal', 'watch'].includes(state?.phase);

function textElement(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function updateEntryChannel(url) {
  if (typeof url !== 'string') return;
  discordChannelUrl = url; $('discord-channel-link').href = url;
  $('discord-channel-link').hidden = !requireDiscordIdentity || !url;
}
function renderScores(scores) {
  const key = JSON.stringify(scores); if (key === scoreKey) return; scoreKey = key;
  $('scores').replaceChildren(); $('score-empty').hidden = scores.length > 0;
  scores.slice(0, 10).forEach((score, i) => { const li = document.createElement('li'); li.append(textElement('span', String(i + 1).padStart(2, '0'), 'rank'), textElement('span', score.name), textElement('span', `${score.points}점`, 'points')); $('scores').append(li); });
}
function renderPresence(players) {
  const key = JSON.stringify(players); if (key === presenceKey) return; presenceKey = key;
  $('player-count').textContent = `${players.length}명`; $('players').replaceChildren();
  for (const p of players) { const li = document.createElement('li'); li.append(textElement('span', p.name.slice(0, 1), 'avatar'), textElement('span', p.name)); if (p.host) li.append(textElement('span', '방장', 'host-badge')); $('players').append(li); }
}
function renderQueue(queue) {
  const key = JSON.stringify([queue, host, joined]); if (key === queueKey) return; queueKey = key;
  $('queue-count').textContent = `${queue.length}곡`;
  $('queue-clear').disabled = !joined || !queue.length; $('playback-queue').replaceChildren();
  if (!queue.length) $('playback-queue').append(textElement('li', '검색 결과의 예약 버튼으로 다음 곡을 골라두세요.', 'small queue-empty'));
  for (const [index, item] of queue.entries()) {
    const row = document.createElement('li'), copy = document.createElement('div');
    const labels = { waiting: '순서 대기', queued: '공유자 전송 대기 · 0%', preparing: `미리 받는 중 · ${item.percent}%`, verifying: '100% 수신 · 음원 검사 중', ready: `재생 준비됨 · ${item.percent}% 수신`, later: '재생할 때 준비', failed: '전송 중단 · 다음 곡에서 다른 공유자 확인' };
    copy.append(textElement('strong', `${index + 1}. ${item.title}`), textElement('small', `${item.kind === 'listen' ? 'FLAC' : '유튜브'} · ${labels[item.status] || '순서 대기'}`));
    const remove = textElement('button', '제거', 'quiet'); remove.type = 'button'; remove.disabled = !joined;
    remove.onclick = () => send({ type: 'queueRemove', id: item.id }); row.append(copy, remove); $('playback-queue').append(row);
  }
}
function applyState(next) {
  if (next.revision < revision) return;
  const roundChanged = !state || next.roundId !== state.roundId;
  const answerWasDisabled = $('answer').disabled;
  const phaseChanged = next.phase !== state?.phase;
  if (pendingPause && (next.roundId !== pendingPause.roundId || (next.revision > pendingPause.revision && Boolean(next.paused) === pendingPause.paused))) clearPendingPause();
  if (matchingSource && (next.phase !== 'watch' || next.roundId !== matchingSource.sourceRoundId)) matchController?.abort();
  revision = next.revision;
  if (roundChanged) { $('chat').replaceChildren(textElement('p', '떠오르는 제목을 가장 먼저 입력해보세요.', 'chat-empty')); $('answer').value = ''; }
  state = next;
  if (phaseChanged && ['watch', 'question', 'listen'].includes(next.phase)) selectMode(next.phase === 'listen' ? 'listen' : next.phase === 'watch' ? 'watch' : 'quiz');
  if (next.video && !player && !window.onYouTubeIframeAPIReady) prepareVideo();
  $('quiz-title').textContent = next.title || '엔티티 음악 퀴즈';
  $('phase').textContent = next.paused ? '잠깐 쉬는 중' : next.preparingKind === 'listen' ? 'FLAC 음원 준비 중' : next.phase === 'listen' ? next.audio?.startedAt ? '무손실 함께 듣기' : '음원 수신 대기' : phaseLabels[next.phase] || '준비 중';
  $('counter').textContent = next.total ? `${String(next.index).padStart(2, '0')} / ${String(next.total).padStart(2, '0')}` : 'READY WHEN YOU ARE';
  const active = joined && ['question', 'reveal', 'fullplay'].includes(next.phase);
  $('skip').disabled = !active;
  $('skip').hidden = $('fullplay').hidden = ['watch', 'listen'].includes(next.phase);
  $('pause').disabled = !joined || Boolean(next.buffering) || !['question', 'reveal', 'fullplay', 'watch', 'listen'].includes(next.phase) || (next.phase === 'listen' && !next.audio?.startedAt); $('pause').textContent = next.paused ? '재생 재개' : '재생 정지';
  if (pendingPause) { $('pause').disabled = true; $('pause').textContent = pendingPause.paused ? '정지 반영 중…' : '재개 반영 중…'; }
  $('stop').disabled = !joined || (!next.preparing && !['loading', 'question', 'reveal', 'fullplay', 'watch', 'listen'].includes(next.phase));
  $('stop').textContent = next.phase === 'listen' ? '음악 감상 종료' : next.phase === 'watch' ? '함께 보기 종료' : '게임 종료';
  $('next-track').hidden = !['listen', 'watch'].includes(next.phase);
  $('next-track').disabled = !joined || next.preparing || !next.queue?.length;
  $('watch-controls').hidden = !['watch', 'listen'].includes(next.phase); $('chat-card').hidden = ['watch', 'listen'].includes(next.phase);
  $('seek-seconds').disabled = $('seek-watch').disabled = !joined || next.preparing;
  $('sync-watch').disabled = !joined;
  if (next.phase === 'watch' && document.activeElement !== $('seek-seconds')) $('seek-seconds').value = Math.floor(videoPosition());
  if (next.phase === 'listen' && document.activeElement !== $('seek-seconds')) $('seek-seconds').value = Math.floor(losslessPosition(next));
  $('audio-hint').textContent = next.preparingKind === 'listen' ? '♫ FLAC 음원을 준비하고 있어요' : next.phase === 'listen' ? `FLAC 원본 · ${next.audio.bitDepth || '?'}bit / ${next.audio.sampleRate ? next.audio.sampleRate / 1000 : '?'}kHz` : ['reveal', 'watch'].includes(next.phase) ? '♫ 영상과 소리는 이 브라우저에서 재생돼요' : '♫ 노래는 디스코드에서 함께 듣고 있어요';
  $('lossless-status').hidden = next.phase !== 'listen'; $('audio-enable').hidden = next.phase !== 'listen'; $('audio-enable').disabled = !joined;
  if (next.audio) $('audio-progress').textContent = next.audio.status === 'retrying' ? '다른 공유자의 같은 곡을 찾는 중…' : next.audio.status === 'verifying' ? '수신 완료 · 전체 무결성 확인 중' : next.audio.startedAt ? `수신 ${next.audio.percent}% · ${(next.audio.bytes / 1024 / 1024).toFixed(1)} / ${(next.audio.size / 1024 / 1024).toFixed(1)}MB` : next.audio.bytes ? `재생 준비 · ${next.audio.percent}% 수신${next.audio.bufferTarget && next.audio.size ? ` · 시작 기준 약 ${Math.min(100, Math.ceil(next.audio.bufferTarget / next.audio.size * 100))}%` : ''}` : '상대방 업로드 대기열에서 기다리고 있어요';
  for (const button of $('track-results').querySelectorAll('button')) button.disabled = !joined || Boolean(next.preparing);
  $('youtube-hint').textContent = next.preparing ? '이전 게임을 정리하고 있어요.' : '영상 선택 시 진행 중인 퀴즈가 종료됩니다.';
  for (const button of $('youtube-results').querySelectorAll('button')) button.disabled = !joined || Boolean(next.preparing);
  $('fullplay').disabled = !joined || next.phase !== 'reveal';
  const answering = joined && next.phase === 'question' && !next.paused;
  $('answer').disabled = !answering; $('answer-send').disabled = !answering;
  $('answer').placeholder = answering ? '곡 제목을 입력하세요…' : next.phase === 'reveal' ? '다음 곡을 기다리고 있어요.' : '게임이 시작되면 정답을 입력할 수 있어요.';
  $('catalog-hint').textContent = next.preparing ? '선택한 퀴즈를 준비하고 있어요.' : active ? '다른 퀴즈를 선택하면 현재 게임이 바뀝니다.' : '노래를 검색하고 퀴즈를 골라 시작하세요.';
  for (const button of $('search-results').querySelectorAll('button')) button.disabled = !joined || Boolean(next.preparing);
  $('question-visual').hidden = Boolean(next.video); $('video-shell').hidden = !next.video;
  $('video-sound').hidden = !next.video;
  updateFlacButton();
  updateSoundButton();
  $('question-visual').classList.toggle('playing', (next.phase === 'question' || (next.phase === 'listen' && next.audio?.startedAt)) && !next.paused);
  $('stage-kicker').textContent = next.phase === 'watch' ? 'WATCHING TOGETHER' : next.phase === 'reveal' ? 'NOW YOU KNOW THE SONG' : next.phase === 'finished' ? 'THANKS FOR PLAYING TOGETHER' : 'THE NEXT SONG IS YOURS';
  const titles = { watch: next.paused ? '잠깐 멈췄어요.' : '같이 보고 있어요.', waiting: '준비되면 시작해요.', loading: '다음 노래를 꺼내는 중…', question: next.paused ? '잠깐 숨을 고를까요?' : '이 노래, 알고 있나요?', reveal: next.answer || '정답 공개', fullplay: next.answer || '한 곡 더 들어볼까요?', finished: next.playbackFailures && !next.scores?.length ? '재생 결과를 확인해주세요.' : '오늘도 함께 잘 들었어요.' };
  $('stage-title').textContent = next.preparingKind === 'listen' ? next.title : next.phase === 'listen' ? next.audio.title : titles[next.phase] || '준비 중';
  const descriptions = { waiting: '누구든 퀴즈를 고르면 모두 함께 시작합니다.', loading: '다음 곡을 준비하고 있어요. 잠시만 기다려주세요.', question: next.paused ? '재개를 누르면 남은 시간부터 이어집니다.' : '디스코드에서 들리는 노래의 제목을 입력하세요.', reveal: next.reason === 'correct' ? `${next.winnerName}님이 가장 먼저 맞혔어요!` : next.reason === 'skipped' ? '스킵한 곡의 정답이에요. 다음 곡은 맞힐 수 있을 거예요.' : '시간이 끝났어요. 이 제목을 기억해두세요.', fullplay: '노래는 디스코드에서, 영상은 모두 같은 위치로 재생됩니다.', finished: next.playbackFailures ? `재생 실패로 ${next.playbackFailures}문제를 건너뛰었습니다. 디스코드의 종료 안내를 확인해주세요.` : '점수를 확인하고 새로운 퀴즈로 다시 시작할 수 있어요.' };
  $('stage-description').textContent = next.preparingKind === 'listen' ? '선택한 FLAC을 임시 캐시에 준비하고 있어요. 전송과 음원 확인을 마치면 함께 시작합니다.' : next.phase === 'listen' ? next.buffering ? '음원을 더 받은 뒤 같은 위치에서 함께 재개합니다.' : 'FLAC 원본으로 함께 듣습니다. 곡을 바꾸거나 감상을 끝내면 캐시는 자동 삭제됩니다.' : next.phase === 'watch' ? '참가자의 정지·재개·위치 변경을 함께 반영합니다. 각 브라우저의 재생 지연은 자동으로 보정해요.' : descriptions[next.phase] || '';
  $('youtube-link').hidden = !next.video;
  if (next.video) $('youtube-link').href = `https://www.youtube.com/watch?v=${encodeURIComponent(next.video.id)}&t=${Math.floor(next.video.startSeconds)}s`;
  renderScores(next.scores || []); renderQueue(next.queue || []); syncVideo(); losslessPlayer.update(joined ? localPlaybackState(next) : { phase: 'waiting' }); updateTimer();
  if (answering && (answerWasDisabled || roundChanged)) $('answer').focus({ preventScroll: true });
}
function updateTimer() {
  if (!state) return;
  if (state.phase === 'listen') {
    const seconds = Math.floor(losslessPosition(state));
    writeTimer(state.audio.startedAt ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '대기 중', state.audio.duration ? Math.min(100, seconds / state.audio.duration * 100) : 0); return;
  }
  if (state.phase === 'watch') {
    const seconds = Math.floor(videoPosition());
    writeTimer(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, state.video.duration ? Math.min(100, seconds / state.video.duration * 100) : 100);
    return;
  }
  const remaining = state.paused && Number.isFinite(state.remainingMs) ? state.remainingMs : state.deadlineMs ? Math.max(0, state.deadlineMs - now()) : null;
  writeTimer(remaining === null ? '—' : `${Math.ceil(remaining / 1000)}s`, remaining === null ? 100 : Math.min(100, remaining / (state.phase === 'reveal' ? 8000 : 25000) * 100));
}
function losslessPosition(value = state) { return !value?.audio?.startedAt ? 0 : value.audio.startSeconds + Math.max(0, ((value.paused ? value.audio.pausedAt : now()) - value.audio.startedAt) / 1000); }
function writeTimer(label, percent) {
  if ($('countdown').textContent !== label) $('countdown').textContent = label;
  const width = `${percent.toFixed(1)}%`;
  if ($('timer-fill').style.width !== width) $('timer-fill').style.width = width;
}
function syncVideo() {
  if (!playerReady) return;
  if (!state?.video) { if (videoKey) { player.mute(); player.stopVideo(); } videoKey = ''; videoAutoplayBlocked = false; videoWasPaused = false; return; }
  if (pendingPause?.paused && pendingPause.roundId === state.roundId) { player.pauseVideo(); return; }
  if (browserAudioAllowed() && videoSoundEnabled) {
    if (player.isMuted()) player.unMute();
  } else if (!player.isMuted()) player.mute();
  const video = state.video;
  const key = `${state.roundId}:${state.phase}:${video.id}`;
  const position = videoPosition();
  const wasPaused = videoWasPaused;
  videoWasPaused = Boolean(state.paused);
  if (key !== videoKey) {
    videoKey = key; videoAutoplayBlocked = false; $('video-error').hidden = true;
    // Reveal begins only after the Discord player is idle; fullplay is muted.
    if (browserAudioAllowed() && videoSoundEnabled) player.unMute(); else player.mute();
    updateSoundButton();
    player.loadVideoById({ videoId: video.id, startSeconds: position });
  } else {
    if (state.paused) player.pauseVideo();
    else if (wasPaused) player.playVideo();
    if ((state.paused || player.getPlayerState() === 1) && Math.abs(player.getCurrentTime() - position) > 1.2) player.seekTo(position, true);
  }
}
function updateSoundButton() {
  $('video-sound').textContent = videoAutoplayBlocked ? (browserAudioAllowed() ? '영상 재생 · 소리 켜기' : '영상 재생') : browserAudioAllowed() ? (videoSoundEnabled ? '영상 소리 끄기' : '영상 소리 켜기') : '영상 재생 (소리는 디스코드)';
}
function prepareVideo() {
  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player('youtube', { width: '100%', height: '100%', playerVars: { autoplay: 1, playsinline: 1, rel: 0, origin: location.origin }, events: {
      onReady: () => { playerReady = true; player.mute(); syncVideo(); },
      onError: () => { $('video-error').hidden = false; },
      onStateChange: event => {
        if (!browserAudioAllowed()) player.mute();
        if (event.data === 1 && (state?.paused || (pendingPause?.paused && pendingPause.roundId === state?.roundId))) player.pauseVideo();
        if (event.data === 0 && state?.phase === 'watch' && player.getVideoData().video_id === state.video.id && (state.video.duration || videoPosition() > 2)) send({ type: 'watchEnded', roundId: state.roundId, phase: 'watch' });
      },
      onAutoplayBlocked: () => {
        if (!state?.video) return;
        videoAutoplayBlocked = true;
        updateSoundButton();
        notify('브라우저가 자동재생을 막았습니다. 영상 재생 버튼을 한 번 눌러주세요.');
      },
    } });
  };
  const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.onerror = () => notify('유튜브 연결을 확인해주세요. 정답 입력은 계속 사용할 수 있어요.'); document.head.append(script);
}
const connection = createRoomConnection({
  url: () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/socket?room=${encodeURIComponent(roomId)}`,
  join: () => ({ name: $('nickname').value.trim(), joinToken, hostToken, resumeToken: resumeGet() }),
  online: () => navigator.onLine !== false,
  checkRoom: async ({ signal }) => {
    const response = await fetch(`/api/rooms/${roomId}`, { signal, cache: 'no-store' });
    await response.body?.cancel();
    return response.status;
  },
  onSocket: ws => { socket = ws; },
  onStatus: ({ type, attempts, delay, code, reason }) => {
    const labels = {
      connecting: '방에 연결 중', connected: '실시간 연결됨',
      retrying: `연결 복구 중 · ${Math.ceil((delay || 1000) / 1000)}초 후 재시도`,
      offline: '인터넷 연결을 기다리는 중', missing: '방이 종료됨 · 디스코드에서 다시 입장',
      expired: '디스코드에서 다시 참가해주세요.', replaced: '다른 창에서 접속 중'
    };
    $('connection').textContent = labels[type] || '연결 확인 중';
    $('connection').className = `connection${type === 'connected' ? ' online' : type === 'connecting' ? '' : ' offline'}`;
    if (type === 'retrying') {
      // No room URL, identity or credential is written to the console.
      console.warn('[connection]', { attempts, code, reason });
      if (attempts === 3) notify('서버 연결이 지연되고 있습니다. 자동으로 다시 연결합니다.');
    }
    if (type === 'replaced') notify('다른 창에서 이 방에 접속했습니다.');
    if (type === 'expired' || type === 'missing') {
      $('game').hidden = true; $('join-card').hidden = false; $('discord-join').hidden = false;
      $('join-form').hidden = true;
      $('discord-join-hint').textContent = type === 'missing'
        ? '방이 종료되었거나 서버가 재시작되었습니다. 디스코드에서 /웹방으로 다시 입장해주세요.'
        : '입장 정보가 만료됐습니다. 봇을 호출한 디스코드 채팅의 「웹방 입장」 버튼을 다시 누르세요.';
    }
  },
  onDisconnect: () => {
    clearPendingPause(); joined = false;
    player?.mute(); losslessPlayer.pause();
    if (state) applyState(state);
  },
  onMessage: (msg, ws) => {
    if (msg.type === 'joined') {
      updateEntryChannel(msg.discordChannelUrl);
      joined = true; host = msg.host; revision = -1; bestRtt = Infinity; losslessPrepared = false; resumeSet(msg.resumeToken); storageSet('entity-nickname', msg.name);
      $('my-name').textContent = msg.name; $('nickname').value = msg.name; $('room-label').textContent = `${msg.voiceName} · LISTENING ROOM`;
      $('join-card').hidden = true; $('game').hidden = false; $('host-controls').hidden = false;
      $('connection').textContent = '실시간 연결됨'; $('connection').className = 'connection online';
      selectMode(mode);
    } else if (msg.type === 'entryChannel') updateEntryChannel(msg.discordChannelUrl);
    else if (msg.type === 'hostRole') { host = msg.host; if (state) applyState(state); }
    else if (msg.type === 'state') { if (bestRtt === Infinity) offset = msg.serverTime - Date.now(); applyState(msg); }
    else if (msg.type === 'presence') renderPresence(msg.players);
    else if (msg.type === 'guess') {
      if (msg.roundId !== state?.roundId) return;
      $('chat').querySelector('.chat-empty')?.remove();
      const row = textElement('div', '', `chat-entry${msg.correct ? ' correct' : ''}`); row.append(textElement('strong', msg.name), textElement('span', `${msg.content}${msg.correct ? ' ✓ 정답!' : ''}`)); $('chat').append(row);
      while ($('chat').children.length > 60) $('chat').firstElementChild.remove();
      $('chat').scrollTop = $('chat').scrollHeight;
    } else if (msg.type === 'pong') {
      const rtt = Date.now() - msg.sentAt;
      if (rtt <= bestRtt + 20) { bestRtt = Math.min(bestRtt, rtt); offset = msg.serverTime - (msg.sentAt + Date.now()) / 2; }
    } else if (msg.type === 'queueAck') notify(`${msg.title} · 다음 곡으로 예약했어요.`);
    else if (msg.type === 'albumQueueAck') notify(`${msg.title} · ${msg.added}곡 예약${msg.skipped ? ` · 중복 ${msg.skipped}곡 제외` : ''}`);
    else if (msg.type === 'error') { clearPendingPause(); notify(msg.message); if (state) applyState(state); }
  }
});
function connect() { connection.connect(); }
async function searchQuizzes() {
  searchedQuizzes = true;
  searchController?.abort(); searchController = new AbortController();
  $('search-results').replaceChildren(textElement('p', '퀴즈를 찾는 중…', 'small'));
  try {
    const response = await fetch(`/api/rooms/${roomId}/quizzes?q=${encodeURIComponent($('search').value)}`, { signal: searchController.signal });
    const data = await readApiResponse(response);
    $('search-results').replaceChildren();
    if (!data.hits.length) $('search-results').append(textElement('p', '검색 결과가 없어요. 다른 검색어를 입력해보세요.', 'small'));
    for (const quiz of data.hits) {
      const button = textElement('button', '', 'quiz-option'); button.type = 'button'; button.disabled = !joined || Boolean(state?.preparing);
      button.append(textElement('strong', quiz.title), textElement('small', `${Number(quiz.hits || 0).toLocaleString()}회 플레이 · 이 퀴즈 선택 ↗`));
      button.onclick = () => {
        const replacing = ['question', 'reveal', 'fullplay'].includes(state?.phase);
        if (send({ type: replacing ? 'replace' : 'start', quizId: quiz.id, count: Number($('question-count').value) })) for (const el of $('search-results').querySelectorAll('button')) el.disabled = true;
      };
      $('search-results').append(button);
    }
  } catch (error) { if (error.name !== 'AbortError') $('search-results').replaceChildren(textElement('p', error.message, 'small')); }
}
async function searchYouTube() {
  youtubeController?.abort(); youtubeController = new AbortController();
  const controller = youtubeController;
  $('youtube-results').replaceChildren(textElement('p', '유튜브 영상을 찾는 중…', 'small'));
  try {
    const response = await fetch(`/api/rooms/${roomId}/videos?q=${encodeURIComponent($('youtube-search').value)}`, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
    const data = await readTrackSearchResponse(response, { signal: controller.signal, onProgress: data => {
      if (youtubeController === controller && data.hits.length) renderVideos(data.hits);
    } });
    if (youtubeController === controller) renderVideos(data.hits);
  } catch (error) { if (error.name !== 'AbortError' && youtubeController === controller) $('youtube-results').replaceChildren(textElement('p', error.message, 'small')); }
}
function renderVideos(hits) {
    $('youtube-results').replaceChildren();
    if (!hits.length) $('youtube-results').append(textElement('p', '검색 결과가 없어요. 영상 주소도 사용할 수 있어요.', 'small'));
    for (const video of hits) {
      const card = textElement('div', '', 'quiz-option video-option');
      const img = document.createElement('img'); img.src = video.thumbnail; img.alt = ''; img.loading = 'lazy';
      card.append(img, textElement('strong', video.title), textElement('small', video.channel));
      const actions = textElement('div', '', 'result-actions');
      for (const [label, action] of [['영상 재생', () => { matchController?.abort(); send({ type: 'watch', videoId: video.id }); }],
        ['영상 예약', () => send({ type: 'queueAdd', kind: 'watch', videoId: video.id })],
        ['FLAC 듣기', () => findFlac(video, 'play')], ['FLAC 예약', () => findFlac(video, 'queue')]]) {
        const button = textElement('button', label, 'secondary'); button.type = 'button'; button.disabled = !joined || Boolean(state?.preparing);
        button.onclick = action; actions.append(button);
      }
      card.append(actions); $('youtube-results').append(card);
    }
}
async function searchTracks() {
  if (albumSearch()) return searchAlbums();
  trackController?.abort(); trackController = new AbortController();
  const controller = trackController;
  let hasHits = false;
  clearTrackResults('Soulseek에서 FLAC를 찾는 중… 첫 연결은 조금 더 걸릴 수 있어요.');
  $('track-search-status').textContent = '검색 중… 결과가 도착하는 대로 표시합니다.';
  try {
    const params = new URLSearchParams({ q: $('track-search').value });
    const response = await fetch(`/api/rooms/${roomId}/tracks?${params}`, {
      signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
    const data = await readTrackSearchResponse(response, { signal: controller.signal, onProgress: data => {
      if (data.hits.length) { hasHits = true; renderTrackResults(data.hits); }
      $('track-search-status').textContent = data.hits.length ? `${data.hits.length}개 도착 · 바로 선택할 수 있어요. 추가 검색 중…`
        : data.stage === 'identity' ? '검색할 가수·곡명을 확인하는 중…'
        : data.stage === 'related' ? '더 관련 있는 곡을 찾기 위해 곡명·가수·핵심 단어로 연관 검색 중…'
        : data.identity ? `${data.identity.artist} · ${data.identity.title} — FLAC 검색 중…` : 'Soulseek 연결·검색 준비 중…';
      showMusicIdentity(data.identity);
    } });
    showMusicIdentity(data.identity);
    renderTrackResults(data.hits);
    const expanded = data.stage === 'related' ? ' · 연관 검색 포함' : '';
    $('track-search-status').textContent = data.hits.length ? `${data.hits.length}개 검색 완료${expanded}`
      : `제목·연관 검색 ${data.searchedQueries?.length || 1}개에서 응답한 공유자의 FLAC 후보를 찾지 못했어요. 다른 곡명 표기나 가수명으로 검색해보세요.`;
  } catch (error) {
    if (error.name !== 'AbortError' && trackController === controller) {
      $('track-search-status').textContent = error.message;
      if (!hasHits) clearTrackResults('검색을 완료하지 못했습니다. 다시 시도해주세요.');
    }
  }
}
async function searchAlbums() {
  trackController?.abort(); const controller = trackController = new AbortController(); let hasAlbums = false;
  clearTrackResults('앨범 폴더를 찾고 있어요. 결과가 도착하면 바로 표시합니다.');
  $('track-search-status').textContent = '앨범 검색 중…';
  try {
    const response = await fetch(`/api/rooms/${roomId}/albums?${new URLSearchParams({ q: $('track-search').value })}`, {
      signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
    const data = await readTrackSearchResponse(response, { signal: controller.signal, onProgress: data => {
      if (trackController !== controller) return;
      if (data.albums?.length) { hasAlbums = true; renderAlbums(data.albums); }
      $('track-search-status').textContent = data.albums?.length ? `${data.albums.length}개 공유본 도착 · 추가 검색 중…` : '가수·앨범명으로 공유 폴더를 찾는 중…';
    } });
    if (trackController !== controller) return;
    renderAlbums(data.albums || []);
    $('track-search-status').textContent = data.albums?.length ? `${data.albums.length}개 앨범 공유본 · 곡 목록을 확인하거나 앨범을 예약하세요.` : '일치하는 앨범 폴더가 없어요. 앨범명이나 가수·앨범명으로 다시 검색해주세요.';
  } catch (error) {
    if (error.name !== 'AbortError' && trackController === controller) {
      $('track-search-status').textContent = error.message;
      if (!hasAlbums) clearTrackResults('앨범 검색을 완료하지 못했습니다. 다시 시도해주세요.');
    }
  }
}
function renderAlbums(albums) {
  const ids = new Set(albums.map(album => album.id));
  for (const [id, card] of albumCards) if (!ids.has(id) && !card.contains(document.activeElement)) { card.remove(); albumCards.delete(id); }
  if (albums.length) $('track-results').querySelector(':scope > p')?.remove();
  else if (!albumCards.size) clearTrackResults('검색된 앨범이 없어요. 가수·앨범명을 입력해주세요.');
  for (const [index, album] of albums.entries()) {
    let card = albumCards.get(album.id);
    if (!card) {
      card = textElement('div', '', 'quiz-option album-option');
      const title = textElement('strong', album.title), detail = textElement('small', '', 'album-detail');
      const note = textElement('small', '검색에 응답한 폴더의 곡 목록입니다. 전체 수록곡과 다를 수 있어요.');
      const actions = textElement('div', '', 'result-actions'), list = document.createElement('div'); list.className = 'album-tracks'; list.hidden = true;
      const show = textElement('button', '곡 목록', 'secondary'); show.type = 'button';
      let loading = false;
      show.onclick = async () => {
        if (loading) return; loading = true; show.textContent = '목록 불러오는 중…';
        try {
          const response = await fetch(`/api/rooms/${roomId}/albums?${new URLSearchParams({ album: album.id })}`, { signal: trackController?.signal });
          const data = await readApiResponse(response); list.replaceChildren();
          for (const [i, track] of data.hits.entries()) {
            const row = textElement('div', '', 'album-track');
            row.append(textElement('span', `${i + 1}. ${track.title}`));
            row.append(textElement('small', `${track.bitDepth || '?'}bit / ${track.sampleRate ? track.sampleRate / 1000 : '?'}kHz · ${(track.size / 1024 / 1024).toFixed(1)}MB`));
            const buttons = textElement('div', '', 'result-actions');
            for (const [label, type] of [['듣기', 'listen'], ['예약', 'queueAdd']]) {
              const button = textElement('button', label, 'quiet'); button.type = 'button'; button.disabled = !joined || Boolean(state?.preparing);
              button.onclick = () => { losslessPlayer.enable(); send({ type, kind: 'listen', trackId: track.id, playbackMode: playbackMode() }); };
              buttons.append(button);
            }
            row.append(buttons); list.append(row);
          }
          list.hidden = false;
        } catch (error) { if (error.name !== 'AbortError') notify(error.message); }
        finally { loading = false; show.textContent = list.hidden ? '곡 목록' : '곡 목록 새로고침'; }
      };
      const reserve = textElement('button', '앨범 예약', 'secondary'); reserve.type = 'button';
      reserve.onclick = () => { losslessPlayer.enable(); send({ type: 'queueAlbum', albumId: album.id, playbackMode: playbackMode() }); };
      actions.append(show, reserve); card.append(title, detail, note, actions, list); albumCards.set(album.id, card); $('track-results').append(card);
    }
    card.querySelector('.album-detail').textContent = `공유본 ${index + 1} · 검색된 ${album.trackCount}곡${album.truncated ? ` / ${album.totalFound}곡 중 표시` : ''} · ${(album.size / 1024 / 1024).toFixed(1)}MB · ${album.freeSlot ? '전송 슬롯 있음' : '전송 대기'}`;
    for (const button of card.querySelectorAll('button')) button.disabled = !joined || Boolean(state?.preparing);
  }
  let next = null;
  for (const album of [...albums].reverse()) {
    const card = albumCards.get(album.id);
    if (card.nextSibling !== next && !card.contains(document.activeElement)) $('track-results').insertBefore(card, next);
    next = card;
  }
}
function showMusicIdentity(identity) {
  $('track-identity').hidden = !identity;
  $('track-identity').textContent = identity ? `검색할 곡: ${identity.artist} · ${identity.title}` : '';
}
function clearTrackResults(message) {
  showMusicIdentity();
  trackCards.clear();
  albumCards.clear();
  $('track-results').replaceChildren();
  if (message) $('track-results').append(textElement('p', message, 'small'));
}
function renderTrackResults(hits, source = {}) {
  const ids = new Set(hits.map(track => track.id));
  for (const [id, card] of trackCards) if (!ids.has(id) && !card.contains(document.activeElement)) { card.remove(); trackCards.delete(id); }
  if (hits.length) $('track-results').querySelector(':scope > p')?.remove();
  else if (!trackCards.size) clearTrackResults('일치하는 FLAC이 없어요. 가수와 곡 제목으로 직접 검색해보세요.');
  for (const track of hits) {
    const label = track.matchLabel || track.relatedLabel;
    const detail = (label ? label + ' · ' : '') + (track.relatedArtist ? track.relatedArtist + ' · ' : '') + (track.freeSlot ? '전송 슬롯 있음' : '대기 ' + track.queueLength + '개');
    const existing = trackCards.get(track.id);
    if (existing) { existing.querySelector('.track-detail').textContent = detail; continue; }
    const card = textElement('div', '', 'quiz-option');
    const quality = (track.bitDepth || '?') + 'bit / ' + (track.sampleRate ? track.sampleRate / 1000 : '?') + 'kHz · ' + (track.size / 1024 / 1024).toFixed(1) + 'MB';
    card.append(textElement('strong', track.title), textElement('small', 'FLAC · ' + quality), textElement('small', detail, 'track-detail'));
    const actions = textElement('div', '', 'result-actions');
    for (const [label, queued] of [['지금 듣기', false], ['다음 곡 예약', true]]) {
      const button = textElement('button', label, 'secondary'); button.type = 'button'; button.disabled = !joined || Boolean(state?.preparing);
      button.onclick = () => { trackController?.abort(); $('track-search-status').textContent = ''; losslessPlayer.enable(); send(queued ? { type: 'queueAdd', kind: 'listen', trackId: track.id, playbackMode: playbackMode(), ...source } : { type: 'listen', trackId: track.id, playbackMode: playbackMode(), ...source }); };
      actions.append(button);
    }
    card.append(actions); trackCards.set(track.id, card); $('track-results').append(card);
  }
  // Reorder surrounding cards instead of moving the focused card itself.
  // Later exact-title responses can then rise to the top without losing focus.
  let next = null;
  for (const track of [...hits].reverse()) {
    const card = trackCards.get(track.id);
    if (card.nextSibling !== next && !card.contains(document.activeElement)) $('track-results').insertBefore(card, next);
    next = card;
  }
}
function updateFlacButton() {
  $('current-flac').hidden = state?.phase !== 'watch';
  $('current-flac').disabled = !joined || Boolean(state?.preparing);
  $('current-flac').textContent = state?.pendingAudio ? state.pendingAudio.status === 'retrying' ? '다른 공유자 찾는 중 · 전환 취소' : `FLAC 전환 취소 · ${state.pendingAudio.percent}%` : matchController ? 'FLAC 검색 취소' : 'FLAC으로 듣기';
}
async function findFlac(video, action, source = {}) {
  $('track-search-kind').value = 'tracks'; updateSearchKind();
  trackController?.abort(); trackController = new AbortController();
  const controller = trackController; matchController = controller; matchingAction = action; matchingSource = source.sourceRoundId ? source : null;
  selectMode('listen'); updateFlacButton();
  clearTrackResults('유튜브 곡의 가수·제목으로 Soulseek FLAC을 찾는 중…');
  $('track-search-status').textContent = '곡명·가수·버전을 비교하고 있어요.';
  let requested = false;
  const requestMatched = data => {
    if (requested || !data.matchedId || !data.playableMatch || !joined || controller.signal.aborted) return false;
    losslessPlayer.enable();
    requested = send(action === 'queue' ? { type: 'queueAdd', kind: 'listen', trackId: data.matchedId, playbackMode: playbackMode(), ...source } : { type: 'listen', trackId: data.matchedId, playbackMode: playbackMode(), ...source });
    if (requested) {
      $('track-search-status').textContent = action === 'queue' ? '일치하는 FLAC을 예약했습니다.' : '일치하는 FLAC 준비 중 · 영상은 전환 전까지 계속 재생됩니다.';
      if (action !== 'queue') notify('FLAC을 준비하고 있습니다. 준비되면 전환합니다.');
      controller.abort();
    }
    return requested;
  };
  try {
    const params = new URLSearchParams({ video: video.id });
    if (video.title) params.set('title', video.title);
    if (source.sourceRoundId) { params.set('current', '1'); params.set('round', source.sourceRoundId); }
    const response = await fetch('/api/rooms/' + roomId + '/tracks?' + params, {
      signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
    const display = data => {
      if (data.query && document.activeElement !== $('track-search')) $('track-search').value = data.identity ? `${data.identity.artist} - ${data.identity.title}` : data.query;
      showMusicIdentity(data.identity);
      if (data.stage === 'identity') $('track-search-status').textContent = '영상의 가수·곡명을 확인하는 중…';
      if (data.hits.length) renderTrackResults(data.hits, source);
      requestMatched(data);
    };
    const data = await readTrackSearchResponse(response, { signal: controller.signal, onProgress: display });
    if (controller.signal.aborted) return;
    display(data); if (requested) return;
    renderTrackResults(data.hits, source);
    $('track-search-status').textContent = `${data.hits.length}개 후보 검색 완료`;
    if (!requested) notify(data.hits.length ? '바로 재생할 일치 후보를 확인하지 못했어요. 곡·버전과 대기열을 확인하고 직접 선택해주세요.' : '일치하는 FLAC을 찾지 못했어요. Soulseek에 접속 중인 공유자가 없을 수도 있습니다. 가수나 검색어를 바꿔보세요.');
  } catch (error) { if (error.name !== 'AbortError' && trackController === controller) $('track-search-status').textContent = error.message; }
  finally { if (matchController === controller) { matchController = null; matchingAction = null; matchingSource = null; updateFlacButton(); } }
}
$('current-flac').onclick = () => {
  if (state?.pendingAudio) { if (send({ type: 'cancelFlac' })) $('track-search-status').textContent = 'FLAC 전환을 취소했습니다.'; return; }
  if (matchController) { matchController.abort(); $('track-search-status').textContent = 'FLAC 검색을 취소했습니다.'; return; }
  if (state?.phase === 'watch' && state.video) {
    const details = playerReady ? player.getVideoData?.() : null;
    void findFlac({ ...state.video, title: details?.title || state.title }, 'play', { sourceRoundId: state.roundId, sourceVideoId: state.video.id });
  }
};
$('join-form').onsubmit = event => { event.preventDefault(); connect(); };
$('search-form').onsubmit = event => { event.preventDefault(); searchQuizzes(); };
$('youtube-search-form').onsubmit = event => { event.preventDefault(); searchYouTube(); };
$('track-search-form').onsubmit = event => { event.preventDefault(); searchTracks(); };
$('next-track').onclick = () => send({ type: 'next', phase: state?.phase, roundId: state?.roundId });
$('queue-clear').onclick = () => { if (matchingAction === 'queue') matchController?.abort(); send({ type: 'queueClear' }); };
$('audio-enable').onclick = () => $('audio-enable').dataset.enabled === 'true' ? losslessPlayer.mute() : losslessPlayer.enable();
$('audio-volume').oninput = () => losslessPlayer.setVolume(Number($('audio-volume').value));
$('seek-form').onsubmit = event => { event.preventDefault(); send({ type: state?.phase === 'listen' ? 'audioSeek' : 'watchSeek', seconds: Number($('seek-seconds').value), roundId: state?.roundId, phase: state?.phase }); };
$('sync-watch').onclick = () => { if (state?.phase === 'listen') { losslessPlayer.sync(); notify('방의 재생 위치에 맞췄어요.'); return; } if (!playerReady || !state?.video) return; player.seekTo(videoPosition(), true); if (!state.paused) player.playVideo(); notify('방의 재생 위치에 맞췄어요.'); };
$('answer-form').onsubmit = event => {
  event.preventDefault();
  const content = $('answer').value.trim();
  if (content && send({ type: 'answer', content, roundId: state?.roundId })) {
    $('answer').value = '';
    if (!$('answer').disabled) $('answer').focus({ preventScroll: true });
  }
};
function control(type) {
  if (type === 'pause') {
    if (!state || pendingPause) return;
    const paused = !state.paused;
    if (!send({ type, paused, roundId: state.roundId, phase: state.phase })) return;
    pendingPause = { paused, roundId: state.roundId, revision, at: now(), timer: setTimeout(() => {
      clearPendingPause(); notify('재생 제어 응답이 지연되고 있어요. 연결 상태를 확인하고 다시 눌러주세요.'); if (state) applyState(state);
    }, 5000) };
    $('pause').disabled = true; $('pause').textContent = paused ? '정지 반영 중…' : '재개 반영 중…';
    if (paused) { if (playerReady) player.pauseVideo(); losslessPlayer.update(localPlaybackState(state)); }
    return;
  }
  if (type === 'stop') { clearPendingPause(); youtubeController?.abort(); trackController?.abort(); matchController?.abort(); }
  if (send({ type, roundId: state?.roundId, phase: state?.phase }) && ['skip', 'fullplay', 'stop'].includes(type)) { player?.mute(); playerReady && player.pauseVideo(); }
  if (type === 'stop') losslessPlayer.pause();
}
for (const [id, type] of [['skip', 'skip'], ['pause', 'pause'], ['fullplay', 'fullplay'], ['stop', 'stop']]) $(id).onclick = () => control(type);
$('video-sound').onclick = () => {
  if (!playerReady || !state?.video) return;
  if (browserAudioAllowed()) videoSoundEnabled = videoAutoplayBlocked || player.isMuted();
  videoAutoplayBlocked = false;
  browserAudioAllowed() && videoSoundEnabled ? player.unMute() : player.mute();
  updateSoundButton();
  const video = state.video;
  player.seekTo(video.startSeconds + Math.max(0, ((state.paused ? video.pausedAt : now()) - video.startedAt) / 1000), true);
  if (!state.paused) player.playVideo();
};
$('share').onclick = async () => { const url = requireDiscordIdentity ? discordChannelUrl : `${location.origin}/r/${roomId}`; try { await navigator.clipboard.writeText(url); notify(requireDiscordIdentity ? '입장 안내가 있는 채팅 주소를 복사했어요. 친구도 그 채팅의 웹방 입장 버튼으로 참가하세요.' : '참가 링크를 복사했어요. 친구에게 보내주세요.'); } catch { notify(url); } };
window.addEventListener('keydown', event => {
  if (!event.ctrlKey || event.altKey || event.metaKey || event.code !== 'KeyE') return;
  event.preventDefault();
  if (event.repeat || $('skip').disabled) return;
  control('skip');
}, { capture: true });
setInterval(() => { if (!document.hidden) updateTimer(); }, 250); setInterval(() => { syncVideo(); if (joined && state?.phase === 'listen') losslessPlayer.update(localPlaybackState(state)); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { connection.wake(); syncVideo(); updateTimer(); } });
window.addEventListener('online', () => connection.wake());
window.addEventListener('offline', () => connection.wake());
window.addEventListener('pagehide', () => { player?.mute(); losslessPlayer.pause(); connection.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted && roomId) connect(); });
if (roomId) {
  $('intro').hidden = true; $('join-card').hidden = false; $('nickname').value = storageGet('entity-nickname');
  fetch(`/api/rooms/${roomId}`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' }).then(async response => {
    const data = await readApiResponse(response);
    $('room-voice').textContent = `${data.voiceName} · 퀴즈·음악·유튜브를 함께 즐기는 방`;
    requireDiscordIdentity = Boolean(data.requireDiscordIdentity); updateEntryChannel(data.discordChannelUrl || '');
    $('join-form').hidden = requireDiscordIdentity;
    $('discord-join').hidden = !requireDiscordIdentity;
    if (requireDiscordIdentity) {
      $('share').textContent = '참가 안내 복사 ↗';
      $('discord-join-hint').textContent = joinToken ? '디스코드 닉네임으로 참가하고 있습니다…' : '봇을 호출한 디스코드 채팅의 「웹방 입장」 버튼이나 /웹방으로 참가하세요. 이름은 자동으로 적용됩니다.';
    }
    losslessConfigured = Boolean(data.losslessConfigured);
    if (!losslessConfigured) $('lossless-hint').textContent = '먼저 PC의 엔티티 폴더에서 「무손실음악 설정.cmd」를 실행해주세요.';
    if (requireDiscordIdentity ? joinToken : $('nickname').value.trim()) connect();
  }).catch(error => {
    const message = error.name === 'TimeoutError' ? '서버 응답이 지연됩니다. 잠시 후 새로 고치거나 디스코드에서 다시 입장해주세요.' : error.message;
    $('connection').textContent = '방 연결 확인 실패'; $('connection').className = 'connection offline';
    notify(message); $('join-form').querySelector('button').disabled = true;
    $('discord-join').hidden = false; $('discord-join-hint').textContent = message;
  });
} else { $('connection').textContent = '디스코드에서 퀴즈 시작'; }
