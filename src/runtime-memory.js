import { readFile } from 'node:fs/promises';
import { releaseIdleMemory } from './resource-profile.js';
const children = new Map();
export function trackMemoryProcess(name, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return () => {};
  const token = { name, pid }; children.set(token, token);
  return () => children.delete(token);
}

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
      const childMemory = await Promise.all([...children.values()].map(async ({ name, pid }) => {
        const status = await read(`/proc/${pid}/status`, 'utf8').catch(() => '');
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1];
        return rss ? ` ${name}RSS=${Math.round(Number(rss) / 1024)}MiB` : '';
      }));
      if (closed) return;
      log(`[memory] nodeRSS=${mb(node.rss)}MiB heap=${mb(node.heapUsed)}MiB` + (value
        ? ` container=${mb(value.used)}/${mb(value.limit)}MiB working=${mb(value.working)}MiB fileCache=${mb(value.inactiveFile)}MiB oomKills=${value.oomKills}` : ' container=unavailable') + childMemory.join(''));
      if (value && value.working >= value.limit * 0.85) { releaseIdleMemory(); log('[memory] pressure: released idle caches'); }
    } finally { running = false; }
  };
  void sample().catch(() => {});
  const timer = setInterval(() => { void sample().catch(() => {}); }, intervalMs); timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
