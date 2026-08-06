// Command capability catalog — normalized exports (v4 single-source plan).
//
// Pure module: only types/constants/metas/alias utils. This is the single
// entry used by help rendering, KB build, KB retrieval fixtures and kb-verify.
import {
  QUICK_DEFS,
  canonicalQuickSyntax,
  type QuickCommandDef,
} from './quick.meta.js';
import {
  OSU_SUBCOMMANDS,
  OSU_CLEAR_ACTIONS_META,
} from './osu.meta.js';
import { OWNER_COMMANDS } from './owner.meta.js';
import {
  type CommandAddress,
  type CommandHelpEntry,
  type CommandPermissions,
  type CommandVisibility,
  type KnowledgeDocumentKind,
  canViewCommand,
  canListCommand,
  cooldownSentence,
  permissionSentence,
  resolveSummaryAudience,
  type CommandPermission,
} from './types.js';
import { normalizeAlias } from './alias.js';

export { canViewCommand, canListCommand, resolveSummaryAudience, permissionSentence, cooldownSentence };
export type { CommandAddress, CommandHelpEntry, CommandPermissions, CommandVisibility, CommandPermission, KnowledgeDocumentKind };

export function commandDocumentId(address: CommandAddress): string {
  const tokens = address.path.map((token) => normalizeAlias(String(token))).filter(Boolean);
  return `cmd:${address.namespace}:${tokens.join('.')}`;
}

export function summaryDocumentId(family: string, audience: 'public' | 'group_admin' | 'owner'): string {
  return `summary:${family}:${audience}`;
}

function quickEntry(def: QuickCommandDef): CommandHelpEntry | null {
  if (def.status !== 'active' || def.visibility !== 'public' || !def.description) return null;
  const domain = def.source === 'lazybot' ? '/' : def.source === 'hydrant' ? 'none' : '!';
  return {
    id: def.id,
    family: 'quick',
    namespace: 'quick',
    source: def.source,
    canonicalSyntax: canonicalQuickSyntax(def),
    aliases: [...def.aliases],
    description: def.description,
    permission: def.permission,
    visibility: def.visibility,
    discoverability: def.discoverability,
    status: def.status,
    execution: def.execution,
    ...(def.cooldown ? { cooldown: def.cooldown } : {}),
    implementationRefs: [
      { path: 'server/bot/quickRouter.ts', symbol: 'matchQuickCommand' },
      { path: 'server/bot/quickRouter.ts', symbol: 'handleQuickCommand' },
    ],
    availability: { contexts: ['group'], requiresBinding: def.capability !== undefined || def.handler !== undefined || def.bridge === true },
    ...(domain === 'none'
      ? {}
      : { permissionKey: 'quick' }),
  };
}

function wuxinEntry(meta: (typeof OWNER_COMMANDS)[number]): CommandHelpEntry {
  const profileFamily = ['profile', 'note', 'me', 'nick', 'style'].includes(meta.id) ? 'profile' : 'administration';
  return {
    id: meta.id,
    family: ['osuHelp', 'osuBind', 'osuAnalyze', 'osuRecent'].includes(meta.id) ? 'osu' : profileFamily,
    group: meta.group,
    namespace: 'wuxin',
    canonicalSyntax: meta.syntax,
    aliases: [],
    description: meta.description,
    permission: meta.permission,
    visibility: meta.visibility,
    discoverability: meta.discoverability,
    status: meta.status,
    execution: meta.execution,
    ...(meta.tags ? { tags: meta.tags } : {}),
    permissionKey: meta.permissionKey,
    implementationRefs: meta.implementationRefs,
  };
}

function osuEntry(subId: string, args?: string): CommandHelpEntry | null {
  if (subId === 'clear') {
    const actionId = String(args || '');
    const meta = OSU_CLEAR_ACTIONS_META[actionId];
    if (!meta) return null;
    return {
      id: `clear.${actionId}`,
      family: 'osu',
      namespace: 'wuxin_osu',
      canonicalSyntax: meta.syntax,
      aliases: [],
      description: meta.description,
      permission: meta.permission,
      visibility: meta.visibility,
      discoverability: meta.discoverability,
      status: meta.status,
      execution: meta.execution,
      ...(meta.tags ? { tags: meta.tags } : {}),
      implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }],
      availability: { contexts: ['group', 'private'], requiresBinding: actionId !== 'cache' },
    };
  }
  const meta = OSU_SUBCOMMANDS[subId];
  if (!meta) return null;
  return {
    id: subId,
    family: 'osu',
    namespace: 'wuxin_osu',
    canonicalSyntax: meta.syntax,
    aliases: [],
    description: meta.description,
    permission: meta.permission,
    visibility: meta.visibility,
    discoverability: meta.discoverability,
    status: meta.status,
    execution: meta.execution,
    ...(meta.tags ? { tags: meta.tags } : {}),
    ...(meta.cooldown ? { cooldown: meta.cooldown } : {}),
    implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }],
    availability: meta.availability,
  };
}

/** Every command in the catalog, normalized to one stable schema. */
export function getAllCommandHelpEntries(): CommandHelpEntry[] {
  const entries: CommandHelpEntry[] = [];
  for (const def of QUICK_DEFS) {
    const entry = quickEntry(def);
    if (entry) entries.push(entry);
  }
  for (const meta of OWNER_COMMANDS) entries.push(wuxinEntry(meta));
  for (const subId of Object.keys(OSU_SUBCOMMANDS)) {
    if (subId === 'clear') {
      for (const actionId of Object.keys(OSU_CLEAR_ACTIONS_META)) {
        const entry = osuEntry('clear', actionId);
        if (entry) entries.push(entry);
      }
    } else {
      const entry = osuEntry(subId);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** Stable address for a catalog entry (used for KB document ids). */
export function entryAddress(entry: CommandHelpEntry): CommandAddress {
  if (entry.namespace === 'quick') {
    const domain = entry.canonicalSyntax.startsWith('/')
      ? '/'
      : entry.canonicalSyntax === '~' || entry.canonicalSyntax.startsWith('查')
        ? 'none'
        : entry.canonicalSyntax.startsWith('+') || entry.canonicalSyntax.startsWith('荐图') || entry.canonicalSyntax.startsWith('where')
          ? 'none'
          : '!';
    const alias = normalizeAlias(entry.aliases[0] || entry.id);
    const collisionKey = `${domain}:${alias}`;
    return { namespace: 'quick', path: QUICK_ALIAS_COLLISIONS.has(collisionKey) ? [domain, alias, entry.source || ''] : [domain, alias] };
  }
  if (entry.namespace === 'wuxin_osu') {
    return { namespace: 'wuxin_osu', path: entry.id.split('.') };
  }
  return { namespace: 'wuxin', path: [entry.id] };
}

const QUICK_ALIAS_COLLISIONS = new Set<string>();
{
  const counts = new Map<string, number>();
  for (const entry of getAllCommandHelpEntries()) {
    if (entry.namespace !== 'quick') continue;
    const domain = entry.canonicalSyntax.startsWith('/')
      ? '/'
      : entry.canonicalSyntax === '~' || entry.canonicalSyntax.startsWith('查') || entry.canonicalSyntax.startsWith('+') || entry.canonicalSyntax.startsWith('荐图') || entry.canonicalSyntax.startsWith('where')
        ? 'none'
        : '!';
    const key = `${domain}:${normalizeAlias(entry.aliases[0] || entry.id)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) if (count > 1) QUICK_ALIAS_COLLISIONS.add(key);
}

/** Auto-render a leaf command knowledge document (fixed template). */
export function commandKnowledgeText(entry: CommandHelpEntry): string {
  const lines: string[] = [
    `【命令】${entry.canonicalSyntax}`,
    `【用途】${entry.description}`,
    `【权限】${permissionSentence(entry.permission)}`,
  ];
  const cooldown = cooldownSentence(entry.cooldown);
  if (cooldown) lines.push(`【冷却】${cooldown}`);
  if (entry.availability?.requiresBinding) {
    lines.push('【使用限制】查询目标需要已绑定 osu! 账号，或在指令后直接给出 osu! 用户名。');
  }
  if (entry.status === 'deprecated') {
    lines.push(`【废弃】${entry.deprecation?.message || '该指令已废弃。'}${entry.deprecation?.replacement ? ` 请改用 ${entry.deprecation.replacement}。` : ''}`);
  }
  return lines.join('\n');
}

const AUDIENCE_PERMS: Record<'public' | 'group_admin' | 'owner', CommandPermissions> = {
  public: { isOwner: false, isAdmin: false },
  group_admin: { isOwner: false, isAdmin: true },
  owner: { isOwner: true, isAdmin: true },
};

const SUMMARY_AUDIENCES: Array<'public' | 'group_admin' | 'owner'> = ['public', 'group_admin', 'owner'];

const SUMMARY_FAMILIES = ['all', 'osu', 'quick', 'profile', 'administration'] as const;
const FAMILY_TITLES: Record<string, string> = {
  all: '能力总览',
  osu: 'osu! 功能',
  quick: '快捷指令',
  profile: '画像与备注',
  administration: '群聊与系统管理',
};

/**
 * Build per-audience capability summaries (cumulative visibility). Each
 * audience gets its own docs; retrieval must pick exactly one audience via
 * resolveSummaryAudience so duplicate summaries never compete in BM25.
 */
export function buildCapabilitySummaryDocs(): Array<{
  id: string;
  title: string;
  tags: string[];
  content: string;
  visibility: CommandVisibility;
  documentKind: KnowledgeDocumentKind;
}> {
  const docs: ReturnType<typeof buildCapabilitySummaryDocs> = [];
  const entries = getAllCommandHelpEntries();
  for (const audience of SUMMARY_AUDIENCES) {
    const perms = AUDIENCE_PERMS[audience];
    for (const family of SUMMARY_FAMILIES) {
      const seenSyntax = new Set<string>();
      const listed = entries.filter((entry) => {
        if (entry.namespace === 'wuxin' && entry.family === 'osu') return false;
        if (family !== 'all' && entry.family !== family) return false;
        if (entry.status !== 'active') return false;
        if (!canViewCommand(entry.visibility, perms)) return false;
        if (!canListCommand(entry.visibility, entry.discoverability, entry.permission, perms)) return false;
        // `/w osu` appears in both the wuxin help catalog and the canonical
        // wuxin_osu subcommand catalog; keep only one line per syntax so
        // summaries never repeat the same command twice.
        if (seenSyntax.has(entry.canonicalSyntax)) return false;
        seenSyntax.add(entry.canonicalSyntax);
        return true;
      });
      if (listed.length === 0) continue;
      const lines = listed.map((entry) => `${entry.canonicalSyntax} — ${entry.description}`);
      docs.push({
        id: summaryDocumentId(family, audience),
        title: `${FAMILY_TITLES[family]}（${audience === 'owner' ? '所有者' : audience === 'group_admin' ? '管理员' : '普通用户'}视角）`,
        tags: [family, '能力', '总览', '功能', '指令', '你能', '做什么', '干什么', '会什么', '有什么'],
        content: `你能做什么？有什么功能？以下是 pippi 的${FAMILY_TITLES[family]}：\n` + lines.join('\n'),
        visibility: audience === 'public' ? 'public' : audience === 'group_admin' ? 'group_admin' : 'owner',
        documentKind: 'capability_summary',
      });
    }
  }
  return docs;
}
