// bp-type-analysis-guard-verify.mjs — regression for natural-language BP type
// analysis. Until osu!oracle is wired in, the bot must NOT fabricate proportions
// from PP+ dimensions. These intents get a deterministic "not integrated" reply
// and never reach the LLM. Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-bptype');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectBpTypeAnalysisIntent, detectRequiredOsuTool } = await import('../server/bots/intent.ts');

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

let llmCalls = 0;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    llmCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'c' + llmCalls, object: 'chat.completion', created: Date.now(),
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message: { role: 'assistant', content: '好的。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    }));
  });
});
await new Promise(r => llmServer.listen(0, '127.0.0.1', r));
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
    db.groupBotConfig = db.groupBotConfig || {};
  });
}

async function send(userText) {
  setupFixture();
  llmCalls = 0;
  return processIncoming({
    source: 'gui', type: 'private',
    messageId: 'bta-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private', userId: 'REDACTED_QQ_001', nickname: 'Owner',
    text: userText,
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
// E2E: analysis intents get the not-integrated reply, never LLM-fabricated
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: BP type analysis is intercepted, no fabricated proportions ===');

const FABRICATED_RE = /占比|六七成|一两张|百分之|典型\s*flow|典型flow|主要是(串|跳)/;

for (const [label, text] of [
  ['e2e-bptype-1', '分析我的bp类型'],
  ['e2e-bptype-2', '串图占比如何'],
  ['e2e-bptype-3', '跳图有多少'],
  ['e2e-bptype-4', '我的BP是什么类型'],
]) {
  const r = await send(text);
  if (r.reason !== 'bp_type_analysis_not_integrated') {
    fail(label, `expected bp_type_analysis_not_integrated, got ${r.reason}`);
    continue;
  }
  if (llmCalls !== 0) {
    fail(label, `must NOT call LLM, got ${llmCalls}`);
    continue;
  }
  if (!(r.text || '').includes('还没接入')) {
    fail(label, `reply must state not-integrated: ${r.text}`);
    continue;
  }
  if (FABRICATED_RE.test(r.text || '')) {
    fail(label, `reply contains fabricated proportions: ${r.text}`);
    continue;
  }
  pass(label);
}

// ═══════════════════════════════════════════════════════
// E2E: normal data queries are NOT swallowed by the analysis guard
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
