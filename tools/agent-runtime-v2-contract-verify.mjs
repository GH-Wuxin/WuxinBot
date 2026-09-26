import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  agentRuntimeModeFor,
  buildV2OsuAgentToolSchemas,
  buildAgentAutonomyGuidance,
  capabilityForAgentToolName,
  normalizeAgentToolCall,
  osuCapabilityForToolCall,
  rewriteLegacyToolReferencesForV2,
} from '../server/bots/agentToolContracts.ts';
import { callableCapabilityNames } from '../server/bots/capabilityCatalog.ts';
import { buildBotToolSchemas } from '../server/bots/registry.ts';
import { runToolLoop } from '../server/bots/executor.ts';

const registry = {
  updatedAt: '',
  bots: [{
    id: 'yumu',
    name: '雨沐',
    description: 'fixture',
    qq: '',
    channel: 'internal',
    enabled: true,
    commands: [],
  }],
};

const schemas = buildV2OsuAgentToolSchemas();
const names = schemas.map((tool) => tool.function.name);

assert.equal(schemas.length, callableCapabilityNames().length, 'one V2 tool per callable capability');
assert.equal(new Set(names).size, names.length, 'V2 tool names must be unique');
assert.ok(!names.includes('osu_watch_match'), 'stateful match capability must remain hidden');

for (const tool of schemas) {
  assert.ok(capabilityForAgentToolName(tool.function.name), `${tool.function.name} maps to a capability`);
  assert.ok(!Object.hasOwn(tool.function.parameters.properties, 'capability'), `${tool.function.name} has no mega-tool selector`);
  assert.match(tool.function.description, /失败/, `${tool.function.name} describes failure behavior`);
  assert.ok(!JSON.stringify(tool).includes('capability='), `${tool.function.name} schema hides legacy multiplexing`);
  assert.ok(!JSON.stringify(tool).includes('query_osu'), `${tool.function.name} schema does not name the hidden executor`);
}

const bestScores = schemas.find((tool) => tool.function.name === 'osu_get_best_scores');
assert.deepEqual(
  Object.keys(bestScores.function.parameters.properties),
  ['username', 'bp_rank', 'bp_start', 'bp_end'],
  'best-score tool exposes only relevant parameters',
);

const calculatePp = schemas.find((tool) => tool.function.name === 'osu_calculate_pp');
assert.deepEqual(
  Object.keys(calculatePp.function.parameters.properties),
  ['beatmap_id', 'mods', 'accuracy', 'combo', 'misses'],
  'pp tool exposes only relevant parameters',
);
assert.deepEqual(calculatePp.function.parameters.required, ['beatmap_id'], 'pp tool requires beatmap id');

const recent = schemas.find((tool) => tool.function.name === 'osu_get_recent_score');
assert.deepEqual(
  Object.keys(recent.function.parameters.properties),
  ['username', 'bot'],
  'recent tool alone exposes bot selector',
);

const original = {
  id: 'v2-call-1',
  type: 'function',
  function: {
    name: 'osu_calculate_pp',
    arguments: JSON.stringify({ beatmap_id: 123, accuracy: 99.5 }),
  },
};
const normalized = normalizeAgentToolCall(original);
assert.equal(normalized.id, original.id, 'normalization preserves tool call id');
assert.equal(normalized.function.name, 'query_osu', 'V2 tool maps to trusted executor');
assert.deepEqual(
  JSON.parse(normalized.function.arguments),
  { capability: 'pp_calc', beatmap_id: 123, accuracy: 99.5 },
  'normalization injects canonical capability without changing arguments',
);
assert.equal(osuCapabilityForToolCall(original), 'pp_calc', 'V2 call capability is observable');
assert.equal(osuCapabilityForToolCall(normalized), 'pp_calc', 'legacy call capability is observable');

const legacyTools = buildBotToolSchemas(registry);
assert.ok(legacyTools.some((tool) => tool.function.name === 'query_osu'), 'legacy surface remains the default');
assert.ok(!legacyTools.some((tool) => tool.function.name === 'osu_get_best_scores'), 'legacy surface stays byte-compatible');

const v2Tools = buildBotToolSchemas(registry, { surface: 'v2' });
assert.ok(!v2Tools.some((tool) => tool.function.name === 'query_osu'), 'V2 surface hides mega-tool');
assert.ok(v2Tools.some((tool) => tool.function.name === 'osu_get_best_scores'), 'V2 surface exposes precise tools');
assert.ok(v2Tools.some((tool) => tool.function.name === 'get_player_skill'), 'non-osu snapshot tool remains available');
const profilerTool = v2Tools.find((tool) => tool.function.name === 'osu_analyze_beatmap_skills');
assert.ok(profilerTool, 'V2 surface exposes the local beatmap Skill Profiler');
assert.deepEqual(
  Object.keys(profilerTool.function.parameters.properties),
  ['beatmap_id', 'mods'],
  'Skill Profiler exposes only BID and the supported Mod list',
);
assert.ok(!legacyTools.some((tool) => tool.function.name === 'osu_analyze_beatmap_skills'), 'legacy rollback surface remains unchanged');

assert.equal(agentRuntimeModeFor({ settings: {} }), 'model_first', 'model-first runtime is the default');
assert.equal(agentRuntimeModeFor({ settings: { agentRuntimeMode: 'legacy' } }), 'legacy', 'stored rollback mode is honored');
assert.match(
  buildAgentAutonomyGuidance({ searchEnabled: true, maxSearchCalls: 2 }),
  /search_web；本轮最多 2 次/,
  'autonomy guidance names the exact exposed web-search function',
);

let modelRound = 0;
const seenToolMessages = [];
const seenEvidenceEnvelopes = [];
const chained = await runToolLoop(async (_db, options) => {
  modelRound += 1;
  const toolMessages = options.messages.filter((message) => message.role === 'tool');
  seenToolMessages.push(toolMessages.length);
  assert.ok(options.tools?.some((tool) => tool.function.name === 'osu_get_recent_score'), 'V2 tools stay visible while planning');
  if (modelRound === 1) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [{
        id: 'recent-1', type: 'function',
        function: { name: 'osu_get_recent_score', arguments: '{}' },
      }] } }] },
    };
  }
  if (modelRound === 2) {
    assert.equal(toolMessages.length, 1, 'first result returns to the same model');
    seenEvidenceEnvelopes.push(JSON.parse(toolMessages[0].content));
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [{
        id: 'profile-1', type: 'function',
        function: { name: 'osu_get_player_profile', arguments: '{}' },
      }] } }] },
    };
  }
  assert.equal(toolMessages.length, 2, 'second result also returns to the model');
  seenEvidenceEnvelopes.push(JSON.parse(toolMessages[1].content));
  return {
    text: '结合最近成绩和玩家资料，已经可以回答。', usage: {},
    raw: { choices: [{ message: { content: '结合最近成绩和玩家资料，已经可以回答。' } }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '看看我最近的状态，再结合资料评价一下' }],
  tools: v2Tools,
  userId: 'fixture-user',
  maxIterations: 4,
  continueAfterDirectPayload: true,
  structuredToolResults: true,
  executeToolCallFn: async (toolCall) => ({
    toolCallId: toolCall.id,
    ok: true,
    content: `${toolCall.function.name} fixture result`,
    images: [`fixture://${toolCall.id}.png`],
  }),
});

assert.equal(chained.toolCallsMade, 2, 'model can execute a two-tool chain');
assert.equal(chained.iterations, 3, 'model receives a fresh planning turn after each result');
assert.deepEqual(chained.images, ['fixture://recent-1.png', 'fixture://profile-1.png'], 'display artifacts survive the full chain');
assert.deepEqual(seenToolMessages, [0, 1, 2], 'evidence accumulates across the continuous loop');
assert.deepEqual(
  seenEvidenceEnvelopes.map((envelope) => ({
    version: envelope.schemaVersion,
    status: envelope.status,
    tool: envelope.tool,
    imageCount: envelope.delivery.imageCount,
    imagesAttachedByHost: envelope.delivery.imagesAttachedByHost,
  })),
  [
    {
      version: 1,
      status: 'success',
      tool: { name: 'osu_get_recent_score', capability: 'recent' },
      imageCount: 1,
      imagesAttachedByHost: true,
    },
    {
      version: 1,
      status: 'success',
      tool: { name: 'osu_get_player_profile', capability: 'profile' },
      imageCount: 1,
      imagesAttachedByHost: true,
    },
  ],
  'each V2 result is a typed evidence envelope with host-delivery state',
);
assert.equal(
  seenEvidenceEnvelopes[0].evidence.text,
  'osu_get_recent_score fixture result',
  'the model receives sanitized evidence inside the envelope',
);
assert.match(chained.text, /最近成绩和玩家资料/, 'final synthesis is produced only after the model stops calling tools');

let noToolExecutions = 0;
const conversational = await runToolLoop(async () => ({
  text: '今天也要玩得开心。', usage: {},
  raw: { choices: [{ message: { content: '今天也要玩得开心。' } }] },
}), {
  db: { settings: {} },
  messages: [{ role: 'user', content: '晚上好' }],
  tools: v2Tools,
  userId: 'fixture-user',
  structuredToolResults: true,
  executeToolCallFn: async () => {
    noToolExecutions += 1;
    throw new Error('casual chat must not execute a tool');
  },
});
assert.equal(noToolExecutions, 0, 'a conversational answer can finish without touching the executor');
assert.equal(conversational.toolCallsMade, 0, 'no-tool decision is accounted correctly');
assert.equal(conversational.iterations, 1, 'no-tool decision finishes in one model round');

let recoveryRound = 0;
const recoveryEnvelopes = [];
const recovered = await runToolLoop(async (_db, options) => {
  recoveryRound += 1;
  const toolMessages = options.messages.filter((message) => message.role === 'tool');
  if (recoveryRound === 1) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [{
        id: 'failed-recent', type: 'function',
        function: { name: 'osu_get_recent_score', arguments: '{}' },
      }] } }] },
    };
  }
  recoveryEnvelopes.push(JSON.parse(toolMessages[toolMessages.length - 1].content));
  if (recoveryRound === 2) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [{
        id: 'fallback-profile', type: 'function',
        function: { name: 'osu_get_player_profile', arguments: '{}' },
      }] } }] },
    };
  }
  return {
    text: '最近成绩暂时不可用，但可以根据实时资料回答。', usage: {},
    raw: { choices: [{ message: { content: '最近成绩暂时不可用，但可以根据实时资料回答。' } }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '看看我最近怎么样，查不到就用其他资料' }],
  tools: v2Tools,
  userId: 'fixture-user',
  maxIterations: 4,
  continueAfterDirectPayload: true,
  structuredToolResults: true,
  executeToolCallFn: async (toolCall) => toolCall.function.name === 'osu_get_recent_score'
    ? { toolCallId: toolCall.id, ok: false, content: '', error: 'RECENT_UNAVAILABLE' }
    : { toolCallId: toolCall.id, ok: true, content: 'profile fallback evidence' },
});
assert.deepEqual(
  recoveryEnvelopes.map((envelope) => [envelope.status, envelope.tool.name, envelope.error]),
  [
    ['error', 'osu_get_recent_score', 'RECENT_UNAVAILABLE'],
    ['success', 'osu_get_player_profile', null],
  ],
  'a failed tool is explicit evidence and the model can choose a different tool',
);
assert.equal(recovered.toolCallsMade, 2, 'failed and successful executor settlements are both accounted');
assert.match(recovered.text, /最近成绩暂时不可用/, 'recovery answer preserves the failed-evidence limitation');

let duplicateRound = 0;
let duplicateExecutions = 0;
let duplicateSkipEnvelope;
const deduplicated = await runToolLoop(async (_db, options) => {
  duplicateRound += 1;
  if (duplicateRound === 3) {
    const toolMessages = options.messages.filter((message) => message.role === 'tool');
    duplicateSkipEnvelope = JSON.parse(toolMessages[toolMessages.length - 1].content);
  }
  if (duplicateRound <= 2) {
    return {
      text: '', usage: {},
      raw: { choices: [{ message: { content: '', tool_calls: [{
        id: `duplicate-${duplicateRound}`,
        type: 'function',
        function: { name: 'osu_get_recent_score', arguments: JSON.stringify({ username: 'Alice' }) },
      }] } }] },
    };
  }
  return {
    text: '使用第一次查询结果回答。', usage: {},
    raw: { choices: [{ message: { content: '使用第一次查询结果回答。' } }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '查 Alice 最近成绩' }],
  tools: v2Tools,
  userId: 'fixture-user',
  maxIterations: 4,
  continueAfterDirectPayload: true,
  deduplicateToolCalls: true,
  structuredToolResults: true,
  executeToolCallFn: async (toolCall) => {
    duplicateExecutions += 1;
    return { toolCallId: toolCall.id, ok: true, content: 'fixture result' };
  },
});
assert.equal(duplicateExecutions, 1, 'identical successful V2 calls execute only once');
assert.equal(deduplicated.toolCallsMade, 1, 'skipped duplicates do not consume executor budget');
assert.equal(deduplicated.text, '使用第一次查询结果回答。', 'model can recover after duplicate suppression');
assert.equal(duplicateSkipEnvelope.status, 'error', 'duplicate suppression remains inside the structured protocol');
assert.equal(duplicateSkipEnvelope.error, 'DUPLICATE_TOOL_CALL_SKIPPED', 'duplicate envelope carries a machine-readable reason');

const personaSource = fs.readFileSync(new URL('../server/bot/persona.ts', import.meta.url), 'utf8');
const rewrittenPersona = rewriteLegacyToolReferencesForV2(personaSource);
assert.ok(personaSource.includes('query_osu'), 'legacy persona baseline remains intact for rollback and snapshot tests');
assert.ok(!rewrittenPersona.includes('query_osu'), 'V2 request boundary removes the hidden mega-tool name');
assert.ok(!rewrittenPersona.includes('capability='), 'V2 request boundary removes legacy multiplexing selectors');

console.log(`PASS: Agent Runtime V2 contracts (${schemas.length} precise osu! tools + continuous multi-tool loop)`);
