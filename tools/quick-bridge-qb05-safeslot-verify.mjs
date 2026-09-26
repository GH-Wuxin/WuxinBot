// quick-bridge-qb05-safeslot-verify.mjs
// Implementation regression for QUICK_BRIDGE_QB05 final spec A'
// (deterministic safe-slot allocator) against server/bots/localBridge.ts.
//
// Phases (each runs in a fresh child process for module-state isolation):
//   unit                  - injected-clock allocator: 100 unique safe slots,
//                           101st fails, next pool resumes, leading-zero
//                           disjointness (constructed collision impossible),
//                           rollback fail-safe + recovery without slot reuse.
//   blackbox              - real callLocalBot against a synthetic WS server:
//                           100 allocations -> WS events carry safe-slot times;
//                           101st rejects BEFORE any WebSocket; next pool
//                           resumes and connects again.
//   fallback-quickrouter  - quickRouter catches allocator failure and falls
//                           back (no throw, no bridge traffic).
//   fallback-executor     - executor recent catches allocator failure and
//                           continues into its internal fallback (mocked osu API).
//   live                  - exactly TWO real Yumu bridge calls in one wall
//                           second with different fast commands; both events
//                           carry 13-digit safe-slot times and both reply.
//
// No Tencent traffic; live exhaustion is NOT performed (offline only).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(path.join('G:/QQ-AI-ChatBot', 'package.json'));
const REPO = 'G:/QQ-AI-ChatBot';
const SELF = fileURLToPath(import.meta.url);
const LOCAL_BRIDGE_URL = pathToFileURL(path.join(REPO, 'server/bots/localBridge.ts')).href;
const QUICK_ROUTER_URL = pathToFileURL(path.join(REPO, 'server/bot/quickRouter.ts')).href;
const EXECUTOR_URL = pathToFileURL(path.join(REPO, 'server/bots/executor.ts')).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (t, g, u) => `${String(t)}${String(g)}${String(u)}`;

function findRealSplits(time, groupId, userId) {
  const S = keyOf(time, groupId, userId);
  const L = S.length;
  const hits = [];
  for (let gl = 1; gl <= 10; gl++) {
    const ul = L - 10 - gl;
    if (ul < 1 || ul > 10) continue;
    const g = S.slice(10, 10 + gl);
    const u = S.slice(10 + gl);
    if (g[0] !== '0' && u[0] !== '0') hits.push({ G: g, U: u, gl, ul });
  }
  return hits;
}

const phase = process.env.QB05_PHASE || '';
let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// unit phase: deterministic injected-clock tests against the real allocator
// ---------------------------------------------------------------------------
if (phase === 'unit') {
  const { yumuSafeTimeMs } = await import(LOCAL_BRIDGE_URL);
  const W = 1_786_861_450_000; // 13-digit epoch-ms, aligned to a second boundary

  {
    const times = [];
    let monotonic = true;
    for (let i = 0; i < 100; i++) {
      const t = yumuSafeTimeMs(W);
      times.push(t);
      if (String(t).length !== 13) monotonic = false;
      if (t % 1000 < 0 || t % 1000 > 99) monotonic = false;
      if (i > 0 && t <= times[i - 1]) monotonic = false;
    }
    ok('unit:100-slots', monotonic && new Set(times).size === 100, `first=${times[0]} last=${times[99]}`);
    ok('unit:slots-0-99', times[0] % 1000 === 0 && times[99] % 1000 === 99, `${times[0] % 1000}..${times[99] % 1000}`);
    ok('unit:same-pool-second', Math.floor(times[0] / 1000) === Math.floor(times[99] / 1000), String(Math.floor(times[0] / 1000)));

    let exhaustion = null;
    try { yumuSafeTimeMs(W); } catch (e) { exhaustion = String(e.message); }
    ok('unit:101st-fails', Boolean(exhaustion) && exhaustion.includes('safe-slot pool exhausted'), exhaustion || 'no throw');

    const next = yumuSafeTimeMs(W + 1);
    ok('unit:next-pool-resumes', next % 1000 === 0 && next > times[99], `next=${next}`);

    // Leading-zero disjointness: char 11 is '0' for every allocated value and
    // the Candidate-A constructed collision is unreachable.
    let disjoint = true;
    for (const t of [...times, next]) {
      if (String(t).charAt(10) !== '0') disjoint = false;
      if (keyOf(t, 770099, 900000099) === keyOf(1786861450, 123770099, 900000099)) disjoint = false;
      for (const u of ['900000', '9000000', '90000009', '900000099', '9000000099']) {
        if (findRealSplits(t, '770099', u).length > 0) disjoint = false;
      }
    }
    ok('unit:constructed-collision-impossible', disjoint, 'A-prime keys never equal the 13/10-digit constructed real key');

    // Wall-clock rollback: fail safely (ordinary Error, no slot reuse), then
    // recover into the same watermark pool with only new slots.
    let rollbackError = null;
    try { yumuSafeTimeMs(W - 5000); } catch (e) { rollbackError = String(e.message); }
    ok('unit:rollback-fails-safe', Boolean(rollbackError) && rollbackError.includes('safe-slot pool exhausted'), rollbackError || 'no throw');

    const emittedAfterRollback = [];
    let recovered = null;
    for (let w = W - 4999; w <= W + 1500; w++) {
      try { recovered = yumuSafeTimeMs(w); emittedAfterRollback.push(recovered); } catch { /* still behind watermark or pool exhausted */ }
    }
    const noReuse = emittedAfterRollback.every((t, i) => i === 0 || t > emittedAfterRollback[i - 1])
      && emittedAfterRollback.every((t) => t > next);
    ok('unit:rollback-recovers-no-reuse', recovered !== null && noReuse, `recovered=${recovered} emitted=${emittedAfterRollback.length}`);

    // Drift stays inside the pool window; the 30s cap is defensive policy and
    // mathematically dominated by the 2000..3098ms safe-slot window.
    let windowOk = true;
    for (let w = W + 10_000; w < W + 13_000; w += 7) {
      try {
        const t = yumuSafeTimeMs(w);
        const margin = t - w;
        if (margin < 2000 || margin > 3098) windowOk = false;
      } catch { /* pool exhaustion while sweeping is expected and safe */ }
    }
    ok('unit:future-window-bounded', windowOk, 'every emitted slot keeps a 2000..3098ms future window');
  }

  console.log(`unit phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// blackbox phase: callLocalBot 100+1 against a synthetic WS server
// ---------------------------------------------------------------------------
if (phase === 'blackbox') {
  const { WebSocketServer } = require('ws');
  const timelineDir = process.env.QB05_TIMELINE_DIR;
  process.env.BRIDGE_TIMELINE = '1';
  process.env.BRIDGE_TIMELINE_DIR = timelineDir;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  process.env.BRIDGE_URL_YUMU = `ws://127.0.0.1:${wss.address().port}`;

  const { callLocalBot } = await import(LOCAL_BRIDGE_URL);

  const conn = { count: 0, inbound: [] };
  wss.on('connection', (socket) => {
    conn.count++;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed && parsed.post_type === 'message') {
        conn.inbound.push(parsed);
        try { socket.close(1000, 'qb05-safeslot-verifier'); } catch {}
      }
    });
  });

  // Wait for a fresh pool so all 100 allocations land in one pool second.
  const poolOf = (now) => Math.ceil((now + 2000) / 1000);
  const p0 = poolOf(Date.now());
  while (poolOf(Date.now()) === p0) await sleep(5);

  const results = [];
  for (let i = 0; i < 100; i++) results.push(callLocalBot(
    'yumu', `!probe ${i}`, { groupId: '770099', userId: '900000099', nickname: 'QB05Blackbox', atTargets: [] }, 5000,
  ));
  const settled = await Promise.allSettled(results);
  const allocRejections = settled.filter((r) => r.status === 'rejected').length;

  let exhaustError = null;
  try {
    await callLocalBot('yumu', '!probe 101', { groupId: '770099', userId: '900000099', nickname: 'QB05Blackbox', atTargets: [] }, 5000);
  } catch (e) { exhaustError = String(e.message); }
  await sleep(250);

  ok('blackbox:100-allocations-reject-later', settled.length === 100 && allocRejections === 100, `settled=${allocRejections}`);
  ok('blackbox:101st-fails-before-ws', Boolean(exhaustError) && exhaustError.includes('safe-slot pool exhausted'), exhaustError || 'no throw');
  ok('blackbox:no-ws-for-101st', conn.count === 100 && conn.inbound.length === 100, `connections=${conn.count} inbound=${conn.inbound.length}`);

  const times = conn.inbound.map((e) => Number(e.time));
  const safe = times.length === 100
    && times.every((t) => String(t).length === 13 && t % 1000 >= 0 && t % 1000 <= 99)
    && new Set(times).size === 100;
  const fieldsOk = conn.inbound.every((e) =>
    Number(e.group_id) === 770099
    && Number(e.user_id) === 900000099
    && Number(e.sender?.user_id) === 900000099
    && String(e.self_id).startsWith('88'));
  ok('blackbox:events-safe-slot-and-fields', safe && fieldsOk, safe && fieldsOk ? `${times[0]}..${times[99]}` : JSON.stringify(times.slice(0, 2)));

  // Timeline: 101st timeline id has no ws_construction_start stage.
  const lines = readTimeline(timelineDir);
  const allocated = lines.filter((l) => l.kind === 'stage' && l.stage === 'yumu_safe_slot_allocated');
  const failedFinishes = lines.filter((l) => l.kind === 'finish' && l.meta?.endReason === 'yumu_safe_slot_alloc_failed');
  ok('blackbox:timeline-100-allocated', allocated.length === 100, `allocated=${allocated.length}`);
  ok('blackbox:timeline-one-alloc-failed', failedFinishes.length === 1, `failed=${failedFinishes.length}`);
  if (failedFinishes.length === 1) {
    const id = failedFinishes[0].timelineId;
    const stages = lines.filter((l) => l.timelineId === id && l.kind === 'stage').map((l) => l.stage);
    ok('blackbox:failed-call-has-no-ws-stage', !stages.includes('ws_construction_start'), stages.join(','));
  }

  // Next pool resumes successfully and reconnects.
  const p1 = poolOf(Date.now());
  while (poolOf(Date.now()) === p1) await sleep(5);
  let nextRejection = null;
  try { await callLocalBot('yumu', '!probe next-pool', { groupId: '770099', userId: '900000099', nickname: 'QB05Blackbox', atTargets: [] }, 5000); }
  catch (e) { nextRejection = String(e.message); }
  await sleep(250);
  ok('blackbox:next-pool-resumes', conn.count === 101 && conn.inbound.length === 101, `connections=${conn.count} inbound=${conn.inbound.length} rejection=${nextRejection}`);
  const nextTime = conn.inbound[100]?.time;
  ok('blackbox:next-pool-safe', nextTime !== undefined && String(nextTime).length === 13 && Number(nextTime) % 1000 <= 99, String(nextTime));

  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((r) => wss.close(r));
  console.log(`blackbox phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// fallback-quickrouter phase
// ---------------------------------------------------------------------------
if (phase === 'fallback-quickrouter') {
  const timelineDir = process.env.QB05_TIMELINE_DIR;
  process.env.BRIDGE_TIMELINE = '1';
  process.env.BRIDGE_TIMELINE_DIR = timelineDir;
  process.env.DATA_DIR = process.env.QB05_DATA_DIR;
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  process.env.BRIDGE_URL_YUMU = `ws://127.0.0.1:${wss.address().port}`;

  const { ensureStore, updateDb } = await import(pathToFileURL(path.join(REPO, 'server/store.ts')).href);
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.settings.llmProvider = 'fixture';
    db.settings.apiKey = 'fixture-key';
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.groups = [{ groupId: '770001', name: 'QB05Group', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 }];
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['770001'] = {};
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
  });

  const { matchQuickCommand, handleQuickCommand } = await import(QUICK_ROUTER_URL);
  const { yumuSafeTimeMs } = await import(LOCAL_BRIDGE_URL);

  let connCount = 0;
  wss.on('connection', () => { connCount++; });

  // Exhaust the pool through the exact module instance quickRouter uses.
  for (let i = 0; i < 100; i++) yumuSafeTimeMs();

  const event = {
    source: 'onebot', type: 'group', messageId: 'qb05-fb-' + Math.random().toString(36).slice(2, 10),
    groupId: '770001', userId: '10001', nickname: 'FallbackTester', text: '!pm', atTargets: [], images: [], raw: {},
  };
  const sent = [];
  const result = await handleQuickCommand(
    event,
    async (_e, text) => { sent.push(String(text)); },
    (await import(pathToFileURL(path.join(REPO, 'server/store.ts')).href)).readDb(),
    matchQuickCommand(event),
    { isOwner: true, isAdmin: true },
  );

  ok('quickrouter:catches-allocator-failure', result && result.handled === false && result.reason === 'quick_unimplemented:pm', JSON.stringify(result));
  ok('quickrouter:no-bridge-traffic', connCount === 0, `connections=${connCount}`);
  ok('quickrouter:no-unexpected-send', sent.length === 0, JSON.stringify(sent));

  const lines = readTimeline(timelineDir);
  const failedFinishes = lines.filter((l) => l.kind === 'finish' && l.meta?.endReason === 'yumu_safe_slot_alloc_failed');
  ok('quickrouter:timeline-alloc-failed', failedFinishes.length === 1, `failed=${failedFinishes.length}`);
  if (failedFinishes.length === 1) {
    const stages = lines.filter((l) => l.timelineId === failedFinishes[0].timelineId && l.kind === 'stage').map((l) => l.stage);
    ok('quickrouter:no-ws-stage-on-failure', !stages.includes('ws_construction_start'), stages.join(','));
  }

  await new Promise((r) => wss.close(r));
  console.log(`fallback-quickrouter phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// fallback-executor phase
// ---------------------------------------------------------------------------
if (phase === 'fallback-executor') {
  const timelineDir = process.env.QB05_TIMELINE_DIR;
  process.env.BRIDGE_TIMELINE = '1';
  process.env.BRIDGE_TIMELINE_DIR = timelineDir;
  process.env.DATA_DIR = process.env.QB05_DATA_DIR;
  process.env.OSU_TOKEN_URL = 'http://offline.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://offline.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-client-id';
  process.env.OSU_CLIENT_SECRET = 'offline-client-secret';
  process.env.BRIDGE_URL_YUMU = 'ws://127.0.0.1:1'; // never contacted: allocation fails first

  // Replace global fetch with an in-process stub so the executor fallback
  // (user + recent score) needs no sockets and the phase exits cleanly on
  // Windows/Node24 (the repo's known UV_HANDLE_CLOSING teardown flake).
  const apiHits = { token: 0, user: 0, recent: 0 };
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    const json = async (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('/oauth/token')) {
      apiHits.token++;
      return json({ access_token: 'offline-token', token_type: 'Bearer', expires_in: 86400 });
    }
    if (url.includes('/users/1234567/scores/recent')) {
      apiHits.recent++;
      return json([{
        rank: 'S', accuracy: 98.76, max_combo: 100, pp: 123.4, mods: [],
        beatmap: { id: 123, title: 'Test Song', version: 'fixture', beatmapset: { title: 'Test Song' } }, score: 1_000_000,
      }]);
    }
    if (url.includes('/users/1234567/osu')) {
      apiHits.user++;
      return json({ id: 1234567, username: '[TST]Alpha', statistics: { play_time: 0 } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const { ensureStore, updateDb } = await import(pathToFileURL(path.join(REPO, 'server/store.ts')).href);
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
  });

  const { executeInternalBotCommand } = await import(EXECUTOR_URL);
  const { yumuSafeTimeMs } = await import(LOCAL_BRIDGE_URL);
  for (let i = 0; i < 100; i++) yumuSafeTimeMs();

  let result = null;
  let thrown = null;
  try {
    result = await executeInternalBotCommand(
      'yumu', 'recent', '',
      { db: (await import(pathToFileURL(path.join(REPO, 'server/store.ts')).href)).readDb(), userId: '10001', groupId: '770099', isOwner: true },
      undefined, undefined, null,
    );
  } catch (e) { thrown = e; }

  const text = typeof result === 'string' ? result : String(result?.content || '');
  ok('executor:catches-allocator-failure', thrown === null && text.includes('Test Song'), `thrown=${String(thrown?.message || '')} text=${text.slice(0, 80)}`);
  ok('executor:internal-fallback-executed', apiHits.token === 1 && apiHits.user === 1 && apiHits.recent === 1, JSON.stringify(apiHits));
  ok('executor:allocator-error-not-leaked', !text.includes('safe-slot pool exhausted') && !String(thrown?.message || '').includes('safe-slot pool exhausted'), text.slice(0, 80));

  const lines = readTimeline(timelineDir);
  const failedFinishes = lines.filter((l) => l.kind === 'finish' && l.meta?.endReason === 'yumu_safe_slot_alloc_failed');
  ok('executor:timeline-alloc-failed', failedFinishes.length === 1, `failed=${failedFinishes.length}`);

  console.log(`fallback-executor phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// live phase: exactly two real Yumu calls in one wall second
// ---------------------------------------------------------------------------
if (phase === 'live') {
  const timelineDir = process.env.QB05_TIMELINE_DIR;
  process.env.BRIDGE_TIMELINE = '1';
  process.env.BRIDGE_TIMELINE_DIR = timelineDir;
  const { callLocalBot } = await import(LOCAL_BRIDGE_URL);

  const ctx = { groupId: '770099', userId: '900000099', nickname: 'QB05Live', atTargets: [] };
  const callA = callLocalBot('yumu', '!ymd20', ctx, 15000);
  const callB = callLocalBot('yumu', '!ymd6', ctx, 15000);
  const [ra, rb] = await Promise.allSettled([callA, callB]);

  ok('live:call1-replied', ra.status === 'fulfilled' && ra.value.frames >= 1, ra.status === 'fulfilled' ? `text=${ra.value.text} frames=${ra.value.frames}` : String(ra.reason?.message || ra.reason));
  ok('live:call2-replied', rb.status === 'fulfilled' && rb.value.frames >= 1, rb.status === 'fulfilled' ? `text=${rb.value.text} frames=${rb.value.frames}` : String(rb.reason?.message || rb.reason));

  const lines = readTimeline(timelineDir);
  const allocated = lines.filter((l) => l.kind === 'stage' && l.stage === 'yumu_safe_slot_allocated')
    .map((l) => Number(l.meta?.eventTimeMs));
  ok('live:exactly-two-events', allocated.length === 2, `allocated=${allocated.length}`);
  ok('live:safe-slot-times', allocated.length === 2 && allocated.every((t) => String(t).length === 13 && t % 1000 >= 0 && t % 1000 <= 99), JSON.stringify(allocated));
  ok('live:same-pool-second-distinct', allocated.length === 2 && Math.floor(allocated[0] / 1000) === Math.floor(allocated[1] / 1000) && allocated[0] !== allocated[1], JSON.stringify(allocated));
  const opens = lines.filter((l) => l.kind === 'stage' && l.stage === 'ws_open').length;
  const commands = lines.filter((l) => l.kind === 'stage' && l.stage === 'command_sent').length;
  ok('live:both-entered-yumu', opens === 2 && commands === 2, `opens=${opens} commands=${commands}`);

  console.log(`live phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// parent: run each phase in a fresh child process
// ---------------------------------------------------------------------------
function readTimeline(dir) {
  const file = path.join(dir || '', 'bridge-timeline.jsonl');
  if (!dir || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const phases = [
  ['unit', {}],
  ['blackbox', {}],
  ['fallback-quickrouter', {}],
  ['fallback-executor', {}],
  ...(process.env.QB05_SKIP_LIVE === '1' ? [] : [['live', {}]]),
];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qb05-safeslot-'));
let totalPassed = 0;
let totalFailed = 0;
const phaseResults = [];

for (const [name] of phases) {
  const timelineDir = path.join(base, name);
  const dataDir = path.join(base, `${name}-data`);
  fs.mkdirSync(timelineDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    QB05_PHASE: name,
    QB05_TIMELINE_DIR: timelineDir,
    QB05_DATA_DIR: dataDir,
  };
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO, env, stdio: 'inherit', shell: false, timeout: 120_000,
  });
  const okPhase = r.status === 0 && !r.error;
  phaseResults.push({ name, ok: okPhase, status: r.status, error: r.error?.message });
  if (okPhase) totalPassed++; else totalFailed++;
  console.log(`PHASE ${name}: ${okPhase ? 'PASS' : 'FAIL'} (exit ${r.status ?? '?'}${r.error ? ` ${r.error.message}` : ''})`);
}

console.log(`\nquick-bridge-qb05-safeslot-verify: ${totalPassed}/${phases.length} phases passed`);
console.log(JSON.stringify({ phases: phaseResults, base }, null, 2));
process.exit(totalFailed ? 1 : 0);
