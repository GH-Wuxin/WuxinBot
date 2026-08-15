// capability-single-source-verify.mjs
//
// Acceptance gate for the single-source capability catalog refactor. It proves
// that deriving tool schema / guard allowlists from capabilityCatalog.ts did
// not change any externally visible contract:
//   - capability inventory identical to the pre-refactor baseline
//   - tool inventory identical (internal registry and external-bot registry)
//   - query_osu JSON schema byte-equivalent to the pre-refactor baseline
//   - permission/guard behavior identical (including the intentional
//     pplus alias rejection and ppplus canonical acceptance)
//   - schema/guard are actually DERIVED from the catalog (not another copy)

import {
  AGENT_CAPABILITY_META,
  auditAgentCapabilityRegistry,
  buildQueryOsuDescription,
  callableCapabilities,
} from '../server/bots/agentCapabilities.ts';
import {
  CAPABILITY_CATALOG,
  normalizeCapabilityName,
  QUERY_OSU_PARAMS,
  queryOsuParamJsonSchema,
} from '../server/bots/capabilityCatalog.ts';
import { buildBotToolSchemas, INTERNAL_CAPABILITIES } from '../server/bots/registry.ts';
import { validateOperation } from '../server/bots/guard.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`PASS: ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${message}${a !== e ? `\n  got:      ${a}\n  expected: ${e}` : ''}`);
}

/** JSON equivalence independent of object key insertion order. */
function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item).sort().map((key) => [key, item[key]]),
      );
    }
    return item;
  });
}

function assertSemanticEqual(actual, expected, message) {
  const a = stableJson(actual);
  const e = stableJson(expected);
  assert(a === e, `${message}${a !== e ? `\n  got:      ${a}\n  expected: ${e}` : ''}`);
}

// ── Pre-refactor baseline ────────────────────────────────────────────────

const BASELINE_CAPABILITIES = [
  'bp',
  'bp_type',
  'recent',
  'info',
  'profile',
  'ppplus',
  'skill',
  'recommend',
  'match',
  'beatmap_lookup',
  'pp_calc',
  'leaderboard',
];

const BASELINE_DESCRIPTION =
  '查询 osu! 数据（Wuxin 内部：osu! API v2、PP+、skill store、rosu pp 估算；图片由 yumu-image 渲染）。可用查询：' +
  BASELINE_CAPABILITIES.map((capability) => {
    const entry = {
      bp: 'bp（最佳成绩（单张 #N 或范围 N-M，最多 100 张，一张图））',
      bp_type: 'bp_type（BP 谱面类型分析（用户问 BP 类型/占比/结构/构成/串图/跳图/aim/alt/tech/stream 时调用；osu!oracle 对 Top100 分类，仅 osu!std，训练范围约 5★-9★，结果按真实分布回复，禁止编造））',
      recent: 'recent（最近一次 osu! 成绩（含图片））',
      info: 'info（玩家信息卡（含图片））',
      profile: 'profile（玩家资料文本）',
      ppplus: 'ppplus（PP+ 维度分析）',
      skill: 'skill（玩家技能雷达）',
      recommend: 'recommend（谱面推荐（协同过滤：与你同分段的玩家在打的图；玩家要求推图/推荐谱面/打什么图/有没有适合我的图时调用，数据来自 osu! API v2））',
      match: 'match（osu! 多人比赛观战（!ml <matchID> 开始监听对局并推送开局/回合成绩；玩家说“观战/比赛直播/!ml”时引导使用快捷指令））',
      beatmap_lookup: 'beatmap_lookup（谱面信息与星数（玩家问“这图多少星/多少 AR/多久/谁做的”时调用；beatmap_id 必填；可选 mods 返回官方带 mod 星数））',
      pp_calc: 'pp_calc（估算某张图给定 acc/combo/miss 的 pp（rosu 估算，不是官方精确值；beatmap_id 必填，可选 mods/accuracy(0-100)/combo/misses；回复时必须说明是估算值）。SS/FC 估算就是 accuracy=100、misses=0、combo=max_combo。用户说“我bp1/我bp几”时没有 beatmap_id：先调 capability=bp 取该 BP 的谱面（beatmap_id 与 mods），再调本 capability；玩家问“如果我bp1 SS 了能有多少 pp”这类假设题必须走这条链实际计算，禁止直接编数字）',
      leaderboard: 'leaderboard（谱面全球榜单（玩家问“榜一多少/前几是谁”时调用；beatmap_id 必填，可选 mods/limit(1-50)））',
    };
    return entry[capability];
  }).join('；') +
  '。玩家要求推图/推荐谱面/打什么图时使用 capability=recommend，username 可填任意 osu! 用户名（不需要提问者已绑定）。数据来自真实 API，不是你凭记忆编的。pp_calc 返回的是 rosu 估算值，引用时说明是估算。没有 capability 枚举之外的查询类型，禁止编造参数。回答中出现的任何 pp/星数/acc/排名数字都必须来自工具返回：玩家要精确计算而你还没调用对应工具时，必须先调用工具再答；工具没返回或失败时禁止报数（哪怕标注“大概”），只能说明还没算出来或服务不可用。玩家上轮说“要/好/算/帮我算”确认时，先真的调用工具计算再回复，不能只查一次成绩就说“算好了”。不要在你的回复正文里输出任何 XML/DSML/tool_calls 格式的调用文本，工具调用只通过结构化 tool_calls 执行。';

const BASELINE_QUERY_OSU_SCHEMA = {
  type: 'object',
  properties: {
    capability: {
      type: 'string',
      enum: BASELINE_CAPABILITIES,
      description: '查询类型',
    },
    username: {
      type: 'string',
      description: 'osu! 用户名。不填则用提问玩家的绑定账号。',
    },
    bot: {
      type: 'string',
      enum: ['yumu', 'kanon', 'hydrant', 'lazybot'],
      description: '用户点名要用的 bot（雨沐/猫猫/消防栓/LazyBot）时填对应 id；不填默认用雨沐渲染。',
    },
    bp_rank: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'BP 单张名次，与 bp_start/bp_end 互斥。',
    },
    bp_start: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'BP 范围起始（含），与 bp_end 同时填，最多 20 张。与 bp_rank 互斥。',
    },
    bp_end: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'BP 范围结束（含）。',
    },
    beatmap_id: {
      type: 'integer',
      minimum: 1,
      description: '谱面 ID（beatmap_lookup / pp_calc / leaderboard 必填）。',
    },
    mods: {
      type: 'string',
      description: 'mod 组合，成对双字母，如 HDHR / HDDT（beatmap_lookup / pp_calc / leaderboard 可选）。',
    },
    accuracy: {
      type: 'number',
      minimum: 0.01,
      maximum: 100,
      description: 'acc 百分比（pp_calc 用，0-100；不填按 100 算）。',
    },
    combo: {
      type: 'integer',
      minimum: 0,
      description: '连击数（pp_calc 用；不填按 FC/max combo 算）。',
    },
    misses: {
      type: 'integer',
      minimum: 0,
      maximum: 999,
      description: 'miss 数（pp_calc 用；不填按 0 算）。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: '榜单条数（leaderboard 用；不填 10 条）。',
    },
  },
  required: ['capability'],
};

// ── Consistency gate ─────────────────────────────────────────────────────

console.log('=== single source: capability catalog ===');
assertEqual(
  auditAgentCapabilityRegistry(),
  [],
  'agent meta and executor catalog agree',
);

console.log('\n=== capability inventory identical ===');
assertEqual(callableCapabilities(), BASELINE_CAPABILITIES, 'callable capability inventory');
assertEqual(
  INTERNAL_CAPABILITIES.map((entry) => entry.name),
  BASELINE_CAPABILITIES,
  'executor registry capability inventory',
);
assertEqual(
  AGENT_CAPABILITY_META.map((entry) => entry.capability),
  BASELINE_CAPABILITIES,
  'agent capability meta inventory',
);

console.log('\n=== pplus/ppplus alias cleanup without behavior change ===');
assertEqual(normalizeCapabilityName('pplus'), 'ppplus', 'command alias pplus -> canonical ppplus');
assertEqual(normalizeCapabilityName('ppplus'), 'ppplus', 'canonical ppplus stays ppplus');
assertEqual(
  CAPABILITY_CATALOG.find((entry) => entry.name === 'ppplus')?.aliases,
  ['pplus'],
  'pplus is declared as the only command-side alias',
);

console.log('\n=== tool inventory identical ===');
{
  const internalRegistry = {
    updatedAt: '',
    bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }],
  };
  const internalNames = buildBotToolSchemas(internalRegistry).map((tool) => tool.function.name);
  assertEqual(internalNames, ['query_osu', 'get_player_skill'], 'internal-registry tool inventory');

  const externalRegistry = {
    updatedAt: '',
    bots: [{
      id: 'external-fixture',
      name: '外部测试机器人',
      description: 'fixture',
      qq: '900000001',
      channel: 'qq_private',
      enabled: true,
      commands: [],
    }],
  };
  const externalNames = buildBotToolSchemas(externalRegistry).map((tool) => tool.function.name);
  assertEqual(externalNames, ['get_player_skill'], 'external-registry tool inventory');
  assert(!externalNames.includes('query_external_bot'), 'query_external_bot is never emitted even for an external registry');
}

console.log('\n=== R3 exposure: dormant backends stay out of every generated schema ===');
{
  const internalRegistry = {
    updatedAt: '',
    bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }],
  };
  const externalRegistry = {
    updatedAt: '',
    bots: [{
      id: 'external-fixture',
      name: '外部测试机器人',
      description: 'fixture',
      qq: '900000001',
      channel: 'qq_private',
      enabled: true,
      commands: [],
    }],
  };
  for (const registry of [internalRegistry, externalRegistry]) {
    const names = buildBotToolSchemas(registry).map((tool) => tool.function.name);
    for (const dormant of ['query_external_bot', 'query_bot', 'list_bots', 'get_recent_score']) {
      assert(!names.includes(dormant), `${dormant} must not be LLM-visible`);
    }
  }
}

console.log('\n=== tool schema byte-equivalent ===');
{
  const registry = {
    updatedAt: '',
    bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }],
  };
  const tools = buildBotToolSchemas(registry);
  const queryOsu = tools.find((tool) => tool.function.name === 'query_osu');
  assertEqual(queryOsu.function.description, BASELINE_DESCRIPTION, 'query_osu description');
  assertSemanticEqual(queryOsu.function.parameters, BASELINE_QUERY_OSU_SCHEMA, 'query_osu JSON schema');
}

console.log('\n=== schema is DERIVED from catalog, not copied ===');
{
  const derivedProperties = Object.fromEntries(
    QUERY_OSU_PARAMS
      .filter((param) => param.exposed)
      .map((param) => [param.name, queryOsuParamJsonSchema(param)]),
  );
  const baselineProperties = BASELINE_QUERY_OSU_SCHEMA.properties;
  const baselineParams = Object.keys(baselineProperties).filter((name) => name !== 'capability');
  assertEqual(Object.keys(derivedProperties), baselineParams, 'exposed parameter key order');
  assertSemanticEqual(
    derivedProperties,
    Object.fromEntries(baselineParams.map((name) => [name, baselineProperties[name]])),
    'exposed parameter schemas',
  );
}

console.log('\n=== guard behavior identical ===');
{
  // Canonical capabilities keep working exactly as before.
  const canonicalCases = [
    { type: 'query_osu', params: { capability: 'recent' } },
    { type: 'query_osu', params: { capability: 'bp', bp_rank: 1 } },
    { type: 'query_osu', params: { capability: 'ppplus' } },
    { type: 'query_osu', params: { capability: 'beatmap_lookup', beatmap_id: 5518740 } },
    { type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, accuracy: 99, combo: 1200, misses: 1 } },
    { type: 'query_osu', params: { capability: 'leaderboard', beatmap_id: 5518740, limit: 5 } },
  ];
  for (const op of canonicalCases) {
    assertEqual(validateOperation(op), { ok: true }, `guard accepts canonical ${op.params.capability}`);
  }

  // The legacy quick-side alias is not an agent capability. The LLM enum has
  // never contained `pplus`, so guard must keep rejecting it.
  assertEqual(
    validateOperation({ type: 'query_osu', params: { capability: 'pplus' } }).ok,
    false,
    'guard still rejects pplus alias',
  );

  // query_external_bot remains outside the whitelist even though its schema can
  // be generated for an external registry.
  assertEqual(
    validateOperation({ type: 'query_external_bot', params: { bot: 'x', command: 'y' } }).ok,
    false,
    'guard still rejects query_external_bot',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
