// Conversation context helpers + LLM reply gate. Type-checked module.
import { readDb, updateDb, nowIso } from '../store.js';
import { applyUsageTotals, usageEventFields } from '../usage.js';
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
} from './cleaning.js';
import {
  callLLM,
  completeChat
} from './llm.js';
import {
  commandRoleLevel,
  commandRoleName,
  userCommandRoleId,
  hasCommandPermission,
  commandDeniedReply,
  parseCommandMeta,
  writeCommandLog
} from './commands.js';
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
} from './prompt.js';
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
} from './reply.js';
import { activeModelName, activateModelProfile } from '../modelConfig.js';

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
  return db.messages.filter(
    (message) =>
      String(message.groupId) === String(groupId) &&
      message.role === 'assistant' &&
      new Date(message.createdAt).getTime() >= since
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
  const last = [...db.messages]
    .reverse()
    .find((message) => String(message.groupId) === String(groupId) && message.role === 'assistant');
  return last ? new Date(last.createdAt).getTime() : 0;
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

export function recentLlmGateCalls(db, groupId, minutes = 60) {
  const since = Date.now() - minutes * 60_000;
  return (db.usageEvents || []).filter((event) =>
    event.kind === 'reply-gate' &&
    String(event.groupId || '') === String(groupId || '') &&
    new Date(event.createdAt || 0).getTime() >= since
  ).length;
}

interface GateUsageRecord {
  groupId: any;
  userId: any;
  result?: any;
  error?: any;
  verdict?: any;
  threshold?: any;
}

export function recordLlmGateUsage({ groupId, userId, result, error, verdict, threshold }: GateUsageRecord) {
  updateDb((draft) => {
    draft.usageEvents ||= [];
    const usage = result?.usage || {};
    if (result) {
      applyUsageTotals(draft.usage, usage);
      draft.usage.requests += 1;
    } else {
      draft.usage.errors += 1;
    }
    draft.usageEvents.push({
      id: crypto.randomUUID(),
      kind: 'reply-gate',
      groupId,
      userId,
      model: result?.model || activeModelName(draft.settings),
      provider: result?.provider || draft.settings.llmProvider,
      ...usageEventFields(usage),
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

export function cleanGateMessage(value, marksOtherMention = false) {
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

export function parseGateVerdict(value) {
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
export async function llmReplyGate(db, groupId, text, { mode, question, chatIsBusy, recentBotReplies10m, userPolicy, userId }) {
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
  const resolvedSettings = activateModelProfile(db.settings, activeModelName(db.settings));
  const usesCodexAccount = String(resolvedSettings.llmProvider || '') === 'codex-app-server';
  const hasApiKey = String(resolvedSettings.apiKey || db.settings.apiKey || '').trim().length > 0;
  if (!usesCodexAccount && !hasApiKey) {
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

