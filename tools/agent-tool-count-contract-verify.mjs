// Enforced regression for executor-boundary toolCallsMade accounting.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { parseReplayScenarioJson } from './agent-runtime/scenario.ts';
import { normalizedJson } from './agent-runtime/trace.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'agent-runtime', 'c1');

async function readFixture(name) {
  const file = path.join(FIXTURES, name);
  return parseReplayScenarioJson(await fs.readFile(file, 'utf8'), file);
}

function eventCount(result, type) {
  return result.trace.events.filter((event) => event.type === type).length;
}

function exactOracle(result) {
  return result.oracles.find((oracle) => oracle.id === 'RT_TOOL_COUNT_EXACT');
}

async function replayTwice(replayScenario, scenario) {
  const first = await replayScenario(scenario);
  const second = await replayScenario(scenario);
  assert.equal(normalizedJson(first.trace), normalizedJson(second.trace), `${scenario.id} trace drift`);
  return first;
}

const source = await readFixture('scenario.min.json');
const safeControl = await readFixture('counterfactual-safe-result.json');
const requiredUnsafeControl = await readFixture('counterfactual-required-unsafe.json');
const multiTool = await readFixture('regression-multi-tool.json');
const toolThrow = await readFixture('regression-tool-throw.json');

// The safe control is derived from the sole reproduction source. Its executor
// call, arguments and business-effect script are identical; only the returned
// content changes from injection-shaped text to a safe result.
assert.deepEqual(safeControl.llmSteps, source.llmSteps);
assert.deepEqual(safeControl.initialState.toolSchemas, source.initialState.toolSchemas);
assert.deepEqual(safeControl.toolSteps[0].expect, source.toolSteps[0].expect);
assert.deepEqual(safeControl.toolSteps[0].effects, source.toolSteps[0].effects);
assert.equal(source.toolSteps[0].result.ok, true);
assert.equal(safeControl.toolSteps[0].result.ok, true);
assert.notEqual(safeControl.toolSteps[0].result.content, source.toolSteps[0].result.content);

const isolation = await installReplayIsolation();
try {
  const { replayScenario } = await import('./agent-runtime/runner.ts');
  const sourceResult = await replayTwice(replayScenario, source);
  const safeResult = await replayTwice(replayScenario, safeControl);
  const requiredUnsafeResult = await replayTwice(replayScenario, requiredUnsafeControl);
  const multiToolResult = await replayTwice(replayScenario, multiTool);
  const toolThrowResult = await replayTwice(replayScenario, toolThrow);

  for (const result of [sourceResult, safeResult, requiredUnsafeResult]) {
    assert.equal(eventCount(result, 'tool_call'), 1, `${result.scenario.id}: executor invocation`);
    assert.equal(eventCount(result, 'tool_result'), 1, `${result.scenario.id}: settled ToolResult`);
    assert.equal(eventCount(result, 'business_effect'), 1, `${result.scenario.id}: scripted effect`);
    assert.equal(result.consumption.toolConsumed, 1, `${result.scenario.id}: tool script consumption`);
    assert.equal(result.consumption.toolTotal, 1, `${result.scenario.id}: tool script total`);
  }

  for (const result of [sourceResult, safeResult, requiredUnsafeResult]) {
    assert.equal(result.trace.terminal.kind, 'result');
    assert.equal(result.trace.terminal.result.toolCallsMade, 1);
    assert.equal(exactOracle(result)?.level, 'enforced');
    assert.equal(exactOracle(result)?.passed, true, exactOracle(result)?.detail);
  }

  assert.equal(eventCount(multiToolResult, 'tool_call'), 2);
  assert.equal(eventCount(multiToolResult, 'tool_result'), 2);
  assert.equal(multiToolResult.trace.terminal.kind, 'result');
  assert.equal(multiToolResult.trace.terminal.result.toolCallsMade, 2);
  assert.equal(exactOracle(multiToolResult)?.level, 'enforced');
  assert.equal(exactOracle(multiToolResult)?.passed, true, exactOracle(multiToolResult)?.detail);
  const failedResult = multiToolResult.trace.events.find(
    (event) => event.type === 'tool_result' && event.data.ok === false,
  );
  assert(failedResult, 'ok=false ToolResult must remain observable and counted');

  // Existing throw semantics stay unchanged: the executor invocation is
  // observed, runToolLoop rejects, and no ToolLoopResult count exists.
  assert.equal(eventCount(toolThrowResult, 'tool_call'), 1);
  assert.equal(eventCount(toolThrowResult, 'tool_throw'), 1);
  assert.equal(eventCount(toolThrowResult, 'tool_result'), 0);
  assert.equal(toolThrowResult.trace.terminal.kind, 'error');
  assert.equal(exactOracle(toolThrowResult), undefined);

  assert.equal(await isolation.assertProductionDbUnchanged(), true);
} finally {
  await isolation.restore();
}

console.log('AGENT TOOL COUNT CONTRACT: FIXED + ENFORCED REGRESSION (productionDbUnchanged=true)');
