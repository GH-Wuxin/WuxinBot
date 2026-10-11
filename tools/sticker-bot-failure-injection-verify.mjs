import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-sticker-bot-failure');
process.env.DATA_DIR = dataDir;
process.env.PIPPI_AGENT_RUNTIME_MODE = 'legacy';
assertNotProduction(dataDir);

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts?sticker-bot-failure-verify');
const { getStickerDeliveryState, getStickerDeliveryStats } = await import(
  '../server/bot/stickers/delivery.ts?sticker-bot-failure-verify'
);

let llmRequests = 0;
let timeoutServer;
let failureServer;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    llmRequests += 1;
    const body = JSON.parse(raw || '{}');
    assert.equal(body.response_format?.type, 'json_object');
    const content = JSON.stringify({ reply: '', mode: 'image_only', sticker_id: 'hello' });
    const response = {
      id: `sticker-fixture-${llmRequests}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
});

await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
const llmPort = llmServer.address().port;

ensureStore();
updateDb((db) => {
  db.settings.selfQq = '900000001';
  db.settings.ownerQq = '';
  db.settings.botNames = 'pippi';
  db.settings.llmProvider = 'openai-compatible';
  db.settings.model = 'fixture-model';
  db.settings.apiKey = 'fixture-key';
  db.settings.deepseekApiKey = 'fixture-key';
  db.settings.apiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
  db.settings.deepseekApiBaseUrl = `http://127.0.0.1:${llmPort}/v1`;
  db.settings.enableAutoModel = false;
  db.settings.thinkingNoticeMode = 'off';
  db.settings.memoryEnabled = false;
  db.settings.searchProvider = 'disabled';
  db.settings.enableWebSearch = false;
  db.settings.botRegistry = {
    updatedAt: new Date().toISOString(),
    bots: [{ id: 'disabled-fixture', name: 'disabled-fixture', enabled: false, channel: 'internal', commands: [] }],
  };
  db.groups = [
    { groupId: 'sticker-gate-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 },
    { groupId: 'sticker-send-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 },
    { groupId: 'sticker-timeout-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 },
  ];
  db.stickerDeliveryState = undefined;
});

function event(groupId, messageId) {
  const mentioned = arguments.length < 3 || arguments[2] !== false;
  return {
    source: 'onebot',
    type: 'group',
    messageId,
    groupId,
    userId: '900000002',
    nickname: 'fixture-user',
    text: mentioned ? '[CQ:at,qq=900000001] 给个反应' : '自然接话失败测试',
    atTargets: mentioned ? ['900000001'] : [],
    images: [],
    raw: {},
  };
}

function configurePolicy(groupIds, mode = 'live') {
  updateDb((db) => {
    db.settings.stickerPolicy = {
      mode,
      groupIds,
      groupCooldownSec: 0,
      userCooldownSec: 0,
      hourlyLimit: 10,
      dailyLimit: 20,
      userDailyLimit: 10,
      duplicateStickerCooldownSec: 0,
    };
    db.stickerDeliveryState = undefined;
  });
}

try {
  // Gate rejection: the model selected image_only, but the source group is not
  // allowlisted. The normal text reply must still be delivered.
  configurePolicy(['some-other-group']);
  const gateSends = [];
  const gateResult = await processIncoming(
    event('sticker-gate-group', 'sticker-gate-message'),
    async (_event, text) => {
      gateSends.push(String(text || ''));
      return { outcome: 'confirmed_success', messageId: 1 };
    },
  );
  assert.equal(gateResult.replied, true);
  assert.equal(gateSends.length, 1);
  assert.equal(gateSends[0], '收到。');
  assert.equal(gateSends[0].includes('[CQ:image'), false);
  assert.equal(getStickerDeliveryStats({ nowMs: Date.now() }).counters.byGroup['sticker-gate-group'].eligibleReplies, 1);

  // Global off: the same model choice must degrade to text and leave no
  // reservation record at all.
  configurePolicy([], 'off');
  const disabledSends = [];
  const disabledResult = await processIncoming(
    event('sticker-gate-group', 'sticker-disabled-message'),
    async (_event, text) => {
      disabledSends.push(String(text || ''));
      return { outcome: 'confirmed_success', messageId: 11 };
    },
  );
  assert.equal(disabledResult.replied, true);
  assert.deepEqual(disabledSends, ['收到。']);
  assert.equal(getStickerDeliveryState().records.length, 0);

  // Confirmed image failure: the first image send fails with a definitive
  // outcome; the bot must send the image_only text fallback and must not resend
  // the image. The reservation is finalized as confirmed_failure.
  configurePolicy(['sticker-send-group']);
  const failureSends = [];
  let imageAttemptCount = 0;
  const failureResult = await processIncoming(
    event('sticker-send-group', 'sticker-send-message'),
    async (_event, text) => {
      const value = String(text || '');
      failureSends.push(value);
      if (value.includes('[CQ:image')) {
        imageAttemptCount += 1;
        const error = new Error('fixture OneBot confirmed failure');
        error.deliveryOutcome = 'confirmed_failure';
        throw error;
      }
      return { outcome: 'confirmed_success', messageId: 2 };
    },
  );
  assert.equal(failureResult.replied, true);
  assert.equal(imageAttemptCount, 1);
  assert.equal(failureSends.length, 2);
  assert.equal(failureSends[0].includes('[CQ:image'), true);
  assert.equal(failureSends[1], '收到。');
  const state = getStickerDeliveryState();
  assert.equal(state.records.at(-1).outcome, 'confirmed_failure');
  assert.equal(state.counters.confirmedFailure, 1);
  assert.equal(getStickerDeliveryStats().counters.byGroup['sticker-send-group'].eligibleReplies, 1);

  // Unknown outcome: never retry the image or invent a text resend, because
  // the first request may already have reached QQ. The reservation remains a
  // conservative budget record with outcome=unknown.
  configurePolicy(['sticker-send-group']);
  const unknownSends = [];
  const unknownResult = await processIncoming(
    event('sticker-send-group', 'sticker-unknown-message'),
    async (_event, text) => {
      unknownSends.push(String(text || ''));
      const error = new Error('fixture OneBot uncertain outcome');
      throw error;
    },
  );
  assert.equal(unknownResult.replied, false);
  assert.equal(unknownSends.length, 1);
  assert.equal(unknownSends[0].includes('[CQ:image'), true);
  assert.equal(getStickerDeliveryState().records.at(-1).outcome, 'unknown');
  assert.equal(getStickerDeliveryState().counters.unknown, 1);

  // Model timeout during generation: the normal system failure notice is the
  // only outbound message, and the sticker denominator/reservation path is
  // never entered because there is no final reply to evaluate.
  timeoutServer = http.createServer((req, _res) => {
    req.on('aborted', () => {});
    // Deliberately leave the request open; the production HTTP deadline must
    // abort it rather than waiting for a response from the provider.
  });
  await new Promise((resolve) => timeoutServer.listen(0, '127.0.0.1', resolve));
  const timeoutPort = timeoutServer.address().port;
  updateDb((db) => {
    db.settings.apiBaseUrl = `http://127.0.0.1:${timeoutPort}/v1`;
    db.stickerDeliveryState = undefined;
  });
  configurePolicy(['sticker-timeout-group']);
  const timeoutSends = [];
  const timeoutStartedAt = Date.now();
  const timeoutResult = await processIncoming(
    event('sticker-timeout-group', 'sticker-timeout-message'),
    async (_event, text) => {
      timeoutSends.push(String(text || ''));
      return { outcome: 'confirmed_success', messageId: 3 };
    },
  );
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert.equal(timeoutResult.replied, false);
  assert.deepEqual(timeoutSends, ['[系统] 这次查询或回复未能完成，请稍后重试。']);
  assert.equal(getStickerDeliveryState().records.length, 0);
  assert.equal(getStickerDeliveryStats().counters.eligibleReplies, 0);
  assert.ok(timeoutElapsedMs < 60_000, `bot timeout fallback exceeded bound: ${timeoutElapsedMs}ms`);

  // A model failure is user-visible only for a direct @ request. The same
  // failure during natural participation is recorded by the backend but must
  // stay silent in the group.
  failureServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"fixture model failure"}');
  });
  await new Promise((resolve) => failureServer.listen(0, '127.0.0.1', resolve));
  const failurePort = failureServer.address().port;
  updateDb((db) => {
    db.settings.apiBaseUrl = `http://127.0.0.1:${failurePort}/v1`;
    db.settings.codexFallbackEnabled = false;
  });
  configurePolicy([], 'off');
  const directFailureSends = [];
  const directFailureResult = await processIncoming(
    event('sticker-timeout-group', 'sticker-direct-failure-message', true),
    async (_event, text) => { directFailureSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 4 }; },
  );
  assert.equal(directFailureResult.replied, false);
  assert.deepEqual(directFailureSends, ['[系统] 这次查询或回复未能完成，请稍后重试。']);

  const naturalFailureSends = [];
  const naturalFailureResult = await processIncoming(
    event('sticker-timeout-group', 'sticker-natural-failure-message', false),
    async (_event, text) => { naturalFailureSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 5 }; },
  );
  assert.equal(naturalFailureResult.replied, false);
  assert.deepEqual(naturalFailureSends, []);

  console.log(JSON.stringify({
    ok: true,
    llmRequests,
    gateRejection: 'text fallback delivered',
    disabledMode: 'text fallback delivered; no reservation',
    confirmedFailure: 'one image attempt + one text fallback; reservation released',
    unknownOutcome: 'one image attempt; no retry; budget retained',
    modelTimeout: `system fallback only; no sticker reservation (${timeoutElapsedMs}ms)`,
    naturalFailure: 'silent; direct @ failure notice retained',
  }, null, 2));
} finally {
  await new Promise((resolve) => llmServer.close(resolve));
  if (timeoutServer) await new Promise((resolve) => timeoutServer.close(resolve));
  if (failureServer) await new Promise((resolve) => failureServer.close(resolve));
  cleanupTestDir(dataDir);
}
