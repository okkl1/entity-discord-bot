import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriceStatus, activityText } from '../src/binance/status.js';

test('활동 상태에 가격을 표시하고 변경 종목을 저장한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'futures-status-test-'));
  const activities = [];
  class FakeFeed extends EventEmitter {
    constructor() { super(); this.prices = new Map(); this.connected = false; }
    setSymbols(symbols) { this.symbols = [...symbols]; this.emit('change'); }
    seed(quote) { this.prices.set(quote.symbol, { ...quote, source: 'snapshot' }); this.emit('change'); }
    disconnect() {}
  }
  const feed = new FakeFeed();
  const status = new PriceStatus({ client: { user: { setActivity: text => activities.push(text) } },
    feed, statePath: join(dir, 'status.json'), initialSymbol: 'BTCUSDT',
    getPriceImpl: async symbol => ({ symbol, price: '123.4000', time: Date.now() }), updateIntervalMs: 10000 });
  try {
    await status.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(activities.at(-1), /BTCUSDT 123\.4 USDT 조회값/);
    await status.setSymbol('ETH');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(feed.symbols, ['ETHUSDT']);
    assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).symbol, 'ETHUSDT');
    assert.match(activities.at(-1), /ETHUSDT 123\.4 USDT 조회값/);
    feed.prices.set('ETHUSDT', { price: '125', time: Date.now(), source: 'trade' });
    feed.connected = true;
    assert.match(activityText(feed, 'ETHUSDT'), /ETHUSDT 125 USDT/);
  } finally {
    status.close();
    await rm(dir, { recursive: true, force: true });
  }
});
