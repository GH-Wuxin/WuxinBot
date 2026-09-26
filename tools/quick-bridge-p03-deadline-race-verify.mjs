// quick-bridge-p03-deadline-race-verify.mjs
// Offline 2,000-case race campaign for QUICK_BRIDGE_FIX_P0_3_1.
// Runs in its own process so bridgeTimeline is enabled from first import:
// every synthetic bridge call records its logical arrival classification
// (valid_reply_accepted vs late_reply_ignored_for_deadline) and its final
// outcome. The assertion is that outcome always matches the recorded logical
// classification, independent of timeout-callback scheduling order.
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

const tlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-p031-race-tl-'));
process.env.BRIDGE_SETTLE_MS = '50';
process.env.BRIDGE_MAX_POST_REPLY_MS = '100';
process.env.BRIDGE_TIMELINE = '1';
process.env.BRIDGE_TIMELINE_DIR = tlDir;
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.once('listening', r));
process.env.BRIDGE_URL_KANON = `ws://127.0.0.1:${wss.address().port}`;
process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-p031-race-out-'));
const mod = await import(`${LOCAL_BRIDGE}?p031-race=${Date.now()}`);

// Delay ONLY the bridge's 120ms no-reply timer by 15ms so late frames get a
// chance to be processed by the message handler before the timeout callback.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, delay, ...args) {
  if (typeof delay === 'number' && delay === 120) return realSetTimeout(fn, delay + 15, ...args);
  return realSetTimeout(fn, delay, ...args);
};

const TOTAL = 2000;
// Arrival classes relative to the 120ms no-reply deadline (server timers
// start ~10ms after connection): <=110 arrive before the deadline; 115-125
// arrive after the deadline but before the delayed 135ms timeout callback;
// >=130 usually arrive after the timeout fires.
const delays = [60, 80, 90, 95, 100, 105, 110, 115, 116, 118, 119, 120, 125, 130, 150];
wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let parsed = null;
    try { parsed = JSON.parse(String(data)); } catch {}
    if (!parsed || parsed.post_type !== 'message') return;
    const m = /^!audit o(\d+)$/.exec(String(parsed.raw_message || ''));
    const delay = m ? Number(m[1]) : 120;
    setTimeout(() => {
      try { socket.send(JSON.stringify({ action: 'send_msg', echo: `e-${delay}`, params: { message: 'r' } })); } catch {}
    }, delay);
  });
});

const beforeTimeouts = activeTimeoutCount();
const results = new Array(TOTAL);
let next = 0;
const CONCURRENCY = 8;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= TOTAL) return;
    const delay = delays[i % delays.length];
    let settles = 0;
    const promise = mod.callLocalBot('kanon', `!audit o${delay}`, { groupId: '770099', userId: String(910000000 + i), nickname: 'R', atTargets: [] }, 120);
    promise.then(() => { settles++; }).catch(() => { settles++; });
    try {
      await promise;
      await Promise.resolve();
      results[i] = { kind: 'resolved', settles };
    } catch (e) {
      await Promise.resolve();
      results[i] = { kind: 'rejected', message: String(e?.message || e), settles };
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await sleep(250);
const afterTimeouts = activeTimeoutCount();
globalThis.setTimeout = realSetTimeout;

const tlPath = path.join(tlDir, 'bridge-timeline.jsonl');
const lines = fs.existsSync(tlPath) ? fs.readFileSync(tlPath, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
const byTimeline = new Map();
for (const line of lines) {
  const obj = JSON.parse(line);
  if (!byTimeline.has(obj.timelineId)) byTimeline.set(obj.timelineId, { accepted: false, lateIgnored: false, outcome: null, command: '' });
  const t = byTimeline.get(obj.timelineId);
  if (obj.kind === 'begin') t.command = obj.command || '';
  if (obj.kind === 'stage' && obj.stage === 'valid_reply_accepted') t.accepted = true;
  if (obj.kind === 'stage' && obj.stage === 'late_reply_ignored_for_deadline') t.lateIgnored = true;
  if (obj.kind === 'finish') t.outcome = obj.outcome || '';
}
const mismatches = [];
let accepted = 0;
let lateIgnored = 0;
for (const t of byTimeline.values()) {
  if (!t.command.includes('!audit o')) continue;
  if (t.accepted) { accepted++; if (t.outcome !== 'resolved') mismatches.push({ command: t.command, t }); }
  if (t.lateIgnored) { lateIgnored++; if (t.outcome !== 'rejected') mismatches.push({ command: t.command, t }); }
}
ok('p031-race:volume', byTimeline.size >= TOTAL * 0.9, `timelines=${byTimeline.size}`);
ok('p031-race:policy-match', mismatches.length === 0, JSON.stringify(mismatches.slice(0, 3)));
ok('p031-race:both-classes', accepted > 0 && lateIgnored > 0, `accepted=${accepted} lateIgnored=${lateIgnored}`);
ok('p031-race:rejections-clean', results.every((r) => r.kind === 'resolved' || String(r.message).includes('调用超时')));
const badSettles = results.filter((r) => r.settles !== 1).slice(0, 5);
ok('p031-race:exact-once', badSettles.length === 0, JSON.stringify(badSettles));
ok('p031-race:timer-cleanup', beforeTimeouts >= 0 && afterTimeouts >= 0 && afterTimeouts - beforeTimeouts <= 0, `before=${beforeTimeouts} after=${afterTimeouts}`);

for (const client of wss.clients) { try { client.terminate(); } catch {} }
await new Promise((r) => wss.close(r));
delete process.env.BRIDGE_SETTLE_MS;
delete process.env.BRIDGE_MAX_POST_REPLY_MS;
delete process.env.BRIDGE_TIMELINE;
delete process.env.BRIDGE_TIMELINE_DIR;
try { fs.rmSync(tlDir, { recursive: true, force: true }); } catch {}

console.log(`\nquick-bridge-p03-deadline-race-verify: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
