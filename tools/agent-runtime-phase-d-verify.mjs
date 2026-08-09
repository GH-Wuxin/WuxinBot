// Phase D stopped-campaign evidence verification. The new candidate is an
// expected finding here; this verifier proves replay/shrink determinism and
// does not promote it to an enforced production gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyReplayResult } from './agent-runtime/campaign.ts';
import { runC2Campaign } from './agent-runtime/c2-campaign.ts';
import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { parseReplayScenarioJson } from './agent-runtime/scenario.ts';
import { normalizedJson } from './agent-runtime/trace.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (...parts) => path.join(ROOT, 'tools', 'fixtures', 'agent-runtime', ...parts);
const phaseDScenarioPath = fixture('phase-d', 'new-finding', 'c2', 'scenario.min.json');
const phaseDEvidencePath = fixture('phase-d', 'new-finding', 'c2', 'evidence.json');
const phaseDTracePath = fixture('phase-d', 'new-finding', 'c2', 'trace.json');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`  PASS ${name}`);
}

function withoutReproductionPath(scenario) {
  const clone = JSON.parse(JSON.stringify(scenario));
  delete clone.minimalReproduction;
  return clone;
}

console.log('\n=== Agent Replay Phase D stopped-campaign evidence ===');

await check('only the reviewed abort candidate may be non-gating', async () => {
  await assert.rejects(
    runC2Campaign({ numRuns: 1, nonGatingCandidateIds: ['RT_EFFECT_IDEMPOTENCY'] }),
    /candidate is not registered as validated\/non-gating/,
  );
});

await check('same seed/path regenerates the minimized semantic scenario', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-agent-phase-d-path-'));
  try {
    const replayed = await runC2Campaign({
      seed: 20_260_813,
      numRuns: 1_000,
      path: '2',
      hardLimitMs: 10_000,
      artifactDir,
      nonGatingCandidateIds: ['RT_ABORT_NO_LATE_EFFECT'],
    });
    assert.equal(replayed.status, 'violation');
    assert.equal(replayed.finding?.oracleId, 'RT_EFFECT_IDEMPOTENCY');
    assert.equal(replayed.counterexamplePath, '2:1');
    assert.equal(replayed.generatorReplayPath, '2');
    assert.equal(replayed.productionDbUnchanged, true);
    const regenerated = parseReplayScenarioJson(
      await fs.readFile(path.join(artifactDir, 'scenario.min.json'), 'utf8'),
      path.join(artifactDir, 'scenario.min.json'),
    );
    const checkedIn = parseReplayScenarioJson(
      await fs.readFile(phaseDScenarioPath, 'utf8'),
      phaseDScenarioPath,
    );
    assert.equal(
      normalizedJson(withoutReproductionPath(regenerated)),
      normalizedJson(withoutReproductionPath(checkedIn)),
    );
  } finally {
    await fs.rm(artifactDir, { recursive: true, force: true });
  }
});

const isolation = await installReplayIsolation();
try {
  const { replayScenario } = await import('./agent-runtime/runner.ts');

  await check('RT_TOOL_COUNT_EXACT remains enforced and passing', async () => {
    const source = fixture('c1', 'scenario.min.json');
    const scenario = parseReplayScenarioJson(await fs.readFile(source, 'utf8'), source);
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
    const exact = first.oracles.find((oracle) => oracle.id === 'RT_TOOL_COUNT_EXACT');
    assert.equal(exact?.level, 'enforced');
    assert.equal(exact?.passed, true, exact?.detail);
    assert.equal(first.trace.terminal.kind, 'result');
    assert.equal(first.trace.terminal.result.toolCallsMade, 1);
  });

  await check('RT_ABORT evidence remains a stable architectural candidate', async () => {
    const source = fixture('c2', 'scenario.min.json');
    const scenario = parseReplayScenarioJson(await fs.readFile(source, 'utf8'), source);
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
    assert.equal(
      normalizedJson(first.trace),
      normalizedJson(JSON.parse(await fs.readFile(fixture('c2', 'trace.json'), 'utf8'))),
    );
    const finding = classifyReplayResult(first);
    assert.equal(finding?.kind, 'candidate_violation');
    assert.equal(finding?.oracleId, 'RT_ABORT_NO_LATE_EFFECT');
  });

  await check('new RT_EFFECT_IDEMPOTENCY evidence replays deterministically with matching fingerprint', async () => {
    const scenario = parseReplayScenarioJson(
      await fs.readFile(phaseDScenarioPath, 'utf8'),
      phaseDScenarioPath,
    );
    const first = await replayScenario(scenario);
    const second = await replayScenario(scenario);
    assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
    const persistedTrace = JSON.parse(await fs.readFile(phaseDTracePath, 'utf8'));
    assert.equal(normalizedJson(first.trace), normalizedJson(persistedTrace));
    const finding = classifyReplayResult(first);
    assert.equal(finding?.kind, 'candidate_violation');
    assert.equal(finding?.oracleId, 'RT_EFFECT_IDEMPOTENCY');
    const fingerprint = createHash('sha256')
      .update(normalizedJson({ scenario, trace: first.trace, finding }))
      .digest('hex');
    const evidence = JSON.parse(await fs.readFile(phaseDEvidencePath, 'utf8'));
    assert.equal(evidence.requestedRuns, 10_000);
    assert.equal(evidence.completedRunsBeforeFailure, 3);
    assert.equal(evidence.counterexamplePath, '2:1');
    assert.equal(evidence.generatorReplayPath, '2');
    assert.equal(fingerprint, evidence.fingerprint);
    assert.equal(fingerprint, '155ccb693bf272f27fd6b19bffdead0e76dac8aec264243d2f51d7659544248a');
  });

  await check('normalized evidence contains no volatile timestamp/path/UUID/port fields', async () => {
    const traceText = await fs.readFile(phaseDTracePath, 'utf8');
    assert.doesNotMatch(traceText, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(traceText, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    assert.doesNotMatch(traceText, /\b\d{13}\b/);
    assert.doesNotMatch(traceText, /localhost:\d{2,5}|127\.0\.0\.1:\d{2,5}/i);
    assert.doesNotMatch(traceText, /"(?:ts|timestamp|createdAt|port)"\s*:/i);
  });

  assert.equal(await isolation.assertProductionDbUnchanged(), true);
} finally {
  await isolation.restore();
}

console.log(`AGENT-RUNTIME PHASE D EVIDENCE: PASS (${checks} checks; campaignPaused=true; productionDbUnchanged=true)`);
