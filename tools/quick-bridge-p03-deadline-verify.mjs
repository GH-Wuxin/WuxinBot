// quick-bridge-p03-deadline-verify.mjs
// Offline hardening regression for QUICK_BRIDGE_FIX_P0_3_1.
// The first valid reply's eligibility is decided by an absolute monotonic
// deadline (receivedAtNs <= noReplyDeadlineNs), never by whether the
// setTimeout callback has executed. All fixtures run in this process with
// synthetic WebSocket servers, mocked process.hrtime.bigint for deterministic
// boundary placement, and an optional timeout-callback delay to model an
// event loop where a logically-late frame is processed before the timer.
// A 2,000-case timeline-annotated race campaign then proves that outcome
// matches the recorded logical arrival classification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(path.join('G:/QQ-AI-ChatBot', 'package.json'));
const { WebSocketServer } = require('ws');

const REPO = 'G:/QQ-AI-ChatBot';
const LOCAL_BRIDGE = pathToFileURL(path.join(REPO, 'server/bots/localBridge.ts')).href;

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function activeTimeoutCount() {
  try { return process._getActiveHandles().filter((h) => h.constructor && h.constructor.name === 'Timeout').length; }
  catch { return -1; }
}

const textFrame = (text, echo) => JSON.stringify({ action: 'send_msg', echo, params: { message: text } });

async function runInProcess({
  id, timeoutMs = 300, env = {}, hrtimePolicy = null, delayTimeoutByMs = 0,
  frameKind = 'text', replyAtMs = null, extraReplyAtMs = null, closeAtMs = null,
  assert, waitAfter = 60,
}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = String(v); }
  process.env.BRIDGE_URL_KANON = `ws://127.0.0.1:${wss.address().port}`;
  process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-p031-inproc-out-'));

  const realSetTimeout = globalThis.setTimeout;
  if (delayTimeoutByMs > 0) {
    globalThis.setTimeout = function (fn, delay, ...args) {
      if (typeof delay === 'number' && delay === timeoutMs) return realSetTimeout(fn, delay + delayTimeoutByMs, ...args);
      return realSetTimeout(fn, delay, ...args);
    };
  }
  const realHrtime = process.hrtime.bigint.bind(process.hrtime);
  let S = 0n;
  if (hrtimePolicy) {
    let calls = 0;
    process.hrtime.bigint = () => {
      calls++;
      if (calls === 1) { S = realHrtime(); return S; }
      return S + BigInt(timeoutMs) * 1_000_000n + BigInt(hrtimePolicy.offsetMs) * 1_000_000n;
    };
  }

  const mod = await import(`${LOCAL_BRIDGE}?p031-ip=${encodeURIComponent(id)}-${Date.now()}`);
  const obs = { acks: [], inbound: null, serverClosed: false };
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed && parsed.post_type === 'message' && !obs.inbound) obs.inbound = parsed;
      else if (parsed && parsed.echo !== undefined && (parsed.status !== undefined || parsed.retcode !== undefined)) obs.acks.push(parsed);
    });
    socket.on('close', () => { obs.serverClosed = true; });
    const sendFrame = (kind, echo) => {
      try {
        if (kind === 'text') socket.send(textFrame('valid', echo));
        else if (kind === 'huge') socket.send(JSON.stringify({ action: 'send_msg', echo, params: { message: 'x'.repeat(3000000) } }));
        else if (kind === 'ack') socket.send(JSON.stringify({ action: 'get_login_info', echo, params: {} }));
        else socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 }));
      } catch {}
    };
    if (replyAtMs !== null) setTimeout(() => sendFrame(frameKind, `e-${frameKind}`), replyAtMs);
    if (extraReplyAtMs !== null) setTimeout(() => sendFrame('text', 'e-extra'), extraReplyAtMs);
    if (closeAtMs !== null) setTimeout(() => { try { socket.close(); } catch {} }, closeAtMs);
  });

  let settles = 0;
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const t0 = Date.now();
  let result = null;
  let rejection = null;
  const promise = mod.callLocalBot('kanon', '!audit', { groupId: '770099', userId: '900000099', nickname: 'P031', atTargets: [] }, timeoutMs);
  promise.then(() => { settles++; }).catch(() => { settles++; });
  try {
    result = await promise;
  } catch (e) { rejection = e; }
  const elapsed = Date.now() - t0;
  await sleep(waitAfter);
  process.removeListener('unhandledRejection', onUnhandled);

  globalThis.setTimeout = realSetTimeout;
  process.hrtime.bigint = realHrtime;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((r) => wss.close(r));

  const ctx = { result, rejection, elapsed, obs, settles, unhandled };
  if (assert) assert(ctx);
  return ctx;
}

// 1/2/3. Deterministic logical-boundary policy via mocked monotonic clock.
const boundaryEnv = { BRIDGE_SETTLE_MS: '50', BRIDGE_MAX_POST_REPLY_MS: '100' };
for (const [name, offsetMs] of [['minus-1', -1], ['exact', 0], ['plus-1', 1]]) {
  const out = await runInProcess({
    id: `deadline-${name}`, timeoutMs: 300, env: boundaryEnv,
    hrtimePolicy: { offsetMs }, replyAtMs: 60,
    assert(ctx) {
      if (offsetMs <= 0) {
        ok(`p031-${name}:resolves`, ctx.result?.text === 'valid' && ctx.rejection === null, JSON.stringify(ctx.result || ctx.rejection?.message));
      } else {
        ok(`p031-${name}:rejects`, ctx.result === null && String(ctx.rejection?.message).includes('调用超时'), JSON.stringify(ctx.result || ctx.rejection?.message));
        ok(`p031-${name}:no-revival`, ctx.result === null, 'late first frame must not resolve');
      }
      ok(`p031-${name}:once`, ctx.settles === 1, `settles=${ctx.settles}`);
    },
  });
  void out;
}

// 4. EVENT_LOOP_DELAY_BEFORE_TIMEOUT_CALLBACK:
// timeout callback delayed +80ms; first valid frame at deadline+10ms.
// The handler runs before the timer, ACKs the frame, but the absolute
// deadline must reject. ACK evidence proves the handler processed the frame.
{
  const out = await runInProcess({
    id: 'delayed-timeout-callback', timeoutMs: 300, env: boundaryEnv,
    delayTimeoutByMs: 80, replyAtMs: 310,
    assert(ctx) {
      ok('p031-delayed:rejects', ctx.result === null && String(ctx.rejection?.message).includes('调用超时'), JSON.stringify(ctx.result || ctx.rejection?.message));
      ok('p031-delayed:frame-processed-before-timer', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-text', JSON.stringify(ctx.obs.acks));
      ok('p031-delayed:elapsed-after-delayed-timer', ctx.elapsed >= 360, `elapsed=${ctx.elapsed}`);
      ok('p031-delayed:once', ctx.settles === 1);
    },
  });
  void out;
}

// 5. LATE_FIRST_THEN_CLOSE_BEFORE_TIMEOUT_CALLBACK (P0_3_1 edge case):
// first valid reply arrives after the absolute deadline, then the server
// closes before the delayed timeout callback. The late frame must have been
// discarded BEFORE collection, so close must reject (无回复), never resolve.
{
  const out = await runInProcess({
    id: 'late-first-close-before-timeout', timeoutMs: 300, env: boundaryEnv,
    delayTimeoutByMs: 80, replyAtMs: 310, closeAtMs: 330,
    assert(ctx) {
      ok('p031-close:rejects', ctx.result === null && ctx.rejection !== null && String(ctx.rejection.message).includes('无回复') && !String(ctx.rejection.message).includes('调用超时'), JSON.stringify(ctx.result || ctx.rejection?.message));
      ok('p031-close:never-resolve', ctx.result === null, 'close after late-only frame must not resolve');
      ok('p031-close:frame-processed-then-discarded', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'e-text', JSON.stringify(ctx.obs.acks));
      ok('p031-close:once', ctx.settles === 1, `settles=${ctx.settles}`);
    },
  });
  void out;
}

// 6. ON_TIME_FRAME_SLOW_EXTRACTION:
// mocked receive time = deadline-1ms; 3MB real parsing crosses the deadline.
// Receive-time semantics accept it.
{
  const out = await runInProcess({
    id: 'slow-extraction', timeoutMs: 300, env: boundaryEnv,
    hrtimePolicy: { offsetMs: -1 }, frameKind: 'huge', replyAtMs: 50,
    assert(ctx) {
      ok('p031-slow:resolves', ctx.result?.text?.length === 3000000, `textLen=${ctx.result?.text?.length}`);
      ok('p031-slow:once', ctx.settles === 1);
    },
  });
  void out;
}

// 7/8. ACK / unrelated after deadline with delayed timeout callback: no grace.
for (const [name, kind] of [['ack-after-deadline', 'ack'], ['unrelated-after-deadline', 'unrelated']]) {
  const out = await runInProcess({
    id: name, timeoutMs: 300, env: boundaryEnv,
    delayTimeoutByMs: 80, frameKind: kind, replyAtMs: 310,
    assert(ctx) {
      ok(`p031-${name}:rejects`, ctx.result === null && String(ctx.rejection?.message).includes('调用超时'), JSON.stringify(ctx.result || ctx.rejection?.message));
      ok(`p031-${name}:once`, ctx.settles === 1);
    },
  });
  void out;
}

// 9. FIRST_VALID_THEN_LATE_VALID:
// on-time first frame retires the deadline; a later frame after the original
// deadline still participates in bounded settle.
{
  const out = await runInProcess({
    id: 'first-valid-then-late', timeoutMs: 300,
    env: { BRIDGE_SETTLE_MS: '200', BRIDGE_MAX_POST_REPLY_MS: '600' },
    replyAtMs: 150, extraReplyAtMs: 320,
    assert(ctx) {
      ok('p031-first-late:both-frames', ctx.result?.frames === 2 && ctx.result?.text === 'valid\nvalid', JSON.stringify(ctx.result));
      ok('p031-first-late:once', ctx.settles === 1);
    },
  });
  void out;
}

// 10. The timeline-annotated 2,000-case race campaign lives in its own
// verifier (quick-bridge-p03-deadline-race-verify.mjs) because bridgeTimeline
// is a process-wide singleton whose ENABLED/TIMELINE_DIR are fixed at first
// import; the boundary fixtures above intentionally run without timeline
// instrumentation so mocked process.hrtime.bigint stays deterministic.

console.log(`\nquick-bridge-p03-deadline-verify: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
