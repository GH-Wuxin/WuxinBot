import fs from 'node:fs';
import sharp from 'sharp';
import {ratingPresentation,RATING_TIERS} from './presentation.js';
import {imageDataUrl} from './images.js';
import {renderSkillCardHtml,skillCardFontFace} from './browser.js';
import {PLAYER_SKILL_AXIS_DEFINITIONS,PLAYER_SKILL_AXIS_ORDER} from '../playerSkillAxes.js';

export const SKILL_CARD_DESIGN_VERSION='PROFILE_20260925_RADAR_16X9_V4_OKLCH_TIER_PALETTE';

export const tierEmblemDataUrls:Record<string,string>=Object.fromEntries(
  ['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','prism'].map((key)=>{
    try{
      const file=new URL(`./assets/tier-${key}.png`,import.meta.url);
      return [key,`data:image/png;base64,${fs.readFileSync(file).toString('base64')}`];
    }catch{
      return [key,''];
    }
  }),
);

const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numeric=(value:unknown):number|null=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);
const finite=(value:unknown,fallback=0)=>numeric(value)??fallback;
const n=(value:unknown,digits=1)=>numeric(value)?.toFixed(digits)??'—';
const fmt=(value:unknown)=>numeric(value)?.toLocaleString('en-US')??'—';
const rank=(value:unknown)=>numeric(value)!==null&&Number(value)>0?'#'+fmt(value):'—';
const time=(ms:unknown)=>{const value=numeric(ms);return value===null?'—':`${Math.floor(value/60000).toString().padStart(2,'0')}:${Math.floor(value/1000%60).toString().padStart(2,'0')}`;};
const precise=(ms:unknown)=>{const rounded=Math.round(finite(ms));return time(rounded)+'.'+(rounded%1000).toString().padStart(3,'0');};

const def=PLAYER_SKILL_AXIS_DEFINITIONS;
const defs=Object.fromEntries(def.map((item)=>[item.key,item])) as Record<string,{key:string;label:string;abbr:string;color:string;unit:string}>;
const allKeys=[...PLAYER_SKILL_AXIS_ORDER];
const starKeys=def.filter((item)=>item.unit==='star').map((item)=>item.key);

const text=(x:number,y:number,value:unknown,size:number,fill='#e7e4dc',weight=500,anchor='start',spacing=0)=>`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}" letter-spacing="${spacing}px">${esc(value)}</text>`;

const axisValue=(source:any,key:string,field:string)=>{
  const axis=Array.isArray(source)?source.find((item:any)=>item?.key===key):source?.[key];
  return numeric(axis?.[field]);
};

function radarPoint(index:number,value:number,max:number,cx:number,cy:number,radius:number,axisCount=allKeys.length){
  const angle=-Math.PI/2+index*Math.PI*2/axisCount;
  const r=radius*Math.max(0,Math.min(max,value))/max;
  return {x:cx+Math.cos(angle)*r,y:cy+Math.sin(angle)*r,cos:Math.cos(angle),sin:Math.sin(angle)};
}

function radarPolygon(values:number[],maxima:number[],cx:number,cy:number,radius:number,axisCount=allKeys.length){
  return values.map((value,index)=>{
    const point=radarPoint(index,value,maxima[index],cx,cy,radius,axisCount);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
}

function tierStrength(level:number){
  return Math.max(0,Math.min(1,(Number(level||1)-1)/11));
}

function tierEnergy(level:number){
  return tierStrength(level)**1.15;
}

function pplusRadarSvg(source:any,accent:string,level=5):string{
  const dimensions=[
    ['Jump','jump'],
    ['Flow','flow'],
    ['Speed','speed'],
    ['Stamina','stamina'],
    ['Precision','precision'],
    ['Accuracy','accuracy'],
  ] as const;
  const values=dimensions.map(([,key])=>axisValue(source,key,'value') ?? numeric(source?.[key]));
  const valid=values.filter((value):value is number=>value!==null);
  const max=Math.max(15,Math.ceil(Math.max(0,...valid)*1.08*2)/2);
  const cx=310,cy=220,radius=156,labelRadius=201,count=dimensions.length;
  const energy=tierEnergy(level);
  const grid='var(--rule)',muted='var(--muted)',panel='var(--panel)',textColor='#e7e4dc';
  const rings=[0.25,0.5,0.75,1].map(ratio=>`<polygon points="${radarPolygon(Array.from({length:count},()=>max*ratio),Array.from({length:count},()=>max),cx,cy,radius,count)}" fill="none" stroke="${grid}" stroke-opacity="${ratio===1?.62:.25}" stroke-width="${ratio===1?1.4:1}"/>`).join('');
  const spokes=dimensions.map((_,index)=>{
    const point=radarPoint(index,max,max,cx,cy,radius,count);
    return `<line x1="${cx}" y1="${cy}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${grid}" stroke-opacity=".28" stroke-width="1"/>`;
  }).join('');
  const baseline=`<polygon points="${radarPolygon(Array.from({length:count},()=>Math.min(15,max)),Array.from({length:count},()=>max),cx,cy,radius,count)}" fill="none" stroke="${muted}" stroke-opacity=".8" stroke-width="1.4" stroke-dasharray="6 5"/>`;
  const polygonValues=values.map(value=>value ?? 0);
  const polygon=values.every(value=>value!==null)
    ? `<polygon points="${radarPolygon(polygonValues,Array.from({length:count},()=>max),cx,cy,radius,count)}" fill="${accent}" fill-opacity="${(.07+energy*.08).toFixed(2)}" stroke="${accent}" stroke-width="${(2+energy*.7).toFixed(2)}" stroke-linejoin="round"/>`
    : '';
  const dots=values.map((value,index)=>{
    if(value===null)return '';
    const point=radarPoint(index,value,max,cx,cy,radius,count);
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${(4.8+energy*.8).toFixed(1)}" fill="${accent}" stroke="${panel}" stroke-width="2"/>`;
  }).join('');
  const labels=dimensions.map(([label],index)=>{
    const angle=-Math.PI/2+index*Math.PI*2/count;
    const x=cx+Math.cos(angle)*labelRadius;
    const y=cy+Math.sin(angle)*labelRadius;
    const anchor=Math.cos(angle)>.22?'start':Math.cos(angle)<-.22?'end':'middle';
    const yOffset=Math.sin(angle)<-.65?-4:Math.sin(angle)>.65?8:4;
    const value=values[index];
    return `${text(Number(x.toFixed(1)),Number((y+yOffset).toFixed(1)),label,18,textColor,600,anchor)}${text(Number(x.toFixed(1)),Number((y+yOffset+23).toFixed(1)),value===null?'—':Number(value).toFixed(2),17,accent,650,anchor)}`;
  }).join('');
  const description='PP+ display radar. 15 is the ExpertPlus benchmark; values are comparable inside PP+ only. Polygon area is not an overall rating.';
  return `<svg class="skill-radar pplus-radar" data-ppplus-max="${max}" viewBox="0 0 620 456" role="img" aria-label="PP+ six dimension radar"><desc>${description}</desc><g>${rings}${spokes}${baseline}${polygon}${dots}${labels}</g></svg>`;
}

function radarSvg(source:any,mode:'player'|'map',accent:string,level=5,unified=false,valueAccent=accent,labelSource:any=source):string{
  const primary=allKeys.map(key=>axisValue(source,key,mode==='player'?'ceiling':'stars'));
  const secondary=mode==='player'?allKeys.map(key=>axisValue(source,key,'median')):[];
  const labelPrimary=allKeys.map(key=>axisValue(labelSource,key,mode==='player'?'ceiling':'stars'));
  const coreValues=(unified ? primary : [...primary.slice(0,7),...secondary.slice(0,7)]).filter((value):value is number=>value!==null);
  const max=Math.max(10,Math.ceil(Math.max(0,...coreValues)*1.08*2)/2);
  // These are display frames, not a common validated difficulty scale. The two
  // bounded indices keep their own 0–10 frame even when core values exceed 10.
  const maxima=allKeys.map(key=>unified?max:defs[key].unit==='independent'?10:max);
  const width=620,height=456,cx=310,cy=224,radius=157,labelRadius=202;
  const muted='var(--muted)',grid='var(--rule)',panel='var(--panel)',textColor='#e7e4dc';
  const rings=[0.25,0.5,0.75,1].map(ratio=>`<polygon points="${radarPolygon(maxima.map(value=>value*ratio),maxima,cx,cy,radius)}" fill="none" stroke="${grid}" stroke-opacity="${ratio===1?.62:.25}" stroke-width="${ratio===1?1.4:1}"/>`).join('');
  const spokes=allKeys.map((_,index)=>{
    const point=radarPoint(index,maxima[index],maxima[index],cx,cy,radius);
    return `<line x1="${cx}" y1="${cy}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${grid}" stroke-opacity=".28" stroke-width="1"/>`;
  }).join('');
  const outline=(values:Array<number|null>,color:string,primarySeries:boolean)=>{
    const energy=tierEnergy(level);
    const attributes=`stroke="${color}" stroke-width="${primarySeries?(2+energy*.7).toFixed(2):1.8}" stroke-linejoin="round"${primarySeries?'':' stroke-dasharray="6 5"'}`;
    if(values.every(value=>value!==null))return `<polygon data-series="${primarySeries?'primary':'median'}" points="${radarPolygon(values.map(value=>value??0),maxima,cx,cy,radius)}" fill="${primarySeries?color:'none'}" fill-opacity="${(.08+energy*.08).toFixed(2)}" ${attributes}/>`;
    // Missing evidence is a gap, never a zero-valued vertex or a filled shape.
    return values.map((value,index)=>{
      const next=(index+1)%values.length;
      if(value===null||values[next]===null)return '';
      const a=radarPoint(index,value,maxima[index],cx,cy,radius),b=radarPoint(next,values[next]!,maxima[next],cx,cy,radius);
      return `<path d="M${a.x},${a.y}L${b.x},${b.y}" fill="none" ${attributes}/>`;
    }).join('');
  };
  const primaryPolygon=outline(primary,accent,true);
  const secondaryPolygon=mode==='player'?outline(secondary,muted,false):'';
  const primaryDots=primary.map((value,index)=>{if(value===null)return '';const point=radarPoint(index,value,maxima[index],cx,cy,radius);return `<circle data-axis="${allKeys[index]}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5.4" fill="${accent}" stroke="${panel}" stroke-width="2"/>`;}).join('');
  const secondaryDots=mode==='player'?secondary.map((value,index)=>{if(value===null)return '';const point=radarPoint(index,value,maxima[index],cx,cy,radius);return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.1" fill="${panel}" stroke="${muted}" stroke-width="1.5"/>`;}).join(''):'';
  const labels=allKeys.map((key,index)=>{
    const d=defs[key];
    const labelAxis=Array.isArray(labelSource)?labelSource.find((item:any)=>item?.key===key):labelSource?.[key];
    const displayKind=String(labelAxis?.displayKind||'').toLowerCase();
    // A candidate calibration is deliberately rendered as a raw fallback by
    // mapPage. Keep the marker tied to the display kind rather than to the
    // common-frame flag, otherwise the fallback would lose its R/≈ warning.
    const rawFallback=mode==='map'&&displayKind==='raw';
    const candidateUnified=mode==='map'&&unified&&displayKind==='candidate';
    const missing=labelPrimary[index]===null;
    const angle=-Math.PI/2+index*Math.PI*2/allKeys.length;
    const x=cx+Math.cos(angle)*labelRadius;
    const y=cy+Math.sin(angle)*labelRadius;
    const anchor=Math.cos(angle)>.22?'start':Math.cos(angle)<-.22?'end':'middle';
    const yOffset=Math.sin(angle)<-.65?-4:Math.sin(angle)>.65?8:4;
    const valueText=mode==='player'
      ? `<tspan fill="${valueAccent}">${n(primary[index])}</tspan><tspan fill="${muted}"> / ${n(secondary[index])}</tspan>`
      : `<tspan fill="${valueAccent}">${rawFallback&&labelPrimary[index]!==null?'≈':''}${n(labelPrimary[index])}</tspan>`;
    const independent=mode==='map'
      ? String(labelAxis?.displayUnit||labelAxis?.unit||'')==='independent'
      : !unified&&d.unit==='independent';
    const labelFill=independent?muted:textColor;
    const suffix=missing
      ? ''
      : rawFallback
        ? `<tspan fill="${muted}" font-size="12">${independent?' · /10':''}</tspan><tspan fill="#e5b765" font-size="11" font-weight="700"> R</tspan>`
        : `<tspan fill="${muted}" font-size="12">${independent?' · /10':' ★'}</tspan>${candidateUnified?'<tspan fill="#e5b765" font-size="11" font-weight="700"> C</tspan>':''}`;
    return `<g data-axis-label="${key}" data-display-kind="${esc(displayKind||'default')}" data-unit="${independent?'/10':'star'}">${text(Number(x.toFixed(1)),Number((y+yOffset).toFixed(1)),d.label,18,labelFill,600,anchor)}<text x="${x.toFixed(1)}" y="${(y+yOffset+23).toFixed(1)}" text-anchor="${anchor}" font-size="17" font-weight="650">${valueText}${suffix}</text></g>`;
  }).join('');
  const description=unified
    ? `Display-only radar. Calibrated axes use the attached unified star-equivalent scale; R marks raw low-confidence estimates and missing evidence stays blank. Polygon area is not an overall rating.`
    : `Display-only radar. Core frame 0–${max} stars; Stamina and Endurance frame 0–10. Different units; polygon area is not an overall rating. Missing evidence stays blank.`;
  return `<svg class="skill-radar" data-core-max="${max}" data-index-max="10" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(mode==='player'?'Player skill radar':'Beatmap demand radar')}"><desc>${description}</desc><g>${rings}${spokes}${secondaryPolygon}${primaryPolygon}${secondaryDots}${primaryDots}${labels}</g></svg>`;
}

const brand=(label:string)=>`<div class="brand"><b>Skill Profiler</b><span>${esc(label)}</span></div>`;
const foot=(left:string,right:string)=>`<footer><div><b>SKILL PROFILER</b><span>${esc(left)}</span></div><div>${esc(right)}</div></footer>`;
const section=(title:string,meta:string)=>`<div class="section-head"><b>${esc(title)}</b><span>${esc(meta)}</span></div>`;

function tierAccentColor(hex:string,_level:number){
  // Tier colors are already perceptually tuned in presentation.ts. Do not
  // re-saturate them per card; that was the source of the neon/hazy result.
  return hex;
}

function mixHex(left:string,right:string,amount:number){
  const a=[1,3,5].map(offset=>parseInt(left.slice(offset,offset+2),16));
  const b=[1,3,5].map(offset=>parseInt(right.slice(offset,offset+2),16));
  return '#'+a.map((value,index)=>Math.round(value*(1-amount)+b[index]*amount).toString(16).padStart(2,'0')).join('');
}

export type MapSkillCardTheme={paper:string;panel:string;rule:string;ruleSoft:string;coverTint:string;contrastTint:string};

const DEFAULT_MAP_THEME:MapSkillCardTheme={
  paper:'#1a1d22',
  panel:'#23262b',
  rule:'#3c4148',
  ruleSoft:'#30353c',
  coverTint:'#71847c',
  contrastTint:'#8bc3ca',
};

const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));

function rgbToHsl(red:number,green:number,blue:number){
  const r=red/255,g=green/255,b=blue/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  const lightness=(max+min)/2;
  if(delta===0)return {hue:0,saturation:0,lightness};
  const saturation=delta/(1-Math.abs(2*lightness-1));
  let hue=max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4;
  hue=(hue/6+1)%1;
  return {hue,saturation,lightness};
}

function hslToHex(hue:number,saturation:number,lightness:number){
  const h=((hue%1)+1)%1,s=clamp(saturation),l=clamp(lightness);
  const channel=(n:number)=>{
    const k=(n+h*12)%12;
    const value=l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));
    return Math.round(255*value).toString(16).padStart(2,'0');
  };
  return '#'+channel(0)+channel(8)+channel(4);
}

function rgbToHex(red:number,green:number,blue:number){
  return '#'+[red,green,blue].map(value=>Math.round(clamp(value/255)*255).toString(16).padStart(2,'0')).join('');
}

/** Keep the cover's hue, but use it as a restrained tint rather than a full-bleed image palette. */
export function mapSkillCardThemeFromColor(red:number,green:number,blue:number):MapSkillCardTheme{
  const {hue,saturation}=rgbToHsl(red,green,blue);
  const tintSaturation=Math.min(.82,saturation*.9+.18);
  const coverTint=hslToHex(hue,tintSaturation,.61);
  const contrastTint=hslToHex(hue+.5,tintSaturation,.61);
  return {
    // The page remains a shared neutral charcoal. The beatmap only contributes
    // a restrained atmospheric tint through --cover-tint in map.css.
    paper:'#1a1d22',
    panel:'#23262b',
    rule:'#3c4148',
    ruleSoft:'#30353c',
    coverTint,
    contrastTint,
  };
}

/** Extract a weighted cover hue from a tiny image; dark/white cover borders do not dominate it. */
export async function mapSkillCardThemeFromImageDataUrl(dataUrl:string):Promise<MapSkillCardTheme>{
  if(!dataUrl)return DEFAULT_MAP_THEME;
  const encoded=dataUrl.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/s)?.[1];
  if(!encoded)return DEFAULT_MAP_THEME;
  try{
    const {data,info}=await sharp(Buffer.from(encoded,'base64'))
      .resize(32,32,{fit:'cover'})
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject:true});
    let red=0,green=0,blue=0,totalWeight=0;
    const channels=info.channels||3;
    for(let index=0;index+channels-1<data.length;index+=channels){
      const r=data[index],g=data[index+1]??r,b=data[index+2]??r;
      const {saturation,lightness}=rgbToHsl(r,g,b);
      if(lightness<.035||lightness>.97)continue;
      const weight=.75+saturation*1.35;
      red+=r*weight;green+=g*weight;blue+=b*weight;totalWeight+=weight;
    }
    if(!totalWeight)return DEFAULT_MAP_THEME;
    return mapSkillCardThemeFromColor(red/totalWeight,green/totalWeight,blue/totalWeight);
  }catch{
    return DEFAULT_MAP_THEME;
  }
}

function complementHex(hex:string){
  const channels=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16));
  if(channels.some(value=>!Number.isFinite(value)))return '#20252b';
  return '#'+channels.map(value=>(255-value).toString(16).padStart(2,'0')).join('');
}

function tierBackground(level:number,tierColor:string,mode:'normal'|'inverse'|'hybrid'='normal'){
  const clamped=Math.max(1,Math.min(12,level));
  const base='#14181b';
  const inverse=mode==='inverse'||mode==='hybrid';
  const tint=inverse?complementHex(tierColor):tierColor;
  const energy=tierEnergy(clamped);
  const amount=mode==='inverse'
    ? .018 + energy*.025
    : .006 + energy*.024;
  const paper=mixHex(base,mode==='inverse'?tint:tierColor,amount);
  return {paper,panel:mixHex(paper,'#ffffff',.045),rule:mixHex(paper,'#ffffff',.14),ruleSoft:mixHex(paper,'#ffffff',.085)};
}

function sampleCounts(sample:any){
  if(Array.isArray(sample?.modCounts))return Object.entries(Object.fromEntries(sample.modCounts.map((item:any)=>[String(item.mods||'NM'),finite(item.count)])));
  return Object.entries(sample?.modCounts||{});
}

function evidenceRows(rows:any[],top:any):string{
  return rows.map((row:any)=>`<div class="evidence-row" data-beatmap-id="${esc(row.beatmapId)}"><span class="bp-number">#${fmt(row.rank)}</span><div class="evidence-title"><b>${esc(row.title)}</b><small>${esc(row.version)}</small></div><div class="mod">${esc(row.mods?.join('')||'NM')}</div><div class="score-data"><b>${n(row.accuracy,2)}<em>%</em></b><small>${fmt(numeric(row.pp)===null?null:Math.round(row.pp))} pp</small></div><div class="evidence-value"><b style="color:${top.color}">${n(row.axes?.[top.key])}</b><small>${top.abbr} OUTPUT${top.unit==='independent'?' /10':''}</small></div></div>`).join('');
}

function playerBpEvidence(rows:any[],top:any,sampleLabel:string):string{
  const items=[...(rows||[])]
    .filter((row:any)=>numeric(row?.rank)!==null)
    .sort((left:any,right:any)=>finite(left.rank)-finite(right.rank))
    .slice(0,3);
  const cards=items.map((row:any)=>`<div class="bp-evidence-card" data-beatmap-id="${esc(row.beatmapId)}">
    <div class="bp-card-top"><b>#${fmt(row.rank)}</b><span>${esc(row.mods?.join('')||'NM')}</span><strong>${fmt(numeric(row.pp)===null?null:Math.round(row.pp))} pp</strong></div>
    <div class="bp-card-title" title="${esc(row.title||'')}">${esc(row.title||`BID ${row.beatmapId||'—'}`)}</div>
    <div class="bp-card-meta"><span>${n(row.accuracy,2)}%</span><span>${n(row.axes?.[top.key])} ${esc(top.abbr)}</span><em>${esc(top.label)}</em></div>
  </div>`).join('');
  return `<section class="bp-evidence"><div class="bp-evidence-label"><b>BP EVIDENCE</b><span>${esc(sampleLabel)}</span></div>${cards||'<div class="bp-evidence-empty">NO VALID BP EVIDENCE</div>'}</section>`;
}

function playerPage(payload:any,avatar:string){
  const user=payload.player||{};
  const profile=payload.profile||{};
  const p={...profile,player:{...user,statistics:{global_rank:user.globalRank,country_rank:user.countryRank,pp:user.pp}},rows:(payload.rows||[]).map((row:any)=>({...row,accuracy:finite(row.accuracy)/100}))};
  if(!Array.isArray(p.axes)||p.axes.length!==9)throw Error('PLAYER_SKILL_PROFILE_AXES_INVALID');
  const actualView=ratingPresentation(p);
  const previewTierLevel=numeric(payload.previewTier);
  const previewTier=previewTierLevel===null?null:RATING_TIERS[Math.max(0,Math.min(RATING_TIERS.length-1,Math.round(previewTierLevel)-1))];
  const view=previewTier
    ? {...actualView,tier:previewTier,value:numeric(payload.previewRating)??actualView.value,honor:null}
    : actualView;
  const mark=view.specialty;
  const roman=['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'][Math.max(0,(view.tier?.level||1)-1)];
  const top=[...p.axes].sort((left:any,right:any)=>right.ceiling-left.ceiling||right.median-left.median||allKeys.indexOf(left.key)-allKeys.indexOf(right.key))[0];
  const topDef=defs[top.key]||defs.jump_aim;
  const axesByKey=Object.fromEntries(p.axes.map((axis:any)=>[axis.key,axis]));
  const tierLabel=view.rated&&view.tier?`TIER ${roman} · ${view.tier.en}`:'UNRATED';
  const title=view.rated?(mark?.label||view.title||profile.profileType||'PROFILE'):'UNRATED';
  const primary=Array.isArray(profile.primaryAxes)?profile.primaryAxes.slice(0,2).map((label:string)=>label==='Micro Precision'||label==='Precision Aim'?'Spatial Precision':label).join(' · '):topDef.label;
  const pp=fmt(numeric(user.pp)===null?null:Math.round(user.pp));
  const sample=payload.sample||{};
  const tierColor=view.rated?String(view.tier?.color||'#aeb5ad'):'#aeb5ad';
  const tierLevel=view.rated?view.tier?.level||1:1;
  const tierMaterial=view.rated?String(view.tier?.material||'flat'):'flat';
  const tierEnergyValue=tierEnergy(tierLevel);
  const radarColor=view.rated?tierAccentColor(tierColor,view.tier?.level||1):tierColor;
  const tierEmblemKey=view.rated
    ? tierLevel===12?'prism':roman.toLowerCase()
    : '';
  const tierEmblemDataUrl=tierEmblemDataUrls[tierEmblemKey]||'';
  const tierEmblem=view.rated&&tierEmblemDataUrl
    ? `<img class="tier-emblem" src="${tierEmblemDataUrl}" alt="" aria-hidden="true">`
    : '';
  const previewBackgroundMode=payload.previewBackgroundMode==='inverse'||payload.previewBackgroundMode==='hybrid'
    ? payload.previewBackgroundMode
    : payload.previewInverseBackground===true?'inverse':'hybrid';
  const background=tierBackground(tierLevel,view.rated?tierColor:String(RATING_TIERS[0].color),previewBackgroundMode);
  const radar=radarSvg(axesByKey,'player',radarColor,view.rated?view.tier?.level||1:1);
  const ppPlus=payload.ppPlus&&typeof payload.ppPlus==='object'?payload.ppPlus:null;
  const ppPlusRadar=ppPlus
    ? pplusRadarSvg(ppPlus,radarColor,tierLevel)
    : '<div class="no-pplus">PP+ DATA UNAVAILABLE</div>';
  const sampleLabel=`${finite(sample.valid)}/${finite(sample.requested,50)} VALID`;
  const inactive=user.isActive===false&&user.isRanked===false&&user.isDeleted!==true;
  const visitDate=inactive&&user.lastVisit?new Date(user.lastVisit):null;
  const lastVisit=visitDate&&Number.isFinite(visitDate.getTime())?visitDate.toLocaleString('en-US',{month:'short',year:'numeric',timeZone:'UTC'}).toUpperCase():'';
  const identityMeta=inactive
    ? `UNRANKED · ${pp} pp · ${n(user.accuracy,2)}%`
    : `GLOBAL ${rank(user.globalRank)} · COUNTRY ${rank(user.countryRank)} · ${pp} pp · ${n(user.accuracy,2)}%`;
  const activityNote=inactive?`<div class="activity-note"><b>INACTIVE</b>${lastVisit?`<span>LAST VISIT · ${esc(lastVisit)}</span>`:''}</div>`:'';
  return {top:top.key,rating:view.rated?view.value:null,tier:view.rated?view.tier?.level||0:0,specialty:mark?.label||null,reps:(payload.rows||[]).slice(0,2).map((row:any)=>row.beatmapId),html:`<main class="sheet radar-sheet player-sheet" style="--paper:${background.paper};--panel:${background.panel};--rule:${background.rule};--rule-soft:${background.ruleSoft};--rank-color:${radarColor};--radar-color:${radarColor};--accent:${topDef.color};--tier-energy:${tierEnergyValue.toFixed(3)};--tier-rule-width:${(1+tierEnergyValue*2.2).toFixed(2)}px;--tier-score-size:${(30+tierEnergyValue*5).toFixed(1)}px" data-rating-policy="${esc(view.ratingPolicy)}" data-tier="${view.rated?view.tier?.level||0:0}" data-tier-material="${esc(tierMaterial)}">
    <header class="page-header">
      ${brand('PLAYER PROFILE')}
      <div class="identity-row">
        ${avatar?`<img class="avatar" src="${esc(avatar)}" alt="${esc(user.username)} avatar">`:`<div class="avatar avatar-placeholder">${esc(String(user.username||'SP').slice(0,2).toUpperCase())}</div>`}
        <div class="identity-copy"><div class="eyebrow">OSU! STANDARD · ${esc(String(user.countryCode||'—').toUpperCase())}</div><h1>${esc(user.username||'Unknown')}</h1><div class="identity-meta">${identityMeta}</div>${activityNote}</div>
        <div class="identity-stat rating-stat"><span>SKILL RATING</span><b>${view.rated?fmt(view.value):'—'}</b><small>${esc(view.rated?tierLabel:'INSUFFICIENT EVIDENCE')}</small>${tierEmblem}</div>
        <div class="identity-stat rank-stat"><span>PROFILE SAMPLE</span><b>${esc(sampleLabel)}</b><small>${esc(view.honor?.label||'BP50')}</small></div>
      </div>
    </header>
    <div class="page-grid dual-radar-grid">
      <section class="radar-panel"><div class="panel-head"><b>SKILL PROFILER</b><span>9 DIMENSIONS</span></div>${radar}<div class="radar-key"><span><i class="key-solid"></i>WEIGHTED P80</span><span><i class="key-dashed"></i>WEIGHTED P50</span></div><div class="unit-note">Experimental equivalent ★ · Stamina / Endurance: independent /10.<br>Display-only radar. Different units; area is not an overall rating.</div></section>
      <section class="radar-panel ppplus-panel"><div class="panel-head"><b>PP+ PROFILE</b><span>6 DIMENSIONS</span></div>${ppPlusRadar}<div class="radar-key"><span><i class="key-solid"></i>PP+ DISPLAY</span><span><i class="key-dashed"></i>15 EXPERTPLUS</span></div><div class="unit-note">PP+ display bars · 15 = ExpertPlus benchmark.<br>Relative shape inside PP+ only; polygon area is not an overall rating.</div></section>
    </div>
    ${playerBpEvidence(payload.rows,topDef,sampleLabel)}
    ${foot('PLAYER PROFILE · '+(profile.profilerIdentity?.mapDemandVersion||'RATING PROFILE'),`${String(user.username||'PLAYER')} · ${tierLabel}`)}
  </main>`};
}

function groupEvidence(items:any[],axes:any){
  const local=items.filter(item=>item.available&&starKeys.includes(item.key)).sort((left,right)=>finite(left.start)-finite(right.start));
  const groups:any[]=[];
  for(const item of local){const last=groups.at(-1);if(last&&finite(item.start)<=last.end){last.end=Math.max(last.end,finite(item.end));last.items.push(item);}else groups.push({start:finite(item.start),end:finite(item.end),items:[item]});}
  const groupScore=(group:any)=>Math.max(...group.items.map((item:any)=>axisValue(axes,item.key,'stars')??-Infinity));
  return groups.sort((left,right)=>groupScore(right)-groupScore(left)||left.start-right.start).slice(0,3).sort((left,right)=>left.start-right.start);
}

function evidenceKind(group:any){
  if(group.items.length>1)return 'OVERLAPPING SUPPORT';
  const raw=String(group.items[0]?.kind||'').toLowerCase();
  if(raw.includes('连续')||raw.includes('持续'))return 'SUSTAINED SUPPORT';
  return 'LOCAL EVIDENCE';
}

function evidenceExtra(value:unknown){
  const raw=String(value||'');
  return raw.includes('全图')?'ADDITIONAL FULL-MAP SUPPORT':raw;
}

function mapTimeline(evidence:any[],end:number):string{
  const x=(value:number)=>105+Math.min(end,Math.max(0,value))/end*420;
  const lanes=evidence.map((item:any,index:number)=>{const d=defs[item.key],y=15+index*16;return `<text x="0" y="${y+4}" class="lane-label">${esc(d.label)}</text><line x1="105" x2="525" y1="${y}" y2="${y}" stroke="var(--rule-soft)"/>${item.available?`<rect x="${x(finite(item.start))}" y="${y-4}" width="${Math.max(4,x(finite(item.end))-x(finite(item.start)))}" height="8" rx="2" fill="${d.color}"/><circle cx="${x(finite(item.start))}" cy="${y}" r="2.8" fill="${d.color}"/>`:`<text x="300" y="${y+4}" text-anchor="middle" class="timeline-empty">NO EVIDENCE</text>`}`;}).join('');
  const ticks=Array.from({length:5},(_,index)=>index*end/4);
  return `<svg class="multi-timeline" viewBox="0 0 560 180" role="img" aria-label="Key evidence timeline"><g>${ticks.map((tick,index)=>`<line x1="${x(tick)}" x2="${x(tick)}" y1="6" y2="154" stroke="var(--rule)" stroke-opacity=".55" stroke-dasharray="2 5"/><text x="${x(tick)}" y="174" text-anchor="${index===0?'start':index===4?'end':'middle'}">${time(tick)}</text>`).join('')}</g>${lanes}</svg>`;
}

function mapPage(payload:any,background:string,theme:MapSkillCardTheme=DEFAULT_MAP_THEME){
  const analysis=payload.analysis||{};
  const official=payload.official||{};
  const axes=analysis.axes||{};
  const unified=analysis.unified_measurements||{};
  const unifiedAttached=unified.status==='ATTACHED';
  const unifiedAxis=(key:string)=>{
    const axis=axes[key]||{};
    const status=String(axis.unified_star_status||'').toUpperCase();
    const value=axisValue(axes,key,'unified_star_equivalent');
    return {axis,status,value,ready:status==='ADMITTED'&&value!==null};
  };
  // Candidate calibration is evidence attached to the analysis, not a
  // formally admitted replacement scale. A common radar frame is only safe
  // when every axis is present and ADMITTED; otherwise keep the entire main
  // display on the deterministic v0.40 values instead of mixing scales.
  const useUnifiedFrame=unifiedAttached&&allKeys.every((key)=>unifiedAxis(key).ready);
  const candidateCount=unifiedAttached
    ? allKeys.filter((key)=>unifiedAxis(key).status==='CANDIDATE'&&unifiedAxis(key).value!==null).length
    : 0;
  const rawFallbackAxes=Object.fromEntries(allKeys.map((key)=>{
    const axis=axes[key]||{};
    const raw=axisValue(axes,key,'stars');
    const independent=String(axis.unit||'')==='bounded_0_10';
    return [key,{...axis,stars:raw,unit:independent?'independent':'star',displayUnit:independent?'independent':'star',displayKind:raw===null?'missing':'raw'}];
  }));
  const displayAxes=useUnifiedFrame
    ? Object.fromEntries(allKeys.map(key=>{
        const {axis,value}=unifiedAxis(key);
        return [key,{...axis,stars:value,unit:'star',displayUnit:'star',displayKind:'unified'}];
      }))
    : unifiedAttached ? rawFallbackAxes : axes;
  const labelAxes=displayAxes;
  const artist=String(analysis.beatmap?.artist||'').toUpperCase();
  const creator=String(analysis.beatmap?.creator||'').toUpperCase();
  const mods=Array.isArray(payload.mods)&&payload.mods.length?payload.mods:['NM'];
  const leadSource=displayAxes;
  const lead=[...allKeys].sort((left,right)=>(axisValue(leadSource,right,'stars')??-Infinity)-(axisValue(leadSource,left,'stars')??-Infinity)||allKeys.indexOf(left)-allKeys.indexOf(right));
  const topDef=defs[lead[0]]||defs.flow_aim;
  const diff=analysis.analysis_context?.effective_difficulty||analysis.analysis_context?.difficulty||{};
  const duration=numeric(analysis.analysis_context?.duration_ms);
  const evidence=def.map(({key})=>analysis.key_sections?.find((item:any)=>item.key===key)||{key,available:false,kind:'NO EVIDENCE'});
  const groups=groupEvidence(evidence,unifiedAttached?labelAxes:axes);
  const maxEnd=Math.max(1,duration??0,...(analysis.experimental_type?.sections||[]).map((item:any)=>finite(item.end_ms)),...evidence.map((item:any)=>finite(item.end)));
  const cards=groups.map((group:any,index:number)=>`<div class="key-card"><div class="key-index">${String(index+1).padStart(2,'0')}</div><div><b class="key-time">${precise(group.start)} — ${precise(group.end)}</b><div class="key-tags">${group.items.map((item:any)=>`<span style="color:${defs[item.key].color}">${esc(defs[item.key].label)}</span>`).join('')}</div><small>${evidenceKind(group)}${group.items.some((item:any)=>item.extra)?' · '+esc(evidenceExtra(group.items.find((item:any)=>item.extra).extra)):''}</small></div></div>`).join('');
  const originalStars=payload.stars;
  const title=String(analysis.beatmap?.title||'Unknown beatmap');
  const version=String(analysis.beatmap?.version||'');
  const starText=originalStars===null||originalStars===undefined?'—':Number(originalStars).toFixed(2);
  const stats=[['BPM',n(analysis.analysis_context?.bpm_max)],['CS',n(diff.CircleSize)],['AR',n(diff.ApproachRate)],['OD',n(diff.OverallDifficulty)],['LENGTH',time(duration)],['OBJECTS',fmt(payload.objectCount??analysis.beatmap?.metadata?.counts?.objects)]];
  const leadValue=axisValue(leadSource,topDef.key,'stars');
  const leadAxis=labelAxes[topDef.key]||{};
  const leadRaw=unifiedAttached&&!useUnifiedFrame&&leadAxis.displayKind==='raw';
  const leadMarker=leadRaw?'<span class="confidence-marker">R</span>':'';
  const leadMarkerText=leadRaw?' R':'';
  const leadPrefix=leadRaw&&leadValue!==null?'≈':'';
  const rawCount=unifiedAttached&&!useUnifiedFrame?allKeys.filter(key=>labelAxes[key]?.displayKind==='raw').length:0;
  const missingCount=unifiedAttached&&!useUnifiedFrame?allKeys.filter(key=>labelAxes[key]?.displayKind==='missing').length:0;
  const confidenceNote=useUnifiedFrame
    ? 'UNIFIED EVIDENCE ATTACHED'
    : candidateCount>0
      ? `CANDIDATE UNIFIED NOT USED · V0.40 RAW DEMAND${rawCount?` · ${rawCount} AXES`:''}`
      : rawCount>0
        ? `RAW ESTIMATE / LOW CONFIDENCE · ${rawCount} AXES`
        : missingCount>0
          ? `INSUFFICIENT EVIDENCE · ${missingCount} AXES`
          : 'NO UNIFIED EVIDENCE';
  const unitNote=useUnifiedFrame
    ? 'ADMITTED UNIFIED STAR DEMAND · R  RAW ESTIMATE / LOW CONFIDENCE · —  INSUFFICIENT EVIDENCE'
    : candidateCount>0
      ? 'C  CANDIDATE UNIFIED (NOT USED) · R  RAW MAP DEMAND / LOW CONFIDENCE · —  INSUFFICIENT EVIDENCE'
      : unifiedAttached
        ? 'R  RAW MAP DEMAND / LOW CONFIDENCE · —  INSUFFICIENT EVIDENCE'
        : 'Core skill dimensions use equivalent star ratings. Stamina / Endurance remain independent /10 indices.';
  const leadSuffix=leadValue===null||leadRaw||topDef.unit==='independent'?'':'★';
  const demandFooter=useUnifiedFrame
    ? 'UNIFIED STAR DEMAND'
    : unifiedAttached
      ? candidateCount>0?'V0.40 DEMAND · CANDIDATE SUPPRESSED':'V0.40 DEMAND · UNIFIED INCOMPLETE'
      : 'V0.40 DEMAND';
  return {top:topDef.key,evidence,groups,originalStars,officialSource:official,html:`<main class="sheet radar-sheet map-sheet" style="--paper:${theme.paper};--panel:${theme.panel};--rule:${theme.rule};--rule-soft:${theme.ruleSoft};--cover-tint:${theme.coverTint};--contrast-tint:${theme.contrastTint};--accent:${topDef.color}">
    <header class="page-header">
      ${brand('BEATMAP PROFILE')}
      <div class="map-top"><div class="map-cover-frame">${background?`<img class="map-cover" src="${background}" alt="">`:'<div class="cover-placeholder" aria-label="cover unavailable">COVER<br>UNAVAILABLE</div>'}</div><div class="map-copy"><div class="eyebrow">${esc(artist)} · MAPPED BY ${esc(creator)}</div><h1>${esc(title)}</h1><div class="difficulty-name">[${esc(version)}]</div><div class="map-id-line"><span>BID ${esc(analysis.beatmap?.beatmap_id||'—')}</span>${mods.map((mod:string)=>`<span class="mod">${esc(mod)}</span>`).join('')}</div></div><div class="star-stat"><span>${esc(payload.starRatingLabel||'OSU! ORIGINAL STAR')}</span><b>${esc(starText)}<em>★</em></b><small>${mods.join('')||'NM'}${mods.length&&numeric(payload.nomodStars)!==null?` · NM ${Number(payload.nomodStars).toFixed(2)}★`:''}</small></div></div>
      <div class="map-stats">${stats.map(([key,value])=>`<div><span>${key}</span><b>${value}</b></div>`).join('')}</div>
    </header>
    <div class="page-grid">
      <section class="radar-panel"><div class="panel-head"><b>MAP DEMAND</b><span>${esc(mods.join('')||'NM')} · 9 DIMENSIONS</span></div><div class="lead-line"><span>PRIMARY DEMAND</span><b style="color:${topDef.color}">${esc(topDef.label)}</b><strong style="color:${topDef.color}">${leadPrefix}${n(leadValue)}${leadSuffix}${leadMarker}</strong></div>${radarSvg(displayAxes,'map',theme.contrastTint,5,useUnifiedFrame,theme.coverTint,labelAxes)}<div class="unit-note">${esc(unitNote)}</div></section>
      <section class="detail-panel"><div class="evidence-head">${section('KEY EVIDENCE',`${groups.length} sections`)}</div>${mapTimeline(evidence,maxEnd)}<div class="timeline-note"><span>SHORT · LOCAL EVIDENCE</span><span>LONG · SUSTAINED SUPPORT</span></div><div class="key-cards">${cards||'<div class="no-evidence">No complete-map evidence available</div>'}</div><div class="detail-note"><span>Experimental demand analysis · ${analysis.identity?.map_demand_version||'v1.0.1'}</span><span>${analysis.warnings?.length?'WARNINGS PRESENT':unifiedAttached?confidenceNote:'NO WARNINGS'}</span></div></section>
    </div>
    ${foot(`BEATMAP PROFILE · ${demandFooter}`,`${topDef.label} ${leadPrefix}${n(leadValue)}${leadSuffix}${leadMarkerText}`)}
  </main>`};
}

const playerCss=fs.readFileSync(new URL('./player.css',import.meta.url),'utf8');
const mapCss=fs.readFileSync(new URL('./map.css',import.meta.url),'utf8');
const document=(body:string,kind:'player'|'map')=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1280"><style>${skillCardFontFace()}${kind==='player'?playerCss:mapCss}</style></head><body>${body}</body></html>`;

export const buildPlayerSkillCardHtml=(payload:any,avatar='')=>document(playerPage(payload,avatar).html,'player');
export const buildMapSkillCardHtml=(payload:any,background='',theme:MapSkillCardTheme=DEFAULT_MAP_THEME)=>document(mapPage(payload,background,theme).html,'map');

export async function renderPlayerSkillProfileCard(payload:any):Promise<Buffer>{
  const avatar=await imageDataUrl(payload.player?.avatarUrl,payload.player?.osuId);
  return renderSkillCardHtml(buildPlayerSkillCardHtml(payload,avatar));
}

export async function renderMapSkillCard(payload:any):Promise<Buffer>{
  const background=await imageDataUrl(payload.coverUrl);
  const theme=await mapSkillCardThemeFromImageDataUrl(background);
  return renderSkillCardHtml(buildMapSkillCardHtml(payload,background,theme));
}
