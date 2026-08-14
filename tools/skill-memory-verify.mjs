import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-skill-memory-'));
process.env.DATA_DIR = testDataDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const {
    extractSkillRecord,
    lookupSkill,
    lookupSkills,
    relevantPlayersSkillBlock,
    resolveSkillQq,
    saveSkillRecord,
    updateRecentSkillRecordInDb,
  } = await import('../server/bots/skills.ts');

  ensureStore();

  const base = {
    userId: 'REDACTED_QQ_001',
    osuUsername: '[TST]Alpha',
    osuUserId: 1234567,
    pp: 10285.6,
    rank: 6217,
    countryRank: 87,
    accuracy: 98.8,
    playCount: 60895,
    playTimeSeconds: 9_000,
    level: 101,
    levelProgress: 48,
    ppPlus: { flow: 12.01, accuracy: 11.39, speed: 4.04, ppTotal: 10286 },
    modComposition: { HD: 55, HDHR: 41, HDDT: 4 },
    summary: '【结论】\n高准确率、HD 主导，Flow 与 Accuracy 突出的稳定型玩家。',
  };

  const std = extractSkillRecord({ ...base, mode: 'std' });
  assert(std.mode === 'osu', 'std alias must normalize to osu');
  assert(std.recordKey === '1234567:osu', 'record key must use osu ID + ruleset');
  assert(Math.abs(std.hoursPlayed - 2.5) < 1e-9, 'play_time seconds must convert to hours');
  assert(Math.abs(std.level - 101.48) < 1e-9, 'level progress must be preserved');
  assert(!std.summary.startsWith('【结论】'), 'stored summary must be compact conclusion text');
  saveSkillRecord(std);
  saveSkillRecord(extractSkillRecord({
    ...base,
    mode: 'mania',
    pp: 4321,
    rank: 18000,
    accuracy: 97.5,
    summary: 'mania 档案',
  }));

  let records = readDb().skillStore.records;
  assert(records.length === 2, 'one QQ must retain separate std and mania records');
  assert(lookupSkills('REDACTED_QQ_001').length === 2, 'QQ lookup must return every stored mode');
  assert(lookupSkill('REDACTED_QQ_001')?.mode === 'osu', 'QQ lookup should prefer std when mode is omitted');
  assert(lookupSkill('REDACTED_QQ_001', 'mania')?.pp === 4321, 'QQ + mode lookup must select mania');
  assert(lookupSkill('[tst]alpha')?.osuUserId === 1234567, 'username lookup must be case-insensitive');
  assert(lookupSkill('1234567')?.osuUsername === '[TST]Alpha', 'osu user ID lookup must work');
  assert(lookupSkill('definitely-missing') === undefined, 'unknown player must not fall back to another record');

  const originalStdSummary = lookupSkill('1234567', 'osu').summary;
  updateDb(db => {
    updateRecentSkillRecordInDb(db, {
      osuUserId: 1234567,
      mode: 'osu',
      userId: 'REDACTED_QQ_001',
    }, 'Recent 50 次：平均 7.20★、Acc 96.50%。');
  });
  const withRecent = lookupSkill('1234567', 'osu');
  assert(withRecent?.recentSummary?.includes('Recent 50 次'), 'Recent must update recentSummary');
  assert(withRecent?.summary === originalStdSummary, 'Recent must not overwrite full-analysis summary');
  assert(withRecent?.pp === 10285.6, 'Recent must not overwrite full profile statistics');

  saveSkillRecord(extractSkillRecord({
    ...base,
    osuUsername: 'OldBindingAccount',
    osuUserId: 3333333,
    mode: 'osu',
    summary: '同 QQ 的另一账号',
  }));
  updateDb(db => {
    updateRecentSkillRecordInDb(db, {
      osuUserId: 1234567,
      userId: 'REDACTED_QQ_001',
      mode: 'osu',
    }, '只应更新指定 osu ID');
  });
  assert(
    !lookupSkillByOsuIdForTest(readDb(), 3333333)?.recentSummary,
    'Recent identity must prioritize osu ID instead of another record sharing the QQ'
  );

  saveSkillRecord(extractSkillRecord({
    ...base,
    mode: 'osu',
    pp: 10300,
    summary: '更新后的完整档案',
  }));
  const refreshed = lookupSkill('1234567', 'osu');
  assert(refreshed?.pp === 10300, 'new full analysis must update the same mode record');
  assert(refreshed?.recentSummary === '只应更新指定 osu ID', 'full update must preserve recentSummary');

  // Legacy v1 rows had no recordKey and were keyed only by QQ. Saving a current
  // record must migrate/update them rather than add a duplicate.
  updateDb(db => {
    db.skillStore.records.push({
      userId: '888000111',
      osuUsername: 'LegacyPlayer',
      osuUserId: 7654321,
      mode: 'osu',
      pp: 1000,
      rank: 50000,
      accuracy: 95,
      playCount: 100,
      hoursPlayed: 10,
      level: 50,
      summary: '旧档案',
      lastAnalyzed: '2025-01-01T00:00:00.000Z',
      version: 1,
    });
  });
  saveSkillRecord(extractSkillRecord({
    userId: '',
    osuUsername: 'LegacyPlayer',
    osuUserId: 7654321,
    mode: 'osu',
    pp: 1100,
    rank: 45000,
    accuracy: 96,
    playCount: 120,
    playTimeSeconds: 40_000,
    level: 51,
    summary: '新档案',
  }));
  records = readDb().skillStore.records;
  const legacyMatches = records.filter(record => record.osuUserId === 7654321 && record.mode === 'osu');
  assert(legacyMatches.length === 1, 'legacy row must migrate without duplicate canonical records');
  assert(legacyMatches[0].userId === '888000111', 'unbound analysis must preserve known legacy QQ');
  assert(legacyMatches[0].recordKey === '7654321:osu', 'legacy row must gain a stable recordKey');

  const resolvedQq = resolveSkillQq({
    bindings: {
      '111111111': 9999999,
      '222222222': 1234567,
    },
    requesterQq: '111111111',
    osuUserId: 1234567,
    osuUsername: '[TST]Alpha',
  });
  assert(resolvedQq === '222222222', 'analyzing another player must use target binding, not requester QQ');
  assert(resolveSkillQq({
    bindings: { '111111111': 9999999 },
    requesterQq: '111111111',
    osuUserId: 1234567,
  }) === '', 'unbound target must not be assigned to requester');

  for (let index = 0; index < 5; index += 1) {
    saveSkillRecord(extractSkillRecord({
      userId: String(300000000 + index),
      osuUsername: `Unrelated${index}`,
      osuUserId: 8000000 + index,
      mode: 'osu',
      pp: 5000 + index,
      rank: 20000,
      accuracy: 97,
      playCount: 1000,
      playTimeSeconds: 3600,
      level: 80,
      summary: `无关玩家 ${index}`,
    }));
  }
  saveSkillRecord(extractSkillRecord({
    userId: '444444444',
    osuUsername: 'RivalPlayer',
    osuUserId: 9090909,
    mode: 'osu',
    pp: 12000,
    rank: 3000,
    accuracy: 99,
    playCount: 5000,
    playTimeSeconds: 7200,
    level: 100,
    summary: '对比对象',
  }));
  const bounded = relevantPlayersSkillBlock({
    userId: 'REDACTED_QQ_001',
    text: '比较一下我和 RivalPlayer 的bp',
    maxRecords: 2,
  });
  assert(bounded.includes('[TST]Alpha'), 'bounded context must include current speaker');
  assert(bounded.includes('RivalPlayer'), 'bounded context must include explicitly named player');
  assert(!bounded.includes('Unrelated0'), 'bounded context must exclude unrelated full store');
  assert((bounded.match(/^- /gm) || []).length <= 2, 'bounded context must honor maxRecords');

  const offTopic = relevantPlayersSkillBlock({
    userId: 'REDACTED_QQ_001',
    text: '晚上吃什么好',
    maxRecords: 2,
  });
  assert(!offTopic.includes('[TST]Alpha'), 'off-topic chat must not inject speaker skill memory');
  assert(!offTopic.includes('RivalPlayer'), 'off-topic chat must not inject mention/name skill memory');

  const osuTopic = relevantPlayersSkillBlock({
    userId: 'REDACTED_QQ_001',
    text: '手感回来了，最近准度好多了',
    maxRecords: 2,
  });
  assert(osuTopic.includes('[TST]Alpha'), 'osu-related chat must still inject speaker skill memory');

  console.log('All skill-memory regression tests PASSED.');
}

function lookupSkillByOsuIdForTest(db, osuUserId) {
  return (db.skillStore?.records || []).find(record => Number(record.osuUserId) === Number(osuUserId));
}

main()
  .finally(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
