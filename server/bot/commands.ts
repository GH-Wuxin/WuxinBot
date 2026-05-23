// Command system: role helpers, permission checks, command logging.
// Extracted from bot.ts.
// Phase B (command registry) will move the actual handlers here.
import { defaultCommandPermissions } from '../store.js';

export function commandRoles(db) {
  return db.settings.commandRoles || [];
}

export function commandRoleLevel(db, roleId) {
  const role = commandRoles(db).find((item) => item.id === roleId);
  return Number(role?.level ?? 0);
}

export function commandRoleName(db, roleId) {
  const role = commandRoles(db).find((item) => item.id === roleId);
  return role?.name || roleId || '未设置用户组';
}

export function userCommandRoleId(db, userPolicy, permissions) {
  if (permissions.isOwner || userPolicy.policy === 'owner') return 'owner';
  if (userPolicy.commandRoleId) return userPolicy.commandRoleId;
  if (permissions.isAdmin || userPolicy.policy === 'admin' || userPolicy.allowCommands) return 'admin';
  return 'guest';
}

export function hasCommandPermission(db, userPolicy, permissions, permissionKey) {
  if (permissions.isOwner || userPolicy.policy === 'owner') return true;
  const requiredRoleId = db.settings.commandPermissions?.[permissionKey] || defaultCommandPermissions[permissionKey] || 'owner';
  const userRoleId = userCommandRoleId(db, userPolicy, permissions);
  return commandRoleLevel(db, userRoleId) >= commandRoleLevel(db, requiredRoleId);
}

export function commandDeniedReply(db, permissionKey) {
  const requiredRoleId = db.settings.commandPermissions?.[permissionKey] || defaultCommandPermissions[permissionKey] || 'owner';
  return `这个指令需要 ${commandRoleName(db, requiredRoleId)} 或更高权限。`;
}

export function parseCommandMeta(event, permissions = { isOwner: false, isAdmin: false }) {
  const text = String(event.text || '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const prefix = (parts[0] || '').toLowerCase();
  const isWuxinCommand = prefix === '/wuxin' || prefix === '/w';
  const command = isWuxinCommand ? `/${(parts[1] || '').toLowerCase()}` : prefix;
  const subCommand = isWuxinCommand ? (parts[2] || '').toLowerCase() : '';
  const db = readDb();
  const userPolicy = getAnyUserPolicy(db, event.groupId, event.userId);
  return {
    rawText: text.slice(0, 600), prefix, command, subCommand, isWuxinCommand,
    userRoleId: userCommandRoleId(db, userPolicy, permissions),
    userPolicy: userPolicy.policy || 'normal'
  };
}

import { readDb, updateDb, nowIso } from '../store.js';

function getAnyUserPolicy(db, groupId, userId) {
  if (db.settings.ownerQq && String(userId) === String(db.settings.ownerQq)) {
    return { policy: 'owner', attentionLevel: 5, allowCommands: true, commandRoleId: 'owner' };
  }
  return db.users.find((user) => String(user.groupId) === String(groupId) && String(user.userId) === String(userId)) || {
    policy: 'normal', attentionLevel: 3, allowCommands: false
  };
}

export function writeCommandLog(event, meta, patch) {
  updateDb((draft) => {
    if (!draft.commandLogs) draft.commandLogs = [];
    draft.commandLogs.push({
      id: crypto.randomUUID(), messageId: event.messageId, type: event.type,
      groupId: event.groupId, userId: event.userId, nickname: event.nickname,
      command: meta.command, subCommand: meta.subCommand, rawText: meta.rawText,
      isWuxinCommand: meta.isWuxinCommand, userRoleId: meta.userRoleId,
      userPolicy: meta.userPolicy, createdAt: nowIso(), ...patch
    });
    draft.commandLogs = draft.commandLogs.slice(-1500);
  });
}
