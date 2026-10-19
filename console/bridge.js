// file:// 下走 preload 的 HTTP 桥（Electron），http(s) 下直接用 fetch。
async function __apiFetch(path, options) {
  const opts = options || {};
  const useBridge = location.protocol === 'file:' && window.desktop && window.desktop.api && typeof window.desktop.api.httpRequest === 'function';
  if (!useBridge) return fetch(path, opts);
  const url = new URL(path, 'http://127.0.0.1:8787').toString();
  const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await window.desktop.api.httpRequest({ url, method: opts.method || 'GET', headers, body: typeof opts.body === 'string' ? opts.body : undefined });
  const body = response && typeof response.body === 'string' ? response.body : '';
  const status = response && Number(response.status) ? Number(response.status) : 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body || '{}')
  };
}
