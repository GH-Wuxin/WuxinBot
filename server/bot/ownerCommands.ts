// Owner/admin command suite split from server/bot.ts.
// This file is now a thin typed dispatcher. All branch bodies live in
// server/bot/owner/*.ts; routing and permission decisions are in
// server/bot/owner/router.ts and registry.ts.
import {
  commandRoleLevel,
  commandRoleName,
  userCommandRoleId,
  parseCommandMeta,
  writeCommandLog,
} from './commands.js';
import { readDb, updateDb } from '../store.js';
import { getUserPolicy } from './gate.js';
import {
  OWNER_DEFAULT_COMMAND_PERMISSIONS,
} from './commands/owner.meta.js';
import { OWNER_HANDLER_REGISTRY } from './owner/registry.js';
import { resolveOwnerRoute } from './owner/router.js';
import type { OwnerHandlerContext } from './owner/types.js';

const policyMap = {
  '/op': 'admin',
  '/deop': 'normal',
  '/ban': 'blocked',
  '/unban': 'normal',
  '/trust': 'whitelist',
  '/focus': 'priority',
  '/quiet': 'muted',
  '/normal': 'normal',
  '/拉黑': 'blocked',
  '/取消拉黑': 'normal',
  '/白名单': 'whitelist',
  '/重点关注': 'priority',
  '/少回应': 'muted',
  '/正常': 'normal',
  '/设管理员': 'admin',
  '/取消管理员': 'normal'
};

function ownerHasCommandPermission(db, userPolicy, permissions, permissionKey) {
  if (permissions.isOwner || userPolicy.policy === 'owner') return true;
  const requiredRoleId =
    db.settings.commandPermissions?.[permissionKey] ||
    OWNER_DEFAULT_COMMAND_PERMISSIONS[permissionKey] ||
    'owner';
  const userRoleId = userCommandRoleId(db, userPolicy, permissions);
  return commandRoleLevel(db, userRoleId) >= commandRoleLevel(db, requiredRoleId);
}

function ownerCommandDeniedReply(db, permissionKey) {
  const requiredRoleId =
    db.settings.commandPermissions?.[permissionKey] ||
    OWNER_DEFAULT_COMMAND_PERMISSIONS[permissionKey] ||
    'owner';
  return `这个指令需要 ${commandRoleName(db, requiredRoleId)} 或更高权限。`;
}

export async function handleOwnerCommand(event, sendMessage = undefined, permissions = { isOwner: true, isAdmin: false }) {
  const meta = parseCommandMeta(event, permissions);
  const startedAt = Date.now();
  try {
    const result: any = await runOwnerCommand(event, sendMessage, permissions);
    const reason = String(result?.reason || result?.text || result?.error || '').slice(0, 800);
    const status = result?.error
      ? 'error'
        : (reason.startsWith('这个指令需要 ') || reason.includes('只有所有者可以使用'))
        ? 'denied'
        : /用法：|范围|设置失败|未知 .*指令|消息太少|不能为空|还没有添加到白名单/.test(reason)
          ? 'invalid'
          : result?.replied
            ? 'ok'
            : 'ignored';
    writeCommandLog(event, meta, {
      status,
      reason,
      errorMessage: result?.error ? String(result.error).slice(0, 1200) : '',
      latencyMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    const message = error?.message || String(error);
    const reply = `指令执行失败：${message}`;
    if (sendMessage) await sendMessage(event, reply);
    updateDb((draft) => {
      draft.usage.errors += 1;
    });
    writeCommandLog(event, meta, {
      status: 'error',
      reason: reply,
      errorName: error?.name || 'Error',
      errorMessage: message,
      errorStack: String(error?.stack || '').slice(0, 2000),
      latencyMs: Date.now() - startedAt
    });
    return { replied: Boolean(sendMessage), error: message, reason: reply };
  }
}

async function runOwnerCommand(event, sendMessage, permissions = { isOwner: true, isAdmin: false }) {
  // Keep parser semantics identical to the pre-dispatch implementation.
  const commandDb = readDb();
  const commandUserPolicy = getUserPolicy(commandDb, event.groupId, event.userId);
  const parts = event.text.trim().split(/\s+/);
  const prefix = parts[0].toLowerCase();
  const isWuxinCommand = prefix === '/wuxin' || prefix === '/w';
  const command = isWuxinCommand ? `/${(parts[1] || '').toLowerCase()}` : prefix;
  const subCommand = isWuxinCommand ? (parts[2] || '').toLowerCase() : '';
  const commandArgs = isWuxinCommand ? parts.slice(2).join(' ') : parts.slice(1).join(' ');
  const target = (event.atTargets && event.atTargets[0]) || (isWuxinCommand ? parts[2] : parts[1]);
  const groupId = (isWuxinCommand ? parts[3] : parts[2]) || event.groupId;

  const context: OwnerHandlerContext = {
    event,
    sendMessage,
    permissions,
    parts,
    prefix,
    isWuxinCommand,
    command,
    subCommand,
    commandArgs,
    target,
    groupId,
    commandDb,
    commandUserPolicy,
    policyMap,
  };

  const route = resolveOwnerRoute(context);

  if (route.kind === 'reply') {
    if (route.reply !== undefined && sendMessage) await sendMessage(event, route.reply);
    return { replied: route.replied, reason: route.reason };
  }

  const handler = OWNER_HANDLER_REGISTRY[route.handlerKey];
  if (!handler) {
    throw new Error(`owner handler missing: ${route.handlerKey}`);
  }

  if (route.permissionKey && !ownerHasCommandPermission(commandDb, commandUserPolicy, permissions, route.permissionKey)) {
    const denyReplyKey = route.denyReplyKey || route.permissionKey;
    const reason = ownerCommandDeniedReply(commandDb, denyReplyKey);
    if (sendMessage) await sendMessage(event, reason);
    return { replied: Boolean(sendMessage), reason };
  }

  return handler(context);
}
