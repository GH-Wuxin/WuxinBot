// Owner command handler for /w member-policy commands (/op, /deop, /ban, ...).
// Decomposed from server/bot/ownerCommands.ts; dispatch already handled
// unknown/usage/permission checks, so only the DB update + reply remain.
import { describePolicy } from '../prompt.js';
import { readDb, updateDb, nowIso } from '../../store.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerMemberPolicyHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  updateDb((draft) => {
    const existingIndex = draft.users.findIndex(
      (user) => String(user.groupId) === String(ctx.groupId) && String(user.userId) === String(ctx.target)
    );
    const entry = {
      groupId: ctx.groupId,
      userId: ctx.target,
      nickname: ctx.target,
      policy: ctx.policyMap[ctx.command],
      attentionLevel: ctx.policyMap[ctx.command] === 'priority' ? 5 : 3,
      allowCommands: ctx.policyMap[ctx.command] === 'admin',
      commandRoleId: ''
    };
    if (ctx.command === '/op' || ctx.command === '/设管理员') entry.commandRoleId = 'admin';
    if (ctx.command === '/deop' || ctx.command === '/取消管理员') entry.commandRoleId = '';
    if (existingIndex >= 0) draft.users[existingIndex] = { ...draft.users[existingIndex], ...entry, updatedAt: nowIso() };
    else draft.users.push({ ...entry, id: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso() });
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: ctx.event.userId,
      action: ctx.command,
      targetUserId: ctx.target,
      groupId: ctx.groupId,
      detail: `设置为 ${ctx.policyMap[ctx.command]}`,
      createdAt: nowIso()
    });
  });

  const reply = `已把 ${ctx.target} 设置为 ${describePolicy(ctx.policyMap[ctx.command])}。`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}
