/**
 * 「刚才为什么没开口」的记录。
 *
 * 只在回复根本没生成出来时记一条 —— 也就是她压根没说话的那种。发图失败、权限
 * 拒绝、冷却拦截都不进这里：那些是「她说了话但某一步没成」，各自已有结果记录。
 * 分开是有意的：这样这行字只能解释她的缺席，没法拿来解释她做过的事。
 *
 * 另外两条限制也在这一层：只留一小时内的，最多三条，且按群隔离 —— 不能翻旧账，
 * 也不能把别的群的失败拿到这个群来说。
 */
import type { LlmFailureKind } from './llmFailure.js';
import { describeLlmFailure } from './llmFailure.js';

/** 存储上限。读取时还会按时间和条数再筛一次。 */
export const REPLY_FAILURE_KEEP = 50;
/** 只有这么久以内的才算「刚刚」。 */
export const REPLY_FAILURE_WINDOW_MS = 60 * 60 * 1000;
/** 最多列几条。 */
export const REPLY_FAILURE_NOTICE_MAX = 3;

export interface ReplyFailure {
  at: string;
  groupId: string;
  kind: LlmFailureKind;
}

/** 追加一条并把长度截住。store 在赋值那一刻做快照，所以必须返回完整的新数组。 */
export function appendReplyFailure(
  existing: unknown,
  entry: ReplyFailure,
  keep = REPLY_FAILURE_KEEP,
): ReplyFailure[] {
  const list = Array.isArray(existing) ? existing : [];
  return [...list, entry].slice(-keep);
}

function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  return minutes <= 0 ? '刚刚' : minutes + ' 分钟前';
}

export function recentReplyFailures(
  failures: unknown,
  groupId: string,
  now = Date.now(),
  windowMs = REPLY_FAILURE_WINDOW_MS,
  max = REPLY_FAILURE_NOTICE_MAX,
): ReplyFailure[] {
  const list = Array.isArray(failures) ? (failures as ReplyFailure[]) : [];
  return list
    .filter((item) => item && String(item.groupId) === String(groupId))
    .filter((item) => {
      const at = Date.parse(String(item.at));
      return Number.isFinite(at) && now - at <= windowMs;
    })
    .slice(-max);
}

/**
 * 给 pippi 自己看的那一行。没有近期失败就返回空字符串，什么都不注入。
 *
 * 措辞按「系统日志」写，并明说这是背景事实：她知道，但没被问到就不主动提，
 * 也不能拿它当理由。用措辞定性质，比在别处堆叮嘱可靠。
 */
export function replyFailureNotice(
  failures: unknown,
  groupId: string,
  now = Date.now(),
): string {
  const recent = recentReplyFailures(failures, groupId, now);
  if (!recent.length) return '';
  const parts = recent.map((item) => relativeTime(Date.parse(String(item.at)), now) + ' ' + describeLlmFailure(item.kind));
  return '（系统记录 · 最近 ' + recent.length + ' 次未能回复：' + parts.join(' · ')
    + '。背景事实，别主动提，也别当理由。）';
}
