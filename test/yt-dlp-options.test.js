import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ytDlpOptions, youtubeFailure } from '../src/machugi/yt-dlp-options.js';

test('enables the running Node executable for yt-dlp without a shell', () => {
  const options = ytDlpOptions({ env: {}, nodePath: 'C:/Program Files/nodejs/node.exe' });
  assert.deepEqual(options, ['--ignore-config', '--js-runtimes', 'node:C:/Program Files/nodejs/node.exe']);
});

test('read-only mounted cookies use a private writable runtime copy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'entity-cookie-test-'));
  const source = join(directory, 'mounted.txt');
  const sample = '# Netscape HTTP Cookie File\n';
  try {
    writeFileSync(source, sample);
    const options = ytDlpOptions({ env: { YT_DLP_COOKIES_FILE: source } });
    const path = options.at(-1);
    assert.equal(options.at(-2), '--cookies');
    assert.notEqual(path, source);
    assert.equal(readFileSync(path, 'utf8'), sample);
    writeFileSync(path, sample + '# updated\n');
    assert.equal(readFileSync(source, 'utf8'), sample);
    assert.equal(ytDlpOptions({ env: { YT_DLP_COOKIES_FILE: source } }).at(-1), path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('bot verification is distinct from deleted videos, timeouts and cancellations', () => {
  const failure = youtubeFailure({ stderr: 'Sign in to confirm you’re not a bot. secret diagnostics' });
  assert.equal(failure.code, 'YOUTUBE_AUTH_REQUIRED');
  assert.match(failure.message, /YT_DLP_COOKIES_FILE/);
  assert.doesNotMatch(failure.message, /secret diagnostics/);
  assert.equal(youtubeFailure(failure), failure);
  assert.equal(youtubeFailure(new Error('Video unavailable')), null);
  assert.equal(youtubeFailure(new Error('The operation was aborted')), null);
});
