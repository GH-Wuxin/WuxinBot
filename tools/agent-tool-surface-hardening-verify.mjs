// agent-tool-surface-hardening-verify.mjs
//
// AGENT_TOOL_SURFACE_HARDENING_V01 acceptance gate. Locks the hardened
// contract end to end:
//   A1  match is command-side only (out of the LLM enum, rejected by guard)
//   A2  hard tool-call budget: <=4 per response, <=8 per turn, overflow
//       skipped with balanced tool messages and safe final synthesis
//   A3  every query_osu parameter is consumed or rejected — never silently
//       ignored (includes intra-player-family scoping like recent+bp_rank)
//   A4  schema text matches runtime caps (bp range 100, bot enum enforced)
//   A5  previousToolFailed is batch/turn-level sticky since the last planner
//   A6  callable rollout metadata stays 'all' while enforcement is absent
//   DSML textual tool calls share the exact same caps and guards
import assert from 'node:assert/strict';
import {
  assertNotProduction,
  cleanupTestDir,
  createTestDataDir,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
} from './test-isolation.mjs';

const prodBefore = productionDbSnapshot();
const testDataDir = createTestDataDir('wuxin-agent-surface');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const { validateOperation } = await import('../server/bots/guard.ts');
const {
  runToolLoop,
  AGENT_MAX_TOOL_CALLS_PER_RESPONSE,
  AGENT_MAX_TOOL_CALLS_PER_TURN,
} = await import('../server/bots/executor.ts');
const {
  buildBotToolSchemas,
  INTERNAL_CAPABILITIES,
  internalCapabilitySupported,
} = await import('../server/bots/registry.ts');
const {
  AGENT_CAPABILITY_META,
  auditAgentCapabilityRegistry,
  callableCapabilities,
} = await import('../server/bots/agentCapabilities.ts');
const { CAPABILITY_CATALOG, QUERY_OSU_PARAMS } = await import('../server/bots/capabilityCatalog.ts');
const { createShadowReasoningRouter } = await import('../server/bot/reasoningRouter.ts');
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');

let passed = 0;
let failed = 0;
function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}
function fail(label, message) {
  console.error(`FAIL [${label}]: ${message}`);
  failed++;
}
function check(condition, label, message) {
  if (condition) pass(label);
  else fail(label, message);
}

// ── Helpers ──────────────────────────────────────────────────────────────

const INTERNAL_REGISTRY = {
  updatedAt: '',
  bots: [{ id: 'yumu', name: '雨沐', description: 'x', qq: '', channel: 'internal', enabled: true, commands: [] }],
};

const QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'query_osu',
    description: 'osu queries',
    parameters: { type: 'object', properties: { capability: { type: 'string' } }, required: ['capability'] },
  },
};

function toolCall(index, args = { capability: 'recent' }) {
  return {
    id: `c${index}`,
    type: 'function',
    function: { name: 'query_osu', arguments: JSON.stringify(args) },
  };
}

function manyCalls(count, argsFn = () => ({ capability: 'recent' })) {
  return Array.from({ length: count }, (_v, index) => toolCall(index + 1, argsFn(index + 1)));
}

function llmResponse(text, toolCalls) {
  return {
    text,
    usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
    raw: {
      choices: [{
        message: { content: text, tool_calls: toolCalls || null },
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      }],
    },
  };
}

function scriptedChat(steps) {
  let index = 0;
  const callLog = [];
  const chat = async (_db, opts) => {
    const callIndex = index;
    const step = steps[Math.min(callIndex, steps.length - 1)];
    index++;
    callLog.push({ callIndex, opts });
    return step(callIndex, opts);
  };
  chat.callCount = () => index;
  chat.callLog = callLog;
  return chat;
}

function successExecutor(log = []) {
  return async (tc) => {
    log.push(tc);
    return { toolCallId: tc.id, ok: true, content: 'ok' };
  };
}

function runCapLoop(chat, executor, extra = {}) {
  return runToolLoop(chat, {
    db: extra.db || { settings: {} },
    messages: [{ role: 'user', content: '测试' }],
    tools: extra.tools || [QUERY_TOOL],
    userId: 'REDACTED_QQ_001',
    groupId: '770001',
    maxIterations: extra.maxIterations ?? 8,
    label: 'agent-surface-hardening',
    executeToolCallFn: executor,
    ...extra,
  });
}

function shadowSink() {
  const base = createShadowReasoningRouter(2_000, () => {});
  const records = [];
  return {
    records,
    sink: {
      resolve: (input, turn) => base.resolve(input, turn),
      mergeTurn: (turn, decision) => base.mergeTurn(turn, decision),
      record(entry) {
        records.push(entry);
        base.record(entry);
      },
      snapshot: () => base.snapshot(),
    },
  };
}

function dsmlCalls(calls) {
  const blocks = calls.map((call) =>
    `<invoke name="${call.name}">${
      Object.entries(call.args || {}).map(([key, value]) => `<parameter name="${key}">${value}</parameter>`).join('')
    }</invoke>`,
  ).join('\n');
  return `<tool_calls>\n${blocks}\n</tool_calls>`;
}

// ── A1: match and the exposed tool surface ───────────────────────────────

console.log('\n=== A1: exposed surface / match command-only ===');
{
  const tools = buildBotToolSchemas(INTERNAL_REGISTRY);
  check(
    JSON.stringify(tools.map((tool) => tool.function.name)) === JSON.stringify(['query_osu', 'get_player_skill']),
    'surface-tool-names',
    JSON.stringify(tools.map((tool) => tool.function.name)),
  );
  const queryOsu = tools.find((tool) => tool.function.name === 'query_osu');
  const enumValues = queryOsu?.function.parameters.properties.capability.enum || [];
  const expectedCallable = ['bp', 'bp_type', 'recent', 'info', 'profile', 'ppplus', 'skill', 'recommend', 'beatmap_lookup', 'pp_calc', 'leaderboard'];
  check(JSON.stringify(enumValues) === JSON.stringify(expectedCallable), 'surface-query-osu-enum', JSON.stringify(enumValues));
  check(!enumValues.includes('match'), 'surface-match-absent-from-enum', 'match leaked into LLM enum');
  check(
    JSON.stringify(callableCapabilities()) === JSON.stringify(expectedCallable),
    'surface-callable-capabilities',
    JSON.stringify(callableCapabilities()),
  );
  check(
    ['query_external_bot', 'query_bot', 'list_bots', 'get_recent_score'].every(
      (name) => !tools.some((tool) => tool.function.name === name),
    ),
    'surface-dormant-tools-unexposed',
    JSON.stringify(tools.map((tool) => tool.function.name)),
  );

  const matchGuard = validateOperation({ type: 'query_osu', params: { capability: 'match' } });
  check(matchGuard.ok === false, 'surface-match-agent-rejected', JSON.stringify(matchGuard));
  check(internalCapabilitySupported('match'), 'surface-match-command-side-still-supported', '!ml command route lost');
  check(
    INTERNAL_CAPABILITIES.some((entry) => entry.name === 'match'),
    'surface-match-internal-registry',
    'match missing from INTERNAL_CAPABILITIES',
  );
  const matchMeta = AGENT_CAPABILITY_META.find((entry) => entry.capability === 'match');
  check(matchMeta?.callable === false, 'surface-match-callable-false', JSON.stringify(matchMeta));
  check(matchMeta?.sideEffects === 'stateful', 'surface-match-stateful-not-readonly', JSON.stringify(matchMeta));
}

// ── A3: parameter applicability matrix ───────────────────────────────────

console.log('\n=== A3: query_osu parameter applicability ===');
{
  const rejectCases = [
    ['recent+bp_rank', { capability: 'recent', bp_rank: 5 }],
    ['profile+bp_start', { capability: 'profile', bp_start: 1, bp_end: 2 }],
    ['recommend+accuracy', { capability: 'recommend', accuracy: 99 }],
    ['pp_calc+limit', { capability: 'pp_calc', beatmap_id: 5518740, limit: 5 }],
    ['leaderboard+misses', { capability: 'leaderboard', beatmap_id: 5518740, misses: 1 }],
    ['recent+mods', { capability: 'recent', mods: 'HD' }],
    ['recent+beatmap_id', { capability: 'recent', beatmap_id: 5518740 }],
    ['recent+compact', { capability: 'recent', compact: true }],
    ['beatmap_lookup+username', { capability: 'beatmap_lookup', beatmap_id: 5518740, username: 'x' }],
    ['beatmap_lookup+bp_start', { capability: 'beatmap_lookup', beatmap_id: 5518740, bp_start: 1, bp_end: 2 }],
    ['leaderboard+accuracy', { capability: 'leaderboard', beatmap_id: 5518740, accuracy: 99 }],
    ['leaderboard+bot', { capability: 'leaderboard', beatmap_id: 5518740, bot: 'yumu' }],
    ['pp_calc+bot', { capability: 'pp_calc', beatmap_id: 5518740, bot: 'yumu' }],
    ['beatmap_lookup+bot', { capability: 'beatmap_lookup', beatmap_id: 5518740, bot: 'lazybot' }],
    ['recommend+bot', { capability: 'recommend', bot: 'yumu' }],
    ['profile+bot', { capability: 'profile', bot: 'kanon' }],
    ['bp+bot', { capability: 'bp', bp_rank: 1, bot: 'hydrant' }],
    ['recent+unknown-param', { capability: 'recent', evil: 'x' }],
    ['recent+invalid-bot', { capability: 'recent', bot: 'evil' }],
    ['recent+hydrant-selector', { capability: 'recent', bot: 'hydrant' }],
    ['recent+lazybot-selector', { capability: 'recent', bot: 'lazybot' }],
    ['bp+bp_rank-101', { capability: 'bp', bp_rank: 101 }],
    ['bp+range-101', { capability: 'bp', bp_start: 1, bp_end: 101 }],
    ['pp_calc+accuracy-101', { capability: 'pp_calc', beatmap_id: 5518740, accuracy: 101 }],
    ['pp_calc+combo-negative', { capability: 'pp_calc', beatmap_id: 5518740, combo: -1 }],
    ['pp_calc+misses-1000', { capability: 'pp_calc', beatmap_id: 5518740, misses: 1000 }],
    ['leaderboard+limit-51', { capability: 'leaderboard', beatmap_id: 5518740, limit: 51 }],
    ['beatmap_lookup+missing-bid', { capability: 'beatmap_lookup' }],
    ['pp_calc+mods-odd-length', { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HDD' }],
    ['pp_calc+mods-single-letter', { capability: 'pp_calc', beatmap_id: 5518740, mods: 'H' }],
    ['pp_calc+mods-space', { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HD DT' }],
  ];
  for (const [label, params] of rejectCases) {
    const result = validateOperation({ type: 'query_osu', params });
    check(result.ok === false, `param-reject-${label}`, JSON.stringify(result));
  }

  const allowCases = [
    ['bp+bp_rank', { capability: 'bp', bp_rank: 1 }],
    ['bp+bp_range-100', { capability: 'bp', bp_start: 1, bp_end: 100 }],
    ['bp+bp_range-100-compact', { capability: 'bp', bp_start: 1, bp_end: 100, compact: true }],
    ['recent+username+bot', { capability: 'recent', username: '[TST]Alpha', bot: 'yumu' }],
    ['recent+kanon-selector', { capability: 'recent', username: '[TST]Alpha', bot: 'kanon' }],
    ['recommend+username', { capability: 'recommend', username: '[TST]Alpha' }],
    ['beatmap_lookup+bid+mods', { capability: 'beatmap_lookup', beatmap_id: 5518740, mods: 'HDHR' }],
    ['pp_calc+full', { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HD', accuracy: 99, combo: 1200, misses: 1 }],
    ['leaderboard+limit+mods', { capability: 'leaderboard', beatmap_id: 5518740, mods: 'HDHR', limit: 5 }],
  ];
  for (const [label, params] of allowCases) {
    const result = validateOperation({ type: 'query_osu', params });
    check(result.ok === true, `param-allow-${label}`, JSON.stringify(result));
  }

  // Exhaustive contract: for every EXPOSED parameter × every callable
  // capability, the guard must either accept it (when catalog allowedFor and
  // requiredFor are satisfied) or reject it. No accepted-but-ignored cell may
  // exist.
  const paramValues = {
    username: '[TST]Alpha',
    bot: 'yumu',
    bp_rank: 1,
    bp_start: 1,
    bp_end: 10,
    beatmap_id: 5518740,
    mods: 'HDHR',
    accuracy: 99,
    combo: 1200,
    misses: 1,
    limit: 5,
  };
  for (const param of QUERY_OSU_PARAMS.filter((entry) => entry.exposed)) {
    for (const capability of CAPABILITY_CATALOG.filter((entry) => entry.callable)) {
      const params = { capability: capability.name };
      if (capability.family === 'beatmap') params.beatmap_id = 5518740;
      if (param.name === 'bp_start') params.bp_end = 10;
      if (param.name === 'bp_end') params.bp_start = 1;
      params[param.name] = paramValues[param.name];
      const allowed = (!param.allowedFor || param.allowedFor.includes(capability.name));
      const required = QUERY_OSU_PARAMS
        .filter((entry) => entry.requiredFor?.includes(capability.name))
        .every((entry) => params[entry.name] !== undefined);
      const result = validateOperation({ type: 'query_osu', params });
      const expectedOk = allowed && required;
      check(result.ok === expectedOk, `param-matrix-${param.name}-${capability.name}`, JSON.stringify({ params, result, expectedOk }));
    }
  }

  // compact is deliberately unexposed, but it is still a runtime parameter:
  // bp consumes it, every other callable capability must reject it.
  for (const capability of CAPABILITY_CATALOG.filter((entry) => entry.callable)) {
    const params = { capability: capability.name, compact: true };
    if (capability.family === 'beatmap') params.beatmap_id = 5518740;
    const result = validateOperation({ type: 'query_osu', params });
    check(result.ok === (capability.name === 'bp'), `param-matrix-compact-${capability.name}`, JSON.stringify({ params, result }));
  }
}

// ── A2: hard tool-call budget ────────────────────────────────────────────

console.log('\n=== A2: hard tool-call budget ===');
{
  check(AGENT_MAX_TOOL_CALLS_PER_RESPONSE === 4, 'cap-constant-per-response', String(AGENT_MAX_TOOL_CALLS_PER_RESPONSE));
  check(AGENT_MAX_TOOL_CALLS_PER_TURN === 8, 'cap-constant-per-turn', String(AGENT_MAX_TOOL_CALLS_PER_TURN));
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse('', [toolCall(1)]),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  check(result.toolCallsMade === 1 && !result.hardCapReached && result.toolCallsSkippedByCap === 0,
    'cap-one-call', JSON.stringify({ result, exec: execLog.length }));
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse('', manyCalls(AGENT_MAX_TOOL_CALLS_PER_RESPONSE)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  check(
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsMade === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 0 && !result.hardCapReached,
    'cap-exactly-limit',
    JSON.stringify({ exec: execLog.length, result }),
  );
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse('', manyCalls(AGENT_MAX_TOOL_CALLS_PER_RESPONSE + 1)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  const finalMessages = chat.callLog[1]?.opts?.messages || [];
  const assistant = finalMessages.find((m) => m.role === 'assistant');
  const toolResults = finalMessages.filter((m) => m.role === 'tool');
  check(
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsMade === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 1 && result.hardCapReached === true &&
    assistant?.tool_calls?.length === 5 && toolResults.length === 5 &&
    JSON.stringify([...new Set(toolResults.map((m) => m.tool_call_id))].sort()) ===
      JSON.stringify(assistant.tool_calls.map((tc) => tc.id).sort()),
    'cap-limit-plus-one',
    JSON.stringify({ exec: execLog.length, result, assistant: assistant?.tool_calls?.length, tools: toolResults.length }),
  );
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse('', manyCalls(100)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  const finalMessages = chat.callLog[1]?.opts?.messages || [];
  const assistant = finalMessages.find((m) => m.role === 'assistant');
  const toolResults = finalMessages.filter((m) => m.role === 'tool');
  const balanced = assistant?.tool_calls?.length === 100 && toolResults.length === 100 &&
    JSON.stringify([...new Set(toolResults.map((m) => m.tool_call_id))].sort()) ===
      JSON.stringify(assistant.tool_calls.map((tc) => tc.id).sort());
  check(
    result.text === 'done' && balanced &&
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsMade === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 96 && result.hardCapReached === true,
    'cap-100-malicious-calls',
    JSON.stringify({ exec: execLog.length, result, assistant: assistant?.tool_calls?.length, tools: toolResults.length }),
  );
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse('', manyCalls(4)),
    () => llmResponse('', manyCalls(4)),
    () => llmResponse('', manyCalls(2)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  check(
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_TURN &&
    result.toolCallsMade === AGENT_MAX_TOOL_CALLS_PER_TURN &&
    result.toolCallsSkippedByCap === 2 && result.hardCapReached === true &&
    result.iterations === 3 && chat.callCount() === 4,
    'cap-multi-round-cumulative',
    JSON.stringify({ exec: execLog.length, result, chatCalls: chat.callCount() }),
  );
}

{
  const execLog = [];
  const executor = async (tc) => {
    execLog.push(tc);
    return tc.id === 'c1'
      ? { toolCallId: tc.id, ok: true, content: 'ok', directContent: 'TRUSTED_PANEL_VERBATIM' }
      : { toolCallId: tc.id, ok: true, content: 'ok' };
  };
  const chat = scriptedChat([
    () => llmResponse('', [
      toolCall(1, { capability: 'recommend' }),
      toolCall(2),
      toolCall(3),
      toolCall(4),
      toolCall(5),
    ]),
    () => llmResponse('lead'),
  ]);
  const result = await runCapLoop(chat, executor);
  check(
    result.directContent === 'TRUSTED_PANEL_VERBATIM' &&
    result.text === 'lead' &&
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsMade === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 1 && result.hardCapReached === true &&
    chat.callLog[1]?.opts?.tools === undefined,
    'cap-direct-payload-before-overflow',
    JSON.stringify({ exec: execLog.length, result, finalTools: chat.callLog[1]?.opts?.tools }),
  );
}

{
  const execLog = [];
  const executor = async (tc) => {
    execLog.push(tc);
    return tc.id === 'c1'
      ? { toolCallId: tc.id, ok: false, content: 'boom', error: 'boom' }
      : { toolCallId: tc.id, ok: true, content: 'ok' };
  };
  const { sink, records } = shadowSink();
  const chat = scriptedChat([
    () => llmResponse('', manyCalls(5)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, executor, { reasoningRouter: sink });
  const planners = records.filter((record) => record.callRole === 'tool_planner').map((record) => record.input.previousToolFailed);
  const synthesis = records.find((record) => record.callRole === 'tool_synthesis');
  check(
    result.text === 'done' &&
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 1 && result.hardCapReached === true &&
    JSON.stringify(planners) === JSON.stringify([false]) &&
    synthesis?.input.previousToolFailed === true,
    'cap-failure-plus-overflow',
    JSON.stringify({ exec: execLog.length, result, planners, synthesis: synthesis?.input }),
  );
}

// ── A5: previousToolFailed is batch/turn-level sticky ────────────────────

console.log('\n=== A5: sticky previousToolFailed ===');
{
  const execLog = [];
  const executor = async (tc) => {
    execLog.push(tc);
    // First batch: fail then succeed in the SAME batch. The second planner
    // must still see previousToolFailed=true (old non-sticky code saw false).
    const ok = !(tc.id === 'a1');
    return { toolCallId: tc.id, ok, content: ok ? 'ok' : 'failed', error: ok ? undefined : 'failed' };
  };
  const { sink, records } = shadowSink();
  const chat = scriptedChat([
    () => llmResponse('', [
      { id: 'a1', type: 'function', function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'recent' }) } },
      { id: 'a2', type: 'function', function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'recent' }) } },
    ]),
    () => llmResponse('', manyCalls(2)),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, executor, { reasoningRouter: sink });
  const planners = records.filter((record) => record.callRole === 'tool_planner').map((record) => record.input.previousToolFailed);
  check(
    result.text === 'done' &&
    JSON.stringify(planners) === JSON.stringify([false, true, false]),
    'sticky-failure-consumption-and-reset',
    JSON.stringify({ planners, result }),
  );
}

// ── DSML parity ──────────────────────────────────────────────────────────

console.log('\n=== DSML textual tool calls share caps and guards ===');
{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse(dsmlCalls(manyCalls(5).map((call) => ({
      name: call.function.name,
      args: JSON.parse(call.function.arguments),
    })))),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  check(
    execLog.length === AGENT_MAX_TOOL_CALLS_PER_RESPONSE &&
    result.toolCallsSkippedByCap === 1 && result.hardCapReached === true &&
    !/[<>]|invoke|parameter|tool_calls/i.test(result.text),
    'dsml-cap-parity',
    JSON.stringify({ exec: execLog.length, result }),
  );
}

{
  const execLog = [];
  const chat = scriptedChat([
    () => llmResponse(dsmlCalls([{ name: 'query_bot', args: { bot: 'yumu', command: 'recent' } }])),
    () => llmResponse('done'),
  ]);
  const result = await runCapLoop(chat, successExecutor(execLog));
  check(
    execLog.length === 0 && chat.callCount() === 1 &&
    result.text.length > 0 && !/[<>]|invoke|parameter|tool_calls/i.test(result.text),
    'dsml-unexposed-name-fail-closed',
    JSON.stringify({ exec: execLog.length, chatCalls: chat.callCount(), result }),
  );
}

{
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.unmetCapabilities = [];
    db.toolCallLogs = [];
  });
  const chat = scriptedChat([
    () => llmResponse(dsmlCalls([{ name: 'query_osu', args: { capability: 'recent', bp_rank: 5 } }])),
    () => llmResponse('done'),
  ]);
  const result = await runToolLoop(chat, {
    db: readDb(),
    messages: [{ role: 'user', content: '测试' }],
    tools: [QUERY_TOOL],
    userId: 'REDACTED_QQ_001',
    groupId: '770001',
    maxIterations: 4,
    label: 'agent-surface-dsml-guard',
  });
  const finalMessages = chat.callLog[1]?.opts?.messages || [];
  const guardedTool = finalMessages.find((m) => m.role === 'tool');
  const db = readDb();
  const audit = (db.toolCallLogs || []).find((entry) => entry.capability === 'recent');
  const unmet = (db.unmetCapabilities || []).find((entry) =>
    entry.toolName === 'query_osu' && entry.intent === 'recent' && entry.reason === 'TOOL_ARGUMENT_UNRESOLVED',
  );
  check(
    guardedTool && /操作被安全策略拒绝/.test(String(guardedTool.content || '')) &&
    /bp_rank 不能与 recent/.test(String(guardedTool.content || '')) &&
    audit?.ok === false && Boolean(unmet) && !/[<>]|invoke|parameter|tool_calls/i.test(result.text),
    'dsml-same-parameter-guard',
    JSON.stringify({ toolContent: guardedTool?.content, audit, unmet, result }),
  );
}

// ── A6: rollout/sideEffects metadata discipline ──────────────────────────

console.log('\n=== A6: rollout / sideEffects metadata discipline ===');
{
  const audit = auditAgentCapabilityRegistry();
  check(audit.length === 0, 'audit-registry-clean', JSON.stringify(audit));
  const callable = AGENT_CAPABILITY_META.filter((entry) => entry.callable);
  check(callable.length > 0, 'audit-callable-nonempty', 'no callable capabilities');
  check(callable.every((entry) => entry.rollout === 'all'), 'audit-callable-all-rollout-all', JSON.stringify(callable.map((entry) => entry.rollout)));
  check(callable.every((entry) => entry.sideEffects === 'readonly'), 'audit-callable-all-readonly', JSON.stringify(callable.map((entry) => entry.sideEffects)));
  const commandOnly = AGENT_CAPABILITY_META.filter((entry) => !entry.callable);
  check(commandOnly.some((entry) => entry.sideEffects === 'stateful'), 'audit-command-only-stateful-allowed', JSON.stringify(commandOnly));
}

// ── A4: schema text matches runtime caps ─────────────────────────────────

console.log('\n=== A4: schema/runtime drift ===');
{
  const tools = buildBotToolSchemas(INTERNAL_REGISTRY);
  const queryOsu = tools.find((tool) => tool.function.name === 'query_osu');
  const properties = queryOsu.function.parameters.properties;
  check(String(properties.bp_start.description).includes('100'), 'drift-bp-start-100', properties.bp_start.description);
  check(!String(properties.bp_start.description).includes('20'), 'drift-bp-start-not-20', properties.bp_start.description);
  check(!String(properties.bot.description).includes('忽略'), 'drift-bot-not-ignore', properties.bot.description);
  check(String(properties.bot.description).includes('仅 capability=recent'), 'drift-bot-recent-only', properties.bot.description);
  check(JSON.stringify(properties.bot.enum) === JSON.stringify(['yumu', 'kanon']), 'drift-bot-supported-selectors-only', JSON.stringify(properties.bot));
  check(validateOperation({ type: 'query_osu', params: { capability: 'recent', bot: 'evil' } }).ok === false, 'drift-bot-enum-enforced', 'unknown bot accepted');
  check(properties.username.maxLength === 128, 'drift-username-max-length', JSON.stringify(properties.username));
  check(properties.mods.maxLength === 16 && properties.mods.pattern === '^([A-Za-z]{2})*$', 'drift-mods-lexical-gate', JSON.stringify(properties.mods));
  check(validateOperation({ type: 'query_osu', params: { capability: 'recent', username: 'x'.repeat(129) } }).ok === false, 'drift-username-guard-matches-schema', 'oversized username accepted');
  check(validateOperation({ type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HDD' } }).ok === false, 'drift-mods-odd-rejected', 'odd mod length accepted');
  check(validateOperation({ type: 'query_osu', params: { capability: 'pp_calc', beatmap_id: 5518740, mods: 'HDHR' } }).ok === true, 'drift-mods-even-accepted', 'even mod length rejected');
}

cleanupTestDir(testDataDir);

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
const prodOk = verifyProductionDbUnchanged(prodBefore);
if (!prodOk) {
  console.error('AGENT-TOOL-SURFACE-HARDENING-VERIFY: production db changed');
  failed++;
}
if (failed > 0) {
  console.error('AGENT-TOOL-SURFACE-HARDENING-VERIFY FAILED');
  process.exit(1);
}
console.log('AGENT-TOOL-SURFACE-HARDENING-VERIFY PASSED');
