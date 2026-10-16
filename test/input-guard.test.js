import test from 'node:test';
import assert from 'node:assert/strict';
import { protectComposition } from '../src/web/public/input-guard.js';

function fixture() {
  const handlers = new Map(), timers = new Map(); let id = 0;
  const form = {
    value: '함께 듣는 노래', sent: [], isConnected: true, valid: true, validations: 0,
    addEventListener(type, handler) { handlers.set(type, handler); },
    requestSubmit(submitter) { this.validations++; if (this.valid) emit('submit', { submitter }); },
  };
  const input = { disabled: false, form };
  protectComposition(form, { defer(fn) { timers.set(++id, fn); return id; }, cancel(key) { timers.delete(key); } });
  const emit = (type, fields = {}) => {
    const event = { target: input, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields };
    handlers.get(type)?.(event);
    if (type === 'submit' && !event.stopped) { form.sent.push(form.value); form.value = ''; }
    return event;
  };
  return { form, input, emit, flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('one Korean commit Enter sends the final text once without clearing it early', () => {
  const f = fixture(); f.emit('compositionstart');
  f.form.value = '함께 듣는 노ㄹ';
  assert.equal(f.emit('keydown', { key: 'Enter', isComposing: true }).prevented, true);
  assert.equal(f.emit('submit').stopped, true);
  assert.equal(f.form.value, '함께 듣는 노ㄹ');
  f.emit('compositionend');
  assert.equal(f.emit('submit').stopped, true);
  assert.deepEqual(f.form.sent, []);
  f.form.value = '함께 듣는 노래'; f.flush(); f.flush();
  assert.deepEqual(f.form.sent, ['함께 듣는 노래']); assert.equal(f.form.value, '');
});

test('compositionend-before-keydown sends once after the final input', () => {
  const f = fixture(); f.emit('compositionstart'); f.emit('compositionend');
  assert.equal(f.emit('keydown', { key: 'Enter', isComposing: false }).prevented, true);
  assert.equal(f.emit('submit').stopped, true);
  f.form.value = '엔티티'; f.flush(); assert.deepEqual(f.form.sent, ['엔티티']);
});

test('a stale IME keyCode 229 and numpad Enter defer a single submission', () => {
  for (const fields of [{ key: 'Enter', keyCode: 229 }, { code: 'NumpadEnter', keyCode: 229 }]) {
    const f = fixture(); assert.equal(f.emit('keydown', fields).prevented, true);
    assert.deepEqual(f.form.sent, []); f.flush();
    assert.deepEqual(f.form.sent, ['함께 듣는 노래']);
  }
});

test('composition ending without Enter never sends an answer', () => {
  const f = fixture(); f.emit('compositionstart'); f.emit('compositionend'); f.flush();
  assert.deepEqual(f.form.sent, []); assert.equal(f.form.value, '함께 듣는 노래');
});

test('space, ordinary typing and Ctrl+E remain available during composition', () => {
  const f = fixture(); f.emit('compositionstart');
  for (const key of [' ', 'a', 'Process', 'e']) assert.equal(f.emit('keydown', { key, code: 'KeyE', ctrlKey: key === 'e', isComposing: true }).prevented, false);
  f.emit('compositionend'); f.emit('compositionstart'); f.flush();
  assert.equal(f.emit('submit').stopped, true, 'a new composition must stay protected');
});

test('starting a new composition cancels an older queued Enter', () => {
  const f = fixture(); f.emit('compositionstart'); f.emit('keydown', { key: 'Enter' });
  f.emit('compositionend'); f.emit('compositionstart'); f.flush();
  f.emit('compositionend'); f.flush(); assert.deepEqual(f.form.sent, []);
});

test('holding Enter does not repeat a queued or completed submission', () => {
  const f = fixture(); f.emit('compositionstart'); f.emit('keydown', { key: 'Enter' });
  assert.equal(f.emit('keydown', { key: 'Enter', repeat: true }).prevented, true);
  f.emit('compositionend'); f.flush();
  assert.equal(f.emit('keydown', { key: 'Enter', repeat: true }).prevented, true);
  assert.deepEqual(f.form.sent, ['함께 듣는 노래']);
});

test('a disabled field or removed form cancels a queued answer', () => {
  for (const disable of [f => { f.input.disabled = true; }, f => { f.form.isConnected = false; }]) {
    const f = fixture(); f.emit('compositionstart'); f.emit('keydown', { key: 'Enter' });
    f.emit('compositionend'); disable(f); f.flush(); assert.deepEqual(f.form.sent, []);
  }
});

test('deferred Enter still performs form validation', () => {
  const f = fixture(); f.form.valid = false;
  f.emit('compositionstart'); f.emit('keydown', { key: 'Enter' }); f.emit('compositionend'); f.flush();
  assert.equal(f.form.validations, 1); assert.deepEqual(f.form.sent, []);
});

test('a submit button used during composition is retained once until commit', () => {
  const f = fixture(), submitter = { disabled: false };
  f.emit('compositionstart'); assert.equal(f.emit('submit', { submitter }).stopped, true);
  f.form.value = '엔티티'; f.emit('compositionend'); f.flush();
  assert.deepEqual(f.form.sent, ['엔티티']);
});

test('completed text and normal submit-button submission are not blocked', () => {
  const f = fixture(); assert.equal(f.emit('keydown', { key: 'Enter' }).prevented, false);
  f.emit('submit'); assert.deepEqual(f.form.sent, ['함께 듣는 노래']);
});
