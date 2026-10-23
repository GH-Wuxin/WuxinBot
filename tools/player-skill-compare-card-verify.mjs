import {createTestDataDir,assertNotProduction} from './test-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const testDataDir=createTestDataDir('wuxin-player-skill-card');
assertNotProduction(testDataDir);
const {closeSkillCardBrowser}=await import('../server/bots/skillCard/browser.ts');
const {buildPlayerSkillComparisonHtml,playerProfileTitlePresentation,renderPlayerSkillComparisonCard,renderPlayerSkillProfileCard}=await import('../server/bots/playerSkillComparisonCard.ts');
const {buildPlayerSkillCardHtml}=await import('../server/bots/skillCard/cards.ts');
const {PLAYER_SKILL_AXES,PLAYER_SKILL_AXIS_LABELS}=await import('../server/bots/playerSkillProfile.ts');
const {RATING_TIERS}=await import('../server/bots/skillCard/presentation.ts');
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
    profileTitle: colorOffset < 100 ? 'Ballistic Virtuoso' : 'Tapping Overdrive',
    axes: PLAYER_SKILL_AXES.map((key, index) => ({
      key,
      label: PLAYER_SKILL_AXIS_LABELS[key],
      ceiling: 5 + index * 0.5 + colorOffset / 100,
      median: 4 + index * 0.4,
    })),
  },
  ppPlus: {
    jump: 12.4 + colorOffset / 100,
    flow: 11.8 + colorOffset / 120,
    speed: 10.6 + colorOffset / 140,
    stamina: 9.7 + colorOffset / 160,
    precision: 13.1 + colorOffset / 180,
    accuracy: 12.2 + colorOffset / 200,
  },
});


const comparisonPayload={left:side('LeftPlayer',0),right:side('RightPlayer',200),limit:50};
const html=buildPlayerSkillComparisonHtml(comparisonPayload);
const attr=(html,key)=>html.match(new RegExp(key+'="([^"]*)"'))?.[1];
const chart=(html,kind)=>html.split('class="compare-radar '+kind+'-radar"')[1].split('</svg>')[0];
assert.equal(attr(html,'data-rating-leader'),'b');
assert.notEqual(attr(html,'data-left-color'),attr(html,'data-right-color'));
assert.deepEqual([...chart(html,'skill').matchAll(/data-axis-label="([^"]+)"/g)].map(m=>m[1]),PLAYER_SKILL_AXES);
assert.equal((chart(html,'pplus').match(/class="axis-value"/g)||[]).length,6);
assert.equal((html.match(/class="series-dot /g)||[]).length,30);
assert.equal((html.match(/class="median-series"/g)||[]).length,2);
assert.match(html,/PP\+ ALGORITHM · ALOIC/);
assert.match(html,/data-unit="independent"/);
assert.match(html,/Ballistic Virtuoso/);
assert.match(html,/Tapping Overdrive/);
// All twelve real Tier thresholds, neutral silver, swapped positions and ties.
const atRating=(name,value)=>{
  const p=side(name,0);
  p.profile.axes=p.profile.axes.map(a=>({...a,ceiling:a.key==='raw_speed'?Math.cbrt(value):0,median:0}));
  return p;
};
for(const [i,tier] of RATING_TIERS.entries()){
  const width=(RATING_TIERS[i+1]?.min??tier.min+600)-tier.min;
  const left=atRating('Stronger',tier.min+Math.round(width*.68)),right=atRating('Quieter',tier.min+Math.round(width*.28));
  const normal=buildPlayerSkillComparisonHtml({left,right});
  const swapped=buildPlayerSkillComparisonHtml({left:right,right:left});
  assert.equal(attr(normal,'data-tier-left'),String(i+1));
  assert.equal(attr(normal,'data-tier-right'),String(i+1));
  assert.equal(attr(normal,'data-rating-leader'),'a');
  assert.equal(attr(swapped,'data-rating-leader'),'b');
  assert.notEqual(attr(normal,'data-left-color'),attr(normal,'data-right-color'));
  assert.equal(attr(normal,'data-left-color'),attr(swapped,'data-right-color'));
  assert.equal(attr(normal,'data-right-color'),attr(swapped,'data-left-color'));
  if(i===2){
    const channels=attr(normal,'data-left-color').slice(1).match(/../g).map(x=>parseInt(x,16));
    assert.ok(Math.max(...channels)-Math.min(...channels)<25,'silver remains neutral');
  }
  const tied=buildPlayerSkillComparisonHtml({left,right:left});
  assert.equal(attr(tied,'data-rating-leader'),'tie');
  assert.equal(attr(tied,'data-left-color'),attr(tied,'data-right-color'),'a tie does not invent a leader');
  assert.match(tied,/data-marker="circle"/);assert.match(tied,/data-marker="diamond"/);
}
const missing=structuredClone(comparisonPayload);
missing.left.ppPlus=null;
missing.right.ppPlus={jump:0,flow:null,speed:Infinity,stamina:{value:3},precision:-1};
const missingChart=chart(buildPlayerSkillComparisonHtml(missing),'pplus');
assert.doesNotMatch(missingChart,/NaN|Infinity|class="series-dot a"/);
assert.equal((missingChart.match(/class="series-dot b"/g)||[]).length,2,'unknown PP+ values are not zero-valued points');
assert.doesNotMatch(missingChart,/<polygon[^>]+class="profile-series/,'partial evidence must not close a polygon');
assert.match(missingChart,/>0\.00</,'real zero values remain visible');
const unrated=structuredClone(comparisonPayload);
unrated.left.profile.profileStatus='INSUFFICIENT_EVIDENCE';
const unratedHtml=buildPlayerSkillComparisonHtml(unrated);
assert.equal(attr(unratedHtml,'data-rating-leader'),'unrated');
assert.equal(attr(unratedHtml,'data-left-rating'),'');
assert.doesNotMatch(chart(unratedHtml,'skill'),/class="series-dot a"/);
assert.match(unratedHtml,/UNRATED · INSUFFICIENT EVIDENCE/);
const unsafe=structuredClone(comparisonPayload);unsafe.right.player.username='<script>&"';
assert.doesNotMatch(buildPlayerSkillComparisonHtml(unsafe),/<script>/);
const png=await renderPlayerSkillComparisonCard(comparisonPayload);
assert.ok(png.length>10000);
assert.deepEqual(await sharp(png).metadata().then(({width,height})=>({width,height})),{width:1280,height:720});
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
const profileHtml = buildPlayerSkillCardHtml(profile);
assert.deepEqual(
  [...profileHtml.matchAll(/data-axis-label="([^"]+)"/g)].map((match) => match[1]),
  [...PLAYER_SKILL_AXES],
  'profile radar angles use the same shared axis order',
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
