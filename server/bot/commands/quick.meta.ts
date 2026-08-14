// Quick-command registry — pure metadata (v4 single-source plan).
//
// This module is the ONLY home of the quick registry. quickRouter imports
// it; kb-build imports it; nothing here may touch db/fs/net/runtime.

import type {
  CommandDiscoverability,
  CommandExecution,
  CommandPermission,
  CommandStatus,
  CommandVisibility,
  CooldownPolicy,
} from './types.js';
import { normalizeAlias, type QuickParseDomain } from './alias.js';
import { RECOMMEND_COOLDOWN } from './commandConstants.js';

export type QuickSource = 'common' | 'yumu' | 'kanon' | 'hydrant' | 'lazybot';

export interface RawQuickCommandDef {
  id: string;
  source: QuickSource;
  aliases: string[];
  kind: 'osu' | 'system' | 'fun' | 'admin';
  /** Internal engine capability, when the command maps to one. */
  capability?: 'recent' | 'info' | 'profile' | 'card' | 'bp' | 'bplist' | 'pplus' | 'skill' | 'recommend' | 'match' | 'score';
  /** Local handler id for non-osu commands. */
  handler?: 'bind' | 'unbind' | 'help' | 'ping' | 'dice' | 'where' | 'self_profile' | 'at_profile' | 'pp_user' | 'pp_self' | 'notice';
  /** For `bp` family: parse a trailing BP rank/range (`1-100`, `#5`). */
  bpArgs?: boolean;
  /** Prefer direct invocation of the original local bot (original rendering). */
  bridge?: boolean;
  /** Inject Wuxin's unified osu! binding when a bridged command has no target. */
  injectBinding?: boolean;
}

export interface QuickCommandDef extends RawQuickCommandDef {
  description: string;
  status: CommandStatus;
  execution: CommandExecution;
  visibility: CommandVisibility;
  discoverability: CommandDiscoverability;
  permission: CommandPermission;
  cooldown?: CooldownPolicy;
}

export const COMMON_DEFS: RawQuickCommandDef[] = [
  { id: 'help', source: 'common', aliases: ['h', 'help', 'helps', '帮助', '文档', '完整帮助'], kind: 'system', handler: 'help' },
  { id: 'ping', source: 'common', aliases: ['ping', 'pi', '探测'], kind: 'system', handler: 'ping' },
  { id: 'bind', source: 'common', aliases: ['bind', 'bi', '绑定'], kind: 'system', handler: 'bind' },
  { id: 'unbind', source: 'common', aliases: ['unbind', 'ub', '解绑', '解除绑定'], kind: 'system', handler: 'unbind' },
  { id: 'setmode', source: 'common', aliases: ['set mode', 'set game mode', 'mode', 'sm', 'mo', '游戏模式'], kind: 'system' },
  { id: 'groupmode', source: 'common', aliases: ['set group mode', 'group mode', 'gm', '群模式', '群聊模式'], kind: 'system' },
  { id: 'check', source: 'common', aliases: ['check', 'ck', '检查'], kind: 'system' },
];

export const YUMU_DEFS: RawQuickCommandDef[] = [
  { id: 'recent', source: 'yumu', aliases: ['p', 'pass', '通过成绩', 'pr', 're', 'recent', 'r', '最近成绩', 'ps', 'passes', 'rs', 'recents', 'pw', 'rw', 'pass show', 'recent show'], kind: 'osu', capability: 'recent', bridge: true },
  { id: 'rbs', source: 'yumu', aliases: ['rbs', 'recents bests', '优秀成绩'], kind: 'osu' },
  { id: 'prcard', source: 'yumu', aliases: ['pc', 'rc', 'passcard', 'recentcard', '通过卡片', '最近卡片'], kind: 'osu' },
  { id: 'score', source: 'yumu', aliases: ['s', 'score', '成绩', 'sw', 'show score', 'ss', 'scores', '多成绩'], kind: 'osu', capability: 'score' },
  { id: 'bp', source: 'yumu', aliases: ['bp', 'b', 'best', 'bestperformance', '最成绩', '最佳成绩', 'bpw', 'best show'], kind: 'osu', capability: 'bp', bpArgs: true, bridge: true },
  { id: 'bs', source: 'yumu', aliases: ['bs', 'bps', 'bests'], kind: 'osu', capability: 'bp', bpArgs: true, bridge: true },
  { id: 'todaybp', source: 'yumu', aliases: ['todaybp', 'tbp', 'tdp', 't', '今日成绩', '今日最佳成绩'], kind: 'osu' },
  { id: 'bpf', source: 'yumu', aliases: ['bpf', 'bf', 'bp fix', 'best fix', '修复成绩', '修复最佳成绩'], kind: 'osu' },
  { id: 'ba', source: 'yumu', aliases: ['ba', 'bpa', 'bp analysis', 'best analysis', '分析成绩', '分析最佳成绩'], kind: 'osu' },
  { id: 'bh', source: 'yumu', aliases: ['bh', 'bph', 'bp history', '历史成绩'], kind: 'osu' },
  { id: 'top', source: 'yumu', aliases: ['top', 'tp', 'top plays'], kind: 'osu' },
  { id: 'pm', source: 'yumu', aliases: ['pm', 'pp-', 'ppminus', '表现分减', 'pv', 'ppminus vs', 'pl', 'ppminus legacy'], kind: 'osu', bridge: true, injectBinding: true },
  { id: 'pplus', source: 'yumu', aliases: ['pp', 'px', 'p+', 'pp+', 'plus', 'pppvs', 'plusvs'], kind: 'osu', capability: 'pplus' },
  { id: 'ppmap', source: 'yumu', aliases: ['pa', 'ppmap'], kind: 'osu' },
  { id: 'skill', source: 'yumu', aliases: ['k', 'skill', 'skills', '技能', '技巧'], kind: 'osu', capability: 'skill' },
  { id: 'kv', source: 'yumu', aliases: ['kv', 'skill vs', 'skills vs', '技能对比'], kind: 'osu' },
  { id: 'etx', source: 'yumu', aliases: ['ex', 'et', 'etx', 'elite', 'eliteronix', '精英分数', 'ev', 'etx vs', 'elite vs'], kind: 'osu', bridge: true, injectBinding: true },
  { id: 'csv', source: 'yumu', aliases: ['csi', 'csv info', 'csvppm', 'cm', 'csvrating', 'cra'], kind: 'osu' },
  { id: 'ppst', source: 'yumu', aliases: ['ppst'], kind: 'osu' },
  { id: 'info', source: 'yumu', aliases: ['i', 'info', 'information', '玩家信息', '个人信息', '玩家', 'ic', 'infocard', '信息卡片', '玩家卡片'], kind: 'osu', capability: 'info' },
  { id: 'mapper', source: 'yumu', aliases: ['im', 'imapper', 'mapper', '谱师', '作者信息'], kind: 'osu' },
  { id: 'friend', source: 'yumu', aliases: ['f', 'friends', '好友', '好友信息'], kind: 'osu' },
  { id: 'badge', source: 'yumu', aliases: ['bd', 'badge', '奖牌', '牌子'], kind: 'osu' },
  { id: 'team', source: 'yumu', aliases: ['tm', 'team', 'clan', '战队', '战队信息'], kind: 'osu' },
  { id: 'getid', source: 'yumu', aliases: ['gi', 'get id', 'gn', 'get name'], kind: 'osu' },
  { id: 'mutual', source: 'yumu', aliases: ['mutual', 'mua', '主页链接', '亲亲'], kind: 'osu' },
  { id: 'qpi', source: 'yumu', aliases: ['qi', 'ri', 'quick play info', 'ranked play info', '排位匹配信息'], kind: 'osu' },
  { id: 'oldavatar', source: 'yumu', aliases: ['oa', 'o', 'old avatar', '旧头像', 'oc', 'oishi', 'avatar card', 'op', 'old profile', 'osu profile'], kind: 'osu' },
  { id: 'audio', source: 'yumu', aliases: ['a', 'audio', 'song', '谱面音频'], kind: 'osu' },
  { id: 'map', source: 'yumu', aliases: ['m', 'map', 'beatmap', 'mz', 'map lazer', 'beatmap lazer', '谱面'], kind: 'osu' },
  { id: 'qualified', source: 'yumu', aliases: ['q', 'qua', 'qualified'], kind: 'osu' },
  { id: 'leader', source: 'yumu', aliases: ['l', 'leader', 'leaderboard', 'list', 'gl', 'group leaderboard', 'group list', 'lg', 'll', 'legacy leaderboard', 'legacy list'], kind: 'osu' },
  { id: 'nom', source: 'yumu', aliases: ['n', 'nom', 'nomination', 'nominations'], kind: 'osu' },
  { id: 'explore', source: 'yumu', aliases: ['e', 'exp', 'explore', 'find', 'search', 'emp', 'explore most played'], kind: 'osu' },
  { id: 'recommend', source: 'yumu', aliases: ['rec', 'recommend', 'recommended', 'j', '推荐', '推荐谱面'], kind: 'osu', capability: 'recommend' },
  { id: 'view', source: 'yumu', aliases: ['v', 'view', 'vv', 'view variation', 'sv view'], kind: 'osu' },
  { id: 'cal', source: 'yumu', aliases: ['cal', 'calculate', 'cl'], kind: 'osu' },
  { id: 'getbg', source: 'yumu', aliases: ['gb', 'bg', 'get bg', 'get background', '获取背景'], kind: 'osu' },
  { id: 'getcover', source: 'yumu', aliases: ['gc', 'get cover', '获取封面'], kind: 'osu' },
  { id: 'match', source: 'yumu', aliases: ['ml', 'li', 'match listen', 'match listener', 'make love', '观战'], kind: 'osu', capability: 'match' },
  { id: 'matchnow', source: 'yumu', aliases: ['mn', 'match now', 'monitor now'], kind: 'osu' },
  { id: 'matchrecent', source: 'yumu', aliases: ['mr', 'match recent', 'match recents'], kind: 'osu' },
  { id: 'matchround', source: 'yumu', aliases: ['ro', 'rounds', 'match rounds'], kind: 'osu' },
  { id: 'rating', source: 'yumu', aliases: ['ra', 'rating', 'mra', 'ym rating', 'sa', 'sra', 'series', 'series rating'], kind: 'osu', bridge: true },
  { id: 'quickplay', source: 'yumu', aliases: ['qp', 'rp', 'quick play', 'ranked play'], kind: 'osu' },
  { id: 'pool', source: 'yumu', aliases: ['po', 'mappool', 'gp', 'getpool', 'get pool'], kind: 'osu' },
  { id: 'dice', source: 'yumu', aliases: ['d', 'dice', 'roll', '骰子'], kind: 'fun', handler: 'dice' },
];

export const KANON_DEFS: RawQuickCommandDef[] = [
  { id: 'recent', source: 'kanon', aliases: ['re', 'recent', 'pr'], kind: 'osu', capability: 'recent', bridge: true },
  { id: 'recentlist', source: 'kanon', aliases: ['res', 'recentlist', 'prs'], kind: 'osu' },
  { id: 'bp', source: 'kanon', aliases: ['bp'], kind: 'osu', capability: 'bp', bpArgs: true, bridge: true },
  { id: 'bplist', source: 'kanon', aliases: ['bplist', 'get bplist'], kind: 'osu', capability: 'bplist', bpArgs: true, bridge: true },
  { id: 'score', source: 'kanon', aliases: ['score'], kind: 'osu', capability: 'score' },
  { id: 'info', source: 'kanon', aliases: ['info'], kind: 'osu', capability: 'info', bridge: true },
  { id: 'todaybp', source: 'kanon', aliases: ['todaybp', 'get todaybp'], kind: 'osu' },
  { id: 'search', source: 'kanon', aliases: ['search'], kind: 'osu' },
  { id: 'update', source: 'kanon', aliases: ['update'], kind: 'osu', bridge: true, injectBinding: true },
  { id: 'getbg', source: 'kanon', aliases: ['get bg'], kind: 'osu' },
  { id: 'getbonuspp', source: 'kanon', aliases: ['get bonuspp', 'get bonus pp'], kind: 'osu' },
  { id: 'badge', source: 'kanon', aliases: ['badge', 'badge list', 'badge info'], kind: 'osu' },
  { id: 'setosumode', source: 'kanon', aliases: ['set osumode', 'set osu mode'], kind: 'system' },
];

export const LAZYBOT_DEFS: RawQuickCommandDef[] = [
  { id: 'pplus', source: 'lazybot', aliases: ['plus', 'ppp'], kind: 'osu', capability: 'pplus', bridge: true },
  { id: 'bp', source: 'lazybot', aliases: ['bp', 'best', 'pbp', 'b', 'bsm'], kind: 'osu', capability: 'bp', bpArgs: true, bridge: true },
  { id: 'bplist', source: 'lazybot', aliases: ['bplist'], kind: 'osu', capability: 'bplist', bpArgs: true, bridge: true },
  { id: 'bpcard', source: 'lazybot', aliases: ['bpcard', 'pbpcard', 'pb', 'pbplist'], kind: 'osu' },
  { id: 'bpif', source: 'lazybot', aliases: ['bpif'], kind: 'osu' },
  { id: 'bps', source: 'lazybot', aliases: ['bps', 'bs', 'bssm'], kind: 'osu' },
  { id: 'bpvs', source: 'lazybot', aliases: ['bpvs'], kind: 'osu' },
  { id: 'recent', source: 'lazybot', aliases: ['pr', 'rp', 'playrecent', 're', 'recent', 'p', 'r', 'ppr', 'pre'], kind: 'osu', capability: 'recent', bridge: true },
  { id: 'prs', source: 'lazybot', aliases: ['prs', 'rps', 'rs', 'res', 'ps'], kind: 'osu' },
  { id: 'score', source: 'lazybot', aliases: ['score', 's', 'pscore'], kind: 'osu', capability: 'score' },
  { id: 'allscore', source: 'lazybot', aliases: ['allscore', 'as', 'allscores', 'ass'], kind: 'osu' },
  { id: 'topscores', source: 'lazybot', aliases: ['topscores', 'ts'], kind: 'osu' },
  { id: 'todaybp', source: 'lazybot', aliases: ['todaybp', 'tbp'], kind: 'osu' },
  { id: 'profile', source: 'lazybot', aliases: ['profile', 'info'], kind: 'osu', capability: 'info', bridge: true },
  { id: 'card', source: 'lazybot', aliases: ['card'], kind: 'osu', capability: 'card', bridge: true },
  { id: 'pstats', source: 'lazybot', aliases: ['pstats'], kind: 'osu' },
  { id: 'ppmap', source: 'lazybot', aliases: ['ppmap'], kind: 'osu' },
  { id: 'pptest', source: 'lazybot', aliases: ['pptest'], kind: 'osu' },
  { id: 'whatif', source: 'lazybot', aliases: ['whatif'], kind: 'osu' },
  { id: 'nochoke', source: 'lazybot', aliases: ['nochoke', 'nc', 'no1miss'], kind: 'osu' },
  { id: 'noreading', source: 'lazybot', aliases: ['noreading', 'nr'], kind: 'osu' },
  { id: 'maxreading', source: 'lazybot', aliases: ['maxreading', 'mr'], kind: 'osu' },
  { id: 'ur', source: 'lazybot', aliases: ['ur', 'accuracy'], kind: 'osu' },
  { id: 'filter', source: 'lazybot', aliases: ['f', 'filter'], kind: 'osu' },
  { id: 'compare', source: 'lazybot', aliases: ['c', 'compare'], kind: 'osu' },
  { id: 'map', source: 'lazybot', aliases: ['m', 'map'], kind: 'osu' },
  { id: 'rd', source: 'lazybot', aliases: ['rd', 'recommenddifficulty'], kind: 'osu', capability: 'recommend' },
  { id: 'nametoid', source: 'lazybot', aliases: ['nametoid', 'n2d'], kind: 'osu' },
  { id: 'avatar', source: 'lazybot', aliases: ['oa', 'avatar'], kind: 'osu' },
  { id: 'setmode', source: 'lazybot', aliases: ['setmode', 'setruleset', 'setrule'], kind: 'system' },
  { id: 'link', source: 'lazybot', aliases: ['link', 'unlink', 'linksm'], kind: 'system' },
  { id: 'update', source: 'lazybot', aliases: ['update'], kind: 'osu' },
  { id: 'setpanel', source: 'lazybot', aliases: ['setpanel', 'sp'], kind: 'system' },
  { id: 'customize', source: 'lazybot', aliases: ['customize'], kind: 'osu' },
  { id: 'verify', source: 'lazybot', aliases: ['verify', 'verifymap', 'vm'], kind: 'system' },
  { id: 'thumbnail', source: 'lazybot', aliases: ['tns', 'tnp', 'thumbnail'], kind: 'osu' },
  { id: 'addscores', source: 'lazybot', aliases: ['addscores', 'addscore', 'add'], kind: 'admin' },
  { id: 'monitor', source: 'lazybot', aliases: ['monitor'], kind: 'admin' },
  { id: 'linkinfo', source: 'lazybot', aliases: ['li', 'linkinfo'], kind: 'system' },
  { id: 'um', source: 'lazybot', aliases: ['um'], kind: 'system' },
  { id: 'tips', source: 'lazybot', aliases: ['tips', 'addtips'], kind: 'system' },
  { id: 'rgc', source: 'lazybot', aliases: ['rgc'], kind: 'fun' },
  { id: 'name', source: 'lazybot', aliases: ['name', 'n', 'namelegacy', 'nl'], kind: 'fun' },
  { id: 'song', source: 'lazybot', aliases: ['song'], kind: 'fun' },
  { id: 'help', source: 'lazybot', aliases: ['help'], kind: 'system', handler: 'help' },
];

export const HYDRANT_DEFS: RawQuickCommandDef[] = [
  { id: 'self_profile', source: 'hydrant', aliases: ['~'], kind: 'osu', handler: 'self_profile', bridge: true },
  { id: 'at_profile', source: 'hydrant', aliases: ['查'], kind: 'osu', handler: 'at_profile', bridge: true },
  { id: 'where', source: 'hydrant', aliases: ['where'], kind: 'osu', handler: 'where', bridge: true },
  // Hydrant's original `+` still calls the retired syrin.me PP+ endpoint.
  // Route the same public command through Wuxin's local PP+ aggregate instead.
  { id: 'pplus', source: 'hydrant', aliases: ['+'], kind: 'osu', capability: 'pplus' },
  { id: 'recommend', source: 'hydrant', aliases: ['荐图'], kind: 'osu', capability: 'recommend' },
  { id: 'pptth', source: 'hydrant', aliases: ['pptth'], kind: 'osu' },
  { id: 'highlight', source: 'hydrant', aliases: ['今日高光'], kind: 'osu' },
  { id: 'help', source: 'hydrant', aliases: ['帮助'], kind: 'system', handler: 'help' },
  { id: 'annual', source: 'hydrant', aliases: ['我的年度osu!', '我的年度osu！', '我的年度屙屎'], kind: 'osu' },
];

// Prefix tables keep the original registry order: `!` precedence follows real
// usage (kanon before yumu for ties), exactly as quickRouter consumed it.
export const ALL_QUICK_DEFS: RawQuickCommandDef[] = [...COMMON_DEFS, ...YUMU_DEFS, ...KANON_DEFS, ...LAZYBOT_DEFS, ...HYDRANT_DEFS];
export const EXCLAMATION_DEFS: RawQuickCommandDef[] = [...COMMON_DEFS, ...KANON_DEFS, ...YUMU_DEFS];
export const SLASH_DEFS: RawQuickCommandDef[] = [...LAZYBOT_DEFS];
export const HYDRANT_PREFIX_FREE: RawQuickCommandDef[] = HYDRANT_DEFS.filter((d) => d.handler !== 'self_profile' && d.handler !== 'at_profile');

export const QUICK_DESCRIPTIONS: Record<string, string> = {
  help: '查看快捷指令帮助（支持 !help、/help、帮助 等别名）',
  ping: '检测 pippi 是否在线',
  bind: '提示绑定 osu! 账号的入口（绑定统一走 /w osu bind）',
  unbind: '提示解绑入口（解绑统一走 /w osu clear bind）',
  recent: '查询最近成绩',
  score: '查询指定谱面 BID 的成绩',
  bp: '查询最佳成绩（BP），支持名次/范围',
  bs: '查询最佳成绩（雨沐风格），支持名次/范围',
  pm: '查询旧版 PP− 表现分',
  pplus: '查询 PP+ 维度面板',
  skill: '查询技能雷达',
  etx: '查询 ETX 精英分数',
  info: '查询玩家信息',
  recommend: '推图 / 谱面推荐',
  match: '比赛观战',
  rating: '查询系列 rating',
  dice: '掷骰子',
  bplist: '查询 BP 列表',
  profile: '查询玩家信息（LazyBot 风格）',
  card: '查询玩家卡片',
  update: '刷新玩家 osu! 缓存与 PP+ 数据',
  rd: '推图 / 谱面难度推荐',
  self_profile: '查询自己的 osu! 信息卡（~）',
  at_profile: '查询被 @ 玩家的 osu! 信息卡',
  where: '按 osu! 用户名查询玩家',
};

export function canonicalQuickSyntax(def: RawQuickCommandDef): string {
  if (def.handler === 'self_profile') return '~';
  if (def.handler === 'at_profile') return '查 @某人';
  if (def.handler === 'where') return 'where <osu用户名> 或 where qq=<QQ号>';
  if (def.handler === 'help') return def.source === 'lazybot' ? '/help' : def.source === 'hydrant' ? '帮助' : '!help';
  if (def.handler === 'ping') return '!ping';
  if (def.handler === 'bind') return '!bind';
  if (def.handler === 'unbind') return '!unbind';
  if (def.handler === 'dice') return '!dice <面数>';
  if (def.source === 'hydrant' && def.id === 'pplus') return '+ <osu用户名>';
  if (def.source === 'hydrant' && def.id === 'recommend') return '荐图';
  if (def.source === 'lazybot') return '/' + (def.aliases[0] || def.id) + (def.bpArgs ? ' <名次/范围>' : '');
  if (def.source === 'kanon' && def.capability === 'score') return '!score <谱面BID> [玩家名]';
  if (def.source === 'kanon' && def.capability === 'info') return '!info <玩家名>';
  if ((def.id === 'bp' || def.id === 'bs' || def.capability === 'bp' || def.capability === 'bplist') && def.bpArgs) {
    return `!${def.aliases[0] || def.id} <名次/范围>`;
  }
  if (def.id === 'bs') return '!bs <名次/范围>';
  if (def.id === 'bp') return '!bp <名次/范围>';
  if (def.capability === 'score') return '!s <谱面BID> [玩家名]';
  if (def.capability === 'recent') return '!' + (def.aliases[0] || 'p');
  return '!' + (def.aliases[0] || def.id);
}

export function finalizeQuickDef(def: RawQuickCommandDef): QuickCommandDef {
  const executable = Boolean(def.handler || def.capability || def.bridge);
  let execution: CommandExecution;
  if (def.bridge) {
    execution = {
      kind: 'proxy',
      capability: def.capability || (def.handler ? 'profile' : 'injected-bridge'),
      targetBot: def.source,
    };
  } else if (def.handler) {
    execution = { kind: 'local', handlerKey: def.handler };
  } else if (def.capability) {
    execution = { kind: 'local', handlerKey: def.capability };
  } else {
    execution = { kind: 'documentation_only', reason: 'not_yet_ported' };
  }
  const cooldown = def.capability === 'recommend' || def.id === 'recommend' || def.id === 'rd'
    ? RECOMMEND_COOLDOWN
    : undefined;
  return {
    ...def,
    description: QUICK_DESCRIPTIONS[def.id] || '',
    status: executable ? 'active' : 'disabled',
    execution,
    visibility: executable ? 'public' : 'hidden',
    discoverability: executable ? 'listed' : 'hidden',
    permission: def.kind === 'admin' ? 'group_admin' : 'all',
    ...(cooldown ? { cooldown } : {}),
  };
}

export const QUICK_DEFS: QuickCommandDef[] = ALL_QUICK_DEFS.map(finalizeQuickDef);

export function quickParseDomain(def: QuickCommandDef): QuickParseDomain {
  if (def.source === 'lazybot') return '/';
  if (def.source === 'hydrant') return 'none';
  return '!';
}

export function quickPrimaryAlias(def: QuickCommandDef): string {
  return normalizeAlias(def.aliases[0] || def.id);
}

interface QuickResolveResult {
  def: QuickCommandDef;
  alias: string;
  args: string;
  prefix: '!' | '/' | 'none';
}

function matchAliasPure(defs: RawQuickCommandDef[], rest: string): { def: RawQuickCommandDef; alias: string } | null {
  const normalized = normalizeAlias(rest);
  let best: { def: RawQuickCommandDef; alias: string; length: number } | null = null;
  for (const def of defs) {
    for (const alias of def.aliases) {
      const key = normalizeAlias(alias);
      if (normalized === key || normalized.startsWith(key + ' ')) {
        if (!best || key.length > best.length) best = { def, alias: key, length: key.length };
      }
    }
  }
  return best ? { def: best.def, alias: best.alias } : null;
}

function argsAfterAliasPure(rawRest: string, alias: string): string {
  const aliasTokens = alias.split(' ').filter(Boolean).length;
  const tokens = String(rawRest || '').trim().split(/\s+/).filter(Boolean);
  return tokens.slice(aliasTokens).join(' ');
}

/**
 * Pure quick-command resolver (no db/fs/net/runtime). Mirrors
 * quickRouter.matchQuickCommand semantics: longest alias wins, ties keep
 * registry order; hydrant prefix-free triggers handled; `/w ...` is not a
 * quick command. kb-verify asserts this resolver and the runtime matcher
 * agree on every generated example.
 */
export function resolveQuickCommand(text: string): QuickResolveResult | null {
  const raw = String(text || '').trim();
  if (!raw) return null;

  if (raw.startsWith('!') || raw.startsWith('！')) {
    const rest = raw.slice(1).trim();
    const matched = matchAliasPure(EXCLAMATION_DEFS, normalizeAlias(rest));
    if (!matched) return null;
    return {
      def: finalizeQuickDef(matched.def),
      alias: matched.alias,
      args: argsAfterAliasPure(rest, matched.alias),
      prefix: '!',
    };
  }

  if (raw.startsWith('/') && !/^\/w(?:uxin)?(?:\s|$)/i.test(raw)) {
    const rest = raw.slice(1).trim();
    const matched = matchAliasPure(SLASH_DEFS, normalizeAlias(rest));
    if (!matched) return null;
    return {
      def: finalizeQuickDef(matched.def),
      alias: matched.alias,
      args: argsAfterAliasPure(rest, matched.alias),
      prefix: '/',
    };
  }

  const hydrant = normalizeAlias(raw);
  if (/^~/.test(hydrant)) {
    const def = HYDRANT_DEFS.find((d) => d.handler === 'self_profile');
    if (!def) return null;
    return { def: finalizeQuickDef(def), alias: '~', args: hydrant.slice(1).trim(), prefix: 'none' };
  }
  const prefixFree = matchAliasPure(HYDRANT_PREFIX_FREE, hydrant);
  if (prefixFree) {
    return {
      def: finalizeQuickDef(prefixFree.def),
      alias: prefixFree.alias,
      args: argsAfterAliasPure(raw, prefixFree.alias),
      prefix: 'none',
    };
  }
  return null;
}
