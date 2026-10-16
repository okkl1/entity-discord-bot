import { readFile, writeFile } from 'node:fs/promises';

// 이전 버전의 공개 시세판만 정리한다. 다른 사람이 쓴 메시지는 절대 삭제하지 않는다.
export async function cleanupLegacyWatches(client, statePath) {
  let saved;
  try { saved = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('이전 시세판 상태를 읽지 못했습니다:', error.message);
    return { removed: 0, pending: 0 };
  }
  if (!Array.isArray(saved)) return { removed: 0, pending: 0 };
  const pending = [];
  let removed = 0;
  for (const item of saved) {
    if (!/^\d+$/.test(item?.channelId) || !/^\d+$/.test(item?.messageId)) continue;
    try {
      const channel = await client.channels.fetch(item.channelId);
      if (!channel?.messages) continue;
      const message = await channel.messages.fetch(item.messageId);
      if (message.author.id !== client.user.id) {
        console.warn(`다른 작성자의 메시지는 삭제하지 않았습니다: ${item.messageId}`);
        continue;
      }
      await message.delete();
      removed++;
    } catch (error) {
      if (error.code === 10003 || error.code === 10008) continue;
      pending.push(item);
      console.warn(`이전 시세판 삭제 실패 (${item.channelId}):`, error.message);
    }
  }
  await writeFile(statePath, JSON.stringify(pending, null, 2), 'utf8');
  return { removed, pending: pending.length };
}
