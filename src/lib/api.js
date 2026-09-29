const ADMIN_PASSWORD_KEY = 'wuxinAdminPassword';
const DEFAULT_TIMEOUT_MS = 30_000;

function apiUrl(pathname) {
  const base = typeof window !== 'undefined' ? String(window.desktop?.apiBaseUrl || '') : '';
  if (!base || /^https?:\/\//i.test(String(pathname))) return pathname;
  return `${base.replace(/\/$/, '')}/${String(pathname).replace(/^\//, '')}`;
}

let authPromptActive = false;
let authPromptCancelled = false;

export function resetAdminAuthPrompt() {
  authPromptCancelled = false;
}

// Electron does not implement window.prompt (it throws), so the packaged
// Desktop console could never answer the 401 password challenge and locked
// itself out after an admin password was set. Build a minimal in-page dialog
// instead; resolves null when cancelled.
function promptPassword(message) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(10,8,16,.62);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:inherit;';
    const card = document.createElement('div');
    card.style.cssText = 'background:#221d31;color:#eee;padding:22px 24px;border-radius:12px;min-width:320px;box-shadow:0 18px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:14px;';
    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'font-size:14px;line-height:1.5;';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.style.cssText = 'padding:9px 11px;border-radius:8px;border:1px solid #4a4160;background:#17141f;color:#eee;font-size:14px;outline:none;';
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid #4a4160;background:transparent;color:#bbb;cursor:pointer;';
    const submit = document.createElement('button');
    submit.textContent = '确定';
    submit.style.cssText = 'padding:8px 16px;border-radius:8px;border:none;background:#7c6cf0;color:#fff;cursor:pointer;';
    buttons.append(cancel, submit);
    card.append(label, input, buttons);
    overlay.append(card);
    document.body.append(overlay);

    const finish = (value) => {
      overlay.remove();
      window.removeEventListener('keydown', onKeyDown, true);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(null); }
      if (event.key === 'Enter') { event.stopPropagation(); finish(input.value); }
    };
    cancel.addEventListener('click', () => finish(null));
    submit.addEventListener('click', () => finish(input.value));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
    window.addEventListener('keydown', onKeyDown, true);
    input.focus();
  });
}

// In the packaged Desktop client the renderer never fetches the loopback API
// cross-origin: requests go through the guarded main-process bridge
// (desktop/preload.cjs → api:request). The browser/dev path keeps direct
// fetch. Returns a minimal Response-like object either way.
async function performRequest(path, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const desktopApi = typeof window !== 'undefined' ? window.desktop : null;
  if (desktopApi?.isDesktop && typeof desktopApi.api?.httpRequest === 'function') {
    const result = await desktopApi.api.httpRequest({ url: apiUrl(path), method, headers, body, timeoutMs });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
      json: async () => JSON.parse(result.body),
    };
  }
  return fetch(apiUrl(path), { method, headers, body });
}

export async function api(path, options = {}, allowAuthRetry = true) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const savedPassword = window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(savedPassword ? { 'X-Wuxin-Admin-Password': savedPassword } : {}),
    ...(fetchOptions.headers || {})
  };
  try {
    const response = await performRequest(path, {
      method: fetchOptions.method || 'GET',
      headers,
      body: fetchOptions.body ? JSON.stringify(fetchOptions.body) : undefined,
      timeoutMs,
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务器错误 (${response.status})`); }
    if (response.status === 401 && allowAuthRetry && !authPromptActive && !authPromptCancelled) {
      authPromptActive = true;
      const password = await promptPassword('控制台已启用管理密码，请输入：');
      authPromptActive = false;
      if (password === null) {
        authPromptCancelled = true;
        throw new Error('需要管理密码');
      }
      window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
      return api(path, options, false);
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (timedOut) throw new Error(`请求超时（${Math.round(Number(timeoutMs) / 1000)} 秒）`);
      throw new Error('请求已取消');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export function parseSseBuffer(input) {
  const normalized = String(input || '').replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() || '';
  const messages = [];
  for (const block of blocks) {
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { /* Ignore malformed diagnostic frames. */ }
  }
  return { messages, remainder };
}

export function subscribeRequestTraceStream({ onMessage, onState }) {
  const controller = new AbortController();
  const desktopApi = typeof window !== 'undefined' ? window.desktop : null;
  const useBridge = Boolean(desktopApi?.isDesktop && typeof desktopApi.api?.sseOpen === 'function');
  let stopped = false;
  let retryTimer = null;
  let releaseRetryWait = null;
  const activeCleanup = [];
  const cleanupActive = () => {
    while (activeCleanup.length) {
      try { activeCleanup.pop()(); } catch { /* ignore */ }
    }
  };
  const streamUrl = apiUrl('/api/request-traces/stream?limit=80');
  const sseHeaders = () => {
    const savedPassword = window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
    return {
      Accept: 'text/event-stream',
      ...(savedPassword ? { 'X-Wuxin-Admin-Password': savedPassword } : {}),
    };
  };

  // Desktop bridge variant: the main process owns the HTTP stream and forwards
  // raw text chunks; the renderer keeps its own SSE framing via parseSseBuffer.
  const openBridgeStream = async () => {
    onState?.('connecting');
    const opened = await desktopApi.api.sseOpen({ url: streamUrl, headers: sseHeaders() });
    let buffer = '';
    let settleStream;
    const settled = new Promise((resolve) => { settleStream = resolve; });
    const off = desktopApi.api.onSseEvent(opened.id, (payload) => {
      if (stopped) return;
      if (payload?.type === 'open') onState?.('connected');
      else if (payload?.type === 'chunk') {
        buffer += payload.text || '';
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.remainder;
        for (const message of parsed.messages) onMessage?.(message);
      } else {
        settleStream(new Error(payload?.type === 'error' ? (payload.message || '实时追踪连接失败') : '实时追踪连接已结束'));
      }
    });
    activeCleanup.push(off);
    activeCleanup.push(() => { void desktopApi.api.sseClose(opened.id); });
    try {
      await settled;
    } finally {
      cleanupActive();
    }
    if (!stopped) throw new Error('实时追踪连接已结束');
  };

  const openFetchStream = async () => {
    onState?.('connecting');
    const response = await fetch(streamUrl, {
      headers: sseHeaders(),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`实时追踪连接失败 (${response.status})`);
    onState?.('connected');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.remainder;
      for (const message of parsed.messages) onMessage?.(message);
    }
    if (!stopped) throw new Error('实时追踪连接已结束');
  };

  void (async () => {
    while (!stopped) {
      try {
        if (useBridge) await openBridgeStream();
        else await openFetchStream();
      } catch (error) {
        cleanupActive();
        if (stopped || error?.name === 'AbortError') break;
        onState?.('fallback', error?.message || String(error));
      }
      if (!stopped) {
        await new Promise((resolve) => {
          releaseRetryWait = resolve;
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            releaseRetryWait = null;
            resolve();
          }, 3000);
        });
      }
    }
  })();
  return () => {
    stopped = true;
    cleanupActive();
    if (retryTimer) window.clearTimeout(retryTimer);
    releaseRetryWait?.();
    releaseRetryWait = null;
    controller.abort();
  };
}

export function rememberAdminPassword(password) {
  if (password && password !== '已设置') window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
}
