import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderPlayerSkillComparisonCard, renderPlayerSkillProfileCard } from '../server/bots/playerSkillComparisonCard.ts';
import { PLAYER_SKILL_AXES, PLAYER_SKILL_AXIS_LABELS } from '../server/bots/playerSkillProfile.ts';

const side = (username, colorOffset) => ({
  player: {
    osuId: colorOffset + 1,
    username,
    avatarUrl: '',
    coverUrl: '',
    countryCode: 'CN',
    globalRank: colorOffset + 10,
    pp: 12000 - colorOffset,
    accuracy: 98.5,
  },
  sample: { requested: 50, valid: 48, failed: 2 },
  profile: {
    primaryAxes: ['Jump Aim', 'Aim Control'],
    profileType: 'Jump Aim Dominant',
    axes: PLAYER_SKILL_AXES.map((key, index) => ({
      key,
      label: PLAYER_SKILL_AXIS_LABELS[key],
      ceiling: 5 + index * 0.5 + colorOffset / 100,
      median: 4 + index * 0.4,
    })),
  },
});

const png = await renderPlayerSkillComparisonCard({ left: side('LeftPlayer', 0), right: side('RightPlayer', 20), limit: 50 });
assert.ok(png.length > 10_000, `comparison PNG should be non-trivial, got ${png.length} bytes`);
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const profile = side('ProfilePlayer', 0);
profile.sample.averageScoreQuality = 0.86;
const profilePng = await renderPlayerSkillProfileCard(profile);
assert.ok(profilePng.length > 10_000, `profile PNG should be non-trivial, got ${profilePng.length} bytes`);
assert.deepEqual([...profilePng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
if (process.env.RENDER_OUTPUT_DIR) {
  fs.mkdirSync(process.env.RENDER_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-profile-preview.png'), profilePng);
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-compare-preview.png'), png);
}
console.log('player-skill-compare-card-verify: ok');
