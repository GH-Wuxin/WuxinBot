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
    totalTokens: nonNegative(usage?.total_tokens),
    promptTokens: nonNegative(usage?.prompt_tokens ?? usage?.input_tokens),
    cachedTokens: nonNegative(
      usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.cache_read_input_tokens
      ?? usage?.prompt_cache_hit_tokens,
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
