import * as osuApi from '../osu/api.js';
import {enrichScoreStarRatings} from '../osu/starRating.js';
import {getPlayerBarsSnapshot} from '../osu/pplus.js';
import {nullableNumber, scoreModsLabel, queryCardNotes, renderWuxinQueryCards, type WuxinQueryCard} from './wuxinFallbackCard.js';

export interface WuxinFallbackContext {
  sourceBot: string;
  reason: 'failed' | 'empty' | 'unavailable';
  requested?: string;
  recentSource?: 'recent_play' | 'recent_pass';
  recentIndex?: number;
  recentList?: boolean;
  extraNote?: string;
  unsupportedMode?: boolean;
}
export interface WuxinFallbackRequest {
  user: any;
  capability: string;
  fallback: WuxinFallbackContext;
  bpSelection?: {startRank: number; endRank: number};
  beatmapId?: number;
  scoreMods?: string[];
}
type Dependencies = {
  api?: Partial<typeof osuApi>;
  enrich?: (scores: any[]) => Promise<any[]>;
  ppPlus?: typeof getPlayerBarsSnapshot;
  render?: (payload: WuxinQueryCard) => Promise<{images: string[]}>;
};
const BOT_NAMES: Record<string,string> = {yumu:'雨沐',kanon:'猫猫',hydrant:'消防栓',lazybot:'LazyBot'};
const botName = (id: string) => BOT_NAMES[id] || '原查询服务';
class QueryUnavailable extends Error {}

/** Preserve recent/pass and #N semantics before choosing a replacement data source. */
export function fallbackContextForQuick(sourceBot: string, alias: string, args: string, reason: WuxinFallbackContext['reason']): WuxinFallbackContext {
  const normalized = String(alias).trim().toLowerCase().replace(/\s+/g,' ');
  const passed = new Set(['p','pass','pr','ps','passes','pw','pass show','通过成绩','通过卡片','passcard','ppr']);
  const list = new Set(['ps','passes','rs','recents','recentlist','prs','res','rps']);
  const match = /[#＃]\s*(\d{1,3})\s*$/.exec(String(args || ''));
  const isPassed=passed.has(normalized) || sourceBot==='lazybot' && ['rp','playrecent'].includes(normalized);
  return {sourceBot,reason,requested:`${alias}${args ? ' '+args : ''}`,
    recentSource:isPassed ? 'recent_pass' : 'recent_play',
    recentIndex:match ? Number(match[1]) : 1,recentList:list.has(normalized),
    ...(/[:：]\s*(?:mania|taiko|catch|ctb|[123])(?:\s|$)/i.test(args) ? {unsupportedMode:true} : {}),
    ...(['ppr','pre'].includes(normalized) ? {extraNote:'备用卡片展示原始成绩；单成绩 PP+ 扩展未提供'} : {})};
}
export function safeFallbackError(error: unknown): string {
  if ((error as any)?.code==='FALLBACK_MODE_UNSUPPORTED') return 'Wuxin 备用卡片目前仅支持 osu!standard，无法替代这次其他模式的查询。';
  if ((error as any)?.code==='FALLBACK_UNSUPPORTED') return '这项查询暂未提供对应的 Wuxin 备用数据，请稍后重试原服务。';
  if (error instanceof QueryUnavailable) return error.message;
  const message=String((error as Error)?.message || error || '');
  if (/timeout|超时/i.test(message)) return '备用数据源响应超时，请稍后重试。';
  if (/404|资源不存在|not.found/i.test(message)) return '没有找到对应的公开数据。';
  if (/auth|oauth|凭据|认证/i.test(message)) return '备用数据源暂不可用，请联系管理员检查服务。';
  return '备用数据源暂不可用，请稍后重试。';
}
function customModSettings(score: any): boolean {
  return (score?.mods || []).some((mod: any) => typeof mod === 'object' && mod?.settings && Object.keys(mod.settings).some(key => {
    if (key==='adjust_pitch') return false;
    const rate=['DT','NC'].includes(mod.acronym) ? 1.5 : ['HT','DC'].includes(mod.acronym) ? .75 : null;
    return key!=='speed_change' || mod.settings[key]!==rate;
  }));
}
async function enrich(scores: any[], dependency?: Dependencies['enrich']): Promise<any[]> {
  if (dependency) return dependency(scores);
  const standard=scores.map((score,index)=>({score,index})).filter(({score})=>!customModSettings(score));
  const result=scores.map(score=>({...score,star_rating_source:'unavailable'}));
  if (standard.length) {
    try {
      const input=standard.map(({score})=>({...score,mods:(score.mods || []).map((mod: any)=>typeof mod==='string' ? mod : mod.acronym)}));
      const enriched=(await enrichScoreStarRatings(input,'osu')).scores;
      standard.forEach(({score,index},i)=>{result[index]={...enriched[i],mods:score.mods};});
    } catch { /* Missing Mod-star data stays unknown; other verified score fields remain usable. */ }
  }
  return result;
}
function validateScore(score: any, userId: number, beatmapId?: number): void {
  if (!score || typeof score!=='object') throw new QueryUnavailable('没有找到对应的成绩记录。');
  if (score.user_id!==undefined && Number(score.user_id)!==userId) throw new QueryUnavailable('成绩返回的玩家与查询目标不一致，已停止展示。');
  const bid=Number(score.beatmap?.id || score.beatmap_id || 0);
  if (beatmapId && bid && bid!==beatmapId) throw new QueryUnavailable('成绩返回的谱面与请求 BID 不一致，已停止展示。');
}
export async function buildWuxinFallbackPayload(request: WuxinFallbackRequest, dependencies: Dependencies = {}): Promise<WuxinQueryCard> {
  if (request.fallback.unsupportedMode) throw Object.assign(new Error(),{code:'FALLBACK_MODE_UNSUPPORTED'});
  const api={...osuApi,...dependencies.api},user=request.user;
  if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id)<=0) throw new QueryUnavailable('无法确认要查询的玩家。');
  const common={user,source:'osu! API v2',sourceBot:botName(request.fallback.sourceBot),requested:request.fallback.requested,fetchedAt:new Date().toISOString()};
  const capability=request.capability;
  if (['info','profile','card'].includes(capability)) {
    const missing=['pp','global_rank','hit_accuracy','play_count'].filter(key=>nullableNumber(user.statistics?.[key])===null);
    return {...common,kind:'profile',title:'玩家资料',notes:missing.length ? ['部分玩家统计未提供'] : []};
  }
  if (capability==='recent') {
    const index=request.fallback.recentIndex ?? 1;
    if (!Number.isSafeInteger(index) || index<1 || index>100) throw new QueryUnavailable('成绩序号须为 1–100，例如 !re #2。');
    const passed=request.fallback.recentSource==='recent_pass';
    const count=request.fallback.recentList ? 10 : 1;
    const limit=passed ? 100 : Math.min(100,index+count-1);
    const raw=await api.getUserRecentScores(user.id,'osu',limit);
    if (!Array.isArray(raw)) throw new QueryUnavailable('最近成绩返回格式不完整。');
    const eligible=passed ? raw.filter(score=>score?.passed!==false && String(score?.rank || '').toUpperCase()!=='F') : raw;
    const selected=eligible.slice(index-1,index-1+count);
    if (!selected.length) throw new QueryUnavailable(passed ? `最近 ${limit} 条记录中没有第 ${index} 条通过成绩。` : `没有第 ${index} 条最近游玩成绩。`);
    selected.forEach(score=>validateScore(score,user.id));
    const scores=await enrich(selected,dependencies.enrich);
    const title=(passed ? '最近通过' : '最近游玩')+(index>1 ? ` · 第 ${index} 条` : '')+(count>1 ? '列表' : '');
    return {...common,kind:count>1 ? 'scores' : 'score',title,scores:scores.map((score,i)=>({score,...(count>1 ? {rank:index+i} : {})})),
      notes:[...(passed ? [`从最近 ${limit} 条记录中筛选通过成绩`] : []),...(request.fallback.extraNote ? [request.fallback.extraNote] : [])]};
  }
  if (capability==='score') {
    const bid=Number(request.beatmapId);
    if (!Number.isSafeInteger(bid) || bid<=0) throw new QueryUnavailable('缺少明确的谱面 BID，无法生成替代成绩卡。');
    let score:any;
    try { score=await api.getUserBeatmapScore(user.id,bid,'osu',request.scoreMods); }
    catch(error) {
      if (/not_found|资源不存在|404/.test(String((error as Error)?.message || error))) throw new QueryUnavailable(`${user.username} 没有 BID ${bid}${request.scoreMods?.length ? ' +'+request.scoreMods.join('') : ''} 的成绩记录。`);
      throw error;
    }
    validateScore(score,user.id,bid);
    if (!score.beatmap?.id) score={...score,beatmap:await api.getBeatmap(bid)};
    validateScore(score,user.id,bid);
    const scores=await enrich([score],dependencies.enrich);
    return {...common,kind:'score',title:`谱面成绩 · BID ${bid}`,scores:scores.map(score=>({score}))};
  }
  if (['bp','bp_range','bplist'].includes(capability)) {
    const {startRank:start=1,endRank:end=1}=request.bpSelection || {};
    if (![start,end].every(Number.isSafeInteger) || start<1 || end<start || end>100) throw new QueryUnavailable('BP 范围须在 1–100 之间。');
    const raw=await api.getUserBestScores(user.id,'osu',end);
    if (!Array.isArray(raw)) throw new QueryUnavailable('BP 数据格式不完整。');
    const selected=raw.slice(start-1,end);
    if (!selected.length) throw new QueryUnavailable(`${user.username} 没有 BP${start}${end===start ? '' : '–'+end} 的成绩记录。`);
    selected.forEach(score=>validateScore(score,user.id));
    const scores=await enrich(selected,dependencies.enrich);
    return {...common,kind:scores.length===1 ? 'score' : 'scores',title:`BP${start}${start===end ? '' : '–'+end}`,
      scores:scores.map((score,i)=>({rank:start+i,score})),notes:selected.length<end-start+1 ? [`请求 ${end-start+1} 条，数据源仅返回 ${selected.length} 条`] : []};
  }
  if (['ppplus','pplus','skill'].includes(capability)) {
    const snapshot=await (dependencies.ppPlus || getPlayerBarsSnapshot)(user.id);
    if (!snapshot) throw new QueryUnavailable('PP+ 尚无已完成的结果，请待原服务完成计算后重试。');
    const at=snapshot.cachedAt && Number.isFinite(snapshot.cachedAt) ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(snapshot.cachedAt))+' UTC+8' : '时间未记录';
    return {...common,kind:'ppplus',title:'PP+ 六维表现',ppPlus:{...snapshot.bars},source:snapshot.source==='cache' ? 'PP+ · 已保存结果' : 'PP+ · 已完成任务',
      notes:snapshot.source==='cache' ? [`缓存写入：${at}`] : []};
  }
  throw new QueryUnavailable('这项查询暂未提供对应的 Wuxin 备用数据，已停止自动替换查询内容。');
}
export interface WuxinFallbackResult {
  content:string; images:string[]; renderer:'wuxin_card'; dataSource:string; final?:boolean; failure?:boolean;
}
function describe(payload: WuxinQueryCard): string {
  if (payload.kind==='error') return `Wuxin 备用查询失败：${payload.error}`;
  const lines=[`Wuxin 备用查询：${payload.title}。数据来源：${payload.source}。`,`${payload.user?.username || ''} · UID ${payload.user?.id || ''}`];
  for (const row of payload.scores || []) {
    const score=row.score,pp=nullableNumber(score.pp),rawAccuracy=nullableNumber(score.accuracy);
    const accuracy=rawAccuracy!==null && rawAccuracy<=1 ? rawAccuracy : null;
    lines.push(`${row.rank ? '#'+row.rank+' ' : ''}BID ${score.beatmap?.id || score.beatmap_id || '未提供'} · ${score.beatmapset?.title || score.beatmap?.beatmapset?.title || '标题未提供'} · ${scoreModsLabel(score)} · PP ${pp===null ? '未提供' : pp.toFixed(2)} · ACC ${accuracy===null ? '未提供' : (accuracy*100).toFixed(2)+'%'} · Combo ${nullableNumber(score.max_combo) ?? '未提供'}x`);
  }
  lines.push(...queryCardNotes(payload));
  return lines.join('\n');
}
async function deliver(payload: WuxinQueryCard, dependencies: Dependencies): Promise<WuxinFallbackResult> {
  try {
    const rendered=await (dependencies.render || renderWuxinQueryCards)(payload);
    return {content:describe(payload),images:rendered.images,renderer:'wuxin_card',dataSource:payload.source,
      ...(payload.kind==='error' ? {failure:true,final:true} : {})};
  } catch {
    return {content:payload.kind==='error' ? describe(payload) : 'Wuxin 备用查询已完成，但卡片生成失败，请稍后重试。',
      images:[],renderer:'wuxin_card',dataSource:payload.source,failure:true,final:true};
  }
}
export async function renderWuxinFallbackFailure(fallback: WuxinFallbackContext, error: unknown, user?: any, dependencies: Dependencies = {}): Promise<WuxinFallbackResult> {
  return deliver({kind:'error',title:'备用查询未完成',user,source:'Wuxin 备用查询',sourceBot:botName(fallback.sourceBot),
    requested:fallback.requested,error:safeFallbackError(error),fetchedAt:new Date().toISOString()},dependencies);
}
export async function executeWuxinFallback(request: WuxinFallbackRequest, dependencies: Dependencies = {}): Promise<WuxinFallbackResult> {
  try { return await deliver(await buildWuxinFallbackPayload(request,dependencies),dependencies); }
  catch(error) { return renderWuxinFallbackFailure(request.fallback,error,request.user,dependencies); }
}
