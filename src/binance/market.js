const API = 'https://fapi.binance.com';
const EXCHANGE_INFO_TTL = 60 * 60 * 1000;
let symbolCache;
let symbolCacheAt = 0;

export function normalizeSymbol(value) {
  const symbol = String(value ?? '').trim().toUpperCase().replace(/[\s/_-]/g, '');
  if (!/^[A-Z0-9]{2,25}$/.test(symbol)) throw new Error('종목 형식이 올바르지 않습니다. 예: BTCUSDT');
  return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
}

export function parseSymbols(value, limit = 5) {
  const items = String(value ?? '').split(/[,\s]+/).filter(Boolean).map(normalizeSymbol);
  const symbols = [...new Set(items)];
  if (!symbols.length) throw new Error('종목을 입력하세요. 예: BTCUSDT,ETHUSDT');
  if (symbols.length > limit) throw new Error(`한 채널에서 최대 ${limit}개 종목을 볼 수 있습니다.`);
  return symbols;
}

async function getJson(path, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, { signal: AbortSignal.timeout(8000) });
  } catch (error) {
    throw new Error(`바이낸스 연결에 실패했습니다: ${error.message}`);
  }
  if (response.status === 451) throw new Error('바이낸스가 이 서버의 접속을 제한했습니다 (HTTP 451). 배포 지역과 Binance 이용 가능 여부를 확인해주세요.');
  if (!response.ok) throw new Error(`바이낸스가 HTTP ${response.status} 오류를 반환했습니다.`);
  return response.json();
}

export async function getTradableSymbols(fetchImpl = fetch) {
  if (fetchImpl === fetch && symbolCache && Date.now() - symbolCacheAt < EXCHANGE_INFO_TTL) return symbolCache;
  const data = await getJson('/fapi/v1/exchangeInfo', fetchImpl);
  if (!Array.isArray(data.symbols)) throw new Error('바이낸스 종목 정보 형식이 올바르지 않습니다.');
  const symbols = new Set(data.symbols.filter(item =>
    item.status === 'TRADING' && item.contractType === 'PERPETUAL' && item.quoteAsset === 'USDT'
  ).map(item => item.symbol));
  if (fetchImpl === fetch) {
    symbolCache = symbols;
    symbolCacheAt = Date.now();
  }
  return symbols;
}

export async function validateSymbols(symbols, fetchImpl = fetch) {
  const valid = await getTradableSymbols(fetchImpl);
  const invalid = symbols.filter(symbol => !valid.has(symbol));
  if (invalid.length) throw new Error(`USDT-M 무기한 선물 종목이 아닙니다: ${invalid.join(', ')}`);
}

export async function getPrice(symbol, fetchImpl = fetch) {
  const data = await getJson(`/fapi/v2/ticker/price?symbol=${encodeURIComponent(symbol)}`, fetchImpl);
  if (data.symbol !== symbol || !isPositivePrice(data.price) || !Number.isFinite(Number(data.time))) {
    throw new Error('바이낸스 가격 응답 형식이 올바르지 않습니다.');
  }
  return { symbol, price: data.price, time: Number(data.time) };
}

export function isPositivePrice(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
}

export function formatPrice(value) {
  if (!isPositivePrice(value)) return '—';
  const [integer, decimal = ''] = value.split('.');
  const left = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const right = decimal.replace(/0+$/, '');
  return right ? `${left}.${right}` : left;
}
