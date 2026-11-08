import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const directory=createTestDataDir('pippi-fast-reply');process.env.NODE_ENV='test';process.env.WUXIN_STICKER_MODE='off';
const store=await import('../server/store.ts');store.ensureStore();
const {processIncoming}=await import('../server/bot.ts');
const {emptySocialState,readSocialPerson}=await import('../server/bot/social/state.ts');
const {registerPendingQuickObservation}=await import('../server/bot/quickContext.ts');
const {sendOneBotMessage}=await import('../server/onebot.ts');
let active,calls=[],variant='reply',sent=[],nextId=1000;
const assessment=(patch={})=>({action:'reply',addressee:'bot',reason:'对当前真实说话人的正常交流',evidenceIds:[active.messageId],affinityDelta:1,familiarityDelta:1,summary:null,preferredNames:null,style:null,mood:{label:'温和',reason:'当前互动'},...patch});
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');res.setHeader('Content-Type','application/json');
 if(req.url!=='/v1/chat/completions'){sent.push(body);return res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:++nextId}}));}
 const system=String(body.messages[0]?.content||'');calls.push(body);await new Promise(r=>setTimeout(r,50));
 let content,toolCalls;
 if(system.includes('同一轮完成社交理解与回复')){
   assert.match(system,/人格保持标记：温和且简洁/);
   if(variant==='tool'&&calls.length===1){content='';toolCalls=[{id:'inspect',type:'function',function:{name:'inspect_capabilities',arguments:'{"query":"随机"}'}}];}
   else if(variant==='malformed')content='{"social":{"affinityDelta":5,"internal_note":"PRIVATE_INTERNAL"},"reply":';
   else content=JSON.stringify({reply:variant==='pass'?'':'我在，慢慢说就好。',social:assessment({action:variant==='pass'?'pass':'reply',affinityDelta:variant==='pass'?-1:1}),mode:'none'});
 }else if(system.includes('社交判断器'))content=JSON.stringify(assessment());
 else if(system.includes('检查草稿'))content=JSON.stringify({action:'keep',reason:'不影响当前回答'});
 else content='我在，慢慢说就好。';
 res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message:{role:'assistant',content,...(toolCalls?{tool_calls:toolCalls}:{})},finish_reason:toolCalls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const initial=structuredClone(store.readDb());
function seed(fast=true){
 calls=[];sent=[];variant='reply';
 store.updateDb(db=>{
  db.settings={...initial.settings,ownerQq:'10001',selfQq:'10002',socialV2Enabled:true,pippiFastReplies:fast,globalPaused:false,tokenSavingMode:false,
   memoryEnabled:false,presenceEnabled:false,pippiActivityEnabled:false,groupProfileAutoUpdateEnabled:false,levelUpNotifyEnabled:false,
   thinkingNoticeMode:'off',osuSearchEnabled:false,visionMode:'off',llmProvider:'openai-compatible',apiKey:'fixture-private-secret',apiBaseUrl:`http://127.0.0.1:${server.address().port}/v1`,
   model:'fixture',enableAutoModel:false,oneBotHttpUrl:`http://127.0.0.1:${server.address().port}`,oneBotAccessToken:'',personalityPrompt:'人格保持标记：温和且简洁，保持自然的群友口吻。',stickerPolicy:{mode:'off'}};
  db.groups=[{groupId:'20001',name:'测试群',enabled:true,mode:'mention',cooldownSec:0,maxPerHour:100}];db.users=[];db.messages=[];db.decisions=[];db.socialV2=emptySocialState();db.usageEvents=[];
 });
 active={source:'onebot',type:'group',groupId:'20001',userId:'10003',nickname:'测试成员',messageId:crypto.randomUUID(),text:'[CQ:at,qq=10002] 今天练得有些累了',atTargets:['10002'],senderRole:'member'};
}
try{
 seed(false);await processIncoming(active,sendOneBotMessage);const baseline=calls.length;assert.equal(baseline,2);
 seed();let result=await processIncoming(active,sendOneBotMessage);assert.equal(result.replied,true);assert.equal(calls.length,1);assert.equal(sent.length,1);
 assert.equal(readSocialPerson(store.readDb(),'10003').affinity.score,51);
 assert.equal(store.readDb().messages.filter(m=>m.role==='assistant').length,1);assert.ok(store.readDb().messages.at(-1).sourceMessageId);
 assert.ok(!JSON.stringify(sent).includes('affinityDelta'));assert.ok(!JSON.stringify(calls).includes('fixture-private-secret'));
 seed();variant='pass';result=await processIncoming(active,sendOneBotMessage);assert.equal(result.replied,false);assert.equal(sent.length,0);assert.equal(calls.length,1);assert.equal(readSocialPerson(store.readDb(),'10003').affinity.score,49);
 seed();variant='tool';active.text='[CQ:at,qq=10002] 你会随机发图吗';result=await processIncoming(active,sendOneBotMessage);assert.equal(result.replied,true);assert.equal(calls.length,2);assert.ok(calls[1].messages.some(m=>m.role==='tool'&&m.content.includes('random_image')));
 seed();let release;const pending=registerPendingQuickObservation(active,()=>new Promise(r=>{release=r;}),'unrelated');
 result=await Promise.race([processIncoming(active,sendOneBotMessage),new Promise((_,reject)=>setTimeout(()=>reject(Error('Unrelated summary blocked reply')),3000))]);release();await pending;assert.equal(result.replied,true);
 seed();active={...active,type:'private',groupId:'private',userId:'10001',atTargets:[],text:'今天有点累'};
 store.updateDb(db=>db.messages.push({id:'foreign',type:'private',role:'assistant',groupId:'private',userId:'bot',replyToUserId:'other',inContext:true,content:'OTHER_PRIVATE_MUST_NOT_LEAK',createdAt:new Date().toISOString()}));
 await processIncoming(active,sendOneBotMessage);assert.equal(calls.length,1);assert.ok(!JSON.stringify(calls).includes('OTHER_PRIVATE_MUST_NOT_LEAK'));
 seed();variant='malformed';result=await processIncoming(active,sendOneBotMessage);assert.ok(!JSON.stringify(sent).includes('PRIVATE_INTERNAL'));assert.ok(!JSON.stringify(sent).includes('affinityDelta'));
 console.log(JSON.stringify({ok:true,ordinaryCalls:{baseline,combined:1},toolLookupCalls:2,personaRetained:true,passAndRelationshipPreserved:true,privateIsolation:true,unrelatedPendingDoesNotBlock:true,malformedEnvelopeNeverSent:true}));
}finally{await new Promise(r=>server.close(r));cleanupTestDir(directory);}
