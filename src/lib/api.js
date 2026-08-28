const ADMIN_PASSWORD_KEY = 'wuxinAdminPassword';

let authPromptActive = false;
let authPromptCancelled = false;

export function resetAdminAuthPrompt() {
  authPromptCancelled = false;
}

export async function api(path, options = {}, allowAuthRetry = true) {
  const { timeoutMs = 120000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, Number(timeoutMs) || 120000));
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
    const response = await fetch(path, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
      body: fetchOptions.body ? JSON.stringify(fetchOptions.body) : undefined
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`服务器错误 (${response.status})`); }
    if (response.status === 401 && allowAuthRetry && !authPromptActive && !authPromptCancelled) {
      authPromptActive = true;
      const password = window.prompt('控制台已启用管理密码，请输入：');
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
  let stopped = false;
  let retryTimer = null;
  let releaseRetryWait = null;
  void (async () => {
    while (!stopped) {
      try {
        onState?.('connecting');
        const savedPassword = window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
        const response = await fetch('/api/request-traces/stream?limit=80', {
          headers: {
            Accept: 'text/event-stream',
            ...(savedPassword ? { 'X-Wuxin-Admin-Password': savedPassword } : {}),
          },
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
      } catch (error) {
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
    if (retryTimer) window.clearTimeout(retryTimer);
    releaseRetryWait?.();
    releaseRetryWait = null;
    controller.abort();
  };
}

export function rememberAdminPassword(password) {
  if (password && password !== '已设置') window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
}
