// Only messages explicitly created for this quiz are passed to this helper.
const deleted = new WeakSet();
export async function deleteGameMessages(messages) {
  const unique = [...new Set(messages.filter(message => message && typeof message.delete === 'function' && !deleted.has(message)))];
  await Promise.all(unique.map(async message => {
    try { await message.delete(); deleted.add(message); }
    catch (error) {
      if (error.code === 10008) deleted.add(message);
      else console.warn('[quiz] 게임 메시지 삭제 실패:', error.message);
    }
  }));
}
export function deleteGameMessageLater(message, delayMs = 10_000) {
  if (!message || deleted.has(message)) return;
  const timer = setTimeout(() => { void deleteGameMessages([message]); }, delayMs);
  timer.unref();
}
