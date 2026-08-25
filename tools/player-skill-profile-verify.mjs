import assert from 'node:assert/strict';
import { aggregatePlayerSkillProfile, PLAYER_SKILL_AXES, weightedQuantile } from '../server/bots/playerSkillProfile.ts';

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
console.log('player-skill-profile-verify: ok');
