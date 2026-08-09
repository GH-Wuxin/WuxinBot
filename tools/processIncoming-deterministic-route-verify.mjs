// processIncoming-deterministic-route-verify.mjs
// End-to-end tests: real user expressions entering processIncoming must hit
// the deterministic requiredTool path and NOT be intercepted by search detection.
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-detroute');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

// Record production state BEFORE any server module is loaded
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectRequiredOsuTool } = await import('../server/bots/intent.ts');

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
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const request = JSON.parse(raw);
    llmCalls++;
    llmReceivedTools = request.tools || null;

    // Record message structure for protocol verification
    const msgRoles = (request.messages || []).map(m => m.role);
    const hasToolCalls = msgRoles.includes('assistant') &&
      (request.messages || []).some(m => m.tool_calls?.length);
    const hasToolResult = msgRoles.includes('tool');

    let message;
    if (hasToolCalls && hasToolResult) {
      // After requiredTool execution — only write a short lead
      message = { role: 'assistant', content: '查好了。' };
    } else {
      // Should never reach free tool selection for osu data messages
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

// ── Set up shared fixture ──

function setupFixture() {
  updateDb(db => {
    db.settings.ownerQq = '1000000001';
    db.settings.selfQq = '900000029';
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
    // QQ → osu! binding so resolveInternalPlayerTarget works
    db.osuBindings = db.osuBindings || {};
    db.osuBindings['1000000001'] = 1234567;
    // Group allows yumu
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['200000001'] = { yumu: true };
  });
}

// ═══════════════════════════════════════════════════════
// Test helper: send a message through processIncoming and verify routing
// ═══════════════════════════════════════════════════════

async function testDeterministicRoute(label, userText, expectedCapability) {
  setupFixture();
  llmCalls = 0;
  llmReceivedTools = null;

  const sends = [];
  let toolExecuted = false;

  const result = await processIncoming({
    source: 'gui',
    type: 'private',
    messageId: 'det-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private',
    userId: '1000000001',
    nickname: 'Owner',
    text: userText,
    atTargets: [],
    images: [],
    raw: {}
  }, async (evt, text) => {
    sends.push({ userId: evt.userId, text: String(text || '').slice(0, 120) });
  });

  // Verify intent was detected
  const intent = detectRequiredOsuTool(userText);
  if (!intent) {
    fail(label, `detectRequiredOsuTool returned null for "${userText}"`);
    return;
  }
  if (intent.args.capability !== expectedCapability) {
    fail(label, `expected capability=${expectedCapability}, got ${intent.args.capability}`);
    return;
  }

  // Verify not intercepted by search
  if (result.reason && result.reason.includes('搜索')) {
    fail(label, `message was intercepted by search: ${result.reason}`);
    return;
  }

  // Verify reply was produced
  if (!result.replied) {
    fail(label, `processIncoming did not reply (reason: ${result.reason})`);
    return;
  }

  // Verify only 1 LLM call (lead only, no tool selection)
  // The LLM fixture returns different responses based on message structure.
  // With requiredTool: assistant(tool_calls) + tool messages present → LLM writes lead
  if (llmCalls === 0) {
    fail(label, 'LLM was never called');
    return;
  }
  if (llmCalls > 1) {
    fail(label, `LLM called ${llmCalls} times, expected 1 (lead only)`);
    return;
  }

  // Verify LLM received no tools
  if (llmReceivedTools) {
    fail(label, 'LLM lead call must not receive tools');
    return;
  }

  pass(label + ` → query_osu/${expectedCapability}`);
}

// ═══════════════════════════════════════════════════════
// Test: messages that contain search-like keywords but are osu data queries
// ═══════════════════════════════════════════════════════

console.log('=== osu! data queries with search-like keywords ===');

await testDeterministicRoute('search-bp1', '查一下我的bp1', 'bp');
await testDeterministicRoute('search-bp', '查查我的bp', 'bp');
await testDeterministicRoute('search-recent', '帮我查recent', 'recent');
await testDeterministicRoute('search-bp-range', '查一下bp1到bp10', 'bp');
await testDeterministicRoute('search-bp-look', '看看我的bp1', 'bp');

// ═══════════════════════════════════════════════════════
// Test: explicit network-search requests still intercepted
// Only explicit network semantics (联网搜索/网上查/搜网页/… ) count as web
// search. A bare "查一下今天天气" is NOT web search — it routes to the LLM.
// ═══════════════════════════════════════════════════════

console.log('\n=== Explicit network-search requests still intercepted ===');

{
  setupFixture();
  llmCalls = 0;
  const result = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'det-search-' + Date.now(),
    groupId: 'private', userId: '1000000001', nickname: 'Owner',
    text: '帮我联网搜索一下今天天气',
    atTargets: ['900000029'], images: [], raw: { self_id: '900000029' }
  }, async () => {});

  if (!result.reason || !result.reason.includes('搜索')) {
    fail('search-intercept', 'explicit network search query was not intercepted');
  } else {
    pass('search-intercept');
  }
}

{
  setupFixture();
  llmCalls = 0;
  const result = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'det-nosearch-' + Date.now(),
    groupId: 'private', userId: '1000000001', nickname: 'Owner',
    text: '帮我查一下今天天气',
    atTargets: ['900000029'], images: [], raw: { self_id: '900000029' }
  }, async () => {});

  // Bare 查一下 must NOT be intercepted as web search (routes to normal LLM).
  if (result.reason && result.reason.includes('搜索')) {
    fail('bare-cha-not-search', `bare "查一下" was treated as web search: ${result.reason}`);
  } else {
    pass('bare-cha-not-search');
  }
}

// ═══════════════════════════════════════════════════════
// Test: casual chat still goes through normal path
// ═══════════════════════════════════════════════════════

console.log('\n=== Casual chat not forced ===');

{
  setupFixture();
  llmCalls = 0;
  const result = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'det-chat-' + Date.now(),
    groupId: 'private', userId: '1000000001', nickname: 'Owner',
    text: 'pippi你好啊',
    atTargets: ['900000029'], images: [], raw: { self_id: '900000029' }
  }, async () => {});

  const intent = detectRequiredOsuTool('pippi你好啊');
  if (intent !== null) {
    fail('casual-chat', `casual chat triggered intent: ${JSON.stringify(intent)}`);
  } else if (llmCalls > 0 && llmReceivedTools) {
    // Normal LLM path with tools is acceptable for casual chat
    pass('casual-chat');
  } else if (result.replied) {
    pass('casual-chat');
  } else {
    fail('casual-chat', 'casual chat did not produce a reply');
  }
}

// ═══════════════════════════════════════════════════════
// Test: osu data intent with NO bots enabled → explicit error
// ═══════════════════════════════════════════════════════

console.log('\n=== osu! data intent with no bots → system error ===');

{
  // Set up fixture with NO bots in registry
  updateDb(db => {
    db.settings.ownerQq = '1000000001';
    db.settings.selfQq = '900000029';
    db.settings.llmProvider = 'deepseek';
    db.settings.apiKey = 'fixture-key';
    db.settings.deepseekApiKey = 'fixture-key';
    db.settings.apiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.deepseekApiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
    db.settings.enableAutoModel = false;
    db.settings.thinkingNoticeMode = 'off';
    db.settings.memoryEnabled = false;
    // All default bots disabled — tools completely unavailable
    db.settings.botRegistry = {
      updatedAt: new Date().toISOString(),
      bots: [
        { id: 'yumu', enabled: false },
        { id: 'kanon', enabled: false },
        { id: 'hydrant', enabled: false },
        { id: 'lazybot', enabled: false },
      ]
    };
  });

  llmCalls = 0;
  llmReceivedTools = null;

  const result = await processIncoming({
    source: 'gui', type: 'private',
    messageId: 'det-nobots-' + Date.now(),
    groupId: 'private', userId: '1000000001', nickname: 'Owner',
    text: '查一下我的bp1',
    atTargets: [], images: [], raw: {}
  }, async () => {});

  const intent = detectRequiredOsuTool('查一下我的bp1');
  assert(intent !== null, 'intent must be detected for "查一下我的bp1"');

  // Must NOT call LLM
  if (llmCalls > 0) {
    fail('nobots-no-llm', `LLM was called ${llmCalls} times despite no bots available`);
  } else {
    pass('nobots-no-llm');
  }

  // Must return explicit system error
  if (!result.replied) {
    fail('nobots-reply', 'no reply produced');
  } else if (!(result.reason || '').includes('osu_intent_no_bots')) {
    fail('nobots-reason', `expected osu_intent_no_bots, got: ${result.reason}`);
  } else {
    pass('nobots-system-error');
  }
}

// ═══════════════════════════════════════════════════════

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
llmServer.close();

// Verify production DB untouched
const prodOk = verifyProductionDbUnchanged(prodBefore);
if (!prodOk) {
  console.error('FATAL: production database was modified during test!');
  failed++;
}

cleanupTestDir(testDataDir);

if (failed > 0) {
  console.error('PROCESSINCOMING-DETERMINISTIC-ROUTE-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('PROCESSINCOMING-DETERMINISTIC-ROUTE-VERIFY PASSED');
process.exit(0);
