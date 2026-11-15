import assert from 'node:assert/strict';
import { completionLimitField, isOfficialOpenAIEndpoint, shouldSetTemperature } from '../server/bot/llm.ts';
import { openAIResponsesReasoningEffort, shouldUseOpenAIResponses } from '../server/bot/openaiResponses.ts';
import { applyOpenAIChatReasoning } from '../server/bot/openaiResponses.ts';

for (const model of ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'o3-mini']) {
  const request = { model, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 2048 };
  for (const [requested, expected] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'high']]) {
    const actual = applyOpenAIChatReasoning(request, 'openai-compatible', 'https://api.openai.com/v1', requested);
    assert.deepEqual(actual, { ...request, reasoning_effort: expected });
    assert.equal('reasoning_effort' in request, false, 'must not mutate caller request');
  }
  for (const requested of [undefined, 'none', 'off', 'disabled', 'unknown']) {
    assert.equal(applyOpenAIChatReasoning(request, 'openai-compatible', 'https://api.openai.com/v1', requested), request);
  }
  assert.equal(applyOpenAIChatReasoning(request, 'openai-compatible', 'https://api.openai.com/v1', 'high', { type: 'disabled' }), request);
}
for (const [provider, url, model] of [
  ['deepseek', 'https://api.deepseek.com', 'deepseek-chat'],
  ['openai-compatible', 'https://relay.example/v1', 'gpt-6.1-terra'],
  ['openai-compatible', 'https://api.openai.com/v1', 'gpt-4o'],
  ['openai-compatible', 'https://api.openai.com/v1', 'gpt-5-pro'],
  ['openai-compatible', 'https://api.openai.com/v1', 'o1-preview'],
  ['openai-compatible', 'https://api.openai.com/v1', 'o1-mini'],
]) {
  const request = { model };
  assert.equal(applyOpenAIChatReasoning(request, provider, url, 'high'), request);
}

assert.equal(isOfficialOpenAIEndpoint('https://api.openai.com/v1'), true);
assert.equal(isOfficialOpenAIEndpoint('https://api.openai.com/v1/'), true);
assert.equal(isOfficialOpenAIEndpoint('HTTPS://API.OPENAI.COM/v1'), true);
assert.equal(isOfficialOpenAIEndpoint('https://api.openai.com.evil.example/v1'), false);
assert.equal(isOfficialOpenAIEndpoint('https://relay.example/v1'), false);
assert.equal(isOfficialOpenAIEndpoint('not a url'), false);
assert.equal(isOfficialOpenAIEndpoint(''), false);

assert.equal(completionLimitField('openai-compatible', 'https://api.openai.com/v1'), 'max_completion_tokens');
assert.equal(completionLimitField('openai-compatible', 'https://api.openai.com/v1/'), 'max_completion_tokens');
assert.equal(completionLimitField('openai-compatible', 'https://relay.example/v1'), 'max_tokens');
assert.equal(completionLimitField('deepseek', 'https://api.openai.com/v1'), 'max_tokens');
assert.equal(completionLimitField('codex-app-server', 'https://api.openai.com/v1'), 'max_tokens');

assert.equal(shouldSetTemperature('openai-compatible', 'https://api.openai.com/v1'), false);
assert.equal(shouldSetTemperature('openai-compatible', 'https://relay.example/v1'), true);
assert.equal(shouldSetTemperature('deepseek', 'https://api.openai.com/v1'), true);
assert.equal(shouldSetTemperature('codex-app-server', 'https://api.openai.com/v1'), true);

assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-6.1-terra', true), true);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-6.1-sol', true), true);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-6-astra', true), true);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-6-luna', true), true);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'o3-mini', true), true);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-4o-mini', true), false);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://relay.example/v1', 'gpt-6.1-terra', true), false);
assert.equal(shouldUseOpenAIResponses('openai-compatible', 'https://api.openai.com/v1', 'gpt-6.1-terra', false), false);
assert.equal(shouldUseOpenAIResponses('deepseek', 'https://api.openai.com/v1', 'gpt-6.1-terra', true), false);

assert.equal(openAIResponsesReasoningEffort('gpt-6.1-terra', undefined), 'low');
assert.equal(openAIResponsesReasoningEffort('gpt-6.1-terra', 'high'), 'high');
assert.equal(openAIResponsesReasoningEffort('gpt-6.1-terra', 'max'), 'max');
assert.equal(openAIResponsesReasoningEffort('gpt-6.1-sol', 'none'), 'low');
assert.equal(openAIResponsesReasoningEffort('gpt-6-astra', 'none'), 'low');
assert.equal(openAIResponsesReasoningEffort('gpt-6-astra', 'max'), 'xhigh');
assert.equal(openAIResponsesReasoningEffort('gpt-6-astra', 'xhigh'), 'xhigh');
assert.equal(openAIResponsesReasoningEffort('o3-mini', 'max'), 'high');

console.log('OpenAI parameter adaptation: official tool calls use Responses, reasoning effort is model-clamped, Chat Completions keeps max_completion_tokens/default temperature, relays and DeepSeek keep existing behavior PASS');
