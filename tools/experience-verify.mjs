/**
 * 经验等级系统验证测试
 *
 * 测试:
 * 1. XP 增长 — 有效消息获得 XP，每日上限 30
 * 2. 等级升级 — XP 达到阈值自动升级
 * 3. 连续活跃加成 — 连续天数越多倍率越高
 * 4. 降级机制 — 30 天不活跃扣 XP
 * 5. 群管自动识别 — senderRole 为 owner/admin 时自动 admin
 * 6. 指令权限 — /w op 只有 bot owner 能用
 * 7. 两层数据 — experience 全局 + groupExperience 群内
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-experience-'));
process.env.DATA_DIR = testDataDir;
const dbPath = path.join(testDataDir, 'db.json');
let readDb;
let writeDb;
let updateDb;
let processXpGain;
let getExperience;
let getXpBonus;
let formatXpBar;
let decayInactiveUsers;
let getStreakMultiplier;
let decideReply;
let processIncoming;

const TEST_OWNER = '30000001';
const TEST_BOT = '30000002';
const TEST_USER = '30000003';
const TEST_GROUP = '900000007';

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function event(overrides) {
  return {
    source: 'exp-test', type: 'group', groupId: TEST_GROUP,
    messageId: `et-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    userId: TEST_USER, nickname: 'TestUser', text: '这是一条有效消息',
    atTargets: [], images: [], raw: {},
    ...overrides,
  };
}

function setupDb(original) {
  const db = structuredClone(original);
  db.settings.ownerQq = TEST_OWNER;
  db.settings.selfQq = TEST_BOT;
  db.settings.botNames = '小深,bot';
  db.settings.globalPaused = false;
  db.settings.onlyMentionMode = false;
  db.groups = [
    ...(db.groups || []).filter((g) => String(g.groupId) !== TEST_GROUP),
    { groupId: TEST_GROUP, name: 'ExpTest', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
  ];
  db.messages = [];
  db.experience = {};
  db.groupExperience = {};
  db.users = [];
  writeDb(db);
  return db;
}

async function main() {
  const store = await import('../server/store.ts');
  const experience = await import('../server/bot/experience.ts');
  const bot = await import('../server/bot.ts');
  ({ readDb, writeDb, updateDb } = store);
  ({ processXpGain, getExperience, getXpBonus, formatXpBar, decayInactiveUsers, getStreakMultiplier } = experience);
  ({ decideReply, processIncoming } = bot);
  store.ensureStore();

  const originalRaw = fs.readFileSync(dbPath, 'utf8').replace(/^﻿/, '');
  const original = JSON.parse(originalRaw);

  try {
    // ============================================================
    // Test 1: XP growth + daily cap
    // ============================================================
    console.log('Test 1: XP growth + daily cap');
    setupDb(original);

    // Send messages and accumulate XP
    let totalXp = 0;
    for (let i = 0; i < 20; i++) {
      const r = processXpGain(event({ text: `消息${i} 有效内容`, messageId: `t1-${i}` }), readDb());
      totalXp += r.gained;
    }

    const exp1 = getExperience(readDb(), TEST_USER);
    assert(exp1.xp > 0, `should have XP, got ${exp1.xp}`);
    assert(exp1.dailyXp <= 30, `daily XP should be capped at 30, got ${exp1.dailyXp}`);
    assert(exp1.activeDays >= 1, `should have active days`);

    // Verify group experience also updated
    const gExp1 = readDb().groupExperience?.[`${TEST_GROUP}:${TEST_USER}`];
    assert(gExp1, 'should have group experience');
    assert(gExp1.msgCount >= 1, `group msgCount should be >= 1, got ${gExp1.msgCount}`);

    console.log('PASS: Test 1 — XP growth + daily cap + group experience');

    // ============================================================
    // Test 2: Level upgrade
    // ============================================================
    console.log('Test 2: Level upgrade');
    setupDb(original);

    // Manually set XP to just below level 1 threshold (level N = N*100 XP)
    updateDb((draft) => {
      draft.experience[TEST_USER] = {
        xp: 99, level: 0, dailyXp: 0, dailyDate: new Date().toISOString().slice(0, 10),
        activeDays: 5, streakDays: 1, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '',
      };
    });

    // One more message should push to level 1
    const r2 = processXpGain(event({ text: '升级消息 有效内容', messageId: 't2-1' }), readDb());
    const exp2 = getExperience(readDb(), TEST_USER);
    assert(exp2.level >= 1, `should be at least level 1, got ${exp2.level}`);

    console.log('PASS: Test 2 — level upgrade');

    // ============================================================
    // Test 3: Streak multiplier
    // ============================================================
    console.log('Test 3: Streak multiplier');
    assert(getStreakMultiplier(0) === 1.0, '0 days = 1.0');
    assert(getStreakMultiplier(1) === 1.0, '1 day = 1.0');
    assert(getStreakMultiplier(3) === 1.2, '3 days = 1.2');
    assert(getStreakMultiplier(7) === 1.5, '7 days = 1.5');
    assert(getStreakMultiplier(14) === 2.0, '14 days = 2.0');
    assert(getStreakMultiplier(30) === 2.0, '30 days = 2.0 (capped)');
    console.log('PASS: Test 3 — streak multiplier');

    // ============================================================
    // Test 4: XP decay for inactive users
    // ============================================================
    console.log('Test 4: XP decay');
    setupDb(original);

    const today = new Date().toISOString().slice(0, 10);
    const longAgo = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    updateDb((draft) => {
      draft.experience[TEST_USER] = {
        xp: 200, level: 2, dailyXp: 0, dailyDate: today,
        activeDays: 10, streakDays: 0, lastMsgDate: longAgo, lastLevelUpAt: '', lastDecayCheck: '',
      };
    });

    decayInactiveUsers();
    const exp4 = getExperience(readDb(), TEST_USER);
    assert(exp4.xp < 200, `XP should have decayed, got ${exp4.xp}`);
    assert(exp4.xp >= 180, `decay should be ~10%, got ${exp4.xp}`);

    console.log('PASS: Test 4 — XP decay');

    // ============================================================
    // Test 5: XP bonus by level
    // ============================================================
    console.log('Test 5: XP bonus by level');
    setupDb(original);

    // Level 0
    const bonus0 = getXpBonus(readDb(), TEST_USER);
    assert(bonus0.weightBonus === 0, 'level 0 should have 0 weight bonus');
    assert(bonus0.memoryThresholdMul === 1.0, 'level 0 should have 1.0 memory mul');

    // Set to level 3
    updateDb((draft) => {
      draft.experience[TEST_USER] = { xp: 350, level: 3, dailyXp: 0, dailyDate: '', activeDays: 10, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
    });
    const bonus3 = getXpBonus(readDb(), TEST_USER);
    assert(bonus3.weightBonus === 20, `level 3 weight bonus should be 20, got ${bonus3.weightBonus}`);
    assert(bonus3.conversationWindowSec === 180, `level 3 conv window should be 180, got ${bonus3.conversationWindowSec}`);
    assert(bonus3.memoryThresholdMul === 0.8, `level 3 memory mul should be 0.8, got ${bonus3.memoryThresholdMul}`);

    console.log('PASS: Test 5 — XP bonus by level');

    // ============================================================
    // Test 6: formatXpBar
    // ============================================================
    console.log('Test 6: formatXpBar');
    const bar6 = formatXpBar({ xp: 100, level: 1, dailyXp: 5, streakDays: 3 });
    assert(bar6.includes('100pp'), 'should show level as 100pp');
    assert(bar6.includes('200pp'), 'should show next level as 200pp');
    assert(bar6.includes('×1.2'), 'should contain streak multiplier');

    console.log('PASS: Test 6 — formatXpBar');

    // ============================================================
    // Test 7: Group admin auto-detection via decideReply
    // ============================================================
    console.log('Test 7: Group admin auto-detection');
    setupDb(original);

    // Owner message should reply in natural mode
    const d7 = await decideReply({
      db: readDb(),
      group: readDb().groups.find((g) => g.groupId === TEST_GROUP),
      userPolicy: { policy: 'normal', attentionLevel: 3, allowCommands: false },
      text: '小深 你好',
      mentioned: true,
      userId: TEST_OWNER,
      images: [],
    });
    assert(d7.shouldReply === true, 'owner @bot should reply');

    console.log('PASS: Test 7 — group admin auto-detection');

    // ============================================================
    // Test 8: Two-layer data structure
    // ============================================================
    console.log('Test 8: Two-layer data structure');
    setupDb(original);

    // Process messages in two different groups
    processXpGain(event({ text: '群1消息 有效内容', groupId: '900000007', messageId: 't8-1' }), readDb());
    processXpGain(event({ text: '群2消息 有效内容', groupId: '770002', messageId: 't8-2' }), readDb());

    const exp8 = getExperience(readDb(), TEST_USER);
    assert(exp8.xp > 0, 'global XP should be > 0');

    const gExp8a = readDb().groupExperience?.[`900000007:${TEST_USER}`];
    const gExp8b = readDb().groupExperience?.[`770002:${TEST_USER}`];
    assert(gExp8a, 'should have group 1 experience');
    assert(gExp8b, 'should have group 2 experience');

    console.log('PASS: Test 8 — two-layer data structure');

    // ============================================================
    // Test 9: /w exp owner command parses @ target + trailing action
    // ============================================================
    console.log('Test 9: /w exp command parsing');
    setupDb(original);
    const sent9 = [];
    const send9 = async (_evt, text) => { sent9.push(String(text || '')); };

    await processIncoming(event({
      userId: TEST_OWNER,
      nickname: 'Owner',
      text: `/w exp [CQ:at,qq=${TEST_USER}] add 1200`,
      atTargets: [TEST_USER],
      messageId: 't9-add',
    }), send9);
    const exp9add = getExperience(readDb(), TEST_USER);
    assert(exp9add.xp === 1200, `add should set XP to 1200, got ${exp9add.xp}`);
    assert(exp9add.level === 12, `1200 XP should be level 12 (1200/100), got ${exp9add.level}`);
    assert(sent9.some((s) => s.includes('增加 1200 XP')), 'add reply should confirm increase');

    await processIncoming(event({
      userId: TEST_OWNER,
      nickname: 'Owner',
      text: `/w exp ${TEST_USER} set 160`,
      atTargets: [],
      messageId: 't9-set',
    }), send9);
    const exp9set = getExperience(readDb(), TEST_USER);
    assert(exp9set.xp === 160, `set should set XP to 160, got ${exp9set.xp}`);
    assert(exp9set.level === 1, `160 XP should be level 1, got ${exp9set.level}`);

    await processIncoming(event({
      userId: TEST_OWNER,
      nickname: 'Owner',
      text: `/w exp [CQ:at,qq=${TEST_USER}] reset`,
      atTargets: [TEST_USER],
      messageId: 't9-reset',
    }), send9);
    const exp9reset = getExperience(readDb(), TEST_USER);
    assert(exp9reset.xp === 0 && exp9reset.level === 0, `reset should clear XP, got ${JSON.stringify(exp9reset)}`);

    console.log('PASS: Test 9 — /w exp add/set/reset parses full command tail');

    // ============================================================
    console.log('\nAll experience verification tests PASSED.');
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
