// external-exposure-verify.mjs
//
// R3 machine check for the LLM tool exposure contract. This verifier reads the
// real registry/guard/executor artifacts at runtime; it does not repeat the
// contract as prose.
//
// Contract:
//   VISIBLE      = names emitted by buildBotToolSchemas
//   CALLABLE     = names validateOperation accepts with a minimal valid op
//   EXECUTOR     = case names inside executor.executeToolCallInner
//   VISIBLE must be a subset of both CALLABLE and EXECUTOR.
//   query_external_bot must be invisible for internal-only AND external-only
//   registries (its backend stays in executor, guard still rejects it).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBotToolSchemas } from '../server/bots/registry.ts';
import { validateOperation } from '../server/bots/guard.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
}

function assert(condition, label, detail = '') {
  if (condition) pass(label);
  else fail(label, detail);
}

function assertSetEqual(actual, expected, label) {
  const a = [...actual].sort().join(',');
  const e = [...expected].sort().join(',');
  assert(a === e, label, `got [${a}] expected [${e}]`);
}

// ── Registries ────────────────────────────────────────────────────────────

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

// ── Runtime inventory ─────────────────────────────────────────────────────

const visibleInternal = buildBotToolSchemas(internalRegistry).map((tool) => tool.function.name);
const visibleExternal = buildBotToolSchemas(externalRegistry).map((tool) => tool.function.name);
const VISIBLE = new Set([...visibleInternal, ...visibleExternal]);

// Minimal valid ops for every known backend tool name. These are the same six
// executor switch cases; guard validation decides whether each is CALLABLE.
const KNOWN_TOOL_NAMES = [
  'query_osu',
  'query_bot',
  'query_external_bot',
  'get_player_skill',
  'list_bots',
  'get_recent_score',
];

const MINIMAL_VALID_OPS = {
  query_osu: { type: 'query_osu', params: { capability: 'recent' } },
  query_bot: { type: 'query_bot', params: { bot: 'yumu', command: 'recent' } },
  query_external_bot: { type: 'query_external_bot', params: { bot: 'yumu', command: 'recent' } },
  get_player_skill: { type: 'get_player_skill', params: { player: '[TST]Alpha' } },
  list_bots: { type: 'list_bots', params: {} },
  get_recent_score: { type: 'get_recent_score', params: { player: '[TST]Alpha' } },
};

const CALLABLE = new Set(
  KNOWN_TOOL_NAMES.filter((name) => validateOperation(MINIMAL_VALID_OPS[name]).ok),
);

// EXECUTOR_REACHABLE is extracted from the source switch in
// executeToolCallInner, not from a hand-maintained list.
function extractExecutorToolNames() {
  const source = fs.readFileSync(path.join(root, 'server', 'bots', 'executor.ts'), 'utf8');
  const start = source.indexOf('async function executeToolCallInner(');
  const endMarker = '// Every query_osu invocation';
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('executor function markers not found');
  const body = source.slice(start, end);
  const names = [...body.matchAll(/case\s+'([^']+)'\s*:/g)].map((match) => match[1]);
  return new Set(names);
}

const EXECUTOR_REACHABLE = extractExecutorToolNames();

// ── Exposure auditor helper (also used for negative tests) ────────────────

function auditExposure({ visible, callable, executorReachable, allowedDormant = new Set() }) {
  const problems = [];
  const visibleSet = new Set(visible);
  const callableSet = new Set(callable);
  const executorSet = new Set(executorReachable);
  for (const name of visibleSet) {
    if (!executorSet.has(name)) problems.push(`VISIBLE_BUT_NO_EXECUTOR:${name}`);
    if (!callableSet.has(name)) problems.push(`VISIBLE_BUT_UNCALLABLE:${name}`);
  }
  const seen = new Set();
  for (const name of visible) {
    if (seen.has(name)) problems.push(`DUPLICATE_VISIBLE:${name}`);
    seen.add(name);
  }
  const dormant = [...executorSet].filter((name) => !visibleSet.has(name) && !allowedDormant.has(name));
  for (const name of dormant) {
    // Dormant backend names are allowed only when explicitly whitelisted by
    // the caller; otherwise they are undeclared backends.
    problems.push(`DORMANT_BACKEND_NOT_WHITELISTED:${name}`);
  }
  return problems;
}

const R3_DORMANT_WHITELIST = new Set(['query_bot', 'query_external_bot', 'list_bots', 'get_recent_score']);

console.log('=== runtime inventory ===');
console.log(`VISIBLE: [${[...VISIBLE].join(', ')}]`);
console.log(`CALLABLE: [${[...CALLABLE].join(', ')}]`);
console.log(`EXECUTOR_REACHABLE: [${[...EXECUTOR_REACHABLE].sort().join(', ')}]`);

assertSetEqual(
  VISIBLE,
  ['query_osu', 'get_player_skill'],
  'visible inventory',
);
assert(
  !VISIBLE.has('query_external_bot'),
  'query_external_bot absent from internal+external visible inventories',
);
assert(
  CALLABLE.has('query_external_bot') === false,
  'query_external_bot remains guard-rejected',
);
for (const dormant of R3_DORMANT_WHITELIST) {
  assert(!VISIBLE.has(dormant), `${dormant} is dormant/not visible`);
}

console.log('\n=== real exposure audit ===');
{
  const problems = auditExposure({
    visible: [...VISIBLE],
    callable: [...CALLABLE],
    executorReachable: [...EXECUTOR_REACHABLE],
    allowedDormant: R3_DORMANT_WHITELIST,
  });
  assert(problems.length === 0, 'real exposure contract clean', problems.join('; '));
}

console.log('\n=== negative tests ===');
{
  // Fake schema exposing query_external_bot must be flagged.
  const problems = auditExposure({
    visible: ['query_osu', 'query_external_bot'],
    callable: ['query_osu'],
    executorReachable: [...EXECUTOR_REACHABLE],
    allowedDormant: R3_DORMANT_WHITELIST,
  });
  assert(
    problems.includes('VISIBLE_BUT_UNCALLABLE:query_external_bot'),
    'negative: query_external_bot exposure detected',
  );

  // Fake visible tool with no executor must be flagged.
  const missingExecutor = auditExposure({
    visible: ['query_osu'],
    callable: ['query_osu'],
    executorReachable: [],
    allowedDormant: R3_DORMANT_WHITELIST,
  });
  assert(
    missingExecutor.includes('VISIBLE_BUT_NO_EXECUTOR:query_osu'),
    'negative: missing executor detected',
  );

  // Duplicate visible exposure must be flagged.
  const duplicate = auditExposure({
    visible: ['query_osu', 'query_osu'],
    callable: ['query_osu'],
    executorReachable: [...EXECUTOR_REACHABLE],
    allowedDormant: R3_DORMANT_WHITELIST,
  });
  assert(
    duplicate.includes('DUPLICATE_VISIBLE:query_osu'),
    'negative: duplicate exposure detected',
  );

  // An unwhitelisted executor backend must be flagged as dormant/undeclared.
  const undeclared = auditExposure({
    visible: ['query_osu'],
    callable: ['query_osu'],
    executorReachable: [...EXECUTOR_REACHABLE, 'mystery_tool'],
    allowedDormant: R3_DORMANT_WHITELIST,
  });
  assert(
    undeclared.includes('DORMANT_BACKEND_NOT_WHITELISTED:mystery_tool'),
    'negative: unwhitelisted backend detected',
  );
}

console.log('\n=== inventory sets ===');
console.log('VISIBLE_AND_CALLABLE:', [...VISIBLE].filter((name) => CALLABLE.has(name)).join(', '));
console.log('VISIBLE_BUT_UNCALLABLE:', [...VISIBLE].filter((name) => !CALLABLE.has(name)).join(', '));
console.log(
  'CALLABLE_BUT_NOT_VISIBLE:',
  [...CALLABLE].filter((name) => !VISIBLE.has(name)).join(', '),
);
console.log(
  'DORMANT_BACKEND_ONLY:',
  [...EXECUTOR_REACHABLE].filter((name) => !VISIBLE.has(name)).sort().join(', '),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
