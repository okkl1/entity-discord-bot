import { Options } from 'discord.js';

export function discordCacheSettings(compact) {
  return compact ? {
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 32,
    GuildMemberManager: { maxSize: 256, keepOverLimit: member => member.id === member.client.user?.id || Boolean(member.voice?.channelId) },
    ReactionManager: 0, ReactionUserManager: 0, PresenceManager: 0,
  } : Options.DefaultMakeCacheSettings;
}
export const discordCache = compact => Options.cacheWithLimits(discordCacheSettings(compact));
