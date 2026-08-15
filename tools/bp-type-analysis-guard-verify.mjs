// bp-type-analysis-guard-verify.mjs — BP-type intents are deterministically
// routed to query_osu/bp_type, whose osu!oracle output cannot fabricate ratios.
import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-bptype');
process.env.DATA_DIR = testDataDir;
process.env.OSU_ORACLE_DISABLED = '1';
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectBpTypeAnalysisIntent, detectRequiredOsuTool } = await import('../server/bots/intent.ts');
const { buildBotToolSchemas } = await import('../server/bots/registry.ts');
const { validateOperation } = await import('../server/bots/guard.ts');
const { formatClassifierBlock } = await import('../server/osu/classifier.ts');

ensureStore();

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

// ── Mock LLM server ──
// First call returns a query_osu/bp_type tool call; later calls return text.
let llmCalls = 0;
let respondWithTool = true;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    llmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (respondWithTool && raw.includes('"tools"') && llmCalls === 1) {
      res.end(JSON.stringify({
        id: 'c' + llmCalls, object: 'chat.completion', created: Date.now(),
        model: 'mock',
        choices: [{
          index: 0,
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'tc1', type: 'function',
              function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'bp_type' }) }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    } else {
      const relay = raw.includes('需要先绑定')
        ? '需要绑定：无法确定要查询的 osu! 用户名，请先使用 /w osu bind 绑定账号。'
        : '好的。';
      res.end(JSON.stringify({
        id: 'c' + llmCalls, object: 'chat.completion', created: Date.now(),
        model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: relay }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      }));
    }
  });
});
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
const llmPort = llmServer.address().port;

function setupFixture() {
  updateDb(db => {
    db.settings.ownerQq = 'REDACTED_QQ_001';
    db.settings.selfQq = 'REDACTED_QQ_002';
    db.settings.llmProvider = 'deepseek';
    db.settings.apiKey = 'fixture-key';
    db.settings.deepseekApiKey = 'fixture-key';
    db.settings.apiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.deepseekApiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.enableAutoModel = false;
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    db.settings.enableWebSearch = false;
    db.settings.botRegistry = {
      updatedAt: new Date().toISOString(),
      bots: [{
        id: 'yumu', name: '雨沐', description: 'osu! data',
        qq: '', channel: 'internal', enabled: true,
        commands: [
          { name: 'recent', trigger: '/r', description: 'recent', params: [], returns: 'image' },
          { name: 'bp', trigger: '/bp', description: 'best plays', params: [], returns: 'image' },
          { name: 'info', trigger: '/i', description: 'player info', params: [], returns: 'image' },
        ]
      }]
    };
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['REDACTED_QQ_001'] = 1234567;
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

async function send(userText, userId = 'REDACTED_QQ_001') {
  setupFixture();
  llmCalls = 0;
  return processIncoming({
    source: 'gui', type: 'group',
    messageId: 'bta-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'test-group', userId, nickname: 'Owner',
    text: '[CQ:at,qq=REDACTED_QQ_002] ' + userText,
    atTargets: [], images: [], raw: {}
  }, async () => {});
}

// ═══════════════════════════════════════════════════════
// Unit: detectBpTypeAnalysisIntent
// ═══════════════════════════════════════════════════════

console.log('=== Unit: detectBpTypeAnalysisIntent ===');

const analysisTrue = [
  '分析我的bp类型', '串图占比如何', '跳图有多少', '我的BP是什么类型',
  '我的bp是什么类型', '看看我的BP类型', '我aim图比例多少',
];
for (const t of analysisTrue) {
  if (detectBpTypeAnalysisIntent(t)) pass('analysis-true-' + t);
  else fail('analysis-true-' + t, `expected true, got false`);
}

const analysisFalse = [
  '查一下我的bp1到bp10', '看看我bp1', '查玩家资料', '今天天气不错',
  '这图是跳图', '打osu', '我适合打什么图',
];
for (const t of analysisFalse) {
  if (!detectBpTypeAnalysisIntent(t)) pass('analysis-false-' + t);
  else fail('analysis-false-' + t, `expected false, got true`);
}

// ═══════════════════════════════════════════════════════
// Unit: bp_type is exposed as an LLM tool; external bot tool stays closed
// ═══════════════════════════════════════════════════════

console.log('\n=== Unit: tool schema exposes bp_type, not query_external_bot ===');

{
  const schemas = buildBotToolSchemas({
    bots: [{
      id: 'yumu', name: '雨沐', description: 'osu! data',
      qq: '', channel: 'internal', enabled: true,
      commands: [{ name: 'bp', trigger: '/bp', description: 'best plays', params: [], returns: 'image' }],
    }],
    updatedAt: '',
  });
  const queryOsu = schemas.find((tool) => tool.function.name === 'query_osu');
  assert(queryOsu, 'query_osu must be exposed to the LLM');
  const capabilities = queryOsu.function.parameters.properties.capability?.enum || [];
  assert(capabilities.includes('bp_type'), 'query_osu must expose the bp_type capability');
  assert(
    !schemas.some((tool) => tool.function.name === 'query_external_bot'),
    'query_external_bot must NOT be offered to the LLM',
  );
  const op = validateOperation({ type: 'query_osu', params: { capability: 'bp_type', username: '[TST]Alpha' } });
  assert(op.ok, 'bp_type operation must pass the security guard');
  pass('tool-schema-bp_type');
}

// ═══════════════════════════════════════════════════════
// Unit: formatClassifierBlock renders real distributions without LLM
// ═══════════════════════════════════════════════════════

console.log('\n=== Unit: formatClassifierBlock ===');

{
  const block = formatClassifierBlock({
    distribution: { stream: 8, aim: 2 },
    details: {},
    totalClassified: 10,
    errors: [],
  });
  assert(block.includes('stream') && block.includes('80%'), 'stream share must render with percentage');
  assert(block.includes('aim') && block.includes('20%'), 'aim share must render with percentage');
  assert(block.includes('串图倾向明显'), 'dominant category summary expected');
  assert(block.includes('BP10 分类统计'), 'classifier block must state the classified count');
  pass('format-classifier-block');
}

// ═══════════════════════════════════════════════════════
// E2E: bp_type intent is deterministically forced before the LLM; result stays deterministic
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: bp_type is deterministically forced ===');

for (const [label, text] of [
  ['e2e-bptype-1', '分析我的bp类型'],
  ['e2e-bptype-2', '串图占比如何'],
  ['e2e-bptype-3', '跳图有多少'],
  ['e2e-bptype-4', '我的BP是什么类型'],
]) {
  respondWithTool = true;
  const r = await send(text, 'unbound-user');
  if (r.replied !== true) {
    fail(label, `expected a reply, got ${JSON.stringify(r)}`);
    continue;
  }
  if (llmCalls !== 0) {
    fail(label, `deterministic error path must not call the LLM, got ${llmCalls} calls`);
    continue;
  }
  if (!(r.text || '').includes('无法确定要查询的 osu! 用户名')) {
    fail(label, `deterministic tool error must reach the reply: ${r.text}`);
    continue;
  }
  const audit = (readDb().toolCallLogs || []).slice(-1)[0];
  if (!audit || audit.capability !== 'bp_type' || audit.ok !== false || !audit.createdAt) {
    fail(label, `query_osu audit log missing/incorrect: ${JSON.stringify(audit)}`);
    continue;
  }
  if (/占比|百分之|典型(串|跳)|主要(串|跳)/.test(r.text || '')) {
    fail(label, `reply contains fabricated proportions: ${r.text}`);
    continue;
  }
  pass(label);
}

// ═══════════════════════════════════════════════════════
// E2E: bp_type intent forces the tool even when the LLM would not call it
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: bp_type intent forces deterministic tool ===');

{
  respondWithTool = false;
  const r = await send('分析一下我的bp构成', 'unbound-user');
  if (!(r.text || '').includes('无法确定要查询的 osu! 用户名')) {
    fail('e2e-bptype-forced', `forced tool result must reach the reply: ${r.text}`);
  } else if (llmCalls !== 0) {
    fail('e2e-bptype-forced-llm', `deterministic error path must not call the LLM, got ${llmCalls}`);
  } else if (!(readDb().toolCallLogs || []).some((x) => x.capability === 'bp_type')) {
    fail('e2e-bptype-forced-audit', 'query_osu bp_type audit log missing');
  } else {
    pass('e2e-bptype-forced');
  }
}

// `查 @某人 的 BP 类型` used to be consumed by Hydrant's generic 查@ profile
// router before the deterministic bp_type route could run.
{
  setupFixture();
  llmCalls = 0;
  const r = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'bta-at-' + Date.now(),
    groupId: 'private', userId: 'REDACTED_QQ_001', nickname: 'Owner',
    text: '查 [CQ:at,qq=REDACTED_QQ_004] 的 BP 类型',
    atTargets: ['REDACTED_QQ_004'], images: [], raw: {},
  }, async () => {});
  const audit = (readDb().toolCallLogs || []).slice(-1)[0];
  if (!audit || audit.capability !== 'bp_type') {
    fail('e2e-bptype-at-route', `@ BP type query was not routed to bp_type: ${JSON.stringify(r)}`);
  } else if (llmCalls !== 0) {
    fail('e2e-bptype-at-route-llm', `deterministic @ error path must not call LLM, got ${llmCalls}`);
  } else {
    pass('e2e-bptype-at-route');
  }
}

// ═══════════════════════════════════════════════════════
// E2E: normal data queries still route to query_osu
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: data queries still route to query_osu ===');

{
  const intent = detectRequiredOsuTool('查一下我的bp1到bp10');
  assert(intent && intent.args.capability === 'bp' && intent.args.bp_start === 1 && intent.args.bp_end === 10,
    'intent mapping for bp1到bp10');

  const r = await send('查一下我的bp1到bp10');
  if (r.reason && (r.reason.includes('操作被安全策略拒绝') || r.reason.includes('bp_type_analysis'))) {
    fail('e2e-data-bprange', `data query wrongly intercepted: ${r.reason}`);
  } else if (llmCalls !== 1) {
    fail('e2e-data-bprange-llm', `expected 1 LLM lead, got ${llmCalls}`);
  } else if (!(readDb().toolCallLogs || []).some((x) => x.capability === 'bp' && x.args?.bp_start === 1)) {
    fail('e2e-data-bprange-audit', 'query_osu bp audit log missing');
  } else {
    pass('e2e-data-bprange');
  }
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
  console.error('BP-TYPE-ANALYSIS-GUARD-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('BP-TYPE-ANALYSIS-GUARD-VERIFY PASSED');
process.exit(0);
