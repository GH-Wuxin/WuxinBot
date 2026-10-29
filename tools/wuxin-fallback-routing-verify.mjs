import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {createTestDataDir,assertNotProduction,cleanupTestDir} from './test-isolation.mjs';

// Real router + executor + OneBot bridge + API client + HTML renderer.
// All transports are fixtures; no QQ sends, upstream requests or production writes.
const dataDir=createTestDataDir('wuxin-fallback-routing');
assertNotProduction(dataDir);
Object.assign(process.env,{NODE_ENV:'test',BRIDGE_OUTPUT_DIR:path.join(dataDir,'bridge'),
  BRIDGE_SETTLE_MS:'10',BRIDGE_MAX_POST_REPLY_MS:'30',OSU_CLIENT_ID:'fixture',OSU_CLIENT_SECRET:'fixture',
  OSU_TOKEN_URL:'http://auth.test/oauth/token',OSU_API_BASE_URL:'http://api.test/api/v2',OSU_API_MIN_INTERVAL_MS:'0'});
const source=relative=>process.env.FALLBACK_VERIFY_ROOT
  ? pathToFileURL(path.join(process.env.FALLBACK_VERIFY_ROOT,relative)).href
  : new URL('../'+relative,import.meta.url).href;
const wss=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>wss.once('listening',resolve));
for(const bot of ['KANON','YUMU','LAZYBOT','HYDRANT'])process.env['BRIDGE_URL_'+bot]=`ws://127.0.0.1:${wss.address().port}`;
const bridgeEvents=[],requests=[];
let bridgeMode='reply',recentMode='normal';
wss.on('connection',socket=>socket.on('message',data=>{
  const message=JSON.parse(String(data));if(message.post_type!=='message')return;
  bridgeEvents.push(message);
  if(bridgeMode==='drop')return socket.close();
  socket.send(JSON.stringify({action:'send_msg',params:{message:'Original fixture panel'},echo:'fixture'}));
}));
const user={id:707,username:'Bound Player',country_code:'CN',statistics:{pp:4321,play_count:100,hit_accuracy:97,grade_counts:{ss:7,ssh:2,s:10,sh:3,a:23}}};
const score=(id,extra={})=>({id,user_id:707,passed:true,rank:'A',pp:100+id,accuracy:.97,max_combo:500,mods:[],
  statistics:{count_300:400,count_100:20,count_50:3,count_miss:1},created_at:'2026-10-28T10:00:00Z',
  beatmap:{id:10000+id,difficulty_rating:5.2,version:'Fixture',max_combo:800},beatmapset:{title:'Fixture '+id,artist:'Fixture'},...extra});
const recent=[score(1,{passed:false,rank:'F'}),score(2),score(3,{passed:false,rank:'F'}),score(4)];
const realFetch=globalThis.fetch;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));requests.push({url,method:options.method || 'GET'});
  if(url.origin==='http://auth.test')return json({access_token:'fixture',expires_in:3600});
  if(url.hostname==='a.ppy.sh') {
    const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=','base64');
    const response=new Response(pixel,{headers:{'content-type':'image/png'}});Object.defineProperty(response,'url',{value:url.href});return response;
  }
  if(url.origin==='http://pplus.test') {
    if(url.pathname==='/auth/token')return json({code:200,data:'fixture'});
    assert.equal(url.pathname,'/player/jobs/status');assert.equal(options.method || 'GET','GET');
    return json({code:200,data:{id:'707',status:'completed',result:{performances:{pp:4321,ppJumpAim:600,ppFlowAim:400,ppSpeed:300,ppStamina:200,ppPrecision:100,ppAcc:300}}}});
  }
  assert.equal(url.origin,'http://api.test',`Unmocked network: ${url.origin}`);
  if(/\/users\/[^/]+\/osu$/.test(url.pathname))return json(user);
  if(/\/scores\/recent$/.test(url.pathname))return json(recentMode==='empty' ? [] : recent.slice(0,Number(url.searchParams.get('limit'))));
  if(/\/scores\/best$/.test(url.pathname))return json(Array.from({length:Number(url.searchParams.get('limit'))},(_,i)=>score(i+1)));
  const specific=/\/beatmaps\/(\d+)\/scores\/users\/707$/.exec(url.pathname);
  if(specific)return Number(specific[1])===99999 ? json({},404) : json({score:score(Number(specific[1])-10000,{mods:url.searchParams.getAll('mods[]')})});
  if(/\/attributes$/.test(url.pathname))return json({attributes:{star_rating:6.7}});
  throw Error('Unexpected API path '+url.pathname);
};
let checks=0,seq=0,closeBrowser;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
try {
  const {ensureStore,readDb,writeDb}=await import(source('server/store.ts'));
  const {handleQuickCommand,matchQuickCommand}=await import(source('server/bot/quickRouter.ts'));
  const {executeInternalBotCommand,executeToolCall,runToolLoop}=await import(source('server/bots/executor.ts'));
  closeBrowser=(await import(source('server/bots/skillCard/browser.ts'))).closeSkillCardBrowser;
  ensureStore();const db=structuredClone(readDb());
  Object.assign(db.settings,{globalPaused:false,pplusBaseUrl:'http://pplus.test',pplusClientId:'fixture',pplusClientSecret:'fixture'});
  db.groups=[{groupId:'991337',enabled:true,mode:'chat'}];
  db.osuBindings={'10001':{osuUserId:707,osuUsername:user.username},'10002':{osuUserId:707,osuUsername:user.username}};
  writeDb(db);
  const invoke=async(text,atTargets=[])=>{
    const event={source:'gui',type:'group',messageId:`fallback-${++seq}`,groupId:'991337',userId:'10001',nickname:'Fixture',text,atTargets,raw:{}};
    const sent=[],before=bridgeEvents.length,start=performance.now();
    const result=await handleQuickCommand(event,async(_event,content)=>sent.push(content),db,matchQuickCommand(event),{isOwner:false,isAdmin:false});
    const content=readDb().messages.filter(m=>m.role==='assistant').at(-1)?.content || '';
    return {sent,result,content,bridgeCount:bridgeEvents.length-before,ms:Math.round(performance.now()-start)};
  };
  const verifyImage=(sent,count=1)=>{
    const urls=[...sent.join('\n').matchAll(/\[CQ:image,file=([^\]]+)\]/g)].map(match=>match[1]);assert.equal(urls.length,count);
    for(const url of urls) {
      const file=fileURLToPath(url);assert.equal(path.dirname(file),path.join(dataDir,'wuxin-query-cards'));
      const png=fs.readFileSync(file);assert.equal(png.subarray(1,4).toString(),'PNG');
      assert.equal(png.readUInt32BE(16),1280);assert.equal(png.readUInt32BE(20),720);
    }
  };
  const success=await invoke('!re');
  check('successful original reply remains unchanged',()=>{assert.deepEqual(success.sent,['Original fixture panel']);assert.equal(success.bridgeCount,1);assert.equal(requests.length,0);});
  bridgeMode='drop';
  for(const [command,expected,count] of [
    ['!re','BID 10001',1],['!pr #2','BID 10004',1],['/rp','BID 10002',1],['!p','BID 10002',1],
    ['!bp 3-5','#3 BID 10003',1],['!bplist 1-100','#1 BID 10001',13],
    ['!score 10009 +HD','BID 10009',1],['!score 99999 +HD','没有 BID 99999 +HD',1],
    ['!info','玩家资料',1],['/profile','玩家资料',1],['/plus','PP+ 六维表现',1],
    ['~','玩家资料',1],['查','玩家资料',1],['!pm','暂未提供对应的 Wuxin 备用数据',1],
    ['!re Bound Player :mania','目前仅支持 osu!standard',1],
  ]) {
    const result=await invoke(command,command==='查' ? ['10002'] : []);
    check(`single-bridge fallback ${command} (${result.ms} ms)`,()=>{
      assert.equal(result.bridgeCount,1,'Must not retry or change external bots');assert.match(result.content,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));verifyImage(result.sent,count);
    });
  }
  check('PP+ never starts calculation during fallback',()=>assert.equal(requests.some(r=>r.url.pathname==='/player/jobs'),false));
  check('score filter preserved in API fallback',()=>assert(requests.filter(r=>r.url.pathname.includes('/scores/users/')).every(r=>r.url.searchParams.getAll('mods[]').join(',')==='HD')));
  const direct=await executeInternalBotCommand('kanon','score_image','',{db,userId:'10001',groupId:'991337',toolArgs:{source:'recent_pass'}});
  check('score_image uses actual passed score and own renderer',()=>{assert.equal(direct.renderer,'wuxin_card');assert.match(direct.content,/BID 10002/);verifyImage(direct.images);});
  // Distinct limit cache key makes this a fresh empty response.
  recentMode='empty';
  const absent=await invoke('!re #99');
  check('empty source returns failure image without substituting data',()=>{assert.match(absent.content,/没有第 99 条/);verifyImage(absent.sent);});
  const toolContext={db,userId:'10001',groupId:'991337',event:{type:'group',userId:'10001',groupId:'991337',text:'draw recent pass'}};
  const call={id:'fixture-tool',type:'function',function:{name:'query_osu',arguments:JSON.stringify({capability:'score_image',username:'Bound Player',source:'recent_pass'})}};
  // Inject a terminal error through a fresh user (avoids prior recent cache).
  const tool=await executeToolCall({...call,function:{...call.function,arguments:JSON.stringify({capability:'score_image',username:'Bound Player',source:'beatmap_score',beatmap_id:99999})}},toolContext);
  check('tool retains failure image and terminal metadata',()=>{assert.equal(tool.ok,false);assert.equal(tool.final,true);assert.equal(tool.metadata.renderer,'wuxin_card');verifyImage(tool.images);});
  const required={toolName:'query_osu',args:{capability:'score_image',username:'Bound Player',source:'beatmap_score',beatmap_id:99999}};
  const loop=await runToolLoop(async()=>{throw Error('Failure must not call LLM');},{...toolContext,messages:[],tools:[],requiredTool:required,deliverDirectContent:true});
  check('terminal tool-loop failure delivers image without LLM or retry',()=>{assert.equal(loop.toolCallsMade,1);verifyImage(loop.images);assert.match(loop.directContent,/没有 BID 99999/);});
  let modelCalls=0,toolCalls=0;
  const planned=await runToolLoop(async()=>{
    modelCalls++;assert.equal(modelCalls,1,'No follow-up generation after a terminal failure');
    return {text:'',usage:{},raw:{choices:[{message:{content:'',tool_calls:[call]},finish_reason:'tool_calls'}]}};
  },{...toolContext,messages:[],tools:[{type:'function',function:{name:'query_osu',description:'fixture',parameters:{type:'object',properties:{}}}}],
    evidenceRequirement:required,executeToolCallFn:async()=>{toolCalls++;return tool;}});
  check('model-selected failure delivers image without evidence retry',()=>{assert.equal(toolCalls,1);assert.equal(modelCalls,1);verifyImage(planned.images);assert.match(planned.directContent,/没有 BID 99999/);});
  console.log(`PASS ${checks} real-routing/transport/render checks`);
} finally {
  globalThis.fetch=realFetch;
  await closeBrowser?.();
  for(const client of wss.clients)client.terminate();
  await new Promise(resolve=>wss.close(resolve));
  cleanupTestDir(dataDir);
}
