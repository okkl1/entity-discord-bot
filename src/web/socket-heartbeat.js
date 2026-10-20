export function touchSocket(ws, time = performance.now()) { ws.lastSeenAt = time; }

export function heartbeatSocket(ws, time = performance.now()) {
  if (ws.readyState !== 1) return;
  // A single delayed pong must not eject every participant during a CPU burst.
  if (time - ws.lastSeenAt >= 90_000) {
    ws.disconnectCause = 'heartbeat-timeout'; ws.terminate(); return;
  }
  ws.ping();
}
