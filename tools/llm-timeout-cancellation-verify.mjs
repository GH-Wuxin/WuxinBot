// llm-timeout-cancellation-verify.mjs
// Deterministic verification (fully OFFLINE) of the LLM timeout/cancellation
// chain against the REAL installed OpenAI SDK (v6.38.0) and the project's real
// withTimeout(), served by a local fake HTTP server that never responds.
// No real provider is called and no tokens are consumed.
//
// Facts pinned by this suite:
//   A. SDK per-attempt timeout with maxRetries=2 issues 3 SEQUENTIAL HTTP
//      attempts (observed max concurrency is 1), not "3 requests in flight".
//   B. The project's outer withTimeout (SDK timeout + 1s) rejects while the SDK
//      keeps issuing further retries - orphaned requests after caller gives up.
//   C. Passing an AbortSignal into SDK options aborts the in-flight fetch
//      immediately and prevents all subsequent retries.
//   D. Aborting between attempts (during retry backoff) also prevents the next
//      attempt from ever hitting the network.
//   E. completeChat() end-to-end: without the signal fix the fake server sees 3
//      requests (orphan); with the fix it sees 2 (outer abort lands in backoff).

import http from 'node:http';
import OpenAI from 'openai';
import {
  createTestDataDir,
  assertNotProduction,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
  cleanupTestDir,
} from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-llm-timeout');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();

const SDK_TIMEOUT_MS = 250;
const OUTER_TIMEOUT_MS = SDK_TIMEOUT_MS + 1000; // mirrors llm.ts: requestTimeoutMs + 1000
const ABORT_IN_FLIGHT_MS = 400; // SDK timeout is 5000 in case C, so only our abort can close it

function createHangingServer() {
  const requests = [];
  let active = 0;
  let maxActive = 0;
  let server;
  let port = 0;
  server = http.createServer((req, res) => {
    const entry = {
      id: requests.length + 1,
      method: req.method,
      url: req.url,
      startedAt: Date.now(),
      closedAt: 0,
    };
    active += 1;
    maxActive = Math.max(maxActive, active);
    requests.push(entry);
    req.on('aborted', () => { /* kept for debugging; close is the source of truth */ });
    req.socket.on('close', () => {
      entry.closedAt = Date.now();
      active -= 1;
    });
    req.resume(); // drain body; never respond, so the request hangs until abort
    res.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        requests,
        maxActive: () => maxActive,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(r);
        }),
      });
    });
  });
}

const server = await createHangingServer();
const API_BASE = `http://127.0.0.1:${server.port}`;
const CHAT_PARAMS = {
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'hi' }],
};

const { withTimeout, completeChat } = await import('../server/bot/llm.ts');

let passed = 0;
let failed = 0;
const pass = (label) => { console.log(`PASS [${label}]`); passed++; };
const fail = (label, msg) => { console.error(`FAIL [${label}]: ${msg}`); failed++; };
const assert = (cond, label, msg) => (cond ? pass(label) : fail(label, msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const makeClient = () => new OpenAI({ apiKey: 'verify-key', baseURL: API_BASE });

// ---- A: SDK per-attempt timeout + maxRetries=2 = 3 sequential attempts ----
{
  const client = makeClient();
  const base = server.requests.length;
  const startedAt = Date.now();
  let error = null;
  try {
    await client.chat.completions.create(CHAT_PARAMS, { timeout: SDK_TIMEOUT_MS, maxRetries: 2 });
  } catch (e) {
    error = e;
  }
  const slice = server.requests.slice(base);
  assert(
    error instanceof OpenAI.APIConnectionTimeoutError,
    'a:rejects-with-sdk-timeout',
    String(error),
  );
  assert(slice.length === 3, 'a:three-total-attempts', `count=${slice.length}`);
  assert(server.maxActive() === 1, 'a:attempts-sequential-not-concurrent', `maxActive=${server.maxActive()}`);
  assert(Date.now() - startedAt >= 1200, 'a:attempts-spread-by-backoff', `elapsed=${Date.now() - startedAt}ms`);
}

// ---- B: outer withTimeout rejects, SDK keeps retrying (orphaned tail) ----
{
  const client = makeClient();
  const base = server.requests.length;
  const sdkPromise = client.chat.completions.create(CHAT_PARAMS, { timeout: SDK_TIMEOUT_MS, maxRetries: 2 });
  sdkPromise.catch(() => {}); // outer race may reject first; swallow the orphaned tail
  let outerRejectedAt = 0;
  try {
    await withTimeout(sdkPromise, OUTER_TIMEOUT_MS, 'verify-b');
  } catch {
    outerRejectedAt = Date.now();
  }
  assert(outerRejectedAt > 0, 'b:outer-with-timeout-rejects', `at=${outerRejectedAt}`);
  await sdkPromise.catch(() => {}); // wait for all orphaned attempts to finish
  const slice = server.requests.slice(base);
  assert(slice.length === 3, 'b:orphaned-sdk-finishes-all-retries', `count=${slice.length}`);
  assert(
    slice[2].startedAt > outerRejectedAt,
    'b:retry-issued-after-caller-gave-up',
    `attempt3=${slice[2].startedAt} outerReject=${outerRejectedAt}`,
  );
}

// ---- C: user signal aborts the in-flight fetch immediately, no retries ----
{
  const client = makeClient();
  const base = server.requests.length;
  const controller = new AbortController();
  const promise = client.chat.completions.create(CHAT_PARAMS, {
    timeout: 5000,
    maxRetries: 2,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), ABORT_IN_FLIGHT_MS);
  let error = null;
  let rejectedAt = 0;
  try {
    await promise;
  } catch (e) {
    error = e;
    rejectedAt = Date.now();
  }
  clearTimeout(timer);
  const slice = server.requests.slice(base);
  const rejectAfterStartMs = rejectedAt > 0 && slice[0] ? rejectedAt - slice[0].startedAt : -1;
  assert(error instanceof OpenAI.APIUserAbortError, 'c:rejects-with-user-abort', String(error));
  assert(slice.length === 1, 'c:no-retries-after-abort', `count=${slice.length}`);
  // The SDK timeout is 5000ms in this case, so rejecting ~400ms after the
  // request started (rather than ~5000ms) proves the abort cut the in-flight
  // fetch short. The fake server cannot measure this itself: undici may keep
  // the already-sent connection in its pool, so the server socket stays open.
  assert(
    rejectAfterStartMs >= 300 && rejectAfterStartMs < 2000,
    'c:in-flight-fetch-aborted-immediately',
    `reject@${rejectAfterStartMs}ms after request start`,
  );
}

// ---- D: abort during retry backoff prevents the next attempt ----
{
  const client = makeClient();
  const base = server.requests.length;
  const controller = new AbortController();
  const promise = client.chat.completions.create(CHAT_PARAMS, {
    timeout: SDK_TIMEOUT_MS,
    maxRetries: 2,
    signal: controller.signal,
  });
  promise.catch(() => {});
  const timer = setTimeout(() => controller.abort(), OUTER_TIMEOUT_MS);
  let error = null;
  let rejectedAt = 0;
  try {
    await promise;
  } catch (e) {
    error = e;
    rejectedAt = Date.now();
  }
  clearTimeout(timer);
  await sleep(1500); // generous window: a third attempt would have arrived by now
  const slice = server.requests.slice(base);
  assert(error instanceof OpenAI.APIUserAbortError, 'd:rejects-with-user-abort', String(error));
  assert(slice.length === 2, 'd:third-attempt-suppressed-during-backoff', `count=${slice.length}`);
  assert(
    slice.every((r) => r.startedAt < rejectedAt),
    'd:no-request-after-abort',
    JSON.stringify(slice.map((r) => r.startedAt)),
  );
}

// ---- E: completeChat() end-to-end ----
// Old wiring: outer timeout rejects at 1250ms, SDK still sends attempt 3
// (~1.4-2.0s) -> 3 requests. Fixed wiring: controller.abort() at 1250ms lands
// during retry backoff -> 2 requests.
{
  const base = server.requests.length;
  const db = {
    settings: {
      llmProvider: 'deepseek',
      apiBaseUrl: API_BASE,
      apiKey: 'verify-key',
      model: 'deepseek-chat',
    },
  };
  let rejected = false;
  let message = '';
  try {
    await completeChat(db, {
      messages: CHAT_PARAMS.messages,
      timeoutMs: SDK_TIMEOUT_MS,
      requestMaxRetries: 2,
      label: 'verify-e2e',
    });
  } catch (e) {
    rejected = true;
    message = String(e?.message || e);
  }
  assert(rejected, 'e:complete-chat-times-out', message);
  await sleep(2500); // let any orphaned SDK attempt finish
  const slice = server.requests.slice(base);
  assert(
    slice.length === 2,
    'e:outer-abort-suppresses-orphaned-retry',
    `count=${slice.length} (old wiring=3, fixed wiring=2)`,
  );
}

await server.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nllm-timeout-cancellation-verify: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
