// Play the original FLAC bytes. Synchronization seeks; it never changes speed.
export function createLosslessPlayer(audio, { now = Date.now, onNotice = () => {}, onStatus = () => {}, onEnded = () => {} } = {}) {
  let state, key = '', enabled = false, blocked = false, startTimer, alignPending = false, initialAlign = false, hasPlayed = false, alignTolerance = 0.25, lastSeekAt = -Infinity, playRequest, holdingBuffer = false;
  const position = () => !state?.audio?.startedAt ? 0 : state.audio.startSeconds + Math.max(0,
    ((state.paused ? state.audio.pausedAt : now()) - state.audio.startedAt) / 1000);
  const status = () => onStatus({ enabled, blocked, buffering: Boolean(key && (holdingBuffer || audio.readyState < 3 || !state.audio.startedAt || state.buffering)) });
  const bufferedAt = (target, seconds = 3) => {
    for (let i = 0; i < audio.buffered.length; i++) {
      const duration = state.audio.duration || (Number.isFinite(audio.duration) && audio.duration) || Infinity;
      if (target >= audio.buffered.start(i) && audio.buffered.end(i) >= target + Math.min(seconds, Math.max(0, duration - target))) return true;
    }
    return false;
  };
  const play = () => {
    if (playRequest || blocked) return;
    const playingKey = key;
    const request = audio.play().then(() => { if (key !== playingKey || !enabled) return; hasPlayed = true; blocked = false; status(); }).catch(error => {
      if (error.name === 'AbortError' || key !== playingKey || !enabled) return;
      blocked = true; status();
    });
    playRequest = request;
    void request.finally(() => { if (playRequest === request) playRequest = null; });
  };
  const sync = (force = false) => {
    clearTimeout(startTimer);
    if (!key || !state.audio.startedAt || state.paused || !enabled) { audio.pause(); status(); return; }
    const until = state.audio.startedAt - now();
    if (until > 0) { audio.pause(); startTimer = setTimeout(() => sync(force), Math.min(until, 2000)); return; }
    if (force) { alignPending = true; initialAlign = false; alignTolerance = 0.25; }
    const target = position(), drift = Math.abs(audio.currentTime - target);
    // Progress updates and canplay after starvation must not repeatedly seek
    // into bytes that have not arrived. Explicit room seeks still apply once.
    const autoAlign = audio.readyState >= 3 && drift > 4 && now() - lastSeekAt >= 10_000 && bufferedAt(target);
    // An initial seek on metadata alone can make FLAC browsers request the
    // undownloaded tail. Let the first playable bytes arrive before aligning.
    const canAlign = alignPending && (!initialAlign || (audio.readyState >= 3 && bufferedAt(target, 2)));
    if (!audio.seeking && audio.readyState >= 1 && (canAlign || autoAlign)) {
      if (drift > (alignPending ? alignTolerance : 0.25)) {
        try { audio.currentTime = target; lastSeekAt = now(); } catch {}
      }
      alignPending = false;
    }
    // After starvation, wait for a useful browser buffer instead of resuming
    // for a few frames at a time while the server receives the original FLAC.
    if (audio.paused || holdingBuffer) {
      // The server already reserves a useful head start. Requiring eight
      // browser seconds before the first play can deadlock paused preloading.
      holdingBuffer = audio.readyState < 3 || !bufferedAt(audio.currentTime, hasPlayed ? 4 : 2);
      if (holdingBuffer) { audio.pause(); status(); return; }
    }
    if (audio.paused) play();
    status();
  };
  audio.addEventListener('canplay', () => sync());
  audio.addEventListener('loadeddata', () => sync());
  audio.addEventListener('waiting', () => {
    if (key && enabled && !state.paused) { holdingBuffer = true; audio.pause(); }
    status();
  });
  audio.addEventListener('progress', () => sync());
  audio.addEventListener('seeked', () => sync());
  audio.addEventListener('playing', () => { hasPlayed = true; status(); });
  audio.addEventListener('ended', () => { if (key && !state.paused) onEnded({ roundId: state.roundId, phase: 'listen' }); });
  audio.addEventListener('error', () => { if (key) { blocked = true; status(); onNotice('음원을 재생하지 못했습니다. FLAC를 지원하는 최신 브라우저에서 다시 참가해주세요.'); } });
  return {
    update(next) {
      if (next.audio && state?.audio && (next.audio.startedAt !== state.audio.startedAt || next.audio.startSeconds !== state.audio.startSeconds)) {
        alignPending = true; alignTolerance = next.audio.startSeconds !== state.audio.startSeconds ? 0.25 : 1;
        initialAlign = !state.audio.startedAt && next.audio.startSeconds === state.audio.startSeconds;
      }
      state = next;
      const nextKey = next.phase === 'listen' && next.audio ? next.audio.id : '';
      if (nextKey !== key) {
        audio.pause(); blocked = false; key = nextKey; alignPending = Boolean(key); initialAlign = true; hasPlayed = false; alignTolerance = 0.25; lastSeekAt = -Infinity; playRequest = null; holdingBuffer = Boolean(key);
        if (key) { audio.src = next.audio.url; audio.load(); }
        else { audio.removeAttribute('src'); audio.load(); }
      }
      sync();
    },
    enable() {
      enabled = true; blocked = false;
      // Called directly by the user's click so browsers can grant sound access.
      if (key) sync();
      status();
    },
    mute() { enabled = false; audio.pause(); status(); },
    pause() { clearTimeout(startTimer); audio.pause(); },
    sync: () => sync(true), position,
  };
}
