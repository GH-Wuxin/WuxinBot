import { tokenSaving } from '../tokenSaving.js';
import { getUserPolicy } from '../gate.js';
import { textWithoutControlPlaceholders } from '../cleaning.js';
import { isSystemOwner } from './state.js';
import { isVerifiedSelfQuote, messageInConversation, messageAccount } from '../../messageFacts.js';
import type { SocialEvent } from './types.js';

/**
 * Ambient participation is the only social LLM call that can be triggered by
 * ordinary group chatter. Keep it on a slow per-room cadence so a busy room
 * cannot spend the whole token budget on deciding not to speak. Direct
 * requests and likely continuations bypass this cooldown.
 */
export const AMBIENT_COOLDOWN_MS = 120 * 60_000;

export function participationStatus(db: any, group: any) {
  const mode = !group?.enabled || db.settings.globalPaused ? 'silent'
    : db.settings.socialV2Enabled !== true && ['light', 'natural'].includes(group.mode) ? 'mention' : group.mode;
  const reason = db.settings.globalPaused ? '全局暂停中' : !group?.enabled ? '本群未启用'
    : mode !== group.mode ? '自然接话已关闭，仅回应提及' : '';
  return { mode, reason };
}

/** Deterministic boundaries only. Meaning and participation are decided by the model. */
export function chatAdmissionReason(db: any, event: SocialEvent, direct: boolean): string {
  if (db.settings.globalPaused) return '机器人处于全局暂停状态';
  if (event.type === 'private') return isSystemOwner(db, event) ? '' : '私聊仅对 Owner 开放';
  const group = db.groups.find((g) => String(g.groupId) === String(event.groupId));
  if (!group?.enabled) return '这个群没有启用机器人';
  if (group.mode === 'silent') return '当前群是静默模式';
  if (group.mode === 'osu') return '当前群仅处理 osu! 指令';
  if (!['mention', 'light', 'natural'].includes(group.mode)) return '本群回复模式无效';
  const policy = getUserPolicy(db, event.groupId, event.userId);
  if (policy.policy === 'blocked') return '该用户在黑名单中';
  if (policy.policy === 'muted' && !direct) return '该用户被设置为少回应';
  if (!direct && participationStatus(db, group).mode === 'mention') return '当前生效模式只回应提及';
  if (event.text?.startsWith('/')) return '指令交给专用入口处理';
  if (!textWithoutControlPlaceholders(event.text || '') && (!direct || db.settings.socialV2Enabled !== true && !event.images?.length)) {
    return '只有 @/媒体/卡片占位，没有可回复的文字';
  }
  return '';
}

export function conversationContext(db: any, event: SocialEvent) {
  const timeline = db.messages.filter((m) => m.inContext !== false && messageInConversation(m, event, messageAccount(db, event)));
  const last = timeline.filter((m) => m.role === 'assistant' && !['random_image','notice'].includes(m.originModule)).at(-1);
  const secondsSinceLastReply = last ? Math.max(0, (Date.now() - Date.parse(last.createdAt)) / 1000) : null;
  const repliesToBot = isVerifiedSelfQuote(db, event) || Boolean(event.replyMessageId && timeline.some((m) => m.role === 'assistant'
    && String(m.sourceMessageId || m.messageId || '') === String(event.replyMessageId)));
  const addressesAnother = (event.atTargets || []).some((id) => String(id) !== String(db.settings.selfQq));
  const quotesAnother = Boolean(event.replyMessageId && !repliesToBot);
  // This is a scheduling hint, not a semantic verdict that the user is continuing.
  const continuationCandidate = !addressesAnother && !quotesAnother && (repliesToBot
    || Boolean(last && secondsSinceLastReply !== null && secondsSinceLastReply < 120 && String(last.replyToUserId) === event.userId));
  return { lastReplyToUserId: last?.replyToUserId || null, secondsSinceLastReply, repliesToBot, continuationCandidate };
}

export function replyLimitReason(db: any, event: SocialEvent, continuation = false): string {
  if (event.type === 'private') return '';
  const group = db.groups.find((g) => String(g.groupId) === String(event.groupId));
  const policy = getUserPolicy(db, event.groupId, event.userId);
  if (event.socialDirect && (isSystemOwner(db, event) || policy.policy === 'admin' || policy.allowCommands)) return '';
  const ownIds = new Set(event.socialMessageIds || [event.messageId]);
  const attempts = new Map<string, number>();
  for (const m of db.messages || []) if (m.role === 'assistant' && !['random_image','notice'].includes(m.originModule) && String(m.groupId) === String(event.groupId)) {
    attempts.set(String(m.replyToMessageId || m.id), Date.parse(m.createdAt));
  }
  for (const d of db.decisions || []) if (d.shouldReply && String(d.groupId) === String(event.groupId)) {
    const key = String(d.messageId || d.id);
    if (!attempts.has(key)) attempts.set(key, Date.parse(d.createdAt));
  }
  const recent = [...attempts].filter(([id, at]) => !ownIds.has(id) && Date.now() - at < 3600_000).map(([, at]) => at);
  if (recent.length >= Math.max(1, Number(group?.maxPerHour ?? 20))) return '已达到本群每小时回复上限';
  if (!event.socialDirect && !continuation && recent.length
    && Date.now() - Math.max(...recent) < Math.max(0, Number(group?.cooldownSec ?? 30)) * 1000) return '本群回复冷却中';
  return '';
}

function ambientCooldownReason(db: any, scope: string, event: SocialEvent, resumed: boolean): string {
  if (event.socialDirect || resumed || conversationContext(db, event).continuationCandidate) return '';
  const now = Date.now();
  const cooling = (db.socialV2?.decisions || []).some((d: any) => d?.scope === scope
    && d.engagement === 'ambient' && d.stage === 'assessment'
    && d.phase !== 'revalidation' && now - Date.parse(d.createdAt) < AMBIENT_COOLDOWN_MS);
  return cooling ? `${tokenSaving(db) ? '节能模式：' : ''}自然接话冷却中（120 分钟）` : '';
}

/** Failed requests have a separate short cooldown, never consume normal assessment quota.
 * Legacy failure records remain usable; success clears the consecutive-failure streak.
 * Guard records do not extend the cooldown. No timer or automatic retries are created.
 */
export function assessmentFailureBackoffReason(db: any, scope: string, now = Date.now()): string {
  const history = (db.socialV2?.decisions || []).filter((d: any) => d.scope === scope
    && d.phase !== 'revalidation' && ['assessment', 'failure'].includes(d.stage)
    && Number.isFinite(Date.parse(d.createdAt)) && Date.parse(d.createdAt) <= now)
    .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let failures = 0;
  for (const entry of history) { if (entry.stage !== 'failure') break; failures++; }
  if (!failures) return '';
  const delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
  const remaining = delay - (now - Date.parse(history[0].createdAt));
  return remaining > 0 ? '社交评估调用失败退避中；约 ' + Math.ceil(remaining / 1000) + ' 秒后可再次评估' : '';
}

export function assessmentBudgetReason(db: any, event: SocialEvent, resumed: boolean): string {
  const scope = event.type === 'private' ? `private:${event.userId}` : `group:${event.groupId}`;
  const failureBackoff = assessmentFailureBackoffReason(db, scope);
  if (failureBackoff) return failureBackoff;
  const calls = db.socialV2.decisions.filter((d) => d.scope === scope && d.stage === 'assessment'
    && d.phase !== 'revalidation' && Date.now() - Date.parse(d.createdAt) < 3600_000);
  // The two-hour room cooldown is the primary ambient limiter; the hourly and
  // ten-minute checks below remain as defensive fallbacks.
  const cooldown = ambientCooldownReason(db, scope, event, resumed);
  if (cooldown) return cooldown;
  if (tokenSaving(db)) {
    if (event.socialDirect || resumed || conversationContext(db, event).continuationCandidate) return '';
    const ambient = calls.filter(d => d.engagement === 'ambient');
    if (ambient.length >= Math.min(6, Number(db.settings.socialMaxAssessmentsPerHour || 60))) return '节能模式：自然门控达到小时额度';
    if (ambient.some(d => Date.now() - Date.parse(d.createdAt) < 10 * 60_000)) return '节能模式：自然门控间隔中';
    return '';
  }
  const budget = Math.max(1, Math.min(300, Number(db.settings.socialMaxAssessmentsPerHour || 60)));
  if (calls.length >= budget) return '本会话社交评估达到小时预算；关系保持不变';
  if (event.socialDirect || resumed || conversationContext(db, event).continuationCandidate) return '';
  // Pace ambient evaluations with a burst of three; explicit requests and
  // likely continuations need not wait for an ambient slot. No text scoring.
  const interval = 3600_000 / budget;
  let next = 0;
  for (const call of calls.filter((d) => d.engagement === 'ambient' && d.phase === 'initial')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
    next = Math.max(next, Date.parse(call.createdAt)) + interval;
  }
  return Date.now() < next - 2 * interval ? '自然接话评估间隔中，保留上下文等待下一次机会' : '';
}
