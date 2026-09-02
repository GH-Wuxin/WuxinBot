import assert from 'node:assert/strict';
import { buildCodexAdapterInput, mapCodexTokenUsage, parseCodexAdapterEnvelope } from '../server/codexAppServer.ts';
import { activateModelProfile, updateProviderSettings } from '../server/modelConfig.ts';

const input = buildCodexAdapterInput([
  { role: 'system', content: 'Use Chinese.' },
  { role: 'user', content: [{ type: 'text', text: '查天气' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
], [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
assert.equal(input[0].type, 'text');
assert.match(input[0].text, /weather/);
assert.equal(input[1].type, 'image');

const toolEnvelope = parseCodexAdapterEnvelope(JSON.stringify({
  kind: 'tool_calls',
  content: '',
  tool_calls: [{ id: 'call_1', name: 'weather', arguments: '{"city":"上海"}' }],
}));
assert.equal(toolEnvelope.kind, 'tool_calls');
assert.deepEqual(toolEnvelope.toolCalls[0].arguments, { city: '上海' });

const usage = mapCodexTokenUsage({
  totalTokens: 120,
  inputTokens: 100,
  cachedInputTokens: 72,
  cacheWriteInputTokens: 16,
  outputTokens: 20,
  reasoningOutputTokens: 8,
});
assert.equal(usage.prompt_tokens, 100);
assert.equal(usage.prompt_tokens_details.cached_tokens, 72);
assert.equal(usage.prompt_tokens_details.cache_write_tokens, 16);
assert.equal(usage.completion_tokens, 20);
assert.equal(usage.completion_tokens_details.reasoning_tokens, 8);

const base = {
  llmProvider: 'deepseek',
  apiKey: 'sk-test',
  apiBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: 'sk-test',
  deepseekApiBaseUrl: 'https://api.deepseek.com',
  mimoApiKey: '',
  mimoApiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  model: 'deepseek-v4-flash',
};
const codex = updateProviderSettings(base, { llmProvider: 'codex-app-server', codexModel: 'gpt-5.6-luna' });
assert.equal(codex.llmProvider, 'codex-app-server');
assert.equal(codex.codexFallbackProvider, 'deepseek');
assert.equal(codex.codexFallbackModel, 'deepseek-v4-flash');
assert.equal(codex.deepseekApiKey, 'sk-test');
assert.equal(activateModelProfile(codex, 'deepseek-chat').llmProvider, 'codex-app-server');

const rolledBack = updateProviderSettings(codex, { llmProvider: 'deepseek', model: 'deepseek-v4-flash' });
assert.equal(rolledBack.llmProvider, 'deepseek');
assert.equal(rolledBack.apiKey, 'sk-test');

console.log('codex-app-server verify: ok');
