// Inbound adapter/context helpers: QQ event adaptation, quote/image collection,
// admission preview and small delivery/level-up formatting helpers.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readDb } from '../store.js';
import { resolveLocalQuote } from '../messageFacts.js';
import { normalizeMessage, extractImageInputs, extractReplyMessageId, extractAtTargets, asksToInspectVisual } from './cleaning.js';
import { looksLikeToolCallMarkup } from '../bots/guard.js';
import { chatAdmissionReason, replyLimitReason } from './social/policy.js';
import { recentVisionImageMessages, shouldUseRecentVisionImage } from './gate.js';
import { modelSupportsVision } from './prompt.js';

let stickerReplyCapabilityWarningLogged = false;

export function recordStickerReplyCapabilityWarning(error) {
  if (stickerReplyCapabilityWarningLogged) return;
  stickerReplyCapabilityWarningLogged = true;
  console.warn('[sticker] optional model-reply catalogue unavailable; continuing without sticker protocol:', String(error?.message || error).slice(0, 240));
}

export function replyTargetMetadata(event) {
  return {
    replyToMessageId: String(event.messageId || ''),
    replyToUserId: String(event.userId || ''),
    replyToNickname: String(event.nickname || event.userId || ''),
  };
}

export function escapeCqParam(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

export function toolImageToCq(image) {
  const value = String(image || '').trim();
  if (!value) return '';
  if (/^\[CQ:image,[^\]]+\]$/i.test(value)) return value;

  let source = value;
  const dataUri = value.match(/^data:image\/[^;,]+;base64,(.+)$/is);
  if (dataUri) {
    source = `base64://${dataUri[1].replace(/\s+/g, '')}`;
  } else if (/^[a-zA-Z]:[\\/]/.test(value)) {
    source = pathToFileURL(value).href;
  }

  return `[CQ:image,file=${escapeCqParam(source)}]`;
}

export function toolImageToMediaInput(image) {
  const value = String(image || '').trim();
  // Message history is durable JSON. Never duplicate a large inline/base64
  // image into it; rendered panels normally arrive as a short file URL and QQ
  // images as a short HTTPS URL.
  if (!value || value.length > 16_384 || /^base64:\/\//i.test(value)) return null;
  const parsed = extractImageInputs(value)[0];
  if (parsed) return parsed;
  if (/^(?:https?:|data:image\/)/i.test(value)) {
    return { type: 'image', url: value };
  }
  return { type: 'image', file: value };
}

// ── Level-up phrase generation ──
// Levels are named by pp value (level N = N*100pp). The phrase compares the
// level pp with the player's real osu! pp and teases accordingly; it never
// mentions "level", "title" or "unlock".

const LEVEL_UP_FALLBACK_LOW = [
  '你 {pp}pp 了！什么？比这 pp 还高？这是我这的等级 pp，不用太在意啦！',
  '你 {pp}pp 了！什么？你真实水平比这高多了？这是我这的等级 pp，随便看看就好。',
  '你 {pp}pp 了！嗯？明明真实 pp 比这高？这是我这的等级 pp，不用当真啦。',
];
const LEVEL_UP_FALLBACK_HIGH = [
  '你 {pp}pp 了！什么？你没那么多 pp？这是我这的等级 pp，不用太在意啦！',
  '你 {pp}pp 了！什么？真实 pp 还没到？这是我这的等级 pp，先记着这个数就行。',
  '你 {pp}pp 了！哦？真没那么多 pp？这是我这的等级 pp，别太当真。',
];
const LEVEL_UP_FALLBACK_NONE = [
  '你 {pp}pp 了！这是我这的等级 pp，不用太在意啦。',
  '你 {pp}pp 了！我这儿的等级 pp，随便看看就好。',
  '你 {pp}pp 了！这是我这的等级 pp，别太当真。',
];

export function levelUpFallback(oldPp, newPp, realPp) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pool = realPp == null ? LEVEL_UP_FALLBACK_NONE
    : realPp < newPp ? LEVEL_UP_FALLBACK_HIGH
    : LEVEL_UP_FALLBACK_LOW;
  return pick(pool).replace('{pp}', String(newPp));
}

/** Missing/invalid data is unknown, while a genuine zero is a valid osu! value. */
export function normalizeRealOsuPp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export async function resolveLevelUpRealPp(binding, getUserById, records = []) {
  if (!binding?.id) return null;
  try {
    const user = await getUserById(binding.id, 'osu');
    const pp = normalizeRealOsuPp(user?.statistics?.pp);
    if (pp !== null) return pp;
  } catch { /* Fall back to an existing real-player snapshot, never chat XP. */ }
  const record = records.find((r) => Number(r.osuUserId) === Number(binding.id));
  return normalizeRealOsuPp(record?.pp);
}

export function buildLevelUpPrompt(nickname, oldPp, newPp, realPp, contextLines) {
  const compare = realPp == null
    ? '他的真实 osu! pp 未知（未绑定或查询没有有效数据），不能当作 0，也不能推断实力。'
    : realPp < newPp
      ? `他的真实 osu! pp 只有 ${realPp}pp，低于新等级对应的 ${newPp}pp。`
      : `他的真实 osu! pp 高达 ${realPp}pp，远高于新等级对应的 ${newPp}pp。`;
  const hint = realPp == null
    ? '按格式说：宣告等级 pp 后，直接说“这是我这的等级 pp，不用太在意啦”。'
    : realPp < newPp
      ? '在宣告后加一句惊讶：“什么？你没那么多 pp？”（因为真实 pp 低于等级 pp）。'
      : '在宣告后加一句惊讶：“什么？比这 pp 还高？”（因为真实 pp 高于等级 pp）。';
  return [
    `你是 pippi。群友 ${nickname} 的等级刚提升：${oldPp}pp → ${newPp}pp。`,
    '这里的等级 pp 只是 Wuxin 聊天经验展示名，不是 osu! 成绩；不能拿它评价玩家实力。',
    compare,
    `最近群聊：${contextLines}`,
    `对 ${nickname} 说一句升级短语，格式是这样：“你 {新等级 pp}pp 了！${realPp == null ? '' : realPp < newPp ? '什么？你没那么多 pp？' : '什么？比这 pp 还高？'}这是我这的等级 pp，不用太在意啦！”`,
    hint,
    '可以在“不用太在意”后面加半句轻松的收尾（比如“先记着这个数就行”），但不要加更多解释。',
    '保留“这是我这的等级 pp”以区分聊天经验和 osu! 成绩；不要额外罗列 Lv.、称号或解锁功能；禁止复述规则或任何括号说明；不要用“装萌新”“少废话”“谁有意见”“别狡辩”这类带挑衅或贬低的说法；只输出一句对玩家说的话，不要解释。',
  ].join('\n');
}

export function compactDirectToolLead(text, directContent = '', hasImages = false) {
  const fallback = hasImages
    ? '查好了，结果在图里。'
    : '查好了，完整结果放在下面。';
  const cleaned = String(text || '')
    // The model writes only a human lead. It must never be able to emit a QQ
    // control segment alongside the system-owned direct payload.
    .replace(/\[CQ:[^\]]+\]/gi, ' ')
    .replace(/\[(?:图片|表情|表情包|视频|文件|语音)\]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/^```[^\n]*\n?/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!cleaned) return fallback;
  if (looksLikeToolCallMarkup(cleaned)) return fallback;

  // Must contain at least one letter or digit — pure punctuation/emoji → fallback
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return fallback;

  // Data-like fragments (starts with #N or contains dense numbers/pipes) → fallback
  if (/^(?:#\d+\b|[-•]\s)/u.test(cleaned)) return fallback;

  // Let the LLM's full evaluation through — just check it's not raw data regurgitation
  const normalizedCleaned = cleaned.replace(/\s+/g, '');
  const normalizedDirect = String(directContent || '').replace(/\s+/g, '');
  if (normalizedCleaned.length >= 8 && normalizedDirect.startsWith(normalizedCleaned)) {
    return fallback;
  }
  return cleaned;
}

/** Replies at or below this length are never merged into a forward card. */

// Console preview reports admission; only the social model decides ambient participation.
export async function decideReply({ db, group, userPolicy, text, mentioned, userId, images = [] }) {
  const event = { type: 'group', groupId: String(group?.groupId || ''), userId: String(userId || ''), text, messageId: '', socialDirect: mentioned } as any;
  const preview = { ...db, groups: [group].filter(Boolean), users: [{ ...userPolicy, groupId: event.groupId, userId: event.userId }] };
  const blocked = chatAdmissionReason(preview, event, mentioned) || replyLimitReason(preview, event);
  if (blocked) return { shouldReply: false, reason: blocked };
  if (!mentioned) return { shouldReply: false, pendingAssessment: true, reason: '等待 LLM 根据对话判断参与，不按字数或标点评分' };
  if (asksToInspectVisual(text) && !modelSupportsVision(db)) return { shouldReply: true, reason: '当前模型不支持视觉识别', visualLimitation: true };
  return { shouldReply: true, reason: '有人 @ 或叫到了机器人' };
}

export function oneBotToInternal(event) {
  // Internal event shape used by the bot engine. Keep fields stringified because
  // QQ ids can exceed safe integer habits and are easier to compare as strings.
  const text = normalizeMessage(event.raw_message || event.message);
  let images = extractImageInputs(event.message || event.raw_message);
  const replyMessageId = extractReplyMessageId(event.message || event.raw_message);
  let quotedMessage;

  // If the user quoted a message, try to include images from the quoted message.
  // This handles: user replies to an image message and @bots.
  if (replyMessageId) {
    try {
      const db = readDb();
      quotedMessage = resolveLocalQuote(db, { type: event.message_type || 'group',
        groupId: String(event.group_id || 'private'), userId: String(event.user_id || ''), replyMessageId, raw: event });
    } catch { /* DB read failure is non-fatal */ }
  }

  return {
    source: 'onebot',
    receivedAtMs: Date.now(),
    type: event.message_type || 'group',
    messageId: String(event.message_id || crypto.randomUUID()),
    groupId: event.group_id ? String(event.group_id) : 'private',
    userId: String(event.user_id || ''),
    nickname: event.sender?.card || event.sender?.nickname || String(event.user_id || ''),
    text,
    images,
    replyMessageId,
    quotedMessage,
    senderRole: event.sender?.role || 'member',
    atTargets: extractAtTargets(event.message || event.raw_message),
    raw: event
  };
}

export function collectEventVisionImages(event) {
  const all = [
    ...(Array.isArray(event?.images) ? event.images : []),
    ...(Array.isArray(event?.quotedMessage?.images) ? event.quotedMessage.images : []),
  ];
  const seen = new Set();
  return all.filter((image) => {
    const key = String(image?.url || image?.file || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve the images this turn's model should see. Current/quoted images win;
 * only when there are none do we fall back to the recent same-speaker image
 * window. Keeping the selection here makes the provenance rule testable without
 * changing how prompt.ts describes the chosen images.
 */
export function resolveConversationVisionImages(db, event) {
  let images = modelSupportsVision(db) ? collectEventVisionImages(event) : [];
  if (images.length === 0 && shouldUseRecentVisionImage(db, event)) {
    const contextImages = recentVisionImageMessages(db, event, 10);
    if (contextImages.length > 0) images = contextImages[0].media.images.slice(0, 1);
  }
  return images;
}

/**
 * The `osu` group mode is a hard ingress boundary, not a reply preference.
 * `/w mode` is the sole non-osu escape hatch so an administrator can leave the
 * mode after enabling it. Natural-language osu! questions are intentionally not
 * accepted because answering them would require the LLM.
 */
export function allowedByOsuCommandOnlyMode(event, quickMatch = null) {
  const text = String(event?.text || '').trim();
  const ownerCommand = /^\/w(?:uxin)?\s+([^\s]+)/i.exec(text)?.[1]?.toLowerCase() || '';
  // `/w info` is the deterministic player Skill Profiler command. It must
  // remain reachable in osu-only groups just like `/w skill`; otherwise the
  // hard ingress gate discards it before the owner dispatcher can run.
  if (ownerCommand) return ['osu', 'skill', 'info', 'update', 'compare', 'cd', 'mode'].includes(ownerCommand);
  return quickMatch?.def?.kind === 'osu';
}
