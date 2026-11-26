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

const FINAL_COMMAND_STATUSES = new Set(['ok', 'completed', 'denied', 'error', 'ignored', 'invalid', 'timeout']);

function commandStatusFromOutcome(outcome: unknown) {
  const value = String(outcome || '').toLowerCase();
  if (FINAL_COMMAND_STATUSES.has(value)) return value === 'completed' ? 'ok' : value;
  if (value === 'unbound' || value === 'unimplemented') return 'invalid';
  if (value === 'disabled') return 'ignored';
  return 'ok';
}

function appendCommandProgress(log: any, stage: string, detail = '') {
  log.progress = [...(log.progress || []), {
    stage,
    at: nowIso(),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
  }].slice(-30);
}

function activeCommandLog(logs: any[], messageId: string) {
  return [...(logs || [])].reverse().find((log) => String(log.messageId) === String(messageId) && log.status === 'active');
}

/** Create or reuse the live record before a command starts. */
export function beginCommandLog(event: any, meta: any, stage = 'received', detail = '') {
  const now = nowIso(), id = crypto.randomUUID();
  updateDb((draft) => {
    if (!draft.commandLogs) draft.commandLogs = [];
    const existing = activeCommandLog(draft.commandLogs, event.messageId);
    if (existing) {
      existing.stage = stage;
      existing.updatedAt = now;
      appendCommandProgress(existing, stage, detail);
      return;
    }
    draft.commandLogs.push({
      id, messageId: event.messageId, type: event.type,
      groupId: event.groupId, userId: event.userId, nickname: event.nickname,
      command: meta.command, subCommand: meta.subCommand, rawText: meta.rawText,
      isWuxinCommand: meta.isWuxinCommand, userRoleId: meta.userRoleId,
      userPolicy: meta.userPolicy, status: 'active', stage, reason: '',
      startedAt: now, updatedAt: now, createdAt: now,
      progress: [{ stage, at: now, ...(detail ? { detail } : {}) }],
    });
    draft.commandLogs = draft.commandLogs.slice(-1500);
  });
  return id;
}

/** Advance the live stage without completing the command. */
export function setCommandStage(event: any, stage: string, detail = '') {
  updateDb((draft) => {
    const active = activeCommandLog(draft.commandLogs || [], event.messageId);
    if (!active) return;
    active.stage = stage;
    active.updatedAt = nowIso();
    appendCommandProgress(active, stage, detail);
  });
}

/** Finish the live record. Existing call sites keep using writeCommandLog. */
export function completeCommandLog(event: any, status: 'ok' | 'completed' | 'denied' | 'error' | 'ignored' | 'invalid' | 'timeout' = 'ok', reason = '') {
  updateDb((draft) => {
    const active = activeCommandLog(draft.commandLogs || [], event.messageId);
    if (!active) return;
    const now = nowIso();
    active.status = status === 'completed' ? 'ok' : status;
    active.stage = status === 'ok' || status === 'completed' ? 'completed' : status;
    active.reason = String(reason || active.reason || '').slice(0, 1200);
    active.updatedAt = now;
    active.completedAt = now;
    active.latencyMs = Math.max(0, Date.now() - Date.parse(active.startedAt || active.createdAt));
    appendCommandProgress(active, active.stage, active.reason);
  });
}

export function writeCommandLog(event: any, meta: any, patch: any = {}) {  updateDb((draft) => {
    if (!draft.commandLogs) draft.commandLogs = [];
    const now = nowIso();
    const status = FINAL_COMMAND_STATUSES.has(String(patch.status))
      ? String(patch.status)
      : commandStatusFromOutcome(patch.outcome);
    const reason = String(patch.reason ?? patch.detail ?? '').slice(0, 1200);
    const active = activeCommandLog(draft.commandLogs, event.messageId);
    if (active) {
      Object.assign(active, patch, {
        status,
        stage: patch.stage || 'completed',
        reason,
        updatedAt: now,
        completedAt: now,
        latencyMs: Number.isFinite(patch.latencyMs)
          ? patch.latencyMs
          : Math.max(0, Date.now() - Date.parse(active.startedAt || active.createdAt)),
      });
      appendCommandProgress(active, active.stage || 'completed', reason);
      draft.commandLogs = draft.commandLogs.slice(-1500);
      return;
    }
    const duplicate = [...draft.commandLogs].reverse()
      .find((log) => String(log.messageId) === String(event.messageId) && log.status !== 'active');
    if (duplicate) {
      Object.assign(duplicate, patch, {
        status,
        stage: patch.stage || 'completed',
        reason,
        updatedAt: now,
        completedAt: now,
      });
      appendCommandProgress(duplicate, duplicate.stage || 'completed', reason);
      return;
    }
    const startedAt = patch.startedAt || now;
    draft.commandLogs.push({
      id: crypto.randomUUID(), ...meta, ...patch,
      messageId: event.messageId, type: event.type,
      groupId: event.groupId, userId: event.userId, nickname: event.nickname,
      status, stage: patch.stage || 'completed', reason,
      startedAt, updatedAt: now, completedAt: now, createdAt: now,
      latencyMs: Number.isFinite(patch.latencyMs)
        ? patch.latencyMs
        : Math.max(0, Date.now() - Date.parse(startedAt)),
      progress: [{ stage: patch.stage || 'completed', at: now, ...(reason ? { detail: reason } : {}) }],
    });
    draft.commandLogs = draft.commandLogs.slice(-1500);
  });
}

/** A command cannot survive a process restart. Mark old live rows as interrupted. */
export function recoverInterruptedCommandLogs() {
  updateDb((draft) => {
    const now = nowIso();
    for (const log of draft.commandLogs || []) {
      if (log.status !== 'active') continue;
      log.status = 'timeout';
      log.stage = 'interrupted';
      log.reason = log.reason || '进程重启，指令未完成';
      log.updatedAt = now;
      log.completedAt = now;
      log.latencyMs = Math.max(0, Date.now() - Date.parse(log.startedAt || log.createdAt));
      log.progress = [...(log.progress || []), {
        stage: 'interrupted',
        at: now,
        detail: '进程重启，指令未完成',
      }].slice(-30);
    }
  });
}
