// Provider-neutral LLM client layer.
// DeepSeek is the default provider today, but the rest of the bot should call
// this module instead of depending on DeepSeek-specific names.
import OpenAI from 'openai';
import { recordLlmSuccess, recordLlmError } from '../health.js';

export function llmProvider(db) {
  return String(db.settings.llmProvider || 'deepseek').trim() || 'deepseek';
}

export function defaultBaseUrlForProvider(provider) {
  if (provider === 'deepseek') return 'https://api.deepseek.com';
  return '';
}

export function llmProviderName(provider) {
  const names = {
    deepseek: 'DeepSeek',
    'openai-compatible': 'OpenAI-compatible'
  };
  return names[provider] || provider || 'LLM';
}

export function supportsProviderSearch(provider) {
  // DeepSeek's official chat-completion API is OpenAI-compatible but does not
  // currently document a built-in web-search parameter. Keep this false until a
  // real search adapter (SearXNG/Brave/Bing/etc.) is wired in; otherwise the bot
  // may look like it searched while the model is only guessing.
  return false;
}

export function mergeUsage(...items) {
  return items.reduce((total, item) => ({
    total_tokens: (total.total_tokens || 0) + (item?.total_tokens || 0),
    prompt_tokens: (total.prompt_tokens || 0) + (item?.prompt_tokens || 0),
    completion_tokens: (total.completion_tokens || 0) + (item?.completion_tokens || 0)
  }), { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 });
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${Math.round(ms / 1000)} 秒`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createLLMClient(db) {
  const provider = llmProvider(db);
  const apiKey = db.settings.apiKey;
  if (!apiKey) {
    throw new Error(`${llmProviderName(provider)} API Key 还没有填写，请先在 GUI 的“模型设置”里填写。`);
  }
  const baseURL = db.settings.apiBaseUrl || defaultBaseUrlForProvider(provider);
  return {
    provider,
    client: new OpenAI({
      apiKey,
      baseURL: baseURL || undefined
    })
  };
}

export async function completeChat(db, options = {}) {
  const { provider, client } = createLLMClient(db);
  const started = Date.now();
  const searchMode = options.searchMode;
  const params = {
    model: options.model || options.overrideModel || db.settings.model || 'deepseek-chat',
    messages: options.messages || [],
    temperature: Number(options.temperature ?? db.settings.temperature ?? 0.85),
    max_tokens: Number(options.maxTokens || db.settings.maxTokens || 420)
  };

  if (searchMode && supportsProviderSearch(provider)) {
    params.enable_search = true;
    params.search_mode = searchMode;
  }

  const runCompletion = async (nextParams) => {
    const response = await withTimeout(
      client.chat.completions.create(nextParams),
      Number(options.timeoutMs || 45_000),
      options.label || `${llmProviderName(provider)} 调用`
    );
    return {
      text: response.choices?.[0]?.message?.content?.trim() || '',
      usage: response.usage || {},
      raw: response
    };
  };

  const retryAfterEmpty = async (first) => {
    if (first.text) return first;
    const retryParams = { ...params };
    if (searchMode && supportsProviderSearch(provider)) {
      delete retryParams.enable_search;
      delete retryParams.search_mode;
    }
    const second = await runCompletion(retryParams);
    return {
      text: second.text,
      usage: mergeUsage(first.usage, second.usage),
      raw: second.raw
    };
  };

  try {
    const result = await retryAfterEmpty(await runCompletion(params));
    recordLlmSuccess(Date.now() - started);
    return {
      ...result,
      provider,
      model: params.model,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    recordLlmError(String(error?.message || error?.code || ''));
    const status = Number(error?.status || 0);
    const message = String(error?.message || error?.code || '');
    if (
      searchMode &&
      supportsProviderSearch(provider) &&
      status === 400 &&
      (message.includes('enable_search') || message.includes('search'))
    ) {
      delete params.enable_search;
      delete params.search_mode;
      const result = await retryAfterEmpty(await runCompletion(params));
      return {
        ...result,
        provider,
        model: params.model,
        latencyMs: Date.now() - started
      };
    }
    throw error;
  }
}

export async function callLLM(db, messages, searchMode, options = {}) {
  return completeChat(db, {
    ...options,
    messages,
    searchMode,
    model: options.overrideModel || db.settings.model || 'deepseek-chat'
  });
}

export const callDeepSeek = callLLM;
