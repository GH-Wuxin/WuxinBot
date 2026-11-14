import assert from 'node:assert/strict';
import {
  buildOpenAIUsageStats,
  initializeOpenAIUsage,
  recordOpenAIUsage,
} from '../server/usage.ts';
import { estimateOpenAIModelsCost } from '../src/pages/Dashboard/openaiPricing.js';

const HOUR = 3600_000;
const now = Date.parse('2026-11-14T13:30:00Z');

const officialCall = (model, usage, at) => ({
  provider: 'openai-compatible',
  apiHost: 'api.openai.com',
  model,
  usage,
  at,
});

const store = { usage: {} };
const terraUsage = {
  prompt_tokens: 1_000_000,
  completion_tokens: 100_000,
  prompt_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 100_000 },
};
assert.equal(recordOpenAIUsage(store.usage, officialCall('gpt-6.1-terra', terraUsage, now - 2 * HOUR)), true);
assert.equal(recordOpenAIUsage(store.usage, {
  ...officialCall('gpt-6.1-terra', terraUsage, now - 2 * HOUR),
  apiHost: 'relay.example',
}), false);
assert.equal(recordOpenAIUsage(store.usage, {
  ...officialCall('gpt-6.1-terra', terraUsage, now - 2 * HOUR),
  provider: 'deepseek',
}), false);
assert.equal(recordOpenAIUsage(store.usage, officialCall('', terraUsage, now - 2 * HOUR)), false);
assert.equal(recordOpenAIUsage(store.usage, officialCall('gpt-6-luna', {
  promptTokens: 2_000_000,
  cachedTokens: 500_000,
  cacheWriteTokens: 0,
  completionTokens: 200_000,
}, now - HOUR)), true);

const stats = buildOpenAIUsageStats(store.usage.openai, now);
assert.deepEqual(stats.hourly24.models['gpt-6.1-terra'], {
  promptTokens: 1_000_000,
  cachedTokens: 200_000,
  cacheWriteTokens: 100_000,
  completionTokens: 100_000,
  requests: 1,
});
assert.deepEqual(stats.hourly24.models['gpt-6-luna'], {
  promptTokens: 2_000_000,
  cachedTokens: 500_000,
  cacheWriteTokens: 0,
  completionTokens: 200_000,
  requests: 1,
});
assert.equal(stats.hourly24.totals.promptTokens, 3_000_000);
assert.equal(stats.hourly24.totals.completionTokens, 300_000);
assert.equal(stats.hourly24.totals.requests, 2);
assert.equal(stats.hourly24.partial, true);
assert.equal(stats.all.partial, true);

const priced = estimateOpenAIModelsCost(stats.hourly24.models);
assert.ok(Math.abs(priced.cost - 1.59) < 1e-9, String(priced.cost));
assert.equal(priced.pricedModels, 2);
assert.deepEqual(priced.unpricedModels, []);

const fullStore = { usage: {} };
recordOpenAIUsage(fullStore.usage, officialCall('gpt-6.1-sol', {
  prompt_tokens: 100,
  completion_tokens: 10,
}, now - 25 * HOUR));
recordOpenAIUsage(fullStore.usage, officialCall('gpt-6.1-sol', {
  prompt_tokens: 200,
  completion_tokens: 20,
}, now - HOUR));
const fullStats = buildOpenAIUsageStats(fullStore.usage.openai, now);
assert.equal(fullStats.hourly24.partial, false);
assert.equal(fullStats.hourly24.totals.promptTokens, 200);
assert.equal(fullStats.daily7.totals.promptTokens, 300);

const events = [
  { kind: 'llm-call', provider: 'openai-compatible', model: 'gpt-6.1-terra', promptTokens: 100, completionTokens: 10, createdAt: new Date(now - 3 * HOUR).toISOString() },
  { kind: 'llm-call', provider: 'openai-compatible', model: 'gpt-6-luna', promptTokens: 200, completionTokens: 20, createdAt: new Date(now - 2 * HOUR).toISOString() },
  { kind: 'llm-call', provider: 'openai-compatible', model: 'deepseek-v4.1-flash', promptTokens: 300, completionTokens: 30, createdAt: new Date(now - HOUR).toISOString() },
  { kind: 'llm-call', provider: 'deepseek', model: 'gpt-6.1-terra', promptTokens: 400, completionTokens: 40, createdAt: new Date(now - HOUR).toISOString() },
  { kind: 'reply-delivery', provider: 'openai-compatible', model: 'gpt-6.1-terra', promptTokens: 500, completionTokens: 50, createdAt: new Date(now - HOUR).toISOString() },
];
const officialSettings = { llmProvider: 'openai-compatible', apiBaseUrl: 'https://api.openai.com/v1' };
const history = initializeOpenAIUsage(undefined, events, officialSettings, now);
const backfilled = buildOpenAIUsageStats(history, now);
assert.deepEqual(Object.keys(backfilled.hourly24.models).sort(), ['gpt-6-luna', 'gpt-6.1-terra']);
assert.equal(backfilled.hourly24.totals.promptTokens, 300);
assert.equal(backfilled.hourly24.totals.completionTokens, 30);
assert.equal(backfilled.hourly24.totals.requests, 2);
assert.equal(history.backfillSource, 'usageEvents');
assert.equal(backfilled.completeSince, new Date(now - 3 * HOUR).toISOString());

const again = initializeOpenAIUsage(history, events, officialSettings, now + HOUR);
assert.equal(again.total['gpt-6.1-terra'].promptTokens, 100);
assert.equal(again.total['gpt-6.1-terra'].requests, 1);

const defaultSettings = { llmProvider: 'openai-compatible', apiBaseUrl: '' };
const defaultHistory = initializeOpenAIUsage(undefined, events, defaultSettings, now);
assert.equal(defaultHistory.total['gpt-6.1-terra'].promptTokens, 100);

const relayHistory = initializeOpenAIUsage(undefined, events, {
  llmProvider: 'openai-compatible',
  apiBaseUrl: 'https://relay.example/v1',
}, now);
assert.deepEqual(relayHistory.total, {});
assert.equal(relayHistory.backfillSource, 'none');

const oldStore = { usage: {} };
recordOpenAIUsage(oldStore.usage, officialCall('gpt-6.1-sol', {
  prompt_tokens: 500,
  completion_tokens: 50,
}, now - 100 * 24 * HOUR));
recordOpenAIUsage(oldStore.usage, officialCall('gpt-6.1-sol', {
  prompt_tokens: 700,
  completion_tokens: 70,
}, now));
const pruned = buildOpenAIUsageStats(oldStore.usage.openai, now);
assert.equal(pruned.all.models['gpt-6.1-sol'].promptTokens, 1200);
assert.equal(pruned.hourly24.models['gpt-6.1-sol'].promptTokens, 700);
assert.equal(pruned.daily30.models['gpt-6.1-sol'].promptTokens, 700);

const empty = buildOpenAIUsageStats(undefined, now);
assert.deepEqual(empty.hourly24.models, {});
assert.equal(empty.hourly24.totals.promptTokens, 0);
assert.equal(empty.hourly24.partial, true);

console.log('OpenAI usage ledger: official attribution, backfill, pruning and exact model costs PASS');
