import assert from 'node:assert/strict';
import { applyUsageTotals, mergeLlmUsage, usageBreakdown, usageEventFields } from '../server/usage.ts';

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
});

const totals = { totalTokens: 1_000, promptTokens: 800, completionTokens: 200 };
applyUsageTotals(totals, first);
assert.deepEqual(totals, {
  totalTokens: 1_120,
  promptTokens: 900,
  cachedTokens: 40,
  cacheWriteTokens: 8,
  completionTokens: 220,
  reasoningTokens: 6,
});

const merged = mergeLlmUsage(first, second);
assert.equal(merged.total_tokens, 138);
assert.equal(merged.prompt_tokens, 111);
assert.equal(merged.completion_tokens, 27);
assert.equal(merged.prompt_tokens_details.cached_tokens, 43);
assert.equal(merged.prompt_tokens_details.cache_write_tokens, 10);
assert.equal(merged.completion_tokens_details.reasoning_tokens, 10);

console.log('usage-totals verify passed');
