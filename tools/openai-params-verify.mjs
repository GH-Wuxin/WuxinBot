import assert from 'node:assert/strict';
import { completionLimitField, isOfficialOpenAIEndpoint, shouldSetOpenAIReasoningNone, shouldSetTemperature } from '../server/bot/llm.ts';

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

assert.equal(shouldSetOpenAIReasoningNone('openai-compatible', 'https://api.openai.com/v1', 'gpt-6.1-terra', true), true);
assert.equal(shouldSetOpenAIReasoningNone('openai-compatible', 'https://api.openai.com/v1', 'o3-mini', true), true);
assert.equal(shouldSetOpenAIReasoningNone('openai-compatible', 'https://api.openai.com/v1', 'gpt-4o-mini', true), false);
assert.equal(shouldSetOpenAIReasoningNone('openai-compatible', 'https://relay.example/v1', 'gpt-6.1-terra', true), false);
assert.equal(shouldSetOpenAIReasoningNone('openai-compatible', 'https://api.openai.com/v1', 'gpt-6.1-terra', false), false);

console.log('OpenAI parameter adaptation: official endpoint uses max_completion_tokens, default temperature and reasoning_effort=none for tools; relays and DeepSeek keep existing behavior PASS');
