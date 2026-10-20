// One transport and one retry per page. No playback commands are replayed.
export function createRoomConnection({ url, join, checkRoom, onSocket = () => {}, onMessage = () => {},
  onStatus = () => {}, onDisconnect = () => {}, WebSocketImpl = globalThis.WebSocket,
  online = () => true, now = Date.now, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let socket = null, enabled = false, joined = false, probing = false, generation = 0, attempts = 0;
  let retryTimer, joinTimer, pingTimer, probeTimer, probeController, lastMessage = 0;
  const status = (type, extra = {}) => onStatus({ type, attempts, ...extra });
  function clearTransport() {
    generation++;
    for (const timer of [retryTimer, joinTimer, pingTimer, probeTimer]) clearTimer(timer);
    retryTimer = joinTimer = pingTimer = probeTimer = undefined;
    probeController?.abort(); probeController = null; probing = false;
    const old = socket; socket = null; joined = false; onSocket(null);
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch {}
    }
  }
  function finish(type, detail = {}) {
    enabled = false; clearTransport(); onDisconnect(detail); status(type, detail);
  }
  function retry(detail = {}) {
    if (!enabled) return;
    clearTransport(); onDisconnect(detail);
    if (!online()) { status('offline'); return; }
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4)) + Math.floor(random() * 500);
    attempts = Math.min(attempts + 1, 1000);
    status('retrying', { ...detail, delay });
    retryTimer = setTimer(() => { void begin(true); }, delay);
  }
  function pulse(ws, token) {
    if (token !== generation || socket !== ws || !joined) return;
    if (now() - lastMessage > 60_000) { retry({ reason: 'response-timeout' }); return; }
    try { ws.send(JSON.stringify({ type: 'ping', sentAt: now() })); }
    catch { retry({ reason: 'send-failed' }); return; }
    pingTimer = setTimer(() => pulse(ws, token), 10_000);
  }
  async function begin(recheck) {
    if (!enabled) return;
    clearTransport();
    if (!online()) { status('offline'); return; }
    const token = generation;
    status('connecting');
    if (recheck && checkRoom) {
      probing = true;
      probeController = new AbortController();
      probeTimer = setTimer(() => probeController?.abort(), 8000);
      let result;
      try { result = await checkRoom({ signal: probeController.signal }); }
      catch { if (token === generation) retry({ reason: 'server-unavailable' }); return; }
      if (token !== generation || !enabled) return;
      clearTimer(probeTimer); probeTimer = undefined; probeController = null; probing = false;
      if (result === 404) { finish('missing'); return; }
      if (result !== 200) { retry({ reason: 'server-unavailable' }); return; }
    }
    let ws;
    try { ws = new WebSocketImpl(typeof url === 'function' ? url() : url); }
    catch { retry({ reason: 'connect-failed' }); return; }
    socket = ws; onSocket(ws);
    joinTimer = setTimer(() => { if (token === generation) retry({ reason: 'connect-timeout' }); }, 20_000);
    ws.onopen = () => {
      if (token !== generation) return;
      try { ws.send(JSON.stringify({ type: 'join', ...join() })); }
      catch { retry({ reason: 'join-failed' }); }
    };
    ws.onmessage = event => {
      if (token !== generation) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { retry({ reason: 'invalid-response' }); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      lastMessage = now();
      if (msg.type === 'joined' && !joined) {
        clearTimer(joinTimer); joinTimer = undefined;
        joined = true; attempts = 0; status('connected'); pulse(ws, token);
      }
      onMessage(msg, ws);
    };
    ws.onclose = event => {
      if (token !== generation) return;
      const detail = { code: event.code };
      if (event.code === 1000 && event.reason === 'Reconnected') finish('replaced', detail);
      else if (event.code === 1008 && event.reason !== 'Join required') finish('expired', detail);
      else retry(detail);
    };
    // Browsers normally follow error with close; the join/response deadline also
    // covers proxies which leave the socket stuck in CONNECTING or OPEN.
    ws.onerror = () => {};
  }
  return {
    connect() { enabled = true; attempts = 0; onDisconnect({ reason: 'connecting' }); void begin(false); },
    stop() { enabled = false; clearTransport(); onDisconnect({ reason: 'stopped' }); },
    wake() {
      if (!enabled) return;
      if (!online()) { clearTransport(); onDisconnect({ reason: 'offline' }); status('offline'); return; }
      if (!socket && !probing) { void begin(true); return; }
      if (joined && now() - lastMessage > 60_000) retry({ reason: 'response-timeout' });
    }
  };
}
