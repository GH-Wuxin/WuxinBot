// Phase B contract tests for the offline Agent Replay Harness.
// This file intentionally lives at tools/*-verify.mjs so `npm run verify-all`
// executes it automatically through the shared tsx runtime.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep the focused trace-normalization checks in the automatic verifier set.
await import('./agent-runtime/trace-verify.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'agent-runtime');
const CLI = path.join(ROOT, 'tools', 'agent-replay.ts');

const {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
} = await import('./agent-runtime/types.ts');
const {
  parseReplayScenario,
  parseReplayScenarioJson,
  ReplayScenarioError,
} = await import('./agent-runtime/scenario.ts');
const { evaluateOracles } = await import('./agent-runtime/oracles.ts');
const {
  normalizedJson,
  semanticJson,
  sanitizeTraceString,
  TraceRecorder,
} = await import('./agent-runtime/trace.ts');
const { installReplayIsolation } = await import('./agent-runtime/isolation.ts');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  PASS ${name}`);
}

function baseScenario(id = 'VERIFY_BASE') {
  return {
    schemaVersion: SCHEMA_VERSION,
    traceVersion: TRACE_VERSION,
    generatorVersion: GENERATOR_VERSION,
    id,
    seed: 7001,
    initialState: {
      context: { userId: 'actor-1', groupId: 'group-1' },
      db: { settings: {} },
      messages: [{ role: 'user', content: 'offline verify' }],
      toolSchemas: [],
      maxIterations: 3,
    },
    llmSteps: [{ outcome: 'return', text: 'done' }],
    toolSteps: [],
    expected: { enforced: [] },
  };
}

function expectScenarioError(value, pattern) {
  assert.throws(
    () => parseReplayScenario(value, '<verify>'),
    (error) => error instanceof ReplayScenarioError && pattern.test(error.message),
  );
}

function terminalResult(overrides = {}) {
  return {
    kind: 'result',
    result: {
      text: '',
      usage: {},
      toolCallsMade: 0,
      iterations: 0,
      recommendToolCalled: false,
      images: [],
      directContent: '',
      ...overrides,
    },
  };
}

function oracleScenario(ids) {
  const scenario = baseScenario('VERIFY_ORACLE');
  scenario.expected.enforced = ids.map((id) => ({ kind: 'invariant', id }));
  return scenario;
}

function oracleMap(results) {
  return new Map(results.map((result) => [result.id, result]));
}

function evaluateTrace(trace, ids) {
  return oracleMap(evaluateOracles(
    oracleScenario(ids),
    trace,
    { llmConsumed: 0, llmTotal: 0, toolConsumed: 0, toolTotal: 0 },
  ));
}

function readScenario(file) {
  const fullPath = path.join(FIXTURES, file);
  return parseReplayScenarioJson(fs.readFileSync(fullPath, 'utf8'), fullPath);
}

console.log('\n=== Agent Replay Phase B contracts ===');

await check('parser keeps enforced/candidate invariant tiers honest', () => {
  const candidateInEnforced = baseScenario('VERIFY_BAD_TIER_A');
  candidateInEnforced.expected.enforced = [{ kind: 'invariant', id: 'RT_FINAL_IMAGES_PRESERVED' }];
  expectScenarioError(candidateInEnforced, /belongs in expected\.candidate/);

  const enforcedInCandidate = baseScenario('VERIFY_BAD_TIER_B');
  enforcedInCandidate.expected.candidate = [{ kind: 'invariant', id: 'RT_FINAL_NO_LLM' }];
  expectScenarioError(enforcedInCandidate, /belongs in expected\.enforced/);
});

await check('parser rejects semantic sidecars and unknown fields in initialState', () => {
  for (const field of ['actor', 'target', 'facts', 'constraints', 'symbolicClaims']) {
    const scenario = baseScenario(`VERIFY_SIDECAR_${field.toUpperCase()}`);
    scenario.initialState[field] = {};
    expectScenarioError(scenario, new RegExp(`initialState\\.${field}.*oracleSidecar`));
  }
  const unknown = baseScenario('VERIFY_UNKNOWN_STATE');
  unknown.initialState.surprise = true;
  expectScenarioError(unknown, /initialState\.surprise.*unknown initialState field/);
});

await check('parser rejects unstable IDs and every incompatible version', () => {
  const badId = baseScenario('VERIFY_BAD_ID');
  badId.id = 'not-stable';
  expectScenarioError(badId, /stable ID/);

  for (const key of ['schemaVersion', 'traceVersion', 'generatorVersion']) {
    const scenario = baseScenario(`VERIFY_BAD_${key.toUpperCase()}`);
    scenario[key] = 999;
    expectScenarioError(scenario, new RegExp(`\\$\\.${key}.*expected`));
  }
});

await check('both checked-in replay fixtures parse successfully', () => {
  assert.equal(readScenario('scenario.min.json').id, 'REPLAY_FINAL_MIN');
  assert.equal(readScenario('direct-lead.json').id, 'REPLAY_DIRECT_LEAD');
});

await check('final oracles require an observed final signal', () => {
  const recorder = new TraceRecorder('VERIFY_NO_FINAL', 1);
  const trace = recorder.finish(terminalResult());
  const results = evaluateTrace(trace, ['RT_FINAL_NO_LLM', 'RT_FINAL_NO_TOOL', 'RT_FINAL_NO_EFFECT']);
  for (const id of ['RT_FINAL_NO_LLM', 'RT_FINAL_NO_TOOL', 'RT_FINAL_NO_EFFECT']) {
    assert.equal(results.get(id).passed, false);
    assert.match(results.get(id).detail, /no final signal observed/);
  }
});

await check('final oracles detect LLM, tool and business effects after final', () => {
  const cases = [
    ['RT_FINAL_NO_LLM', 'llm_call'],
    ['RT_FINAL_NO_TOOL', 'tool_call'],
    ['RT_FINAL_NO_EFFECT', 'business_effect'],
  ];
  for (const [id, eventType] of cases) {
    const recorder = new TraceRecorder(`VERIFY_${id}`, 2);
    recorder.push('final_signal_observed', { toolCallId: 'tc1' });
    recorder.push(eventType, { marker: id });
    const result = evaluateTrace(recorder.finish(terminalResult()), [id]).get(id);
    assert.equal(result.passed, false, `${id} should reject ${eventType}`);
  }
});

await check('final permits housekeeping and terminal recording only', () => {
  const recorder = new TraceRecorder('VERIFY_FINAL_HOUSEKEEPING', 3);
  recorder.push('final_signal_observed', { toolCallId: 'tc1' });
  recorder.push('housekeeping_effect', { kind: 'cleanup' });
  const results = evaluateTrace(
    recorder.finish(terminalResult()),
    ['RT_FINAL_NO_LLM', 'RT_FINAL_NO_TOOL', 'RT_FINAL_NO_EFFECT'],
  );
  for (const result of results.values()) assert.equal(result.passed, true, result.detail);
});

await check('empty directContent is not a direct-delivery signal', () => {
  const recorder = new TraceRecorder('VERIFY_EMPTY_DIRECT', 4);
  recorder.push('tool_result', { directContent: '', imageCount: 0 });
  const result = evaluateTrace(recorder.finish(terminalResult()), ['RT_DIRECT_LEAD_LIMIT'])
    .get('RT_DIRECT_LEAD_LIMIT');
  assert.equal(result.passed, false);
  assert.match(result.detail, /no runtime-accepted direct payload/);
});

await check('direct-lead oracle allows the original batch but rejects tools returned by the lead', () => {
  const allowed = new TraceRecorder('VERIFY_DIRECT_BATCH', 41);
  allowed.push('tool_result', { callIndex: 0, directContent: 'panel', images: [], final: false });
  allowed.push('tool_call', { callIndex: 1, toolCallId: 'tc2', name: 'preplanned_second', args: {} });
  allowed.push('tool_result', { callIndex: 1, directContent: null, images: [], final: false });
  allowed.push('llm_call', { callIndex: 1, exposedTools: [], toolChoice: null });
  allowed.push('llm_result', { callIndex: 1, toolCalls: [] });
  const allowedResult = evaluateTrace(
    allowed.finish(terminalResult({ directContent: 'panel' })),
    ['RT_DIRECT_LEAD_LIMIT'],
  ).get('RT_DIRECT_LEAD_LIMIT');
  assert.equal(allowedResult.passed, true, allowedResult.detail);

  const rejected = new TraceRecorder('VERIFY_DIRECT_ILLEGAL_TOOL', 42);
  rejected.push('tool_result', { callIndex: 0, directContent: 'panel', images: [], final: false });
  rejected.push('llm_call', { callIndex: 1, exposedTools: [], toolChoice: null });
  rejected.push('llm_result', { callIndex: 1, toolCalls: [{ id: 'tc2', name: 'must_not_execute' }] });
  rejected.push('tool_call', { callIndex: 1, toolCallId: 'tc2', name: 'must_not_execute', args: {} });
  rejected.push('tool_result', { callIndex: 1, directContent: null, images: [], final: true });
  rejected.push('final_signal_observed', { callIndex: 1, toolCallId: 'tc2' });
  const rejectedResult = evaluateTrace(
    rejected.finish(terminalResult({ directContent: 'panel' })),
    ['RT_DIRECT_LEAD_LIMIT'],
  ).get('RT_DIRECT_LEAD_LIMIT');
  assert.equal(rejectedResult.passed, false);
  assert.match(rejectedResult.detail, /after decorative LLM settlement/);
});

await check('trace normalization covers volatile strings, numbers, IDs and terminal errors', () => {
  const raw = [
    'C:\\Users\\someone\\AppData\\Local\\Temp\\case.ts:12:4',
    '/tmp/wuxin-agent-replay-abc/case.json',
    '550e8400-e29b-41d4-a716-446655440000',
    '1730000000123',
    '2026-08-09T12:34:56.789Z',
    'http://localhost:4567/test',
    'https://example.test:8443/api',
    'port=6099',
  ].join(' | ');
  const clean = sanitizeTraceString(raw);
  for (const secret of [
    'C:\\Users', '/tmp/', '550e8400', '1730000000123', '2026-08-09',
    'localhost:4567', 'example.test:8443', 'port=6099',
  ]) assert(!clean.includes(secret), `sanitizer leaked ${secret}: ${clean}`);

  function buildTrace(latencyMs, timestamp, port) {
    const recorder = new TraceRecorder('VERIFY_TRACE', 5);
    assert.equal(recorder.toolCallId('raw-call-a'), 'tc1');
    assert.equal(recorder.toolCallId('raw-call-a'), 'tc1');
    assert.equal(recorder.toolCallId('raw-call-b'), 'tc2');
    recorder.push('adapter_error', { message: raw, latencyMs, timestamp, port });
    return normalizedJson(recorder.finish({
      kind: 'error',
      error: { name: 'FixtureError', message: raw },
    }));
  }
  assert.equal(
    buildTrace(917, 1730000000123, 6099),
    buildTrace(1, 1739999999999, 6553),
    'only volatile values differed, so normalized traces must match',
  );
});

await check('trace redaction preserves semantic identity instead of collapsing distinct UUIDs', () => {
  const firstId = '550e8400-e29b-41d4-a716-446655440000';
  const secondId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
  const recorder = new TraceRecorder('VERIFY_IDENTITY', 6);
  recorder.push('tool_call', {
    callIndex: 0,
    toolCallId: 'tc1',
    name: 'identity_tool',
    args: { target: firstId },
    context: { userId: firstId },
  });
  const event = recorder.events[0];
  assert(!normalizedJson(event).includes(firstId), 'raw UUID leaked into normalized trace');
  assert.equal(semanticJson(event.data.args), semanticJson({ target: firstId }));
  assert.notEqual(semanticJson(event.data.args), semanticJson({ target: secondId }));
  assert.notEqual(semanticJson({ timestamp: 111 }), semanticJson({ timestamp: 222 }));

  const sensitive = new TraceRecorder('VERIFY_EMBEDDED_IDENTITIES', 7);
  const sensitiveArgs = {
    windows: 'see C:\\Users\\secret\\fixture.txt now',
    unix: 'read /tmp/private/fixture.json now',
    unc: 'open \\\\server\\share\\secret.txt now',
    endpoint: 'call http://localhost:4567/test',
  };
  sensitive.push('tool_call', {
    callIndex: 0,
    toolCallId: 'tc1',
    name: 'identity_tool',
    args: sensitiveArgs,
    context: { userId: firstId },
  });
  const serialized = normalizedJson(sensitive.events[0]);
  for (const leaked of ['C:\\Users', '/tmp/', '\\\\server', 'localhost:4567']) {
    assert(!serialized.includes(leaked), `identity-aware trace leaked ${leaked}: ${serialized}`);
  }
  assert.equal(semanticJson(sensitive.events[0].data.args), semanticJson(sensitiveArgs));
});

const isolation = await installReplayIsolation();
try {
  const { ReplayHarnessError, replayScenario } = await import('./agent-runtime/runner.ts');

  await check('normal multi-tool batch stops at the first final ToolResult', async () => {
    const scenario = baseScenario('VERIFY_BATCH_FINAL');
    scenario.initialState.toolSchemas = [
      { name: 'first_tool' },
      { name: 'must_not_run' },
    ];
    scenario.llmSteps = [{
      outcome: 'return',
      expect: { exposedTools: ['first_tool', 'must_not_run'] },
      toolCalls: [
        { id: 'raw-first', name: 'first_tool', args: { target: 'locked' } },
        { id: 'raw-second', name: 'must_not_run', args: { target: 'locked' } },
      ],
    }];
    scenario.toolSteps = [
      {
        outcome: 'return',
        expect: { name: 'first_tool' },
        result: { ok: true, content: 'terminal payload', directContent: 'terminal payload', final: true },
      },
      {
        outcome: 'return',
        expect: { name: 'must_not_run' },
        effects: [{ kind: 'forbidden', class: 'business' }],
        result: { ok: true, content: 'should not happen' },
      },
    ];
    scenario.expected.enforced = [
      { kind: 'invariant', id: 'RT_FINAL_NO_LLM' },
      { kind: 'invariant', id: 'RT_FINAL_NO_TOOL' },
      { kind: 'invariant', id: 'RT_FINAL_NO_EFFECT' },
      { kind: 'assertion', id: 'ASSERT_LLM_CALL_COUNT', value: 1 },
      { kind: 'assertion', id: 'ASSERT_TOOL_CALL_COUNT', value: 1 },
      {
        kind: 'assertion',
        id: 'ASSERT_SCRIPT_CONSUMPTION',
        value: { llmConsumed: 1, llmTotal: 1, toolConsumed: 1, toolTotal: 2 },
      },
    ];
    const result = await replayScenario(parseReplayScenario(scenario));
    assert.equal(result.passed, true, normalizedJson(result.oracles));
    assert.equal(result.trace.events.some((event) => event.type === 'business_effect'), false);
  });

  await check('direct-lead replay disables tools and records planner Thinking then decorative Fast', async () => {
    const result = await replayScenario(readScenario('direct-lead.json'));
    assert.equal(result.passed, true, normalizedJson(result.oracles));
    const llmCalls = result.trace.events.filter((event) => event.type === 'llm_call');
    assert.deepEqual(llmCalls[1].data.exposedTools, []);
    const reasoning = result.trace.events.filter((event) => event.type === 'reasoning');
    assert.deepEqual(reasoning.map((event) => event.data.callRole), ['tool_planner', 'decorative_lead']);
    assert.deepEqual(reasoning.map((event) => event.data.decision.mode), ['thinking', 'fast']);
    const directResults = result.trace.events.filter(
      (event) => event.type === 'tool_result' && String(event.data.directContent || '').length > 0,
    );
    assert.equal(directResults.length, 1);
    assert.equal(result.trace.terminal.result.directContent, directResults[0].data.directContent);
  });

  await check('same scenario replays to byte-identical normalized traces', async () => {
    const scenario = readScenario('direct-lead.json');
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
  });

  await check('candidate diagnostics never block, enforced failures do', async () => {
    const candidateOnly = baseScenario('VERIFY_CANDIDATE_DIAG');
    candidateOnly.expected.enforced = [
      { kind: 'assertion', id: 'ASSERT_TERMINAL_KIND', value: 'result' },
    ];
    candidateOnly.expected.candidate = [
      { kind: 'invariant', id: 'RT_FINAL_IMAGES_PRESERVED' },
    ];
    const diagnostic = await replayScenario(parseReplayScenario(candidateOnly));
    assert.equal(diagnostic.oracles.find((oracle) => oracle.level === 'candidate').passed, false);
    assert.equal(diagnostic.passed, true);

    const enforcedFailure = structuredClone(candidateOnly);
    enforcedFailure.id = 'VERIFY_ENFORCED_FAIL';
    enforcedFailure.expected.enforced = [
      { kind: 'assertion', id: 'ASSERT_TEXT', value: 'wrong text' },
    ];
    const failed = await replayScenario(parseReplayScenario(enforcedFailure));
    assert.equal(failed.passed, false);
  });

  await check('adapter errors and undeclared unused script steps are non-bypassable harness failures', async () => {
    const underScripted = baseScenario('VERIFY_ADAPTER_INTEGRITY');
    underScripted.llmSteps = [];
    underScripted.expected.enforced = [{ kind: 'invariant', id: 'HARNESS_ISOLATED' }];
    await assert.rejects(
      replayScenario(parseReplayScenario(underScripted)),
      (error) => error instanceof ReplayHarnessError && /adapter contract failed/.test(error.message),
    );

    const unused = baseScenario('VERIFY_UNUSED_SCRIPT');
    unused.llmSteps.push({ outcome: 'return', text: 'must remain unused' });
    await assert.rejects(
      replayScenario(parseReplayScenario(unused)),
      (error) => error instanceof ReplayHarnessError && /script not fully consumed/.test(error.message),
    );
  });

  await check('scripted expectations reject UUID target drift before redaction', async () => {
    const expectedId = '550e8400-e29b-41d4-a716-446655440000';
    const driftedId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    const scenario = baseScenario('VERIFY_UUID_DRIFT');
    scenario.initialState.toolSchemas = [{ name: 'identity_tool' }];
    scenario.llmSteps = [{
      outcome: 'return',
      toolCalls: [{ name: 'identity_tool', args: { target: driftedId } }],
    }];
    scenario.toolSteps = [{
      outcome: 'return',
      expect: { name: 'identity_tool', args: { target: expectedId } },
      result: { ok: true, content: 'must not pass' },
    }];
    await assert.rejects(
      replayScenario(parseReplayScenario(scenario)),
      (error) => error instanceof ReplayHarnessError && /adapter contract failed/.test(error.message),
    );
  });

  await check('production DB guard reports unchanged without exposing a hash', async () => {
    assert.equal(await isolation.assertProductionDbUnchanged(), true);
  });
} finally {
  await isolation.restore();
}

await check('CLI exit codes distinguish pass, invariant failure and input errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-agent-cli-verify-'));
  try {
    const candidate = baseScenario('VERIFY_CLI_CANDIDATE');
    candidate.expected.candidate = [{ kind: 'invariant', id: 'RT_FINAL_IMAGES_PRESERVED' }];
    const candidatePath = path.join(tempDir, 'candidate.json');
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));

    const enforced = baseScenario('VERIFY_CLI_ENFORCED');
    enforced.expected.enforced = [{ kind: 'assertion', id: 'ASSERT_TEXT', value: 'wrong' }];
    const enforcedPath = path.join(tempDir, 'enforced.json');
    fs.writeFileSync(enforcedPath, JSON.stringify(enforced));

    const badJsonPath = path.join(tempDir, 'bad-json.json');
    fs.writeFileSync(badJsonPath, '{');
    const badSchemaPath = path.join(tempDir, 'bad-schema.json');
    fs.writeFileSync(badSchemaPath, JSON.stringify({ ...baseScenario('VERIFY_CLI_SCHEMA'), schemaVersion: 999 }));
    const badTier = baseScenario('VERIFY_CLI_TIER');
    badTier.expected.enforced = [{ kind: 'invariant', id: 'RT_FINAL_IMAGES_PRESERVED' }];
    const badTierPath = path.join(tempDir, 'bad-tier.json');
    fs.writeFileSync(badTierPath, JSON.stringify(badTier));
    const harnessFailure = baseScenario('VERIFY_CLI_HARNESS');
    harnessFailure.llmSteps = [];
    harnessFailure.expected.enforced = [{ kind: 'invariant', id: 'HARNESS_ISOLATED' }];
    const harnessFailurePath = path.join(tempDir, 'harness-failure.json');
    fs.writeFileSync(harnessFailurePath, JSON.stringify(harnessFailure));

    function cli(args) {
      return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
      });
    }

    const valid = cli([path.join(FIXTURES, 'scenario.min.json')]);
    assert.equal(valid.status, 0, 'valid fixture');
    assert.match(valid.stdout, /productionDbUnchanged=true/);
    assert.equal(cli([candidatePath]).status, 0, 'candidate-only failure');
    assert.equal(cli([enforcedPath]).status, 1, 'enforced assertion failure');
    assert.equal(cli([harnessFailurePath]).status, 2, 'harness integrity failure');
    assert.equal(cli([badJsonPath]).status, 2, 'invalid JSON');
    assert.equal(cli([badSchemaPath]).status, 2, 'schema mismatch');
    assert.equal(cli([badTierPath]).status, 2, 'invariant tier mismatch');
    const missingPath = path.join(tempDir, 'missing.json');
    const missing = cli([missingPath]);
    assert.equal(missing.status, 2, 'missing file');
    assert(!missing.stderr.includes(tempDir), `CLI leaked an absolute path: ${missing.stderr}`);
    assert(!/\n\s*at\s/.test(missing.stderr), `CLI leaked a stack: ${missing.stderr}`);
    const missingJson = cli([missingPath, '--json']);
    assert.equal(missingJson.status, 2, 'missing file in JSON mode');
    const errorEnvelope = JSON.parse(missingJson.stderr);
    assert.equal(errorEnvelope.error.code, 'ENOENT');
    assert(!missingJson.stderr.includes(tempDir), `JSON error leaked an absolute path: ${missingJson.stderr}`);
    assert.equal(cli(['--help']).status, 0, '--help');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

await check('production DB hash guard detects mutation using an isolated fake APPDATA', () => {
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-agent-db-guard-'));
  try {
    const fakeWuxin = path.join(fakeAppData, 'Wuxin');
    fs.mkdirSync(fakeWuxin, { recursive: true });
    fs.writeFileSync(path.join(fakeWuxin, 'db.json'), '{"fixture":1}');
    const isolationUrl = pathToFileURL(path.join(ROOT, 'tools', 'agent-runtime', 'isolation.ts')).href;
    const child = `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const beforeFetch = globalThis.fetch;
      const { installReplayIsolation } = await import(${JSON.stringify(isolationUrl)});
      const isolation = await installReplayIsolation();
      await fs.writeFile(path.join(process.env.APPDATA, 'Wuxin', 'db.json'), '{"fixture":2}');
      let detected = false;
      try { await isolation.restore(); }
      catch (error) { detected = /production DB changed/.test(String(error?.message || error)); }
      if (!detected || globalThis.fetch !== beforeFetch) process.exitCode = 7;
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', child], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      timeout: 30_000,
      env: { ...process.env, APPDATA: fakeAppData },
    });
    assert.equal(result.status, 0, `fake DB guard child failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  }
});

console.log(`AGENT-RUNTIME VERIFY: PASS (${checks} checks, productionDbUnchanged=true)`);
