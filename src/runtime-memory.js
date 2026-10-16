import { readFile } from 'node:fs/promises';
import { releaseIdleMemory } from './resource-profile.js';

export function containerMemory(current, maximum, stat = '', events = '') {
  const used = Number(String(current).trim()), limit = Number(String(maximum).trim());
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) return null;
  const number = (text, key) => Number(new RegExp(`(?:^|\\n)${key} (\\d+)`).exec(text)?.[1] || 0);
  const inactive = Math.min(used, number(stat, 'inactive_file'));
  return { used, limit, working: used - inactive, inactiveFile: inactive, oomKills: number(events, 'oom_kill') };
}
export function startMemoryMonitor({ intervalMs = 60_000, log = console.log, read = readFile, memory = process.memoryUsage } = {}) {
  let closed = false, running = false;
  const sample = async () => {
    if (closed || running) return; running = true;
    try {
      const values = await Promise.all(['memory.current', 'memory.max', 'memory.stat', 'memory.events']
        .map(file => read(`/sys/fs/cgroup/${file}`, 'utf8').catch(() => '')));
      if (closed) return;
      const value = containerMemory(...values), mb = bytes => Math.round(bytes / 1024 / 1024);
      const node = memory();
      log(`[memory] nodeRSS=${mb(node.rss)}MiB heap=${mb(node.heapUsed)}MiB` + (value
        ? ` container=${mb(value.used)}/${mb(value.limit)}MiB working=${mb(value.working)}MiB fileCache=${mb(value.inactiveFile)}MiB oomKills=${value.oomKills}` : ' container=unavailable'));
      if (value && value.working >= value.limit * 0.85) { releaseIdleMemory(); log('[memory] pressure: released idle caches'); }
    } finally { running = false; }
  };
  void sample().catch(() => {});
  const timer = setInterval(() => { void sample().catch(() => {}); }, intervalMs); timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
