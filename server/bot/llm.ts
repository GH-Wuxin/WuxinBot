// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
// Provider-neutral LLM client layer.
// DeepSeek is the default provider today, but the rest of the bot should call
// this module instead of depending on DeepSeek-specific names.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { recordLlmSuccess, recordLlmError } from '../health.js';
import { completeCodexAppServerChat } from '../codexAppServer.js';
import { mergeLlmUsage } from '../usage.js';
import {
  currentRequestTraceId,
  extractProviderResponseTrace,
  traceEvent,
  traceModelStream,
} from '../requestTrace.js';
import {
  activateModelProfile,
  DEEPSEEK_BASE_URL,
  isDeepSeekVisionModel,
  looksLikeMimoApiKey,
  looksLikeMimoEndpoint,
  resolveDeepSeekWireModel
} from '../modelConfig.js';

export { looksLikeMimoApiKey, looksLikeMimoEndpoint } from '../modelConfig.js';

export interface LlmCompletionMeta {
  finishReason: string | null;
  reasoningTokens: number;
  completionTokens: number;
  totalTokens: number;
  contentEmpty: boolean;
  hadToolCalls: boolean;
  model: string;
  provider: string;
  latencyMs: number;
}

/** Pure policy helper so the empty-response retry contract is regression-testable. */
export function buildEmptyReplyRetryParams(
  params: Record<string, any>,
  options: { retainToolsOnEmpty?: boolean; removeProviderSearch?: boolean } = {},
): Record<string, any> {
  const retryParams = { ...params };
  if (options.removeProviderSearch) {
    delete retryParams.enable_search;
    delete retryParams.search_mode;
  }
  if (!options.retainToolsOnEmpty && retryParams.tools) {
    delete retryParams.tools;
    delete retryParams.tool_choice;
  }
  return retryParams;
}

/**
 * Normalize completion metadata from a raw chat-completion response. Safe for
 * missing fields (non-DeepSeek providers, mocks, partial payloads): numbers
 * degrade to 0, finishReason to null, booleans to false. contentEmpty uses
 * the same rule as the existing empty-reply check (trimmed content empty).
 */
export function buildLlmCompletionMeta(raw, base) {
  const choice = raw?.choices?.[0];
  const message = choice?.message;
  const usage = raw?.usage;
  const content = String(message?.content ?? '');
  const toNonNegative = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    reasoningTokens: toNonNegative(usage?.completion_tokens_details?.reasoning_tokens),
    completionTokens: toNonNegative(usage?.completion_tokens),
    totalTokens: toNonNegative(usage?.total_tokens),
    contentEmpty: content.trim().length === 0,
    hadToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
    model: String(base?.model ?? ''),
    provider: String(base?.provider ?? ''),
    latencyMs: Number.isFinite(Number(base?.latencyMs)) ? Number(base.latencyMs) : 0,
  };
}

/**
 * Reasoning budget exhaustion: thinking consumed the whole max_tokens budget,
 * so the model returned empty content and no tool calls. This must NOT fall
 * into the ordinary empty-reply retry (which drops tools); a thinking-aware
 * retry should raise max_tokens and keep thinking+tools.
 */
export function isReasoningBudgetExhaustion(meta) {
  return Boolean(
    meta &&
    meta.finishReason === 'length' &&
    meta.reasoningTokens > 0 &&
    meta.contentEmpty &&
    !meta.hadToolCalls,
  );
}

/**
 * Translate a ReasoningLevel into DeepSeek wire params. OFF disables thinking
 * and never sends reasoning_effort; HIGH/MAX enable thinking with the matching
 * effort level. `enabled=false` (kill switch) always produces the OFF shape.
 */
export function thinkingParamsForLevel(level, enabled = true) {
  if (!enabled || level === 'off') return { thinking: { type: 'disabled' } };
  if (level === 'max') return { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
  return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
}

export async function collectChatCompletionStream(stream, fallbackModel = '', onProgress = undefined) {
  const message = { role: 'assistant', content: '', tool_calls: [] };
  let reasoningContent = '';
  let finishReason = null;
  let usage;
  let id = '';
  let created;
  let model = fallbackModel;
  let systemFingerprint;

  for await (const chunk of stream) {
    id = chunk?.id || id;
    created = chunk?.created ?? created;
    model = chunk?.model || model;
    systemFingerprint = chunk?.system_fingerprint ?? systemFingerprint;
    usage = chunk?.usage || usage;
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.role === 'string') message.role = delta.role;
    if (typeof delta.content === 'string') message.content += delta.content;
    const reasoningDelta = ['reasoning_content', 'reasoning', 'thinking']
      .map((key) => typeof delta?.[key] === 'string' ? delta[key] : '')
      .find(Boolean) || '';
    reasoningContent += reasoningDelta;
    for (const [position, callDelta] of (delta.tool_calls || []).entries()) {
      const index = Number.isInteger(callDelta?.index) ? callDelta.index : position;
      const call = message.tool_calls[index] || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (typeof callDelta?.id === 'string') call.id = callDelta.id;
      if (typeof callDelta?.type === 'string') call.type = callDelta.type;
      if (typeof callDelta?.function?.name === 'string') call.function.name += callDelta.function.name;
      if (typeof callDelta?.function?.arguments === 'string') call.function.arguments += callDelta.function.arguments;
      message.tool_calls[index] = call;
    }
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    if (onProgress && (reasoningDelta || delta.content || delta.tool_calls?.length)) {
      onProgress({
        content: message.content,
        reasoning: reasoningContent,
        reasoningExposed: Boolean(reasoningContent),
        toolCallsPending: message.tool_calls.length,
      });
    }
  }

  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (message.tool_calls.length === 0) message.tool_calls = null;
  return {
    id,
    object: 'chat.completion',
    ...(created != null ? { created } : {}),
    model,
    ...(systemFingerprint != null ? { system_fingerprint: systemFingerprint } : {}),
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function llmProvider(db) {
  const provider = String(db.settings.llmProvider || 'deepseek').trim() || 'deepseek';
  const baseUrl = String(db.settings.apiBaseUrl || '').trim();
  if (provider === 'deepseek' && looksLikeMimoEndpoint(baseUrl)) return 'openai-compatible';
  return provider;
}

export function defaultBaseUrlForProvider(provider) {
  if (provider === 'deepseek') return DEEPSEEK_BASE_URL;
  return '';
}

export function llmProviderName(provider) {
  const names = {
    deepseek: 'DeepSeek',
    'openai-compatible': 'OpenAI-compatible',
    'codex-app-server': 'ChatGPT / Codex'
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

function rawLlmProvider(db) {
  return String(db.settings.llmProvider || 'deepseek').trim() || 'deepseek';
}

function assertLlmConfigCompatible(db, provider, baseURL, apiKey) {
  const rawProvider = rawLlmProvider(db);
  const base = String(baseURL || '').trim();
  const key = String(apiKey || '').trim();
  if (rawProvider === 'deepseek' && !looksLikeMimoEndpoint(base) && looksLikeMimoApiKey(key)) {
    throw new Error('LLM 配置错配：当前供应商/地址是 DeepSeek，但 API Key 看起来是 Mimo 的 tp- 开头密钥。请在模型设置里把供应商切到 OpenAI 兼容接口，并填写 Mimo API 地址。');
  }
  if (provider === 'deepseek' && looksLikeMimoEndpoint(base)) {
    throw new Error('LLM 配置错配：API 地址是 Mimo，但供应商仍是 DeepSeek。请保存为 OpenAI 兼容接口。');
  }
}

function requestModelForProvider(db, provider, baseURL, options = {}) {
  const fallback = provider === 'deepseek' ? 'deepseek-chat' : 'mimo-v2.5';
  const model = String(options.model || options.overrideModel || db.settings.model || fallback).trim() || fallback;
  if (provider === 'openai-compatible' && looksLikeMimoEndpoint(baseURL) && /^deepseek-/i.test(model)) {
    throw new Error(`LLM 配置错配：Mimo API 地址不能使用 DeepSeek 模型名 ${model}。请把模型切到 mimo-v2.5 或 mimo-v2.5-pro。`);
  }
  if (provider === 'deepseek' && /^mimo-/i.test(model)) {
    throw new Error(`LLM 配置错配：DeepSeek 供应商不能使用 Mimo 模型名 ${model}。请切换供应商或模型。`);
  }
  return provider === 'deepseek' ? resolveDeepSeekWireModel(model) : model;
}

export function mergeUsage(...items) {
  return mergeLlmUsage(...items);
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${Math.round(ms / 1000)} 秒`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toWellFormedText(value) {
  const text = String(value ?? '');
  if (typeof text.toWellFormed === 'function') return text.toWellFormed();
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      output += '\uFFFD';
    } else {
      output += text[index];
    }
  }
  return output;
}

export function normalizeLlmMessages(messages = []) {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
          if (!part || typeof part !== 'object') return part;
          if (part.type === 'text') return { ...part, text: toWellFormedText(part.text) };
          if (part.type === 'image_url' && part.image_url) {
            return { ...part, image_url: { ...part.image_url, url: toWellFormedText(part.image_url.url) } };
          }
          return part;
        })
      : toWellFormedText(message.content),
    // DeepSeek thinking assistant messages with tool_calls must carry their
    // reasoning_content into the following tool-result round. Explicitly
    // preserve it rather than relying on the spread above.
    ...(typeof message.reasoning_content === 'string'
      ? { reasoning_content: toWellFormedText(message.reasoning_content) }
      : {})
  }));
}

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
};

function imageMimeFromRef(ref, fallback = 'image/jpeg') {
  try {
    const pathname = ref.startsWith('http') ? new URL(ref).pathname : ref;
    return IMAGE_MIME_BY_EXT[path.extname(pathname).toLowerCase()] || fallback;
  } catch {
    return fallback;
  }
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  return Boolean(match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31);
}

function isProbablyLocalUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    return isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeLocalPath(ref) {
  const value = String(ref || '').trim();
  if (!value) return '';
  if (value.startsWith('file://')) return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value;
  return '';
}

async function bufferToDataUrl(buffer, mime, maxBytes) {
  if (!buffer?.length) throw new Error('图片为空');
  if (buffer.length > maxBytes) {
    throw new Error(`图片过大 ${Math.round(buffer.length / 1024 / 1024)}MB，超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  }
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function fetchImageAsDataUrl(url, timeoutMs, maxBytes) {
  const response = await withTimeout(fetch(url), timeoutMs, '图片下载');
  if (!response.ok) throw new Error(`图片下载失败 ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';')[0] || imageMimeFromRef(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return bufferToDataUrl(bytes, mime, maxBytes);
}

async function localImageAsDataUrl(file, maxBytes) {
  const filePath = normalizeLocalPath(file);
  if (!filePath) throw new Error('不是可读取的本地图片路径');
  const bytes = await fs.readFile(filePath);
  return bufferToDataUrl(bytes, imageMimeFromRef(filePath), maxBytes);
}

async function resolveVisionImageUrl(db, image, options = {}) {
  const transport = String(db.settings.visionImageTransport || 'auto').toLowerCase();
  const maxBytes = Math.max(256_000, Math.min(20_000_000, Number(db.settings.visionMaxImageBytes || 6_000_000)));
  const timeoutMs = Math.max(1000, Math.min(30_000, Number(db.settings.visionImageTimeoutMs || options.timeoutMs || 8000)));
  const url = String(image?.url || '').trim();
  const file = String(image?.file || '').trim();

  if (transport === 'url' && url) return url;
  if (transport === 'data') {
    if (url) return fetchImageAsDataUrl(url, timeoutMs, maxBytes);
    if (file) return localImageAsDataUrl(file, maxBytes);
  }
  if (url) {
    if (url.startsWith('data:')) return url;
    if (!isProbablyLocalUrl(url)) return url;
    return fetchImageAsDataUrl(url, timeoutMs, maxBytes);
  }
  if (file) return localImageAsDataUrl(file, maxBytes);
  throw new Error('图片缺少 url/file');
}

async function attachVisionImages(db, messages, images = [], options = {}) {
  if (!images?.length) return messages;
  const provider = llmProvider(db);
  const requestedModel = options.model || options.overrideModel || db.settings.model;
  if (provider === 'deepseek' && !isDeepSeekVisionModel(requestedModel)) return messages;
  const maxImages = Math.max(1, Math.min(6, Number(db.settings.visionMaxImages || 3)));
  const usable = [];
  const errors = [];
  for (const image of images.slice(0, maxImages)) {
    try {
      const url = await resolveVisionImageUrl(db, image, options);
      usable.push({ type: 'image_url', image_url: { url } });
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  if (!usable.length) {
    if (!errors.length) return messages;
  }
  const next = [...messages];
  const lastIndex = next.map((message) => message.role).lastIndexOf('user');
  if (lastIndex < 0) return messages;
  const last = next[lastIndex];
  const text = Array.isArray(last.content)
    ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : String(last.content || '');
  const note = usable.length
    ? `\n\n【视觉输入】本轮已附带 ${usable.length} 张图片。请只基于实际附带图片回答；如果图片不可读，明确说明。`
    : `\n\n【视觉输入】收到图片占位符，但图片传输失败：${errors.slice(0, 2).join('；')}。不能编造图片内容。`;
  next[lastIndex] = {
    ...last,
    content: [{ type: 'text', text: text + note }, ...usable]
  };
  return next;
}

export function createLLMClient(db, requestedModel = db.settings.model) {
  if (!/^mimo-/i.test(String(requestedModel || ''))) {
    const rawProvider = llmProvider(db);
    const rawBaseUrl = db.settings.apiBaseUrl || defaultBaseUrlForProvider(rawProvider);
    assertLlmConfigCompatible(db, rawProvider, rawBaseUrl, db.settings.apiKey);
  }
  const resolvedSettings = activateModelProfile(db.settings, requestedModel);
  const resolvedDb = { ...db, settings: resolvedSettings };
  const provider = llmProvider(resolvedDb);
  const apiKey = resolvedSettings.apiKey;
  if (!apiKey) {
    throw new Error(`${llmProviderName(provider)} API Key 还没有填写，请先在 GUI 的“模型设置”里填写。`);
  }
  const baseURL = resolvedSettings.apiBaseUrl || defaultBaseUrlForProvider(provider);
  assertLlmConfigCompatible(resolvedDb, provider, baseURL, apiKey);
  return {
    provider,
    baseURL,
    settings: resolvedSettings,
    client: new OpenAI({
      apiKey,
      baseURL: baseURL || undefined
    })
  };
}

export async function completeChat(db, options = {}) {
  if (rawLlmProvider(db) === 'codex-app-server') {
    const invocationId = crypto.randomUUID();
    const started = Date.now();
    const model = String(db.settings.codexModel || 'gpt-5.6-luna').trim() || 'gpt-5.6-luna';
    traceEvent('MODEL', 'model_call_started', {
      status: 'running',
      invocationId,
      attempt: 1,
      role: options.traceRole || 'assistant',
      purpose: options.tracePurpose || options.label || 'Codex App Server 调用',
      provider: 'codex-app-server',
      model,
      messageCount: options.messages?.length || 0,
      toolCount: options.tools?.length || 0,
      streaming: false,
      thinkingEnabled: db.settings.codexReasoningEffort !== 'low',
    });
    try {
      const codexMessages = normalizeLlmMessages(
        await attachVisionImages(db, options.messages || [], options.visionImages || [], options)
      );
      const result = await completeCodexAppServerChat(db, { ...options, messages: codexMessages });
      const latencyMs = Date.now() - started;
      recordLlmSuccess(latencyMs);
      traceEvent('MODEL', 'model_call_completed', {
        status: 'ok',
        durationMs: latencyMs,
        invocationId,
        attempt: 1,
        role: options.traceRole || 'assistant',
        purpose: options.tracePurpose || options.label || 'Codex App Server 调用',
        provider: 'codex-app-server',
        model: result.model,
        streaming: false,
        response: extractProviderResponseTrace(result.raw),
      });
      return {
        ...result,
        meta: buildLlmCompletionMeta(result.raw, {
          model: result.model,
          provider: result.provider,
          latencyMs,
        }),
      };
    } catch (error) {
      const message = String(error?.message || error?.code || error);
      recordLlmError(message);
      traceEvent('MODEL', 'model_call_failed', {
        status: 'error',
        durationMs: Date.now() - started,
        invocationId,
        attempt: 1,
        role: options.traceRole || 'assistant',
        purpose: options.tracePurpose || options.label || 'Codex App Server 调用',
        provider: 'codex-app-server',
        model,
        error: message,
      });
      if (db.settings.codexFallbackEnabled === false || options.codexFallbackAttempt) throw error;
      const fallbackProvider = ['deepseek', 'openai-compatible'].includes(String(db.settings.codexFallbackProvider))
        ? String(db.settings.codexFallbackProvider)
        : 'deepseek';
      const fallbackModel = String(db.settings.codexFallbackModel || db.settings.model || 'deepseek-v4-flash').trim();
      const fallbackSettings = activateModelProfile({
        ...db.settings,
        llmProvider: fallbackProvider,
      }, fallbackModel);
      try {
        const fallback = await completeChat({ ...db, settings: fallbackSettings }, {
          ...options,
          model: fallbackModel,
          overrideModel: fallbackModel,
          codexFallbackAttempt: true,
        });
        return {
          ...fallback,
          fallbackFrom: 'codex-app-server',
          fallbackReason: message.slice(0, 300),
        };
      } catch (fallbackError) {
        throw new Error(`Codex 调用失败：${message}；旧供应商自动降级也失败：${String(fallbackError?.message || fallbackError)}`);
      }
    }
  }

  const requestedModel = options.model || options.overrideModel || db.settings.model;
  const { provider, client, baseURL, settings } = createLLMClient(db, requestedModel);
  const resolvedDb = { ...db, settings };
  const started = Date.now();
  const searchMode = options.searchMode;
  const messages = normalizeLlmMessages(
    await attachVisionImages(resolvedDb, options.messages || [], options.visionImages || [], options)
  );
  const params = {
    model: requestModelForProvider(resolvedDb, provider, baseURL, { ...options, model: requestedModel }),
    messages,
    temperature: Number(options.temperature ?? settings.temperature ?? 0.85)
  };

  // deepseek-v4-flash defaults to thinking on this API and can burn the whole
  // token budget on reasoning_content (returning empty chat content), which
  // doubled latency via retries and produced silent empty replies. Chat
  // replies do not need hidden reasoning; disable it explicitly.
  const thinkingEnabled = provider === 'deepseek'
    && ['enabled', 'high', 'max'].includes(String(options.thinking?.type || ''));
  if (provider === 'deepseek') {
    params.thinking = options.thinking || { type: 'disabled' };
    if (options.reasoning_effort) {
      params.reasoning_effort = options.reasoning_effort;
    }
  }
  // Thinking requests must not be capped by the chat-default max_tokens; the
  // reasoning content itself needs budget, so keep the provider's own limit.
  if (!thinkingEnabled) {
    params.max_tokens = Number(options.maxTokens || settings.maxTokens || 420);
  }

  // Tool calling support (OpenAI function-calling format)
  if (options.tools?.length) {
    params.tools = options.tools;
    params.tool_choice = options.tool_choice || 'auto';
  }

  if (searchMode && supportsProviderSearch(provider)) {
    params.enable_search = true;
    params.search_mode = searchMode;
  }
  if (options.responseFormat) {
    params.response_format = options.responseFormat;
  }

  let providerAttempt = 0;
  const runCompletion = async (nextParams) => {
    providerAttempt += 1;
    const invocationId = crypto.randomUUID();
    const invocationStarted = Date.now();
    const requestTimeoutMs = Number(options.timeoutMs || 45_000);
    const requestMaxRetries = Math.max(0, Number(options.requestMaxRetries ?? 2));
    const outerTimeoutMs = requestTimeoutMs + 1000;
    const label = options.label || `${llmProviderName(provider)} 调用`;
    const streaming = provider === 'deepseek'
      && Boolean(currentRequestTraceId())
      && options.traceStreaming !== false;
    traceEvent('MODEL', 'model_call_started', {
      status: 'running',
      invocationId,
      attempt: providerAttempt,
      role: options.traceRole || 'assistant',
      purpose: options.tracePurpose || label,
      provider,
      model: nextParams.model,
      messageCount: nextParams.messages?.length || 0,
      toolCount: nextParams.tools?.length || 0,
      streaming,
      thinkingEnabled,
    });
    // The outer timeout must do more than stop waiting: abort the SDK's
    // in-flight fetch AND cancel its pending retries. SDK v6 propagates
    // `signal` to the per-attempt fetch and re-checks it before every attempt,
    // so an abort during backoff prevents the next HTTP request entirely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), outerTimeoutMs);
    try {
      let response;
      if (streaming) {
        let lastPublishedAt = 0;
        let latestProgress;
        let lastPublishedSignature = '';
        const publishProgress = (force = false) => {
          if (!latestProgress) return;
          const now = Date.now();
          const signature = `${latestProgress.reasoning.length}:${latestProgress.content.length}:${latestProgress.toolCallsPending}`;
          if (!force && lastPublishedAt > 0 && now - lastPublishedAt < 120) return;
          if (signature === lastPublishedSignature) return;
          lastPublishedAt = now;
          lastPublishedSignature = signature;
          traceModelStream(invocationId, {
            status: 'running',
            durationMs: now - invocationStarted,
            purpose: options.tracePurpose || label,
            attempt: providerAttempt,
            provider,
            model: nextParams.model,
            response: latestProgress,
            streaming: true,
          });
        };
        const stream = await withTimeout(
          client.chat.completions.create({
            ...nextParams,
            stream: true,
            stream_options: { include_usage: true },
          }, {
            timeout: requestTimeoutMs,
            maxRetries: requestMaxRetries,
            signal: controller.signal,
          }),
          outerTimeoutMs,
          label
        );
        const remainingMs = Math.max(1, outerTimeoutMs - (Date.now() - invocationStarted));
        response = await withTimeout(
          collectChatCompletionStream(stream, nextParams.model, (progress) => {
            latestProgress = progress;
            publishProgress(false);
          }),
          remainingMs,
          label
        );
        publishProgress(true);
        traceModelStream(invocationId, {
          status: 'ok',
          durationMs: Date.now() - invocationStarted,
          purpose: options.tracePurpose || label,
          attempt: providerAttempt,
          provider,
          model: nextParams.model,
          response: latestProgress || {
            content: '', reasoning: '', reasoningExposed: false, toolCallsPending: 0,
          },
          streaming: true,
        });
      } else {
        response = await withTimeout(
          client.chat.completions.create(nextParams, {
            timeout: requestTimeoutMs,
            maxRetries: requestMaxRetries,
            signal: controller.signal,
          }),
          outerTimeoutMs,
          label
        );
      }
      traceEvent('MODEL', 'model_call_completed', {
        status: 'ok',
        durationMs: Date.now() - invocationStarted,
        invocationId,
        attempt: providerAttempt,
        role: options.traceRole || 'assistant',
        purpose: options.tracePurpose || label,
        provider,
        model: nextParams.model,
        streaming,
        response: extractProviderResponseTrace(response),
      });
      return {
        text: response.choices?.[0]?.message?.content?.trim() || '',
        usage: response.usage || {},
        raw: response
      };
    } catch (error) {
      traceEvent('MODEL', 'model_call_failed', {
        status: 'error',
        durationMs: Date.now() - invocationStarted,
        invocationId,
        attempt: providerAttempt,
        role: options.traceRole || 'assistant',
        purpose: options.tracePurpose || label,
        provider,
        model: nextParams.model,
        error: error?.message || String(error),
      });
      // The abort fires at the same instant the outer timer rejects, so the
      // SDK usually settles first with APIUserAbortError. Normalize it back to
      // the same user-facing timeout message callers saw before.
      if (error instanceof OpenAI.APIUserAbortError) {
        throw new Error(`${label} 超时 ${Math.round(outerTimeoutMs / 1000)} 秒`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const retryAfterEmpty = async (first) => {
    if (options.retryOnEmpty === false) return first;
    const firstMeta = buildLlmCompletionMeta(first.raw, {
      model: params.model,
      provider,
      latencyMs: 0,
    });
    if (isReasoningBudgetExhaustion(firstMeta)) {
      // Thinking consumed the whole output budget. Retry once with tools
      // intact and no max_tokens cap; never route through the tools-dropping
      // empty-reply retry below.
      const retryParams = { ...params };
      delete retryParams.max_tokens;
      const second = await runCompletion(retryParams);
      return {
        text: second.text,
        usage: mergeUsage(first.usage, second.usage),
        raw: second.raw
      };
    }
    if (first.text || (first.raw?.choices?.[0]?.message?.tool_calls?.length > 0)) return first;
    const retryParams = buildEmptyReplyRetryParams(params, {
      retainToolsOnEmpty: options.retainToolsOnEmpty === true,
      removeProviderSearch: Boolean(searchMode && supportsProviderSearch(provider)),
    });
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
      latencyMs: Date.now() - started,
      meta: buildLlmCompletionMeta(result.raw, {
        model: params.model,
        provider,
        latencyMs: Date.now() - started,
      })
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
        latencyMs: Date.now() - started,
        meta: buildLlmCompletionMeta(result.raw, {
          model: params.model,
          provider,
          latencyMs: Date.now() - started,
        })
      };
    }
    if (/Connection error/i.test(message) || error?.name === 'APIConnectionError') {
      const cause = error?.cause?.code || error?.cause?.message || '';
      throw new Error(`${llmProviderName(provider)} 连接失败：${baseURL || '未配置 API 地址'}。${cause || message}`);
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
