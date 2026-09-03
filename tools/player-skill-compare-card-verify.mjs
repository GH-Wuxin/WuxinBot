import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  playerProfileTitlePresentation,
  renderPlayerSkillComparisonCard,
  renderPlayerSkillProfileCard,
} from '../server/bots/playerSkillComparisonCard.ts';
import { PLAYER_SKILL_AXES, PLAYER_SKILL_AXIS_LABELS } from '../server/bots/playerSkillProfile.ts';

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-player-skill-card-'));
process.env.DATA_DIR = testDataDir;

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
assert.deepEqual(
  await sharp(png).metadata().then(({ width, height }) => ({ width, height })),
  { width: 2560, height: 1440 },
);
const profile = side('ProfilePlayer', 0);
profile.sample.averageScoreQuality = 0.86;
profile.profile.profileTitle = 'GOD OF AIM';
profile.profile.profileTier = 'WORLD_CLASS';
assert.deepEqual(playerProfileTitlePresentation(profile.profile), {
  title: 'GOD OF AIM',
  color: '#ffcf62',
  fontSize: 24,
});
assert.equal(playerProfileTitlePresentation({ profileType: 'Legacy Hybrid' }).title, 'LEGACY HYBRID');
const longTitle = playerProfileTitlePresentation({
  profileTitle: 'THE EXTRAORDINARILY COMPLETE PACKAGE',
  profileType: 'Must Not Win',
  profileTier: 'EXPERT',
});
assert.equal(longTitle.title, 'THE EXTRAORDINARILY COMPLETE PACKAGE');
assert.equal(longTitle.fontSize, 18);
assert.equal(longTitle.color, '#e9b65b');
assert.doesNotMatch(longTitle.title, /…/);
const profilePng = await renderPlayerSkillProfileCard(profile);
assert.ok(profilePng.length > 10_000, `profile PNG should be non-trivial, got ${profilePng.length} bytes`);
assert.deepEqual([...profilePng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.deepEqual(
  await sharp(profilePng).metadata().then(({ width, height }) => ({ width, height })),
  { width: 2560, height: 1440 },
);
const originalFetch = globalThis.fetch;
let avatarAttempts = 0;
const avatarUrl = `https://a.ppy.sh/999999?retry-fixture-${Date.now()}`;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
try {
  globalThis.fetch = async () => {
    avatarAttempts += 1;
    if (avatarAttempts === 1) return new Response('', { status: 503 });
    const response = new Response(tinyPng, {
      status: 200,
      // osu! can return PNG bytes while claiming image/jpeg. The renderer must
      // trust the signature, not this misleading header.
      headers: { 'content-type': 'image/jpeg', 'content-length': String(tinyPng.length) },
    });
    Object.defineProperty(response, 'url', { value: avatarUrl });
    return response;
  };
  const retryProfile = {
    ...profile,
    player: { ...profile.player, osuId: 999999, avatarUrl, coverUrl: avatarUrl },
  };
  const retryPng = await renderPlayerSkillProfileCard(retryProfile);
  assert.ok(retryPng.length > 10_000);
  assert.equal(avatarAttempts, 2, 'avatar download should retry once after a transient HTTP failure');
  const cacheFiles = fs.readdirSync(path.join(testDataDir, 'player-skill-image-cache'));
  const cached = JSON.parse(fs.readFileSync(path.join(testDataDir, 'player-skill-image-cache', cacheFiles[0]), 'utf8'));
  assert.match(cached.dataUrl, /^data:image\/png;base64,/, 'PNG signature must override a misleading image/jpeg response header');
} finally {
  globalThis.fetch = originalFetch;
}
if (process.env.RENDER_OUTPUT_DIR) {
  fs.mkdirSync(process.env.RENDER_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-profile-preview.png'), profilePng);
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-compare-preview.png'), png);
}
fs.rmSync(testDataDir, { recursive: true, force: true });
console.log('player-skill-compare-card-verify: ok');
