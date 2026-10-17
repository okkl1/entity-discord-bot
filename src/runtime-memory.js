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
export function cpuSample(stat, maximum, previous, timeMs) {
  const usage = Number(/^usage_usec (\d+)/m.exec(String(stat))?.[1]);
  const throttled = Number(/^nr_throttled (\d+)/m.exec(String(stat))?.[1]);
  const [quota, period] = String(maximum).trim().split(/\s+/).map(Number);
  const cores = quota > 0 && period > 0 ? quota / period : null;
  if (!Number.isFinite(usage)) return null;
  const sample = { usage, throttled, timeMs, cores };
  if (previous && timeMs > previous.timeMs && usage >= previous.usage) {
    sample.corePercent = 100 * (usage - previous.usage) / ((timeMs - previous.timeMs) * 1000);
    sample.quotaPercent = cores ? sample.corePercent / cores : null;
    sample.throttledPeriods = Math.max(0, throttled - previous.throttled) || 0;
  }
  return sample;
}
export function startMemoryMonitor({ intervalMs = 15_000, log = console.log, read = readFile, memory = process.memoryUsage } = {}) {
  let closed = false, running = false, previousCpu;
  const sample = async () => {
    if (closed || running) return; running = true;
    try {
      const values = await Promise.all(['memory.current', 'memory.max', 'memory.stat', 'memory.events', 'cpu.stat', 'cpu.max']
        .map(file => read(`/sys/fs/cgroup/${file}`, 'utf8').catch(() => '')));
      if (closed) return;
      const value = containerMemory(...values), mb = bytes => Math.round(bytes / 1024 / 1024);
      const node = memory();
      const cpu = cpuSample(values[4], values[5], previousCpu, performance.now()); previousCpu = cpu;
      const childMemory = await Promise.all([...children.values()].map(async ({ name, pid }) => {
        const status = await read(`/proc/${pid}/status`, 'utf8').catch(() => '');
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(status)?.[1];
        return rss ? ` ${name}RSS=${Math.round(Number(rss) / 1024)}MiB` : '';
      }));
      if (closed) return;
      log(`[memory] nodeRSS=${mb(node.rss)}MiB heap=${mb(node.heapUsed)}MiB` + (value
        ? ` container=${mb(value.used)}/${mb(value.limit)}MiB working=${mb(value.working)}MiB fileCache=${mb(value.inactiveFile)}MiB oomKills=${value.oomKills}` : ' container=unavailable') + childMemory.join('') + (cpu?.quotaPercent != null ? ` cpuQuota=${Math.round(cpu.quotaPercent)}% throttledPeriods=${cpu.throttledPeriods}` : ''));
      if (value && value.working >= value.limit * 0.85) { releaseIdleMemory(); log('[memory] pressure: released idle caches'); }
    } finally { running = false; }
  };
  void sample().catch(() => {});
  const timer = setInterval(() => { void sample().catch(() => {}); }, intervalMs); timer.unref();
  return () => { closed = true; clearInterval(timer); };
}
