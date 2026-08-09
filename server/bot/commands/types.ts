// Command capability catalog — shared pure types (v4 single-source plan).
//
// These types describe the *capability directory* of Wuxin's command system:
// routing keys, permissions, visibility, discoverability, lifecycle and
// execution are one coherent model. The metadata modules in this directory
// must stay side-effect free (no db/fs/net/runtime imports) so that kb-build
// can import them offline.

export type CommandNamespace = 'quick' | 'wuxin' | 'wuxin_osu';

/** Who is allowed to *execute* the command. */
export type CommandPermission = 'all' | 'group_admin' | 'owner';

/** Who is allowed to *retrieve knowledge* about the command. */
export type CommandVisibility = 'public' | 'group_admin' | 'owner' | 'hidden';

/**
 * Whether the command is actively listed in help / capability summaries.
 * `direct_only` means users may ask about it directly, but it is not listed
 * in ordinary help or summaries unless the caller outranks it.
 */
export type CommandDiscoverability = 'listed' | 'direct_only' | 'hidden';

export type CommandStatus = 'active' | 'deprecated' | 'disabled';

export type CommandExecution =
  | { kind: 'local'; handlerKey: string }
  | { kind: 'proxy'; capability: string; targetBot: string }
  | { kind: 'documentation_only'; reason: string };

export interface CommandArgument {
  name: string;
  required: boolean;
  type: 'string' | 'integer' | 'range' | 'enum';
  values?: string[];
  description: string;
}

export type CooldownScope = 'user' | 'group' | 'user_in_group' | 'global';

export type CooldownPolicy =
  | { kind: 'none' }
  | { kind: 'fixed'; ms: number; scope: CooldownScope; resettableBy: CommandPermission }
  | { kind: 'dynamic'; publicDescription: string };

export interface CommandAddress {
  namespace: CommandNamespace;
  path: readonly string[];
}

export interface CommandDescriptor {
  /** Stable descriptor key (leaf id inside the namespace). */
  id: string;
  namespace: CommandNamespace;
  path: readonly string[];
  aliases?: readonly string[];
  syntax: string;
  description: string;
  permission: CommandPermission;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  status: CommandStatus;
  execution: CommandExecution;
  arguments?: CommandArgument[];
  cooldown?: CooldownPolicy;
  deprecation?: {
    replacement?: string;
    deprecatedSince?: string;
    message: string;
  };
  /** Runtime-configurable db permission key (ownerCommands uses these). */
  permissionKey?: string;
  availability?: {
    contexts?: Array<'group' | 'private'>;
    requiresBinding?: boolean;
    supportedModes?: string[];
  };
  family?: string;
}

/** Normalized help view produced by getAllCommandHelpEntries(). */
export interface CommandHelpEntry {
  id: string;
  family: string;
  group?: string;
  namespace: CommandNamespace;
  source?: string;
  canonicalSyntax: string;
  aliases: string[];
  description: string;
  permission: CommandPermission;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  status: CommandStatus;
  execution: CommandExecution;
  cooldown?: CooldownPolicy;
  deprecation?: CommandDescriptor['deprecation'];
  permissionKey?: string;
  availability?: CommandDescriptor['availability'];
  implementationRefs?: { path: string; symbol: string }[];
  tags?: string[];
}

/** Human-authored prose that is separate from auto-rendered facts. */
export interface CommandKnowledgeTemplate {
  commandId: string;
  boundaryNotes?: string[];
  examplesOfUse?: string[];
  warnings?: string[];
}

export type KnowledgeDocumentKind = 'command' | 'capability_summary' | 'boundary';

export interface CommandPermissions {
  isOwner: boolean;
  isAdmin: boolean;
}

export function permissionIsAtLeast(permission: CommandPermission, permissions: CommandPermissions): boolean {
  if (permission === 'all') return true;
  if (permission === 'group_admin') return permissions.isAdmin || permissions.isOwner;
  return permissions.isOwner;
}

/** Knowledge-visibility gate. `hidden` never passes. */
export function canViewCommand(
  visibility: CommandVisibility,
  permissions: CommandPermissions,
): boolean {
  if (visibility === 'public') return true;
  if (visibility === 'group_admin') return permissions.isAdmin || permissions.isOwner;
  if (visibility === 'owner') return permissions.isOwner;
  return false;
}

/**
 * Help / capability-summary listing gate. `direct_only` commands are only
 * listed for callers who already pass their permission (owner in practice);
 * `hidden` is never listed.
 */
export function canListCommand(
  visibility: CommandVisibility,
  discoverability: CommandDiscoverability,
  permission: CommandPermission,
  permissions: CommandPermissions,
): boolean {
  if (discoverability === 'hidden') return false;
  if (!canViewCommand(visibility, permissions)) return false;
  if (discoverability === 'listed') return true;
  // direct_only: only list when the caller already has execution rights.
  return permissionIsAtLeast(permission, permissions);
}

/** Pick the highest summary audience visible to a caller. */
export function resolveSummaryAudience(permissions: CommandPermissions): 'public' | 'group_admin' | 'owner' {
  if (permissions.isOwner) return 'owner';
  if (permissions.isAdmin) return 'group_admin';
  return 'public';
}

export function summaryAudienceLabel(audience: 'public' | 'group_admin' | 'owner'): string {
  return audience === 'owner' ? '所有者' : audience === 'group_admin' ? '管理员' : '普通用户';
}

export function permissionSentence(permission: CommandPermission): string {
  if (permission === 'all') return '所有成员可用';
  if (permission === 'group_admin') return '仅群管理员或 owner 可用';
  return '仅 owner 可用';
}

export function cooldownSentence(cooldown: CooldownPolicy | undefined): string {
  if (!cooldown || cooldown.kind === 'none') return '';
  if (cooldown.kind === 'dynamic') return `冷却：${cooldown.publicDescription}`;
  const ms = cooldown.ms;
  const text = ms >= 3600_000
    ? `${Math.round(ms / 3600_000)} 小时`
    : ms >= 60_000
      ? `${Math.round(ms / 60_000)} 分钟`
      : `${Math.round(ms / 1000)} 秒`;
  const scopeText = cooldown.scope === 'global' ? '全局'
    : cooldown.scope === 'group' ? '每群'
    : cooldown.scope === 'user_in_group' ? '每人每群'
    : '每人';
  return `冷却：${scopeText} ${text}`;
}
