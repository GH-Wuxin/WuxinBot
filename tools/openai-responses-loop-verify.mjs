import assert from 'node:assert/strict';
import { runToolLoop } from '../server/bots/executor/toolLoop.ts';

const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'ping', arguments: '{}' },
};
const responsesOutput = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted' },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ping', arguments: '{}' },
];
const usage = { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 };
const seen = [];

const completeChatFn = async (db, options) => {
  seen.push(options);
  if (seen.length === 1) {
    return {
      text: '',
      usage,
      raw: {
        model: 'gpt-6-luna',
        usage,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall],
            responses_output: responsesOutput,
          },
          finish_reason: 'tool_calls',
        }],
      },
    };
  }
  return {
    text: 'pong',
    usage,
    raw: {
      model: 'gpt-6-luna',
      usage,
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
    },
  };
};

const result = await runToolLoop(completeChatFn, {
  db: { settings: {}, groups: [] },
  messages: [{ role: 'user', content: 'ping' }],
  tools: [{
    type: 'function',
    function: {
      name: 'ping',
      description: 'ping',
      parameters: { type: 'object', properties: {} },
    },
  }],
  userId: 'test-user',
  maxIterations: 3,
  executeToolCallFn: async () => ({ ok: true, content: 'pong' }),
  label: 'responses loop test',
});

assert.equal(result.text, 'pong');
assert.equal(result.toolCallsMade, 1);
assert.ok(seen.length >= 2);
const followUp = seen.find((options) => options.messages.some((message) => message.role === 'tool'));
assert.ok(followUp, 'tool result round was not sent');
const assistant = followUp.messages.find((message) => message.role === 'assistant' && message.tool_calls?.length);
assert.ok(assistant, 'assistant tool-call message missing');
assert.deepEqual(assistant.responses_output, responsesOutput);
assert.equal(assistant.tool_calls[0].id, 'call_1');
const toolMessage = followUp.messages.find((message) => message.role === 'tool');
assert.equal(toolMessage.tool_call_id, 'call_1');
assert.ok(toolMessage.content.startsWith('pong'));

console.log('OpenAI Responses loop: assistant output items and tool results survive the tool loop PASS');
