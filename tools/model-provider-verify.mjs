import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateModelProfile,
  activeProviderLabel,
  providerFamily,
  updateProviderSettings,
} from '../server/modelConfig.ts';

const deepseek = {
  llmProvider: 'deepseek',
  apiKey: 'deepseek-live-key',
  apiBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: 'deepseek-live-key',
  deepseekApiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

test('explicit OpenAI-compatible provider wins over a deepseek-* model id', () => {
  const next = updateProviderSettings(deepseek, {
    llmProvider: 'openai-compatible',
    apiKey: 'amr-key',
    apiBaseUrl: 'https://amr-link.open-design.ai/v1',
    model: 'deepseek-v3.2',
  });
  assert.equal(next.llmProvider, 'openai-compatible');
  assert.equal(next.model, 'deepseek-v3.2');
  assert.equal(next.apiKey, 'amr-key');
  assert.equal(next.apiBaseUrl, 'https://amr-link.open-design.ai/v1');
  assert.equal(next.deepseekApiKey, 'deepseek-live-key');
  assert.equal(next.deepseekApiBaseUrl, 'https://api.deepseek.com');
  assert.equal(providerFamily(next), null);
  assert.equal(activeProviderLabel(next), 'OpenAI 兼容接口');
});

test('activating a deepseek-* model does not rewrite an explicit provider', () => {
  const next = activateModelProfile({
    ...deepseek,
    llmProvider: 'openai-compatible',
    apiKey: 'amr-key',
    apiBaseUrl: 'https://amr-link.open-design.ai/v1',
  }, 'deepseek-v3.2');
  assert.equal(next.llmProvider, 'openai-compatible');
  assert.equal(next.model, 'deepseek-v3.2');
  assert.equal(next.apiKey, 'amr-key');
  assert.equal(next.apiBaseUrl, 'https://amr-link.open-design.ai/v1');
  assert.equal(next.deepseekApiKey, 'deepseek-live-key');
  assert.equal(next.deepseekApiBaseUrl, 'https://api.deepseek.com');
});

test('explicit DeepSeek provider still uses the DeepSeek connection profile', () => {
  const next = updateProviderSettings({
    ...deepseek,
    llmProvider: 'openai-compatible',
    apiKey: 'amr-key',
    apiBaseUrl: 'https://amr-link.open-design.ai/v1',
  }, {
    llmProvider: 'deepseek',
    apiKey: 'new-ds-key',
    apiBaseUrl: 'https://deepseek-proxy.example/v1',
    model: 'deepseek-chat',
  });
  assert.equal(next.llmProvider, 'deepseek');
  assert.equal(next.apiKey, 'new-ds-key');
  assert.equal(next.apiBaseUrl, 'https://deepseek-proxy.example/v1');
  assert.equal(next.deepseekApiKey, 'new-ds-key');
  assert.equal(next.deepseekApiBaseUrl, 'https://deepseek-proxy.example/v1');
  assert.equal(activeProviderLabel(next), 'DeepSeek');
});
