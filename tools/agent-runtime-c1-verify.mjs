// Phase C1 self-tests. The formal 1,000-case smoke remains an explicit
// campaign command so a candidate finding can be inspected before expansion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';

import {
  C1_DEFAULT_SEED,
  classifyReplayResult,
  runC1Campaign,
} from './agent-runtime/campaign.ts';
import {
  buildC1Scenario,
  c1CommandsArbitrary,
} from './agent-runtime/generator.ts';
import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { parseReplayScenarioJson } from './agent-runtime/scenario.ts';
import { normalizedJson } from './agent-runtime/trace.ts';
import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
} from './agent-runtime/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAL_ARTIFACT_DIR = path.join(ROOT, 'tools', 'fixtures', 'agent-runtime', 'c1');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  PASS ${name}`);
}

function replayResult(oracles, observed = 0, reported = 0) {
  return {
    oracles,
    trace: {
      terminal: {
        kind: 'result',
        result: { toolCallsMade: reported },
      },
      events: Array.from({ length: observed }, (_, index) => ({
        seq: index + 1,
        type: 'tool_call',
        data: {},
      })),
    },
  };
}

console.log('\n=== Agent Replay Phase C1 contracts ===');

await check('semantic stateful generator emits versioned parseable scenarios', () => {
  const samples = fc.sample(c1CommandsArbitrary(4, { includeUnsafe: false }), {
    seed: C1_DEFAULT_SEED,
    numRuns: 20,
  });
  assert.equal(samples.length, 20);
  for (const commands of samples) {
    const first = buildC1Scenario(commands, C1_DEFAULT_SEED);
    const second = buildC1Scenario(commands, C1_DEFAULT_SEED);
    assert.equal(first.scenario.schemaVersion, SCHEMA_VERSION);
    assert.equal(first.scenario.traceVersion, TRACE_VERSION);
    assert.equal(first.scenario.generatorVersion, GENERATOR_VERSION);
    assert.match(first.scenario.id, /^C1_[0-9A-F]{16}$/);
    assert.equal(normalizedJson(first.scenario), normalizedJson(second.scenario));
    assert(first.scenario.initialState.messages.length > 0);
  }
});

await check('oracle classifier treats exact tool accounting as enforced', () => {
  const enforced = classifyReplayResult(replayResult([
    { level: 'enforced', id: 'RT_TOOL_COUNT_EXACT', passed: false, detail: 'reported 0, observed 1' },
    { level: 'candidate', id: 'RT_TARGET_LOCK', passed: false, detail: 'target drift' },
  ], 1, 0));
  assert.equal(enforced.kind, 'enforced_violation');
  assert.equal(enforced.oracleId, 'RT_TOOL_COUNT_EXACT');

  const uncertain = classifyReplayResult(replayResult([
    { level: 'candidate', id: 'RT_TARGET_LOCK', passed: false, detail: 'target drift' },
  ], 1, 1));
  assert.equal(uncertain.provisionalClassification, 'needs_manual_review');
  assert.equal(classifyReplayResult(replayResult([])), null);
});

await check('safe-only stateful sample executes the real runToolLoop', async () => {
  const result = await runC1Campaign({
    seed: C1_DEFAULT_SEED,
    numRuns: 25,
    maxCommands: 4,
    includeUnsafe: false,
    hardLimitMs: 10_000,
  });
  assert.equal(result.status, 'passed', normalizedJson(result));
  assert.equal(result.completedRuns, 25);
  assert.equal(result.productionDbUnchanged, true);
});

await check('unsafe-inclusive stateful sample enforces exact tool accounting', async () => {
  // maxCommands 4 keeps generated scripts inside the production hard tool-call
  // budget (<=4 per response, <=8 per turn); overflow itself is covered by
  // tools/agent-tool-surface-hardening-verify.mjs with a direct executor seam.
  const campaign = await runC1Campaign({
    seed: C1_DEFAULT_SEED,
    numRuns: 50,
    maxCommands: 4,
    includeUnsafe: true,
    hardLimitMs: 15_000,
  });
  assert.equal(campaign.status, 'passed', normalizedJson(campaign));
  assert.equal(campaign.completedRuns, 50);
  assert.equal(campaign.productionDbUnchanged, true);
});

await check('stateful command generator still supports automatic shrink', () => {
  const property = fc.property(
    c1CommandsArbitrary(5, { includeUnsafe: true }),
    (commands) => {
      const generated = buildC1Scenario(commands, C1_DEFAULT_SEED);
      if (generated.semanticSteps.some((step) => step.startsWith('unsafe('))) {
        throw new Error('synthetic shrink sentinel');
      }
    },
  );
  const details = fc.check(property, {
    seed: C1_DEFAULT_SEED,
    numRuns: 50,
  });
  assert.equal(details.failed, true);
  assert(details.numShrinks > 0);
  assert(details.counterexamplePath);
  const minimized = buildC1Scenario(details.counterexample[0], C1_DEFAULT_SEED);
  assert.deepEqual(minimized.semanticSteps, ['unsafe(batch=1)', 'planner_text']);
});

await check('formal scenario.min.json is the enforced deterministic regression', async () => {
  const scenarioPath = path.join(FORMAL_ARTIFACT_DIR, 'scenario.min.json');
  const scenario = parseReplayScenarioJson(await fs.readFile(scenarioPath, 'utf8'), scenarioPath);

  const isolation = await installReplayIsolation();
  try {
    const { replayScenario } = await import('./agent-runtime/runner.ts');
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
    const exact = first.oracles.find((oracle) => oracle.id === 'RT_TOOL_COUNT_EXACT');
    assert.equal(exact?.level, 'enforced');
    assert.equal(exact?.passed, true, exact?.detail);
    assert.equal(first.trace.events.filter((event) => event.type === 'tool_call').length, 1);
    assert.equal(first.trace.terminal.kind, 'result');
    assert.equal(first.trace.terminal.result.toolCallsMade, 1);
    assert.equal(classifyReplayResult(first), null);
    assert.equal(await isolation.assertProductionDbUnchanged(), true);
  } finally {
    await isolation.restore();
  }
});

console.log(`AGENT-RUNTIME C1 VERIFY: PASS (${checks} checks)`);
