import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveYtDlpPath } from '../machugi/yt-dlp-path.js';
import { ytDlpOptions, youtubeFailure } from '../machugi/yt-dlp-options.js';
const run = promisify(execFile);
export function parseYouTubeInput(input) {
  const text = String(input).trim();
  if (/^[\w-]{11}$/.test(text)) return { id: text, seconds: 0 };
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let id;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (['youtube.com', 'youtube-nocookie.com'].includes(host)) id = url.searchParams.get('v') || /^\/(?:shorts|embed|live)\/([\w-]+)/.exec(url.pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id ?? '')) return null;
    const raw = url.searchParams.get('t') || url.searchParams.get('start') || '';
    let seconds = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (/^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(raw)) seconds = Number(/(\d+)h/.exec(raw)?.[1] || 0) * 3600 + Number(/(\d+)m/.exec(raw)?.[1] || 0) * 60 + Number(/(\d+)s/.exec(raw)?.[1] || 0);
    return { id, seconds: Math.min(86400, seconds) };
  } catch { return null; }
}
export function createYouTubeSearch({ execute = run, now = Date.now, configuredPath = process.env.YT_DLP_PATH } = {}) {
  const cache = new Map(), pending = new Map();
  let active = 0;
  const subscribe = (job, signal) => new Promise((resolve, reject) => {
    job.users++; let finished = false;
    const done = (error, value) => {
      if (finished) return; finished = true; signal?.removeEventListener('abort', abort);
      if (--job.users === 0) job.controller.abort();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => done(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    job.promise.then(value => done(null, value), error => done(error));
    if (signal?.aborted) abort();
  });
  return async (input, { metadata = false, signal } = {}) => {
    signal?.throwIfAborted();
    const query = String(input ?? '').trim().slice(0, 120);
    if (!query) throw new Error('검색어 또는 유튜브 주소를 입력해주세요.');
    const direct = parseYouTubeInput(query), key = metadata && direct ? `detail:${direct.id}` : query;
    const saved = cache.get(key);
    if (saved && saved.expires > now()) return saved.results;
    if (pending.has(key) && !pending.get(key).controller.signal.aborted) return subscribe(pending.get(key), signal);
    if (direct && !metadata) return [{ id: direct.id, title: '유튜브 링크 영상', channel: '', duration: null, startSeconds: direct.seconds, thumbnail: `https://i.ytimg.com/vi/${direct.id}/hqdefault.jpg` }];
    if (active >= 2) throw new Error('다른 유튜브 검색을 처리 중입니다. 잠시 후 다시 검색해주세요.');
    const job = { controller: new AbortController(), users: 0 };
    const task = job.promise = (async () => {
      active++;
      try {
        const executable = resolveYtDlpPath(configuredPath, fileURLToPath(new URL('../../bin/yt-dlp.exe', import.meta.url)));
        const { stdout } = await execute(executable, [...ytDlpOptions(), '--skip-download', direct ? '--no-playlist' : '--flat-playlist', '--dump-single-json', '--no-warnings', '--socket-timeout', '10', '--', direct ? `https://www.youtube.com/watch?v=${direct.id}` : `ytsearch8:${query}`], { windowsHide: true, signal: job.controller.signal, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
        job.controller.signal.throwIfAborted();
        const data = JSON.parse(stdout);
        const results = (direct ? [data] : data.entries ?? []).filter(v => /^[\w-]{11}$/.test(v.id) && v.availability !== 'private').slice(0, 8).map(v => ({
          id: v.id, title: String(v.title || '제목 없는 영상').slice(0, 200), channel: String(v.channel || v.uploader || '').slice(0, 100),
          artist: typeof v.artist === 'string' ? v.artist.slice(0, 100) : undefined, track: typeof v.track === 'string' ? v.track.slice(0, 200) : undefined,
          duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null, startSeconds: direct?.seconds || 0, thumbnail: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
        }));
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { results, expires: now() + 5 * 60_000 });
        return results;
      } catch (error) { job.controller.signal.throwIfAborted(); throw youtubeFailure(error) || new Error('유튜브 검색에 실패했습니다. 잠시 후 재시도하거나 영상 주소를 붙여넣어주세요.'); }
      finally { active--; }
    })();
    pending.set(key, job);
    const clear = () => { if (pending.get(key) === job) pending.delete(key); };
    void task.then(clear, clear);
    return subscribe(job, signal);
  };
}
