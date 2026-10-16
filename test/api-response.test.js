import test from 'node:test';
import assert from 'node:assert/strict';
import { readApiResponse } from '../src/web/public/api-response.js';

test('web API responses preserve structured errors and reject invalid shapes', async () => {
  assert.deepEqual(await readApiResponse(new Response('{"hits":[]}')), { hits: [] });
  await assert.rejects(readApiResponse(new Response('{"error":"Soulseek 계정을 확인해주세요."}', { status: 502 })), /Soulseek 계정/);
  for (const body of ['null','[]','"wrong"']) await assert.rejects(readApiResponse(new Response(body)), /웹방 응답/);
});

test('HTML proxy responses display connection guidance instead of JSON syntax or page contents', async () => {
  for (const status of [200, 403, 502, 504]) {
    await assert.rejects(readApiResponse(new Response('<!DOCTYPE html><h1>private proxy details</h1>', { status })), error => {
      assert.match(error.message, /웹방/); assert.doesNotMatch(error.message, /Unexpected|DOCTYPE|private proxy/); return true;
    });
  }
});
