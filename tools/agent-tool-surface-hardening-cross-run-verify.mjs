// agent-tool-surface-hardening-cross-run-verify.mjs
//
// V01_1 edge gate: AGENT_MAX_TOOL_CALLS_PER_TURN is a USER-TURN budget shared
// by every runToolLoop invocation of one processIncoming turn, not a per-loop
// budget. The production risk is bot.ts's recommendation hard guard, which can
// run a second runToolLoop(requiredTool=recommend) after the first loop.
//
// Two blackboxes:
//   1. Executor seam: first loop executes the full 8 calls, then a second
//      requiredTool loop with toolCallsExecutedBeforeLoop=8 must execute 0.
//   2. processIncoming end-to-end: mock LLM drives 4+4 failed tool calls, then
//      returns a fake recommendation reply; the recommendation hard guard
//      fires, and the forced recommend call must NOT cross executeToolCall.
//      Observed via real db.toolCallLogs (writeToolCallAudit).
import http from 'node:http';
import {
  assertNotProduction,
  cleanupTestDir,
  createTestDataDir,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
} from './test-isolation.mjs';

const prodBefore = productionDbSnapshot();
const testDataDir = createTestDataDir('wuxin-agent-cross-run');
process.env.DATA_DIR = testDataDir;
process.env.PIPPI_AGENT_RUNTIME_MODE = 'legacy';
assertNotProduction(testDataDir);

const {
  runToolLoop,
  AGENT_MAX_TOOL_CALLS_PER_RESPONSE,
  AGENT_MAX_TOOL_CALLS_PER_TURN,
} = await import('../server/bots/executor.ts');
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const {
  detectRequiredOsuTool,
  hasFallbackRecommendIntent,
  looksLikeRecommendationReply,
} = await import('../server/bots/intent.ts');

let passed = 0;
let failed = 0;
function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}
function fail(label, message) {
  console.error(`FAIL [${label}]: ${message}`);
  failed++;
}
function check(condition, label, message) {
  if (condition) pass(label);
  else fail(label, message);
}

const QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'query_osu',
    description: 'osu queries',
    parameters: { type: 'object', properties: { capability: { type: 'string' } }, required: ['capability'] },
  },
};

function toolCall(index) {
  return {
    id: `x${index}`,
    type: 'function',
    function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'recent' }) },
  };
}

function response(text, calls) {
  return {
    text,
    usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
    raw: {
      choices: [{
        message: { content: text, tool_calls: calls || null },
        finish_reason: calls?.length ? 'tool_calls' : 'stop',
      }],
    },
  };
}

// ── Blackbox 1: executor seam, two loops, one shared budget ──────────────

console.log('\n=== Cross-run executor budget ===');
{
  const execLog = [];
  const firstChatCalls = [];
  const firstChat = async (_db, opts) => {
    firstChatCalls.push(opts);
    if (firstChatCalls.length === 1) return response('', [toolCall(1), toolCall(2), toolCall(3), toolCall(4)]);
    if (firstChatCalls.length === 2) return response('', [toolCall(5), toolCall(6), toolCall(7), toolCall(8)]);
    return response('给你推了三张图：BID 123456');
  };
  const first = await runToolLoop(firstChat, {
    db: { settings: {} },
    messages: [{ role: 'user', content: '你觉得我适合打什么图' }],
    tools: [QUERY_TOOL],
    userId: 'u1',
    groupId: 'g1',
    maxIterations: 4,
    toolCallsExecutedBeforeLoop: 0,
    executeToolCallFn: async (tc) => {
      execLog.push(tc);
      return { toolCallId: tc.id, ok: false, content: '拒绝', error: 'guard' };
    },
  });
  check(first.toolCallsMade === 8, 'cross-run-first-loop-8', JSON.stringify(first));
  check(first.toolCallsMadeThisTurn === 8, 'cross-run-first-loop-turn-total', JSON.stringify(first));
  check(first.hardCapReached === false, 'cross-run-first-loop-no-overflow', JSON.stringify(first));

  const secondExecLog = [];
  let secondChatCalls = 0;
  const second = await runToolLoop(async () => {
    secondChatCalls++;
    return response('lead');
  }, {
    db: { settings: {} },
    messages: [{ role: 'user', content: '你觉得我适合打什么图' }],
    tools: [QUERY_TOOL],
    userId: 'u1',
    groupId: 'g1',
    maxIterations: 4,
    toolCallsExecutedBeforeLoop: first.toolCallsMadeThisTurn,
    requiredTool: { toolName: 'query_osu', args: { capability: 'recommend' } },
    executeToolCallFn: async (tc) => {
      secondExecLog.push(tc);
      return { toolCallId: tc.id, ok: true, content: '不应该执行' };
    },
  });
  check(second.toolCallsMade === 0, 'cross-run-second-loop-executes-zero', JSON.stringify(second));
  check(secondExecLog.length === 0, 'cross-run-second-loop-no-executor', String(secondExecLog.length));
  check(second.toolCallsMadeThisTurn === 8, 'cross-run-second-loop-turn-total', JSON.stringify(second));
  check(second.toolCallsSkippedByCap === 1 && second.hardCapReached === true, 'cross-run-second-loop-refused-by-cap', JSON.stringify(second));
  check(secondChatCalls === 0, 'cross-run-second-loop-no-llm', String(secondChatCalls));
  check(/工具调用已达上限/.test(second.text), 'cross-run-second-loop-safe-text', second.text);
  check(execLog.length + secondExecLog.length === AGENT_MAX_TOOL_CALLS_PER_TURN, 'cross-run-total-at-most-cap', `${execLog.length}+${secondExecLog.length}`);
}

// ── Mock LLM: 4+4 tool batches, then a suspicious recommendation reply ──

console.log('\n=== processIncoming blackbox: first loop 8 calls → recommendation fallback ===');

const USER_TEXT = '你觉得我适合打什么图';
const FAKE_REPLY = '给你推了三张图：BID 123456';
check(detectRequiredOsuTool(USER_TEXT) === null, 'blackbox-fallback-not-deterministic-intent', JSON.stringify(detectRequiredOsuTool(USER_TEXT)));
check(hasFallbackRecommendIntent(USER_TEXT) === true, 'blackbox-fallback-intent-detected', USER_TEXT);
check(looksLikeRecommendationReply(FAKE_REPLY) === true, 'blackbox-reply-detected-as-recommendation', FAKE_REPLY);

let llmRequestCount = 0;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const request = JSON.parse(raw);
    llmRequestCount++;
    const messages = request.messages || [];
    const toolCount = messages.filter((message) => message.role === 'tool').length;
    const toolsPresent = Array.isArray(request.tools) && request.tools.length > 0;
    let message;
    if (toolsPresent && toolCount < AGENT_MAX_TOOL_CALLS_PER_TURN) {
      message = {
        role: 'assistant',
        content: '',
        tool_calls: [0, 1, 2, 3].map((index) => ({
          id: `bb_${toolCount}_${index}`,
          type: 'function',
          function: { name: 'query_osu', arguments: JSON.stringify({ capability: 'recent', bp_rank: 5 }) },
        })),
      };
    } else if (toolsPresent) {
      message = { role: 'assistant', content: FAKE_REPLY };
    } else {
      message = { role: 'assistant', content: '查好了。' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `c${llmRequestCount}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    }));
  });
});
await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
const llmPort = llmServer.address().port;

ensureStore();
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
  db.settings.botRegistry = {
    updatedAt: new Date().toISOString(),
    bots: [{
      id: 'yumu', name: '雨沐', description: 'osu! data',
      qq: '', channel: 'internal', enabled: true, commands: [],
    }],
  };
  db.groupBotConfig = { 'REDACTED_GROUP_001': { yumu: true } };
  db.toolCallLogs = [];
  db.unmetCapabilities = [];
});

const sends = [];
const processResult = await processIncoming({
  source: 'gui',
  type: 'private',
  messageId: 'cross-run-' + Date.now(),
  groupId: 'private',
  userId: 'REDACTED_QQ_001',
  nickname: 'Tester',
  text: USER_TEXT,
  atTargets: [],
  images: [],
  raw: {},
}, async (event, text) => {
  sends.push({ userId: event.userId, text: String(text || '').slice(0, 240) });
});

const logs = readDb().toolCallLogs || [];
const recentLogs = logs.filter((entry) => entry.capability === 'recent');
const recommendLogs = logs.filter((entry) => entry.capability === 'recommend');
check(processResult.replied === true, 'blackbox-process-replied', JSON.stringify(processResult));
check(recentLogs.length === AGENT_MAX_TOOL_CALLS_PER_TURN, 'blackbox-first-loop-audit-8', JSON.stringify(logs));
check(recommendLogs.length === 0, 'blackbox-fallback-recommend-not-executed', JSON.stringify(recommendLogs));
check(logs.length === AGENT_MAX_TOOL_CALLS_PER_TURN, 'blackbox-total-audit-8', `total=${logs.length}`);
check(sends.some((send) => /工具调用已达上限/.test(send.text)), 'blackbox-safe-budget-refusal-delivered', JSON.stringify(sends));
check(llmRequestCount === 3, 'blackbox-llm-rounds', `llmRequests=${llmRequestCount} (first loop 3 planner rounds, fallback must not call LLM)`);

llmServer.close();

cleanupTestDir(testDataDir);
console.log(`\nPassed: ${passed}, Failed: ${failed}`);
const prodOk = verifyProductionDbUnchanged(prodBefore);
if (!prodOk) {
  console.error('CROSS-RUN TOOL BUDGET VERIFY: production db changed');
  failed++;
}
if (failed > 0) {
  console.error('AGENT-TOOL-SURFACE-HARDENING-CROSS-RUN-VERIFY FAILED');
  process.exit(1);
}
console.log('AGENT-TOOL-SURFACE-HARDENING-CROSS-RUN-VERIFY PASSED');
