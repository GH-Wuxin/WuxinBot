import assert from 'node:assert/strict';
import {
  aggregatePlayerSkillProfile,
  bpRankWeight,
  demonstratedAxisValue,
  inferPlayerSkillIdentity,
  PLAYER_SKILL_AXES,
  PLAYER_SKILL_TITLE_POLICY_ID,
  PLAYER_SKILL_QUALITY_POLICY_ID,
  scoreAchievementQuality,
  PLAYER_SKILL_TITLES,
  playerProfileCacheKey,
  weightedQuantile,
} from '../server/bots/playerSkillProfile.ts';

assert.equal(weightedQuantile([{ value: 2, weight: 1 }, { value: 8, weight: 3 }], 0.5), 8);
assert.equal(weightedQuantile([], 0.8), null);

const profileRows = (values, primaryTypes = ['HYBRID'], count = 50) => Array.from({ length: count }, (_, index) => ({
  rank: index + 1,
  beatmapId: 100 + index,
  mods: [],
  pp: 500,
  accuracy: 99,
  weight: bpRankWeight(index + 1),
  axes: Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, Number(values[axis] ?? 0)])),
  primaryType: primaryTypes[index % primaryTypes.length],
}));

const allAxes = (value) => Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, value]));
const identityAxes = (overrides = {}, fallback = 2.5) => PLAYER_SKILL_AXES.map((key) => ({
  key,
  label: key,
  ceiling: Number(overrides[key]?.ceiling ?? overrides[key] ?? fallback),
  median: Number(overrides[key]?.median ?? overrides[key] ?? fallback),
}));

const beginner = aggregatePlayerSkillProfile(profileRows(allAxes(2.8)));
assert.equal(beginner.profileStatus, 'RATED');
assert.equal(beginner.profileTier, 'BEGINNER');
assert.equal(beginner.profileType, 'All-Rounder');
assert.equal(beginner.profileTitle, 'Rookie');

const flowSpeedPlayerAxes = { ...allAxes(3.0), flow_aim: 5.5, raw_speed: 5.0 };
const flowSpeedPlayer = aggregatePlayerSkillProfile(profileRows(flowSpeedPlayerAxes));
assert.equal(flowSpeedPlayer.profileTier, 'PLAYER');
assert.equal(flowSpeedPlayer.profileArchetype, 'FLOW_SPEED');
assert.equal(flowSpeedPlayer.profileType, 'Flow Speed');
assert.equal(flowSpeedPlayer.profileTitle, 'Stream Runner');

const wuxinLikeAxes = {
  aim_control: 5.6,
  jump_aim: 3.8,
  spatial_precision: 2.7,
  flow_aim: 8.1,
  raw_speed: 7.3,
  finger_control: 5.3,
  stamina: 5.1,
  endurance: 6.7,
  reading: 5.5,
};
const wuxinLike = aggregatePlayerSkillProfile(profileRows(
  wuxinLikeAxes,
  ['HYBRID', 'FLOW_AIM_DOMINANT', 'RAW_SPEED_DOMINANT'],
));
assert.deepEqual(wuxinLike.primaryAxes, ['Flow Aim', 'Raw Speed']);
assert.equal(wuxinLike.profileTier, 'EXPERT');
assert.equal(wuxinLike.profileArchetype, 'FLOW_SPEED');
assert.equal(wuxinLike.profileType, 'Flow Speed');
assert.equal(wuxinLike.profileTitle, 'Torrent Rider');
assert.notEqual(wuxinLike.profileType, 'Hybrid');

const sameAxesDifferentMapVotes = aggregatePlayerSkillProfile(profileRows(
  wuxinLikeAxes,
  ['JUMP_AIM_DOMINANT', 'AIM_CONTROL_READING'],
));
assert.equal(sameAxesDifferentMapVotes.profileTitle, wuxinLike.profileTitle,
  'map archetype votes must not rename a player with identical aggregate axes');

const mrekkLike = aggregatePlayerSkillProfile(profileRows({
  ...allAxes(6.0),
  jump_aim: 10.8,
  aim_control: 9.9,
  flow_aim: 8.2,
}));
assert.equal(mrekkLike.profileTier, 'WORLD_CLASS');
assert.equal(mrekkLike.profileArchetype, 'AIM');
assert.equal(mrekkLike.profileTitle, 'Aiming Ascendant');

const qiaoLike = inferPlayerSkillIdentity(identityAxes({
  jump_aim: { ceiling: 6.5, median: 5.1 },
  aim_control: { ceiling: 5.4, median: 4.8 },
}));
assert.equal(qiaoLike.tierScore, 6.05);
assert.equal(qiaoLike.tier, 'PLAYER', 'qiao-like 6kpp profile must not become an 8-star aim expert');
assert.equal(qiaoLike.title, 'Aimer');

const badeuLike = inferPlayerSkillIdentity(identityAxes({
  jump_aim: { ceiling: 9.3, median: 8.15 },
  reading: { ceiling: 8.8, median: 5.2 },
  aim_control: { ceiling: 7.4, median: 6.6 },
}));
assert.equal(badeuLike.tier, 'WORLD_CLASS', 'broad world-class aim must not require artificial 10-star overflow');
assert.equal(badeuLike.title, 'Ballistic Virtuoso');

const tierAt = (value, evidence = undefined) => inferPlayerSkillIdentity(identityAxes({
  jump_aim: value,
}), evidence).tier;
assert.equal(tierAt(3.49), 'BEGINNER');
assert.equal(tierAt(3.5), 'PLAYER');
assert.equal(tierAt(6.49), 'PLAYER');
assert.equal(tierAt(6.5), 'EXPERT');
const worldThreshold = identityAxes({ jump_aim: { ceiling: 10, median: 6.875 } });
assert.equal(inferPlayerSkillIdentity(worldThreshold, { sampleCount: 29, effectiveSampleSize: 29 }).tier, 'EXPERT');
assert.equal(inferPlayerSkillIdentity(worldThreshold, { sampleCount: 30, effectiveSampleSize: 20 }).tier, 'WORLD_CLASS');
assert.equal(inferPlayerSkillIdentity(worldThreshold, { sampleCount: 30, effectiveSampleSize: 19.99 }).tier, 'EXPERT');

assert.equal(inferPlayerSkillIdentity(identityAxes(), { sampleCount: 11, effectiveSampleSize: 11 }).title, 'UNRATED');
assert.equal(inferPlayerSkillIdentity(identityAxes(), { sampleCount: 12, effectiveSampleSize: 10 }).title, 'Rookie');

const oneExtremeMap = aggregatePlayerSkillProfile(profileRows({
  ...allAxes(2.5),
  jump_aim: 16,
}, ['JUMP_AIM_DOMINANT'], 1));
assert.equal(oneExtremeMap.profileStatus, 'INSUFFICIENT_EVIDENCE');
assert.equal(oneExtremeMap.profileTier, null);
assert.equal(oneExtremeMap.profileTitle, 'UNRATED');

const normalRows = profileRows(allAxes(5.5));
const threeExtremeRows = normalRows.map((row, index) => ({
  ...row,
  axes: { ...row.axes, jump_aim: index < 3 ? 12 : 5.5 },
}));
const fourExtremeRows = normalRows.map((row, index) => ({
  ...row,
  axes: { ...row.axes, jump_aim: index < 4 ? 12 : 5.5 },
}));
assert.equal(aggregatePlayerSkillProfile(threeExtremeRows).axes.find((axis) => axis.key === 'jump_aim').ceiling, 5.5,
  'three isolated top-rank results must remain below the weighted P80 frontier');
const fourExtremeProfile = aggregatePlayerSkillProfile(fourExtremeRows);
assert.equal(fourExtremeProfile.axes.find((axis) => axis.key === 'jump_aim').ceiling, 12,
  'four top-rank results intentionally cross the weighted P80 frontier');
assert.equal(fourExtremeProfile.profileTier, 'EXPERT',
  'a narrow four-map overflow peak without a strong BP50 baseline must not manufacture a world title');
const fourExtremeStaminaRows = normalRows.map((row, index) => ({
  ...row,
  axes: { ...row.axes, stamina: index < 4 ? 10 : 5.5 },
}));
assert.equal(aggregatePlayerSkillProfile(fourExtremeStaminaRows).profileTier, 'EXPERT',
  'a narrow bounded-axis peak without a strong BP50 baseline must not manufacture a world title');
const fourDualExtremeRows = normalRows.map((row, index) => ({
  ...row,
  axes: {
    ...row.axes,
    jump_aim: index < 4 ? 12 : 5.5,
    aim_control: index < 4 ? 12 : 5.5,
  },
}));
assert.equal(aggregatePlayerSkillProfile(fourDualExtremeRows).profileTier, 'EXPERT',
  'two narrow overflow peaks must not bypass the world-class BP50 baseline guard');
const fourDualBoundedExtremeRows = normalRows.map((row, index) => ({
  ...row,
  axes: {
    ...row.axes,
    stamina: index < 4 ? 10 : 5.5,
    endurance: index < 4 ? 10 : 5.5,
  },
}));
assert.equal(aggregatePlayerSkillProfile(fourDualBoundedExtremeRows).profileTier, 'EXPERT',
  'two narrow bounded peaks must not bypass the world-class BP50 baseline guard');

for (const first of PLAYER_SKILL_AXES) {
  const single = inferPlayerSkillIdentity(identityAxes({ [first]: 8 }));
  assert.ok(single.archetype);
  assert.doesNotMatch(single.title, /HYBRID/i);
  for (const second of PLAYER_SKILL_AXES) {
    if (first === second) continue;
    const pair = inferPlayerSkillIdentity(identityAxes({ [first]: 8, [second]: 8 }));
    const reversedInput = inferPlayerSkillIdentity([...identityAxes({ [first]: 8, [second]: 8 })].reverse());
    assert.equal(pair.archetype, reversedInput.archetype, `${first}+${second} must not depend on array order`);
    assert.equal(pair.title, reversedInput.title, `${first}+${second} title must not depend on array order`);
    assert.doesNotMatch(pair.title, /HYBRID/i);
  }
}
assert.equal(inferPlayerSkillIdentity(identityAxes({ flow_aim: 8, raw_speed: 8 })).archetype, 'FLOW_SPEED');
assert.equal(inferPlayerSkillIdentity(identityAxes({ flow_aim: 8, finger_control: 8 })).archetype, 'TECH');
assert.equal(inferPlayerSkillIdentity(identityAxes({ flow_aim: 8, aim_control: 8 })).archetype, 'AIM');
assert.equal(inferPlayerSkillIdentity(identityAxes({ flow_aim: 8, spatial_precision: 8 })).archetype, 'AIM');
const onlyFiveBroadAxes = identityAxes(Object.fromEntries(PLAYER_SKILL_AXES.slice(0, 5).map((axis) => [axis, 8])));
assert.notEqual(inferPlayerSkillIdentity(onlyFiveBroadAxes).archetype, 'ALL_ROUNDER',
  'five strong axes with four weak axes are not broad enough for an all-rounder title');
const sevenBroadAxes = identityAxes(Object.fromEntries(PLAYER_SKILL_AXES.slice(0, 7).map((axis) => [axis, 8])));
assert.equal(inferPlayerSkillIdentity(sevenBroadAxes).archetype, 'ALL_ROUNDER');

for (const titles of Object.values(PLAYER_SKILL_TITLES)) {
  for (const title of Object.values(titles)) {
    assert.doesNotMatch(title, /…/, `profile title catalog must store the complete title: ${title}`);
  }
}

assert.equal(inferPlayerSkillIdentity(wuxinLike.axes).title, 'Torrent Rider');
const beta7Cache = playerProfileCacheKey(19244792, 50, { algorithmId: 'A7', mapDemandVersion: 'beta7' });
const beta8Cache = playerProfileCacheKey(19244792, 50, { algorithmId: 'A8', mapDemandVersion: 'beta8' });
assert.notEqual(beta7Cache, beta8Cache, 'player cache must rotate with profiler identity');
assert.deepEqual(JSON.parse(beta8Cache), [
  PLAYER_SKILL_TITLE_POLICY_ID,
  PLAYER_SKILL_QUALITY_POLICY_ID,
  'A8',
  'beta8',
  19244792,
  50,
]);
assert.notEqual(beta8Cache,
  playerProfileCacheKey(19244792, 50, { algorithmId: 'A7', mapDemandVersion: 'beta8' }),
  'player cache must rotate with profiler algorithm');
assert.notEqual(beta8Cache,
  playerProfileCacheKey(19244792, 50, { algorithmId: 'A8', mapDemandVersion: 'beta7' }),
  'player cache must rotate with profiler version');
assert.notEqual(
  playerProfileCacheKey(19244792, 50, { algorithmId: 'A:7', mapDemandVersion: 'beta7' }),
  playerProfileCacheKey(19244792, 50, { algorithmId: 'A', mapDemandVersion: '7:beta7' }),
  'JSON cache keys must resist delimiter collisions',
);
assert.notEqual(beta8Cache, playerProfileCacheKey(19244792, 49, { algorithmId: 'A8', mapDemandVersion: 'beta8' }));
assert.notEqual(beta8Cache, playerProfileCacheKey(19244793, 50, { algorithmId: 'A8', mapDemandVersion: 'beta8' }));

const score = (accuracy, combo, miss, objects = 500) => ({
  accuracy,
  max_combo: combo,
  statistics: { count_300: Math.max(0, objects - miss), count_100: 0, count_50: 0, count_miss: miss },
  beatmap: {},
});
const weakQuality = scoreAchievementQuality(score(0.78, 50, 30));
const strongQuality = scoreAchievementQuality(score(0.99, 490, 1));
const weakJump = demonstratedAxisValue('jump_aim', 12, weakQuality);
const strongJump = demonstratedAxisValue('jump_aim', 12, strongQuality);
const weakExtremeJump = demonstratedAxisValue('jump_aim', 16, weakQuality);
const oneSidedWeaknessJump = demonstratedAxisValue('jump_aim', 12, scoreAchievementQuality(score(0.99, 50, 0)));
const excellentFcQuality = scoreAchievementQuality({ ...score(0.995, 500, 0), perfect: true });
const excellentFcJump = demonstratedAxisValue('jump_aim', 12, excellentFcQuality);
assert.ok(weakJump < 5, `low ACC/combo 12★ pass must collapse under reciprocal penalty, got ${weakJump}`);
assert.ok(weakExtremeJump <= weakJump + 0.75,
  `low-quality extreme demand must approach a finite demonstrated ceiling, got 12★=${weakJump}, 16★=${weakExtremeJump}`);
assert.ok(oneSidedWeaknessJump > weakJump * 1.8,
  `one weak signal alone must not receive the joint low-ACC/low-combo collapse, got ${oneSidedWeaknessJump}`);
assert.ok(strongJump > 11, `high-quality 12★ score should preserve demonstrated Jump, got ${strongJump}`);
assert.ok(excellentFcQuality.fullCombo, '99%+ perfect score should be recognized as an FC');
assert.ok(excellentFcJump > 12 && excellentFcJump <= 12 * 1.19,
  `99%+ FC should receive a small bounded excellence bonus, got ${excellentFcJump}`);
// Isolate bonus behaviour from the separate achievement penalties.
for (const axis of PLAYER_SKILL_AXES) {
  const base = { ...scoreAchievementQuality(score(1, 500, 0)), fullCombo: false };
  const bonusValue = (accuracy) => demonstratedAxisValue(axis, 8, { ...base, accuracy });
  assert.ok(Math.abs(bonusValue(99) - 8 * 1.04) < 1e-10);
  assert.ok(Math.abs(bonusValue(100) - 8 * 1.15) < 1e-10);
  assert.ok(bonusValue(99.5) - bonusValue(99) < bonusValue(100) - bonusValue(99.5),
    'reward must accelerate toward SS');
  let previousIncrement = 0;
  for (let step = 1; step <= 100; step++) {
    const increment = bonusValue(99 + step / 100) - bonusValue(99 + (step - 1) / 100);
    assert.ok(increment > previousIncrement, 'exponential increments must strictly increase');
    previousIncrement = increment;
  }
  assert.ok(Math.abs(demonstratedAxisValue(axis, 8, { ...base, fullCombo: true }) - 8 * 1.19) < 1e-10);
}
// Quality policy: independent ACC excellence, stronger low combo, subordinate misses.
for (const axis of PLAYER_SKILL_AXES) {
  const evaluate = (acc, combo, miss = 0) => demonstratedAxisValue(axis, 8,
    scoreAchievementQuality({ ...score(acc, combo, miss), beatmap: { max_combo: 500 } }));
  for (const combo of [0, 125, 245, 250, 400, 500]) {
    let previous = 0;
    for (let acc = 7500; acc <= 10000; acc += 5) {
      const next = evaluate(acc / 10000, combo);
      assert.ok(next >= previous - 1e-10, axis + ': increasing ACC must not lower evidence');
      previous = next;
    }
  }
  for (const acc of [0.80, 0.96, 0.97, 0.99, 1]) {
    let previous = 0;
    for (let combo = 0; combo <= 500; combo++) {
      const next = evaluate(acc, combo);
      assert.ok(next >= previous - 1e-10, axis + ': increasing combo must not lower evidence');
      previous = next;
    }
  }
  assert.equal(evaluate(0.97, 0), evaluate(0.97, 0, 20), 'miss must only refine combo evidence');
  assert.ok(evaluate(0.995, 400) > evaluate(0.99, 400), 'non-FC accuracy excellence must matter');
  assert.ok(evaluate(1, 500) <= 8 * 1.19, 'combined bonus must stay bounded');
}
assert.ok(scoreAchievementQuality(score(0.96, 250, 0)).accuracyQuality < 0.90);
assert.ok(scoreAchievementQuality(score(0.99, 125, 0)).comboQuality < 0.50);
assert.equal(scoreAchievementQuality(score(0.99, 200, 0)).fullCombo, false);
const sliderMapQuality = scoreAchievementQuality({
  accuracy: 0.9,
  max_combo: 300,
  statistics: { count_300: 300, count_100: 20, count_50: 0, count_miss: 10 },
  beatmap: { count_circles: 100, count_sliders: 200, count_spinners: 0 },
});
assert.ok(sliderMapQuality.comboRatio < 0.55, `slider-heavy maps need estimated max combo, got ${sliderMapQuality.comboRatio}`);
assert.equal(bpRankWeight(1), 1);
assert.ok(bpRankWeight(50) < 0.09 && bpRankWeight(50) > 0.08, `BP50 decay should be about 8.1%, got ${bpRankWeight(50)}`);

const baseAxes = (jump) => Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, axis === 'jump_aim' ? jump : 5]));
const isolatedOutlier = Array.from({ length: 50 }, (_, index) => ({
  rank: index + 1, beatmapId: 1000 + index, mods: [], pp: 500 - index,
  accuracy: 97, weight: bpRankWeight(index + 1),
  axes: baseAxes(index === 0 ? weakJump : 6), primaryType: 'JUMP_AIM_DOMINANT',
}));
const repeatedSpecialty = isolatedOutlier.map((row, index) => ({
  ...row,
  axes: baseAxes(index < 15 ? 10.5 : 6),
}));
assert.ok(aggregatePlayerSkillProfile(isolatedOutlier).axes.find((axis) => axis.key === 'jump_aim').ceiling < 7,
  'one weak outlier must not inflate the BP50 Jump ceiling');
assert.ok(aggregatePlayerSkillProfile(repeatedSpecialty).axes.find((axis) => axis.key === 'jump_aim').ceiling > 10,
  'repeated high Jump evidence should remain visibly exceptional');
console.log('player-skill-profile-verify: ok');
