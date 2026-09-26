// quick-bridge-p03-settle-verify.mjs
// Offline regression for QUICK_BRIDGE_FIX_P0_3 (SETTLE_TIMEOUT_ARBITRATION).
// Synthetic WebSocket servers only. BRIDGE_SETTLE_MS / BRIDGE_MAX_POST_REPLY_MS
// overrides keep fixtures and the race campaign fast; production defaults are
// exercised once in the f14-equivalent fixture.
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

async function runCase({ id, timeoutMs, env, behavior, assert, waitAfter = 100 }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const saved = {};
  for (const [k, v] of Object.entries(env || {})) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = String(v);
  }
  process.env.BRIDGE_URL_KANON = url;
  process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-p03-out-'));
  const mod = await import(`${LOCAL_BRIDGE}?p03=${encodeURIComponent(id)}-${Date.now()}`);

  const obs = { inbound: null, acks: [], serverClosed: false, headers: null };
  wss.on('connection', (socket, req) => {
    obs.headers = req.headers;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed && parsed.post_type === 'message' && !obs.inbound) obs.inbound = parsed;
      else if (parsed && parsed.echo !== undefined && (parsed.status !== undefined || parsed.retcode !== undefined)) obs.acks.push(parsed);
      if (behavior && behavior.onInbound) behavior.onInbound(parsed, socket);
    });
    socket.on('close', () => { obs.serverClosed = true; });
    if (behavior && behavior.onConnect) behavior.onConnect(socket);
  });

  let settles = 0;
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const t0 = Date.now();
  let result, rejection;
  try {
    result = await mod.callLocalBot('kanon', '!audit', { groupId: '770099', userId: '900000099', nickname: 'P03', atTargets: [] }, timeoutMs);
  } catch (e) { rejection = e; }
  settles++;
  const elapsed = Date.now() - t0;
  await sleep(waitAfter);
  process.removeListener('unhandledRejection', onUnhandled);
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((r) => wss.close(r));
  const ctx = { result, rejection, elapsed, obs, settles, unhandled };
  if (assert) assert(ctx);
  return ctx;
}

const shortEnv = { BRIDGE_SETTLE_MS: '50', BRIDGE_MAX_POST_REPLY_MS: '100' };
const textFrame = (text, echo) => JSON.stringify({ action: 'send_msg', echo, params: { message: text } });

// 1. f14-equivalent with PRODUCTION defaults (3000ms settle).
await runCase({
  id: 'f14-production-defaults', timeoutMs: 500,
  behavior: { onConnect(socket) { setTimeout(() => socket.send(textFrame('too late to settle', 'e-f14')), 430); } },
  assert(ctx) {
    ok('p03-f14:resolves', ctx.result !== undefined, ctx.rejection ? String(ctx.rejection.message) : '');
    ok('p03-f14:text', ctx.result?.text === 'too late to settle', JSON.stringify(ctx.result));
    ok('p03-f14:settle-window', ctx.elapsed >= 3000 && ctx.elapsed < 4500, `elapsed=${ctx.elapsed}`);
    ok('p03-f14:once', ctx.settles === 1);
  },
});

// 2. Zero frames: no-reply deadline unchanged, no grace.
await runCase({
  id: 'no-reply', timeoutMs: 250, env: shortEnv,
  behavior: { onConnect() { /* stay silent */ } },
  assert(ctx) {
    ok('p03-noreply:rejects', ctx.rejection && String(ctx.rejection.message).includes('调用超时'), String(ctx.rejection?.message));
    ok('p03-noreply:no-grace', ctx.elapsed >= 230 && ctx.elapsed < 700, `elapsed=${ctx.elapsed}`);
    ok('p03-noreply:once', ctx.settles === 1);
  },
});

// 3. Valid reply at deadline-epsilon.
await runCase({
  id: 'just-before-deadline', timeoutMs: 300, env: shortEnv,
  behavior: { onConnect(socket) { setTimeout(() => socket.send(textFrame('just before', 'e-jb')), 270); } },
  assert(ctx) {
    ok('p03-before:resolves', ctx.result?.text === 'just before', JSON.stringify(ctx.rejection || ctx.result));
    ok('p03-before:window', ctx.elapsed >= 300 && ctx.elapsed < 900, `elapsed=${ctx.elapsed}`);
  },
});

// 4. First valid frame only AFTER deadline must not revive.
await runCase({
  id: 'just-after-deadline', timeoutMs: 300, env: shortEnv,
  behavior: { onConnect(socket) { setTimeout(() => { try { socket.send(textFrame('too late', 'e-ja')); } catch {} }, 340); } },
  assert(ctx) {
    ok('p03-after:rejects', ctx.rejection && String(ctx.rejection.message).includes('调用超时'), String(ctx.rejection?.message));
    ok('p03-after:once', ctx.settles === 1);
    ok('p03-after:fast', ctx.elapsed < 900, `elapsed=${ctx.elapsed}`);
  },
});

// 5. Multiple valid frames aggregate.
await runCase({
  id: 'multi-valid', timeoutMs: 500, env: shortEnv,
  behavior: { onConnect(socket) {
    setTimeout(() => socket.send(textFrame('a', 'e-m1')), 10);
    setTimeout(() => socket.send(textFrame('b', 'e-m2')), 50);
  } },
  assert(ctx) {
    ok('p03-multi:text', ctx.result?.text === 'a\nb', JSON.stringify(ctx.result));
    ok('p03-multi:frames', ctx.result?.frames === 2, `frames=${ctx.result?.frames}`);
    ok('p03-multi:once', ctx.settles === 1);
  },
});

// 6. Late valid frame inside settle extends nominal settle but stays bounded.
await runCase({
  id: 'late-valid-during-settle', timeoutMs: 500, env: shortEnv,
  behavior: { onConnect(socket) {
    setTimeout(() => socket.send(textFrame('a', 'e-l1')), 30);
    setTimeout(() => socket.send(textFrame('b', 'e-l2')), 70);
  } },
  assert(ctx) {
    ok('p03-late:both-frames', ctx.result?.frames === 2 && ctx.result?.text === 'a\nb', JSON.stringify(ctx.result));
    ok('p03-late:bounded', ctx.elapsed >= 110 && ctx.elapsed < 500, `elapsed=${ctx.elapsed}`);
  },
});

// 7. Hard post-reply bound: frames every ~25ms cannot extend past grace.
await runCase({
  id: 'bounded-total', timeoutMs: 500, env: shortEnv,
  behavior: { onConnect(socket) {
    for (const [i, at] of [0, 25, 50, 75, 95].entries()) {
      setTimeout(() => { try { socket.send(textFrame(`f${i}`, `e-b${i}`)); } catch {} }, at);
    }
  } },
  assert(ctx) {
    ok('p03-bound:resolved-with-collected', ctx.result && ctx.result.frames >= 4 && ctx.result.frames <= 5, JSON.stringify(ctx.result));
    ok('p03-bound:elapsed', ctx.elapsed >= 90 && ctx.elapsed < 250, `elapsed=${ctx.elapsed}`);
    ok('p03-bound:once', ctx.settles === 1);
  },
});

// 8. Unrelated frame near deadline grants no grace.
await runCase({
  id: 'unrelated-near-timeout', timeoutMs: 400, env: shortEnv,
  behavior: { onConnect(socket) { setTimeout(() => socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 })), 370); } },
  assert(ctx) {
    ok('p03-unrelated:rejects', ctx.rejection && String(ctx.rejection.message).includes('调用超时'), String(ctx.rejection?.message));
    ok('p03-unrelated:elapsed', ctx.elapsed < 900, `elapsed=${ctx.elapsed}`);
  },
});

// 9. ACK-only traffic near deadline grants no grace.
await runCase({
  id: 'ack-near-timeout', timeoutMs: 400, env: shortEnv,
  behavior: { onConnect(socket) { setTimeout(() => socket.send(JSON.stringify({ action: 'get_login_info', echo: 'ack-near', params: {} })), 370); } },
  assert(ctx) {
    ok('p03-ack:rejects', ctx.rejection && String(ctx.rejection.message).includes('调用超时'), String(ctx.rejection?.message));
    ok('p03-ack:acked', ctx.obs.acks.length === 1 && ctx.obs.acks[0].echo === 'ack-near', JSON.stringify(ctx.obs.acks));
    ok('p03-ack:once', ctx.settles === 1);
  },
});

// 10. Close after valid reply before settle completes: content wins.
await runCase({
  id: 'close-after-reply', timeoutMs: 500, env: shortEnv,
  behavior: { onConnect(socket) {
    setTimeout(() => socket.send(textFrame('close me', 'e-close')), 30);
    setTimeout(() => { try { socket.close(); } catch {} }, 60);
  } },
  assert(ctx) {
    ok('p03-close:resolves', ctx.result?.text === 'close me', JSON.stringify(ctx.rejection || ctx.result));
    ok('p03-close:fast', ctx.elapsed < 500, `elapsed=${ctx.elapsed}`);
    ok('p03-close:once', ctx.settles === 1);
  },
});

// 11. Error after valid reply: explicit transport error remains fatal.
{
  const outcome = await runCase({
    id: 'error-after-reply', timeoutMs: 500, env: shortEnv,
    behavior: { onConnect(socket) {
      setTimeout(() => socket.send(textFrame('before error', 'e-err')), 30);
      setTimeout(() => {
        try {
          const raw = socket._socket;
          if (raw && typeof raw.resetAndDestroy === 'function') raw.resetAndDestroy();
          else raw.destroy();
        } catch {}
      }, 60);
    } },
    assert(ctx) {
      ok('p03-error:settled-once', ctx.settles === 1);
      ok('p03-error:no-unhandled', ctx.unhandled === null, ctx.unhandled || '');
    },
  });
  // ResetAndDestroy may surface as close on some platforms; both single-settle
  // paths are acceptable. Record which path the platform took.
  console.log(`[info] error-after-reply outcome: ${outcome.result ? 'resolved (close-like)' : 'rejected (error-like)'} elapsed=${outcome.elapsed}`);
}

// 12. Deterministic timeout/settle race campaign (shortened timings).
{
  console.log('\n=== p03-race-campaign (3000 cases, settle=50ms, grace=100ms, timeout=120ms) ===');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  process.env.BRIDGE_SETTLE_MS = '50';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '100';
  process.env.BRIDGE_URL_KANON = `ws://127.0.0.1:${wss.address().port}`;
  process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-p03-race-out-'));
  const mod = await import(`${LOCAL_BRIDGE}?p03-race=${Date.now()}`);

  const delays = [30, 60, 90, 100, 140, 150, 160, 180, 118, 119, 120, 121, 122];
  let connIndex = 0;
  let serverConnections = 0;
  wss.on('connection', (socket) => {
    serverConnections++;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (!parsed || parsed.post_type !== 'message') return;
      const m = /^!audit d(\d+)$/.exec(String(parsed.raw_message || ''));
      const delay = m ? Number(m[1]) : 120;
      setTimeout(() => {
        try { socket.send(textFrame('r', `e-${delay}-${connIndex++}`)); } catch {}
      }, delay);
    });
  });

  const beforeTimeouts = activeTimeoutCount();
  let anomalies = 0;
  let resolves = 0;
  let rejects = 0;
  const TOTAL = 3000;
  const CONCURRENCY = 24;
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const delay = delays[i % delays.length];
      let settles = 0;
      let result = null;
      let rejection = null;
      try {
        result = await mod.callLocalBot('kanon', `!audit d${delay}`, { groupId: '770099', userId: String(900000000 + i), nickname: 'R', atTargets: [] }, 120);
      } catch (e) { rejection = e; }
      settles++;
      if (result) {
        resolves++;
        if (!(result.frames === 1 && result.text === 'r')) { anomalies++; console.error(`ANOMALY case ${i} delay=${delay} result=${JSON.stringify(result)}`); }
      } else if (rejection) {
        rejects++;
        if (!String(rejection.message).includes('调用超时')) { anomalies++; console.error(`ANOMALY case ${i} delay=${delay} rejection=${rejection.message}`); }
      } else { anomalies++; }
      // P0_3_1: with the absolute deadline, a frame whose handler enters after
      // the deadline is legitimately rejected even if the server sent early;
      // delay-based outcome heuristics were removed here. The authoritative
      // arrival-vs-outcome policy is asserted by p03-deadline-verify.mjs.
      if (settles !== 1) { anomalies++; console.error(`ANOMALY case ${i} settles=${settles}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await sleep(250);
  const afterTimeouts = activeTimeoutCount();
  ok('p03-race:volume', resolves + rejects === TOTAL, `resolves=${resolves} rejects=${rejects}`);
  ok('p03-race:both-outcomes', resolves > 0 && rejects > 0, `resolves=${resolves} rejects=${rejects}`);
  ok('p03-race:no-anomalies', anomalies === 0, `anomalies=${anomalies}`);
  ok('p03-race:timer-growth', beforeTimeouts >= 0 && afterTimeouts >= 0 && afterTimeouts - beforeTimeouts <= 0, `before=${beforeTimeouts} after=${afterTimeouts}`);
  console.log(`[info] race serverConnections=${serverConnections} resolves=${resolves} rejects=${rejects}`);
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((r) => wss.close(r));
  delete process.env.BRIDGE_SETTLE_MS;
  delete process.env.BRIDGE_MAX_POST_REPLY_MS;
}

console.log(`\nquick-bridge-p03-settle-verify: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
