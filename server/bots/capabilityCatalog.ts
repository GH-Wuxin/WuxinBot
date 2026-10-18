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
  /**
   * 工具面阶段：text = 第一层（取数与分析，纯文本）；image = 第二层（发图）。
   * 缺省按 text 处理，图片能力只会在第一阶段跑完之后才暴露。
   */
  phase?: 'text' | 'image';
  /**
   * True only for capabilities that are real user-facing features available
   * solely through a command (e.g. match watching). Capabilities that were
   * simply retired from the tool surface are NOT command-only and must not be
   * advertised in the per-turn capability summary.
   */
  commandOnly?: boolean;
}

export const CAPABILITY_CATALOG: readonly CapabilityDescriptor[] = [
  {
    name: 'bp',
    description: '玩家第 N 张 BP 的完整成绩：谱面名、BID、mods、acc、combo、pp、名次。用户问“我的 BP3 多少 pp / 是什么图 / 什么 mod”时用；一次只查一张。要多张用 osu_get_best_scores，要看类型分布用 osu_analyze_best_score_types。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'bp_range',
    description: '玩家 BP 区间成绩（N-M，最多 100 张）：每张返回名次、谱面名、BID、mods、acc、pp。用户要“BP1-BP10 / 前 50 张 / 最近十张 BP”时用；只想看其中某一张的细节再用 osu_get_best_score。',
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
    description: '最近一次 osu! 成绩（已从工具面移除，仅保留给指令路径）',
    callable: false,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'info',
    description: '玩家信息卡（已从工具面移除，资料卡与 profile 重复）',
    callable: false,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'profile',
    description: '玩家账号资料：PP、全球/国家排名、准确率、游玩次数、总时长、常用 mods。问“这人什么水平 / 多少 pp / 排名多少”时用；不含 BP 明细，也不含技能画像（技能用 osu_player_skill）。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'ppplus',
    description: 'PP+ 维度分析：各维度相对基准线 15 的数值。问“他偏什么类型 / 哪项强”时用；这是 PP+ 口径，BP50 加权的技能画像用 osu_player_skill，两者不能混着说。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    aliases: ['pplus'],
  },
  {
    name: 'skill',
    description: '玩家技能雷达（与 pp_plus 是同一份数据，已合并）',
    callable: false,
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
    commandOnly: true,
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
    name: 'beatmap_skill',
    description: '谱面九维需求分析（v0.40 本地分析：Jump Aim、Flow Aim、Aim Control、Spatial Precision、Raw Speed、Finger Control、Reading、Stamina、Endurance）。用户问“这张图难在哪/是什么类型/哪个维度吃力”时调用；可以给 beatmap_id，也可以用 bp_rank 指向某玩家第几张 BP。这是谱面需求，不是玩家能力，也不是官方星数；本地没有的图会明确说明。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
  },
  {
    name: 'player_skill',
    description: '玩家 BP50 技能画像：九维能力值、tier、archetype、样本质量。回答“他水平怎么样/强在哪/什么类型”时调用；基于 BP50，不代表最近状态（最近用 recent_skill）。首次计算要逐张分析谱面，可能较慢。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'recent_skill',
    description: '玩家近期表现：最近 5 天、最近 50 条成绩起步，给出近期需求与波动。回答“最近状态怎么样/这周打得如何”时调用；比 player_skill 更慢，首次可能几十秒。只反映近期，不代表长期水平。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'score_image',
    description: '把成绩画成卡片发给用户（第二层，只在取数完成后可用）。source=bp 画单张 BP；bp_range 画区间长图；recent_play 画最近一次游玩；recent_pass 画最近一次通过；beatmap_score 画某张谱面的成绩。什么时候用：用户想看图，或一张成绩卡比文字更有说服力。什么时候别用：这轮没查过对应数据、只是聊数据、用户没要图。返回一张图 + 一句摘要，图会直接进回复。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    phase: 'image',
  },
  {
    name: 'player_card_image',
    description: '把玩家资料画成卡片（第二层）。什么时候用：用户说“来张资料卡/看看我的卡片”。什么时候别用：只想看数字，或这轮没查过资料。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    phase: 'image',
  },
  {
    name: 'beatmap_card_image',
    description: '把谱面信息画成卡片（第二层）。需要 beatmap_id。什么时候用：用户想看这张图长什么样。什么时候别用：只问星数/长度，文字已经够了。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
    phase: 'image',
  },
  {
    name: 'beatmap_skill_image',
    description: '把谱面九维技能分析画成卡片（第二层）。依赖第一层的 osu_beatmap_skill；没有可用缓存时会现算一次。什么时候用：用户想看技能雷达图。什么时候别用：只想知道数值。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'beatmap',
    phase: 'image',
  },
  {
    name: 'player_skill_image',
    description: '把玩家 BP50 技能画像画成卡片（第二层）。依赖第一层的 osu_player_skill。什么时候用：用户想看技能画像图。什么时候别用：只想读结论。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    phase: 'image',
  },
  {
    name: 'skill_compare_image',
    description: '把两人技能对比画成卡片（第二层）。需要 left/right，依赖第一层的 osu_compare_skill。什么时候用：用户想看对比图。什么时候别用：只想读结论。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    phase: 'image',
  },
  {
    name: 'recent_skill_image',
    description: '把近期表现画成卡片（第二层）。依赖第一层的 osu_recent_skill。什么时候用：用户想看近期状态图。什么时候别用：只想读数值。返回一张图 + 摘要。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
    phase: 'image',
  },
  {
    name: 'compare_skill',
    description: '两个玩家的 BP50 技能对比：逐维差值 + 明显强弱项。用户问“A 和 B 谁强/对比一下”时调用；需要两个不同玩家。单个玩家的画像用 player_skill。',
    callable: true,
    sideEffects: 'readonly',
    rollout: 'all',
    family: 'player',
  },
  {
    name: 'leaderboard',
    description: '谱面全球榜单：榜前玩家、acc、分数、mods。用户问“榜一多少 / 前几是谁”时用；beatmap_id 必填，可选 mods 和 limit(1-50)。它不返回国内榜，也不能替代玩家自己的成绩。',
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

/**
 * Canonical names in catalog order. This is the exact LLM enum order.
 * phase 默认 text：第二层（发图）能力不会混进第一层的工具面。
 */
export function callableCapabilityNames(phase: 'text' | 'image' = 'text'): CapabilityName[] {
  return CAPABILITY_CATALOG
    .filter((capability) => capability.callable && (capability.phase === 'image') === (phase === 'image'))
    .map((capability) => capability.name);
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
    // compare_skill / skill_compare_image 用 left/right 指定玩家；beatmap_skill 允许按玩家 BP 名次定位。
    allowedFor: [...PLAYER_CAPABILITY_NAMES]
      .filter((name) => name !== 'compare_skill' && name !== 'skill_compare_image')
      .concat(['beatmap_skill']) as readonly CapabilityName[],
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
    schemaDescription: 'BP 单张名次。仅 capability=bp 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp', 'beatmap_skill', 'score_image'] as readonly CapabilityName[],
  },
  {
    name: 'bp_start',
    schemaType: 'integer',
    schemaDescription: 'BP 范围起始（含），与 bp_end 同时填，最多 100 张。仅 capability=bp_range / score_image 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp_range', 'score_image'] as readonly CapabilityName[],
  },
  {
    name: 'bp_end',
    schemaType: 'integer',
    schemaDescription: 'BP 范围结束（含）。仅 capability=bp_range / score_image 使用。',
    exposed: true,
    minimum: 1,
    maximum: 100,
    allowedFor: ['bp_range', 'score_image'] as readonly CapabilityName[],
  },
  {
    name: 'beatmap_id',
    schemaType: 'integer',
    schemaDescription: '谱面 ID（beatmap_lookup / pp_calc / leaderboard 必填）。',
    exposed: true,
    minimum: 1,
    allowedFor: [...BEATMAP_CAPABILITY_NAMES, 'score_image'] as readonly CapabilityName[],
    requiredFor: ['beatmap_lookup', 'pp_calc', 'leaderboard', 'beatmap_card_image', 'beatmap_skill_image'] as readonly CapabilityName[],
    missingMessage: '需要有效的 beatmap_id',
  },
  {
    name: 'mods',
    schemaType: 'string',
    schemaDescription: 'mod 组合，成对双字母，如 HDHR / HDDT（仅 beatmap_lookup / pp_calc / leaderboard 使用）。',
    exposed: true,
    maxLength: 16,
    pattern: '^([A-Za-z]{2})*$',
    allowedFor: [...BEATMAP_CAPABILITY_NAMES, 'score_image'] as readonly CapabilityName[],
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
    name: 'source',
    schemaType: 'string',
    schemaDescription: '要画哪一种成绩：bp（单张 BP）、bp_range（BP 区间）、recent_play（最近游玩）、recent_pass（最近通过）、beatmap_score（某谱面成绩）。仅 score_image 使用。',
    exposed: true,
    schemaEnum: ['bp', 'bp_range', 'recent_play', 'recent_pass', 'beatmap_score'],
    allowedFor: ['score_image'] as readonly CapabilityName[],
    requiredFor: ['score_image'] as readonly CapabilityName[],
    missingMessage: 'score_image 需要 source',
  },
  {
    name: 'left',
    schemaType: 'string',
    schemaDescription: '对比的左方玩家（compare_skill 必填，osu! 用户名）。',
    exposed: true,
    maxLength: 128,
    allowedFor: ['compare_skill', 'skill_compare_image'] as readonly CapabilityName[],
    requiredFor: ['compare_skill', 'skill_compare_image'] as readonly CapabilityName[],
    missingMessage: '对比需要 left 玩家名',
  },
  {
    name: 'right',
    schemaType: 'string',
    schemaDescription: '对比的右方玩家（compare_skill 必填，osu! 用户名）。',
    exposed: true,
    maxLength: 128,
    allowedFor: ['compare_skill', 'skill_compare_image'] as readonly CapabilityName[],
    requiredFor: ['compare_skill', 'skill_compare_image'] as readonly CapabilityName[],
    missingMessage: '对比需要 right 玩家名',
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
