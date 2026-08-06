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
import { processXpGain, getExperience, getXpBonus, formatXpBar, getUnlockedFeatures, getLevelInfo, getNextLevelInfo, levelToPp, decayInactiveUsers } from './bot/experience.js';
import { isSearchAvailable, searchWeb, formatSearchResults, getLastSearchStatus, extractSearchQuery } from './bot/search.js';
import { setBotPaused, getRecalcProgress, startRecalc, tickRecalc, finishRecalc } from './health.js';
import { activateModelProfile, activeProviderLabel } from './modelConfig.js';
import { handleOsuCommand } from './osu/commands.js';
import { loadRegistry, buildBotToolSchemas, enabledBots, findBot } from './bots/registry.js';
import {
  detectRequiredOsuTool,
  detectNamedBotRequest,
  hasFallbackRecommendIntent,
  looksLikeRecommendationReply,
} from './bots/intent.js';
import { validateOperation } from './bots/guard.js';
import { runToolLoop, tryResolveBotResponse } from './bots/executor.js';
import {
  claimInboundEvent,
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
  countRecentUserMessages,
  lastAssistantAt,
  lastAssistantMessage,
  isPrivilegedForConversation,
  looksLikeReplyToBot,
  recentBotConversation,
  recentVisionImageMessages,
  shouldUseRecentVisionImage,
  recentLlmGateCalls,
  recordLlmGateUsage,
  cleanGateMessage,
  parseGateVerdict,
  llmReplyGate
} from './bot/gate.js';
import { handleOwnerCommand } from './bot/ownerCommands.js';
import { matchQuickCommand, handleQuickCommand, quickRouterEnabled } from './bot/quickRouter.js';

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
    // Bare slash commands that belong to the LazyBot quick table are routed
    // below (when the quick router is enabled); Wuxin's own `/help` and other
    // owner slash commands keep their existing behavior.
    const privateQuick = matchQuickCommand(event);
    const isLazyQuick = privateQuick?.def.source === 'lazybot' && privateQuick.def.id !== 'help';
    if (!(isLazyQuick && quickRouterEnabled(db, event))) {
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

  // ── Legacy quick-command router (M1 of four-bot merge) ──
  // Deterministic `!p`/`!bs`/`/plus`/`~`/`查@` … commands bypass the LLM.
  const quickMatch = matchQuickCommand(event);
  if (quickMatch && quickRouterEnabled(db, event)) {
    const quickResult = await handleQuickCommand(event, sendMessage, db, quickMatch, {
      isOwner: isGroupOwner || isPrivateOwner,
      isAdmin: isGroupAdmin,
    });
    if (quickResult?.handled) {
      return quickResult;
    }
  }

  const group = getGroup(db, event.groupId);
  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  const mentioned = mentionsBot(event.text, settings);
  // On the first pass the message + decision are recorded and side effects
  // (memory, XP, pair/profile pending) run exactly once. Drained replays use
  // the stored decision and must NOT duplicate history or side effects.
  const decision = queuedDecision || (event.type === 'private'
    ? { shouldReply: String(event.userId) === String(settings.ownerQq || event.userId), reason: '私聊消息' }
    : await decideReply({ db, group, userPolicy, text: event.text, mentioned, userId: event.userId, images: event.images || [] }));

  if (!isFromDrain) {
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

      // Level-up phrase: generated and queued; delivered when pippi next
      // replies to this player (never popped as a standalone message).
      if (xpResult.levelUp && db.settings.levelUpNotifyEnabled !== false) {
        const oldPp = levelToPp(xpResult.oldLevel);
        const newPp = levelToPp(xpResult.newLevel);
        void (async () => {
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
        })();
      }
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

    // If the user explicitly named a bot (猫猫/雨沐/etc.) AND asked for osu
    // data, carry the bot choice into the required tool. This mapping is a
    // simple common-sense alias (猫猫→kanon), and live tests showed the LLM
    // picks the wrong tool when left to decide; the tool schema still exposes
    // `bot` as a fallback for LLM-driven calls on uncaught phrasings.
    if (osuDataIntent && namedBotRequest) {
      osuDataIntent.args.bot = namedBotRequest.botId;
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
      await drainReplyQueue(replyLockKey, processIncoming);
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
      await drainReplyQueue(replyLockKey, processIncoming);
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
        await drainReplyQueue(replyLockKey, processIncoming);
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
        await drainReplyQueue(replyLockKey, processIncoming);
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
      await drainReplyQueue(replyLockKey, processIncoming);
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
        messages[0].content += '\n\n【可用工具】你可以调用 query_osu 获取真实 osu! 数据（BP、最近成绩、玩家信息、PP+ 等）。数据来自 osu! API v2 和 PP+ 服务，不是你凭记忆编造的。涉及 osu! 数据时必须调用工具，不准用聊天记录或上下文中的旧数据。当玩家问"我是谁"等身份问题时也必须调工具查绑定。日常闲聊不需要使用工具。如果玩家问的是分析/判断类问题（为什么偏科、怎么提升），也需要先查数据再做分析。涉及 BP 谱面类型或占比（串图/跳图比例、bp 类型）的分析必须调用 query_osu 的 bp_type 能力（osu!oracle 真实分类，仅支持 osu!std 的 aim/alt/tech/stream 四类）。用户提到串图/跳图/占比/BP结构/BP类型/aim图/stream图/tech图/alt图时一律调用该工具，禁止用上下文猜测或跳过工具；未调用工具前不得给出任何比例。本 bot 只支持 osu!std 查询，用户问 taiko/catch/mania 时如实说明暂不支持，禁止拿 std 数据冒充。玩家要求推图/推荐谱面/打什么图时，必须调用 query_osu capability=recommend 获取真实候选后再推荐；推荐对象可以是任意 osu! 用户名（如 给 mrekk 推图），不需要对方已绑定；工具没返回候选时如实说推不了，禁止凭记忆编图。 如果 recommend 工具调用失败或没有返回候选，你只能如实说明失败原因（如同分段数据太少、服务暂时不可用），绝对禁止编造任何谱面名、难度或 BID 数字。推图时最终回复的文本里必须包含每张推荐图的完整标题和 BID（直接用工具返回的 BID 行，例如 BID 3743551），不能只发图片省略 BID。推图支持自然语言筛选：玩家提出 BPM/AR/CS/OD/HP/星数/时长等限制时，正常调用 recommend 即可，系统会自动解析限制，并按带 Mod 后的实际数值筛选和展示；推荐时必须说明按什么条件筛的，禁止无视条件硬推；筛选结果为空时如实告知玩家可以放宽条件，禁止用不满足条件的图充数。注意：雨沐/猫猫/消防栓/LazyBot 是 QQ 群里的独立机器人，不是你可以调用的工具——你应该用 query_osu 获取数据。涉及"最近成绩/最近没玩/多久没打/最近状态"时必须调用 query_osu capability=recent 实时查询；profile、info、skill、get_player_skill 的结果都不包含 recent，工具没返回 recent 字段绝不等于玩家没有最近成绩。历史对话和技能快照中的 osu! 数据可能过时，以实时查询为准。 引用任何 osu! 查询结果时必须先说玩家名（如 Naaahida 的最近成绩：），禁止把某位玩家的数据说成另一位玩家的；不确定数据归属时如实说不知道，不要猜测。 用户点名用某个 bot 时（雨沐/猫猫/消防栓/LazyBot），调用 query_osu 必须把 bot 参数填成对应 id（yumu/kanon/hydrant/lazybot）；没点名就不填 bot。';
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
          await drainReplyQueue(replyLockKey, processIncoming);
          return { replied: true, text: errorText, reason };
        }
      }

      const harnessChat = (db: any, opts: any) => completeChat(db, {
        ...opts,
        searchMode,
        visionImages,
        label: opts.label || 'Bot Harness'
      });
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
        // 自然聊天不回显工具原文：数据只供 LLM 参考并自然融入回答。
        // 显式指令（/w osu analyze、!p 等）走独立通道，不受此开关影响。
        deliverDirectContent: requiredTool?.args.capability === 'recommend',
      };
      let toolResult = await runToolLoop(harnessChat, loopOptions);

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
        toolResult = await runToolLoop(harnessChat, {
          ...loopOptions,
          requiredTool: { toolName: 'query_osu', args: { capability: 'recommend' } },
          deliverDirectContent: true,
        });
      }

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

    // Deliver a queued level-up phrase as part of this reply (never standalone).
    const pendingUpKey = String(event.userId);
    const pendingUp = readDb().pendingLevelUps?.[pendingUpKey];
    if (pendingUp?.text) {
      const atLead = `[CQ:at,qq=${event.userId}] ${pendingUp.text}`;
      replyText = replyText ? `${atLead}\n\n${replyText}` : atLead;
      updateDb((draft) => {
        if (draft.pendingLevelUps) delete draft.pendingLevelUps[pendingUpKey];
      });
    }

    const deliveredText = [replyText, toolDirectContent].filter(Boolean).join('\n\n');
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
    void drainReplyQueue(replyLockKey, processIncoming);
  }
}

