import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTestDataDir,assertNotProduction,cleanupTestDir} from './test-isolation.mjs';

const dataDir=createTestDataDir('wuxin-fallback-bg');
assertNotProduction(dataDir);
process.env.NODE_ENV='test';
const source=relative=>process.env.FALLBACK_VERIFY_ROOT
  ? pathToFileURL(path.join(process.env.FALLBACK_VERIFY_ROOT,relative)).href
  : new URL('../'+relative,import.meta.url).href;
const {queryCardBackgroundUrls,loadWuxinQueryCardMedia,buildWuxinQueryCardHtml,renderWuxinQueryCards}=await import(source('server/bots/wuxinFallbackCard.ts'));
const {closeSkillCardBrowser}=await import(source('server/bots/skillCard/browser.ts'));
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=','base64');
const fixture=process.env.FALLBACK_BG_FILE ? fs.readFileSync(process.env.FALLBACK_BG_FILE) : pixel;
const originalFetch=globalThis.fetch,requests=[];
const failedUrls=new Set();
globalThis.fetch=async(input)=>{
  const url=new URL(String(input));assert(['a.ppy.sh','assets.ppy.sh'].includes(url.hostname));
  requests.push(url.href);
  await new Promise(resolve=>setTimeout(resolve,10));
  const response=failedUrls.has(url.href) ? new Response('',{status:404}) : new Response(fixture,{headers:{'content-type':process.env.FALLBACK_BG_FILE ? 'image/jpeg' : 'image/png'}});
  Object.defineProperty(response,'url',{value:url.href});return response;
};
const user={id:707,username:'Wuxin Preview',country_code:'CN',cover:{url:'https://assets.ppy.sh/user-profile-covers/707/fixture.jpeg'},
  statistics:{pp:9543.27,global_rank:6427,country_rank:536,hit_accuracy:98.72,play_count:18294,play_time:1954800,total_hits:7842531,maximum_combo:2864,level:{current:100},ranked_score:21457899632,total_score:123456789012,grade_counts:{ss:42,ssh:16,s:362,sh:127,a:751}}};
const score={id:9001,user_id:707,pp:512.38,accuracy:.9872,max_combo:1234,passed:true,rank:'A',mods:['HD','HR'],created_at:'2026-10-29T12:00:00Z',
  beatmap:{id:129891,beatmapset_id:39804,version:'FOUR DIMENSIONS',difficulty_rating:6.21,max_combo:1402},
  beatmapset:{id:39804,title:'FREEDOM DiVE',artist:'xi',covers:{'cover@2x':'https://assets.ppy.sh/beatmaps/39804/covers/cover@2x.jpg'}},
  statistics:{count_300:901,count_100:18,count_50:2,count_miss:1},modded_star_rating:7.34,star_rating_source:'modded'};
const payload={kind:'score',title:'最近通过',user,scores:[{score}],source:'osu! API v2',sourceBot:'猫猫',fetchedAt:'2026-10-29T13:00:00Z',notes:['排版预览 · 成绩数值为测试数据']};
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
try {
  check('score artwork belongs to selected beatmapset',()=>assert.deepEqual(queryCardBackgroundUrls(payload),[
    'https://assets.ppy.sh/beatmaps/39804/covers/fullsize.jpg','https://assets.ppy.sh/beatmaps/39804/covers/cover@2x.jpg']));
  check('nested map metadata and absent artwork are handled',()=>{
    assert.equal(queryCardBackgroundUrls({...payload,scores:[{score:{beatmap:{beatmapset_id:12}}}]} )[0],'https://assets.ppy.sh/beatmaps/12/covers/fullsize.jpg');
    assert.deepEqual(queryCardBackgroundUrls({...payload,scores:[{score:{}}]}),[]);
  });
  check('profile and PP+ use player cover, not score artwork',()=>{
    for(const kind of ['profile','ppplus','error'])assert.deepEqual(queryCardBackgroundUrls({...payload,kind}),[user.cover.url]);
  });
  check('background URLs reject other hosts and credentials',()=>{
    for(const value of ['https://assets.ppy.sh.evil.test/bg.jpg','http://assets.ppy.sh/bg.jpg','https://name:secret@assets.ppy.sh/bg.jpg','file:///C:/secret.png','javascript:alert(1)'])assert.deepEqual(queryCardBackgroundUrls({kind:'profile',user:{cover_url:value}}),[]);
  });
  const pending=loadWuxinQueryCardMedia(payload);
  check('avatar and BG downloads start concurrently',()=>{assert.equal(requests.length,2);assert(requests.includes('https://a.ppy.sh/707'));});
  const media=await pending;
  check('downloaded background reaches HTML as embedded pixels',()=>{
    assert(media.background.startsWith('data:image/'));const html=buildWuxinQueryCardHtml(payload,media);
    assert.match(html,/query-sheet has-background/);assert(html.includes('src="'+media.background+'"'));assert.match(html,/>512\.38<\/b>/);
  });
  const count=requests.length;
  await loadWuxinQueryCardMedia(payload);
  check('repeat rendering reuses cache without another download',()=>assert.equal(requests.length,count));
  const miss='https://assets.ppy.sh/beatmaps/999999991/covers/fullsize.jpg';failedUrls.add(miss);
  const fallback=await loadWuxinQueryCardMedia({...payload,scores:[{score:{...score,beatmapset:{...score.beatmapset,id:999999991}}}]});
  check('unavailable full-size image falls back to API cover',()=>{assert(fallback.background);assert(requests.includes(score.beatmapset.covers['cover@2x']));});
  const unavailableUrl='https://assets.ppy.sh/user-profile-covers/707/unavailable.jpeg';failedUrls.add(unavailableUrl);
  const absent=await loadWuxinQueryCardMedia({...payload,kind:'profile',user:{...user,cover:{url:unavailableUrl}}});
  check('failed artwork leaves usable card instead of failed query',()=>{assert.equal(absent.background,'');const html=buildWuxinQueryCardHtml(payload,absent);assert.doesNotMatch(html,/query-sheet has-background/);assert.match(html,/>512\.38<\/b>/);});
  check('only embedded image data reaches background markup',()=>{
    const html=buildWuxinQueryCardHtml(payload,{background:'https://untrusted.test/x.jpg" onerror="alert(1)'});
    assert.doesNotMatch(html,/untrusted|onerror|query-sheet has-background/);
  });
  if(process.argv.includes('--render')) {
    assert(process.env.FALLBACK_BG_FILE,'--render requires a downloaded real background fixture');
    const out=path.resolve(process.env.FALLBACK_PREVIEW_DIR || path.join(dataDir,'previews'));fs.mkdirSync(out,{recursive:true});
    // The public beatmap art is real; numerical player/score values are fixtures.
    const previews={score:payload,bp:{...payload,kind:'scores',title:'BP 3–10',scores:Array.from({length:8},(_,i)=>({rank:i+3,score:{...score,id:9001+i}}))},
      profile:{...payload,kind:'profile',title:'玩家资料'}};
    for(const [name,card] of Object.entries(previews)) {
      // Initials avoid presenting the artwork fixture as a real player's avatar.
      const cardMedia={...await loadWuxinQueryCardMedia(card),avatar:''};
      const html=buildWuxinQueryCardHtml(card,cardMedia);
      const {renderSkillCardHtml}=await import(source('server/bots/skillCard/browser.ts'));
      const buffer=await renderSkillCardHtml(html);
      fs.writeFileSync(path.join(out,name+'.png'),buffer);fs.writeFileSync(path.join(out,name+'.html'),html);
    }
    const rendered=await renderWuxinQueryCards(payload);
    check('production render produces a PNG with the downloaded BG',()=>{assert.equal(rendered.buffers[0].readUInt32BE(16),1280);assert.equal(rendered.buffers[0].readUInt32BE(20),720);});
    console.log('PREVIEWS '+out);
  }
  console.log(`PASS ${checks} background selection/download/cache/render checks`);
} finally {
  globalThis.fetch=originalFetch;
  await closeSkillCardBrowser();
  cleanupTestDir(dataDir);
}
