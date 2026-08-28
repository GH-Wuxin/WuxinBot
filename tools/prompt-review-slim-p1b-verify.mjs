// WUXINBOT_PROMPT_REVIEW_SLIM_V01_P1B verification.
// Verifies conditional tool-guidance injection without changing production
// metadata, tool schema, routing, permissions or the planner loop.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = createTestDataDir('prompt-review-slim-p1b');
process.env.DATA_DIR = testDataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(testDataDir);

const { ensureStore } = await import('../server/store.ts');
ensureStore();

const { buildPrompt } = await import('../server/bot/prompt.ts');
const {
  buildToolGuidance,
  buildToolGuidanceFromMetadata,
  TOOL_GUIDANCE_VERSION,
} = await import('../server/bots/toolGuidance.ts');
const { buildBotToolSchemas, DEFAULT_BOTS } = await import('../server/bots/registry.ts');
const {
  AGENT_CAPABILITY_META,
  buildQueryOsuDescription,
  callableCapabilities,
} = await import('../server/bots/agentCapabilities.ts');
const { CAPABILITY_CATALOG, RECENT_BOT_SELECTOR_IDS } = await import('../server/bots/capabilityCatalog.ts');
const { AGENT_MAX_TOOL_CALLS_PER_RESPONSE, AGENT_MAX_TOOL_CALLS_PER_TURN } = await import('../server/bots/executor.ts');
const { detectRequiredOsuTool, detectBpTypeAnalysisIntent } = await import('../server/bots/intent.ts');

const p1bDir = path.join(root, 'tmp', 'prompt_review_slim_v01_p1b');
const baselineGuidancePath = path.join(p1bDir, 'p1a_guidance_baseline.txt');
const schemaBaselinePath = path.join(p1bDir, 'tool_schema_baseline.json');

let failures = 0;
let checks = 0;
function check(cond, label, detail = '') {
  checks += 1;
  if (cond) console.log(`PASS ${label}`);
  else { failures += 1; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`); }
}

const capabilityNames = callableCapabilities();
const fullGuidance = buildToolGuidance();
const canonicalMeta = {
  capabilities: capabilityNames,
  externalBotNames: DEFAULT_BOTS.map((bot) => bot.name),
  recentSelectorIds: RECENT_BOT_SELECTOR_IDS,
};

console.log('=== P1B-1 version + canonical full guidance ===');
check(TOOL_GUIDANCE_VERSION === 'p1b-v1', 'version is p1b-v1', TOOL_GUIDANCE_VERSION);
check(fullGuidance === buildToolGuidance(), 'full guidance deterministic');
check(fullGuidance.length > 0, 'full guidance non-empty');
if (fs.existsSync(baselineGuidancePath)) {
  const baseline = fs.readFileSync(baselineGuidancePath, 'utf8');
  check(fullGuidance === baseline, 'full guidance byte-identical to P1A captured baseline', `len=${fullGuidance.length}`);
  check(fullGuidance.length === 1098, 'full guidance length is 1098 chars', `${fullGuidance.length}`);
} else {
  check(false, 'full guidance baseline file exists');
}
for (const name of capabilityNames) {
  check(fullGuidance.includes(name), `full guidance contains capability ${name}`);
}
for (const bot of canonicalMeta.externalBotNames) {
  check(fullGuidance.includes(bot), `full guidance contains external bot name ${bot}`);
}
for (const selector of canonicalMeta.recentSelectorIds) {
  check(fullGuidance.includes(selector), `full guidance contains recent selector ${selector}`);
}
const fullMeta = buildToolGuidanceFromMetadata(canonicalMeta);
check(fullMeta === fullGuidance, 'full guidance equals metadata assembly');

console.log('\n=== P1B-2 empty exposure ===');
check(buildToolGuidance({ exposedCapabilities: [] }) === '', 'empty exposedCapabilities -> empty guidance');
check(buildToolGuidanceFromMetadata(canonicalMeta, { exposedCapabilities: [] }) === '', 'metadata empty exposure -> empty guidance');
check(
  buildToolGuidanceFromMetadata({ capabilities: [], externalBotNames: [], recentSelectorIds: [] }) === '',
  'empty canonical metadata -> empty guidance',
);

console.log('\n=== P1B-3 unknown capability ids fail closed ===');
check(buildToolGuidance({ exposedCapabilities: ['no_such_capability'] }) === fullGuidance, 'all-unknown exposure -> full guidance');
check(
  buildToolGuidance({ exposedCapabilities: [capabilityNames[0], 'no_such_capability'] }) === fullGuidance,
  'mixed valid+unknown exposure -> full guidance',
);
check(
  buildToolGuidance({ exposedCapabilities: [capabilityNames[0], capabilityNames[0]] }) !== fullGuidance,
  'deduplicated valid subset remains subset guidance',
);

console.log('\n=== P1B-4 per-capability scoping matrix ===');
const scopedPolicyTexts = [
  { id: 'P_BP_TYPE_SCOPED', capabilities: ['bp_type'], text: '涉及 BP 类型/占比/串图/跳图/aim/alt/tech/stream' },
  { id: 'P_RECOMMEND_SCOPED', capabilities: ['recommend'], text: '玩家要求推图/推荐谱面/打什么图时' },
  { id: 'P_PP_CALC_SCOPED', capabilities: ['pp_calc'], text: 'pp 计算必须调用 capability=pp_calc' },
  { id: 'P_RECENT_SCOPED', capabilities: ['recent'], text: 'profile/info/skill 等结果不含 recent' },
];
const globalPolicyTexts = [
  { id: 'P_GLOBAL_NO_FABRICATE', text: '你必须通过 query_osu 获取真实 osu! 数据' },
  { id: 'P_GLOBAL_NO_NUMBERS_WITHOUT_TOOL', text: '任何 pp/星数/acc/排名数字都必须来自工具返回' },
  { id: 'P_GLOBAL_ROUTE_FACTS', text: '日常闲聊不需要工具' },
  { id: 'P_GLOBAL_ATTRIBUTION', text: '引用任何查询结果时必须先说玩家名' },
  { id: 'P_GLOBAL_STD_ONLY', text: '本 bot 只支持 osu!std' },
  { id: 'P_GLOBAL_NO_MARKUP', text: '回复正文永远不要输出 XML/DSML' },
];
function capabilityListLine(text) {
  const marker = '可用查询类型：';
  const line = text.split('\n').find((l) => l.startsWith(marker));
  return line ? line.slice(marker.length).replace(/。.*$/, '') : '';
}
function listedCapabilities(text) {
  const line = capabilityListLine(text);
  return line ? line.split('、').filter(Boolean) : [];
}
const subsetByCapability = new Map();
for (const capability of capabilityNames) {
  const subset = buildToolGuidance({ exposedCapabilities: [capability] });
  subsetByCapability.set(capability, subset);
  check(subset.length > 0, `subset ${capability} non-empty`);
  check(subset.length < fullGuidance.length, `subset ${capability} strictly smaller than full`, `${subset.length}/${fullGuidance.length}`);
  const listed = listedCapabilities(subset);
  check(listed.length === 1 && listed[0] === capability, `subset ${capability} lists exactly that capability`, listed.join(','));
  for (const other of capabilityNames.filter((n) => n !== capability)) {
    check(!listed.includes(other), `subset ${capability} excludes ${other}`, listed.join(','));
  }
  for (const policy of globalPolicyTexts) {
    check(subset.includes(policy.text), `subset ${capability} keeps global policy ${policy.id}`);
  }
  for (const policy of scopedPolicyTexts) {
    const shouldHave = policy.capabilities.includes(capability);
    check(
      subset.includes(policy.text) === shouldHave,
      `subset ${capability} ${shouldHave ? 'keeps' : 'omits'} scoped policy ${policy.id}`,
    );
  }
  const selectorLine = '只有最近成绩查询（capability=recent）可以填 bot 参数';
  check(subset.includes(selectorLine) === (capability === 'recent'), `subset ${capability} recent-selector line correct`);
}
// Cross-subset ordering stability.
const subsetA = buildToolGuidance({ exposedCapabilities: [capabilityNames[0]] });
const subsetB = buildToolGuidance({ exposedCapabilities: [capabilityNames[0]] });
check(subsetA === subsetB, 'subset guidance deterministic');
const subRecent = buildToolGuidance({ exposedCapabilities: ['recent'] });
const subInfo = buildToolGuidance({ exposedCapabilities: ['info'] });
check(!subInfo.includes('capability=recent'), 'info subset contains no recent route fact');
check(subRecent.includes('capability=recent'), 'recent subset contains recent route fact');

console.log('\n=== P1B-5 synthetic policy drift (no production policy mutation) ===');
const syntheticPolicies = [
  { id: 'G_SYN', scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED', text: '合成全局策略-必须存在' },
  { id: 'S_SYN', scope: 'CAPABILITY_SCOPED', requiredCapabilities: ['bp'], text: '合成bp策略-仅bp暴露时存在' },
];
const syntheticMeta = { capabilities: ['bp', 'recent'], externalBotNames: ['雨沐'], recentSelectorIds: ['yumu'] };
const synthFull = buildToolGuidanceFromMetadata(syntheticMeta, undefined, syntheticPolicies);
const synthBp = buildToolGuidanceFromMetadata(syntheticMeta, { exposedCapabilities: ['bp'] }, syntheticPolicies);
const synthRecent = buildToolGuidanceFromMetadata(syntheticMeta, { exposedCapabilities: ['recent'] }, syntheticPolicies);
check(synthFull.includes('合成全局策略-必须存在') && synthFull.includes('合成bp策略-仅bp暴露时存在'), 'synthetic full keeps both policies');
check(synthBp.includes('合成全局策略-必须存在') && synthBp.includes('合成bp策略-仅bp暴露时存在'), 'synthetic bp subset keeps global + bp policy');
check(synthRecent.includes('合成全局策略-必须存在') && !synthRecent.includes('合成bp策略-仅bp暴露时存在'), 'synthetic recent subset keeps global only');
check(synthBp !== synthFull && synthRecent !== synthFull && synthBp !== synthRecent, 'synthetic exposures produce distinct guidance');

console.log('\n=== P1B-6 tool schema unchanged (P1B adds no schema/capability drift) ===');
const registryForSchema = {
  updatedAt: '',
  bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }],
};
const currentSchemas = buildBotToolSchemas(registryForSchema);
if (fs.existsSync(schemaBaselinePath)) {
  const baselineSchemas = JSON.parse(fs.readFileSync(schemaBaselinePath, 'utf8'));
  check(JSON.stringify(currentSchemas) === JSON.stringify(baselineSchemas), 'tool schema JSON byte-identical to captured baseline');
} else {
  check(false, 'tool schema baseline file exists');
}
check(
  currentSchemas.map((tool) => tool.function.name).join(',') === 'query_osu,get_player_skill',
  'exposed tool names are exactly query_osu,get_player_skill',
  currentSchemas.map((tool) => tool.function.name).join(','),
);
const querySchema = currentSchemas.find((tool) => tool.function.name === 'query_osu');
check(!!querySchema, 'query_osu tool present');
if (querySchema) {
  const enumValues = querySchema.function.parameters.properties.capability.enum;
  check(JSON.stringify(enumValues) === JSON.stringify(capabilityNames), 'query_osu capability enum equals callableCapabilities', JSON.stringify(enumValues));
  check(querySchema.function.description === buildQueryOsuDescription(), 'query_osu description still single-sourced from metadata');
}
check(
  AGENT_CAPABILITY_META.filter((entry) => entry.callable).map((entry) => entry.capability).join(',') === capabilityNames.join(','),
  'AGENT_CAPABILITY_META callable list unchanged and ordered',
);

console.log('\n=== P1B-7 planner loop + routing/permission boundaries unchanged ===');
const botSource = fs.readFileSync(path.join(root, 'server', 'bot.ts'), 'utf8');
check(botSource.includes('maxIterations: 4'), 'bot.ts still caps harness loop at 4 iterations');
check(AGENT_MAX_TOOL_CALLS_PER_RESPONSE === 4, 'per-response tool cap still 4');
check(AGENT_MAX_TOOL_CALLS_PER_TURN === 8, 'per-turn tool cap still 8');
check(botSource.includes('const useTools = enabledBots(loadRegistry(liveDb)).length > 0;'), 'tool exposure still gated by enabled bots');
check(botSource.includes('if (osuDataIntent && !useTools)'), 'no-tool osu data explicit-fail routing still present');
check(botSource.includes('validateOperation({'), 'permission validation still runs before deterministic tool execution');
check(
  botSource.includes("buildToolGuidance({ exposedCapabilities: [requiredCapability] })"),
  'required-tool path injects capability-scoped guidance',
);
check(botSource.includes('buildToolGuidance()'), 'non-required-tool path injects full guidance');
check(botSource.includes("if (toolGuidance) messages[0].content += '\\n\\n' + toolGuidance;"), 'injection skipped for empty guidance');
check(!botSource.includes('【可用工具】'), 'bot.ts keeps zero handwritten tool guidance text');

console.log('\n=== P1B-7.5 runtime-reachable required-tool capabilities ===');
const routeSamples = {
  bp: '查我bp',
  bp_type: '分析我的bp类型',
  recent: '最近成绩',
  recommend: '推荐点图给我',
  info: '查一下我的info',
};
const runtimeScopedCapabilities = [];
for (const [capability, sample] of Object.entries(routeSamples)) {
  const detectedTool = detectRequiredOsuTool(sample);
  const detectedBpType = detectBpTypeAnalysisIntent(sample);
  const reached = (detectedTool?.toolName === 'query_osu' && detectedTool?.args?.capability === capability) ||
    (capability === 'bp_type' && detectedBpType);
  check(reached, `deterministic route ${capability} reachable from natural-language sample`, JSON.stringify(detectedTool));
  if (reached) runtimeScopedCapabilities.push(capability);
}
check(
  JSON.stringify(runtimeScopedCapabilities) === JSON.stringify(['bp', 'bp_type', 'recent', 'recommend', 'info']),
  'runtime required-tool scoping reaches exactly bp/bp_type/recent/recommend/info',
  runtimeScopedCapabilities.join(','),
);

console.log('\n=== P1B-8 prompt builder does not pre-inject tool guidance ===');
const promptDb = {
  settings: {
    selfQq: '10001', ownerQq: '10002', model: 'test', searchMode: 'off',
    systemPrompt: '', persona: '雨沐', defaultGroup: '', contextLimit: 30,
    ownerPrivateContextCharBudget: 12000, memoryEnabled: false,
  },
  groups: [{ groupId: 'G1', name: 'P1B_GROUP' }],
  messages: [], groupProfiles: [], relationshipProfiles: [], memories: [], users: [], osuBindings: {},
  skillStore: { records: [], updatedAt: '' }, experience: {}, pendingLevelUps: {},
};
const promptEvent = { source: 'onebot', type: 'group', messageId: 'm1', groupId: 'G1', userId: 'U1', nickname: 'RedactedUser', text: '帮我查bp', atTargets: [], images: [], raw: {}, senderRole: 'member' };
const promptPolicy = { policy: 'normal', attentionLevel: 3, allowCommands: false, customPrompt: '' };
const basePromptMessages = buildPrompt(promptDb, { groupId: 'G1', name: 'P1B_GROUP' }, promptEvent, promptPolicy);
check(Array.isArray(basePromptMessages) && basePromptMessages.length > 0, 'buildPrompt still returns message array');
check(basePromptMessages.every((message) => !String(message.content || '').includes('【可用工具】')), 'buildPrompt output has no tool guidance (single injection point in bot.ts)');
check(basePromptMessages[0]?.role === 'system', 'base system prompt still builds normally');

console.log('\n=== P1B-9 metadata single-source drift (synthetic only) ===');
const driftBase = buildToolGuidanceFromMetadata({
  capabilities: ['bp', 'recent'],
  externalBotNames: ['雨沐', '猫猫'],
  recentSelectorIds: ['yumu'],
});
const driftCap = buildToolGuidanceFromMetadata({
  capabilities: ['bp', 'recent', 'test_only_capability'],
  externalBotNames: ['雨沐', '猫猫'],
  recentSelectorIds: ['yumu'],
});
check(driftBase.includes('bp、recent'), 'synthetic metadata assembles capability list');
check(driftCap.includes('test_only_capability'), 'synthetic new capability appears in generated guidance');
check(buildToolGuidanceFromMetadata({ capabilities: ['bp'], externalBotNames: [], recentSelectorIds: [] }).includes('bp'), 'synthetic single capability assembles');
check(
  buildToolGuidanceFromMetadata({ capabilities: ['recent'], externalBotNames: ['雨沐'], recentSelectorIds: ['yumu'] }).includes('雨沐'),
  'synthetic bot name propagates when recent selector ids exist',
);
check(
  !buildToolGuidanceFromMetadata({ capabilities: ['recent'], externalBotNames: ['雨沐'], recentSelectorIds: [] }).includes('雨沐'),
  'synthetic bot name omitted when recent selector ids are absent',
);

console.log('\n=== P1B-10 guidance line/char budget captures ===');
const lineCount = (text) => (text ? text.split('\n').length : 0);
check(lineCount(fullGuidance) === lineCount(buildToolGuidance()), 'full guidance line count stable');
check(fullGuidance.length === 1098, 'full guidance 1098 chars (P1A baseline)');
check(buildToolGuidance({ exposedCapabilities: [] }).length === 0, 'empty exposure is 0 chars');
const expectedSubsetChars = {
  bp: 486,
  bp_type: 582,
  recent: 702,
  recommend: 634,
  pp_calc: 573,
  info: 488,
  profile: 491,
  ppplus: 490,
  skill: 489,
  beatmap_lookup: 498,
  leaderboard: 495,
};
for (const [capability, expected] of Object.entries(expectedSubsetChars)) {
  const actual = (subsetByCapability.get(capability) || '').length;
  check(actual === expected, `subset ${capability} char count ${expected}`, `${actual}`);
}
check(
  [...subsetByCapability.values()].every((text) => text.length > 0 && text.length < fullGuidance.length),
  'all capability subsets are between 1 and full-1 chars',
);

console.log(`\n=== P1B verification: ${checks} checks, ${failures} failures ===`);

// ── Artifacts ──
const now = new Date().toISOString();
fs.mkdirSync(p1bDir, { recursive: true });
fs.writeFileSync(path.join(p1bDir, 'capability_scope_matrix.json'), JSON.stringify({
  generated_at: now,
  tool_guidance_version: TOOL_GUIDANCE_VERSION,
  full_guidance_chars: fullGuidance.length,
  empty_guidance_chars: 0,
  capabilities: capabilityNames.map((capability) => {
    const text = subsetByCapability.get(capability) || '';
    const listed = listedCapabilities(text);
    const includedScoped = scopedPolicyTexts.filter((policy) => text.includes(policy.text)).map((policy) => policy.id);
    return {
      capability,
      guidance_chars: text.length,
      guidance_lines: lineCount(text),
      listed_capabilities: listed,
      contains_only_itself: listed.length === 1 && listed[0] === capability,
      scoped_policy_ids: includedScoped,
      global_policy_ids: globalPolicyTexts.filter((policy) => text.includes(policy.text)).map((policy) => policy.id),
      contains_recent_selector_line: text.includes('只有最近成绩查询（capability=recent）可以填 bot 参数'),
    };
  }),
}, null, 2));
fs.writeFileSync(path.join(p1bDir, 'policy_scope_map.json'), JSON.stringify({
  generated_at: now,
  tool_guidance_version: TOOL_GUIDANCE_VERSION,
  scoping_rule: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED policies always present when any capability is exposed; CAPABILITY_SCOPED policies present only when at least one requiredCapabilities value is in the selected exposure.',
  global_policies: globalPolicyTexts.map((policy) => ({
    id: policy.id,
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: policy.text,
    chars: policy.text.length,
    observed_in_every_nonempty_subset: [...subsetByCapability.values()].every((text) => text.includes(policy.text)),
  })),
  scoped_policies: scopedPolicyTexts.map((policy) => ({
    id: policy.id,
    scope: 'CAPABILITY_SCOPED',
    requiredCapabilities: policy.capabilities,
    text: policy.text,
    chars: policy.text.length,
    observed_only_in_exposures: policy.capabilities.every((capability) => (subsetByCapability.get(capability) || '').includes(policy.text)) &&
      capabilityNames.filter((name) => !policy.capabilities.includes(name)).every((capability) => !(subsetByCapability.get(capability) || '').includes(policy.text)),
  })),
}, null, 2));

const perCallBudget = {
  no_tools: { p1a_chars: 0, p1b_chars: 0, delta_per_llm_call: 0, logical_unique_chars: 0, runtime_reachable: true },
  tools_full: { p1a_chars: fullGuidance.length, p1b_chars: fullGuidance.length, delta_per_llm_call: 0, logical_unique_chars: fullGuidance.length, runtime_reachable: true },
};
for (const capability of capabilityNames) {
  const subsetChars = (subsetByCapability.get(capability) || '').length;
  perCallBudget[`required_tool_${capability}`] = {
    p1a_chars: fullGuidance.length,
    p1b_chars: subsetChars,
    delta_per_llm_call: fullGuidance.length - subsetChars,
    logical_unique_chars: subsetChars,
    runtime_reachable: runtimeScopedCapabilities.includes(capability),
  };
}
fs.writeFileSync(path.join(p1bDir, 'before_after_budget.json'), JSON.stringify({
  generated_at: now,
  comparison_basis: 'P1A (always full guidance when tools exposed) vs P1B (scoped guidance on deterministic required-tool path, full otherwise, empty when no tools). Guidance is injected once into messages[0]; runToolLoop can call the LLM multiple times with the same messages, so request-visible chars = logical unique chars x LLM calls.',
  chars_guidance_only: 'Guidance string chars only; system prompt, history and tool schema are identical across P1A/P1B for the same runtime path.',
  runtime_reachable_scoped_capabilities: runtimeScopedCapabilities,
  scenarios: perCallBudget,
}, null, 2));

const injectionRows = [
  {
    row: 'no_tools',
    trigger: 'useTools=false',
    injected_before: false,
    injected_after: false,
    p1a_guidance_chars: 0,
    p1b_guidance_chars: 0,
    delta_per_llm_call: 0,
    notes: 'osuDataIntent fails explicitly before the LLM call; no tool guidance is ever appended.',
    runtime_reachable: true,
  },
  {
    row: 'tools_required_tool_missing_or_unknown',
    trigger: 'useTools=true and requiredTool undefined (no deterministic osu data intent)',
    injected_before: true,
    injected_after: true,
    p1a_guidance_chars: fullGuidance.length,
    p1b_guidance_chars: fullGuidance.length,
    delta_per_llm_call: 0,
    notes: 'Unified query_osu exposes the full callable catalog, so guidance stays full (and fails closed to full for unknown capability ids).',
    runtime_reachable: true,
  },
];
for (const capability of capabilityNames) {
  const subsetChars = (subsetByCapability.get(capability) || '').length;
  injectionRows.push({
    row: `tools_required_tool_${capability}`,
    trigger: `useTools=true, requiredTool={toolName:'query_osu', args:{capability:'${capability}'}}`,
    injected_before: true,
    injected_after: true,
    p1a_guidance_chars: fullGuidance.length,
    p1b_guidance_chars: subsetChars,
    delta_per_llm_call: fullGuidance.length - subsetChars,
    notes: runtimeScopedCapabilities.includes(capability)
      ? 'Deterministic required-tool route exists today; guidance is scoped to this single capability.'
      : 'Builder supports this subset, but no deterministic required-tool route currently emits it; it is capability for future deterministic routing, not claimed P1B runtime saving.',
    runtime_reachable: runtimeScopedCapabilities.includes(capability),
  });
}
fs.writeFileSync(path.join(p1bDir, 'baseline_injection_matrix.json'), JSON.stringify({
  generated_at: now,
  baseline: 'P1A behavior: when useTools is true, buildToolGuidance() (full 1098 chars) is appended to messages[0] before every runToolLoop; when useTools is false nothing is appended.',
  after: 'P1B behavior: requiredTool.args.capability (deterministic query_osu route only) scopes guidance to one capability; all other tool calls keep full guidance; no-tools path remains zero.',
  multi_llm_call_note: 'The guidance string is appended once per turn to messages[0]. runToolLoop reuses the same messages for up to 4 iterations, so every LLM request in that turn repeats the string: request-visible delta = delta_per_llm_call x (number of LLM requests in the turn).',
  rows: injectionRows,
}, null, 2));

fs.writeFileSync(path.join(p1bDir, 'verification_summary.json'), JSON.stringify({
  generated_at: now,
  verifier: 'tools/prompt-review-slim-p1b-verify.mjs',
  tool_guidance_version: TOOL_GUIDANCE_VERSION,
  checks,
  passed: checks - failures,
  failed: failures,
  result: failures === 0 ? 'ALL_P1B_VERIFIER_CHECKS_PASS' : 'P1B_VERIFIER_HAS_FAILURES',
  runtime_reachable_scoped_capabilities: runtimeScopedCapabilities,
  artifacts_written: [
    'tmp/prompt_review_slim_v01_p1b/baseline_injection_matrix.json',
    'tmp/prompt_review_slim_v01_p1b/capability_scope_matrix.json',
    'tmp/prompt_review_slim_v01_p1b/policy_scope_map.json',
    'tmp/prompt_review_slim_v01_p1b/before_after_budget.json',
    'tmp/prompt_review_slim_v01_p1b/verification_summary.json',
  ],
}, null, 2));

cleanupTestDir(testDataDir);
if (failures > 0) {
  console.error(`P1B VERIFIER FAILED: ${failures} failure(s)`);
  process.exit(1);
}
console.log('P1B VERIFIER PASSED');
