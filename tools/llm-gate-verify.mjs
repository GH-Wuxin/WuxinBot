import assert from 'node:assert/strict';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const directory = createTestDataDir('wuxin-admission');
process.env.DATA_DIR = directory; process.env.NODE_ENV = 'test';
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { decideReply } = await import('../server/bot.ts');
try {
  ensureStore(); updateDb(db => {
    db.settings.socialV2Enabled = true; db.settings.globalPaused = false;
    db.settings.ownerQq = 'owner';
    db.groups = [{ groupId: 'room', name: 'fixture', enabled: true, mode: 'natural', maxPerHour: 20, cooldownSec: 0 }];
    db.messages = []; db.decisions = [];
  });
  const base = () => ({ db: readDb(), group: readDb().groups[0], userId: 'member', userPolicy: { policy: 'normal' }, mentioned: false });
  for (const mode of ['light', 'natural']) for (const text of ['嗯', '为什么', '卡了三天终于过了', '哈哈'.repeat(30)]) {
    const result = await decideReply({ ...base(), group: { ...base().group, mode }, text });
    assert.equal(result.pendingAssessment, true, `${mode}: ${text}`);
    assert.equal(result.shouldReply, false, 'preview cannot invent a semantic verdict');
  }
  const direct = await decideReply({ ...base(), mentioned: true, text: 'Pippi 你好' });
  assert.equal(direct.shouldReply, true);
  updateDb(db => { db.groups[0].cooldownSec = 30; db.decisions.push({ id: 'attempt', groupId: 'room', shouldReply: true, createdAt: new Date().toISOString() }); });
  const cooling = await decideReply({ ...base(), text: '新的话题' });
  assert.equal(cooling.shouldReply, false); assert.match(cooling.reason, /冷却/);
  updateDb(db => { db.groups[0].mode = 'mention'; });
  assert.equal((await decideReply({ ...base(), text: '普通闲聊' })).pendingAssessment, undefined);
  console.log('PASS admission preview: no semantic score, direct requests and failed-send cooldown preserved');
} finally { cleanupTestDir(directory); }
