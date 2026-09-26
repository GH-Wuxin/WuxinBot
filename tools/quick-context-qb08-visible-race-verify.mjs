// quick-context-qb08-visible-race-verify.mjs
// QUICK_CONTEXT_FIX_QB08_VISIBLE_CONTEXT_RACE — production-path verifier.
//
// Drives the REAL quickRouter + quickContext + quickMemory code with synthetic
// WS bridges and an in-process osu API fetch stub. Proves:
//   visible < shadow-ready does not lose follow-up context (next-turn drain),
//   visible quick latency does not wait for the shadow,
//   already-ready pending work adds ~zero follow-up wait,
//   shadow failure cannot hang a follow-up,
//   two quick commands keep conversation order,
//   group/user isolation, concurrent drains reuse the same shadow promise,
//   bounded-wait timeout policy, and QB-07 fetch graph unchanged.
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
  const bestDelay = opts.bestDelay || 0;
  const respond = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
  globalThis.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input?.url || input);
    if (url.includes('/oauth/token')) {
      counts.token++;
      return respond({ access_token: 'offline-token', token_type: 'Bearer', expires_in: 86400 });
    }
    const decoded = decodeURIComponent(url.split('?')[0]);
    const recent = /\/users\/(\d+)\/scores\/recent/.exec(decoded);
    if (recent) {
      counts.recent++;
      counts.recentByUser[recent[1]] = (counts.recentByUser[recent[1]] || 0) + 1;
      if (recentDelay > 0) await new Promise((r) => setTimeout(r, recentDelay));
      if (recentStatus !== 200) return respond({}, recentStatus);
      const name = recent[1] === '1234568' ? '[TST]Beta' : '[TST]Alpha';
      return respond([{ rank: 'S', accuracy: 98.76, max_combo: 100, pp: 123.4, mods: [], beatmap: { id: Number(recent[1]), title: `${name} Song`, version: 'fixture', beatmapset: { title: `${name} Song` } }, score: 1_000_000 }]);
    }
    const best = /\/users\/(\d+)\/scores\/best/.exec(decoded);
    if (best) {
      counts.best = (counts.best || 0) + 1;
      if (bestDelay > 0) await new Promise((r) => setTimeout(r, bestDelay));
      const name = best[1] === '1234568' ? '[TST]Beta' : '[TST]Alpha';
      return respond([{ rank: 'S', accuracy: 99.1, max_combo: 900, pp: 220, mods: [], beatmap: { id: Number(best[1]), title: `${name} BP Song`, version: 'fixture', beatmapset: { title: `${name} BP Song` } }, score: 2_000_000 }]);
    }
    const userById = /\/users\/(\d+)\/osu/.exec(decoded);
    if (userById) {
      counts.userById++;
      const name = userById[1] === '1234568' ? '[TST]Beta' : '[TST]Alpha';
      return respond({ id: Number(userById[1]), username: name, statistics: { play_time: 0 } });
    }
    if (decoded.includes('/users/@')) {
      counts.userByName++;
      const isBeta = decoded.includes('[TST]Beta');
      return respond({ id: isBeta ? 1234568 : 1234567, username: isBeta ? '[TST]Beta' : '[TST]Alpha', statistics: { play_time: 0 } });
    }
    return respond({}, 404);
  };
}

function imageReply(socket, echo) {
  socket.send(JSON.stringify({ action: 'send_group_msg', echo, params: { message: [{ type: 'image', data: { file: 'http://fixture.test/a.png' } }] } }));
  setTimeout(() => { try { socket.close(1000, 'fixture-done'); } catch {} }, 80);
}

async function startWsBridge() {
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
        imageReply(socket, parsed.message_id);
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
    db.groupBotConfig['770001'] = {};
    db.groupBotConfig['770002'] = {};
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
    db.osuBindings['10002'] = { id: 1234568, username: '[TST]Beta' };
  });
  return readDb;
}

async function waitFor(fn, timeoutMs, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

const phase = process.env.QB08_PHASE || '';
const phaseData = process.env.QB08_DATA_DIR || '';

const mkEvent = (text, extra = {}) => ({
  source: 'onebot', type: 'group',
  messageId: `qb08-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  groupId: '770001', userId: '10001', nickname: 'AlphaUser',
  text, atTargets: [], images: [], raw: {}, ...extra,
});

// ---------------------------------------------------------------------------
// race-wait
// ---------------------------------------------------------------------------
if (phase === 'race-wait') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
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
  const sent = [];
  const quickEvent = mkEvent('!r');
  const t0 = Date.now();
  const result = await handleQuickCommand(quickEvent, async (_e, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  const visibleMs = Date.now() - t0;

  ok('race:visible-sent-first', result?.reason === 'bridge:yumu' && sent.length === 1 && sent[0].includes('[CQ:image'), JSON.stringify(result));
  ok('race:visible-does-not-wait-shadow', visibleMs < 450, `visibleMs=${visibleMs} shadowDelay=600`);

  const followUp = mkEvent('第一把怎么回事');
  const t1 = Date.now();
  const drain = await settlePendingQuickObservations(followUp);
  const followupWaitMs = Date.now() - t1;
  ok('race:followup-bounded-wait', followupWaitMs >= 300 && followupWaitMs <= 30000, `followup_wait_ms=${followupWaitMs}`);
  ok('race:drain-stats', drain.pendingCount >= 1, JSON.stringify(drain));

  const db = readDb();
  ok('race:followup-sees-summary', db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha 的最近成绩')), 'hydrated summary visible after drain');
  ok('race:qb07-fetch-unchanged', counts.recent === 1 && counts.userByName === 1 && bridge.obs.connections === 1, JSON.stringify(counts));
  ok('race:pending-cleared', (await import(QC_URL)).quickContextPendingCountForTest() === 0, 'registry emptied after settle');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`race-wait phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// already-ready
// ---------------------------------------------------------------------------
if (phase === 'already-ready') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
  installFetchStub(counts, { recentDelay: 80 });
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
  await waitFor(async () => readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')), 2000);

  const t0 = Date.now();
  const drain = await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  ok('ready:zero-extra-wait', Date.now() - t0 < 60 && drain.pendingCount === 0, `waitedMs=${Date.now() - t0} pending=${drain.pendingCount}`);
  ok('ready:context-present', readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')), 'no re-fetch, existing context read');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`already-ready phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// shadow-failure
// ---------------------------------------------------------------------------
if (phase === 'shadow-failure') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
  installFetchStub(counts, { recentStatus: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations, quickContextPendingCountForTest } = await import(QC_URL);
  const readDb = await initDb();
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const quickEvent = mkEvent('!r');
  const result = await handleQuickCommand(quickEvent, async (_e, text) => { /* visible */ }, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  ok('sfail:visible-success', result?.handled === true && result?.reason === 'bridge:yumu', JSON.stringify(result));

  const t0 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  ok('sfail:no-hang', Date.now() - t0 < 2000, `waitedMs=${Date.now() - t0}`);
  const db = readDb();
  ok('sfail:placeholder-fallback', db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('快捷指令查询完成')), 'fallback context remains');
  ok('sfail:no-unhandled', unhandled === null, String(unhandled));
  ok('sfail:registry-empty', quickContextPendingCountForTest() === 0, 'failure still settles pending entry');
  process.removeListener('unhandledRejection', onUnhandled);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`shadow-failure phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------
if (phase === 'ordering') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
  installFetchStub(counts, { recentDelay: 600, bestDelay: 80 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge();
  const failKanon = await startWsBridge();
  process.env.BRIDGE_URL_YUMU = bridge.url;
  process.env.BRIDGE_URL_KANON = failKanon.url;
  failKanon.wss.on('connection', (socket) => { try { socket.close(4000, 'qb08-no-live-kanon'); } catch {} });

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const { settlePendingQuickObservations } = await import(QC_URL);
  const readDb = await initDb();
  const run = (text) => { const e = mkEvent(text); return handleQuickCommand(e, async () => {}, readDb(), matchQuickCommand(e), { isOwner: true, isAdmin: true }); };
  await run('!r');
  await run('!bs');
  const followUp = mkEvent('第一把怎么回事');
  const t0 = Date.now();
  await settlePendingQuickObservations(followUp);
  ok('ordering:drain-covered-both', Date.now() - t0 >= 400, `waitedMs=${Date.now() - t0}`);

  const db = readDb();
  const messages = db.messages || [];
  const idx = (text) => messages.findIndex((m) => String(m.content || '').includes(text));
  const recentSummary = idx('[TST]Alpha 的最近成绩');
  const bpSummary = idx('[TST]Alpha 的 BP');
  const userRecent = idx('!r');
  const userBp = idx('!bs');
  ok('ordering:recent-slot-before-bp-user', recentSummary !== -1 && userBp !== -1 && recentSummary < userBp, `recentSummary=${recentSummary} userBp=${userBp}`);
  ok('ordering:bp-slot-after-bp-user', bpSummary !== -1 && bpSummary > userBp, `bpSummary=${bpSummary} userBp=${userBp}`);
  ok('ordering:no-overwrite', messages.filter((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')).length === 1 && messages.filter((m) => m.role === 'assistant' && String(m.content || '').includes('的 BP')).length === 1, 'each quick command owns its hydrated slot');
  ok('ordering:fetch-counts', counts.recent === 1 && counts.best === 1, JSON.stringify(counts));

  await new Promise((r) => { bridge.wss.close(r); failKanon.wss.close(r); });
  console.log(`ordering phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// isolation
// ---------------------------------------------------------------------------
if (phase === 'isolation') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
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
  const eventA = mkEvent('!r');
  await handleQuickCommand(eventA, async () => {}, readDb(), matchQuickCommand(eventA), { isOwner: true, isAdmin: true });

  const otherUser = mkEvent('第一把怎么回事', { userId: '10002', nickname: 'BetaUser' });
  const t1 = Date.now();
  const drainOther = await settlePendingQuickObservations(otherUser);
  ok('isolation:other-user-no-wait', Date.now() - t1 < 150 && drainOther.pendingCount === 0, `waitedMs=${Date.now() - t1}`);

  const otherGroup = mkEvent('第一把怎么回事', { groupId: '770002' });
  const t2 = Date.now();
  const drainGroup = await settlePendingQuickObservations(otherGroup);
  ok('isolation:other-group-no-wait', Date.now() - t2 < 150 && drainGroup.pendingCount === 0, `waitedMs=${Date.now() - t2}`);

  const t3 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  ok('isolation:same-user-waits-own', Date.now() - t3 >= 300, `waitedMs=${Date.now() - t3}`);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`isolation phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// concurrent-drain
// ---------------------------------------------------------------------------
if (phase === 'concurrent-drain') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
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
  const f1 = mkEvent('第一把怎么回事');
  const f2 = mkEvent('第一把怎么回事');
  await Promise.all([settlePendingQuickObservations(f1), settlePendingQuickObservations(f2)]);
  ok('conc:single-shadow-fetch', counts.recent === 1, JSON.stringify(counts));
  ok('conc:both-context-visible', readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')), 'shared promise, no duplicate fetch');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`concurrent-drain phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// no-pending + timeout-policy
// ---------------------------------------------------------------------------
if (phase === 'no-pending-timeout') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  process.env.QUICK_CONTEXT_PENDING_WAIT_MS = '60';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {}, best: 0 };
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
  const t0 = Date.now();
  const none = await settlePendingQuickObservations(mkEvent('普通闲聊'));
  ok('normal:zero-cost-without-pending', Date.now() - t0 < 50 && none.pendingCount === 0, `waitedMs=${Date.now() - t0}`);

  const quickEvent = mkEvent('!r');
  await handleQuickCommand(quickEvent, async () => {}, readDb(), matchQuickCommand(quickEvent), { isOwner: true, isAdmin: true });
  const t1 = Date.now();
  await settlePendingQuickObservations(mkEvent('第一把怎么回事'));
  ok('timeout:bounded-return', Date.now() - t1 < 300, `waitedMs=${Date.now() - t1} (policy 60ms)`);
  const early = readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩'));
  ok('timeout:placeholder-at-bound', !early, 'shadow still running after bounded wait');
  const later = await waitFor(async () => readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('的最近成绩')), 2000);
  ok('timeout:background-hydrates-later', Boolean(later), 'hydration still lands after the turn');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`no-pending-timeout phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// static-hook
// ---------------------------------------------------------------------------
if (phase === 'static-hook') {
  const botSrc = fs.readFileSync(path.join(REPO, 'server/bot.ts'), 'utf8');
  const qrSrc = fs.readFileSync(path.join(REPO, 'server/bot/quickRouter.ts'), 'utf8');
  const qmSrc = fs.readFileSync(path.join(REPO, 'server/bot/quickMemory.ts'), 'utf8');
  const qcSrc = fs.readFileSync(path.join(REPO, 'server/bot/quickContext.ts'), 'utf8');
  const hookIdx = botSrc.indexOf('await settlePendingQuickObservations(event);');
  const promptIdx = botSrc.indexOf('const messages = buildPrompt(');
  ok('static:hook-before-context-read', hookIdx !== -1 && promptIdx !== -1 && hookIdx < promptIdx, `hook=${hookIdx} prompt=${promptIdx}`);
  ok('static:placeholder-before-shadow', qrSrc.includes('recordQuickContextPending(event, placeholder') && qrSrc.includes('registerPendingQuickObservation'), 'placeholder slot + pending registration');
  ok('static:hydrate-in-place', qmSrc.includes('pendingQuickId') && qmSrc.includes('hydrateQuickContextPending'), 'in-place hydration');
  ok('static:key-is-group-user', qcSrc.includes('group:${String(event.groupId') && qcSrc.includes('private:${String(event.userId'), 'conversation identity key');
  ok('static:process-local-only', qcSrc.includes('const pendingByKey = new Map'), 'pending registry is in-memory/process-local');
  ok('static:no-visible-wait', !qrSrc.includes('await settlePendingQuickObservations'), 'quickRouter never awaits pending drain');
  console.log(`static-hook phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// parent
// ---------------------------------------------------------------------------
const phases = ['race-wait', 'already-ready', 'shadow-failure', 'ordering', 'isolation', 'concurrent-drain', 'no-pending-timeout', 'static-hook'];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qb08-verify-'));
let phasesOk = 0;
for (const name of phases) {
  const dataDir = path.join(base, `${name}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO,
    env: { ...process.env, QB08_PHASE: name, QB08_DATA_DIR: dataDir },
    stdio: 'inherit',
    shell: false,
    timeout: 120_000,
  });
  const okPhase = r.status === 0 && !r.error;
  if (okPhase) phasesOk++;
  console.log(`PHASE ${name}: ${okPhase ? 'PASS' : 'FAIL'} (exit ${r.status ?? '?'}${r.error ? ` ${r.error.message}` : ''})`);
}
console.log(`\nquick-context-qb08-visible-race-verify: ${phasesOk}/${phases.length} phases passed`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(phasesOk === phases.length ? 0 : 1);
