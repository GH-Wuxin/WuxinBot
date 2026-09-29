import assert from 'node:assert/strict';
import test from 'node:test';

const fetchCalls = [];
const session = new Map();
globalThis.window = {
  desktop: undefined,
  sessionStorage: {
    getItem: (key) => session.get(key) || null,
    setItem: (key, value) => session.set(key, value),
  },
  setTimeout,
  clearTimeout,
};
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const { api } = await import('../src/lib/api.js?api-cancellation-verify');

test('browser cancellation reaches fetch and pre-aborted calls do not send', async () => {
  fetchCalls.length = 0;
  const controller = new AbortController();
  await api('/api/state', { signal: controller.signal });
  assert.ok(fetchCalls[0].options.signal instanceof AbortSignal, 'fetch must receive the caller signal');

  fetchCalls.length = 0;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(() => api('/api/state', { signal: alreadyAborted.signal }), /请求已取消/);
  assert.equal(fetchCalls.length, 0, 'pre-aborted request must not reach fetch');
});

test('packaged cancellation sends only its request id and ignores a late success', async () => {
  let requestSeen = null;
  let resolveHttp;
  const cancelCalls = [];
  window.desktop = {
    isDesktop: true,
    apiTransport: 'bridge',
    apiBaseUrl: 'http://127.0.0.1:8787',
    api: {
      httpRequest: (request) => {
        requestSeen = request;
        return new Promise((resolve) => { resolveHttp = resolve; });
      },
      cancelHttpRequest: (requestId) => {
        cancelCalls.push(requestId);
        return Promise.resolve(true);
      },
    },
  };
  const controller = new AbortController();
  const pending = api('/api/state', { signal: controller.signal });
  for (let attempt = 0; attempt < 20 && !requestSeen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(requestSeen?.requestId, 'bridge request must carry an id');
  controller.abort();
  assert.deepEqual(cancelCalls, [requestSeen.requestId], 'cancel must target this request only');
  resolveHttp({ status: 200, body: JSON.stringify({ ok: true, via: 'late-success' }) });
  await assert.rejects(pending, /请求已取消/, 'late success must not escape cancellation');
});

test('cancellation while consuming a response body keeps cancellation semantics', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  let bodyStarted = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: () => {
      bodyStarted = true;
      return new Promise((resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    },
  });
  window.desktop = undefined;
  try {
    const pending = api('/api/state', { signal: controller.signal, timeoutMs: 5_000 });
    for (let attempt = 0; attempt < 20 && !bodyStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(bodyStarted, true, 'response body consumption must start');
    controller.abort();
    await assert.rejects(pending, /请求已取消/, 'body-stage cancellation must not become server error 200');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
