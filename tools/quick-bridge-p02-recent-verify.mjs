// quick-bridge-p02-recent-verify.mjs
// Offline regression for QUICK_BRIDGE_FIX_P0_2 (RECENT_DOUBLE_BRIDGE).
// Verifies that quickRouter's failed bridge #1 is expressed as request-scoped
// state and that executor recent does not repeat the same-target bridge,
// while direct/agent callers and deliberate cross-target fallbacks keep their
// existing bridge behavior. Uses only synthetic local WS servers + the shared
// osu API mock. No real bots, no QQ traffic, no real 60s waits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(path.join('G:/QQ-AI-ChatBot', 'package.json'));
const { WebSocketServer } = require('ws');

const REPO = 'G:/QQ-AI-ChatBot';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-p02-'));
process.env.DATA_DIR = DATA_DIR;

// Start the shared osu API mock and point runtime env at it BEFORE importing
// any server module that captures those env vars.
const { startOsuApiMock } = await import(pathToFileURL(path.join(REPO, 'tools/osu-api-mock.mjs')));
const mock = await startOsuApiMock();
process.env.OSU_API_BASE_URL = mock.apiBase;
process.env.OSU_TOKEN_URL = mock.tokenUrl;

// Synthetic per-family bridge servers.
const modes = { kanon: 'fail', yumu: 'fail', lazybot: 'fail' };
const attempts = { kanon: 0, yumu: 0, lazybot: 0 };
const servers = {};
for (const family of ['kanon', 'yumu', 'lazybot']) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  process.env[`BRIDGE_URL_${family.toUpperCase()}`] = url;
  wss.on('connection', (socket) => {
    attempts[family]++;
    let first = true;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (!first || !parsed || parsed.post_type !== 'message') return;
      first = false;
      const mode = modes[family];
      if (mode === 'reply') {
        socket.send(JSON.stringify({ action: 'send_msg', echo: `e-${family}`, params: { message: `bridge:${family}:ok` } }));
        setTimeout(() => { try { socket.close(); } catch {} }, 30);
      } else if (mode === 'fail') {
        setTimeout(() => { try { socket.close(); } catch {} }, 20);
      }
      // mode 'hang': stay silent and open.
    });
  });
  servers[family] = wss;
}
process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-p02-out-'));

const { ensureStore, readDb, updateDb } = await import(pathToFileURL(path.join(REPO, 'server/store.ts')));
const { matchQuickCommand, handleQuickCommand } = await import(pathToFileURL(path.join(REPO, 'server/bot/quickRouter.ts')));
const { executeInternalBotCommand, executeToolCall } = await import(pathToFileURL(path.join(REPO, 'server/bots/executor.ts')));

ensureStore();
const TEST_QQ = '570341031';
updateDb((db) => {
  db.settings = { ...(db.settings || {}), ownerQq: TEST_QQ, memoryEnabled: false, osuClientId: 'fixture-client', osuClientSecret: 'fixture-secret' };
  db.groups = [{ groupId: '770001', name: 'P02', enabled: true, mode: 'normal', maxPerHour: 1000, cooldownSec: 0 }];
  db.groupBotConfig = { '770001': {} };
  db.osuBindings = { [TEST_QQ]: { id: 10000001, username: '[TST]Alpha' } };
});

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS [${name}]${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.error(`FAIL [${name}]${detail ? ' — ' + detail : ''}`); }
}
function snapshot() { return { kanon: attempts.kanon, yumu: attempts.yumu, lazybot: attempts.lazybot }; }
function delta(a, b, family) { return b[family] - a[family]; }

const eventBase = {
  source: 'onebot', type: 'group', groupId: '770001', userId: TEST_QQ, nickname: 'P02User',
  atTargets: [], images: [], raw: {},
};

async function runQuick(text) {
  const match = matchQuickCommand({ text, atTargets: [] });
  if (!match) throw new Error(`no match for ${text}`);
  const sends = [];
  const t0 = Date.now();
  const result = await handleQuickCommand(
    { ...eventBase, messageId: 'p02-' + Math.random().toString(36).slice(2), text },
    async (_ev, payload) => sends.push(payload),
    readDb(),
    match,
    { isOwner: true, isAdmin: true },
  );
  return { result, sends, elapsedMs: Date.now() - t0, match };
}

// 1. KANON_QUICK_BRIDGE_FAILS
{
  modes.kanon = 'fail'; modes.yumu = 'reply'; modes.lazybot = 'fail';
  const before = snapshot();
  const run = await runQuick('!re');
  const after = snapshot();
  ok('p02-kanon:matched-kanon', run.match.def.source === 'kanon' && run.match.def.id === 'recent');
  ok('p02-kanon:internal-result', run.result.reason === 'recent' && run.sends[0]?.includes('[TST]Alpha 最近一次 osu! 成绩'), JSON.stringify({ result: run.result, sends: run.sends }));
  ok('p02-kanon:bridge-count-1', delta(before, after, 'kanon') === 1, `kanon delta=${delta(before, after, 'kanon')}`);
  ok('p02-kanon:no-cross-bridge', delta(before, after, 'yumu') === 0 && delta(before, after, 'lazybot') === 0);
  ok('p02-kanon:no-long-wait', run.elapsedMs < 8000, `elapsed=${run.elapsedMs}ms`);
}

// 2. YUMU_QUICK_BRIDGE_FAILS
{
  modes.kanon = 'reply'; modes.yumu = 'fail'; modes.lazybot = 'fail';
  const before = snapshot();
  const run = await runQuick('!r');
  const after = snapshot();
  ok('p02-yumu:matched-yumu', run.match.def.source === 'yumu' && run.match.def.id === 'recent');
  ok('p02-yumu:internal-result', run.result.reason === 'recent' && run.sends[0]?.includes('[TST]Alpha 最近一次 osu! 成绩'));
  ok('p02-yumu:bridge-count-1', delta(before, after, 'yumu') === 1, `yumu delta=${delta(before, after, 'yumu')}`);
  ok('p02-yumu:no-cross-bridge', delta(before, after, 'kanon') === 0);
}

// 3. DIRECT_EXECUTOR_RECENT (no prior-bridge context -> bridge preserved)
{
  modes.kanon = 'reply'; modes.yumu = 'fail'; modes.lazybot = 'fail';
  const before = snapshot();
  const result = await executeInternalBotCommand(
    'kanon', 'recent', '',
    { db: readDb(), userId: TEST_QQ, groupId: '770001', event: { ...eventBase, text: '!re' } },
    undefined,
    undefined,
  );
  const after = snapshot();
  ok('p02-direct:bridge-preserved', delta(before, after, 'kanon') === 1, `kanon delta=${delta(before, after, 'kanon')}`);
  ok(
    'p02-direct:bridge-content',
    typeof result === 'object'
      && result.content.startsWith('bridge:kanon:ok')
      && result.content.includes('BID 1008'),
    JSON.stringify(result),
  );
}

// 4. FLAG_ONLY_SAME_TARGET (different-bot flag must NOT suppress kanon)
{
  modes.kanon = 'reply'; modes.yumu = 'fail'; modes.lazybot = 'fail';
  const before = snapshot();
  const result = await executeInternalBotCommand(
    'kanon', 'recent', '',
    { db: readDb(), userId: TEST_QQ, groupId: '770001', event: { ...eventBase, text: '!re' } },
    undefined,
    { bridgeAlreadyAttemptedFor: 'yumu' },
  );
  const after = snapshot();
  ok('p02-flag-scope:kanon-still-attempted', delta(before, after, 'kanon') === 1, `kanon delta=${delta(before, after, 'kanon')}`);
  ok(
    'p02-flag-scope:content',
    typeof result === 'object'
      && result.content.startsWith('bridge:kanon:ok')
      && result.content.includes('BID 1008'),
    JSON.stringify(result),
  );
}

// 5. AGENT / INTERNAL CALLER (executeToolCall query_osu recent)
{
  modes.kanon = 'reply'; modes.yumu = 'fail'; modes.lazybot = 'fail';
  const before = snapshot();
  const toolResult = await executeToolCall(
    { id: 'p02-agent', type: 'function', function: { name: 'query_osu', arguments: JSON.stringify({ bot: 'kanon', capability: 'recent', username: '[TST]Alpha' }) } },
    { db: readDb(), userId: TEST_QQ, groupId: '770001', event: { ...eventBase, text: 'show recent' }, sendMessage: async () => {} },
  );
  const after = snapshot();
  ok('p02-agent:bridge-preserved', delta(before, after, 'kanon') === 1, `kanon delta=${delta(before, after, 'kanon')}`);
  ok(
    'p02-agent:bridge-content',
    toolResult.ok === true
      && String(toolResult.content).includes('bridge:kanon:ok')
      && String(toolResult.content).includes('BID 1008'),
    JSON.stringify({ ok: toolResult.ok, content: String(toolResult.content).slice(0, 160) }),
  );
}

// 6. LAZYBOT_RECENT cross-target fallback preserved (lazybot fail -> yumu bridge)
{
  modes.kanon = 'fail'; modes.yumu = 'reply'; modes.lazybot = 'fail';
  const before = snapshot();
  const run = await runQuick('/pr');
  const after = snapshot();
  ok('p02-lazybot:matched-lazybot', run.match.def.source === 'lazybot' && run.match.def.id === 'recent');
  ok(
    'p02-lazybot:cross-target-yumu',
    run.result.reason === 'recent'
      && run.sends[0]?.includes('bridge:yumu:ok')
      && run.sends[0]?.includes('BID 1008'),
    JSON.stringify({ result: run.result, sends: run.sends }),
  );
  ok('p02-lazybot:lazybot-count-1', delta(before, after, 'lazybot') === 1, `lazybot delta=${delta(before, after, 'lazybot')}`);
  ok('p02-lazybot:yumu-count-1', delta(before, after, 'yumu') === 1, `yumu delta=${delta(before, after, 'yumu')}`);
}

// 7. FAILURE_CHAIN_LATENCY_MODEL: skip flag avoids hanging same-target bridge.
//    A hang server + 5s race proves the removed duplicate can no longer add a
//    60s wait (old behavior would hang here); mock osu completes the internal
//    path in <5s.
{
  modes.kanon = 'hang'; modes.yumu = 'fail'; modes.lazybot = 'fail';
  const before = snapshot();
  let outcome = null;
  const run = executeInternalBotCommand(
    'kanon', 'recent', '',
    { db: readDb(), userId: TEST_QQ, groupId: '770001', event: { ...eventBase, text: '!re' } },
    undefined,
    { bridgeAlreadyAttemptedFor: 'kanon' },
  ).then((value) => ({ kind: 'resolved', value }))
    .catch((error) => ({ kind: 'rejected', error: String(error?.message || error) }));
  outcome = await Promise.race([
    run,
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 5000)),
  ]);
  const after = snapshot();
  ok('p02-latency:no-second-bridge', delta(before, after, 'kanon') === 0, `kanon delta=${delta(before, after, 'kanon')}`);
  ok('p02-latency:internal-completes', outcome?.kind === 'resolved' && typeof outcome.value === 'string' && outcome.value.includes('[TST]Alpha 最近一次 osu! 成绩'), JSON.stringify(outcome));
}

// 8. Per-request scope: a NEW quick request still issues bridge #1.
{
  modes.kanon = 'fail'; modes.yumu = 'reply'; modes.lazybot = 'fail';
  const before = snapshot();
  const run = await runQuick('!re');
  const after = snapshot();
  ok('p02-scope:new-request-new-bridge', delta(before, after, 'kanon') === 1, `kanon delta=${delta(before, after, 'kanon')}`);
  ok('p02-scope:internal-result', run.result.reason === 'recent' && run.sends[0]?.includes('最近一次 osu! 成绩'));
}

// Teardown
for (const wss of Object.values(servers)) {
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((resolve) => wss.close(resolve));
}
await mock.close();
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

console.log(`\nquick-bridge-p02-recent-verify: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
