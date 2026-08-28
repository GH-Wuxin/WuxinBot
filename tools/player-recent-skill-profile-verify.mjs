import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateRecentSkillProfile,
  canonicalRecentMods,
  groupRecentScores,
  recentFailureEvidence,
  recentScoreCompletion,
  recentScoreGroupKey,
  recentTimeWeight,
  validRecentDemand,
} from '../server/bots/playerRecentSkillProfile.ts';
import { renderPlayerRecentSkillProfileCard } from '../server/bots/playerSkillComparisonCard.ts';
import { PLAYER_SKILL_AXES, PLAYER_SKILL_AXIS_LABELS } from '../server/bots/playerSkillProfile.ts';

const score = ({ id = 1, bid = 100, mods = [], passed = true, accuracy = .97, combo = 450, judged = 500, total = 500, days = 0 }) => ({
  id, passed, rank: passed ? 'A' : 'F', accuracy, max_combo: combo, mods,
  statistics: { count_300: Math.max(0, judged - 5), count_100: 0, count_50: 0, count_miss: 5 },
  beatmap: { id: bid, difficulty_rating: 7, max_combo: total, count_circles: total, count_sliders: 0, count_spinners: 0, total_length: 120 },
  ended_at: new Date(Date.now() - days * 86_400_000).toISOString(),
});

assert.deepEqual(canonicalRecentMods(score({ mods: ['NC', 'NF', 'PF'] })), ['DT']);
assert.equal(recentScoreGroupKey(score({ bid: 123, mods: ['NC'] })), '123:DT');
assert.equal(groupRecentScores([
  score({ id: 1, bid: 123, mods: ['NC'] }), score({ id: 2, bid: 123, mods: ['DT', 'SD'] }),
]).length, 1, 'NC/DT and neutral safety mods should dedupe');
assert.equal(recentScoreCompletion(score({ passed: false, judged: 250, total: 500 })), 0.5);
assert.ok(recentFailureEvidence(score({ passed: false, judged: 450, total: 500 }))
  > recentFailureEvidence(score({ passed: false, judged: 100, total: 500 })), 'late fail must retain more evidence');
assert.equal(recentTimeWeight(Date.now() - 12 * 3_600_000), 1);
assert.ok(Math.abs(recentTimeWeight(Date.now() - 5 * 86_400_000) - .85) < .001);

const axes = Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, 8]));
assert.equal(validRecentDemand(19, axes, score({ total: 500 })), true);
assert.equal(validRecentDemand(21, axes, score({ total: 500 })), false);
assert.equal(validRecentDemand(8, { ...axes, jump_aim: 21 }, score({ total: 500 })), false);

const longTerm = PLAYER_SKILL_AXES.map((key) => ({ key, ceiling: 6 }));
const recentGroups = Array.from({ length: 4 }, (_, index) => ({
  completed: true, recency: 1 - index * .02, quality: .9, stability: 1, failureEvidence: 1,
  axes: Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, axis === 'jump_aim' ? 9 - index * .1 : 5])),
  demandAxes: Object.fromEntries(PLAYER_SKILL_AXES.map((axis) => [axis, axis === 'jump_aim' ? 9.4 - index * .1 : 5.2])),
}));
const aggregate = aggregateRecentSkillProfile(recentGroups, longTerm);
const jump = aggregate.find((axis) => axis.key === 'jump_aim');
assert.equal(jump.evidence, 'SUFFICIENT');
assert.ok(jump.value > 8.5 && jump.delta > 2, 'repeated salient recent Jump evidence should remain visible');
const untested = aggregateRecentSkillProfile(recentGroups.map((group) => ({
  ...group,
  demandAxes: { ...group.demandAxes, jump_aim: 4 },
  axes: { ...group.axes, jump_aim: 3.8 },
})), PLAYER_SKILL_AXES.map((key) => ({ key, ceiling: key === 'jump_aim' ? 12 : 6 })));
const untestedJump = untested.find((axis) => axis.key === 'jump_aim');
assert.equal(untestedJump.evidence, 'LOWER_BOUND');
assert.equal(untestedJump.delta, null, 'an untested recent axis must not claim a decline');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-recent-skill-card-'));
process.env.DATA_DIR = testDataDir;
const payload = {
  player: { osuId: 1, username: 'RecentPlayer', avatarUrl: '', coverUrl: '', countryCode: 'CN', globalRank: 123, pp: 10000 },
  sample: { days: 5, fetched: 82, groups: 31, completed: 25, analyzed: 28, skipped: 3 },
  profile: { axes: aggregate.map((axis, index) => index === 8 ? { ...axis, value: null, evidence: 'INSUFFICIENT', delta: null } : axis) },
};
const png = await renderPlayerRecentSkillProfileCard(payload);
assert.ok(png.length > 10_000, `recent profile PNG should be non-trivial, got ${png.length}`);
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
if (process.env.RENDER_OUTPUT_DIR) {
  fs.mkdirSync(process.env.RENDER_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-recent-skill-profile-preview.png'), png);
}
fs.rmSync(testDataDir, { recursive: true, force: true });
console.log('player-recent-skill-profile-verify: ok');
