import WebSocket from 'ws';

const separator = '\x1e';

// slskd persists REST response lists only after completion. Its SignalR hub
// supplies each peer's response while the search is still running.
export function createSoulseekSearchEvents({ baseUrl, apiKey, connectMs = 1500 } = {}) {
  const listeners = new Map();
  let socket, opening, ready = false, closed = false, ping;
  function connect() {
    if (closed) return Promise.reject(new Error('Search events closed'));
    if (ready && socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (opening) return opening;
    const target = new URL(`${baseUrl.replace(/\/$/, '')}/hub/search`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(target, { headers: { 'X-API-Key': apiKey }, maxPayload: 8 * 1024 * 1024 });
    socket = current;
    opening = new Promise((resolve, reject) => {
      let buffer = '', settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (error) { reject(error); current.terminate(); }
        else {
          ready = true;
          ping = setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send('{"type":6}' + separator); }, 10_000);
          ping.unref(); resolve();
        }
      };
      const timeout = setTimeout(() => finish(new Error('Search event connection timed out')), connectMs);
      current.on('open', () => current.send(JSON.stringify({ protocol: 'json', version: 1 }) + separator));
      current.on('message', bytes => {
        buffer += bytes.toString();
        if (buffer.length > 8 * 1024 * 1024) { finish(new Error('Search event too large')); current.terminate(); return; }
        let boundary;
        while ((boundary = buffer.indexOf(separator)) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          if (!frame) continue;
          let message;
          try { message = JSON.parse(frame); }
          catch { finish(new Error('Invalid search event')); current.terminate(); return; }
          if (!settled && message.type === undefined) { finish(message.error ? new Error('Search event handshake failed') : null); continue; }
          if (message.type === 7) { finish(new Error('Search event connection ended')); current.terminate(); return; }
          if (message.type === 1 && message.target === 'RESPONSE') {
            const value = message.arguments?.[0];
            if (value?.response && typeof value.searchId === 'string') listeners.get(value.searchId)?.(value.response);
          }
        }
      });
      current.on('error', () => finish(new Error('Search event connection failed')));
      current.on('close', () => {
        finish(new Error('Search event connection closed'));
        if (socket === current) { ready = false; socket = null; clearInterval(ping); }
      });
    }).finally(() => { opening = null; });
    return opening;
  }
  return {
    async subscribe(id, listener) {
      listeners.set(id, listener);
      try { await connect(); }
      catch { if (listeners.get(id) === listener) listeners.delete(id); return null; }
      return () => { if (listeners.get(id) === listener) listeners.delete(id); };
    },
    close() { closed = true; ready = false; listeners.clear(); clearInterval(ping); socket?.terminate(); },
  };
}
