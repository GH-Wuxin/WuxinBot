// Small real-async probes. These use actual Promise, AbortController and timer
// ordering; they supplement (and do not elevate) symbolic scheduler evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installReplayIsolation } from './agent-runtime/isolation.ts';
import { parseReplayScenarioJson } from './agent-runtime/scenario.ts';
import { normalizedJson } from './agent-runtime/trace.ts';
import { toLlmTools } from './agent-runtime/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_SCENARIO = path.join(ROOT, 'tools', 'fixtures', 'agent-runtime', 'c2', 'scenario.min.json');

function planner(call) {
  return {
    text: '',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    raw: {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }],
        },
      }],
    },
  };
}

function finalText(text = 'real async complete') {
  return {
    text,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    raw: { choices: [{ finish_reason: 'stop', message: { content: text } }] },
  };
}

async function realOuterControlProbe(runToolLoop, kind) {
  const call = { id: `${kind}_call`, name: `${kind}_tool`, args: { target: 'locked-player' } };
  let llmCalls = 0;
  let toolCalls = 0;
  let businessEffects = 0;
  const completeChat = async () => (++llmCalls === 1 ? planner(call) : finalText());
  const executeToolCallFn = async () => {
    toolCalls++;
    return await new Promise((resolve) => {
      setTimeout(() => {
        businessEffects++;
        resolve({ ok: true, content: `${kind} late result` });
      }, 30);
    });
  };
  const runtime = runToolLoop(completeChat, {
    db: { settings: {} },
    messages: [{ role: 'user', content: `${kind} targeted async` }],
    tools: toLlmTools([{ name: call.name }]),
    userId: 'c2-actor',
    groupId: 'c2-group',
    maxIterations: 3,
    executeToolCallFn,
  });

  let outerTerminal;
  if (kind === 'abort') {
    const controller = new AbortController();
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('abort'), { once: true });
    });
    setTimeout(() => controller.abort('targeted abort'), 5);
    outerTerminal = await Promise.race([runtime.then(() => 'runtime'), aborted]);
  } else {
    const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5));
    outerTerminal = await Promise.race([runtime.then(() => 'runtime'), timedOut]);
  }
  assert.equal(outerTerminal, kind);
  assert.equal(businessEffects, 0, 'effect must still be pending when outer control wins');
  const result = await runtime;
  assert.equal(result.toolCallsMade, 1);
  assert.equal(toolCalls, 1);
  assert.equal(llmCalls, 2);
  assert.equal(businessEffects, 1, 'pending tool continues because runToolLoop has no cancellation input');
}

const isolation = await installReplayIsolation();
try {
  const { replayScenario } = await import('./agent-runtime/runner.ts');
  const { runToolLoop } = await import('../server/bots/executor.ts');

  const scenario = parseReplayScenarioJson(await fs.readFile(MIN_SCENARIO, 'utf8'), MIN_SCENARIO);
  const first = await replayScenario(scenario);
  const second = await replayScenario(scenario);
  assert.equal(normalizedJson(first.trace), normalizedJson(second.trace));
  const candidate = first.oracles.find((oracle) => oracle.id === 'RT_ABORT_NO_LATE_EFFECT');
  assert.equal(candidate?.level, 'candidate');
  assert.equal(candidate?.passed, false);

  await realOuterControlProbe(runToolLoop, 'abort');
  await realOuterControlProbe(runToolLoop, 'timeout');

  // A delayed final ToolResult remains a runToolLoop terminal: it skips the
  // rest of the batch and causes no post-final LLM/tool execution.
  let finalLlmCalls = 0;
  let finalToolCalls = 0;
  let resolverAttempts = 0;
  let finalEffects = 0;
  const finalCall = { id: 'late_final', name: 'late_final_tool', args: { target: 'locked-player' } };
  const finalResult = await runToolLoop(async () => {
    finalLlmCalls++;
    return planner(finalCall);
  }, {
    db: { settings: {} },
    messages: [{ role: 'user', content: 'late final targeted async' }],
    tools: toLlmTools([{ name: finalCall.name }, { name: 'must_not_execute' }]),
    userId: 'c2-actor',
    groupId: 'c2-group',
    maxIterations: 3,
    executeToolCallFn: async () => {
      finalToolCalls++;
      return await new Promise((resolve) => setTimeout(() => {
        resolverAttempts++;
        finalEffects++;
        const value = { ok: true, content: 'late final', directContent: 'late final', final: true };
        resolve(value);
        resolverAttempts++;
        resolve(value);
      }, 10));
    },
  });
  assert.equal(finalResult.toolCallsMade, 1);
  assert.equal(finalLlmCalls, 1);
  assert.equal(finalToolCalls, 1);
  assert.equal(resolverAttempts, 2);
  assert.equal(finalEffects, 1);
  assert.equal(finalResult.directContent, 'late final');

  assert.equal(await isolation.assertProductionDbUnchanged(), true);
  console.log('AGENT-RUNTIME C2.1 TARGETED ASYNC: PASS (candidate reproduced; productionDbUnchanged=true)');
} finally {
  await isolation.restore();
}
