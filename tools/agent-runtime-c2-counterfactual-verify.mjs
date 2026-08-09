// Phase C2.2 Fast/Thinking scripted counterfactual contracts. This remains
// fully offline and runs both variants through the real runToolLoop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareInvariantOutcomes,
  parseCounterfactualFixture,
  runCounterfactualFixture,
} from './agent-runtime/counterfactual.ts';
import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { normalizedJson } from './agent-runtime/trace.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(
  ROOT,
  'tools',
  'fixtures',
  'agent-runtime',
  'counterfactual',
  'fast-thinking.json',
);

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  PASS ${name}`);
}

console.log('\n=== Agent Replay Phase C2.2 counterfactual contracts ===');

const raw = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));

await check('fixture parser enforces counterfactual/replay versions', () => {
  const fixture = parseCounterfactualFixture(raw, FIXTURE_PATH);
  assert.equal(fixture.counterfactualSchemaVersion, 1);
  assert.throws(
    () => parseCounterfactualFixture({ ...raw, counterfactualSchemaVersion: 2 }, 'bad-counterfactual-version'),
    /counterfactualSchemaVersion must be 1/,
  );
  assert.throws(
    () => parseCounterfactualFixture({ ...raw, traceSchemaVersion: 2 }, 'bad-trace-version'),
    /incompatible Replay schema\/trace\/generator version/,
  );
});

await check('invariant comparison reports outcome changes but ignores detail-only changes', () => {
  const base = {
    mode: 'fast', toolSequence: [], toolCallCount: 0, target: null, targets: [],
    terminalState: { kind: 'result' }, reasoningDecisions: [],
    simulatedTokens: { prompt: 0, completion: 0, total: 0, reasoning: 0 },
    simulatedLatencyMs: 0,
  };
  const detailOnly = compareInvariantOutcomes(
    { ...base, invariants: [{ id: 'RT_BOUNDED_LOOP', level: 'enforced', passed: true, detail: 'fast detail' }] },
    { ...base, mode: 'thinking', invariants: [{ id: 'RT_BOUNDED_LOOP', level: 'enforced', passed: true, detail: 'thinking detail' }] },
  );
  assert.deepEqual(detailOnly, []);
  const changed = compareInvariantOutcomes(
    { ...base, invariants: [{ id: 'RT_TARGET_LOCK', level: 'candidate', passed: true, detail: 'locked' }] },
    { ...base, mode: 'thinking', invariants: [{ id: 'RT_TARGET_LOCK', level: 'candidate', passed: false, detail: 'drift' }] },
  );
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, 'RT_TARGET_LOCK');
  assert.equal(changed[0].thinking.passed, false);
});

const isolation = await installReplayIsolation();
try {
  let golden;
  await check('golden Fast/Thinking variants replay deterministically through real runToolLoop', async () => {
    const fixture = parseCounterfactualFixture(raw, FIXTURE_PATH);
    const first = await runCounterfactualFixture(fixture, FIXTURE_PATH);
    const second = await runCounterfactualFixture(fixture, FIXTURE_PATH);
    assert.equal(normalizedJson(first), normalizedJson(second));
    assert.equal(first.runtime, 'real_runToolLoop');
    assert.equal(first.offline, true);
    assert.equal(first.productionThinkingEnabled, false);
    assert.match(first.disclaimer, /does not predict real model answer quality/);
    golden = first;
  });

  await check('golden comparison exposes all requested runtime deltas', () => {
    assert.deepEqual(golden.variants.fast.toolSequence, ['lookup_profile']);
    assert.deepEqual(golden.variants.thinking.toolSequence, ['lookup_profile', 'lookup_detail']);
    assert.equal(golden.variants.fast.toolCallCount, 1);
    assert.equal(golden.variants.thinking.toolCallCount, 2);
    assert.equal(golden.variants.fast.target, 'player-one');
    assert.equal(golden.variants.thinking.target, 'player-one');
    assert.equal(golden.variants.fast.terminalState.kind, 'result');
    assert.equal(golden.variants.thinking.terminalState.kind, 'result');
    assert(golden.variants.fast.reasoningDecisions.every((entry) => entry.level === 'off'));
    assert(golden.variants.thinking.reasoningDecisions.every((entry) => entry.level === 'max'));
    assert.deepEqual(golden.variants.fast.simulatedTokens, {
      prompt: 170, completion: 60, total: 230, reasoning: 0,
    });
    assert.deepEqual(golden.variants.thinking.simulatedTokens, {
      prompt: 320, completion: 130, total: 450, reasoning: 180,
    });
    assert.equal(golden.variants.fast.simulatedLatencyMs, 35);
    assert.equal(golden.variants.thinking.simulatedLatencyMs, 170);
    assert.equal(golden.differences.toolSequenceChanged, true);
    assert.equal(golden.differences.toolCallCountDelta, 1);
    assert.equal(golden.differences.targetChanged, false);
    assert.equal(golden.differences.reasoningChanged, true);
    assert.equal(golden.differences.simulatedTokenDelta, 220);
    assert.equal(golden.differences.simulatedLatencyDeltaMs, 135);
    assert.deepEqual(golden.differences.invariantDifferences, []);
    assert.deepEqual(golden.findings, []);
  });

  await check('offline smoke remains deterministic and candidate-free', async () => {
    for (let run = 0; run < 25; run++) {
      const fixture = parseCounterfactualFixture({
        ...raw,
        seed: raw.seed + run,
      }, `counterfactual-smoke-${run}`);
      const result = await runCounterfactualFixture(fixture, `counterfactual-smoke-${run}`);
      assert.deepEqual(result.findings, [], normalizedJson(result.findings));
      assert.equal(result.variants.fast.target, result.variants.thinking.target);
      assert.equal(result.differences.toolCallCountDelta, 1);
      assert.equal(result.differences.invariantDifferences.length, 0);
    }
  });

  assert.equal(await isolation.assertProductionDbUnchanged(), true);
} finally {
  await isolation.restore();
}

console.log(`AGENT-RUNTIME C2.2 COUNTERFACTUAL VERIFY: PASS (${checks} checks; smoke=25; productionDbUnchanged=true)`);
