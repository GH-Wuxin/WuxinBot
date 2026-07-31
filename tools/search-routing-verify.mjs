// search-routing-verify.mjs — E2E regression for web-search routing.
// Named-bot requests and osu! data intents must NEVER be eaten by the web
// search interception. Only explicit network semantics (联网搜索/网上查/搜网页
// /查官网/搜新闻/找网页链接) count as a web search request.
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-searchroute');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectNamedBotRequest, detectRequiredOsuTool } = await import('../server/bots/intent.ts');
const { asksForExplicitSearch } = await import('../server/bot/prompt.ts');
const { DEFAULT_BOTS } = await import('../server/bots/registry.ts');

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
    // All four default bots registered (all internal) so named-bot detection works.
    db.settings.botRegistry = { updatedAt: new Date().toISOString(), bots: DEFAULT_BOTS };
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
    messageId: 'sr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private', userId: 'REDACTED_QQ_001', nickname: 'Owner',
    text: userText,
    atTargets: [], images: [], raw: {}
  }, async () => {});
}

// ═══════════════════════════════════════════════════════
// Unit: asksForExplicitSearch requires network semantics
// ═══════════════════════════════════════════════════════

console.log('=== Unit: asksForExplicitSearch semantics ===');

const searchTrue = [
  '帮我联网搜索今天天气', '联网查一下', '上网搜一下', '网上查查',
  '搜网页看看', '查官网', '搜新闻', '找网页链接', '百度一下', '搜狗查', 'google一下',
];
const searchFalse = [
  '查一下我的bp1', '用猫猫查一下我刚刚打了什么图', '帮我查一下今天天气',
  '查查我的bp', '搜一下recent', '帮我查recent', '今天天气怎么样', '查玩家资料',
];
for (const t of searchTrue) {
  if (asksForExplicitSearch(t)) pass('search-true-' + t);
  else fail('search-true-' + t, `expected true, got false`);
}
for (const t of searchFalse) {
  if (!asksForExplicitSearch(t)) pass('search-false-' + t);
  else fail('search-false-' + t, `expected false, got true`);
}

// ═══════════════════════════════════════════════════════
// Unit: detectNamedBotRequest
// ═══════════════════════════════════════════════════════

console.log('\n=== Unit: detectNamedBotRequest ===');

const bots = DEFAULT_BOTS.map(b => ({ id: b.id, name: b.name }));

const nameTrue = [
  ['用猫猫查一下我刚刚打了什么图', '猫猫'],
  ['调用LazyBot', 'LazyBot'],
  ['用雨沐查recent', '雨沐'],
  ['猫猫在吗', '猫猫'],
  ['让消防栓看看', '消防栓'],
];
for (const [t, name] of nameTrue) {
  const r = detectNamedBotRequest(t, bots);
  if (r && r.botName === name) pass('named-' + t);
  else fail('named-' + t, `expected bot ${name}, got ${JSON.stringify(r)}`);
}

const nameFalse = [
  '看看我的bp', '查玩家资料', '今天天气不错', '分析我的bp类型', '我想养一只猫',
  '让我先看看', '使用说明在哪', '切换输入法',
];
for (const t of nameFalse) {
  const r = detectNamedBotRequest(t, bots);
  if (!r) pass('named-false-' + t);
  else fail('named-false-' + t, `expected null, got ${JSON.stringify(r)}`);
}

// ═══════════════════════════════════════════════════════
// E2E: the five reported inputs must NOT trigger web search
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: named-bot / osu intents never eaten by search ===');

{
  const r = await send('用猫猫查一下我刚刚打了什么图');
  if (r.reason && r.reason.includes('搜索')) { fail('e2e-named-kanon-search', 'was treated as search: ' + r.reason); }
  else if (r.reason !== 'named_bot_no_adapter') { fail('e2e-named-kanon', `expected named_bot_no_adapter, got ${r.reason}`); }
  else if (llmCalls !== 0) { fail('e2e-named-kanon-llm', `must not call LLM, got ${llmCalls}`); }
  else if (!(r.text || '').includes('猫猫') || !(r.text || '').includes('接入 Harness')) { fail('e2e-named-kanon-text', `reply text wrong: ${r.text}`); }
  else pass('e2e-named-kanon');
}

{
  const r = await send('调用LazyBot');
  if (r.reason !== 'named_bot_no_adapter') { fail('e2e-named-lazybot', `expected named_bot_no_adapter, got ${r.reason}`); }
  else if (llmCalls !== 0) { fail('e2e-named-lazybot-llm', `must not call LLM, got ${llmCalls}`); }
  else pass('e2e-named-lazybot');
}

{
  // osu data intent with internal bot — deterministic query_osu, not search
  const r = await send('用雨沐查recent');
  if (r.reason && r.reason.includes('搜索')) { fail('e2e-yumu-search', 'was treated as search: ' + r.reason); }
  else if (r.reason && r.reason.includes('操作被安全策略拒绝')) { fail('e2e-yumu-policy', 'policy rejected: ' + r.reason); }
  else if (llmCalls !== 1) { fail('e2e-yumu-llm', `expected 1 LLM lead, got ${llmCalls}`); }
  else pass('e2e-yumu-recent');
}

{
  const r = await send('看看我的bp');
  if (r.reason && r.reason.includes('搜索')) { fail('e2e-bp-search', 'was treated as search: ' + r.reason); }
  else if (r.reason && r.reason.includes('操作被安全策略拒绝')) { fail('e2e-bp-policy', 'policy rejected: ' + r.reason); }
  else if (llmCalls !== 1) { fail('e2e-bp-llm', `expected 1 LLM lead, got ${llmCalls}`); }
  else pass('e2e-bp');
}

{
  const r = await send('查玩家资料');
  if (r.reason && r.reason.includes('搜索')) { fail('e2e-profile-search', 'was treated as search: ' + r.reason); }
  else if (r.reason && r.reason.includes('操作被安全策略拒绝')) { fail('e2e-profile-policy', 'policy rejected: ' + r.reason); }
  else if (llmCalls !== 1) { fail('e2e-profile-llm', `expected 1 LLM lead, got ${llmCalls}`); }
  else pass('e2e-profile');
}

// ═══════════════════════════════════════════════════════
// E2E: explicit network semantics still intercepted (no provider)
// ═══════════════════════════════════════════════════════

console.log('\n=== E2E: explicit network search still intercepted ===');

for (const [label, text] of [
  ['e2e-net1', '帮我联网搜索今天天气'],
  ['e2e-net2', '搜网页看看最近的osu新闻'],
  ['e2e-net3', '帮我在网上查一下osu排名'],
]) {
  const r = await send(text);
  if (!r.reason || !r.reason.includes('搜索')) { fail(label, `expected search interception, got ${r.reason || r.text}`); }
  else if (llmCalls !== 0) { fail(label, `must not call LLM on search-not-configured, got ${llmCalls}`); }
  else pass(label);
}

// Bare 查一下 must route to normal LLM, not search
{
  const r = await send('帮我查一下今天天气');
  if (r.reason && r.reason.includes('搜索')) { fail('e2e-bare-cha-search', 'bare 查一下 was treated as search: ' + r.reason); }
  else if (llmCalls !== 1) { fail('e2e-bare-cha-llm', `expected normal LLM call, got ${llmCalls}`); }
  else pass('e2e-bare-cha');
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
  console.error('SEARCH-ROUTING-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('SEARCH-ROUTING-VERIFY PASSED');
process.exit(0);
