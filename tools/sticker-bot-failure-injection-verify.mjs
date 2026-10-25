import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-sticker-bot-failure');
process.env.DATA_DIR = dataDir;
process.env.PIPPI_AGENT_RUNTIME_MODE = 'legacy';
assertNotProduction(dataDir);

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { stickerFailureNotice: stickerFailureNoticeForTest } = await import(
  '../server/bot/stickers/replyDelivery.ts?sticker-bot-failure-verify'
);
const { processIncoming } = await import('../server/bot.ts?sticker-bot-failure-verify');
const { getStickerDeliveryState, getStickerDeliveryStats } = await import(
  '../server/bot/stickers/delivery.ts?sticker-bot-failure-verify'
);

let llmRequests = 0;
let llmReplyEnvelope = { reply: '', mode: 'image_only', sticker_id: 'hello' };
let failureRewriteText = '这会儿发不了图，晚点再试。';
const failureRewriteRequests = [];
let timeoutServer;
let failureServer;
const llmServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    llmRequests += 1;
    const body = JSON.parse(raw || '{}');
    const stickerProtocolEnabled = body.response_format?.type === 'json_object';
    const failureRewrite = !stickerProtocolEnabled
      && body.messages?.some((message) => message.role === 'user' && String(message.content).startsWith('失败原因：'));
    if (failureRewrite) failureRewriteRequests.push(body.messages);
    const content = stickerProtocolEnabled ? JSON.stringify(llmReplyEnvelope)
      : failureRewrite ? failureRewriteText : '收到。';
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
  db.settings.osuSearchEnabled = false;
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

function event(groupId, messageId, mentioned = true, textOverride = '') {
  return {
    source: 'onebot',
    type: 'group',
    messageId,
    groupId,
    userId: '900000002',
    nickname: 'fixture-user',
    text: textOverride || (mentioned ? '[CQ:at,qq=900000001] 给个反应' : '自然接话失败测试'),
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

  // A long reply is delivered as a forward first. If only the optional sticker
  // send fails afterwards, the body must remain a successful reply and must be
  // written to history exactly once.
  llmReplyEnvelope = { reply: '这是一段已经送达的长回复正文。', mode: 'text_image', sticker_id: 'hello' };
  configurePolicy(['sticker-send-group']);
  const longSends = [];
  const longResult = await processIncoming(
    event('sticker-send-group', 'sticker-long-message', true, '写一篇长文，说明刚才的结果'),
    async (_event, text) => {
      const value = String(text || '');
      longSends.push(value);
      if (value.includes('[CQ:image')) {
        const error = new Error('fixture long-reply sticker failure');
        error.deliveryOutcome = 'confirmed_failure';
        throw error;
      }
      return { outcome: 'confirmed_success', messageId: 22 };
    },
  );
  assert.equal(longResult.replied, true);
  assert.equal(longSends.length, 2);
  assert.equal(longSends[0], 'Wuxin 回复');
  assert.equal(longSends[1].includes('[CQ:image'), true);
  const longHistory = readDb().messages.at(-1);
  assert.equal(longHistory.content, '这是一段已经送达的长回复正文。');
  assert.equal(longHistory.sticker?.outcome, 'confirmed_failure');
  llmReplyEnvelope = { reply: '', mode: 'image_only', sticker_id: 'hello' };

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

  // ── F1：附文不能被当成正文重发 ──
  // 混合任务（正经正文 + 配图短句）在组合发送确认失败时：独立正文完整保留、
  // 附文绝不能出现在回退里、明确索图要补一句实话。
  // 附文之所以进不了回退，是因为它只被拼进带图那条消息，从不进 deliveredText。
  llmReplyEnvelope = {
    reply: '先检查文件路径，再确认读取权限',
    sticker_caption: '给你这张',
    sticker_use: 'requested',
    mode: 'text_image',
    sticker_id: 'hello',
  };
  configurePolicy(['sticker-send-group']);
  const mixedSends = [];
  const mixedResult = await processIncoming(
    event('sticker-send-group', 'sticker-mixed-message'),
    async (_event, text) => {
      const value = String(text || '');
      mixedSends.push(value);
      if (value.includes('[CQ:image')) {
        const error = new Error('fixture mixed send confirmed failure');
        error.deliveryOutcome = 'confirmed_failure';
        throw error;
      }
      return { outcome: 'confirmed_success', messageId: 31 };
    },
  );
  assert.equal(mixedResult.replied, true);
  assert.equal(mixedSends.length, 2, '应当只有一次带图尝试和一次文字回退');
  assert.equal(mixedSends[0].includes('给你这张'), true, '成功路径上附文应随图出现');
  assert.equal(mixedSends[0].includes('先检查文件路径'), true, '带图消息应含独立正文');
  assert.equal(mixedSends[1].includes('给你这张'), false, '失败回退不得重发附文');
  assert.equal(mixedSends[1].includes('先检查文件路径'), true, '独立正文必须完整保留');
  assert.equal(mixedSends[1].includes('这张没发出去'), true, '明确索图失败要说清楚');

  // 可选配图（reaction）失败：正文保留，但不该反过来打扰用户。
  llmReplyEnvelope = {
    reply: '这段是正经回答',
    sticker_caption: '给你这张',
    sticker_use: 'reaction',
    mode: 'text_image',
    sticker_id: 'hello',
  };
  configurePolicy(['sticker-send-group']);
  const reactionSends = [];
  await processIncoming(
    event('sticker-send-group', 'sticker-reaction-message'),
    async (_event, text) => {
      const value = String(text || '');
      reactionSends.push(value);
      if (value.includes('[CQ:image')) {
        const error = new Error('fixture reaction sticker failure');
        error.deliveryOutcome = 'confirmed_failure';
        throw error;
      }
      return { outcome: 'confirmed_success', messageId: 32 };
    },
  );
  assert.equal(reactionSends.length, 2);
  assert.equal(reactionSends[1].includes('给你这张'), false, '可选配图失败也不得重发附文');
  assert.equal(reactionSends[1].includes('这段是正经回答'), true);
  assert.equal(reactionSends[1].includes('没发出去'), false, '自己加的图失败不该打扰用户');

  // 成功路径：附文必须跟着图片一起出现，否则它就成了永远发不出去的字段。
  llmReplyEnvelope = {
    reply: '好',
    sticker_caption: '给你这张',
    sticker_use: 'requested',
    mode: 'text_image',
    sticker_id: 'hello',
  };
  configurePolicy(['sticker-send-group']);
  const okSends = [];
  await processIncoming(
    event('sticker-send-group', 'sticker-caption-success-message'),
    async (_event, text) => {
      okSends.push(String(text || ''));
      return { outcome: 'confirmed_success', messageId: 33 };
    },
  );
  assert.equal(okSends.length, 1);
  assert.equal(okSends[0].includes('[CQ:image'), true);
  assert.equal(okSends[0].includes('给你这张'), true, '成功时附文必须随图发出');
  llmReplyEnvelope = { reply: '', mode: 'image_only', sticker_id: 'hello' };

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
// 失败提示本身要有断言，但断言不能把字符串写死 —— 那会把「提示带不带图」这种
// 表现细节变成契约。这里检验的是意图：提示发出去了，而且是 service_down 那张
// （gate=code 的状态图，走 withSticker 不经过 LLM）。其余断言不变：失败不得
// 触碰贴纸预算（records 为空、eligibleReplies 为 0）。
const FAILURE_NOTICE = '[系统] 这次查询或回复未能完成，请稍后重试。';
function assertFailureNotice(sends, label) {
  assert.equal(sends.length, 1, label + ' 应当只发一条');
  assert.ok(sends[0].startsWith(FAILURE_NOTICE), label + ' 首行应是失败提示，实际: ' + sends[0]);
  // 只断言「附的是 service_down 组里的图」，不断言具体文件名 ——
  // 那一组现在有 8 张差分，写死 pippi_service_down.png 会在拆组时误报。
  assert.ok(sends[0].includes('pippi_service_down'), label + ' 应当附 service_down 组的图，实际: ' + sends[0]);
}

  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert.equal(timeoutResult.replied, false);
  assertFailureNotice(timeoutSends, '超时兜底');
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
  assertFailureNotice(directFailureSends, '被 @ 时模型失败');

  const naturalFailureSends = [];
  const naturalFailureResult = await processIncoming(
    event('sticker-timeout-group', 'sticker-natural-failure-message', false),
    async (_event, text) => { naturalFailureSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 5 }; },
  );
  assert.equal(naturalFailureResult.replied, false);
  assert.deepEqual(naturalFailureSends, []);

  // ── F1 收尾：三条以前没被覆盖的路径 ──
  // 上面把 apiBaseUrl 指向了故意失败的服务器，这里先指回能正常作答的那个。
  updateDb((db) => { db.settings.apiBaseUrl = `http://127.0.0.1:${llmPort}/v1`; });

  // 上面 gateRejection 那条用的是旧信封（没有 sticker_use），意图被推断成 reaction，
  // 所以补「收到。」是对的。下面第一条是同一个位置、但信封明确写了 requested ——
  // 那时占位句不该出现，该说的是实话。
  llmReplyEnvelope = { reply: '', sticker_use: 'requested', mode: 'image_only', sticker_id: 'hello' };
  configurePolicy([]);
  const rejectedSends = [];
  await processIncoming(
    event('sticker-send-group', 'sticker-requested-rejected-message'),
    async (_event, text) => { rejectedSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 51 }; },
  );
  assert.equal(rejectedSends.length, 1, '明确要图但被策略拒绝：应当有且只有一条回退');
  assert.equal(failureRewriteRequests.length, 1, '策略拒绝后应调用模型改写失败说明');
  assert.ok(failureRewriteRequests[0].some((message) => String(message.content).includes('这个群没有开启表情包发送')),
    '改写请求必须包含实际拒绝原因');
  assert.equal(rejectedSends[0], failureRewriteText, '应发送模型改写的失败说明，而不是旧版固定话术');
  assert.equal(rejectedSends[0].includes('收到。'), false, '不该用一句「收到。」盖过没发出去这件事');
  assert.equal(rejectedSends[0].includes('[CQ:image'), false, '被拒绝时不该有图');

  // 没有可用改写时，固定失败说明仍必须兜底，不能退回「收到。」。
  failureRewriteText = '';
  configurePolicy([]);
  const emptyRewriteSends = [];
  await processIncoming(
    event('sticker-send-group', 'sticker-requested-empty-rewrite-message'),
    async (_event, text) => { emptyRewriteSends.push(String(text || '')); return { outcome: 'confirmed_success', messageId: 52 }; },
  );
  assert.ok(failureRewriteRequests.length > 1, '必须实际走过空改写路径');
  assert.deepEqual(emptyRewriteSends, ['这张没发出去']);
  failureRewriteText = '这会儿发不了图，晚点再试。';

  // 有图待发但发送确认失败：只能说一次，不能「收到。」和「这张没发出去」各来一句。
  llmReplyEnvelope = { reply: '', sticker_use: 'requested', mode: 'image_only', sticker_id: 'hello' };
  configurePolicy(['sticker-send-group']);
  const pureFailureSends = [];
  await processIncoming(
    event('sticker-send-group', 'sticker-pure-image-failure-message'),
    async (_event, text) => {
      pureFailureSends.push(String(text || ''));
      const error = new Error('fixture confirmed failure');
      error.deliveryOutcome = 'confirmed_failure';
      throw error;
    },
  );
  assert.equal(pureFailureSends.some((text) => text.includes('这张没发出去')), true,
    '纯图请求发送失败必须说明，实际: ' + JSON.stringify(pureFailureSends));
  assert.equal(pureFailureSends.some((text) => text.includes('收到。')), false,
    '不能说两句：既有占位句又有实话');

  // 长正文已交付、随后配图失败这一条路径，没有自动化用例。
  //
  // 原因是用例没法把 isLongReply 稳定置真：这条事件会走一次升级改写，改写结果会
  // 覆盖掉注入的正文，于是始终落回「正文与图同一条」的分支。硬凑会把用例变成在
  // 测改写通道，而不是在测收尾。
  //
  // 所以这里只锁住措辞契约（措辞定义了却没人调用，正是这个 bug 的形态），
  // 分支本身靠代码审查：bot.ts 长正文分支的内层 catch 里已经补了这条通知。
  assert.equal(stickerFailureNoticeForTest({ explicitRequest: true, bodyDelivered: true }), '表情那张没发出去',
    '正文已交付时的措辞必须是这一句');
  assert.equal(stickerFailureNoticeForTest({ explicitRequest: true, bodyDelivered: false }), '这张没发出去',
    '正文未交付时说的是另一句');
  assert.equal(stickerFailureNoticeForTest({ explicitRequest: false, bodyDelivered: false }), '',
    '自己加的图失败不该打扰用户');
  assert.ok(readFileSync(new URL('../server/bot.ts', import.meta.url), 'utf8')
    .includes("explicitRequest: stickerExplicitRequest, bodyDelivered: true"),
    'bot.ts 长正文分支必须调用这条通知 —— 缺了它这句文案就永远发不出去');

  console.log(JSON.stringify({
    ok: true,
    llmRequests,
    gateRejection: 'text fallback delivered',
    disabledMode: 'text fallback delivered; no reservation',
    captionDelivery: 'success send carries caption with the image',
    captionOnFailure: 'independent reply kept; caption never resent; explicit request gets the notice',
    captionOptionalFailure: 'own reaction failure stays silent',
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
