import { readApiResponse } from './api-response.js';

// Keep JSON error handling for proxy/HTML failures and older servers. Stream
// complete records, not network chunks: Korean text can span UTF-8 chunks.
export async function readTrackSearchResponse(response, { signal, onProgress } = {}) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    const data = await readApiResponse(response);
    signal?.throwIfAborted();
    if (!Array.isArray(data.hits)) throw new Error('검색 결과를 읽지 못했습니다. 다시 검색해주세요.');
    return data;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read(); signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) throw new Error('검색 응답이 너무 큽니다. 검색어를 구체적으로 입력해주세요.');
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        let data;
        try { data = JSON.parse(line); } catch { throw new Error('검색 연결이 끊겼습니다. 다시 검색해주세요.'); }
        if (data?.type === 'error') throw new Error(typeof data.error === 'string' ? data.error : '검색하지 못했습니다. 다시 시도해주세요.');
        if (!['progress', 'done'].includes(data?.type) || !Array.isArray(data.hits)) throw new Error('검색 결과를 읽지 못했습니다. 다시 검색해주세요.');
        if (data.type === 'done') return data;
        onProgress?.(data);
      }
      if (done) throw new Error('검색 연결이 끊겼습니다. 다시 검색해주세요.');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
