import assert from 'node:assert/strict';
import {
  aggregatePlayerSkillProfile,
  bpRankWeight,
  demonstratedAxisValue,
  PLAYER_SKILL_AXES,
  scoreAchievementQuality,
  weightedQuantile,
} from '../server/bots/playerSkillProfile.ts';

assert.equal(weightedQuantile([{ value: 2, weight: 1 }, { value: 8, weight: 3 }], 0.5), 8);
assert.equal(weightedQuantile([], 0.8), null);

const rows = [0, 1, 2].map((offset) => ({
  rank: offset + 1,
  beatmapId: 100 + offset,
  mods: [],
  pp: 500,
  accuracy: 99,
  weight: 1,
  axes: Object.fromEntries(PLAYER_SKILL_AXES.map((axis, index) => [axis, index === 0 ? 8 + offset : 4 + offset / 10])),
  primaryType: offset < 2 ? 'TECHNICAL' : 'STREAM',
}));
const result = aggregatePlayerSkillProfile(rows);
assert.equal(result.axes.length, 9);
assert.equal(result.axes[0].ceiling, 10);
assert.equal(result.axes[0].median, 9);
assert.equal(result.primaryAxes[0], 'Aim Control');
assert.equal(result.profileType, 'Technical');

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
assert.ok(excellentFcJump > 12 && excellentFcJump < 12.6,
  `99%+ FC should receive a small bounded excellence bonus, got ${excellentFcJump}`);
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
