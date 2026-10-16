// Send a commit Enter once the IME's final input has reached the field.
export function protectComposition(form, { defer = setTimeout, cancel = clearTimeout } = {}) {
  let composing = false, ending = false, release, pending;
  const finish = () => {
    cancel(release);
    release = defer(() => {
      ending = false;
      const submission = pending;
      pending = undefined;
      if (!submission || composing || form.isConnected === false ||
          submission.target?.disabled || submission.submitter?.disabled) return;
      // requestSubmit preserves validation and the application's submit handler.
      if (submission.submitter) form.requestSubmit(submission.submitter);
      else form.requestSubmit();
    }, 0);
  };
  form.addEventListener('compositionstart', () => {
    cancel(release); pending = undefined; composing = true; ending = false;
  });
  form.addEventListener('compositionend', () => {
    composing = false; ending = true;
    // Some browsers report compositionend before the Enter keydown/submit.
    finish();
  });
  form.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.code !== 'Enter' && event.code !== 'NumpadEnter') return;
    if (event.repeat) { event.preventDefault(); return; }
    if (!composing && !ending && !pending && !event.isComposing && event.keyCode !== 229) return;
    event.preventDefault();
    pending = { target: event.target };
    // Otherwise compositionend schedules this after the character commits.
    if (!composing) { ending = true; finish(); }
  }, { capture: true });
  form.addEventListener('submit', event => {
    if (!composing && !ending && !pending) return;
    event.preventDefault(); event.stopImmediatePropagation();
    // Retain an explicit button click made while the IME is committing.
    if (event.submitter && !pending) {
      pending = { submitter: event.submitter };
      if (!composing) finish();
    }
  }, { capture: true });
}
