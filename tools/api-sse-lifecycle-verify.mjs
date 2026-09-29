import assert from 'node:assert/strict';
import test from 'node:test';

const closeCalls = [];
let resolveOpen;
const session = new Map();
globalThis.window = {
  desktop: {
    isDesktop: true,
    apiTransport: 'bridge',
    apiBaseUrl: 'http://127.0.0.1:8787',
    api: {
      sseOpen: () => new Promise((resolve) => { resolveOpen = resolve; }),
      onSseEvent: () => () => {},
      sseClose: (id) => { closeCalls.push(id); return Promise.resolve(true); },
    },
  },
  sessionStorage: {
    getItem: (key) => session.get(key) || null,
    setItem: (key, value) => session.set(key, value),
  },
  setTimeout,
  clearTimeout,
};

const { subscribeRequestTraceStream } = await import('../src/lib/api.js?api-sse-lifecycle-verify');

test('cancelling while bridge SSE open is pending closes the late stream id', async () => {
  const stop = subscribeRequestTraceStream({ onMessage: () => {}, onState: () => {} });
  for (let attempt = 0; attempt < 20 && !resolveOpen; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(resolveOpen, 'SSE open must have started');
  stop();
  resolveOpen({ id: 'late-sse' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(closeCalls, ['late-sse']);
});

test('active SSE cleanup is idempotent and ignores late events', async () => {
  closeCalls.length = 0;
  let eventHandler;
  let offCalls = 0;
  const messages = [];
  window.desktop.api = {
    sseOpen: async () => ({ id: 'active-sse' }),
    onSseEvent: (_id, handler) => {
      eventHandler = handler;
      return () => { offCalls += 1; };
    },
    sseClose: (id) => { closeCalls.push(id); return Promise.resolve(true); },
  };
  const stop = subscribeRequestTraceStream({ onMessage: (message) => messages.push(message), onState: () => {} });
  for (let attempt = 0; attempt < 20 && !eventHandler; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(eventHandler, 'SSE listener must be registered');
  stop();
  stop();
  eventHandler({ type: 'chunk', text: 'data: {"late":true}\n\n' });
  eventHandler({ type: 'end' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(closeCalls, ['active-sse']);
  assert.equal(offCalls, 1);
  assert.deepEqual(messages, []);
});
