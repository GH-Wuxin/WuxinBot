import {closeSkillCardBrowser} from '../server/bots/skillCard/browser.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  buildPlayerSkillComparisonSvg,
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

const comparisonPayload = { left: side('LeftPlayer', 0), right: side('RightPlayer', 200), limit: 50 };
const svg = buildPlayerSkillComparisonSvg(comparisonPayload);
assert.match(svg,/data-design="tier-radar-v2"/);
assert.match(svg,/class="comparison-radar"/);
assert.equal((svg.match(/class="axis-value"/g)||[]).length,9,'comparison radar shows all nine fixed dimensions');
assert.match(svg,/data-axis-label="spatial_precision"/,'comparison preserves the Spatial Precision label');
assert.match(svg,/data-unit="independent"/,'Stamina and Endurance retain independent /10 units');
assert.match(svg,/RightPlayer leads/,'the summary names the leading player rather than a generic profile lean');
const leftRadarColor = svg.match(/data-left-color="([^"]+)"/)?.[1];
const rightRadarColor = svg.match(/data-right-color="([^"]+)"/)?.[1];
assert.match(svg,new RegExp(`<text[^>]*fill="${rightRadarColor}"[^>]*>\\+2\\.0</text>`),'positive deltas use the right-player tier color');
assert.match(svg,/r="39"[^>]*stroke-width="1\.7"/,'comparison avatars use the enlarged profile-card size');
assert.doesNotMatch(svg,/TIER [IVX]+ · [A-Z]+<\/text><text[^>]*>[^<]+<\/text>/,'tier label is not packed beside the player name');
assert.doesNotMatch(svg,/维度领先|势均力敌|Largest meaningful gap|dimensions are close|comparisonRows|comparisonBars/i);
assert.doesNotMatch(svg,/<linearGradient id="compare-bg"/,'comparison uses the restrained graphite surface');
assert.notEqual(leftRadarColor,rightRadarColor,'player radar accents come from their different Tiers');
const closePayload = { left: side('LeftPlayer', 0), right: side('RightPlayer', 0), limit: 50 };
const closeSvg = buildPlayerSkillComparisonSvg(closePayload);
assert.match(closeSvg,/Overall close/);
assert.equal((closeSvg.match(/Overall close/g)||[]).length,1,'close summary is not duplicated');
const png = await renderPlayerSkillComparisonCard(comparisonPayload);
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
const profileSize=await sharp(profilePng).metadata();
assert.deepEqual({width:profileSize.width,height:profileSize.height},{width:1280,height:720});
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
  const cacheEntries = cacheFiles.map((file) => JSON.parse(fs.readFileSync(path.join(testDataDir, 'player-skill-image-cache', file), 'utf8')));
  const cached = cacheEntries.find((entry) => entry.url === avatarUrl);
  assert.ok(cached, 'successful avatar retry should be cached under the requested URL');
  assert.match(cached.dataUrl, /^data:image\/png;base64,/, 'PNG signature must override a misleading image/jpeg response header');
} finally {
  globalThis.fetch = originalFetch;
}
if (process.env.RENDER_OUTPUT_DIR) {
  fs.mkdirSync(process.env.RENDER_OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-profile-preview.png'), profilePng);
  fs.writeFileSync(path.join(process.env.RENDER_OUTPUT_DIR, 'player-skill-compare-preview.png'), png);
}
await closeSkillCardBrowser();
fs.rmSync(testDataDir, { recursive: true, force: true });
console.log('player-skill-compare-card-verify: ok');
