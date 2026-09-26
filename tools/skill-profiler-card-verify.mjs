import assert from 'node:assert/strict';
import {buildSkillProfilerCardPayload} from '../server/bots/skillProfilerCard.ts';
import {formatSkillProfilerAnalysis,skillProfilerAxisValue} from '../server/bots/skillProfiler.ts';
import {buildMapSkillCardHtml} from '../server/bots/skillCard/cards.ts';
import {PLAYER_SKILL_AXIS_ORDER} from '../server/bots/playerSkillAxes.ts';
import {compactSkillProfilerSnapshot} from '../server/bots/skillProfilerFeedback.ts';
const keys=['flow_aim','jump_aim','aim_control','spatial_precision','raw_speed','finger_control','reading','stamina','endurance'];
const analysis={status:'OK',beatmap:{beatmap_id:4288226,beatmapset_id:1946744,artist:'Artist',title:'A <script> title',version:'Expert',creator:'Mapper',local_nm_stars:7.42,metadata:{counts:{objects:100}}},
 analysis_context:{duration_ms:123000,bpm_max:240,effective_difficulty:{ApproachRate:10.4,OverallDifficulty:10.1,CircleSize:4}},
 mod_context:{requested_mods:['HD','DT','PF'],effective_mods:['HD','DT'],neutral_mods:['PF']},
 axes:Object.fromEntries(keys.map((key,i)=>[key,{stars:8-i*.3,confidence:'LOW'}])),
 key_sections:keys.map((key,i)=>({key,available:true,start:1000+i*1000,end:1500+i*1000,kind:i>=7?'持续区间':'局部证据',extra:''}))};
const payload=buildSkillProfilerCardPayload(analysis,{beatmap:{difficulty_rating:7.42},starRating:8.765});
assert.equal(payload.coverUrl,'https://assets.ppy.sh/beatmaps/1946744/covers/fullsize.jpg');
assert.deepEqual(payload.mods,['HD','DT','PF']);assert.equal(payload.stars,8.765);assert.equal(payload.nomodStars,7.42);
const html=buildMapSkillCardHtml(payload);
assert.match(html,/MODDED STAR/);assert.match(html,/>8\.77</);assert.match(html,/NM 7\.42★/);assert.match(html,/HDDTPF/);
assert.equal(payload.objectCount,100,'object count falls back to profiler metadata when official counts are absent');
assert.match(html,/10\.4/);assert.doesNotMatch(html,/<script>/);
assert.equal((html.match(/class="lane-label"/g)||[]).length,9,'all nine axes have evidence lanes');
assert.match(html,/OVERLAPPING SUPPORT|LOCAL EVIDENCE/);
const missing=buildSkillProfilerCardPayload(analysis);
assert.equal(missing.stars,null,'NM stars never masquerade as played Mod stars');
assert.match(buildMapSkillCardHtml(missing),/MODDED STAR/);
assert.match(buildMapSkillCardHtml(missing),/>—</);
const nm=buildSkillProfilerCardPayload({...analysis,mod_context:{effective_mods:[]}});
assert.equal(nm.stars,7.42);
const sparse=buildSkillProfilerCardPayload({...analysis,beatmap:{beatmap_id:1},analysis_context:{},key_sections:undefined});
assert.doesNotThrow(()=>buildMapSkillCardHtml(sparse),'partial map metadata still renders a card');
assert.doesNotMatch(buildMapSkillCardHtml(sparse),/NaN|undefined/);

const attachedAxes=Object.fromEntries(keys.map((key,index)=>[key,{
  stars:10.6-index*.4,
  unified_star_status:'UNKNOWN',
  unit:key==='stamina'||key==='endurance'?'bounded_0_10':'star_equivalent'
}]));
attachedAxes.jump_aim={...attachedAxes.jump_aim,unified_star_equivalent:7.4,unified_star_status:'CANDIDATE'};
attachedAxes.aim_control={...attachedAxes.aim_control,unified_star_equivalent:6.8,unified_star_status:'CANDIDATE'};
attachedAxes.endurance={...attachedAxes.endurance,unified_star_equivalent:2.7,unified_star_status:'CANDIDATE'};
const attached=buildSkillProfilerCardPayload({...analysis,axes:attachedAxes,unified_measurements:{status:'ATTACHED'}});
const attachedHtml=buildMapSkillCardHtml(attached);
assert.deepEqual(skillProfilerAxisValue({...analysis,axes:attachedAxes,unified_measurements:{status:'ATTACHED'}},'jump_aim'),{
  value:10.2,
  scale:'v040_axis',
  status:'CANDIDATE_NOT_ADMITTED'
},'candidate calibration never enters player/profile measurement values');
assert.match(formatSkillProfilerAnalysis({...analysis,axes:attachedAxes,unified_measurements:{status:'ATTACHED'}}),/尚未进入正式输出；以下使用 v0\.40 原轴值/);
assert.match(attachedHtml,/C  CANDIDATE UNIFIED/);
assert.match(attachedHtml,/R  RAW MAP DEMAND \/ LOW CONFIDENCE/);
assert.match(attachedHtml,/data-display-kind="raw"/);
assert.match(attachedHtml,/≈10\.6/,'attached maps show raw fallback values');
assert.match(attachedHtml,/> R<\/tspan>/,'raw fallback values carry a visible R marker');
assert.doesNotMatch(attachedHtml,/class="confidence-marker">C<\/span>/,'candidate values never become the primary demand');
assert.match(attachedHtml,/C  CANDIDATE UNIFIED \(NOT USED\)/,'candidate calibration is explicitly demoted');
assert.match(attachedHtml,/V0\.40 DEMAND · CANDIDATE SUPPRESSED/,'candidate fallback is visible in the footer');
assert.doesNotMatch(attachedHtml,/data-display-kind="candidate"/);
assert.doesNotMatch(attachedHtml,/Calibrated axes use the attached unified star-equivalent scale/);

const admittedAxes=Object.fromEntries(keys.map((key,index)=>[key,{
  stars:4+index*.2,
  unified_star_equivalent:6+index*.1,
  unified_star_status:'ADMITTED',
  unit:key==='stamina'||key==='endurance'?'bounded_0_10':'star_equivalent'
}]));
const admitted=buildSkillProfilerCardPayload({...analysis,axes:admittedAxes,unified_measurements:{status:'ATTACHED'}});
const admittedHtml=buildMapSkillCardHtml(admitted);
assert.match(admittedHtml,/UNIFIED STAR DEMAND/,'fully admitted unified values still enter the main display');
assert.match(admittedHtml,/data-display-kind="unified"/);
assert.doesNotMatch(admittedHtml,/data-display-kind="raw"/);
assert.deepEqual(
  [...attachedHtml.matchAll(/data-axis-label="([^"]+)"/g)].map((match) => match[1]),
  [...PLAYER_SKILL_AXIS_ORDER],
  'map radar angles use the shared nine-axis order',
);
const snapshot=compactSkillProfilerSnapshot({...analysis,axes:{...analysis.axes,jump_aim:{stars:8,unified_star_equivalent:null,unified_star_status:'UNKNOWN'}}});
assert.equal(snapshot.axes.jump_aim.unifiedStarEquivalent,null,'UNKNOWN unified evidence remains null instead of becoming zero');
assert.deepEqual(Object.keys(snapshot.axes),[...PLAYER_SKILL_AXIS_ORDER],'stored snapshots use the shared nine-axis order');
assert.throws(()=>buildSkillProfilerCardPayload({status:'BAD'}),/ANALYSIS_INVALID/);
console.log('PASS: mod-specific official stars, NM reference, nine evidence lanes, escaped map metadata and absent stars');
