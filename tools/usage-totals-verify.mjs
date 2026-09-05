import assert from 'node:assert/strict';
import { applyUsageTotals, cacheUsageSummary, mergeLlmUsage, usageBreakdown, usageEventFields } from '../server/usage.ts';

const first = {
  total_tokens: 120,
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 8 },
  completion_tokens_details: { reasoning_tokens: 6 },
};
const second = {
  total_tokens: 18,
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 3,
  cache_write_input_tokens: 2,
  completion_tokens_details: { reasoning_tokens: 4 },
};

assert.deepEqual(usageBreakdown(first), {
  totalTokens: 120,
  promptTokens: 100,
  cachedTokens: 40,
  cacheWriteTokens: 8,
  completionTokens: 20,
  reasoningTokens: 6,
});
assert.deepEqual(usageEventFields(second), {
  totalTokens: 18,
  promptTokens: 11,
  cachedTokens: 3,
  cacheWriteTokens: 2,
  completionTokens: 7,
  reasoningTokens: 4,
  cacheMetricsAvailable: true,
  cacheMeasuredPromptTokens: 11,
  accountingExcluded: false,
});

const totals = {
  totalTokens: 1_000,
  promptTokens: 800,
  completionTokens: 200,
  cacheMeasuredPromptTokens: 0,
  cacheMeasuredRequests: 0,
  cacheMetricsStartedAt: '2026-09-02T00:00:00.000Z',
};
applyUsageTotals(totals, first);
assert.deepEqual(totals, {
  totalTokens: 1_120,
  promptTokens: 900,
  cachedTokens: 40,
  cacheWriteTokens: 8,
  completionTokens: 220,
  reasoningTokens: 6,
  cacheMeasuredPromptTokens: 100,
  cacheMeasuredRequests: 1,
  cacheMetricsStartedAt: '2026-09-02T00:00:00.000Z',
});

const merged = mergeLlmUsage(first, second);
assert.equal(merged.total_tokens, 138);
assert.equal(merged.prompt_tokens, 111);
assert.equal(merged.completion_tokens, 27);
assert.equal(merged.prompt_tokens_details.cached_tokens, 43);
assert.equal(merged.prompt_tokens_details.cache_write_tokens, 10);
assert.equal(merged.completion_tokens_details.reasoning_tokens, 10);
assert.equal(merged.cache_metrics_available, true);

const measured = cacheUsageSummary([
  { promptTokens: 900, createdAt: '2026-09-01T00:00:00.000Z' },
  { promptTokens: 100, cachedTokens: 40, cacheWriteTokens: 8, createdAt: '2026-09-02T00:00:00.000Z' },
  { promptTokens: 60, cachedTokens: 0, cacheWriteTokens: 0, cacheMetricsAvailable: true, createdAt: '2026-09-02T01:00:00.000Z' },
]);
assert.deepEqual(measured, {
  promptTokens: 160,
  cachedTokens: 40,
  cacheWriteTokens: 8,
  requests: 2,
  startedAt: '2026-09-02T00:00:00.000Z',
});

console.log('usage-totals verify passed');
