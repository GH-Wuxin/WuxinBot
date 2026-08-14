// agent-capability-verify.mjs — Phase A consistency gate + derived-schema checks.
// Verifies the agent capability meta table, the derived query_osu schema and the
// unmet-capability telemetry. Exit 0 on all pass, non-zero on any failure.
import {
  AGENT_CAPABILITY_META,
  auditAgentCapabilityRegistry,
  callableCapabilities,
  buildQueryOsuDescription,
} from '../server/bots/agentCapabilities.ts';
import { INTERNAL_CAPABILITIES, buildBotToolSchemas } from '../server/bots/registry.ts';
import { validateOperation } from '../server/bots/guard.ts';

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

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('AGENT-CAPABILITY-VERIFY FAILED');
  process.exit(1);
}
console.log('AGENT-CAPABILITY-VERIFY PASSED');
