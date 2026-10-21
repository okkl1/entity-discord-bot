import { EventEmitter } from 'node:events';
export const RELEASE = '2026-10-21-v5.9';

export function resourceSettings(env = process.env) {
  const compact = env.ENTITY_MEMORY_PROFILE === 'compact';
  return { compact, searchCacheTracks: compact ? 8000 : 50_000, searchCacheEntries: compact ? 20 : 60,
    clipCacheBytes: (compact ? 4 : 16) * 1024 * 1024, clipConcurrency: compact ? 1 : 2, quizLookahead: compact ? 1 : 2 };
}
export const resources = resourceSettings();
const pressure = new EventEmitter(); pressure.setMaxListeners(0);
export function onMemoryPressure(callback) { pressure.on('pressure', callback); return () => pressure.off('pressure', callback); }
let backgroundPausedUntil = 0;
let memorySample;
export function updateResourceMemory(value) { memorySample = value ? { ...value, at: Date.now() } : null; }
export function memoryWorkAllowed(reserveBytes = 64 * 1024 ** 2) {
  if (!resources.compact || !memorySample || Date.now() - memorySample.at > 30_000) return true;
  return memorySample.limit - memorySample.working >= reserveBytes;
}
export const backgroundWorkAllowed = () => Date.now() >= backgroundPausedUntil && memoryWorkAllowed(96 * 1024 ** 2);
export function releaseIdleMemory(detail = {}) { backgroundPausedUntil = Date.now() + 30_000; pressure.emit('pressure', detail); }
