import assert from 'node:assert/strict';
import http from 'node:http';
import {
  clearRequestTracesForTest,
  extractProviderResponseTrace,
  finishRequestTrace,
  listRequestTraces,
  redactTraceValue,
  startRequestTrace,
  subscribeRequestTraces,
  traceEvent,
  traceModelStream,
  withRequestTrace,
} from '../server/requestTrace.ts';
import { correlateChatRecords, requestProgressSnapshot } from '../src/pages/Logs/correlation.js';
import { parseSseBuffer } from '../src/lib/api.js';
import { collectChatCompletionStream, completeChat } from '../server/bot/llm.ts';

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

async function* fakeCompletionStream() {
  yield { id: 'stream-1', model: 'deepseek-v4-flash', choices: [{ delta: { role: 'assistant', reasoning_content: '先分析' }, finish_reason: null }] };
  yield { id: 'stream-1', model: 'deepseek-v4-flash', choices: [{ delta: { reasoning_content: '问题', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'web_', arguments: '{"q"' } }] }, finish_reason: null }] };
  yield { id: 'stream-1', model: 'deepseek-v4-flash', choices: [{ delta: { content: '答案', tool_calls: [{ index: 0, function: { name: 'search', arguments: ':"x"}' } }] }, finish_reason: 'tool_calls' }] };
  yield { id: 'stream-1', model: 'deepseek-v4-flash', choices: [], usage: { total_tokens: 12, completion_tokens_details: { reasoning_tokens: 4 } } };
}
const streamedProgress = [];
const assembledStream = await collectChatCompletionStream(fakeCompletionStream(), 'fallback', (progress) => streamedProgress.push(progress));
assert.equal(assembledStream.choices[0].message.reasoning_content, '先分析问题');
assert.equal(assembledStream.choices[0].message.content, '答案');
assert.equal(assembledStream.choices[0].message.tool_calls[0].function.name, 'web_search');
assert.equal(assembledStream.choices[0].message.tool_calls[0].function.arguments, '{"q":"x"}');
assert.equal(assembledStream.choices[0].finish_reason, 'tool_calls');
assert.equal(assembledStream.usage.total_tokens, 12);
assert.equal(streamedProgress.at(-1).reasoning, '先分析问题');

const pushedTraces = [];
const unsubscribe = subscribeRequestTraces((trace) => pushedTraces.push(trace));
assert.equal(typeof unsubscribe, 'function');
const liveId = startRequestTrace({ ...input, messageId: 'live-request' });
withRequestTrace(liveId, () => {
  traceEvent('MODEL', 'model_call_started', { status: 'running' });
  traceModelStream('invocation-1', { status: 'running', response: { reasoning: '先' } });
  traceModelStream('invocation-1', { status: 'running', response: { reasoning: '先想' } });
});
const liveTrace = listRequestTraces(1)[0];
assert.equal(liveTrace.status, 'active', 'active request must be observable before completion');
assert.equal(liveTrace.events.at(-1).name, 'model_call_streaming');
assert.equal(liveTrace.events.filter((event) => event.name === 'model_call_streaming').length, 1, 'stream updates must reuse one trace event');
assert.equal(liveTrace.events.at(-1).data.response.reasoning, '先想');
const liveProgress = requestProgressSnapshot(liveTrace, new Date(liveTrace.startedAt).getTime() + 31_000);
assert.equal(liveProgress.phase, 'MODEL');
assert.equal(liveProgress.longIdle, true, 'UI must distinguish a long period without progress');
withRequestTrace(liveId, () => finishRequestTrace('completed'));
assert.equal(pushedTraces.some((trace) => trace.status === 'active' && trace.events.at(-1)?.name === 'model_call_started'), true, 'MODEL start must publish before completion');
assert.equal(pushedTraces.some((trace) => trace.status === 'completed'), true, 'terminal state must publish immediately');
const pushedBeforeUnsubscribe = pushedTraces.length;
unsubscribe();
startRequestTrace({ ...input, messageId: 'after-unsubscribe' });
assert.equal(pushedTraces.length, pushedBeforeUnsubscribe, 'unsubscribed clients must not retain listeners');

const firstSseChunk = parseSseBuffer('data: {"type":"snapshot","traces":[]}\n\ndata: {"type":"up');
assert.deepEqual(firstSseChunk.messages, [{ type: 'snapshot', traces: [] }]);
const secondSseChunk = parseSseBuffer(firstSseChunk.remainder + 'sert","trace":{"id":"r1"}}\n\n');
assert.deepEqual(secondSseChunk.messages, [{ type: 'upsert', trace: { id: 'r1' } }]);
assert.equal(secondSseChunk.remainder, '');

const providerBodies = [];
const fakeProvider = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    providerBodies.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ id: 'live-1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '实时思考' }, finish_reason: null }] });
    setTimeout(() => {
      send({ id: 'live-1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { content: '最终回答' }, finish_reason: 'stop' }] });
      send({ id: 'live-1', model: 'deepseek-v4-flash', choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } } });
      response.end('data: [DONE]\n\n');
    }, 20);
  });
});
await new Promise((resolve) => fakeProvider.listen(0, '127.0.0.1', resolve));
try {
  const port = fakeProvider.address().port;
  const endToEndUpdates = [];
  const stopEndToEndUpdates = subscribeRequestTraces((trace) => endToEndUpdates.push(trace));
  const endToEndId = startRequestTrace({ ...input, messageId: 'stream-end-to-end' });
  const completion = await withRequestTrace(endToEndId, () => completeChat({ settings: {
    llmProvider: 'deepseek',
    model: 'deepseek-v4-flash',
    apiBaseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    deepseekApiKey: 'test-key',
    temperature: 0.4,
    maxTokens: 64,
    visionMode: 'auto',
    visionImageTransport: 'auto',
    visionMaxImages: 3,
    visionMaxImageBytes: 6_000_000,
    visionImageTimeoutMs: 8_000,
  } }, {
    messages: [{ role: 'user', content: 'test live reasoning' }],
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    requestMaxRetries: 0,
  }));
  stopEndToEndUpdates();
  assert.equal(providerBodies[0].stream, true, 'traced DeepSeek request must use provider streaming');
  assert.equal(providerBodies[0].stream_options.include_usage, true);
  assert.equal(completion.text, '最终回答');
  assert.equal(completion.raw.choices[0].message.reasoning_content, '实时思考');
  assert.equal(endToEndUpdates.some((trace) => trace.events.some((event) => event.name === 'model_call_streaming' && event.data?.response?.reasoning === '实时思考')), true, 'raw CoT must publish before final completion');
  assert.equal(endToEndUpdates.some((trace) => trace.events.some((event) => event.name === 'model_call_completed' && event.data?.streaming === true)), true, 'final trace must retain streaming mode');
} finally {
  await new Promise((resolve) => fakeProvider.close(resolve));
}

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
