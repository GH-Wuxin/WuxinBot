// Single-source capability catalog for the agent tool surface.
//
// This module owns:
//   - the canonical capability names exposed to the LLM (query_osu enum)
//   - the long agent-facing descriptions used to build query_osu.description
//   - the JSON-schema parameter shapes used to build query_osu.parameters
//   - the parameter applicability rules used by guard.ts validation
//   - the command-side alias map (only `pplus` -> `ppplus` is needed today)
//
// Nothing here may import registry.ts / executor.ts / guard.ts. Those modules
// derive from this catalog so there is only one place to add a capability.

export const INTERNAL_BOT_IDS = ['yumu', 'kanon', 'hydrant', 'lazybot'] as const;
export type InternalBotId = (typeof INTERNAL_BOT_IDS)[number];

/**
 * The only bot selector values whose recent execution path is truly distinct:
 * yumu → !r bridge, kanon → !re bridge. hydrant/lazybot have no supported
 * recent selection; bot.ts must degrade those named requests explicitly
 * instead of silently mapping them to yumu.
 */
export const RECENT_BOT_SELECTOR_IDS = ['yumu', 'kanon'] as const;

export interface CapabilityDescriptor {
  /** Canonical capability name. This is exactly the value exposed to the LLM. */
  name: string;
  /** Long description used in query_osu tool description and capability meta. */
  description: string;
  callable: boolean;
  /** Agent-callable capabilities must be readonly; command-only may be stateful. */
  sideEffects: 'readonly' | 'stateful';
  rollout: 'all' | 'owner_canary';
  /** Command-side aliases. `pplus` is the legacy quick-router spelling. */
  aliases?: readonly string[];
  /** Capability family used for guard applicability rules. */
  family: 'player' | 'beatmap';
}

export const CAPABILITY_CATALOG: readonly CapabilityDescriptor[] = [
  {
    name: 'bp',
    description: '最佳成绩（单张 #N 或范围 N-M，最多 100 张，一张图）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'bp_type',
    description: 'BP 谱面类型分析（用户问 BP 类型/占比/结构/构成/串图/跳图/aim/alt/tech/stream 时调用；osu!oracle 对 Top100 分类，仅 osu!std，训练范围约 5★-9★，结果按真实分布回复，禁止编造）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'recent',
    description: '最近一次 osu! 成绩（含图片）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'info',
    description: '玩家信息卡（含图片）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'profile',
    description: '玩家资料文本',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'ppplus',
    description: 'PP+ 维度分析',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    aliases: ['pplus'],
  },
  {
    name: 'skill',
    description: '玩家技能雷达',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'recommend',
    description: '谱面推荐（协同过滤：与你同分段的玩家在打的图；玩家要求推图/推荐谱面/打什么图/有没有适合我的图时调用，数据来自 osu! API v2）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'match',
    description: 'osu! 多人比赛观战（!ml <matchID> 开始监听对局并推送开局/回合成绩；玩家说“观战/比赛直播/!ml”时引导使用快捷指令）',
    // Command-side only. matchManager writes osuMatchListeners, creates a
    // MatchListener and starts continuous polling that later pushes messages
    // to the group, so it violates the Agent readonly contract. It must stay
    // reachable through executeInternalBotCommand / !ml but NOT in the LLM
    // query_osu enum (guard.ts rejects non-callable capabilities).
    callable: false,
    sideEffects: 'stateful',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'beatmap_lookup',
    description: '谱面信息与星数（玩家问“这图多少星/多少 AR/多久/谁做的”时调用；beatmap_id 必填；可选 mods 返回官方带 mod 星数）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
  },
  {
    name: 'pp_calc',
    description: '估算某张图给定 acc/combo/miss 的 pp（rosu 估算，不是官方精确值；beatmap_id 必填，可选 mods/accuracy(0-100)/combo/misses；回复时必须说明是估算值）。SS/FC 估算就是 accuracy=100、misses=0、combo=max_combo。用户说“我bp1/我bp几”时没有 beatmap_id：先调 capability=bp 取该 BP 的谱面（beatmap_id 与 mods），再调本 capability；玩家问“如果我bp1 SS 了能有多少 pp”这类假设题必须走这条链实际计算，禁止直接编数字',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
  },
  {
    name: 'leaderboard',
    description: '谱面全球榜单（玩家问“榜一多少/前几是谁”时调用；beatmap_id 必填，可选 mods/limit(1-50)）',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
  },
] as const;

export type CapabilityName = (typeof CAPABILITY_CATALOG)[number]['name'];

const NAME_TO_CAPABILITY = new Map<string, CapabilityDescriptor>(
  CAPABILITY_CATALOG.map((capability) => [capability.name, capability]),
);

const ALIAS_TO_CAPABILITY = new Map<string, CapabilityDescriptor>();
for (const capability of CAPABILITY_CATALOG) {
  for (const alias of capability.aliases || []) {
    ALIAS_TO_CAPABILITY.set(alias, capability);
  }
}

export function findCapability(name: string): CapabilityDescriptor | undefined {
  return NAME_TO_CAPABILITY.get(name);
}

/** True when this is the canonical agent-exposed name. */
export function isCallableCapability(name: string): boolean {
  return Boolean(NAME_TO_CAPABILITY.get(name)?.callable);
}

/**
 * Resolve a command-side alias to its canonical capability name.
 * The legacy quick-router spelling `pplus` resolves to canonical `ppplus`;
 * unknown values pass through so executor error messages stay unchanged.
 */
export function normalizeCapabilityName(name: string): string {
  return ALIAS_TO_CAPABILITY.get(name)?.name || name;
}

/** Canonical names in catalog order. This is the exact LLM enum order. */
export function callableCapabilityNames(): CapabilityName[] {
  return CAPABILITY_CATALOG.filter((capability) => capability.callable).map((capability) => capability.name);
}

export function capabilityNames(): CapabilityName[] {
  return CAPABILITY_CATALOG.map((capability) => capability.name);
}

export function capabilityDescription(name: string): string {
  return NAME_TO_CAPABILITY.get(name)?.description || '';
}

export const PLAYER_CAPABILITY_NAMES = new Set(
  CAPABILITY_CATALOG.filter((capability) => capability.family === 'player').map((capability) => capability.name),
);

export const BEATMAP_CAPABILITY_NAMES = new Set(
  CAPABILITY_CATALOG.filter((capability) => capability.family === 'beatmap').map((capability) => capability.name),
);

export const PP_CALC_CAPABILITY = 'pp_calc' as const;
export const LEADERBOARD_CAPABILITY = 'leaderboard' as const;
export const BEATMAP_ID_PARAM = 'beatmap_id' as const;

export interface CapabilityParamSpec {
  name: string;
  /** JSON-schema type for the LLM tool schema. */
  schemaType: 'string' | 'integer' | 'number' | 'boolean';
  /** Description emitted in the LLM tool schema. */
  schemaDescription: string;
  /** Whether this parameter appears in the LLM tool schema. */
  exposed: boolean;
  schemaEnum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  /** ECMAScript pattern mirroring the guard lexical gate. */
  pattern?: string;
  /**
   * Capabilities this parameter may accompany. When undefined the parameter
   * is allowed for every capability.
   */
  allowedFor?: readonly CapabilityName[];
  /**
   * Capabilities for which this parameter is required (guard-time, not schema
   * required).
   */
  requiredFor?: readonly CapabilityName[];
  /** Suffix for the guard error when a requiredFor capability omits it. */
  missingMessage?: string;
}

export const QUERY_OSU_PARAMS: readonly CapabilityParamSpec[] = [
  {
    name: 'username',
    schemaType: 'string',
    schemaDescription: 'osu! 用户名。不填则用提问玩家的绑定账号。',
    exposed: true,
    maxLength: 128,
    allowedFor: [...PLAYER_CAPABILITY_NAMES] as readonly CapabilityName[],
  },
  {
    name: 'bot',
    schemaType: 'string',
    schemaDescription: '用户点名要用的 bot 时填对应 id。仅 capability=recent 使用：yumu → !r，kanon → !re；其他 bot 点名会由系统明确提示并降级为内部查询。其他查询类型请勿填写。',
    exposed: true,
    schemaEnum: RECENT_BOT_SELECTOR_IDS,
    allowedFor: ['recent'] as readonly CapabilityName[],
  },
  {
    name: 'bp_rank',
    schemaType: 'integer',
    schemaDescription: 'BP 单张名次，与 bp_start/bp_end 互斥。仅 capability=bp 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp'] as readonly CapabilityName[],
  },
  {
    name: 'bp_start',
    schemaType: 'integer',
    schemaDescription: 'BP 范围起始（含），与 bp_end 同时填，最多 100 张。与 bp_rank 互斥。仅 capability=bp 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp'] as readonly CapabilityName[],
  },
  {
    name: 'bp_end',
    schemaType: 'integer',
    schemaDescription: 'BP 范围结束（含）。仅 capability=bp 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp'] as readonly CapabilityName[],
  },
  {
    name: 'beatmap_id',
    schemaType: 'integer',
    schemaDescription: '谱面 ID（beatmap_lookup / pp_calc / leaderboard 必填）。',
    exposed: true,
    minimum: 1,
    allowedFor: [...BEATMAP_CAPABILITY_NAMES] as readonly CapabilityName[],
    requiredFor: [...BEATMAP_CAPABILITY_NAMES] as readonly CapabilityName[],
    missingMessage: '需要有效的 beatmap_id',
  },
  {
    name: 'mods',
    schemaType: 'string',
    schemaDescription: 'mod 组合，成对双字母，如 HDHR / HDDT（仅 beatmap_lookup / pp_calc / leaderboard 使用）。',
    exposed: true,
    maxLength: 16,
    pattern: '^([A-Za-z]{2})*$',
    allowedFor: [...BEATMAP_CAPABILITY_NAMES] as readonly CapabilityName[],
  },
  {
    name: 'accuracy',
    schemaType: 'number',
    schemaDescription: 'acc 百分比（pp_calc 用，0-100；不填按 100 算）。',
    exposed: true,
    minimum: 0.01,
    maximum: 100,
    allowedFor: [PP_CALC_CAPABILITY],
  },
  {
    name: 'combo',
    schemaType: 'integer',
    schemaDescription: '连击数（pp_calc 用；不填按 FC/max combo 算）。',
    exposed: true,
    minimum: 0,
    allowedFor: [PP_CALC_CAPABILITY],
  },
  {
    name: 'misses',
    schemaType: 'integer',
    schemaDescription: 'miss 数（pp_calc 用；不填按 0 算）。',
    exposed: true,
    minimum: 0,
    maximum: 999,
    allowedFor: [PP_CALC_CAPABILITY],
  },
  {
    name: 'limit',
    schemaType: 'integer',
    schemaDescription: '榜单条数（leaderboard 用；不填 10 条）。',
    exposed: true,
    minimum: 1,
    maximum: 50,
    allowedFor: [LEADERBOARD_CAPABILITY],
  },
  // compact is accepted by the runtime/guard for BP list rendering but is
  // deliberately not exposed in the LLM schema. Runtime consumes it only for
  // capability=bp.
  {
    name: 'compact',
    schemaType: 'boolean',
    schemaDescription: '',
    exposed: false,
    allowedFor: ['bp'] as readonly CapabilityName[],
  },
] as const;

export type QueryOsuParamName = (typeof QUERY_OSU_PARAMS)[number]['name'];

const PARAM_BY_NAME = new Map<string, CapabilityParamSpec>(QUERY_OSU_PARAMS.map((param) => [param.name, param]));

export function queryOsuParam(name: string): CapabilityParamSpec | undefined {
  return PARAM_BY_NAME.get(name);
}

export function queryOsuParamAllowed(param: CapabilityParamSpec, capability: string): boolean {
  return !param.allowedFor || param.allowedFor.includes(capability as CapabilityName);
}

export function queryOsuParamRequiredFor(param: CapabilityParamSpec, capability: string): boolean {
  return Boolean(param.requiredFor && param.requiredFor.includes(capability as CapabilityName));
}

export function queryOsuParamNames(): QueryOsuParamName[] {
  return QUERY_OSU_PARAMS.map((param) => param.name);
}

/**
 * Build the exact JSON schema fragment for one query_osu parameter.
 * Exposed parameters are emitted in catalog order, so the LLM tool schema is
 * byte-for-byte stable and identical to the pre-catalog hand-written schema.
 */
export function queryOsuParamJsonSchema(param: CapabilityParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: param.schemaType };
  if (param.schemaDescription) schema.description = param.schemaDescription;
  if (param.schemaEnum) schema.enum = [...param.schemaEnum];
  if (param.minimum !== undefined) schema.minimum = param.minimum;
  if (param.maximum !== undefined) schema.maximum = param.maximum;
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength;
  if (param.pattern) schema.pattern = param.pattern;
  return schema;
}
