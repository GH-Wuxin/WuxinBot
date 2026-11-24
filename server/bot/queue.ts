// Reply queue + inbound dedupe. Type-checked module.
import { conversationKey, messageAccount, messageInConversation } from '../messageFacts.js';
import { socialCoordinator } from './social/coordinator.js';

const INBOUND_EVENT_DEDUPE_TTL_MS = 10 * 60_000;
const INBOUND_EVENT_DEDUPE_LIMIT = 5_000;
const recentInboundEvents = new Map();

export function claimInboundEvent(event, db) {
  const messageId = String(event?.messageId || '').trim();
  if (!messageId || event?.source === 'gui') return true;

  const now = Date.now();
  const key = JSON.stringify([messageAccount(db, event), conversationKey(event), messageId]);
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
export const getReplyQueueStats = () => socialCoordinator.stats;

/**
 * Second dedupe boundary, persisted inside the same atomic update that records
 * the message. The in-memory map above handles routine OneBot redelivery; this
 * check prevents two accidentally concurrent server processes from both
 * crossing into memory/profile/LLM side effects.
 */
export function persistedInboundDuplicate(draft, event) {
  const messageId = String(event?.messageId || '').trim();
  if (!messageId || event?.source === 'gui') return false;
  const account = messageAccount(draft, event);
  const messages = draft.messages || [];
  const start = Math.max(0, messages.length - INBOUND_EVENT_DEDUPE_LIMIT);
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message && (!message.role || message.role === 'user') && String(message.sourceMessageId || '') === messageId
      && messageInConversation(message, event, account)) return true;
  }
  return false;
}
