export const usagePeriods = [{ value: 'hourly24', label: '24 小时' }, { value: 'daily7', label: '7 天' }, { value: 'all', label: '总览' }];
export const periodLabels = { hourly24: '近 24 小时', daily7: '近 7 天', all: '历史累计' };
export const formatNumber = value => Number(value || 0).toLocaleString('zh-CN');
export function shortNumber(value) {
  const number = Number(value || 0);
  if (number >= 1e8) return { value: (number / 1e8).toLocaleString('zh-CN', { maximumFractionDigits: 2 }), unit: '亿' };
  if (number >= 1e4) return { value: (number / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 }), unit: '万' };
  return { value: formatNumber(number), unit: '' };
}
export function usageSummary(stats = {}, usage = {}, period = 'hourly24') {
  const points = period === 'all' ? [] : (stats?.[period] || []);
  const keys = ['totalTokens', 'promptTokens', 'completionTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'cacheMeasuredPromptTokens', 'cacheMeasuredRequests', 'requests'];
  const totals = period === 'all' ? (usage || {}) : points.reduce((acc, point) => {
    for (const key of keys) acc[key] = (acc[key] || 0) + Number(point[key] || 0);
    return acc;
  }, {});
  const measured = period === 'all' ? (stats?.cacheMeasuredAll || {}) : totals;
  const denominator = Number(period === 'all' ? measured.promptTokens || 0 : measured.cacheMeasuredPromptTokens || 0);
  const cached = Number(measured.cachedTokens || 0);
  return { points, totals, cached, cacheWrite: Number(measured.cacheWriteTokens || 0), measuredInput: denominator, cacheRate: denominator > 0 ? cached / denominator * 100 : null };
}
export function quotaWindows(limits) {
  const entries = Object.entries(limits?.rateLimitsByLimitId || {});
  const buckets = (entries.length ? entries : limits?.rateLimits ? [[limits.rateLimits.limitId || 'codex', limits.rateLimits]] : [])
    .sort(([left], [right]) => Number(right === 'codex') - Number(left === 'codex') || left.localeCompare(right));
  return buckets.flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap(key => {
    const window = bucket?.[key];
    if (!window) return [];
    const mins = Number(window.windowDurationMins || 0);
    const label = mins === 300 ? '5 小时窗口' : mins === 10080 ? '周额度窗口' : mins > 0 ? `${mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`}窗口` : key === 'primary' ? '主窗口' : '次窗口';
    const used = window.usedPercent == null || !Number.isFinite(Number(window.usedPercent)) ? null : Math.min(100, Math.max(0, Number(window.usedPercent)));
    return [{ key: `${id}:${key}`, bucket: bucket.limitName || id, label, used, resetsAt: window.resetsAt }];
  }));
}
