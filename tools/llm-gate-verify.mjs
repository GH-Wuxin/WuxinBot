import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-llm-gate-'));
process.env.DATA_DIR = dataDir;
let requestCount = 0;
const requestBodies = [];
const server = http.createServer(async (req, res) => {
  requestCount += 1;
  let body = '';
  for await (const chunk of req) body += chunk;
  requestBodies.push(JSON.parse(body));
  const gateContent = requestCount === 1
    ? 'SCORE=35\nREASON=接话价值较低'
    : 'SCORE=78\nREASON=有明确话题可接';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'gate-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'gate-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: gateContent }, finish_reason: 'stop' }],
    usage: { total_tokens: 124, prompt_tokens: 123, completion_tokens: 1 }
  }));
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { ensureStore, readDb, writeDb, updateDb } = await import('../server/store.ts');
  const { decideReply } = await import('../server/bot.ts');
  ensureStore();
  const db = readDb();
  db.settings = {
    ...db.settings,
    llmProvider: 'openai-compatible', apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'gate-test-key', model: 'gate-test-model', llmReplyGateMaxPerHour: 0
  };
  db.groups = [{ groupId: '990001', name: 'Gate Test', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 0 }];
  db.messages = [];
  db.usageEvents = [];
  writeDb(db);

  const input = {
    group: db.groups[0], userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
    text: '今天这个话题还挺有意思', mentioned: false, userId: '10001', images: []
  };
  const decision = await decideReply({ db: readDb(), ...input });
  if (decision.shouldReply || !decision.reason.includes('35/45')) throw new Error(`低分门控决策异常：${decision.reason}`);
  let after = readDb();
  const gateEvent = after.usageEvents.find((event) => event.kind === 'reply-gate');
  if (after.usage.totalTokens !== 124 || after.usage.requests !== 1 || gateEvent?.promptTokens !== 123 || gateEvent?.gateScore !== 35) {
    throw new Error('门控 Token 未正确计入总用量或明细');
  }

  const positive = await decideReply({ db: readDb(), ...input, text: '[CQ:at,qq=20002] 这个话题你们怎么看' });
  if (!positive.shouldReply || !positive.reason.includes('78/45')) throw new Error(`高分门控决策异常：${positive.reason}`);
  const sentPrompt = requestBodies[1]?.messages?.[0]?.content || '';
  if (sentPrompt.includes('[CQ:at')) throw new Error('门控提示词仍包含原始 CQ at 码');

  after = readDb();
  if (after.usage.totalTokens !== 248 || after.usage.requests !== 2) throw new Error('第二次门控调用未计入用量');
  updateDb((draft) => { draft.settings.llmReplyGateMaxPerHour = 2; });
  const limited = await decideReply({ db: readDb(), ...input });
  if (!limited.reason.includes('达到每小时 2 次上限') || requestCount !== 2) {
    throw new Error('门控频率上限未阻止第二次 API 调用');
  }
  console.log('PASS LLM gate: scoring, CQ cleaning, usage accounting and hourly limit');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
