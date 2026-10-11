import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_GROUP_ID = '1083681153';
const BOT_QQ = '3312171148';
const SOURCE_GROUPS = ['682910196', '712531032', '885215108'];
const sampleLimit = Math.max(1, Number(process.env.SHADOW_SAMPLE_LIMIT || 6));
const timeoutMs = Math.max(10_000, Math.min(60_000, Number(process.env.SHADOW_TIMEOUT_MS || 45_000)));
const selectedIndices = String(process.env.SHADOW_INDICES || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const outputPath = path.resolve(
  process.env.SHADOW_OUTPUT
    || path.join('docs', 'sticker-release', 'evidence', `real-history-shadow-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`),
);

if (SOURCE_GROUPS.includes(TEST_GROUP_ID)) {
  throw new Error('安全检查失败：测试群不能出现在来源群列表中');
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wuxin-sticker-shadow-'));
const productionDir = path.resolve(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
  'Wuxin',
);
for (const entry of await fs.readdir(productionDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^db(?:-[\w-]+)?\.json$/u.test(entry.name)) continue;
  await fs.copyFile(path.join(productionDir, entry.name), path.join(tempDir, entry.name));
}
const productionKnowledgeDir = path.join(productionDir, 'knowledge');
try {
  await fs.cp(productionKnowledgeDir, path.join(tempDir, 'knowledge'), { recursive: true });
} catch {
  // Shadow remains usable with the normal KB fail-closed behavior when the
  // optional production knowledge snapshot is unavailable.
}

// This is deliberately a disposable copy. The actual sender callback below
// only records what the pipeline would send; no OneBot endpoint is involved.
process.env.DATA_DIR = tempDir;
process.env.WUXIN_STICKER_DELIVERY_MODE = 'dry-run';
process.env.WUXIN_STICKER_LIVE_GROUP_IDS = TEST_GROUP_ID;

const { readDb, updateDb } = await import('../server/store.ts');
const { processIncomingAdmitted } = await import('../server/bot.ts');
const { clearStickerDebugTraces, listStickerDebugTraces, setStickerDebugMode } = await import('../server/bot/stickers/debug.ts');

updateDb((draft) => {
  draft.settings.codexTimeoutMs = timeoutMs;
  draft.settings.codexFallbackEnabled = false;
});
setStickerDebugMode('dry-run', { groupId: TEST_GROUP_ID });

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
  return index < 0 ? null : { message: messages[index], index };
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function traceSelection(messageId) {
  const trace = listStickerDebugTraces(10).find((item) => item.messageId === messageId);
  if (!trace) return { traceFound: false, stickerId: null, dryRun: false };
  const selected = trace.events.find((event) => event.stage === 'model_selected')?.data?.stickerId
    || trace.events.find((event) => event.stage === 'finished')?.data?.wouldSend
    || null;
  return {
    traceFound: true,
    traceStatus: trace.status,
    stickerId: selected ? String(selected) : null,
    dryRun: trace.status === 'dry_run',
  };
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
  .filter((_, index) => selectedIndices.length === 0 || selectedIndices.includes(index))
  .map(([groupId, fragment]) => findSample(groupId, fragment))
  .filter(Boolean)
  .slice(0, sampleLimit);

const baseMessages = messages.filter((message) => String(message.groupId) !== TEST_GROUP_ID);
const results = [];

for (const [sampleIndex, sample] of samples.entries()) {
  const source = sample.message;
  const inputText = String(source.content || '');
  const sourceGroupId = String(source.groupId);
  const sourceContext = messages
    .slice(Math.max(0, sample.index - 12), sample.index)
    .filter((message) => String(message.groupId) === sourceGroupId)
    .map((message, contextIndex) => ({
      ...message,
      id: `shadow-context-${sampleIndex}-${contextIndex}`,
      groupId: TEST_GROUP_ID,
      sourceMessageId: undefined,
      inContext: true,
    }));
  updateDb((draft) => {
    draft.messages = [...baseMessages, ...sourceContext];
    draft.decisions = (draft.decisions || []).filter((decision) => String(decision.groupId) !== TEST_GROUP_ID);
    draft.pendingLevelUps = {};
  });
  clearStickerDebugTraces();

  const event = {
    source: 'onebot',
    type: 'group',
    messageId: `real-history-shadow-${sampleIndex}-${Date.now()}`,
    groupId: TEST_GROUP_ID,
    userId: String(source.userId || `shadow-user-${sampleIndex}`),
    nickname: String(source.nickname || source.userId || '历史消息用户'),
    text: `[CQ:at,qq=${BOT_QQ}] ${inputText.replace(/^\[CQ:at,[^\]]+\]\s*/u, '')}`,
    atTargets: [BOT_QQ],
    senderRole: 'member',
  };
  const sent = [];
  const started = Date.now();
  try {
    const result = await processIncomingAdmitted(
      event,
      async (_event, text) => {
        sent.push({
          hasImageCq: /\[CQ:image,/iu.test(String(text || '')),
          textLength: String(text || '').length,
        });
      },
      { shouldReply: true, reason: 'real-history-shadow' },
    );
    const selection = traceSelection(event.messageId);
    results.push({
      sampleIndex,
      sourceGroupId,
      inputHash: shortHash(inputText),
      inputLength: inputText.length,
      elapsedMs: Date.now() - started,
      replied: Boolean(result?.replied),
      proposedStickerId: selection.stickerId,
      traceFound: selection.traceFound,
      traceStatus: selection.traceStatus || null,
      dryRun: selection.dryRun,
      senderCallCount: sent.length,
      senderImageCount: sent.filter((item) => item.hasImageCq).length,
      textLengths: sent.map((item) => item.textLength),
    });
  } catch (error) {
    const selection = traceSelection(event.messageId);
    results.push({
      sampleIndex,
      sourceGroupId,
      inputHash: shortHash(inputText),
      inputLength: inputText.length,
      elapsedMs: Date.now() - started,
      replied: false,
      proposedStickerId: selection.stickerId,
      traceFound: selection.traceFound,
      traceStatus: selection.traceStatus || null,
      dryRun: selection.dryRun,
      senderCallCount: sent.length,
      senderImageCount: sent.filter((item) => item.hasImageCq).length,
      error: String(error?.message || error).replace(/\s+/gu, ' ').slice(0, 500),
    });
  }
  process.stdout.write(`${results.at(-1).replied ? 'PASS' : 'FAIL'} shadow-${sampleIndex} ${selectionForProgress(results.at(-1))}\n`);
}

function selectionForProgress(result) {
  return `${result.proposedStickerId || 'none'} ${result.elapsedMs}ms`;
}

const proposed = results.filter((result) => result.proposedStickerId);
const summary = {
  ok: results.length > 0 && results.every((result) => result.replied && result.senderImageCount === 0),
  mode: 'dry-run',
  destinationGroupId: TEST_GROUP_ID,
  sourceGroups: SOURCE_GROUPS,
  sampleCount: results.length,
  repliedCount: results.filter((result) => result.replied).length,
  proposalCount: proposed.length,
  proposalRate: results.length ? Number((proposed.length / results.length).toFixed(3)) : 0,
  senderImageCount: results.reduce((sum, result) => sum + result.senderImageCount, 0),
  timeoutMs,
  results,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...summary, evidencePath: outputPath }, null, 2));
if (!summary.ok) process.exitCode = 2;
