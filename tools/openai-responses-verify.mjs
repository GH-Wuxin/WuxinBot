import assert from 'node:assert/strict';
import {
  buildOpenAIResponsesParams,
  buildResponsesInput,
  normalizeOpenAIResponsesResponse,
} from '../server/bot/openaiResponses.ts';

const user = buildResponsesInput([
  { role: 'system', content: 'system rules' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'low' } },
    ],
  },
]);
assert.equal(user.instructions, 'system rules');
assert.deepEqual(user.input, [{
  role: 'user',
  content: [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'low' },
  ],
}]);

const priorOutput = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'query', arguments: '{"q":"x"}' },
  { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
];
const preserved = buildResponsesInput([
  { role: 'system', content: 'system rules' },
  { role: 'user', content: 'do it' },
  {
    role: 'assistant',
    content: 'checking',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'query', arguments: '{"q":"x"}' } }],
    responses_output: priorOutput,
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'result' },
]);
assert.deepEqual(preserved.input[1], priorOutput[0]);
assert.deepEqual(preserved.input[2], priorOutput[1]);
assert.deepEqual(preserved.input[3], priorOutput[2]);
assert.deepEqual(preserved.input[4], {
  type: 'function_call_output',
  call_id: 'call_1',
  output: 'result',
});

const reconstructed = buildResponsesInput([
  {
    role: 'assistant',
    content: 'previous',
    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'ping', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'call_2', content: 'pong' },
]);
assert.deepEqual(reconstructed.input[0], {
  role: 'assistant',
  content: [{ type: 'output_text', text: 'previous' }],
});
assert.deepEqual(reconstructed.input[1], {
  type: 'function_call',
  call_id: 'call_2',
  name: 'ping',
  arguments: '{}',
});
assert.deepEqual(reconstructed.input[2], {
  type: 'function_call_output',
  call_id: 'call_2',
  output: 'pong',
});

const orphanTool = buildResponsesInput([
  { role: 'tool', tool_call_id: 'missing', content: 'orphan' },
]);
assert.equal(orphanTool.input[0].role, 'user');
assert.ok(orphanTool.input[0].content[0].text.includes('missing'));

const chatParams = {
  model: 'gpt-6.1-terra',
  tools: [{
    type: 'function',
    function: {
      name: 'query',
      description: 'query data',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  }],
  tool_choice: 'auto',
  max_completion_tokens: 420,
  response_format: { type: 'json_object' },
};
const params = buildOpenAIResponsesParams(chatParams, [{ role: 'user', content: 'x' }], {
  reasoning_effort: 'high',
});
assert.equal(params.model, 'gpt-6.1-terra');
assert.equal(params.store, false);
assert.deepEqual(params.include, ['reasoning.encrypted_content']);
assert.equal(params.reasoning.effort, 'high');
assert.equal(params.tools.length, 1);
assert.equal(params.tools[0].type, 'function');
assert.equal(params.tools[0].name, 'query');
assert.equal(params.tools[0].strict, false);
assert.equal(params.tool_choice, 'auto');
assert.equal(params.parallel_tool_calls, true);
assert.equal(params.max_output_tokens, 8192);
assert.deepEqual(params.text, { format: { type: 'json_object' } });

const lowParams = buildOpenAIResponsesParams(chatParams, [{ role: 'user', content: 'x' }], {
  reasoning_effort: 'low',
});
assert.equal(lowParams.max_output_tokens, 4096);

const backgroundParams = buildOpenAIResponsesParams(chatParams, [{ role: 'user', content: 'x' }], {
  reasoning_effort: 'low',
  completionBudget: 2048,
});
assert.equal(backgroundParams.max_output_tokens, 2048);

const noLimitParams = buildOpenAIResponsesParams({
  ...chatParams,
  max_completion_tokens: undefined,
}, [{ role: 'user', content: 'x' }], {});
assert.equal('max_output_tokens' in noLimitParams, false);

const namedChoice = buildOpenAIResponsesParams({
  ...chatParams,
  tool_choice: { type: 'function', function: { name: 'query' } },
}, [{ role: 'user', content: 'x' }], {});
assert.deepEqual(namedChoice.tool_choice, { type: 'function', name: 'query' });

const raw = {
  id: 'resp_1',
  model: 'gpt-6.1-terra',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'query', arguments: '{"q":"x"}' },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
};
const normalized = normalizeOpenAIResponsesResponse(raw);
assert.equal(normalized.id, 'resp_1');
assert.equal(normalized.model, 'gpt-6.1-terra');
assert.equal(normalized.choices[0].message.content, 'hello');
assert.deepEqual(normalized.choices[0].message.tool_calls, [{
  id: 'call_1',
  type: 'function',
  function: { name: 'query', arguments: '{"q":"x"}' },
}]);
assert.equal(normalized.choices[0].finish_reason, 'tool_calls');
assert.equal(normalized.choices[0].message.responses_output.length, 3);
assert.equal(normalized.usage.prompt_tokens, 100);
assert.equal(normalized.usage.completion_tokens, 20);
assert.equal(normalized.usage.total_tokens, 120);
assert.equal(normalized.usage.prompt_tokens_details.cached_tokens, 30);
assert.equal(normalized.usage.prompt_tokens_details.cache_write_tokens, 10);
assert.equal(normalized.usage.completion_tokens_details.reasoning_tokens, 5);
assert.equal(normalized.usage.cache_metrics_available, true);

const textOnly = normalizeOpenAIResponsesResponse({
  ...raw,
  output: [{ type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
});
assert.equal(textOnly.choices[0].message.content, 'done');
assert.equal(textOnly.choices[0].message.tool_calls, null);
assert.equal(textOnly.choices[0].finish_reason, 'stop');

const incomplete = normalizeOpenAIResponsesResponse({
  ...raw,
  status: 'incomplete',
  output: [],
});
assert.equal(incomplete.choices[0].finish_reason, 'length');
assert.equal(incomplete.choices[0].message.content, null);

console.log('OpenAI Responses adapter: message/tool mapping, reasoning preservation, choices and usage normalization PASS');
