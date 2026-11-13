import assert from 'node:assert/strict';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const dir = createTestDataDir('wuxin-conversation-preparation');
process.env.DATA_DIR = dir;
try {
  const { conversationGuidance } = await import('../server/bot/conversationPreparation.ts');
  const modelFirst = conversationGuidance({
    modelFirstRuntime: true,
    osuSearchEnabled: true,
    hasBotTools: true,
    requiredCapability: 'profile',
  });
  assert.ok(modelFirst.includes('【Agent 行动约定】'), 'model-first keeps the autonomy guidance');
  assert.ok(modelFirst.includes('取证'), 'model-first still requires evidence');
  assert.equal(modelFirst.includes('可用查询类型：profile'), false, 'model-first does not narrow to the legacy capability list');

  const legacy = conversationGuidance({
    modelFirstRuntime: false,
    osuSearchEnabled: false,
    hasBotTools: true,
    requiredCapability: 'profile',
  });
  assert.ok(legacy.includes('可用查询类型：profile'), 'legacy required capability narrows the exposed list');
  assert.ok(legacy.includes('query_osu'), 'legacy keeps the query_osu contract');

  const legacyAll = conversationGuidance({
    modelFirstRuntime: false,
    osuSearchEnabled: false,
    hasBotTools: true,
  });
  assert.ok(legacyAll.includes('可用查询类型：'), 'legacy without a required capability advertises the catalog');

  const empty = conversationGuidance({
    modelFirstRuntime: false,
    osuSearchEnabled: false,
    hasBotTools: false,
  });
  assert.equal(empty, '', 'no tools and no search produces no guidance block');
  console.log('conversation preparation: model-first/legacy guidance and empty-tool behavior PASS');
} finally {
  cleanupTestDir(dir);
}
