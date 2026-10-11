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
  const gateContent = 'SCORE=35\nREASON=旧门控不应再被调用';
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
  const { ensureStore, readDb, writeDb } = await import('../server/store.ts');
  const { decideReply } = await import('../server/bot.ts');
  ensureStore();
  const db = readDb();
  db.settings = {
    ...db.settings,
    llmProvider: 'openai-compatible', apiBaseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'gate-test-key', model: 'gate-test-model',
    replyGateNaturalThreshold: 45,
    replyGateLightThreshold: 70,
  };
  db.groups = [{ groupId: '990001', name: 'Gate Test', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 0 }];
  db.messages = [];
  db.usageEvents = [];
  writeDb(db);

  const naturalStrong = {
    group: db.groups[0], userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
    text: '这个话题为什么会变成这样？', mentioned: false, userId: '10001', images: []
  };
  const decision = await decideReply({ db: readDb(), ...naturalStrong });
  if (!decision.shouldReply || !decision.reason.includes('自然群友门控')) {
    throw new Error(`自然参与强消息没有通过本地门控：${decision.reason}`);
  }
  const naturalWeak = await decideReply({
    db: readDb(),
    ...naturalStrong,
    text: '嗯',
  });
  if (naturalWeak.shouldReply || !naturalWeak.reason.includes('未达到接话阈值')) {
    throw new Error(`自然参与弱消息没有被门控拒绝：${naturalWeak.reason}`);
  }
  const light = { ...db.groups[0], mode: 'light' };
  const lightStrong = await decideReply({
    db: readDb(),
    ...naturalStrong,
    group: light,
    text: '我觉得这个方案还需要重新考虑一下，为什么要这样设计？',
  });
  if (!lightStrong.shouldReply || !lightStrong.reason.includes('轻度参与门控')) {
    throw new Error(`轻度参与强消息没有通过本地门控：${lightStrong.reason}`);
  }
  const lightWeak = await decideReply({
    db: readDb(),
    ...naturalStrong,
    group: light,
    text: '今天这个话题还挺有意思',
  });
  if (lightWeak.shouldReply || !lightWeak.reason.includes('未达到接话阈值')) {
    throw new Error(`轻度参与弱消息没有被更严格门控：${lightWeak.reason}`);
  }
  if (requestCount !== 0 || requestBodies.length !== 0) {
    throw new Error(`本地参与门控不应触发额外 LLM 调用：${requestCount}`);
  }
  const after = readDb();
  if (after.usageEvents.some((event) => event.kind === 'reply-gate')) {
    throw new Error('不应再写入 reply-gate 用量事件');
  }
  const throttled = readDb();
  throttled.groups = [{ ...throttled.groups[0], mode: 'natural', cooldownSec: 30 }];
  throttled.decisions = [{
    id: 'prior-reply-attempt', groupId: '990001', shouldReply: true,
    createdAt: new Date().toISOString(),
  }];
  writeDb(throttled);
  const failedDeliveryCooldown = await decideReply({
    db: readDb(), ...naturalStrong, group: throttled.groups[0],
  });
  if (failedDeliveryCooldown.shouldReply || !failedDeliveryCooldown.reason.includes('冷却')) {
    throw new Error(`失败交付后的回复尝试没有占用冷却：${failedDeliveryCooldown.reason}`);
  }
  console.log('PASS reply participation: natural/light modes use one local threshold gate');
  console.log('PASS reply participation: failed delivery attempts still consume cooldown');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
