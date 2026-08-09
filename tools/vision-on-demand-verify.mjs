import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-vision-demand-'));
process.env.DATA_DIR = tmpDir;

const { ensureStore, updateDb } = await import('../server/store.ts');
const { asksToInspectVisual, looksLikeVisualFollowup } = await import('../server/bot/cleaning.ts');
const { maybeRecordImageMemorySummary } = await import('../server/bot/memory.ts');

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

try {
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'owner';
    db.settings.selfQq = 'bot';
    db.settings.memoryEnabled = true;
    db.settings.visionMemoryEnabled = true;
    db.settings.visionMode = 'on';
    db.settings.llmProvider = 'openai-compatible';
    db.settings.apiBaseUrl = 'https://example.invalid/v1';
    db.settings.model = 'mimo-v2.5';
    db.groups = [{ groupId: 'g1', name: '按需看图测试群', enabled: true, mode: 'mention' }];
    db.usageEvents = [{
      id: 'u1',
      groupId: 'g1',
      userId: 'u1',
      model: 'mimo-v2.5',
      kind: 'image-memory-summary',
      totalTokens: 100,
      promptTokens: 50,
      completionTokens: 50,
      createdAt: new Date().toISOString(),
    }];
  });

  assert(asksToInspectVisual('[CQ:at,qq=bot] 查看这个图片'), '查看这个图片 should be recognized as visual request');
  assert(asksToInspectVisual('[CQ:at,qq=bot] 分析一下这张图'), '分析这张图 should be recognized as visual request');
  assert(looksLikeVisualFollowup('[CQ:at,qq=bot] 现在看'), '现在看 should be recognized as visual follow-up');
  assert(looksLikeVisualFollowup('[CQ:at,qq=bot] 能看的出来吗'), '能看出来吗 should be recognized as visual follow-up');

  const skipped = await maybeRecordImageMemorySummary({
    type: 'group',
    groupId: 'g1',
    userId: 'u1',
    nickname: '用户1',
    messageId: 'm1',
    text: '[图片]',
    atTargets: [],
    images: [{ type: 'image', url: 'https://example.invalid/a.jpg', file: 'a.jpg' }],
    createdAt: new Date().toISOString(),
  }, { policy: 'priority', attentionLevel: 5, allowCommands: false });

  assert(skipped.ok === false, 'pure image summary should respect cooldown');
  assert(/冷却|上限/.test(skipped.reason), 'skip reason should mention cooldown or limit');

  console.log('PASS: vision on-demand intent and image-memory budget verification');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
