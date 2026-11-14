import assert from 'node:assert/strict';
import {
  OPENAI_MODEL_PRICING,
  estimateOpenAIModelsCost,
  estimateOpenAIUsageCost,
  formatRate,
  formatUsd,
  openAIPricingFor,
} from '../src/pages/Dashboard/openaiPricing.js';

const official = { llmProvider: 'openai-compatible', apiBaseUrl: 'https://api.openai.com/v1' };
assert.equal(openAIPricingFor(official, 'gpt-6.1-terra').label, 'Terra 6.1');
assert.equal(openAIPricingFor(official, 'gpt-6-luna').label, 'Luna 6');
assert.equal(openAIPricingFor(official, 'gpt-6.1-sol').label, 'Sol 6.1');
assert.equal(openAIPricingFor({ ...official, apiBaseUrl: 'https://relay.example/v1' }, 'gpt-6.1-terra'), null);
assert.equal(openAIPricingFor({ ...official, llmProvider: 'deepseek' }, 'gpt-6.1-terra'), null);
assert.equal(openAIPricingFor({ ...official, apiBaseUrl: '' }, 'gpt-6.1-terra').label, 'Terra 6.1');
assert.equal(openAIPricingFor(official, 'gpt-unknown'), null);

assert.equal(estimateOpenAIUsageCost('gpt-6.1-terra', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 6);
assert.equal(estimateOpenAIUsageCost('gpt-6-luna', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 0.6);
assert.equal(estimateOpenAIUsageCost('gpt-6.1-sol', { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 12);
const cachedCost = estimateOpenAIUsageCost('gpt-6.1-terra', {
  promptTokens: 1_000_000,
  cachedTokens: 500_000,
  cacheWriteTokens: 200_000,
  completionTokens: 1_000_000,
});
assert.ok(Math.abs(cachedCost - 5.575) < 1e-9, String(cachedCost));
assert.equal(estimateOpenAIUsageCost('gpt-unknown', { promptTokens: 1 }), null);

const modelsCost = estimateOpenAIModelsCost({
  'gpt-6.1-terra': { promptTokens: 1_000_000, completionTokens: 1_000_000 },
  'gpt-6-luna': { promptTokens: 1_000_000, completionTokens: 1_000_000 },
  'gpt-unknown': { promptTokens: 1_000_000, completionTokens: 1_000_000 },
});
assert.ok(Math.abs(modelsCost.cost - 6.6) < 1e-9, String(modelsCost.cost));
assert.equal(modelsCost.pricedModels, 2);
assert.deepEqual(modelsCost.unpricedModels, ['gpt-unknown']);
assert.equal(estimateOpenAIModelsCost({}).cost, null);
assert.equal(estimateOpenAIModelsCost({ 'gpt-unknown': { promptTokens: 1 } }).cost, null);

assert.equal(formatUsd(0), '$0.00');
assert.equal(formatUsd(0.0000001), '<$0.000001');
assert.equal(formatUsd(0.000123), '$0.000123');
assert.equal(formatUsd(0.1234), '$0.1234');
assert.equal(formatUsd(12.345), '$12.35');
assert.equal(formatRate(0.05), '$0.0500');
assert.equal(formatRate(2), '$2.00');
assert.deepEqual(Object.keys(OPENAI_MODEL_PRICING).sort(), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra']);

console.log('OpenAI pricing: Terra 6.1 / Luna 6 / Sol 6.1 input, cache and output estimates PASS');
