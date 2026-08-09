// reasoning-router-verify.mjs
// Phase 2 v1 Reasoning Router regression. Fully OFFLINE:
//   - pure resolver matrix (roles x features -> level/source/reasonCode)
//   - OFF/HIGH/MAX wire mapping via thinkingParamsForLevel
//   - kill switch semantics via reasoningEnabledFor
//   - monotonic turn-level inheritance (planner max -> synthesis inherits
//     with the ORIGINAL root reason code; never reasonCode 'inherit')
//   - decorative lead / direct-delivery exceptions never inherit
//   - LlmCompletionMeta extraction degrades safely on missing/malformed raw
//   - isReasoningBudgetExhaustion 4-combination matrix
//   - runToolLoop integration: tool_planner records + synthesis inheritance
//   - shadow records carry structured input only (no user text / payload)
// Exit 0 on all pass, non-zero on any failure.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  createShadowReasoningRouter,
  resolveReasoningMode,
  mergeTurnState,
  decideAndRecord,
  formatShadowRecord,
  reasoningInput,
  emptyTurnState,
  reasoningEnabledFor,
} = await import(pathToFileURL(path.join(REPO, 'server', 'bot', 'reasoningRouter.ts')).href);
const { buildLlmCompletionMeta, isReasoningBudgetExhaustion, thinkingParamsForLevel } =
  await import(pathToFileURL(path.join(REPO, 'server', 'bot', 'llm.ts')).href);
const { runToolLoop } = await import(pathToFileURL(path.join(REPO, 'server', 'bots', 'executor.ts')).href);

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
function assert(cond, label, msg) {
  if (cond) pass(label);
  else fail(label, msg);
}
function eq(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const OFF = 'off';
const HIGH = 'high';
const MAX = 'max';

// ── 1. Resolver matrix ──
{
  const label = 'resolver';
  const d = (callRole, partial = {}, turn = emptyTurnState()) =>
    resolveReasoningMode(reasoningInput(callRole, partial), turn);

  eq(d('decorative_lead', { hasDirectPayload: true }, { maxLevel: MAX, rootReasonCode: 'tool_selection' }),
    { level: OFF, source: 'rule', reasonCode: 'direct_delivery' }, `${label}:decorative-lead-never-inherit`);
  eq(d('conversation'), { level: OFF, source: 'rule', reasonCode: 'simple_chat' }, `${label}:conversation-off`);
  eq(d('conversation', { contextDependent: true }),
    { level: HIGH, source: 'rule', reasonCode: 'context_dependency' }, `${label}:conversation-context-high`);
  eq(d('rewrite'), { level: OFF, source: 'rule', reasonCode: 'fast_default' }, `${label}:rewrite-off`);
  eq(d('rewrite', { previousFastFailure: true }),
    { level: MAX, source: 'escalation', reasonCode: 'fast_failure_escalation' }, `${label}:rewrite-escalation`);

  eq(d('tool_planner', { requiredTool: true }), { level: OFF, source: 'rule', reasonCode: 'deterministic_tool' }, `${label}:planner-required-tool`);
  eq(d('tool_planner', { terminalFinal: true }), { level: OFF, source: 'rule', reasonCode: 'deterministic_tool' }, `${label}:planner-terminal`);
  eq(d('tool_planner', { hasDirectPayload: true }), { level: OFF, source: 'rule', reasonCode: 'direct_delivery' }, `${label}:planner-direct`);
  eq(d('tool_planner', { previousToolFailed: true }), { level: MAX, source: 'rule', reasonCode: 'tool_failure_recovery' }, `${label}:planner-failure-recovery`);
  eq(d('tool_planner', { ambiguousTarget: true }), { level: MAX, source: 'rule', reasonCode: 'tool_ambiguity' }, `${label}:planner-ambiguity`);
  eq(d('tool_planner', { toolCallsMade: 2, iterations: 3, toolSelectionRequired: true }),
    { level: MAX, source: 'rule', reasonCode: 'tool_multi_step' }, `${label}:planner-multi-step`);
  eq(d('tool_planner', { toolSelectionRequired: true }), { level: MAX, source: 'rule', reasonCode: 'tool_selection' }, `${label}:planner-selection`);
  eq(d('tool_planner', { contextDependent: true }), { level: HIGH, source: 'rule', reasonCode: 'context_dependency' }, `${label}:planner-context-high`);
  eq(d('tool_planner', { contextDependent: true, toolSelectionRequired: true }),
    { level: MAX, source: 'rule', reasonCode: 'tool_selection' }, `${label}:planner-high-plus-selection-max`);
  eq(d('tool_planner'), { level: OFF, source: 'rule', reasonCode: 'fast_default' }, `${label}:planner-off-default`);

  eq(d('tool_synthesis', { hasDirectPayload: true }, { maxLevel: MAX, rootReasonCode: 'tool_selection' }),
    { level: OFF, source: 'rule', reasonCode: 'direct_delivery' }, `${label}:synthesis-direct-exception`);
  eq(d('tool_synthesis', {}, { maxLevel: HIGH, rootReasonCode: 'context_dependency' }),
    { level: HIGH, source: 'inherit', reasonCode: 'context_dependency' }, `${label}:synthesis-inherits-high-root`);
  eq(d('tool_synthesis', {}, { maxLevel: MAX, rootReasonCode: 'tool_selection' }),
    { level: MAX, source: 'inherit', reasonCode: 'tool_selection' }, `${label}:synthesis-inherits-max-root`);
  eq(d('tool_synthesis', { requiresStructuredComparison: true }),
    { level: MAX, source: 'rule', reasonCode: 'structured_fact_compare' }, `${label}:synthesis-structured-compare`);
  eq(d('tool_synthesis'), { level: OFF, source: 'rule', reasonCode: 'fast_default' }, `${label}:synthesis-off-default`);
}

// ── 2. Monotonic turn state ──
{
  const label = 'turn-state';
  let turn = emptyTurnState();
  turn = mergeTurnState(turn, { level: HIGH, source: 'rule', reasonCode: 'context_dependency' });
  eq(turn, { maxLevel: HIGH, rootReasonCode: 'context_dependency' }, `${label}:high-triggered`);
  turn = mergeTurnState(turn, { level: MAX, source: 'rule', reasonCode: 'tool_selection' });
  eq(turn, { maxLevel: MAX, rootReasonCode: 'context_dependency' }, `${label}:max-upgrade-keeps-root`);
  turn = mergeTurnState(turn, { level: OFF, source: 'rule', reasonCode: 'direct_delivery' });
  eq(turn, { maxLevel: MAX, rootReasonCode: 'context_dependency' }, `${label}:off-never-clears`);
  eq(mergeTurnState(emptyTurnState(), { level: OFF, source: 'rule', reasonCode: 'fast_default' }),
    emptyTurnState(), `${label}:untouched`);
}

// ── 3. LlmCompletionMeta safe extraction ──
{
  const label = 'meta';
  const full = buildLlmCompletionMeta({
    choices: [{ message: { content: ' x ', tool_calls: [] }, finish_reason: 'stop' }],
    usage: { completion_tokens: 5, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 3 } },
  }, { model: 'deepseek-v4-flash', provider: 'deepseek', latencyMs: 123 });
  eq(full, {
    finishReason: 'stop', reasoningTokens: 3, completionTokens: 5, totalTokens: 10,
    contentEmpty: false, hadToolCalls: false, model: 'deepseek-v4-flash', provider: 'deepseek', latencyMs: 123,
  }, `${label}:full`);

  const empty = buildLlmCompletionMeta({}, {});
  eq(empty, {
    finishReason: null, reasoningTokens: 0, completionTokens: 0, totalTokens: 0,
    contentEmpty: true, hadToolCalls: false, model: '', provider: '', latencyMs: 0,
  }, `${label}:empty-safe`);

  const weird = buildLlmCompletionMeta({
    choices: [{ message: { content: '', tool_calls: [{ id: 'c1' }] }, finish_reason: 'tool_calls' }],
    usage: { completion_tokens: NaN, total_tokens: -3, completion_tokens_details: { reasoning_tokens: 'x' } },
  }, { model: 'mimo-v2.5', provider: 'openai-compatible', latencyMs: NaN });
  eq(weird, {
    finishReason: 'tool_calls', reasoningTokens: 0, completionTokens: 0, totalTokens: 0,
    contentEmpty: true, hadToolCalls: true, model: 'mimo-v2.5', provider: 'openai-compatible', latencyMs: 0,
  }, `${label}:malformed-safe`);
}

// ── 4. isReasoningBudgetExhaustion matrix ──
{
  const label = 'budget';
  const meta = (finishReason, reasoningTokens, contentEmpty, hadToolCalls) =>
    ({ finishReason, reasoningTokens, contentEmpty, hadToolCalls });
  assert(isReasoningBudgetExhaustion(meta('length', 50, true, false)), `${label}:exhaustion`, 'should be true');
  assert(!isReasoningBudgetExhaustion(meta('stop', 50, true, false)), `${label}:stop-not-exhaustion`, 'stop is not exhaustion');
  assert(!isReasoningBudgetExhaustion(meta('length', 0, true, false)), `${label}:no-reasoning-not-exhaustion`, 'no reasoning tokens');
  assert(!isReasoningBudgetExhaustion(meta('length', 50, false, false)), `${label}:content-not-empty`, 'content present');
  assert(!isReasoningBudgetExhaustion(meta('length', 50, true, true)), `${label}:tool-calls-not-exhaustion`, 'tool calls present');
}

// ── 5. Wire mapping + kill switch ──
{
  const label = 'wire';
  eq(thinkingParamsForLevel(OFF, true), { thinking: { type: 'disabled' } }, `${label}:off`);
  eq(thinkingParamsForLevel(HIGH, true), { thinking: { type: 'enabled' }, reasoning_effort: 'high' }, `${label}:high`);
  eq(thinkingParamsForLevel(MAX, true), { thinking: { type: 'enabled' }, reasoning_effort: 'max' }, `${label}:max`);
  eq(thinkingParamsForLevel(MAX, false), { thinking: { type: 'disabled' } }, `${label}:kill-switch-forces-off`);
}
{
  const label = 'kill-switch';
  const original = process.env.REASONING_ENABLED;
  try {
    delete process.env.REASONING_ENABLED;
    assert(reasoningEnabledFor({ settings: { reasoningEnabled: true } }), `${label}:settings-on-env-unset`, 'should be true');
    assert(!reasoningEnabledFor({ settings: { reasoningEnabled: false } }), `${label}:settings-off`, 'should be false');
    assert(!reasoningEnabledFor({ settings: {} }), `${label}:missing-settings`, 'should be false');
    process.env.REASONING_ENABLED = 'false';
    assert(!reasoningEnabledFor({ settings: { reasoningEnabled: true } }), `${label}:env-false-veto`, 'should be false');
    process.env.REASONING_ENABLED = '0';
    assert(!reasoningEnabledFor({ settings: { reasoningEnabled: true } }), `${label}:env-0-veto`, 'should be false');
    process.env.REASONING_ENABLED = 'true';
    assert(reasoningEnabledFor({ settings: { reasoningEnabled: true } }), `${label}:env-true-allows`, 'should be true');
  } finally {
    if (original === undefined) delete process.env.REASONING_ENABLED;
    else process.env.REASONING_ENABLED = original;
  }
}

// ── 6. decideAndRecord: structured input only ──
{
  const label = 'record';
  const router = createShadowReasoningRouter();
  const meta = buildLlmCompletionMeta({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }, {});
  const input = reasoningInput('conversation', { contextDependent: true });
  const { decision } = decideAndRecord(router, 'turn-1', input, meta);
  const records = router.snapshot();
  assert(records.length === 1, `${label}:recorded`, `expected 1, got ${records.length}`);
  eq(decision, { level: HIGH, source: 'rule', reasonCode: 'context_dependency' }, `${label}:decision`);
  eq(records[0].turnId, 'turn-1', `${label}:turn-id`);
  eq(records[0].actual, meta, `${label}:actual`);
  const keys = Object.keys(records[0].input);
  assert(!keys.includes('text') && !keys.includes('history') && !keys.includes('payload'),
    `${label}:no-raw-fields`, `unexpected keys: ${keys.join(',')}`);
  assert(keys.every((k) => ['boolean', 'number', 'string'].includes(typeof records[0].input[k])),
    `${label}:structured-only`, `non-structured value in input`);
  const line = formatShadowRecord(records[0]);
  const parsed = JSON.parse(line);
  eq(Object.keys(parsed).join(','),
    'ts,turnId,callRole,level,source,reasonCode,actualModel,finishReason,reasoningTokens,completionTokens,totalTokens,latencyMs,toolCalls,textEmpty',
    `${label}:format-keys`);
  eq(parsed.turnId, 'turn-1', `${label}:format-turn-id`);
  eq(parsed.callRole, 'conversation', `${label}:format-role`);
  eq(parsed.level, 'high', `${label}:format-level`);
  eq(parsed.textEmpty, false, `${label}:format-text-empty`);
}

// ── 7. runToolLoop integration ──
const fakeToolSchema = [{
  type: 'function',
  function: { name: 'fake_tool', description: 'fake', parameters: { type: 'object', properties: {}, required: [] } },
}];
const metaFor = (content, toolCalls, finishReason) =>
  buildLlmCompletionMeta({
    choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: finishReason }],
    usage: { completion_tokens: 1, total_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
  }, { model: 'deepseek-v4-flash', provider: 'deepseek', latencyMs: 7 });

{
  const label = 'loop:planner';
  const router = createShadowReasoningRouter();
  const fakeChat = async () => ({
    text: 'hi',
    usage: {},
    meta: metaFor('hi', null, 'stop'),
    raw: { choices: [{ message: { content: 'hi', tool_calls: null }, finish_reason: 'stop' }] },
  });
  const result = await runToolLoop(fakeChat, {
    db: {},
    messages: [{ role: 'user', content: 'hello' }],
    tools: fakeToolSchema,
    userId: 'u',
    groupId: 'g',
    maxIterations: 4,
    turnId: 't-plan',
    reasoningRouter: router,
  });
  assert(result.text === 'hi', `${label}:text`, result.text);
  const records = router.snapshot();
  assert(records.length === 1, `${label}:count`, `expected 1, got ${records.length}`);
  eq(records[0].callRole, 'tool_planner', `${label}:role`);
  eq(records[0].decision, { level: MAX, source: 'rule', reasonCode: 'tool_selection' }, `${label}:decision`);
}

{
  const label = 'loop:synthesis-inherit';
  const router = createShadowReasoningRouter();
  let calls = 0;
  const fakeChat = async () => {
    calls++;
    if (calls <= 4) {
      const tc = [{ id: `c${calls}`, type: 'function', function: { name: 'fake_tool', arguments: '{}' } }];
      return {
        text: '',
        usage: {},
        meta: metaFor('', tc, 'tool_calls'),
        raw: { choices: [{ message: { content: '', tool_calls: tc }, finish_reason: 'tool_calls' }] },
      };
    }
    return {
      text: 'done',
      usage: {},
      meta: metaFor('done', null, 'stop'),
      raw: { choices: [{ message: { content: 'done', tool_calls: null }, finish_reason: 'stop' }] },
    };
  };
  const result = await runToolLoop(fakeChat, {
    db: {},
    messages: [{ role: 'user', content: 'do it' }],
    tools: fakeToolSchema,
    userId: 'u',
    groupId: 'g',
    maxIterations: 4,
    turnId: 't-syn',
    reasoningRouter: router,
  });
  assert(result.text === 'done', `${label}:text`, result.text);
  const records = router.snapshot();
  assert(records.length === 5, `${label}:count`, `expected 5 (4 planner + 1 synthesis), got ${records.length}`);
  eq(records.map((r) => r.callRole), ['tool_planner', 'tool_planner', 'tool_planner', 'tool_planner', 'tool_synthesis'], `${label}:roles`);
  eq(records[0].decision, { level: MAX, source: 'rule', reasonCode: 'tool_selection' }, `${label}:first-planner`);
  eq(records[1].decision, { level: MAX, source: 'rule', reasonCode: 'tool_failure_recovery' }, `${label}:second-planner`);
  eq(records[4].decision, { level: MAX, source: 'inherit', reasonCode: 'tool_selection' }, `${label}:synthesis-inherit-root`);
}

console.log(`\nREASONING-ROUTER-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
