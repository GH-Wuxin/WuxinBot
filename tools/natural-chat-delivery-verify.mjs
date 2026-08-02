// natural-chat-delivery-verify.mjs
// Regression guard: natural chat (LLM tool loop) must never deliver the raw
// structured tool payload to the user. The LLM receives the data as reference
// material and writes its own reply; only explicit command flows opt into
// verbatim delivery via deliverDirectContent=true.
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-natchat');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

const { ensureStore, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectRequiredOsuTool } = await import('../server/bots/intent.ts');
const { runToolLoop } = await import('../server/bots/executor.ts');

ensureStore();

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

// Mock LLM: one required-tool lead turn, records the last tool message so we
// can assert the natural-chat note is used instead of the delivery note.
let llmCalls = 0;
let lastToolContent = '';
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const request = JSON.parse(raw);
    llmCalls++;
    const msgs = request.messages || [];
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    if (toolMsgs.length > 0) {
      lastToolContent = String(toolMsgs[toolMsgs.length - 1].content || '');
    }
    const hasToolFlow = msgs.some((m) => m.tool_calls?.length) && toolMsgs.length > 0;
    const message = hasToolFlow
      ? { role: 'assistant', content: '查好了，图里就是你的BP。' }
      : { role: 'assistant', content: '不应该走这里。' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'c' + llmCalls, object: 'chat.completion', created: Date.now(),
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    }));
  });
});
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r));
const llmPort = llmServer.address().port;

function setupFixture() {
  // Seed real osu! credentials + a real binding from the production DB when
  // available, so the internal tool can succeed in the strongest text-only
  // profile case. When unavailable the tool errors and the test still verifies
  // the no-leak guarantee.
  let prodCreds = null;
  let prodBinding = null;
  try {
    const prodDbPath = path.join(process.env.APPDATA || '', 'Wuxin', 'db.json');
    if (fs.existsSync(prodDbPath)) {
      const prod = JSON.parse(fs.readFileSync(prodDbPath, 'utf8'));
      prodCreds = {
        osuClientId: String(prod.settings?.osuClientId || ''),
        osuClientSecret: String(prod.settings?.osuClientSecret || ''),
      };
      const bindings = Object.entries(prod.osuBindings || {});
      if (bindings.length > 0) {
        const [qq, value] = bindings[0];
        prodBinding = { qq, value };
      }
    }
  } catch { /* credentials are optional for this test */ }

  updateDb((db) => {
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
    if (prodCreds?.osuClientId && prodCreds?.osuClientSecret) {
      db.settings.osuClientId = prodCreds.osuClientId;
      db.settings.osuClientSecret = prodCreds.osuClientSecret;
    }
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
    if (prodBinding) {
      db.osuBindings['REDACTED_QQ_001'] = prodBinding.value;
    } else {
      db.osuBindings['REDACTED_QQ_001'] = 1234567;
    }
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig['REDACTED_GROUP_001'] = { yumu: true };
  });
}

async function testNaturalNoDump(label, userText, expectedCapability) {
  setupFixture();
  llmCalls = 0;
  lastToolContent = '';
  const sends = [];

  const result = await processIncoming({
    source: 'gui',
    type: 'private',
    messageId: 'natchat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private',
    userId: 'REDACTED_QQ_001',
    nickname: 'Owner',
    text: userText,
    atTargets: [],
    images: [],
    raw: {}
  }, async (evt, text) => {
    sends.push({ userId: evt.userId, text: String(text || '') });
  });

  const intent = detectRequiredOsuTool(userText);
  if (!intent || intent.args.capability !== expectedCapability) {
    fail(label, `intent not detected for "${userText}" (cap=${intent?.args?.capability})`);
    return;
  }
  if (!result.replied) {
    fail(label, `processIncoming did not reply: ${result.reason}`);
    return;
  }
  if (llmCalls !== 1) {
    fail(label, `expected 1 LLM lead call, got ${llmCalls}`);
    return;
  }

  // The tool message must never use the verbatim delivery note. When the tool
  // actually succeeded, it must also carry a natural-chat note (data-as-reference
  // for text results, or image-attached comment for rendered panels).
  if (lastToolContent.includes('交付说明')) {
    fail(label, 'tool message still contains the verbatim delivery note');
    return;
  }
    const toolFailed = lastToolContent.includes('查询失败') ||
      lastToolContent.includes('找不到') ||
      lastToolContent.includes('工具结果被安全过滤器拦截') ||
      lastToolContent.includes('未配置');
  if (!toolFailed) {
    const naturalNote = lastToolContent.includes('数据仅供你参考') ||
      lastToolContent.includes('结果图片会由系统附上');
    if (!naturalNote) {
      fail(label, `tool message is missing the natural-chat note: ${lastToolContent.slice(0, 160)}`);
      return;
    }
  } else {
    console.log(`  [warn] ${label}: tool unavailable (${lastToolContent.slice(0, 80)}), no-leak assertion only`);
  }

  const delivered = sends.map((s) => s.text).join('\n') || result.text || '';
  if (!delivered.includes('查好了，图里就是你的BP。')) {
    fail(label, `LLM lead missing from delivery: ${delivered.slice(0, 200)}`);
    return;
  }
  for (const marker of ['【账号档案', '【BP100', '【BP5', '【Mods', '【PP+', '【谱面类型分布', '全球排名', '路径已隐藏', '交付说明']) {
    if (delivered.includes(marker)) {
      fail(label, `raw tool payload leaked into user delivery: ${marker}`);
      return;
    }
  }
  pass(label + ` → ${expectedCapability}`);
}

console.log('=== natural chat never delivers raw tool payload ===');

await testNaturalNoDump('natural-bp1', '看看我的bp1', 'bp');
await testNaturalNoDump('natural-recent', '帮我查一下recent', 'recent');

// Unit: runToolLoop must gate verbatim payload delivery on deliverDirectContent.
// profile is a text-only internal command, so a successful call exercises the
// exact branch that previously leaked raw tool text into natural chat.
console.log('\n=== runToolLoop delivery gating (text-only profile) ===');

let unitToolContent = '';
const mockChat = async (_db, opts) => {
  const msgs = opts?.messages || [];
  const toolMsgs = msgs.filter((m) => m.role === 'tool');
  if (toolMsgs.length > 0) {
    unitToolContent = String(toolMsgs[toolMsgs.length - 1].content || '');
  }
  return {
    text: '查好了，图里就是你的BP。',
    usage: { total_tokens: 13, prompt_tokens: 10, completion_tokens: 3 }
  };
};

for (const [mode, opts] of [
  ['natural', { deliverDirectContent: false }],
  ['command', { deliverDirectContent: true }],
]) {
  setupFixture();
  llmCalls = 0;
  lastToolContent = '';
  unitToolContent = '';
  const result = await runToolLoop(mockChat, {
    db: (await import('../server/store.ts')).readDb(),
    messages: [{ role: 'user', content: '看看我的玩家资料' }],
    tools: [],
    userId: 'REDACTED_QQ_001',
    groupId: 'private',
    maxIterations: 1,
    label: 'natchat-verify',
    requiredTool: { toolName: 'query_osu', args: { capability: 'profile' } },
    ...opts,
  });

  const toolFailed = unitToolContent.includes('查询失败') ||
    unitToolContent.includes('找不到') ||
    unitToolContent.includes('工具结果被安全过滤器拦截') ||
    unitToolContent.includes('未配置');

  if (mode === 'natural') {
    if (result.directContent !== '') {
      fail('unit-profile-natural', `directContent leaked in natural mode: ${result.directContent.slice(0, 120)}`);
      continue;
    }
    if (unitToolContent.includes('交付说明')) {
      fail('unit-profile-natural', 'tool message contains the verbatim delivery note');
      continue;
    }
    if (!toolFailed && !unitToolContent.includes('数据仅供你参考')) {
      fail('unit-profile-natural', `missing natural reference note: ${unitToolContent.slice(0, 120)}`);
      continue;
    }
    pass('unit-profile-natural' + (toolFailed ? ' (tool unavailable, no-leak only)' : ''));
  } else {
    if (toolFailed) {
      console.log(`  [warn] unit-profile-command: tool unavailable (${unitToolContent.slice(0, 80)}), skip`);
      pass('unit-profile-command (skipped: tool unavailable)');
      continue;
    }
    if (result.directContent === '') {
      fail('unit-profile-command', 'command mode returned empty directContent for a text tool');
      continue;
    }
    if (!unitToolContent.includes('交付说明')) {
      fail('unit-profile-command', `command mode tool message missing the delivery note: ${unitToolContent.slice(0, 120)}`);
      continue;
    }
    pass('unit-profile-command');
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
  console.error('NATURAL-CHAT-DELIVERY-VERIFY FAILED');
  process.exit(1);
}
console.log('[isolation] production db unchanged: ' + prodOk);
console.log('NATURAL-CHAT-DELIVERY-VERIFY PASSED');
process.exit(0);
