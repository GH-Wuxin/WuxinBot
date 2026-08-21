import assert from 'node:assert/strict';
import {
  clearRequestTracesForTest,
  extractProviderResponseTrace,
  finishRequestTrace,
  listRequestTraces,
  redactTraceValue,
  startRequestTrace,
  traceEvent,
  withRequestTrace,
} from '../server/requestTrace.ts';
import { correlateChatRecords, requestProgressSnapshot } from '../src/pages/Logs/correlation.js';

clearRequestTracesForTest();

const input = { messageId: 'm1', groupId: 'g1', userId: 'u1', nickname: 'tester', type: 'group', text: 'hello' };
const before = structuredClone(input);
const handler = async (event) => ({ replied: true, text: event.text.toUpperCase() });
const expected = await handler(structuredClone(input));
const requestId = startRequestTrace(input);
const actual = await withRequestTrace(requestId, async () => {
  traceEvent('INGRESS', 'test_ingress', { authorization: 'Bearer should-never-leak' });
  const result = await handler(input);
  finishRequestTrace('completed', { replied: result.replied });
  return result;
});
assert.deepEqual(actual, expected, 'tracing must not change handler output');
assert.deepEqual(input, before, 'tracing must not mutate handler input');

const traceJson = JSON.stringify(listRequestTraces());
assert.equal(traceJson.includes('should-never-leak'), false, 'trace output must redact bearer credentials');
assert.equal(traceJson.includes('[REDACTED]'), true);
assert.doesNotThrow(() => redactTraceValue(new Proxy({}, { ownKeys() { throw new Error('boom'); } })), 'redaction is fail-open');

const responseTrace = extractProviderResponseTrace({
  choices: [{ finish_reason: 'stop', message: {
    content: 'answer',
    reasoning_content: 'real provider reasoning',
    tool_calls: [{ id: 'tc1', function: { name: 'demo', arguments: JSON.stringify({ apiKey: 'not-for-console' }) } }],
  } }],
  usage: { total_tokens: 9, prompt_tokens: 4, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } },
});
assert.equal(responseTrace.reasoning, 'real provider reasoning');
assert.equal(responseTrace.reasoningExposed, true);
assert.equal(JSON.stringify(responseTrace).includes('not-for-console'), false, 'tool arguments must be recursively redacted');
assert.equal(extractProviderResponseTrace({ choices: [{ message: { content: 'answer' } }] }).reasoningExposed, false);

const liveId = startRequestTrace({ ...input, messageId: 'live-request' });
withRequestTrace(liveId, () => traceEvent('MODEL', 'model_call_started', { status: 'running' }));
const liveTrace = listRequestTraces(1)[0];
assert.equal(liveTrace.status, 'active', 'active request must be observable before completion');
assert.equal(liveTrace.events.at(-1).name, 'model_call_started');
const liveProgress = requestProgressSnapshot(liveTrace, new Date(liveTrace.startedAt).getTime() + 31_000);
assert.equal(liveProgress.phase, 'MODEL');
assert.equal(liveProgress.longIdle, true, 'UI must distinguish a long period without progress');
withRequestTrace(liveId, () => finishRequestTrace('completed'));

const rows = correlateChatRecords(
  [
    { id: 'a', requestId: 'r1', sourceMessageId: 'm1', nickname: 'same', createdAt: '2020-01-01' },
    { id: 'b', sourceMessageId: 'm2', nickname: 'same', createdAt: '2020-01-01' },
    { id: 'c', nickname: 'same', createdAt: '2020-01-01' },
  ],
  [
    { id: 'd1', requestId: 'r1', messageId: 'wrong' },
    { id: 'd2', messageId: 'm2' },
    { id: 'd3', messageId: 'm3' },
  ],
);
assert.equal(rows.find((row) => row.message?.id === 'a')?.decision?.id, 'd1');
assert.equal(rows.find((row) => row.message?.id === 'b')?.decision?.id, 'd2');
assert.equal(rows.find((row) => row.message?.id === 'c')?.decision, null, 'must not guess by nickname/time/index');
assert.equal(rows.some((row) => row.kind === 'decision' && row.decision.id === 'd3'), true, 'orphan decisions remain visible');

clearRequestTracesForTest();
for (let i = 0; i < 175; i += 1) {
  const id = startRequestTrace({ ...input, messageId: `bounded-${i}` });
  withRequestTrace(id, () => {
    for (let n = 0; n < 140; n += 1) traceEvent('MODEL', 'bounded_event', { n });
    finishRequestTrace('completed');
  });
}
const bounded = listRequestTraces(999);
assert.equal(bounded.length, 160, 'request store retention must be bounded');
assert.equal(bounded.every((trace) => trace.events.length <= 120), true, 'per-request events must be bounded');

console.log('REQUEST_TRACE_VERIFY_PASS');
