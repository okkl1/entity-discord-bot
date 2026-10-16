import test from 'node:test';
import assert from 'node:assert/strict';
import { allCommands, roomCommands, sharedCommands, syncSlashCommands, syncGuildCommands } from '../src/discord-commands.js';

function registry() {
  const scopes = new Map(), calls = [];
  const scope = id => { const key = id || 'global'; if (!scopes.has(key)) scopes.set(key, new Map()); return scopes.get(key); };
  const manager = {
    async create(data, guildId) {
      calls.push(['create', guildId || 'global', data.name]);
      if (manager.failGuild === guildId && guildId) throw new Error('registration failed');
      const command = { name: data.name, type: data.type || 1, delete: async () => { calls.push(['delete', guildId || 'global', data.name]); scope(guildId).delete(`${command.type}:${command.name}`); } };
      scope(guildId).set(`${command.type}:${command.name}`, command);
    },
    fetch: async ({ guildId }) => new Map(scope(guildId)),
  };
  const seed = async (names, id, type = 1) => { for (const name of names) await manager.create({ name, type }, id); };
  const names = id => [...scope(id).values()].filter(c => c.type === 1).map(c => c.name).sort();
  return { manager, seed, names, calls, scope };
}
const names = commands => commands.map(command => command.name).sort();

test('global room duplicates are removed only after immediate guild replacements, leaving unrelated commands intact', async () => {
  const f = registry();
  await f.seed([...names(allCommands), 'watch', 'stop', 'unrelated']);
  await f.seed([...names(allCommands), 'watch', 'unrelated'], 'server');
  await f.seed(['웹방'], undefined, 2);
  f.calls.length = 0;
  const result = await syncSlashCommands(f.manager, { guildIds: ['server'] });
  assert.equal(result.removed, 15);
  assert.deepEqual(f.names(), [...names(sharedCommands), 'unrelated'].sort());
  assert.deepEqual(f.names('server'), [...names(roomCommands), 'unrelated'].sort());
  assert.ok(f.scope().has('2:웹방'));
  const firstGlobalDelete = f.calls.findIndex(c => c[0] === 'delete' && c[1] === 'global');
  assert.ok(firstGlobalDelete > f.calls.findLastIndex(c => c[0] === 'create' && c[1] === 'server'));
  assert.equal((await syncSlashCommands(f.manager, { guildIds: ['server'] })).removed, 0);
});

test('changing a configured development guild cleans old scopes without recreating duplicate globals', async () => {
  const f = registry(); await f.seed(names(allCommands)); await f.seed(names(allCommands), 'old');
  await syncSlashCommands(f.manager, { guildIds: ['old', 'new'], primaryGuildId: 'new' });
  assert.deepEqual(f.names(), []); assert.deepEqual(f.names('new'), names(allCommands)); assert.deepEqual(f.names('old'), names(roomCommands));
  await syncSlashCommands(f.manager, { guildIds: ['old', 'new'] });
  assert.deepEqual(f.names(), names(sharedCommands)); assert.deepEqual(f.names('new'), names(roomCommands));
});

test('failed guild registration preserves existing global room commands', async () => {
  const f = registry(); await f.seed(names(allCommands)); f.manager.failGuild = 'server';
  await assert.rejects(syncSlashCommands(f.manager, { guildIds: ['server'] }), /registration failed/);
  assert.deepEqual(f.names(), names(allCommands));
});

test('joining a new server uses the same guild command policy', async () => {
  const f = registry(); await syncGuildCommands(f.manager, 'server'); assert.deepEqual(f.names('server'), names(roomCommands));
  await syncGuildCommands(f.manager, 'dev', { primaryGuildId: 'dev' }); assert.deepEqual(f.names('dev'), names(allCommands));
});
