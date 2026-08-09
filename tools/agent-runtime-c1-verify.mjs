// Phase C1 self-tests. The formal 1,000-case smoke remains an explicit
// campaign command so a candidate finding can be inspected before expansion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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

await check('oracle classifier prioritizes enforced and labels exact tool-count evidence', () => {
  const enforced = classifyReplayResult(replayResult([
    { level: 'candidate', id: 'RT_TOOL_COUNT_EXACT', passed: false, detail: 'candidate' },
    { level: 'enforced', id: 'RT_FINAL_NO_LLM', passed: false, detail: 'enforced' },
  ], 1, 0));
  assert.equal(enforced.kind, 'enforced_violation');
  assert.equal(enforced.oracleId, 'RT_FINAL_NO_LLM');

  const exact = classifyReplayResult(replayResult([
    { level: 'candidate', id: 'RT_TOOL_COUNT_EXACT', passed: false, detail: 'reported 0, observed 1' },
  ], 1, 0));
  assert.equal(exact.kind, 'candidate_violation');
  assert.equal(exact.provisionalClassification, 'provisional_real_production_candidate');

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

await check('automatic shrink persists the candidate and disk replay is deterministic', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-agent-c1-verify-'));
  try {
    const campaign = await runC1Campaign({
      seed: C1_DEFAULT_SEED,
      numRuns: 20,
      maxCommands: 5,
      includeUnsafe: true,
      hardLimitMs: 15_000,
      artifactDir,
    });
    assert.equal(campaign.status, 'violation', normalizedJson(campaign));
    assert.equal(campaign.finding?.kind, 'candidate_violation');
    assert.equal(campaign.finding?.oracleId, 'RT_TOOL_COUNT_EXACT');
    assert.equal(campaign.finding?.provisionalClassification, 'provisional_real_production_candidate');
    assert(campaign.numShrinks > 0, 'the fixed synthetic fault must exercise automatic shrink');
    assert(campaign.counterexamplePath, 'fast-check path must be retained as auxiliary provenance');
    assert.equal(campaign.productionDbUnchanged, true);

    const scenarioPath = path.join(artifactDir, 'scenario.min.json');
    const evidencePath = path.join(artifactDir, 'evidence.json');
    const scenario = parseReplayScenarioJson(await fs.readFile(scenarioPath, 'utf8'), scenarioPath);
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    assert.equal(evidence.evidenceVersion, 1);
    assert.equal(evidence.deterministicReplay, true);
    assert.equal(evidence.finding.oracleId, 'RT_TOOL_COUNT_EXACT');
    assert.equal(evidence.scenarioPath, 'tools/fixtures/agent-runtime/c1/scenario.min.json');

    const isolation = await installReplayIsolation();
    try {
      const { replayScenario } = await import('./agent-runtime/runner.ts');
      const first = await replayScenario(scenario);
      const second = await replayScenario(scenario);
      assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
      const finding = classifyReplayResult(first);
      assert.equal(finding?.oracleId, 'RT_TOOL_COUNT_EXACT');
      assert.equal(await isolation.assertProductionDbUnchanged(), true);
    } finally {
      await isolation.restore();
    }
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

await check('formal scenario.min.json remains the deterministic replay truth', async () => {
  const scenarioPath = path.join(FORMAL_ARTIFACT_DIR, 'scenario.min.json');
  const evidencePath = path.join(FORMAL_ARTIFACT_DIR, 'evidence.json');
  const scenario = parseReplayScenarioJson(await fs.readFile(scenarioPath, 'utf8'), scenarioPath);
  const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  assert.equal(evidence.seed, C1_DEFAULT_SEED);
  assert.equal(evidence.requestedRuns, 1_000);
  assert.equal(evidence.finding.oracleId, 'RT_TOOL_COUNT_EXACT');

  const isolation = await installReplayIsolation();
  try {
    const { replayScenario } = await import('./agent-runtime/runner.ts');
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
    assert.equal(classifyReplayResult(first)?.oracleId, evidence.finding.oracleId);
    assert.equal(await isolation.assertProductionDbUnchanged(), true);
  } finally {
    await isolation.restore();
  }
});

console.log(`AGENT-RUNTIME C1 VERIFY: PASS (${checks} checks)`);
