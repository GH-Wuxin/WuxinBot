import { defaultPrompt, readDb, updateDb, nowIso } from './store.js';
import {
  normalizeMessage,
  extractImageInputs,
  extractAtTargets,
  mentionsBot,
  isQuestion,
  hasVisualPlaceholder,
  asksToInspectVisual,
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
  splitReplySegments
} from './bot/reply.js';
import { recordMemoryObservation, maybeUpdateMemoryProfile, maybeRecordImageMemorySummary, updateMemoryProfile, commitMemoryProfileResult } from './bot/memory.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, incrementGroupProfilePending } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, incrementPairPending } from './bot/relationshipProfile.js';
import { processTrustSignal, evaluateTrustScores, trustInteractionBonus, isTrustedMember } from './bot/trust.js';
import { isSearchAvailable, searchWeb, formatSearchResults, getLastSearchStatus, extractSearchQuery } from './bot/search.js';
import { setBotPaused, getRecalcProgress, startRecalc, tickRecalc, finishRecalc } from './health.js';

// User policies are not hard permissions by themselves. They mainly bias the
// reply decision engine. Hard permission checks for owner/admin commands happen
// in processIncoming/handleOwnerCommand below.
const policyWeight = {
  blocked: -999,
  muted: -80,
  normal: 0,
  whitelist: 25,
  priority: 45,
  admin: 20,
  owner: 60
};

// Reply queue: when a reply is being generated for a group, new @bot messages
// are queued instead of dropped. After the current reply finishes, the next
// queued message is processed automatically (FIFO).
const REPLY_QUEUE_LIMIT = 10;
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

export function decideReply({ db, group, userPolicy, text, mentioned, userId, images = [] }) {
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

  const recentBotReplies10m = countRecentReplies(db, group.groupId, 10);
  const recentUserMessages5m = countRecentUserMessages(db, group.groupId, 5);
  const attention = Number(userPolicy.attentionLevel || 3);
  const policyBase = userPolicy.policy === 'owner' ? 8 : (policyWeight[userPolicy.policy] ?? 0);
  const trustBonus = trustInteractionBonus(db, userId).weightBonus;
  const weight = policyBase + (attention - 3) * 5 + trustBonus;
  const question = isQuestion(text);
  const chatIsBusy = recentUserMessages5m >= 10;
  const fatiguePenalty = Math.min(0.35, recentBotReplies10m * 0.06);
  const busyPenalty = chatIsBusy ? 0.12 : 0;

  if (group.mode === 'light') {
    const chance = Math.max(0.08, 0.18 + weight / 160 - fatiguePenalty - busyPenalty);
    if (question && Math.random() < chance) return { shouldReply: true, reason: '轻度参与：选择性回应问题' };
  }

  if (group.mode === 'natural') {
    const questionChance = Math.max(0.12, 0.35 + weight / 150 - fatiguePenalty - busyPenalty);
    const casualChance = Math.max(0.03, 0.06 + weight / 240 - fatiguePenalty - busyPenalty);
    if (question && Math.random() < questionChance) return { shouldReply: true, reason: '自然聊天模式下选择性回应问题' };
    if (Math.random() < casualChance) return { shouldReply: true, reason: '自然聊天模式下低频接话' };
  }

  return { shouldReply: false, reason: '这条消息没有达到当前主动性阈值' };
}

export function oneBotToInternal(event) {
  // Internal event shape used by the bot engine. Keep fields stringified because
  // QQ ids can exceed safe integer habits and are easier to compare as strings.
  const text = normalizeMessage(event.raw_message || event.message);
  const images = extractImageInputs(event.message || event.raw_message);
  return {
    source: 'onebot',
    type: event.message_type || 'group',
    messageId: String(event.message_id || crypto.randomUUID()),
    groupId: event.group_id ? String(event.group_id) : 'private',
    userId: String(event.user_id || ''),
    nickname: event.sender?.card || event.sender?.nickname || String(event.user_id || ''),
    text,
    images,
    atTargets: extractAtTargets(event.message || event.raw_message),
    raw: event
  };
}

export async function processIncoming(event, sendMessage, queuedDecision, isFromDrain) {
  // High-level pipeline:
  // 1. Ignore self messages and route slash commands.
  // 2. Log the incoming message and decide whether to reply.
  // 3. Handle deterministic visual-limitation replies (bot genuinely cannot see images).
  // 4. Call the configured LLM (with optional provider search), sanitize/rewrite, send, record usage.
  // Identity/model questions are handled by the model via the runtime-injected system prompt.
  const db = readDb();
  const settings = db.settings;
  if (settings.selfQq && String(event.userId) === String(settings.selfQq)) {
    return { replied: false, reason: '忽略机器人自己的消息' };
  }

  const isPrivateOwner = event.type === 'private' && settings.ownerQq && String(event.userId) === String(settings.ownerQq);
  if (isPrivateOwner && event.text.startsWith('/')) {
    return handleOwnerCommand(event);
  }

  const isGroupOwner = event.type === 'group' && settings.ownerQq && String(event.userId) === String(settings.ownerQq);
  const groupUserPolicy = getUserPolicy(db, event.groupId, event.userId);
  const adminRoleLevel = commandRoleLevel(db, 'admin');
  const groupCommandRoleLevel = commandRoleLevel(db, userCommandRoleId(db, groupUserPolicy, { isOwner: isGroupOwner, isAdmin: false }));
  const isGroupAdmin = event.type === 'group' && (
    groupUserPolicy.policy === 'admin' ||
    groupUserPolicy.allowCommands ||
    groupCommandRoleLevel >= adminRoleLevel
  );

  // All /w and /wuxin commands should be handled as commands even when the
  // sender has no permission. Otherwise a denied command could fall through
  // into normal chat and be answered by the model.
  const isWuxinCommandText = /^\/w(uxin)?(?:\s|$)/i.test(event.text);
  if (event.type === 'group' && isWuxinCommandText) {
    return handleOwnerCommand(event, sendMessage, { isOwner: isGroupOwner, isAdmin: isGroupAdmin });
  }

  if ((isGroupOwner || isGroupAdmin) && event.text.startsWith('/')) {
    return handleOwnerCommand(event, sendMessage, { isOwner: isGroupOwner, isAdmin: isGroupAdmin });
  }

  const group = getGroup(db, event.groupId);
  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  const mentioned = mentionsBot(event.text, settings);
  const decision = event.type === 'private'
    ? { shouldReply: String(event.userId) === String(settings.ownerQq || event.userId), reason: '私聊消息' }
    : decideReply({ db, group, userPolicy, text: event.text, mentioned, userId: event.userId, images: event.images || [] });

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
  }
  if (event.images?.length) {
    void maybeRecordImageMemorySummary(event, userPolicy);
  }

  // Group profile auto-update: increment pending counter, trigger if threshold reached
  if (event.type === 'group' && event.groupId && event.groupId !== 'private') {
    incrementGroupProfilePending(db, event.groupId, event.text);
    processTrustSignal(event, db);
    incrementPairPending(db, event.groupId, event.userId);
  }

  if (!decision.shouldReply) return { replied: false, reason: decision.reason };

  if (decision.visualLimitation) {
    const replyText = visualLimitationReply(event);
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
    queueState.queue.push({ event, sendMessage, decision });
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

    // Real search: if explicitly requested, run searchWeb and inject results
    if (explicitSearch && !isSearchAvailable(liveDb)) {
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
    if (explicitSearch && isSearchAvailable(liveDb)) {
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

    // Thinking notice — configurable per thinkingNoticeMode
    const thinkingMode = liveDb.settings.thinkingNoticeMode || 'slow';
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

    const ai = await callLLM(liveDb, messages, searchMode, {
      maxTokens: responseOptions.maxTokens,
      overrideModel: responseOptions.overrideModel,
      visionImages: modelSupportsVision(liveDb) ? (event.images || []) : []
    });

    let replyText = sanitizeReply(ai.text, liveDb.settings);
    if (!responseOptions.longForm && isWeirdReply(replyText)) {
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
    if (!replyText) throw new Error('模型返回了空内容。');

    // Long replies (>150 chars or multi-paragraph) are sent as merged-forward
    // cards to avoid flooding the chat. Short replies stay as segmented messages.
    const newlineCount = (replyText.match(/\n/g) || []).length;
    const isLongReply = responseOptions.longForm || replyText.length > 150 || newlineCount >= 2;
    let segments;
    if (isLongReply && sendMessage) {
      await sendForwardText(sendMessage, event, 'Wuxin 回复', replyText);
      segments = [replyText];
    } else {
      segments = await sendReplySegments(sendMessage, event, replyText);
    }

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

    return { replied: true, text: replyText, segments, usage: ai.usage, latencyMs: ai.latencyMs, reason: decision.reason };
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

async function handleOwnerCommand(event, sendMessage, permissions = { isOwner: true, isAdmin: false }) {
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
        if (r?.ok !== false) rCount++;
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
      const knownModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
      if (!arg || arg === 'show') {
        if (!(await requireCommand('modelShow'))) return { replied: Boolean(sendMessage), reason: commandDeniedReply(commandDb, 'modelShow') };
        const db = readDb();
        const reply = `当前模型：${db.settings.model}`;
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
      updateDb((draft) => {
        draft.settings.model = arg;
        draft.adminActions.push({
          id: crypto.randomUUID(),
          operatorUserId: event.userId,
          action: '/wuxin model',
          targetUserId: 'bot',
          groupId: event.groupId,
          detail: `模型切换为 ${arg}`,
          createdAt: nowIso()
        });
      });
      const reply = `已切换模型：${arg}`;
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

  if (!policyMap[command] || !target) {
    if (sendMessage) await sendForwardText(sendMessage, event, 'Wuxin 指令帮助', help);
    return { replied: Boolean(sendMessage), reason: help };
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
