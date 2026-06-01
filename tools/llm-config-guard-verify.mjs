import assert from 'node:assert/strict';
import { createLLMClient, llmProvider } from '../server/bot/llm.ts';

const baseSettings = {
  apiKey: 'sk-test',
  llmProvider: 'deepseek',
  apiBaseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash'
};

assert.equal(
  llmProvider({ settings: { ...baseSettings, apiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' } }),
  'openai-compatible',
  'Mimo endpoint should force OpenAI-compatible provider'
);

assert.throws(
  () => createLLMClient({ settings: { ...baseSettings, apiKey: 'tp-test-mimo-key' } }),
  /配置错配/,
  'Mimo-looking key must not be sent to DeepSeek'
);

assert.doesNotThrow(
  () => createLLMClient({
    settings: {
      ...baseSettings,
      llmProvider: 'openai-compatible',
      apiBaseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      apiKey: 'tp-test-mimo-key',
      model: 'mimo-v2.5'
    }
  }),
  'Mimo OpenAI-compatible config should pass'
);

console.log('PASS: LLM provider/key guard verification');
