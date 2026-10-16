import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ActivityType } from 'discord.js';
import { formatPrice, getPrice, normalizeSymbol } from './market.js';

const STALE_AFTER_MS = 30_000;

export function activityText(feed, symbol, now = Date.now()) {
  const quote = feed.prices.get(symbol);
  if (!quote) return `${symbol} 시세 연결 중`;
  if (now - quote.time >= STALE_AFTER_MS || now - quote.time < -STALE_AFTER_MS) return `${symbol} 시세 지연`;
  if (quote.source === 'trade' && !feed.connected) return `${symbol} 시세 연결 중`;
  const suffix = quote.source === 'snapshot' ? ' 조회값' : '';
  return `${symbol} ${formatPrice(quote.price)} USDT${suffix}`;
}

export class PriceStatus {
  constructor({ client, feed, statePath, initialSymbol = 'BTCUSDT', getPriceImpl = getPrice,
    updateIntervalMs = 10_000 }) {
    this.client = client;
    this.feed = feed;
    this.statePath = statePath;
    this.initialSymbol = normalizeSymbol(initialSymbol);
    this.getPriceImpl = getPriceImpl;
    this.updateIntervalMs = updateIntervalMs;
    this.symbol = this.initialSymbol;
    this.lastText = '';
    this.lastUpdate = 0;
    this.timer = null;
    this.onChange = () => this.sync();
  }

  async start() {
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (saved?.symbol) this.symbol = normalizeSymbol(saved.symbol);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('저장된 종목을 읽지 못했습니다:', error.message);
    }
    this.feed.on('change', this.onChange);
    this.feed.setSymbols([this.symbol]);
    this.sync(true);
    this.seed(this.symbol);
    this.timer = setInterval(() => this.sync(), 2000);
    this.timer.unref?.();
  }

  async setSymbol(symbol) {
    const next = normalizeSymbol(symbol);
    if (next === this.symbol) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify({ symbol: next }, null, 2), 'utf8');
    await rename(temp, this.statePath);
    this.symbol = next;
    this.feed.setSymbols([next]);
    this.sync(true);
    this.seed(next);
  }

  seed(symbol) {
    this.getPriceImpl(symbol).then(quote => {
      if (this.symbol !== symbol) return;
      this.feed.seed(quote);
      this.sync(true);
    }).catch(error => console.warn(`${symbol} 최초 가격 조회 실패:`, error.message));
  }

  sync(force = false) {
    if (!this.client.user) return;
    const now = Date.now();
    if (!force && now - this.lastUpdate < this.updateIntervalMs) return;
    const value = activityText(this.feed, this.symbol, now);
    if (!force && value === this.lastText) return;
    this.client.user.setActivity(value, { type: ActivityType.Watching });
    this.lastText = value;
    this.lastUpdate = now;
  }

  close() {
    clearInterval(this.timer);
    this.feed.off('change', this.onChange);
    this.feed.disconnect();
  }
}
