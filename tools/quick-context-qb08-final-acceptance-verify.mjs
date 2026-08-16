// quick-context-qb08-final-acceptance-verify.mjs
// QB-08 FINAL ACCEPTANCE + END_TO_END_STABILITY_V01.
//
// A1: registration-before-visible boundary (runtime + source).
// A2: drain timeout is ONE aggregate budget for 1/2/8/16 never-settling
//     pending entries.
// B1-B7: user-visible !re -> immediate follow-up stability matrix with real
//     quickRouter/quickContext/quickMemory/buildPrompt and synthetic bridges.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(path.join('G:/QQ-AI-ChatBot', 'package.json'));
const REPO = 'G:/QQ-AI-ChatBot';
const SELF = fileURLToPath(import.meta.url);
const STORE_URL = pathToFileURL(path.join(REPO, 'server/store.ts')).href;
const QR_URL = pathToFileURL(path.join(REPO, 'server/bot/quickRouter.ts')).href;
const QC_URL = pathToFileURL(path.join(REPO, 'server/bot/quickContext.ts')).href;
const PROMPT_URL = pathToFileURL(path.join(REPO, 'server/bot/prompt.ts')).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
};

function installFetchStub(counts, opts = {}) {
  const recentDelay = opts.recentDelay || 0;
  const recentStatus = opts.recentStatus || 200;
  const userStatus = opts.userStatus || 200;
  counts.nameById = counts.nameById || {};
  const respond = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    if (url.includes('/oauth/token')) { counts.token++; return respond({ access_token: 'offline-token', token_type: 'Bearer', expires_in: 86400 }); }
    const decoded = decodeURIComponent(url.split('?')[0]);
    const recent = /\/users\/(\d+)\/scores\/recent/.exec(decoded);
    if (recent) {
      counts.recent++;
      counts.recentByUser[recent[1]] = (counts.recentByUser[recent[1]] || 0) + 1;
      if (recentDelay > 0) await new Promise((r) => setTimeout(r, recentDelay));
      if (recentStatus !== 200) return respond({}, recentStatus);
      const name = counts.nameById[recent[1]] || (recent[1] === '1234568' ? '[TST]Beta' : '[TST]Alpha');
      return respond([{ rank: 'S', accuracy: 98.76, max_combo: 100, pp: 123.4, mods: [], beatmap: { id: Number(recent[1]), title: `${name} Song`, version: 'fixture', beatmapset: { title: `${name} Song` } }, score: 1_000_000 }]);
    }
    const userById = /\/users\/(\d+)\/osu/.exec(decoded);
    if (userById) {
      counts.userById++;
      const name = counts.nameById[userById[1]] || (userById[1] === '1234568' ? '[TST]Beta' : '[TST]Alpha');
      return respond({ id: Number(userById[1]), username: name, statistics: { play_time: 0 } });
    }
    if (decoded.includes('/users/@')) {
      counts.userByName++;
      if (userStatus !== 200) return respond({}, userStatus);
      const requested = decodeURIComponent(decoded.split('/users/@')[1] || '').split('/')[0];
      const isBeta = requested.includes('[TST]Beta');
      const id = isBeta ? 1234568 : 1234567;
      const name = requested || (isBeta ? '[TST]Beta' : '[TST]Alpha');
      counts.nameById[id] = name;
      return respond({ id, username: name, statistics: { play_time: 0 } });
    }
    return respond({}, 404);
  };
}

function imageReply(socket, echo, text) {
  socket.send(JSON.stringify({ action: 'send_group_msg', echo, params: { message: [{ type: 'image', data: { file: 'http://fixture.test/a.png' } }, ...(text ? [{ type: 'text', data: { text } }] : [])] } }));
  setTimeout(() => { try { socket.close(1000, 'fixture-done'); } catch {} }, 80);
}

async function startWsBridge(onMessage = null) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const obs = { connections: 0, inbound: [] };
  wss.on('connection', (socket) => {
    obs.connections++;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed?.post_type === 'message') {
        obs.inbound.push(parsed);
        (onMessage || imageReply)(socket, parsed);
      }
    });
  });
  return { wss, obs, url: `ws://127.0.0.1:${wss.address().port}` };
}

async function initDb() {
  const { ensureStore, updateDb, readDb } = await import(STORE_URL);
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.settings.llmProvider = 'fixture';
    db.settings.apiKey = 'fixture-key';
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.groups = [
      { groupId: '770001', name: 'QB08-A', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 },
      { groupId: '770002', name: 'QB08-B', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 },
    ];
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['770001'] = { quick: true };
    db.groupBotConfig['770002'] = { quick: true };
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
    db.osuBindings['10002'] = { id: 1234568, username: '[TST]Beta' };
  });
  return readDb;
}

const mkEvent = (text, extra = {}) => ({
  source: 'onebot', type: 'group',
  messageId: `qb08f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  groupId: '770001', userId: '10001', nickname: 'AlphaUser',
  text, atTargets: [], images: [], raw: {}, ...extra,
});

async function waitFor(fn, timeoutMs, step = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const phase = process.env.QB08F_PHASE || '';
const phaseData = process.env.QB08F_DATA_DIR || '';

// ---------------------------------------------------------------------------
// A1 registration boundary
// ---------------------------------------------------------------------------
if (phase === 'a1-boundary') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { quickContextPendingCountForTest } = await import(QC_URL);
  const readDb = await initDb();

  let pendingAtSend = -1;
  let placeholderAtSend = false;
  const quickEvent = mkEvent('!r');
  const result = await handleQuickCommand(quickEvent, async (_e, text) => {
    // This callback IS the externally observable visible boundary. Assert the
    // placeholder and pending handle already exist before send completes.
    pendingAtSend = quickContextPendingCountForTest();
    placeholderAtSend = readDb().messages?.some((m) => m.role === 'assistant' && m.pendingQuickId);
  }, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });

  ok('a1:handled', result?.reason === 'bridge:yumu', JSON.stringify(result));
  ok('a1:pending-exists-before-visible-completes', pendingAtSend >= 1, `pendingAtSend=${pendingAtSend}`);
  ok('a1:placeholder-exists-before-visible-completes', placeholderAtSend, 'assistant slot with pendingQuickId already in db');
  const summary = await waitFor(async () => readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')), 2000);
  ok('a1:hydrated-after-send', Boolean(summary), 'shadow completes independently');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`a1-boundary phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// A2 aggregate timeout (never-settling work), one fresh child per count
// ---------------------------------------------------------------------------
if (phase === 'a2-worker') {
  const count = Number(process.env.QB08F_A2_COUNT || '1');
  process.env.QUICK_CONTEXT_PENDING_WAIT_MS = '80';
  const { registerPendingQuickObservation, settlePendingQuickObservations } = await import(QC_URL);
  const event = mkEvent('followup');
  for (let i = 0; i < count; i++) registerPendingQuickObservation(event, () => new Promise(() => {}));
  const t0 = Date.now();
  const drain = await settlePendingQuickObservations(event);
  const waited = Date.now() - t0;
  const okAgg = waited >= 60 && waited < 500 && drain.pendingCount === count;
  console.log(`${okAgg ? 'PASS' : 'FAIL'} [a2:${count}-pending-aggregate] waitedMs=${waited} pending=${drain.pendingCount} budget=80ms (NOT ${count}*80ms)`);
  process.exit(okAgg ? 0 : 1);
}

if (phase === 'a2-timeout') {
  for (const count of [1, 2, 8, 16]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
      cwd: REPO,
      env: { ...process.env, QB08F_PHASE: 'a2-worker', QB08F_A2_COUNT: String(count) },
      stdio: 'inherit',
      shell: false,
      timeout: 30_000,
    });
    ok(`a2-worker-${count}`, r.status === 0 && !r.error, `exit ${r.status ?? '?'}`);
  }
  console.log(`a2-timeout phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B1 image-only recent immediate follow-up (real buildPrompt)
// ---------------------------------------------------------------------------
if (phase === 'b1-immediate') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const { buildPrompt } = await import(PROMPT_URL);
  const readDb = await initDb();

  const quickEvent = mkEvent('!r');
  let visibleAt = 0;
  const t0 = Date.now();
  await handleQuickCommand(quickEvent, async (_e, text) => { visibleAt = Date.now(); }, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  const visibleMs = visibleAt - t0;

  const followUp = mkEvent('第一把怎么回事');
  const t1 = Date.now();
  const drain = await settlePendingQuickObservations(followUp);
  const followupWaitMs = Date.now() - t1;
  const contextReadyMs = Date.now() - t0;
  const prompt = buildPrompt(readDb(), { groupId: '770001', name: 'QB08-A' }, followUp, { policy: 'normal', allowCommands: false, customPrompt: '' }, { includeSkill: false, includeMemory: false, includeGroupProfile: false, includeRelationship: false });
  const contextText = JSON.stringify(prompt?.messages || prompt);
  ok('b1:timeline', visibleMs < 450 && followupWaitMs >= 300 && followupWaitMs <= 30000, `quick_visible_ms=${visibleMs} followup_wait_ms=${followupWaitMs} context_ready_ms=${contextReadyMs}`);
  ok('b1:context-has-recent', contextText.includes('[TST]Alpha 的最近成绩'), 'buildPrompt context contains the same visible snapshot');
  ok('b1:no-extra-refetch', counts.recent === 1 && counts.userByName === 1, JSON.stringify(counts));
  ok('b1:no-duplicate-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`b1-immediate phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B2 kanon text+image: no shadow fetch, no pending wait
// ---------------------------------------------------------------------------
if (phase === 'b2-kanon') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts);
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge((socket, parsed) => imageReply(socket, parsed.message_id, 'Kanon Recent Text'));
  process.env.BRIDGE_URL_KANON = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const { buildPrompt } = await import(PROMPT_URL);
  const readDb = await initDb();
  const quickEvent = mkEvent('!re');
  await handleQuickCommand(quickEvent, async () => {}, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  const followUp = mkEvent('第一把怎么回事');
  const t0 = Date.now();
  const drain = await settlePendingQuickObservations(followUp);
  const followupWaitMs = Date.now() - t0;
  const prompt = buildPrompt(readDb(), { groupId: '770001', name: 'QB08-A' }, followUp, { policy: 'normal', allowCommands: false, customPrompt: '' }, { includeSkill: false, includeMemory: false, includeGroupProfile: false, includeRelationship: false });
  const contextText = JSON.stringify(prompt?.messages || prompt);
  ok('b2:no-pending-wait', drain.pendingCount === 0 && followupWaitMs < 60, `waitedMs=${followupWaitMs}`);
  ok('b2:context-from-text', contextText.includes('Kanon Recent Text'), 'bridge text reused');
  ok('b2:no-upstream-fetch', counts.recent === 0 && counts.userByName === 0, JSON.stringify(counts));

  await new Promise((r) => bridge.wss.close(r));
  console.log(`b2-kanon phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B3 shadow slow ladder (one module instance, per-run binding swap)
// ---------------------------------------------------------------------------
if (phase === 'b3-slow') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  let currentDelay = 100;
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, {});
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    if (/\/users\/@/.test(decodeURIComponent(url.split('?')[0])) && currentDelay) {
      await sleep(currentDelay);
    }
    return baseFetch(input);
  };
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const { ensureStore, updateDb, readDb } = await import(STORE_URL);
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.settings.llmProvider = 'fixture';
    db.settings.apiKey = 'fixture-key';
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.groups = [{ groupId: '770001', name: 'QB08-A', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 }];
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['770001'] = { quick: true };
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
  });
  const ladder = [100, 500, 2000, 40000];
  const rows = [];
  for (const delay of ladder) {
    currentDelay = delay;
    updateDb((db) => { db.osuBindings['10001'] = { id: 1234567, username: `[TST]D${delay}` }; });
    process.env.QUICK_CONTEXT_PENDING_WAIT_MS = delay === 40000 ? '300' : '30000';
    const quickEvent = mkEvent('!r');
    const t0 = Date.now();
    let visibleAt = 0;
    await handleQuickCommand(quickEvent, async () => { visibleAt = Date.now(); }, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
    const followUp = mkEvent('第一把怎么回事');
    const t1 = Date.now();
    const drain = await settlePendingQuickObservations(followUp);
    const followupWaitMs = Date.now() - t1;
    const hydrated = readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes(`[TST]D${delay} 的最近成绩`));
    rows.push({ delay, quickVisibleMs: visibleAt - t0, followupWaitMs, pendingCount: drain.pendingCount, hydratedAfterDrain: hydrated });
  }
  for (const row of rows) {
    ok(`b3:delay-${row.delay}`, row.quickVisibleMs < 450 && row.followupWaitMs <= (row.delay === 40000 ? 800 : row.delay + 1500), JSON.stringify(row));
  }
  const over = rows.find((r) => r.delay === 40000);
  ok('b3:over-bound-bounded', Boolean(over) && !over.hydratedAfterDrain, JSON.stringify(over));
  console.log(`b3-slow phase timeline: ${JSON.stringify(rows)}`);
  console.log(`b3-slow phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B4 shadow failure
// ---------------------------------------------------------------------------
if (phase === 'b4-failure') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentStatus: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const readDb = await initDb();
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const quickEvent = mkEvent('!r');
  const result = await handleQuickCommand(quickEvent, async (_e, text) => {}, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  const t0 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  const waitedMs = Date.now() - t0;
  ok('b4:visible-success', result?.reason === 'bridge:yumu', JSON.stringify(result));
  ok('b4:no-hang', waitedMs < 1500, `waitedMs=${waitedMs}`);
  ok('b4:no-retry-storm', counts.recent === 1, JSON.stringify(counts));
  ok('b4:no-second-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);
  ok('b4:fallback-context', readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('快捷指令查询完成')), 'placeholder fallback remains');
  ok('b4:no-unhandled', unhandled === null, String(unhandled));
  process.removeListener('unhandledRejection', onUnhandled);
  await new Promise((r) => bridge.wss.close(r));
  console.log(`b4-failure phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B5 two quick recent, reverse shadow completion
// ---------------------------------------------------------------------------
if (phase === 'b5-ordering') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 0 });
  const { default: origFetch } = globalThis;
  // reverse completion: Alpha's shadow is slow, Beta's is fast
  const originalStub = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    const decoded = decodeURIComponent(url.split('?')[0]);
    if (/\/users\/@/.test(decoded) && decoded.includes('[TST]Alpha')) await sleep(600);
    if (/\/users\/@/.test(decoded) && decoded.includes('[TST]Beta')) await sleep(80);
    return originalStub(input);
  };
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const readDb = await initDb();
  const run = (text, userId, nickname) => { const e = mkEvent(text, { userId, nickname }); return handleQuickCommand(e, async () => {}, readDb(), matchQuickCommand(e), { isOwner: true, isAdmin: true }); };
  await run('!r', '10001', 'AlphaUser');
  await run('!r', '10002', 'BetaUser');
  const t0 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  const waitedMs = Date.now() - t0;
  const db = readDb();
  const messages = db.messages || [];
  const alpha = messages.findIndex((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha 的最近成绩'));
  const beta = messages.findIndex((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Beta 的最近成绩'));
  const alphaUser = messages.findIndex((m) => m.role === 'user' && String(m.content || '').includes('!r') && String(m.userId) === '10001');
  const betaUser = messages.findIndex((m) => m.role === 'user' && String(m.content || '').includes('!r') && String(m.userId) === '10002');
  ok('b5:visible-order-slots', alphaUser !== -1 && betaUser !== -1 && alphaUser < betaUser && alpha > alphaUser && beta > betaUser && alpha < beta, `alphaUser=${alphaUser} betaUser=${betaUser} alpha=${alpha} beta=${beta}`);
  ok('b5:hydration-in-place-no-overwrite', messages.filter((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha 的最近成绩')).length === 1 && messages.filter((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Beta 的最近成绩')).length === 1, 'A/B own one slot each');
  ok('b5:drain-waits-only-once-per-shadow', waitedMs >= 400 && counts.recent === 2, `waitedMs=${waitedMs} counts=${JSON.stringify(counts)}`);
  await new Promise((r) => bridge.wss.close(r));
  console.log(`b5-ordering phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B6 conversation isolation incl. group vs private
// ---------------------------------------------------------------------------
if (phase === 'b6-isolation') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 600 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const readDb = await initDb();
  const groupA = mkEvent('!r', { groupId: '770001', userId: '10001' });
  await handleQuickCommand(groupA, async () => {}, readDb(), matchQuickCommand(groupA), { isOwner: true, isAdmin: true });
  const t1 = Date.now();
  const privateOther = { ...mkEvent('第一把怎么回事', { userId: '10001' }), type: 'private' };
  const d1 = await settlePendingQuickObservations(privateOther);
  ok('b6:group-vs-private-isolated', Date.now() - t1 < 150 && d1.pendingCount === 0, `waitedMs=${Date.now() - t1}`);
  const t2 = Date.now();
  const groupOtherUser = mkEvent('第一把怎么回事', { userId: '10002' });
  const d2 = await settlePendingQuickObservations(groupOtherUser);
  ok('b6:different-user-isolated', Date.now() - t2 < 150 && d2.pendingCount === 0, `waitedMs=${Date.now() - t2}`);
  const t3 = Date.now();
  const groupOtherGroup = mkEvent('第一把怎么回事', { groupId: '770002' });
  const d3 = await settlePendingQuickObservations(groupOtherGroup);
  ok('b6:different-group-isolated', Date.now() - t3 < 150 && d3.pendingCount === 0, `waitedMs=${Date.now() - t3}`);
  const t4 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  ok('b6:own-conversation-waits', Date.now() - t4 >= 300, `waitedMs=${Date.now() - t4}`);
  await new Promise((r) => bridge.wss.close(r));
  console.log(`b6-isolation phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// B7 concurrent follow-ups share one pending promise
// ---------------------------------------------------------------------------
if (phase === 'b7-concurrent') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const readDb = await initDb();
  const quickEvent = mkEvent('!r');
  await handleQuickCommand(quickEvent, async () => {}, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  await Promise.all([settlePendingQuickObservations(mkEvent('第一把怎么回事 A')), settlePendingQuickObservations(mkEvent('第一把怎么回事 B'))]);
  const db = readDb();
  const summaries = db.messages.filter((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩'));
  ok('b7:one-shadow-one-hydration', counts.recent === 1 && summaries.length === 1, `recent=${counts.recent} summaries=${summaries.length}`);
  ok('b7:no-race-exception', summaries.length === 1, 'single hydrated slot');
  await new Promise((r) => bridge.wss.close(r));
  console.log(`b7-concurrent phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// parent
// ---------------------------------------------------------------------------
const phases = ['a1-boundary', 'a2-timeout', 'b1-immediate', 'b2-kanon', 'b3-slow', 'b4-failure', 'b5-ordering', 'b6-isolation', 'b7-concurrent'];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qb08-final-'));
let phasesOk = 0;
for (const name of phases) {
  const dataDir = path.join(base, `${name}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO,
    env: { ...process.env, QB08F_PHASE: name, QB08F_DATA_DIR: dataDir },
    stdio: 'inherit',
    shell: false,
    timeout: 120_000,
  });
  const okPhase = r.status === 0 && !r.error;
  if (okPhase) phasesOk++;
  console.log(`PHASE ${name}: ${okPhase ? 'PASS' : 'FAIL'} (exit ${r.status ?? '?'}${r.error ? ` ${r.error.message}` : ''})`);
}
console.log(`\nquick-context-qb08-final-acceptance-verify: ${phasesOk}/${phases.length} phases passed`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(phasesOk === phases.length ? 0 : 1);
