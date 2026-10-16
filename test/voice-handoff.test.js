import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

let currentConnection;
mock.module('@discordjs/voice', { namedExports: {
  AudioPlayerStatus: { Idle: 'idle' }, getVoiceConnection: () => currentConnection,
} });
mock.module('../src/machugi/voice.js', { namedExports: {
  connectToVoice: async () => currentConnection,
  createPlayer: () => Object.assign(new EventEmitter(), { stop() { this.stopped = true; } }),
  playYouTubeClip: async () => {}, prefetchQuizClip: async () => true,
  waitForPlayerIdle: async () => {}, pausePlayer: () => {}, resumePlayer: () => {},
} });
const { QuizSession } = await import('../src/machugi/quiz-session.js');

function fixture() {
  const client = new EventEmitter();
  const session = new QuizSession({ textChannel: { client }, voiceChannel: { id: 'voice', guild: { id: 'guild' } },
    quiz: { title: '퀴즈' }, questions: [], questionTimeMs: 1000, answerRevealMs: 1000 });
  client.on('messageCreate', session.messageHandler);
  const connection = { joinConfig: { channelId: 'voice' }, destroyed: 0, destroy() { this.destroyed++; } };
  currentConnection = connection;
  return { session, connection, client };
}

test('quiz replacement cleans old playback and listeners while leaving the same voice connection intact', () => {
  const { session, connection, client } = fixture();
  let cleaned = 0, unsubscribed = 0;
  const controller = new AbortController();
  session.current = { controller, clip: { cleanup() { cleaned++; } } };
  session.cleanupFns.push(() => { unsubscribed++; });
  session.requestStop({ keepVoiceConnection: true }); session.destroy();
  assert.equal(connection.destroyed, 0);
  assert.equal(currentConnection, connection);
  assert.equal(session.player.stopped, true); assert.equal(controller.signal.aborted, true);
  assert.equal(cleaned, 1); assert.equal(unsubscribed, 1);
  assert.equal(client.listenerCount('messageCreate'), 0);
  session.releaseVoiceConnection();
});

test('normal stop and natural completion still disconnect voice', () => {
  for (const stop of [false, true]) {
    const { session, connection } = fixture();
    if (stop) session.requestStop();
    session.destroy(); assert.equal(connection.destroyed, 1);
  }
});

test('normal stop overrides connection retention while a replacement is being cleaned up', () => {
  const { session, connection } = fixture();
  session.requestStop({ keepVoiceConnection: true }); session.requestStop(); session.destroy();
  assert.equal(connection.destroyed, 1);
});

test('abandoned handoffs release the retained connection once', () => {
  const { session, connection } = fixture();
  session.requestStop({ keepVoiceConnection: true }); session.destroy();
  session.releaseVoiceConnection(); session.releaseVoiceConnection();
  assert.equal(connection.destroyed, 1);
});

test('timed-out handoffs reset retention before the old cleanup reaches destruction', () => {
  const { session, connection } = fixture();
  session.requestStop({ keepVoiceConnection: true }); session.releaseVoiceConnection(); session.destroy();
  assert.equal(connection.destroyed, 1);
});

test('releasing an old handoff cannot destroy a different connection', () => {
  const { session, connection } = fixture();
  session.requestStop({ keepVoiceConnection: true }); session.destroy();
  const newer = { destroyed: 0, destroy() { this.destroyed++; } }; currentConnection = newer;
  session.releaseVoiceConnection();
  assert.equal(connection.destroyed, 0); assert.equal(newer.destroyed, 0);
});

test('session destruction does not disconnect a different voice channel', () => {
  const { session, connection } = fixture(); connection.joinConfig.channelId = 'other';
  session.destroy(); assert.equal(connection.destroyed, 0);
});
