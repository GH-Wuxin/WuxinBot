import assert from 'node:assert/strict';
import {createTestDataDir,cleanupTestDir} from './test-isolation.mjs';
const directory=createTestDataDir('pippi-progress');process.env.NODE_ENV='test';
const {ensureStore,readDb,updateDb}=await import('../server/store.ts');ensureStore();
const {shouldUseReplyProgress,createReplyProgress,completeWithReplyProgress,stagedReplySegments}=await import('../server/bot/replyProgress.ts');
const {runReplyProcess,listReplyProcesses,abortReplyProcess}=await import('../server/bot/replyProcesses.ts');
const {emptySocialState}=await import('../server/bot/social/state.ts');
const {isReasoningBudgetExhaustion}=await import('../server/bot/llm.ts');
const {parseStickerReply}=await import('../server/bot/stickers/finalReply.ts');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const event={source:'onebot',type:'group',groupId:'room',userId:'member',messageId:'turn',text:'[CQ:at,qq=bot] 帮我看看这个',atTargets:['bot'],socialDirect:true};
updateDb(db=>{db.settings={...db.settings,selfQq:'bot',ownerQq:'owner',globalPaused:false,socialV2Enabled:true,pippiProgressReplies:true};
 db.groups=[{groupId:'room',enabled:true,mode:'mention',cooldownSec:0,maxPerHour:100}];db.messages=[];db.users=[];db.socialV2=emptySocialState();});
const options={messages:[{role:'system',content:'PERSONA_MUST_STAY'},{role:'user',content:'测试请求'}]};
const envelope=(phase='final',action='reply',reply='晚安。',presentation='chat')=>({text:JSON.stringify({response_phase:phase,presentation,
  social:{action,addressee:'bot',reason:'按真实语境回应'},reply,mode:'none'}),usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,accounted:true}});
let sent=[],calls=[];
const send=async(e,text,extra)=>{sent.push({text,extra});return {outcome:'confirmed_success',messageId:'sent-'+sent.length};};
try{
 assert.equal(isReasoningBudgetExhaustion({finishReason:null,reasoningTokens:1200,completionTokens:1200,contentEmpty:true,hadToolCalls:false}),true);
 for(const text of ['晚安','对比这两个方案','你还会啥','复杂这个词是什么意思','x'.repeat(300)])assert.equal(shouldUseReplyProgress(readDb(),{...event,text}),true,'eligibility does not classify semantics');
 for(const patch of [{atTargets:[]},{source:'gui'},{type:'private'}])assert.equal(shouldUseReplyProgress(readDb(),{...event,...patch}),false);
 let progress=createReplyProgress(event,send,{intervalMs:25});
 let result=await completeWithReplyProgress(readDb(),options,progress,async(_db,request)=>{calls.push(request);return envelope();});
 assert.equal(calls.length,1);assert.equal(sent.length,0);assert.equal(parseStickerReply(result.text).reply,'晚安。');progress.stop();
 calls=[];progress=createReplyProgress(event,send,{intervalMs:25});
 await completeWithReplyProgress(readDb(),options,progress,async()=>{calls.push(1);return envelope('final','pass','');});
 assert.equal(calls.length,1);assert.equal(sent.length,0,'a semantic pass never emits a placeholder');progress.stop();

 calls=[];let release;
 progress=createReplyProgress(event,send,{intervalMs:25});
 const work=completeWithReplyProgress(readDb(),options,progress,async(_db,request)=>{
   calls.push(request);assert.ok(request.messages[0].content.includes('PERSONA_MUST_STAY'));
   if(calls.length===1)return envelope('acknowledge','reply','我把两个方案分别看一下。');
   await new Promise(r=>{release=r;});return envelope('final','reply','这是完整的比较结果。');
 });
 await delay(15);assert.equal(calls.length,2);assert.equal(sent.length,1);assert.equal(sent[0].extra.originModule,'notice');
 assert.equal(sent[0].text,'我把两个方案分别看一下。');release();result=await work;
 assert.equal(result.usage.total_tokens,10);assert.equal(parseStickerReply(result.text).reply,'这是完整的比较结果。');
 progress.begin('不能重复开场');await delay(30);const done=progress.toolStarted('inspect_message');progress.toolFinished(done,true);await delay(5);assert.equal(sent.length,2);
 await delay(30);const extra=progress.toolStarted('PRIVATE_TOOL_NAME');progress.toolFinished(extra,true);assert.equal(sent.length,2);progress.stop();
 assert.ok(!JSON.stringify(sent).includes('PRIVATE_TOOL_NAME'));
 sent=[];progress=createReplyProgress(event,send,{toolDelayMs:15});const fast=progress.toolStarted('inspect_message');progress.toolFinished(fast,true);await delay(30);assert.equal(sent.length,0);progress.stop();

 sent=[];calls=[];progress=createReplyProgress(event,send);
 const raw={choices:[{message:{tool_calls:[{id:'query',function:{name:'inspect_message'}}]}}]};
 result=await completeWithReplyProgress(readDb(),options,progress,async()=>{calls.push(1);return {...envelope('acknowledge','reply','我核对一下。'),raw};});
 assert.equal(calls.length,1,'actual tools must execute before another completion');assert.equal(result.raw,raw);progress.stop();

 progress=createReplyProgress(event,send);progress.begin('我核对一下。');
 await assert.rejects(()=>completeWithReplyProgress(readDb(),options,progress,async()=>envelope('acknowledge','reply','再等一下。')),/重复了开场/);
 progress.stop();

 sent=[];calls=[];progress=createReplyProgress(event,send);
 await assert.rejects(()=>completeWithReplyProgress(readDb(),options,progress,async()=>{calls.push(1);return envelope('acknowledge','reply','我看一下。');}),/重复了开场/);
 assert.equal(calls.length,2);assert.equal(sent.length,1);progress.stop();

 sent=[];await runReplyProcess(event,async()=>{
   const p=createReplyProgress(event,send);abortReplyProcess(listReplyProcesses()[0].id);
   p.begin('我来看看。');p.toolStarted('inspect_message');await delay(10);p.stop();
 });assert.equal(sent.length,0);
 let aborted=false;progress=createReplyProgress(event,async(_e,_t,extra)=>new Promise((resolve,reject)=>extra.signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled optional notice'));},{once:true})));
 progress.begin('我来看看。');await delay(5);progress.stop();await delay(5);assert.equal(aborted,true);
 const body=Array.from({length:12},(_,i)=>`${i+1}. 这是完整的一段说明，保留段内所有内容和列表结构。`).join('\n\n');
 const segments=stagedReplySegments(body);assert.ok(segments.length<=3);assert.equal(segments.join('\n\n'),body);
 assert.equal(parseStickerReply(envelope('final','reply','完整文章','document').text).presentation,'document');
 console.log('PASS semantic stages: no text classifier, one-call simple/pass, early model-authored opening, one continuation, tool ordering, no duplicate progress, aborts and complete paragraphs');
}finally{cleanupTestDir(directory);}
