// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
import { pathToFileURL } from 'node:url';
import { defaultPrompt, readDb, updateDb, nowIso } from './store.js';
import {
  normalizeMessage,
  extractImageInputs,
  extractAtTargets,
  extractReplyMessageId,
  mentionsBot,
  isQuestion,
  hasVisualPlaceholder,
  asksToInspectVisual,
  looksLikeVisualFollowup,
  onlyVisualMessage,
  textWithoutControlPlaceholders,
  cardPlaceholder
} from './bot/cleaning.js';
import {
  callLLM,
  completeChat
} from './bot/llm.js';
import {
  commandRoleLevel,
  commandRoleName,
  userCommandRoleId,
  hasCommandPermission,
  commandDeniedReply,
  parseCommandMeta,
  writeCommandLog
} from './bot/commands.js';
import {
  buildPrompt,
  describePolicy,
  describeModel,
  getPricing,
  calcCost,
  asksForExplicitSearch,
  isLongFormRequest,
  taskComplexityScore,
  autoModelForTask,
  responseOptionsFor,
  ownerPrivateContextStats,
  promptContextMessages,
  memoryPromptBlock,
  modelSupportsVision,
  sumUsageSince,
  startOfLocalDayTime
} from './bot/prompt.js';
import {
  sanitizeReply,
  sendReplySegments,
  isWeirdReply,
  rewriteNormalReply,
  visualLimitationReply,
  sendForwardText,
  splitReplySegments,
  isIdentityQuestion,
  neutralIdentityReply
} from './bot/reply.js';
import { recordMemoryObservation, maybeUpdateMemoryProfile, maybeRecordImageMemorySummary, updateMemoryProfile, commitMemoryProfileResult, maybeSweepDueMemoryProfiles } from './bot/memory.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, incrementGroupProfilePending, hasGroupProfileContent } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, incrementPairPending } from './bot/relationshipProfile.js';
import { processTrustSignal, evaluateTrustScores, trustInteractionBonus, isTrustedMember } from './bot/trust.js';
import { processXpGain, getExperience, getXpBonus, formatXpBar, getUnlockedFeatures, getLevelInfo, getNextLevelInfo, LEVELS, decayInactiveUsers } from './bot/experience.js';
import { isSearchAvailable, searchWeb, formatSearchResults, getLastSearchStatus, extractSearchQuery } from './bot/search.js';
import { setBotPaused, getRecalcProgress, startRecalc, tickRecalc, finishRecalc } from './health.js';
import { activateModelProfile, activeProviderLabel } from './modelConfig.js';
import { handleOsuCommand } from './osu/commands.js';
import { loadRegistry, buildBotToolSchemas, enabledBots, findBot } from './bots/registry.js';
import { detectRequiredOsuTool, detectNamedBotRequest, detectBpTypeAnalysisIntent } from './bots/intent.js';
import { validateOperation } from './bots/guard.js';
import { runToolLoop, tryResolveBotResponse } from './bots/executor.js';

function escapeCqParam(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

function toolImageToCq(image) {
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

function toolImageToMediaInput(image) {
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

// Reply queue: when a reply is being generated for a group, new @bot messages
// are queued instead of dropped. After the current reply finishes, the next
// queued message is processed automatically (FIFO).
const REPLY_QUEUE_LIMIT = 10;
const REPLY_QUEUE_TTL_MS = 90_000;
const INBOUND_EVENT_DEDUPE_TTL_MS = 10 * 60_000;
const INBOUND_EVENT_DEDUPE_LIMIT = 5_000;
const recentInboundEvents = new Map();

function claimInboundEvent(event) {
  const messageId = String(event?.messageId || '').trim();
  if (!messageId || event?.source === 'gui') return true;

  const now = Date.now();
  const key = [
    String(event?.source || 'unknown'),
    String(event?.type || 'unknown'),
    String(event?.groupId || 'private'),
    messageId
  ].join(':');
  const seenAt = recentInboundEvents.get(key);
  if (Number.isFinite(seenAt) && now - seenAt < INBOUND_EVENT_DEDUPE_TTL_MS) {
    return false;
  }

  recentInboundEvents.set(key, now);
  if (recentInboundEvents.size > INBOUND_EVENT_DEDUPE_LIMIT) {
    for (const [candidate, timestamp] of recentInboundEvents) {
      if (now - timestamp >= INBOUND_EVENT_DEDUPE_TTL_MS ||
          recentInboundEvents.size > INBOUND_EVENT_DEDUPE_LIMIT) {
        recentInboundEvents.delete(candidate);
      }
      if (recentInboundEvents.size <= INBOUND_EVENT_DEDUPE_LIMIT) break;
    }
  }
  return true;
}
const replyQueues = new Map(); // key → { locked: boolean, queue: [{event, sendMessage, decision}] }

function getQueueState(key) {
  if (!replyQueues.has(key)) replyQueues.set(key, { locked: false, queue: [] });
  return replyQueues.get(key);
}

export function getReplyQueueStats() {
  const stats = {};
  for (const [key, state] of replyQueues) {
    if (state.locked || state.queue.length > 0) {
      stats[key] = { locked: state.locked, queued: state.queue.length };
    }
  }
  return stats;
}

async function drainReplyQueue(key) {
  const state = replyQueues.get(key);
  if (state?.queue?.length) {
    const now = Date.now();
    const fresh = [];
    for (const item of state.queue) {
      if (!item.enqueuedAt || now - item.enqueuedAt <= REPLY_QUEUE_TTL_MS) {
        fresh.push(item);
        continue;
      }
      updateDb((draft) => {
        draft.decisions.push({
          id: crypto.randomUUID(),
          messageId: item.event.messageId,
          groupId: item.event.groupId,
          userId: item.event.userId,
          shouldReply: false,
          reason: '回复队列等待超时，丢弃旧消息',
          createdAt: nowIso()
        });
      });
    }
    state.queue = fresh;
  }
  if (!state || state.queue.length === 0) {
    if (state) state.locked = false;
    replyQueues.delete(key);
    return;
  }
  // Process next queued message. Lock stays held — pass isFromDrain=true
  // so processIncoming skips the lock check and doesn't re-queue.
  const next = state.queue.shift();
  try {
    await processIncoming(next.event, next.sendMessage, next.decision, true);
  } catch {
    // Errors are already handled inside processIncoming
  }
}

function looksLikeExternalBotSender(event, settings = {}) {
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

function extractAtQq(text) {
  const match = String(text || '').match(/\[CQ:at,qq=([^\],\]]+)\]/i);
  return match ? String(match[1]) : null;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAtQq(text, qq) {
  if (!qq) return String(text || '').trim();
  return String(text || '').replace(new RegExp(`\\[CQ:at,qq=${escapeRegExp(qq)}(?:,[^\\]]*)?\\]\\s*`, 'i'), '').trim();
}

function parseTargetAndRest(text, event, options = {}) {
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
async function llmContentFilter(text, label) {
  // Basic safety: empty, control chars, prompt injection patterns
  if (!text || !text.trim()) return { ok: false, reason: '内容为空' };
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return { ok: false, reason: '包含控制字符' };
  if (/(忽略|忘记|切换到|你现在听我的|我是你(主人|老板|开发者)|系统提示|system prompt|ignore previous)/i.test(text)) {
    return { ok: false, reason: '疑似提示词注入' };
  }
  try {
    const db = readDb();
    const { completeChat } = await import('./bot/llm.js');
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

function getGroup(db, groupId) {
  return db.groups.find((group) => String(group.groupId) === String(groupId));
}

function getUserPolicy(db, groupId, userId) {
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

function recentGroupMessages(db, groupId, limit) {
  return db.messages
    .filter((message) => String(message.groupId) === String(groupId) && message.inContext !== false)
    .slice(-limit);
}

function ownerPrivateMessages(db) {
  const ownerQq = db.settings.ownerQq;
  return db.messages.filter((message) =>
    message.type === 'private' &&
    message.inContext !== false &&
    (String(message.userId) === String(ownerQq) || message.userId === 'bot')
  );
}

function limitMessagesByCharBudget(messages, budget) {
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

function countRecentReplies(db, groupId, minutes) {
  const since = Date.now() - minutes * 60 * 1000;
  return db.messages.filter(
    (message) =>
      String(message.groupId) === String(groupId) &&
      message.role === 'assistant' &&
      new Date(message.createdAt).getTime() >= since
  ).length;
}

function countRecentUserMessages(db, groupId, minutes) {
  const since = Date.now() - minutes * 60 * 1000;
  return db.messages.filter(
    (message) =>
      String(message.groupId) === String(groupId) &&
      message.role === 'user' &&
      new Date(message.createdAt).getTime() >= since
  ).length;
}

function lastAssistantAt(db, groupId) {
  const last = [...db.messages]
    .reverse()
    .find((message) => String(message.groupId) === String(groupId) && message.role === 'assistant');
  return last ? new Date(last.createdAt).getTime() : 0;
}

function lastAssistantMessage(db, groupId) {
  return [...db.messages]
    .reverse()
    .find((message) => String(message.groupId) === String(groupId) && message.role === 'assistant');
}

function isPrivilegedForConversation(userPolicy) {
  return userPolicy.policy === 'owner' ||
    userPolicy.policy === 'admin' ||
    userPolicy.policy === 'priority' ||
    userPolicy.allowCommands;
}

function looksLikeReplyToBot(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^(6+|草|笑死|绷|难绷|牛逼|离谱|对|是|不是|行|好|嗯|？|\?)$/.test(value)) return false;
  return /你这|你刚|刚才|上一句|说的啥|说错|错了|不对|幻觉|编的|乱说|什么鬼|有头没尾|没写完|没结尾|继续|补上|接着|重写|改改|搜一下|上网搜|查一下|查查|不是这个|撤回|算错/.test(value);
}

function recentBotConversation(db, groupId, seconds = 120) {
  const last = lastAssistantMessage(db, groupId);
  if (!last) return { active: false, last: null };
  const ageMs = Date.now() - new Date(last.createdAt).getTime();
  return { active: ageMs <= seconds * 1000, last };
}

function recentVisionImageMessages(db, event, minutes = 10) {
  const cutoff = Date.now() - minutes * 60_000;
  const currentId = String(event.messageId || '');
  const sameGroupImages = (db.messages || [])
    .filter((message) => {
      if (String(message.groupId) !== String(event.groupId)) return false;
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

function shouldUseRecentVisionImage(db, event) {
  if (!modelSupportsVision(db) || event.images?.length) return false;
  const text = event.text || '';
  if (asksToInspectVisual(text)) return true;
  if (!looksLikeVisualFollowup(text)) return false;
  const mentioned = mentionsBot(text, db.settings);
  const botConversation = recentBotConversation(db, event.groupId, 180);
  return mentioned || botConversation.active;
}

function recentLlmGateCalls(db, groupId, minutes = 60) {
  const since = Date.now() - minutes * 60_000;
  return (db.usageEvents || []).filter((event) =>
    event.kind === 'reply-gate' &&
    String(event.groupId || '') === String(groupId || '') &&
    new Date(event.createdAt || 0).getTime() >= since
  ).length;
}

function recordLlmGateUsage({ groupId, userId, result, error, verdict, threshold }) {
  updateDb((draft) => {
    draft.usageEvents ||= [];
    const usage = result?.usage || {};
    if (result) {
      draft.usage.totalTokens += usage.total_tokens || 0;
      draft.usage.promptTokens += usage.prompt_tokens || 0;
      draft.usage.completionTokens += usage.completion_tokens || 0;
      draft.usage.requests += 1;
    } else {
      draft.usage.errors += 1;
    }
    draft.usageEvents.push({
      id: crypto.randomUUID(),
      kind: 'reply-gate',
      groupId,
      userId,
      model: result?.model || draft.settings.model,
      provider: result?.provider || draft.settings.llmProvider,
      totalTokens: usage.total_tokens || 0,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      latencyMs: result?.latencyMs || 0,
      gateScore: verdict?.score,
      gateReason: verdict?.reason || '',
      gateThreshold: threshold,
      gateDecision: Number.isFinite(verdict?.score) ? (verdict.score >= threshold ? 'reply' : 'silent') : 'invalid',
      gateRaw: verdict?.raw || '',
      error: error ? String(error).slice(0, 180) : '',
      createdAt: nowIso()
    });
    draft.usageEvents = draft.usageEvents.slice(-5000);
  });
}

function cleanGateMessage(value, marksOtherMention = false) {
  const raw = String(value || '');
  const hasAt = /\[CQ:at,qq=[^\]]+\]/i.test(raw);
  const cleaned = textWithoutControlPlaceholders(raw)
    .replace(/\[CQ:(?:markdown|json|xml|forward)[^\]]*\]/gi, ' ')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return marksOtherMention && hasAt ? `（这条消息提及了其他群友）${cleaned}` : cleaned;
}

function parseGateVerdict(value) {
  const raw = String(value || '').trim().slice(0, 240);
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      const score = Math.max(0, Math.min(100, Number(parsed.score)));
      if (Number.isFinite(score)) {
        return { score, reason: String(parsed.reason || '模型未说明理由').slice(0, 40), raw };
      }
    }
  } catch { /* fall through to tolerant parsing */ }
  const lineScore = unfenced.match(/SCORE\s*=\s*(\d{1,3})/i);
  if (lineScore) {
    const lineReason = unfenced.match(/REASON\s*=\s*([^\r\n]+)/i);
    return {
      score: Math.max(0, Math.min(100, Number(lineScore[1]))),
      reason: String(lineReason?.[1] || '模型未说明理由').slice(0, 40),
      raw
    };
  }
  const scoreMatch = unfenced.match(/(?:score|分数|意愿)\D{0,8}(\d{1,3})/i);
  if (scoreMatch) {
    return { score: Math.max(0, Math.min(100, Number(scoreMatch[1]))), reason: '从非标准输出提取分数', raw };
  }
  if (/^不回/.test(unfenced)) return { score: 0, reason: '模型明确选择不回复', raw };
  if (/^回/.test(unfenced)) return { score: 100, reason: '模型明确选择回复', raw };
  return { score: null, reason: '模型没有给出可识别分数', raw };
}

// LLM reply gate: replaces Math.random() dice in light/natural modes. Calls
// are metered like normal completions and may be capped per group per hour.
async function llmReplyGate(db, groupId, text, { mode, question, chatIsBusy, recentBotReplies10m, userPolicy, userId }) {
  const hourlyLimit = Math.max(0, Number(db.settings.llmReplyGateMaxPerHour || 0));
  if (hourlyLimit > 0 && recentLlmGateCalls(db, groupId) >= hourlyLimit) {
    return { shouldReply: false, reason: `LLM 门控已达到每小时 ${hourlyLimit} 次上限` };
  }
  const recentMessages = (db.messages || [])
    .filter(m => String(m.groupId) === String(groupId) && m.role === 'user')
    .slice(-8)
    .map((message) => ({ ...message, gateText: cleanGateMessage(message.content) }))
    .filter((message) => message.gateText)
    .slice(-5);

  const contextLines = recentMessages.map(m =>
    `${m.nickname || m.userId}: ${m.gateText.slice(0, 120)}`
  ).join('\n');
  const latestText = cleanGateMessage(text, true) || '（无有效文字）';
  const threshold = mode === 'light'
    ? Math.max(0, Math.min(100, Number(db.settings.llmReplyGateLightThreshold ?? 70)))
    : Math.max(0, Math.min(100, Number(db.settings.llmReplyGateNaturalThreshold ?? 45)));

  const senderNote = userPolicy?.policy === 'trusted' ? '\n发消息的人是群里的信任成员。' :
    userPolicy?.policy === 'priority' ? '\n发消息的人是重点关注对象。' : '';

  const busyNote = chatIsBusy ? '\n注意：当前群聊很活跃，请慎重接话。' : '';
  const fatigueNote = recentBotReplies10m >= 3 ? '\n你近期已经说了不少话，不要每条都接。' : '';
  const questionNote = question ? '\n这条消息看起来是个问题。' : '';

  const prompt = [
    '你是QQ群里的一名普通群友。请判断是否值得主动接上最新一句话。机器人已经通过硬性安全和频率检查，现在只需要判断聊天价值。',
    '',
    `当前参与模式：${mode === 'light' ? '轻度参与（更克制）' : '自然群友（可以主动参与）'}`,
    `系统会在分数达到 ${threshold} 时回复。请诚实评分，不要为了“谨慎”习惯性给低分。`,
    '',
    '评分参考：',
    '- 85-100：明确向大家提问、邀请回应、需要安慰或非常适合接梗',
    '- 60-84：有清晰话题、观点、经历或玩笑，你能自然贡献一句',
    '- 40-59：普通闲聊但仍有可接内容；自然群友模式下可以参与',
    '- 20-39：明显主要说给另一位群友、片段信息、接话价值较低',
    '- 0-19：纯指令、机器内容、无意义灌水、话题已结束',
    '- 没有 @ 机器人不是扣分理由；主动接话本来就是本次判断的目的',
    '- 提及其他群友只说明主要对象可能不是你，不代表绝对不能参与；结合内容判断',
    '',
    '最近聊天记录：',
    contextLines || '（没有更多上下文）',
    '',
    `最新消息：${latestText}`,
    senderNote,
    busyNote,
    fatigueNote,
    questionNote,
    '',
    '必须先输出分数，严格使用两行纯文本，不要 Markdown：',
    'SCORE=0到100的整数',
    'REASON=不超过20个字的理由'
  ].join('\n');

  // Resolve effective settings to check whether an API key is configured before
  // even attempting the call. Without this, every gate attempt would fail
  // silently with the user seeing only "LLM 门控调用失败" in decision logs.
  const resolvedSettings = activateModelProfile(db.settings, db.settings.model);
  const hasApiKey = String(resolvedSettings.apiKey || db.settings.apiKey || '').trim().length > 0;
  if (!hasApiKey) {
    return { shouldReply: false, reason: 'LLM 门控跳过（API Key 未配置）' };
  }

  try {
    const result = await completeChat(db, {
      messages: [{ role: 'user', content: prompt }],
      // Reasoning models may spend the first part of max_tokens internally and
      // otherwise return empty content. Keep enough room for a visible score.
      maxTokens: 512,
      temperature: 0.2,
      timeoutMs: 15_000,
      label: 'LLM门控'
    });
    const verdict = parseGateVerdict(result.text);
    recordLlmGateUsage({ groupId, userId, result, verdict, threshold });
    if (!Number.isFinite(verdict.score)) {
      return { shouldReply: false, reason: `LLM 门控输出无效：${verdict.reason}` };
    }
    const reason = `LLM 门控 ${verdict.score}/${threshold}：${verdict.reason}`;
    return { shouldReply: verdict.score >= threshold, reason };
  } catch (error) {
    const detail = String(error?.message || error?.code || error).slice(0, 100);
    recordLlmGateUsage({ groupId, userId, error: detail, threshold });
    return { shouldReply: false, reason: `LLM 门控失败：${detail}` };
  }
}

export async function decideReply({ db, group, userPolicy, text, mentioned, userId, images = [] }) {
  // This is the main "should the bot speak?" gate. Keep cheap deterministic
  // checks first; only call the configured LLM after this returns shouldReply=true.
  if (db.settings.globalPaused) return { shouldReply: false, reason: '机器人处于全局暂停状态' };
  if (!group?.enabled) return { shouldReply: false, reason: '这个群没有启用机器人' };
  if (userPolicy.policy === 'blocked') return { shouldReply: false, reason: '该用户在黑名单中', inContext: false };
  if (group.mode === 'silent') return { shouldReply: false, reason: '当前群是静默模式' };
  if (db.settings.onlyMentionMode && !mentioned) return { shouldReply: false, reason: '全局设置为只在 @ 时回复' };
  const visionCapable = modelSupportsVision(db);
  const hasVisionImages = visionCapable && Array.isArray(images) && images.length > 0;
  if (text.length < 1) return { shouldReply: false, reason: '空消息或无法识别的消息' };
  if (!textWithoutControlPlaceholders(text)) {
    if (hasVisionImages && mentioned) return { shouldReply: true, reason: '用户 @ 机器人并发送图片，交给视觉模型回答' };
    return { shouldReply: false, reason: '只有 @/媒体/卡片占位，没有可回复的文字', inContext: false };
  }
  if (onlyVisualMessage(text)) {
    if (hasVisionImages && mentioned) return { shouldReply: true, reason: '用户 @ 机器人并发送纯图片，交给视觉模型回答' };
    return { shouldReply: false, reason: visionCapable ? '纯图片或表情包消息，默认不抢话' : '图片或表情包消息，当前默认忽略', inContext: false };
  }
  if (asksToInspectVisual(text)) {
    if (visionCapable) return { shouldReply: true, reason: '用户要求看图，交给模型按当前视觉能力回答' };
    return { shouldReply: true, reason: '用户要求看图或识别表情包，需要解释当前不支持视觉识别', visualLimitation: true };
  }

  const privilegedMention =
    mentioned &&
    (userPolicy.policy === 'owner' || userPolicy.policy === 'admin' || userPolicy.allowCommands);

  // Owner/admin mentions are allowed to bypass rate/cooldown limits. Ordinary
  // group members still respect maxPerHour and cooldownSec.
  const maxPerHour = Number(group.maxPerHour || 20);
  if (!privilegedMention && countRecentReplies(db, group.groupId, 60) >= maxPerHour) {
    return { shouldReply: false, reason: `已达到每小时最多 ${maxPerHour} 次回复` };
  }

  const cooldownMs = Number(group.cooldownSec || 30) * 1000;
  const inCooldown = Date.now() - lastAssistantAt(db, group.groupId) < cooldownMs;
  if (privilegedMention) return { shouldReply: true, reason: 'owner/admin @ 机器人，绕过频率限制' };
  if (mentioned) return { shouldReply: true, reason: '有人 @ 或叫到了机器人' };
  if (userPolicy.policy === 'muted') return { shouldReply: false, reason: '该用户被设置为少回应' };
  const convWindow = trustInteractionBonus(db, userId).conversationWindowSec;
  const botConversation = recentBotConversation(db, group.groupId, convWindow);
  if (botConversation.active && looksLikeReplyToBot(text)) {
    return { shouldReply: true, reason: '识别到用户在接机器人上一句' };
  }
  if (botConversation.active && isPrivilegedForConversation(userPolicy) && !text.startsWith('/') && (isQuestion(text) || looksLikeReplyToBot(text))) {
    return { shouldReply: true, reason: 'owner/admin/重点关注对象正在连续对话' };
  }
  if (group.mode === 'mention') return { shouldReply: false, reason: '当前群只在 @ 时回复' };
  if (inCooldown) return { shouldReply: false, reason: '距离上次发言太近，正在冷却' };

  if (group.mode === 'light' || group.mode === 'natural') {
    const recentBotReplies10m = countRecentReplies(db, group.groupId, 10);
    const recentUserMessages5m = countRecentUserMessages(db, group.groupId, 5);
    const question = isQuestion(text);
    const chatIsBusy = recentUserMessages5m >= 10;
    return await llmReplyGate(db, group.groupId, text, { mode: group.mode, question, chatIsBusy, recentBotReplies10m, userPolicy, userId });
  }

  return { shouldReply: false, reason: '这条消息没有达到当前主动性阈值' };
}

export function oneBotToInternal(event) {
  // Internal event shape used by the bot engine. Keep fields stringified because
  // QQ ids can exceed safe integer habits and are easier to compare as strings.
  const text = normalizeMessage(event.raw_message || event.message);
  let images = extractImageInputs(event.message || event.raw_message);
  const replyMessageId = extractReplyMessageId(event.message || event.raw_message);

  // If the user quoted a message, try to include images from the quoted message.
  // This handles: user replies to an image message and @bots.
  if (replyMessageId && images.length === 0) {
    try {
      const db = readDb();
      const quoted = db.messages.find((m) => String(m.id) === replyMessageId);
      if (quoted?.media?.images?.length) {
        images = quoted.media.images;
      }
    } catch { /* DB read failure is non-fatal */ }
  }

  return {
    source: 'onebot',
    type: event.message_type || 'group',
    messageId: String(event.message_id || crypto.randomUUID()),
    groupId: event.group_id ? String(event.group_id) : 'private',
    userId: String(event.user_id || ''),
    nickname: event.sender?.card || event.sender?.nickname || String(event.user_id || ''),
    text,
    images,
    replyMessageId,
    senderRole: event.sender?.role || 'member',
    atTargets: extractAtTargets(event.message || event.raw_message),
    raw: event
  };
}

export async function processIncoming(event, sendMessage = undefined, queuedDecision = undefined, isFromDrain = false) {
  // High-level pipeline:
  // 1. Ignore self messages and route slash commands.
  // 2. Log the incoming message and decide whether to reply.
  // 3. Handle deterministic visual-limitation replies (bot genuinely cannot see images).
  // 4. Call the configured LLM (with optional provider search), sanitize/rewrite, send, record usage.
  // Identity/model questions are handled by the model via the runtime-injected system prompt.
  // A queued message was already claimed when it first entered the pipeline.
  if (!isFromDrain && !claimInboundEvent(event)) {
    return { replied: false, reason: '忽略重复投递的 OneBot message_id', duplicate: true };
  }

  const db = readDb();
  const settings = db.settings;
  if (settings.selfQq && String(event.userId) === String(settings.selfQq)) {
    return { replied: false, reason: '忽略机器人自己的消息' };
  }

  const isPrivateOwner = event.type === 'private' && settings.ownerQq && String(event.userId) === String(settings.ownerQq);
  if (isPrivateOwner && event.text.startsWith('/')) {
    return handleOwnerCommand(event, sendMessage);
  }

  const isGroupOwner = event.type === 'group' && settings.ownerQq && String(event.userId) === String(settings.ownerQq);
  const groupUserPolicy = getUserPolicy(db, event.groupId, event.userId);
  const adminRoleLevel = commandRoleLevel(db, 'admin');
  const groupCommandRoleLevel = commandRoleLevel(db, userCommandRoleId(db, groupUserPolicy, { isOwner: isGroupOwner, isAdmin: false }));
  // Group admin: manually set OR auto-detected from OneBot sender.role
  const isGroupAdmin = event.type === 'group' && (
    groupUserPolicy.policy === 'admin' ||
    groupUserPolicy.allowCommands ||
    groupCommandRoleLevel >= adminRoleLevel ||
    event.senderRole === 'owner' ||
    event.senderRole === 'admin'
  );

  // All /w and /wuxin commands should be handled as commands even when the
  // sender has no permission. Otherwise a denied command could fall through
  // into normal chat and be answered by the model.
  const isWuxinCommandText = /^\/w(uxin)?(?:\s|$)/i.test(event.text);
  if (event.type === 'group' && looksLikeExternalBotSender(event, settings) && !isGroupOwner) {
    const reason = '忽略疑似其他机器人账号的消息';
    updateDb((draft) => {
      draft.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        type: event.type,
        groupId: event.groupId,
        userId: event.userId,
        nickname: event.nickname,
        content: event.text,
        media: event.images?.length ? { images: event.images } : undefined,
        inContext: false,
        createdAt: nowIso()
      });
      draft.decisions.push({
        id: crypto.randomUUID(),
        messageId: event.messageId,
        groupId: event.groupId,
        userId: event.userId,
        shouldReply: false,
        reason,
        createdAt: nowIso()
      });
    });
    return { replied: false, reason };
  }

  if (event.type === 'group' && isWuxinCommandText) {
    return handleOwnerCommand(event, sendMessage, { isOwner: isGroupOwner, isAdmin: isGroupAdmin });
  }

  const group = getGroup(db, event.groupId);
  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  const mentioned = mentionsBot(event.text, settings);
  const decision = event.type === 'private'
    ? { shouldReply: String(event.userId) === String(settings.ownerQq || event.userId), reason: '私聊消息' }
    : await decideReply({ db, group, userPolicy, text: event.text, mentioned, userId: event.userId, images: event.images || [] });

  updateDb((draft) => {
    draft.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      type: event.type,
      groupId: event.groupId,
      userId: event.userId,
      nickname: event.nickname,
      content: event.text,
      media: event.images?.length ? { images: event.images } : undefined,
      inContext: decision.inContext !== false,
      createdAt: nowIso()
    });
    draft.decisions.push({
      id: crypto.randomUUID(),
      messageId: event.messageId,
      groupId: event.groupId,
      userId: event.userId,
      shouldReply: decision.shouldReply,
      reason: decision.reason,
      createdAt: nowIso()
    });
  });

  const memoryRecord = recordMemoryObservation(event, userPolicy);
  if (memoryRecord.shouldUpdate) {
    void maybeUpdateMemoryProfile(event);
  } else {
    maybeSweepDueMemoryProfiles(event);
  }
  if (event.images?.length) {
    void maybeRecordImageMemorySummary(event, userPolicy);
  }

  // Group profile auto-update: increment pending counter, trigger if threshold reached
  if (event.type === 'group' && event.groupId && event.groupId !== 'private') {
    incrementGroupProfilePending(db, event.groupId, event.text);
    const xpResult = processXpGain(event, db);
    incrementPairPending(db, event.groupId, event.userId);

    // Level-up congratulations
    if (xpResult.levelUp && sendMessage && db.settings.levelUpNotifyEnabled !== false) {
      const newInfo = getLevelInfo(xpResult.newLevel);
      const features = getUnlockedFeatures(xpResult.newLevel);
      const featureText = features.length ? `解锁：${features[features.length - 1]}` : '';
      // Fire-and-forget: don't block the main reply
      void (async () => {
        try {
          const congratsPrompt = `用户 ${event.nickname} 从 Lv.${xpResult.oldLevel} 升级到 ${newInfo.emoji} ${newInfo.title}（Lv.${newInfo.level}）。${featureText}。写一句简短的群内恭喜，15字以内，轻松活泼，不要重复。`;
          const { completeChat } = await import('./bot/llm.js');
          const resp = await completeChat(readDb(), { messages: [{ role: 'user', content: congratsPrompt }], temperature: 0.8, maxTokens: 50, label: '升级恭喜' });
          const congratsText = resp.text?.trim() || `🎉 恭喜 ${event.nickname} 升级为 ${newInfo.emoji} ${newInfo.title}！`;
          await sendMessage(event, congratsText);
        } catch { /* non-fatal */ }
      })();
    }
  }

  if (!decision.shouldReply) return { replied: false, reason: decision.reason };

  if (decision.visualLimitation) {
    const replyText = visualLimitationReply(event, db);
    const segments = await sendReplySegments(sendMessage, event, replyText);
    updateDb((draft) => {
      draft.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        type: event.type,
        groupId: event.groupId,
        userId: 'bot',
        nickname: '机器人',
        content: replyText,
        inContext: true,
        createdAt: nowIso()
      });
      draft.usage.replies += Math.max(1, segments.length);
    });
    return { replied: true, text: replyText, segments, reason: decision.reason };
  }

  const replyLockKey = event.type === 'group' ? `group:${event.groupId}` : `private:${event.userId}`;
  const queueState = getQueueState(replyLockKey);
  if (!isFromDrain && queueState.locked) {
    if (queueState.queue.length >= REPLY_QUEUE_LIMIT) {
      const reason = `回复队列已满(${REPLY_QUEUE_LIMIT})，丢弃`;
      updateDb((draft) => {
        draft.decisions.push({
          id: crypto.randomUUID(),
          messageId: event.messageId,
          groupId: event.groupId,
          userId: event.userId,
          shouldReply: false,
          reason,
          createdAt: nowIso()
        });
      });
      return { replied: false, reason };
    }
    const reason = '已有回复正在生成，加入队列等待';
    updateDb((draft) => {
      draft.decisions.push({
        id: crypto.randomUUID(),
        messageId: event.messageId,
        groupId: event.groupId,
        userId: event.userId,
        shouldReply: false,
        reason,
        createdAt: nowIso()
      });
    });
    queueState.queue.push({ event, sendMessage, decision, enqueuedAt: Date.now() });
    return { replied: false, reason, queued: true, queuePosition: queueState.queue.length };
  }
  queueState.locked = true;

  let thinkingTimer = null;
  try {
    const liveDb = readDb();
    const liveGroup = getGroup(liveDb, event.groupId) || { groupId: event.groupId, name: '私聊' };
    const liveUserPolicy = getUserPolicy(liveDb, event.groupId, event.userId);
    const messages = buildPrompt(liveDb, liveGroup, event, liveUserPolicy);
    const responseOptions = responseOptionsFor(event, liveDb, liveUserPolicy);
    const explicitSearch = asksForExplicitSearch(event.text);
    // osu! data queries use their own deterministic routing. Don't let the
    // generic "查/搜" search keyword match eat them before tool availability
    // is checked — the requiredTool path handles data retrieval directly.
    const osuDataIntent = detectRequiredOsuTool(event.text);
    const registryHere = loadRegistry(liveDb);
    const namedBotRequest = detectNamedBotRequest(event.text, registryHere.bots || []);
    const bpTypeAnalysis = detectBpTypeAnalysisIntent(event.text);

    // ── BP type analysis guard ──
    // "分析我的bp类型" needs real beatmap classification (osu!oracle on Top100),
    // which is not wired into natural language yet. Reply honestly instead of
    // letting the LLM fabricate proportions from PP+ dimensions.
    if (bpTypeAnalysis && !osuDataIntent) {
      const replyText = 'BP 谱面类型分析需要 osu!oracle 对 Top100 的真实分类，这项自然语言分析能力还没接入。可以用 /w osu analyze 生成带真实分类的完整分析。';
      if (sendMessage) await sendMessage(event, replyText);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      await drainReplyQueue(replyLockKey);
      return { replied: true, text: replyText, reason: 'bp_type_analysis_not_integrated' };
    }

    // ── Named-bot invocation guard ──
    // User explicitly names a bot to do something (用猫猫查…、调用LazyBot). Without
    // a real Harness adapter we must NOT impersonate the bot via query_osu and must
    // NOT run a web search. Reply honestly exactly once.
    if (namedBotRequest && !osuDataIntent) {
      const replyText = `${namedBotRequest.botName}目前没有接入 Harness 的真实调用通道。无心内部 osu! 查询可以提供类似数据。`;
      if (sendMessage) await sendMessage(event, replyText);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      await drainReplyQueue(replyLockKey);
      return { replied: true, text: replyText, reason: 'named_bot_no_adapter' };
    }

    // Real search: if explicitly requested, run searchWeb and inject results
    if (explicitSearch && !osuDataIntent && !namedBotRequest && !isSearchAvailable(liveDb)) {
      // Search requested but no real provider configured — don't let LLM fake it
      const replyText = '当前还没有接入真实联网搜索源。可以在控制台「模型」页配置 SearXNG 或其他搜索服务。';
      if (sendMessage) await sendMessage(event, replyText);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      await drainReplyQueue(replyLockKey);
      return { replied: true, text: replyText, reason: '搜索请求但未接入真实搜索源' };
    }

    let searchBlock = '';
    if (explicitSearch && !osuDataIntent && !namedBotRequest && isSearchAvailable(liveDb)) {
      const searchQuery = extractSearchQuery(event.text);
      if (!searchQuery || searchQuery.length < 2) {
        const replyText = '你想让我搜什么？给我一个关键词或问题就行。';
        if (sendMessage) await sendMessage(event, replyText);
        updateDb((draft) => {
          draft.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            type: event.type,
            groupId: event.groupId,
            userId: 'bot',
            nickname: '机器人',
            content: replyText,
            inContext: true,
            createdAt: nowIso()
          });
          draft.usage.replies += 1;
        });
        await drainReplyQueue(replyLockKey);
        return { replied: true, text: replyText, reason: '搜索请求缺少关键词' };
      }
      if (sendMessage) await sendMessage(event, `正在搜索：${searchQuery.slice(0, 60)}…`);
      const searchResult = await searchWeb(liveDb, searchQuery);
      if (searchResult.ok && searchResult.results.length > 0) {
        searchBlock = `【搜索结果】\n${formatSearchResults(searchResult.results)}\n\n请基于以上搜索结果回答，不确定就说没查到。`;
        messages[messages.length - 1].content += '\n\n' + searchBlock;
      } else {
        const detail = searchResult.error ? `原因：${searchResult.error}` : '没有拿到可用结果';
        const replyText = `我这次没有搜到可靠结果，先不硬编。${detail}`;
        if (sendMessage) await sendMessage(event, replyText);
        updateDb((draft) => {
          draft.messages.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            type: event.type,
            groupId: event.groupId,
            userId: 'bot',
            nickname: '机器人',
            content: replyText,
            inContext: true,
            createdAt: nowIso()
          });
          draft.usage.replies += 1;
        });
        await drainReplyQueue(replyLockKey);
        return { replied: true, text: replyText, reason: '搜索失败或无结果' };
      }
    }
    const searchMode = responseOptions.searchMode;
    // Always offer tools when bots are enabled — the LLM decides when to use them
    const useTools = enabledBots(loadRegistry(liveDb)).length > 0;

    // Thinking notice — configurable per thinkingNoticeMode
    const thinkingMode = useTools ? 'off' : (liveDb.settings.thinkingNoticeMode || 'slow');
    const thinkingDelay = Number(liveDb.settings.thinkingNoticeDelayMs || 3000);
    let thinkingSent = false;

    const sendThinking = async (text) => {
      if (thinkingSent || !sendMessage) return;
      thinkingSent = true;
      await sendMessage(event, text);
    };

    if (thinkingMode === 'simple') {
      await sendThinking('正在思考…');
    } else if (thinkingMode === 'detail') {
      const modelHint = responseOptions.overrideModel && responseOptions.overrideModel !== liveDb.settings.model
        ? describeModel(responseOptions.overrideModel)
        : describeModel(liveDb.settings.model);
      await sendThinking(`深度思考中（${modelHint}）…`);
    } else if (thinkingMode === 'slow') {
      thinkingTimer = setTimeout(() => sendThinking('正在进行思考…'), thinkingDelay);
    }
    // 'off' — never send

    // If user asks to look at images but none attached, attach only the most
    // recent relevant image. This keeps vision on-demand and avoids paying for
    // every image posted in an active group.
    let visionImages = modelSupportsVision(liveDb) ? (event.images || []) : [];
    if (visionImages.length === 0 && shouldUseRecentVisionImage(liveDb, event)) {
      const contextImages = recentVisionImageMessages(liveDb, event, 10);
      if (contextImages.length > 0) {
        visionImages = contextImages[0].media.images.slice(0, 1);
      }
    }

    // ── osu! data intent with no tools available ──
    // osuDataIntent is computed above (before search interception). If the user
    // is clearly asking for osu! data but no bots are enabled, fail explicitly
    // instead of falling through to the LLM with no tool access.
    if (osuDataIntent && !useTools) {
      const errorText = '[系统] osu! 数据查询不可用：当前没有已启用的机器人，无法查询 osu! 数据。';
      if (sendMessage) await sendMessage(event, errorText);
      updateDb((draft) => {
        draft.messages.push({
          id: crypto.randomUUID(), role: 'assistant', type: event.type,
          groupId: event.groupId, userId: 'bot', nickname: '机器人',
          content: errorText, inContext: true, createdAt: nowIso()
        });
        draft.usage.replies += 1;
      });
      await drainReplyQueue(replyLockKey);
      return { replied: true, text: errorText, reason: 'osu_intent_no_bots' };
    }

    // ── Bot harness tool loop ──
    let ai;
    let toolImages = [];
    let toolDirectContent = '';
    if (useTools) {
      const registry = loadRegistry(liveDb);
      const tools = buildBotToolSchemas(registry);
      // Add tool availability note to system prompt
      if (messages[0]?.role === 'system') {
        messages[0].content += '\n\n【可用工具】你可以调用 query_osu 获取真实 osu! 数据（BP、最近成绩、玩家信息、PP+ 等）。数据来自 osu! API v2 和 PP+ 服务，不是你凭记忆编造的。涉及 osu! 数据时必须调用工具，不准用聊天记录或上下文中的旧数据。当玩家问"我是谁"等身份问题时也必须调工具查绑定。日常闲聊不需要使用工具。如果玩家问的是分析/判断类问题（为什么偏科、怎么提升），也需要先查数据再做分析。涉及 BP 谱面类型或占比（串图/跳图比例、bp 类型）的分析，在拿到真实分类数据之前不得给出比例或确定性结论——要直接说明该能力尚未接入。注意：雨沐/猫猫/消防栓/LazyBot 是 QQ 群里的独立机器人，不是你可以调用的工具——你应该用 query_osu 获取数据。';
      }

      // ── Deterministic osu! data routing ──
      // When the user's intent is an unambiguous data lookup, we execute the
      // tool before the LLM sees the context. This prevents context poisoning
      // where repeated queries cause the model to skip tool calls.
      let requiredTool: { toolName: string; args: Record<string, unknown> } | undefined;
      if (osuDataIntent) {
        const internalBotsEnabled = enabledBots(registry).some((b) => b.channel === 'internal');
        const opValid = validateOperation({
          type: 'query_osu',
          params: osuDataIntent.args,
        });
        if (internalBotsEnabled && opValid.ok) {
          requiredTool = osuDataIntent;
        } else {
          const reason = !internalBotsEnabled
            ? '内部 osu! 工具未启用'
            : `操作被安全策略拒绝: ${(opValid as any).reason || '未知原因'}`;
          const errorText = `[系统] osu! 数据查询不可用：${reason}`;
          if (sendMessage) await sendMessage(event, errorText);
          updateDb((draft) => {
            draft.messages.push({
              id: crypto.randomUUID(), role: 'assistant', type: event.type,
              groupId: event.groupId, userId: 'bot', nickname: '机器人',
              content: errorText, inContext: true, createdAt: nowIso()
            });
            draft.usage.replies += 1;
          });
          await drainReplyQueue(replyLockKey);
          return { replied: true, text: errorText, reason };
        }
      }

      const toolResult = await runToolLoop(
        (db, opts) => completeChat(db, {
          ...opts,
          searchMode,
          visionImages,
          label: opts.label || 'Bot Harness'
        }),
        {
          db: liveDb,
          messages,
          tools,
          userId: event.userId,
          groupId: event.groupId,
          sendMessage,
          event,
          selfQq: liveDb.settings.selfQq,
          maxIterations: 4,
          temperature: responseOptions.temperature,
          maxTokens: responseOptions.maxTokens,
          model: responseOptions.overrideModel,
          label: 'Bot Harness',
          requiredTool,
        }
      );

      ai = {
        text: toolResult.text,
        usage: toolResult.usage,
        latencyMs: undefined
      };
      toolImages = toolResult.images || [];
      toolDirectContent = String(toolResult.directContent || '').trim();
    } else {
      ai = await callLLM(liveDb, messages, searchMode, {
        maxTokens: responseOptions.maxTokens,
        overrideModel: responseOptions.overrideModel,
        visionImages
      });
    }

    let replyText = sanitizeReply(ai.text, liveDb.settings);
    const imageCqCodes = toolImages.map(toolImageToCq).filter(Boolean);
    const hasDirectToolDelivery = Boolean(toolDirectContent || imageCqCodes.length > 0);
    if (hasDirectToolDelivery) {
      replyText = compactDirectToolLead(replyText, toolDirectContent, imageCqCodes.length > 0);
    } else if (!responseOptions.longForm && isWeirdReply(replyText)) {
      if (isIdentityQuestion(event.text)) {
        replyText = neutralIdentityReply(event, liveDb.settings);
      } else {
        const rewrite = await rewriteNormalReply(liveDb, replyText, event);
        replyText = sanitizeReply(rewrite.text, liveDb.settings);
        ai.usage.total_tokens = (ai.usage.total_tokens || 0) + (rewrite.usage.total_tokens || 0);
        ai.usage.prompt_tokens = (ai.usage.prompt_tokens || 0) + (rewrite.usage.prompt_tokens || 0);
        ai.usage.completion_tokens = (ai.usage.completion_tokens || 0) + (rewrite.usage.completion_tokens || 0);
        // Identity confusion fallback: if rewrite still contains self-negation
        if (isWeirdReply(replyText) && /(没有|没)回应.*(at|@)|(at|@).*(不是.*自己|其他|别人|群友)|不该.*回复|不该.*回应/.test(replyText)) {
          replyText = '我在，刚才识别有点乱。你刚刚是在叫我，对吧？';
        }
      }
    }
    if (!replyText && imageCqCodes.length === 0) throw new Error('模型返回了空内容。');
    if (!replyText) replyText = imageCqCodes.length > 0 ? '查好了，结果在图里。' : '查好了。';
    const deliveredText = [replyText, toolDirectContent].filter(Boolean).join('\n\n');
    const deliveredMediaImages = toolImages.map(toolImageToMediaInput).filter(Boolean);

    // Long replies (>150 chars or multi-paragraph) are sent as merged-forward
    // cards to avoid flooding the chat. Short replies stay as segmented messages.
    const newlineCount = (deliveredText.match(/\n/g) || []).length;
    const isLongReply = responseOptions.longForm || deliveredText.length > 150 || newlineCount >= 2;
    let segments;
    if (hasDirectToolDelivery) {
      // Structured tool output bypasses both the LLM restatement and the
      // three-segment/merged-forward paths. NapCat receives one complete,
      // deterministic message with any images appended structurally.
      const outboundText = [deliveredText, ...imageCqCodes].filter(Boolean).join('\n');
      if (sendMessage) await sendMessage(event, outboundText);
      segments = [outboundText];
    } else if (isLongReply && sendMessage) {
      await sendForwardText(sendMessage, event, 'Wuxin 回复', deliveredText);
      segments = [deliveredText];
    } else {
      segments = await sendReplySegments(sendMessage, event, deliveredText);
    }

    updateDb((draft) => {
      draft.messages.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        type: event.type,
        groupId: event.groupId,
        userId: 'bot',
        nickname: '机器人',
        content: deliveredText,
        media: deliveredMediaImages.length > 0 ? { images: deliveredMediaImages } : undefined,
        inContext: true,
        createdAt: nowIso()
      });
      draft.usage.totalTokens += ai.usage.total_tokens || 0;
      draft.usage.promptTokens += ai.usage.prompt_tokens || 0;
      draft.usage.completionTokens += ai.usage.completion_tokens || 0;
      draft.usage.requests += 1;
      draft.usage.replies += Math.max(1, segments.length);
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({
        id: crypto.randomUUID(),
        groupId: event.groupId,
        userId: event.userId,
        model: liveDb.settings.model,
        totalTokens: ai.usage.total_tokens || 0,
        promptTokens: ai.usage.prompt_tokens || 0,
        completionTokens: ai.usage.completion_tokens || 0,
        createdAt: nowIso()
      });
      draft.usageEvents = draft.usageEvents.slice(-5000);
    });

    return {
      replied: true,
      text: deliveredText,
      images: toolImages,
      segments,
      usage: ai.usage,
      latencyMs: ai.latencyMs,
      reason: decision.reason
    };
  } catch (error) {
    updateDb((draft) => {
      draft.usage.errors += 1;
      draft.decisions.push({
        id: crypto.randomUUID(),
        messageId: event.messageId,
        groupId: event.groupId,
        userId: event.userId,
        shouldReply: false,
        reason: `调用失败：${error.message}`,
        createdAt: nowIso()
      });
    });
    return { replied: false, error: error.message, reason: decision.reason };
  } finally {
    if (thinkingTimer) clearTimeout(thinkingTimer);
    void drainReplyQueue(replyLockKey);
  }
}

async function handleOwnerCommand(event, sendMessage = undefined, permissions = { isOwner: true, isAdmin: false }) {
  const meta = parseCommandMeta(event, permissions);
  const startedAt = Date.now();
  try {
    const result = await runOwnerCommand(event, sendMessage, permissions);
    const reason = String(result?.reason || result?.text || result?.error || '').slice(0, 800);
    const status = result?.error
      ? 'error'
        : (reason.startsWith('这个指令需要 ') || reason.includes('只有所有者可以使用'))
        ? 'denied'
        : /用法：|范围|设置失败|未知 .*指令|消息太少|不能为空|还没有添加到白名单/.test(reason)
          ? 'invalid'
          : result?.replied
            ? 'ok'
            : 'ignored';
    writeCommandLog(event, meta, {
      status,
      reason,
      errorMessage: result?.error ? String(result.error).slice(0, 1200) : '',
      latencyMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    const reply = `指令执行失败：${message}`;
    if (sendMessage) await sendMessage(event, reply);
    updateDb((draft) => {
      draft.usage.errors += 1;
    });
    writeCommandLog(event, meta, {
      status: 'error',
      reason: reply,
      errorName: error?.name || 'Error',
      errorMessage: message,
      errorStack: String(error?.stack || '').slice(0, 2000),
      latencyMs: Date.now() - startedAt
    });
    return { replied: Boolean(sendMessage), error: message, reason: reply };
  }
}

async function runOwnerCommand(event, sendMessage, permissions = { isOwner: true, isAdmin: false }) {
  // Namespaced commands use /wuxin or /w to avoid collisions with other bots.
  // Command permissions are configured in db.settings.commandPermissions.
  // Owner always bypasses permission checks; everyone else is checked by role.
  const commandDb = readDb();
  const commandUserPolicy = getUserPolicy(commandDb, event.groupId, event.userId);
  const requireCommand = async (permissionKey) => {
    if (hasCommandPermission(commandDb, commandUserPolicy, permissions, permissionKey)) return true;
    const reply = commandDeniedReply(commandDb, permissionKey);
    if (sendMessage) await sendMessage(event, reply);
    return false;
  };
  const parts = event.text.trim().split(/\s+/);
  const prefix = parts[0].toLowerCase();
  const isWuxinCommand = prefix === '/wuxin' || prefix === '/w';
  const command = isWuxinCommand ? `/${(parts[1] || '').toLowerCase()}` : prefix;
  const subCommand = isWuxinCommand ? (parts[2] || '').toLowerCase() : '';
  const commandArgs = isWuxinCommand ? parts.slice(2).join(' ') : parts.slice(1).join(' ');
  const target = (event.atTargets && event.atTargets[0]) || (isWuxinCommand ? parts[2] : parts[1]);
  const groupId = (isWuxinCommand ? parts[3] : parts[2]) || event.groupId;
  const policyMap = {
    '/op': 'admin',
    '/deop': 'normal',
    '/ban': 'blocked',
    '/unban': 'normal',
    '/trust': 'whitelist',
    '/focus': 'priority',
    '/quiet': 'muted',
    '/normal': 'normal',
    '/拉黑': 'blocked',
    '/取消拉黑': 'normal',
    '/白名单': 'whitelist',
    '/重点关注': 'priority',
    '/少回应': 'muted',
    '/正常': 'normal',
    '/设管理员': 'admin',
    '/取消管理员': 'normal'
  };

  const help = `Wuxin 指令 · 都可以简写为 /w

【成员管理】
/w op @某人 · 设为管理员
/w deop @某人 · 取消管理员
/w ban @某人 · 拉黑不回应
/w unban @某人 · 解除黑名单
/w trust @某人 · 优先回应
/w focus @某人 · 重点关注
/w quiet @某人 · 少回应
/w normal @某人 · 恢复正常

【备注与画像】
/w note @某人 内容 · 设置备注
/w note show @某人 · 查看备注
/w note clear @某人 · 清除备注
/w profile @某人 · 更新画像
/w profile show @某人 · 查看画像
/w profile samples @某人 · 画像依据
/w profile retry @某人 方向 · 按指定方向重算画像
/w profile rule @某人 规则 · 画像约束
/w profile clear @某人 · 清除画像

【人设】
/w prompt show · 查看人设摘要
/w prompt add 内容 · 追加人设
/w prompt set 内容 · 覆盖人设
/w prompt reset · 重置为基线
/w prompt savebase · 保存为基线(仅owner)

【群聊设置】
/w group add [群名] · 加群(仅owner)
/w group profile show · 查看群画像
/w group profile update · 更新群画像
/w group profile clear · 清除群画像
/w rate 数字 · 每小时回复上限
/w cooldown 秒数 · 发言冷却
/w mode silent|mention|light|natural · 回复模式
/w status · 查看群参数

【模型与搜索】
/w model 模型名 · 切换模型
/w model list · 模型列表
/w search on|off · 开关搜索
/w search status · 搜索状态
/w search fast|balanced|deep · 搜索模式
/w thinking off|simple|detail|slow [ms]|status · 思考提示
/w sysfacts on|off · 纯人设模式
/w summarize 条数 · 总结群聊

【系统】
/w preset class|away|sleep|active|silent|debug · 场景预设
/w usage · 今日用量
/w pause · 暂停
/w resume · 恢复
/w why · 最近为什么回/没回
/w my · 我的权限
/w refresh · 全局重算(仅owner)
/w recalc · 重算进度
/w ping · 检查在线
/w help · 本帮助 | /w help 成员|人设|群聊|系统 分组查看

具体权限以控制台”权限”页为准。`;

  const helpDefs = [
    { key: 'lv', group: '等级', line: '/w lv (@某人) · 查看等级经验' },
    { key: 'exp', group: '等级', line: '/w exp @某人 add/set/reset · 管理经验(仅owner)' },
    { key: 'top', group: '等级', line: '/w top · 群内排行榜' },
    { key: 'nick', group: '等级', line: '/w nick 称呼 / nick @某人 称呼 · 自定义称呼' },
    { key: 'style', group: '等级', line: '/w style 内容 / style @某人 内容 · 个人交互风格' },
    { key: 'me', group: '等级', line: '/w me · 查看 bot 对你的画像' },
    { key: 'memberPolicy', group: '成员管理', line: '/w op/deop/ban/unban/trust/focus/quiet/normal @某人 · 成员权限' },
    { key: 'note', group: '备注与画像', line: '/w note @某人 内容/show/clear · 成员备注' },
    { key: 'profile', group: '备注与画像', line: '/w profile (@某人) show/samples/retry/rule/clear · 画像管理' },
    { key: 'promptShow', group: '人设', line: '/w prompt show · 查看人设' },
    { key: 'promptEdit', group: '人设', line: '/w prompt add/set/reset · 编辑人设' },
    { key: 'promptSavebase', group: '人设', line: '/w prompt savebase · 保存基线(仅owner)' },
    { key: 'groupAdd', group: '群聊设置', line: '/w group add [群名] · 加群(仅owner)' },
    { key: 'groupProfileShow', group: '群聊设置', line: '/w group profile show · 查看群画像' },
    { key: 'groupProfileEdit', group: '群聊设置', line: '/w group profile update/clear/on/off · 群画像管理' },
    { key: 'rate', group: '群聊设置', line: '/w rate/cooldown/mode/status · 群参数' },
    { key: 'modelShow', group: '模型与搜索', line: '/w model show/list · 查看模型' },
    { key: 'modelSet', group: '模型与搜索', line: '/w model 模型名 · 切换模型' },
    { key: 'search', group: '模型与搜索', line: '/w search on/off/status/fast/balanced/deep · 搜索' },
    { key: 'thinking', group: '模型与搜索', line: '/w thinking off|simple|detail|slow [ms]|status · 思考提示' },
    { key: 'search', group: '模型与搜索', line: '/w sysfacts on/off · 纯人设模式' },
    { key: 'summarize', group: '模型与搜索', line: '/w summarize 条数 · 总结群聊' },
    { key: 'preset', group: '系统', line: '/w preset class|away|sleep|active|silent|debug · 场景预设' },
    { key: 'usage', group: '系统', line: '/w usage · 今日用量' },
    { key: 'pause', group: '系统', line: '/w pause/resume · 暂停恢复' },
    { key: 'why', group: '系统', line: '/w why · 最近为什么回/没回' },
    { key: 'osuHelp', group: 'osu!', line: '/w osu help · osu! 命令帮助' },
    { key: 'osuBind', group: 'osu!', line: '/w osu bind <用户名> · 绑定 osu! 账号' },
    { key: 'osuAnalyze', group: 'osu!', line: '/w osu analyze (@某人) · 完整玩家分析' },
    { key: 'osuRecent', group: 'osu!', line: '/w osu recent (@某人) · 近期成绩短评' },
    { key: 'help', group: '系统', line: '/w help · 本帮助 | /w help 分组名' },
    { key: 'ping', group: '系统', line: '/w ping · 检查在线' },
    { key: 'my', group: '系统', line: '/w my · 我的权限' },
    { key: 'recalc', group: '系统', line: '/w recalc · 重算进度' },
    { key: 'memberPolicy', group: '系统', line: '/w refresh · 全局重算(仅owner)' },
  ];

  function buildHelpText(db, userPolicy, perms) {
    const allowed = helpDefs.filter((d) => hasCommandPermission(db, userPolicy, perms, d.key));
    const byGroup = {};
    for (const d of allowed) {
      if (!byGroup[d.group]) byGroup[d.group] = [];
      if (!byGroup[d.group].includes(d.line)) byGroup[d.group].push(d.line);
    }
    const lines = ['Wuxin 指令 · 都可以简写为 /w · 以下是你有权限的指令'];
    for (const [group, cmds] of Object.entries(byGroup)) {
      lines.push(`\n【${group}】`);
      for (const cmd of cmds) lines.push(cmd);
    }
    lines.push('\n具体权限以控制台"权限"页为准。');
    return lines.join('\n');
  }

  if (command === '/help' && isWuxinCommand) {
    if (!(await requireCommand('help'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'help') };
    const groupFilter = subCommand;
    let text = buildHelpText(commandDb, commandUserPolicy, permissions);
    if (groupFilter) {
      const allGroups = text.split('\n\n');
      const matched = allGroups.filter((g) => g.includes(`【${groupFilter}】`));
      if (matched.length) text = matched.join('\n\n') + '\n\n具体权限以控制台"权限"页为准。';
    }
    if (sendMessage) await sendForwardText(sendMessage, event, 'Wuxin 指令帮助', text);
    return { replied: Boolean(sendMessage), reason: '显示指令帮助' };
  }

  if (command === '/help' && !isWuxinCommand) {
    return { replied: false, reason: '忽略裸 /help，避免和其他 bot 冲突' };
  }

  if (command === '/my' && isWuxinCommand) {
    const db = readDb();
    const userRoleId = userCommandRoleId(db, commandUserPolicy, { isOwner: permissions.isOwner, isAdmin: permissions.isAdmin });
    const roleName = commandRoleName(db, userRoleId);
    const roleLevel = commandRoleLevel(db, userRoleId);
    const allowed = helpDefs.filter((p) => hasCommandPermission(db, commandUserPolicy, permissions, p.key));
    const denied = helpDefs.filter((p) => !hasCommandPermission(db, commandUserPolicy, permissions, p.key));
    const byGroup = {};
    for (const p of allowed) {
      if (!byGroup[p.group]) byGroup[p.group] = [];
      if (!byGroup[p.group].includes(p.line)) byGroup[p.group].push('  ' + p.line);
    }
    const lines = [`你的身份：${roleName}（等级 ${roleLevel}）`, `QQ：${event.userId}`, '', '—— 可用指令 ——'];
    for (const [group, cmds] of Object.entries(byGroup)) { lines.push(`\n【${group}】`); lines.push(...cmds); }
    if (denied.length > 0) { lines.push('\n—— 无权限 ——'); for (const p of denied) lines.push('  ' + p.line + '（需更高权限）'); }
    if (sendMessage) await sendForwardText(sendMessage, event, '我的权限', lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: `显示 ${event.userId} 权限` };
  }

  // ── /w lv — experience level ──
  if (command === '/lv' && isWuxinCommand) {
    const db = readDb();
    const targetQq = extractAtQq(subCommand || parts[2] || '') || event.userId;
    const exp = getExperience(db, targetQq);
    const targetUser = (db.users || []).find((u) => String(u.userId) === targetQq);
    const nickname = targetUser?.nickname || targetQq;
    const isSelf = String(targetQq) === String(event.userId);
    const bar = formatXpBar(exp);
    const features = getUnlockedFeatures(exp.level);
    const lines = [bar];
    if (features.length) lines.push('已解锁: ' + features.join(' · '));
    if (exp.level >= 2) {
      const user = (db.users || []).find((u) => String(u.userId) === targetQq);
      if (user?.customName) lines.push(`称呼: ${user.customName}`);
    }
    const title = isSelf ? '我的等级' : `${nickname} 的等级`;
    if (sendMessage) await sendMessage(event, lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: title };
  }

  // ── /w top — group leaderboard ──
  if (command === '/top' && isWuxinCommand) {
    const db = readDb();
    const groupId = String(event.groupId);
    // Collect all users who have experience in this group
    const groupEntries = Object.entries(db.groupExperience || {})
      .filter(([key]) => key.startsWith(groupId + ':'))
      .map(([, v]) => v)
      .sort((a, b) => (b.xpInGroup || 0) - (a.xpInGroup || 0))
      .slice(0, 10);
    if (groupEntries.length === 0) {
      if (sendMessage) await sendMessage(event, '还没有人在本群获得经验。');
      return { replied: Boolean(sendMessage), reason: '排行榜为空' };
    }
    const lines = ['🏆 群经验排行'];
    for (let i = 0; i < groupEntries.length; i++) {
      const ge = groupEntries[i];
      const exp = getExperience(db, ge.userId);
      const info = getLevelInfo(exp.level);
      const user = (db.users || []).find((u) => String(u.userId) === ge.userId);
      const name = user?.customName || user?.nickname || ge.userId;
      const current = LEVELS.find((l) => l.level === exp.level) || LEVELS[0];
      const next = LEVELS.find((l) => l.level === exp.level + 1);
      const progress = next ? Math.round(((exp.xp - current.xp) / (next.xp - current.xp)) * 10) : 10;
      const bar = '█'.repeat(progress) + '░'.repeat(10 - progress);
      lines.push(`${i + 1}. ${info.emoji} ${name}  ${exp.xp} XP ${bar}`);
    }
    if (sendMessage) await sendForwardText(sendMessage, event, '群经验排行', lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: '显示排行榜' };
  }

  // ── /w nick — custom name ──
  if (command === '/nick' && isWuxinCommand) {
    const db = readDb();
    const parsedTarget = parseTargetAndRest(commandArgs, event, { allowNumeric: false });
    const targetQq = parsedTarget.targetQq;
    const isTargetOther = targetQq && String(targetQq) !== String(event.userId);

    if (isTargetOther && !permissions.isOwner && !permissions.isAdmin) {
      if (sendMessage) await sendMessage(event, '只有管理员可以设置他人的称呼。');
      return { replied: Boolean(sendMessage), reason: '权限不足' };
    }

    const realTarget = targetQq || event.userId;
    const exp = getExperience(db, realTarget);
    if (!isTargetOther && exp.level < 2 && !permissions.isOwner && !permissions.isAdmin) {
      if (sendMessage) await sendMessage(event, `设置称呼需要达到 Lv.2 🎯 活跃群友。你当前是 Lv.${exp.level}。`);
      return { replied: Boolean(sendMessage), reason: '等级不足' };
    }

    // Extract the name (after @mention or after /nick)
    let name = '';
    if (targetQq) {
      name = parsedTarget.rest;
    } else {
      name = commandArgs.trim();
    }

    if (name === 'clear' || name === '清除') {
      updateDb((draft) => {
        const u = (draft.users || []).find((u) => String(u.userId) === realTarget && String(u.groupId) === String(event.groupId));
        if (u) { u.customName = ''; u.updatedAt = nowIso(); }
      });
      if (sendMessage) await sendMessage(event, '称呼已清除。');
      return { replied: Boolean(sendMessage), reason: '清除称呼' };
    }

    if (!name) {
      const user = (db.users || []).find((u) => String(u.userId) === realTarget);
      const current = user?.customName;
      if (sendMessage) await sendMessage(event, current ? `当前称呼：${current}` : '还未设置称呼。用 /w nick 称呼 来设置。');
      return { replied: Boolean(sendMessage), reason: '查看称呼' };
    }

    // Content filter: basic safety
    if (name.length > 20 || name.length < 1) {
      if (sendMessage) await sendMessage(event, '称呼长度需要 1-20 个字符。');
      return { replied: Boolean(sendMessage), reason: '称呼长度不合规' };
    }

    // LLM content filter
    const nickFilter = await llmContentFilter(name, '称呼');
    if (!nickFilter.ok) {
      if (sendMessage) await sendMessage(event, `内容不合适：${nickFilter.reason}。请换一个。`);
      return { replied: Boolean(sendMessage), reason: '称呼内容被过滤' };
    }

    updateDb((draft) => {
      if (!draft.users) draft.users = [];
      let u = draft.users.find((u) => String(u.userId) === realTarget && String(u.groupId) === String(event.groupId));
      if (!u) {
        u = { groupId: String(event.groupId), userId: String(realTarget), nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, customName: name, createdAt: nowIso(), updatedAt: nowIso() };
        draft.users.push(u);
      } else {
        u.customName = name;
        u.updatedAt = nowIso();
      }
    });
    if (sendMessage) await sendMessage(event, `称呼已设置为：${name}`);
    return { replied: Boolean(sendMessage), reason: '设置称呼' };
  }

  // ── /w style — personal interaction style ──
  if (command === '/style' && isWuxinCommand) {
    const db = readDb();
    const parsedTarget = parseTargetAndRest(commandArgs, event, { allowNumeric: false });
    const targetQq = parsedTarget.targetQq;
    const isTargetOther = targetQq && String(targetQq) !== String(event.userId);

    if (isTargetOther && !permissions.isOwner && !permissions.isAdmin) {
      if (sendMessage) await sendMessage(event, '只有管理员可以设置他人的交互风格。');
      return { replied: Boolean(sendMessage), reason: '权限不足' };
    }

    const realTarget = targetQq || event.userId;
    const exp = getExperience(db, realTarget);
    if (!isTargetOther && exp.level < 3 && !permissions.isOwner && !permissions.isAdmin) {
      if (sendMessage) await sendMessage(event, `设置个人风格需要达到 Lv.3 ⭐ 老熟人。你当前是 Lv.${exp.level}。`);
      return { replied: Boolean(sendMessage), reason: '等级不足' };
    }

    let content = '';
    if (targetQq) {
      content = parsedTarget.rest;
    } else {
      content = commandArgs.trim();
    }

    if (content === 'clear' || content === '清除') {
      updateDb((draft) => {
        const u = (draft.users || []).find((u) => String(u.userId) === realTarget && String(u.groupId) === String(event.groupId));
        if (u) { u.customStyle = ''; u.updatedAt = nowIso(); }
      });
      if (sendMessage) await sendMessage(event, '个人风格已清除。');
      return { replied: Boolean(sendMessage), reason: '清除风格' };
    }

    if (!content) {
      const user = (db.users || []).find((u) => String(u.userId) === realTarget);
      const current = user?.customStyle;
      if (sendMessage) await sendMessage(event, current ? `当前个人风格：${current}` : '还未设置个人风格。用 /w style 内容 来设置。');
      return { replied: Boolean(sendMessage), reason: '查看风格' };
    }

    // Content filter: basic safety
    if (content.length > 200) {
      if (sendMessage) await sendMessage(event, '个人风格长度上限 200 字。');
      return { replied: Boolean(sendMessage), reason: '风格内容过长' };
    }

    // LLM content filter
    const styleFilter = await llmContentFilter(content, '交互风格');
    if (!styleFilter.ok) {
      if (sendMessage) await sendMessage(event, `内容不合适：${styleFilter.reason}。请修改。`);
      return { replied: Boolean(sendMessage), reason: '风格内容被过滤' };
    }

    updateDb((draft) => {
      if (!draft.users) draft.users = [];
      let u = draft.users.find((u) => String(u.userId) === realTarget && String(u.groupId) === String(event.groupId));
      if (!u) {
        u = { groupId: String(event.groupId), userId: String(realTarget), nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, customStyle: content, createdAt: nowIso(), updatedAt: nowIso() };
        draft.users.push(u);
      } else {
        u.customStyle = content;
        u.updatedAt = nowIso();
      }
    });
    if (sendMessage) await sendMessage(event, '个人风格已设置。Bot 回复你时会参考这个风格。');
    return { replied: Boolean(sendMessage), reason: '设置风格' };
  }

  // ── /w me — view own profile (Lv.3+) ──
  if (command === '/me' && isWuxinCommand) {
    const db = readDb();
    const exp = getExperience(db, event.userId);
    if (exp.level < 3 && !permissions.isOwner && !permissions.isAdmin) {
      if (sendMessage) await sendMessage(event, `查看画像需要达到 Lv.3 ⭐ 老熟人。你当前是 Lv.${exp.level}。`);
      return { replied: Boolean(sendMessage), reason: '等级不足' };
    }
    const mem = (db.memories || []).find((m) => String(m.userId) === String(event.userId));
    if (!mem) {
      if (sendMessage) await sendMessage(event, '还没有关于你的画像数据。多聊聊天就有了。');
      return { replied: Boolean(sendMessage), reason: '无画像' };
    }
    const info = getLevelInfo(exp.level);
    const lines = [
      `📋 Wuxin 眼中的你`,
      `───────────────`,
      mem.summary && `整体：${mem.summary}`,
      mem.traits && `性格：${mem.traits}`,
      mem.speechStyle && `说话：${mem.speechStyle}`,
      mem.behavior && `行为：${mem.behavior}`,
      mem.preferences && `偏好：${mem.preferences}`,
      mem.manualNotes && `备注：${mem.manualNotes}`,
      `───────────────`,
      `${info.emoji} ${info.title} · ${exp.xp} XP · 活跃 ${exp.activeDays} 天`,
    ].filter(Boolean);
    if (sendMessage) await sendForwardText(sendMessage, event, '我的画像', lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: '查看画像' };
  }

  // ── /w exp — experience control (owner only) ──
  if (command === '/exp' && isWuxinCommand) {
    if (!permissions.isOwner) {
      if (sendMessage) await sendMessage(event, '只有 bot 所有者可以使用 /w exp。');
      return { replied: Boolean(sendMessage), reason: 'exp 权限限制' };
    }
    const db = readDb();
    const parsedTarget = parseTargetAndRest(commandArgs, event);
    const targetQq = parsedTarget.targetQq;
    if (!targetQq) {
      // Show usage
      const usage = '用法：\n/w exp @某人 · 查看经验详情\n/w exp @某人 add <XP> · 增加XP\n/w exp @某人 set <XP> · 设置XP\n/w exp @某人 reset · 重置为0';
      if (sendMessage) await sendMessage(event, usage);
      return { replied: Boolean(sendMessage), reason: 'exp 用法' };
    }
    const exp = getExperience(db, targetQq);
    const info = getLevelInfo(exp.level);
    const user = (db.users || []).find((u) => String(u.userId) === targetQq);
    const nickname = user?.nickname || user?.customName || targetQq;

    // Parse subcommand after @mention
    const action = parsedTarget.rest.trim().toLowerCase();
    const actionParts = action.split(/\s+/);
    const verb = actionParts[0];
    const amount = Number(actionParts[1]);

    if (verb === 'add' && Number.isFinite(amount) && amount > 0) {
      updateDb((draft) => {
        if (!draft.experience) draft.experience = {};
        let e = draft.experience[targetQq];
        if (!e) {
          e = { xp: 0, level: 0, dailyXp: 0, dailyDate: '', activeDays: 0, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
          draft.experience[targetQq] = e;
        }
        e.xp += amount;
        // Re-evaluate level
        let newLevel = 0;
        for (let i = LEVELS.length - 1; i >= 0; i--) {
          if (e.xp >= LEVELS[i].xp) { newLevel = LEVELS[i].level; break; }
        }
        if (newLevel > e.level) { e.level = newLevel; e.lastLevelUpAt = nowIso(); }
      });
      const newExp = getExperience(readDb(), targetQq);
      const newInfo = getLevelInfo(newExp.level);
      if (sendMessage) await sendMessage(event, `已给 ${nickname} 增加 ${amount} XP → ${newExp.xp} XP ${newInfo.emoji} ${newInfo.title} Lv.${newInfo.level}`);
      return { replied: Boolean(sendMessage), reason: 'exp add' };
    }

    if (verb === 'set' && Number.isFinite(amount) && amount >= 0) {
      updateDb((draft) => {
        if (!draft.experience) draft.experience = {};
        let e = draft.experience[targetQq];
        if (!e) {
          e = { xp: 0, level: 0, dailyXp: 0, dailyDate: '', activeDays: 0, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
          draft.experience[targetQq] = e;
        }
        e.xp = amount;
        let newLevel = 0;
        for (let i = LEVELS.length - 1; i >= 0; i--) {
          if (e.xp >= LEVELS[i].xp) { newLevel = LEVELS[i].level; break; }
        }
        e.level = newLevel;
      });
      const newExp = getExperience(readDb(), targetQq);
      const newInfo = getLevelInfo(newExp.level);
      if (sendMessage) await sendMessage(event, `已将 ${nickname} 的 XP 设为 ${amount} → ${newInfo.emoji} ${newInfo.title} Lv.${newInfo.level}`);
      return { replied: Boolean(sendMessage), reason: 'exp set' };
    }

    if (verb === 'reset') {
      updateDb((draft) => {
        if (draft.experience) delete draft.experience[targetQq];
        if (draft.groupExperience) {
          for (const key of Object.keys(draft.groupExperience)) {
            if (key.endsWith(':' + targetQq)) delete draft.groupExperience[key];
          }
        }
      });
      if (sendMessage) await sendMessage(event, `已重置 ${nickname} 的全部经验数据。`);
      return { replied: Boolean(sendMessage), reason: 'exp reset' };
    }

    // Default: show info
    const bar = formatXpBar(exp);
    const features = getUnlockedFeatures(exp.level);
    const lines = [bar];
    if (features.length) lines.push('已解锁: ' + features.join(' · '));
    if (user?.customName) lines.push(`称呼: ${user.customName}`);
    if (user?.customStyle) lines.push(`风格: ${user.customStyle.slice(0, 50)}`);
    if (sendMessage) await sendMessage(event, lines.join('\n'));
    return { replied: Boolean(sendMessage), reason: 'exp 查看' };
  }

  // ── /w op — only bot owner can op ──
  if (command === '/op' && isWuxinCommand && !permissions.isOwner) {
    if (sendMessage) await sendMessage(event, '只有 bot 所有者可以使用 /w op。');
    return { replied: Boolean(sendMessage), reason: 'op 权限限制' };
  }

  if (command === '/help' && !isWuxinCommand) {
    return { replied: false, reason: '忽略裸 /help，避免和其他 bot 冲突' };
  }

  if (command === '/preset' && isWuxinCommand) {
    if (!(await requireCommand('preset'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'mode') };
    const presetName = subCommand || (parts[2] || '').toLowerCase();
    const presets = {
      class: { mode: 'silent', maxPerHour: 0, cooldownSec: 300, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: false, label: '上课/会议：完全静默，不回复' },
      away: { mode: 'silent', maxPerHour: 3, cooldownSec: 120, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: false, label: '出门/忙：极少回复，只在@时可能回' },
      sleep: { mode: 'silent', maxPerHour: 0, cooldownSec: 600, onlyMentionMode: true, groupProfileAutoUpdate: false, globalPaused: true, label: '睡觉：全局暂停' },
      active: { mode: 'natural', maxPerHour: 30, cooldownSec: 15, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '活跃聊天：自然参与，自动画像' },
      silent: { mode: 'light', maxPerHour: 10, cooldownSec: 60, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '安静挂机：轻度参与，保持画像更新' },
      debug: { mode: 'mention', maxPerHour: 60, cooldownSec: 5, onlyMentionMode: false, groupProfileAutoUpdate: true, globalPaused: false, label: '调试：高频回复，只在@模式' },
    };
    const preset = presets[presetName];
    if (!preset) {
      const list = Object.entries(presets).map(([k, v]) => `/w preset ${k} — ${v.label}`).join('\n');
      const reply = `可用预设：\n${list}`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const db = readDb();
    const group = getGroup(db, event.groupId);
    const oldMode = group?.mode || 'mention';
    const oldRate = group?.maxPerHour || 20;
    const oldCooldown = group?.cooldownSec || 30;
    updateDb((draft) => {
      const g = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
      if (g) {
        g.mode = preset.mode;
        g.maxPerHour = preset.maxPerHour;
        g.cooldownSec = preset.cooldownSec;
        g.updatedAt = nowIso();
      }
      draft.settings.onlyMentionMode = preset.onlyMentionMode;
      draft.settings.groupProfileAutoUpdate = preset.groupProfileAutoUpdate !== false;
      draft.settings.globalPaused = preset.globalPaused;
      setBotPaused(preset.globalPaused);
    });
    const reply = `已切换为「${preset.label}」\n回复模式：${oldMode} → ${preset.mode}\n每小时上限：${oldRate} → ${preset.maxPerHour}\n冷却：${oldCooldown} → ${preset.cooldownSec} 秒`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: `预设：${presetName}` };
  }

  if (command === '/why' && isWuxinCommand) {
    if (!(await requireCommand('why'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'why') };
    const db = readDb();
    const lastDecision = [...(db.decisions || [])].reverse().find((d) => String(d.groupId) === String(event.groupId));
    if (!lastDecision) { const reply = '还没有本群的回复决策记录。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
    const lastMsg = [...(db.messages || [])].reverse().find((m) => String(m.groupId) === String(event.groupId) && m.role === 'user');
    const reply = `最近一条消息：${lastMsg ? `${lastMsg.nickname || lastMsg.userId}：${(lastMsg.content || '').slice(0, 80)}` : '无'}`
      + `\n决策：${lastDecision.shouldReply ? '回复了' : '没有回复'}`
      + `\n原因：${lastDecision.reason}`
      + `\n时间：${lastDecision.createdAt ? new Date(lastDecision.createdAt).toLocaleString('zh-CN') : '未知'}`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if ((command === '/pause' || command === '/resume') && isWuxinCommand) {
    if (!(await requireCommand('pause'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'pause') };
    const pausing = command === '/pause';
    updateDb((draft) => {
      draft.settings.globalPaused = pausing;
      setBotPaused(pausing);
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: event.userId,
        action: `/wuxin ${command.slice(1)}`,
        targetUserId: 'bot',
        groupId: event.groupId,
        detail: pausing ? '暂停机器人' : '恢复机器人',
        createdAt: nowIso()
      });
    });
    const reply = pausing ? '已暂停，不再自动回复。用 /w resume 恢复。' : '已恢复，正常参与群聊。';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/prompt' && isWuxinCommand) {
    const promptText = parts.slice(3).join(' ').trim();
    if (subCommand === 'show') {
      if (!(await requireCommand('promptShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'promptShow') };
      const db = readDb();
      const prompt = db.settings.personalityPrompt || '';
      const reply = `当前完整提示词：\n${prompt}`;
      if (sendMessage) await sendForwardText(sendMessage, event, 'Wuxin 当前提示词', reply);
      return { replied: Boolean(sendMessage), reason: '显示完整提示词' };
    }

    if (subCommand === 'reset') {
      if (!(await requireCommand('promptEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'promptEdit') };
      updateDb((draft) => {
        draft.settings.personalityPrompt = draft.settings.baselinePersonalityPrompt || defaultPrompt;
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: '/wuxin prompt reset',
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: '重置提示词',
          createdAt: nowIso()
        });
      });
      const reply = '已重置提示词。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (subCommand === 'savebase') {
      if (!(await requireCommand('promptSavebase'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'promptSavebase') };
      updateDb((draft) => {
        draft.settings.baselinePersonalityPrompt = draft.settings.personalityPrompt || defaultPrompt;
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: '/wuxin prompt savebase',
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: '保存当前提示词为 reset 基线',
          createdAt: nowIso()
        });
      });
      const reply = '已把当前提示词保存为 reset 基线。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if ((subCommand === 'add' || subCommand === 'set') && !promptText) {
      if (!(await requireCommand('promptEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'promptEdit') };
      const reply = '用法：/wuxin prompt add 内容，或 /wuxin prompt set 内容';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (subCommand === 'add' || subCommand === 'set') {
      if (!(await requireCommand('promptEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'promptEdit') };
      updateDb((draft) => {
        draft.settings.personalityPrompt = subCommand === 'set'
          ? promptText
          : `${draft.settings.personalityPrompt || ''}\n\n${promptText}`.trim();
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: `/wuxin prompt ${subCommand}`,
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: promptText.slice(0, 240),
          createdAt: nowIso()
        });
      });
      const reply = subCommand === 'set' ? '已覆盖提示词。' : '已追加提示词规则。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (sendMessage) await sendMessage(event, help);
    return { replied: Boolean(sendMessage), reason: '未知 prompt 指令' };
  }

  if (command === '/relation' && isWuxinCommand) {
    const relAction = subCommand || 'show';
    const targetA = (event.atTargets && event.atTargets[0]) || parts[3];
    const targetB = (event.atTargets && event.atTargets[1]) || parts[4];
    if (!targetA || !targetB) {
      const reply = '用法：/w relation show|update|clear @某人 @某人';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (relAction === 'show') {
      if (!(await requireCommand('relationshipShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'relationshipShow') };
      const db = readDb();
      const rp = getRelationshipProfile(db, event.groupId, targetA, targetB);
      if (!rp) { const reply = '这两人还没有关系画像。用 /w relation update @A @B 生成。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
      const text = `互动风格：${rp.interactionStyle || '无'}\n共同话题：${rp.commonTopics || '无'}\n语气：${rp.tone || '无'}\nbot策略：${rp.botStrategy || '无'}\n边界：${rp.boundaries || '无'}\n置信：${Math.round((rp.confidence || 0) * 100)}% · ${rp.evidenceCount || 0}条互动`;
      if (sendMessage) await sendForwardText(sendMessage, event, '群友关系画像', text);
      return { replied: Boolean(sendMessage), reason: '显示关系画像' };
    }
    if (relAction === 'update') {
      if (!(await requireCommand('relationshipEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'relationshipEdit') };
      if (sendMessage) await sendMessage(event, '正在生成关系画像…');
      const db = readDb();
      const result = await updateRelationshipProfile(db, event.groupId, targetA, targetB);
      if (!result.ok) { const reply = `生成失败：${result.error}`; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), error: result.error, reason: reply }; }
      if (result.skipped) {
        const reply = `关系画像未保存：${result.reason || '互动证据不足'}（${result.sampleCount || 0}条有效互动）。`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      if (sendMessage) await sendMessage(event, `关系画像已更新（${result.sampleCount}条互动）。`);
      return { replied: Boolean(sendMessage), reason: '关系画像已更新' };
    }
    if (relAction === 'clear') {
      if (!(await requireCommand('relationshipEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'relationshipEdit') };
      clearRelationshipProfile(event.groupId, targetA, targetB);
      if (sendMessage) await sendMessage(event, '已清除关系画像。');
      return { replied: Boolean(sendMessage), reason: '已清除' };
    }
    const reply = '用法：/w relation show|update|clear @某人 @某人';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/group' && isWuxinCommand) {
    // /w group profile show/update/clear/on/off
    if (subCommand === 'profile') {
      const profileAction = (parts[3] || '').toLowerCase();
      const db = readDb();
      if (profileAction === 'show') {
        if (!(await requireCommand('groupProfileShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'groupProfileShow') };
        const gp = getGroupProfile(db, event.groupId);
        if (!gp) { const reply = '这个群还没有群聊画像。用 /w group profile update 生成。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
        if (!hasGroupProfileContent(gp)) {
          const pending = Number(gp.pendingMessageCount || 0);
          const failed = gp.lastUpdateStatus === 'failed' && gp.lastUpdateError ? `\n上次自动更新失败：${gp.lastUpdateError}` : '';
          const reply = `这个群还没有有效群聊画像。已累计 ${pending} 条候选消息，可以用 /w group profile update 手动生成。${failed}`;
          if (sendMessage) await sendMessage(event, reply);
          return { replied: Boolean(sendMessage), reason: reply };
        }
        const text = `启用：${gp.enabled ? '是' : '否'}\n氛围：${gp.atmosphere || '无'}\n话题：${gp.topics || '无'}\n玩笑：${gp.humorStyle || '无'}\n节奏：${gp.pace || '无'}\n边界：${gp.boundaries || '无'}\n策略：${gp.botStrategy || '无'}\n置信：${Math.round(gp.confidence * 100)}% · ${gp.evidenceCount}条依据\n更新：${gp.updatedAt ? new Date(gp.updatedAt).toLocaleString('zh-CN') : '未知'}`;
        if (sendMessage) await sendForwardText(sendMessage, event, '群聊画像', text);
        return { replied: Boolean(sendMessage), reason: '显示群聊画像' };
      }
      if (profileAction === 'update') {
        if (!(await requireCommand('groupProfileEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'groupProfileEdit') };
        if (sendMessage) await sendMessage(event, '正在生成群聊画像…');
        try {
          const result = await updateGroupProfile(db, event.groupId);
          if (!result.ok) { const reply = `群聊画像生成失败：${result.error}`; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), error: result.error, reason: reply }; }
          if (sendMessage) await sendMessage(event, `群聊画像已更新（${result.sampleCount}条消息）。用 /w group profile show 查看。`);
          return { replied: Boolean(sendMessage), reason: '群聊画像已更新' };
        } catch (error) {
          const reply = `群聊画像更新失败：${error.message}`;
          if (sendMessage) await sendMessage(event, reply);
          return { replied: Boolean(sendMessage), error: error.message, reason: reply };
        }
      }
      if (profileAction === 'clear') {
        if (!(await requireCommand('groupProfileEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'groupProfileEdit') };
        clearGroupProfile(event.groupId);
        const reply = '已清除本群的群聊画像。';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      if (profileAction === 'on' || profileAction === 'off') {
        if (!(await requireCommand('groupProfileEdit'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'groupProfileEdit') };
        updateDb((draft) => {
          if (!draft.groupProfiles) draft.groupProfiles = [];
          const gp = draft.groupProfiles.find((p) => String(p.groupId) === String(event.groupId));
          if (gp) gp.enabled = profileAction === 'on';
        });
        const reply = profileAction === 'on' ? '已启用群聊画像注入。' : '已停用群聊画像注入。';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const reply = '用法：/w group profile show|update|clear|on|off';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (subCommand !== 'add') {
      const reply = '用法：/w group add [群名] 或 /w group profile show|update|clear|on|off';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (!(permissions.isOwner || commandUserPolicy.policy === 'owner')) {
      const reply = '这个指令只有所有者可以使用。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (event.type !== 'group' || !event.groupId || event.groupId === 'private') {
      const reply = '这个指令只能在目标群聊里使用：/wuxin group add [群名]。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    const groupName = parts.slice(3).join(' ').trim() || event.raw?.group_name || event.groupName || `群聊 ${event.groupId}`;
    updateDb((draft) => {
      const existing = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
      if (existing) {
        existing.name = groupName || existing.name || event.groupId;
        existing.enabled = true;
        existing.updatedAt = nowIso();
      } else {
        draft.groups.push({
          groupId: String(event.groupId),
          name: groupName,
          enabled: true,
          mode: 'mention',
          maxPerHour: 20,
          cooldownSec: 30,
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: event.userId,
        action: '/wuxin group add',
        targetUserId: 'group',
        groupId: event.groupId,
        detail: `添加/启用活跃群聊：${groupName}`,
        createdAt: nowIso()
      });
    });

    const reply = `已将本群加入活跃群聊：${groupName}（${event.groupId}）。默认只在 @ 时回复，可用 /w mode natural 调整。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if ((command === '/rate' || command === '/cooldown' || command === '/mode' || command === '/status') && isWuxinCommand) {
    const permissionKey = {
      '/rate': 'rate',
      '/cooldown': 'cooldown',
      '/mode': 'mode',
      '/status': 'status'
    }[command];
    if (!(await requireCommand(permissionKey))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, permissionKey) };

    const db = readDb();
    const currentGroup = getGroup(db, event.groupId);
    if (!currentGroup) {
      const reply = '这个群还没有添加到白名单配置里。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (command === '/status') {
      const modeName = {
        silent: '静默',
        mention: '只在 @ 时回复',
        light: '轻度参与',
        natural: '自然群友'
      }[currentGroup.mode] || currentGroup.mode;
      const reply = `本群参数：
模式：${modeName}
每小时最多回复：${currentGroup.maxPerHour}
发言冷却：${currentGroup.cooldownSec} 秒`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: '显示群运行参数' };
    }

    let reply = '';
    updateDb((draft) => {
      const group = draft.groups.find((entry) => String(entry.groupId) === String(event.groupId));
      if (!group) return;

      if (command === '/rate') {
        const value = Number(parts[2]);
        if (!Number.isFinite(value) || value < 1 || value > 200) {
          reply = '用法：/wuxin rate 20。范围 1 到 200。';
          return;
        }
        group.maxPerHour = Math.round(value);
        reply = `已设置本群每小时最多回复 ${group.maxPerHour} 次。`;
      }

      if (command === '/cooldown') {
        const value = Number(parts[2]);
        if (!Number.isFinite(value) || value < 0 || value > 600) {
          reply = '用法：/wuxin cooldown 30。范围 0 到 600 秒。';
          return;
        }
        group.cooldownSec = Math.round(value);
        reply = `已设置本群发言冷却 ${group.cooldownSec} 秒。`;
      }

      if (command === '/mode') {
        const value = String(parts[2] || '').toLowerCase();
        const allowed = ['silent', 'mention', 'light', 'natural'];
        if (!allowed.includes(value)) {
          reply = '用法：/wuxin mode silent|mention|light|natural。';
          return;
        }
        group.mode = value;
        reply = `已设置本群回复模式为 ${value}。`;
      }

      group.updatedAt = nowIso();
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: event.userId,
        action: `/wuxin ${command.slice(1)}`,
        targetUserId: 'group',
        groupId: event.groupId,
        detail: reply,
        createdAt: nowIso()
      });
    });

    if (sendMessage) await sendMessage(event, reply || '设置失败，请检查指令格式。');
    return { replied: Boolean(sendMessage), reason: reply || '群运行参数设置失败' };
  }

  if (command === '/refresh' && isWuxinCommand) {
    if (!(await requireCommand('memberPolicy'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'memberPolicy') };
    const state = getRecalcProgress();
    if (state.running) { const reply = `正在重算中：${state.done}/${state.total}（${state.label}）`; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
    if (sendMessage) await sendMessage(event, '正在重算全部画像，稍候…');
    const db = readDb();
    const mems = (db.memories || []).filter((m) => m.enabled && (m.samples || []).filter((s) => s.usedForProfile).length >= 3);
    const gps = (db.groups || []).filter((g) => g.enabled);
    const rels = (db.relationshipProfiles || []).filter((r) => r.enabled !== false);
    const total = mems.length + gps.length + rels.length;
    startRecalc(total, 'QQ端重算');
    let pCount = 0, gCount = 0, rCount = 0;
    for (const mem of mems) {
      if (getRecalcProgress().stopped) break;
      try {
        const result = await updateMemoryProfile(readDb(), mem);
        commitMemoryProfileResult(mem.userId, result, { groupId: event.groupId, model: readDb().settings.model, kind: 'memory-recalc' });
        pCount++;
      } catch { /* skip */ }
      tickRecalc();
    }
    for (const g of gps) {
      if (getRecalcProgress().stopped) break;
      try { const r = await updateGroupProfile(readDb(), g.groupId); if (r.ok) gCount++; } catch { /* skip */ }
      tickRecalc();
    }
    for (const rp of rels) {
      if (getRecalcProgress().stopped) break;
      try {
        const r = await updateRelationshipProfile(readDb(), rp.groupId, rp.userA, rp.userB);
        if (r?.ok !== false && !r?.skipped) rCount++;
      } catch { /* skip */ }
      tickRecalc();
    }
    finishRecalc(getRecalcProgress().stopped ? 'QQ端已停止' : 'QQ端全部重算完成');
    const reply = getRecalcProgress().stopped
      ? `重算已停止。完成：个人${pCount}/群${gCount}/关系${rCount}`
      : `全部重算完成。\n个人画像：${pCount} 人\n群聊画像：${gCount} 群\n关系画像：${rCount} 对`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/recalc' && isWuxinCommand) {
    const state = getRecalcProgress();
    if (!state.running) { const reply = '当前没有正在进行的重算。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
    const pct = state.total > 0 ? Math.round(state.done / state.total * 100) : 0;
    const bar = '█'.repeat(pct / 10) + '░'.repeat(10 - pct / 10);
    const reply = `${state.label}\n[${bar}] ${pct}%\n${state.done}/${state.total} 已完成`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if ((command === '/ping' || command === '/usage' || command === '/model') && isWuxinCommand) {
    if (command === '/ping') {
      if (!(await requireCommand('ping'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'ping') };
      const reply = 'pong，我在。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (command === '/usage') {
      if (!(await requireCommand('usage'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'usage') };
      const db = readDb();
      const today = sumUsageSince(db, startOfLocalDayTime());

      // Calculate today's cost from usageEvents (per-model accurate)
      const todayStart = startOfLocalDayTime();
      const todayByModel = {};
      for (const e of (db.usageEvents || [])) {
        if (new Date(e.createdAt).getTime() < todayStart) continue;
        const m = e.model || 'unknown';
        if (!todayByModel[m]) todayByModel[m] = { prompt: 0, completion: 0, requests: 0 };
        todayByModel[m].prompt += e.promptTokens || 0;
        todayByModel[m].completion += e.completionTokens || 0;
        todayByModel[m].requests += 1;
      }
      const costLines = [];
      let totalCost = 0;
      for (const [m, data] of Object.entries(todayByModel)) {
        const p = getPricing(m);
        const cost = calcCost(data.prompt, data.completion, p);
        totalCost += cost;
        costLines.push(`${p.label}：¥${cost.toFixed(4)}（${data.requests}次）`);
      }

      const allTimeP = getPricing(db.settings.model);
      const allTimeCost = calcCost(db.usage.promptTokens || 0, db.usage.completionTokens || 0, allTimeP);

      const reply = `今日用量：
请求：${today.requests} 次 | Token：${today.totalTokens}
输入：${today.promptTokens} | 输出：${today.completionTokens}
${costLines.length > 0 ? `费用明细：\n${costLines.join('\n')}\n今日合计：¥${totalCost.toFixed(4)}` : '今日暂无费用明细'}
---
累计：${db.usage.totalTokens || 0} Token（约 ¥${allTimeCost.toFixed(2)}）
累计请求：${db.usage.requests || 0} 次`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: '显示今日 token 用量' };
    }

    if (command === '/model') {
      const arg = String(parts[2] || '').trim();
      const knownModels = [
        'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-omni', 'mimo-v2-pro',
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'
      ];
      if (!arg || arg === 'show') {
        if (!(await requireCommand('modelShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'modelShow') };
        const db = readDb();
        const reply = `当前模型：${db.settings.model}\n接口：${activeProviderLabel(db.settings)}\nAPI Key：${db.settings.apiKey ? '已配置' : '未配置'}`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: '显示当前模型' };
      }
      if (arg === 'list') {
        if (!(await requireCommand('modelShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'modelShow') };
        const reply = `可选模型：
${knownModels.join('\n')}
也可以直接填写当前接口支持的自定义模型名。`;
        if (sendMessage) await sendForwardText(sendMessage, event, 'Wuxin 模型列表', reply);
        return { replied: Boolean(sendMessage), reason: '显示模型列表' };
      }

      if (!(await requireCommand('modelSet'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'modelSet') };
      let switchedSettings;
      updateDb((draft) => {
        draft.settings = activateModelProfile(draft.settings, arg);
        switchedSettings = draft.settings;
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: '/wuxin model',
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: `模型切换为 ${arg}；接口=${activeProviderLabel(draft.settings)}`,
          createdAt: nowIso()
        });
      });
      const reply = `已切换模型：${arg}\n接口：${activeProviderLabel(switchedSettings)}${switchedSettings?.apiKey ? '' : '\n注意：该接口的 API Key 尚未配置，请到控制台“模型”页填写。'}`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
  }

  if (command === '/search' && isWuxinCommand) {
    if (!(await requireCommand('search'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'search') };

    const arg = (parts[2] || '').toLowerCase();
    if (arg === 'on' || arg === 'off') {
      updateDb((draft) => {
        draft.settings.enableWebSearch = arg === 'on';
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: `/wuxin search ${arg}`,
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: `联网搜索${arg === 'on' ? '开启' : '关闭'}`,
          createdAt: nowIso()
        });
      });
      const reply = `已${arg === 'on' ? '开启' : '关闭'}联网搜索。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (arg === 'status') {
      const db = readDb();
      const statusLine = db.settings.enableWebSearch ? '已开启' : '已关闭';
      const searchAvailable = isSearchAvailable(db);
      const lastSearch = getLastSearchStatus(db);
      const searchInfo = searchAvailable
        ? `真实搜索源：${db.settings.searchProvider} (${db.settings.searchBaseUrl})`
        : '未接入真实搜索源，显式搜索会拒绝（避免瞎编）';
      const lastLine = lastSearch
        ? `最近搜索：${lastSearch.query?.slice(0, 30)} · ${lastSearch.resultCount}条结果 · ${lastSearch.latencyMs}ms${lastSearch.error ? ' · 错误：' + lastSearch.error : ''}`
        : '暂无搜索记录';
      const reply = `联网搜索：${statusLine}，模式：${db.settings.webSearchMode || 'balanced'}。${searchInfo}。${lastLine}。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (['fast', 'balanced', 'deep'].includes(arg)) {
      updateDb((draft) => {
        draft.settings.enableWebSearch = true;
        draft.settings.webSearchMode = arg;
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: `/wuxin search ${arg}`,
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: `联网搜索模式切换为 ${arg}`,
          createdAt: nowIso()
        });
      });
      const reply = `已设置联网搜索模式为 ${arg}，并已开启搜索。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    const reply = '用法：/w search on|off|status|fast|balanced|deep';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/thinking' && isWuxinCommand) {
    if (!(await requireCommand('thinking'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'thinking') };
    const arg = (parts[2] || '').toLowerCase();
    if (arg === 'off' || arg === 'simple' || arg === 'detail') {
      updateDb((draft) => { draft.settings.thinkingNoticeMode = arg; });
      const labels = { off: '已关闭思考提示', simple: '已设为简短提示（正在思考…）', detail: '已设为详细提示（含模型名）' };
      const reply = labels[arg] || `已设为 ${arg} 模式`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (arg === 'slow') {
      const delayMs = parseInt(parts[3], 10);
      const delay = Number.isFinite(delayMs) && delayMs >= 500 ? delayMs : 3000;
      updateDb((draft) => { draft.settings.thinkingNoticeMode = 'slow'; draft.settings.thinkingNoticeDelayMs = delay; });
      const reply = `已设为慢请求提示模式，${delay}ms 内未回复才提示"正在思考…"。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (arg === 'status') {
      const db = readDb();
      const mode = db.settings.thinkingNoticeMode || 'slow';
      const delay = db.settings.thinkingNoticeDelayMs || 3000;
      const labels = { off: '关闭', simple: '简短提示', detail: '详细提示（含模型名）', slow: `慢请求提示（${delay}ms 延迟）` };
      const reply = `思考提示：${labels[mode] || mode}`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const reply = '用法：/w thinking off|simple|detail|slow [毫秒]|status。默认 slow 3000ms。例如 /w thinking slow 5000';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/sysfacts' && isWuxinCommand) {
    if (!(await requireCommand('search'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'search') };
    const arg = (parts[2] || '').toLowerCase();
    if (arg === 'on' || arg === 'off') {
      updateDb((draft) => { draft.settings.ignoreSystemFacts = arg === 'on'; });
      const reply = arg === 'on' ? '已开启纯人设模式，底层系统信息不再注入。' : '已关闭纯人设模式，底层系统信息恢复注入。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (arg === 'status') {
      const db = readDb();
      const reply = `纯人设模式：${db.settings.ignoreSystemFacts ? '已开启（底层信息不注入）' : '已关闭（底层信息正常注入）'}。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const reply = '用法：/w sysfacts on|off|status';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/summarize' && isWuxinCommand) {
    const countArg = parseInt(parts[2], 10);
    const N = Number.isFinite(countArg) && countArg >= 5 ? countArg : 50;
    const summarizePermission = N >= 100 ? 'summarizeLarge' : 'summarize';

    if (N < 5 || N > 500) {
      const reply = '总结消息条数范围：5-500。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (!(await requireCommand(summarizePermission))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, summarizePermission) };

    const db = readDb();
    const groupMessages = (db.messages || [])
      .filter((m) => String(m.groupId) === String(event.groupId))
      .filter((m) => m.content && m.content.trim())
      .slice(-N);

    if (groupMessages.length < 5) {
      const reply = '这个群的聊天记录还太少（至少需要 5 条有内容的发言），没法总结。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    const formatted = groupMessages.map((m) => {
      const time = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const name = m.nickname || m.userId || '未知';
      return `[${time}] ${name}：${m.content}`;
    }).join('\n');

    const summaryPrompt = `请用简洁中文总结以下 ${groupMessages.length} 条 QQ 群聊消息，用 2-5 条要点概括主要话题和讨论内容。不要提及具体 QQ 号，用"有人/群友"代替。`;

    try {
      const response = await completeChat(db, {
        model: db.settings.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是群聊总结助手，用中文输出。' },
          { role: 'user', content: `${summaryPrompt}\n\n${formatted}` }
        ],
        temperature: 0.3,
        maxTokens: 500,
        timeoutMs: 45_000,
        label: '群聊总结'
      });

      const summary = response.text || '无法生成总结。';

      updateDb((draft) => {
        draft.usage.requests += 1;
        draft.usage.totalTokens += response.usage?.total_tokens || 0;
        draft.usage.promptTokens += response.usage?.prompt_tokens || 0;
        draft.usage.completionTokens += response.usage?.completion_tokens || 0;
        if (!draft.usageEvents) draft.usageEvents = [];
        draft.usageEvents.push({
          id: crypto.randomUUID(),
          groupId: event.groupId,
          userId: event.userId,
          model: db.settings.model,
          totalTokens: response.usage?.total_tokens || 0,
          promptTokens: response.usage?.prompt_tokens || 0,
          completionTokens: response.usage?.completion_tokens || 0,
          createdAt: nowIso()
        });
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: `/wuxin summarize ${N}`,
          targetUserId: 'group',
          groupId: event.groupId,
          detail: `总结 ${groupMessages.length} 条消息`,
          createdAt: nowIso()
        });
      });

      if (sendMessage) await sendForwardText(sendMessage, event, `群聊总结 (${groupMessages.length}条)`, summary);
      return { replied: Boolean(sendMessage), text: summary, reason: `总结 ${groupMessages.length} 条消息` };
    } catch (error) {
      const reply = `总结失败：${error.message}`;
      if (sendMessage) await sendMessage(event, reply);
      updateDb((draft) => {
        draft.usage.errors += 1;
      });
      return { replied: Boolean(sendMessage), error: error.message, reason: reply };
    }
  }

  if (command === '/note' && isWuxinCommand) {
    if (!(await requireCommand('note'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'note') };

    const action = (parts[2] || '').toLowerCase();
    const noteTarget = (event.atTargets && event.atTargets[0]) || (action === 'show' || action === 'clear' ? parts[3] : parts[2]);
    const noteText = action === 'show' || action === 'clear'
      ? parts.slice(4).join(' ').trim()
      : parts.slice(3).join(' ').trim();

    if (!noteTarget) {
      const reply = '用法：/wuxin note @某人 内容，/wuxin note show @某人，/wuxin note clear @某人';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    if (action === 'show') {
      const db = readDb();
      const user = db.users.find((entry) => String(entry.groupId) === String(event.groupId) && String(entry.userId) === String(noteTarget));
      const reply = user?.note ? `${noteTarget} 的备注：${user.note}` : `${noteTarget} 还没有备注。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    const nextNote = action === 'clear' ? '' : noteText;
    if (action !== 'clear' && !nextNote) {
      const reply = '备注内容不能为空。用法：/wuxin note @某人 内容';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }

    updateDb((draft) => {
      const existingIndex = draft.users.findIndex(
        (user) => String(user.groupId) === String(event.groupId) && String(user.userId) === String(noteTarget)
      );
      if (existingIndex >= 0) {
        draft.users[existingIndex] = { ...draft.users[existingIndex], note: nextNote, updatedAt: nowIso() };
      } else {
        draft.users.push({
          id: crypto.randomUUID(),
          groupId: event.groupId,
          userId: noteTarget,
          nickname: noteTarget,
          policy: 'normal',
          attentionLevel: 3,
          allowCommands: false,
          note: nextNote,
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: event.userId,
        action: `/wuxin note ${action || 'set'}`,
        targetUserId: noteTarget,
        groupId: event.groupId,
        detail: nextNote || '清除备注',
        createdAt: nowIso()
      });
    });

    const reply = action === 'clear' ? `已清除 ${noteTarget} 的备注。` : `已给 ${noteTarget} 设置备注。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (command === '/profile' && isWuxinCommand) {
    if (!(await requireCommand('profile'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'profile') };
    const action = subCommand || 'update';
    // /w profile show @某人 — view profile
    if (action === 'show') {
      const showTarget = (event.atTargets && event.atTargets[0]) || parts[3];
      if (!showTarget) {
        const reply = '用法：/w profile show @某人';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const db = readDb();
      const mem = (db.memories || []).find((m) => String(m.userId) === String(showTarget));
      if (!mem || (!mem.summary && !mem.traits && !mem.speechStyle && !mem.behavior && !mem.preferences)) {
        const reply = `${showTarget} 还没有画像数据。`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const recentDynamics = (mem.recentDynamics || []).slice(-5).filter((d) => d.confidence >= 0.2);
      const dynamicsBlock = recentDynamics.length > 0 ? '\n—— 近期动态（可能临时）——\n' + recentDynamics.map((d) => `${d.topic}：${d.summary}（置信${Math.round(d.confidence * 100)}%）`).join('\n') : '';
      const profileText = [
        '—— 长期画像 ——',
        mem.summary && `整体：${mem.summary}`,
        mem.traits && `性格：${mem.traits}`,
        mem.speechStyle && `说话：${mem.speechStyle}`,
        mem.behavior && `行为：${mem.behavior}`,
        mem.preferences && `偏好：${mem.preferences}`,
        mem.manualNotes && `备注：${mem.manualNotes}`,
        dynamicsBlock,
        `\n发言数：${mem.profileMessageCount || 0} | 最近更新：${mem.lastProfiledAt ? new Date(mem.lastProfiledAt).toLocaleString('zh-CN') : '从未'}`
      ].filter(Boolean).join('\n');
      if (sendMessage) await sendForwardText(sendMessage, event, `${mem.nickname || showTarget} 的画像`, profileText);
      return { replied: Boolean(sendMessage), reason: `查看 ${showTarget} 画像` };
    }
    // /w profile samples @某人 — show profile evidence
    if (action === 'samples') {
      const samplesTarget = (event.atTargets && event.atTargets[0]) || parts[3];
      if (!samplesTarget) {
        const reply = '用法：/w profile samples @某人';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const db = readDb();
      const mem = (db.memories || []).find((m) => String(m.userId) === String(samplesTarget));
      if (!mem || !(mem.samples || []).length) {
        const reply = `${samplesTarget} 还没有发言样本。`;
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      const all = mem.samples || [];
      const usedNormal = all.filter((s) => s.usedForProfile && s.riskLevel === 'normal');
      const lowConf = all.filter((s) => s.riskLevel === 'low-confidence');
      const highRisk = all.filter((s) => s.riskLevel === 'high-risk');
      const cards = all.filter((s) => !s.usedForProfile && s.type === 'card');
      const otherExcluded = all.filter((s) => !s.usedForProfile && s.type !== 'card' && s.riskLevel === 'normal');

      const meta = mem.profileMeta || {};
      const metaLine = (field) => {
        const m = meta[field];
        if (!m || !m.confidence) return '';
        return ` ${Math.round(m.confidence * 100)}%`;
      };

      const lines = [
        `${mem.nickname || samplesTarget} 的画像依据`,
        `画像置信：整体${metaLine('traits')}${metaLine('speechStyle')}${metaLine('behavior')}${metaLine('preferences')}`,
        '',
      ];

      if (usedNormal.length > 0) {
        const withCtx = usedNormal.filter((s) => s.context && s.context.nearby && s.context.nearby.length > 0);
        const withoutCtx = usedNormal.filter((s) => !s.context || !s.context.nearby || s.context.nearby.length === 0);
        if (withCtx.length > 0) {
          lines.push(`—— 用于画像（${withCtx.length}条，带上下文）——`);
          for (const s of withCtx.slice(-10)) {
            const ctx = s.context;
            let ctxSummary = '';
            if (ctx.nearby && ctx.nearby.length > 0) {
              const last = ctx.nearby[ctx.nearby.length - 1];
              if (last && String(last.userId) !== String(samplesTarget)) {
                ctxSummary = `  ← 接「${(last.nickname || last.userId)}：${last.content.slice(0, 30)}」`;
              }
            }
            lines.push(`${s.content}${ctxSummary}`);
          }
          lines.push('');
        }
        if (withoutCtx.length > 0) {
          lines.push(`—— 旧版画像依据（${withoutCtx.length}条，无上下文，权重已降低。新数据积累后将覆盖）——`);
          for (const s of withoutCtx.slice(-6)) {
            lines.push(`${s.content}`);
          }
          lines.push('');
        }
      }

      if (lowConf.length > 0) {
        lines.push(`—— 低置信观察（${lowConf.length}条，保留但不写画像）——`);
        for (const s of lowConf.slice(-8)) {
          const ctx = s.context;
          let ctxSummary = s.reason;
          if (ctx && ctx.nearby && ctx.nearby.length > 0) {
            const prev = ctx.nearby[ctx.nearby.length - 1];
            if (prev && String(prev.userId) !== String(samplesTarget)) {
              ctxSummary += `，接「${prev.nickname || prev.userId}：${prev.content.slice(0, 30)}」`;
            }
          }
          lines.push(`${s.content}  [${ctxSummary}]`);
        }
        lines.push('');
      }

      if (highRisk.length > 0) {
        lines.push(`—— 高风险已降级（${highRisk.length}条，仅审计）——`);
        for (const s of highRisk.slice(-5)) {
          lines.push(`${s.content}  [${s.reason}]`);
        }
        lines.push('');
      }

      if (cards.length > 0 || otherExcluded.length > 0) {
        const totalBg = cards.length + otherExcluded.length;
        lines.push(`另有 ${totalBg} 条低权重/被排除样本（分享卡片、指令、过短文本等），不单独下结论。`);
      }

      if (sendMessage) await sendForwardText(sendMessage, event, `${mem.nickname || samplesTarget} 画像依据`, lines.join('\n'));
      return { replied: Boolean(sendMessage), reason: `显示 ${samplesTarget} 画像依据` };
    }
    // /w profile rule @某人 规则 — set profiling constraint
    if (action === 'rule') {
      const ruleTarget = (event.atTargets && event.atTargets[0]) || parts[3];
      const ruleText = parts.slice(4).join(' ').trim();
      if (!ruleTarget) {
        const reply = '用法：/w profile rule @某人 规则内容。例如：/w profile rule @某人 禁止使用负面词汇描述';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      updateDb((draft) => {
        let mem = (draft.memories || []).find((m) => String(m.userId) === String(ruleTarget));
        if (!mem) {
          mem = {
            id: crypto.randomUUID(), userId: ruleTarget, nickname: ruleTarget,
            enabled: true, importanceLevel: 2, importanceLabel: '手动创建',
            messageCount: 0, profileMessageCount: 0, pendingCount: 0, groupsSeen: [],
            samples: [], summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
            manualNotes: '', profilingRule: '', createdAt: nowIso(), updatedAt: nowIso()
          };
          draft.memories.push(mem);
        }
        mem.profilingRule = ruleText || '';
        mem.updatedAt = nowIso();
      });
      const reply = ruleText
        ? `已设置 ${ruleTarget} 的画像约束：${ruleText}`
        : `已清除 ${ruleTarget} 的画像约束。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    // /w profile retry @某人 方向 — recalculate profile with guidance
    if (action === 'retry') {
      const retryTarget = (event.atTargets && event.atTargets[0]) || parts[3];
      const guidance = parts.slice(4).join(' ').trim();
      if (!retryTarget) { const reply = '用法：/w profile retry @某人 画像方向。例如：/w profile retry @某人 重点关注技术和游戏方面的表达'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
      const db = readDb();
      const mem = (db.memories || []).find((m) => String(m.userId) === String(retryTarget));
      if (!mem) { const reply = '还没有这个用户的记忆数据。'; if (sendMessage) await sendMessage(event, reply); return { replied: Boolean(sendMessage), reason: reply }; }
      // Temporarily set profilingRule as guidance for this update
      const savedRule = mem.profilingRule;
      if (guidance) mem.profilingRule = guidance;
      if (sendMessage) await sendMessage(event, `正在按「${guidance || '默认方向'}」重算 ${mem.nickname || retryTarget} 的画像…`);
      try {
        const result = await updateMemoryProfile(db, mem);
        const outcome = commitMemoryProfileResult(retryTarget, result, { groupId: event.groupId, model: db.settings.model, kind: 'memory' });
        updateDb((draft) => {
          const target = (draft.memories || []).find((m) => String(m.userId) === String(retryTarget));
          if (target) target.profilingRule = savedRule;
        });
        if (sendMessage) await sendMessage(event, `${mem.nickname || retryTarget} 画像重算完成：${outcome.reason}`);
        return { replied: Boolean(sendMessage), reason: `定向重算 ${retryTarget} 画像` };
      } catch (error) {
        updateDb((draft) => { const t = (draft.memories || []).find((m) => String(m.userId) === String(retryTarget)); if (t) t.profilingRule = savedRule; });
        const reply = `重算失败：${error.message}`; if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), error: error.message, reason: reply };
      }
    }
    // /w profile clear @某人 — clear profile
    if (action === 'clear') {
      const clearTarget = (event.atTargets && event.atTargets[0]) || parts[3];
      if (!clearTarget) {
        const reply = '用法：/w profile clear @某人';
        if (sendMessage) await sendMessage(event, reply);
        return { replied: Boolean(sendMessage), reason: reply };
      }
      updateDb((draft) => {
        const mem = (draft.memories || []).find((m) => String(m.userId) === String(clearTarget));
        if (!mem) return;
        mem.summary = '';
        mem.traits = '';
        mem.speechStyle = '';
        mem.behavior = '';
        mem.preferences = '';
        mem.pendingCount = 0;
        mem.lastProfiledAt = '';
        mem.updatedAt = nowIso();
      });
      const reply = `已清除 ${clearTarget} 的画像数据。`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    // /w profile @某人 — update profile (default)
    const targetUser = (event.atTargets && event.atTargets[0]) || parts[2];
    if (!targetUser) {
      const reply = '用法：/w profile @某人（更新）/ /w profile show @某人（查看）/ /w profile clear @某人（清除）';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    const db = readDb();
    let memory = (db.memories || []).find((m) => String(m.userId) === String(targetUser));
    if (!memory) {
      const reply = '还没有这个用户的记忆数据，等ta多说几句话后再试。';
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), reason: reply };
    }
    if (sendMessage) await sendMessage(event, `正在更新 ${memory.nickname || targetUser} 的画像…`);
    try {
      const result = await updateMemoryProfile(db, memory);
      const outcome = commitMemoryProfileResult(targetUser, result, { groupId: event.groupId, model: db.settings.model, kind: 'memory' });
      if (sendMessage) await sendMessage(event, `${memory.nickname || targetUser} 画像更新完成：${outcome.reason}`);
      return { replied: Boolean(sendMessage), reason: `手动更新 ${targetUser} 画像` };
    } catch (error) {
      const reply = `画像更新失败：${error.message}`;
      if (sendMessage) await sendMessage(event, reply);
      return { replied: Boolean(sendMessage), error: error.message, reason: reply };
    }
  }

  if (command === '/osu' && isWuxinCommand) {
    const permKey = subCommand === 'bind' ? 'osuBind'
      : subCommand === 'analyze' ? 'osuAnalyze'
      : subCommand === 'recent' ? 'osuRecent'
      : subCommand === 'clear' ? 'osuClearCache'
      : 'osuHelp';
    if (!(await requireCommand(permKey))) {
      return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, permKey) };
    }
    return handleOsuCommand(event, sendMessage, permissions, subCommand, commandArgs);
  }

  if (!isWuxinCommand) {
    return { replied: false, reason: '忽略非 Wuxin 裸斜杠指令，避免和其他 bot 冲突' };
  }

  if (!policyMap[command]) {
    const reply = command === '/'
      ? '用 /w help 查看 Wuxin 指令。'
      : `未知 Wuxin 指令：${command}。用 /w help 查看帮助。`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (!target) {
    const reply = `用法：/w ${command.slice(1)} @某人`;
    if (sendMessage) await sendMessage(event, reply);
    return { replied: Boolean(sendMessage), reason: reply };
  }

  if (!(await requireCommand('memberPolicy'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'memberPolicy') };

  updateDb((draft) => {
    const existingIndex = draft.users.findIndex(
      (user) => String(user.groupId) === String(groupId) && String(user.userId) === String(target)
    );
    const entry = {
      groupId,
      userId: target,
      nickname: target,
      policy: policyMap[command],
      attentionLevel: policyMap[command] === 'priority' ? 5 : 3,
      allowCommands: policyMap[command] === 'admin'
    };
    if (command === '/op' || command === '/设管理员') entry.commandRoleId = 'admin';
    if (command === '/deop' || command === '/取消管理员') entry.commandRoleId = '';
    if (existingIndex >= 0) draft.users[existingIndex] = { ...draft.users[existingIndex], ...entry, updatedAt: nowIso() };
    else draft.users.push({ ...entry, id: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso() });
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: event.userId,
      action: command,
      targetUserId: target,
      groupId,
      detail: `设置为 ${policyMap[command]}`,
      createdAt: nowIso()
    });
  });

  const reply = `已把 ${target} 设置为 ${describePolicy(policyMap[command])}。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: Boolean(sendMessage), reason: reply };
}
