// QQ 昵称的本地解析：长期记忆里存了昵称，其次成员策略，最后翻最近消息。
// 都查不到才回退成 QQ 号，不要凭空编名字。
export function resolveNickname(db, userId) {
  const id = String(userId || '');
  if (!id) return '';
  const memory = (db?.memories || []).find((item) => String(item.userId) === id && String(item.nickname || '').trim());
  if (memory) return String(memory.nickname).trim();
  const user = (db?.users || []).find((item) => String(item.userId) === id && String(item.customName || item.nickname || '').trim());
  if (user) return String(user.customName || user.nickname).trim();
  const messages = db?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message.userId) === id && String(message.nickname || '').trim()) return String(message.nickname).trim();
  }
  return '';
}
