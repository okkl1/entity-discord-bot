// Offline UI preview. No Discord login, saved credentials or external quiz API.
import { EventEmitter } from 'node:events';
import { createQuizWebServer } from './server.js';
import { isCorrect } from '../machugi/answer.js';
import { startPublicTunnel } from './tunnel.js';
import { QuizSession } from '../machugi/quiz-session.js';

const events = new EventEmitter();
const guild = { id: 'preview', members: { fetch: async () => ({ voice: { channelId: 'preview-voice' } }) } };
const voiceChannel = { id: 'preview-voice', name: '미리보기 음악방', guild };
let active, tunnel;
class PreviewSession {
  constructor() { this.voiceChannel = voiceChannel; this.events = new EventEmitter(); this.scores = new Map(); this.state = {}; this.stopped = false; }
  getWebState() { return { ...this.state, scores: [...this.scores.values()] }; }
  publish(patch) { Object.assign(this.state, patch); this.events.emit('state', this.getWebState()); }
  get webState() { return this.state; }
  publishWebState(patch) { this.publish(patch); }
  submitAnswer({ userId, name, content, roundId }) {
    if (roundId !== this.state.roundId || this.state.phase !== 'question' || this.current.paused || this.answered) return { accepted: false };
    const correct = isCorrect(content, ['엔티티']);
    if (correct) { this.answered = true; const old = this.scores.get(userId); this.scores.set(userId, { name, points: (old?.points ?? 0) + 1 }); this.finishQuestion({ reason: 'correct', winnerName: name }); }
    this.events.emit('guess', { name, content, correct, roundId });
    return { accepted: true, correct };
  }
  skipCurrent() { if (this.resolveResult) this.resolveResult('next'); else if (this.resolveFullPlay) this.resolveFullPlay('next'); else this.finishQuestion?.({ reason: 'skipped' }); }
  requestStop() { this.stopped = true; this.skipCurrent(); }
  pause() { if (!this.current) return this.phaseControl?.pause(); if (this.current.paused) return { ok: false }; this.current.paused = true; this.remaining = Math.max(0, this.state.deadlineMs - Date.now()); clearTimeout(this.questionTimer); this.publish({ paused: true, deadlineMs: null, remainingMs: this.remaining }); return { ok: true }; }
  resume() { if (!this.current) return this.phaseControl?.resume(); if (!this.current.paused) return { ok: false }; this.current.paused = false; this.publish({ paused: false, deadlineMs: Date.now() + this.remaining }); this.questionTimer = setTimeout(() => this.finishQuestion({ reason: 'timeout' }), this.remaining); return { ok: true }; }
  async run() {
    events.emit('start', this);
    try {
      for (let index = 1; index <= 3 && !this.stopped; index++) {
        this.current = { paused: false }; this.answered = false;
        this.publish({ phase: 'question', title: '같이 맞히는 엔티티 · 연결 테스트', index, total: 3,
          roundId: `preview:${Date.now()}:${index}`, answer: null, video: null, paused: false, deadlineMs: Date.now() + 25_000 });
        const result = await new Promise(resolve => { this.finishQuestion = resolve; this.questionTimer = setTimeout(() => resolve({ reason: 'timeout' }), 25_000); });
        clearTimeout(this.questionTimer); this.current = null;
        if (this.stopped) break;
        this.publish({ phase: 'reveal', reason: result.reason, winnerName: result.winnerName, answer: '엔티티',
          deadlineMs: Date.now() + 8000, video: { id: 'M7lc1UVf-VE', startSeconds: 0, startedAt: Date.now() } });
        let timer;
        const action = await new Promise(resolve => { this.resolveResult = resolve; timer = QuizSession.prototype.presentationTimer.call(this, 8000, () => resolve('timeout')); timer.start(); });
        timer.cleanup(); this.resolveResult = null;
        if (action === 'fullplay' && !this.stopped) {
          this.publish({ phase: 'fullplay', deadlineMs: null, paused: false, video: { id: 'M7lc1UVf-VE', startSeconds: 0, startedAt: Date.now() } });
          await new Promise(resolve => { this.resolveFullPlay = resolve; timer = QuizSession.prototype.presentationTimer.call(this, 30_000, resolve); timer.start(); });
          timer.cleanup(); this.resolveFullPlay = null;
        }
      }
      this.publish({ phase: 'finished', answer: null, video: null, deadlineMs: null, paused: false });
    } finally { events.emit('end', this); active = null; }
  }
}
const web = createQuizWebServer({ events, requireDiscordIdentity: false, busy: () => Boolean(active),
  videoSearch: async query => [{ id: 'M7lc1UVf-VE', title: `YouTube Developers · ${query}`, channel: 'Google for Developers', duration: 1344, startSeconds: 0, thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg' }],
  search: async () => ({ found: 2, hits: [{ id: 'preview', title: '엔티티 · 연결 테스트', hits: 0 }, { id: 'preview2', title: '친구와 같이 한 판', hits: 0 }] }),
  load: async () => ({ quiz: { title: '연결 테스트' }, questions: [] }),
  launch: async () => { active = new PreviewSession(); await active.run(); },
});
const local = await web.listen({ port: Number(process.env.WEB_PREVIEW_PORT || 3010) });
if (process.argv.includes('--public')) { tunnel = startPublicTunnel(local); web.setPublicUrl(await tunnel.ready); }
const room = web.createRoom({ textChannel: { id: 'preview-text' }, voiceChannel, ownerId: 'preview-owner', title: '미리보기 · 동기화 테스트 방' });
console.log(JSON.stringify({ preview: true, hostUrl: room.hostUrl, shareUrl: room.shareUrl, answer: '엔티티' }));
async function close() { active?.requestStop(); tunnel?.close(); await web.close(); process.exit(0); }
process.once('SIGINT', close); process.once('SIGTERM', close);
