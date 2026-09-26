// Bot registry: loads bot definitions from db config, builds LLM tool schemas.
import type { BotCommand, BotCommandParam, BotDefinition, BotRegistry, LlmTool } from './types.js';
import { buildQueryOsuDescription, callableCapabilities } from './agentCapabilities.js';
import {
  capabilityNames,
  queryOsuParamJsonSchema,
  QUERY_OSU_PARAMS,
} from './capabilityCatalog.js';
import { buildV2OsuAgentToolSchemas, type AgentToolSurface } from './agentToolContracts.js';
import { buildSkillProfilerToolSchema } from './skillProfiler.js';

function bpQueryParams(): BotCommandParam[] {
  return [
    { name: 'username', type: 'string', required: false, description: 'osu! 用户名' },
    { name: 'bp_rank', type: 'number', required: false, description: '单张 BP 的名次（1-100）' },
    { name: 'bp_start', type: 'number', required: false, description: 'BP 范围起始名次（1-100）' },
    { name: 'bp_end', type: 'number', required: false, description: 'BP 范围结束名次（1-100）' },
  ];
}

export const DEFAULT_BOTS: BotDefinition[] = [
  {
    id: 'yumu',
    name: '雨沐',
    description: '查询 osu! 最近成绩、BP、玩家信息和 PP+',
    qq: '',
    channel: 'internal',
    enabled: true,
    commands: [
      { name: 'recent', trigger: '/r', description: '最近一次 osu! 成绩（图片）', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'info', trigger: '/i', description: '玩家信息面板（图片）', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'bp', trigger: '/bp', description: '单张或指定范围的最佳成绩', params: bpQueryParams(), returns: 'image' },
      { name: 'skill', trigger: '/k', description: '玩家技能雷达图', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'ppplus', trigger: '/pp', description: 'PP+ 维度分析', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'map', trigger: '/m', description: '谱面信息', params: [{ name: 'beatmap_id', type: 'string', required: true, description: '谱面 ID 或链接' }], returns: 'image' },
      { name: 'profile', trigger: '/pr', description: '玩家信息卡片', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' }
    ]
  },
  {
    id: 'kanon',
    name: '猫猫',
    description: '查询 osu! 最近成绩、BP 和玩家信息',
    qq: '',
    channel: 'internal',
    enabled: true,
    commands: [
      { name: 'recent', trigger: '!re', description: '最近成绩（含失败）', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'info', trigger: '!info', description: '玩家信息面板', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'search', trigger: '!search', description: '搜索 osu! 谱面', params: [{ name: 'query', type: 'string', required: true, description: '搜索关键词或谱面 ID' }], returns: 'image' },
      { name: 'ppvs', trigger: '!ppvs', description: '两名玩家 PP+ 对比', params: [{ name: 'username', type: 'string', required: true, description: '要对比的玩家' }], returns: 'image' },
      { name: 'bp', trigger: '!bp', description: '单张或指定范围的最佳成绩', params: bpQueryParams(), returns: 'image' },
      { name: 'pr', trigger: '!pr', description: '最近通过成绩', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'recommend', trigger: '!get recommend', description: '根据 BP 推荐谱面', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'text' }
    ]
  },
  {
    id: 'hydrant',
    name: '消防栓',
    description: 'osu! 玩家资料和 PP+ 文字查询',
    qq: '',
    channel: 'internal',
    enabled: true,
    commands: [
      { name: 'profile', trigger: '~', description: '查询 osu! 玩家信息（文字版）', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'text' },
      { name: 'ppplus', trigger: '+', description: 'PP+ 维度查询', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'text' },
      { name: 'where', trigger: 'where', description: '查询玩家绑定信息', params: [{ name: 'query', type: 'string', required: true, description: 'osu! 名或 QQ 号' }], returns: 'text' },
      { name: 'today_highlight', trigger: '今日高光', description: '今日群组 PP 排行榜', params: [], returns: 'text' },
      { name: 'recommend', trigger: '打什么图', description: '根据 BP 推荐谱面', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'text' },
      { name: 'annual_report', trigger: '我的年度osu', description: '年度 osu! 活动报告', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'pptth', trigger: 'pptth', description: 'PP/TTH 趋势折线图', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' }
    ]
  },
  {
    id: 'lazybot',
    name: 'LazyBot',
    description: 'osu! 最近成绩、BP、玩家卡片和信息面板',
    qq: '',
    channel: 'internal',
    enabled: true,
    commands: [
      { name: 'recent', trigger: '/rs', description: '最近成绩列表', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'bp', trigger: '/bp', description: '单张或指定范围的最佳成绩', params: bpQueryParams(), returns: 'image' },
      { name: 'card', trigger: '/card', description: '玩家信息卡片（图片）', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'nochoke', trigger: '/nochoke', description: 'BP 如果 FC 的 PP 计算', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' },
      { name: 'bplist', trigger: '/bplist', description: 'BP 范围列表', params: bpQueryParams(), returns: 'image' },
      { name: 'compare', trigger: '/compare', description: '玩家对比', params: [{ name: 'username', type: 'string', required: true, description: '要对比的玩家名' }], returns: 'image' },
      { name: 'profile', trigger: '/info', description: '玩家信息面板', params: [{ name: 'username', type: 'string', required: false, description: 'osu! 用户名' }], returns: 'image' }
    ]
  }
];

export function loadRegistry(db: { settings?: { botRegistry?: BotRegistry } }): BotRegistry {
  const saved = db?.settings?.botRegistry;
  if (saved?.bots?.length) return saved;
  return { bots: DEFAULT_BOTS, updatedAt: new Date().toISOString() };
}

export function enabledBots(registry: BotRegistry): BotDefinition[] {
  return (registry.bots || []).filter((b) => b.enabled && (b.qq || b.channel === 'internal'));
}

export function findBot(registry: BotRegistry, botId: string): BotDefinition | undefined {
  const target = String(botId || '').trim().toLocaleLowerCase();
  return (registry.bots || []).find(
    (b) => b.id.toLocaleLowerCase() === target || b.name.toLocaleLowerCase() === target
  );
}

// Wuxin internal adapter: these commands are served by Wuxin's own osu! API
// client, PP+ service, skill store, and yumu-image renderer. The four default
// bots (yumu/kanon/hydrant/lazybot) all share this single implementation.
// This table is DERIVED from server/bots/capabilityCatalog.ts — do not add a
// name or description here by hand.
export const INTERNAL_CAPABILITIES: ReadonlyArray<{ name: string }> = capabilityNames().map(
  (name) => ({ name }),
);

export function internalCapabilitySupported(name: string): boolean {
  return INTERNAL_CAPABILITIES.some((c) => c.name === name);
}

// Legacy: per-bot command allowlist used by external QQ-bot routing.
const INTERNAL_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  yumu: new Set(['recent', 'info', 'bp', 'skill', 'ppplus', 'profile']),
  kanon: new Set(['recent', 'info', 'bp']),
  hydrant: new Set(['profile', 'ppplus']),
  lazybot: new Set(['recent', 'bp', 'card', 'bplist', 'profile']),
};

export function availableCommands(bot: BotDefinition): BotCommand[] {
  if (bot.channel !== 'internal') return bot.commands || [];
  const implemented = INTERNAL_COMMANDS[bot.id];
  if (!implemented) return [];
  return (bot.commands || []).filter((command) => implemented.has(command.name));
}

function normalizedCommand(value: string): string {
  return String(value || '').trim().replace(/[ \t]+/g, ' ').toLocaleLowerCase();
}

export function findCommand(bot: BotDefinition, commandName: string): BotCommand | undefined {
  const target = normalizedCommand(commandName);
  if (!target) return undefined;
  return availableCommands(bot).find(
    (command) =>
      normalizedCommand(command.name) === target ||
      normalizedCommand(command.trigger) === target
  );
}

// ── Build LLM tool schemas ──
// External bots (yumu/kanon/hydrant/lazybot) run independently on their QQ
// channels. The harness uses a single unified internal tool for osu! data.

export function buildBotToolSchemas(
  registry: BotRegistry,
  options: { surface?: AgentToolSurface } = {},
): LlmTool[] {
  const hasInternal = enabledBots(registry).some((b) => b.channel === 'internal');
  const tools: LlmTool[] = [];

  if (hasInternal) {
    if (options.surface === 'v2') {
      tools.push(...buildV2OsuAgentToolSchemas());
      tools.push(buildSkillProfilerToolSchema());
    } else {
      tools.push({
        type: 'function',
        function: {
          name: 'query_osu',
          description: buildQueryOsuDescription(),
          parameters: {
            type: 'object',
            properties: {
              capability: {
                type: 'string',
                enum: callableCapabilities(),
                description: '查询类型'
              },
              ...Object.fromEntries(
                QUERY_OSU_PARAMS
                  .filter((param) => param.exposed)
                  .map((param) => [param.name, queryOsuParamJsonSchema(param)]),
              )
            },
            required: ['capability']
          }
        }
      });
    }
  }

  // R3 dead-path cleanup: query_external_bot must NEVER be emitted as an LLM
  // schema. Its executor backend remains in executor.ts and guard.ts keeps
  // rejecting it (VISIBLE_BUT_UNCALLABLE has been removed by making it
  // INVISIBLE_BUT_BACKEND_PRESENT). The QQ relay path is unchanged.
  //
  // The legacy query_bot / list_bots / get_recent_score tools are also
  // deliberately not LLM-visible here; their executor implementations stay
  // dormant until a future explicit exposure decision.

  tools.push({
    type: 'function',
    function: {
      name: 'get_player_skill',
      description: options.surface === 'v2'
        ? '获取已记录的玩家 osu! 技能水平快照（PP、排名、领域强弱、常用 Mods、分析摘要）。注意：这是之前分析时保存的快照，可能过时，且不含最近成绩；实时状态必须调用当前可见的实时玩家数据工具。'
        : '获取已记录的玩家 osu! 技能水平快照（PP、排名、领域强弱、常用 Mods、分析摘要）。注意：这是之前分析时保存的快照，可能过时，且不含最近成绩。查询实时数据（最近成绩、最新 PP、当前状态）必须用 query_osu。',
      parameters: {
        type: 'object',
        properties: { player: { type: 'string', description: 'osu! 用户名或 QQ 号' } },
        required: ['player']
      }
    }
  });

  return tools;
}

// ── Build a compact skill context block for prompt injection ──

export function skillContextBlock(
  registry: BotRegistry,
  skillStore: { records?: { userId: string; osuUsername: string; pp: number; rank: number; summary: string; ppPlus?: Record<string, number>; topMods?: string[] }[] }
): string {
  const records = skillStore?.records || [];
  if (records.length === 0) return '';

  const lines: string[] = ['', '【已记录的玩家技能水平】', '你之前分析过以下玩家的 osu! 数据。在日常对话中，你可以自然地提到他们的水平——不需要背诵数据，而是像朋友一样记住他们的特点。', '这些记录是历史快照（保存于分析时），可能过时。涉及玩家最近成绩、最近是否游玩、当前状态时必须调用 query_osu 实时查询，禁止用快照或历史对话推断。'];

  for (const r of records) {
    const mods = r.topMods?.length ? `常用 Mods: ${r.topMods.join('、')}` : '';
    const ppPlus = r.ppPlus ? Object.entries(r.ppPlus)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(1)}`)
      .join('、') : '';

    lines.push(
      `- ${r.osuUsername}（QQ:${r.userId}）：PP ${r.pp?.toLocaleString() ?? '未知'}，全球 #${r.rank?.toLocaleString() ?? '未知'}。` +
      (ppPlus ? `擅长维度：${ppPlus}。` : '') +
      (mods ? mods : '') +
      `\n  评价摘要：${r.summary || '暂无'}`
    );
  }

  lines.push('使用原则：只在相关时自然提及，不背数据、不生硬复述。如果玩家最近的表现和记录有矛盾，以实时查询结果为准。');
  return lines.join('\n');
}
