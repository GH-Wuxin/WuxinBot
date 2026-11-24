import { boundedInteger } from '../boundedInteger.js';
// Bounded, conversation-scoped group context. The model interprets meaning;
// this module follows transport links and offers recent conversation evidence.
import type { BotEvent, Db, MessageRecord } from '../types.js';
import { messageAccount, messageContextText, messageInConversation } from '../messageFacts.js';

export interface GroupContextSearchStats {
  expanded: boolean;
  reason: 'disabled' | 'recent_only' | 'conversation_links' | 'quoted_message';
  baseCount: number;
  retrievedCount: number;
  searchedCount: number;
}
export interface GroupContextSelection {
  messages: MessageRecord[];
  stats: GroupContextSearchStats;
}
export interface GroupTurnPart {
  messageId: string;
  userId: string;
  nickname?: string;
  text: string;
  atTargets: string[];
  mentionNames?: unknown;
  replyMessageId: string;
  quotedMessage?: BotEvent['quotedMessage'];
}
type GroupTurn = BotEvent & {
  mentionNames?: unknown;
  socialMessages?: GroupTurnPart[];
  selectedGroupContext?: GroupContextSelection;
};

function rowId(row: MessageRecord) { return String(row.sourceMessageId || row.messageId || row.id || ''); }
export { rowId as contextRowId };
export function contextReplyId(row: MessageRecord) {
  return String(row.role === 'assistant' ? row.replyToMessageId || '' : row.replyMessageId || '');
}

export function groupTurnParts(event: GroupTurn): GroupTurnPart[] {
  return event.socialMessages?.length ? event.socialMessages : [{
    messageId: event.messageId, userId: event.userId, nickname: event.nickname, text: event.text,
    atTargets: event.atTargets || [], mentionNames: event.mentionNames,
    replyMessageId: event.replyMessageId || '', quotedMessage: event.quotedMessage,
  }];
}

/** No after-the-target turns, regardless of priority delays; a merged turn ends at its last constituent. */
export function conversationBeforeTurn(db: Db, event: BotEvent): MessageRecord[] {
  const account = messageAccount(db, event);
  const rows = (db.messages || []).filter(m => messageInConversation(m, event, account));
  const targetId = String(event.messageId || '');
  const boundary = targetId ? rows.findIndex(row => row.role === 'user' && rowId(row) === targetId) : -1;
  const currentIds = new Set(groupTurnParts(event).map(part => String(part.messageId)));
  return (boundary < 0 ? rows : rows.slice(0, boundary)).filter(row =>
    row.inContext !== false && !['confirmed_failure', 'pending'].includes(String(row.deliveryOutcome || ''))
    && !currentIds.has(rowId(row))
    && (boundary >= 0 || !event.receivedAtMs || !(Date.parse(row.createdAt) > event.receivedAtMs)));
}

function rowCost(row: MessageRecord): number {
  return messageContextText(row).length + String(row.nickname || row.userId || '').length
    + String(row.sticker?.description || '').length + rowId(row).length + contextReplyId(row).length + 48;
}
function savingTail(rows: MessageRecord[]): MessageRecord[] {
  let left = 2200;
  const selected: MessageRecord[] = [];
  for (const row of rows.slice(-8).reverse()) {
    const entry = { ...row, content: String(row.content || '').slice(0, 500),
      contextSummary: row.contextSummary?.slice(0, 500) };
    const size = rowCost(entry);
    if (size > left) break;
    selected.unshift(entry);
    left -= size;
  }
  return selected;
}

export function selectAdaptiveGroupContext(db: Db, event: GroupTurn): GroupContextSelection {
  const visible = conversationBeforeTurn(db, event);
  const saving = db.settings.tokenSavingMode === true;
  const baseLimit = boundedInteger(db.settings.contextLimit, 30, 5, 80);
  const base = saving ? savingTail(visible) : visible.slice(-baseLimit);
  const enabled = !saving && db.settings.groupContextSearchEnabled !== false;
  const result = (extra: MessageRecord[] = [], searchedCount = 0, quoted = false): GroupContextSelection => ({
    messages: [...extra, ...base], stats: { expanded: extra.length > 0,
      reason: !enabled ? 'disabled' : !extra.length ? 'recent_only' : quoted ? 'quoted_message' : 'conversation_links',
      baseCount: base.length, retrievedCount: extra.length, searchedCount },
  });
  if (!enabled || visible.length <= base.length) return result();

  const maxExtra = boundedInteger(db.settings.groupContextSearchMaxExtra, 24, 3, 80);
  const poolSize = boundedInteger(db.settings.groupContextSearchPoolSize, 400, 50, 2000);
  const budget = boundedInteger(db.settings.groupContextSearchCharBudget, 12000, 2000, 40000);
  const older = visible.slice(0, visible.length - base.length).slice(-poolSize);
  const baseIds = new Set(base.map(rowId));
  const byId = new Map([...older, ...base].map(row => [rowId(row), row]));
  const extra = new Set<MessageRecord>();
  let used = 0;
  function take(row: MessageRecord) {
    if (baseIds.has(rowId(row)) || extra.has(row)) return;
    const cost = rowCost(row);
    if (extra.size >= maxExtra || used + cost > budget) return;
    extra.add(row);
    used += cost;
  }
  function walk(start: string) {
    let id = start;
    const seen = new Set<string>();
    for (let hops = 0; id && hops < 6 && !seen.has(id); hops++) {
      seen.add(id);
      const parent = byId.get(id);
      if (!parent) break;
      take(parent);
      id = contextReplyId(parent);
    }
  }

  // Exact current links first, then a few durable local exchanges that can
  // survive a busy channel. This is evidence selection, not a referent verdict.
  const quotes = groupTurnParts(event).map(part => part.replyMessageId || part.quotedMessage?.messageId || '').filter(Boolean);
  for (const id of quotes) walk(id);

  let same = 0, bot = 0;
  for (let i = older.length - 1; i >= 0 && (same < 4 || bot < 4); i--) {
    const row = older[i];
    if (row.role === 'user' && String(row.userId) === String(event.userId) && same < 4) same++;
    else if (row.role === 'assistant' && String(row.replyToUserId) === String(event.userId) && bot < 4) bot++;
    else continue;
    take(row);
    walk(contextReplyId(row));
    // An unthreaded follow-up often sits directly beside the speaker's line.
    if (i > 0) take(older[i - 1]);
    if (i + 1 < older.length) take(older[i + 1]);
  }

  for (const row of [...base].reverse()) walk(contextReplyId(row));
  return result(older.filter(row => extra.has(row)), older.length, quotes.length > 0);
}

/** A gate and subsequent reply on the same event read one already-bounded snapshot. */
export function groupContextForTurn(db: Db, event: GroupTurn): GroupContextSelection {
  return event.selectedGroupContext || selectAdaptiveGroupContext(db, event);
}

export function freezeGroupContext(db: Db, event: GroupTurn): GroupContextSelection {
  return event.selectedGroupContext ||= selectAdaptiveGroupContext(db, event);
}
