import assert from 'node:assert/strict';
import {buildSkillProfilerCardPayload} from '../server/bots/skillProfilerCard.ts';
import {buildMapSkillCardHtml} from '../server/bots/skillCard/cards.ts';
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
assert.match(html,/osu! 原星数/);assert.match(html,/>8\.77</);assert.match(html,/NM 7\.42★/);assert.match(html,/HDDTPF/);
assert.match(html,/10\.4/);assert.doesNotMatch(html,/<script>/);
assert.equal((html.match(/class="lane-label"/g)||[]).length,9,'all nine axes have evidence lanes');
assert.match(html,/多项局部证据重合|局部证据/);
const missing=buildSkillProfilerCardPayload(analysis);
assert.equal(missing.stars,null,'NM stars never masquerade as played Mod stars');
assert.match(buildMapSkillCardHtml(missing),/原星数暂不可用/);
const nm=buildSkillProfilerCardPayload({...analysis,mod_context:{effective_mods:[]}});
assert.equal(nm.stars,7.42);
const sparse=buildSkillProfilerCardPayload({...analysis,beatmap:{beatmap_id:1},analysis_context:{},key_sections:undefined});
assert.doesNotThrow(()=>buildMapSkillCardHtml(sparse),'partial map metadata still renders a card');
assert.doesNotMatch(buildMapSkillCardHtml(sparse),/NaN|undefined/);
assert.throws(()=>buildSkillProfilerCardPayload({status:'BAD'}),/ANALYSIS_INVALID/);
console.log('PASS: mod-specific official stars, NM reference, nine evidence lanes, escaped map metadata and absent stars');
