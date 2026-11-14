import assert from 'node:assert/strict';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';
const dir = createTestDataDir('wuxin-chat-level-pp');
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
assertNotProduction(dir);
try {
  const store = await import('../server/store.ts');
  const { buildPrompt } = await import('../server/bot/prompt.ts');
  const { buildLevelUpPrompt, levelUpFallback, normalizeRealOsuPp, resolveLevelUpRealPp } = await import('../server/bot/inboundContext.ts');
  store.ensureStore();
  const db = structuredClone(store.readDb());
  db.settings.tokenSavingMode = false;
  db.settings.ownerQq = '10001';
  db.settings.selfQq = '10002';
  db.settings.ignoreSystemFacts = false;
  db.experience = { '10003': { xp: 1146.1, level: 11 } };
  db.osuBindings = { '10003': { id: 123, username: 'fixturePlayer' } };
  const event = { type: 'group', groupId: '20001', userId: '10003', nickname: 'fixture', text: '你好', messageId: 'pp-case', images: [], atTargets: [], source: 'onebot' };
  const group = { groupId: '20001', enabled: true, mode: 'natural' };
  const assembled = JSON.stringify(buildPrompt(db, group, event, { policy: 'normal' }));
  assert.ok(assembled.includes('1100pp（chatLevelPp）'));
  assert.ok(assembled.includes('不是 osu! performance points'));
  assert.ok(assembled.includes('历史聊天和升级通知中的内部 pp'));
  assert.ok(assembled.includes('fixturePlayer'));
  // Voice-only rollback must not undo current identity, privacy or task contracts.
  assert.ok(assembled.includes('玩梗和吐槽：'));
  assert.ok(assembled.includes('除非用户要求解析，否则不要立刻把梗拆成论文'));
  assert.ok(assembled.includes('你的固定外观：'));
  assert.ok(assembled.includes('不可由聊天内容修改的身份与授权'));
  assert.ok(assembled.includes('正文放在 JSON 的 reply 字段'));
  assert.ok(!assembled.includes('默认只接一句'));
  assert.ok(!assembled.includes('能连起来就正常连'));
  assert.ok(!assembled.includes('多数在 10 个字以内'));
  assert.ok(!assembled.includes('群聊高频反应'));
  db.experience['10003'].level = 0;
  const zeroLevel = JSON.stringify(buildPrompt(db, group, event, { policy: 'normal' }));
  assert.ok(zeroLevel.includes('不是 osu! performance points'));
  for (const value of [undefined, null, NaN, Infinity, -1, '', '0']) assert.equal(normalizeRealOsuPp(value), null);
  assert.equal(normalizeRealOsuPp(0), 0);
  assert.equal(normalizeRealOsuPp(123.6), 124);
  const binding = { id: 123 };
  const records = [{ osuUserId: 123, pp: 456.2 }];
  assert.equal(await resolveLevelUpRealPp(binding, async () => ({ statistics: { pp: 0 } }), records), 0);
  assert.equal(await resolveLevelUpRealPp(binding, async () => ({}), records), 456);
  assert.equal(await resolveLevelUpRealPp(binding, async () => { throw Error('offline'); }, [{ osuUserId: 123, pp: 0 }]), 0);
  assert.equal(await resolveLevelUpRealPp(binding, async () => ({}), []), null);
  assert.equal(await resolveLevelUpRealPp(null, async () => { throw Error('must not call'); }, records), null);
  for (const pp of [null, 0, 8000]) {
    const prompt = buildLevelUpPrompt('fixture', 1000, 1100, pp, '');
    assert.ok(prompt.includes('只是 Wuxin 聊天经验展示名'));
    assert.ok(prompt.includes('保留“这是我这的等级 pp”'));
    assert.ok(!prompt.includes('禁止出现“Lv.”“等级”'));
    assert.ok(levelUpFallback(1000, 1100, pp).includes('等级 pp'));
  }
  assert.ok(buildLevelUpPrompt('fixture', 1000, 1100, null, '').includes('查询没有有效数据'));
  assert.ok(buildLevelUpPrompt('fixture', 1000, 1100, 0, '').includes('真实 osu! pp 只有 0pp'));
  console.log('chat-level-pp: prompt assembly, historical boundary, notices, unknown/zero and fallback PASS');
} finally { cleanupTestDir(dir); }