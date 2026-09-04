import assert from 'node:assert/strict';
import { buildCodexAdapterInput, mapCodexTokenUsage, parseCodexAdapterEnvelope } from '../server/codexAppServer.ts';
import { activeModelName, activateModelProfile, updateProviderSettings } from '../server/modelConfig.ts';
import { modelSupportsVision } from '../server/bot/prompt.ts';
import { buildPippiPrompt } from '../server/bot/persona.ts';

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

const input = buildCodexAdapterInput([
  { role: 'system', content: 'Use Chinese.' },
  { role: 'user', content: [{ type: 'text', text: '查天气' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
], [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
assert.equal(input[0].type, 'text');
assert.match(input[0].text, /weather/);
assert.equal(input[1].type, 'image');
assert.ok(input[0].text.indexOf('External tools') < input[0].text.indexOf('Leading system\/developer instructions'));
assert.ok(input[0].text.indexOf('Leading system\/developer instructions') < input[0].text.indexOf('Conversation messages'));

const siblingInput = buildCodexAdapterInput([
  { role: 'system', content: 'Use Chinese.' },
  { role: 'user', content: '查上海天气' },
], [{ type: 'function', function: { name: 'weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]);
const conversationBoundary = input[0].text.indexOf('Conversation messages (JSON, in order):');
assert.ok(
  commonPrefixLength(input[0].text, siblingInput[0].text) >= conversationBoundary,
  '相同工具和系统指令必须保持到动态会话区之前的公共缓存前缀',
);

const personaPrompt = buildPippiPrompt({
  scene: 'casual',
  userPersonality: '固定表达偏好测试',
  factualContext: '每轮变化的运行时信息',
});
assert.ok(
  personaPrompt.indexOf('固定表达偏好测试') < personaPrompt.indexOf('当前场景：日常聊天。'),
  '稳定人格补充应位于每轮场景和动态上下文之前',
);

const codexVisionSettings = {
  visionMode: 'on',
  llmProvider: 'codex-app-server',
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'GPT-5.6-Sol',
};
assert.equal(
  modelSupportsVision({ settings: codexVisionSettings }),
  true,
  '显式多模态模式不能被遗留的 DeepSeek API 地址覆盖',
);
assert.equal(
  modelSupportsVision({ settings: { ...codexVisionSettings, visionMode: 'off' } }),
  false,
  '显式纯文字模式必须保持关闭视觉输入',
);
assert.equal(
  modelSupportsVision({ settings: { ...codexVisionSettings, visionMode: 'auto', codexModel: 'gpt-5.6-luna' } }),
  true,
  'Codex 自动视觉模式不能被遗留的 API 模型误判为纯文字',
);
assert.equal(
  modelSupportsVision({ settings: { ...codexVisionSettings, visionMode: 'auto', llmProvider: 'deepseek', model: 'deepseek-chat' } }),
  false,
  '自动模式下仍应按当前 DeepSeek 模型能力判断',
);

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
assert.equal(usage.cache_metrics_available, true);

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
assert.equal(activeModelName({ ...codex, model: 'GPT-5.6-Sol' }), 'gpt-5.6-luna');

const switchedCodex = updateProviderSettings(codex, { codexModel: 'gpt-5.6-terra' });
assert.equal(activeModelName(switchedCodex), 'gpt-5.6-terra');
assert.equal(switchedCodex.model, 'deepseek-v4-flash', '切换 Codex 模型必须保留 API 回退模型');

const rolledBack = updateProviderSettings(codex, { llmProvider: 'deepseek', model: 'deepseek-v4-flash' });
assert.equal(rolledBack.llmProvider, 'deepseek');
assert.equal(rolledBack.apiKey, 'sk-test');

console.log('codex-app-server verify: ok');
