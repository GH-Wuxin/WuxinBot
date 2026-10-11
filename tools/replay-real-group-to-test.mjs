import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_GROUP_ID = '1083681153';
const BOT_QQ = '3312171148';
const SOURCE_GROUPS = ['682910196', '712531032', '885215108'];

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-replay-'));
const productionDir = path.resolve(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
  'Wuxin',
);
for (const entry of await fs.readdir(productionDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^db(?:-[\w-]+)?\.json$/u.test(entry.name)) continue;
  await fs.copyFile(path.join(productionDir, entry.name), path.join(tempDir, entry.name));
}
process.env.DATA_DIR = tempDir;
process.env.WUXIN_STICKER_DELIVERY_MODE = 'live';
process.env.WUXIN_STICKER_LIVE_GROUP_IDS = TEST_GROUP_ID;

const { readDb, updateDb } = await import('../server/store.ts');
const { processIncomingAdmitted } = await import('../server/bot.ts');

const replayTimeoutMs = Math.max(10_000, Number(process.env.REPLAY_TIMEOUT_MS || 30_000));
const replaySampleLimit = Math.max(1, Number(process.env.REPLAY_SAMPLE_LIMIT || 3));
updateDb((draft) => {
  draft.settings.codexTimeoutMs = replayTimeoutMs;
});

const db = readDb();
const messages = Array.isArray(db.messages) ? db.messages : [];

function isUsableSourceMessage(message) {
  const text = String(message?.content || '').trim();
  return SOURCE_GROUPS.includes(String(message?.groupId || ''))
    && message?.role === 'user'
    && text
    && !text.includes('[图片]')
    && !/\[CQ:image,/iu.test(text)
    && !/^(?:\/w|\/wuxin|[!！~]|查\s*@|！?ba\b|！?bs\b)/iu.test(text)
    && text.length <= 280;
}

function findSample(groupId, fragment) {
  const index = messages.findIndex((message) =>
    String(message.groupId) === groupId
    && isUsableSourceMessage(message)
    && String(message.content || '').includes(fragment));
  if (index < 0) return null;
  return { message: messages[index], index };
}

const requestedSamples = [
  ['712531032', '我悟了'],
  ['712531032', '哦耶哦耶下班了下班了'],
  ['682910196', '今晚5k'],
  ['682910196', '偷摸mp'],
  ['885215108', '原来如此'],
  ['885215108', '我还真没研究过'],
];
const samples = requestedSamples
  .map(([groupId, fragment]) => findSample(groupId, fragment))
  .filter(Boolean)
  .slice(0, replaySampleLimit);

const baseMessages = messages.filter((message) => String(message.groupId) !== TEST_GROUP_ID);
const results = [];

for (const [sampleIndex, sample] of samples.entries()) {
  const source = sample.message;
  const sourceGroupId = String(source.groupId);
  const sourceContext = messages
    .slice(Math.max(0, sample.index - 12), sample.index)
    .filter((message) => String(message.groupId) === sourceGroupId)
    .map((message, contextIndex) => ({
      ...message,
      id: `replay-context-${sampleIndex}-${contextIndex}`,
      groupId: TEST_GROUP_ID,
      sourceMessageId: undefined,
      inContext: true,
    }));
  updateDb((draft) => {
    draft.messages = [...baseMessages, ...sourceContext];
    draft.decisions = (draft.decisions || []).filter((decision) => String(decision.groupId) !== TEST_GROUP_ID);
    draft.pendingLevelUps = {};
  });

  const sent = [];
  const event = {
    source: 'onebot',
    type: 'group',
    messageId: `real-history-replay-${sampleIndex}-${Date.now()}`,
    groupId: TEST_GROUP_ID,
    userId: String(source.userId || `replay-user-${sampleIndex}`),
    nickname: String(source.nickname || source.userId || '历史消息用户'),
    text: `[CQ:at,qq=${BOT_QQ}] ${String(source.content || '').replace(/^\[CQ:at,[^\]]+\]\s*/u, '')}`,
    atTargets: [BOT_QQ],
    senderRole: 'member',
  };
  const startedAt = Date.now();
  try {
    const result = await processIncomingAdmitted(
      event,
      async (_event, text, options = {}) => {
        sent.push({
          text: String(text || ''),
          hasImageCq: /\[CQ:image,/iu.test(String(text || '')),
          isForward: Boolean(options.forwardNodes?.length),
          at: Date.now(),
        });
      },
      { shouldReply: true, reason: 'real-history-replay' },
    );
    results.push({
      sampleIndex,
      sourceGroupId,
      sourceUser: event.nickname,
      input: event.text.replace(`[CQ:at,qq=${BOT_QQ}] `, ''),
      elapsedMs: Date.now() - startedAt,
      replied: Boolean(result?.replied),
      reason: result?.reason || '',
      stickerIds: result?.stickers || [],
      sentCount: sent.length,
      sent: sent.map((item) => ({
        hasImageCq: item.hasImageCq,
        isForward: item.isForward,
        text: item.text.slice(0, 360),
      })),
    });
  } catch (error) {
    results.push({
      sampleIndex,
      sourceGroupId,
      sourceUser: event.nickname,
      input: event.text.replace(`[CQ:at,qq=${BOT_QQ}] `, ''),
      elapsedMs: Date.now() - startedAt,
      replied: false,
      error: String(error?.message || error).slice(0, 500),
      sentCount: sent.length,
      sent: sent.map((item) => ({
        hasImageCq: item.hasImageCq,
        isForward: item.isForward,
        text: item.text.slice(0, 360),
      })),
    });
  }
}

const replied = results.filter((item) => item.replied);
const stickerReplies = results.filter((item) => item.stickerIds?.length || item.sent?.some((entry) => entry.hasImageCq));
console.log(JSON.stringify({
  ok: true,
  tempDataDir: tempDir,
  sourceGroups: SOURCE_GROUPS,
  sampleCount: results.length,
  repliedCount: replied.length,
  stickerReplyCount: stickerReplies.length,
  stickerReplyRate: results.length ? Number((stickerReplies.length / results.length).toFixed(3)) : 0,
  results,
}, null, 2));

