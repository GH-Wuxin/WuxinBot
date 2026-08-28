// quick-bridge-qb07-shadow-refetch-verify.mjs
// QUICK_BRIDGE_QB07_RECENT_SHADOW_REFETCH — production-path verifier.
//
// Runs the REAL quickRouter / executor / quickMemory code against synthetic
// WS bridges and a local osu! API mock. It measures, per explicit recent
// request, exactly which upstream fetches happen and classifies them:
//   SAME_REQUEST_DUPLICATE / REQUIRED_FALLBACK / OBSERVATION_SHADOW_REFETCH /
//   INDEPENDENT_FOLLOWUP_FETCH.
//
// Phases (fresh child processes because BRIDGE_URL_* and DATA_DIR are read at
// module load):
//   yumu-image-success   image-only bridge -> shadow refetch measured
//   kanon-text-success   text+image bridge -> no Wuxin-side refetch
//   bridge-fail-executor failed primary bridge -> REQUIRED internal fallback,
//                        P0_2 suppresses a second same-target bridge
//   lazybot-yumu         cross-target fallback preserved, counted separately
//   shadow-failure       observation failure must not break visible reply
//   concurrency          two users, same user twice, different groups
//   shape                bridge reply carries only rendered text/images ->
//                        DESIGN_REQUIRED conclusion
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
const BRIDGE_URL = pathToFileURL(path.join(REPO, 'server/bots/localBridge.ts')).href;

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
  const respond = (body, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
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
      const id = recent[1];
      const name = id === '1234568' ? '[TST]Beta' : '[TST]Alpha';
      return respond([{
        rank: 'S', accuracy: 98.76, max_combo: 100, pp: 123.4, mods: [],
        beatmap: { id: Number(id), title: `${name} Song`, version: 'fixture', beatmapset: { title: `${name} Song` } },
        score: 1_000_000,
      }]);
    }
    const userById = /\/users\/(\d+)\/osu/.exec(decoded);
    if (userById) {
      counts.userById++;
      const id = userById[1];
      const name = id === '1234568' ? '[TST]Beta' : '[TST]Alpha';
      return respond({ id: Number(id), username: name, statistics: { play_time: 0 } });
    }
    if (decoded.includes('/users/@')) {
      counts.userByName++;
      const isBeta = decoded.includes('[TST]Beta');
      return respond({ id: isBeta ? 1234568 : 1234567, username: isBeta ? '[TST]Beta' : '[TST]Alpha', statistics: { play_time: 0 } });
    }
    return respond({}, 404);
  };
}

function imagePayload(text) {
  const segments = [];
  if (text) segments.push({ type: 'text', data: { text } });
  segments.push({ type: 'image', data: { file: 'http://fixture.test/a.png' } });
  return segments;
}

async function startWsBridge({ onConnect, onMessage }) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const obs = { connections: 0, inbound: [] };
  wss.on('connection', (socket) => {
    obs.connections++;
    if (onConnect) onConnect(socket, obs);
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (parsed?.post_type === 'message') {
        obs.inbound.push(parsed);
        if (onMessage) onMessage(parsed, socket, obs);
      }
    });
  });
  return { wss, obs, url: `ws://127.0.0.1:${wss.address().port}` };
}

const sendImageReply = (socket, echo, text) => {
  socket.send(JSON.stringify({ action: 'send_group_msg', echo, params: { message: imagePayload(text) } }));
  setTimeout(() => { try { socket.close(1000, 'fixture-done'); } catch {} }, 80);
};

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
    db.groups = [{ groupId: '770001', name: 'QB07', enabled: true, mode: 'normal', maxPerHour: 100, cooldownSec: 0 }];
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['770001'] = {};
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['10001'] = { id: 1234567, username: '[TST]Alpha' };
    db.osuBindings['10002'] = { id: 1234568, username: '[TST]Beta' };
  });
  return readDb;
}

async function waitFor(fn, timeoutMs, step = 30) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  return null;
}

const phase = process.env.QB07_PHASE || '';
const phaseData = process.env.QB07_DATA_DIR || '';

// ---------------------------------------------------------------------------
// yumu-image-success
// ---------------------------------------------------------------------------
if (phase === 'yumu-image-success') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, ''); } });
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const sent = [];
  const event = { source: 'onebot', type: 'group', messageId: 'qb07-yumu-' + Date.now(), groupId: '770001', userId: '10001', nickname: 'AlphaUser', text: '!r', atTargets: [], images: [], raw: {} };
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const t0 = Date.now();
  const result = await handleQuickCommand(event, async (_e, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(event), { isOwner: true, isAdmin: true });
  const routeMs = Date.now() - t0;

  ok('yumu:handled-bridge', result?.handled === true && result?.reason === 'bridge:yumu', JSON.stringify(result));
  ok('yumu:visible-image-sent', sent.length === 1 && sent[0].includes('[CQ:image'), sent.join(' | ').slice(0, 120));
  ok('yumu:exactly-one-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);
  ok('yumu:bridge-command', bridge.obs.inbound[0]?.raw_message === '!r [TST]Alpha', bridge.obs.inbound[0]?.raw_message);
  ok('yumu:route-does-not-wait-for-shadow', routeMs < 450, `routeMs=${routeMs} (shadow recent delayed 500ms)`);

  const contextReady = await waitFor(async () => {
    const db = readDb();
    return db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha 的最近成绩'));
  }, 3000);
  ok('yumu:context-shadow-summary', Boolean(contextReady), 'assistant summary contains [TST]Alpha 的最近成绩');
  ok('yumu:shadow-refetch-count', counts.recent === 1 && counts.userByName === 1, JSON.stringify(counts));
  ok('yumu:no-second-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);
  ok('yumu:no-unhandled-rejection', unhandled === null, String(unhandled));
  process.removeListener('unhandledRejection', onUnhandled);
  ok('yumu:qb08-context-after-visible', routeMs < 450, `route returned before context-ready (routeMs=${routeMs})`);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`yumu-image-success phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// kanon-text-success
// ---------------------------------------------------------------------------
if (phase === 'kanon-text-success') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts);
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, 'Kanon Recent Text'); } });
  process.env.BRIDGE_URL_KANON = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const sent = [];
  const event = { source: 'onebot', type: 'group', messageId: 'qb07-kanon-' + Date.now(), groupId: '770001', userId: '10001', nickname: 'AlphaUser', text: '!re', atTargets: [], images: [], raw: {} };
  const result = await handleQuickCommand(event, async (_e, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(event), { isOwner: true, isAdmin: true });

  ok('kanon:handled-bridge', result?.handled === true && result?.reason === 'bridge:kanon', JSON.stringify(result));
  ok('kanon:visible-text', sent.length === 1 && sent[0].includes('Kanon Recent Text'), sent.join(' | ').slice(0, 120));
  ok('kanon:no-wuxin-refetch', counts.recent === 0 && counts.userByName === 0 && counts.userById === 0, JSON.stringify(counts));
  const db = readDb();
  ok('kanon:context-from-bridge-text', db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('Kanon Recent Text')), 'bridge text reused for context');
  ok('kanon:exactly-one-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`kanon-text-success phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// bridge-fail-executor
// ---------------------------------------------------------------------------
if (phase === 'bridge-fail-executor') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts);
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge({ onConnect(socket) { try { socket.close(4000, 'primary-fails'); } catch {} } });
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const sent = [];
  const event = { source: 'onebot', type: 'group', messageId: 'qb07-fail-' + Date.now(), groupId: '770001', userId: '10001', nickname: 'AlphaUser', text: '!r', atTargets: [], images: [], raw: {} };
  const result = await handleQuickCommand(event, async (_e, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(event), { isOwner: true, isAdmin: true });

  ok('fail:internal-result', result?.handled === true && result?.reason === 'recent', JSON.stringify(result));
  ok('fail:visible-text', sent.length === 1 && sent[0].includes('[TST]Alpha Song'), sent.join(' | ').slice(0, 160));
  ok('fail:required-fallback-one-fetch', counts.recent === 1 && counts.userById === 1, JSON.stringify(counts));
  await sleep(200);
  ok('fail:p02-no-second-bridge', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);
  const db = readDb();
  ok('fail:context-from-authoritative-text', db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha Song')), 'internal fallback text recorded, no shadow refetch');
  ok('fail:no-shadow-by-name', counts.userByName === 0, 'buildQuickShadowSummary not invoked');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`bridge-fail-executor phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// lazybot-yumu cross-target fallback
// ---------------------------------------------------------------------------
if (phase === 'lazybot-yumu') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts);
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const lazy = await startWsBridge({ onConnect(socket) { try { socket.close(4000, 'lazy-fails'); } catch {} } });
  const yumu = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, ''); } });
  process.env.BRIDGE_URL_LAZYBOT = lazy.url;
  process.env.BRIDGE_URL_YUMU = yumu.url;

  const { SLASH_DEFS, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const lazyRecent = SLASH_DEFS.find((d) => d.source === 'lazybot' && d.capability === 'recent');
  const sent = [];
  const event = { source: 'onebot', type: 'group', messageId: 'qb07-lazy-' + Date.now(), groupId: '770001', userId: '10001', nickname: 'AlphaUser', text: '/pr', atTargets: [], images: [], raw: {} };
  const match = { def: lazyRecent, cmdText: 'pr', alias: 'pr', args: '', prefix: '/', atTargets: [] };
  const result = await handleQuickCommand(event, async (_e, text) => { sent.push(String(text)); }, readDb(), match, { isOwner: true, isAdmin: true });

  ok('lazy:cross-target-result', result?.handled === true && result?.reason === 'recent', JSON.stringify(result));
  ok('lazy:visible-image', sent.length === 1 && sent[0].includes('[CQ:image'), sent.join(' | ').slice(0, 120));
  await sleep(200);
  ok('lazy:primary-and-fallback-attempts', lazy.obs.connections === 1 && yumu.obs.connections === 1, `lazy=${lazy.obs.connections} yumu=${yumu.obs.connections}`);
  ok('lazy:no-wuxin-recent-fetch', counts.recent === 0 && counts.userByName === 0, JSON.stringify(counts));
  const db = readDb();
  ok('lazy:context-placeholder', db.messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('最近一次 osu! 成绩')), 'cross-target image result records placeholder (documented follow-up gap)');

  await new Promise((r) => { lazy.wss.close(r); yumu.wss.close(r); });
  console.log(`lazybot-yumu phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// shadow-failure
// ---------------------------------------------------------------------------
if (phase === 'shadow-failure') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentStatus: 500 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, ''); } });
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const sent = [];
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = String(e?.message || e); };
  process.on('unhandledRejection', onUnhandled);
  const event = { source: 'onebot', type: 'group', messageId: 'qb07-sfail-' + Date.now(), groupId: '770001', userId: '10001', nickname: 'AlphaUser', text: '!r', atTargets: [], images: [], raw: {} };
  const result = await handleQuickCommand(event, async (_e, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(event), { isOwner: true, isAdmin: true });

  ok('sfail:visible-success', result?.handled === true && result?.reason === 'bridge:yumu' && sent.length === 1 && sent[0].includes('[CQ:image'), JSON.stringify(result));
  ok('sfail:one-bridge-only', bridge.obs.connections === 1, `connections=${bridge.obs.connections}`);
  const shadowAttempt = await waitFor(async () => (counts.recent >= 1 && counts.userByName >= 1 ? counts : null), 2500);
  ok('sfail:single-shadow-attempt', Boolean(shadowAttempt) && shadowAttempt.recent === 1, JSON.stringify(counts));
  const fallback = await waitFor(async () => readDb().messages?.some((m) => m.role === 'assistant' && String(m.content || '').includes('快捷指令查询完成')), 2000);
  ok('sfail:fallback-observation-recorded', Boolean(fallback), 'observation failure degrades to generic record, never blocks reply');
  ok('sfail:no-unhandled', unhandled === null, String(unhandled));
  process.removeListener('unhandledRejection', onUnhandled);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`shadow-failure phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// concurrency
// ---------------------------------------------------------------------------
if (phase === 'concurrency') {
  process.env.DATA_DIR = phaseData;
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const counts = { token: 0, recent: 0, userByName: 0, userById: 0, recentByUser: {} };
  installFetchStub(counts, { recentDelay: 120 });
  process.env.OSU_TOKEN_URL = 'http://fixture.test/oauth/token';
  process.env.OSU_API_BASE_URL = 'http://fixture.test/api/v2';
  process.env.OSU_CLIENT_ID = 'offline-id';
  process.env.OSU_CLIENT_SECRET = 'offline-secret';
  const bridge = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, ''); } });
  process.env.BRIDGE_URL_YUMU = bridge.url;

  const { matchQuickCommand, handleQuickCommand } = await import(QR_URL);
  const readDb = await initDb();
  const sent = [];
  const mkEvent = (userId, groupId) => ({ source: 'onebot', type: 'group', messageId: `qb07-conc-${userId}-${groupId}-${Date.now()}-${Math.random()}`, groupId, userId, nickname: userId === '10001' ? 'AlphaUser' : 'BetaUser', text: '!r', atTargets: [], images: [], raw: {} });
  const e1 = mkEvent('10001', '770001');
  const e2 = mkEvent('10002', '770001');
  const e3 = mkEvent('10001', '770001');
  const run = (e) => handleQuickCommand(e, async (_ev, text) => { sent.push(String(text)); }, readDb(), matchQuickCommand(e), { isOwner: true, isAdmin: true });
  const results = await Promise.all([run(e1), run(e2), run(e3)]);

  ok('conc:all-visible', results.every((r) => r?.handled === true && r?.reason === 'bridge:yumu') && sent.length === 3, JSON.stringify({ results, sentCount: sent.length }));
  await waitFor(async () => {
    const db = readDb();
    const alpha = db.messages?.filter((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Alpha 的最近成绩')).length;
    const beta = db.messages?.filter((m) => m.role === 'assistant' && String(m.content || '').includes('[TST]Beta 的最近成绩')).length;
    return alpha >= 2 && beta >= 1 ? { alpha, beta } : null;
  }, 3000).then((v) => {
    ok('conc:summaries-not-cross-contaminated', Boolean(v) && v.alpha >= 2 && v.beta >= 1, JSON.stringify(v));
  });
  ok('conc:bridge-count', bridge.obs.connections === 3, `connections=${bridge.obs.connections}`);

  await new Promise((r) => bridge.wss.close(r));
  console.log(`concurrency phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------
if (phase === 'shape') {
  process.env.BRIDGE_SETTLE_MS = '80';
  process.env.BRIDGE_MAX_POST_REPLY_MS = '160';
  const bridge = await startWsBridge({ onMessage(parsed, socket) { sendImageReply(socket, parsed.message_id, ''); } });
  process.env.BRIDGE_URL_YUMU = bridge.url;
  const { callLocalBot } = await import(BRIDGE_URL);
  const reply = await callLocalBot('yumu', '!r [TST]Alpha', { groupId: '770099', userId: '10001', nickname: 'AlphaUser', atTargets: [] }, 3000);
  const keys = Object.keys(reply).sort();
  ok('shape:bridge-reply-rendered-only', JSON.stringify(keys) === JSON.stringify(['frames', 'images', 'text']), `keys=${keys.join(',')}`);
  ok('shape:no-domain-object', !('domainResult' in reply) && !('score' in reply), 'no structured score crosses the bridge');
  const qrSrc = fs.readFileSync(path.join(REPO, 'server/bot/quickRouter.ts'), 'utf8');
  const shadowCall = qrSrc.match(/recordShadow\(([^)]*)\)/s)?.[1] || '';
  ok('shape:shadow-has-no-domain-handoff', /shadowCap\s*,\s*shadowUser\s*,\s*reply\.images/.test(shadowCall), `recordShadow receives only rendered metadata: ${shadowCall.replace(/\s+/g, ' ').slice(0, 120)}`);
  const qmSrc = fs.readFileSync(path.join(REPO, 'server/bot/quickMemory.ts'), 'utf8');
  ok('shape:shadow-refetches-domain', qmSrc.includes('getUserRecentScores(user.id, \'osu\', 1)') && qmSrc.includes('await getUser('), 'buildQuickShadowSummary performs its own domain fetch');
  ok('shape:no-render-reparse', !qmSrc.includes('reply.text') && !shadowCall.includes('reply.text'), 'observer never parses rendered bridge text');

  await new Promise((r) => bridge.wss.close(r));
  console.log(`shape phase: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------------
// parent
// ---------------------------------------------------------------------------
const phases = ['yumu-image-success', 'kanon-text-success', 'bridge-fail-executor', 'lazybot-yumu', 'shadow-failure', 'concurrency', 'shape'];
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qb07-verify-'));
let phasesOk = 0;
for (const name of phases) {
  const dataDir = path.join(base, `${name}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  const r = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    cwd: REPO,
    env: { ...process.env, QB07_PHASE: name, QB07_DATA_DIR: dataDir },
    stdio: 'inherit',
    shell: false,
    timeout: 120_000,
  });
  const okPhase = r.status === 0 && !r.error;
  if (okPhase) phasesOk++;
  console.log(`PHASE ${name}: ${okPhase ? 'PASS' : 'FAIL'} (exit ${r.status ?? '?'}${r.error ? ` ${r.error.message}` : ''})`);
}
console.log(`\nquick-bridge-qb07-shadow-refetch-verify: ${phasesOk}/${phases.length} phases passed`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(phasesOk === phases.length ? 0 : 1);
