// agent-named-bot-constraint-verify.mjs
//
// V01_2: a user-named bot constraint must never be silently dropped when
// osuDataIntent routes through query_osu.
//
// Contract:
//   recent + named bot           → bot is attached to requiredTool and the
//                                  actual recent executor honors the selection
//                                  (kanon → kanon bridge; yumu/hydrant/lazybot
//                                  → yumu-compatible bridge).
//   non-recent + named bot       → internal result may still be produced, but
//                                  an explicit downgrade notice must be sent;
//                                  requiredTool args must NOT carry bot.
//
// Evidence sources: detectRequiredOsuTool/detectNamedBotRequest, real
// processIncoming with captured sends, real toolCallLogs audit args, and real
// synthetic local bridge servers (kanon/yumu) for actual executor routing.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = 'G:/QQ-AI-ChatBot';
const require = createRequire(path.join(REPO, 'package.json'));
const { WebSocketServer } = require('ws');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-namedbot-constraint-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PIPPI_AGENT_RUNTIME_MODE = 'legacy';

// osu API mock + synthetic bridge env must exist before server modules load.
const { startOsuApiMock } = await import(pathToFileURL(path.join(REPO, 'tools/osu-api-mock.mjs')));
const osuMock = await startOsuApiMock();
process.env.OSU_API_BASE_URL = osuMock.apiBase;
process.env.OSU_TOKEN_URL = osuMock.tokenUrl;

const attempts = { kanon: 0, yumu: 0 };
const bridgeServers = {};
for (const family of ['kanon', 'yumu']) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  process.env[`BRIDGE_URL_${family.toUpperCase()}`] = `ws://127.0.0.1:${wss.address().port}`;
  wss.on('connection', (socket) => {
    attempts[family]++;
    let first = true;
    socket.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(String(data)); } catch {}
      if (!first || !parsed || parsed.post_type !== 'message') return;
      first = false;
      socket.send(JSON.stringify({
        action: 'send_msg',
        echo: `e-${family}`,
        params: { message: `bridge:${family}:ok` },
      }));
      setTimeout(() => { try { socket.close(); } catch {} }, 30);
    });
  });
  bridgeServers[family] = wss;
}
process.env.BRIDGE_OUTPUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-namedbot-bridge-out-'));

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const {
  detectNamedBotRequest,
  detectRequiredOsuTool,
} = await import('../server/bots/intent.ts');
const { validateOperation } = await import('../server/bots/guard.ts');

let passed = 0;
let failed = 0;
function pass(label) { console.log(`PASS [${label}]`); passed++; }
function fail(label, message) { console.error(`FAIL [${label}]: ${message}`); failed++; }
function check(condition, label, message) {
  if (condition) pass(label);
  else fail(label, message);
}
function snapshot() { return { kanon: attempts.kanon, yumu: attempts.yumu }; }
function delta(before, after, family) { return after[family] - before[family]; }

const BOUND_QQ = '570341031';
const UNBOUND_QQ = 'unbound-user';
const BOTS = ['yumu', 'kanon', 'hydrant', 'lazybot'].map((id, index) => ({
  id,
  name: ['雨沐', '猫猫', '消防栓', 'LazyBot'][index],
  description: 'osu! data',
  qq: '',
  channel: 'internal',
  enabled: true,
  commands: [{ name: 'recent', trigger: '/r', description: 'recent', params: [], returns: 'both' }],
}));

let llmCalls = 0;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    llmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `c${llmCalls}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message: { role: 'assistant', content: '查好了。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
  });
});
await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
const llmPort = llmServer.address().port;

ensureStore();
function setupFixture(bound) {
  updateDb((db) => {
    db.settings = {
      ...(db.settings || {}),
      ownerQq: 'REDACTED_QQ_001',
      selfQq: 'REDACTED_QQ_002',
      llmProvider: 'deepseek',
      apiKey: 'fixture-key',
      deepseekApiKey: 'fixture-key',
      apiBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
      deepseekApiBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
      enableAutoModel: false,
      thinkingNoticeMode: 'off',
      memoryEnabled: false,
      enableWebSearch: false,
      osuClientId: 'fixture-client',
      osuClientSecret: 'fixture-secret',
      botRegistry: { updatedAt: new Date().toISOString(), bots: BOTS },
    };
    db.osuBindings = bound ? { [BOUND_QQ]: 10000001 } : {};
    db.messages = [];
    db.decisions = [];
    db.commandLogs = [];
    db.toolCallLogs = [];
    db.groups = [{
      groupId: 'test-group', name: '测试群', enabled: true,
      mode: 'normal', maxPerHour: 50, cooldownSec: 0,
    }];
  });
}

async function sendCase(text, { bound }) {
  setupFixture(bound);
  llmCalls = 0;
  const before = snapshot();
  const sends = [];
  const result = await processIncoming({
    source: 'gui', type: 'group',
    messageId: 'nbc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'test-group',
    userId: bound ? BOUND_QQ : UNBOUND_QQ,
    nickname: 'Tester',
    text: '[CQ:at,qq=REDACTED_QQ_002] ' + text,
    atTargets: [], images: [], raw: {},
  }, async (_event, payload) => {
    sends.push(String(payload || ''));
  });
  const after = snapshot();
  const logs = readDb().toolCallLogs || [];
  return { result, sends, logs, deltas: { kanon: delta(before, after, 'kanon'), yumu: delta(before, after, 'yumu') } };
}

const supportedRecentCases = [
  ['kanon-recent', 'kanon', '用猫猫查我 recent', 'kanon'],
  ['yumu-recent', 'yumu', '用雨沐查我 recent', 'yumu'],
];

const unsupportedRecentCases = [
  ['hydrant-recent', 'hydrant', '消防栓', '用消防栓查我 recent'],
  ['lazybot-recent', 'lazybot', 'LazyBot', '用 LazyBot 查我 recent'],
];

console.log('\n=== recent + named bot: supported selectors reach their real backend ===');
for (const [label, botId, text, expectedBridge] of supportedRecentCases) {
  const intent = detectRequiredOsuTool(text.replace(/^\[CQ:[^\]]+\]\s*/, ''));
  const named = detectNamedBotRequest(text.replace(/^\[CQ:[^\]]+\]\s*/, ''), BOTS);
  check(intent?.args?.capability === 'recent', `${label}-osu-intent`, JSON.stringify(intent));
  check(named?.botId === botId, `${label}-named-bot`, JSON.stringify(named));

  const run = await sendCase(text, { bound: true });
  const audit = run.logs[0];
  check(
    audit?.capability === 'recent' && audit?.args?.bot === botId,
    `${label}-required-tool-bot-attached`,
    JSON.stringify({ audit, logs: run.logs.length }),
  );
  check(
    run.deltas[expectedBridge] === 1,
    `${label}-actual-executor-${expectedBridge}`,
    JSON.stringify(run.deltas),
  );
  const otherBridge = expectedBridge === 'kanon' ? 'yumu' : 'kanon';
  check(run.deltas[otherBridge] === 0, `${label}-no-wrong-bridge`, JSON.stringify(run.deltas));
  check(
    !run.sends.some((payload) => /降级|暂不支持/.test(payload)),
    `${label}-no-downgrade-notice`,
    JSON.stringify(run.sends.map((payload) => payload.slice(0, 80))),
  );
  check(validateOperation({ type: 'query_osu', params: { capability: 'recent', bot: botId } }).ok, `${label}-guard-allows`, `bot=${botId}`);
}

console.log('\n=== recent + named bot: unsupported selectors degrade explicitly (no silent yumu alias) ===');
for (const [label, botId, botName, text] of unsupportedRecentCases) {
  const clean = text.replace(/^\[CQ:[^\]]+\]\s*/, '');
  const intent = detectRequiredOsuTool(clean);
  const named = detectNamedBotRequest(clean, BOTS);
  check(intent?.args?.capability === 'recent', `${label}-osu-intent`, JSON.stringify(intent));
  check(named?.botId === botId, `${label}-named-bot`, JSON.stringify(named));

  const run = await sendCase(text, { bound: true });
  const audit = run.logs[0];
  check(
    audit?.capability === 'recent' && audit?.args?.bot === undefined,
    `${label}-required-tool-no-bot-param`,
    JSON.stringify({ audit, logs: run.logs.length }),
  );
  check(
    run.deltas.yumu === 1 && run.deltas.kanon === 0,
    `${label}-actual-backend-internal-yumu-route`,
    JSON.stringify(run.deltas),
  );
  check(
    run.sends.some((payload) => payload.includes('降级') && payload.includes(botName)),
    `${label}-explicit-downgrade-notice`,
    JSON.stringify(run.sends.map((payload) => payload.slice(0, 120))),
  );
  check(validateOperation({ type: 'query_osu', params: { capability: 'recent', bot: botId } }).ok === false, `${label}-guard-rejects-selector`, `bot=${botId}`);
}

const nonRecentCases = [
  ['kanon-bp', 'kanon', '猫猫', '用猫猫查我 BP1', 'bp'],
  ['yumu-bp', 'yumu', '雨沐', '用雨沐查我 BP1', 'bp'],
  ['hydrant-bp', 'hydrant', '消防栓', '用消防栓查我 BP1', 'bp'],
  ['lazybot-bp', 'lazybot', 'LazyBot', '用 LazyBot 查我 BP1', 'bp'],
  ['lazybot-info', 'lazybot', 'LazyBot', '用 LazyBot 查我的玩家信息', 'info'],
];

console.log('\n=== non-recent + named bot: explicit downgrade, constraint not silently dropped ===');
for (const [label, botId, botName, text, capability] of nonRecentCases) {
  const clean = text.replace(/^\[CQ:[^\]]+\]\s*/, '');
  const intent = detectRequiredOsuTool(clean);
  const named = detectNamedBotRequest(clean, BOTS);
  check(intent?.args?.capability === capability, `${label}-osu-intent`, JSON.stringify(intent));
  check(named?.botId === botId, `${label}-named-bot`, JSON.stringify(named));

  const run = await sendCase(text, { bound: false });
  const audit = run.logs[0];
  check(
    audit?.capability === capability && audit?.args?.bot === undefined,
    `${label}-required-tool-no-bot-param`,
    JSON.stringify({ audit, logs: run.logs.length }),
  );
  check(
    run.sends.some((payload) => payload.includes('降级') && payload.includes(botName)),
    `${label}-explicit-downgrade-notice`,
    JSON.stringify(run.sends.map((payload) => payload.slice(0, 120))),
  );
  check(
    run.result.replied === true && String(run.result.text || '').includes('无法确定要查询的 osu! 用户名'),
    `${label}-internal-result-still-produced`,
    JSON.stringify(run.result),
  );
  check(validateOperation({ type: 'query_osu', params: { capability, bot: botId } }).ok === false, `${label}-guard-rejects-unused-bot`, `capability=${capability} bot=${botId}`);
}

console.log('\n=== production invariant: no dormant bot tools re-exposed ===');
{
  const schemas = (await import('../server/bots/registry.ts')).buildBotToolSchemas({ bots: BOTS, updatedAt: '' });
  const names = schemas.map((tool) => tool.function.name);
  check(!names.includes('query_bot') && !names.includes('query_external_bot'), 'invariant-no-dormant-tools', JSON.stringify(names));
  const queryOsu = schemas.find((tool) => tool.function.name === 'query_osu');
  check(
    JSON.stringify(queryOsu?.function?.parameters?.properties?.bot?.enum) === JSON.stringify(['yumu', 'kanon']) &&
    queryOsu.function.parameters.properties.bot.description.includes('仅 capability=recent'),
    'invariant-bot-enum-only-supported-selectors',
    JSON.stringify(queryOsu?.function?.parameters?.properties?.bot),
  );
}

for (const wss of Object.values(bridgeServers)) {
  for (const client of wss.clients) { try { client.terminate(); } catch {} }
  await new Promise((resolve) => wss.close(resolve));
}
llmServer.close();
await osuMock.close();
try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('AGENT-NAMED-BOT-CONSTRAINT-VERIFY FAILED');
  process.exit(1);
}
console.log('AGENT-NAMED-BOT-CONSTRAINT-VERIFY PASSED');
