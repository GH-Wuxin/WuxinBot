import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createTestDataDir,assertNotProduction,cleanupTestDir} from './test-isolation.mjs';
const dataDir=createTestDataDir('wuxin-fallback-verify');
assertNotProduction(dataDir);
process.env.NODE_ENV='test';
const realFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Unexpected network request from fallback verification');};
const {buildWuxinFallbackPayload,executeWuxinFallback,fallbackContextForQuick}=await import('../server/bots/wuxinFallback.ts');
const {buildWuxinQueryCardHtml,nullableNumber,scoreStars,renderWuxinQueryCards}=await import('../server/bots/wuxinFallbackCard.ts');
const {closeSkillCardBrowser}=await import('../server/bots/skillCard/browser.ts');
const user={id:707,username:'Wuxin Test Player',country_code:'CN',avatar_url:'',
  statistics:{pp:9543.27,global_rank:6427,country_rank:536,hit_accuracy:98.72,play_count:18294,play_time:1954800,total_hits:7842531,maximum_combo:2864,level:{current:100},ranked_score:21457899632,total_score:123456789012},
  grade_counts:{ss:42,ssh:16,s:362,sh:127,a:751}};
const score=(id,extra={})=>({id,user_id:user.id,pp:512.38,accuracy:.9872,max_combo:1234,passed:true,rank:'A',mods:['HD','HR'],
  created_at:'2026-10-28T15:04:30Z',statistics:{count_300:901,count_100:18,count_50:2,count_miss:1},
  beatmap:{id:10000+id,difficulty_rating:6.21,version:'A long difficulty name',max_combo:1402},
  beatmapset:{title:'Wuxin — A Transparent Query Result',artist:'Test Artist'},modded_star_rating:7.34,star_rating_source:'modded',...extra});
const recent=[score(1,{passed:false,rank:'F',pp:null,accuracy:.6521,max_combo:240}),score(2),score(3,{passed:false,rank:'F'}),score(4)];
const base={user,capability:'recent',fallback:{sourceBot:'kanon',reason:'failed',recentSource:'recent_play'}};
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
const calls=[];
const deps={api:{getUserRecentScores:async(...args)=>{calls.push(['recent',...args]);return recent;},getUserBestScores:async(_id,_mode,limit)=>Array.from({length:limit},(_,i)=>score(i+1))},enrich:async rows=>rows,render:async()=>({images:['[CQ:image,file=fixture.png]']})};
try {
  check('unknown numeric values never become zero',()=>{
    for(const value of [null,undefined,'',' ',true,false,[],{},NaN,Infinity,-1])assert.equal(nullableNumber(value),null);
    assert.equal(nullableNumber(0),0);assert.equal(nullableNumber('0'),0);
  });
  check('modded stars never use base stars when unavailable',()=>{
    assert.equal(scoreStars(score(1,{star_rating_source:'unavailable'})).value,null);
    assert.equal(scoreStars(score(1,{star_rating_source:undefined})).value,null);
    assert.equal(scoreStars(score(1,{mods:[],star_rating_source:'base'})).value,6.21);
  });
  check('recent/pass aliases and ordinal remain distinct',()=>{
    assert.equal(fallbackContextForQuick('kanon','pr','Player #2','failed').recentIndex,2);
    assert.equal(fallbackContextForQuick('kanon','pr','','failed').recentSource,'recent_pass');
    assert.equal(fallbackContextForQuick('kanon','re','','failed').recentSource,'recent_play');
    assert.equal(fallbackContextForQuick('lazybot','rp','','failed').recentSource,'recent_pass');
    assert.equal(fallbackContextForQuick('lazybot','r','','failed').recentSource,'recent_play');
  });
  const play=await buildWuxinFallbackPayload(base,deps);
  check('recent play includes the latest failed play',()=>assert.equal(play.scores[0].score.id,1));
  const passed=await buildWuxinFallbackPayload({...base,fallback:{...base.fallback,recentSource:'recent_pass',recentIndex:2}},deps);
  check('second recent pass selects second passed result, not second raw result',()=>{assert.equal(passed.scores[0].score.id,4);assert.equal(calls.at(-1)[3],100);});
  const noPass=await executeWuxinFallback({...base,fallback:{...base.fallback,recentSource:'recent_pass'}},{...deps,api:{getUserRecentScores:async()=>[recent[0]]}});
  check('no matching pass returns own failure image without substituting a fail',()=>{assert.equal(noPass.failure,true);assert.equal(noPass.images.length,1);assert.match(noPass.content,/没有第 1 条通过成绩/);});
  for(const recentIndex of [0,101,1.5]) {
    const invalid=await executeWuxinFallback({...base,fallback:{...base.fallback,recentIndex}},deps);
    check('invalid recent index '+recentIndex,()=>assert.equal(invalid.failure,true));
  }
  const bp=await buildWuxinFallbackPayload({...base,capability:'bp',bpSelection:{startRank:3,endRank:5}},deps);
  check('BP range preserves ranks and score identities',()=>{assert.deepEqual(bp.scores.map(x=>x.rank),[3,4,5]);assert.deepEqual(bp.scores.map(x=>x.score.id),[3,4,5]);});
  const all=await buildWuxinFallbackPayload({...base,capability:'bplist',bpSelection:{startRank:1,endRank:100}},deps);
  const pages=Array.from({length:13},(_,page)=>buildWuxinQueryCardHtml(all,{page}));
  check('BP100 is completely paginated without lost/duplicated rows',()=>{
    const ids=pages.flatMap(html=>[...html.matchAll(/data-score-id="(\d+)"/g)].map(m=>Number(m[1])));
    assert.deepEqual(ids,Array.from({length:100},(_,i)=>i+1));
    assert.match(pages[12],/100 条记录 · 13 \/ 13 页/);
  });
  let scoreArgs;
  const targeted=await buildWuxinFallbackPayload({...base,capability:'score',beatmapId:10009,scoreMods:['HD']},{...deps,api:{getUserBeatmapScore:async(...args)=>{scoreArgs=args;return score(9,{mods:['HD']});}}});
  check('specific score preserves BID and requested Mods',()=>{assert.deepEqual(scoreArgs,[707,10009,'osu',['HD']]);assert.equal(targeted.scores[0].score.beatmap.id,10009);});
  const wrongMap=await executeWuxinFallback({...base,capability:'score',beatmapId:10009},{...deps,api:{getUserBeatmapScore:async()=>score(8)}});
  check('wrong beatmap cannot be presented as requested score',()=>{assert.equal(wrongMap.failure,true);assert.match(wrongMap.content,/BID 不一致/);});
  const wrongUser=await executeWuxinFallback(base,{...deps,api:{getUserRecentScores:async()=>[score(1,{user_id:999})]}});
  check('wrong player fails explicitly',()=>assert.equal(wrongUser.failure,true));
  const partial=buildWuxinQueryCardHtml({...play,scores:[{score:score(5,{pp:null,accuracy:null,max_combo:null,statistics:{},star_rating_source:'unavailable'})}]});
  check('missing fields are unknown, not fake zero/100 percent',()=>{assert.match(partial,/部分数据/);assert.doesNotMatch(partial,/>100\.00%<|>0\.00<|>0x<|NaN|undefined|Infinity/);assert.match(partial,/未提供 PP/);});
  const zero=buildWuxinQueryCardHtml({...play,scores:[{score:score(5,{pp:0,accuracy:0,max_combo:0,statistics:{count_miss:0}})}]});
  check('real zeros remain real zeros',()=>{assert.match(zero,/>0\.00%<\/b>/);assert.match(zero,/>0\.00<\/b>/);assert.match(zero,/>0x<\/b>/);});
  const escaped=buildWuxinQueryCardHtml({...passed,user:{...user,username:'<script>&name'},scores:[{score:score(2,{beatmapset:{title:'<img onerror=alert(1)>'}})}]});
  check('untrusted names and titles cannot inject markup',()=>{assert.doesNotMatch(escaped,/<script>|<img onerror/);assert.match(escaped,/&lt;script&gt;&amp;name/);});
  const info=await buildWuxinFallbackPayload({...base,capability:'info'},deps);
  check('player info has independent profile card',()=>{assert.equal(info.kind,'profile');assert.match(buildWuxinQueryCardHtml(info),/PLAYER OVERVIEW/);});
  check('grade counts use official statistics nesting',()=>{
    const html=buildWuxinQueryCardHtml({...info,user:{...user,grade_counts:undefined,statistics:{...user.statistics,grade_counts:{ss:777,ssh:12,s:34,sh:56,a:78}}}});
    assert.match(html,/<span>SS<\/span><b>777<\/b>/);
  });
  const ppplus=await buildWuxinFallbackPayload({...base,capability:'ppplus'},{...deps,ppPlus:async()=>({source:'cache',cachedAt:Date.parse('2026-10-27T02:00:00Z'),bars:{ppTotal:12345,jump:17.3,flow:12.4,speed:8.1,stamina:0,precision:5.4,accuracy:10.2}})});
  check('PP+ cached source and timestamp are explicit',()=>{const h=buildWuxinQueryCardHtml(ppplus);assert.match(h,/缓存结果/);assert.match(h,/缓存写入/);assert.match(h,/17\.30/);assert.match(h,/>0\.00<\/b>/);});
  const absent=await executeWuxinFallback({...base,capability:'ppplus'},{...deps,ppPlus:async()=>null});
  check('missing PP+ does not create fake dimensions',()=>{assert.equal(absent.failure,true);assert.match(absent.content,/尚无已完成/);});
  const apiError=await executeWuxinFallback(base,{...deps,api:{getUserRecentScores:async()=>{throw Error('secret=do-not-expose');}}});
  check('query failures produce own error image and hide internal details',()=>{assert.equal(apiError.failure,true);assert.equal(apiError.final,true);assert.equal(apiError.renderer,'wuxin_card');assert.doesNotMatch(apiError.content,/do-not-expose/);});
  const rendererError=await executeWuxinFallback(base,{...deps,render:async()=>{throw Error('browser unavailable');}});
  check('renderer failure is explicit, never another Bot call',()=>{assert.equal(rendererError.failure,true);assert.equal(rendererError.images.length,0);assert.match(rendererError.content,/卡片生成失败/);});

  // Exercise the actual PP+ snapshot reader against a fake HTTP transport.
  const {updateDb}=await import('../server/store.ts');
  const {getPlayerBarsSnapshot}=await import('../server/osu/pplus.ts');
  updateDb(db=>Object.assign(db.settings,{pplusBaseUrl:'http://pplus.test',pplusClientId:'fixture',pplusClientSecret:'fixture'}));
  const transport=[];
  let job={id:'777',status:'completed',result:{performances:{pp:10000,ppJumpAim:2000,ppFlowAim:3000,ppSpeed:1000,ppStamina:900,ppPrecision:500,ppAcc:600}}};
  globalThis.fetch=async(input,opts={})=>{
    const url=new URL(String(input));assert.equal(url.origin,'http://pplus.test');transport.push({path:url.pathname,method:opts.method || 'GET'});
    return new Response(JSON.stringify(url.pathname==='/auth/token' ? {code:200,data:'fixture-token'} : {code:200,data:job}),{status:200,headers:{'content-type':'application/json'}});
  };
  const snapshot=await getPlayerBarsSnapshot(777);
  check('PP+ fallback reads completed jobs without starting work',()=>{assert.equal(snapshot.source,'completed_job');assert.equal(transport.some(x=>x.path==='/player/jobs'),false);assert.equal(transport.at(-1).method,'GET');});
  job={id:'778',status:'running'};
  const pendingSnapshot=await getPlayerBarsSnapshot(778);
  check('PP+ pending jobs are never fabricated',()=>assert.equal(pendingSnapshot,null));

  if(process.argv.includes('--render')) {
    const out=path.resolve(process.env.FALLBACK_PREVIEW_DIR || path.join(dataDir,'previews'));fs.mkdirSync(out,{recursive:true});
    const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=','base64');
    globalThis.fetch=async(input)=>{assert.equal(new URL(String(input)).hostname,'a.ppy.sh');return new Response(pixel,{headers:{'content-type':'image/png'}});};
    const previews={score:{...passed,title:'最近通过 · 第 2 条'},partial:{...play,title:'最近游玩',scores:[{score:score(1,{pp:null,passed:false,rank:'F',star_rating_source:'unavailable',max_combo:240})}]},bp:{...bp,title:'BP 3–10',scores:Array.from({length:8},(_,i)=>({rank:i+3,score:score(i+3)}))},profile:info,ppplus,error:{kind:'error',title:'备用查询未完成',user,source:'Wuxin 备用查询',sourceBot:'猫猫',error:'备用数据源响应超时，请稍后重试。',requested:'!re #2',fetchedAt:'2026-10-29T09:30:00Z'}};
    for(const [name,payload] of Object.entries(previews)) {
      const result=await renderWuxinQueryCards(payload);
      fs.writeFileSync(path.join(out,name+'.png'),result.buffers[0]);
      fs.writeFileSync(path.join(out,name+'.html'),buildWuxinQueryCardHtml(payload));
    }
    fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({fixtures:true,checks,previews:Object.keys(previews)},null,2));
    console.log('PREVIEWS '+out);
  }
  console.log(`PASS ${checks} fallback data/selection/render-contract checks`);
} finally {
  globalThis.fetch=realFetch;
  await closeSkillCardBrowser();
  cleanupTestDir(dataDir);
}
