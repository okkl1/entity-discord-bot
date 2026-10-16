import test from 'node:test';
import assert from 'node:assert/strict';
import { readTrackSearchResponse } from '../src/web/public/track-search-response.js';

const response = text => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(text);
  // Every byte is separate, including the three bytes of a Korean syllable.
  for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
  controller.close();
} }), { headers: { 'Content-Type': 'application/x-ndjson' } });

test('streamed search decodes split Korean text and publishes choices before completion', async () => {
  const hits = [{ id: 'first', title: '아이유 좋은 날' }], progress = [];
  const data = await readTrackSearchResponse(response(JSON.stringify({ type: 'progress', hits }) + '\n' + JSON.stringify({ type: 'done', hits }) + '\n'), { onProgress: data => progress.push(data.hits) });
  assert.deepEqual(progress, [hits]); assert.deepEqual(data.hits, hits);
});

test('search stream reports a service error or truncated connection instead of accepting incomplete results', async () => {
  await assert.rejects(readTrackSearchResponse(response('{"type":"error","error":"로그인 실패"}\n')), /로그인 실패/);
  await assert.rejects(readTrackSearchResponse(response('{"type":"progress","hits":[]}\n')), /연결이 끊겼/);
  await assert.rejects(readTrackSearchResponse(response('{broken}\n')), /연결이 끊겼/);
  await assert.rejects(readTrackSearchResponse(response('{"type":"done"}\n')), /결과를 읽지/);
});

test('JSON compatibility and HTML proxy errors retain readable messages', async () => {
  assert.deepEqual(await readTrackSearchResponse(new Response('{"hits":[]}')), { hits: [] });
  await assert.rejects(readTrackSearchResponse(new Response('<!DOCTYPE html><html>unavailable</html>', { status: 502 })), /웹방 연결/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readTrackSearchResponse(response('{"type":"done","hits":[]}\n'), { signal: controller.signal }), { name: 'AbortError' });
});
