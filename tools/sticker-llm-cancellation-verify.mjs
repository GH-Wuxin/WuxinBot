import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-sticker-llm-cancel');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { completeChat } = await import('../server/bot/llm.ts?sticker-cancel-verify');

const requests = [];
const server = http.createServer((req, res) => {
  const request = { startedAt: Date.now(), closedAt: 0 };
  requests.push(request);
  req.resume();
  req.on('close', () => { request.closedAt = Date.now(); });
  res.on('error', () => {});
});

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  ensureStore();
  updateDb((db) => {
    db.settings.llmProvider = 'openai-compatible';
    db.settings.model = 'fixture-model';
    db.settings.apiKey = 'fixture-key';
    db.settings.apiBaseUrl = `http://127.0.0.1:${port}/v1`;
    db.settings.memoryEnabled = false;
  });

  let settledAt = 0;
  await assert.rejects(
    () => completeChat(readDb(), {
      messages: [{ role: 'user', content: 'cancel this sticker decision' }],
      timeoutMs: 120,
      requestMaxRetries: 2,
      label: '表情取消测试',
    }),
  );
  settledAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((request) => request.startedAt <= settledAt), 'retry started after completeChat settled');
  assert.ok(requests.every((request) => request.closedAt > 0), 'an in-flight request survived cancellation');

  console.log(JSON.stringify({
    ok: true,
    requests: requests.length,
    settledBeforeNoFurtherRetry: true,
    allRequestsClosed: true,
  }, null, 2));
} finally {
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
  cleanupTestDir(dataDir);
}
