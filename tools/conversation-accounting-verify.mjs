import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-conversation-accounting');
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(dataDir);

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { recordConversationSuccess } = await import('../server/bot/conversationSuccess.ts');
const { recordConversationFailure } = await import('../server/bot/conversationFailure.ts');
const { processIncoming } = await import('../server/bot.ts');
ensureStore();

const GROUP = 'accounting-group';
const SELF = 'accounting-self';
const USER = 'accounting-user';

function event(overrides = {}) {
  return {
    source: 'onebot',
    type: 'group',
    messageId: 'accounting-event-' + Math.random().toString(16).slice(2),
    groupId: GROUP,
    userId: USER,
    nickname: 'fixture-user',
    text: '测试',
    atTargets: [SELF],
    images: [],
    raw: {},
    ...overrides,
  };
}

function resetUsage() {
  updateDb((db) => {
    db.messages = [];
    db.usageEvents = [];
    db.decisions = [];
    db.replyFailures = [];
    db.usage = {
      ...db.usage,
      totalTokens: 100,
      promptTokens: 80,
      completionTokens: 20,
      requests: 7,
      replies: 5,
      errors: 0,
    };
  });
}

const noReading = {
  readingScope: `group:${GROUP}`,
  readingRevision: 0,
  readingSources: [],
  confirmedReceipts: [],
};

// ── Success accounting: already-accounted usage must not be charged twice ──
resetUsage();
const accountedEvent = event({ messageId: 'accounted-true' });
const accountedBefore = { ...readDb().usage };
const accountedResult = recordConversationSuccess({
  event: accountedEvent,
  settings: readDb().settings,
  decision: { reason: 'fixture success' },
  ai: {
    model: 'fixture-model',
    provider: 'fixture-provider',
    latencyMs: 12,
    usage: { accounted: true, total_tokens: 120, prompt_tokens: 100, completion_tokens: 20 },
  },
  deliveredText: '第一段。第二段。第三段。',
  segments: ['第一段。', '第二段。', '第三段。'],
  toolImages: [],
  toolDeliverImages: [],
  modelStickerPath: '',
  modelStickerHistory: null,
  deliveredMediaImages: [],
  ...noReading,
});
const accountedDb = readDb();
assert.equal(accountedResult.replied, true);
assert.equal(accountedResult.segments.length, 3);
assert.equal(accountedDb.usage.requests, accountedBefore.requests, 'accounted usage must not increment requests again');
assert.equal(accountedDb.usage.replies, accountedBefore.replies + 3, 'three segments count three replies');
assert.equal(accountedDb.usage.totalTokens, accountedBefore.totalTokens, 'accounted usage must not add tokens again');
const accountedMessages = accountedDb.messages.filter((m) => m.role === 'assistant'
  && String(m.replyToMessageId || '') === 'accounted-true');
assert.equal(accountedMessages.length, 1, 'one assistant history record');
assert.equal(accountedMessages[0].content, '第一段。第二段。第三段。');
const accountedEventRow = accountedDb.usageEvents.filter((e) => e.kind === 'reply-delivery');
assert.equal(accountedEventRow.length, 1, 'one reply-delivery event');
assert.equal(accountedEventRow[0].status, 'completed');
assert.equal(accountedEventRow[0].accountingExcluded, true, 'accounted usage is diagnostic-only');
assert.equal(accountedEventRow[0].observedUsage.totalTokens, 120);
assert.equal(accountedEventRow[0].totalTokens, 0, 'diagnostic event is not billable');

// ── Success accounting: unaccounted usage is charged once ──
resetUsage();
const unaccountedBefore = { ...readDb().usage };
recordConversationSuccess({
  event: event({ messageId: 'accounted-false' }),
  settings: readDb().settings,
  decision: { reason: 'fixture success' },
  ai: {
    model: 'fixture-model',
    provider: 'fixture-provider',
    latencyMs: 8,
    usage: { accounted: false, total_tokens: 50, prompt_tokens: 40, completion_tokens: 10 },
  },
  deliveredText: '单段回复。',
  segments: ['单段回复。'],
  toolImages: [],
  toolDeliverImages: [],
  modelStickerPath: '',
  modelStickerHistory: null,
  deliveredMediaImages: [],
  ...noReading,
});
const unaccountedDb = readDb();
assert.equal(unaccountedDb.usage.requests, unaccountedBefore.requests + 1, 'unaccounted usage requests once');
assert.equal(unaccountedDb.usage.replies, unaccountedBefore.replies + 1, 'one segment counts one reply');
assert.equal(unaccountedDb.usage.totalTokens, unaccountedBefore.totalTokens + 50, 'unaccounted usage adds tokens');
assert.equal(unaccountedDb.usage.promptTokens, unaccountedBefore.promptTokens + 40);
assert.equal(unaccountedDb.usage.completionTokens, unaccountedBefore.completionTokens + 10);
const unaccountedRow = unaccountedDb.usageEvents.filter((e) => e.kind === 'reply-delivery');
assert.equal(unaccountedRow.length, 1);
assert.equal(unaccountedRow[0].accountingExcluded, false);
assert.equal(unaccountedRow[0].totalTokens, 50);

// ── Failure accounting: explicit request, natural participation, started delivery ──
function failureSnapshot() {
  const db = readDb();
  return {
    errors: db.usage.errors,
    events: db.usageEvents.length,
    decisions: db.decisions.length,
    failures: (db.replyFailures || []).length,
  };
}

function failureDelta(before) {
  const db = readDb();
  return {
    errors: db.usage.errors - before.errors,
    events: db.usageEvents.length - before.events,
    decisions: db.decisions.length - before.decisions,
    failures: (db.replyFailures || []).length - before.failures,
  };
}

resetUsage();
const explicitEvent = event({ messageId: 'failure-explicit', replyToCurrentMessage: true });
const explicitSends = [];
let explicitBefore = failureSnapshot();
const explicitResult = await recordConversationFailure({
  event: explicitEvent,
  sendMessage: async (_event, text) => { explicitSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 1 }; },
  decision: { reason: 'fixture failure' },
  error: new Error('fixture generation failure'),
  deliveryStarted: false,
  modelStageStarted: true,
});
const explicitDelta = failureDelta(explicitBefore);
assert.equal(explicitResult.replied, false);
assert.equal(explicitSends.length, 1, 'explicit request gets one failure notice');
assert.ok(explicitSends[0].includes('[系统] 这次查询或回复未能完成'), explicitSends[0]);
assert.equal(explicitDelta.errors, 1);
assert.equal(explicitDelta.events, 1);
assert.equal(explicitDelta.decisions, 1);
assert.equal(explicitDelta.failures, 1);
assert.equal(readDb().usageEvents.at(-1).status, 'generation_failed');
assert.equal(readDb().usageEvents.at(-1).accountingExcluded, true);

resetUsage();
const naturalEvent = event({ messageId: 'failure-natural', replyToCurrentMessage: false });
const naturalSends = [];
let naturalBefore = failureSnapshot();
await recordConversationFailure({
  event: naturalEvent,
  sendMessage: async (_event, text) => { naturalSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 2 }; },
  decision: { reason: 'fixture failure' },
  error: new Error('fixture natural failure'),
  deliveryStarted: false,
  modelStageStarted: true,
});
const naturalDelta = failureDelta(naturalBefore);
assert.equal(naturalSends.length, 0, 'ambient failure must stay silent');
assert.equal(naturalDelta.errors, 1);
assert.equal(naturalDelta.events, 1);
assert.equal(naturalDelta.decisions, 1);
assert.equal(naturalDelta.failures, 1);

resetUsage();
const deliveredEvent = event({ messageId: 'failure-delivery-started', replyToCurrentMessage: true });
const deliveredSends = [];
let deliveredBefore = failureSnapshot();
await recordConversationFailure({
  event: deliveredEvent,
  sendMessage: async (_event, text) => { deliveredSends.push(String(text || '')); return { outcome: 'unknown' }; },
  decision: { reason: 'fixture failure' },
  error: new Error('fixture delivery started failure'),
  deliveryStarted: true,
  modelStageStarted: true,
});
const deliveredDelta = failureDelta(deliveredBefore);
assert.equal(deliveredSends.length, 0, 'must not send a second failure notice after delivery starts');
assert.equal(deliveredDelta.errors, 1);
assert.equal(deliveredDelta.events, 1);
assert.equal(deliveredDelta.decisions, 1);
assert.equal(deliveredDelta.failures, 0, 'delivery-started failure is not a pre-send reply failure');
assert.equal(readDb().usageEvents.at(-1).status, 'failed_or_unknown');

// ── Multi-segment process: one LLM request, three delivered segments, one history row ──
const paragraph = (n) => `第${n}段：` + '这是一段用于验证多段回复记账的较长正文，内容本身不重要。'.repeat(8);
const multiText = [paragraph('一'), paragraph('二'), paragraph('三')].join('\n\n');
const llmServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'accounting-completion',
      object: 'chat.completion',
      created: Date.now(),
      model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: multiText }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});
await new Promise((resolve) => llmServer.listen(0, '127.0.0.1', resolve));
const llmPort = llmServer.address().port;
try {
  updateDb((db) => {
    db.settings = {
      ...db.settings,
      selfQq: SELF,
      ownerQq: '',
      botNames: 'pippi',
      globalPaused: false,
      tokenSavingMode: false,
      socialV2Enabled: false,
      presenceEnabled: false,
      memoryEnabled: false,
      osuSearchEnabled: false,
      enableAutoModel: false,
      agentRuntimeMode: 'legacy',
      thinkingNoticeMode: 'off',
      apiBaseUrl: `http://127.0.0.1:${llmPort}/v1`,
      apiKey: 'fixture-key',
      llmProvider: 'openai-compatible',
      model: 'fixture-model',
      stickerPolicy: { mode: 'off', allGroups: false, groupIds: [], groupCooldownSec: 0, userCooldownSec: 0, hourlyLimit: 0, dailyLimit: 0, userDailyLimit: 0, duplicateStickerCooldownSec: 0 },
    };
    db.groups = [{ groupId: GROUP, name: 'Accounting', enabled: true, mode: 'mention', maxPerHour: 100, cooldownSec: 0, randomImageEnabled: false }];
    db.messages = [];
    db.usageEvents = [];
    db.decisions = [];
    db.replyFailures = [];
    db.usage = { ...db.usage, totalTokens: 100, promptTokens: 80, completionTokens: 20, requests: 7, replies: 5, errors: 0 };
  });
  const sends = [];
  const before = { requests: readDb().usage.requests, replies: readDb().usage.replies };
  const multiEvent = event({ messageId: 'multi-segment-process', text: `[CQ:at,qq=${SELF}] 写三段话` });
  const multiResult = await processIncoming(multiEvent, async (_event, text) => {
    sends.push(String(text || ''));
    return { outcome: 'confirmed_success', messageId: sends.length };
  });
  const after = readDb();
  assert.equal(multiResult.replied, true);
  assert.equal(multiResult.segments.length, 3, 'three reply segments');
  assert.equal(sends.length, 3, 'three sends');
  assert.equal(after.usage.requests, before.requests + 1, 'one model request counted once');
  assert.equal(after.usage.replies, before.replies + 3, 'three delivered segments counted');
  const assistant = after.messages.filter((m) => m.role === 'assistant'
    && String(m.replyToMessageId || '') === 'multi-segment-process');
  assert.equal(assistant.length, 1, 'one assistant history row');
  assert.equal(assistant[0].content, multiText);
  const deliveryEvents = after.usageEvents.filter((e) => e.kind === 'reply-delivery');
  assert.equal(deliveryEvents.length, 1, 'one reply-delivery event');
  assert.equal(deliveryEvents[0].status, 'completed');
  assert.equal(deliveryEvents[0].accountingExcluded, true);
  assert.equal(deliveryEvents[0].observedUsage.totalTokens, 15);
} finally {
  await new Promise((resolve) => llmServer.close(resolve));
  cleanupTestDir(dataDir);
}

console.log('conversation accounting: success/failure usage, history, events and multi-segment counts PASS');
