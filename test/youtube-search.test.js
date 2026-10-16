import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeSearch, parseYouTubeInput } from '../src/web/youtube-search.js';

test('cancelling one shared metadata lookup preserves the other caller, and cancels the process when all callers leave', async () => {
  let finish, currentSignal;
  const search = createYouTubeSearch({ execute: (file, args, { signal }) => new Promise((resolve, reject) => {
    currentSignal = signal; finish = () => resolve({ stdout: JSON.stringify({ entries: [] }) });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const a = new AbortController(), b = new AbortController();
  const first = search('shared', { signal: a.signal }), second = search('shared', { signal: b.signal });
  a.abort(); await assert.rejects(first, { name: 'AbortError' }); assert.equal(currentSignal.aborted, false);
  finish(); assert.deepEqual(await second, []);
  const cancel = new AbortController(), pending = search('other', { signal: cancel.signal });
  cancel.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(currentSignal.aborted, true);
});

test('YouTube inputs accept official video links and timestamps, reject foreign URLs', () => {
  assert.deepEqual(parseYouTubeInput('https://youtu.be/M7lc1UVf-VE?t=1h2m3s'), { id: 'M7lc1UVf-VE', seconds: 3723 });
  assert.deepEqual(parseYouTubeInput('https://www.youtube.com/watch?v=M7lc1UVf-VE&start=45'), { id: 'M7lc1UVf-VE', seconds: 45 });
  assert.deepEqual(parseYouTubeInput('https://m.youtube.com/shorts/M7lc1UVf-VE'), { id: 'M7lc1UVf-VE', seconds: 0 });
  assert.equal(parseYouTubeInput('https://youtube.com.evil.example/watch?v=M7lc1UVf-VE'), null);
  assert.equal(parseYouTubeInput('file:///M7lc1UVf-VE'), null);
  assert.equal(parseYouTubeInput('https://youtu.be/invalid'), null);
});

test('metadata extraction enables Node and explains server bot verification without leaking stderr', async () => {
  const search = createYouTubeSearch({ execute: async (_, args) => {
    const runtimeIndex = args.indexOf('--js-runtimes');
    assert.ok(runtimeIndex >= 0);
    assert.equal(args[runtimeIndex + 1], `node:${process.execPath}`);
    throw Object.assign(new Error('private command'), { stderr: 'Sign in to confirm you’re not a bot. private diagnostics' });
  } });
  await assert.rejects(search('example'), error => {
    assert.equal(error.code, 'YOUTUBE_AUTH_REQUIRED');
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});
test('metadata search uses argument arrays, bounded subprocess, safe public fields and cache', async () => {
  let calls = 0, time = 0;
  const search = createYouTubeSearch({ now: () => time, execute: async (file, args, options) => {
    calls++; assert.ok(file); assert.ok(args.includes('--skip-download')); assert.ok(args.includes('--flat-playlist'));
    assert.equal(args.at(-1), 'ytsearch8:test;echo secret'); assert.equal(options.timeout, 20_000); assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    return { stdout: JSON.stringify({ entries: [{ id: 'M7lc1UVf-VE', title: '<script>title</script>', duration: 90, channel: 'Google', privateField: 'secret' }, { id: '../../bad', title: 'bad' }, { id: 'abcdefghijk', availability: 'private' }] }) };
  } });
  const result = await search('test;echo secret');
  assert.equal(result.length, 1); assert.equal(result[0].duration, 90); assert.equal(result[0].privateField, undefined);
  await search('test;echo secret'); assert.equal(calls, 1);
  time = 300_001; await search('test;echo secret'); assert.equal(calls, 2);
  const direct = await search('https://youtu.be/M7lc1UVf-VE?t=20'); assert.equal(direct[0].startSeconds, 20); assert.equal(calls, 2);
});
test('search shares in-flight work, limits concurrent subprocesses and recovers from errors', async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const search = createYouTubeSearch({ execute: async () => { calls++; await pending; throw new Error('private diagnostics'); } });
  const one = search('one'), duplicate = search('one'), two = search('two');
  const rejects = [one, duplicate, two].map(task => assert.rejects(task, /검색에 실패/));
  await assert.rejects(search('three'), /처리 중/);
  assert.equal((await search('https://youtu.be/M7lc1UVf-VE'))[0].id, 'M7lc1UVf-VE');
  release(); await Promise.all(rejects); assert.equal(calls, 2);
  await assert.rejects(search('one'), /검색에 실패/); assert.equal(calls, 3);
});
test('a direct video gets bounded metadata only when FLAC matching needs its real song title', async () => {
  let calls = 0;
  const search = createYouTubeSearch({ execute: async (_, args) => {
    calls++; assert.ok(args.includes('--skip-download')); assert.ok(args.includes('--no-playlist'));
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
    return { stdout: JSON.stringify({ id: 'M7lc1UVf-VE', title: 'Artist - Song', artist: 'Artist', track: 'Song', duration: 200, formats: ['private'] }) };
  } });
  await search('https://youtu.be/M7lc1UVf-VE'); assert.equal(calls, 0);
  const result = await search('https://youtu.be/M7lc1UVf-VE', { metadata: true }); assert.equal(result[0].track, 'Song'); assert.equal(result[0].formats, undefined);
  await search('https://youtu.be/M7lc1UVf-VE', { metadata: true }); assert.equal(calls, 1);
});
