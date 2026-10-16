import test from 'node:test';
import assert from 'node:assert/strict';
import { createLosslessPlayer } from '../src/web/public/lossless-player.js';

class Audio extends EventTarget {
  paused = true; readyState = 4; currentTime = 0; playbackRate = 1; plays = 0; src = '';
  buffered = { length: 1, start: () => 0, end: () => 1000 }; seeking = false;
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  play() { this.plays++; if (this.playNext) return this.playNext(); this.paused = false; return Promise.resolve(); }
}
const playing = (patch = {}) => ({ phase: 'listen', paused: false, audio: { id: 'one', url: '/original.flac',
  startSeconds: 3, startedAt: 9000, ...patch } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('buffer starvation and repeated canplay events cannot seek beyond downloaded audio', async () => {
  const audio = new Audio(); let clock = 10_000, seeks = 0, value = 0;
  Object.defineProperty(audio, 'currentTime', { get: () => value, set: next => { seeks++; value = next; } });
  const player = createLosslessPlayer(audio, { now: () => clock });
  player.update(playing()); player.enable(); await tick(); assert.equal(seeks, 1);
  audio.buffered = { length: 1, start: () => 0, end: () => 7 };
  clock = 25_000; audio.readyState = 2; audio.dispatchEvent(new Event('waiting'));
  for (let i = 0; i < 10; i++) { player.update(playing()); audio.dispatchEvent(new Event('canplay')); }
  assert.equal(seeks, 1); assert.equal(audio.currentTime, 4);
  audio.readyState = 4; player.update(playing()); assert.equal(seeks, 1, 'future bytes remain unavailable');
  audio.buffered.end = () => 100; player.update(playing()); assert.equal(seeks, 2); assert.equal(audio.currentTime, 19);
  audio.currentTime = 10; const before = seeks; player.update(playing()); assert.equal(seeks, before, 'automatic corrections are spaced out');
  player.sync(); assert.equal(audio.currentTime, 19, 'explicit sync remains available');
  player.update({ phase: 'waiting' });
});

test('native FLAC player aligns to the room clock without changing playback speed and clears source on stop', async () => {
  const audio = new Audio(), player = createLosslessPlayer(audio, { now: () => 10_000 });
  player.update(playing()); assert.equal(audio.paused, true, 'sound requires a user gesture');
  player.enable(); await tick(); assert.equal(audio.paused, false); assert.equal(audio.currentTime, 4);
  assert.equal(audio.playbackRate, 1); assert.equal(audio.src, '/original.flac');
  player.update({ ...playing({ pausedAt: 10_000 }), paused: true }); assert.equal(audio.paused, true);
  player.update({ phase: 'waiting' }); assert.equal(audio.src, ''); assert.equal(audio.paused, true);
});

test('a sound click during initial buffering survives an aborted play request and starts at the shared clock', async () => {
  const audio = new Audio(); let status;
  const player = createLosslessPlayer(audio, { now: () => 10_000, onStatus: value => { status = value; } });
  player.update(playing({ startedAt: null }));
  audio.playNext = () => Promise.reject(new DOMException('Paused while buffering', 'AbortError'));
  player.enable(); await tick(); assert.equal(status.enabled, true); assert.equal(status.blocked, false);
  audio.playNext = null; player.update(playing()); await tick(); assert.equal(audio.paused, false);
});

test('a rejected play for an old track cannot block a new track, and local mute survives shared updates', async () => {
  const audio = new Audio(); let rejectOld, status;
  const player = createLosslessPlayer(audio, { now: () => 10_000, onStatus: value => { status = value; } });
  player.update(playing()); audio.playNext = () => new Promise((_, reject) => { rejectOld = reject; }); player.enable();
  audio.playNext = null; player.update(playing({ id: 'two', url: '/new.flac' })); await tick();
  rejectOld(new DOMException('Old play failed', 'NotAllowedError')); await tick(); assert.equal(status.blocked, false);
  player.mute(); player.update(playing({ id: 'two' })); assert.equal(audio.paused, true); assert.equal(status.enabled, false);
  player.update({ phase: 'waiting' });
});

test('browser autoplay rejection keeps an explicit sound button available', async () => {
  const audio = new Audio(); let status;
  const player = createLosslessPlayer(audio, { now: () => 10_000, onStatus: value => { status = value; } });
  player.update(playing()); audio.playNext = () => Promise.reject(new DOMException('Gesture needed', 'NotAllowedError'));
  player.enable(); await tick(); assert.equal(status.blocked, true);
  audio.playNext = null; player.enable(); await tick(); assert.equal(audio.paused, false); assert.equal(status.blocked, false);
  player.update({ phase: 'waiting' });
});

test('short browser refills do not restart audio until a useful buffer has arrived', async () => {
  const audio = new Audio(); let status;
  const player = createLosslessPlayer(audio, { now: () => 10_000, onStatus: value => { status = value; } });
  player.update(playing()); player.enable(); await tick(); const plays = audio.plays;
  audio.buffered.end = () => 5; audio.readyState = 2; audio.dispatchEvent(new Event('waiting'));
  assert.equal(audio.paused, true);
  audio.readyState = 3; audio.dispatchEvent(new Event('canplay')); await tick();
  assert.equal(audio.plays, plays); assert.equal(status.buffering, true);
  audio.buffered.end = () => 20; audio.dispatchEvent(new Event('progress')); await tick();
  assert.equal(audio.paused, false); assert.equal(status.buffering, false); assert.equal(audio.playbackRate, 1);
  player.update({ phase: 'waiting' });
});

test('small pause-resume timing differences do not insert a seek into the audio', async () => {
  const audio = new Audio(); let clock = 10_000, seeks = 0, value = 0;
  Object.defineProperty(audio, 'currentTime', { get: () => value, set: next => { seeks++; value = next; } });
  const player = createLosslessPlayer(audio, { now: () => clock });
  player.update(playing()); player.enable(); await tick(); assert.equal(seeks, 1);
  player.update({ ...playing({ pausedAt: 10_000 }), paused: true });
  clock = 11_000; value = 4.4; player.update(playing({ startedAt: 10_000 })); await tick();
  assert.equal(seeks, 1); assert.equal(audio.currentTime, 4.4); assert.equal(audio.paused, false);
  player.sync(); assert.equal(seeks, 2); assert.equal(audio.currentTime, 4);
  player.update({ phase: 'waiting' });
});

test('a sound click cannot play early before the shared start or while initial bytes are missing', async () => {
  const audio = new Audio(), player = createLosslessPlayer(audio, { now: () => 10_000 });
  player.update(playing({ startedAt: null })); player.enable(); await tick(); assert.equal(audio.plays, 0);
  audio.readyState = 2; player.update(playing()); await tick(); assert.equal(audio.plays, 0);
  audio.readyState = 4; audio.dispatchEvent(new Event('canplay')); await tick(); assert.equal(audio.plays, 1);
  player.update({ phase: 'waiting' });
});
