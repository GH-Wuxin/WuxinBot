// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
import { pathToFileURL } from 'node:url';
import { sendOptionalNotice } from './bot/notice.js';
import { withLlmTurnPolicy, assertLlmTurnActive } from './llmPolicy.js';
import { defaultPrompt, readDb, updateDb, nowIso } from './store.js';
import { applyUsageTotals, mergeLlmUsage, usageEventFields } from './usage.js';
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
  completeChat,
  thinkingParamsForLevel
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
  createShadowReasoningRouter,
  emptyTurnState,
  reasoningEnabledFor,
  reasoningInput
} from './bot/reasoningRouter.js';
import {
  sanitizeReply,
  sendReplySegments,
  isDirectBotMention,
  replyToCurrentMessageOptions,
  isWeirdReply,
  rewriteNormalReply,
  visualLimitationReply,
  sendForwardText,
  splitReplySegments,
  isIdentityQuestion,
  neutralIdentityReply,
  normalReplyRewriteSkipReason
} from './bot/reply.js';
import { buildRewriteEntry, recordRewriteTelemetry } from './bot/rewriteTelemetry.js';
import { recordMemoryObservation, maybeUpdateMemoryProfile, maybeRecordImageMemorySummary, updateMemoryProfile, commitMemoryProfileResult, maybeSweepDueMemoryProfiles } from './bot/memory.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, incrementGroupProfilePending, hasGroupProfileContent } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, incrementPairPending } from './bot/relationshipProfile.js';
import { processTrustSignal, evaluateTrustScores, trustInteractionBonus, isTrustedMember } from './bot/trust.js';
import { processXpGain, getExperience, getXpBonus, formatXpBar, getUnlockedFeatures, getLevelInfo, getNextLevelInfo, levelToPp, decayInactiveUsers } from './bot/experience.js';
import {
  SEARCH_TOOL_NAME,
  buildSearchToolGuidance,
  buildSearchToolSchema,
  executeSearchToolCall,
  extractSearchQuery,
  isSearchAvailable,
} from './bot/search.js';
import { setBotPaused, getRecalcProgress, startRecalc, tickRecalc, finishRecalc, markActiveProcessing, recordDecisionError } from './health.js';
import { runBackgroundTask } from './backgroundTasks.js';
import { runInboundTask } from './bot/inboundGate.js';
import {
  currentRequestTraceId,
  finishRequestTrace,
  requestTraceIdFor,
  startRequestTrace,
  traceEvent,
  withRequestTrace,
} from './requestTrace.js';
import { activeModelName, activateModelProfile, activeProviderLabel } from './modelConfig.js';
import { handleOsuCommand } from './osu/commands.js';
import { loadRegistry, buildBotToolSchemas, enabledBots, findBot } from './bots/registry.js';
import {
  detectRequiredOsuTool,
  detectNamedBotRequest,
  detectBpTypeAnalysisIntent,
  extractBpTypeUsername,
  hasFallbackRecommendIntent,
  looksLikeRecommendationReply,
} from './bots/intent.js';
import { validateOperation, looksLikeToolCallMarkup } from './bots/guard.js';
import { RECENT_BOT_SELECTOR_IDS } from './bots/capabilityCatalog.js';
import { executeToolCall, runToolLoop, mergeToolLoopResults, tryResolveBotResponse } from './bots/executor.js';
import { buildToolGuidance } from './bots/toolGuidance.js';
import {
  agentRuntimeModeFor,
  buildAgentAutonomyGuidance,
  rewriteLegacyToolReferencesForV2,
} from './bots/agentToolContracts.js';
import {
  claimInboundEvent,
  persistedInboundDuplicate,
  getQueueState,
  drainReplyQueue,
  REPLY_QUEUE_LIMIT
} from './bot/queue.js';
import {
  looksLikeExternalBotSender,
  extractAtQq,
  escapeRegExp,
  stripAtQq,
  parseTargetAndRest,
  llmContentFilter,
  getGroup,
  getUserPolicy,
  recentGroupMessages,
  ownerPrivateMessages,
  limitMessagesByCharBudget,
  countRecentReplies,
  scoreReplyParticipation,
  lastAssistantAt,
  lastAssistantMessage,
  isPrivilegedForConversation,
  looksLikeReplyToBot,
  recentBotConversation,
  recentVisionImageMessages,
  shouldUseRecentVisionImage
} from './bot/gate.js';
import { handleOwnerCommand } from './bot/ownerCommands.js';
import { matchQuickCommand, handleQuickCommand } from './bot/quickRouter.js';
import { cqImageFor, pickCodeSticker, pickSticker, withSticker } from './bot/stickers/index.js';
import { rollRandomImage } from './bot/randomImages.js';
import {
  beginLiveStickerDebug,
  stickerDebugShouldDryRun,
  validateStickerSelection,
  type StickerDebugSession,
} from './bot/stickers/debug.js';
import {
  parseStickerReply,
  resolveStickerReplyCapability,
  STICKER_REPLY_RESPONSE_FORMAT,
  withStickerReplyInstruction,
} from './bot/stickers/finalReply.js';
import {
  completeStickerDelivery,
  recordStickerDecisionInDb,
  reserveStickerDelivery,
  stickerDeliveryConfig,
  type StickerDeliveryOutcome,
} from './bot/stickers/delivery.js';
import {
  ensureStickerReplyFallback,
  stickerFailureFallback,
  stickerFailureNotice,
} from './bot/stickers/replyDelivery.js';
import { appendReplyFailure } from './bot/replyFailures.js';
import { resolveMemberNames } from './bot/memberDirectory.js';
import { classifyLlmFailure } from './bot/llmFailure.js';
import { settlePendingQuickObservations } from './bot/quickContext.js';

let stickerReplyCapabilityWarningLogged = false;

function recordStickerReplyCapabilityWarning(error) {
  if (stickerReplyCapabilityWarningLogged) return;
  stickerReplyCapabilityWarningLogged = true;
  console.warn('[sticker] optional model-reply catalogue unavailable; continuing without sticker protocol:', String(error?.message || error).slice(0, 240));
}

function replyTargetMetadata(event) {
  return {
    replyToMessageId: String(event.messageId || ''),
    replyToUserId: String(event.userId || ''),
    replyToNickname: String(event.nickname || event.userId || ''),
  };
}

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

function levelUpFallback(oldPp, newPp, realPp) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pool = realPp == null ? LEVEL_UP_FALLBACK_NONE
    : realPp < newPp ? LEVEL_UP_FALLBACK_HIGH
    : LEVEL_UP_FALLBACK_LOW;
  return pick(pool).replace('{pp}', String(newPp));
}

function buildLevelUpPrompt(nickname, oldPp, newPp, realPp, contextLines) {
  const compare = realPp == null
    ? '他的真实 osu! pp 未知（未绑定账号）。'
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
    compare,
    `最近群聊：${contextLines}`,
    `对 ${nickname} 说一句升级短语，格式是这样：“你 {新等级 pp}pp 了！${realPp == null ? '' : realPp < newPp ? '什么？你没那么多 pp？' : '什么？比这 pp 还高？'}这是我这的等级 pp，不用太在意啦！”`,
    hint,
    '可以在“不用太在意”后面加半句轻松的收尾（比如“先记着这个数就行”），但不要加更多解释。',
    '禁止出现“Lv.”“等级”“称号”“升级”“解锁”字样；禁止复述规则或任何括号说明；不要用“装萌新”“少废话”“谁有意见”“别狡辩”这类带挑衅或贬低的说法；只输出一句对玩家说的话，不要解释。',
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
const MERGE_FORWARD_MIN_CHARS = 200;

// Reply queue: each group+user pair keeps its own FIFO, so different members
// never block each other. While a reply is being generated, that member's new
// messages are queued; after the current reply finishes, queued messages from
// the same member are merged into one reply and processed automatically.
export async function decideReply({ db, group, userPolicy, text, mentioned, userId, images = [] }) {
  // Keep the participation boundary deterministic. Natural/light group
  // messages use a local score before entering the one main reply-model turn;
  // there is deliberately no second LLM preflight call here.
  if (db.settings.globalPaused) return { shouldReply: false, reason: '机器人处于全局暂停状态' };
  if (!group?.enabled) return { shouldReply: false, reason: '这个群没有启用机器人' };
  if (userPolicy.policy === 'blocked') return { shouldReply: false, reason: '该用户在黑名单中', inContext: false };
  if (group.mode === 'silent') return { shouldReply: false, reason: '当前群是静默模式' };
  if (group.mode === 'osu') return { shouldReply: false, reason: '当前群仅处理 osu! 指令', inContext: false };
  if (db.settings.onlyMentionMode && !mentioned) return { shouldReply: false, reason: '全局设置为只在 @ 时回复' };
  const visionCapable = modelSupportsVision(db);
  const hasVisionImages = visionCapable && Array.isArray(images) && images.length > 0;
  if (text.length < 1) {
    if (hasVisionImages) return { shouldReply: false, reason: '真实纯图片已记录，未点名机器人时不主动回复' };
    return { shouldReply: false, reason: '空消息或无法识别的消息' };
  }
  if (!textWithoutControlPlaceholders(text)) {
    if (hasVisionImages && mentioned) return { shouldReply: true, reason: '用户 @ 机器人并发送图片，交给视觉模型回答' };
    if (hasVisionImages) return { shouldReply: false, reason: '真实纯图片已记录，未点名机器人时不主动回复' };
    return { shouldReply: false, reason: '只有 @/媒体/卡片占位，没有可回复的文字', inContext: false };
  }
  if (onlyVisualMessage(text)) {
    if (hasVisionImages && mentioned) return { shouldReply: true, reason: '用户 @ 机器人并发送纯图片，交给视觉模型回答' };
    if (hasVisionImages) return { shouldReply: false, reason: '真实纯图片已记录，未点名机器人时不主动回复' };
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
    const thresholdKey = group.mode === 'light'
      ? 'replyGateLightThreshold'
      : 'replyGateNaturalThreshold';
    const defaultThreshold = group.mode === 'light' ? 70 : 45;
    const threshold = Math.max(0, Math.min(100, Number(
      db.settings[thresholdKey] ?? defaultThreshold,
    )));
    const participation = scoreReplyParticipation(db, group.groupId, text, { userPolicy });
    const modeLabel = group.mode === 'light' ? '轻度参与' : '自然群友';
    if (participation.score < threshold) {
      return {
        shouldReply: false,
        reason: `${modeLabel}门控 ${participation.score}/${threshold}，未达到接话阈值`,
      };
    }
    return {
      shouldReply: true,
      reason: `${modeLabel}门控 ${participation.score}/${threshold}，交给主回复模型`,
    };
  }

  return { shouldReply: false, reason: '这条消息没有达到当前主动性阈值' };
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
  if (replyMessageId && images.length === 0) {
    try {
      const db = readDb();
      const quoted = db.messages.find((m) => String(m.sourceMessageId || m.messageId || m.id) === replyMessageId);
      if (quoted) {
        quotedMessage = {
          messageId: replyMessageId,
          text: String(quoted.content || ''),
          images: quoted.media?.images || [],
          userId: String(quoted.userId || ''),
          nickname: String(quoted.nickname || ''),
        };
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
  if (ownerCommand) return ['osu', 'skill', 'info', 'cd', 'mode'].includes(ownerCommand);
  return quickMatch?.def?.kind === 'osu';
}

function llmTurnLimitsForEvent(event) {
  const text = String(event?.text || '').trim();
  // osu Analyze spends most of its time collecting BP100/Recent/PP+ evidence
  // before it makes the single Codex report call. The normal 180s conversation
  // budget can expire during collection and incorrectly turn a healthy model
  // into LLM_TURN_BUDGET_EXHAUSTED. Keep this exception narrow and explicit.
  if (/^\/w(?:uxin)?\s+osu\s+analyze(?:\s|$)/i.test(text)) {
    return { maxCalls: 4, timeoutMs: 600_000 };
  }
  return undefined;
}

export function processIncoming(event, sendMessage = undefined, queuedDecision = undefined, isFromDrain = false) {
  return runInboundTask('onebot.message', () => processIncomingAdmitted(event, sendMessage, queuedDecision, isFromDrain));
}

export async function processIncomingAdmitted(event, sendMessage = undefined, queuedDecision = undefined, isFromDrain = false) {
  const queueOwner = { key: '' };
  const requestId = requestTraceIdFor(event);
  startRequestTrace(event, requestId);
  return withRequestTrace(requestId, async () => {
    traceEvent('INGRESS', 'onebot_message_received', {
      messageId: event?.messageId,
      groupId: event?.groupId,
      userId: event?.userId,
      messageType: event?.type,
      imageCount: event?.images?.length || 0,
      replayedFromQueue: Boolean(isFromDrain),
    });
    markActiveProcessing(1);
    try {
      const result = await withLlmTurnPolicy(
        () => processIncomingInner(event, sendMessage, queuedDecision, isFromDrain, queueOwner),
        llmTurnLimitsForEvent(event),
      );
      finishRequestTrace(result?.error ? 'failed' : 'completed', {
        replied: Boolean(result?.replied),
        queued: Boolean(result?.queued),
        reason: result?.reason || '',
      });
      return result;
    } catch (error) {
      finishRequestTrace('failed', { error: error?.message || String(error) });
      throw error;
    } finally {
      markActiveProcessing(-1);
      if (queueOwner.key && !isFromDrain) {
        void drainReplyQueue(queueOwner.key, processIncoming).catch((error) => {
          console.error('[reply-queue] worker failed:', error?.message || error);
        });
      }
    }
  });
}

async function processIncomingInner(event, sendMessage = undefined, queuedDecision = undefined, isFromDrain = false, queueOwner = { key: '' }) {
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
  // Preserve the distinction between a direct @mention and natural group
  // participation before command/quick routes can send anything. The reply
  // helper uses this in every final delivery branch.
  event.replyToCurrentMessage = isDirectBotMention(event, settings);
  if (settings.selfQq && String(event.userId) === String(settings.selfQq)) {
    return { replied: false, reason: '忽略机器人自己的消息' };
  }

  const isPrivateOwner = event.type === 'private' && settings.ownerQq && String(event.userId) === String(settings.ownerQq);
  if (isPrivateOwner && event.text.startsWith('/')) {
    // Bare slash commands that belong to the LazyBot shortcut table are routed
    // below; Wuxin's own `/help` and owner commands keep their existing behavior.
    const privateQuick = matchQuickCommand(event);
    const isLazyQuick = privateQuick?.def.source === 'lazybot' && privateQuick.def.id !== 'help';
    if (!isLazyQuick) {
      return handleOwnerCommand(event, sendMessage);
    }
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
  const group = event.type === 'group' ? getGroup(db, event.groupId) : null;
  const detectedQuickMatch = detectBpTypeAnalysisIntent(event.text) ? null : matchQuickCommand(event);

  // Random images are an independent module. Run this before the osu-only
  // text router can return, so a group may keep spontaneous images enabled
  // while restricting Pippi's text replies to osu! commands.
  if (event.type === 'group' && sendMessage && group?.randomImageEnabled === true) {
    const roll = rollRandomImage(event.groupId, group.randomImageRate);
    if (roll.file) {
      // 不 await：发图失败不该影响正常回复，也不该拖慢这一轮。
      Promise.resolve(sendMessage(event, cqImageFor(roll.file))).catch(() => undefined);
    }
  }

  if (event.type === 'group' && group?.mode === 'osu' && !allowedByOsuCommandOnlyMode(event, detectedQuickMatch)) {
    traceEvent('GATE', 'osu_command_only_ignored', {
      status: 'silent',
      reason: '本群为仅 osu! 指令模式',
    });
    // Return before messages, decisions, XP, memory, relationship and group
    // profile counters are touched. This is what makes the mode a real privacy
    // and cost boundary instead of another probabilistic reply policy.
    return { replied: false, reason: '本群为仅 osu! 指令模式，忽略非 osu! 内容' };
  }

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

  // ── Deterministic shortcut commands ──
  // Deterministic `!p`/`!bs`/`/plus`/`~`/`查@` … commands bypass the LLM.
  // BP 类型查询 has its own deterministic osu!oracle route. In particular,
  // `查 @某人 的 BP 类型` must not be consumed as Hydrant's generic 查@资料.
  const quickMatch = detectedQuickMatch;
  if (quickMatch) {
    const quickResult = await handleQuickCommand(event, sendMessage, db, quickMatch, {
      isOwner: isGroupOwner || isPrivateOwner,
      isAdmin: isGroupAdmin,
    });
    if (quickResult?.handled) {
      return quickResult;
    }
  }

  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  if (isFromDrain && (settings.globalPaused || userPolicy.policy === 'blocked'
      || userPolicy.policy === 'muted' || (event.type === 'group' && (!group?.enabled || group.mode === 'silent'))
      || (event.type === 'private' && settings.ownerQq && !isPrivateOwner)
      || ((settings.onlyMentionMode || (event.type === 'group' && group?.mode === 'mention')) && !mentionsBot(event.text, settings)))) {
    return { replied: false, reason: '排队期间权限或参与模式已改变，取消回复' };
  }
  const mentioned = mentionsBot(event.text, settings);
  const eventVisionImages = collectEventVisionImages(event);
  // On the first pass the message + decision are recorded and side effects
  // (memory, XP, pair/profile pending) run exactly once. Drained replays use
  // the stored decision and must NOT duplicate history or side effects.
  const decision = queuedDecision || (event.type === 'private'
    ? { shouldReply: String(event.userId) === String(settings.ownerQq || event.userId), reason: '私聊消息' }
    : await decideReply({ db, group, userPolicy, text: event.text, mentioned, userId: event.userId, images: eventVisionImages }));
  traceEvent('GATE', 'reply_gate_decided', {
    status: decision.shouldReply ? 'reply' : 'silent',
    shouldReply: Boolean(decision.shouldReply),
    reason: decision.reason,
    inContext: decision.inContext !== false,
    visualLimitation: Boolean(decision.visualLimitation),
    mentioned,
    replyToCurrentMessage: Boolean(event.replyToCurrentMessage),
    atTargets: event?.atTargets || [],
  });

  // @ 段只有 QQ 号，渲染出来就是「[CQ:at,qq=123] 你吃饭了吗」—— 她分不出那个号码
  // 是自己还是别人，也就分不出这句话是不是冲她来的。按 AstrBot 的做法查一次名字
  // （群名片优先，空则回退 QQ 昵称），随消息一起存下来：历史因此是准确的，
  // 渲染时也不必再查。查不到就留空，退回原来的号码，不影响别的。
  const mentionNames = event.type === 'group' && event.atTargets?.length
    ? await resolveMemberNames(readDb(), event.groupId, event.atTargets)
    : new Map();
  // 同一份结果也给当前这一轮用，免得历史里有名字、当前消息却还是裸号码。
  event.mentionNames = mentionNames;

  if (!isFromDrain) {
    let persistedDuplicate = false;
    updateDb((draft) => {
      if (persistedInboundDuplicate(draft, event)) {
        persistedDuplicate = true;
        return;
      }
      draft.messages.push({
        id: crypto.randomUUID(),
        requestId: currentRequestTraceId(),
        sourceMessageId: event.messageId,
        role: 'user',
        type: event.type,
        groupId: event.groupId,
        userId: event.userId,
        nickname: event.nickname,
        content: event.text,
        media: event.images?.length ? { images: event.images } : undefined,
        mentions: mentionNames.size ? [...mentionNames.values()] : undefined,
        inContext: decision.inContext !== false,
        createdAt: nowIso()
      });
      draft.decisions.push({
        id: crypto.randomUUID(),
        requestId: currentRequestTraceId(),
        messageId: event.messageId,
        groupId: event.groupId,
        userId: event.userId,
        shouldReply: decision.shouldReply,
        reason: decision.reason,
        createdAt: nowIso()
      });
    });
    if (persistedDuplicate) {
      return { replied: false, reason: '忽略已持久化的重复 OneBot message_id', duplicate: true };
    }

    const memoryRecord = recordMemoryObservation(event, userPolicy);
    if (memoryRecord.shouldUpdate) {
      void runBackgroundTask('memory.profile', () => maybeUpdateMemoryProfile(event));
    } else {
      maybeSweepDueMemoryProfiles(event);
    }
    if (event.images?.length) {
      void runBackgroundTask('memory.image-summary', () => maybeRecordImageMemorySummary(event, userPolicy));
    }

    // Group profile auto-update: increment pending counter, trigger if threshold reached
    if (event.type === 'group' && event.groupId && event.groupId !== 'private') {
      incrementGroupProfilePending(db, event.groupId, event.text);
      const xpResult = processXpGain(event, db);
      incrementPairPending(db, event.groupId, event.userId);

      // Level-up phrase: generated and queued; delivered when pippi next
      // replies to this player (never popped as a standalone message).
      if (xpResult.levelUp && db.settings.levelUpNotifyEnabled !== false) {
        const oldPp = levelToPp(xpResult.oldLevel);
        const newPp = levelToPp(xpResult.newLevel);
        void runBackgroundTask('level-up.phrase', async () => {
          try {
            const liveDb = readDb();
            // Real player pp (osu API has a 6h cache; skill snapshot as fallback).
            let realPp = null;
            const binding = liveDb.osuBindings?.[String(event.userId)];
            if (binding) {
              try {
                const { getUserById } = await import('./osu/api.js');
                const user = await getUserById(binding.id, 'osu');
                realPp = Math.round(Number(user.statistics?.pp || 0));
              } catch {
                const record = (liveDb.skillStore?.records || []).find(
                  (r) => Number(r.osuUserId) === Number(binding.id),
                );
                if (record?.pp) realPp = Math.round(Number(record.pp));
              }
            }
            const contextLines = recentGroupMessages(liveDb, event.groupId, 5)
              .map((m) => `${m.nickname || m.userId}: ${String(m.content || '').slice(0, 60)}`)
              .join('\n') || '（暂无）';
            const congratsPrompt = buildLevelUpPrompt(
              event.nickname || '你',
              oldPp,
              newPp,
              realPp,
              contextLines,
            );
            const { completeChat } = await import('./bot/llm.js');
            const resp = await completeChat(readDb(), { messages: [{ role: 'user', content: congratsPrompt }], temperature: 0.9, maxTokens: 60, label: '升级短语' });
            const congratsText = resp.text?.trim() || levelUpFallback(oldPp, newPp, realPp);
            updateDb((draft) => {
              draft.pendingLevelUps = draft.pendingLevelUps || {};
              draft.pendingLevelUps[String(event.userId)] = { text: congratsText, at: nowIso() };
              // Keep the queue bounded: drop the oldest when oversized.
              const keys = Object.keys(draft.pendingLevelUps);
              if (keys.length > 200) {
                const sorted = keys.sort((a, b) =>
                  String(draft.pendingLevelUps[a].at).localeCompare(String(draft.pendingLevelUps[b].at)),
                );
                for (const k of sorted.slice(0, keys.length - 200)) delete draft.pendingLevelUps[k];
              }
            });
          } catch { /* non-fatal */ }
        });
      }
    }
  }

  if (!decision.shouldReply) return { replied: false, reason: decision.reason };

  if (decision.visualLimitation) {
    const replyText = visualLimitationReply(event, db);
    traceEvent('SEND', 'deterministic_visual_reply_started', { contentLength: replyText.length });
    const segments = await sendReplySegments(sendMessage, event, replyText);
    traceEvent('SEND', 'deterministic_visual_reply_sent', { status: 'ok', segmentCount: segments.length });
    updateDb((draft) => {
      draft.messages.push({
        id: crypto.randomUUID(),
        requestId: currentRequestTraceId(),
        ...replyTargetMetadata(event),
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

  // Per-member FIFO: members of the same group reply in parallel, while each
  // member's own rapid messages stay ordered (and get merged on drain).
  const replyLockKey = event.type === 'group'
    ? `group:${event.groupId}:${event.userId}`
    : `private:${event.userId}`;
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
    traceEvent('QUEUE', 'reply_enqueued', { status: 'waiting', position: queueState.queue.length });
    return { replied: false, reason, queued: true, queuePosition: queueState.queue.length };
  }
  queueState.locked = true;
  queueOwner.key = replyLockKey;

  let thinkingTimer = null;
let waitUpTimer = null;
  let modelStageStarted = false;
  let deliveryStarted = false;
  try {
    // QUICK_CONTEXT_FIX_QB08: before building this conversational turn's
    // context, drain any pending quick observation whose visible reply already
    // completed for THIS group+user. Bounded by QUICK_CONTEXT_PENDING_WAIT_MS;
    // no pending work means zero added latency.
    await settlePendingQuickObservations(event);
    const liveDb = readDb();
    const liveGroup = getGroup(liveDb, event.groupId) || { groupId: event.groupId, name: '私聊' };
    const liveUserPolicy = getUserPolicy(liveDb, event.groupId, event.userId);
    const messages = buildPrompt(liveDb, liveGroup, event, liveUserPolicy);
    traceEvent('PROMPT', 'prompt_built', {
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      totalCharacters: messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
      includesVision: Boolean(event?.images?.length),
    });
    const responseOptions = responseOptionsFor(event, liveDb, liveUserPolicy);
    const turnId = String(event.messageId || crypto.randomUUID());
    const reasoningRouter = createShadowReasoningRouter();
    const explicitSearch = asksForExplicitSearch(event.text);
    // osu! data queries use their own deterministic routing. Don't let the
    // generic "查/搜" search keyword match eat them before tool availability
    // is checked — the requiredTool path handles data retrieval directly.
    let osuDataIntent = detectRequiredOsuTool(event.text);
    // BP 谱面类型/组成问题（含显式点名 osu_oracle）必须走确定性 bp_type 路由，
    // 不允许 LLM 用上下文旧数据编造比例。
    if (detectBpTypeAnalysisIntent(event.text)) {
      const bpTypeUsername = extractBpTypeUsername(event.text);
      osuDataIntent = {
        toolName: 'query_osu',
        args: {
          capability: 'bp_type',
          ...(bpTypeUsername ? { username: bpTypeUsername } : {}),
        },
      };
    }
    const registryHere = loadRegistry(liveDb);
    const namedBotRequest = detectNamedBotRequest(event.text, registryHere.bots || []);
    traceEvent('ROUTER', 'conversation_route_resolved', {
      explicitSearch,
      osuCapability: osuDataIntent?.args?.capability || '',
      namedBotId: namedBotRequest?.botId || '',
    });
    let namedBotDowngradeNotice = '';

    // If the user explicitly named a bot (猫猫/雨沐/etc.) AND asked for recent
    // data with a truly-supported selector, carry the bot choice into the
    // required tool. Only yumu/kanon are distinct recent selectors in
    // executeInternalBotCommand (yumu → !r, kanon → !re); hydrant/lazybot are
    // NOT supported selectors and must degrade explicitly instead of being
    // silently mapped to the yumu compatibility bridge.
    if (osuDataIntent && namedBotRequest) {
      if (
        osuDataIntent.args.capability === 'recent' &&
        (RECENT_BOT_SELECTOR_IDS as readonly string[]).includes(namedBotRequest.botId)
      ) {
        osuDataIntent.args.bot = namedBotRequest.botId;
      } else {
        // Named-bot constraint on a capability/value that does not have a real
        // executor selection must never be dropped silently. Keep the internal
        // result but tell the user explicitly that the requested bot selection
        // was degraded.
        const capabilityLabels: Record<string, string> = {
          bp: 'BP 查询',
          bp_type: 'BP 类型分析',
          info: '玩家信息',
          profile: '玩家资料',
          ppplus: 'PP+ 分析',
          skill: '技能分析',
          recent: '最近成绩',
          recommend: '谱面推荐',
        };
        const capabilityLabel = capabilityLabels[osuDataIntent.args.capability] || 'osu 数据查询';
        namedBotDowngradeNotice =
          `[系统] 你点名的「${namedBotRequest.botName}」暂不支持在“${capabilityLabel}”中指定；` +
          '本次查询已降级为 Wuxin 内部数据，结果照常给出。';
      }
    }

    // Surface the degradation immediately instead of silently executing a
    // plain internal query_osu. The internal result still follows this notice.
    if (namedBotDowngradeNotice) {
      if (sendMessage) await sendMessage(event, namedBotDowngradeNotice);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: namedBotDowngradeNotice, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
    }

    // ── Named-bot invocation guard ──
    // User explicitly names a bot to do something (用猫猫查…、调用LazyBot). Without
    // a real Harness adapter we must NOT impersonate the bot via query_osu and must
    // NOT run a web search. Reply honestly exactly once.
    if (namedBotRequest && !osuDataIntent) {
      const replyText = `${namedBotRequest.botName}目前没有接入 Harness 的真实调用通道。无心内部 osu! 查询可以提供类似数据。`;
      if (sendMessage) await sendMessage(event, replyText);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      return { replied: true, text: replyText, reason: 'named_bot_no_adapter' };
    }

    // Explicit search still has a deterministic availability guard. Query
    // planning and execution happen later through the LLM tool loop.
    if (explicitSearch && !osuDataIntent && !namedBotRequest && !isSearchAvailable(liveDb)) {
      // Search requested but no real provider configured — don't let LLM fake it
      const replyText = '当前还没有接入真实联网搜索源。可以在控制台「模型」页配置 SearXNG 或其他搜索服务。';
      if (sendMessage) await sendMessage(event, replyText);
      updateDb((draft) => {
        draft.messages.push({ id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      return { replied: true, text: replyText, reason: '搜索请求但未接入真实搜索源' };
    }

    // Natural replies decide an optional sticker only in their final model
    // output. Data queries, explicit searches and named-bot routes keep their
    // existing delivery semantics and do not pay for a sticker envelope.
    const stickerCapability = resolveStickerReplyCapability({
      eligible: !explicitSearch && !osuDataIntent && !namedBotRequest,
      deliveryMode: stickerDeliveryConfig(liveDb).mode,
    });
    if (stickerCapability.reason === 'catalog_unavailable') {
      recordStickerReplyCapabilityWarning(new Error('manifest or visual annotations could not be loaded'));
    }
    const stickerReplyEnabled = stickerCapability.enabled;
    const stickerReplyInstruction = stickerCapability.instruction;

    const searchMode = responseOptions.searchMode || liveDb.settings.webSearchMode || 'balanced';
    const maxSearchCalls = searchMode === 'deep' ? 3 : (searchMode === 'fast' ? 1 : 2);
    const agentRuntimeMode = agentRuntimeModeFor(liveDb);
    const modelFirstRuntime = agentRuntimeMode === 'model_first';
    const registryForTurn = loadRegistry(liveDb);
    const hasEnabledBots = enabledBots(registryForTurn).length > 0;
    const botTools = hasEnabledBots
      ? buildBotToolSchemas(registryForTurn, { surface: modelFirstRuntime ? 'v2' : 'legacy' })
      : [];
    // Clear osu! data intents keep their deterministic domain tool. Other
    // conversational turns receive search_web and let the LLM decide whether,
    // what and how to search.
    const searchToolEnabled = isSearchAvailable(liveDb) && (modelFirstRuntime || !osuDataIntent);
    const toolsForTurn = [
      ...botTools,
      ...(searchToolEnabled ? [buildSearchToolSchema()] : []),
    ];
    const useTools = toolsForTurn.length > 0;
    traceEvent('ROUTER', 'execution_path_selected', {
      route: useTools ? 'tool_loop' : 'direct_model',
      enabledToolNames: toolsForTurn.map((tool) => tool?.function?.name).filter(Boolean),
      explicitSearch,
      requiredOsuCapability: osuDataIntent?.args?.capability || '',
      agentRuntimeMode,
    });

    // Thinking notice — configurable per thinkingNoticeMode
    modelStageStarted = true;
    const thinkingMode = liveDb.settings.thinkingNoticeMode || 'slow';
    const thinkingDelay = Number(liveDb.settings.thinkingNoticeDelayMs || 3000);
    let thinkingSent = false;

    // 图由代码直接触发（pickSticker + withSticker），不经过 LLM —— 「正在查询」这类提示
    // 发生在 LLM 还没出声的时候（实测 /w info 要 40~70 秒），本来就不可能有 LLM 文案。
    // thinking 是 4 张的池，这里随机取一张。
    const sendThinking = async (text, stickerKey = 'thinking') => {
      if (thinkingSent || !sendMessage) return;
      thinkingSent = true;
      const picked = pickCodeSticker(stickerKey);
      await sendMessage(event, picked ? withSticker(text, picked.id) : text);
    };

    if (thinkingMode === 'simple') {
      await sendOptionalNotice(() => sendThinking('正在思考…'));
    } else if (thinkingMode === 'detail') {
      const currentModel = activeModelName(liveDb.settings);
      const modelHint = responseOptions.overrideModel && responseOptions.overrideModel !== currentModel
        ? describeModel(responseOptions.overrideModel)
        : describeModel(currentModel);
      await sendOptionalNotice(() => sendThinking(`深度思考中（${modelHint}）…`));
    } else if (thinkingMode === 'slow') {
      thinkingTimer = setTimeout(() => {
        void sendOptionalNotice(() => sendThinking(useTools ? '正在查询或整理结果…' : '正在进行思考…'));
      }, thinkingDelay);
    }
    // 'off' — never send

    // 二段提示：查询拖久了再发一张「别催·在算了」。一段（thinking）默认 3 秒，
    // 二段默认 25 秒 —— 让用户在长查询中途知道 bot 没死。thinkingNoticeMode 为 off 时两段都不发。
    if (thinkingMode !== 'off') {
      waitUpTimer = setTimeout(() => {
        void sendOptionalNotice(async () => {
          if (!sendMessage) return;
          const picked = pickSticker('wait_up');
          const text = useTools ? '还在查，稍等一下…' : '还在处理，稍等一下…';
          await sendMessage(event, picked ? withSticker(text, picked.id) : text);
        });
      }, Number(liveDb.settings.waitUpNoticeDelayMs || 25000));
    }

    // If user asks to look at images but none attached, attach only the most
    // recent relevant image. This keeps vision on-demand and avoids paying for
    // every image posted in an active group.
    let visionImages = modelSupportsVision(liveDb) ? collectEventVisionImages(event) : [];
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
    if (osuDataIntent && !hasEnabledBots) {
      const errorText = '[系统] osu! 数据查询不可用：当前没有已启用的机器人，无法查询 osu! 数据。';
      // 服务不可用 —— 附 service_down。图由代码触发，不经过 LLM，所以模型挂掉时也发得出。
      // service_down 是一组差分，用 pickCodeSticker 从组里随机取一张；取不到就退回纯文字，
      // 不让「故障提示」本身因为贴纸问题发不出去。记进库里的是纯文字：CQ 码进上下文只是噪音。
      const noticeSticker = pickCodeSticker('service_down');
      if (sendMessage) await sendMessage(event, noticeSticker ? withSticker(errorText, noticeSticker.id) : errorText);
      updateDb((draft) => {
        draft.messages.push({
          id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type,
          groupId: event.groupId, userId: 'bot', nickname: '机器人',
          content: errorText, inContext: true, createdAt: nowIso()
        });
        draft.usage.replies += 1;
      });
      return { replied: true, text: errorText, reason: 'osu_intent_no_bots' };
    }

    // ── Bot harness tool loop ──
    let ai;
    let toolImages = [];
    let toolDeliverImages = [];
    let toolDirectContent = '';
    let modelStickerPath = '';
    let modelStickerCqCode = '';
    let modelStickerReservationId = '';
    let modelStickerDebugSession: StickerDebugSession | null = null;
    let modelStickerSelectionValid = false;
    let modelStickerHistory = null;
    let requiredToolLed = false;
    let evidenceProtectedTurn = false;
    if (useTools) {
      const registry = registryForTurn;
      const tools = toolsForTurn;
      // ── Deterministic osu! data routing ──
      // When the user's intent is an unambiguous data lookup, we execute the
      // tool before the LLM sees the context. This prevents context poisoning
      // where repeated queries cause the model to skip tool calls.
      let requiredTool: { toolName: string; args: Record<string, unknown> } | undefined;
      let evidenceRequirement: { toolName: string; args: Record<string, unknown> } | undefined;
      if (osuDataIntent) {
        const internalBotsEnabled = enabledBots(registry).some((b) => b.channel === 'internal');
        const opValid = validateOperation({
          type: 'query_osu',
          params: osuDataIntent.args,
        });
        if (internalBotsEnabled && opValid.ok) {
          if (modelFirstRuntime) evidenceRequirement = osuDataIntent;
          else requiredTool = osuDataIntent;
        } else {
          const reason = !internalBotsEnabled
            ? '内部 osu! 工具未启用'
            : `操作被安全策略拒绝: ${(opValid as any).reason || '未知原因'}`;
          const errorText = `[系统] osu! 数据查询不可用：${reason}`;
          const noticeSticker = pickCodeSticker('service_down');
          if (sendMessage) await sendMessage(event, noticeSticker ? withSticker(errorText, noticeSticker.id) : errorText);
          updateDb((draft) => {
            draft.messages.push({
              id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type,
              groupId: event.groupId, userId: 'bot', nickname: '机器人',
              content: errorText, inContext: true, createdAt: nowIso()
            });
            draft.usage.replies += 1;
          });
          return { replied: true, text: errorText, reason };
        }
      }

      // P1B conditional tool-guidance injection. The deterministic required
      // tool path is the only runtime state that narrows the exposed
      // capability set for this turn; otherwise the unified query_osu tool
      // exposes the full callable catalog and guidance stays full.
      const requiredCapability = requiredTool?.toolName === 'query_osu' && requiredTool.args?.capability
        ? String(requiredTool.args.capability)
        : null;
      if (messages[0]?.role === 'system') {
        if (modelFirstRuntime) {
          messages[0].content = rewriteLegacyToolReferencesForV2(messages[0].content);
        }
        const guidanceBlocks = [];
        if (modelFirstRuntime) {
          guidanceBlocks.push(buildAgentAutonomyGuidance({ searchEnabled: searchToolEnabled, maxSearchCalls }));
        } else {
          if (botTools.length > 0) {
            guidanceBlocks.push(requiredCapability
              ? buildToolGuidance({ exposedCapabilities: [requiredCapability] })
              : buildToolGuidance());
          }
          if (searchToolEnabled) {
            guidanceBlocks.push(buildSearchToolGuidance({ explicitSearch, maxCalls: maxSearchCalls }));
          }
        }
        if (guidanceBlocks.filter(Boolean).length > 0) {
          messages[0].content += '\n\n' + guidanceBlocks.filter(Boolean).join('\n\n');
        }
      }

      let webSearchCalls = 0;
      const executeConversationTool = async (toolCall, context) => {
        assertLlmTurnActive();
        if (String(toolCall?.function?.name || '') !== SEARCH_TOOL_NAME) {
          return executeToolCall(toolCall, context);
        }
        if (!searchToolEnabled) {
          return { toolCallId: toolCall.id, ok: false, content: '当前未开放网页搜索', error: 'search_unavailable' };
        }
        if (webSearchCalls >= maxSearchCalls) {
          return { toolCallId: toolCall.id, ok: false, content: `本轮网页搜索已达到 ${maxSearchCalls} 次上限`, error: 'search_call_limit' };
        }
        webSearchCalls += 1;
        return executeSearchToolCall(toolCall, context);
      };

      let toolLoopModel = '';
      let toolLoopProvider = '';
      const harnessChat = async (db: any, opts: any) => {
        const result = await completeChat(db, {
          ...opts,
          searchMode,
          visionImages,
          label: opts.label || 'Bot Harness'
        });
        toolLoopModel = String(result?.model || toolLoopModel || '');
        toolLoopProvider = String(result?.provider || toolLoopProvider || '');
        return result;
      };
      const loopOptions = {
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
        evidenceRequirement,
        // 自然聊天不回显工具原文：数据只供 LLM 参考并自然融入回答。
        // 显式指令（/w osu analyze、!p 等）走独立通道，不受此开关影响。
        deliverDirectContent: requiredTool?.args.capability === 'recommend',
        continueAfterDirectPayload: modelFirstRuntime,
        deduplicateToolCalls: modelFirstRuntime,
        structuredToolResults: modelFirstRuntime,
        ...(stickerReplyEnabled && stickerReplyInstruction ? {
          finalResponseFormat: STICKER_REPLY_RESPONSE_FORMAT,
          finalResponseInstruction: stickerReplyInstruction,
        } : {}),
        turnId,
        reasoningRouter,
        executeToolCallFn: executeConversationTool,
      };
      // One user message is one shared tool budget, even when the
      // recommendation hard guard below runs a second runToolLoop.
      let turnToolCallsMade = 0;
      let toolResult = await runToolLoop(harnessChat, {
        ...loopOptions,
        toolCallsExecutedBeforeLoop: turnToolCallsMade,
      });
      evidenceProtectedTurn = Boolean(evidenceRequirement);
      requiredToolLed = Boolean(requiredTool || toolResult.evidenceFallbackExecuted);
      turnToolCallsMade = Number(toolResult.toolCallsMadeThisTurn ?? toolResult.toolCallsMade) || 0;

      // Explicit search is a hard user requirement. Normally the first LLM
      // planner chooses a better query and calls search_web itself. If it
      // ignores the tool contract, execute one bounded fallback search using
      // the cleaned user request, then let the LLM synthesize the result.
      const fallbackSearchQuery = explicitSearch ? extractSearchQuery(event.text) : '';
      if (
        explicitSearch &&
        searchToolEnabled &&
        webSearchCalls === 0 &&
        fallbackSearchQuery.length >= 2
      ) {
        toolResult = mergeToolLoopResults(toolResult, await runToolLoop(harnessChat, {
          ...loopOptions,
          toolCallsExecutedBeforeLoop: turnToolCallsMade,
          requiredTool: { toolName: SEARCH_TOOL_NAME, args: { query: fallbackSearchQuery } },
        }));
        requiredToolLed = true;
        turnToolCallsMade = Number(toolResult.toolCallsMadeThisTurn ?? toolResult.toolCallsMade) || 0;
      }

      // Hard guard: when the user clearly asked for recommendations but the
      // model answered WITHOUT ever running the recommend tool, any map names
      // in the reply are improvising. Re-run the loop with the deterministic
      // tool forced so the final answer is data-backed.
      const fallbackRecommendIntent = !requiredTool && hasFallbackRecommendIntent(event.text);
      if (
        fallbackRecommendIntent &&
        !toolResult.recommendToolCalled &&
        looksLikeRecommendationReply(toolResult.text)
      ) {
        toolResult = mergeToolLoopResults(toolResult, await runToolLoop(harnessChat, {
          ...loopOptions,
          toolCallsExecutedBeforeLoop: turnToolCallsMade,
          requiredTool: { toolName: 'query_osu', args: { capability: 'recommend' } },
          deliverDirectContent: true,
        }));
        turnToolCallsMade = Number(toolResult.toolCallsMadeThisTurn ?? toolResult.toolCallsMade) || 0;
      }

      ai = {
        text: toolResult.text,
        usage: toolResult.usage,
        model: toolLoopModel || activeModelName(liveDb.settings),
        provider: toolLoopProvider || liveDb.settings.llmProvider,
        latencyMs: undefined
      };
      toolImages = toolResult.images || [];
      toolDeliverImages = toolResult.deliverOnlyImages || [];
      toolDirectContent = String(toolResult.directContent || '').trim();
    } else {
      // Phase 2 v1 context dependency: prior context is a precondition only;
      // HIGH is triggered solely by existing deterministic signals.
      const hasPriorContext = messages.filter((m) => m.role !== 'system').length > 1;
      const contextDependent = hasPriorContext
        && (looksLikeReplyToBot(event.text) || shouldUseRecentVisionImage(liveDb, event));
      const convInput = reasoningInput('conversation', { contextDependent });
      let convTurn = emptyTurnState();
      const convDecision = reasoningRouter.resolve(convInput, convTurn);
      convTurn = reasoningRouter.mergeTurn(convTurn, convDecision);
      const convWire = thinkingParamsForLevel(convDecision.level, reasoningEnabledFor(liveDb));
      const finalMessages = stickerReplyEnabled && stickerReplyInstruction
        ? withStickerReplyInstruction(messages, stickerReplyInstruction)
        : messages;
      ai = await callLLM(liveDb, finalMessages, searchMode, {
        maxTokens: responseOptions.maxTokens,
        overrideModel: responseOptions.overrideModel,
        visionImages,
        ...(stickerReplyEnabled && stickerReplyInstruction ? { responseFormat: STICKER_REPLY_RESPONSE_FORMAT } : {}),
        traceRole: 'conversation',
        tracePurpose: 'conversation_reply',
        ...convWire
      });
      reasoningRouter.record({
        turnId,
        ts: Date.now(),
        callRole: 'conversation',
        decision: convDecision,
        input: convInput,
        actual: ai?.meta || null,
      });
    }

    const stickerReply = stickerReplyEnabled
      ? parseStickerReply(ai.text)
      : { reply: String(ai.text || ''), stickerCaption: '', stickerIntent: 'none' as const, captionSplit: false, stickerId: null, mode: 'none' as const, structured: false };
    ai.text = stickerReply.reply;
    const stickerDecisionId = stickerReplyEnabled ? stickerReply.stickerId : null;
    const imageOnlySticker = stickerReplyEnabled && stickerReply.mode === 'image_only';
    // 附文只跟图片一起出现，绝不进 ai.text / deliveredText —— 于是图片发送失败时，
    // 回退路径天然重发不到它，宿主不需要去猜哪句话依赖图片。
    const stickerCaption = stickerReplyEnabled && stickerReply.captionSplit
      ? sanitizeReply(String(stickerReply.stickerCaption || ''), liveDb.settings)
      : '';
    // 模型自报：用户是否明确要求发图。只有这种才在失败时补一句说明。
    // 读意图，不读「有没有选出图」。用户明确要图而这次没选出时，意图仍然是 requested ——
  // 那正是最需要它的时候。
  const stickerExplicitRequest = stickerReplyEnabled && stickerReply.stickerIntent === 'requested';
    let replyText = sanitizeReply(ai.text, liveDb.settings);
    const imageCqCodes = [...toolImages, ...toolDeliverImages].map(toolImageToCq).filter(Boolean);
    const hasDirectToolDelivery = Boolean(toolDirectContent || imageCqCodes.length > 0);
    const rewriteEligible = isWeirdReply(replyText);
    const rewriteSkipReason = normalReplyRewriteSkipReason({
      rewriteEligible,
      toolEvidenceProtected: requiredToolLed || evidenceProtectedTurn,
      hasDirectToolDelivery,
      longForm: Boolean(responseOptions.longForm),
    });
    if (rewriteEligible && rewriteSkipReason) {
      void recordRewriteTelemetry(liveDb, buildRewriteEntry({
        event,
        turnId,
        eligible: true,
        invoked: false,
        skipReason: rewriteSkipReason,
        provider: ai.provider,
        model: ai.model,
        usageAvailable: false,
        latencyMs: null,
        result: 'SKIPPED',
        originalText: replyText,
        rewrittenText: replyText,
      }));
    }
    if (hasDirectToolDelivery) {
      replyText = compactDirectToolLead(replyText, toolDirectContent, imageCqCodes.length > 0);
    } else if (!responseOptions.longForm && rewriteEligible && !rewriteSkipReason) {
      if (isIdentityQuestion(event.text)) {
        void recordRewriteTelemetry(liveDb, buildRewriteEntry({
          event,
          turnId,
          eligible: true,
          invoked: false,
          skipReason: 'identity_question_deterministic',
          provider: ai.provider,
          model: ai.model,
          usageAvailable: false,
          latencyMs: null,
          result: 'SKIPPED',
          originalText: replyText,
          rewrittenText: replyText,
        }));
        replyText = neutralIdentityReply(event, liveDb.settings);
      } else {
        const rewrite = await rewriteNormalReply(liveDb, replyText, event, { reasoningRouter, turnId });
        replyText = sanitizeReply(rewrite.text, liveDb.settings);
        ai.usage = mergeLlmUsage(ai.usage, rewrite.usage);
        // Identity confusion fallback: if rewrite still contains self-negation
        if (isWeirdReply(replyText) && /(没有|没)回应.*(at|@)|(at|@).*(不是.*自己|其他|别人|群友)|不该.*回复|不该.*回应/.test(replyText)) {
          replyText = '我在，刚才识别有点乱。你刚刚是在叫我，对吧？';
        }
      }
    }
    if (!replyText && imageCqCodes.length === 0 && !imageOnlySticker) {
      // The required-tool cosmetic lead can legitimately end up empty when the
      // model only emitted tool-call markup (sanitized away before this point)
      // and no direct payload exists to deliver. Do not claim a result exists
      // ("查好了") — admit the reply failed so the user can retry. Plain
      // conversation replies keep the strict empty-content guard.
      if (requiredToolLed) {
        replyText = '这次查询我这边没整理好，你稍后再试一次？';
      } else {
        throw new Error('模型返回了空内容。');
      }
    }
    if (!replyText && imageCqCodes.length > 0) replyText = '查好了，结果在图里。';

    // Deliver a queued level-up phrase as part of this reply (never standalone).
    const pendingUpKey = String(event.userId);
    const pendingUp = readDb().pendingLevelUps?.[pendingUpKey];
    if (pendingUp?.text) {
      // 文案本身已经走过「LLM 生成 + levelUpFallback 回退」（见上方 completeChat），
      // 这里只把升级的表情挂上 —— 图由代码触发，不依赖 LLM。
      const atLead = withSticker(`[CQ:at,qq=${event.userId}] ${pendingUp.text}`, 'applause');
      replyText = replyText ? `${atLead}\n\n${replyText}` : atLead;
      updateDb((draft) => {
        if (draft.pendingLevelUps) delete draft.pendingLevelUps[pendingUpKey];
      });
    }

    // Validate the model's optional image only after all reply editing is
    // complete. A rewrite or a deterministic lead must be able to veto a
    // now-inappropriate reaction. Direct tool payloads and code-triggered
    // status stickers already have their own delivery semantics.
    if (stickerDecisionId && (replyText.trim() || imageOnlySticker) && !hasDirectToolDelivery && !pendingUp?.text) {
      try {
        modelStickerDebugSession = beginLiveStickerDebug({
          groupId: event.groupId,
          userId: event.userId,
          messageId: event.messageId,
        });
        const debugDryRun = stickerDebugShouldDryRun({ groupId: event.groupId, userId: event.userId });
        const validation = validateStickerSelection({
          stickerId: stickerDecisionId,
          verifyHashes: false,
        });
        modelStickerHistory = {
          id: stickerDecisionId,
          ...(validation.selected?.emotion ? { emotion: validation.selected.emotion } : {}),
          ...(validation.selected?.description ? { description: validation.selected.description } : {}),
          outcome: 'rejected',
          ...(validation.reason ? { reason: validation.reason } : {}),
        };
        if (modelStickerDebugSession) {
          modelStickerDebugSession.record('catalog_validated', validation.validation?.ok ? 'ok' : 'failed', {
            manifestCount: validation.validation?.manifestCount,
            annotationCount: validation.validation?.annotationCount,
            verifyHashes: false,
          });
          modelStickerDebugSession.record('catalog_loaded', validation.ok ? 'ok' : 'failed', {
            candidateCount: validation.candidateCount || 0,
          });
          modelStickerDebugSession.record('model_selected', 'received', { stickerId: stickerDecisionId });
        }
        if (!validation.ok) {
          modelStickerDebugSession?.finish('failed', {
            reason: validation.reason || 'selection_rejected',
            error: validation.error,
            sendSkipped: true,
          });
          traceEvent('TOOL', 'sticker_final_decision', {
            status: 'rejected',
            stickerId: stickerDecisionId,
            stickerDebugTraceId: modelStickerDebugSession?.traceId,
            structured: stickerReply.structured,
            sendSkipped: true,
            deliveryReason: validation.reason || 'selection_rejected',
          });
        } else if (debugDryRun) {
          modelStickerSelectionValid = true;
          modelStickerHistory = {
            ...modelStickerHistory,
            ...(validation.selected?.emotion ? { emotion: validation.selected.emotion } : {}),
            ...(validation.selected?.description ? { description: validation.selected.description } : {}),
            outcome: 'dry_run',
            reason: 'debug_dry_run',
          };
          modelStickerDebugSession?.record('selection_validated', 'ok', validation.selected || {});
          modelStickerDebugSession?.record('send_requested', 'skipped', { reason: 'debug_dry_run' });
          modelStickerDebugSession?.finish('dry_run', { wouldSend: validation.selected?.id, sendSkipped: true });
          traceEvent('TOOL', 'sticker_final_decision', {
            status: 'dry_run',
            stickerId: stickerDecisionId,
            stickerDebugTraceId: modelStickerDebugSession?.traceId,
            structured: stickerReply.structured,
            sendSkipped: true,
            deliveryReason: 'debug_dry_run',
          });
        } else {
          modelStickerSelectionValid = true;
          const delivery = sendMessage
            ? reserveStickerDelivery({
                eventType: event.type,
                groupId: event.groupId,
                userId: event.userId,
                messageId: event.messageId,
                stickerId: stickerDecisionId,
              })
            : { ok: false, reason: 'mode' as const };
          modelStickerDebugSession?.record('selection_validated', 'ok', validation.selected || {});
          if (delivery.ok && delivery.path) {
            modelStickerPath = delivery.path;
            modelStickerCqCode = toolImageToCq(delivery.path);
            modelStickerReservationId = delivery.reservationId || '';
            modelStickerHistory = {
              ...modelStickerHistory,
              ...(validation.selected?.emotion ? { emotion: validation.selected.emotion } : {}),
              ...(validation.selected?.description ? { description: validation.selected.description } : {}),
              outcome: 'reserved',
            };
            modelStickerDebugSession?.record('send_requested', 'reserved', {
              stickerId: delivery.stickerId,
              reservationId: delivery.reservationId,
            });
          } else {
            modelStickerHistory = {
              ...modelStickerHistory,
              outcome: 'rejected',
              reason: delivery.reason || 'mode',
            };
            modelStickerDebugSession?.finish('completed', {
              sendSkipped: true,
              deliveryReason: delivery.reason || 'mode',
            });
          }
          traceEvent('TOOL', 'sticker_final_decision', {
            status: delivery.ok ? 'live_reserved' : 'validated',
            stickerId: stickerDecisionId,
            stickerDebugTraceId: modelStickerDebugSession?.traceId,
            structured: stickerReply.structured,
            sendSkipped: !delivery.ok,
            deliveryReason: delivery.reason || '',
          });
        }
      } catch (error) {
        modelStickerHistory = {
          ...(modelStickerHistory || { id: stickerDecisionId }),
          outcome: 'rejected',
          reason: 'validation_error',
        };
        modelStickerDebugSession?.finish('failed', {
          sendSkipped: true,
          error: String((error as Error)?.message || error).slice(0, 300),
        });
        traceEvent('TOOL', 'sticker_final_decision', {
          status: 'error',
          stickerId: stickerDecisionId,
          structured: stickerReply.structured,
          stickerDebugTraceId: modelStickerDebugSession?.traceId,
          sendSkipped: true,
          error: String((error as Error)?.message || error).slice(0, 300),
        });
      }
    }

    // An image-only decision is optional. If validation, policy, or delivery
    // prevents the image, retain a small text fallback instead of emitting an
    // empty QQ message.
    //
    // 分两种情形，别混在一起：
    //   没选到图（校验或策略拒绝）—— 收尾的失败分支不会经过，现在就得说；
    //   有图待发 —— 空正文留给收尾，那里才知道送没送到，说的也是实话。
    if (stickerExplicitRequest && !modelStickerCqCode) {
      replyText = [replyText, stickerFailureNotice({ explicitRequest: true, bodyDelivered: false })]
        .filter(Boolean).join('\n');
    } else {
      replyText = ensureStickerReplyFallback(replyText, modelStickerCqCode, {
        deferToNotice: stickerExplicitRequest,
      });
    }

    // Count the eligible natural reply before the actual image send. A
    // confirmed or unknown OneBot outcome must not erase the denominator used
    // to calibrate proposal and delivery rates.
    if (stickerReplyEnabled) {
      try {
        updateDb((draft) => {
          recordStickerDecisionInDb(draft, {
            mode: stickerReply.mode,
            stickerId: stickerDecisionId || undefined,
            validSelection: modelStickerSelectionValid,
            groupId: event.groupId,
          });
        });
      } catch (error) {
        traceEvent('ERROR', 'sticker_metrics_record_failed', {
          status: 'degraded',
          error: String(error?.message || error).slice(0, 200),
        });
      }
    }

    let deliveredText = [replyText, toolDirectContent].filter(Boolean).join('\n\n');
    const deliveredMediaImages = toolImages.map(toolImageToMediaInput).filter(Boolean);

    // Merged-forward cards require BOTH: the output would actually split into
    // two or more messages (as judged by the same segmenter used for normal
    // delivery) AND it exceeds the character floor. Replies within 200 chars
    // never use the forward card; a single-speech output stays a normal
    // message even if it is long; only explicit long-form tasks force the card.
    const segmentCount = splitReplySegments(deliveredText).length;
    const withinMergeFloor = deliveredText.length <= MERGE_FORWARD_MIN_CHARS;
    const isLongReply = responseOptions.longForm || (!withinMergeFloor && segmentCount >= 2);
    let segments;
    let deliveryStatus = 'ok';
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    if (waitUpTimer) { clearTimeout(waitUpTimer); waitUpTimer = null; }
    deliveryStarted = true;
    traceEvent('SEND', 'qq_delivery_started', {
      contentLength: deliveredText.length,
      imageCount: imageCqCodes.length + (modelStickerCqCode ? 1 : 0),
      deliveryMode: hasDirectToolDelivery ? 'direct-tool' : (isLongReply ? 'forward' : 'segments'),
    });
    if (hasDirectToolDelivery) {
      // Structured tool output bypasses both the LLM restatement and the
      // three-segment/merged-forward paths. NapCat receives one complete,
      // deterministic message with any images appended structurally.
      const outboundText = [deliveredText, ...imageCqCodes].filter(Boolean).join('\n');
      if (sendMessage) await sendMessage(event, outboundText, replyToCurrentMessageOptions(event));
      segments = [outboundText];
    } else if (modelStickerCqCode && sendMessage) {
      const completeModelStickerOutcome = (stickerOutcome: StickerDeliveryOutcome, error?: unknown) => {
        if (modelStickerReservationId) {
          completeStickerDelivery(modelStickerReservationId, stickerOutcome);
        }
        if (isLongReply && stickerOutcome !== 'confirmed_success' && stickerOutcome !== 'accepted_unknown') {
          deliveryStatus = 'partial';
        }
        modelStickerHistory = {
          ...(modelStickerHistory || { id: stickerDecisionId }),
          outcome: stickerOutcome,
          ...(error ? { reason: String(error?.message || error).slice(0, 240) } : {}),
        };
        modelStickerDebugSession?.record('send_confirmed', stickerOutcome, {
          stickerId: stickerDecisionId,
          reservationId: modelStickerReservationId || undefined,
        });
        modelStickerDebugSession?.finish(
          stickerOutcome === 'confirmed_success' || stickerOutcome === 'accepted_unknown' ? 'completed' : 'failed',
          { outcome: stickerOutcome, sendSkipped: false },
        );
        traceEvent('SEND', 'sticker_delivery_completed', {
          status: stickerOutcome,
          stickerId: stickerDecisionId,
          reservationId: modelStickerReservationId || undefined,
          ...(error ? { error: String(error?.message || error).slice(0, 300) } : {}),
        });
      };
      try {
        let stickerResult;
        if (isLongReply) {
          await sendForwardText(sendMessage, event, 'Wuxin 回复', deliveredText);
          // The body is already visible to the user. A later optional sticker
          // failure must not turn this successful turn into replied=false or
          // cause the long body to be sent a second time.
          segments = [deliveredText];
          try {
            stickerResult = await sendMessage(event, [stickerCaption, modelStickerCqCode].filter(Boolean).join('\n'), replyToCurrentMessageOptions(event));
            segments = [deliveredText, [stickerCaption, modelStickerCqCode].filter(Boolean).join('\n')];
            const rawOutcome = stickerResult?.outcome;
            const stickerOutcome: StickerDeliveryOutcome = rawOutcome === 'confirmed_success'
              || rawOutcome === 'accepted_unknown'
              || rawOutcome === 'confirmed_failure'
              || rawOutcome === 'unknown'
              ? rawOutcome
              : 'unknown';
            completeModelStickerOutcome(stickerOutcome);
          } catch (error) {
            const confirmedFailure = error?.deliveryOutcome === 'confirmed_failure';
            deliveryStatus = 'partial';
            completeModelStickerOutcome(confirmedFailure ? 'confirmed_failure' : 'unknown', error);
            // 正文已经单独发过了，这里补一句配图的情况。以前这条路径只记录不吭声
            // —— 外层 catch 被这个内层吞掉，于是「表情那张没发出去」从来没有
            // 在长正文这条路上发出过。结果未知时不补：原请求可能已经落地。
            if (confirmedFailure) {
              const notice = stickerFailureNotice({ explicitRequest: stickerExplicitRequest, bodyDelivered: true });
              if (notice && sendMessage) {
                await sendOptionalNotice(() => sendMessage(event, notice, replyToCurrentMessageOptions(event)));
              }
            }
          }
        } else {
          // 附文只在这一条里出现 —— 它跟图片同生共死，于是图片失败时天然不会被重发。
          const outboundText = [deliveredText, stickerCaption, modelStickerCqCode].filter(Boolean).join('\n');
          stickerResult = await sendMessage(event, outboundText, replyToCurrentMessageOptions(event));
          segments = [outboundText];
          const rawOutcome = stickerResult?.outcome;
          const stickerOutcome: StickerDeliveryOutcome = rawOutcome === 'confirmed_success'
            || rawOutcome === 'accepted_unknown'
            || rawOutcome === 'confirmed_failure'
            || rawOutcome === 'unknown'
            ? rawOutcome
            : 'unknown';
          completeModelStickerOutcome(stickerOutcome);
        }
      } catch (error) {
        const confirmedFailure = error?.deliveryOutcome === 'confirmed_failure';
        let fallbackSent = false;
        // A confirmed image failure means the combined text+image request was
        // not accepted. Deliver the necessary text alone; an unknown outcome
        // is never retried because the original request may have landed.
        const fallbackText = stickerFailureFallback({
          deliveredText,
          confirmedFailure,
          isLongReply,
        });
        // 明确要图却没送达时补一句实话。长正文已经单独发过，所以那种情况只说配图。
        // 不确定结果（unknown）不补 —— 原请求可能已经落地，不能被说成失败。
        const notice = confirmedFailure
          ? stickerFailureNotice({ explicitRequest: stickerExplicitRequest, bodyDelivered: isLongReply })
          : '';
        // notice 已经是一句实话，别再叠一个「收到。」占位句；但正文非空时要保留它。
        const placeholderOnly = fallbackText === '收到。';
        const outboundFallback = [notice && placeholderOnly ? '' : fallbackText, notice].filter(Boolean).join('\n');
        if (outboundFallback && sendMessage) {
          try {
            await sendMessage(event, outboundFallback, replyToCurrentMessageOptions(event));
            deliveredText = outboundFallback;
            segments = [outboundFallback];
            fallbackSent = true;
          } catch {
            // Keep the original confirmed failure if even the text fallback fails.
          }
        }
        if (modelStickerReservationId) {
          completeStickerDelivery(
            modelStickerReservationId,
            confirmedFailure ? 'confirmed_failure' : 'unknown',
          );
        }
        modelStickerHistory = {
          ...(modelStickerHistory || { id: stickerDecisionId }),
          outcome: confirmedFailure ? 'confirmed_failure' : 'unknown',
          reason: String(error?.message || error).slice(0, 240),
        };
        modelStickerDebugSession?.record('send_confirmed', confirmedFailure ? 'confirmed_failure' : 'unknown', {
          stickerId: stickerDecisionId,
          reservationId: modelStickerReservationId || undefined,
        });
        modelStickerDebugSession?.finish('failed', { sendSkipped: false });
        traceEvent('SEND', 'sticker_delivery_completed', {
          status: confirmedFailure ? 'confirmed_failure' : 'unknown',
          stickerId: stickerDecisionId,
          reservationId: modelStickerReservationId || undefined,
          error: String(error?.message || error).slice(0, 300),
        });
        if (!fallbackSent) throw error;
      }
    } else if (isLongReply && sendMessage) {
      await sendForwardText(sendMessage, event, 'Wuxin 回复', deliveredText);
      segments = [deliveredText];
    } else {
      segments = await sendReplySegments(sendMessage, event, deliveredText);
    }
    traceEvent('SEND', 'qq_delivery_completed', { status: deliveryStatus, segmentCount: segments.length });

    updateDb((draft) => {
      draft.messages.push({
        id: crypto.randomUUID(),
        requestId: currentRequestTraceId(),
        ...replyTargetMetadata(event),
        role: 'assistant',
        type: event.type,
        groupId: event.groupId,
        userId: 'bot',
        nickname: '机器人',
        content: deliveredText,
        media: deliveredMediaImages.length > 0 ? { images: deliveredMediaImages } : undefined,
        sticker: modelStickerHistory || undefined,
        inContext: true,
        createdAt: nowIso()
      });
      applyUsageTotals(draft.usage, ai.usage);
      if (!ai.usage?.accounted) draft.usage.requests += 1;
      draft.usage.replies += Math.max(1, segments.length);
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({
        id: crypto.randomUUID(),
        kind: 'reply-delivery',
        requestId: currentRequestTraceId(),
        status: 'completed',
        groupId: event.groupId,
        userId: event.userId,
        model: ai.model || activeModelName(liveDb.settings),
        provider: ai.provider || liveDb.settings.llmProvider,
        ...usageEventFields(ai.usage),
        createdAt: nowIso()
      });
      draft.usageEvents = draft.usageEvents.slice(-5000);
    });

    return {
      replied: true,
      text: deliveredText,
      images: toolImages,
      stickers: [...toolDeliverImages, ...(modelStickerPath ? [modelStickerPath] : [])],
      segments,
      usage: ai.usage,
      latencyMs: ai.latencyMs,
      reason: decision.reason
    };
  } catch (error) {
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    if (waitUpTimer) { clearTimeout(waitUpTimer); waitUpTimer = null; }
    traceEvent(deliveryStarted ? 'SEND' : 'ERROR', deliveryStarted ? 'qq_delivery_failed_or_unknown' : 'reply_generation_failed', { status: 'error', error: String(error) });
    // Once QQ delivery starts, timeout may mean accepted-but-unacknowledged.
    // Do not resend the answer or a contradictory failure notice in that case.
    // Natural group participation is opportunistic. If its model turn fails,
    // do not create a second unsolicited group message just to announce the
    // failure. Direct @mentions explicitly asked for a response and may still
    // receive the existing failure notice.
    const directConversation = event.type === 'private';
    if (modelStageStarted && !deliveryStarted && sendMessage
      && (event.replyToCurrentMessage === true || directConversation)) {
      // 这是最该配图的一条：回复内容没生成出来，但「服务挂了、举白旗认输」这个意思
      // 是确定的，而 service_down 正是 gate=code 的状态图 —— 走 withSticker 不经过 LLM，
      // 所以 LLM 超时/挂掉时它照样发得出去。
      // service_down 现在是一组 8 张差分（跪地举旗 / 站立举旗 / 摊手 / 趴桌 …），
      // 由代码随机取一张。取不到时退回纯文字 —— 兜底提示本身不能因为贴纸发不出去。
      const failureNotice = '[系统] 这次查询或回复未能完成，请稍后重试。';
      const noticeSticker = pickCodeSticker('service_down');
      await sendOptionalNotice(() => sendMessage(event,
        noticeSticker ? withSticker(failureNotice, noticeSticker.id) : failureNotice));
    }
    // 只记「回复根本没生成出来」这一种 —— 也就是她压根没开口的那种。发图失败、
    // 权限拒绝、冷却拦截各有自己的结果记录，不进这里。分开是有意的：这样这行字
    // 只能解释她的缺席，没法拿来解释她做过的事，也就堵住了「拿它当理由」。
    if (!deliveryStarted) {
      updateDb((draft) => {
        draft.replyFailures = appendReplyFailure(draft.replyFailures, {
          at: nowIso(),
          groupId: String(event.groupId || ''),
          kind: classifyLlmFailure(error),
        });
      });
    }
    recordDecisionError(`回复失败：${String(error?.message || error).slice(0, 500)}`);
    updateDb((draft) => {
      draft.usage.errors += 1;
      draft.usageEvents ||= [];
      draft.usageEvents.push({
        id: crypto.randomUUID(), kind: 'reply-delivery', requestId: currentRequestTraceId(),
        groupId: event.groupId, userId: event.userId,
        status: deliveryStarted ? 'failed_or_unknown' : 'generation_failed',
        accountingExcluded: true, createdAt: nowIso(),
      });
      draft.usageEvents = draft.usageEvents.slice(-5000);
      draft.decisions.push({
        id: crypto.randomUUID(),
        requestId: currentRequestTraceId(),
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
    if (waitUpTimer) clearTimeout(waitUpTimer);
  }
}
