import { PLAYER_SKILL_TITLES } from '../playerSkillTitles.js';

export const SKILL_RATING_POLICY = 'BP_SPECIALTY_AIM_PRIORITY_V02';
// Multipliers act on internal coordinates, before the existing peak/support
// aggregation and cubic display. They do not alter the nine displayed axes.
export const SKILL_RATING_COORDINATE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  jump_aim:1.08, flow_aim:1.08, raw_speed:1,
  aim_control:1/1.03, spatial_precision:1/1.03, finger_control:1/1.03, reading:1/1.03,
});

export function compositeCandidate(axes: ReadonlyArray<{key:string;ceiling:number}>) {
  // Stamina/Endurance remain independent indices until their units are aligned.
  const inputs = axes.filter(a => Object.hasOwn(SKILL_RATING_COORDINATE_WEIGHTS,a.key));
  if(inputs.length!==7 || new Set(inputs.map(a=>a.key)).size!==7 || inputs.some(a=>typeof a.ceiling!=='number'||!Number.isFinite(a.ceiling)||a.ceiling<0)) {
    throw Error('SKILL_RATING_INVALID_AXES');
  }
  const ranked = inputs.map(a => ({key:a.key,rawValue:a.ceiling,weight:SKILL_RATING_COORDINATE_WEIGHTS[a.key],value:a.ceiling*SKILL_RATING_COORDINATE_WEIGHTS[a.key]}))
    .sort((a,b) => b.value-a.value || a.key.localeCompare(b.key));
  const main = ranked[0]?.value || 0;
  const normalizer = 1 - 0.5 ** 6;
  const contributions = ranked.slice(1).map((a,i) => ({...a,
    contribution:main ? main * 0.20 * (0.5 ** (i+1) / normalizer) * (a.value/main) ** 3 : 0,
  }));
  const bonus = contributions.reduce((sum,a)=>sum+a.contribution,0);
  if(!Number.isFinite(main+bonus))throw Error('SKILL_RATING_OUT_OF_RANGE');
  return {policy:SKILL_RATING_POLICY,mainAxis:ranked[0]?.key,mainRaw:ranked[0]?.rawValue||0,main,bonus,total:main+bonus,contributions};
}


export const RATING_PRESENTATION_POLICY = 'RATING_TIERS_12_SPECIALTY_V02';
export const RATING_TIERS = [
  [0,'玄铁','IRON','#9cacbf','flat'],
  [25,'赤铜','BRONZE','#c69272','flat'],
  [60,'白银','SILVER','#c4d0e1','flat'],
  [110,'铂钢','PLATINUM','#9bc3d2','flat'],
  [180,'青玉','JADE','#5ae3c9','flat'],
  [280,'苍蓝','AZURE','#80b9ff','flat'],
  [420,'蓝晶','SAPPHIRE','#8ca0ff','metal'],
  [600,'紫晶','AMETHYST','#c2a0ff','metal'],
  [850,'璀钻','DIAMOND','#97e8f6','metal'],
  [1200,'辉金','AUREATE','#e5b765','metal'],
  [1600,'绯焰','EMBER','#fc827c','metal'],
  [2000,'极光','PRISM','#c0cbff','prism'],
].map(([min,name,en,color,material],index)=>({level:index+1,min,name,en,color,material}));

const singles = {
  JUMP:['jump_aim','JP'],FLOW:['flow_aim','FL'],
  PRECISION:['spatial_precision','PR'],CONTROL:['aim_control','AC'],
  SPEED:['raw_speed','SP'],RHYTHM:['finger_control','FC'],
  STAMINA:['stamina','ST'],ENDURANCE:['endurance','EN'],READING:['reading','RD'],
};

export function specialtyMark(profile) {
  if (profile.profileStatus !== 'RATED' || profile.profileTier === 'BEGINNER') return null;
  const single = singles[profile.profileArchetype];
  if (!single) return null;
  const [axis,abbr] = single;
  // Reuse the profile's evidence-based strength class, independently of global
  // rank and the weighted composite rating. No player-specific title overrides.
  const label = PLAYER_SKILL_TITLES[profile.profileArchetype]?.[profile.profileTier];
  if (!label) return null;
  const score = profile.axes.find(a=>a.key===axis)?.ceiling;
  const support = profile.rows.filter(r=>Number(r.axes[axis]) >= Number(score)*0.85 && Number(r.weight)>0);
  const distinctMaps = new Set(support.map(r=>r.beatmapId)).size;
  if (distinctMaps < 3) return null;
  const result: any = {axis,abbr,label,variant:'skill',evidence:{distinctMaps}};
  if (axis === 'reading') {
    const ezhd = support.filter(r=>r.mods.includes('EZ') && r.mods.includes('HD') && !r.mods.some(m=>['DT','HT','HR'].includes(m)));
    const weight = support.reduce((sum,r)=>sum+r.weight,0);
    const share = weight ? ezhd.reduce((sum,r)=>sum+r.weight,0)/weight : 0;
    if (new Set(ezhd.map(r=>r.beatmapId)).size >= 3 && share >= 0.40) {
      result.label = 'EZHD · ' + label;
      result.variant = 'ezhd';
      result.evidence.ezhdDistinctMaps = new Set(ezhd.map(r=>r.beatmapId)).size;
      result.evidence.ezhdSupportWeight = share;
    }
  }
  return result;
}

export function ratingPresentation(profile) {
  const composite = compositeCandidate(profile.axes);
  const value = Math.round(composite.total**3);
  if(!Number.isSafeInteger(value))throw Error('SKILL_RATING_OUT_OF_RANGE');
  const tier = RATING_TIERS.slice().reverse().find(t=>value>=Number(t.min));
  const rank = Number(profile.player.statistics.global_rank);
  const honor = !Number.isFinite(rank) || rank < 1 ? null
    : rank===1 ? {key:'first',label:'WORLD NO. 1'}
    : rank<=10 ? {key:'top10',label:'GLOBAL TOP 10'}
    : rank<=100 ? {key:'top100',label:'GLOBAL TOP 100'}
    : rank<=1000 ? {key:'top1000',label:'GLOBAL TOP 1,000'} : null;
  const title = profile.profileStatus === 'RATED' && (profile.profileTier === 'BEGINNER' || !singles[profile.profileArchetype])
    ? PLAYER_SKILL_TITLES[profile.profileArchetype]?.[profile.profileTier] : null;
  return {policy:RATING_PRESENTATION_POLICY,ratingPolicy:SKILL_RATING_POLICY,value,tier,honor,title,rated:profile.profileStatus!=='INSUFFICIENT_EVIDENCE',specialty:specialtyMark(profile)};
}
