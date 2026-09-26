// Bounded adaptive retrieval for QQ group history.
//
// Normal turns receive the recent tail configured by contextLimit. Turns that
// explicitly depend on older context ("刚才/之前/继续/那张图", or a QQ reply)
// additionally retrieve a small, relevant set from an older bounded pool. This
// is intentionally local and deterministic: it does not spend a second LLM
// request merely to decide whether more history is needed.
import type { BotEvent, Db, MessageRecord } from '../types.js';

export interface GroupContextSearchStats {
  expanded: boolean;
  reason: 'disabled' | 'recent_only' | 'history_reference' | 'quoted_message';
  baseCount: number;
  retrievedCount: number;
  searchedCount: number;
}

export interface GroupContextSelection {
  messages: MessageRecord[];
  stats: GroupContextSearchStats;
}

const HISTORY_REFERENCE_RE = /刚才|方才|前面|之前|先前|上次|上一(?:句|条|段|张|次|个)|更早|历史|聊天记录|还记得|继续|接着|补上|再说|你(?:刚才|之前|上次)?说|他(?:刚才|之前)?说|她(?:刚才|之前)?说|提到过|那个|这个|那件事|这件事|那张|这张|那段|这段|原来那个|还是那个/i;
const VISUAL_REFERENCE_RE = /图|图片|截图|表情包|照片|画面|这张|那张|上面|下面/i;
const ASSISTANT_REFERENCE_RE = /你(?:刚才|之前|上次)?说|你提到|你的回答|你回的|上一句/i;
const GENERIC_TOKENS = new Set([
  '刚才', '方才', '前面', '之前', '先前', '上次', '上一', '更早', '历史', '聊天',
  '记录', '继续', '接着', '补上', '再说', '那个', '这个', '这件', '那件', '这张',
  '那张', '这段', '那段', '什么', '怎么', '为什么', '一下', '一个', '还是', '关于',
]);

function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function isCurrentEventMessage(message: MessageRecord, event: BotEvent): boolean {
  const sourceMessageId = String(message.sourceMessageId || '');
  return Boolean(sourceMessageId && event.messageId && sourceMessageId === String(event.messageId));
}

function messageCost(message: MessageRecord): number {
  return String(message.content || '').length + String(message.nickname || message.userId || '').length + 24;
}

function searchableText(value: unknown): string {
  return String(value || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\[(?:图片|表情包|表情|视频|语音|文件)\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLowerCase();
}

function lexicalTokens(value: unknown): Set<string> {
  const text = searchableText(value);
  const result = new Set<string>();
  for (const token of text.match(/[a-z][a-z0-9_+.-]{1,31}/g) || []) result.add(token);
  for (const sequence of text.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 8) result.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      result.add(sequence.slice(index, index + 2));
    }
  }
  for (const token of [...result]) {
    if (GENERIC_TOKENS.has(token)) result.delete(token);
  }
  return result;
}

function historyReferenceReason(event: BotEvent): GroupContextSearchStats['reason'] | null {
  if (event.replyMessageId || event.quotedMessage?.messageId) return 'quoted_message';
  const text = String(event.text || '').trim();
  return HISTORY_REFERENCE_RE.test(text) ? 'history_reference' : null;
}

function scoreMessage(message: MessageRecord, queryTokens: Set<string>, event: BotEvent, recency: number): number {
  const tokens = lexicalTokens(message.content);
  let overlap = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) overlap += token.length >= 3 ? 1.4 : 1;
  }
  let score = overlap;
  const text = String(event.text || '');
  if (ASSISTANT_REFERENCE_RE.test(text) && message.role === 'assistant') score += 1.1;
  if (VISUAL_REFERENCE_RE.test(text) && message.media?.images?.length) score += 1.8;
  if (String(message.userId) === String(event.userId)) score += 0.2;
  score += recency * 0.15;
  return score;
}

function addWithNeighbours(target: Set<number>, index: number, length: number): void {
  for (let offset = -1; offset <= 1; offset += 1) {
    const candidate = index + offset;
    if (candidate >= 0 && candidate < length) target.add(candidate);
  }
}

export function selectAdaptiveGroupContext(db: Db, event: BotEvent): GroupContextSelection {
  const baseLimit = numberSetting(db.settings.contextLimit, 30, 5, 80);
  const visible = (db.messages || []).filter((message) =>
    String(message.groupId) === String(event.groupId) &&
    message.type === 'group' &&
    message.inContext !== false &&
    !isCurrentEventMessage(message, event)
  );
  const base = visible.slice(-baseLimit);
  const enabled = db.settings.groupContextSearchEnabled !== false;
  const reason = historyReferenceReason(event);
  if (!enabled || !reason || visible.length <= base.length) {
    return {
      messages: base,
      stats: {
        expanded: false,
        reason: enabled ? 'recent_only' : 'disabled',
        baseCount: base.length,
        retrievedCount: 0,
        searchedCount: 0,
      },
    };
  }

  const poolSize = numberSetting(db.settings.groupContextSearchPoolSize, 400, 50, 2000);
  const maxExtra = numberSetting(db.settings.groupContextSearchMaxExtra, 24, 3, 80);
  const charBudget = numberSetting(db.settings.groupContextSearchCharBudget, 12000, 2000, 40000);
  const older = visible.slice(0, Math.max(0, visible.length - base.length));
  const pool = older.slice(-poolSize);
  const selectedIndexes = new Set<number>();

  const quotedId = String(event.quotedMessage?.messageId || event.replyMessageId || '');
  if (quotedId) {
    const quotedIndex = pool.findIndex((message) =>
      String(message.sourceMessageId || '') === quotedId || String(message.id || '') === quotedId
    );
    if (quotedIndex >= 0) addWithNeighbours(selectedIndexes, quotedIndex, pool.length);
  }

  const queryTokens = lexicalTokens([
    event.text,
    event.quotedMessage?.text,
    event.quotedMessage?.nickname,
  ].filter(Boolean).join(' '));
  const ranked = pool
    .map((message, index) => ({
      index,
      score: scoreMessage(message, queryTokens, event, pool.length ? (index + 1) / pool.length : 0),
    }))
    .filter((item) => item.score >= 0.9)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, 8);
  for (const item of ranked) addWithNeighbours(selectedIndexes, item.index, pool.length);

  // Deictic requests such as "继续刚才那个" may contain no useful lexical
  // terms. In that case widen the recent tail rather than returning nothing.
  if (selectedIndexes.size === 0) {
    const fallbackStart = Math.max(0, pool.length - maxExtra);
    for (let index = fallbackStart; index < pool.length; index += 1) selectedIndexes.add(index);
  }

  const priority = [...selectedIndexes]
    .map((index) => ({
      index,
      score: scoreMessage(pool[index], queryTokens, event, pool.length ? (index + 1) / pool.length : 0),
    }))
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const accepted = new Set<number>();
  let usedChars = 0;
  for (const candidate of priority) {
    if (accepted.size >= maxExtra) break;
    const cost = messageCost(pool[candidate.index]);
    if (accepted.size >= 3 && usedChars + cost > charBudget) continue;
    accepted.add(candidate.index);
    usedChars += cost;
  }

  const retrieved = [...accepted].sort((a, b) => a - b).map((index) => pool[index]);
  return {
    messages: [...retrieved, ...base],
    stats: {
      expanded: retrieved.length > 0,
      reason,
      baseCount: base.length,
      retrievedCount: retrieved.length,
      searchedCount: pool.length,
    },
  };
}
