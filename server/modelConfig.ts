export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

export type ModelFamily = 'deepseek' | 'mimo' | null;

export function looksLikeMimoEndpoint(value: unknown) {
  return /(mimo|xiaomimimo|token-plan-cn)/i.test(String(value || ''));
}

export function looksLikeMimoApiKey(value: unknown) {
  return /^tp-/i.test(String(value || '').trim());
}

export function modelFamily(value: unknown): ModelFamily {
  const model = String(value || '').trim();
  if (/^deepseek-/i.test(model)) return 'deepseek';
  if (/^mimo-/i.test(model)) return 'mimo';
  return null;
}

export function providerFamily(settings: Record<string, any>): ModelFamily {
  if (looksLikeMimoEndpoint(settings.apiBaseUrl)) return 'mimo';
  if (String(settings.llmProvider || '') === 'deepseek') return 'deepseek';
  return modelFamily(settings.model);
}

function clean(value: unknown) {
  return String(value || '').trim();
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
  next.mimoApiKey = isPlaceholder(next.mimoApiKey) ? '' : clean(next.mimoApiKey);
  next.apiKey = isPlaceholder(next.apiKey) ? '' : clean(next.apiKey);
  next.deepseekApiBaseUrl = clean(next.deepseekApiBaseUrl) ||
    (activeFamily === 'deepseek' && activeBase && !looksLikeMimoEndpoint(activeBase) ? activeBase : DEEPSEEK_BASE_URL);
  next.mimoApiBaseUrl = clean(next.mimoApiBaseUrl) ||
    (looksLikeMimoEndpoint(activeBase) ? activeBase : MIMO_BASE_URL);

  // Migrate the legacy single active key into one provider profile. A tp- key
  // is unambiguously Mimo; otherwise the active endpoint/provider owns it.
  if (activeKey) {
    if (looksLikeMimoApiKey(activeKey) && !next.mimoApiKey) next.mimoApiKey = activeKey;
    else if (activeFamily === 'mimo' && !next.mimoApiKey) next.mimoApiKey = activeKey;
    else if (activeFamily === 'deepseek' && !next.deepseekApiKey) next.deepseekApiKey = activeKey;
  }
  return next;
}

export function activateModelProfile(settings: Record<string, any>, requestedModel?: unknown) {
  const next = ensureProviderProfiles(settings);
  const model = clean(requestedModel === undefined ? next.model : requestedModel);
  const family = modelFamily(model);
  if (model) next.model = model;

  if (family === 'mimo') {
    next.llmProvider = 'openai-compatible';
    next.apiBaseUrl = next.mimoApiBaseUrl || MIMO_BASE_URL;
    next.apiKey = next.mimoApiKey || '';
  } else if (family === 'deepseek') {
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
    const family = looksLikeMimoApiKey(key)
      ? 'mimo'
      : (looksLikeMimoEndpoint(candidate.apiBaseUrl) || modelFamily(candidate.model) === 'mimo')
        ? 'mimo'
        : (candidate.llmProvider === 'deepseek' || modelFamily(candidate.model) === 'deepseek')
          ? 'deepseek'
          : null;
    if (family === 'mimo' && !next.mimoApiKey) {
      next.mimoApiKey = key;
      if (looksLikeMimoEndpoint(candidate.apiBaseUrl)) next.mimoApiBaseUrl = clean(candidate.apiBaseUrl);
    }
    if (family === 'deepseek' && !looksLikeMimoApiKey(key) && !next.deepseekApiKey) {
      next.deepseekApiKey = key;
      if (candidate.apiBaseUrl && !looksLikeMimoEndpoint(candidate.apiBaseUrl)) {
        next.deepseekApiBaseUrl = clean(candidate.apiBaseUrl);
      }
    }
    if (next.mimoApiKey && next.deepseekApiKey) break;
  }
  return activateModelProfile(next, settings.model);
}

export function updateProviderSettings(current: Record<string, any>, incoming: Record<string, any>) {
  const saved = ensureProviderProfiles(current);
  const next = { ...saved, ...incoming };
  const keepSecret = (value: unknown) => !clean(value) || isPlaceholder(value);
  if (keepSecret(incoming.deepseekApiKey)) next.deepseekApiKey = saved.deepseekApiKey;
  if (keepSecret(incoming.mimoApiKey)) next.mimoApiKey = saved.mimoApiKey;
  const requestedModel = clean(incoming.model === undefined ? saved.model : incoming.model);
  const requestedFamily = modelFamily(requestedModel) ||
    (looksLikeMimoEndpoint(incoming.apiBaseUrl) ? 'mimo' : null) ||
    (incoming.llmProvider === 'deepseek' ? 'deepseek' : null) ||
    providerFamily(saved);
  const suppliedKey = clean(incoming.apiKey);
  const hasNewKey = !keepSecret(incoming.apiKey);
  const suppliedBase = clean(incoming.apiBaseUrl);

  if (requestedFamily === 'mimo') {
    if (hasNewKey) next.mimoApiKey = suppliedKey;
    if (suppliedBase && looksLikeMimoEndpoint(suppliedBase)) next.mimoApiBaseUrl = suppliedBase;
  } else if (requestedFamily === 'deepseek') {
    if (hasNewKey) next.deepseekApiKey = suppliedKey;
    if (suppliedBase && !looksLikeMimoEndpoint(suppliedBase)) next.deepseekApiBaseUrl = suppliedBase;
  }

  // Unknown custom models keep the explicitly selected provider. Known model
  // families always activate their own complete connection profile.
  if (modelFamily(requestedModel)) return activateModelProfile(next, requestedModel);
  next.apiKey = hasNewKey ? suppliedKey : saved.apiKey;
  return ensureProviderProfiles(next);
}

export function activeProviderLabel(settings: Record<string, any>) {
  const family = modelFamily(settings.model) || providerFamily(settings);
  return family === 'mimo' ? 'Mimo / OpenAI 兼容接口' : 'DeepSeek';
}
