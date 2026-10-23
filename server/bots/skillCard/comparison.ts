import fs from 'node:fs';
import {PLAYER_SKILL_AXIS_DEFINITIONS} from '../playerSkillAxes.js';
import {buildSkillCardDocument,playerSkillCardIdentity} from './cards.js';
import {renderSkillCardHtml} from './browser.js';
import {imageDataUrl} from './images.js';

const css=fs.readFileSync(new URL('./comparison.css',import.meta.url),'utf8');
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numeric=(value:unknown):number|null=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))||Number(value)<0?null:Number(value);
const number=(value:number|null,digits=1)=>value===null?'—':value.toFixed(digits);
type Identity=ReturnType<typeof playerSkillCardIdentity>;
type Axis={key:string;label:string;unit:string};
const ppPlusAxes:Axis[]=['Jump','Flow','Speed','Stamina','Precision','Accuracy'].map(label=>({key:label.toLowerCase(),label,unit:'ppplus'}));

function toHsl(color:string):[number,number,number]{
  const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min,l=(max+min)/2;
  if(!delta)return [0,0,l];
  const h=max===r?(g-b)/delta+(g<b?6:0):max===g?(b-r)/delta+2:(r-g)/delta+4;
  return [h*60,delta/(1-Math.abs(2*l-1)),l];
}

function fromHsl(h:number,s:number,l:number):string{
  const a=s*Math.min(l,1-l);
  return '#'+[0,8,4].map(n=>{
    const k=(n+h/30)%12;
    return Math.round((l-a*Math.max(-1,Math.min(k-3,9-k,1)))*255).toString(16).padStart(2,'0');
  }).join('');
}

function comparisonColors(left:Identity,right:Identity){
  const comparable=left.view.rated&&right.view.rated;
  const sameTier=comparable&&left.tierLevel===right.tierLevel;
  const leader=!comparable?'unrated':left.view.value===right.view.value?'tie':left.view.value>right.view.value?'a':'b';
  let a=left.tierColor,b=right.tierColor;
  if(sameTier&&(leader==='a'||leader==='b')){
    const [h,s,l]=toHsl(a),neutral=s<.12;
    // Pale metals keep their neutral identity; saturation alone would turn silver blue.
    const vivid=fromHsl(h,Math.min(.96,s+Math.min(.38,s*1.2)),neutral?Math.max(.83,l):l>.7?Math.max(.66,l-.09):Math.min(.64,Math.max(.54,l)));
    const muted=fromHsl(h,s*.6,neutral?.53:Math.min(.8,l+.12));
    [a,b]=leader==='a'?[vivid,muted]:[muted,vivid];
  }
  return {a,b,leader,sameTier};
}

function backdrop(left:string,right:string):string{
  return `<svg class="tier-backdrop" viewBox="0 0 1280 720" aria-hidden="true"><defs><linearGradient id="quiet-field" x1="0" y1="0" x2="1280" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="${left}" stop-opacity=".22"/><stop offset=".2" stop-color="${left}" stop-opacity=".14"/><stop offset=".42" stop-color="${left}" stop-opacity=".025"/><stop offset=".5" stop-color="${left}" stop-opacity="0"/><stop offset=".58" stop-color="${right}" stop-opacity=".025"/><stop offset=".8" stop-color="${right}" stop-opacity=".14"/><stop offset="1" stop-color="${right}" stop-opacity=".22"/></linearGradient></defs><rect width="1280" height="720" fill="#14171b"/><rect width="1280" height="720" fill="url(#quiet-field)"/></svg>`;
}

function side(identity:Identity,other:Identity,key:'a'|'b',color:string):string{
  const delta=identity.view.rated&&other.view.rated?identity.view.value-other.view.value:null;
  const label=delta===null?'—':`${delta>0?'+':delta<0?'−':''}${Math.abs(delta)}`;
  return `<aside class="player-side side-${key}" data-tier="${identity.view.rated?identity.tierLevel:0}" style="--rank-color:${color};--radar-color:${color};--series-color:${color}">${identity.html}<div class="rating-gap">${label}<span>SKILL RATING DIFFERENCE</span></div></aside>`;
}

function radar(kind:'skill'|'pplus',payload:any,identities:Identity[],colors:string[]):string{
  const skill=kind==='skill',axes:readonly Axis[]=skill?PLAYER_SKILL_AXIS_DEFINITIONS:ppPlusAxes;
  const values=(side:any,field:string,rated:boolean)=>(axes.map(axis=>{
    if(skill)return rated?numeric(side.profile?.axes?.find((a:any)=>a.key===axis.key)?.[field]):null;
    const raw=side.ppPlus?.[axis.key];
    return numeric(raw&&typeof raw==='object'?raw.value:raw);
  }));
  const primary=[values(payload.left,'ceiling',identities[0].view.rated),values(payload.right,'ceiling',identities[1].view.rated)];
  const medians=[values(payload.left,'median',identities[0].view.rated),values(payload.right,'median',identities[1].view.rated)];
  // /10 indices have their own scale and must not stretch the star axes.
  const valid=primary.flatMap(v=>v.filter((n,i):n is number=>n!==null&&axes[i].unit!=='independent'));
  const max=Math.max(skill?10:15,Math.ceil(Math.max(0,...valid)*1.04*2)/2);
  const maxima=axes.map(axis=>axis.unit==='independent'?10:max);
  const count=axes.length,cx=340,cy=121,radius=skill?83:85,labelRadius=skill?111:112;
  const point=(i:number,value:number)=>{
    const angle=-Math.PI/2+i*2*Math.PI/count,factor=Math.min(1,Math.max(0,value/maxima[i]));
    return [cx+Math.cos(angle)*radius*factor,cy+Math.sin(angle)*radius*factor];
  };
  const polygon=(v:number[])=>v.map((n,i)=>point(i,n).map(x=>x.toFixed(2)).join(',')).join(' ');
  const shape=(v:(number|null)[],attributes:string,fill=false)=>{
    if(!v.includes(null))return `<polygon points="${polygon(v as number[])}" ${attributes}/>`;
    if(fill)return '';
    // Never close missing evidence through zero, or connect across an unknown axis.
    return v.map((n,i)=>{
      const next=(i+1)%count;
      return n===null||v[next]===null?'':`<path d="M${point(i,n).join(' ')}L${point(next,v[next]!).join(' ')}" ${attributes}/>`;
    }).join('');
  };
  let content=[.25,.5,.75,1].map(r=>`<polygon points="${polygon(maxima.map(v=>v*r))}" fill="none" stroke="#84959d" stroke-opacity="${r===1?.24:.11}"/>`).join('');
  content+=maxima.map((v,i)=>`<path d="M${cx} ${cy}L${point(i,v).join(' ')}" stroke="#84959d" stroke-opacity=".13"/>`).join('');
  if(!skill)content+=`<polygon points="${polygon(maxima.map(()=>15))}" fill="none" stroke="#c1c8c2" stroke-opacity=".45" stroke-width="1.1" stroke-dasharray="4 4"/>`;
  primary.forEach((v,i)=>{content+=shape(v,`fill="${colors[i]}" fill-opacity="${i===0?.075:.035}"`,true);});
  if(skill)medians.forEach((v,i)=>{content+=shape(v,`class="median-series" fill="none" stroke="${colors[i]}" stroke-opacity=".34" stroke-width="1" stroke-dasharray="3 4"`);});
  primary.forEach((v,index)=>{
    const color=colors[index],key=index===0?'a':'b';
    content+=shape(v,'fill="none" stroke="#08131b" stroke-opacity=".85" stroke-width="5.4" stroke-linejoin="round"');
    content+=shape(v,`class="profile-series ${key}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linejoin="round"`);
    content+=v.map((n,i)=>{
      if(n===null)return '';
      const [x,y]=point(i,n);
      return index===0?`<circle class="series-dot a" data-marker="circle" cx="${x}" cy="${y}" r="3.5" fill="${color}" stroke="#0d171e" stroke-width="1.2"/>`:`<path class="series-dot b" data-marker="diamond" d="M${x} ${y-4.2}L${x+4.2} ${y}L${x} ${y+4.2}L${x-4.2} ${y}Z" fill="#0d171e" stroke="${color}" stroke-width="1.8"/>`;
    }).join('');
  });
  content+=axes.map((axis,i)=>{
    const angle=-Math.PI/2+i*2*Math.PI/count,cos=Math.cos(angle),sin=Math.sin(angle);
    const x=cx+cos*labelRadius,y=cy+sin*labelRadius,anchor=cos>.2?'start':cos<-.2?'end':'middle';
    return `<text data-axis-label="${axis.key}" data-unit="${axis.unit}" x="${x}" y="${y}" text-anchor="${anchor}" fill="#edf1f0" font-size="13" font-weight="650">${esc(axis.label)}</text><text class="axis-value" x="${x}" y="${y+16}" text-anchor="${anchor}" font-size="12" font-weight="650"><tspan fill="${colors[0]}" font-size="9">A </tspan><tspan fill="${colors[0]}">${number(primary[0][i],skill?1:2)}</tspan><tspan fill="#657279"> · </tspan><tspan fill="${colors[1]}" font-size="9">B </tspan><tspan fill="${colors[1]}">${number(primary[1][i],skill?1:2)}</tspan><tspan fill="#86939b" font-size="9">${axis.unit==='independent'?'  /10':''}</tspan></text>`;
  }).join('');
  return `<svg class="compare-radar ${kind}-radar" data-scale-max="${max}" viewBox="0 0 680 252" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
}

export function buildPlayerSkillComparisonHtml(payload:Record<string,any>,leftAvatar='',rightAvatar=''):string{
  const label=(key:string)=>`<div class="player-label"><i class="marker ${key}"></i>PLAYER ${key.toUpperCase()}</div>`;
  const left=playerSkillCardIdentity(payload.left,leftAvatar,label('a')),right=playerSkillCardIdentity(payload.right,rightAvatar,label('b'));
  const {a,b,leader,sameTier}=comparisonColors(left,right);
  const legend=()=>`<div class="player-legend">${[payload.left,payload.right].map((p,i)=>`<span style="--series-color:${i===0?a:b}"><i class="legend-line ${i===0?'a':'b'}"></i><em>${i===0?'A':'B'}</em><span class="legend-name">${esc(p.player?.username||'Unknown')}</span></span>`).join('')}</div>`;
  const body=`<main class="sheet comparison-sheet" data-design="tier-radar-v3" data-tier-left="${left.view.rated?left.tierLevel:0}" data-tier-right="${right.view.rated?right.tierLevel:0}" data-unified="${sameTier}" data-rating-leader="${leader}" data-left-color="${a}" data-right-color="${b}" data-left-rating="${left.view.rated?left.view.value:''}" data-right-rating="${right.view.rated?right.view.value:''}">
${backdrop(a,b)}${side(left,right,'a',a)}<div class="compare-center">
<section class="compare-panel"><div class="panel-head"><b>SKILL PROFILER</b>${legend()}</div><div class="chart-box">${radar('skill',payload,[left,right],[a,b])}</div><div class="compare-key"><div class="pair"><span><i class="line"></i>P80</span><span><i class="line dashed"></i>P50</span></div><span>9 DIMENSIONS · BP50 · VALUES: P80</span><span>STAMINA / ENDURANCE: /10</span></div></section>
<section class="compare-panel"><div class="panel-head"><b>PP+ PROFILE</b>${legend()}</div><div class="chart-box">${radar('pplus',payload,[left,right],[a,b])}</div><div class="compare-key"><div class="pair"><span><i class="line dashed"></i>15 EXPERTPLUS</span></div><span>6 DIMENSIONS</span><span class="source-note">PP+ ALGORITHM · ALOIC</span></div></section>
</div>${side(right,left,'b',b)}</main>`;
  return buildSkillCardDocument(body,'player',css);
}

export async function renderPlayerSkillComparisonCard(payload:Record<string,any>):Promise<Buffer>{
  const [left,right]=await Promise.all([imageDataUrl(payload.left?.player?.avatarUrl,payload.left?.player?.osuId),imageDataUrl(payload.right?.player?.avatarUrl,payload.right?.player?.osuId)]);
  return renderSkillCardHtml(buildPlayerSkillComparisonHtml(payload,left,right));
}
