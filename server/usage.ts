export interface UsageBreakdown {
  totalTokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function usageBreakdown(usage: any = {}): UsageBreakdown {
  return {
    totalTokens: nonNegative(usage?.total_tokens),
    promptTokens: nonNegative(usage?.prompt_tokens ?? usage?.input_tokens),
    cachedTokens: nonNegative(
      usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.cache_read_input_tokens,
    ),
    cacheWriteTokens: nonNegative(
      usage?.prompt_tokens_details?.cache_write_tokens
      ?? usage?.input_tokens_details?.cache_write_tokens
      ?? usage?.cache_write_input_tokens,
    ),
    completionTokens: nonNegative(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokens: nonNegative(usage?.completion_tokens_details?.reasoning_tokens),
  };
}

export function applyUsageTotals(target: any, usage: any = {}): UsageBreakdown {
  const values = usageBreakdown(usage);
  target.totalTokens = nonNegative(target.totalTokens) + values.totalTokens;
  target.promptTokens = nonNegative(target.promptTokens) + values.promptTokens;
  target.cachedTokens = nonNegative(target.cachedTokens) + values.cachedTokens;
  target.cacheWriteTokens = nonNegative(target.cacheWriteTokens) + values.cacheWriteTokens;
  target.completionTokens = nonNegative(target.completionTokens) + values.completionTokens;
  target.reasoningTokens = nonNegative(target.reasoningTokens) + values.reasoningTokens;
  return values;
}

export function usageEventFields(usage: any = {}) {
  return usageBreakdown(usage);
}

export function mergeLlmUsage(...items: any[]) {
  const merged = items.reduce<UsageBreakdown>((total, item) => {
    const values = usageBreakdown(item);
    total.totalTokens += values.totalTokens;
    total.promptTokens += values.promptTokens;
    total.cachedTokens += values.cachedTokens;
    total.cacheWriteTokens += values.cacheWriteTokens;
    total.completionTokens += values.completionTokens;
    total.reasoningTokens += values.reasoningTokens;
    return total;
  }, {
    totalTokens: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  });
  return {
    total_tokens: merged.totalTokens,
    prompt_tokens: merged.promptTokens,
    completion_tokens: merged.completionTokens,
    prompt_tokens_details: {
      cached_tokens: merged.cachedTokens,
      cache_write_tokens: merged.cacheWriteTokens,
    },
    input_tokens_details: { cached_tokens: merged.cachedTokens },
    completion_tokens_details: { reasoning_tokens: merged.reasoningTokens },
    cache_read_input_tokens: merged.cachedTokens,
    cache_write_input_tokens: merged.cacheWriteTokens,
  };
}
