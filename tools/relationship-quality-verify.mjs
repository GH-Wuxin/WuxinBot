import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-relationship-quality-'));
process.env.DATA_DIR = tmpDir;

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const {
  isSubstantiveRelationshipProfile,
  updateRelationshipProfile,
} = await import('../server/bot/relationshipProfile.ts');

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function msg(id, userId, content, minutesAgo) {
  return {
    id,
    role: 'user',
    type: 'group',
    groupId: 'g1',
    userId,
    nickname: `u${userId}`,
    content,
    inContext: true,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

try {
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'owner';
    db.settings.selfQq = 'bot';
    db.groups = [{ groupId: 'g1', name: '关系质量测试群', enabled: true, mode: 'natural' }];
    db.relationshipProfiles = [];
    db.messages = [
      msg('a1', '1001', '今天装备怎么配', 120),
      msg('a2', '1001', '我去跑一把', 110),
      msg('x1', '3001', '路过', 100),
      msg('b1', '1002', '这个地图收益还行', 90),
      msg('b2', '1002', '我先吃饭', 80),
    ];
  });

  assert(!isSubstantiveRelationshipProfile({
    interactionStyle: '无明显模式',
    commonTopics: '信息不足',
    tone: '',
    botStrategy: '',
    boundaries: '',
    confidence: 0.4,
    evidenceCount: 30,
  }), 'empty relationship profile should not be substantive');

  assert(!isSubstantiveRelationshipProfile({
    interactionStyle: '单方面输出，用户A未参与回应',
    commonTopics: 'CS2游戏技巧、训练心得、自我吐槽',
    tone: '认真指导与自我评价交替',
    botStrategy: '可承接游戏话题提出建议',
    boundaries: '不要放大自我吐槽情绪',
    confidence: 0.4,
    evidenceCount: 73,
  }), 'one-sided relationship profile should not be substantive');

  assert(isSubstantiveRelationshipProfile({
    interactionStyle: '经常围绕游戏装备互相接话',
    commonTopics: '暗区突围装备、收益、地图选择',
    tone: '轻松直接，偶尔吐槽',
    botStrategy: '只在他们明确问到配置或战术时补充一句',
    boundaries: '不要站队或放大争执',
    confidence: 0.62,
    evidenceCount: 12,
  }), 'real interaction profile should be substantive');

  const skipped = await updateRelationshipProfile(readDb(), 'g1', '1001', '1002');
  assert(skipped.ok === true && skipped.skipped === true, 'non-interacting pair should be skipped without LLM');
  assert((readDb().relationshipProfiles || []).length === 0, 'skipped relationship should not be saved');

  console.log('PASS: relationship quality gate verification');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
