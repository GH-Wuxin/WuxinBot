import crypto from 'node:crypto';
/** Effective limits only; saved normal-mode settings are never overwritten. */
export const tokenSaving = (db: any) => db?.settings?.tokenSavingMode === true;
export const SAVING_PROFILE_INTERVAL_MS = 6 * 3600_000;

export function savingMemoryThresholds(db: any, thresholds: { minMessages: number; updateEvery: number; maxSamples: number }) {
  return tokenSaving(db) ? { minMessages: Math.max(30, thresholds.minMessages * 3),
    updateEvery: Math.max(120, thresholds.updateEvery * 4), maxSamples: Math.min(16, thresholds.maxSamples) } : thresholds;
}

export function savingMemoryDue(db: any, memory: any, thresholds: { minMessages: number; updateEvery: number }, hasProfile: boolean, now = Date.now()) {
  if (!tokenSaving(db)) return true;
  const last = Math.max(Date.parse(memory?.lastProfileAttemptAt || '') || 0, Date.parse(memory?.lastProfiledAt || '') || 0);
  return Number(memory?.profileMessageCount || 0) >= thresholds.minMessages
    && Number(memory?.pendingCount || 0) >= (hasProfile ? thresholds.updateEvery : thresholds.minMessages)
    && now - last >= SAVING_PROFILE_INTERVAL_MS;
}

export function automaticProfileInterval(db: any) { return tokenSaving(db) ? SAVING_PROFILE_INTERVAL_MS : 30 * 60_000; }
export function groupProfileThreshold(db: any) {
  const normal = Math.max(1, Number(db.settings.groupProfileThreshold || 80));
  return tokenSaving(db) ? Math.max(200, normal * 4) : normal;
}
export function pairProfileThreshold(db: any) { return tokenSaving(db) ? 100 : 25; }

/** Called inside updateDb to claim one attempt, including failed/skipped ones. */
export function claimProfileAttempt(db: any, key: string, lastSuccess = '', now = Date.now()) {
  const attempts = db.profileAutoAttempts || {};
  const last = Math.max(Date.parse(attempts[key] || '') || 0, tokenSaving(db) ? Date.parse(lastSuccess || '') || 0 : 0);
  if (now - last < automaticProfileInterval(db)) return false;
  db.profileAutoAttempts ??= {};
  db.profileAutoAttempts[key] = new Date(now).toISOString();
  const old = Object.entries(db.profileAutoAttempts).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(2000);
  for (const [id] of old) delete db.profileAutoAttempts[id];
  return true;
}

export function savingLlmOptions(db: any, options: any) {
  if (!tokenSaving(db)) return options;
  const thinking = options.thinking && options.thinking.type !== 'disabled';
  const cap = Number(options.completionBudget || (thinking ? 2048 : options.maxTokens || db.settings.maxTokens || 420));
  return { ...options, requestMaxRetries: 0, retryOnEmpty: false,
    ...(db.settings.llmProvider === 'codex-app-server' ? {} : { completionBudget: Math.min(2048, Math.max(128, cap)) }),
    ...(['high', 'max'].includes(options.reasoning_effort) ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' } : {}),
    codexReasoningEffort: 'low' };
}

const unavailable = new Map<string, number>();
const accountKey = (db: any) => crypto.createHash('sha256').update(JSON.stringify([
  db.settings.llmProvider, db.settings.apiBaseUrl, db.settings.apiKey,
  db.settings.deepseekApiBaseUrl, db.settings.deepseekApiKey,
])).digest('hex');
export function assertSavingApiAvailable(db: any, now = Date.now()) {
  if (!tokenSaving(db)) return;
  const key = accountKey(db), until = unavailable.get(key) || 0;
  if (now < until) throw new Error('API 余额或认证不可用，节能模式已暂停该通道的重复调用 10 分钟');
  unavailable.delete(key);
}
export function recordSavingApiFailure(db: any, error: any, now = Date.now()) {
  if (!tokenSaving(db)) return;
  // Transport status / provider codes only; never infer quota from chat text.
  if (![401, 402, 403].includes(Number(error?.status)) && !['insufficient_quota', 'insufficient_balance'].includes(error?.code)) return;
  unavailable.set(accountKey(db), now + 10 * 60_000);
  if (unavailable.size > 20) unavailable.delete(unavailable.keys().next().value!);
}
