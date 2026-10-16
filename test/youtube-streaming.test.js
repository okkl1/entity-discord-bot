import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
let child, callback;
mock.module('node:child_process', { namedExports: { execFile: (file, args, options, done) => {
  callback = done; child = { stdout: new PassThrough() }; return child;
} } });
const { createYouTubeSearch } = await import('../src/web/youtube-search.js');

test('default subprocess reader publishes a UTF-8 video before its exit callback', async () => {
  const search = createYouTubeSearch({ configuredPath: process.execPath });
  const progress = []; let completed = false;
  const pending = search('한국어 노래', { onProgress: hits => progress.push(hits) }).then(hits => { completed = true; return hits; });
  const line = JSON.stringify({ id: 'M7lc1UVf-VE', title: '노래 제목' }) + '\n';
  const bytes = Buffer.from(line), split = bytes.indexOf(Buffer.from('노')) + 1;
  child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split));
  assert.equal(progress.length, 1); assert.equal(progress[0][0].title, '노래 제목');
  assert.equal(completed, false);
  callback(null, line);
  assert.equal((await pending).length, 1); assert.equal(progress.length, 1);
});
