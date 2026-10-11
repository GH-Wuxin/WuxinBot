import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanupTestDir, createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const ENV_OVERRIDES = [
  'WUXIN_STICKER_DELIVERY_MODE',
  'WUXIN_STICKER_ALL_GROUPS',
  'WUXIN_STICKER_LIVE_GROUP_IDS',
  'WUXIN_STICKER_COOLDOWN_MS',
  'WUXIN_STICKER_USER_COOLDOWN_MS',
  'WUXIN_STICKER_HOURLY_LIMIT',
  'WUXIN_STICKER_DAILY_LIMIT',
  'WUXIN_STICKER_USER_DAILY_LIMIT',
  'WUXIN_STICKER_DUPLICATE_WINDOW_MS',
];
const savedEnv = Object.fromEntries(ENV_OVERRIDES.map((name) => [name, process.env[name]]));
for (const name of ENV_OVERRIDES) delete process.env[name];

const dataDir = createTestDataDir('wuxin-sticker-delivery-contract');
assertNotProduction(dataDir);

const {
  ensureStore,
  readDb,
  updateDb,
} = await import('../server/store.ts');
const {
  completeStickerDelivery,
  getStickerDeliveryState,
  getStickerDeliveryStats,
  recordStickerDecisionInDb,
  reserveStickerDelivery,
} = await import('../server/bot/stickers/delivery.ts?contract-verify');
const { pickCodeSticker, pickSticker } = await import('../server/bot/stickers/index.ts?contract-verify');
const { ensureStickerReplyFallback, stickerFailureFallback } = await import(
  '../server/bot/stickers/replyDelivery.ts?contract-verify'
);
const { parseStickerReply, resolveStickerReplyCapability } = await import(
  '../server/bot/stickers/finalReply.ts?contract-verify'
);
const { sendOneBotMessage } = await import('../server/onebot.ts?sticker-contract-verify');

const basePolicy = (groupIds, overrides = {}) => ({
  mode: 'live',
  allGroups: false,
  groupIds,
  groupCooldownSec: 0,
  userCooldownSec: 0,
  hourlyLimit: 20,
  dailyLimit: 50,
  userDailyLimit: 20,
  duplicateStickerCooldownSec: 60,
  ...overrides,
});

function injectedDb(groupIds, overrides = {}) {
  return {
    settings: { stickerPolicy: basePolicy(groupIds, overrides) },
    stickerDeliveryState: undefined,
  };
}

function reserve(db, { groupId, userId = 'user', messageId, stickerId = 'hello', nowMs }) {
  return reserveStickerDelivery({
    eventType: 'group',
    groupId,
    userId,
    messageId,
    stickerId,
  }, { db, nowMs });
}

function lastJsonLine(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/u).filter(Boolean).at(-1);
  return JSON.parse(line || '{}');
}

let server;
let requestBody = null;
try {
  const baseTime = 5_000_000;

  const validEnvelope = JSON.stringify({ reply: '你好', mode: 'none', sticker_id: null });
  assert.equal(parseStickerReply(`${validEnvelope}\n附注`).structured, true);
  assert.equal(parseStickerReply(`${validEnvelope}\n附注`).reply, '你好');
  assert.equal(parseStickerReply(`${validEnvelope.slice(0, -1)}`).reply, '你好');
  assert.equal(parseStickerReply(`说明：${validEnvelope}`).reply, '你好');
  assert.equal(resolveStickerReplyCapability({ eligible: true, deliveryMode: 'off' }).enabled, false);
  assert.equal(resolveStickerReplyCapability({
    eligible: true,
    deliveryMode: 'live',
    buildInstruction: () => { throw new Error('fixture catalogue failure'); },
  }).reason, 'catalog_unavailable');

  // Code-owned pools may opt into code-gated groups; the ordinary picker and
  // model path must continue to reject the same group.
  assert.equal(pickSticker('thinking', { rng: () => 0 }), null);
  assert.equal(pickCodeSticker('thinking', { rng: () => 0 })?.id, 'thinking_01');

  // 1. A -> B -> A must still detect the first A inside the full duplicate
  // window. A latest-record-only implementation incorrectly allows this.
  const repeatedDb = injectedDb(['repeat-group'], { duplicateStickerCooldownSec: 60 });
  const firstA = reserve(repeatedDb, {
    groupId: 'repeat-group', messageId: 'repeat-a', stickerId: 'hello', nowMs: baseTime,
  });
  const middleB = reserve(repeatedDb, {
    groupId: 'repeat-group', messageId: 'repeat-b', stickerId: 'received', nowMs: baseTime + 1_000,
  });
  const finalA = reserve(repeatedDb, {
    groupId: 'repeat-group', messageId: 'repeat-a-again', stickerId: 'hello', nowMs: baseTime + 2_000,
  });
  assert.equal(firstA.ok, true);
  assert.equal(middleB.ok, true);
  assert.equal(finalA.ok, false);
  assert.equal(finalA.reason, 'duplicate');

  // 2. messageId is only a duplicate within the same source group. A replay
  // or cross-group source must not poison another group's turn.
  const scopedDb = injectedDb(['source-a', 'source-b']);
  const sourceA = reserve(scopedDb, {
    groupId: 'source-a', messageId: 'same-message-id', stickerId: 'hello', nowMs: baseTime,
  });
  const sourceB = reserve(scopedDb, {
    groupId: 'source-b', messageId: 'same-message-id', stickerId: 'received', nowMs: baseTime + 1,
  });
  const sourceARepeat = reserve(scopedDb, {
    groupId: 'source-a', messageId: 'same-message-id', stickerId: 'thanks', nowMs: baseTime + 2,
  });
  assert.equal(sourceA.ok, true);
  assert.equal(sourceB.ok, true);
  assert.equal(sourceARepeat.ok, false);
  assert.equal(sourceARepeat.reason, 'duplicate_turn');

  // 3. Budget semantics: confirmed_failure releases; unknown, accepted_unknown
  // and unfinished reservations continue to occupy the budget. Records older
  // than the retention horizon are pruned and no longer consume it.
  const failureDb = injectedDb(['budget-failure'], { hourlyLimit: 1 });
  const failed = reserve(failureDb, {
    groupId: 'budget-failure', messageId: 'failure-1', nowMs: baseTime,
  });
  assert.equal(failed.ok, true);
  assert.equal(completeStickerDelivery(failed.reservationId, 'confirmed_failure', {
    db: failureDb, nowMs: baseTime + 1,
  }), true);
  const afterFailure = reserve(failureDb, {
    groupId: 'budget-failure', messageId: 'failure-2', stickerId: 'received', nowMs: baseTime + 2,
  });
  assert.equal(afterFailure.ok, true);

  const unknownDb = injectedDb(['budget-unknown'], { hourlyLimit: 1 });
  const unknown = reserve(unknownDb, {
    groupId: 'budget-unknown', messageId: 'unknown-1', nowMs: baseTime,
  });
  assert.equal(unknown.ok, true);
  assert.equal(completeStickerDelivery(unknown.reservationId, 'unknown', {
    db: unknownDb, nowMs: baseTime + 1,
  }), true);
  const afterUnknown = reserve(unknownDb, {
    groupId: 'budget-unknown', messageId: 'unknown-2', stickerId: 'received', nowMs: baseTime + 2,
  });
  assert.equal(afterUnknown.reason, 'hourly_limit');

  const acceptedDb = injectedDb(['budget-accepted'], { hourlyLimit: 1 });
  const accepted = reserve(acceptedDb, {
    groupId: 'budget-accepted', messageId: 'accepted-1', nowMs: baseTime,
  });
  assert.equal(accepted.ok, true);
  assert.equal(completeStickerDelivery(accepted.reservationId, 'accepted_unknown', {
    db: acceptedDb, nowMs: baseTime + 1,
  }), true);
  const afterAccepted = reserve(acceptedDb, {
    groupId: 'budget-accepted', messageId: 'accepted-2', stickerId: 'received', nowMs: baseTime + 2,
  });
  assert.equal(afterAccepted.reason, 'hourly_limit');

  const unfinishedDb = injectedDb(['budget-unfinished'], { hourlyLimit: 1 });
  const unfinished = reserve(unfinishedDb, {
    groupId: 'budget-unfinished', messageId: 'unfinished-1', nowMs: baseTime,
  });
  assert.equal(unfinished.ok, true);
  const afterUnfinished = reserve(unfinishedDb, {
    groupId: 'budget-unfinished', messageId: 'unfinished-2', stickerId: 'received', nowMs: baseTime + 1,
  });
  assert.equal(afterUnfinished.reason, 'hourly_limit');

  const expiredDb = injectedDb(['budget-expired'], { hourlyLimit: 1 });
  const expiredAt = baseTime;
  const expired = reserve(expiredDb, {
    groupId: 'budget-expired', messageId: 'expired-1', nowMs: expiredAt,
  });
  assert.equal(expired.ok, true);
  const afterExpiry = reserve(expiredDb, {
    groupId: 'budget-expired', messageId: 'expired-2', stickerId: 'received',
    nowMs: expiredAt + 8 * 24 * 60 * 60_000 + 1,
  });
  assert.equal(afterExpiry.ok, true);
  assert.equal(getStickerDeliveryState({ db: expiredDb }).records.some((record) => record.reservationId === expired.reservationId), false);
  assert.equal(getStickerDeliveryStats({ db: unknownDb, nowMs: baseTime + 2 }).activeRecords, 1);

  // The calibration denominator is a completed natural-reply decision, not
  // the whole QQ group and not only successful image sends. It must retain a
  // bounded per-group view so rollout frequency can be inspected safely.
  const metricsDb = injectedDb(['metrics-group']);
  recordStickerDecisionInDb(metricsDb, { mode: 'none', groupId: 'metrics-group' }, baseTime);
  recordStickerDecisionInDb(metricsDb, {
    mode: 'text_image', stickerId: 'hello', validSelection: true, groupId: 'metrics-group',
  }, baseTime + 1);
  recordStickerDecisionInDb(metricsDb, {
    mode: 'image_only', stickerId: 'received', validSelection: true, groupId: 'other-group',
  }, baseTime + 2);
  const metrics = getStickerDeliveryStats({ db: metricsDb, nowMs: baseTime + 3 });
  assert.equal(metrics.counters.eligibleReplies, 3);
  assert.equal(metrics.counters.modelProposals, 2);
  assert.equal(metrics.counters.byGroup['metrics-group'].eligibleReplies, 2);
  assert.equal(metrics.counters.byGroup['metrics-group'].modelProposals, 1);
  assert.equal(metrics.rates.proposalRate, 2 / 3);
  assert.equal(metrics.rates.allowedRate, 0);
  const metricReservation = reserve(metricsDb, {
    groupId: 'metrics-group', messageId: 'metrics-send', stickerId: 'thanks', nowMs: baseTime + 3,
  });
  assert.equal(metricReservation.ok, true);
  assert.equal(completeStickerDelivery(metricReservation.reservationId, 'confirmed_success', {
    db: metricsDb, nowMs: baseTime + 4,
  }), true);
  const metricsAfterSend = getStickerDeliveryStats({ db: metricsDb, nowMs: baseTime + 5 });
  assert.equal(metricsAfterSend.rates.allowedRate, 1 / 3);
  assert.equal(metricsAfterSend.rates.confirmedSuccessRate, 1 / 3);
  assert.equal(metricsAfterSend.recent24hByGroup['metrics-group'], 1);
  assert.equal(metricsAfterSend.recent24hBySticker.thanks, 1);
  assert.equal(metricsAfterSend.stickerOutcomes.thanks.confirmed_success, 1);

  // The production tracked proxy stores assigned objects by value. A reject
  // must therefore re-assign the normalized state after incrementing its
  // counters; mutating the detached local object alone loses the accounting.
  updateDb((db) => {
    db.settings.stickerPolicy = basePolicy(['proxy-group'], {
      groupCooldownSec: 60,
      duplicateStickerCooldownSec: 0,
    });
    db.stickerDeliveryState = undefined;
  });
  const proxyAllowed = reserveStickerDelivery({
    eventType: 'group', groupId: 'proxy-group', userId: 'proxy-user',
    messageId: 'proxy-1', stickerId: 'hello',
  }, { nowMs: baseTime });
  const proxyRejected = reserveStickerDelivery({
    eventType: 'group', groupId: 'proxy-group', userId: 'proxy-user',
    messageId: 'proxy-2', stickerId: 'received',
  }, { nowMs: baseTime + 1 });
  const proxyState = readDb().stickerDeliveryState;
  assert.equal(proxyAllowed.ok, true);
  assert.equal(proxyRejected.reason, 'cooldown');
  assert.equal(proxyState.counters.rejected.cooldown, 1);
  assert.equal(proxyState.counters.selected, 2);

  // 4. The allowlisted reservation target and final OneBot target must be the
  // same. The source group is deliberately different from the target group.
  const sourceGroupId = '712531032';
  const targetGroupId = '1083681153';
  assert.equal(sourceGroupId === targetGroupId, false);

  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 991 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 5. Persist a reservation, then start a separate Node process against the
  // same temp directory. This proves restart recovery from disk, not cloning.
  ensureStore();
  updateDb((db) => {
    db.settings.stickerPolicy = basePolicy(['disk-group'], {
      hourlyLimit: 5,
      duplicateStickerCooldownSec: 60,
    });
    db.stickerDeliveryState = undefined;
    db.settings.oneBotHttpUrl = `http://127.0.0.1:${port}`;
    db.settings.oneBotAccessToken = '';
  });
  const diskReservation = reserveStickerDelivery({
    eventType: 'group', groupId: 'disk-group', userId: 'disk-user',
    messageId: 'disk-message', stickerId: 'hello',
  }, { nowMs: Date.now() });
  assert.equal(diskReservation.ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'db.json')), true);

  const deliveryUrl = pathToFileURL(path.resolve('server/bot/stickers/delivery.ts')).href;
  const childEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' };
  for (const name of ENV_OVERRIDES) delete childEnv[name];
  const childCode = [
    `const { reserveStickerDelivery } = await import(${JSON.stringify(deliveryUrl)});`,
    "const result = reserveStickerDelivery({ eventType: 'group', groupId: 'disk-group', userId: 'disk-user', messageId: 'disk-message', stickerId: 'received' });",
    'console.log(JSON.stringify(result));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
    cwd: path.resolve('.'),
    env: childEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `restart child failed:\n${child.stdout}\n${child.stderr}`);
  const restoredResult = lastJsonLine(child.stdout);
  assert.equal(restoredResult.ok, false);
  assert.equal(restoredResult.reason, 'duplicate_turn');

  // Use the same disk-backed store for the target reservation and the final
  // send. This keeps the allowlist assertion on the actual production seam.
  updateDb((db) => {
    db.settings.stickerPolicy = basePolicy([targetGroupId], { hourlyLimit: 5 });
    db.stickerDeliveryState = undefined;
  });
  const targetReservation = reserveStickerDelivery({
    eventType: 'group', groupId: targetGroupId, userId: 'target-user',
    messageId: 'target-message', stickerId: 'hello',
  }, { nowMs: Date.now() });
  assert.equal(targetReservation.ok, true);

  // Final OneBot request uses the target event group, never the source group.
  const sent = await sendOneBotMessage({
    type: 'group', groupId: targetGroupId, userId: 'target-user', messageId: 'target-message',
  }, '[CQ:image,file=file:///tmp/sticker.png]');
  assert.equal(sent.outcome, 'confirmed_success');
  assert.equal(requestBody.group_id, Number(targetGroupId));
  assert.equal(completeStickerDelivery(targetReservation.reservationId, 'confirmed_success'), true);

  // An explicit all-group switch accepts an otherwise unlisted group, while
  // the event-type gate still rejects private messages.
  const allGroupsDb = injectedDb([], { allGroups: true });
  const allGroupsReservation = reserve(allGroupsDb, {
    groupId: 'previously-unlisted-group',
    userId: 'all-groups-user',
    messageId: 'all-groups-message',
    stickerId: 'hello',
    nowMs: 20_000,
  });
  assert.equal(allGroupsReservation.ok, true);
  const privateGate = reserveStickerDelivery({
    eventType: 'private',
    groupId: 'previously-unlisted-group',
    userId: 'all-groups-user',
    messageId: 'private-message',
    stickerId: 'hello',
  }, { db: allGroupsDb, nowMs: 20_001 });
  assert.equal(privateGate.reason, 'private');

  // 6. A policy/gate rejection and a confirmed send failure both preserve a
  // required reply for image_only. Unknown send outcomes deliberately do not
  // retry, since the first request may already have landed.
  assert.equal(ensureStickerReplyFallback('', ''), '收到。');
  assert.equal(ensureStickerReplyFallback('', '[CQ:image,file=x]'), '');
  assert.equal(stickerFailureFallback({ deliveredText: '', confirmedFailure: true, isLongReply: false }), '收到。');
  assert.equal(stickerFailureFallback({ deliveredText: '必要回复', confirmedFailure: true, isLongReply: false }), '必要回复');
  assert.equal(stickerFailureFallback({ deliveredText: '', confirmedFailure: false, isLongReply: false }), null);
  assert.equal(stickerFailureFallback({ deliveredText: '', confirmedFailure: true, isLongReply: true }), null);

  console.log(JSON.stringify({
    ok: true,
    duplicateWindow: 'A->B->A rejected',
    duplicateTurnScope: 'same messageId isolated by groupId',
    budget: 'confirmed_failure releases; unknown/accepted_unknown/reserved consume; expired pruned',
    targetGroup: requestBody.group_id,
    sourceGroup: sourceGroupId,
    allGroups: 'explicit switch accepts unlisted groups; private events remain rejected',
    restartRecovery: restoredResult.reason,
    imageOnlyFallback: 'gate rejection and confirmed failure retain fallback; unknown not retried',
  }, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  cleanupTestDir(dataDir);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
