import { radioCommands } from './chzzk/commands.js';
import { binanceCommands } from './binance/plugin.js';
import { webCommands } from './web/commands.js';
import { watchTogetherCommands } from './web/watch-together.js';

export const sharedCommands = [...radioCommands, ...binanceCommands];
export const roomCommands = [...webCommands, ...watchTogetherCommands];
export const allCommands = [...sharedCommands, ...roomCommands];
const managedNames = new Set([...allCommands.map(command => command.name), 'watch', 'stop']);

async function removeObsolete(manager, desired, guildId) {
  const keep = new Set(desired.map(command => command.name));
  const registered = await manager.fetch({ guildId });
  let removed = 0;
  for (const command of registered.values()) {
    if (command.type === 1 && managedNames.has(command.name) && !keep.has(command.name)) {
      await command.delete(); removed++;
    }
  }
  return removed;
}

export async function syncGuildCommands(manager, guildId, { primaryGuildId } = {}) {
  const desired = guildId === primaryGuildId ? allCommands : roomCommands;
  for (const command of desired) await manager.create(command.toJSON(), guildId);
  return removeObsolete(manager, desired, guildId);
}

export async function syncSlashCommands(manager, { guildIds, primaryGuildId } = {}) {
  // Room commands are registered in guilds for immediate availability. Other
  // commands retain their global scope unless a development guild is set.
  const globalCommands = primaryGuildId ? [] : sharedCommands;
  for (const command of globalCommands) await manager.create(command.toJSON());
  const ids = new Set(guildIds);
  if (primaryGuildId) ids.add(primaryGuildId);
  let removed = 0;
  for (const id of ids) removed += await syncGuildCommands(manager, id, { primaryGuildId });
  // Only remove old global entries after replacement guild registrations work.
  removed += await removeObsolete(manager, globalCommands);
  return { guilds: ids.size, removed };
}
