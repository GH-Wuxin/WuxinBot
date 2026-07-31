// bp-range-route-verify.mjs — E2E regression for "查一下我的bp1到bp10".
// Verifies:
//   1. detectRequiredOsuTool maps "bp1到bp10" → { capability:'bp', bp_start:1, bp_end:10 }
//   2. query_osu passes the range (bp_start/bp_end) into the tool call args
//   3. processIncoming never rejects with a security-policy error for query_osu
//   4. The requiredTool path executes exactly once and LLM writes only a lead
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-bprange');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectRequiredOsuTool } = await import('../server/bots/intent.ts');
const { validateOperation } = await import('../server/bots/guard.ts');
const { resolveBpQuerySelection } = await import('../server/bots/executor.ts');

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
let llmReceivedTools = null;
let capturedToolCalls = null; // assistant tool_calls captured in the lead request
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const request = JSON.parse(raw);
    llmCalls++;
    llmReceivedTools = request.tools || null;
    const msgs = request.messages || [];
    capturedToolCalls = msgs.filter(m => m.tool_calls?.length).map(m => m.tool_calls).flat();

    const hasToolCalls = msgs.some(m => m.tool_calls?.length);
    const hasToolResult = msgs.some(m => m.role === 'tool');

    let message;
    if (hasToolCalls && hasToolResult) {
      message = { role: 'assistant', content: '查好了。' };
    } else {
      message = { role: 'assistant', content: '不应该走这里。' };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'c' + llmCalls, object: 'chat.completion', created: Date.now(),
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    }));
  });
});
await new Promise(r => llmServer.listen(0, '127.0.0.1', r));
const llmPort = llmServer.address().port;

// ── Fixture ──

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
    db.groupBotConfig['REDACTED_GROUP_001'] = { yumu: true };
  });
}

async function runRangeE2E(label, userText, expectedArgs) {
  setupFixture();
  llmCalls = 0;
  llmReceivedTools = null;
  capturedToolCalls = null;

  const result = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'bpr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private', userId: 'REDACTED_QQ_001', nickname: 'Owner',
    text: userText,
    atTargets: [], images: [], raw: {}
  }, async () => {});

  // 1. No security-policy rejection
  if (result.reason && result.reason.includes('操作被安全策略拒绝')) {
    fail(label, `security policy rejected: ${result.reason}`);
    return;
  }
  // 2. No search interception
  if (result.reason && result.reason.includes('搜索')) {
    fail(label, `message was treated as web search: ${result.reason}`);
    return;
  }
  // 3. Exactly one LLM lead call, no tools offered
  if (llmCalls !== 1) {
    fail(label, `expected exactly 1 LLM lead call, got ${llmCalls}`);
    return;
  }
  if (llmReceivedTools) {
    fail(label, 'lead call must not receive tools');
    return;
  }
  // 4. Captured assistant tool_calls must carry the exact args
  const call = capturedToolCalls?.[0];
  if (!call || call.function?.name !== 'query_osu') {
    fail(label, `expected query_osu tool call, got ${JSON.stringify(call?.function?.name || null)}`);
    return;
  }
  const parsedArgs = JSON.parse(call.function.arguments || '{}');
  for (const [k, v] of Object.entries(expectedArgs)) {
    if (parsedArgs[k] !== v) {
      fail(label, `expected arg ${k}=${v}, got ${parsedArgs[k]}`);
      return;
    }
  }
  for (const [k, v] of Object.entries(parsedArgs)) {
    if (!(k in expectedArgs)) {
      fail(label, `unexpected arg ${k}=${v}`);
      return;
    }
  }
  pass(label + ` → query_osu ${JSON.stringify(parsedArgs)}`);
}

// ═══════════════════════════════════════════════════════
// Unit: intent → args mapping
// ═══════════════════════════════════════════════════════

console.log('=== Unit: detectRequiredOsuTool BP range mapping ===');

{
  const cases = [
    ['查一下我的bp1到bp10', { capability: 'bp', bp_start: 1, bp_end: 10 }],
    ['查一下bp1到bp10', { capability: 'bp', bp_start: 1, bp_end: 10 }],
    ['查一下我的bp1到bp100', { capability: 'bp', bp_start: 1, bp_end: 100 }],
    ['!bs 1-100', { capability: 'bp', bp_start: 1, bp_end: 100, compact: true }],
    ['查一下我的bs1', { capability: 'bp', bp_rank: 1 }],
    ['查一下我的bp1', { capability: 'bp', bp_rank: 1 }],
    ['看看我bp1', { capability: 'bp', bp_rank: 1 }],
    ['查一下我的bp', { capability: 'bp' }],
    ['查查我的bp', { capability: 'bp' }],
  ];
  for (const [text, expected] of cases) {
    const intent = detectRequiredOsuTool(text);
    if (!intent) { fail('intent-' + text, `detectRequiredOsuTool returned null`); continue; }
    if (intent.toolName !== 'query_osu') { fail('intent-' + text, `toolName=${intent.toolName}`); continue; }
    const a = intent.args;
    let ok = a.capability === expected.capability;
    if (expected.bp_rank !== undefined) ok = ok && a.bp_rank === expected.bp_rank;
    if (expected.bp_start !== undefined) ok = ok && a.bp_start === expected.bp_start;
    if (expected.bp_end !== undefined) ok = ok && a.bp_end === expected.bp_end;
    if (ok) pass('intent-' + text);
    else fail('intent-' + text, `got ${JSON.stringify(a)} expected ${JSON.stringify(expected)}`);
  }
}

// ═══════════════════════════════════════════════════════
// Unit: resolveBpQuerySelection — range is a list, rank is a single
// ═══════════════════════════════════════════════════════

console.log('\n=== Unit: resolveBpQuerySelection range vs single ===');

{
  const range = resolveBpQuerySelection({ bp_start: 1, bp_end: 10 });
  assert(range.startRank === 1 && range.endRank === 10, 'range startRank/endRank');
  assert(range.single === false, 'range must NOT be single');
  pass('bp-range-resolves-to-list');

  const single = resolveBpQuerySelection({ bp_rank: 1 });
  assert(single.startRank === 1 && single.endRank === 1, 'single rank');
  assert(single.single === true, 'single must be single');
  pass('bp-rank-resolves-to-single');
}

// ═══════════════════════════════════════════════════════
// E2E: processIncoming routes range to query_osu with exact args
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: "查一下我的bp1到bp10" through processIncoming ===');

await runRangeE2E('bp-range', '查一下我的bp1到bp10', { capability: 'bp', bp_start: 1, bp_end: 10 });
await runRangeE2E('bp-range-short', '查一下bp1到bp10', { capability: 'bp', bp_start: 1, bp_end: 10 });
await runRangeE2E('bp-range-100', '!bs 1-100', { capability: 'bp', bp_start: 1, bp_end: 100, compact: true });
await runRangeE2E('bp-rank1', '查一下我的bp1', { capability: 'bp', bp_rank: 1 });
await runRangeE2E('bp-no-range', '查一下我的bp', { capability: 'bp' });

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
  console.error('BP-RANGE-ROUTE-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('BP-RANGE-ROUTE-VERIFY PASSED');
process.exit(0);
