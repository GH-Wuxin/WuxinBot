// quick-bridge-qb03-policy-verify.mjs
// Offline policy-evaluation harness for QUICK_BRIDGE_QB03_POLICY_AUDIT_V01.
// It does NOT change production behavior. It runs the current callLocalBot
// against a synthetic silent/noise/delayed matrix, records each outcome, and
// then evaluates hypothetical no-first-frame watchdog thresholds against the
// observed successes to show which thresholds would produce false negatives.
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

async function runCase({ id, timeoutMs, behavior, env = {} }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  process.env.BRIDGE_URL_KANON = `ws://127.0.0.1:${wss.address().port}`;
  process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb03-policy-out-'));
  const mod = await import(`${LOCAL_BRIDGE}?qb03=${encodeURIComponent(id)}-${Date.now()}`);

  const obs = { acks: [], sentAt: [], inbound: null };
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed && parsed.post_type === 'message' && !obs.inbound) obs.inbound = parsed;
      else if (parsed && parsed.echo !== undefined && (parsed.status !== undefined || parsed.retcode !== undefined)) obs.acks.push(parsed);
    });
    if (behavior && behavior.onConnect) behavior.onConnect(socket, obs);
  });

  let settles = 0;
  const t0 = Date.now();
  const promise = mod.callLocalBot('kanon', '!audit', { groupId: '770099', userId: '900000099', nickname: 'QB03', atTargets: [] }, timeoutMs);
  promise.then(() => { settles++; }).catch(() => { settles++; });
  let result = null;
  let rejection = null;
  try { result = await promise; } catch (e) { rejection = e; }
  const elapsed = Date.now() - t0;
  await sleep(80);
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((r) => wss.close(r));
  for (const [k] of Object.entries(env)) delete process.env[k];
  return { id, timeoutMs, result, rejection: rejection ? String(rejection.message || rejection) : null, elapsed, settles, obs };
}

const textFrame = (text, echo) => JSON.stringify({ action: 'send_msg', echo, params: { message: text } });
const results = [];

// 1-3. Silent states.
results.push(await runCase({ id: 'open-zero-frames', timeoutMs: 1200, behavior: {} }));
results.push(await runCase({ id: 'ack-only', timeoutMs: 1200, behavior: { onConnect(socket) { setTimeout(() => socket.send(JSON.stringify({ action: 'get_login_info', echo: 'a1', params: {} })), 150); } } }));
results.push(await runCase({ id: 'unrelated-frames', timeoutMs: 1200, behavior: { onConnect(socket) { setTimeout(() => socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 })), 150); } } }));

// 4-9. Delayed valid replies (10x accelerated: 100ms->1s, 500->5s, 1000->10s,
// 2000->20s, 3000->30s, 3900->~40s before a 4000ms timeout).
for (const [label, atMs, timeoutMs] of [
  ['delayed-1s', 100, 4000],
  ['delayed-5s', 500, 4000],
  ['delayed-10s', 1000, 4000],
  ['delayed-20s', 2000, 4000],
  ['delayed-30s', 3000, 4000],
  ['just-before-timeout', 3900, 4000],
]) {
  results.push(await runCase({
    id: label, timeoutMs,
    behavior: { onConnect(socket, obs) {
      setTimeout(() => { obs.sentAt.push(Date.now()); socket.send(textFrame('valid', `e-${label}`)); }, atMs);
    } },
  }));
}

// 10-13. Terminal/error/malformed/repeated-noise states.
results.push(await runCase({ id: 'silent-close', timeoutMs: 1200, behavior: { onConnect(socket) { setTimeout(() => { try { socket.close(); } catch {} }, 60); } } }));
results.push(await runCase({ id: 'error', timeoutMs: 1200, behavior: { onConnect(socket) { setTimeout(() => { try { socket._socket.destroy(new Error('boom')); } catch {} }, 60); } } }));
results.push(await runCase({ id: 'malformed-frames', timeoutMs: 1200, behavior: { onConnect(socket) { setTimeout(() => socket.send('not json {'), 80); setTimeout(() => { try { socket.close(); } catch {} }, 160); } } }));
results.push(await runCase({ id: 'repeated-unrelated', timeoutMs: 1500, behavior: { onConnect(socket) {
  const timer = setInterval(() => { try { socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1 })); } catch {} }, 120);
  setTimeout(() => clearInterval(timer), 1400);
} } }));
results.push(await runCase({ id: 'repeated-ack-like', timeoutMs: 1500, behavior: { onConnect(socket) {
  let n = 0;
  const timer = setInterval(() => { try { socket.send(JSON.stringify({ action: 'get_status', echo: `a${n++}`, params: {} })); } catch {} }, 120);
  setTimeout(() => clearInterval(timer), 1400);
} } }));

const silentIds = new Set(['open-zero-frames', 'ack-only', 'unrelated-frames', 'repeated-unrelated', 'repeated-ack-like']);
const terminalIds = new Set(['silent-close', 'malformed-frames']);
for (const r of results) {
  const name = `qb03-${r.id}`;
  if (r.id.startsWith('delayed-') || r.id === 'just-before-timeout') {
    ok(`${name}:resolves`, r.result?.text === 'valid' && r.rejection === null, JSON.stringify(r));
    ok(`${name}:settles-once`, r.settles === 1, `settles=${r.settles}`);
  } else if (silentIds.has(r.id)) {
    ok(`${name}:rejects-timeout`, r.result === null && r.rejection?.includes('调用超时'), JSON.stringify(r));
    ok(`${name}:settles-once`, r.settles === 1, `settles=${r.settles}`);
  } else if (terminalIds.has(r.id)) {
    ok(`${name}:rejects-no-reply`, r.result === null && r.rejection !== null, JSON.stringify(r));
    ok(`${name}:settles-once`, r.settles === 1, `settles=${r.settles}`);
  } else if (r.id === 'error') {
    // On Windows the synthetic error may surface as close-like resolve; the
    // important invariant is exactly-one settlement.
    ok(`${name}:settles-once`, r.settles === 1, JSON.stringify(r));
    console.log(`[info] ${name}: ${r.result ? 'resolved (close-like)' : 'rejected (error-like)'} elapsed=${r.elapsed}`);
  }
}

// Hypothetical no-first-frame watchdog evaluation against observed successes.
// Thresholds are the 10x-accelerated equivalents of 5s/10s/15s/30s.
const thresholds = { '5s': 500, '10s': 1000, '15s': 1500, '30s': 3000 };
const successRows = results.filter((r) => r.result && (r.id.startsWith('delayed-') || r.id === 'just-before-timeout'));
const policyEvaluation = successRows.map((r) => {
  const firstFrameApprox = Number(r.id.match(/delayed-(\d+)s/)?.[1]) * 100 || (r.id === 'just-before-timeout' ? 3900 : 0);
  const killedBy = Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, firstFrameApprox > v]));
  return { case: r.id, firstFrameApproxMs: firstFrameApprox, resolved: Boolean(r.result), killedBy };
});
console.log('\n[policy] hypothetical no-first-frame watchdog evaluation (accelerated 10x):');
console.log(JSON.stringify(policyEvaluation, null, 2));

// Deterministic assertions on the evaluation table.
const byCase = Object.fromEntries(policyEvaluation.map((row) => [row.case, row]));
ok('qb03-policy:1s-safe-for-all-watchdogs', byCase['delayed-1s'] && Object.values(byCase['delayed-1s'].killedBy).every((v) => v === false));
ok('qb03-policy:5s-boundary-not-killed', byCase['delayed-5s']?.killedBy['5s'] === false && byCase['delayed-5s']?.killedBy['10s'] === false);
ok('qb03-policy:10s-killed-by-5s-only', byCase['delayed-10s']?.killedBy['5s'] === true && byCase['delayed-10s']?.killedBy['10s'] === false);
ok('qb03-policy:20s-killed-by-5s-10s-15s', byCase['delayed-20s']?.killedBy['5s'] === true && byCase['delayed-20s']?.killedBy['10s'] === true && byCase['delayed-20s']?.killedBy['15s'] === true && byCase['delayed-20s']?.killedBy['30s'] === false);
ok('qb03-policy:30s-boundary-not-killed-by-30s', byCase['delayed-30s']?.killedBy['30s'] === false);
ok('qb03-policy:just-before-timeout-killed-by-all-simple-watchdogs', byCase['just-before-timeout'] && Object.values(byCase['just-before-timeout'].killedBy).every((v) => v === true));

const before = activeTimeoutCount();
console.log(`\nquick-bridge-qb03-policy-verify: ${passed} passed, ${failed} failed (timer count=${before})`);
process.exit(failed > 0 ? 1 : 0);
