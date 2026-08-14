// Reply queue + inbound dedupe. Type-checked module.
import { updateDb, nowIso } from '../store.js';
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

export const REPLY_QUEUE_LIMIT = 20;
const REPLY_QUEUE_TTL_MS = 180_000;
const INBOUND_EVENT_DEDUPE_TTL_MS = 10 * 60_000;
const INBOUND_EVENT_DEDUPE_LIMIT = 5_000;
const recentInboundEvents = new Map();

export function claimInboundEvent(event) {
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

export function getQueueState(key) {
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

export async function drainReplyQueue(key, processIncoming) {
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
  // Take ALL queued messages (same member by key design) and merge them into
  // a single reply so a burst of messages costs one LLM turn, not N.
  const items = state.queue.splice(0, state.queue.length);
  const next = mergeQueuedReplyItems(items);
  try {
    await processIncoming(next.event, next.sendMessage, next.decision, true);
  } catch {
    // Errors are already handled inside processIncoming
  }
}

function mergeQueuedReplyItems(items) {
  const last = items[items.length - 1];
  const texts = items
    .map((item) => String(item.event?.text || '').trim())
    .filter(Boolean);
  const images = items.flatMap((item) =>
    Array.isArray(item.event?.images) ? item.event.images : [],
  );
  const event = { ...last.event };
  if (texts.length > 1) {
    event.text = texts.join('\n') + '\n（以上是同一成员连续发送的消息，请综合这些内容回复一次）';
  }
  if (images.length > 0) {
    event.images = images;
  }
  return {
    event,
    sendMessage: last.sendMessage,
    decision: last.decision,
  };
}

