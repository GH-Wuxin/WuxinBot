// Provider-neutral LLM client layer.
// DeepSeek is the default provider today, but the rest of the bot should call
// this module instead of depending on DeepSeek-specific names.
import fs from 'node:fs/promises';
import path from 'node:path';
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
  if (!images?.length || llmProvider(db) === 'deepseek') return messages;
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

export function createLLMClient(db) {
  const provider = llmProvider(db);
  const apiKey = db.settings.apiKey;
  if (!apiKey) {
    throw new Error(`${llmProviderName(provider)} API Key 还没有填写，请先在 GUI 的“模型设置”里填写。`);
  }
  const baseURL = db.settings.apiBaseUrl || defaultBaseUrlForProvider(provider);
  return {
    provider,
    baseURL,
    client: new OpenAI({
      apiKey,
      baseURL: baseURL || undefined
    })
  };
}

export async function completeChat(db, options = {}) {
  const { provider, client, baseURL } = createLLMClient(db);
  const started = Date.now();
  const searchMode = options.searchMode;
  const messages = await attachVisionImages(db, options.messages || [], options.visionImages || [], options);
  const params = {
    model: options.model || options.overrideModel || db.settings.model || 'deepseek-chat',
    messages,
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
