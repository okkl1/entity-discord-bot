import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, getPrice, normalizeSymbol, parseSymbols, validateSymbols } from '../src/binance/market.js';

test('종목 입력을 정리하고 중복 및 개수 제한을 적용한다', () => {
  assert.equal(normalizeSymbol('btc/usdt'), 'BTCUSDT');
  assert.deepEqual(parseSymbols('BTC, ethusdt BTCUSDT'), ['BTCUSDT', 'ETHUSDT']);
  assert.throws(() => parseSymbols(''), /종목을 입력/);
  assert.throws(() => parseSymbols('AA,BB,CC,DD,EE,FF'), /최대 5개/);
});

test('USDT-M 무기한 거래 가능 종목만 허용한다', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'ETHUSDT', status: 'BREAK', contractType: 'PERPETUAL', quoteAsset: 'USDT' },
    { symbol: 'XUSDT', status: 'TRADING', contractType: 'CURRENT_QUARTER', quoteAsset: 'USDT' }
  ] }) });
  await validateSymbols(['BTCUSDT'], fakeFetch);
  await assert.rejects(validateSymbols(['ETHUSDT'], fakeFetch), /무기한 선물/);
  await assert.rejects(validateSymbols(['XUSDT'], fakeFetch), /무기한 선물/);
});

test('가격 응답을 검사하고 정확한 소수점 문자열을 표시한다', async () => {
  const fakeFetch = async url => {
    assert.match(url, /symbol=BTCUSDT/);
    return { ok: true, json: async () => ({ symbol: 'BTCUSDT', price: '101234.5000', time: 1700000000000 }) };
  };
  assert.deepEqual(await getPrice('BTCUSDT', fakeFetch), { symbol: 'BTCUSDT', price: '101234.5000', time: 1700000000000 });
  assert.equal(formatPrice('101234.5000'), '101,234.5');
  assert.equal(formatPrice('0.00001230'), '0.0000123');
});
