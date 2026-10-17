import { EventEmitter } from 'node:events';
export const RELEASE = '2026-10-17-v5.6';

export function resourceSettings(env = process.env) {
  const compact = env.ENTITY_MEMORY_PROFILE === 'compact';
  return { compact, searchCacheTracks: compact ? 8000 : 50_000, searchCacheEntries: compact ? 20 : 60,
    clipCacheBytes: (compact ? 4 : 16) * 1024 * 1024, clipConcurrency: compact ? 1 : 2, quizLookahead: compact ? 1 : 2 };
}
export const resources = resourceSettings();
const pressure = new EventEmitter(); pressure.setMaxListeners(0);
export function onMemoryPressure(callback) { pressure.on('pressure', callback); return () => pressure.off('pressure', callback); }
let backgroundPausedUntil = 0;
export const backgroundWorkAllowed = () => Date.now() >= backgroundPausedUntil;
export function releaseIdleMemory() { backgroundPausedUntil = Date.now() + 30_000; pressure.emit('pressure'); }
