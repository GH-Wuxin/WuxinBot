import assert from 'node:assert/strict';
import {createTestDataDir, cleanupTestDir, assertNotProduction} from './test-isolation.mjs';
const dir=createTestDataDir('wuxin-social-failure');
process.env.DATA_DIR=dir;process.env.NODE_ENV='test';assertNotProduction(dir);
try {
 const store=await import('../server/store.ts');
 const {emptySocialState}=await import('../server/bot/social/state.ts');
 const {assessSocialParticipation}=await import('../server/bot/social/runtime.ts');
 const {assessmentBudgetReason,assessmentFailureBackoffReason}=await import('../server/bot/social/policy.ts');
 store.ensureStore();
 const event=()=>({source:'onebot',type:'group',groupId:'20001',userId:'10003',messageId:crypto.randomUUID(),nickname:'fixture',text:'今天聊什么',atTargets:[],images:[]});
 function reset(){store.updateDb(db=>{
  db.settings.selfQq='10002';db.settings.ownerQq='10001';db.settings.socialV2Enabled=true;
  db.settings.globalPaused=false;db.settings.tokenSavingMode=false;db.settings.socialMaxAssessmentsPerHour=60;
  db.groups=[{groupId:'20001',enabled:true,mode:'natural',cooldownSec:0,maxPerHour:100}];
  db.users=[];db.messages=[];db.decisions=[];db.socialV2=emptySocialState();
 });}
 const row=(stage,ago,patch={})=>({id:crypto.randomUUID(),scope:'group:20001',stage,phase:'initial',engagement:'ambient',createdAt:new Date(Date.now()-ago).toISOString(),...patch});
 reset();let captured,calls=0;const e=event();
 assert.equal(await assessSocialParticipation(e,'initial',async(_db,options)=>{calls++;captured=options;throw Error('400 upstream_error');}),null);
 assert.equal(calls,1);assert.equal(captured.requestMaxRetries,0);assert.equal(captured.retryOnEmpty,false);
 assert.equal(captured.responseFormat.type,'json_object');assert.match(captured.messages[0].content,/合法 JSON 对象/);
 assert.equal(e.socialAssessmentDiagnostic.stage,'failure');assert.match(e.socialAssessmentDiagnostic.reason,/400/);
 assert.equal(store.readDb().socialV2.decisions.at(-1).stage,'failure');
 assert.match(assessmentFailureBackoffReason(JSON.parse(JSON.stringify(store.readDb())), 'group:20001'), /失败退避/);
 const blocked=event();assert.equal(await assessSocialParticipation(blocked,'initial',async()=>{throw Error('must not invoke');}),null);
 assert.equal(blocked.socialAssessmentDiagnostic.stage,'guard');assert.match(blocked.socialAssessmentDiagnostic.reason,/失败退避/);
 assert.equal(store.readDb().socialV2.decisions.filter(d=>d.stage==='failure').length,1);
 assert.equal(store.readDb().socialV2.transitions.length,0);
 // Old failures, including missing phase/engagement, do not use the normal hourly quota or ambient cooldown.
 reset();store.updateDb(db=>{db.socialV2.decisions=Array.from({length:70},()=>row('failure',301000,{phase:undefined,engagement:undefined}));});
 assert.equal(assessmentBudgetReason(store.readDb(),event(),false),'');
 const ok=event();const response=await assessSocialParticipation(ok,'initial',async()=>({text:JSON.stringify({action:'pass',addressee:'group',reason:'模型主动选择不接话'}),usage:{total_tokens:10}}));
 assert.equal(response.action,'pass');assert.equal(ok.socialAssessmentDiagnostic.stage,'assessment');
 assert.equal(store.readDb().socialV2.decisions.filter(d=>d.stage==='failure').length,70);
 assert.equal(assessmentFailureBackoffReason(store.readDb(),'group:20001'),'');
 // Success still spends normal quota, even for an explicit named candidate.
 reset();store.updateDb(db=>{db.socialV2.decisions=Array.from({length:60},()=>row('assessment',1000,{engagement:'direct'}));});
 assert.match(assessmentBudgetReason(store.readDb(),{...event(),socialDirect:true},false),/小时预算/);
 // Bounded exponential backoff: 30s, 60s, 120s, 240s, cap 300s, scoped and revalidation excluded.
 for(const [count,delay] of [[1,30000],[2,60000],[3,120000],[4,240000],[10,300000]]) {
  const now=Date.now(),db={socialV2:{decisions:Array.from({length:count},()=>row('failure',0))}};
  assert.ok(assessmentFailureBackoffReason(db,'group:20001',now+delay-100));
  assert.equal(assessmentFailureBackoffReason(db,'group:20001',now+delay+100),'');
  assert.equal(assessmentFailureBackoffReason(db,'group:20002',now),'');
 }
 assert.equal(assessmentFailureBackoffReason({socialV2:{decisions:[row('failure',0,{phase:'revalidation'})]}},'group:20001'),'');
 reset();const invalid=event();await assessSocialParticipation(invalid,'initial',async()=>({text:'{}'}));
 assert.equal(invalid.socialAssessmentDiagnostic.stage,'failure');
 // Admission abort clears a previous diagnostic, avoiding a stale wait/resume failure.
 invalid.text='/w info';await assessSocialParticipation(invalid,'resumed',async()=>{throw Error('not called');});
 assert.equal(invalid.socialAssessmentDiagnostic,undefined);

 // End-to-end local HTTP 400: preserve visible diagnostic, never send a chat error.
 const http=await import('node:http');let requests=0;
 const server=http.createServer(async(req,res)=>{for await(const part of req){} requests++;
  res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture upstream_error',type:'invalid_request_error'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  reset();store.updateDb(db=>{
   db.settings.llmProvider='openai-compatible';db.settings.apiBaseUrl='http://127.0.0.1:'+server.address().port+'/v1';
   db.settings.apiKey='fixture';db.settings.model='fixture';db.settings.memoryEnabled=false;
   db.settings.presenceEnabled=false;db.settings.osuSearchEnabled=false;db.settings.enableAutoModel=false;
   db.settings.thinkingNoticeMode='off';db.settings.levelUpNotifyEnabled=false;db.settings.stickerPolicy={mode:'off'};
   db.settings.pippiFastReplies=true;db.settings.socialDebounceMs=0;
  });
  const {processIncoming}=await import('../server/bot.ts');const sent=[];
  const result=await processIncoming(event(),async(_event,text)=>{sent.push(text);});
  assert.equal(result.replied,false);assert.match(result.reason,/评估错误/);assert.equal(sent.length,0);
  assert.ok(store.readDb().decisions.some(d=>d.reason.includes('评估错误')));
  const second=await processIncoming(event(),async(_event,text)=>{sent.push(text);});
  assert.equal(second.replied,false);assert.match(second.reason,/失败退避/);assert.equal(sent.length,0);
  assert.ok(requests>=1);
 } finally {
  const {waitForBackgroundTasks}=await import('../server/backgroundTasks.ts');await waitForBackgroundTasks(3000);
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 }
 console.log('social failure checks PASS');
}finally{await cleanupTestDir(dir);}
