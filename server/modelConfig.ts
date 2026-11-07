export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_FLASH_VISION_MODEL = 'deepseek-v4-flash-vision-exp';
export type ModelFamily = 'deepseek' | null;

/**
 * Keep the stable Wuxin-facing Flash id while routing it to DeepSeek's
 * image-capable experimental endpoint on the wire.
 */
export function resolveDeepSeekWireModel(value: unknown) {
  const model = String(value || '').trim();
  // 线上设置里同时存在 deepseek-flash 和 deepseek-v4-flash 两种写法，
  // 只要指向同一档 Flash 就都映射到视觉端点，否则能力判断会一半真一半假。
  const isFlashAlias = model === DEEPSEEK_FLASH_MODEL
    || model === 'deepseek-flash'
    || model === 'deepseek_flash';
  return isFlashAlias ? DEEPSEEK_FLASH_VISION_MODEL : model;
}

export function isDeepSeekVisionModel(value: unknown) {
  return resolveDeepSeekWireModel(value) === DEEPSEEK_FLASH_VISION_MODEL;
}

export function modelFamily(value: unknown): ModelFamily {
  const model = String(value || '').trim();
  if (/^deepseek-/i.test(model)) return 'deepseek';
  return null;
}

export function providerFamily(settings: Record<string, any>): ModelFamily {
  const provider = String(settings.llmProvider || '').trim();
  if (provider === 'deepseek') return 'deepseek';
  // An explicit non-DeepSeek provider owns the connection even when the
  // upstream exposes model ids that start with "deepseek-".
  if (provider === 'openai-compatible' || provider === 'codex-app-server') return null;
  return modelFamily(settings.model);
}

function clean(value: unknown) {
  return String(value || '').trim();
}

/**
 * Return the model that the active transport will actually request.
 *
 * `settings.model` is intentionally kept as the API/fallback profile while
 * Codex App Server is active, so it must not be used as the runtime model
 * identity in prompts, telemetry, commands, or the dashboard.
 */
export function activeModelName(settings: Record<string, any>) {
  if (clean(settings.llmProvider) === 'codex-app-server') {
    return clean(settings.codexModel) || 'gpt-5.6-luna';
  }
  return clean(settings.model) || '未设置';
}

function isPlaceholder(value: unknown) {
  const v = clean(value);
  return v === '已填写' || v === '已设置';
}

export function ensureProviderProfiles(settings: Record<string, any>) {
  const next = { ...settings };
  const activeFamily = providerFamily(next);
  const activeKey = isPlaceholder(next.apiKey) ? '' : clean(next.apiKey);
  const activeBase = clean(next.apiBaseUrl);

  next.deepseekApiKey = isPlaceholder(next.deepseekApiKey) ? '' : clean(next.deepseekApiKey);
  next.apiKey = isPlaceholder(next.apiKey) ? '' : clean(next.apiKey);
  next.deepseekApiBaseUrl = clean(next.deepseekApiBaseUrl) ||
    (activeFamily === 'deepseek' && activeBase ? activeBase : DEEPSEEK_BASE_URL);

  // 把旧的单一 key 迁移到 DeepSeek 档案里（Mimo 已移除，不再有第二个档案）。
  if (activeKey && activeFamily === 'deepseek' && !next.deepseekApiKey) next.deepseekApiKey = activeKey;
  return next;
}

export function activateModelProfile(settings: Record<string, any>, requestedModel?: unknown) {
  const next = ensureProviderProfiles(settings);
  const model = clean(requestedModel === undefined ? next.model : requestedModel);
  if (model) next.model = model;

  const provider = clean(next.llmProvider) || 'deepseek';
  next.llmProvider = provider;

  // Codex App Server has its own `codexModel`. Keep the existing API model and
  // credentials untouched as a rollback/fallback profile instead of letting a
  // deepseek- model name silently switch this provider back off.
  if (provider === 'codex-app-server') return next;

  // Only an explicit DeepSeek provider uses the DeepSeek profile. Third-party
  // OpenAI-compatible endpoints may expose the same "deepseek-*" model ids;
  // the chosen provider must win over the model-name prefix.
  if (provider === 'deepseek') {
    next.apiBaseUrl = next.deepseekApiBaseUrl || DEEPSEEK_BASE_URL;
    next.apiKey = next.deepseekApiKey || '';
  }
  return next;
}

export function recoverProviderProfiles(settings: Record<string, any>, snapshots: any[] = []) {
  const next = ensureProviderProfiles(settings);
  for (const snapshot of [...snapshots].reverse()) {
    const candidate = snapshot?.settings || snapshot || {};
    const key = clean(candidate.apiKey);
    if (!key || isPlaceholder(key)) continue;
    const isDeepSeek = candidate.llmProvider === 'deepseek'
      || (!candidate.llmProvider && modelFamily(candidate.model) === 'deepseek');
    if (isDeepSeek && !next.deepseekApiKey) {
      next.deepseekApiKey = key;
      if (candidate.apiBaseUrl) next.deepseekApiBaseUrl = clean(candidate.apiBaseUrl);
    }
    if (next.deepseekApiKey) break;
  }
  return activateModelProfile(next, settings.model);
}

export function updateProviderSettings(current: Record<string, any>, incoming: Record<string, any>) {
  const saved = ensureProviderProfiles(current);
  const next = { ...saved, ...incoming };
  const keepSecret = (value: unknown) => !clean(value) || isPlaceholder(value);
  if (keepSecret(incoming.deepseekApiKey)) next.deepseekApiKey = saved.deepseekApiKey;

  if (clean(incoming.llmProvider) === 'codex-app-server') {
    if (clean(saved.llmProvider) !== 'codex-app-server') {
      next.codexFallbackProvider = clean(saved.llmProvider) || 'deepseek';
      next.codexFallbackModel = clean(saved.model) || 'deepseek-v4-flash';
    }
    next.llmProvider = 'codex-app-server';
    // API fields remain the last working fallback profile and are never
    // replaced by the browser's secret placeholders.
    next.apiKey = saved.apiKey;
    next.apiBaseUrl = saved.apiBaseUrl;
    next.model = saved.model;
    return ensureProviderProfiles(next);
  }

  const requestedProvider = clean(incoming.llmProvider) || clean(saved.llmProvider) || 'deepseek';
  next.llmProvider = requestedProvider;
  const requestedModel = clean(incoming.model === undefined ? saved.model : incoming.model);
  const requestedFamily = requestedProvider === 'deepseek' ? 'deepseek' : null;
  const suppliedKey = clean(incoming.apiKey);
  const hasNewKey = !keepSecret(incoming.apiKey);
  const suppliedBase = clean(incoming.apiBaseUrl);

  if (requestedFamily === 'deepseek') {
    if (hasNewKey) next.deepseekApiKey = suppliedKey;
    if (suppliedBase) next.deepseekApiBaseUrl = suppliedBase;
  } else {
    next.apiKey = hasNewKey ? suppliedKey : saved.apiKey;
  }

  // The chosen provider is authoritative. Model ids are opaque strings from
  // the upstream and must not switch the connection profile by prefix.
  return activateModelProfile(next, requestedModel);
}

export function activeProviderLabel(settings: Record<string, any>) {
  const provider = clean(settings.llmProvider);
  if (provider === 'codex-app-server') return 'ChatGPT / Codex App Server';
  if (provider === 'openai-compatible') return 'OpenAI 兼容接口';
  return providerFamily(settings) === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容接口';
}
