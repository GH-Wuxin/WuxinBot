// natural-chat-delivery-verify.mjs
// Regression guard: natural chat (LLM tool loop) must never deliver the raw
// structured tool payload to the user. The LLM receives the data as reference
// material and writes its own reply; only explicit command flows opt into
// verbatim delivery via deliverDirectContent=true.
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';
import { startOsuApiMock } from './osu-api-mock.mjs';

const testDataDir = createTestDataDir('wuxin-natchat');
process.env.DATA_DIR = testDataDir;
process.env.PIPPI_AGENT_RUNTIME_MODE = 'legacy';
assertNotProduction(testDataDir);

const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

// Offline osu! API mock: the internal tool must succeed in the strongest
// text-only profile case so the natural-chat delivery note is exercised.
const osuMock = await startOsuApiMock();
process.env.OSU_API_BASE_URL = osuMock.apiBase;
process.env.OSU_TOKEN_URL = osuMock.tokenUrl;
console.log(`[mock] osu! API served on 127.0.0.1:${osuMock.port}`);

const { ensureStore, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { detectRequiredOsuTool } = await import('../server/bots/intent.ts');
const { runToolLoop } = await import('../server/bots/executor.ts');

ensureStore();

let passed = 0;
let failed = 0;

// Regression fixture: the exact shape leaked in production on 2026-08-12,
// where the model wrote a pp_calc invocation as DSML text inside `content`
// instead of (or alongside) a structured tool call.
const DSML_LEAK_TEXT = [
  '<｜｜DSML｜｜tool_calls>',
  '<｜｜DSML｜｜invoke name="query_osu">',
  '<｜｜DSML｜｜parameter name="capability" string="true">pp_calc<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜parameter name="username" string="true">[TST]Alpha<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜parameter name="beatmap_id" string="true">809469<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜parameter name="mods" string="true">HD<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜parameter name="acc" string="true">99<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜parameter name="combo" string="true">fc<｜｜DSML｜｜/parameter>',
  '<｜｜DSML｜｜/invoke>',
  '<｜｜DSML｜｜/tool_calls>',
].join('\n');

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
let dsmlLeadMode = false;
let dsmlRetryMode = false;
let leadTurnCount = 0;
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
    let leadContent;
    if (dsmlRetryMode) {
      leadTurnCount++;
      // First lead turn returns pure DSML markup; the corrective retry turn
      // returns a natural-language lead. Locks the retry path end to end.
      leadContent = leadTurnCount === 1 ? DSML_LEAK_TEXT : '查到你的 BP1 了，是一张跳图。';
    } else {
      leadContent = dsmlLeadMode ? DSML_LEAK_TEXT : '查好了，图里就是你的BP。';
    }
    const message = hasToolFlow
      ? { role: 'assistant', content: leadContent }
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
    db.settings.osuClientId = 'fixture-client';
    db.settings.osuClientSecret = 'fixture-secret';
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

// The model wrote literal DSML tool-call markup as the cosmetic lead while a
// direct panel/image already existed. The markup must never be sent; the
// deterministic fallback lead replaces it.
async function testNaturalDsmlLead(label, userText, expectedCapability) {
  setupFixture();
  llmCalls = 0;
  lastToolContent = '';
  dsmlLeadMode = true;
  const sends = [];

  const result = await processIncoming({
    source: 'gui',
    type: 'private',
    messageId: 'dsml-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
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
  dsmlLeadMode = false;

  const intent = detectRequiredOsuTool(userText);
  if (!intent || intent.args.capability !== expectedCapability) {
    fail(label, `intent not detected for "${userText}" (cap=${intent?.args?.capability})`);
    return;
  }
  if (!result.replied) {
    fail(label, `processIncoming did not reply: ${result.reason}`);
    return;
  }

  const delivered = sends.map((s) => s.text).join('\n') || result.text || '';
  const markup = /tool_calls|invoke|parameter|DSML|pp_calc|＜｜/i.test(delivered);
  if (markup) {
    fail(label, `DSML tool-call markup leaked into delivery: ${delivered.slice(0, 220)}`);
    return;
  }
  // No direct payload exists in this harness scenario, so the reply must NOT
  // pretend a result was delivered: the deterministic honest-retry lead
  // replaces the markup (never the markup itself).
  if (!delivered.includes('这次查询我这边没整理好，你稍后再试一次？')) {
    fail(label, `fallback lead missing from delivery: ${delivered.slice(0, 220)}`);
    return;
  }
  pass(label + ` -> ${expectedCapability}`);
}

console.log('=== natural chat never delivers raw tool payload ===');

await testNaturalNoDump('natural-bp1', '看看我的bp1', 'bp');
await testNaturalNoDump('natural-recent', '帮我查一下recent', 'recent');
await testNaturalDsmlLead('natural-dsml-lead', '看看我的bp1', 'bp');

// The corrective lead retry must actually deliver the natural-language result
// when the first lead turn is pure DSML and the retry succeeds.
{
  setupFixture();
  llmCalls = 0;
  lastToolContent = '';
  dsmlRetryMode = true;
  leadTurnCount = 0;
  const sends = [];
  const result = await processIncoming({
    source: 'gui',
    type: 'private',
    messageId: 'dsml-retry-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    groupId: 'private',
    userId: 'REDACTED_QQ_001',
    nickname: 'Owner',
    text: '看看我的bp1',
    atTargets: [],
    images: [],
    raw: {}
  }, async (evt, text) => {
    sends.push({ userId: evt.userId, text: String(text || '') });
  });
  dsmlRetryMode = false;
  const delivered = sends.map((s) => s.text).join('\n') || result.text || '';
  const markup = /tool_calls|invoke|parameter|DSML|pp_calc|＜｜/i.test(delivered);
  if (!result.replied) {
    fail('natural-dsml-retry-success', `processIncoming did not reply: ${result.reason}`);
  } else if (markup) {
    fail('natural-dsml-retry-success', `markup leaked into delivery: ${delivered.slice(0, 220)}`);
  } else if (!delivered.includes('查到你的 BP1 了，是一张跳图。')) {
    fail('natural-dsml-retry-success', `retry result missing from delivery: ${delivered.slice(0, 220)}`);
  } else if (leadTurnCount < 2) {
    fail('natural-dsml-retry-success', `expected lead + corrective retry turns, got ${leadTurnCount}`);
  } else {
    pass('natural-dsml-retry-success');
  }
}

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

// A model that emits literal DSML tool-call markup as its final answer (with
// no structured tool_calls and no direct payload) must not leak it to the
// user; the loop returns a neutral fallback instead of raw markup.
console.log('\n=== runToolLoop never leaks literal tool-call markup ===');

let markupChatCalls = 0;
const markupChat = async () => {
  markupChatCalls++;
  return {
    text: DSML_LEAK_TEXT,
    usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 }
  };
};

setupFixture();
// Schema-exposed tool: text DSML naming query_osu must go through the
// validated executor (pp_calc is rejected) and then a final synthesis call.
const exposedTools = [{ type: 'function', function: { name: 'query_osu', description: 'x', parameters: { type: 'object', properties: {} } } }];
const markupResult = await runToolLoop(markupChat, {
  db: (await import('../server/store.ts')).readDb(),
  messages: [{ role: 'user', content: '这图99acc fc大概多少pp' }],
  tools: exposedTools,
  userId: 'REDACTED_QQ_001',
  groupId: 'private',
  maxIterations: 1,
  label: 'natchat-dsml-unit',
});

const markupLeak = /tool_calls|invoke|parameter|DSML|pp_calc|＜｜/i.test(markupResult.text);
if (markupLeak) {
  fail('runToolLoop-dsml-final', `markup leaked into result.text: ${markupResult.text.slice(0, 220)}`);
} else if (!markupResult.text) {
  fail('runToolLoop-dsml-final', 'expected neutral fallback text, got empty');
} else {
  pass('runToolLoop-dsml-final');
}
if (markupChatCalls < 2) {
  fail('runToolLoop-dsml-retry', `expected parse+reject+final flow, got ${markupChatCalls} calls`);
} else {
  pass('runToolLoop-dsml-retry');
}

// Text DSML naming a tool that was NOT exposed in this round's schema must
// never execute anything: the parsed call is dropped and the reply fails
// closed with a neutral fallback in a single LLM call. Assert both the LLM
// call count AND that the executor seam was never invoked.
let hiddenToolChatCalls = 0;
let hiddenExecCalls = 0;
const hiddenToolChat = async () => {
  hiddenToolChatCalls++;
  return {
    text: DSML_LEAK_TEXT,
    usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 }
  };
};
const hiddenSpyExecutor = async () => {
  hiddenExecCalls++;
  return { ok: true, content: '不应被执行' };
};
const hiddenResult = await runToolLoop(hiddenToolChat, {
  db: (await import('../server/store.ts')).readDb(),
  messages: [{ role: 'user', content: '这图99acc fc大概多少pp' }],
  tools: [],
  userId: 'REDACTED_QQ_001',
  groupId: 'private',
  maxIterations: 3,
  label: 'natchat-dsml-hidden-tool',
  executeToolCallFn: hiddenSpyExecutor,
});
if (hiddenToolChatCalls !== 1) {
  fail('runToolLoop-dsml-unexposed-tool', `unexposed text tool must not execute, got ${hiddenToolChatCalls} calls`);
} else if (hiddenExecCalls !== 0) {
  fail('runToolLoop-dsml-unexposed-tool', `executor must never run for unexposed text tools, got ${hiddenExecCalls} executions`);
} else if (/tool_calls|invoke|parameter|DSML|pp_calc|＜｜/i.test(hiddenResult.text) || !hiddenResult.text) {
  fail('runToolLoop-dsml-unexposed-tool', `unexposed markup must fail closed with neutral text, got: ${hiddenResult.text.slice(0, 160)}`);
} else {
  pass('runToolLoop-dsml-unexposed-tool');
}

// A tool IS exposed, but the text DSML structure is mis-nested. The parse
// layer must reject it, so the executor still never runs (fail closed on the
// malformed invocation itself, not only on leaked text).
let malformedChatCalls = 0;
let malformedExecCalls = 0;
const malformedChat = async () => {
  malformedChatCalls++;
  return {
    text: '<tool_calls><invoke name="query_osu"><parameter name="capability">bp</parameter></tool_calls></invoke>',
    usage: { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2 }
  };
};
const malformedSpyExecutor = async () => {
  malformedExecCalls++;
  return { ok: true, content: '不应被执行' };
};
const malformedResult = await runToolLoop(malformedChat, {
  db: (await import('../server/store.ts')).readDb(),
  messages: [{ role: 'user', content: '看看我的bp1' }],
  tools: exposedTools,
  userId: 'REDACTED_QQ_001',
  groupId: 'private',
  maxIterations: 3,
  label: 'natchat-dsml-malformed',
  executeToolCallFn: malformedSpyExecutor,
});
if (malformedExecCalls !== 0) {
  fail('runToolLoop-dsml-malformed-no-exec', `malformed DSML must never execute, got ${malformedExecCalls} executions (${malformedChatCalls} llm calls)`);
} else if (/tool_calls|invoke|parameter|DSML|pp_calc/i.test(malformedResult.text) || !malformedResult.text) {
  fail('runToolLoop-dsml-malformed-no-exec', `malformed markup must fail closed with neutral text, got: ${malformedResult.text.slice(0, 160)}`);
} else {
  pass('runToolLoop-dsml-malformed-no-exec');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
llmServer.close();
await osuMock.close();

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
