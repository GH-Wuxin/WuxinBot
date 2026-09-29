import assert from 'node:assert/strict';
import test from 'node:test';

const fetchCalls = [];
const bridgeCalls = [];
const session = new Map();

globalThis.window = {
  desktop: {
    isDesktop: true,
    apiTransport: 'fetch',
    apiBaseUrl: '',
    api: {
      httpRequest: async (request) => {
        bridgeCalls.push(request);
        return { status: 200, body: JSON.stringify({ ok: true, via: 'bridge' }) };
      },
    },
  },
  sessionStorage: {
    getItem: (key) => session.get(key) || null,
    setItem: (key, value) => session.set(key, value),
  },
  setTimeout,
  clearTimeout,
};
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return { ok: true, status: 200, json: async () => ({ ok: true, via: 'fetch' }) };
};

const { api, subscribeRequestTraceStream } = await import('../src/lib/api.js?api-transport-verify');

test('Desktop dev uses same-origin fetch when transport explicitly selects fetch', async () => {
  fetchCalls.length = 0;
  bridgeCalls.length = 0;
  const result = await api('/api/state');
  assert.equal(result.via, 'fetch');
  assert.equal(fetchCalls.length, 1, 'dev request must use fetch');
  assert.equal(fetchCalls[0].url, '/api/state', 'dev request stays relative');
  assert.equal(bridgeCalls.length, 0, 'dev request must not use the packaged bridge');
});

test('packaged uses the bridge with an absolute API target and auth headers', async () => {
  fetchCalls.length = 0;
  bridgeCalls.length = 0;
  session.set('wuxinAdminPassword', 'secret');
  window.desktop = {
    isDesktop: true,
    apiTransport: 'bridge',
    apiBaseUrl: 'http://127.0.0.1:8787',
    api: {
      httpRequest: async (request) => {
        bridgeCalls.push(request);
        return { status: 200, body: JSON.stringify({ ok: true, via: 'bridge' }) };
      },
    },
  };
  const result = await api('/api/state', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: { hello: 'world' },
  });
  assert.equal(result.via, 'bridge');
  assert.equal(fetchCalls.length, 0, 'packaged request must not use renderer fetch');
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].url, 'http://127.0.0.1:8787/api/state');
  assert.equal(bridgeCalls[0].headers['X-Wuxin-Admin-Password'], 'secret');
  assert.equal(bridgeCalls[0].body, '{"hello":"world"}');
});

test('browser uses direct fetch and keeps server errors observable', async () => {
  fetchCalls.length = 0;
  bridgeCalls.length = 0;
  session.clear();
  window.desktop = undefined;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: false, status: 503, json: async () => ({ ok: false, error: 'fixture unavailable' }) };
  };
  await assert.rejects(() => api('/api/state'), /fixture unavailable/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/state');
  assert.equal(bridgeCalls.length, 0);
});

function streamResponse(payload) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

function waitForSseMessage() {
  return new Promise((resolve, reject) => {
    let stop;
    const deadline = setTimeout(() => {
      stop?.();
      reject(new Error('SSE fixture timed out'));
    }, 1000);
    stop = (message) => {
      clearTimeout(deadline);
      stopStream?.();
      resolve(message);
    };
    let stopStream;
    stopStream = subscribeRequestTraceStream({ onMessage: stop, onState: () => {} });
  });
}

test('SSE uses the same explicit transport choice as HTTP', async () => {
  fetchCalls.length = 0;
  bridgeCalls.length = 0;
  window.desktop = { isDesktop: true, apiTransport: 'fetch', apiBaseUrl: '' };
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return streamResponse({ via: 'fetch' });
  };
  const browserMessage = await waitForSseMessage();
  assert.deepEqual(browserMessage, { via: 'fetch' });
  assert.equal(fetchCalls[0].url, '/api/request-traces/stream?limit=80');
  assert.equal(bridgeCalls.length, 0);

  bridgeCalls.length = 0;
  window.desktop = {
    isDesktop: true,
    apiTransport: 'bridge',
    apiBaseUrl: 'http://127.0.0.1:8787',
    api: {
      sseOpen: async (request) => {
        bridgeCalls.push({ type: 'open', request });
        return { id: 'sse-fixture' };
      },
      onSseEvent: (_id, handler) => {
        queueMicrotask(() => {
          handler({ type: 'open' });
          handler({ type: 'chunk', text: 'data: {"via":"bridge"}\n\n' });
        });
        return () => {};
      },
      sseClose: (id) => { bridgeCalls.push({ type: 'close', id }); },
    },
  };
  const packagedMessage = await waitForSseMessage();
  assert.deepEqual(packagedMessage, { via: 'bridge' });
  assert.equal(bridgeCalls[0].type, 'open');
  assert.equal(bridgeCalls[0].request.url, 'http://127.0.0.1:8787/api/request-traces/stream?limit=80');
  assert.equal(bridgeCalls.at(-1).type, 'close');
});
