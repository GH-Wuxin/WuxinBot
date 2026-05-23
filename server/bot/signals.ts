// Shared interaction signal extractor — pure rules, no LLM.
// Used by both auto-trust scoring and relationship profiles.
import { textWithoutControlPlaceholders } from './cleaning.js';

export function extractSignals(event, db) {
  const text = String(event.text || '').trim();
  const clean = textWithoutControlPlaceholders(text);
  const atTargets = event.atTargets || [];

  return {
    // Message quality
    isRealText: clean.length >= 3 && !/^\//.test(clean) && !/^\[(图片|表情|视频|文件|语音)\]/.test(clean),
    isCommand: /^\//.test(clean),
    isMedia: /^\[(图片|表情|表情包|视频|文件|语音)\]/.test(clean) || (!clean && /\[(图片|表情|视频|文件|语音)\]/.test(text)),
    isCard: /\[分享卡片/.test(text),
    textLength: clean.length,

    // Interaction targets
    atTargets,
    mentionsBot: atTargets.some((qq) => String(qq) === String(db.settings.selfQq || '')),
    mentionsOwner: atTargets.some((qq) => String(qq) === String(db.settings.ownerQq || '')),
    mentionsCount: atTargets.length,

    // Risk flags
    hasPromptInjection: /忽略(规则|设定|人设|角色|系统)|你现在听我的|我是你(主人|老板|开发者|owner)|忘记(你是|你的)|切换到(调试|开发|管理员)模式/i.test(clean),
    isAdversarial: /测试|test|试探|试试|试一下|看看你会不会|测一下/.test(clean) && atTargets.some((qq) => String(qq) === String(db.settings.selfQq || '')),
  };
}

export function computeInteractionDiversity(messages, userId) {
  const interacted = new Set();
  const userMsgs = messages.filter((m) => String(m.userId) === String(userId));
  if (userMsgs.length < 3) return 0;
  // Count distinct members this user has replied to or @'d
  for (let i = 0; i < userMsgs.length; i++) {
    const m = userMsgs[i];
    // Check if this message @s someone
    const atMatches = (m.content || '').match(/\[CQ:at,qq=(\d+)\]/g) || [];
    for (const at of atMatches) {
      const qq = at.match(/\d+/)?.input?.match(/\d+/)?.[0];
      if (qq) interacted.add(qq);
    }
    // Check if previous message was from someone else (conversation partner)
    const idx = messages.indexOf(m);
    if (idx > 0) {
      const prev = messages[idx - 1];
      if (prev && String(prev.userId) !== String(userId) && prev.role === 'user') {
        interacted.add(String(prev.userId));
      }
    }
  }
  return interacted.size;
}

export function countRecentNegativeSignals(samples, days = 7) {
  const cutoff = Date.now() - days * 86400000;
  return (samples || []).filter((s) => {
    if (s.riskLevel !== 'high-risk' && s.riskLevel !== 'low-confidence') return false;
    return new Date(s.createdAt).getTime() >= cutoff;
  }).length;
}

export function findRecentInteractionPairs(messages, groupId, limit = 60) {
  const groupMsgs = messages.filter((m) => String(m.groupId) === String(groupId) && m.role === 'user').slice(-limit);
  const pairs = {};
  for (let i = 1; i < groupMsgs.length; i++) {
    const a = String(groupMsgs[i - 1].userId);
    const b = String(groupMsgs[i].userId);
    if (a === b) continue;
    // Check if there's an @ between them in either message
    const aAts = (groupMsgs[i - 1].content || '').match(/\[CQ:at,qq=(\d+)\]/g) || [];
    const bAts = (groupMsgs[i].content || '').match(/\[CQ:at,qq=(\d+)\]/g) || [];
    const aAtB = aAts.some((at) => at.includes(b));
    const bAtA = bAts.some((at) => at.includes(a));
    const pairKey = [a, b].sort().join(':');
    if (!pairs[pairKey]) pairs[pairKey] = { userA: [a, b].sort()[0], userB: [a, b].sort()[1], count: 0, atEachOther: 0, consecutiveTurns: 0 };
    pairs[pairKey].count += 1;
    if (aAtB || bAtA) pairs[pairKey].atEachOther += 1;
    // Consecutive turn detection: if same pair chatted back-and-forth
    if (i > 1) {
      const prevA = String(groupMsgs[i - 2].userId);
      if (prevA === a || prevA === b) pairs[pairKey].consecutiveTurns += 1;
    }
  }
  return Object.values(pairs).filter((p) => p.count >= 3);
}
