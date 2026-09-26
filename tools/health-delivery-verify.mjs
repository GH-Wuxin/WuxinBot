import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const dir = createTestDataDir('wuxin-health-delivery');
const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { getReplyQueueStats } = await import('../server/bot/queue.ts');
const { listRequestTraces } = await import('../server/requestTrace.ts');
let mode = 'success';
let releaseModel;
let modelStarted;
let calls = 0;
const timers = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls++;
    const finish = () => {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'failure') { res.writeHead(400); res.end('{"error":{"message":"injected model failure"}}'); return; }
      res.end(JSON.stringify({ id: 'fixture', model: 'fixture-model', choices: [{ message: { role: 'assistant', content: '嗯，今天聊得挺开心的。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }));
    };
    if (mode === 'hold') { releaseModel = finish; modelStarted?.(); }
    else timers.push(setTimeout(finish, 35));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const event = id => ({ source: 'gui', type: 'private', messageId: id, groupId: 'private', userId: '10001', nickname: 'Owner', text: '聊聊今天吧', atTargets: [], images: [], raw: {} });
try {
  ensureStore();
  updateDb(db => {
    Object.assign(db.settings, { ownerQq: '10001', selfQq: '10002', llmProvider: 'openai-compatible', model: 'fixture-model', apiKey: 'test-only',
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, enableAutoModel: false, memoryEnabled: false, enableWebSearch: false,
      thinkingNoticeMode: 'slow', thinkingNoticeDelayMs: 1, botRegistry: { bots: [{ id: 'disabled-fixture', enabled: false }], updatedAt: new Date().toISOString() } });
  });
  const delivered = [];
  let failedNotices = 0;
  const first = await processIncoming(event('notice-failure'), async (_event, text) => {
    if (text.includes('正在')) { failedNotices++; throw new Error('notice rejected'); }
    delivered.push(text);
  });
  assert.equal(first.replied, true); assert.equal(failedNotices, 1); assert.equal(delivered.length, 1);
  console.log('PASS processIncoming: failed slow notification does not kill/abort main reply');

  updateDb(db => { db.settings.thinkingNoticeMode = 'off'; });
  const before = readDb().usage.totalTokens;
  let sends = 0;
  const failure = await processIncoming(event('delivery-failure'), async () => { sends++; throw new Error('QQ accepted-or-lost'); });
  assert.equal(failure.replied, false); assert.equal(sends, 1);
  assert.equal(readDb().usage.totalTokens, before + 25);
  assert.ok(listRequestTraces().find(trace => trace.messageId === 'delivery-failure').events.some(e => e.name === 'qq_delivery_failed_or_unknown'));
  console.log('PASS processIncoming: QQ failure keeps model usage and does not blindly resend');

  mode = 'failure';
  const notices = [];
  const errorReply = await processIncoming(event('model-failure'), async (_event, text) => { notices.push(text); });
  assert.equal(errorReply.replied, false);
  assert.equal(notices.length, 1); assert.match(notices[0], /未能完成/);
  console.log('PASS processIncoming: model error gets exactly one bounded failure notice');

  mode = 'hold';
  const entered = new Promise(resolve => { modelStarted = resolve; });
  const active = processIncoming(event('queue-A'), async () => {});
  await entered;
  const queued = await processIncoming(event('queue-B'), async () => { throw new Error('paused replay must not send'); });
  assert.equal(queued.queued, true);
  const callsBeforeDrain = calls;
  updateDb(db => { db.settings.globalPaused = true; });
  releaseModel(); await active;
  const deadline = Date.now() + 1000;
  while (Object.keys(getReplyQueueStats()).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(getReplyQueueStats(), {});
  assert.equal(calls, callsBeforeDrain);
  console.log('PASS processIncoming: pause while queued blocks replay and releases queue lock');
} finally {
  timers.forEach(clearTimeout); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanupTestDir(dir);
}
