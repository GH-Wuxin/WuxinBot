// Conversation context and message-participation helpers. Type-checked module.
import { readDb } from '../store.js';
import {
  mentionsBot,
  asksToInspectVisual,
  looksLikeVisualFollowup,
  isQuestion,
  textWithoutControlPlaceholders,
} from './cleaning.js';
import {
  modelSupportsVision,
} from './prompt.js';

export function looksLikeExternalBotSender(
  event,
  settings: { selfQq?: string; externalBotQqs?: string } = {}
) {
  if (settings.selfQq && String(event.userId) === String(settings.selfQq)) return false;
  const explicitBotQqs = String(settings.externalBotQqs || '')
    .split(/[,\s]+/)
    .map((qq) => qq.trim())
    .filter(Boolean);
  if (explicitBotQqs.includes(String(event.userId))) return true;
  const nick = String(event.nickname || '').trim();
  if (!nick) return false;
  return /(^|[\s._-])(bot|ai)([\s._-]|$)|(?:机器人|助手|bot)$/i.test(nick)
    || /^(ChatGPT|Claude|DeepSeek|Mimo)(?:[\s._-]|$)/i.test(nick);
}

export function extractAtQq(text) {
  const match = String(text || '').match(/\[CQ:at,qq=([^\],\]]+)\]/i);
  return match ? String(match[1]) : null;
}

export function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripAtQq(text, qq) {
  if (!qq) return String(text || '').trim();
  return String(text || '').replace(new RegExp(`\\[CQ:at,qq=${escapeRegExp(qq)}(?:,[^\\]]*)?\\]\\s*`, 'i'), '').trim();
}

export function parseTargetAndRest(
  text,
  event,
  options: { allowNumeric?: boolean } = {}
) {
  const raw = String(text || '').trim();
  const cqTarget = extractAtQq(raw);
  if (cqTarget) return { targetQq: cqTarget, rest: stripAtQq(raw, cqTarget) };

  if (options.allowNumeric !== false) {
    const numeric = raw.match(/^(\d{5,12})(?:\s+|$)/);
    if (numeric) return { targetQq: numeric[1], rest: raw.slice(numeric[0].length).trim() };
  }

  const atTarget = event?.atTargets?.[0] ? String(event.atTargets[0]) : null;
  if (atTarget && raw.startsWith('@')) {
    return { targetQq: atTarget, rest: raw.replace(/^@\S+\s*/, '').trim() };
  }

  return { targetQq: null, rest: raw };
}

// LLM content filter for user-generated content (nick/style).
// Returns { ok: true } or { ok: false, reason: '...' }.
export async function llmContentFilter(text, label) {
  // Basic safety: empty, control chars, prompt injection patterns
  if (!text || !text.trim()) return { ok: false, reason: '内容为空' };
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { ok: false, reason: '包含控制字符' };
  if (/(忽略|忘记|切换到|你现在听我的|我是你(主人|老板|开发者)|系统提示|system prompt|ignore previous)/i.test(text)) {
    return { ok: false, reason: '疑似提示词注入' };
  }
  try {
    const db = readDb();
    const { completeChat } = await import('./llm.js');
    const resp = await completeChat(db, {
      messages: [{
        role: 'user',
        content: `判断以下用户设置的${label}内容是否合适。不合适的情况：侮辱/歧视/色情/政治敏感/冒充他人/广告/纯乱码。只回复"OK"或"不合适:原因"（10字以内）。\n\n内容：${text.slice(0, 200)}`
      }],
      temperature: 0.1,
      maxTokens: 30,
      label: '内容审核',
    });
    const reply = (resp.text || '').trim();
    if (reply.toUpperCase().startsWith('OK')) return { ok: true };
    const reason = reply.replace(/^[^:：]*[:：]\s*/, '').slice(0, 50) || '内容不合适';
    return { ok: false, reason };
  } catch {
    // If LLM fails, allow the content (don't block on filter errors)
    return { ok: true };
  }
}

export function getGroup(db, groupId) {
  return db.groups.find((group) => String(group.groupId) === String(groupId));
}

export function getUserPolicy(db, groupId, userId) {
  // Owner is global and comes from settings, so it overrides per-group entries.
  if (db.settings.ownerQq && String(userId) === String(db.settings.ownerQq)) {
    return {
      policy: 'owner',
      attentionLevel: 5,
      allowCommands: true,
      commandRoleId: 'owner'
    };
  }

  return (
    db.users.find((user) => String(user.groupId) === String(groupId) && String(user.userId) === String(userId)) || {
      policy: 'normal',
      attentionLevel: 3,
      allowCommands: false
    }
  );
}

export function recentGroupMessages(db, groupId, limit) {
  return db.messages
    .filter((message) => String(message.groupId) === String(groupId) && message.inContext !== false)
    .slice(-limit);
}

export function ownerPrivateMessages(db) {
  const ownerQq = db.settings.ownerQq;
  return db.messages.filter((message) =>
    message.type === 'private' &&
    message.inContext !== false &&
    (String(message.userId) === String(ownerQq) || message.userId === 'bot')
  );
}

export function limitMessagesByCharBudget(messages, budget) {
  const maxChars = Math.max(4000, Number(budget || 24000));
  const selected = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = String(message.content || '').length + String(message.nickname || message.userId || '').length + 24;
    if (selected.length >= 6 && used + cost > maxChars) break;
    selected.unshift(message);
    used += cost;
  }
  return selected;
}

export function countRecentReplies(db, groupId, minutes) {
  const since = Date.now() - minutes * 60 * 1000;
  // Count reply decisions rather than only successful assistant messages.
  // A downstream OneBot failure must still consume the participation budget;
  // otherwise every following message looks like the bot never replied and
  // can start another model turn.
  return (db.decisions || []).filter((decision) =>
    String(decision.groupId) === String(groupId) &&
    decision.shouldReply === true &&
    new Date(decision.createdAt).getTime() >= since
  ).length;
}

export function countRecentUserMessages(db, groupId, minutes) {
  const since = Date.now() - minutes * 60 * 1000;
  return db.messages.filter(
    (message) =>
      String(message.groupId) === String(groupId) &&
      message.role === 'user' &&
      new Date(message.createdAt).getTime() >= since
  ).length;
}

export function lastAssistantAt(db, groupId) {
  const lastAssistant = [...db.messages]
    .reverse()
    .find((message) => String(message.groupId) === String(groupId) && message.role === 'assistant');
  const lastAttempt = [...(db.decisions || [])]
    .reverse()
    .find((decision) => String(decision.groupId) === String(groupId) && decision.shouldReply === true);
  return Math.max(
    lastAssistant ? new Date(lastAssistant.createdAt).getTime() : 0,
    lastAttempt ? new Date(lastAttempt.createdAt).getTime() : 0,
  );
}

/**
 * Cheap, deterministic participation scoring for natural/light groups.
 *
 * This is deliberately not a second model call. The main reply model remains
 * the only LLM turn for an accepted message; this score only decides whether
 * an ordinary unmentioned message is worth admitting to that turn.
 */
export function scoreReplyParticipation(
  db,
  groupId,
  text,
  { userPolicy = {} }: { userPolicy?: { policy?: string } } = {},
) {
  const clean = textWithoutControlPlaceholders(String(text || '')).trim();
  const characterCount = [...clean].length;
  if (!clean || /^[/!]/.test(clean)) {
    return { score: 0, characterCount, recentUserMessages5m: 0, recentBotReplies10m: 0, busy: false };
  }

  const recentUserMessages5m = countRecentUserMessages(db, groupId, 5);
  const recentBotReplies10m = countRecentReplies(db, groupId, 10);
  const busy = recentUserMessages5m >= 10;
  let score = Math.min(45, characterCount * 3);

  // A little structure is stronger evidence than raw length, but none of
  // these signals selects a sticker or interprets a particular keyword.
  if (characterCount >= 6) score += 5;
  if (characterCount >= 18) score += 5;
  if (isQuestion(clean)) score += 30;
  if (/[!?！？]/.test(clean)) score += 5;
  if (/[。；;\n]/.test(clean)) score += 5;

  if (userPolicy?.policy === 'trusted' || userPolicy?.policy === 'priority'
    || userPolicy?.policy === 'admin' || userPolicy?.policy === 'owner') {
    score += 10;
  }
  if (busy) score -= 20;
  if (recentBotReplies10m >= 3) score -= 15;
  else if (recentBotReplies10m >= 1) score -= 5;

  return {
    score: Math.max(0, Math.min(100, score)),
    characterCount,
    recentUserMessages5m,
    recentBotReplies10m,
    busy,
  };
}

export function lastAssistantMessage(db, groupId) {
  return [...db.messages]
    .reverse()
    .find((message) => String(message.groupId) === String(groupId) && message.role === 'assistant');
}

export function isPrivilegedForConversation(userPolicy) {
  return userPolicy.policy === 'owner' ||
    userPolicy.policy === 'admin' ||
    userPolicy.policy === 'priority' ||
    userPolicy.allowCommands;
}

export function looksLikeReplyToBot(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^(6+|草|笑死|绷|难绷|牛逼|离谱|对|是|不是|行|好|嗯|？|\?)$/.test(value)) return false;
  return /你这|你刚|刚才|上一句|说的啥|说错|错了|不对|幻觉|编的|乱说|什么鬼|有头没尾|没写完|没结尾|继续|补上|接着|重写|改改|搜一下|上网搜|查一下|查查|不是这个|撤回|算错/.test(value);
}

export function recentBotConversation(db, groupId, seconds = 120) {
  const last = lastAssistantMessage(db, groupId);
  if (!last) return { active: false, last: null };
  const ageMs = Date.now() - new Date(last.createdAt).getTime();
  return { active: ageMs <= seconds * 1000, last };
}

export function recentVisionImageMessages(db, event, minutes = 10) {
  const cutoff = Date.now() - minutes * 60_000;
  const currentId = String(event.messageId || '');
  const sameGroupImages = (db.messages || [])
    .filter((message) => {
      if (String(message.groupId) !== String(event.groupId)) return false;
      if (message.inContext === false || message.type !== event.type) return false;
      // Automatic history lookup requires a connection to this speaker.
      // Explicitly quoted messages are hydrated through a separate path.
      if (String(message.userId) !== String(event.userId)) return false;
      if (!message.media?.images?.length) return false;
      if (currentId && String(message.id) === currentId) return false;
      const time = new Date(message.createdAt || 0).getTime();
      return Number.isFinite(time) && time >= cutoff;
    })
    .slice(-30)
    .reverse();
  const sameUser = sameGroupImages.find((message) => String(message.userId) === String(event.userId));
  return sameUser ? [sameUser, ...sameGroupImages.filter((message) => message !== sameUser)] : sameGroupImages;
}

export function shouldUseRecentVisionImage(db, event) {
  if (!modelSupportsVision(db) || event.images?.length) return false;
  const text = event.text || '';
  if (asksToInspectVisual(text)) return true;
  if (!looksLikeVisualFollowup(text)) return false;
  const mentioned = mentionsBot(text, db.settings);
  const botConversation = recentBotConversation(db, event.groupId, 180);
  return mentioned || botConversation.active;
}
