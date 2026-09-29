import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-onebot-delivery');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const { ensureStore, updateDb } = await import('../server/store.ts');
const { getHealth } = await import('../server/health.ts');
const { sendOneBotMessage } = await import('../server/onebot.ts?delivery-verify');
ensureStore();

let mode = 'ok';
let requestCount = 0;
const server = http.createServer(async (req, res) => {
  requestCount += 1;
  for await (const _chunk of req) { /* consume the request body */ }
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'http-error') {
    res.writeHead(500);
    res.end(JSON.stringify({ status: 'ok', retcode: 0 }));
    return;
  }
  res.writeHead(200);
  if (mode === 'empty') {
    res.end('');
    return;
  }
  if (mode === 'async') {
    res.end(JSON.stringify({ status: 'async', retcode: 1, data: { message_id: -8 } }));
    return;
  }
  if (mode === 'failed') {
    res.end(JSON.stringify({ status: 'failed', retcode: 100, message: 'fixture failure' }));
    return;
  }
  if (mode === 'invalid-retcode') {
    res.end(JSON.stringify({ status: 'ok', retcode: false }));
    return;
  }
  res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: -7 } }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
updateDb((db) => {
  db.settings.oneBotHttpUrl = `http://127.0.0.1:${server.address().port}`;
  db.settings.oneBotAccessToken = '';
});

const event = { type: 'group', groupId: '1', userId: '2' };
try {
  requestCount = 0;
  mode = 'ok';
  const confirmed = await sendOneBotMessage(event, 'confirmed');
  assert.equal(confirmed.outcome, 'confirmed_success');
  assert.equal(confirmed.messageId, -7, 'negative message_id is preserved');
  assert.equal(requestCount, 1, 'confirmed success sends once');

  mode = 'async';
  const accepted = await sendOneBotMessage(event, 'accepted');
  assert.equal(accepted.outcome, 'accepted_unknown');
  assert.equal(accepted.messageId, -8);
  assert.equal(getHealth().sendMessage.failureCount, 0, 'accepted unknown is not a confirmed failure');
  assert.equal(getHealth().sendMessage.acceptedUnknownCount, 1);

  requestCount = 0;
  mode = 'failed';
  await assert.rejects(
    () => sendOneBotMessage(event, 'failed'),
    (error) => error.deliveryOutcome === 'confirmed_failure',
  );
  assert.equal(requestCount, 1, 'confirmed failure is not retried automatically');
  assert.equal(getHealth().sendMessage.failureCount, 1);

  for (const nextMode of ['http-error', 'empty', 'invalid-retcode']) {
    mode = nextMode;
    await assert.rejects(
      () => sendOneBotMessage(event, nextMode),
      (error) => error.deliveryOutcome === 'unknown',
    );
  }
  assert.equal(getHealth().sendMessage.unknownCount, 3, 'HTTP/protocol uncertainty is accounted separately');

  mode = 'ok';
  const afterUnknown = await sendOneBotMessage(event, 'after-unknown');
  assert.equal(afterUnknown.outcome, 'confirmed_success', 'normal send works after unknown results');
  console.log('PASS: OneBot delivery outcomes, accounting, and no-retry boundary');
} finally {
  await new Promise((resolve) => server.close(resolve));
  cleanupTestDir(dataDir);
}
