// Quick-command router — M1 of the four-bot merge.
//
// Deterministic, no-LLM handling of the legacy quick commands (`!p`/`!bs`/`/plus`/
// `~`/`查@` …). Every kept alias from the confirmed feature inventory lives in
// the registry below; implemented commands execute directly against the shared
// internal engine, while not-yet-migrated commands fall through to the normal
// LLM pipeline so the group experience never regresses.
import { readDb, updateDb, nowIso } from '../store.js';
import { getGroup, getUserPolicy } from './gate.js';
import { hasCommandPermission, commandDeniedReply, writeCommandLog } from './commands.js';
import {
  executeInternalBotCommand,
  parseEmbeddedBpCommand,
  type BpQuerySelection,
} from '../bots/executor.js';
import { callLocalBot, hasLocalEndpoint } from '../bots/localBridge.js';

export type QuickSource = 'common' | 'yumu' | 'kanon' | 'hydrant' | 'lazybot';

export interface QuickCommandDef {
  id: string;
  source: QuickSource;
  aliases: string[];
  kind: 'osu' | 'system' | 'fun' | 'admin';
  /** Internal engine capability, when the command maps to one. */
  capability?: 'recent' | 'info' | 'profile' | 'card' | 'bp' | 'bplist' | 'pplus' | 'skill';
  /** Local handler id for non-osu commands. */
  handler?: 'bind' | 'unbind' | 'help' | 'ping' | 'dice' | 'where' | 'self_profile' | 'at_profile' | 'pp_user' | 'pp_self' | 'notice';
  /** Admin-only commands are gated by owner/admin role before any reply. */
  permission?: 'admin';
  /** False until the handler is ported; matched-but-unimplemented falls to LLM. */
  implemented?: boolean;
  /** For `bp` family: parse a trailing BP rank/range (`1-100`, `#5`). */
  bpArgs?: boolean;
  /** Prefer direct invocation of the original local bot (original rendering). */
  bridge?: boolean;
}

interface QuickMatch {
  def: QuickCommandDef;
  /** The full normalized command text without the prefix. */
  cmdText: string;
  /** Raw arguments after the matched alias. */
  args: string;
  prefix: '!' | '/' | 'none';
  atTargets: string[];
  /** Hydrant mode suffix (e.g. `,mania` after `~` / `查`). */
  extraMode?: string;
}

// ── Registry ──

const COMMON: QuickCommandDef[] = [
  { id: 'help', source: 'common', aliases: ['h', 'help', 'helps', '帮助', '文档', '完整帮助'], kind: 'system', handler: 'help', implemented: true },
  { id: 'ping', source: 'common', aliases: ['ping', 'pi', '探测'], kind: 'system', handler: 'ping', implemented: true },
  { id: 'bind', source: 'common', aliases: ['bind', 'bi', '绑定'], kind: 'system', handler: 'bind', implemented: true },
  { id: 'unbind', source: 'common', aliases: ['unbind', 'ub', '解绑', '解除绑定'], kind: 'system', handler: 'unbind', implemented: true },
  { id: 'setmode', source: 'common', aliases: ['set mode', 'set game mode', 'mode', 'sm', 'mo', '游戏模式'], kind: 'system', implemented: false },
  { id: 'groupmode', source: 'common', aliases: ['set group mode', 'group mode', 'gm', '群模式', '群聊模式'], kind: 'system', implemented: false },
  { id: 'check', source: 'common', aliases: ['check', 'ck', '检查'], kind: 'system', implemented: false },
];

const YUMU: QuickCommandDef[] = [
  { id: 'recent', source: 'yumu', aliases: ['p', 'pass', '通过成绩', 'pr', 're', 'recent', 'r', '最近成绩', 'ps', 'passes', 'rs', 'recents', 'pw', 'rw', 'pass show', 'recent show'], kind: 'osu', capability: 'recent', implemented: true, bridge: true },
  { id: 'rbs', source: 'yumu', aliases: ['rbs', 'recents bests', '优秀成绩'], kind: 'osu', implemented: false },
  { id: 'prcard', source: 'yumu', aliases: ['pc', 'rc', 'passcard', 'recentcard', '通过卡片', '最近卡片'], kind: 'osu', implemented: false },
  { id: 'score', source: 'yumu', aliases: ['s', 'score', '成绩', 'sw', 'show score', 'ss', 'scores', '多成绩'], kind: 'osu', implemented: false },
  { id: 'bp', source: 'yumu', aliases: ['bp', 'b', 'best', 'bestperformance', '最成绩', '最佳成绩', 'bpw', 'best show'], kind: 'osu', capability: 'bp', bpArgs: true, implemented: true, bridge: true },
  { id: 'bs', source: 'yumu', aliases: ['bs', 'bps', 'bests'], kind: 'osu', capability: 'bp', bpArgs: true, implemented: true, bridge: true },
  { id: 'todaybp', source: 'yumu', aliases: ['todaybp', 'tbp', 'tdp', 't', '今日成绩', '今日最佳成绩'], kind: 'osu', implemented: false },
  { id: 'bpf', source: 'yumu', aliases: ['bpf', 'bf', 'bp fix', 'best fix', '修复成绩', '修复最佳成绩'], kind: 'osu', implemented: false },
  { id: 'ba', source: 'yumu', aliases: ['ba', 'bpa', 'bp analysis', 'best analysis', '分析成绩', '分析最佳成绩'], kind: 'osu', implemented: false },
  { id: 'bh', source: 'yumu', aliases: ['bh', 'bph', 'bp history', '历史成绩'], kind: 'osu', implemented: false },
  { id: 'top', source: 'yumu', aliases: ['top', 'tp', 'top plays'], kind: 'osu', implemented: false },
  { id: 'pm', source: 'yumu', aliases: ['pm', 'pp-', 'ppminus', '表现分减', 'pv', 'ppminus vs', 'pl', 'ppminus legacy'], kind: 'osu', implemented: false },
  { id: 'pplus', source: 'yumu', aliases: ['pp', 'px', 'p+', 'pp+', 'plus', 'pppvs', 'plusvs'], kind: 'osu', capability: 'pplus', implemented: true },
  { id: 'ppmap', source: 'yumu', aliases: ['pa', 'ppmap'], kind: 'osu', implemented: false },
  { id: 'skill', source: 'yumu', aliases: ['k', 'skill', 'skills', '技能', '技巧'], kind: 'osu', capability: 'skill', implemented: true },
  { id: 'kv', source: 'yumu', aliases: ['kv', 'skill vs', 'skills vs', '技能对比'], kind: 'osu', implemented: false },
  { id: 'etx', source: 'yumu', aliases: ['ex', 'et', 'etx', 'elite', 'eliteronix', '精英分数', 'ev', 'etx vs', 'elite vs'], kind: 'osu', implemented: false },
  { id: 'csv', source: 'yumu', aliases: ['csi', 'csv info', 'csvppm', 'cm', 'csvrating', 'cra'], kind: 'osu', implemented: false },
  { id: 'ppst', source: 'yumu', aliases: ['ppst'], kind: 'osu', implemented: false },
  { id: 'info', source: 'yumu', aliases: ['i', 'info', 'information', '玩家信息', '个人信息', '玩家', 'ic', 'infocard', '信息卡片', '玩家卡片'], kind: 'osu', capability: 'info', implemented: true },
  { id: 'mapper', source: 'yumu', aliases: ['im', 'imapper', 'mapper', '谱师', '作者信息'], kind: 'osu', implemented: false },
  { id: 'friend', source: 'yumu', aliases: ['f', 'friends', '好友', '好友信息'], kind: 'osu', implemented: false },
  { id: 'badge', source: 'yumu', aliases: ['bd', 'badge', '奖牌', '牌子'], kind: 'osu', implemented: false },
  { id: 'team', source: 'yumu', aliases: ['tm', 'team', 'clan', '战队', '战队信息'], kind: 'osu', implemented: false },
  { id: 'getid', source: 'yumu', aliases: ['gi', 'get id', 'gn', 'get name'], kind: 'osu', implemented: false },
  { id: 'mutual', source: 'yumu', aliases: ['mutual', 'mua', '主页链接', '亲亲'], kind: 'osu', implemented: false },
  { id: 'qpi', source: 'yumu', aliases: ['qi', 'ri', 'quick play info', 'ranked play info', '排位匹配信息'], kind: 'osu', implemented: false },
  { id: 'oldavatar', source: 'yumu', aliases: ['oa', 'o', 'old avatar', '旧头像', 'oc', 'oishi', 'avatar card', 'op', 'old profile', 'osu profile'], kind: 'osu', implemented: false },
  { id: 'audio', source: 'yumu', aliases: ['a', 'audio', 'song', '谱面音频'], kind: 'osu', implemented: false },
  { id: 'map', source: 'yumu', aliases: ['m', 'map', 'beatmap', 'mz', 'map lazer', 'beatmap lazer', '谱面'], kind: 'osu', implemented: false },
  { id: 'qualified', source: 'yumu', aliases: ['q', 'qua', 'qualified'], kind: 'osu', implemented: false },
  { id: 'leader', source: 'yumu', aliases: ['l', 'leader', 'leaderboard', 'list', 'gl', 'group leaderboard', 'group list', 'lg', 'll', 'legacy leaderboard', 'legacy list'], kind: 'osu', implemented: false },
  { id: 'nom', source: 'yumu', aliases: ['n', 'nom', 'nomination', 'nominations'], kind: 'osu', implemented: false },
  { id: 'explore', source: 'yumu', aliases: ['e', 'exp', 'explore', 'find', 'search', 'emp', 'explore most played'], kind: 'osu', implemented: false },
  { id: 'recommend', source: 'yumu', aliases: ['rec', 'recommend', 'recommended', 'j', '推荐', '推荐谱面'], kind: 'osu', implemented: false },
  { id: 'view', source: 'yumu', aliases: ['v', 'view', 'vv', 'view variation', 'sv view'], kind: 'osu', implemented: false },
  { id: 'cal', source: 'yumu', aliases: ['cal', 'calculate', 'cl'], kind: 'osu', implemented: false },
  { id: 'getbg', source: 'yumu', aliases: ['gb', 'bg', 'get bg', 'get background', '获取背景'], kind: 'osu', implemented: false },
  { id: 'getcover', source: 'yumu', aliases: ['gc', 'get cover', '获取封面'], kind: 'osu', implemented: false },
  { id: 'match', source: 'yumu', aliases: ['ml', 'li', 'match listen', 'match listener', 'make love', '观战'], kind: 'osu', implemented: false },
  { id: 'matchnow', source: 'yumu', aliases: ['mn', 'match now', 'monitor now'], kind: 'osu', implemented: false },
  { id: 'matchrecent', source: 'yumu', aliases: ['mr', 'match recent', 'match recents'], kind: 'osu', implemented: false },
  { id: 'matchround', source: 'yumu', aliases: ['ro', 'rounds', 'match rounds'], kind: 'osu', implemented: false },
  { id: 'rating', source: 'yumu', aliases: ['ra', 'rating', 'mra', 'ym rating', 'sa', 'sra', 'series', 'series rating'], kind: 'osu', implemented: false },
  { id: 'quickplay', source: 'yumu', aliases: ['qp', 'rp', 'quick play', 'ranked play'], kind: 'osu', implemented: false },
  { id: 'pool', source: 'yumu', aliases: ['po', 'mappool', 'gp', 'getpool', 'get pool'], kind: 'osu', implemented: false },
  { id: 'dice', source: 'yumu', aliases: ['d', 'dice', 'roll', '骰子'], kind: 'fun', handler: 'dice', implemented: true },
];

const KANON: QuickCommandDef[] = [
  { id: 'recent', source: 'kanon', aliases: ['re', 'recent', 'pr'], kind: 'osu', capability: 'recent', implemented: true, bridge: true },
  { id: 'recentlist', source: 'kanon', aliases: ['res', 'recentlist', 'prs'], kind: 'osu', implemented: false },
  { id: 'bp', source: 'kanon', aliases: ['bp'], kind: 'osu', capability: 'bp', bpArgs: true, implemented: true, bridge: true },
  { id: 'bplist', source: 'kanon', aliases: ['bplist', 'get bplist'], kind: 'osu', capability: 'bplist', bpArgs: true, implemented: true, bridge: true },
  { id: 'score', source: 'kanon', aliases: ['score'], kind: 'osu', implemented: false },
  { id: 'info', source: 'kanon', aliases: ['info'], kind: 'osu', capability: 'info', implemented: true, bridge: true },
  { id: 'todaybp', source: 'kanon', aliases: ['todaybp', 'get todaybp'], kind: 'osu', implemented: false },
  { id: 'search', source: 'kanon', aliases: ['search'], kind: 'osu', implemented: false },
  { id: 'update', source: 'kanon', aliases: ['update'], kind: 'osu', implemented: false },
  { id: 'getbg', source: 'kanon', aliases: ['get bg'], kind: 'osu', implemented: false },
  { id: 'getbonuspp', source: 'kanon', aliases: ['get bonuspp', 'get bonus pp'], kind: 'osu', implemented: false },
  { id: 'badge', source: 'kanon', aliases: ['badge', 'badge list', 'badge info'], kind: 'osu', implemented: false },
  { id: 'setosumode', source: 'kanon', aliases: ['set osumode', 'set osu mode'], kind: 'system', implemented: false },
];

const LAZYBOT: QuickCommandDef[] = [
  { id: 'pplus', source: 'lazybot', aliases: ['plus', 'ppp'], kind: 'osu', capability: 'pplus', implemented: true, bridge: true },
  { id: 'bp', source: 'lazybot', aliases: ['bp', 'best', 'pbp', 'b', 'bsm'], kind: 'osu', capability: 'bp', bpArgs: true, implemented: true, bridge: true },
  { id: 'bplist', source: 'lazybot', aliases: ['bplist'], kind: 'osu', capability: 'bplist', bpArgs: true, implemented: true, bridge: true },
  { id: 'bpcard', source: 'lazybot', aliases: ['bpcard', 'pbpcard', 'pb', 'pbplist'], kind: 'osu', implemented: false },
  { id: 'bpif', source: 'lazybot', aliases: ['bpif'], kind: 'osu', implemented: false },
  { id: 'bps', source: 'lazybot', aliases: ['bps', 'bs', 'bssm'], kind: 'osu', implemented: false },
  { id: 'bpvs', source: 'lazybot', aliases: ['bpvs'], kind: 'osu', implemented: false },
  { id: 'recent', source: 'lazybot', aliases: ['pr', 'rp', 'playrecent', 're', 'recent', 'p', 'r', 'ppr', 'pre'], kind: 'osu', capability: 'recent', implemented: true, bridge: true },
  { id: 'prs', source: 'lazybot', aliases: ['prs', 'rps', 'rs', 'res', 'ps'], kind: 'osu', implemented: false },
  { id: 'score', source: 'lazybot', aliases: ['score', 's', 'pscore'], kind: 'osu', implemented: false },
  { id: 'allscore', source: 'lazybot', aliases: ['allscore', 'as', 'allscores', 'ass'], kind: 'osu', implemented: false },
  { id: 'topscores', source: 'lazybot', aliases: ['topscores', 'ts'], kind: 'osu', implemented: false },
  { id: 'todaybp', source: 'lazybot', aliases: ['todaybp', 'tbp'], kind: 'osu', implemented: false },
  { id: 'profile', source: 'lazybot', aliases: ['profile', 'info'], kind: 'osu', capability: 'info', implemented: true, bridge: true },
  { id: 'card', source: 'lazybot', aliases: ['card'], kind: 'osu', capability: 'card', implemented: true, bridge: true },
  { id: 'pstats', source: 'lazybot', aliases: ['pstats'], kind: 'osu', implemented: false },
  { id: 'ppmap', source: 'lazybot', aliases: ['ppmap'], kind: 'osu', implemented: false },
  { id: 'pptest', source: 'lazybot', aliases: ['pptest'], kind: 'osu', implemented: false },
  { id: 'whatif', source: 'lazybot', aliases: ['whatif'], kind: 'osu', implemented: false },
  { id: 'nochoke', source: 'lazybot', aliases: ['nochoke', 'nc', 'no1miss'], kind: 'osu', implemented: false },
  { id: 'noreading', source: 'lazybot', aliases: ['noreading', 'nr'], kind: 'osu', implemented: false },
  { id: 'maxreading', source: 'lazybot', aliases: ['maxreading', 'mr'], kind: 'osu', implemented: false },
  { id: 'ur', source: 'lazybot', aliases: ['ur', 'accuracy'], kind: 'osu', implemented: false },
  { id: 'filter', source: 'lazybot', aliases: ['f', 'filter'], kind: 'osu', implemented: false },
  { id: 'compare', source: 'lazybot', aliases: ['c', 'compare'], kind: 'osu', implemented: false },
  { id: 'map', source: 'lazybot', aliases: ['m', 'map'], kind: 'osu', implemented: false },
  { id: 'rd', source: 'lazybot', aliases: ['rd', 'recommenddifficulty'], kind: 'osu', implemented: false },
  { id: 'nametoid', source: 'lazybot', aliases: ['nametoid', 'n2d'], kind: 'osu', implemented: false },
  { id: 'avatar', source: 'lazybot', aliases: ['oa', 'avatar'], kind: 'osu', implemented: false },
  { id: 'setmode', source: 'lazybot', aliases: ['setmode', 'setruleset', 'setrule'], kind: 'system', implemented: false },
  { id: 'link', source: 'lazybot', aliases: ['link', 'unlink', 'linksm'], kind: 'system', implemented: false },
  { id: 'update', source: 'lazybot', aliases: ['update'], kind: 'osu', implemented: false },
  { id: 'setpanel', source: 'lazybot', aliases: ['setpanel', 'sp'], kind: 'system', implemented: false },
  { id: 'customize', source: 'lazybot', aliases: ['customize'], kind: 'osu', implemented: false },
  { id: 'verify', source: 'lazybot', aliases: ['verify', 'verifymap', 'vm'], kind: 'system', implemented: false },
  { id: 'thumbnail', source: 'lazybot', aliases: ['tns', 'tnp', 'thumbnail'], kind: 'osu', implemented: false },
  { id: 'addscores', source: 'lazybot', aliases: ['addscores', 'addscore', 'add'], kind: 'admin', implemented: false },
  { id: 'monitor', source: 'lazybot', aliases: ['monitor'], kind: 'admin', implemented: false },
  { id: 'linkinfo', source: 'lazybot', aliases: ['li', 'linkinfo'], kind: 'system', implemented: false },
  { id: 'um', source: 'lazybot', aliases: ['um'], kind: 'system', implemented: false },
  { id: 'tips', source: 'lazybot', aliases: ['tips', 'addtips'], kind: 'system', implemented: false },
  { id: 'rgc', source: 'lazybot', aliases: ['rgc'], kind: 'fun', implemented: false },
  { id: 'name', source: 'lazybot', aliases: ['name', 'n', 'namelegacy', 'nl'], kind: 'fun', implemented: false },
  { id: 'song', source: 'lazybot', aliases: ['song'], kind: 'fun', implemented: false },
  { id: 'help', source: 'lazybot', aliases: ['help'], kind: 'system', handler: 'help', implemented: true },
];

// Hydrant triggers are prefix-free (or use special tokens), so they live in
// their own matcher instead of the shared alias table.
const HYDRANT: QuickCommandDef[] = [
  { id: 'self_profile', source: 'hydrant', aliases: ['~'], kind: 'osu', handler: 'self_profile', implemented: true, bridge: true },
  { id: 'at_profile', source: 'hydrant', aliases: ['查'], kind: 'osu', handler: 'at_profile', implemented: true, bridge: true },
  { id: 'where', source: 'hydrant', aliases: ['where'], kind: 'osu', handler: 'where', implemented: true, bridge: true },
  { id: 'pp_self', source: 'hydrant', aliases: ['++'], kind: 'osu', handler: 'pp_self', implemented: true },
  { id: 'pp_user', source: 'hydrant', aliases: ['+'], kind: 'osu', handler: 'pp_user', implemented: true },
  { id: 'recommend', source: 'hydrant', aliases: ['荐图'], kind: 'osu', implemented: false },
  { id: 'pptth', source: 'hydrant', aliases: ['pptth'], kind: 'osu', implemented: false },
  { id: 'highlight', source: 'hydrant', aliases: ['今日高光'], kind: 'osu', implemented: false },
  { id: 'help', source: 'hydrant', aliases: ['帮助'], kind: 'system', handler: 'help', implemented: true },
  { id: 'annual', source: 'hydrant', aliases: ['我的年度osu!', '我的年度osu！', '我的年度屙屎'], kind: 'osu', implemented: false },
];

const ALL_DEFS: QuickCommandDef[] = [...COMMON, ...YUMU, ...KANON, ...LAZYBOT, ...HYDRANT];

// Prefix tables, longest alias first. `!` precedence follows real usage:
// 猫猫 owns !pr/!re/!bp/!bplist/!info, 雨沐 owns !p/!r/!b/!bs/!s/!t/!i.
const EXCLAMATION_DEFS = [...COMMON, ...KANON, ...YUMU].sort((a, b) => longestAlias(b) - longestAlias(a));
const SLASH_DEFS = [...LAZYBOT].sort((a, b) => longestAlias(b) - longestAlias(a));

function longestAlias(def: QuickCommandDef): number {
  return def.aliases.reduce((max, alias) => Math.max(max, alias.length), 0);
}

function normalizeAlias(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[！]/g, '!').replace(/[～∼]/g, '~').replace(/[，]/g, ',').replace(/[ \t]+/g, ' ');
}

function matchAlias(defs: QuickCommandDef[], rest: string): { def: QuickCommandDef; alias: string } | null {
  const normalized = normalizeAlias(rest);
  for (const def of defs) {
    for (const alias of def.aliases) {
      const key = normalizeAlias(alias);
      if (normalized === key || normalized.startsWith(key + ' ')) {
        return { def, alias: key };
      }
    }
  }
  return null;
}

/** Rebuild raw args after a matched alias, preserving original casing. */
function argsAfterAlias(rawRest: string, alias: string): string {
  const aliasTokens = alias.split(' ').filter(Boolean).length;
  const tokens = String(rawRest || '').trim().split(/\s+/).filter(Boolean);
  return tokens.slice(aliasTokens).join(' ');
}

function modeSuffix(value: string): { mode: string; rest: string } {
  const match = /^(.*?)\s*[,，]\s*(\S*)\s*$/.exec(value);
  if (match) return { mode: match[2], rest: match[1] };
  return { mode: '', rest: value };
}

/**
 * Match a message against the quick-command registry.
 * Returns null when the message is not a quick command (LLM pipeline owns it).
 */
export function matchQuickCommand(event: { text: string; atTargets?: string[] }): QuickMatch | null {
  const raw = String(event.text || '').trim();
  if (!raw) return null;
  const atTargets = Array.isArray(event.atTargets) ? event.atTargets.map(String) : [];

  if (raw.startsWith('!') || raw.startsWith('！')) {
    const rest = raw.slice(1).trim();
    const normalizedRest = normalizeAlias(rest);
    const matched = matchAlias(EXCLAMATION_DEFS, normalizedRest);
    if (!matched) return null;
    return {
      def: matched.def,
      cmdText: rest,
      args: argsAfterAlias(rest, matched.alias),
      prefix: '!',
      atTargets,
    };
  }

  if (raw.startsWith('/') && !/^\/w(?:uxin)?(?:\s|$)/i.test(raw)) {
    const rest = raw.slice(1).trim();
    const normalizedRest = normalizeAlias(rest);
    const matched = matchAlias(SLASH_DEFS, normalizedRest);
    if (!matched) return null;
    return {
      def: matched.def,
      cmdText: rest,
      args: argsAfterAlias(rest, matched.alias),
      prefix: '/',
      atTargets,
    };
  }

  // Hydrant: prefix-free triggers.
  const hydrant = normalizeAlias(raw);
  if (/^~/.test(hydrant)) {
    const { mode, rest } = modeSuffix(hydrant.slice(1).trim());
    const def = HYDRANT.find((d) => d.handler === 'self_profile')!;
    return { def, cmdText: hydrant, args: rest, prefix: 'none', atTargets, extraMode: mode };
  }
  if (/^查/.test(raw)) {
    const { mode, rest } = modeSuffix(raw.slice(1).trim());
    if (atTargets.length > 0) {
      const def = HYDRANT.find((d) => d.handler === 'at_profile')!;
      return { def, cmdText: raw, args: rest, prefix: 'none', atTargets, extraMode: mode };
    }
    return null;
  }
  const normalizedRaw = normalizeAlias(raw);
  const prefixFree = matchAlias(HYDRANT.filter((d) => d.handler !== 'self_profile' && d.handler !== 'at_profile'), normalizedRaw);
  if (prefixFree) {
    const def = prefixFree.def;
    return {
      def,
      cmdText: raw,
      args: argsAfterAlias(raw, prefixFree.alias),
      prefix: 'none',
      atTargets,
      extraMode: '',
    };
  }
  // `+<username>` — hydrant PP+ lookup.
  if (/^\+[^\s+]\S*$/.test(raw) && raw.length >= 3) {
    const def = HYDRANT.find((d) => d.handler === 'pp_user')!;
    return { def, cmdText: raw, args: raw.slice(1).trim(), prefix: 'none', atTargets, extraMode: '' };
  }

  return null;
}

// ── BP argument parsing ──

interface ParsedOsuArgs {
  username: string;
  bpSelection?: BpQuerySelection;
  error?: string;
}

export function parseBpArgs(args: string, compactDefault: boolean): ParsedOsuArgs {
  const value = String(args || '').trim();
  if (!value) {
    return {
      username: '',
      bpSelection: {
        startRank: 1,
        endRank: 10,
        explicit: false,
        single: false,
        compact: compactDefault,
      },
    };
  }

  // "1-100", "#5", "5", "1到10"
  const bareRange = /^#?(\d{1,3})(?:\s*(?:-|~|到|至)\s*#?(\d{1,3}))?$/.exec(value);
  if (bareRange) {
    const startRank = Number(bareRange[1]);
    const endRank = bareRange[2] ? Number(bareRange[2]) : startRank;
    if (startRank < 1 || endRank > 100 || startRank > endRank) {
      return { username: '', error: 'BP 名次必须是 1 到 100，且范围起点不能大于终点' };
    }
    return {
      username: '',
      bpSelection: { startRank, endRank, explicit: true, single: startRank === endRank, compact: compactDefault },
    };
  }

  // "<用户名> 1-100" / "<用户名> 5"
  const trailingRange = /^(.+?)\s+#?(\d{1,3})(?:\s*(?:-|~|到|至)\s*#?(\d{1,3}))?$/.exec(value);
  if (trailingRange) {
    const startRank = Number(trailingRange[2]);
    const endRank = trailingRange[3] ? Number(trailingRange[3]) : startRank;
    if (startRank >= 1 && endRank <= 100 && startRank <= endRank) {
      return {
        username: trailingRange[1].trim(),
        bpSelection: { startRank, endRank, explicit: true, single: startRank === endRank, compact: compactDefault },
      };
    }
  }

  return { username: value };
}

export function parseOsuArgs(def: QuickCommandDef, args: string): ParsedOsuArgs {
  if (def.bpArgs || def.capability === 'bp' || def.capability === 'bplist') {
    // Reuse the executor parser for canonical "bp 1-100" / "bs 10" forms.
    const embedded = parseEmbeddedBpCommand(`${def.id === 'bs' ? 'bs' : 'bp'} ${args}`.trim());
    if (embedded.selection && !embedded.error) {
      return {
        username: '',
        bpSelection: {
          ...embedded.selection,
          compact: embedded.selection.compact || def.id === 'bs',
        },
      };
    }
    return parseBpArgs(args, def.id === 'bs');
  }
  return { username: String(args || '').trim() };
}

/** Rebuild the original bot command text for bridge invocation. */
function buildBridgeCommand(match: QuickMatch): string {
  const { def, cmdText, args, prefix } = match;
  if (def.handler === 'self_profile') return '~';
  if (def.handler === 'at_profile') {
    const qq = match.atTargets?.[0] || '';
    return qq ? `查[CQ:at,qq=${qq}]` : '查';
  }
  if (def.handler === 'where') return `where ${args}`.trim();
  if (def.handler === 'pp_self') return '++';
  if (def.handler === 'pp_user') return `+${args}`.trim();
  if (prefix === '!') return `!${cmdText}`;
  if (prefix === '/') return `/${cmdText}`;
  return cmdText;
}

// ── Execution ──

const HELP_TEXT = [
  '快捷指令（迁移中，陆续接入）：',
  '成绩：!p / !r / !pr / !re（最近）、!bp / !b / !bs（BP）、!i / !info（玩家信息）、!pp / !plus（PP+）、!k（技能）',
  'LazyBot 风格：/plus /ppp（PP+）、/bp /bplist、/pr /recent、/profile /info',
  '消防栓风格：~（自己信息卡）、查+@（查他人）、where 名字、++（PP+）',
  '绑定：!bind <osu用户名>；解绑：!unbind',
].join('\n');

/**
 * Quick commands mirror the original bots: when a panel image exists, the
 * image IS the answer. The full text payload is only for the LLM fallback
 * path; quick delivery drops it so `!bs 1-100` never dumps 100 text lines
 * alongside the panel.
 */
export function quickPayload(result: string | { content: string; images?: string[] }): string {
  if (typeof result === 'string') return result;
  const images = Array.isArray(result.images) ? result.images : [];
  if (images.length > 0) return images.join('\n');
  return String(result.content || '');
}

function stdOnlyNote(mode: string): string | null {
  if (!mode) return null;
  const normalized = mode.toLowerCase();
  if (['taiko', 'catch', 'mania', 'ctb', 'osu!taiko', 'osu!catch', 'osu!mania'].includes(normalized)) {
    return '目前只支持 osu!std 查询。';
  }
  return null;
}

function resolveAtBinding(db: any, atTargets: string[]): string {
  if (!atTargets?.length) return '';
  const binding = db?.osuBindings?.[atTargets[0]];
  if (!binding) return '';
  return String(binding.osuUsername ?? binding.username ?? binding.id ?? '');
}

export interface QuickRoutePermissions {
  isOwner: boolean;
  isAdmin: boolean;
}

/**
 * Quick-command activation gate. M1 keeps the router dormant by default so the
 * still-running original bots keep owning their commands (no double replies).
 * Enable per group (`groupBotConfig[groupId].quick = true`) or globally
 * (`settings.quickRouterEnabled = true`) once a bot family is retired.
 */
export function quickRouterEnabled(db: any, event: { groupId?: string; type?: string }): boolean {
  if (db?.settings?.quickRouterEnabled === true) return true;
  const groupConfig = db?.groupBotConfig?.[String(event?.groupId || '')];
  return groupConfig?.quick === true;
}

/**
 * Execute a matched quick command. Returns `{ handled: true }` when the quick
 * path owns the message (reply sent or intentionally ignored); `{ handled: false }`
 * when the message should continue into the normal LLM pipeline.
 */
export async function handleQuickCommand(
  event: any,
  sendMessage: any,
  db: any,
  match: QuickMatch,
  permissions: QuickRoutePermissions,
): Promise<{ handled: boolean; replied?: boolean; reason?: string }> {
  const { def, args, atTargets } = match;

  // Global/group/user gates shared with the main pipeline.
  if (db?.settings?.globalPaused) return { handled: true, replied: false, reason: '全局暂停' };
  const group = getGroup(db, event.groupId);
  const isPrivate = event.type === 'private';
  if (!isPrivate && !group?.enabled) return { handled: true, replied: false, reason: '群未启用' };
  const userPolicy = getUserPolicy(db, event.groupId, event.userId);
  if (userPolicy.policy === 'blocked') return { handled: true, replied: false, reason: '黑名单用户' };
  if (!isPrivate && group?.mode === 'silent') return { handled: true, replied: false, reason: '静默模式' };

  // Private chat: owner only in M1 (original bots answered privately too, but
  // the merged entry keeps private traffic conservative for now).
  if (isPrivate && !permissions.isOwner) {
    return { handled: false, reason: '私聊快捷指令暂仅限 owner' };
  }

  // Admin-gated commands.
  if ((def.permission === 'admin' || def.kind === 'admin') && !permissions.isOwner && !permissions.isAdmin) {
    const reply = commandDeniedReply(db, 'admin');
    if (sendMessage) await sendMessage(event, reply);
    return { handled: true, replied: true, reason: '权限不足' };
  }

  const log = (outcome: string, detail = '') => {
    try {
      writeCommandLog(event, {
        prefix: match.prefix,
        command: `quick:${def.id}`,
        subCommand: '',
        isWuxinCommand: false,
        rawText: String(event.text || '').slice(0, 600),
        userRoleId: '',
        userPolicy: userPolicy.policy || 'normal',
      }, { outcome, detail, source: def.source, implemented: Boolean(def.implemented) });
    } catch { /* logging is non-fatal */ }
  };

  // Hydrant std-only guard runs before bridging `~` / `查@`.
  if (def.handler === 'self_profile' || def.handler === 'at_profile') {
    const modeNote = stdOnlyNote((match as any).extraMode || '');
    if (modeNote) {
      if (sendMessage) await sendMessage(event, modeNote);
      return { handled: true, replied: true, reason: '非 std 模式' };
    }
  }

  // ── Local bot bridge: direct invocation of the original bot ──
  // Original rendering (雨沐 E5/A4 面板、消防栓文字卡等) beats the internal
  // engine; on any bridge failure we fall through to the internal handler.
  if (def.bridge && hasLocalEndpoint(def.source)) {
    const bridgeCommand = buildBridgeCommand(match);
    const bridgeContext = {
      groupId: event.type === 'private' ? '770001' : String(event.groupId || ''),
      userId: String(event.userId || ''),
      nickname: String(event.nickname || ''),
      atTargets,
    };
    try {
      const bridgeTimeout = def.source === 'lazybot' ? 30_000 : 60_000;
      const reply = await callLocalBot(def.source, bridgeCommand, bridgeContext, bridgeTimeout);
      // Bridge replies are the original bot's own output: keep text and images
      // exactly as produced (the internal engine is the one that needed the
      // image-only rule to avoid duplicating its panel text).
      const payload = [reply.text, ...reply.images].filter(Boolean).join('\n');
      if (payload) {
        try {
          if (sendMessage) await sendMessage(event, payload);
        } catch (deliveryError: any) {
          console.error(`[quick] bridge ${def.source} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
        }
        log('bridge', `${def.source}:${bridgeCommand}`);
        return { handled: true, replied: true, reason: `bridge:${def.source}` };
      }
      console.error(`[quick] bridge ${def.source} 返回空回复，回退内部引擎`);
    } catch (error: any) {
      console.error(`[quick] bridge ${def.source} 失败，回退内部引擎:`, error?.message || error);
    }
  }

  // ── Local handlers ──
  if (def.handler === 'help') {
    if (sendMessage) await sendMessage(event, HELP_TEXT);
    log('help');
    return { handled: true, replied: true, reason: 'help' };
  }
  if (def.handler === 'ping') {
    const text = `在的（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`;
    if (sendMessage) await sendMessage(event, text);
    log('ping');
    return { handled: true, replied: true, reason: 'ping' };
  }
  if (def.handler === 'dice') {
    const raw = args.match(/(\d{1,6})/);
    const sides = raw ? Math.min(Number(raw[1]), 1_000_000) : 100;
    const value = Math.floor(Math.random() * sides) + 1;
    const text = `🎲 ${value}（1~${sides}）`;
    if (sendMessage) await sendMessage(event, text);
    log('dice', String(sides));
    return { handled: true, replied: true, reason: 'dice' };
  }
  if (def.handler === 'bind') {
    const username = String(args || '').trim();
    if (!username) {
      if (sendMessage) await sendMessage(event, '用法：!bind <osu用户名>（例如 !bind Cookiezi）');
      return { handled: true, replied: true, reason: 'bind 缺用户名' };
    }
    let userId: number;
    try {
      const { getUser } = await import('../osu/api.js');
      const user = await getUser(username);
      userId = user.id;
    } catch {
      if (sendMessage) await sendMessage(event, `osu! 用户 "${username}" 查不到。`);
      return { handled: true, replied: true, reason: 'bind 用户不存在' };
    }
    updateDb((draft) => {
      draft.osuBindings = draft.osuBindings || {};
      draft.osuBindings[String(event.userId)] = { id: userId, username };
    });
    if (sendMessage) await sendMessage(event, `已将 QQ 绑定到 osu! ${username}（ID: ${userId}）。`);
    log('bind', username);
    return { handled: true, replied: true, reason: 'bind' };
  }
  if (def.handler === 'unbind') {
    updateDb((draft) => {
      if (draft.osuBindings) delete draft.osuBindings[String(event.userId)];
    });
    if (sendMessage) await sendMessage(event, '已解除 osu! 绑定。');
    log('unbind');
    return { handled: true, replied: true, reason: 'unbind' };
  }

  // ── Hydrant profile/PP+ handlers ──
  if (def.handler === 'self_profile' || def.handler === 'at_profile') {
    const modeNote = stdOnlyNote((match as any).extraMode || '');
    if (modeNote) {
      if (sendMessage) await sendMessage(event, modeNote);
      return { handled: true, replied: true, reason: '非 std 模式' };
    }
    const username = def.handler === 'at_profile' ? resolveAtBinding(db, atTargets) : '';
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand('hydrant', 'profile', username, {
        db, userId: String(event.userId), groupId: event.groupId,
      });
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      return { handled: true, replied: true, reason: 'profile_error' };
    }
    // Delivery failure after a successful command must not trigger a second,
    // confusing error message (panel may already have been sent).
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log('profile', username || '(self)');
    return { handled: true, replied: true, reason: 'profile' };
  }
  if (def.handler === 'where') {
    const query = String(args || '').trim();
    const qqMatch = /^qq\s*=\s*(\d+)$/i.exec(query);
    if (qqMatch) {
      const binding = db?.osuBindings?.[qqMatch[1]];
      const text = binding
        ? `QQ ${qqMatch[1]} 绑定到 osu! ${String(binding.osuUsername ?? binding.username ?? binding.id)}。`
        : `QQ ${qqMatch[1]} 未绑定 osu! 账号。`;
      if (sendMessage) await sendMessage(event, text);
      log('where_qq', qqMatch[1]);
      return { handled: true, replied: true, reason: 'where_qq' };
    }
    if (!query) {
      if (sendMessage) await sendMessage(event, '用法：where <osu用户名> 或 where qq=<QQ号>');
      return { handled: true, replied: true, reason: 'where 缺参数' };
    }
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand('hydrant', 'profile', query, {
        db, userId: String(event.userId), groupId: event.groupId,
      });
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      return { handled: true, replied: true, reason: 'where_error' };
    }
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log('where', query);
    return { handled: true, replied: true, reason: 'where' };
  }
  if (def.handler === 'pp_self' || def.handler === 'pp_user') {
    const username = def.handler === 'pp_user' ? String(args || '').trim() : '';
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand('hydrant', 'pplus', username, {
        db, userId: String(event.userId), groupId: event.groupId,
      });
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      return { handled: true, replied: true, reason: 'pplus_error' };
    }
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log('pplus', username || '(self)');
    return { handled: true, replied: true, reason: 'pplus' };
  }

  // ── Internal engine capabilities ──
  if (def.capability) {
    const parsed = parseOsuArgs(def, args);
    if (parsed.error) {
      if (sendMessage) await sendMessage(event, parsed.error);
      return { handled: true, replied: true, reason: '参数错误' };
    }
    let username = parsed.username;
    if (!username && atTargets.length > 0) username = resolveAtBinding(db, atTargets);
    const botId = def.source === 'kanon' ? 'kanon' : def.source === 'lazybot' ? 'lazybot' : 'yumu';
    let result: Awaited<ReturnType<typeof executeInternalBotCommand>>;
    try {
      result = await executeInternalBotCommand(
        botId,
        def.capability,
        username,
        { db, userId: String(event.userId), groupId: event.groupId },
        parsed.bpSelection,
      );
    } catch (error: any) {
      if (sendMessage) await sendMessage(event, String(error?.message || error));
      return { handled: true, replied: true, reason: `${def.capability}_error` };
    }
    try {
      if (sendMessage) await sendMessage(event, quickPayload(result));
    } catch (deliveryError: any) {
      console.error(`[quick] ${def.id} 发送失败（面板可能已发出）:`, deliveryError?.message || deliveryError);
    }
    log(def.capability, username || '(self)');
    return { handled: true, replied: true, reason: def.capability };
  }

  // Registered but not yet ported: keep the LLM pipeline as the fallback so
  // the group keeps getting useful answers while migration is in progress.
  log('unimplemented', def.id);
  return { handled: false, reason: `quick_unimplemented:${def.id}` };
}
