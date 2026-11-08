import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {createTestDataDir,cleanupTestDir} from './test-isolation.mjs';
const directory=createTestDataDir('pippi-load');process.env.NODE_ENV='test';process.env.WUXIN_STICKER_MODE='off';
const realConfig=process.env.PIPPI_LOAD_REAL_CONFIG;
const real=Boolean(realConfig), count=Number(process.env.PIPPI_LOAD_COUNT|| (real?12:96));
const concurrency=Number(process.env.PIPPI_LOAD_CONCURRENCY|| (real?4:12));
const expectOverload=process.env.PIPPI_LOAD_EXPECT_OVERLOAD==='1';
const staged=process.env.PIPPI_LOAD_STAGED==='1';
const store=await import('../server/store.ts');store.ensureStore();
const {processIncoming}=await import('../server/bot.ts');
const {sendOneBotMessage}=await import('../server/onebot.ts');
const {emptySocialState}=await import('../server/bot/social/state.ts');
const {waitForBackgroundTasks}=await import('../server/backgroundTasks.ts');
const {getLlmAdmissionStats}=await import('../server/llmPolicy.ts');
const {getInboundAdmissionStats}=await import('../server/bot/inboundGate.ts');
const {getSocialReflectionQueueStats,resumeSocialReflections}=await import('../server/bot/social/reflection.ts');
let active=0,maxActive=0,backgroundActive=0,maxBackgroundActive=0,nextId=1000;
const sent=[],deliveries=[],modelCalls=[],results=[];let peakPending=0;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');
 if(req.url!=='/v1/chat/completions'){
   sent.push({at:performance.now(),group:String(body.group_id),text:body.messages?.map(n=>n.data?.content||'').join('\n')||String(body.message||'')});
   return res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:++nextId}}));
 }
 const system=String(body.messages[0]?.content||'');const background=system.includes('【回复后的关系整理】');
 const content=JSON.stringify(body.messages);const markers=[...new Set(content.match(/ROOM_[0-9]+/g)||[])];
 assert.ok(markers.length<=1,'cross-conversation prompt contamination');
 active++;maxActive=Math.max(maxActive,active);if(background){backgroundActive++;maxBackgroundActive=Math.max(maxBackgroundActive,backgroundActive);}
 modelCalls.push({at:performance.now(),background,marker:markers[0]});
 await new Promise(r=>setTimeout(r,background?100:45));
 let output;
 if(background){const input=JSON.parse(body.messages.find(m=>m.role==='user').content);
   output={action:input.outcome.action,addressee:'bot',reason:'本次正常交流',evidenceIds:input.target.messageIds,affinityDelta:1,familiarityDelta:1,summary:null,preferredNames:null,style:null,mood:null};
 }else {
   const complex=staged&&Number(markers[0]?.slice(5))%4===0;
   const continued=body.messages.some(m=>m.role==='assistant'&&String(m.content).includes('"response_phase":"acknowledge"'));
   output={response_phase:complex&&!continued?'acknowledge':'final',presentation:'chat',social:{action:'reply',addressee:'bot',reason:'明确提问'},
     reply:complex&&!continued?`${markers[0]}，我把两边理一下。`:`${markers[0]}，我在，慢慢说。`,mode:'none'};
 }
 active--;if(background)backgroundActive--;
 res.end(JSON.stringify({id:'load',model:'fixture',choices:[{message:{role:'assistant',content:JSON.stringify(output)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const before=structuredClone(store.readDb());
const configured=real?JSON.parse(fs.readFileSync(realConfig,'utf8')).settings:{};
const endpoint=`http://127.0.0.1:${server.address().port}`;
store.updateDb(db=>{
 db.settings={...before.settings,...configured,selfQq:'990002',ownerQq:'990001',globalPaused:false,socialV2Enabled:true,pippiFastReplies:true,
   oneBotHttpUrl:endpoint,oneBotWsUrl:'',oneBotAccessToken:'',memoryEnabled:false,presenceEnabled:false,pippiActivityEnabled:false,relationshipAutoUpdateEnabled:false,groupProfileAutoUpdateEnabled:false,
   levelUpNotifyEnabled:false,thinkingNoticeMode:'off',stickerPolicy:{mode:'off'},visionMode:'off',kb:{enabled:false},
   ...(real?{}:{llmProvider:'openai-compatible',model:'fixture',apiKey:'fixture-only',apiBaseUrl:endpoint+'/v1',enableAutoModel:false,osuSearchEnabled:false})};
 db.groups=Array.from({length:count},(_,i)=>({groupId:String(991000+i),name:`ROOM_${i}`,enabled:true,mode:'mention',cooldownSec:0,maxPerHour:200,randomImageEnabled:false}));
 db.users=[];db.messages=[];db.decisions=[];db.usageEvents=[];db.memories=[];db.groupProfiles=[];db.relationshipProfiles=[];db.socialV2=emptySocialState();db.ownerDirectives=[];db.osuBindings={};
});
const allowed=new Set([new URL(endpoint).origin]);
if(real)for(const key of ['apiBaseUrl','deepseekApiBaseUrl','openaiApiBaseUrl'])if(configured[key])try{allowed.add(new URL(configured[key]).origin);}catch{}
if(real){allowed.add('https://api.deepseek.com');allowed.add('https://api.openai.com');}
const nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!allowed.has(url.origin))throw Error('Load test blocks non-model/non-fixture network');return nativeFetch(input,options);};
const started=performance.now();let cursor=0;
const sample=setInterval(()=>{const stats=getLlmAdmissionStats();maxActive=Math.max(maxActive,stats.active);maxBackgroundActive=Math.max(maxBackgroundActive,stats.backgroundActive);},10);
const events=Array.from({length:count},(_,i)=>({source:'onebot',type:'group',groupId:String(991000+i),userId:String(992000+i),nickname:'测试成员',
 messageId:crypto.randomUUID(),atTargets:['990002'],senderRole:'member',text:`[CQ:at,qq=990002] ROOM_${i}，${staged&&i%4===0
   ?'我有两种周末安排：全部用来休息，或者休息与练习穿插。请分别说明取舍，再给我一份上午下午晚上的安排，结合疲劳和时间冲突考虑。'
   :'今天练得有点累，想休息一下。'}`}));
try{
 await Promise.all(Array.from({length:Math.min(concurrency,count)},async()=>{while(cursor<count){const i=cursor++,t=performance.now();
   try{const r=await processIncoming(events[i],async(event,text,options={})=>{
     const receipt=await sendOneBotMessage(event,text,options);
     deliveries.push({i,ms:Math.round(performance.now()-t),origin:options.originModule||'reply',outcome:receipt.outcome});return receipt;
   });results.push({i,ms:Math.round(performance.now()-t),replied:Boolean(r.replied),reason:r.reason,error:r.error});}
   catch(error){if(!expectOverload||!String(error).includes('INBOUND_CAPACITY_EXHAUSTED'))throw error;
     results.push({i,ms:Math.round(performance.now()-t),replied:false,rejected:true,reason:'inbound_capacity'});}
   peakPending=Math.max(peakPending,getSocialReflectionQueueStats().pending);
 }}));
 const foregroundMs=Math.round(performance.now()-started);
 const duplicate=await processIncoming(events[0],sendOneBotMessage);assert.equal(duplicate.replied,false);
 const drained=await waitForBackgroundTasks(real?600_000:60_000);assert.equal(drained.drained,true);
 for(let attempt=0;attempt<2&&getSocialReflectionQueueStats().durablePending;attempt++){
   await new Promise(r=>setTimeout(r,10_100));resumeSocialReflections();
   assert.equal((await waitForBackgroundTasks(real?600_000:60_000)).drained,true);
 }
 const usages=store.readDb().usageEvents.filter(e=>e.kind==='llm-call');
 const output={real,staged,count,concurrency,foregroundMs,totalMs:Math.round(performance.now()-started),
   replied:results.filter(r=>r.replied).length,failed:results.filter(r=>r.error).length,
   rejected:results.filter(r=>r.rejected).length,
   p50:results.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(results.length/2)],p95:results.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(results.length*.95)],
   results,deliveries,replies:sent.map(s=>({group:s.group,text:s.text.replace(/\[CQ:[^\]]*\]/g,'').trim()})),
   calls:usages.map(e=>({purpose:e.purpose,ms:e.durationMs,status:e.status})),
   maxActive,maxBackgroundActive,peakPending,reflectionQueue:getSocialReflectionQueueStats(),admission:getLlmAdmissionStats(),
   inbound:getInboundAdmissionStats(),
   relationshipRecords:Object.keys(store.readDb().socialV2.people).length,processedTurns:store.readDb().socialV2.processed.length};
 if(!real){assert.equal(output.replied+output.rejected,count);if(expectOverload)assert.ok(output.rejected>0);else assert.equal(output.replied,count);
   assert.equal(output.failed,0);assert.ok(maxActive<=4);assert.equal(maxBackgroundActive,1);
   assert.equal(output.processedTurns,output.replied);assert.equal(output.reflectionQueue.overflow,0);
   for(const row of sent){const marker=row.text.match(/ROOM_(\d+)/)?.[1];assert.equal(String(991000+Number(marker)),row.group);}
   assert.equal(deliveries.filter(d=>d.origin!=='notice').length,output.replied,'one final response per accepted request; duplicate input cannot resend');
   assert.equal(sent.length,deliveries.length,'duplicate input cannot bypass observed sender');
   if(staged)for(const row of results.filter(r=>r.replied&&r.i%4===0)){
     const own=deliveries.filter(d=>d.i===row.i);assert.equal(own.length,2);assert.equal(own[0].origin,'notice');assert.equal(own[1].origin,'reply');
   }
 }
 if(process.env.PIPPI_LOAD_OUTPUT)fs.writeFileSync(process.env.PIPPI_LOAD_OUTPUT,JSON.stringify(output,null,2));
 console.log(JSON.stringify({...output,results:undefined,replies:undefined,calls:undefined},null,2));
 if(real&&(output.failed||output.processedTurns!==output.replied))process.exitCode=1;
}finally{clearInterval(sample);await waitForBackgroundTasks(2000);server.closeAllConnections();await new Promise(r=>server.close(r));cleanupTestDir(directory);}
