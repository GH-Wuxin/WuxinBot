import { readDb, updateDb } from '../../store.js';
import { activeOwnerDirectives, isSystemOwner, readSocialPerson, readSocialView, socialScope, updateOwnerDirective } from '../social/state.js';
import type { OwnerHandlerContext } from './types.js';
import { readAffinityRanking } from '../social/ranking.js';

async function respond(ctx: OwnerHandlerContext, text: string) {
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, text);
  return { replied: Boolean(ctx.sendMessage), reason: text };
}

export async function ownerAffinityHandler(ctx: OwnerHandlerContext) {
  const db = readDb();
  // Do not trust the caller's isOwner flag, command-role overrides, or stored user policy.
  if (!isSystemOwner(db, ctx.event)) return respond(ctx, '只有所有者可以使用这个指令。');
  const target = String(ctx.event.atTargets?.find((id) => String(id) !== String(db.settings.selfQq)) || ctx.commandArgs.trim() || ctx.event.userId);
  if (!/^\d{4,20}$/.test(target)) return respond(ctx, '用法：/w 好感度 [@成员 或 QQ]；省略目标查看自己。');
  const person = readSocialPerson(db, target);
  if (!person) return respond(ctx, `QQ ${target}：尚无好感度记录。`);
  const view = readSocialView(db, socialScope(ctx.event), target);
  const affinity = person.affinity.kind === 'owner' ? '特殊（固定关系，不参与数值升降）' : `${person.affinity.score.toFixed(1)} / 100`;
  return respond(ctx, [
    `QQ ${target} · 好感度：${affinity}`,
    `熟悉程度：${person.familiarity.toFixed(1)} / 100`,
    `本会话关系：${view?.summary || (person.affinity.kind === 'owner' ? '稳定亲近与重视，情绪不影响指令权限。' : '尚无记录')}`,
    `本会话最近情绪：${view?.mood.label || '尚未判断'}`,
    view?.mood.reason ? `依据：${view.mood.reason}` : '',
    view?.preferredNames.length ? `已接受称呼：${view.preferredNames.join('、')}` : '',
    view?.lastReason ? `最近判断：${view.lastReason}` : '',
    `本会话评估：${view?.lastEvaluatedAt || view?.updatedAt || '尚无记录'}`,
  ].filter(Boolean).join('\n'));
}

export async function ownerDirectiveHandler(ctx: OwnerHandlerContext) {
  const db = readDb();
  if (!isSystemOwner(db, ctx.event)) return respond(ctx, '只有所有者可以使用这个指令。');
  const [action, key, ...body] = ctx.commandArgs.split(/\s+/);
  if (!action || action === 'list') {
    const entries = activeOwnerDirectives(db, socialScope(ctx.event));
    return respond(ctx, entries.length ? entries.map((d) => `${d.key} · v${d.version}：${d.text}`).join('\n') : '本会话没有已保存的长期指令。');
  }
  if (!['set', 'revoke'].includes(action) || !key) return respond(ctx, '用法：/w 指令 set 名称 内容 | revoke 名称 | list。只作用于当前会话。');
  updateDb((draft) => updateOwnerDirective(draft, ctx.event, key, body.join(' '), action === 'set'));
  return respond(ctx, `已${action === 'set' ? '保存' : '撤销'}本会话长期指令：${key}。`);
}

export async function ownerAffinityRankHandler(ctx: OwnerHandlerContext) {
  const db = readDb();
  if (!isSystemOwner(db, ctx.event)) return respond(ctx, '只有所有者可以使用这个指令。');
  const arg = ctx.commandArgs.trim().toLowerCase();
  if (!['', '本群', '全局', 'global'].includes(arg) || (arg === '本群' && ctx.event.type !== 'group')) {
    return respond(ctx, '用法：/w 好感榜 [全局]（别名 好感排名、affinity-top）。群聊默认本群，私聊默认全局。');
  }
  const global = ['全局', 'global'].includes(arg) || ctx.event.type === 'private';
  const ranking = readAffinityRanking(db, global ? null : socialScope(ctx.event));
  const plainName = (value: string) => value.replace(/\s+/g, ' ').slice(0, 40)
    .replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
  return respond(ctx, [
    `Pippi 好感榜 · ${global ? '全局' : '本群'}（${ranking.total} 人）`,
    ranking.owner ? `Owner ${ranking.owner.userId}：特殊 · 不参与数值排名` : '',
    ...ranking.entries.map((p) => `${p.rank}. ${plainName(p.nickname)}${p.nickname !== p.userId ? ` (${p.userId})` : ''} · ${p.score.toFixed(1)}`),
    !ranking.total ? '暂无普通成员的好感记录。' : '同分并列；只统计已有关系记录的成员。',
    ranking.total > ranking.entries.length ? `显示前 ${ranking.entries.length} 人，更多成员可在控制台查看。` : '',
  ].filter(Boolean).join('\n'));
}
