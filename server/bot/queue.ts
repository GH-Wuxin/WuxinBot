// Reply queue + inbound dedupe. Type-checked module.
import { socialCoordinator } from './social/coordinator.js';

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
  const type = String(event?.type || 'unknown');
  const groupId = String(event?.groupId || 'private');
  const recentMessages = (draft?.messages || []).slice(-INBOUND_EVENT_DEDUPE_LIMIT);
  return recentMessages.some((message) =>
    String(message?.sourceMessageId || '') === messageId &&
    String(message?.type || 'unknown') === type &&
    String(message?.groupId || 'private') === groupId
  );
}

