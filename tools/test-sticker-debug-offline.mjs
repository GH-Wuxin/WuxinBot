import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildStickerSelectionTool,
  explainModelStickerEligibility,
  listModelStickers,
  pickForModel,
  validateStickerCatalog,
} from '../server/bot/stickers/index.ts';
import { buildBotToolSchemas, DEFAULT_BOTS } from '../server/bots/registry.ts';
import { executeToolCall, runToolLoop } from '../server/bots/executor.ts';
import {
  beginLiveStickerDebug,
  clearStickerDebugTraces,
  listStickerDebugTraces,
  runStickerDryRun,
  setStickerDebugMode,
} from '../server/bot/stickers/debug.ts';
import {
  buildStickerReplyInstruction,
  parseStickerReply,
  STICKER_REPLY_RESPONSE_FORMAT,
} from '../server/bot/stickers/finalReply.ts';
import {
  completeStickerDelivery,
  clearStickerDeliveryState,
  getStickerDeliveryStats,
  recordStickerDecisionInDb,
  reserveStickerDelivery,
} from '../server/bot/stickers/delivery.ts';

const catalog = validateStickerCatalog({ verifyHashes: true });
assert.equal(catalog.ok, true, JSON.stringify(catalog));
// 不写死条数：这个测试要保的是「清单与人工标注一一对应」，不是某个体量。
// 不一致时 catalog.ok 已经是 false（上一行已断言），这里再钉住两者相等，
// 这样增删表情包不会误报，而真正的错配仍然会被抓住。
assert.equal(catalog.manifestCount, catalog.annotationCount);
assert.ok(catalog.manifestCount > 0, '贴纸清单不应为空');

// The model path is an exact-ID contract. Group/emotion fallback belongs only
// to the deterministic code path.
assert.equal(pickForModel('laugh'), null);
assert.equal(pickForModel('amused'), null);
assert.equal(pickForModel('service_down', { allowedGates: ['code'] }), null);
assert.equal(explainModelStickerEligibility('service_down', { allowedGates: ['code'] }).reason, 'gate');
// 从这里起用的是清单里的真实条目，不写死具体 id —— 这个测试要保的是
// 「精确 ID + 门禁 + 话题」这套契约，不是某一张贴纸。原先写死 dt_zoom，
// 那张挪进随机池之后这里就挂了。
const topicExample = JSON.parse(fs.readFileSync(path.resolve('server/bot/stickers/manifest.json'), 'utf8'))
  .stickers.find((entry) => entry.gate === 'topic' && Array.isArray(entry.topics) && entry.topics.length);
assert.ok(topicExample, '应当至少有一张带话题的 topic 档贴纸');
assert.equal(pickForModel(topicExample.id, { allowedGates: ['topic'] }), null);
assert.equal(
  pickForModel(topicExample.id, { allowedGates: ['topic'], contextTopics: topicExample.topics })?.id,
  topicExample.id,
);

const candidates = listModelStickers();
assert.ok(candidates.length > 0);
assert.ok(candidates.every((entry) => entry.gate === 'loose' && entry.mode === 'random'));
const tool = buildStickerSelectionTool();
const enumValues = tool.function.parameters.properties.sticker_id.enum;
assert.ok(Array.isArray(enumValues));
assert.ok(!enumValues.includes('service_down'));

const registry = { bots: DEFAULT_BOTS, updatedAt: '' };
for (const surface of ['legacy', 'v2']) {
  const names = buildBotToolSchemas(registry, { surface }).map((entry) => entry.function.name);
  assert.ok(!names.includes('send_sticker'), `${surface} normal tool surface must not expose send_sticker`);
}

const finalInstruction = buildStickerReplyInstruction();
assert.match(finalInstruction, /reply/);
assert.match(finalInstruction, /hello/);
assert.deepEqual(
  parseStickerReply('{"reply":"收到。","sticker_id":"hello"}'),
  { reply: '收到。', stickerId: 'hello', mode: 'text_image', structured: true },
);
assert.equal(parseStickerReply('下面是结果：{"reply":"收到。","sticker_id":"hello"}').stickerId, 'hello');
assert.equal(parseStickerReply('{"reply":"","sticker_id":"hello"}').mode, 'image_only');
assert.deepEqual(
  parseStickerReply('{"reply":"","mode":"image_only","sticker_id":"hello"}'),
  { reply: '', stickerId: 'hello', mode: 'image_only', structured: true },
);
assert.deepEqual(
  parseStickerReply('{"reply":"不要发图","mode":"none","sticker_id":"hello"}'),
  { reply: '不要发图', stickerId: null, mode: 'none', structured: true },
);
assert.equal(parseStickerReply('普通文字').stickerId, null);

// The production default is closed. Tests inject a plain persisted store so
// no real database or OneBot budget is touched.
const closedDb = { settings: {}, stickerDeliveryState: undefined };
const closedDelivery = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'tester',
  messageId: 'closed-message',
  stickerId: 'hello',
}, { db: closedDb, nowMs: 1_000_000 });
assert.equal(closedDelivery.ok, false);
assert.equal(closedDelivery.reason, 'mode');

// Live delivery is still gated before it reaches OneBot: only the configured
// test group is allowed, and the persisted reservation controls cooldowns.
const deliveryDb = {
  settings: {
    stickerPolicy: {
      mode: 'live',
      groupIds: ['1083681153', 'second-group'],
      groupCooldownSec: 10,
      userCooldownSec: 20,
      hourlyLimit: 3,
      dailyLimit: 16,
      userDailyLimit: 4,
      duplicateStickerCooldownSec: 30,
    },
  },
  stickerDeliveryState: undefined,
};
clearStickerDeliveryState({ db: deliveryDb });
recordStickerDecisionInDb(deliveryDb, { mode: 'none' });
recordStickerDecisionInDb(deliveryDb, { mode: 'text_image', stickerId: 'hello', validSelection: true });
recordStickerDecisionInDb(deliveryDb, { mode: 'image_only', stickerId: 'hello', validSelection: false });
assert.equal(getStickerDeliveryStats({ db: deliveryDb }).counters.eligibleReplies, 3);
assert.equal(getStickerDeliveryStats({ db: deliveryDb }).counters.modelProposals, 2);
assert.equal(getStickerDeliveryStats({ db: deliveryDb }).counters.invalidSelections, 1);
const baseDeliveryTime = 2_000_000;
const liveDelivery = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'tester',
  messageId: 'live-message-1',
  stickerId: 'hello',
}, { db: deliveryDb, nowMs: baseDeliveryTime });
assert.equal(liveDelivery.ok, true);
assert.equal(liveDelivery.stickerId, 'hello');
assert.ok(liveDelivery.path);
const duplicateDelivery = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'tester',
  messageId: 'live-message-2',
  stickerId: 'hello',
}, { db: deliveryDb, nowMs: baseDeliveryTime + 1_000 });
assert.equal(duplicateDelivery.ok, false);
assert.equal(duplicateDelivery.reason, 'duplicate');
const userCooldownDelivery = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'tester',
  messageId: 'live-message-3',
  stickerId: 'received',
}, { db: deliveryDb, nowMs: baseDeliveryTime + 11_000 });
assert.equal(userCooldownDelivery.ok, false);
assert.equal(userCooldownDelivery.reason, 'user_cooldown');
assert.equal(completeStickerDelivery(liveDelivery.reservationId, 'confirmed_success', {
  db: deliveryDb,
  nowMs: baseDeliveryTime + 12_000,
}), true);
const restoredDeliveryDb = structuredClone(deliveryDb);
const restoredGate = reserveStickerDelivery({
  eventType: 'group',
  groupId: '1083681153',
  userId: 'tester',
  messageId: 'live-message-4',
  stickerId: 'received',
}, { db: restoredDeliveryDb, nowMs: baseDeliveryTime + 13_000 });
assert.equal(restoredGate.ok, false);
assert.equal(restoredGate.reason, 'user_cooldown');
const wrongGroupDelivery = reserveStickerDelivery({
  eventType: 'group',
  groupId: 'other-group',
  userId: 'tester',
  messageId: 'wrong-group-message',
  stickerId: 'hello',
}, { db: deliveryDb, nowMs: baseDeliveryTime + 40_000 });
assert.equal(wrongGroupDelivery.ok, false);
assert.equal(wrongGroupDelivery.reason, 'group');
const concurrentDb = {
  settings: {
    stickerPolicy: {
      mode: 'live', groupIds: ['1083681153'], groupCooldownSec: 0, userCooldownSec: 0,
      hourlyLimit: 1, dailyLimit: 1, userDailyLimit: 1, duplicateStickerCooldownSec: 0,
    },
  },
  stickerDeliveryState: undefined,
};
const concurrent = await Promise.all([
  Promise.resolve(reserveStickerDelivery({
    eventType: 'group', groupId: '1083681153', userId: 'a', messageId: 'concurrent-a', stickerId: 'hello',
  }, { db: concurrentDb, nowMs: baseDeliveryTime })),
  Promise.resolve(reserveStickerDelivery({
    eventType: 'group', groupId: '1083681153', userId: 'b', messageId: 'concurrent-b', stickerId: 'received',
  }, { db: concurrentDb, nowMs: baseDeliveryTime })),
]);
assert.equal(concurrent.filter((item) => item.ok).length, 1);
assert.equal(concurrent.filter((item) => item.reason === 'hourly_limit').length, 1);

const outcomeDb = {
  settings: {
    stickerPolicy: {
      mode: 'live', groupIds: ['1083681153'], groupCooldownSec: 0, userCooldownSec: 0,
      hourlyLimit: 1, dailyLimit: 16, userDailyLimit: 4, duplicateStickerCooldownSec: 0,
    },
  },
  stickerDeliveryState: undefined,
};
const failedReservation = reserveStickerDelivery({
  eventType: 'group', groupId: '1083681153', userId: 'failure-user', messageId: 'failure-1', stickerId: 'hello',
}, { db: outcomeDb, nowMs: baseDeliveryTime });
assert.equal(failedReservation.ok, true);
assert.equal(completeStickerDelivery(failedReservation.reservationId, 'confirmed_failure', {
  db: outcomeDb,
  nowMs: baseDeliveryTime + 1,
}), true);
const afterConfirmedFailure = reserveStickerDelivery({
  eventType: 'group', groupId: '1083681153', userId: 'failure-user', messageId: 'failure-2', stickerId: 'received',
}, { db: outcomeDb, nowMs: baseDeliveryTime + 2 });
assert.equal(afterConfirmedFailure.ok, true);
assert.equal(completeStickerDelivery(afterConfirmedFailure.reservationId, 'unknown', {
  db: outcomeDb,
  nowMs: baseDeliveryTime + 3,
}), true);
const afterUnknown = reserveStickerDelivery({
  eventType: 'group', groupId: '1083681153', userId: 'failure-user', messageId: 'failure-3', stickerId: 'thanks',
}, { db: outcomeDb, nowMs: baseDeliveryTime + 4 });
assert.equal(afterUnknown.ok, false);
assert.equal(afterUnknown.reason, 'hourly_limit');

clearStickerDebugTraces();
setStickerDebugMode('trace-once', { groupId: 'offline-test' });
const session = beginLiveStickerDebug({ groupId: 'offline-test', userId: 'tester' });
assert.ok(session);
session.record('catalog_loaded', 'ok', { nested: { value: 1 } });
const finished = session.finish('completed');
const eventCount = finished.eventCount;
session.record('send_requested', 'late');
assert.equal(session.snapshot()?.eventCount, eventCount);
const returned = finished.events[1].data;
returned.nested.value = 99;
assert.equal(session.snapshot()?.events[1].data.nested.value, 1);

const dryRun = runStickerDryRun({ stickerId: 'hello', groupId: 'offline-test' });
assert.equal(dryRun.ok, true);
assert.equal(dryRun.trace.status, 'dry_run');
assert.equal(dryRun.trace.events.at(-1).data.sendSkipped, true);
assert.equal(dryRun.trace.events.at(-2).stage, 'send_requested');

let sendMessageCalls = 0;
const executedDryRun = await executeToolCall({
  id: 'offline-send-sticker',
  type: 'function',
  function: { name: 'send_sticker', arguments: JSON.stringify({ sticker_id: 'hello' }) },
}, {
  db: { settings: {} },
  userId: 'tester',
  groupId: 'offline-test',
  event: { messageId: 'offline-message' },
  sendMessage: async () => { sendMessageCalls += 1; },
});
assert.equal(executedDryRun.ok, true);
assert.equal(executedDryRun.metadata?.actualExecutor, 'sticker_debug_dry_run');
assert.equal(executedDryRun.metadata?.sendSkipped, true);
assert.equal(executedDryRun.deliverOnlyImages?.length || 0, 0);
assert.equal(sendMessageCalls, 0);
assert.equal(
  listStickerDebugTraces(1)[0]?.events.find((event) => event.stage === 'catalog_loaded')?.data?.verifyHashes,
  false,
);

const rejectedCodeSticker = await executeToolCall({
  id: 'offline-send-code-sticker',
  type: 'function',
  function: { name: 'send_sticker', arguments: JSON.stringify({ sticker_id: 'service_down' }) },
}, {
  db: { settings: {} },
  userId: 'tester',
  groupId: 'offline-test',
  event: { messageId: 'offline-message-2' },
  sendMessage: async () => { sendMessageCalls += 1; },
});
assert.equal(rejectedCodeSticker.ok, false);
assert.equal(rejectedCodeSticker.error, 'sticker_selection_rejected');
assert.equal(sendMessageCalls, 0);
assert.equal(listStickerDebugTraces(1)[0]?.operation, 'dry-run');

let plannerCalls = 0;
let loopSendMessageCalls = 0;
const modelLoop = await runToolLoop(async () => {
  plannerCalls += 1;
  if (plannerCalls === 1) {
    const call = {
      id: 'model-selected-sticker',
      type: 'function',
      function: { name: 'send_sticker', arguments: JSON.stringify({ sticker_id: 'hello' }) },
    };
    return {
      text: '',
      usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
      raw: { choices: [{ message: { content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] },
    };
  }
  return {
    text: '已记录这个选择。',
    usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
    raw: { choices: [{ message: { content: '已记录这个选择。' }, finish_reason: 'stop' }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '选择一张表情' }],
  tools: [tool],
  userId: 'tester',
  groupId: 'offline-test',
  event: { messageId: 'offline-model-message' },
  sendMessage: async () => { loopSendMessageCalls += 1; },
  maxIterations: 2,
  structuredToolResults: true,
  executeToolCallFn: executeToolCall,
});
assert.equal(modelLoop.toolCallsMade, 1);
assert.equal(modelLoop.deliverOnlyImages?.length || 0, 0);
assert.equal(loopSendMessageCalls, 0);

let synthesisCalls = 0;
let synthesisOptions;
const finalSynthesis = await runToolLoop(async (_db, options) => {
  synthesisCalls += 1;
  if (synthesisCalls === 1) {
    const call = {
      id: 'probe-call',
      type: 'function',
      function: { name: 'probe', arguments: '{}' },
    };
    return {
      text: '',
      usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
      raw: { choices: [{ message: { content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] },
    };
  }
  synthesisOptions = options;
  const text = JSON.stringify({ reply: '工具结果整理好了。', sticker_id: 'hello' });
  return {
    text,
    usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
    raw: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'user', content: '整理这件事' }],
  tools: [{ type: 'function', function: { name: 'probe', description: 'test', parameters: { type: 'object', properties: {} } } }],
  userId: 'tester',
  groupId: 'offline-test',
  event: { messageId: 'offline-synthesis-message' },
  maxIterations: 1,
  finalResponseFormat: STICKER_REPLY_RESPONSE_FORMAT,
  finalResponseInstruction: finalInstruction,
  executeToolCallFn: async (toolCall) => ({ toolCallId: toolCall.id, ok: true, content: '真实工具证据' }),
});
assert.equal(synthesisCalls, 2);
assert.equal(synthesisOptions.responseFormat.type, 'json_object');
assert.match(String(synthesisOptions.messages.at(-1).content), /最终回复格式/);
assert.deepEqual(parseStickerReply(finalSynthesis.text).stickerId, 'hello');

let earlyFinishCalls = 0;
const earlyFinish = await runToolLoop(async (_db, options) => {
  earlyFinishCalls += 1;
  if (earlyFinishCalls === 1) {
    const call = {
      id: 'early-finish-probe',
      type: 'function',
      function: { name: 'probe', arguments: '{}' },
    };
    return {
      text: '',
      usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
      raw: { choices: [{ message: { content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] },
    };
  }
  assert.match(String(options.messages[0].content), /最终回复格式/);
  const text = JSON.stringify({ reply: '已经整理好了。', sticker_id: 'hello' });
  return {
    text,
    usage: { total_tokens: 1, prompt_tokens: 1, completion_tokens: 0 },
    raw: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
  };
}, {
  db: { settings: {} },
  messages: [{ role: 'system', content: '系统提示' }, { role: 'user', content: '整理这件事' }],
  tools: [{ type: 'function', function: { name: 'probe', description: 'test', parameters: { type: 'object', properties: {} } } }],
  userId: 'tester',
  groupId: 'offline-test',
  event: { messageId: 'offline-early-finish-message' },
  maxIterations: 2,
  finalResponseFormat: STICKER_REPLY_RESPONSE_FORMAT,
  finalResponseInstruction: finalInstruction,
  executeToolCallFn: async (toolCall) => ({ toolCallId: toolCall.id, ok: true, content: '真实工具证据' }),
});
assert.equal(earlyFinishCalls, 2);
assert.deepEqual(parseStickerReply(earlyFinish.text).stickerId, 'hello');

console.log(JSON.stringify({
  ok: true,
  catalog: `${catalog.manifestCount}/${catalog.annotationCount}`,
  candidateCount: candidates.length,
  defaultDelivery: closedDelivery.reason,
  liveDelivery: liveDelivery.ok ? 'reserved' : liveDelivery.reason,
  duplicateDelivery: duplicateDelivery.reason,
  userCooldownDelivery: userCooldownDelivery.reason,
  restoredGate: restoredGate.reason,
  wrongGroupDelivery: wrongGroupDelivery.reason,
  concurrent: concurrent.map((item) => item.ok ? 'reserved' : item.reason),
  confirmedFailureReleases: afterConfirmedFailure.ok,
  unknownConsumesBudget: afterUnknown.reason,
  traceEvents: eventCount,
  dryRun: dryRun.selected?.id,
  executor: 'send_sticker dry-run',
  sendMessageCalls,
  modelLoopToolCalls: modelLoop.toolCallsMade,
  modelLoopSendMessageCalls: loopSendMessageCalls,
  finalSynthesisSticker: parseStickerReply(finalSynthesis.text).stickerId,
  earlyFinishSticker: parseStickerReply(earlyFinish.text).stickerId,
}, null, 2));
