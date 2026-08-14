// agent-capability-verify.mjs — Phase A consistency gate + derived-schema checks.
// Verifies the agent capability meta table, the derived query_osu schema and the
// unmet-capability telemetry. Exit 0 on all pass, non-zero on any failure.
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-agent-cap');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

import {
  AGENT_CAPABILITY_META,
  auditAgentCapabilityRegistry,
  callableCapabilities,
  buildQueryOsuDescription,
} from '../server/bots/agentCapabilities.ts';
import { INTERNAL_CAPABILITIES, buildBotToolSchemas } from '../server/bots/registry.ts';
import { validateOperation } from '../server/bots/guard.ts';
import { executeToolCall } from '../server/bots/executor.ts';
import { ensureStore, readDb, updateDb } from '../server/store.ts';

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

console.log('=== Phase A: meta/executor consistency ===');

const violations = auditAgentCapabilityRegistry();
if (violations.length === 0) {
  pass('audit-clean');
} else {
  for (const violation of violations) fail('audit-clean', `${violation.code}: ${violation.message}`);
}

const callable = callableCapabilities();
const executorNames = INTERNAL_CAPABILITIES.map((c) => c.name);
for (const name of ['beatmap_lookup', 'pp_calc', 'leaderboard']) {
  if (callable.includes(name) && executorNames.includes(name)) pass(`exposed-${name}`);
  else fail(`exposed-${name}`, `capability missing from callable=${callable.includes(name)} executor=${executorNames.includes(name)}`);
}
if (new Set(callable).size === callable.length) pass('no-duplicate-capabilities');
else fail('no-duplicate-capabilities', 'duplicate callable capabilities');

console.log('\n=== Phase A: derived tool schema ===');

const registry = { updatedAt: '', bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }] };
const tools = buildBotToolSchemas(registry);
const queryOsu = tools.find((t) => t.function.name === 'query_osu');
if (!queryOsu) fail('schema-query-osu', 'query_osu tool missing');
else {
  const enumValues = queryOsu.function.parameters.properties.capability.enum;
  for (const name of ['beatmap_lookup', 'pp_calc', 'leaderboard']) {
    if (enumValues.includes(name)) pass(`schema-enum-${name}`);
    else fail(`schema-enum-${name}`, `enum lacks ${name}`);
  }
  const paramKeys = Object.keys(queryOsu.function.parameters.properties);
  for (const key of ['beatmap_id', 'mods', 'accuracy', 'combo', 'misses', 'limit']) {
    if (paramKeys.includes(key)) pass(`schema-param-${key}`);
    else fail(`schema-param-${key}`, 'param missing from derived schema');
  }
  const description = buildQueryOsuDescription();
  if (description.includes('beatmap_lookup') && description.includes('pp_calc') && description.includes('leaderboard')) {
    pass('schema-description-derived');
  } else {
    fail('schema-description-derived', 'description does not mention the three beatmap capabilities');
  }
}

console.log('\n=== Phase A: meta table discipline ===');

if (AGENT_CAPABILITY_META.every((entry) => entry.sideEffects === 'readonly')) pass('all-readonly');
else fail('all-readonly', 'a capability is not readonly');
if (AGENT_CAPABILITY_META.every((entry) => entry.rollout === 'all' || entry.rollout === 'owner_canary')) pass('valid-rollouts');
else fail('valid-rollouts', 'invalid rollout value');
for (const entry of AGENT_CAPABILITY_META) {
  const isBeatmap = entry.capability === 'beatmap_lookup' || entry.capability === 'pp_calc' || entry.capability === 'leaderboard';
  const op = { type: 'query_osu', params: isBeatmap ? { capability: entry.capability, beatmap_id: 5518740 } : { capability: entry.capability } };
  const result = validateOperation(op);
  if (result.ok) pass(`validated-${entry.capability}`);
  else fail(`validated-${entry.capability}`, result.reason || 'rejected');
}

console.log('\n=== Phase D: unmet-capability telemetry ===');

ensureStore();
updateDb((db) => {
  db.settings.ownerQq = 'REDACTED_QQ_001';
  db.settings.selfQq = 'REDACTED_QQ_002';
  db.unmetCapabilities = [];
});

const telemetryContext = {
  db: readDb(),
  userId: 'REDACTED_QQ_001',
  groupId: '900000007',
  event: { userId: 'REDACTED_QQ_001', groupId: '900000007', text: '帮我算一下这张图的pp', nickname: 'Tester' },
};

// 1. query_osu with an unsupported capability → TOOL_NOT_CAPABLE.
{
  const result = await executeToolCall(
    { id: 't1', type: 'function', function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'pp_calc_v2', beatmap_id: 1 }) } },
    telemetryContext,
  );
  const entries = (readDb().unmetCapabilities || []).filter((e) => e.toolName === 'query_osu' && e.intent === 'pp_calc_v2');
  if (!result.ok && entries.length === 1 && entries[0].reason === 'TOOL_NOT_CAPABLE') pass('telemetry-not-capable');
  else fail('telemetry-not-capable', `result.ok=${result.ok} entries=${JSON.stringify(entries)}`);
}

// 2. Unknown tool name → NO_TOOL_MATCH.
{
  const result = await executeToolCall(
    { id: 't2', type: 'function', function: { name: 'osu_magic_tool', arguments: '{}' } },
    telemetryContext,
  );
  const entries = (readDb().unmetCapabilities || []).filter((e) => e.toolName === 'osu_magic_tool');
  if (!result.ok && entries.length === 1 && entries[0].reason === 'NO_TOOL_MATCH') pass('telemetry-no-tool-match');
  else fail('telemetry-no-tool-match', `result.ok=${result.ok} entries=${JSON.stringify(entries)}`);
}

// 3. Supported capability with a bad argument → TOOL_ARGUMENT_UNRESOLVED.
{
  const result = await executeToolCall(
    { id: 't3', type: 'function', function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'pp_calc' }) } },
    telemetryContext,
  );
  const entries = (readDb().unmetCapabilities || []).filter((e) => e.intent === 'pp_calc' && e.reason === 'TOOL_ARGUMENT_UNRESOLVED');
  if (!result.ok && entries.length === 1) pass('telemetry-argument-unresolved');
  else fail('telemetry-argument-unresolved', `result.ok=${result.ok} entries=${JSON.stringify(entries)}`);
}

cleanupTestDir(testDataDir);

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('AGENT-CAPABILITY-VERIFY FAILED');
  process.exit(1);
}
console.log('AGENT-CAPABILITY-VERIFY PASSED');
