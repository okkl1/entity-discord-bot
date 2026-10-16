import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createSoulseekSearchEvents } from '../src/web/soulseek-search-events.js';
import { SoulseekClient } from '../src/web/soulseek-client.js';

const rs = '\x1e';
async function fixture(handshake = '{}') {
  const requests = [], sockets = [], server = createServer(), wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    requests.push({ url: request.url, key: request.headers['x-api-key'] });
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    sockets.push(ws);
    ws.on('message', value => {
      if (!String(value).includes('"protocol"')) return;
      assert.deepEqual(JSON.parse(String(value).split(rs)[0]), { protocol: 'json', version: 1 });
      if (handshake !== null) ws.send(handshake + rs + JSON.stringify({ type: 1, target: 'LIST', arguments: [[]] }) + rs);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests, sockets,
    send(id, response) { for (const ws of sockets) ws.send(JSON.stringify({ type: 1, target: 'RESPONSE', arguments: [{ searchId: id, response }] }) + rs); },
    async close() { for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}

test('live search events authenticate, reuse one connection and route split/coalesced SignalR frames by search id', async () => {
  const f = await fixture(), events = createSoulseekSearchEvents({ baseUrl: f.baseUrl, apiKey: 'test-key' });
  const a = [], b = []; let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  try {
    const unA = await events.subscribe('a', value => a.push(value));
    const unB = await events.subscribe('b', value => { b.push(value); arrived(); });
    assert.equal(typeof unA, 'function'); assert.equal(typeof unB, 'function'); assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.requests, [{ url: '/hub/search', key: 'test-key' }]);
    const one = JSON.stringify({ type: 1, target: 'RESPONSE', arguments: [{ searchId: 'a', response: { username: 'peer-a' } }] });
    const two = JSON.stringify({ type: 1, target: 'RESPONSE', arguments: [{ searchId: 'b', response: { username: 'peer-b' } }] });
    f.sockets[0].send(one.slice(0, 20)); f.sockets[0].send(one.slice(20) + rs + two + rs);
    await received; assert.equal(a[0].username, 'peer-a'); assert.equal(b[0].username, 'peer-b');
    unA(); unB(); f.send('a', { username: 'ignored' });
    await new Promise(setImmediate); assert.equal(a.length, 1);
  } finally { events.close(); await f.close(); }
});

test('a rejected or unresponsive event handshake yields a bounded REST fallback', async () => {
  for (const handshake of ['{"error":"denied"}', null]) {
    const f = await fixture(handshake), events = createSoulseekSearchEvents({ baseUrl: f.baseUrl, apiKey: 'test-key', connectMs: 30 });
    try { assert.equal(await events.subscribe('a', () => {}), null); }
    finally { events.close(); await f.close(); }
  }
});

test('an ended hub connection reconnects on the next search', async () => {
  const f = await fixture(), events = createSoulseekSearchEvents({ baseUrl: f.baseUrl, apiKey: 'test-key' });
  try {
    (await events.subscribe('a', () => {}))();
    const closed = once(f.sockets[0], 'close'); f.sockets[0].close(); await closed; await new Promise(setImmediate);
    assert.equal(typeof await events.subscribe('b', () => {}), 'function'); assert.equal(f.sockets.length, 2);
  } finally { events.close(); await f.close(); }
});

test('the Soulseek client returns real websocket responses without waiting for persisted REST files', async () => {
  const f = await fixture(); let responseReads = 0;
  const client = new SoulseekClient({ baseUrl: f.baseUrl, apiKey: 'test-key', searchMs: 1000, minSearchMs: 30, settleMs: 10, pollMs: 10,
    fetchImpl: async (url, options) => {
      let value = { endedAt: 'now' };
      if (url.endsWith('/server')) value = { isLoggedIn: true };
      if (url.endsWith('/searches') && options.method === 'POST') {
        const id = JSON.parse(options.body).id;
        f.send(id, { username: 'peer', hasFreeUploadSlot: true, files: Array.from({ length: 10 }, (_, i) => ({ filename: `Song ${i}.flac`, size: 1000 })) });
      }
      if (url.endsWith('/responses')) { responseReads++; value = []; }
      return new Response(JSON.stringify(value));
    } });
  try {
    assert.equal((await client.search('song')).length, 10); assert.equal(responseReads, 0); assert.equal(f.requests.length, 1);
  } finally { await Promise.allSettled([...client.cleanups]); client.close(); await f.close(); }
});
