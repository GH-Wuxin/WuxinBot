// Phase C2.1 harness/oracle self-tests. Candidate-producing production traces
// belong to the campaign and targeted verifier, not to these green gates.
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  buildC2ProfileScenario,
  buildC2Scenario,
  c2CommandsArbitrary,
} from './agent-runtime/c2-generator.ts';
import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { evaluateOracles } from './agent-runtime/oracles.ts';
import { DeterministicSettlementScheduler } from './agent-runtime/scheduler.ts';
import { normalizedJson, TraceRecorder } from './agent-runtime/trace.ts';

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  PASS ${name}`);
}

function syntheticTrace(scenario, events) {
  return {
    traceVersion: scenario.traceVersion,
    schemaVersion: scenario.schemaVersion,
    generatorVersion: scenario.generatorVersion,
    scenarioId: scenario.id,
    seed: scenario.seed,
    events: events.map((event, seq) => ({ seq, ...event })),
    terminal: { kind: 'error', error: { name: 'SyntheticTerminal', message: 'oracle self-test' } },
  };
}

console.log('\n=== Agent Replay Phase C2.1 contracts ===');

await check('compound profile matrix is versioned, parseable and deterministic', () => {
  const behaviors = ['normal', 'final_batch', 'retry_destructive', 'bounded_failures'];
  const settlements = ['immediate', 'late', 'duplicate', 'reordered'];
  const controls = ['none', 'abort', 'timeout'];
  for (const behavior of behaviors) {
    for (const settlement of settlements) {
      for (const control of controls) {
        const first = buildC2ProfileScenario({ behavior, settlement, control });
        const second = buildC2ProfileScenario({ behavior, settlement, control });
        assert.match(first.scenario.id, /^C2_[0-9A-F]{16}$/);
        assert.equal(normalizedJson(first.scenario), normalizedJson(second.scenario));
        assert.equal(first.scenario.faultProfile.id, `${behavior}+${control === 'none' ? settlement : (settlement === 'immediate' ? 'late' : settlement)}+${control}`);
      }
    }
  }
});

await check('stateful generator composes independent behavior/settlement/control commands', () => {
  const samples = fc.sample(c2CommandsArbitrary(3), { seed: 20_260_811, numRuns: 50 });
  assert.equal(samples.length, 50);
  for (const commands of samples) {
    const generated = buildC2Scenario(commands, 20_260_811);
    assert(generated.semanticSteps.length >= 1);
    assert(generated.scenario.faultProfile.tags.length >= 1);
  }
});

await check('symbolic scheduler uses stable tick/order and never executes Agent state', async () => {
  const recorder = new TraceRecorder('C2_SCHEDULER_SELF_TEST', 1);
  const scheduler = new DeterministicSettlementScheduler(recorder);
  const order = [];
  scheduler.scheduleAt(3, 'primary', () => order.push('primary'));
  scheduler.scheduleAt(1, 'duplicate-first', () => order.push('duplicate-first'));
  scheduler.scheduleAt(3, 'same-tick-second', () => order.push('same-tick-second'));
  while (await scheduler.runNext()) {}
  assert.deepEqual(order, ['duplicate-first', 'primary', 'same-tick-second']);
  assert.deepEqual(recorder.events.map((event) => event.data.tick), [1, 3, 3]);
});

await check('oracle self-test catches late activity after abort/timeout terminal', () => {
  const scenario = buildC2ProfileScenario({ behavior: 'normal', settlement: 'late', control: 'abort' }).scenario;
  scenario.expected.enforced = [];
  scenario.expected.candidate = [{ kind: 'invariant', id: 'RT_ABORT_NO_LATE_EFFECT' }];
  const bad = syntheticTrace(scenario, [
    { type: 'turn_control', data: { kind: 'abort' } },
    { type: 'business_effect', data: { kind: 'late-write', data: {} } },
  ]);
  const good = syntheticTrace(scenario, [
    { type: 'turn_control', data: { kind: 'timeout' } },
    { type: 'housekeeping_effect', data: { kind: 'cleanup', data: {} } },
  ]);
  const badOracle = evaluateOracles(scenario, bad, { llmConsumed: 0, llmTotal: 0, toolConsumed: 0, toolTotal: 0 })[0];
  const goodOracle = evaluateOracles(scenario, good, { llmConsumed: 0, llmTotal: 0, toolConsumed: 0, toolTotal: 0 })[0];
  assert.equal(badOracle.passed, false);
  assert.match(badOracle.detail, /business_effect/);
  assert.equal(goodOracle.passed, true);
});

await check('oracle self-test catches repeated destructive effect identity', () => {
  const scenario = buildC2ProfileScenario({ behavior: 'normal', settlement: 'immediate', control: 'none' }).scenario;
  scenario.expected.enforced = [];
  scenario.expected.candidate = [{ kind: 'invariant', id: 'RT_EFFECT_IDEMPOTENCY' }];
  const effect = { type: 'business_effect', data: { kind: 'write', data: { idempotencyKey: 'same-op' } } };
  const trace = syntheticTrace(scenario, [effect, effect]);
  const oracle = evaluateOracles(scenario, trace, { llmConsumed: 0, llmTotal: 0, toolConsumed: 0, toolTotal: 0 })[0];
  assert.equal(oracle.passed, false);
  assert.match(oracle.detail, /duplicate business effect/);
});

const isolation = await installReplayIsolation();
try {
  const { replayScenario } = await import('./agent-runtime/runner.ts');

  await check('final + duplicate settlement skips remaining batch after real runToolLoop final', async () => {
    const scenario = buildC2ProfileScenario({ behavior: 'final_batch', settlement: 'duplicate', control: 'none' }).scenario;
    const result = await replayScenario(scenario);
    assert.equal(result.passed, true, normalizedJson(result.oracles));
    assert.equal(result.trace.events.filter((event) => event.type === 'tool_call').length, 1);
    assert.equal(result.trace.events.filter((event) => event.type === 'business_effect').length, 1);
    assert.equal(result.trace.events.filter((event) => event.type === 'settlement_attempt').length, 2);
    assert.equal(result.trace.events.filter((event) => event.type === 'settlement_attempt' && event.data.accepted).length, 1);
    assert.equal(result.consumption.toolConsumed, 1);
    assert.equal(result.consumption.toolTotal, 2);
  });

  await check('reordered duplicate resolver accepts once and commits one business effect', async () => {
    const scenario = buildC2ProfileScenario({ behavior: 'normal', settlement: 'reordered', control: 'none' }).scenario;
    const result = await replayScenario(scenario);
    assert.equal(result.passed, true, normalizedJson(result.oracles));
    const attempts = result.trace.events.filter((event) => event.type === 'settlement_attempt');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].data.attempt, 'duplicate');
    assert.equal(attempts[0].data.accepted, true);
    assert.equal(attempts[1].data.accepted, false);
    assert.equal(result.trace.events.filter((event) => event.type === 'business_effect').length, 1);
  });

  await check('bounded delayed failure path terminates through real capped synthesis', async () => {
    const scenario = buildC2ProfileScenario({ behavior: 'bounded_failures', settlement: 'late', control: 'none' }).scenario;
    const result = await replayScenario(scenario);
    assert.equal(result.passed, true, normalizedJson(result.oracles));
    assert.equal(result.trace.terminal.kind, 'result');
    assert.equal(result.trace.terminal.result.iterations, 2);
    assert.equal(result.trace.events.filter((event) => event.type === 'llm_call').length, 3);
    assert.equal(result.trace.events.filter((event) => event.type === 'tool_call').length, 2);
  });

  assert.equal(await isolation.assertProductionDbUnchanged(), true);
} finally {
  await isolation.restore();
}

console.log(`AGENT-RUNTIME C2.1 VERIFY: PASS (${checks} checks)`);
