// Wuxin (/w) command metadata — pure (v4 single-source plan).
//
// Transcribed from ownerCommands.ts `helpDefs` + `defaultCommandPermissions`
// (server/store.ts). permissionKey is the runtime-configurable db key;
// permission/visibility are the normalized defaults used by KB/help.
import type {
  CommandDiscoverability,
  CommandExecution,
  CommandPermission,
  CommandStatus,
  CommandVisibility,
} from './types.js';

export interface OwnerCommandMeta {
  id: string;
  commandPath: string;
  group: string;
  syntax: string;
  description: string;
  permissionKey: string;
  permission: CommandPermission;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  status: CommandStatus;
  execution: CommandExecution;
  tags?: string[];
  implementationRefs?: { path: string; symbol: string }[];
}

function permFromKey(key: string): CommandPermission {
  // Mirrors server/store.ts defaultCommandPermissions (single static source).
  const ownerKeys = new Set(['promptSavebase', 'note', 'groupAdd', 'memberPolicy', 'exp']);
  if (ownerKeys.has(key)) return 'owner';
  if (['help', 'my', 'ping', 'why', 'lv', 'top', 'me', 'nick', 'style', 'summarize', 'recalc', 'osuBind', 'osuAnalyze', 'osuRecent', 'osuHelp'].includes(key)) return 'all';
  return 'group_admin';
}

function visibilityFor(key: string): CommandVisibility {
  return permFromKey(key) === 'owner' ? 'owner' : 'public';
}

function discoverabilityFor(key: string): CommandDiscoverability {
  return permFromKey(key) === 'owner' ? 'direct_only' : 'listed';
}

export const OWNER_COMMANDS: OwnerCommandMeta[] = [
  { id: 'lv', commandPath: '/lv', group: '等级', syntax: '/w lv (@某人)', description: '查看等级经验', permissionKey: 'lv', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'lv' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'exp', commandPath: '/exp', group: '等级', syntax: '/w exp @某人 add/set/reset', description: '管理群友经验（仅 owner）', permissionKey: 'exp', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'exp' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'top', commandPath: '/top', group: '等级', syntax: '/w top', description: '查看群内等级排行榜', permissionKey: 'top', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'top' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'nick', commandPath: '/nick', group: '等级', syntax: '/w nick 称呼 / nick @某人 称呼', description: '自定义 pippi 对你的称呼', permissionKey: 'nick', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'nick' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'style', commandPath: '/style', group: '等级', syntax: '/w style 内容 / style @某人 内容', description: '设置个人交互风格', permissionKey: 'style', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'style' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'me', commandPath: '/me', group: '等级', syntax: '/w me', description: '查看 pippi 对你的画像', permissionKey: 'me', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'me' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'memberPolicy', commandPath: '/op', group: '成员管理', syntax: '/w op/deop/ban/unban/trust/focus/quiet/normal @某人', description: '成员权限策略：管理员、黑名单、优先回应、重点关注、少回应', permissionKey: 'memberPolicy', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'memberPolicy' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'note', commandPath: '/note', group: '备注与画像', syntax: '/w note @某人 内容/show/clear', description: '成员备注管理', permissionKey: 'note', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'note' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'profile', commandPath: '/profile', group: '备注与画像', syntax: '/w profile (@某人) show/samples/retry/rule/clear', description: '画像管理：更新、查看、依据、重算、约束、清除', permissionKey: 'profile', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'profile' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'promptShow', commandPath: '/prompt', group: '人设', syntax: '/w prompt show', description: '查看人设摘要', permissionKey: 'promptShow', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'promptShow' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'promptEdit', commandPath: '/prompt', group: '人设', syntax: '/w prompt add/set/reset', description: '编辑人设：追加、覆盖、重置基线', permissionKey: 'promptEdit', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'promptEdit' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'promptSavebase', commandPath: '/prompt', group: '人设', syntax: '/w prompt savebase', description: '把当前人设保存为基线（仅 owner）', permissionKey: 'promptSavebase', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'promptSavebase' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'groupAdd', commandPath: '/group', group: '群聊设置', syntax: '/w group add [群名]', description: '把当前群加入 bot 管理（仅 owner）', permissionKey: 'groupAdd', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'groupAdd' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'groupProfileShow', commandPath: '/group', group: '群聊设置', syntax: '/w group profile show', description: '查看群画像', permissionKey: 'groupProfileShow', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'groupProfileShow' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'groupProfileEdit', commandPath: '/group', group: '群聊设置', syntax: '/w group profile update/clear/on/off', description: '群画像管理：更新、清除、开关', permissionKey: 'groupProfileEdit', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'groupProfileEdit' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'rate', commandPath: '/rate', group: '群聊设置', syntax: '/w rate 数字', description: '设置每小时回复上限', permissionKey: 'rate', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'rate' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'cooldown', commandPath: '/cooldown', group: '群聊设置', syntax: '/w cooldown 秒数', description: '设置发言冷却', permissionKey: 'cooldown', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'cooldown' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'mode', commandPath: '/mode', group: '群聊设置', syntax: '/w mode silent|mention|light|natural', description: '设置群回复模式', permissionKey: 'mode', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'mode' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'status', commandPath: '/status', group: '群聊设置', syntax: '/w status', description: '查看群参数', permissionKey: 'status', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'status' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'modelShow', commandPath: '/model', group: '模型与搜索', syntax: '/w model show/list', description: '查看模型列表与当前模型', permissionKey: 'modelShow', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'modelShow' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'modelSet', commandPath: '/model', group: '模型与搜索', syntax: '/w model 模型名', description: '切换当前模型', permissionKey: 'modelSet', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'modelSet' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'search', commandPath: '/search', group: '模型与搜索', syntax: '/w search on/off/status/fast/balanced/deep', description: '搜索开关、状态与模式', permissionKey: 'search', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'search' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'thinking', commandPath: '/thinking', group: '模型与搜索', syntax: '/w thinking off|simple|detail|slow [ms]|status', description: '思考提示模式', permissionKey: 'thinking', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'thinking' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'sysfacts', commandPath: '/sysfacts', group: '模型与搜索', syntax: '/w sysfacts on/off', description: '纯人设模式（关闭系统事实注入）', permissionKey: 'search', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'sysfacts' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'summarize', commandPath: '/summarize', group: '模型与搜索', syntax: '/w summarize 条数', description: '总结群聊', permissionKey: 'summarize', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'summarize' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'preset', commandPath: '/preset', group: '系统', syntax: '/w preset class|away|sleep|active|silent|debug', description: '场景预设', permissionKey: 'preset', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'preset' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'usage', commandPath: '/usage', group: '系统', syntax: '/w usage', description: '今日用量', permissionKey: 'usage', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'usage' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'pause', commandPath: '/pause', group: '系统', syntax: '/w pause / resume', description: '暂停 / 恢复回复', permissionKey: 'pause', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'pause' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'resume', commandPath: '/resume', group: '系统', syntax: '/w resume', description: '恢复回复', permissionKey: 'pause', permission: 'group_admin', visibility: 'public', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'resume' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'why', commandPath: '/why', group: '系统', syntax: '/w why', description: '解释最近为什么回复或没回复', permissionKey: 'why', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'why' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'help', commandPath: '/help', group: '系统', syntax: '/w help 或 /w help 分组名', description: '查看指令帮助', permissionKey: 'help', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'help' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'ping', commandPath: '/ping', group: '系统', syntax: '/w ping', description: '检查 pippi 是否在线', permissionKey: 'ping', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'ping' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'my', commandPath: '/my', group: '系统', syntax: '/w my', description: '查看自己的权限与可用指令', permissionKey: 'my', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'my' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'recalc', commandPath: '/recalc', group: '系统', syntax: '/w recalc', description: '查看全局重算进度', permissionKey: 'recalc', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'recalc' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'refresh', commandPath: '/refresh', group: '系统', syntax: '/w refresh', description: '触发全局重算（仅 owner）', permissionKey: 'memberPolicy', permission: 'owner', visibility: 'owner', discoverability: 'direct_only', status: 'active', execution: { kind: 'local', handlerKey: 'refresh' }, implementationRefs: [{ path: 'server/bot/ownerCommands.ts', symbol: 'runOwnerCommand' }] },
  { id: 'osuHelp', commandPath: '/osu', group: 'osu!', syntax: '/w osu help', description: 'osu! 命令帮助', permissionKey: 'osuHelp', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'osu.help' }, implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }] },
  { id: 'osuBind', commandPath: '/osu', group: 'osu!', syntax: '/w osu bind <osu用户名>', description: '绑定 osu! 账号', permissionKey: 'osuBind', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'osu.bind' }, implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }] },
  { id: 'osuAnalyze', commandPath: '/osu', group: 'osu!', syntax: '/w osu analyze (@某人)', description: '完整玩家分析', permissionKey: 'osuAnalyze', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'osu.analyze' }, implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }] },
  { id: 'osuRecent', commandPath: '/osu', group: 'osu!', syntax: '/w osu recent (@某人)', description: '近期成绩短评', permissionKey: 'osuRecent', permission: 'all', visibility: 'public', discoverability: 'listed', status: 'active', execution: { kind: 'local', handlerKey: 'osu.recent' }, implementationRefs: [{ path: 'server/osu/commands.ts', symbol: 'handleOsuCommand' }] },
];

export const OWNER_COMMANDS_BY_ID: Record<string, OwnerCommandMeta> = Object.fromEntries(
  OWNER_COMMANDS.map((entry) => [entry.id, entry]),
);

export { permFromKey, visibilityFor, discoverabilityFor };

/** Member-policy paths handled by ownerCommands policyMap (pure mirror). */
const MEMBER_POLICY_PATHS = new Set([
  '/op', '/deop', '/ban', '/unban', '/trust', '/focus', '/quiet', '/normal',
  '/拉黑', '/取消拉黑', '/白名单', '/重点关注', '/少回应', '/正常', '/设管理员', '/取消管理员',
]);

/**
 * Pure resolver for `/w ...` texts (owner commands). Used by kb-verify;
 * never calls handlers.
 */
export function parseOwnerCommandText(text: string): { id: string; args: string } | null {
  const raw = String(text || '').trim();
  const match = /^\/w(?:uxin)?\s+([a-zA-Z][\w-]*)(?:\s+(.*))?$/.exec(raw);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const args = String(match[2] || '').trim();
  if (MEMBER_POLICY_PATHS.has(`/${command}`)) return { id: 'memberPolicy', args };
  const matches = OWNER_COMMANDS.filter((entry) => entry.commandPath === `/${command}`);
  if (matches.length === 0) return null;
  if (matches.length === 1) return { id: matches[0].id, args };
  // Shared command paths (group/prompt/model): resolve by explicit
  // sub-command tokens so fixtures hit the intended descriptor id.
  const tokens = raw.trim().split(/\s+/).map((part) => part.toLowerCase()).filter(Boolean);
  const sub1 = tokens[2] || '';
  const sub2 = tokens[3] || '';
  if (command === 'prompt') {
    if (sub1 === 'show') {
      const entry = matches.find((item) => item.id === 'promptShow');
      return entry ? { id: entry.id, args } : { id: matches[0].id, args };
    }
    if (sub1 === 'savebase') {
      const entry = matches.find((item) => item.id === 'promptSavebase');
      return entry ? { id: entry.id, args } : { id: matches[0].id, args };
    }
    const entry = matches.find((item) => item.id === 'promptEdit');
    return entry ? { id: entry.id, args } : { id: matches[0].id, args };
  }
  if (command === 'group') {
    if (sub1 === 'add') {
      const entry = matches.find((item) => item.id === 'groupAdd');
      return entry ? { id: entry.id, args } : { id: matches[0].id, args };
    }
    if (sub1 === 'profile') {
      if (sub2 === 'show') {
        const entry = matches.find((item) => item.id === 'groupProfileShow');
        return entry ? { id: entry.id, args } : { id: matches[0].id, args };
      }
      const entry = matches.find((item) => item.id === 'groupProfileEdit');
      return entry ? { id: entry.id, args } : { id: matches[0].id, args };
    }
    return { id: matches[0].id, args };
  }
  if (command === 'model') {
    const modelShow = matches.find((entry) => entry.id === 'modelShow');
    const modelSet = matches.find((entry) => entry.id === 'modelSet');
    if (sub1 === 'list' || sub1 === 'show') return modelShow ? { id: modelShow.id, args } : { id: matches[0].id, args };
    if (modelSet) return { id: modelSet.id, args };
  }
  return { id: matches[0].id, args };
}
