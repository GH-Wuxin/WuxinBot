import { readDb, updateDb } from '../../store.js';
import { runBackgroundTask } from '../../backgroundTasks.js';
import { traceEvent } from '../../requestTrace.js';
import { completeChat, thinkingParamsForLevel } from '../llm.js';
import { reasoningEnabledFor } from '../reasoningRouter.js';
import { tokenSaving } from '../tokenSaving.js';
import { isReplyProcessAborted } from '../replyProcesses.js';
import { messageAccount, messageInConversation } from '../../messageFacts.js';
import { parseSocialAssessment, recentSocialChanges, socialTimeline } from './runtime.js';
import { ownerAuthorityPrompt, SOCIAL_ASSESSMENT_PROMPT } from './prompts.js';
import { commitSocialAssessment, isSystemOwner, readSocialPerson, readSocialView, socialScope } from './state.js';
import { commitSelfProposal, readPippiSelf, selfContext, SELF_PROPOSAL_GUIDANCE } from './self.js';
import type { SocialAction, SocialEvent } from './types.js';

let queueTail: Promise<unknown> = Promise.resolve();
const pending = new Set<string>();
const MAX_PENDING = 128;
let overflow=0;
let recoveryTimer: ReturnType<typeof setInterval>|undefined;
export function getSocialReflectionQueueStats(){
  const saved=readDb().socialV2.reflectionQueue||[];
  return {pending:pending.size,maxPending:MAX_PENDING,overflow,durablePending:saved.filter(j=>j.attempts<3).length,exhausted:saved.filter(j=>j.attempts>=3).length};
}
function removeSaved(key:string){updateDb(db=>{db.socialV2.reflectionQueue=(db.socialV2.reflectionQueue||[]).filter(j=>j.key!==key);});}
function hasSources(db:any,snapshot:ReturnType<typeof captureSocialReflection>){
  return snapshot.ids.every(id=>db.messages.some(m=>String(m.sourceMessageId||m.messageId||m.id)===id&&m.role==='user'
    &&String(m.senderId||m.userId)===snapshot.event.userId&&messageInConversation(m,snapshot.event,snapshot.account)));
}

/** Restart/retry recovery uses scoped message IDs; deleted evidence stays deleted. */
export function resumeSocialReflections(now=Date.now(),invoke=completeChat){
  const db=readDb();if(db.settings.socialV2Enabled!==true||db.settings.globalPaused||tokenSaving(db))return;
  for(const job of [...(db.socialV2.reflectionQueue||[])]){
    if(pending.size>=MAX_PENDING)break;
    if(pending.has(job.key)||job.attempts>=3||job.lastAttemptAt&&now-Date.parse(job.lastAttemptAt)<10_000)continue;
    if(job.scope!==socialScope(job.event)||job.account!==messageAccount(db,job.event)){removeSaved(job.key);continue;}
    const timeline=socialTimeline(db,job.event,db.messages.length).filter(m=>job.timelineIds.includes(m.messageId));
    if(!job.ids.every(id=>timeline.some(m=>m.messageId===id&&m.senderId===job.event.userId))){removeSaved(job.key);continue;}
    queueSocialReflection({event:structuredClone(job.event),scope:job.scope,account:job.account,ids:[...job.ids],timeline},job.outcome,invoke);
  }
}
export function startSocialReflections(){
  if(recoveryTimer)return;
  recoveryTimer=setInterval(()=>{try{resumeSocialReflections();}catch(error){traceEvent('ERROR','social_reflection_recovery_failed',{error:String(error)});}},10_000);
  recoveryTimer.unref?.();resumeSocialReflections();
}
export function stopSocialReflections(){if(recoveryTimer)clearInterval(recoveryTimer);recoveryTimer=undefined;}

/** Capture this conversation before asynchronous work can see a later turn. */
export function captureSocialReflection(event: SocialEvent) {
  const db=readDb(), scope=socialScope(event);
  return {
    event: {source:event.source,type:event.type,groupId:event.groupId,userId:event.userId,nickname:event.nickname,
      messageId:event.messageId,text:event.text,atTargets:[...(event.atTargets||[])],replyMessageId:event.replyMessageId,
      socialDirect:event.socialDirect,socialNamed:event.socialNamed} as SocialEvent,
    scope,account:messageAccount(db,event),ids:[...(event.socialMessageIds||[event.messageId])],
    timeline:structuredClone(socialTimeline(db,event,40)),
  };
}

/** No sends and no participation changes are permitted in detached reflection. */
export function queueSocialReflection(snapshot: ReturnType<typeof captureSocialReflection>, outcome: {action:SocialAction;replied:boolean}, invoke=completeChat) {
  const event=snapshot.event, key=`${snapshot.scope}/${event.userId}/${snapshot.ids.join(',')}`;
  if(pending.has(key)||isReplyProcessAborted()||tokenSaving(readDb()))return;
  if(snapshot.ids.some(id=>readDb().socialV2.processed.includes(`${snapshot.scope}/${event.userId}/${id}`)))return;
  const saved=readDb().socialV2.reflectionQueue?.find(j=>j.key===key);
  if(saved?.attempts>=3)return;
  const queuedAt=saved?.queuedAt||new Date().toISOString();
  if(!saved)updateDb(db=>{
    db.socialV2.reflectionQueue=[...(db.socialV2.reflectionQueue||[]),{key,event:structuredClone(event),scope:snapshot.scope,account:snapshot.account,
      ids:[...snapshot.ids],timelineIds:snapshot.timeline.map(m=>m.messageId),outcome:{...outcome},queuedAt,attempts:0}];
  });
  if(pending.size>=MAX_PENDING){overflow++;traceEvent('GATE','social_reflection_deferred',{status:'busy',pending:pending.size});return;}
  pending.add(key);
  // One dispatcher avoids filling the shared background admission queue with
  // reflections during a burst. Other memory/profile work keeps its slot too.
  const previous=queueTail;
  const job=runBackgroundTask('social.reflection',async()=>{
    await previous;
    const db=readDb();
    // person/view and recent history must come from the same post-wait DB
    // snapshot. A job queued earlier must still see legitimate commits that
    // completed while it was waiting; only records created after this read are
    // excluded as future anomalies.
    const snapshotAt=new Date().toISOString();
    if(db.settings.socialV2Enabled!==true||db.settings.globalPaused||tokenSaving(db))return;
    if(!hasSources(db,snapshot)){removeSaved(key);return;}
    if(messageAccount(db,event)!==snapshot.account||event.type==='private'&&!isSystemOwner(db,event)){removeSaved(key);return;}
    if(event.type==='group'&&!db.groups.some(g=>String(g.groupId)===String(event.groupId)&&g.enabled)){removeSaved(key);return;}
    if(snapshot.ids.some(id=>db.socialV2.processed.includes(`${snapshot.scope}/${event.userId}/${id}`))){removeSaved(key);return;}
    updateDb(draft=>{const queued=draft.socialV2.reflectionQueue?.find(j=>j.key===key);if(queued){queued.attempts++;queued.lastAttemptAt=new Date().toISOString();}});
    const person=structuredClone(readSocialPerson(db,event.userId)), view=structuredClone(readSocialView(db,snapshot.scope,event.userId));
    const selfRevision=readPippiSelf(db).revision;
    const delivered=db.messages.filter(m=>m.role==='assistant'&&m.deliveryOutcome==='confirmed_success'
      &&messageInConversation(m,event,snapshot.account)&&snapshot.ids.includes(m.triggerMessageId||m.replyToMessageId||'')
      &&m.originModule!=='notice').map(m=>({messageId:String(m.sourceMessageId||''),text:String(m.content||'').slice(0,1600)}));
    const result=await invoke(db,{messages:[
      {role:'system',content:`${SOCIAL_ASSESSMENT_PROMPT}\n${SELF_PROPOSAL_GUIDANCE}\n${ownerAuthorityPrompt(db,event)}\n【回复后的关系整理】本轮已经完成参与决定和发送处理。只根据本次真实互动提出关系、情绪和经历更新，不重新决定是否回复、不生成正文、不调用工具。action 保持给定 outcome.action。confirmedReplies 才是确认已发出的内容；空列表不能推断已发送。没有新证据就填 0/null。`},
      {role:'user',content:JSON.stringify({target:{userId:event.userId,messageIds:snapshot.ids,text:event.text,atTargets:event.atTargets,replyTo:event.replyMessageId},
        outcome,confirmedReplies:delivered,relationship:person,currentConversation:view,
        recentRelationshipChanges:recentSocialChanges(db,snapshot.scope,event.userId,6,snapshotAt),
        selfContext:selfContext(db,snapshot.scope,event.userId),timeline:snapshot.timeline})}],
      maxTokens:8192,timeoutMs:60_000,requestMaxRetries:0,retryOnEmpty:false,temperature:0.2,
      ...thinkingParamsForLevel('low',reasoningEnabledFor(db)),responseFormat:{type:'json_object'},
      promptModule:'general',label:'Pippi 后台关系整理',tracePurpose:'social_reflection',traceRole:'background'});
    const assessment=parseSocialAssessment(result.text,[...new Set([...snapshot.ids,...snapshot.timeline.map(m=>m.messageId)])],isSystemOwner(db,event),snapshot.ids);
    assessment.action=outcome.action;
    updateDb(draft=>{
      if(draft.settings.socialV2Enabled!==true||tokenSaving(draft)||messageAccount(draft,event)!==snapshot.account)return;
      if(!hasSources(draft,snapshot)){draft.socialV2.reflectionQueue=(draft.socialV2.reflectionQueue||[]).filter(j=>j.key!==key);return;}
      if(event.type==='group'&&!draft.groups.some(g=>String(g.groupId)===String(event.groupId)&&g.enabled))return;
      if(event.type==='private'&&!isSystemOwner(draft,event))return;
      const committed=commitSocialAssessment(draft,{event,messageIds:snapshot.ids,assessment,
        expectedPersonRevision:person?.revision||0,expectedViewRevision:view?.revision||0});
      if(committed.applied)commitSelfProposal(draft,assessment.self,{scope:snapshot.scope,expectedRevision:selfRevision,requiredEvidenceIds:snapshot.ids,
        sources:snapshot.timeline.map(m=>({id:m.messageId,kind:'message' as const,scope:snapshot.scope,at:m.at,userId:m.senderId}))});
      traceEvent('GATE','social_reflection_committed',{status:committed.applied?'ok':'skipped',reason:committed.reason});
      draft.socialV2.reflectionQueue=(draft.socialV2.reflectionQueue||[]).filter(j=>j.key!==key);
    });
  });
  queueTail=job;
  void job.finally(()=>{pending.delete(key);});
  return job;
}
