import crypto from 'node:crypto';
import { readDb, updateDb, nowIso } from './store.js';
import { extractImageInputs, normalizeMessage } from './bot/cleaning.js';
import { currentRequestTraceId, traceEvent } from './requestTrace.js';

const ORIGINS = new Set(['reply', 'random_image', 'quick_command', 'notice', 'forward', 'self_event']);
const text = (value: unknown) => String(value ?? '');
export function messageContextText(record: any): string {
  const source = record.originModule === 'random_image' ? '（pippi 通过自己的随机图片功能自动发送）' : '';
  const summary = record.contextSummary ? `（查询事实摘要：${record.contextSummary}）` : '';
  return `${text(record.content)}${source}${summary}`;
}
export function messageAccount(db: any, event: any): string {
  return text(db.settings?.selfQq || event?.raw?.self_id).trim();
}
export function conversationKey(event: any): string {
  return event?.type === 'group' ? `group:${text(event.groupId)}` : `private:${text(event?.userId)}`;
}
export function messageInConversation(record: any, event: any, account: string): boolean {
  if (record.type !== event.type || record.accountId && record.accountId !== account) return false;
  if (event.type === 'group') return text(record.groupId) === text(event.groupId);
  return text(record.peerId || (record.role === 'assistant' ? record.replyToUserId : record.userId)) === text(event.userId);
}
export function findMessageFact(db: any, event: any, messageId: unknown) {
  const wanted = text(messageId).trim();
  if (!wanted) return null;
  const account = messageAccount(db, event);
  // Legacy UUIDs are never treated as platform IDs. Older inbound rows used messageId.
  return [...(db.messages || [])].reverse().find(m =>
    text(m.sourceMessageId || m.messageId) === wanted && messageInConversation(m, event, account)
    && !['confirmed_failure', 'pending'].includes(m.deliveryOutcome)) || null;
}
export function quoteFromRecord(record: any, event: any, account: string) {
  return {
    messageId: text(record.sourceMessageId || record.messageId),
    text: text(record.content), images: record.media?.images || [],
    userId: text(record.senderId || (record.role === 'assistant' ? record.accountId || 'bot' : record.userId)),
    nickname: record.role === 'assistant' ? 'pippi' : text(record.nickname),
    isSelf: record.role === 'assistant', verified: true,
    scope: conversationKey(event), accountId: account,
    originModule: record.originModule || '', deliveryOutcome: record.deliveryOutcome || 'received',
  };
}
export function resolveLocalQuote(db: any, event: any) {
  const record = findMessageFact(db, event, event.replyMessageId);
  return record ? quoteFromRecord(record, event, messageAccount(db, event)) : undefined;
}
export function isVerifiedSelfQuote(db: any, event: any): boolean {
  const quote = event?.quotedMessage;
  const account = messageAccount(db, event);
  return Boolean(quote?.verified && quote.scope === conversationKey(event) && quote.accountId === account
    && text(quote.messageId) === text(event.replyMessageId) && quote.isSelf === true);
}

function imageFacts(value: unknown) {
  return extractImageInputs(value).filter((image: any) =>
    (image.url || image.file) && text(image.url || image.file).length <= 4096
    && !/^base64:|^data:/i.test(text(image.url || image.file))).slice(0, 12);
}
export function beginOutboundMessage(db: any, event: any, body: unknown, options: any = {}): string {
  const id = crypto.randomUUID();
  const origin = ORIGINS.has(options.originModule) ? options.originModule : options.forwardNodes?.length ? 'forward' : 'reply';
  const nodes = Array.isArray(options.forwardNodes) ? options.forwardNodes.slice(0, 50).map((node: any) => ({
    senderId: text(node.data?.user_id || node.data?.uin), nickname: text(node.data?.nickname || node.data?.name).slice(0, 80),
    text: normalizeMessage(node.data?.content || '').slice(0, 2000),
  })) : undefined;
  const content = nodes?.length ? '[合并转发]\n' + nodes.map((n: any) => `${n.nickname || '原作者'}：${n.text}`).join('\n') : normalizeMessage(body);
  const images = imageFacts(body);
  updateDb((draft: any) => {
    draft.messages.push({ id, requestId: currentRequestTraceId(), role: 'assistant',
      type: event.type, groupId: text(event.groupId || 'private'), peerId: event.type === 'private' ? text(event.userId) : '',
      userId: 'bot', senderId: messageAccount(db, event), accountId: messageAccount(db, event), nickname: 'pippi',
      originModule: origin, triggerMessageId: text(event.messageId),
      receivedAtMs: Number(event.receivedAtMs) || Date.now(),
      replyToMessageId: origin === 'random_image' ? '' : text(options.replyToMessageId || event.messageId),
      replyToUserId: origin === 'random_image' ? '' : text(event.userId),
      replyToNickname: origin === 'random_image' ? '' : text(event.nickname),
      content: content.slice(0, 16000), media: images.length ? { images } : undefined, forwardAuthors: nodes,
      deliveryOutcome: 'pending', inContext: false, createdAt: nowIso(),
    });
  });
  return id;
}

/** Journal availability must not prevent an otherwise authorized delivery. */
export function tryBeginOutboundMessage(db: any, event: any, body: unknown, options: any = {}): string | undefined {
  try {
    return beginOutboundMessage(db, event, body, options);
  } catch {
    traceEvent('ERROR', 'outbound_fact_begin_failed', { status: 'degraded' });
    return undefined;
  }
}

export function finishOutboundMessage(id: string, outcome: string, messageId?: unknown) {
  try {
    updateDb((db: any) => {
      const record = db.messages.find((m: any) => m.id === id);
      if (!record) return;
      const duplicates = messageId == null ? [] : db.messages.filter((m: any) => m.id !== id && m.role === 'assistant' && m.sourceMessageId === text(messageId)
        && m.accountId === record.accountId && m.type === record.type && m.groupId === record.groupId && m.peerId === record.peerId);
      const confirmed = record.deliveryOutcome === 'confirmed_success' || duplicates.some((m: any) => m.deliveryOutcome === 'confirmed_success');
      record.deliveryOutcome = confirmed ? 'confirmed_success' : outcome;
      if (messageId !== undefined && messageId !== null && text(messageId).trim()) record.sourceMessageId = text(messageId);
      record.confirmedAt = record.deliveryOutcome === 'confirmed_success' ? record.confirmedAt || nowIso() : undefined;
      record.deliveryLatencyMs = record.confirmedAt && Number.isFinite(record.receivedAtMs) ? Math.max(0, Date.parse(record.confirmedAt) - record.receivedAtMs) : undefined;
      record.inContext = record.deliveryOutcome === 'confirmed_success' && record.originModule !== 'notice';
      if (duplicates.length) { const ids = new Set(duplicates.map((m: any) => m.id)); db.messages = db.messages.filter((m: any) => !ids.has(m.id)); }
    });
    traceEvent('SEND', 'outbound_fact_recorded', { status: outcome });
  } catch {
    // Sending has already happened. A journal error must never cause a resend.
    traceEvent('ERROR', 'outbound_fact_record_failed', { status: 'degraded' });
  }
}

/** Add semantic detail to real sends without inventing a second platform message. */
export function recordAssistantContext(db: any, record: any) {
  const existing = (db.messages || []).filter((m: any) => m.deliveryOutcome && m.role === 'assistant'
    && messageInConversation(m, { type: record.type, groupId: record.groupId, userId: record.replyToUserId }, messageAccount(db, {}))
    && (m.triggerMessageId && m.triggerMessageId === record.replyToMessageId
      || record.requestId && m.requestId === record.requestId)
    && !['random_image', 'notice'].includes(m.originModule));
  if (!existing.length) { db.messages.push(record); return record.id; }
  const confirmed = existing.filter((m: any) => m.deliveryOutcome === 'confirmed_success');
  const target = confirmed.at(-1);
  if (target) {
    if (record.sticker) target.sticker = record.sticker;
    if (record.pendingQuickId) target.pendingQuickId = record.pendingQuickId;
    if (target.originModule === 'quick_command') target.contextSummary = text(record.content).slice(0, 1200);
  }
  return target?.id || existing.at(-1).id;
}

/** Trusted own-account events are receipts, never new conversational input. */
export function observeSelfMessage(raw: any): boolean {
  const db: any = readDb();
  const account = text(db.settings?.selfQq);
  const sender = text(raw.user_id || raw.sender?.user_id);
  if (!account || text(raw.self_id) !== account || sender !== account) return false;
  if (!['message', 'message_sent'].includes(raw.post_type) || raw.message_id == null) return false;
  const type = raw.message_type;
  const peer = text(raw.target_id || raw.peer_id);
  if (type !== 'group' && (type !== 'private' || !peer || peer === account)) return true;
  const event = { type, groupId: text(raw.group_id || 'private'), userId: type === 'private' ? peer : account };
  const existing = findMessageFact(db, event, raw.message_id);
  if (existing?.role === 'assistant') { finishOutboundMessage(existing.id, 'confirmed_success', raw.message_id); return true; }
  const id = beginOutboundMessage(db, event, raw.message || raw.raw_message || '', { originModule: 'self_event' });
  finishOutboundMessage(id, 'confirmed_success', raw.message_id);
  return true;
}
