import fs from 'node:fs';
import {ratingPresentation} from './presentation.js';
import {imageDataUrl} from './images.js';
import {renderSkillCardHtml,skillCardFontFace} from './browser.js';
export const SKILL_CARD_DESIGN_VERSION='PROFILE_20260906_RATING_TITLES_V2';
const playerCss=fs.readFileSync(new URL('./player.css',import.meta.url),'utf8');
const mapCss=fs.readFileSync(new URL('./map.css',import.meta.url),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>v!=null&&Number.isFinite(Number(v))?Number(v).toFixed(1):'—',fmt=v=>v!=null&&Number.isFinite(Number(v))?Number(v).toLocaleString('en-US'):'—';
const regionNames=new Intl.DisplayNames(['zh-CN'],{type:'region',fallback:'none'});
const regionNameOverrides={HK:'中国香港',MO:'中国澳门',TW:'中国台湾'};
const regionName=code=>/^[A-Z]{2}$/.test(code)?regionNameOverrides[code]||regionNames.of(code)||'未知地区':'未知地区';
const time=ms=>`${Math.floor(ms/60000).toString().padStart(2,'0')}:${Math.floor(ms/1000%60).toString().padStart(2,'0')}`;
const precise=ms=>time(ms)+'.'+Math.round(ms%1000).toString().padStart(3,'0');
const def=[
 ['flow_aim','Flow Aim','连续瞄准','FL','#72edc5'],['jump_aim','Jump Aim','跳跃瞄准','JP','#76b3ed'],
 ['aim_control','Aim Control','瞄准控制','AC','#eab885'],['spatial_precision','Precision Aim','空间精度','PR','#c1a9f0'],
 ['raw_speed','Raw Speed','击打速度','SP','#f3d786'],['finger_control','Finger Control','指法控制','FC','#e9a8be'],
 ['reading','Reading','读图','RD','#a8c9d0'],['stamina','Stamina','击打体力','ST','#afb4d8'],['endurance','Endurance','全图耐力','EN','#9bcbb8']
];
const defs=Object.fromEntries(def.map(d=>[d[0],{key:d[0],label:d[1],cn:d[2],abbr:d[3],color:d[4]}]));
const starKeys=def.slice(0,7).map(d=>d[0]);
const bar=(v,mid,c,max=15)=>`<div class="track" style="--color:${c};--value:${Math.min(v,max)/max*100}%;--median:${Math.min(mid??v,max)/max*100}%"><div class="ticks"></div><div class="bar-range"></div>${mid!=null?'<span class="median-mark"></span>':''}<span class="value-mark"></span></div>`;
const brand=t=>`<div class="brand"><b>Skill Profiler</b><span>${t}</span></div>`;
const section=(i,t,s)=>`<div class="section-title"><div><span>${i}</span><b>${t}</b></div><small>${s}</small></div>`;
const foot=(s,version='')=>`<footer><div><b>WUXINBOT</b><span>${s}</span></div><div>${new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}).replaceAll('-','.')}<i>·</i>${esc(version)}</div></footer>`;
function skillRows(axes,player,top){return starKeys.map(key=>{
 const d=defs[key],v=player?axes[key].ceiling:axes[key].stars,mid=player?axes[key].median:null;
 return `<div class="skill-row ${key===top?'selected-axis':''}"><div class="skill-name"><span class="abbr" style="color:${d.color}">${d.abbr}</span><div><b>${d.label}</b><small>${d.cn}${key===top?' · 最高维度':''}</small></div></div>${bar(v,mid,d.color)}<div class="numeric" style="color:${key===top?d.color:'#f1f3ef'}">${n(v)}</div>${player?`<div class="secondary-num">${n(mid)}</div>`:''}</div>`;
 }).join('');}
function aux(axes,player,top){return `<div class="aux-grid">${['stamina','endurance'].map(key=>{
 const d=defs[key],v=player?axes[key].ceiling:axes[key].stars,mid=player?axes[key].median:null;
 return `<div class="aux-item"><div class="aux-title"><span style="color:${key===top?d.color:'inherit'}">${d.label}<small>${d.cn}</small></span><div><b>${n(v)}</b><em>/10</em></div></div>${bar(v,mid,d.color,10)}<div class="aux-caption">独立指数${key===top?' · 最高维度':''}<span>${player?'中位 '+n(mid):'0 — 10'}</span></div></div>`;
 }).join('')}</div>`;}
function playerPage(payload: any, avatar: string){
 const u=payload.player||{};
 const p={...payload.profile,player:{...u,statistics:{global_rank:u.globalRank,country_rank:u.countryRank,pp:u.pp}},
  axes:payload.profile.axes,rows:(payload.rows||[]).map(r=>({...r,accuracy:r.accuracy/100})),
  sample:{...payload.sample,modCounts:Object.fromEntries((payload.sample.modCounts||[]).map(x=>[x.mods,x.count]))}};
 if(p.axes.length!==9)throw Error('PLAYER_SKILL_PROFILE_AXES_INVALID');
 const view=ratingPresentation(p),mark=view.specialty;
 const roman=['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'][view.tier.level-1];
 const a=Object.fromEntries(p.axes.map(x=>[x.key,x]));
 const ranked=[...p.axes].sort((x,y)=>y.ceiling-x.ceiling||y.median-x.median||def.findIndex(d=>d[0]===x.key)-def.findIndex(d=>d[0]===y.key));
 const top=ranked[0],d=defs[top.key];
 const reps=[...p.rows].sort((x,y)=>y.axes[top.key]-x.axes[top.key]||x.rank-y.rank).slice(0,2);
 const mods=Object.entries<number>(p.sample.modCounts).sort((x,y)=>y[1]-x[1]);
 const colors=['#72edc5','#76b3ed','#d5bd84','#c1a9f0','#e9a8be','#a8c9d0'];
 const evidence=reps.map(r=>`<div class="evidence-row"><span class="bp-number">#${r.rank}</span><div class="evidence-title"><b>${esc(r.title)}</b><small>${esc(r.version)}</small></div><div class="mod">${r.mods.join('')||'NM'}</div><div class="score-data"><b>${(r.accuracy*100).toFixed(2)}<em>%</em></b><small>${Math.round(r.pp)} pp</small></div><div class="evidence-value"><b style="color:${d.color}">${n(r.axes[top.key])}</b><small>${d.abbr} 表现${['stamina','endurance'].includes(top.key)?' /10':''}</small></div></div>`).join('');
 const countryCode=String(p.player.countryCode||'').trim().toUpperCase();
 const country=regionName(countryCode);
 const pp=fmt(Math.round(p.player.statistics.pp));
 const crown=view.honor?.key==='first'?'<svg class="rank-crown" viewBox="0 0 48 40" aria-hidden="true"><path d="M7 11 17 19 24 6 31 19 41 11 36 30H12Z" fill="currentColor"/><path d="M12 35H36" stroke="currentColor" stroke-width="3"/></svg>':'';
 return {top:top.key,rating:view.value,tier:view.tier.level,specialty:mark?.label||null,reps:reps.map(r=>r.beatmapId),html:`<main class="sheet player-sheet" style="--accent:${d.color};--rank-color:${view.tier.color}" data-rating-policy="${view.ratingPolicy}" data-tier="${view.tier.level}" data-material="${view.tier.material}" data-rank="${view.honor?.key||'ordinary'}"><header class="profile-header"><div class="brand"><b>Skill Profiler</b>${view.honor?`<span class="global-honor">${crown}${esc(view.honor.label)}</span>`:'<span>PLAYER PROFILE</span>'}</div>
 <div class="identity">${avatar?`<img src="${avatar}" alt="${esc(p.player.username)} 头像">`:`<div class="avatar-placeholder">${esc(p.player.username?.slice(0,2)||'SP')}</div>`}<div class="identity-copy"><div class="eyebrow">OSU! STANDARD<i>·</i>${esc(countryCode||'—')}</div><h1>${esc(p.player.username)}</h1><div class="identity-meta">${view.honor?'':`#${fmt(p.player.statistics.global_rank)} 全球<i>·</i>`}#${fmt(p.player.statistics.country_rank)} ${esc(country)}${view.honor?`<i>·</i><span class="inline-pp">${pp} pp</span>`:''}</div></div>${view.honor?`<div class="rank-insignia"><span>GLOBAL RANK</span><b><small>#</small>${fmt(p.player.statistics.global_rank)}</b></div>`:`<div class="pp"><b>${pp}</b><span>PERFORMANCE POINTS</span></div>`}</div></header>
 <div class="rating-hero" data-material="${view.tier.material}">
   <div class="rating-class"><div class="rating-level">TIER ${view.rated?roman:'—'}</div>
   ${mark?`<div class="specialty-mark" data-variant="${mark.variant}" style="--skill-color:${defs[mark.axis].color}"><b>${esc(mark.abbr)}</b><span>${esc(mark.label)}</span></div>`:`<div class="profile-shape">${esc(view.title||p.profileType)} · BP 画像</div>`}</div>
   <div class="rating-score"><b>${view.rated?fmt(view.value):'—'}</b><span>${view.rated?'Skill Rating':'样本不足 · 暂未评级'}</span></div>
 </div>
 ${section('01','能力画像','固定顺序 · 等效星级')}
 <div class="row-head"><span>SKILL</span><div class="scale"><span>0</span><span>5</span><span>10</span><span>15</span></div><span>高位</span><span>中位</span></div><div class="skill-list">${skillRows(a,true,top.key)}</div>
 <div class="chart-note"><span class="legend-dot"></span> 高位：加权 P80 <span class="legend-tick"></span> 中位：加权 P50<span class="note-end">BP 成绩质量修正后</span></div>${aux(a,true,top.key)}
 ${section('02',d.label+' 代表成绩','按最高维度的表现值选取')}
 <div class="evidence-list">${evidence||'<div class="no-evidence">暂无有效代表成绩</div>'}</div>
 <div class="sample"><div class="sample-label"><b>${p.sample.valid}<span>/${p.sample.requested}</span></b><small>有效 BP${p.sample.failed?' · '+p.sample.failed+' 张失败':''}</small></div><div class="mod-sample"><div class="mod-legend">${mods.map(([mod,count],i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${mod}<b>${count}</b></span>`).join('')}</div><div class="mod-strip">${mods.map(([mod,count],i)=>`<span style="width:${count/p.sample.valid*100}%;background:${colors[i%colors.length]}"></span>`).join('')}</div></div></div>${foot('BP50 样本画像',payload.profile.profilerIdentity?.mapDemandVersion)}</main>`};
}
function groupEvidence(items,axes){
 const local=items.filter(x=>x.available&&starKeys.includes(x.key)).sort((x,y)=>x.start-y.start),groups=[];
 for(const e of local){const last=groups.at(-1);if(last&&e.start<=last.end){last.end=Math.max(last.end,e.end);last.items.push(e);}else groups.push({start:e.start,end:e.end,items:[e]});}
 const selected=groups.sort((x,y)=>Math.max(...y.items.map(i=>axes[i.key].stars))-Math.max(...x.items.map(i=>axes[i.key].stars))).slice(0,3).sort((x,y)=>x.start-y.start);
 return selected;
}
function mapPage(payload: any, background: string){
 const a=payload.analysis,official=payload.official;
 const artist=String(a.beatmap.artist||'').toUpperCase(),creator=String(a.beatmap.creator||'').toUpperCase();
 const meta={bid:a.beatmap.beatmap_id,mods:payload.mods,background};
 const originalStars=payload.stars;
 const originalContext=originalStars===null?'原星数暂不可用':(meta.mods.join('')||'NM')+(meta.mods.length&&Number.isFinite(payload.nomodStars)?`<i>·</i><small>NM ${payload.nomodStars.toFixed(2)}★</small>`:'');
 const lead=[...starKeys].sort((x,y)=>a.axes[y].stars-a.axes[x].stars),top=defs[lead[0]],diff=a.analysis_context?.effective_difficulty||a.analysis_context?.difficulty||{};
 const duration=a.analysis_context?.duration_ms||0;
 const evidence=def.map(([key])=>a.key_sections?.find(x=>x.key===key)||{key,available:false,kind:'暂无局部证据'});
 const groups=groupEvidence(evidence,a.axes);
 const end=Math.max(1,duration,...(a.experimental_type?.sections||[]).map(x=>Number(x.end_ms)||0),...evidence.map(x=>Number(x.end)||0));
 const x=t=>195+Math.min(end,Math.max(0,t))/end*845;
 const lanes=evidence.map((e,i)=>{
  const d=defs[e.key],y=22+i*29;
  return `<text x="0" y="${y+5}" class="lane-label">${d.label}</text><line x1="195" x2="1040" y1="${y}" y2="${y}" stroke="#273b44"/>${e.available?`<rect x="${x(e.start)}" y="${y-5}" width="${Math.max(4,x(e.end)-x(e.start))}" height="10" rx="3" fill="${d.color}"/><circle cx="${x(e.start)}" cy="${y}" r="3" fill="${d.color}"/>`:`<text x="620" y="${y+5}">暂无局部证据</text>`}`;
 }).join('');
 const ticks=Array.from({length:5},(_,i)=>i*end/4);
 const timeline=`<svg class="multi-timeline" viewBox="0 0 1080 306" role="img" aria-label="九项能力的关键证据区段"><g>${ticks.map(t=>`<line x1="${x(t)}" x2="${x(t)}" y1="8" y2="266" stroke="#33444d" stroke-dasharray="2 5"/><text x="${x(t)}" y="291" text-anchor="${t===0?'start':t===end?'end':'middle'}">${time(t)}</text>`).join('')}</g>${lanes}</svg>`;
 const cards=groups.map((group,i)=>`<div class="key-card"><div class="key-index">${String(i+1).padStart(2,'0')}</div><div><b class="key-time">${precise(group.start)} — ${precise(group.end)}</b><div class="key-tags">${group.items.map(e=>`<span style="color:${defs[e.key].color}">${defs[e.key].label}</span>`).join('')}</div><small>${group.items.length>1?'多项局部证据重合':group.items[0].kind}${group.items.some(e=>e.extra)?' · '+group.items.find(e=>e.extra).extra:''}</small></div></div>`).join('');
 return {top:top.key,evidence,groups,originalStars,officialSource:official,html:`<main class="sheet map-sheet" style="--accent:${top.color}">${brand('BEATMAP PROFILE')}
 <div class="map-identity">${meta.background?`<img class="map-cover" src="${background}" alt="谱面背景">`:''}<div class="map-cover-shade"></div><div class="map-identity-copy"><div class="eyebrow">${esc(artist)}<i>·</i>MAPPED BY ${esc(creator)}</div><h1>${esc(a.beatmap.title)}</h1><div class="map-title-footer"><div><p class="difficulty-name">[${esc(a.beatmap.version)}]</p><div class="map-id-line"><span>BID ${meta.bid}</span>${(meta.mods.length?meta.mods:['NM']).map(m=>`<span class="mod">${m}</span>`).join('')}</div></div><div class="original-stars"><span>osu! 原星数</span><div class="original-star-value"><b>${originalStars===null?'—':originalStars.toFixed(2)}</b><span>★</span></div><div class="original-star-context">${originalContext}</div></div></div></div></div>
 <div class="map-stats">${[['BPM',Number((a.analysis_context?.bpm_max||0).toFixed(1))],['CS',n(diff.CircleSize)],['AR',n(diff.ApproachRate)],['OD',n(diff.OverallDifficulty)],['LENGTH',time(duration)],['OBJECTS',fmt(a.beatmap.metadata?.counts?.objects||0)]].map(([k,v])=>`<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
 <div class="map-lead"><div><span class="eyebrow">主要技能需求</span><h2 style="color:${top.color}">${top.label}</h2><p>${top.cn}<i>·</i>${meta.mods.join('')||'NM'}</p></div><div class="map-lead-value"><b style="color:${top.color}">${n(a.axes[top.key].stars)}</b><span>等效星级</span></div><div class="lead-side"><span>其他主要需求</span>${lead.slice(1,3).map(k=>`<div>${defs[k].label}<b>${n(a.axes[k].stars)}</b></div>`).join('')}</div></div>
 ${section('01','技能需求',(meta.mods.join('')||'NM')+' · 等效星级')}<div class="row-head"><span>SKILL</span><div class="scale"><span>0</span><span>5</span><span>10</span><span>15</span></div><span>需求</span></div><div class="skill-list">${skillRows(a.axes,false,top.key)}</div>${aux(a.axes,false,top.key)}
 ${section('02','关键区段','七项技能 + 体力 / 耐力')}${timeline}<div class="timeline-note"><span>短标记：局部证据</span><span>长区间：持续支撑</span><span>同段多项证据合并展示</span></div><div class="key-cards">${cards}</div>${foot('实验评分 · '+(Object.values(a.axes).some((axis:any)=>axis.confidence==='LOW')?'置信度低':'技能需求分析'),a.identity?.map_demand_version)}</main>`};
}

const document=(body:string,kind:'player'|'map')=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1200"><style>${skillCardFontFace()}${kind==='player'?playerCss:mapCss}</style></head><body>${body}</body></html>`;
export const buildPlayerSkillCardHtml=(payload:any,avatar='')=>document(playerPage(payload,avatar).html,'player');
export const buildMapSkillCardHtml=(payload:any,background='')=>document(mapPage(payload,background).html,'map');
export async function renderPlayerSkillProfileCard(payload:any):Promise<Buffer>{
 const avatar=await imageDataUrl(payload.player?.avatarUrl,payload.player?.osuId);
 return renderSkillCardHtml(buildPlayerSkillCardHtml(payload,avatar));
}
export async function renderMapSkillCard(payload:any):Promise<Buffer>{
 const background=await imageDataUrl(payload.coverUrl);
 return renderSkillCardHtml(buildMapSkillCardHtml(payload,background));
}
