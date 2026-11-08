import assert from 'node:assert/strict';
import {createTestDataDir,cleanupTestDir} from './test-isolation.mjs';
const directory=createTestDataDir('pippi-reflection');process.env.NODE_ENV='test';
const store=await import('../server/store.ts');store.ensureStore();
const {captureSocialReflection,queueSocialReflection,resumeSocialReflections,getSocialReflectionQueueStats}=await import('../server/bot/social/reflection.ts');
const {assessSocialParticipation}=await import('../server/bot/social/runtime.ts');
const {emptySocialState,readSocialPerson,commitSocialAssessment}=await import('../server/bot/social/state.ts');
const {waitForBackgroundTasks,getBackgroundTaskStats}=await import('../server/backgroundTasks.ts');
const event={source:'onebot',type:'group',groupId:'room',userId:'member',nickname:'测试成员',messageId:'current',text:'谢谢你',socialDirect:true};
const assessment=(patch={})=>({action:'reply',addressee:'bot',reason:'本次真实互动',evidenceIds:[event.messageId],affinityDelta:1,familiarityDelta:1,summary:null,preferredNames:null,style:null,mood:null,...patch});
function seed(){store.updateDb(db=>{db.settings={...db.settings,selfQq:'bot',ownerQq:'owner',socialV2Enabled:true,tokenSavingMode:false,globalPaused:false};
 db.groups=[{groupId:'room',enabled:true,mode:'natural',cooldownSec:0,maxPerHour:100}];db.socialV2=emptySocialState();db.users=[];
 db.messages=[{id:'current',sourceMessageId:'current',role:'user',type:'group',groupId:'room',userId:'member',content:'谢谢你',createdAt:new Date().toISOString()},
 {id:'other',role:'user',type:'group',groupId:'elsewhere',userId:'member',content:'FORBIDDEN_OTHER_ROOM'},
 {id:'private',role:'assistant',type:'private',peerId:'elsewhere',userId:'bot',content:'FORBIDDEN_PRIVATE'}];});}
try{
 seed();let invoked=0,release,started;
 const began=new Promise(r=>{started=r;});
 const invoke=async(_db,options)=>{invoked++;assert.equal(options.tracePurpose,'social_reflection');
   const text=JSON.stringify(options.messages);assert.ok(!text.includes('FORBIDDEN_OTHER_ROOM'));assert.ok(!text.includes('FORBIDDEN_PRIVATE'));
   started();await new Promise(r=>{release=r;});return {text:JSON.stringify(assessment({affinityDelta:4}))};};
 const snapshot=captureSocialReflection(event);const job=queueSocialReflection(snapshot,{action:'reply',replied:true},invoke);
 assert.equal(queueSocialReflection(snapshot,{action:'reply',replied:true},invoke),undefined);await began;
 store.updateDb(db=>commitSocialAssessment(db,{event:{...event,messageId:'newer'},messageIds:['newer'],assessment:assessment({affinityDelta:2}),expectedPersonRevision:0,expectedViewRevision:0}));
 release();await job;assert.equal(invoked,1);assert.equal(readSocialPerson(store.readDb(),'member').affinity.score,52,'late background results cannot overwrite a newer revision');
 seed();invoked=0;const valid=async()=>{invoked++;return {text:JSON.stringify(assessment())};};
 await queueSocialReflection(captureSocialReflection(event),{action:'pass',replied:false},valid);
 assert.equal(readSocialPerson(store.readDb(),'member').affinity.score,51,'pass still permits grounded relationship updates');
 await queueSocialReflection(captureSocialReflection(event),{action:'pass',replied:false},valid);assert.equal(invoked,1,'same turn is committed at most once');
 const failedBefore=getBackgroundTaskStats().failed;event.messageId='invalid';
 store.updateDb(db=>db.messages.push({id:'invalid',sourceMessageId:'invalid',role:'user',type:'group',groupId:'room',userId:'member',content:'测试',createdAt:new Date().toISOString()}));
 await queueSocialReflection(captureSocialReflection(event),{action:'reply',replied:true},async()=>({text:JSON.stringify(assessment({evidenceIds:['forged']}))}));
 assert.equal(getBackgroundTaskStats().failed,failedBefore+1);assert.equal(readSocialPerson(store.readDb(),'member').affinity.score,51);
 // A truncated provider response remains recoverable after a process restart.
 seed();event.messageId='current';
 await queueSocialReflection(captureSocialReflection(event),{action:'reply',replied:true},async()=>({text:'{"action":'}));
 assert.equal(getSocialReflectionQueueStats().durablePending,1);
 const saved=structuredClone(store.readDb().socialV2.reflectionQueue);assert.equal(saved[0].attempts,1);
 assert.ok(!JSON.stringify(saved).includes('FORBIDDEN_OTHER_ROOM'));
 resumeSocialReflections(Date.now()+11_000,valid);await waitForBackgroundTasks(3000);
 assert.equal(getSocialReflectionQueueStats().durablePending,0);assert.equal(readSocialPerson(store.readDb(),'member').affinity.score,51);
 seed();await queueSocialReflection(captureSocialReflection(event),{action:'reply',replied:true},async()=>{
   store.updateDb(db=>{db.messages=[];});return {text:JSON.stringify(assessment())};
 });
 assert.equal(readSocialPerson(store.readDb(),'member'),null,'deleting messages while reflection runs cannot resurrect their memory');
 assert.equal(getSocialReflectionQueueStats().durablePending,0);
 seed();
 const before=JSON.stringify(store.readDb().socialV2.people);
 const participation=await assessSocialParticipation({...event,socialDirect:false},'initial',async()=>({text:JSON.stringify({action:'pass',addressee:'member',reason:'别人正在对话'}),usage:{total_tokens:1}}));
 assert.equal(participation.action,'pass');assert.equal(JSON.stringify(store.readDb().socialV2.people),before,'foreground participation never writes relationships');
 const malformed=await assessSocialParticipation({...event,socialDirect:false},'initial',async()=>({text:JSON.stringify({action:['reply'],addressee:'bot',reason:'invalid action type'})}));
 assert.equal(malformed,null,'arrays must not be coerced into closed semantic enums');
 console.log('PASS background social: scope privacy, duplicate suppression, stale revision guard, pass updates, invalid evidence rejected, foreground participation read-only');
}finally{await waitForBackgroundTasks(3000);cleanupTestDir(directory);}
