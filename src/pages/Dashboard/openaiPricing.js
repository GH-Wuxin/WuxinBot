// OpenAI standard list prices, USD per 1M tokens, checked 2026-11-14.
// Source: https://developers.openai.com/api/docs/pricing
// Short-context Standard rates; Batch/Flex, Fast, regional and long-context
// surcharges are deliberately not applied here.
export const OPENAI_PRICING_CHECKED_AT = '2026-11-14';

export const OPENAI_MODEL_PRICING = {
  'gpt-6.1-terra': { label: 'Terra 6.1', input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
  'gpt-6-luna': { label: 'Luna 6', input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6.1-sol': { label: 'Sol 6.1', input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
};

const count = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

export function openAIPricingFor(settings, model) {
  if (settings?.llmProvider !== 'openai-compatible') return null;
  const raw = String(settings.apiBaseUrl || '').trim();
  if (raw) {
    let host = '';
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host !== 'api.openai.com') return null;
  }
  return OPENAI_MODEL_PRICING[String(model || '')] || null;
}

/**
 * Prices are per 1M tokens. Cached and cache-write tokens are treated as
 * subsets of promptTokens, matching OpenAI usage details.
 */
export function estimateOpenAIUsageCost(model, usage = {}) {
  const pricing = OPENAI_MODEL_PRICING[String(model || '')];
  if (!pricing) return null;
  const prompt = count(usage.promptTokens);
  const cached = count(usage.cachedTokens);
  const cacheWrite = count(usage.cacheWriteTokens);
  const output = count(usage.completionTokens);
  const uncached = Math.max(0, prompt - cached - cacheWrite);
  return (
    uncached * pricing.input
    + cached * pricing.cachedInput
    + cacheWrite * pricing.cacheWrite
    + output * pricing.output
  ) / 1_000_000;
}

export function estimateOpenAIModelsCost(models = {}) {
  let total = 0;
  let pricedModels = 0;
  const unpricedModels = [];
  for (const [model, usage] of Object.entries(models || {})) {
    const cost = estimateOpenAIUsageCost(model, usage);
    if (cost == null) {
      unpricedModels.push(model);
      continue;
    }
    total += cost;
    pricedModels += 1;
  }
  return { cost: pricedModels ? total : null, pricedModels, unpricedModels };
}

export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Math.max(0, Number(value));
  if (number >= 1) return `$${number.toFixed(2)}`;
  if (number >= 0.01) return `$${number.toFixed(4)}`;
  if (number > 0 && number < 0.000001) return '<$0.000001';
  if (number > 0) return `$${number.toFixed(6)}`;
  return '$0.00';
}

export function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `$${number.toFixed(number >= 1 ? 2 : 4)}`;
}
