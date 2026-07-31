// named-bot-sandbox-verify.mjs — can kanon/hydrant/lazybot be called?
// Verifies the actual message SOURCE for each phrasing:
//  - named request WITHOUT data intent → named-bot guard (named_bot_no_adapter)
//  - named request WITH data intent → Wuxin internal query_osu (wuxin_internal)
//  - query_external_bot is never offered to the LLM
import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-namedbot');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { buildBotToolSchemas } = await import('../server/bots/registry.ts');

ensureStore();

let passed = 0;
let failed = 0;
function pass(label) { console.log(`PASS [${label}]`); passed++; }
function fail(label, msg) { console.error(`FAIL [${label}]: ${msg}`); failed++; }

let llmCalls = 0;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    llmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (raw.includes('"tools"') && llmCalls === 1) {
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: Date.now(), model: 'mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc1', type: 'function',
              function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'bp', bp_rank: 1 }) }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    } else {
      const relay = raw.includes('无法确定要查询的 osu! 用户名')
        ? '需要绑定：无法确定要查询的 osu! 用户名，请先使用 /w osu bind 绑定账号。'
        : '好的。';
      res.end(JSON.stringify({
        id: 'c2', object: 'chat.completion', created: Date.now(), model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: relay }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      }));
    }
  });
});
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
const llmPort = llmServer.address().port;

const BOTS = ['yumu', 'kanon', 'hydrant', 'lazybot'].map((id, index) => ({
  id,
  name: ['雨沐', '猫猫', '消防栓', 'LazyBot'][index],
  description: 'osu! data',
  qq: '',
  channel: 'internal',
  enabled: true,
  commands: [{ name: 'bp', trigger: '/bp', description: 'best plays', params: [], returns: 'image' }],
}));

function setupFixture() {
  updateDb((db) => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.settings.botNames = '小深,bot,pippi';
    db.settings.llmProvider = 'deepseek';
    db.settings.apiKey = 'fixture-key';
    db.settings.deepseekApiKey = 'fixture-key';
    db.settings.apiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.deepseekApiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.enableAutoModel = false;
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.settings.enableWebSearch = false;
    db.settings.botRegistry = { updatedAt: new Date().toISOString(), bots: BOTS };
    db.osuBindings = {};
    db.messages = [];
    db.decisions = [];
    db.commandLogs = [];
    db.groups = [{
      groupId: 'test-group', name: '测试群', enabled: true,
      mode: 'normal', maxPerHour: 50, cooldownSec: 0,
    }];
  });
}

async function send(text, userId = 'unbound-user') {
  setupFixture();
  llmCalls = 0;
  return processIncoming({
    source: 'gui', type: 'group',
    messageId: 'nb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'test-group', userId, nickname: 'Tester',
    text: '[CQ:at,qq=REDACTED_QQ_002] ' + text,
    atTargets: [], images: [], raw: {}
  }, async () => {});
}

// ── Schema: external bot tool is never offered ──
console.log('=== Schema: query_external_bot is not exposed ===');
{
  const schemas = buildBotToolSchemas({ bots: BOTS, updatedAt: '' });
  if (schemas.some((tool) => tool.function.name === 'query_external_bot')) {
    fail('schema-no-external-tool', 'query_external_bot must NOT be offered to the LLM');
  } else {
    console.log('SOURCE [schema]: query_external_bot absent; only query_osu (+skills) exposed');
    pass('schema-no-external-tool');
  }
}

// ── Named request WITHOUT data intent → named-bot guard ──
console.log('\n=== Named requests without data intent → named_bot_no_adapter ===');
for (const [label, botName, text] of [
  ['kanon-guard', '猫猫', '让猫猫帮我看看'],
  ['hydrant-guard', '消防栓', '用消防栓查一下'],
  ['lazybot-guard', 'LazyBot', '调用LazyBot'],
  ['yumu-guard', '雨沐', '叫雨沐帮个忙'],
]) {
  const r = await send(text);
  if (r.reason !== 'named_bot_no_adapter') {
    fail(label, `expected named_bot_no_adapter, got ${r.reason}: ${r.text}`);
    continue;
  }
  if (!(r.text || '').includes(botName)) {
    fail(label, `reply must name the requested bot: ${r.text}`);
    continue;
  }
  if (llmCalls !== 0) {
    fail(label, `guard must not call the LLM, got ${llmCalls}`);
    continue;
  }
  console.log(`SOURCE [${label}]: 「${text}」 → ${botName} named-bot guard (reason=${r.reason})`);
  pass(label);
}

// ── Named request WITH data intent → Wuxin internal query_osu ──
console.log('\n=== Named requests with data intent → wuxin_internal query_osu ===');
for (const [label, botName, text] of [
  ['kanon-data', '猫猫', '用猫猫查一下我的bp1'],
  ['hydrant-data', '消防栓', '让消防栓查一下我的bp1'],
  ['lazybot-data', 'LazyBot', '调用LazyBot查我的bp1'],
  ['yumu-data', '雨沐', '雨沐查一下我的bp1'],
]) {
  const r = await send(text);
  if (r.reason === 'named_bot_no_adapter') {
    fail(label, `data intent must bypass the named-bot guard: ${r.text}`);
    continue;
  }
  if (!(r.text || '').includes('无法确定要查询的 osu! 用户名')) {
    fail(label, `expected wuxin_internal binding error as source, got: ${r.text.slice(0, 120)}`);
    continue;
  }
  console.log(`SOURCE [${label}]: 「${text}」 → query_osu executed by wuxin_internal (reason=${r.reason || 'tool path'})`);
  pass(label);
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
llmServer.close();

const prodOk = verifyProductionDbUnchanged(prodBefore);
if (!prodOk) {
  console.error('FATAL: production database was modified during test!');
  failed++;
}
cleanupTestDir(testDataDir);

if (failed > 0) {
  console.error('NAMED-BOT-SANDBOX-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('NAMED-BOT-SANDBOX-VERIFY PASSED');
process.exit(0);
