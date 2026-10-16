import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { isPositivePrice } from './market.js';

const STREAM_URL = 'wss://fstream.binance.com/market/stream';

export class PriceFeed extends EventEmitter {
  constructor({ WebSocketImpl = WebSocket, reconnectDelay = 1000 } = {}) {
    super();
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectDelay = reconnectDelay;
    this.symbols = new Set();
    this.prices = new Map();
    this.socket = null;
    this.timer = null;
    this.generation = 0;
    this.connected = false;
  }

  setSymbols(symbols) {
    const next = new Set(symbols);
    const added = [...next].filter(symbol => !this.symbols.has(symbol));
    const removed = [...this.symbols].filter(symbol => !next.has(symbol));
    if (!added.length && !removed.length) return;
    this.symbols = next;
    for (const symbol of removed) this.prices.delete(symbol);
    if (!next.size) {
      this.disconnect();
    } else if (this.socket?.readyState === this.WebSocketImpl.OPEN) {
      if (added.length) this.send('SUBSCRIBE', added);
      if (removed.length) this.send('UNSUBSCRIBE', removed);
    } else if (!this.socket && !this.timer) {
      this.connect();
    }
    this.emit('change');
  }

  streamNames(symbols) {
    return symbols.map(symbol => `${symbol.toLowerCase()}@aggTrade`);
  }

  send(method, symbols) {
    if (!symbols.length || this.socket?.readyState !== this.WebSocketImpl.OPEN) return;
    this.socket.send(JSON.stringify({ method, params: this.streamNames(symbols), id: Date.now() }));
  }

  connect() {
    if (!this.symbols.size || this.socket) return;
    clearTimeout(this.timer);
    this.timer = null;
    const generation = ++this.generation;
    const startingSymbols = [...this.symbols];
    const url = `${STREAM_URL}?streams=${this.streamNames(startingSymbols).join('/')}`;
    let socket;
    try {
      socket = new this.WebSocketImpl(url);
    } catch (error) {
      this.emit('warning', error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (generation !== this.generation) return;
      this.connected = true;
      this.reconnectDelay = 1000;
      const addedWhileConnecting = [...this.symbols].filter(symbol => !startingSymbols.includes(symbol));
      const removedWhileConnecting = startingSymbols.filter(symbol => !this.symbols.has(symbol));
      this.send('SUBSCRIBE', addedWhileConnecting);
      this.send('UNSUBSCRIBE', removedWhileConnecting);
      this.emit('change');
    });
    socket.on('message', raw => {
      if (generation !== this.generation) return;
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      const trade = payload.data ?? payload;
      if (trade.e !== 'aggTrade' || !this.symbols.has(trade.s) || !isPositivePrice(trade.p)) return;
      const time = Number(trade.T ?? trade.E);
      if (!Number.isFinite(time) || time <= 0) return;
      this.prices.set(trade.s, { price: trade.p, time, source: 'trade' });
      this.emit('change');
    });
    socket.on('error', error => this.emit('warning', error));
    socket.on('close', () => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.connected = false;
      this.emit('change');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (!this.symbols.size || this.timer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    this.timer.unref?.();
  }

  seed(snapshot) {
    if (!this.symbols.has(snapshot.symbol)) return;
    const previous = this.prices.get(snapshot.symbol);
    if (!previous || snapshot.time > previous.time) {
      this.prices.set(snapshot.symbol, { price: snapshot.price, time: snapshot.time, source: 'snapshot' });
      this.emit('change');
    }
  }

  disconnect() {
    clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== this.WebSocketImpl.CLOSED) socket.terminate();
    this.emit('change');
  }
}
