export interface UsageBreakdown {
  totalTokens: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface CacheUsageSummary {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  requests: number;
  startedAt: string;
}

function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
}

export function hasCacheUsageDetails(usage: any = {}): boolean {
  if (typeof usage?.cache_metrics_available === 'boolean') return usage.cache_metrics_available;
  if (typeof usage?.cacheMetricsAvailable === 'boolean') return usage.cacheMetricsAvailable;
  return hasOwn(usage?.prompt_tokens_details, 'cached_tokens')
    || hasOwn(usage?.input_tokens_details, 'cached_tokens')
    || hasOwn(usage, 'cache_read_input_tokens')
    || hasOwn(usage, 'prompt_cache_hit_tokens');
}

export function usageEventHasCacheDetails(event: any = {}): boolean {
  if (typeof event?.cacheMetricsAvailable === 'boolean') return event.cacheMetricsAvailable;
  // Events written by the first cache-telemetry release predate the explicit
  // availability flag, but already persisted these two fields.
  return hasOwn(event, 'cachedTokens') || hasOwn(event, 'cacheWriteTokens');
}

export function usageBreakdown(usage: any = {}): UsageBreakdown {
  return {
    totalTokens: nonNegative(usage?.total_tokens ?? usage?.totalTokens),
    promptTokens: nonNegative(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokens),
    cachedTokens: nonNegative(
      usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.cache_read_input_tokens
      ?? usage?.prompt_cache_hit_tokens
      ?? usage?.cachedTokens,
    ),
    cacheWriteTokens: nonNegative(
      usage?.prompt_tokens_details?.cache_write_tokens
      ?? usage?.input_tokens_details?.cache_write_tokens
      ?? usage?.cache_write_input_tokens
      ?? usage?.cacheWriteTokens,
    ),
    completionTokens: nonNegative(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.completionTokens),
    reasoningTokens: nonNegative(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoningTokens),
  };
}

export function applyUsageTotals(target: any, usage: any = {}, at = Date.now()): UsageBreakdown {
  if (usage?.accounted === true) return usageBreakdown(usage);
  usage = usage?.unaccounted_usage ?? usage;
  const values = usageBreakdown(usage);
  target.totalTokens = nonNegative(target.totalTokens) + values.totalTokens;
  target.promptTokens = nonNegative(target.promptTokens) + values.promptTokens;
  target.cachedTokens = nonNegative(target.cachedTokens) + values.cachedTokens;
  target.cacheWriteTokens = nonNegative(target.cacheWriteTokens) + values.cacheWriteTokens;
  target.completionTokens = nonNegative(target.completionTokens) + values.completionTokens;
  target.reasoningTokens = nonNegative(target.reasoningTokens) + values.reasoningTokens;
  if (hasCacheUsageDetails(usage)) {
    target.cacheMeasuredPromptTokens = nonNegative(target.cacheMeasuredPromptTokens) + measuredPromptTokens(usage);
    target.cacheMeasuredRequests = nonNegative(target.cacheMeasuredRequests) + 1;
    if (!target.cacheMetricsStartedAt) target.cacheMetricsStartedAt = new Date().toISOString();
  }
  if (target.history?.version === 1) {
    recordUsageBucket(target.history, {
      ...values, requests: 1,
      cacheMeasuredPromptTokens: measuredPromptTokens(usage),
      cacheMeasuredRequests: hasCacheUsageDetails(usage) ? 1 : 0,
    }, at);
  }
  return values;
}

export function usageEventFields(usage: any = {}) {
  // Old releases do not understand accountingExcluded. Keep diagnostic rows
  // numerically neutral even for those readers after a code-only rollback.
  const billableUsage = usage?.accounted === true ? {} : (usage?.unaccounted_usage ?? usage);
  return {
    ...usageBreakdown(billableUsage),
    cacheMetricsAvailable: hasCacheUsageDetails(billableUsage),
    cacheMeasuredPromptTokens: measuredPromptTokens(billableUsage),
    accountingExcluded: usage?.accounted === true,
    ...(usage?.accounted === true ? { observedUsage: usageBreakdown(usage) } : {}),
  };
}

export function measuredPromptTokens(usage: any = {}): number {
  if (!hasCacheUsageDetails(usage)) return 0;
  return nonNegative(usage.cache_measured_prompt_tokens ?? usageBreakdown(usage).promptTokens);
}

export function eventMeasuredPromptTokens(event: any = {}): number {
  return usageEventHasCacheDetails(event) ? nonNegative(event.cacheMeasuredPromptTokens ?? event.promptTokens) : 0;
}

export function cacheUsageSummary(events: any[] = []): CacheUsageSummary {
  const summary: CacheUsageSummary = {
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    requests: 0,
    startedAt: '',
  };
  for (const event of events) {
    if (event?.accountingExcluded || event?.kind === 'rewrite-reply' || !usageEventHasCacheDetails(event)) continue;
    const createdAt = String(event?.createdAt || '');
    const timestamp = new Date(createdAt).getTime();
    summary.promptTokens += eventMeasuredPromptTokens(event);
    summary.cachedTokens += nonNegative(event?.cachedTokens);
    summary.cacheWriteTokens += nonNegative(event?.cacheWriteTokens);
    summary.requests += 1;
    if (Number.isFinite(timestamp) && (!summary.startedAt || timestamp < new Date(summary.startedAt).getTime())) {
      summary.startedAt = createdAt;
    }
  }
  return summary;
}

export function mergeLlmUsage(...items: any[]): Record<string, any> {
  const cacheMetricsAvailable = items.some((item) => hasCacheUsageDetails(item));
  const nonempty = items.filter(item => item?.accounted || Object.values(usageBreakdown(item)).some(value => value > 0));
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
  // No measured usage: retain the legacy empty shape, without manufacturing
  // cache/reasoning detail fields (also preserves archived replay fingerprints).
  if (!cacheMetricsAvailable && nonempty.length === 0) {
    return { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  }
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
    cache_metrics_available: cacheMetricsAvailable,
    cache_measured_prompt_tokens: items.reduce((sum, item) => sum + measuredPromptTokens(item), 0),
    accounted: nonempty.length > 0 && nonempty.every(item => item.accounted === true),
    // If one invocation failed to persist, a later business write retries only
    // that unpaid subset, never the other invocations already in the ledger.
    ...(items.some(item => item?.unaccounted_usage) || (nonempty.some(item => item.accounted) && nonempty.some(item => !item.accounted))
      ? { unaccounted_usage: mergeLlmUsage(...items.filter(item => !item?.accounted).map(item => item?.unaccounted_usage ?? item)) }
      : {}),
  };
}

export const USAGE_TIME_ZONE = 'Asia/Shanghai';
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;
const PERIOD_KEYS = ['totalTokens', 'promptTokens', 'completionTokens', 'cachedTokens',
  'cacheWriteTokens', 'reasoningTokens', 'cacheMeasuredPromptTokens', 'cacheMeasuredRequests', 'requests'] as const;
export type PeriodUsage = Record<typeof PERIOD_KEYS[number], number>;
export interface UsageHistory {
  version: 1;
  timeZone: typeof USAGE_TIME_ZONE;
  completeSince: string;
  hasEarlierUsage: boolean;
  hours: Record<string, PeriodUsage>;
  days: Record<string, PeriodUsage>;
}
export function usageDayStart(at: number): number {
  return Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}
export function emptyPeriodUsage(): PeriodUsage {
  return Object.fromEntries(PERIOD_KEYS.map(key => [key, 0])) as PeriodUsage;
}
function addedUsage(previous: Partial<PeriodUsage> | undefined, values: Partial<PeriodUsage>): PeriodUsage {
  return Object.fromEntries(PERIOD_KEYS.map(key => [key, nonNegative(previous?.[key]) + nonNegative(values[key])])) as PeriodUsage;
}
function recordUsageBucket(history: UsageHistory, values: Partial<PeriodUsage>, at: number, prune = true) {
  if (!Number.isFinite(at)) return;
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  const day = usageDayStart(at);
  // Assign complete values so the store's write proxy observes new buckets too.
  history.hours[hour] = addedUsage(history.hours[hour], values);
  history.days[day] = addedUsage(history.days[day], values);
  if (prune) pruneUsageBuckets(history, at);
}
function pruneUsageBuckets(history: UsageHistory, now: number) {
  const oldestHour = Math.floor(now / HOUR_MS) * HOUR_MS - 71 * HOUR_MS;
  const oldestDay = usageDayStart(now) - 399 * DAY_MS;
  for (const key of Object.keys(history.hours)) if (Number(key) < oldestHour) delete history.hours[key];
  for (const key of Object.keys(history.days)) if (Number(key) < oldestDay) delete history.days[key];
}

/** One-time import of retained telemetry; never reset lifetime counters or guess missing days. */
export function initializeUsageHistory(usage: any = {}, events: any[] = [], now = Date.now()): UsageHistory {
  if (usage.history?.version === 1) return usage.history;
  if (usage.history !== undefined) throw new Error('Unsupported or invalid usage history');
  const history: UsageHistory = {version: 1, timeZone: USAGE_TIME_ZONE,
    completeSince: new Date(now).toISOString(), hasEarlierUsage: false, hours: {}, days: {}};
  let imported = emptyPeriodUsage();
  for (const event of events) {
    if (!event || event.accountingExcluded || event.kind === 'rewrite-reply') continue;
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    const values = {...event, requests: 1, cacheMeasuredPromptTokens: eventMeasuredPromptTokens(event),
      cacheMeasuredRequests: usageEventHasCacheDetails(event) ? 1 : 0};
    imported = addedUsage(imported, values);
    recordUsageBucket(history, values, at, false);
    if (at < Date.parse(history.completeSince)) history.completeSince = new Date(at).toISOString();
  }
  history.hasEarlierUsage = nonNegative(usage.totalTokens) > imported.totalTokens || nonNegative(usage.requests) > imported.requests;
  pruneUsageBuckets(history, now);
  return history;
}

export interface OpenAIUsageBucket {
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  requests: number;
}

export interface OpenAIUsageHistory {
  version: 1;
  timeZone: typeof USAGE_TIME_ZONE;
  completeSince: string;
  backfillSource?: 'usageEvents' | 'none';
  backfilledAt?: string;
  hours: Record<string, Record<string, OpenAIUsageBucket>>;
  days: Record<string, Record<string, OpenAIUsageBucket>>;
  total: Record<string, OpenAIUsageBucket>;
}

export interface OpenAIUsagePeriodStats {
  models: Record<string, OpenAIUsageBucket>;
  totals: OpenAIUsageBucket;
  start: number;
  end: number;
  partial: boolean;
  availableSince: string;
}

export interface OpenAIUsageStats {
  timeZone: typeof USAGE_TIME_ZONE;
  completeSince: string;
  backfillSource: string;
  hourly24: OpenAIUsagePeriodStats;
  daily7: OpenAIUsagePeriodStats;
  daily30: OpenAIUsagePeriodStats;
  month: OpenAIUsagePeriodStats;
  all: OpenAIUsagePeriodStats;
}

export const OPENAI_OFFICIAL_HOST = 'api.openai.com';
// Backfill allowlist; keep in sync with src/pages/Dashboard/openaiPricing.js.
export const OPENAI_PRICED_MODELS = ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol'] as const;

export function apiHostFromUrl(value: unknown): string {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isOpenAIPricedModel(model: unknown): boolean {
  return (OPENAI_PRICED_MODELS as readonly string[]).includes(String(model || ''));
}

function emptyOpenAIUsageBucket(): OpenAIUsageBucket {
  return { promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, requests: 0 };
}

function addedOpenAIUsageBucket(
  previous: Partial<OpenAIUsageBucket> | undefined,
  values: Partial<OpenAIUsageBucket>,
): OpenAIUsageBucket {
  return {
    promptTokens: nonNegative(previous?.promptTokens) + nonNegative(values.promptTokens),
    cachedTokens: nonNegative(previous?.cachedTokens) + nonNegative(values.cachedTokens),
    cacheWriteTokens: nonNegative(previous?.cacheWriteTokens) + nonNegative(values.cacheWriteTokens),
    completionTokens: nonNegative(previous?.completionTokens) + nonNegative(values.completionTokens),
    requests: nonNegative(previous?.requests) + nonNegative(values.requests),
  };
}

function addOpenAIModelUsage(
  target: Record<string, OpenAIUsageBucket>,
  model: string,
  values: Partial<OpenAIUsageBucket>,
) {
  target[model] = addedOpenAIUsageBucket(target[model], values);
}

function createOpenAIUsageHistory(at = Date.now()): OpenAIUsageHistory {
  const timestamp = new Date(at).toISOString();
  return {
    version: 1,
    timeZone: USAGE_TIME_ZONE,
    completeSince: timestamp,
    backfillSource: 'none',
    backfilledAt: timestamp,
    hours: {},
    days: {},
    total: {},
  };
}

function normalizeOpenAIUsageHistory(stored: any, now: number): OpenAIUsageHistory {
  if (stored?.version !== 1) return createOpenAIUsageHistory(now);
  const history: OpenAIUsageHistory = {
    ...stored,
    version: 1,
    timeZone: USAGE_TIME_ZONE,
    completeSince: String(stored.completeSince || ''),
    hours: stored.hours && typeof stored.hours === 'object' ? { ...stored.hours } : {},
    days: stored.days && typeof stored.days === 'object' ? { ...stored.days } : {},
    total: stored.total && typeof stored.total === 'object' ? { ...stored.total } : {},
  };
  pruneOpenAIUsageBuckets(history, now);
  return history;
}

function pruneOpenAIUsageBuckets(history: OpenAIUsageHistory, now: number) {
  const oldestHour = Math.floor(now / HOUR_MS) * HOUR_MS - 71 * HOUR_MS;
  const oldestDay = usageDayStart(now) - 399 * DAY_MS;
  for (const key of Object.keys(history.hours)) if (Number(key) < oldestHour) delete history.hours[key];
  for (const key of Object.keys(history.days)) if (Number(key) < oldestDay) delete history.days[key];
}

/**
 * Persist only calls that reached the official OpenAI endpoint. Relays and
 * other providers keep the existing aggregate counters but never enter this
 * ledger, so their tokens cannot be priced as OpenAI usage.
 */
export function recordOpenAIUsage(usage: any, call: {
  provider?: string;
  apiHost?: string;
  model?: string;
  usage?: any;
  at?: number;
} = {}): boolean {
  if (call.provider !== 'openai-compatible') return false;
  if (String(call.apiHost || '').toLowerCase() !== OPENAI_OFFICIAL_HOST) return false;
  const model = String(call.model || '').trim();
  if (!model) return false;
  const at = Number.isFinite(call.at) ? Number(call.at) : Date.now();
  const values = usageBreakdown(call.usage);
  usage.openai = normalizeOpenAIUsageHistory(usage.openai, at);
  const history = usage.openai as OpenAIUsageHistory;
  const bucket = {
    promptTokens: values.promptTokens,
    cachedTokens: values.cachedTokens,
    cacheWriteTokens: values.cacheWriteTokens,
    completionTokens: values.completionTokens,
    requests: 1,
  };
  const hourKey = String(Math.floor(at / HOUR_MS) * HOUR_MS);
  const hour = history.hours[hourKey] || {};
  addOpenAIModelUsage(hour, model, bucket);
  history.hours[hourKey] = hour;
  const dayKey = String(usageDayStart(at));
  const day = history.days[dayKey] || {};
  addOpenAIModelUsage(day, model, bucket);
  history.days[dayKey] = day;
  addOpenAIModelUsage(history.total, model, bucket);
  if (!history.completeSince || at < Date.parse(history.completeSince)) {
    history.completeSince = new Date(at).toISOString();
  }
  pruneOpenAIUsageBuckets(history, at);
  return true;
}

/** One-time import of retained llm-call telemetry for the official endpoint. */
export function initializeOpenAIUsage(
  stored: any,
  events: any[] = [],
  settings: any = {},
  now = Date.now(),
): OpenAIUsageHistory {
  if (stored?.version === 1) return normalizeOpenAIUsageHistory(stored, now);
  const history = createOpenAIUsageHistory(now);
  const configuredHost = apiHostFromUrl(settings?.apiBaseUrl);
  const official = settings?.llmProvider === 'openai-compatible'
    && (!String(settings?.apiBaseUrl || '').trim() || configuredHost === OPENAI_OFFICIAL_HOST);
  if (!official) return history;
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (!event || event.kind !== 'llm-call' || event.accountingExcluded) continue;
    if (event.provider !== 'openai-compatible') continue;
    if (!isOpenAIPricedModel(event.model)) continue;
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at) || at > now) continue;
    const values = {
      promptTokens: nonNegative(event.promptTokens),
      cachedTokens: nonNegative(event.cachedTokens),
      cacheWriteTokens: nonNegative(event.cacheWriteTokens),
      completionTokens: nonNegative(event.completionTokens),
      requests: 1,
    };
    const hourKey = String(Math.floor(at / HOUR_MS) * HOUR_MS);
    const hour = history.hours[hourKey] || {};
    addOpenAIModelUsage(hour, event.model, values);
    history.hours[hourKey] = hour;
    const dayKey = String(usageDayStart(at));
    const day = history.days[dayKey] || {};
    addOpenAIModelUsage(day, event.model, values);
    history.days[dayKey] = day;
    addOpenAIModelUsage(history.total, event.model, values);
    earliest = Math.min(earliest, at);
  }
  if (Number.isFinite(earliest)) {
    history.completeSince = new Date(earliest).toISOString();
    history.backfillSource = 'usageEvents';
  }
  pruneOpenAIUsageBuckets(history, now);
  return history;
}

function sumOpenAIUsageBuckets(models: Record<string, OpenAIUsageBucket>): OpenAIUsageBucket {
  return Object.values(models).reduce(
    (total, bucket) => addedOpenAIUsageBucket(total, bucket),
    emptyOpenAIUsageBucket(),
  );
}

function openAIUsagePeriod(
  history: OpenAIUsageHistory,
  keys: string[],
  source: 'hours' | 'days',
  start: number,
  end: number,
): OpenAIUsagePeriodStats {
  const models: Record<string, OpenAIUsageBucket> = {};
  for (const key of keys) {
    const bucket = history[source]?.[key] || {};
    for (const [model, values] of Object.entries(bucket)) addOpenAIModelUsage(models, model, values);
  }
  const since = history.completeSince ? Date.parse(history.completeSince) : Number.NaN;
  return {
    models,
    totals: sumOpenAIUsageBuckets(models),
    start,
    end,
    partial: !Number.isFinite(since) || since > start,
    availableSince: history.completeSince || '',
  };
}

/** Per-period exact token totals for official OpenAI calls. */
export function buildOpenAIUsageStats(stored: any, now = Date.now()): OpenAIUsageStats {
  const history = normalizeOpenAIUsageHistory(stored, now);
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = usageDayStart(now);
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
  const lastHours = Array.from({ length: 24 }, (_, i) => String(hour - (23 - i) * HOUR_MS));
  const last7Days = Array.from({ length: 7 }, (_, i) => String(day - (6 - i) * DAY_MS));
  const last30Days = Array.from({ length: 30 }, (_, i) => String(day - (29 - i) * DAY_MS));
  const monthDays = Array.from({ length: local.getUTCDate() }, (_, i) => String(monthStart + i * DAY_MS));
  const allModels = Object.fromEntries(
    Object.entries(history.total || {}).map(([model, bucket]) => [model, { ...bucket }]),
  );
  return {
    timeZone: USAGE_TIME_ZONE,
    completeSince: history.completeSince || '',
    backfillSource: history.backfillSource || 'none',
    hourly24: openAIUsagePeriod(history, lastHours, 'hours', hour - 23 * HOUR_MS, now),
    daily7: openAIUsagePeriod(history, last7Days, 'days', day - 6 * DAY_MS, now),
    daily30: openAIUsagePeriod(history, last30Days, 'days', day - 29 * DAY_MS, now),
    month: openAIUsagePeriod(history, monthDays, 'days', monthStart, now),
    all: {
      models: allModels,
      totals: sumOpenAIUsageBuckets(allModels),
      start: 0,
      end: now,
      partial: true,
      availableSince: history.completeSince || '',
    },
  };
}

/** A bounded view from persistent aggregates, independent of the 5,000-row event window. */
export function buildUsageStats(usage: any = {}, events: any[] = [], now = Date.now()) {
  const history = initializeUsageHistory(usage, events, now);
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const day = usageDayStart(now);
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
  const point = (start: number, unit: 'hour' | 'day') => {
    const date = new Date(start + SHANGHAI_OFFSET_MS);
    return {start, end: Math.min(now, start + (unit === 'hour' ? HOUR_MS : DAY_MS)),
      partial: history.hasEarlierUsage && start < Date.parse(history.completeSince),
      label: unit === 'hour' ? `${String(date.getUTCHours()).padStart(2, '0')}:00` : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
      ...addedUsage(undefined, (unit === 'hour' ? history.hours : history.days)[start] || {})};
  };
  const hourly24 = Array.from({length: 24}, (_, i) => point(hour - (23 - i) * HOUR_MS, 'hour'));
  const daily7 = Array.from({length: 7}, (_, i) => point(day - (6 - i) * DAY_MS, 'day'));
  const daily30 = Array.from({length: 30}, (_, i) => point(day - (29 - i) * DAY_MS, 'day'));
  const month = Array.from({length: local.getUTCDate()}, (_, i) => point(monthStart + i * DAY_MS, 'day'));
  const coverage = Object.fromEntries(Object.entries({hourly24, daily7, daily30, month}).map(([key, rows]) => [key, {
    start: rows[0].start, end: now,
    partial: history.hasEarlierUsage && rows[0].start < Date.parse(history.completeSince),
    availableSince: history.completeSince,
  }]));
  return {timeZone: USAGE_TIME_ZONE, generatedAt: now, coverage,
    today: point(day, 'day'), hourly24, daily7, daily30, month,
    cacheMeasuredAll: {
      promptTokens: nonNegative(usage.cacheMeasuredPromptTokens), cachedTokens: nonNegative(usage.cachedTokens),
      cacheWriteTokens: nonNegative(usage.cacheWriteTokens), requests: nonNegative(usage.cacheMeasuredRequests),
      startedAt: String(usage.cacheMetricsStartedAt || ''),
    }};
}
