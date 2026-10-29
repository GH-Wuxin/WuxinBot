import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {getDataDir} from '../store.js';
import {buildSkillCardDocument} from './skillCard/cards.js';
import {renderSkillCardHtml} from './skillCard/browser.js';
import {imageDataUrl} from './skillCard/images.js';

export const WUXIN_QUERY_CARD_VERSION = 'WUXIN_QUERY_CARD_V2';
export type QueryCardKind = 'score' | 'scores' | 'profile' | 'ppplus' | 'error';
export interface WuxinQueryCard {
  kind: QueryCardKind;
  title: string;
  user?: any;
  scores?: Array<{rank?: number; score: any}>;
  ppPlus?: Record<string, unknown>;
  source: string;
  sourceBot?: string;
  notes?: string[];
  requested?: string;
  error?: string;
  fetchedAt?: string;
}

const css = fs.readFileSync(new URL('./wuxinFallbackCard.css', import.meta.url), 'utf8');
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const nullableNumber = (value: unknown): number | null =>
  (typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value)) || Number(value) < 0
    ? null : Number(value);
const n = (value: unknown, digits = 0) => nullableNumber(value)?.toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}) ?? '—';
const ratio = (value: unknown) => {
  const v = nullableNumber(value);
  return v !== null && v <= 1 ? (v * 100).toFixed(2) + '%' : '—';
};
const rank = (value: unknown) => nullableNumber(value) && Number(value) > 0 ? '#' + n(value) : '—';
const statistic = (stats: any, modern: string, classic: string) => nullableNumber(stats?.[modern]) ?? nullableNumber(stats?.[classic]);
const safeImage = (value: unknown): string => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';

/** Score cards use that beatmap's artwork; player cards use the player's cover. */
export function queryCardBackgroundUrls(payload: WuxinQueryCard): string[] {
  const candidates: unknown[] = [];
  if (payload.kind === 'score' || payload.kind === 'scores') {
    const score = payload.scores?.[0]?.score;
    const set = score?.beatmapset || score?.beatmap?.beatmapset || {};
    const setId = Number(set.id || score?.beatmap?.beatmapset_id || score?.beatmapset_id);
    if (Number.isSafeInteger(setId) && setId > 0) candidates.push(`https://assets.ppy.sh/beatmaps/${setId}/covers/fullsize.jpg`);
    candidates.push(set.covers?.['cover@2x'], set.covers?.cover, set.covers?.['card@2x']);
  } else {
    candidates.push(payload.user?.cover?.url, payload.user?.cover?.custom_url, payload.user?.cover_url);
  }
  return [...new Set(candidates.filter((value): value is string => typeof value === 'string' && Boolean(value)).filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'assets.ppy.sh' && !url.username && !url.password; }
    catch { return false; }
  }))];
}

export async function loadWuxinQueryCardMedia(payload: WuxinQueryCard): Promise<{avatar: string; background: string}> {
  const bounded = async (promise: Promise<string>, ms: number): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise.catch(() => ''), new Promise<string>(resolve => { timer = setTimeout(() => resolve(''), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const backgroundRequest = (async () => {
    for (const url of queryCardBackgroundUrls(payload)) {
      const data = await imageDataUrl(url);
      if (data) return data;
    }
    return '';
  })();
  // Fetch once for the entire result, including a multi-page BP list.
  // Warm requests use the shared in-flight and disk caches immediately.
  const [avatar, background] = await Promise.all([
    bounded(imageDataUrl(payload.user?.avatar_url, payload.user?.id), 2000),
    bounded(backgroundRequest, 6000),
  ]);
  return {avatar, background};
}
export function scoreModsLabel(score: any): string {
  const mods = (Array.isArray(score?.mods) ? score.mods : []).map((mod: any) => {
    if (typeof mod === 'string') return mod.toUpperCase();
    const acronym = String(mod?.acronym || '').toUpperCase();
    const rate = nullableNumber(mod?.settings?.speed_change);
    return acronym + (rate === null ? '' : ` ${rate}x`);
  }).filter(Boolean);
  return mods.length ? mods.join(' · ') : 'NM';
}
export function scoreStars(score: any): {value: number | null; label: string} {
  if (score?.star_rating_source === 'modded') return {value: nullableNumber(score.modded_star_rating), label: '实际 Mods 星级'};
  const mods = (score?.mods || []).map((m: any) => typeof m === 'string' ? m.toUpperCase() : String(m?.acronym || '').toUpperCase());
  if (score?.star_rating_source === 'unavailable' || mods.some((m: string) => !['NM','NF','SD','PF'].includes(m))) {
    return {value: null, label: '实际 Mods 星级未获取'};
  }
  return {value: nullableNumber(score?.beatmap?.difficulty_rating), label: '基础星级'};
}
function date(value: unknown): string {
  if (!value) return '时间未提供';
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) return '时间未提供';
  return new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(parsed) + ' UTC+8';
}
const metric = (label: string, value: string, unit = '', extra = '') => `<div class="query-metric ${extra}"><span>${esc(label)}</span><b>${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ''}</b></div>`;
const stat = (label: string, value: string) => `<div class="query-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
function playerSide(payload: WuxinQueryCard, avatar: string): string {
  const user = payload.user || {}, stats = user.statistics || {};
  const name = String(user.username || payload.requested || 'Wuxin 查询');
  const safeAvatar = safeImage(avatar);
  const image = safeAvatar ? `<img class="query-avatar" src="${safeAvatar}" alt="">` : `<div class="query-avatar query-initials">${esc([...name].slice(0,2).join(''))}</div>`;
  return `<aside class="query-side"><div class="query-brand">WUXIN<span>OSU! QUERY</span></div><div class="query-person">${image}<div class="identity"><div class="query-eyebrow">OSU! STANDARD${user.country_code ? ` · ${esc(user.country_code)}` : ''}</div><h1>${esc(name)}</h1><div class="query-user-id">${user.id ? `UID ${esc(user.id)}` : '查询结果暂不可用'}</div></div></div><div class="query-player-pp"><b>${n(stats.pp,0)}</b><span>PLAYER PP</span></div><div class="query-player-stats">${stat('全球排名',rank(stats.global_rank))}${stat('地区排名',rank(stats.country_rank))}${stat('准确率',nullableNumber(stats.hit_accuracy) === null ? '—' : n(stats.hit_accuracy,2)+'%')}${stat('游玩次数',n(stats.play_count))}</div><div class="query-source-tag">WUXIN 备用查询</div><div class="query-source">${esc(payload.source)}${payload.sourceBot ? `<br>${esc(payload.sourceBot)} 未能完成原查询` : ''}</div></aside>`;
}
function scoreDetail(score: any, label?: number): string {
  const map = score?.beatmap || {}, set = score?.beatmapset || map.beatmapset || {};
  const stars = scoreStars(score);
  const misses = statistic(score?.statistics,'miss','count_miss');
  const grade = score?.passed === false ? 'F' : String(score?.rank || '—');
  const maxCombo = nullableNumber(map.max_combo);
  const combo = nullableNumber(score?.max_combo);
  const comboValue = combo === null ? '—' : n(combo) + 'x';
  return `<section class="query-map"><div class="query-map-kicker">${label ? `BP #${label}` : 'SCORE RECORD'}<span>${map.id ? `BID ${esc(map.id)}` : 'BID 未提供'}</span></div><h2>${esc(set.title || '谱面标题未提供')}</h2><div class="query-difficulty">${esc(map.version || '难度名未提供')}<span>${esc(set.artist || '')}</span></div><div class="query-score-tags"><b>${esc(scoreModsLabel(score))}</b><span>${stars.value === null ? '★ —' : '★ '+n(stars.value,2)}</span><small>${esc(stars.label)}</small><em class="query-grade ${grade === 'F' ? 'failed' : ''}">${esc(grade)}</em></div></section><div class="query-metrics">${metric('本成绩 PP',n(score?.pp,2))}${metric('准确率',ratio(score?.accuracy))}${metric(maxCombo === null ? '已达连击' : '连击 / 最大连击',comboValue,'', 'combo')}${metric('MISS',n(misses))}</div>${maxCombo === null ? '' : `<div class="query-combo-note">谱面最大连击 ${n(maxCombo)}x</div>`}<section class="query-judgements"><div class="query-section-label">判定记录 <span>${esc(date(score?.ended_at || score?.created_at))}</span></div><div class="query-judgement-values">${stat('300',n(statistic(score?.statistics,'great','count_300')))}${stat('100',n(statistic(score?.statistics,'ok','count_100')))}${stat('50',n(statistic(score?.statistics,'meh','count_50')))}${stat('MISS',n(misses))}</div></section>`;
}
function scoreTable(rows: Array<{rank?: number; score: any}>): string {
  return `<div class="query-table"><div class="query-table-head"><span>#</span><span>谱面 / Mods</span><span>ACC / 连击</span><span>PP</span></div>${rows.map(({rank: position,score},index) => {
    const map = score?.beatmap || {}, set = score?.beatmapset || map.beatmapset || {}, stars = scoreStars(score);
    return `<div class="query-score-row" data-score-id="${esc(score?.id ?? '')}"><b class="query-position">${position ?? index+1}</b><div class="query-row-title"><strong>${esc(set.title || '谱面标题未提供')}</strong><span>${esc(map.version || '—')} · ${esc(scoreModsLabel(score))} · ${stars.value === null ? '★ —' : '★ '+n(stars.value,2)}</span></div><div class="query-row-data"><b>${ratio(score?.accuracy)}</b><span>${nullableNumber(score?.max_combo) === null ? '—' : n(score.max_combo)+'x'} · ${n(statistic(score?.statistics,'miss','count_miss'))} miss</span></div><strong class="query-row-pp">${n(score?.pp,2)}</strong></div>`;
  }).join('')}</div>`;
}
function profileDetail(user: any): string {
  const s = user?.statistics || {}, grades = s.grade_counts || user?.grade_counts || {};
  const hours = nullableNumber(s.play_time);
  return `<section class="query-profile-hero"><span>PLAYER OVERVIEW</span><h2>玩家资料</h2><p>公开统计 · osu!standard</p></section><div class="query-profile-grid">${metric('累计游玩时长',hours === null ? '—' : n(hours/3600,1),'小时')}${metric('总命中数',n(s.total_hits))}${metric('最高连击',n(s.maximum_combo),'x')}${metric('等级',n(s.level?.current))}${metric('排名计分',n(s.ranked_score))}${metric('总分',n(s.total_score))}</div><div class="query-section-label">成绩等级</div><div class="query-judgement-values">${stat('SS',n(grades.ss))}${stat('SSH',n(grades.ssh))}${stat('S',n(grades.s))}${stat('SH',n(grades.sh))}${stat('A',n(grades.a))}</div>`;
}
function ppPlusDetail(bars: Record<string,unknown>): string {
  const dims = [['jump','Jump'],['flow','Flow'],['speed','Speed'],['stamina','Stamina'],['precision','Precision'],['accuracy','Accuracy']];
  const maximum = Math.max(15,...dims.map(([key])=>nullableNumber(bars[key]) ?? 0));
  return `<section class="query-profile-hero"><span>PERFORMANCE PLUS</span><h2>PP+ 六维表现</h2><p>15 为参考线 · 保留真实数值</p></section><div class="query-bars">${dims.map(([key,label])=>{
    const value=nullableNumber(bars[key]);
    return `<div class="query-bar"><span>${label}</span><div class="query-bar-track"><i style="width:${value === null ? 0 : value/maximum*100}%"></i><em style="left:${15/maximum*100}%"></em></div><b>${n(value,2)}</b></div>`;
  }).join('')}</div>`;
}
export function queryCardNotes(payload: WuxinQueryCard): string[] {
  const notes = [...(payload.notes || [])];
  if (payload.scores?.some(({score})=>nullableNumber(score?.pp)===null)) notes.push('部分成绩未提供 PP');
  if (payload.scores?.some(({score})=>scoreStars(score).value===null)) notes.push('部分 Mods 星级未获取');
  if (payload.scores?.some(({score})=>nullableNumber(score?.accuracy)===null || Number(score.accuracy)>1 || nullableNumber(score?.max_combo)===null)) notes.push('部分成绩字段未提供');
  return [...new Set(notes)];
}
export function buildWuxinQueryCardHtml(payload: WuxinQueryCard, options: {avatar?: string; background?: string; page?: number} = {}): string {
  const all = payload.scores || [], pages = Math.max(1,Math.ceil(all.length/8));
  const page = Math.max(0,Math.min(pages-1,options.page || 0));
  const notes = queryCardNotes(payload);
  let body: string;
  if (payload.kind==='error') body=`<div class="query-error"><span>QUERY UNAVAILABLE</span><h2>暂未获取到结果</h2><p>${esc(payload.error || '备用数据源暂不可用，请稍后重试。')}</p>${payload.requested ? `<small>请求：${esc(payload.requested)}</small>` : ''}</div>`;
  else if (payload.kind==='profile') body=profileDetail(payload.user);
  else if (payload.kind==='ppplus') body=ppPlusDetail(payload.ppPlus || {});
  else if (all.length===1) body=scoreDetail(all[0].score,payload.kind==='score' ? all[0].rank : undefined);
  else body=scoreTable(all.slice(page*8,page*8+8));
  const partial=notes.some(note=>/未提供|未获取|仅返回/.test(note));
  const status=payload.kind==='error' ? '未完成' : partial ? '部分数据' : payload.source.includes('已保存') ? '缓存结果' : '查询结果';
  const background = safeImage(options.background);
  const artwork = background ? `<img class="query-background" src="${background}" alt="" aria-hidden="true"><div class="query-background-shade" aria-hidden="true"></div>` : '';
  const html=`<main class="sheet query-sheet${background ? ' has-background' : ''}" data-query-card="${WUXIN_QUERY_CARD_VERSION}">${artwork}${playerSide(payload,options.avatar || '')}<section class="query-main"><header class="query-header"><div><span>WUXIN QUERY</span><h1>${esc(payload.title)}</h1></div><b class="query-state ${partial ? 'partial' : ''}">${status}</b></header><div class="query-content">${body}</div><div class="query-notes">${notes.length ? notes.map(esc).join(' · ') : '— 表示数据源未提供该字段'}</div><div class="query-footer"><span>${esc(payload.source)}</span><span>${payload.kind==='scores' ? `${all.length} 条记录 · ${page+1} / ${pages} 页` : esc(date(payload.fetchedAt))}</span></div></section></main>`;
  return buildSkillCardDocument(html,'player',css);
}

function saveCard(buffer: Buffer): string {
  const root=path.join(getDataDir(),'wuxin-query-cards');
  fs.mkdirSync(root,{recursive:true});
  const file=path.join(root,`query-${randomUUID().replaceAll('-','')}.png`);
  fs.writeFileSync(file,buffer,{flag:'wx'});
  const entries=fs.readdirSync(root).filter(name=>/^query-[0-9a-f]{32}\.png$/.test(name)).map(name=>{
    const file=path.join(root,name),stat=fs.statSync(file);return {file,size:stat.size,at:stat.mtimeMs};
  }).sort((a,b)=>b.at-a.at);
  let bytes=0;
  for(const [index,entry] of entries.entries()) {
    bytes+=entry.size;
    if(index>=256 || bytes>128*1024*1024 || Date.now()-entry.at>7*86400000) {
      try { fs.unlinkSync(entry.file); } catch { /* In use by the message transport; retry on the next render. */ }
    }
  }
  return `[CQ:image,file=${pathToFileURL(file).href}]`;
}
export async function renderWuxinQueryCards(payload: WuxinQueryCard): Promise<{images:string[];buffers:Buffer[]}> {
  const media=await loadWuxinQueryCardMedia(payload);
  const images:string[]=[],buffers:Buffer[]=[];
  const pages=payload.kind==='scores' ? Math.max(1,Math.ceil((payload.scores?.length || 0)/8)) : 1;
  for(let page=0;page<pages;page++) {
    const buffer=await renderSkillCardHtml(buildWuxinQueryCardHtml(payload,{...media,page}));
    buffers.push(buffer);images.push(saveCard(buffer));
  }
  return {images,buffers};
}
