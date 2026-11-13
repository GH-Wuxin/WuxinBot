// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
import { tokenSaving } from './bot/tokenSaving.js';
import { recordAssistantContext, messageAccount } from './messageFacts.js';
import { buildIntrospectionTools, executeIntrospection, INTROSPECTION_TOOL_NAMES } from './bot/introspection.js';
import { sourceSender, sourceDetails, messageTrigger, type SourceStep } from './messageProvenance.js';
import { socialCoordinator } from './bot/social/coordinator.js';
import { chatAdmissionReason, replyLimitReason, conversationContext } from './bot/social/policy.js';
import { isSystemOwner } from './bot/social/state.js';
import { assessSocialTurn, assessSocialParticipation, revalidateSocialReply, socialDeliveryGuard, socialEntryAllowed, socialTimeline, waitForSocialContinuation, recordSocialDecision, prepareCombinedSocialTurn, applyCombinedSocialTurn } from './bot/social/runtime.js';
import { captureSocialReflection, queueSocialReflection } from './bot/social/reflection.js';
import { sendOptionalNotice } from './bot/notice.js';
import { createReplyProgress, shouldUseReplyProgress, stagedReplySegments, completeWithReplyProgress } from './bot/replyProgress.js';
import { withLlmTurnPolicy, assertLlmTurnActive } from './llmPolicy.js';
import { defaultPrompt, readDb, updateDb, nowIso } from './store.js';
import { mergeLlmUsage } from './usage.js';
import {
  normalizeMessage,
  extractImageInputs,
  extractAtTargets,
  extractReplyMessageId,
  mentionsBot,
  hasVisualPlaceholder,
  asksToInspectVisual,
  looksLikeVisualFollowup,
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
  writeCommandLog,
  beginCommandLog,
  setCommandStage,
  completeCommandLog
} from './bot/commands.js';
import {
  buildPrompt,
  describePolicy,
  describeModel,
  getPricing,
  calcCost,
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
  isIdentityQuestion,
  neutralIdentityReply,
  normalReplyRewriteSkipReason
} from './bot/reply.js';
import { buildRewriteEntry, recordRewriteTelemetry } from './bot/rewriteTelemetry.js';
import { recordMemoryObservation, maybeUpdateMemoryProfile, maybeRecordImageMemorySummary, updateMemoryProfile, commitMemoryProfileResult, maybeSweepDueMemoryProfiles } from './bot/memory.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, incrementGroupProfilePending, hasGroupProfileContent } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, incrementPairPending } from './bot/relationshipProfile.js';
import { processTrustSignal, evaluateTrustScores, isTrustedMember } from './bot/trust.js';
import { abortReplyProcess, isReplyProcessAborted, runReplyProcess, updateReplyProcessStage } from './bot/replyProcesses.js';
import { processXpGain, getExperience, getXpBonus, formatXpBar, getUnlockedFeatures, getLevelInfo, getNextLevelInfo, levelToPp, decayInactiveUsers } from './bot/experience.js';
import { setBotPaused, getRecalcProgress, startRecalc, tickRecalc, finishRecalc, markActiveProcessing } from './health.js';
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
import { OSU_SEARCH_TOOL, OSU_READ_TOOL, buildOsuSearchTools, executeOsuSearchTool, isOsuSearchAvailable } from './osu/search.js';
import { readPippiSelf, SELF_PROPOSAL_GUIDANCE, type SelfEvidence } from './bot/social/self.js';
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
import {
  agentRuntimeModeFor,
  rewriteLegacyToolReferencesForV2,
} from './bots/agentToolContracts.js';
import {
  claimInboundEvent,
  persistedInboundDuplicate
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
  shouldUseRecentVisionImage
} from './bot/gate.js';
import { handleOwnerCommand } from './bot/ownerCommands.js';
import { matchQuickCommand, handleQuickCommand } from './bot/quickRouter.js';
import { cqImageFor, pickCodeSticker, pickSticker, withSticker } from './bot/stickers/index.js';
import { rollRandomImage } from './bot/randomImages.js';
import { observeMessage } from './bot/presence.js';
import {
  beginLiveStickerDebug,
  stickerDebugShouldDryRun,
  validateStickerSelection,
  type StickerDebugSession,
} from './bot/stickers/debug.js';
import {
  parseStickerReply,
  buildSavingStickerReplyInstruction,
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
  stickerFailureInstruction,
  stickerFailureNotice,
} from './bot/stickers/replyDelivery.js';
import { resolveMemberNames } from './bot/memberDirectory.js';
import { conversationGuidance } from './bot/conversationPreparation.js';
import { recordConversationFailure } from './bot/conversationFailure.js';
import { recordConversationSuccess } from './bot/conversationSuccess.js';


import {
  buildLevelUpPrompt,
  compactDirectToolLead,
  decideReply,
  escapeCqParam,
  levelUpFallback,
  oneBotToInternal,
  recordStickerReplyCapabilityWarning,
  replyTargetMetadata,
  resolveConversationVisionImages,
  toolImageToCq,
  toolImageToMediaInput,
  allowedByOsuCommandOnlyMode,
} from './bot/inboundContext.js';
export { collectEventVisionImages, compactDirectToolLead, decideReply, oneBotToInternal, allowedByOsuCommandOnlyMode } from './bot/inboundContext.js';

export function processIncoming(event, sendMessage = undefined) {
  return runInboundTask('onebot.message', () => processIncomingAdmitted(event, sendMessage));
}

export async function processIncomingAdmitted(event, sendMessage = undefined) {
  event.receivedAtMs ||= Date.now();
  const requestId = requestTraceIdFor(event);
  startRequestTrace(event, requestId);
  return withRequestTrace(requestId, async () => {
    traceEvent('INGRESS', 'onebot_message_received', {
      messageId: event?.messageId,
      groupId: event?.groupId,
      userId: event?.userId,
      messageType: event?.type,
      imageCount: event?.images?.length || 0,
    });
    markActiveProcessing(1);
    // 控制台要能看见并掐断正在跑的这一轮。发送统一走 guardedSend：
    // 被掐断后正文、贴纸、失败提示一个都不发，流程照常走完并正常记账。
    const guardedSend = typeof sendMessage === 'function'
      ? (sendEvent, sendText, sendOptions) => {
          if (isReplyProcessAborted()) {
            traceEvent('REPLY', 'reply_aborted', { groupId: sendEvent?.groupId, userId: sendEvent?.userId });
            return Promise.resolve(undefined);
          }
          return sendMessage(sendEvent, sendText, sendOptions);
        }
      : undefined;
    try {
      const result = await runReplyProcess(
        { groupId: event?.groupId, userId: event?.userId, nickname: event?.nickname, messageId: event?.messageId },
        () => withLlmTurnPolicy(
          () => processIncomingInner(event, guardedSend),
          tokenSaving(readDb()) ? { maxCalls: 6, timeoutMs: 180_000 } : undefined,
        ),
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
    }
  });
}

async function processIncomingInner(event, sendMessage = undefined) {
  // High-level pipeline:
  // 1. Ignore self messages and route slash commands.
  // 2. Log the incoming message and decide whether to reply.
  // 3. Handle deterministic visual-limitation replies (bot genuinely cannot see images).
  // 4. Call the configured LLM (with optional provider search), sanitize/rewrite, send, record usage.
  // Identity/model questions are handled by the model via the runtime-injected system prompt.
  if (!claimInboundEvent(event)) {
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
      beginCommandLog(event, parseCommandMeta(event, { isOwner: true, isAdmin: true }), 'received');
      setCommandStage(event, 'running');
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
      Promise.resolve(sendMessage(event, cqImageFor(roll.file), { originModule: 'random_image', suppressReply: true,
        ...sourceDetails({module:'random_image',operation:'random_draw'},
          {code:'random_draw_selected',description:'本群随机图片功能在收到这条群消息后抽中了图片；不是针对触发者的文字回复。',audience:'conversation'},event),
      })).catch(() => undefined);
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
    beginCommandLog(event, parseCommandMeta(event, { isOwner: isGroupOwner, isAdmin: isGroupAdmin }), 'received');
    setCommandStage(event, 'running');
    return handleOwnerCommand(event, sendMessage, { isOwner: isGroupOwner, isAdmin: isGroupAdmin });
  }

  // ── Deterministic shortcut commands ──
  // Deterministic `!p`/`!bs`/`/plus`/`~`/`查@` … commands bypass the LLM.
  // BP 类型查询 has its own deterministic osu!oracle route. In particular,
  // `查 @某人 的 BP 类型` must not be consumed as Hydrant's generic 查@资料.
  const quickMatch = detectedQuickMatch;
  if (quickMatch) {
    beginCommandLog(event, {
      prefix: quickMatch.prefix,
      command: `quick:${quickMatch.def.id}`,
      subCommand: '',
      isWuxinCommand: false,
      rawText: String(event.text || '').slice(0, 600),
      userRoleId: '',
      userPolicy: groupUserPolicy.policy || 'normal',
    }, 'received');
    setCommandStage(event, 'running');
    try {
      const quickSend = sendMessage ? (e, body, options) => sendMessage(e, body, { originModule: 'quick_command', ...options }) : undefined;
      const quickResult = await handleQuickCommand(event, quickSend, db, quickMatch, {
        isOwner: isGroupOwner || isPrivateOwner,
        isAdmin: isGroupAdmin,
      });
      if (quickResult?.handled) {
        completeCommandLog(event, 'ok', quickResult.reason || '已处理');
        return quickResult;
      }
      completeCommandLog(event, 'ignored', quickResult?.reason || '转为普通对话');
    } catch (error: any) {
      completeCommandLog(event, 'error', String(error?.message || error).slice(0, 1200));
      throw error;
    }
  }

  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  const replyingToSelf = conversationContext(db,event).repliesToBot
    && !(event.atTargets || []).some(id=>String(id)!==String(settings.selfQq));
  const mentioned = isDirectBotMention(event, settings) || mentionsBot(event.text, settings) || replyingToSelf;
  event.socialNamed = mentioned && !isDirectBotMention(event, settings);
  event.socialDirect = event.type === 'private' || isDirectBotMention(event, settings) || replyingToSelf
    || settings.socialV2Enabled !== true && mentioned;
  // Presence observes every eligible group message in the background. It never
  // replies and never blocks the inbound path.
  if (event.type === 'group') observeMessage(event);
  // On the first pass the message + decision are recorded and side effects
  // (memory, XP, pair/profile pending) run exactly once. Drained replays use
  // the stored decision and must NOT duplicate history or side effects.
  const socialCandidate = socialEntryAllowed(db, event, mentioned || event.type === 'private');
  const boundary = chatAdmissionReason(db, event, event.socialDirect || event.socialNamed);
  const decision = socialCandidate
    ? { shouldReply: false, reason: '等待同群协调与语义评估' }
    : { shouldReply: !boundary && event.socialDirect, reason: boundary || '明确请求', inContext: userPolicy.policy !== 'blocked' };
  decision.visualLimitation = !socialCandidate && event.type === 'group' && decision.shouldReply
    && asksToInspectVisual(event.text) && !modelSupportsVision(db);
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
  const mentionNames = socialCandidate
    ? new Map((event.atTargets || []).map((id) => {
      const known = db.users.find((u) => String(u.groupId) === String(event.groupId) && String(u.userId) === String(id));
      return [String(id), { qq: String(id), card: '', nickname: known?.nickname || String(id) }];
    }))
    : event.type === 'group' && event.atTargets?.length
    ? await resolveMemberNames(readDb(), event.groupId, event.atTargets)
    : new Map();
  // 同一份结果也给当前这一轮用，免得历史里有名字、当前消息却还是裸号码。
  event.mentionNames = mentionNames;

  {
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
        accountId: messageAccount(db, event),
        role: 'user',
        type: event.type,
        groupId: event.groupId,
        userId: event.userId,
        nickname: event.nickname,
        content: event.text,
        media: event.images?.length ? { images: event.images } : undefined,
        mentions: mentionNames.size ? [...mentionNames.values()] : undefined,
        atTargets: event.atTargets || [],
        replyMessageId: event.replyMessageId || '',
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
            const resp = tokenSaving(liveDb) ? { text: '' } : await completeChat(readDb(), { messages: [{ role: 'user', content: congratsPrompt }], temperature: 0.9, maxTokens: 60, label: '升级短语' });
            const congratsText = sanitizeReply(
              resp.text?.trim() || levelUpFallback(oldPp, newPp, realPp),
              liveDb.settings,
            );
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

  if (!socialCandidate && !decision.shouldReply) {
    if (settings.socialV2Enabled && group?.enabled && group.mode !== 'osu') recordSocialDecision(event, {
      stage: 'guard', action: 'pass', reason: decision.reason, evidenceIds: [], durationMs: 0, totalTokens: 0,
    });
    return { replied: false, reason: decision.reason };
  }
  const priority = event.socialDirect || event.socialNamed ? (isSystemOwner(db, event) ? 2 : 1) : 0;
  const result = await socialCoordinator.submit(event, priority, async (merged) => {
    const entryBlock = chatAdmissionReason(readDb(), merged, merged.socialDirect || merged.socialNamed);
    if (isReplyProcessAborted() || entryBlock) return { replied: false, reason: entryBlock || '请求已取消' };
    let assessment;
    const fastSocial = socialCandidate && !tokenSaving(readDb())
      && readDb().settings.pippiFastReplies !== false && process.env.PIPPI_FAST_REPLIES !== '0';
    const combinedSocial = fastSocial && merged.socialDirect;
    let reflection = fastSocial ? captureSocialReflection(merged) : null;
    const assessParticipation = fastSocial ? assessSocialParticipation : assessSocialTurn;
    if (socialCandidate && !combinedSocial) {
      assessment = await assessParticipation(merged);
      if (assessment?.action === 'wait') {
        await waitForSocialContinuation(merged);
        socialCoordinator.takeContinuation(merged);
        assessment = await assessParticipation(merged, 'resumed');
        if(fastSocial)reflection=captureSocialReflection(merged);
      }
    }
    // Preserve name-call availability when assessment is unavailable, while
    // an explicit other recipient keeps ambiguous name references ambient.
    if (!assessment && merged.socialNamed && !(merged.atTargets || []).some((id) => String(id) !== String(readDb().settings.selfQq))
      && (!merged.replyMessageId || conversationContext(readDb(), merged).repliesToBot)) merged.socialDirect = true;
    const action = assessment?.action || (merged.socialDirect ? 'reply' : 'pass');
    const guard = socialDeliveryGuard(readDb(), merged);
    const shouldReply = !isReplyProcessAborted() && !guard && ['react', 'reply'].includes(action);
    const reason = guard || assessment?.reason || (merged.socialDirect ? '继续明确请求' : '本轮不参与');
    updateDb((draft) => {
      for (const item of draft.decisions) if (item.groupId === merged.groupId && item.userId === merged.userId
        && (merged.socialMessageIds || [merged.messageId]).includes(item.messageId)) {
        item.shouldReply = shouldReply && item.messageId === merged.messageId;
        item.reason = reason;
      }
    });
    if (!shouldReply) {
      if (assessment && ['react', 'reply'].includes(action)) recordSocialDecision(merged, {
        stage: 'guard', action: 'pass', reason: guard || '请求已取消', evidenceIds: [], durationMs: 0, totalTokens: 0,
      });
      if(reflection&&!guard&&!isReplyProcessAborted())queueSocialReflection(reflection,{action:'pass',replied:false});
      return { replied: false, reason };
    }
    merged.socialAction = action;
    merged.socialContextIds ||= socialTimeline(readDb(), merged, 40).map((m) => m.messageId);
    const output = await generateConversationReply(merged, sendMessage, { shouldReply: true, reason,
      socialReady: socialCandidate, combinedSocial, visualLimitation: decision.visualLimitation });
    if(reflection&&!isReplyProcessAborted())queueSocialReflection(reflection,{action:merged.socialAction||action,replied:Boolean(output.replied)});
    if (socialCandidate) recordSocialDecision(merged, { stage: 'delivery', action: output.replied ? merged.socialAction || action : 'pass',
      reason: output.replied ? '已发送' : output.error ? '生成或发送失败' : output.reason,
      evidenceIds: [], durationMs: 0, totalTokens: 0 });
    return output;
  });
  if (socialCandidate && !result.replied && !result.merged && !result.error && !['本轮不参与'].includes(result.reason)) {
    // Queue expiry/permission changes are visible even before an LLM evaluation.
    const seen = readDb().socialV2.decisions.some((d) => d.scope === (event.type === 'group' ? 'group:' + event.groupId : 'private:' + event.userId)
      && d.messageIds.includes(event.messageId));
    if (!seen) recordSocialDecision(event, { stage: 'guard', action: 'pass', reason: result.reason, evidenceIds: [], durationMs: 0, totalTokens: 0 });
  }
  return result;
}

async function generateConversationReply(event, sendMessage, decision) {
  const replySources: SourceStep[] = [{module:'conversation',operation:decision.visualLimitation?'visual_limitation':'generate_reply'}];
  sendMessage = sourceSender(sendMessage, () => replySources,
    {code:event.socialDirect?'direct_reply':event.socialEngagement==='continuation'?'conversation_followup':'ambient_participation',
      description:event.socialDirect?'回应当前发言者的明确请求。':'模型根据本会话交流决定接话。',
      audience:event.socialDirect?'requester':'conversation'},messageTrigger(event,true));
  const readingSources: SelfEvidence[] = [];
  const readingScope = event.type === 'group' ? `group:${event.groupId}` : `private:${event.userId}`;
  let readingRevision = readPippiSelf(readDb()).revision;
  let readingProposal;
  const confirmedReceipts: string[] = [];
  const originalSend = sendMessage;
  // Track the actual answer separately from thinking notices and optional stickers.
  const sendReadingReply = originalSend ? async (...args) => {
    const receipt = await originalSend(...args);
    if (receipt?.outcome === 'confirmed_success') confirmedReceipts.push(String(receipt.messageId || crypto.randomUUID()));
    return receipt;
  } : undefined;
  let thinkingTimer = null;
  let waitUpTimer = null;
  let progress;
  let progressEligible = false;
  let stagedReply = false;
  let modelStageStarted = false;
  let deliveryStarted = false;
  try {
    if (decision.visualLimitation) {
      const text = visualLimitationReply(event, readDb());
      deliveryStarted = true;
      const segments = await sendReplySegments(sendMessage, event, text);
      updateDb((draft) => {
        recordAssistantContext(draft, { id: crypto.randomUUID(), requestId: currentRequestTraceId(), ...replyTargetMetadata(event),
          role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: text, inContext: true, createdAt: nowIso() });
        draft.usage.replies += Math.max(1, segments.length);
      });
      return { replied: true, text, segments, reason: decision.reason };
    }
    // Confirmed sends are already visible. Only an explicit inspect_message
    // request for unfinished semantic detail waits on that specific observation.
    const liveDb = readDb();
    readingRevision = readPippiSelf(liveDb).revision;
    const liveGroup = getGroup(liveDb, event.groupId) || { groupId: event.groupId, name: '私聊' };
    const liveUserPolicy = getUserPolicy(liveDb, event.groupId, event.userId);
    const savingMode = tokenSaving(liveDb);
    const messages = buildPrompt(liveDb, liveGroup, event, liveUserPolicy);
    const combined = decision.combinedSocial ? prepareCombinedSocialTurn(event) : null;
    const socialExpressionContext = messages[0]?.content;
    traceEvent('PROMPT', 'prompt_built', {
      messageCount: messages.length,
      roles: messages.map((message) => message.role),
      totalCharacters: messages.reduce((sum, message) => sum + String(message.content || '').length, 0),
      includesVision: Boolean(event?.images?.length),
    });
    const responseOptions = responseOptionsFor(event, liveDb, liveUserPolicy);
    if (combined) responseOptions.maxTokens = Math.max(1200, responseOptions.maxTokens || 0);
    if (event.socialAction === 'react') responseOptions.maxTokens = Math.min(responseOptions.maxTokens || 250, 250);
    const turnId = String(event.messageId || crypto.randomUUID());
    const reasoningRouter = createShadowReasoningRouter(undefined, undefined, tokenSaving(liveDb) ? 'low' : 'max');
    let osuDataIntent = savingMode ? null : detectRequiredOsuTool(event.text);
    // BP 谱面类型/组成问题（含显式点名 osu_oracle）必须走确定性 bp_type 路由，
    // 不允许 LLM 用上下文旧数据编造比例。
    if (!savingMode && detectBpTypeAnalysisIntent(event.text)) {
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
    const namedBotRequest = savingMode ? null : detectNamedBotRequest(event.text, registryHere.bots || []);
    traceEvent('ROUTER', 'conversation_route_resolved', {
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
      if (sendMessage) await sendMessage(event, namedBotDowngradeNotice, sourceDetails({module:'conversation',operation:'executor_fallback_notice'},
        {code:'requested_executor_unavailable',description:'点名的外部 Bot 不支持本次查询，实际切换到备用处理前告知请求者。',audience:'requester'},event));
      updateDb((draft) => {
        recordAssistantContext(draft, { id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: namedBotDowngradeNotice, inContext: true, createdAt: nowIso() });
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
        recordAssistantContext(draft, { id: crypto.randomUUID(), ...replyTargetMetadata(event), role: 'assistant', type: event.type, groupId: event.groupId, userId: 'bot', nickname: '机器人', content: replyText, inContext: true, createdAt: nowIso() });
        draft.usage.replies += 1;
      });
      return { replied: true, text: replyText, reason: 'named_bot_no_adapter' };
    }

    // Natural replies decide an optional sticker only in their final model
    // output. Data queries and named-bot routes keep their
    // existing delivery semantics and do not pay for a sticker envelope.
    const stickerCapability = resolveStickerReplyCapability({
      eligible: !osuDataIntent && !namedBotRequest,
      deliveryMode: stickerDeliveryConfig(liveDb).mode,
      ...(savingMode ? { buildInstruction: buildSavingStickerReplyInstruction } : {}),
    });
    if (stickerCapability.reason === 'catalog_unavailable') {
      recordStickerReplyCapabilityWarning(new Error('manifest or visual annotations could not be loaded'));
    }
    const stickerReplyEnabled = stickerCapability.enabled;
    const stickerReplyInstruction = stickerCapability.instruction;

    const agentRuntimeMode = agentRuntimeModeFor(liveDb);
    const modelFirstRuntime = agentRuntimeMode === 'model_first';
    const registryForTurn = loadRegistry(liveDb);
    const hasEnabledBots = enabledBots(registryForTurn).length > 0;
    const botTools = !savingMode && hasEnabledBots
      ? buildBotToolSchemas(registryForTurn, { surface: modelFirstRuntime ? 'v2' : 'legacy' })
      : [];
    // 第二层：发图工具。只在 V2 运行时提供，第一层整批结束后由执行器切换。
    const imageTools = !savingMode && modelFirstRuntime && hasEnabledBots
      ? buildBotToolSchemas(registryForTurn, { surface: 'v2', phase: 'image' })
      : [];
    const osuSearchEnabled = !savingMode && isOsuSearchAvailable(liveDb);
    const toolsForTurn = [
      ...botTools,
      ...(osuSearchEnabled ? buildOsuSearchTools() : []),
      ...(!savingMode ? buildIntrospectionTools() : []),
    ];
    const useTools = toolsForTurn.length > 0;
    traceEvent('ROUTER', 'execution_path_selected', {
      route: useTools ? 'tool_loop' : 'direct_model',
      enabledToolNames: toolsForTurn.map((tool) => tool?.function?.name).filter(Boolean),
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
      await sendMessage(event, picked ? withSticker(text, picked.id) : text, { originModule: 'notice',
        ...sourceDetails({module:'thinking_notice',operation:stickerKey},
          {code:'generation_in_progress',description:'回复任务仍在生成或查询，按当前提示设置发送过程状态。',audience:'requester'},event)});
    };

    progressEligible = shouldUseReplyProgress(liveDb,event);
    if(progressEligible){
      // Compatibility endpoints count reasoning inside max_tokens too. A
      // detailed answer needs room for both reasoning and the requested text.
      responseOptions.maxTokens=Math.max(8192,responseOptions.maxTokens||0);
      progress=createReplyProgress(event,sendMessage);
    }
    if (progressEligible) {
      // Progress comes from the current task; do not add legacy timer stickers.
    } else if (thinkingMode === 'simple') {
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
    if (!progressEligible && thinkingMode !== 'off') {
      waitUpTimer = setTimeout(() => {
        void sendOptionalNotice(async () => {
          if (!sendMessage) return;
          const picked = pickSticker('wait_up');
          const text = useTools ? '还在查，稍等一下…' : '还在处理，稍等一下…';
          await sendMessage(event, picked ? withSticker(text, picked.id) : text, {originModule:'notice',
            ...sourceDetails({module:'thinking_notice',operation:'wait_up'},
              {code:'task_still_running',description:'任务仍未结束，等待计时器触发了进度提示。',audience:'requester'},event)});
        });
      }, Number(liveDb.settings.waitUpNoticeDelayMs || 25000));
    }

    // If user asks to look at images but none attached, attach only the most
    // recent relevant image. This keeps vision on-demand and avoids paying for
    // every image posted in an active group.
    let visionImages = resolveConversationVisionImages(liveDb, event);

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
        recordAssistantContext(draft, {
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
            recordAssistantContext(draft, {
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
        const guidance = conversationGuidance({
          modelFirstRuntime,
          osuSearchEnabled,
          hasBotTools: botTools.length > 0,
          requiredCapability,
        });
        if (guidance) messages[0].content += '\n\n' + guidance;
      }

      let osuSearchCalls = 0;
      const executeConversationTool = async (toolCall, context) => {
        assertLlmTurnActive();
        const progressTool = progress?.toolStarted(String(toolCall?.function?.name || ''));
        let succeeded = false;
        const finishTool = result => {
          succeeded = Boolean(result?.ok);
          // Tool-provided reference images are for the model's next turn, not
          // for QQ delivery. Self-appearance uses this to look at its own art
          // without sending the reference into the group.
          const vision = result?.metadata?.visionImages;
          if (Array.isArray(vision)) {
            for (const image of vision) {
              const key = typeof image === 'string'
                ? image
                : String(image?.url || image?.file || '');
              if (!key) continue;
              const exists = visionImages.some((existing) => (
                typeof existing === 'string' ? existing : String(existing?.url || existing?.file || '')
              ) === key);
              if (!exists) visionImages.push(image);
            }
          }
          replySources.push({module:'tool',operation:String(toolCall?.function?.name||'unknown'),
            producer:String(result?.metadata?.actualExecutor||result?.metadata?.provider||'wuxin'),
            outcome:succeeded?'success':'failed'});
          if (Array.isArray(result?.metadata?.messageSources)) replySources.push(...result.metadata.messageSources);
          return result;
        };
        try {
          if (INTROSPECTION_TOOL_NAMES.includes(toolCall?.function?.name)) {
            return finishTool(await executeIntrospection(readDb(), event, toolCall, { canSee: modelSupportsVision(liveDb) }));
          }
          if ([OSU_SEARCH_TOOL, OSU_READ_TOOL].includes(toolCall?.function?.name)) {
            if (!osuSearchEnabled) return { toolCallId: toolCall.id, ok: false, content: '当前未开放 osu! 官方搜索', error: 'osu_search_unavailable' };
            if (osuSearchCalls >= 4) return { toolCallId: toolCall.id, ok: false, content: '本轮 osu! 检索与阅读已达到 4 次上限', error: 'osu_search_call_limit' };
            osuSearchCalls += 1;
            const result = await executeOsuSearchTool(toolCall, context);
            const reading = result.metadata?.reading as { id: string; url: string; title: string; at: string } | undefined;
            if (result.ok && reading && liveDb.settings.socialV2Enabled === true && !tokenSaving(readDb())) {
              if (!readingSources.some(s => s.id === reading.id)) readingSources.push({ ...reading, kind: 'reading', scope: readingScope, userId: event.userId });
            }
            return finishTool(result);
          }
          return finishTool(await executeToolCall(toolCall, context));
        } finally {
          if (progressTool !== undefined) progress?.toolFinished(progressTool, succeeded);
        }
      };

      let toolLoopModel = '';
      let toolLoopProvider = '';
      const harnessChat = async (db: any, opts: any) => {
        updateReplyProcessStage('生成中');
        const result = await completeWithReplyProgress(db,opts,progress,(current,request)=>completeChat(current,{
          ...request,
          visionImages,label:request.label||'Bot Harness',
        }));
        toolLoopModel = String(result?.model || toolLoopModel || '');
        toolLoopProvider = String(result?.provider || toolLoopProvider || '');
        return result;
      };
      const loopOptions = {
        db: liveDb,
        messages,
        tools,
        imageTools,
        lightweightToolsOnly: botTools.length === 0 && !osuSearchEnabled,
        userId: event.userId,
        groupId: event.groupId,
        sendMessage,
        event,
        selfQq: liveDb.settings.selfQq,
        maxIterations: tokenSaving(liveDb) ? 2 : 8,
        temperature: responseOptions.temperature,
        maxTokens: responseOptions.maxTokens,
        model: responseOptions.overrideModel,
        label: 'Bot Harness',
        requiredTool,
        evidenceRequirement,
        // 自然聊天不回显工具原文：数据只供 LLM 参考并自然融入回答。
        // 显式指令（/w info、!p 等）走独立通道，不受此开关影响。
        deliverDirectContent: requiredTool?.args.capability === 'recommend',
        continueAfterDirectPayload: modelFirstRuntime,
        deduplicateToolCalls: modelFirstRuntime,
        structuredToolResults: modelFirstRuntime,
        finalResponseFormat: () => combined || stickerReplyEnabled || readingSources.length || progressEligible ? STICKER_REPLY_RESPONSE_FORMAT : undefined,
        finalResponseInstruction: () => [stickerReplyInstruction || '', combined?.instruction || '', ...(readingSources.length ? [
          '结束本轮时输出 JSON，reply 为实际回复；可选 self 用于保留本次阅读的经历，不必每次都记。保留已有表情字段（若开放）。回复尚未送出，self 只写已完成的阅读与感受，不记为已向群友分享。',
          SELF_PROPOSAL_GUIDANCE, '本次实际读取成功的来源：' + JSON.stringify(readingSources),
        ] : [])].filter(Boolean).join('\n'),
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
        && (event.socialEngagement === 'continuation' || shouldUseRecentVisionImage(liveDb, event));
      const convInput = reasoningInput('conversation', { contextDependent });
      let convTurn = emptyTurnState();
      const convDecision = savingMode
        ? { level: 'low' as const, source: 'rule' as const, reasonCode: 'token_saving' as const }
        : reasoningRouter.resolve(convInput, convTurn);
      convTurn = reasoningRouter.mergeTurn(convTurn, convDecision);
      const convWire = thinkingParamsForLevel(convDecision.level, reasoningEnabledFor(liveDb));
      const finalMessages = combined || stickerReplyEnabled && stickerReplyInstruction
        ? withStickerReplyInstruction(messages, [stickerReplyInstruction || '',combined?.instruction || ''].filter(Boolean).join('\n'))
        : messages;
      ai = await completeWithReplyProgress(liveDb, {
        messages:finalMessages,
        maxTokens: responseOptions.maxTokens,
        overrideModel: responseOptions.overrideModel,
        visionImages,
        // DeepSeek JSON mode can finish with whitespace only. Saving chat keeps
        // the JSON prompt/parser without the provider's constrained decoder.
        ...(!savingMode && stickerReplyEnabled && stickerReplyInstruction ? { responseFormat: STICKER_REPLY_RESPONSE_FORMAT } : {}),
        traceRole: 'conversation',
        tracePurpose: 'conversation_reply',
        ...(savingMode ? { promptModule: 'conversation_saving' } : {}),
        ...convWire
      },progress,(current,request)=>callLLM(current,request.messages,request));
      reasoningRouter.record({
        turnId,
        ts: Date.now(),
        callRole: 'conversation',
        decision: convDecision,
        input: convInput,
        actual: ai?.meta || null,
      });
    }

    if (combined) {
      const parsedEnvelope = parseStickerReply(ai.text);
      if (!parsedEnvelope.structured && /^\s*(?:```(?:json)?\s*)?[\[{]/i.test(ai.text)) {
        throw new Error('Invalid combined reply envelope');
      }
      if (!parsedEnvelope.structured && /"(?:social|affinityDelta|familiarityDelta|evidenceIds)"\s*:/.test(ai.text)) {
        throw new Error('Invalid combined reply envelope');
      }
      let participation;
      try { participation = applyCombinedSocialTurn(event, ai.text, combined); } catch { /* invalid proposals never alter state */ }
      if (!participation) {
        // A valid plain answer is itself the model choosing to participate under
        // the same persona/relationship prompt. Never evaluate that choice again
        // after generating the answer. Structured pass still wins above.
        const content = parsedEnvelope.structured ? parsedEnvelope.reply : ai.text;
        if(!String(content||'').trim()&&!toolImages.length&&!toolDeliverImages.length&&!toolDirectContent
          &&!(parsedEnvelope.structured&&parsedEnvelope.mode==='image_only'&&parsedEnvelope.stickerId)){
          throw new Error('模型没有返回可发送的正文');
        }
        participation={allow:true};
        event.socialAction=participation.allow?'reply':'pass';
        recordSocialDecision(event,{stage:'assessment',phase:'initial',action:event.socialAction,
          reason:'本轮生成结果已表达参与选择',evidenceIds:[],durationMs:0,totalTokens:0});
      }
      if (participation && !participation.allow) return {replied:false,reason:'本轮不参与'};
      if(!String(parsedEnvelope.structured?parsedEnvelope.reply:ai.text).trim()&&!toolImages.length&&!toolDeliverImages.length&&!toolDirectContent
        &&!(parsedEnvelope.structured&&parsedEnvelope.mode==='image_only'&&parsedEnvelope.stickerId))throw new Error('模型没有返回可发送的正文');
    }
    const stickerReply = parseStickerReply(ai.text);
    ai.text = stickerReply.reply;
    responseOptions.longForm = stickerReply.presentation === 'document';
    if (readingSources.length && 'self' in stickerReply && stickerReply.self && !tokenSaving(readDb())) {
      readingProposal = stickerReply.self;
    }
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
    // V2 delegates conversational meaning to the model. The legacy path only
    // corrects a reply that denies its own @/reply target; style and length are
    // never classified or rewritten by that path.
    const rewriteEligible = !decision.socialReady && isWeirdReply(replyText);
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

    const deliveryGuard = socialDeliveryGuard(readDb(), event);
    if (deliveryGuard) return { replied: false, reason: deliveryGuard };
    if (decision.socialReady) {
      const checked = await revalidateSocialReply(event, replyText || `[图片反应：${stickerDecisionId || ''}]`, {
        expressionPrompt: socialExpressionContext,
        protectedOutput: Boolean(hasDirectToolDelivery || requiredToolLed || evidenceProtectedTurn || stickerDecisionId || imageOnlySticker),
      });
      if (checked === null) return { replied: false, reason: 'V2 发送前判断已取消过时回复' };
      if (replyText) replyText = sanitizeReply(checked, liveDb.settings);
    }

    // Deliver a queued level-up phrase as part of this reply (never standalone).
    const pendingUpKey = String(event.userId);
    const pendingUp = readDb().pendingLevelUps?.[pendingUpKey];
    if (pendingUp?.text) {
      // 文案本身已经走过「LLM 生成 + levelUpFallback 回退」（见上方 completeChat），
      // 这里只把升级的表情挂上 —— 图由代码触发，不依赖 LLM。
      const pendingText = sanitizeReply(String(pendingUp.text || ''), liveDb.settings);
      const atLead = withSticker(`[CQ:at,qq=${event.userId}] ${pendingText}`, 'applause');
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
                explicitRequest: stickerExplicitRequest,
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
      // 图没发出去时，把「为什么没发出去」交给模型自己重写这句话；
      // 只有模型调用不可用时才退回固定话术。
      const failureReason = String(modelStickerHistory?.reason || '');
      let softened = '';
      try {
        if (tokenSaving(readDb())) throw new Error('节能模式使用现有发送失败提示');
        const instruction = stickerFailureInstruction(replyText, failureReason);
        const rewritten = await completeChat(readDb(), {
          messages: [
            { role: 'system', content: instruction.system },
            { role: 'user', content: instruction.user },
          ],
          temperature: 0.6,
          maxTokens: 80,
          label: '表情包失败改写',
        });
        softened = String(rewritten?.text || '').trim();
      } catch {
        softened = '';
      }
      replyText = softened || [replyText, stickerFailureNotice({ explicitRequest: true, bodyDelivered: false })]
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

    // Missing optional presentation metadata is still ordinary chat. Preserve
    // model-authored paragraphs so !commands and URL punctuation stay intact.
    stagedReply = stickerReply.presentation !== 'document';
    const stagedSegments = stagedReply ? stagedReplySegments(deliveredText) : [];
    // Documents and physically large/code-heavy payloads retain full forwarding.
    const isLongReply = responseOptions.longForm || deliveredText.length > 1800 || deliveredText.includes('```');
    let segments;
    let deliveryStatus = 'ok';
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    if (waitUpTimer) { clearTimeout(waitUpTimer); waitUpTimer = null; }
    progress?.stop();
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
      if (sendReadingReply) await sendReadingReply(event, outboundText, replyToCurrentMessageOptions(event));
      segments = [outboundText];
    } else if (modelStickerCqCode && sendMessage) {
      const stickerSource = sourceDetails({module:'reply_sticker',operation:stickerExplicitRequest?'requested_image':'model_reaction',producer:'pippi'},
        {code:stickerExplicitRequest?'sticker_requested':'sticker_selected',
          description:stickerExplicitRequest?'回应用户的图片请求，发送本轮模型选择且通过交付检查的表情。':'本轮模型按交流语境选择表情，作为自己的回应。',audience:event.socialDirect?'requester':'conversation'},event);
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
          await sendForwardText(sendReadingReply, event, 'Wuxin 回复', deliveredText);
          // The body is already visible to the user. A later optional sticker
          // failure must not turn this successful turn into replied=false or
          // cause the long body to be sent a second time.
          segments = [deliveredText];
          try {
            stickerResult = await sendMessage(event, [stickerCaption, modelStickerCqCode].filter(Boolean).join('\n'), replyToCurrentMessageOptions(event,stickerSource));
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
                await sendOptionalNotice(() => sendMessage(event, notice, replyToCurrentMessageOptions(event,
                  sourceDetails({module:'reply_sticker',operation:'failure_notice'},
                    {code:'image_delivery_failed',description:'图片明确发送失败，告知请求者；已成功的正文不会重发。',audience:'requester'},event))));
              }
            }
          }
        } else {
          // 附文只在这一条里出现 —— 它跟图片同生共死，于是图片失败时天然不会被重发。
          const outboundText = [deliveredText, stickerCaption, modelStickerCqCode].filter(Boolean).join('\n');
          stickerResult = await (deliveredText.trim() ? sendReadingReply! : sendMessage)(event, outboundText, replyToCurrentMessageOptions(event,stickerSource));
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
            await sendReadingReply!(event, outboundFallback, replyToCurrentMessageOptions(event,
              sourceDetails({module:'reply_sticker',operation:'text_fallback'},
                {code:'image_delivery_failed',description:'图片明确发送失败，保留可独立交付的正文并说明情况。',audience:'requester'},event)));
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
      await sendForwardText(sendReadingReply, event, 'Wuxin 回复', deliveredText);
      segments = [deliveredText];
    } else if(stagedReply&&sendMessage){
      for(let index=0;index<stagedSegments.length;index++)await sendReadingReply(event,stagedSegments[index],index===0?replyToCurrentMessageOptions(event):{suppressReply:true});
      segments=stagedSegments;
    } else {
      segments = await sendReplySegments(sendReadingReply, event, deliveredText);
    }
    traceEvent('SEND', 'qq_delivery_completed', { status: deliveryStatus, segmentCount: segments.length });

    return recordConversationSuccess({
      event,
      settings: liveDb.settings,
      decision,
      ai,
      deliveredText,
      segments,
      toolImages,
      toolDeliverImages,
      modelStickerPath,
      modelStickerHistory,
      deliveredMediaImages,
      readingProposal,
      readingScope,
      readingRevision,
      readingSources,
      confirmedReceipts,
    });
  } catch (error) {
    progress?.stop();
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    if (waitUpTimer) { clearTimeout(waitUpTimer); waitUpTimer = null; }
    return await recordConversationFailure({
      event,
      sendMessage,
      decision,
      error,
      deliveryStarted,
      modelStageStarted,
    });
  } finally {
    progress?.stop();
    if (thinkingTimer) clearTimeout(thinkingTimer);
    if (waitUpTimer) clearTimeout(waitUpTimer);
  }
}
