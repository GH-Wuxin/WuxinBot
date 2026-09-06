import {getBeatmap,getBeatmapAttributes} from '../osu/api.js';
import {saveAndGetCqCode} from './render.js';
import {renderMapSkillCard} from './skillCard/cards.js';

const finite=(value:unknown):number|null=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?null:Number(value);
const modsOf=(values:unknown)=>Array.isArray(values)?[...new Set(values.map(String).map(x=>x.trim().toUpperCase()).filter(x=>x&&x!=='NM'))]:[];

export function buildSkillProfilerCardPayload(analysis:any,official:{beatmap?:any;starRating?:number|null}={}){
  if(analysis?.status!=='OK'||!analysis?.beatmap||!analysis?.axes)throw Error('SKILL_PROFILER_CARD_ANALYSIS_INVALID');
  const context=analysis.mod_context||{};
  const mods=modsOf(context.requested_mods?.length?context.requested_mods:context.effective_mods);
  const effective=modsOf(context.effective_mods??mods).filter(mod=>!['NF','SD','PF'].includes(mod));
  const setId=finite(analysis.beatmap.beatmapset_id);
  return {
    analysis,mods,
    stars:finite(official.starRating)??(effective.length?null:finite(official.beatmap?.difficulty_rating)??finite(analysis.beatmap.local_nm_stars)),
    nomodStars:finite(official.beatmap?.difficulty_rating),
    coverUrl:setId&&setId>0?`https://assets.ppy.sh/beatmaps/${setId}/covers/fullsize.jpg`:'',
    official:{source:'osu! API v2',beatmapId:analysis.beatmap.beatmap_id},
  };
}

export async function renderSkillProfilerCard(analysis:any):Promise<{buffer:Buffer;cqCode:string}|null>{
  try{
    const bid=finite(analysis?.beatmap?.beatmap_id);
    let beatmap:any=null,starRating:number|null=null;
    if(bid&&bid>0){
      const context=analysis.mod_context||{};
      const mods=modsOf(context.effective_mods??context.requested_mods).filter(mod=>!['NF','SD','PF'].includes(mod));
      const [mapResult,starResult]=await Promise.allSettled([
        getBeatmap(bid),mods.length?getBeatmapAttributes(bid,'osu',mods):Promise.resolve(null),
      ]);
      if(mapResult.status==='fulfilled'){
        beatmap=mapResult.value;
        if(!mods.length)starRating=finite(beatmap.difficulty_rating);
      }
      if(starResult.status==='fulfilled')starRating=finite(starResult.value?.attributes?.star_rating)??starRating;
    }
    const buffer=await renderMapSkillCard(buildSkillProfilerCardPayload(analysis,{beatmap,starRating}));
    return {buffer,cqCode:saveAndGetCqCode(buffer,'skill')};
  }catch(error){
    console.error('[render] Skill card failed:',error instanceof Error?error.message:String(error));
    return null;
  }
}
