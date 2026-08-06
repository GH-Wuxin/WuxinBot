// /w osu command metadata — pure (v4 single-source plan).
//
// OSU_SUBCOMMANDS and OSU_CLEAR_ACTIONS_META are the only source for the
// `/w osu` keyed handler map, `/w osu help` rendering and KB documents.
import type {
  CommandDiscoverability,
  CommandExecution,
  CommandPermission,
  CommandStatus,
  CommandVisibility,
  CooldownPolicy,
} from './types.js';
import { ANALYSIS_COOLDOWN, RECENT_COOLDOWN } from './commandConstants.js';

export interface OsuSubcommandMeta {
  id: string;
  syntax: string;
  description: string;
  permission: CommandPermission;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  status: CommandStatus;
  execution: CommandExecution;
  cooldown?: CooldownPolicy;
  tags?: string[];
  availability?: {
    contexts?: Array<'group' | 'private'>;
    requiresBinding?: boolean;
    supportedModes?: string[];
  };
}

export const OSU_SUBCOMMANDS = {
  bind: {
    id: 'bind',
    syntax: '/w osu bind <osu用户名>',
    description: '把当前 QQ 绑定到 osu! 账号，之后查成绩、分析、推图默认使用该账号',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'bind' },
    tags: ['bind', '绑定', 'osu绑定'],
    availability: { contexts: ['group', 'private'], requiresBinding: false },
  },
  analyze: {
    id: 'analyze',
    syntax: '/w osu analyze [用户名] [--mode=std/taiko/catch/mania]',
    description: '完整玩家分析：BP、PP+、技能与结论',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'analyze' },
    cooldown: ANALYSIS_COOLDOWN,
    tags: ['analyze', '分析', '玩家分析'],
    availability: { contexts: ['group', 'private'], requiresBinding: false, supportedModes: ['std', 'taiko', 'catch', 'mania'] },
  },
  recent: {
    id: 'recent',
    syntax: '/w osu recent [用户名] [--mode=std/taiko/catch/mania]',
    description: '对比近期成绩与完整档案给出短评',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'recent' },
    cooldown: RECENT_COOLDOWN,
    tags: ['recent', '近期', '短评', '近期成绩'],
    availability: { contexts: ['group', 'private'], requiresBinding: false, supportedModes: ['std', 'taiko', 'catch', 'mania'] },
  },
  clear: {
    id: 'clear',
    syntax: '/w osu clear <bind|history|cooldown|recommend|cache>',
    description: '清除绑定、分析历史、冷却、推图历史或全局缓存',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear' },
  },
  help: {
    id: 'help',
    syntax: '/w osu help',
    description: '查看 osu! 命令帮助',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'help' },
    tags: ['help', '帮助', 'osu帮助'],
  },
} as const satisfies Record<string, OsuSubcommandMeta>;

export type OsuCommandId = keyof typeof OSU_SUBCOMMANDS;

export interface OsuClearActionMeta {
  id: string;
  syntax: string;
  description: string;
  permission: CommandPermission;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  status: CommandStatus;
  execution: CommandExecution;
  tags?: string[];
}

export const OSU_CLEAR_ACTIONS_META = {
  bind: {
    id: 'clear.bind',
    syntax: '/w osu clear bind',
    description: '删除当前 QQ 的 osu! 绑定',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear.bind' },
    tags: ['解绑', '清除绑定'],
  },
  history: {
    id: 'clear.history',
    syntax: '/w osu clear history',
    description: '删除当前 QQ 的所有分析历史',
    permission: 'all',
    visibility: 'public',
    discoverability: 'listed',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear.history' },
    tags: ['清除历史', '分析历史'],
  },
  cooldown: {
    id: 'clear.cooldown',
    syntax: '/w osu clear cooldown <osu用户名或ID>',
    description: '清除指定玩家的完整分析/近期/推图冷却',
    permission: 'owner',
    visibility: 'owner',
    discoverability: 'direct_only',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear.cooldown' },
    tags: ['清除冷却', '冷却'],
  },
  recommend: {
    id: 'clear.recommend',
    syntax: '/w osu clear recommend <osu用户名或ID>',
    description: '清除指定玩家的推图历史与冷却（防重复记录一并清除）',
    permission: 'owner',
    visibility: 'owner',
    discoverability: 'direct_only',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear.recommend' },
    tags: ['清除推图', '推图历史', '防重复'],
  },
  cache: {
    id: 'clear.cache',
    syntax: '/w osu clear cache',
    description: '清除全局所有用户的完整分析、近期分析和类型分析缓存',
    permission: 'owner',
    visibility: 'public',
    discoverability: 'direct_only',
    status: 'active',
    execution: { kind: 'local', handlerKey: 'clear.cache' },
    tags: ['清除缓存', '缓存'],
  },
} as const satisfies Record<string, OsuClearActionMeta>;

export type OsuClearActionId = keyof typeof OSU_CLEAR_ACTIONS_META;

/**
 * Pure resolver for `/w osu ...` texts. Used by kb-verify and commandExample
 * fixtures; never calls handlers.
 */
export function parseOsuCommandText(text: string): { commandId: string; actionId?: string; args: string } | null {
  const match = /^\/w(?:uxin)?\s+osu\s+([a-z]+)(?:\s+([a-z]+)(?:\s+(.*))?)?$/i.exec(String(text || '').trim());
  if (!match) return null;
  const commandId = match[1].toLowerCase();
  if (commandId === 'clear') {
    const action = String(match[2] || '').toLowerCase();
    const args = String(match[3] || '').trim();
    if (!action || !(action in OSU_CLEAR_ACTIONS_META)) return null;
    return { commandId, actionId: action, args };
  }
  if (!(commandId in OSU_SUBCOMMANDS)) return null;
  return { commandId, args: String(match[2] || '').trim() };
}
