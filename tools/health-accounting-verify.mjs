import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const dir = createTestDataDir('wuxin-health-accounting');
const { readDb, ensureStore, updateDb, publicDb } = await import('../server/store.ts');
const { completeChat } = await import('../server/bot/llm.ts');
const { recordLlmInvocation } = await import('../server/llmLedger.ts');
const { mergeLlmUsage, usageEventFields, applyUsageTotals, measuredPromptTokens } = await import('../server/usage.ts');
const { mapCodexTokenUsage, parseCodexAdapterEnvelope, codexInvocationConfig } = await import('../server/codexAppServer.ts');
const { runToolLoop, mergeToolLoopResults, executeToolCall, registerPendingBotCall, tryResolveBotResponse } = await import('../server/bots/executor.ts');
const { withLlmTurnPolicy, reserveLlmInvocation, hasTurnFallback, markTurnFallback } = await import('../server/llmPolicy.ts');

const usage = { total_tokens: 120, prompt_tokens: 100, completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 72 }, completion_tokens_details: { reasoning_tokens: 8 } };
const completion = text => ({ text, usage, raw: { choices: [{ message: { content: text } }] } });
try {
  ensureStore();
  assert.equal(mapCodexTokenUsage().cache_metrics_available, false);
  assert.equal(mapCodexTokenUsage().usage_known, false);
  const mixed = mergeLlmUsage(usage, { prompt_tokens: 900, total_tokens: 900 });
  assert.equal(measuredPromptTokens(mixed), 100);
  assert.equal(measuredPromptTokens(mergeLlmUsage(mixed, usage)), 200);
  const mixedLedger = mergeLlmUsage({ ...usage, accounted: true }, usage);
  const recoverable = {};
  applyUsageTotals(recoverable, mergeLlmUsage(mixedLedger, { ...usage, accounted: true }));
  assert.equal(recoverable.totalTokens, 120, 'recover only unpaid invocation after a partial ledger write failure');
  assert.equal(usageEventFields(mixedLedger).totalTokens, 120);
  const legacyCompatible = usageEventFields({ ...usage, accounted: true });
  assert.equal(legacyCompatible.totalTokens, 0);
  assert.equal(legacyCompatible.cacheMetricsAvailable, false);
  assert.equal(legacyCompatible.observedUsage.totalTokens, 120);
  console.log('PASS unknown usage is not measured zero; mixed cache denominator stays partial');

  for (const argumentsText of ['{"username":', 'null', '[]', '42', '"name"', '']) {
    const parsed = parseCodexAdapterEnvelope(JSON.stringify({ kind: 'tool_calls', content: '', tool_calls: [{ name: 'query_osu', id: 'bad', arguments: argumentsText }] }));
    const result = await executeToolCall({ id: 'bad', type: 'function', function: { name: 'query_osu', arguments: parsed.toolCalls[0].rawArguments } }, { db: {}, userId: 'fixture' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'INVALID_TOOL_ARGUMENTS');
    const v2 = await executeToolCall({ id: 'bad-v2', type: 'function', function: { name: 'osu_get_player_profile', arguments: argumentsText } }, { db: {}, userId: 'fixture' });
    assert.equal(v2.error, 'INVALID_TOOL_ARGUMENTS');
  }
  console.log('PASS real adapter/executor rejects corrupt or non-object arguments before defaults');

  let capturedRole;
  const toolOptions = { db: { settings: {} }, userId: 'fixture', messages: [{ role: 'user', content: '查资料' }],
    tools: [], requiredTool: { toolName: 'query_osu', args: { capability: 'profile' } }, deliverDirectContent: false,
    executeToolCallFn: async call => ({ toolCallId: call.id, ok: true, content: '玩家 Example\nPP: 123.45\n路径 C:\\private\\file' }) };
  const fallback = await runToolLoop(async (_db, opts) => { capturedRole = opts.traceRole; throw new Error('synthesis failure'); }, toolOptions);
  assert.equal(capturedRole, 'tool_synthesis');
  assert.match(fallback.text, /PP: 123\.45/);
  assert.doesNotMatch(fallback.text, /C:\\private/);
  const first = await runToolLoop(async () => completion('first'), toolOptions);
  const merged = mergeToolLoopResults({ ...first, images: ['old'], evidenceRequirementSatisfied: true }, { ...first, images: ['new'], evidenceRequirementSatisfied: false });
  assert.equal(merged.usage.prompt_tokens_details.cached_tokens, 144);
  assert.equal(merged.usage.completion_tokens_details.reasoning_tokens, 16);
  assert.deepEqual(merged.images, ['old', 'new']);
  assert.equal(merged.evidenceRequirementSatisfied, true);
  console.log('PASS real loops preserve usage/attachments/evidence; failed text synthesis delivers safe source data');

  const botDb = { settings: { botResponseProgressSettleMs: 5, botRegistry: { bots: [{ id: 'progress-fixture', name: 'fixture', qq: '100', channel: 'qq_private', enabled: true, commands: [] }] } } };
  const pending = registerPendingBotCall({ correlationId: 'progress', botId: 'progress-fixture', channel: 'qq_private' }, 30);
  assert.equal(tryResolveBotResponse(botDb, { type: 'private', userId: '100', text: '正在查询' }), true);
  assert.equal((await pending).ok, false);
  console.log('PASS real external-bot route: progress alone is not evidence');

  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', bytes => { raw += bytes; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      if (requests.length === 2) { res.writeHead(503); res.end('{"error":{"message":"injected failure"}}'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'fixture', model: 'actual-fixture', choices: [{ message: { role: 'assistant', content: '已生成' }, finish_reason: 'stop' }], usage }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const db = { settings: { llmProvider: 'openai-compatible', model: 'fixture', apiKey: 'test-only', apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
    const opts = { messages: [{ role: 'user', content: 'test' }], requestMaxRetries: 0, retryOnEmpty: false };
    const before = readDb().usage.totalTokens;
    const result = await completeChat(db, opts);
    // No QQ delivery/bookkeeping is performed: invocation must already exist.
    assert.equal(readDb().usage.totalTokens, before + 120);
    await assert.rejects(completeChat(db, opts), /injected failure/);
    const events = readDb().usageEvents.filter(event => event.kind === 'llm-call');
    assert.equal(events.length, 2);
    assert.equal(events[0].model, 'actual-fixture');
    assert.equal(events[1].usageKnown, false);
    assert.equal(events[1].status, 'failed');
    const requestsBefore = readDb().usage.requests;
    const dayBefore = publicDb().usageStats.today.totalTokens;
    updateDb(draft => {
      applyUsageTotals(draft.usage, mergeLlmUsage(result.usage));
      draft.usageEvents.push({ ...usageEventFields(result.usage), createdAt: new Date().toISOString() });
    });
    assert.equal(readDb().usage.totalTokens, before + 120);
    assert.equal(publicDb().usageStats.today.totalTokens, dayBefore);
    recordLlmInvocation({ invocationId: events[0].id, provider: 'fixture', model: 'fixture', purpose: 'duplicate', startedAt: Date.now(), usage });
    assert.equal(readDb().usage.requests, requestsBefore);
    console.log('PASS real SDK + store: completed invocation survives later failure; ledger identity/dedup/period totals correct');
    const fallbackDb = { settings: { ...db.settings, llmProvider: 'codex-app-server',
      codexExecutable: path.join(dir, 'deliberately-absent-codex.exe'), codexModel: 'fixture-codex',
      codexFallbackEnabled: true, codexFallbackProvider: 'openai-compatible', codexFallbackModel: 'fixture' } };
    await withLlmTurnPolicy(async () => {
      const first = await completeChat(fallbackDb, opts);
      const next = await completeChat(fallbackDb, opts);
      assert.equal(first.fallbackFrom, 'codex-app-server');
      assert.equal(next.fallbackFrom, 'codex-app-server');
    });
    const nativeAttempts = readDb().usageEvents.filter(event => event.kind === 'llm-call' && event.provider === 'codex-app-server');
    assert.equal(nativeAttempts.length, 1, 'next round must not re-launch the failed transport');
    assert.equal(nativeAttempts[0].usageKnown, false);
    console.log('PASS completeChat fallback: missing Codex process attempted once, then successful provider reused within turn');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  withLlmTurnPolicy(() => {
    const claim = reserveLlmInvocation(1000); claim.release(); claim.release();
    assert.throws(() => reserveLlmInvocation(1000), /BUDGET_EXHAUSTED/);
    markTurnFallback('fixture'); assert.equal(hasTurnFallback('fixture'), true);
  }, { maxCalls: 1, timeoutMs: 1000 });
  withLlmTurnPolicy(() => assert.equal(hasTurnFallback('fixture'), false));
  withLlmTurnPolicy(() => assert.throws(() => reserveLlmInvocation(1000), /BUDGET_EXHAUSTED/), { maxCalls: 12, timeoutMs: -1 });
  const claims = Array.from({ length: 4 }, () => reserveLlmInvocation(1000));
  assert.throws(() => reserveLlmInvocation(1000), /CAPACITY_EXHAUSTED/);
  claims.forEach(claim => claim.release());
  assert.equal(codexInvocationConfig({ codexReasoningEffort: 'max' }, { thinking: { type: 'disabled' } }).effort, 'low');
  assert.equal(codexInvocationConfig({}, { reasoning_effort: 'high' }).effort, 'high');
  assert.equal(codexInvocationConfig({}, { maxTokens: 30 }).capabilities.hardMaxTokens, false);
  console.log('PASS invocation/time/concurrency budgets and explicit Codex capability limitations');
} finally { cleanupTestDir(dir); }
