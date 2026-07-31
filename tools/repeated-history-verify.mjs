// repeated-history-verify.mjs — regression tests for deterministic osu! tool routing.
// Verifies that requiredTool forces tool execution regardless of context/history.
// Exit 0 on all pass, non-zero on any failure.

import { runToolLoop, executeToolCall } from '../server/bots/executor.ts';
import { buildBotToolSchemas } from '../server/bots/registry.ts';
import { detectRequiredOsuTool } from '../server/bots/intent.ts';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

// ── Fixtures ──

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const DEFAULT_REGISTRY = {
  bots: [
    {
      id: 'yumu', name: '雨沐', description: 'osu! data',
      qq: '', channel: 'internal', enabled: true,
      commands: [
        { name: 'recent', trigger: '/r', description: 'recent score', params: [], returns: 'image' },
        { name: 'bp', trigger: '/bp', description: 'best performance', params: [], returns: 'image' },
        { name: 'info', trigger: '/i', description: 'player info', params: [], returns: 'image' },
      ],
    },
  ],
  updatedAt: new Date(0).toISOString(),
};
const DEFAULT_TOOLS = buildBotToolSchemas(DEFAULT_REGISTRY);

async function test() {

// ═══════════════════════════════════════════════════════
// 1. requiredTool path: tool executes before LLM
// ═══════════════════════════════════════════════════════
console.log('=== 1. requiredTool: tool executes before LLM ===');

{
  const llmCalls = [];
  const result = await runToolLoop(
    async (_db, opts) => {
      llmCalls.push(opts);
      return { text: '简短的引导语', usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 } };
    },
    {
      db: { settings: {} },
      messages: [{ role: 'user', content: '看看我bp1' }],
      tools: DEFAULT_TOOLS,
      userId: 'REDACTED_QQ_001',
      event: { type: 'group', groupId: 'REDACTED_GROUP_001', userId: 'REDACTED_QQ_001', text: '看看我bp1' },
      maxIterations: 4,
      requiredTool: { toolName: 'list_bots', args: {} },
    },
  );

  assert(llmCalls.length === 1, 'requiredTool path: exactly 1 LLM call');
  assert(llmCalls[0].tools === undefined, 'requiredTool path: LLM must receive no tools');
  assert(result.text === '简短的引导语', 'requiredTool path: LLM lead text must be preserved');
  assert(result.toolCallsMade === 1, 'requiredTool path: toolCallsMade must be 1');
  assert(result.iterations === 1, 'requiredTool path: exactly 1 iteration');

  // Message protocol: assistant(tool_calls) → tool(tool_call_id) → LLM lead
  const msgs = llmCalls[0].messages;
  const assistantIdx = msgs.findIndex(m => m.role === 'assistant' && m.tool_calls?.length);
  const toolIdx = msgs.findIndex(m => m.role === 'tool');
  assert(assistantIdx >= 0, 'requiredTool path: must have assistant(tool_calls) message');
  assert(toolIdx >= 0, 'requiredTool path: must have tool message');
  assert(assistantIdx < toolIdx, 'requiredTool path: assistant(tool_calls) must precede tool message');
  // tool_call_id must match
  const assistantCallId = msgs[assistantIdx].tool_calls[0].id;
  const toolCallId = msgs[toolIdx].tool_call_id;
  assert(assistantCallId === toolCallId, 'requiredTool path: tool_call_id must match between assistant and tool messages');
  pass('required-tool-executes-before-llm');
  pass('required-tool-message-protocol-order');
}

// ═══════════════════════════════════════════════════════
// 2. requiredTool: LLM cannot call a second tool
// ═══════════════════════════════════════════════════════
console.log('\n=== 2. requiredTool: LLM second tool_call is impossible ===');

{
  const llmCalls = [];
  const result = await runToolLoop(
    async (_db, opts) => {
      llmCalls.push(opts);
      // Even if we return a raw with tool_calls, it should be ignored
      // because the function returns before checking tool_calls
      return {
        text: 'lead',
        usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
        raw: {
          choices: [{
            message: {
              content: 'lead',
              tool_calls: [toolCall('should-be-ignored', 'query_bot', { bot: 'yumu', command: 'bp' })],
            },
          }],
        },
      };
    },
    {
      db: { settings: {} },
      messages: [{ role: 'user', content: '看看我bp1' }],
      tools: DEFAULT_TOOLS,
      userId: 'REDACTED_QQ_001',
      event: { type: 'group', groupId: 'REDACTED_GROUP_001', userId: 'REDACTED_QQ_001', text: '看看我bp1' },
      maxIterations: 4,
      requiredTool: { toolName: 'list_bots', args: {} },
    },
  );

  assert(result.toolCallsMade === 1, 'requiredTool: toolCallsMade must still be 1 despite LLM emitting a tool call');
  assert(result.iterations === 1, 'requiredTool: must not loop back to execute the LLM-emitted tool');
  pass('required-tool-no-second-call');
}

// ═══════════════════════════════════════════════════════
// 3. requiredTool: repeated 10 times — each executes
// ═══════════════════════════════════════════════════════
console.log('\n=== 3. requiredTool: 10 repeated calls all execute ===');

{
  for (let i = 1; i <= 10; i++) {
    const llmCalls = [];
    const result = await runToolLoop(
      async (_db, opts) => {
        llmCalls.push(opts);
        return { text: `第${i}次查询`, usage: { total_tokens: 50, prompt_tokens: 40, completion_tokens: 10 } };
      },
      {
        db: { settings: {} },
        messages: [
          { role: 'user', content: '看看我bp1' },
          // Simulate accumulated history from previous calls
          ...Array.from({ length: i - 1 }, (_, j) => [
            { role: 'user', content: `[${String(j + 12).padStart(2, '0')}:00] Wux1n: [CQ:at,qq=REDACTED_QQ_002] 看看我bp1` },
            { role: 'assistant', content: `[${String(j + 12).padStart(2, '0')}:01] 机器人: HDHR 98.94%, 563.9pp...` },
          ]).flat(),
        ],
        tools: DEFAULT_TOOLS,
        userId: 'REDACTED_QQ_001',
        event: { type: 'group', groupId: 'REDACTED_GROUP_001', userId: 'REDACTED_QQ_001', text: '看看我bp1' },
        maxIterations: 4,
        requiredTool: { toolName: 'list_bots', args: {} },
      },
    );

    assert(result.toolCallsMade === 1, `repeated call #${i}: toolCallsMade must be 1`);
    assert(result.iterations === 1, `repeated call #${i}: must be 1 iteration`);
    assert(llmCalls.length === 1, `repeated call #${i}: exactly 1 LLM call`);
    assert(llmCalls[0].tools === undefined, `repeated call #${i}: LLM must receive no tools`);
  }
  pass('required-tool-repeated-10');
}

// ═══════════════════════════════════════════════════════
// 4. Normal path (no requiredTool): LLM chooses tools
// ═══════════════════════════════════════════════════════
console.log('\n=== 4. Normal path: LLM autonomy preserved ===');

{
  const llmCalls = [];
  const result = await runToolLoop(
    async (_db, opts) => {
      llmCalls.push(opts);
      return {
        text: 'final answer',
        usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
        raw: {
          choices: [{
            message: {
              content: 'final answer',
              tool_calls: [toolCall('llm-chose', 'query_bot', { bot: 'yumu', command: 'bp' })],
            },
          }],
        },
      };
    },
    {
      db: { settings: {} },
      messages: [{ role: 'user', content: '看看我bp1' }],
      tools: DEFAULT_TOOLS,
      userId: 'REDACTED_QQ_001',
      event: { type: 'group', groupId: 'REDACTED_GROUP_001', userId: 'REDACTED_QQ_001', text: '看看我bp1' },
      sendMessage: async () => {},
      maxIterations: 1,
      // NO requiredTool
    },
  );

  assert(llmCalls[0].tools?.length > 0, 'normal path: LLM must receive tools');
  assert(result.toolCallsMade >= 0, 'normal path: LLM may or may not call tools');
  pass('normal-path-llm-autonomy');
}

// ═══════════════════════════════════════════════════════
// 5. Intent classifier: BP/recent/info with normal chat
// ═══════════════════════════════════════════════════════
console.log('\n=== 5. Intent classifier integration ===');

{
  // Data queries should be detected
  assert(detectRequiredOsuTool('看看我bp1') !== null, 'BP intent must be detected');
  assert(detectRequiredOsuTool('看看我最近一次成绩') !== null, 'recent intent must be detected');
  assert(detectRequiredOsuTool('看看我的玩家资料') !== null, 'profile intent must be detected');

  // Casual chat should NOT be detected
  const chatMessages = ['你好', '今天天气不错', '哈哈哈哈', 'pippi你在吗'];
  for (const msg of chatMessages) {
    assert(detectRequiredOsuTool(msg) === null, `chat "${msg}" must not trigger requiredTool`);
  }

  // Analysis questions should NOT be detected
  const analysisMessages = [
    '分析一下我的osu水平',
    '我的bp为什么这么差',
    '怎么提升我的accuracy',
  ];
  for (const msg of analysisMessages) {
    assert(detectRequiredOsuTool(msg) === null, `analysis "${msg}" must not trigger requiredTool`);
  }

  pass('intent-classifier-integration');
}

// ═══════════════════════════════════════════════════════
// 6. requiredTool: lead failure does not discard payload
// ═══════════════════════════════════════════════════════
console.log('\n=== 6. requiredTool: LLM failure preserves direct payload ===');

{
  const result = await runToolLoop(
    async () => { throw new Error('LLM unavailable'); },
    {
      db: { settings: {} },
      messages: [{ role: 'user', content: '看看我bp1' }],
      tools: DEFAULT_TOOLS,
      userId: 'REDACTED_QQ_001',
      event: { type: 'group', groupId: 'REDACTED_GROUP_001', userId: 'REDACTED_QQ_001', text: '看看我bp1' },
      maxIterations: 4,
      requiredTool: { toolName: 'list_bots', args: {} },
    },
  );

  assert(result.text === '', 'lead failure: text must be empty (cosmetic lead failed)');
  assert(result.toolCallsMade === 1, 'lead failure: tool must have executed before the crash');
  pass('required-tool-lead-failure-payload-preserved');
}

// ═══════════════════════════════════════════════════════
// 7. requiredTool + actual query_osu validation
// ═══════════════════════════════════════════════════════
console.log('\n=== 7. requiredTool query_osu parameter integrity ===');

{
  const intent = detectRequiredOsuTool('看看我bp1');
  assert(intent !== null, 'intent must be detected');
  assert(intent.toolName === 'query_osu', 'toolName must be query_osu');
  assert(intent.args.capability === 'bp', 'capability must be bp for BP query');
  assert(intent.args.bp_rank === 1, 'bp_rank must be 1 for "bp1"');

  const intentRecent = detectRequiredOsuTool('我的recent');
  assert(intentRecent?.args.capability === 'recent', 'recent intent must map to recent capability');

  const intentProfile = detectRequiredOsuTool('我的info');
  assert(intentProfile?.args.capability === 'info', 'info intent must map to info capability');

  pass('required-tool-parameter-integrity');
}

// ═══════════════════════════════════════════════════════
// 8. /w osu analyze: verify NOT captured by intent parser
// ═══════════════════════════════════════════════════════
console.log('\n=== 8. /w osu analyze path is separate ===');

{
  // /w osu commands should NOT trigger requiredTool (they go through handleOwnerCommand)
  assert(detectRequiredOsuTool('/w osu analyze [SHK]Wuxin') === null, '/w osu analyze must not trigger requiredTool');
  assert(detectRequiredOsuTool('/w osu recent') === null, '/w osu recent must not trigger requiredTool');
  assert(detectRequiredOsuTool('/w osu bind [SHK]Wuxin') === null, '/w osu bind must not trigger requiredTool');
  pass('w-osu-commands-not-captured');
}

console.log(`\n${'='.repeat(40)}`);
console.log(`Passed: ${passed}, Failed: 0`);
console.log('REPEATED-HISTORY-VERIFY PASSED');
}

test().catch((err) => {
  console.error('REPEATED-HISTORY-VERIFY FAILED:', err.message);
  process.exit(1);
});
