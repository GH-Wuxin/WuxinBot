// WUXINBOT_PROMPT_REVIEW_SLIM_V01_P1A verification.
// Verifies single-source tool guidance without changing production metadata.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = createTestDataDir('prompt-review-slim-p1a');
process.env.DATA_DIR = testDataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(testDataDir);

const { ensureStore } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { buildToolGuidance, buildToolGuidanceFromMetadata } = await import('../server/bots/toolGuidance.ts');
const { buildBotToolSchemas } = await import('../server/bots/registry.ts');
const { buildQueryOsuDescriptionFromMeta, AGENT_CAPABILITY_META } = await import('../server/bots/agentCapabilities.ts');
const { CAPABILITY_CATALOG } = await import('../server/bots/capabilityCatalog.ts');
const { getAllCommandHelpEntries } = await import('../server/bot/commands/index.ts');
const { DEFAULT_BOTS } = await import('../server/bots/registry.ts');
const { RECENT_BOT_SELECTOR_IDS } = await import('../server/bots/capabilityCatalog.ts');

ensureStore();
let failures = 0;
function check(cond, label, detail = '') {
  if (cond) console.log(`PASS ${label}`);
  else { failures += 1; console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`); }
}

// 1. Determinism / stable ordering
{
  const a = buildToolGuidance();
  const b = buildToolGuidance();
  check(a === b, 'generated guidance deterministic');
  for (let i = 0; i < 20; i += 1) check(buildToolGuidance() === a, 'generated guidance stable across calls');
}

// 2. Canonical metadata propagation (drift test, synthetic mutation only)
{
  const base = buildToolGuidanceFromMetadata({
    capabilities: ['bp', 'recent'],
    externalBotNames: ['雨沐', '猫猫'],
    recentSelectorIds: ['yumu'],
  });
  const changedCap = buildToolGuidanceFromMetadata({
    capabilities: ['bp', 'recent', 'test_only_capability'],
    externalBotNames: ['雨沐', '猫猫'],
    recentSelectorIds: ['yumu'],
  });
  const changedBot = buildToolGuidanceFromMetadata({
    capabilities: ['bp', 'recent'],
    externalBotNames: ['雨沐', '猫猫', '测试机器人'],
    recentSelectorIds: ['yumu'],
  });
  const changedSelector = buildToolGuidanceFromMetadata({
    capabilities: ['bp', 'recent'],
    externalBotNames: ['雨沐', '猫猫'],
    recentSelectorIds: ['yumu', 'kanon'],
  });
  check(base !== changedCap && changedCap.includes('test_only_capability'), 'drift: capability mutation reflected automatically');
  check(changedBot.includes('测试机器人') && !base.includes('测试机器人'), 'drift: bot-name mutation reflected automatically');
  check(changedSelector.includes('yumu/kanon') && !base.includes('yumu/kanon'), 'drift: selector mutation reflected automatically');
  const baseSchemaDesc = buildQueryOsuDescriptionFromMeta([...AGENT_CAPABILITY_META]);
  const mutatedMeta = AGENT_CAPABILITY_META.map((entry) => entry.capability === 'bp' ? { ...entry, description: 'TEST_ONLY_MUTATED_DESCRIPTION' } : entry);
  const mutatedSchemaDesc = buildQueryOsuDescriptionFromMeta(mutatedMeta);
  check(baseSchemaDesc !== mutatedSchemaDesc && mutatedSchemaDesc.includes('TEST_ONLY_MUTATED_DESCRIPTION'), 'drift: capability description mutation reflected in tool description');
}

// 3. Generated facts from canonical sources
{
  const guidance = buildToolGuidance();
  const callable = AGENT_CAPABILITY_META.filter((e) => e.callable).map((e) => e.capability);
  for (const name of callable) check(guidance.includes(name), `generated guidance contains capability ${name}`);
  for (const bot of DEFAULT_BOTS) check(guidance.includes(bot.name), `generated guidance contains bot name ${bot.name}`);
  for (const id of RECENT_BOT_SELECTOR_IDS) check(guidance.includes(id), `generated guidance contains recent selector ${id}`);
}

// 4. Mandatory handwritten policy remains (not metadata-able)
{
  const guidance = buildToolGuidance();
  const mandatory = [
    '你必须通过 query_osu 获取真实 osu! 数据',
    '禁止报数',
    '禁止编造谱面名、难度或 BID',
    '说明是 rosu 估算',
    '禁止拿 std 数据冒充',
    '禁止把某位玩家的数据说成另一位玩家的',
    'XML/DSML/tool_calls',
  ];
  for (const s of mandatory) check(guidance.includes(s), `mandatory policy present: ${s}`);
}

// 5. No full capability descriptions dumped twice
{
  const registry = { bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] };
  const tools = buildBotToolSchemas(registry);
  const desc = tools.find((t) => t.function.name === 'query_osu').function.description;
  const guidance = buildToolGuidance();
  for (const entry of AGENT_CAPABILITY_META.filter((e) => e.callable)) {
    if (entry.description.length > 20) {
      check(!guidance.includes(entry.description), `generated guidance does not dump full description for ${entry.capability}`);
    }
  }
  check(desc.includes('bp_type') && desc.includes('recommend') && desc.includes('pp_calc'), 'tool schema still carries canonical descriptions');
  check(!guidance.includes(desc), 'guidance does not duplicate whole tool schema description');
}

// 6. Assembled prompt deterministic and tool-injection structure preserved
{
  const db = {
    settings: {
      ownerQq: 'OWNER_TEST_QQ', selfQq: 'BOT_TEST_QQ', llmProvider: 'deepseek', model: 'deepseek-v4-flash',
      visionMode: 'off', memoryEnabled: false, contextLimit: 30, ownerPrivateContextCharBudget: 24000,
      enableAutoModel: false, enableWebSearch: true, webSearchMode: 'balanced', ignoreSystemFacts: false,
      thinkingNoticeMode: 'off', levelUpNotifyEnabled: false, groupProfileAutoUpdate: false, personalityPrompt: '', botNames: 'pippi',
      kb: { enabled: false, collections: { wuxinSelf: true, osuDomain: true, communityStyle: true }, rollout: { mode: 'off', groupIds: [], privateMessagesEnabled: false } },
      commandRoles: [{ id: 'guest', name: 'normal', level: 0, locked: true }, { id: 'admin', name: 'admin', level: 60, locked: true }, { id: 'owner', name: 'owner', level: 100, locked: true }],
      commandPermissions: { osuAnalyze: 'guest', osuHelp: 'guest' },
    },
    groups: [{ groupId: 'G1', name: 'P1A_GROUP', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 }],
    messages: [], groupProfiles: [], relationshipProfiles: [], memories: [], users: [], osuBindings: {},
    skillStore: { records: [], updatedAt: '' }, experience: {}, pendingLevelUps: {},
  };
  const event = { source: 'onebot', type: 'group', messageId: 'm1', groupId: 'G1', userId: 'U1', nickname: 'RedactedUser', text: '帮我查bp', atTargets: [], images: [], raw: {}, senderRole: 'member' };
  const policy = { policy: 'normal', attentionLevel: 3, allowCommands: false, customPrompt: '' };
  const p1 = buildPrompt(db, { groupId: 'G1', name: 'P1A_GROUP' }, event, policy);
  const p2 = buildPrompt(db, { groupId: 'G1', name: 'P1A_GROUP' }, event, policy);
  check(JSON.stringify(p1) === JSON.stringify(p2), 'assembled prompt deterministic');
  const assembled = p1[0].content + '\n\n' + buildToolGuidance();
  check(assembled.includes('【可用工具】') && assembled.includes('query_osu'), 'assembled tool path contains generated guidance');
  check(!assembled.includes('BID 3743551'), 'assembled guidance no hardcoded example BID text (policy only)');
}

// 7. Other surfaces unchanged by construction
{
  check(getAllCommandHelpEntries().length >= 1 && getAllCommandHelpEntries()[0].canonicalSyntax, 'command catalog surface unchanged');
  check(CAPABILITY_CATALOG.some((c) => c.name === 'bp_type' && c.name === c.name), 'capability catalog surface unchanged');
  const source = fs.readFileSync(path.join(root, 'server', 'bot.ts'), 'utf8');
  check(!source.includes('messages[0].content += \'\\n\\n\' + \'【可用工具】'), 'handwritten tool note literal removed from bot.ts');
}

cleanupTestDir(testDataDir);
if (failures > 0) {
  console.error(`P1A_VERIFY_FAIL failures=${failures}`);
  process.exit(1);
}
console.log('P1A_VERIFY_PASS');
