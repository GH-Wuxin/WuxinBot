import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {buildSkillProfilerCardPayload} from '../server/bots/skillProfilerCard.ts';
import {renderPlayerSkillProfileCard, renderPlayerRecentSkillProfileCard, renderPlayerSkillComparisonCard} from '../server/bots/playerSkillComparisonCard.ts';

const port = Number(process.argv[2] || 18767);
const output = path.resolve('tmp/beta-release-preview');
await fs.mkdir(output, {recursive:true});
const results = [];
for (const [bid,mods] of [[1475722,['HD','DT']],[5648807,[]],[5405912,['HD']],[2116202,[]]]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({beatmap_id:bid,mods}), signal:AbortSignal.timeout(45000),
  });
  const analysis = await response.json();
  assert.equal(response.status,200,JSON.stringify(analysis));
  assert.equal(analysis.status,'OK');
  assert.equal(analysis.identity.map_demand_version,'0.10.0-beta.1');
  assert.equal(analysis.release.stage,'PUBLIC_BETA');
  results.push(analysis);
  console.log(bid,mods.join('')||'NM',Object.fromEntries(Object.entries(analysis.axes).map(([key,axis])=>[key,Number(axis.stars.toFixed(2))])));
}
assert.ok(Math.abs(results[0].axes.jump_aim.stars-11.750612780087177)<1e-10);
const payload=buildSkillProfilerCardPayload(results[0]);
// Real local artwork, no extra osu API requests. No substitute official SR.
const osuPath=results[0].beatmap.path_abs;
const osu=await fs.readFile(osuPath,'utf8');
const bg=osu.match(/^0,0,"([^"]+)"/m)?.[1];
if(bg){
  const bgPath=path.resolve(path.dirname(osuPath),bg);
  assert.ok(bgPath.startsWith(path.dirname(osuPath)+path.sep));
  payload.beatmap.coverUrl=`data:image/jpeg;base64,${(await fs.readFile(bgPath)).toString('base64')}`;
} else payload.beatmap.coverUrl='';
const originalCwd=process.cwd();
process.chdir('G:/My pack/Agent Work/codex_work/napcat-local-bots/sources/yumu-image');
const {panel_Skill}=await import(pathToFileURL('G:/My pack/Agent Work/codex_work/napcat-local-bots/sources/yumu-image/src/panel/panel_Skill.js'));
const svg=await panel_Skill(payload);
process.chdir(originalCwd);
assert.ok(svg.includes('0.10.0-beta.1 · 试用'));
await sharp(Buffer.from(svg)).png().toFile(path.join(output,'single-map-beta.png'));

// Explicit layout fixtures, not claimed player data; no avatar downloads.
const axes=Object.entries(results[0].axes).map(([key,axis])=>({key,label:key,ceiling:axis.stars,median:axis.stars*0.8}));
const fixture={player:{username:'BETA LAYOUT FIXTURE'},sample:{requested:50,valid:48},profile:{axes,releaseLabel:results[0].release.label,primaryAxes:['Jump Aim'],profileType:'Jump Aim Dominant'}};
await fs.writeFile(path.join(output,'player-beta.png'),await renderPlayerSkillProfileCard(fixture));
await fs.writeFile(path.join(output,'recent-beta.png'),await renderPlayerRecentSkillProfileCard(fixture));
await fs.writeFile(path.join(output,'compare-beta.png'),await renderPlayerSkillComparisonCard({left:fixture,right:fixture,limit:50}));
console.log('HTTP samples, beta identity, real-map render and 3 player layouts PASS',output);
process.exit(0);
