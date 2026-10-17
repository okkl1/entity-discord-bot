import { WorkLimiter } from './work-limiter.js';
import { resources } from './resource-profile.js';
import { trackMemoryProcess } from './runtime-memory.js';

export const extractionSlots = new WorkLimiter(resources.compact ? 1 : 2);
export const transcodeSlots = new WorkLimiter(resources.compact ? 2 : Infinity);
export async function acquireTranscode(options) {
  const release = await transcodeSlots.acquire(options);
  try { options?.signal?.throwIfAborted(); return release; }
  catch (error) { release(); throw error; }
}
export async function runExtraction(start, options) {
  const release = await extractionSlots.acquire(options);
  let child;
  try {
    options?.signal?.throwIfAborted();
    const pending = start();
    if (Number.isSafeInteger(pending.child?.pid)) {
      child = trackMediaProcess('ytdlp', pending.child);
      child.once('close', release);
    }
    return await pending;
  } finally {
    // AbortError can precede process exit. Keep the slot until the real child
    // closes so cancellation cannot briefly launch two Python/JS runtimes.
    if (!child) release();
  }
}
export const audioInputOptions = () => resources.compact ? ['-threads', '1', '-filter_threads', '1'] : [];
export const opusOutputOptions = () => ['-vn', '-ar', '48000', '-ac', '2', '-c:a', 'libopus',
  '-b:a', '96k', '-frame_duration', '20', '-application', 'audio',
  ...(resources.compact ? ['-threads', '1'] : []), '-f', 'ogg', '-page_duration', '20000', 'pipe:1'];
export function trackMediaProcess(name, child, release) {
  const remove = trackMemoryProcess(name, child.pid);
  child.once('close', remove);
  if (release) child.once('close', release);
  return child;
}
