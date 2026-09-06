import assert from 'node:assert/strict';
import {ratingPresentation,compositeCandidate,SKILL_RATING_POLICY,SKILL_RATING_COORDINATE_WEIGHTS,RATING_TIERS} from '../server/bots/skillCard/presentation.ts';
import {buildPlayerSkillCardHtml} from '../server/bots/skillCard/cards.ts';
const keys=['flow_aim','jump_aim','aim_control','spatial_precision','raw_speed','finger_control','reading','stamina','endurance'];
const axes=keys.map((key,i)=>({key,ceiling:8-i*.3,median:7-i*.3}));
const rows=[1,2,3].map(rank=>({rank,beatmapId:rank,weight:1,mods:['HD'],accuracy:99.5,pp:400,title:'Track <script>bad()</script>',version:'A & B',axes:Object.fromEntries(keys.map((key,i)=>[key,8-i*.3]))}));
const profile={profileStatus:'RATED',profileTier:'EXPERT',profileArchetype:'FLOW',profileType:'Flow Aim',axes};
const payload={player:{username:'Fixture <&>',countryCode:'HK',globalRank:1,countryRank:1,pp:10000},profile,rows,sample:{valid:3,requested:50,failed:47,modCounts:[{mods:'HD',count:3}]}};
const html=buildPlayerSkillCardHtml(payload);
assert.match(html,/中国香港/);assert.match(html,/OSU! STANDARD<i>·<\/i>HK/);
assert.match(html,/Fixture &lt;&amp;&gt;/);assert.doesNotMatch(html,/<script>/);
assert.match(html,/99\.50/,'backend ACC is percent, not a fraction');
assert.match(html,/WORLD NO\. 1/);assert.match(html,/class="rank-crown"/);assert.match(html,/Flow Rider/);
assert.doesNotMatch(html,/>紫晶<|>辉金<|MAIN_PLUS_SUPPORT|contribution/);
assert.equal((html.match(/class="skill-row /g)||[]).length,7);
for(const [code,label] of [['MO','中国澳门'],['TW','中国台湾'],['DE','德国']])assert.ok(buildPlayerSkillCardHtml({...payload,player:{...payload.player,countryCode:code}}).includes(label));
const metadata={...profile,rows,player:{statistics:{global_rank:1}}};
for(const [rank,honor] of [[1,'first'],[3,'top10'],[51,'top100'],[748,'top1000'],[6427,undefined]]){
  const view=ratingPresentation({...metadata,player:{statistics:{global_rank:rank}}});
  assert.equal(view.honor?.key,honor);
}
const insufficient=buildPlayerSkillCardHtml({...payload,profile:{...profile,profileStatus:'INSUFFICIENT_EVIDENCE'}});
assert.match(insufficient,/样本不足 · 暂未评级/);assert.match(insufficient,/TIER —/);
const ezhd=ratingPresentation({...metadata,profileArchetype:'READING',rows:rows.map(r=>({...r,mods:['EZ','HD']}))});
assert.equal(ezhd.specialty?.label,'EZHD · Pattern Seeker');
for(const [tier,title] of [['PLAYER','Snapper'],['EXPERT','Snap Ace'],['WORLD_CLASS','Ballistic Virtuoso']]){
  for(const rank of [1,50000])assert.equal(ratingPresentation({...metadata,profileArchetype:'JUMP',profileTier:tier,player:{statistics:{global_rank:rank}}}).specialty?.label,title);
}
assert.equal(ratingPresentation({...metadata,profileTier:'WORLD_CLASS',rows:rows.slice(0,2)}).specialty,null,'strong titles still require three distinct supporting maps');
assert.equal(ratingPresentation({...metadata,profileTier:'WORLD_CLASS',rows:rows.map(r=>({...r,beatmapId:1}))}).specialty,null);
assert.equal(ratingPresentation({...metadata,profileStatus:'INSUFFICIENT_EVIDENCE'}).specialty,null);
assert.equal(ratingPresentation({...metadata,profileTier:'BEGINNER'}).specialty,null);
assert.equal(ratingPresentation({...metadata,profileArchetype:'READING',profileTier:'WORLD_CLASS',rows:rows.map(r=>({...r,mods:['EZ','HD']}))}).specialty?.label,'EZHD · Perception Savant');
assert.match(buildPlayerSkillCardHtml({...payload,profile:{...profile,profileArchetype:'AIM',profileTier:'WORLD_CLASS',profileTitle:'GOD OF AIM'}}),/Aiming Ascendant/,'cached title text must not bypass the current catalog');
assert.match(buildPlayerSkillCardHtml({...payload,profile:{...profile,profileTier:'BEGINNER'}}),/Rookie · BP 画像/);
assert.equal(ratingPresentation({...metadata,profileTier:'WORLD_CLASS',rows:rows.slice(0,2)}).title,null,'fallback text cannot bypass specialty evidence');
const baseline=compositeCandidate(axes);
assert.ok(baseline.total>=baseline.main&&baseline.total<=baseline.main*1.2);
assert.deepEqual(compositeCandidate([...axes].reverse()),baseline);
assert.equal(compositeCandidate(axes.map(a=>['stamina','endurance'].includes(a.key)?{...a,ceiling:10}:a)).total,baseline.total);
assert.equal(ratingPresentation(metadata).ratingPolicy,SKILL_RATING_POLICY);
assert.match(html,new RegExp(`data-rating-policy="${SKILL_RATING_POLICY}"`));
assert.doesNotMatch(html,/rawValue|coordinate|1\.08|0\.97087/,'internal rating details stay out of the card');

const vector=overrides=>keys.map(key=>({key,ceiling:overrides[key]??0,median:0}));
const score=overrides=>compositeCandidate(vector(overrides)).total;
for(const scale of [.25,.5,1,1.5,2]){
  assert.ok(score({jump_aim:8*scale})>score({raw_speed:8.5*scale}));
  assert.ok(score({jump_aim:8*scale})>=score({raw_speed:8.4*scale}));
  assert.ok(score({raw_speed:9*scale})>score({jump_aim:8*scale}));
  assert.ok(score({aim_control:8.5*scale})>score({raw_speed:8*scale}));
  const dual=score({jump_aim:8*scale,flow_aim:8*scale});
  assert.ok(dual>score({jump_aim:8.4*scale})&&dual<score({jump_aim:9.5*scale}));
  assert.ok(score({jump_aim:10*scale})>dual);
}
assert.equal(score({}),0);
assert.deepEqual(compositeCandidate([...axes,{key:'unknown_axis',ceiling:1e9}]),baseline);
for(const invalid of [NaN,Infinity,-1,null,'8'])assert.throws(()=>compositeCandidate(axes.map(a=>a.key==='jump_aim'?{...a,ceiling:invalid}:a)),/INVALID_AXES/);
assert.throws(()=>compositeCandidate(axes.filter(a=>a.key!=='jump_aim')),/INVALID_AXES/);
assert.throws(()=>compositeCandidate([...axes,axes[0]]),/INVALID_AXES/);
assert.throws(()=>ratingPresentation({...metadata,axes:vector({jump_aim:1e8})}),/OUT_OF_RANGE/);

// Valid profile coordinates may cross ten; increasing any axis cannot lower SR.
let seed=183127;
const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
for(let n=0;n<400;n++){
  const candidate=keys.map(key=>({key,ceiling:random()*20,median:0}));
  const before=compositeCandidate(candidate);
  assert.ok(before.total>=before.main&&before.total<=before.main*1.2+1e-9);
  for(const key of keys){const after=compositeCandidate(candidate.map(a=>({...a,ceiling:a.ceiling+(a.key===key?.1:0)})));assert.ok(after.total>=before.total-1e-9);}
  assert.deepEqual(compositeCandidate([...candidate].reverse()),before);
}
// Tier styles follow the final rounded display value, across every threshold.
for(let i=1;i<RATING_TIERS.length;i++)for(const offset of [-.6,-.4,.4,.6]){
  const intended=Number(RATING_TIERS[i].min)+offset;
  const tierView=ratingPresentation({...metadata,axes:vector({raw_speed:Math.cbrt(intended)})});
  assert.equal(tierView.value,Math.round(intended));
  assert.equal(tierView.tier.level,offset<-.5?i:i+1);
}
assert.deepEqual(Object.keys(SKILL_RATING_COORDINATE_WEIGHTS).sort(),keys.filter(k=>!['stamina','endurance'].includes(k)).sort());
console.log('PASS: Skill Rating v2 human bounds, monotonicity, input validation, Tier thresholds, specialty titles, evidence and existing card rules');
