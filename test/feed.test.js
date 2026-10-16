import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PriceFeed } from '../src/binance/feed.js';
import { activityText } from '../src/binance/status.js';

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { this.sent.push(JSON.parse(data)); }
  terminate() { this.readyState = 3; this.emit('close'); }
  trade(symbol, price, time) {
    this.emit('message', Buffer.from(JSON.stringify({ stream: `${symbol.toLowerCase()}@aggTrade`, data: { e: 'aggTrade', s: symbol, p: price, T: time } })));
  }
}
FakeSocket.instances = [];

test('market 경로에서 체결가를 받고 종목 변경을 구독한다', () => {
  FakeSocket.instances = [];
  const feed = new PriceFeed({ WebSocketImpl: FakeSocket });
  feed.setSymbols(['BTCUSDT']);
  const socket = FakeSocket.instances[0];
  assert.match(socket.url, /^wss:\/\/fstream\.binance\.com\/market\/stream\?streams=btcusdt@aggTrade$/);
  socket.open();
  feed.setSymbols(['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(socket.sent[0].params, ['ethusdt@aggTrade']);
  const now = Date.now();
  socket.trade('BTCUSDT', '101.5', now);
  assert.deepEqual(feed.prices.get('BTCUSDT'), { price: '101.5', time: now, source: 'trade' });
  assert.match(activityText(feed, 'BTCUSDT', now), /101\.5 USDT/);
  feed.setSymbols(['ETHUSDT']);
  assert.equal(feed.prices.has('BTCUSDT'), false);
  assert.equal(socket.sent[1].method, 'UNSUBSCRIBE');
  feed.disconnect();
});

test('연결이 끊기거나 오래된 값은 실시간으로 표시하지 않는다', () => {
  const feed = new PriceFeed({ WebSocketImpl: FakeSocket });
  feed.connected = true;
  feed.prices.set('BTCUSDT', { price: '10', time: 100000, source: 'trade' });
  assert.match(activityText(feed, 'BTCUSDT', 131000), /시세 지연/);
  feed.connected = false;
  assert.match(activityText(feed, 'BTCUSDT', 101000), /연결 중/);
  feed.disconnect();
});
