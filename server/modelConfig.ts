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
  if (String(settings.llmProvider || '') === 'deepseek') return 'deepseek';
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
  const family = modelFamily(model);
  if (model) next.model = model;

  // Codex App Server has its own `codexModel`. Keep the existing API model and
  // credentials untouched as a rollback/fallback profile instead of letting a
  // deepseek- model name silently switch this provider back off.
  if (clean(next.llmProvider) === 'codex-app-server') return next;

  if (family === 'deepseek') {
    next.llmProvider = 'deepseek';
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
    const isDeepSeek = candidate.llmProvider === 'deepseek' || modelFamily(candidate.model) === 'deepseek';
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

  const requestedModel = clean(incoming.model === undefined ? saved.model : incoming.model);
  const requestedFamily = modelFamily(requestedModel) ||
    (incoming.llmProvider === 'deepseek' ? 'deepseek' : null) ||
    providerFamily(saved);
  const suppliedKey = clean(incoming.apiKey);
  const hasNewKey = !keepSecret(incoming.apiKey);
  const suppliedBase = clean(incoming.apiBaseUrl);

  if (requestedFamily === 'deepseek') {
    if (hasNewKey) next.deepseekApiKey = suppliedKey;
    if (suppliedBase) next.deepseekApiBaseUrl = suppliedBase;
  }

  // Unknown custom models keep the explicitly selected provider. Known model
  // families always activate their own complete connection profile.
  if (modelFamily(requestedModel)) return activateModelProfile(next, requestedModel);
  next.apiKey = hasNewKey ? suppliedKey : saved.apiKey;
  return ensureProviderProfiles(next);
}

export function activeProviderLabel(settings: Record<string, any>) {
  if (clean(settings.llmProvider) === 'codex-app-server') return 'ChatGPT / Codex App Server';
  const family = modelFamily(settings.model) || providerFamily(settings);
  return family === 'deepseek' ? 'DeepSeek' : 'OpenAI 兼容接口';
}
