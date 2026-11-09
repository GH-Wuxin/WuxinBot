import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {createTestDataDir,cleanupTestDir} from './test-isolation.mjs';

const directory=createTestDataDir('pippi-own-provenance');process.env.NODE_ENV='test';
const store=await import('../server/store.ts');store.ensureStore();
const facts=await import('../server/messageFacts.ts');
const provenance=await import('../server/messageProvenance.ts');
const archive=await import('../server/messageArchiveStorage.ts');
const {inspectOwnMessages}=await import('../server/bot/ownMessageInspection.ts');
const {sendOneBotMessage}=await import('../server/onebot.ts');
const {createBackup,restoreBackup,deleteBackup}=await import('../server/backup.ts');
const {handleQuickCommand,matchQuickCommand}=await import('../server/bot/quickRouter.ts');
let next=1000,echo=false,fail=false;const wire=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');wire.push(body);
 const messageId=++next;
 if(echo&&body.group_id)facts.observeSelfMessage({post_type:'message_sent',message_type:'group',self_id:'10002',user_id:'10002',group_id:body.group_id,message_id:messageId,message:body.message,time:Math.floor(Date.now()/1000)});
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fail?{status:'failed',retcode:100}:{status:'ok',retcode:0,data:{message_id:messageId}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
store.updateDb(db=>{db.settings={...db.settings,selfQq:'10002',ownerQq:'10001',globalPaused:false,tokenSavingMode:false,
 oneBotHttpUrl:`http://127.0.0.1:${server.address().port}`,oneBotWsUrl:'',oneBotAccessToken:''};
 db.groups=[{groupId:'20001',enabled:true,mode:'mention'},{groupId:'20002',enabled:true,mode:'mention'}];db.users=[];db.messages=[];});
const event={source:'onebot',type:'group',groupId:'20001',userId:'10003',nickname:'请求者',messageId:'user-request',text:'帮我看看',atTargets:['10002'],replyToCurrentMessage:true};
const send=provenance.sourceSender(sendOneBotMessage,{module:'conversation',operation:'generate_reply'},
 {code:'direct_reply',description:'ARCHIVE_ONLY_CAUSE：回应当前消息',audience:'requester'},provenance.messageTrigger(event,true));
const query=(args={},e=event)=>inspectOwnMessages(store.readDb(),e,args);
try{
 const sent=await send(event,'正文 [CQ:at,qq=10004]');
 let detail=query({message_id:String(sent.messageId)}).messages[0];
 assert.equal(detail.source.chain[0].module,'conversation');assert.equal(detail.source.cause.code,'direct_reply');
 assert.equal(detail.source.trigger.userId,'10003');assert.equal(detail.source.trigger.preview,'帮我看看');
 assert.deepEqual(detail.destination,{type:'group',id:'20001'});assert.deepEqual(detail.addressed_to,['10003']);
 assert.deepEqual(detail.mentions,['10003','10004']);assert.equal(detail.quoted_message_id,event.messageId);
 assert.equal(store.readDb().messages.at(-1).messageSource,undefined,'details must not bloat the rolling chat shard');
 assert.ok(store.readDb().messages.at(-1).provenanceRef);
 assert.equal(facts.findMessageFact(store.readDb(),event,sent.messageId).messageSource.chain[0].module,'conversation');
 const originalArchive=archive.readOwnArchive(store.getDataDir(),'10002','group:20001',{messageId:String(sent.messageId)});
 assert.throws(()=>archive.saveOwnArchive(directory,{...originalArchive,groupId:'20002'}),/scope_mismatch/);
 assert.equal(query({message_id:String(sent.messageId)}).messages[0].destination.id,'20001');
 const nativeCounter=next;next=Number(sent.messageId)-1;
 await send(event,'平台 ID 复用的新发送');next=nativeCounter+1;
 const reused=query({message_id:String(sent.messageId)});assert.equal(reused.platform_id_matches,2);
 assert.equal(reused.messages[0].text,'平台 ID 复用的新发送');
 assert.equal(query({record_id:originalArchive.id}).messages[0].text,'正文 ');
 assert.equal(store.readDb().messages.filter(m=>m.sourceMessageId===String(sent.messageId)).length,2,'a reused platform ID must not erase another real send from rolling context');

 const image=await sendOneBotMessage(event,'[CQ:image,file=G:/PRIVATE_MEDIA/pic.png]',{originModule:'random_image',suppressReply:true,
   ...provenance.sourceDetails({module:'random_image',operation:'random_draw'},
    {code:'random_draw_selected',description:'随机模块抽中图片，向群内发送。',audience:'conversation'},event)});
 detail=query({message_id:String(image.messageId)}).messages[0];
 assert.equal(detail.source.chain[0].module,'random_image');assert.equal(detail.image_count,1);
 assert.deepEqual(detail.addressed_to,[]);assert.deepEqual(detail.mentions,[]);assert.equal(detail.quoted_message_id,null);
 assert.ok(!JSON.stringify(detail).includes('PRIVATE_MEDIA'));
 const noQuote=await send(event,'不引用',{suppressReply:true});assert.equal(query({message_id:String(noQuote.messageId)}).messages[0].quoted_message_id,null);

 const forward=await send(event,'转发',{forwardNodes:[{type:'node',data:{uin:'10004',name:'原作者',content:'原作者文字 [CQ:image,file=G:/PRIVATE_MEDIA/forward.png]'}}]});
 detail=query({message_id:String(forward.messageId)}).messages[0];assert.equal(detail.quoted_message_id,null);
 assert.deepEqual(detail.forward_authors,[{nickname:'原作者',senderId:'10004',verified:false}]);assert.equal(detail.source.chain[0].module,'conversation');
 assert.equal(detail.image_count,1);assert.ok(!JSON.stringify(detail).includes('PRIVATE_MEDIA'));

 echo=true;const raced=await send(event,'回声先到');echo=false;
 const racedRows=query({limit:20}).messages.filter(m=>m.message_id===String(raced.messageId));assert.equal(racedRows.length,1);
 assert.equal(racedRows[0].source.certainty,'recorded');assert.equal(racedRows[0].source.chain[0].module,'conversation');
 fail=true;await assert.rejects(()=>send(event,'拒绝发送'));fail=false;
 assert.equal(query().messages.some(m=>m.delivery==='confirmed_failure'),false);
 assert.ok(query({include_unconfirmed:true,limit:20}).messages.some(m=>m.delivery==='confirmed_failure'&&m.source.chain[0].module==='conversation'));

 const outside=await sendOneBotMessage(event,'无来源入口',{suppressReply:true});
 detail=query({message_id:String(outside.messageId)}).messages[0];assert.equal(detail.source.certainty,'unknown');assert.deepEqual(detail.source.chain,[]);

 const privateEvent={...event,type:'private',groupId:'private',userId:'10001',messageId:'private-request'};
 const relay=provenance.sourceSender(sendOneBotMessage,{module:'external_bot_relay',operation:'query',producer:'kanon'},
   {code:'relay_query',description:'PRIVATE_TRIGGER_SECRET',audience:'specified',addressedTo:['10999']},
   {...provenance.messageTrigger(privateEvent,true),preview:'PRIVATE_TRIGGER_SECRET'});
 const relayed=await relay({...event,groupId:'20002'},'公开查询',{suppressReply:true});
 const hidden=query({message_id:String(relayed.messageId)});assert.deepEqual(hidden.messages,[]);
 const visible=query({message_id:String(relayed.messageId)},{...event,groupId:'20002'}).messages[0];
 assert.equal(visible.source.trigger.scope,'other_conversation');assert.ok(!JSON.stringify(visible).includes('PRIVATE_TRIGGER_SECRET'));
 assert.ok(!JSON.stringify(visible.source.trigger).includes('10001'));
 assert.equal(query({before:visible.record_id}).error,'invalid_cursor');
 assert.equal(query({groupId:'20002'}).ok,false);
 assert.equal(query({message_id:String(sent.messageId)},{...event,type:'private',groupId:'private',userId:'10003'}).ok,false);
 const foreignAccount={...store.readDb(),settings:{...store.readDb().settings,selfQq:'different-account'}};
 assert.deepEqual(inspectOwnMessages(foreignAccount,event,{message_id:String(sent.messageId)}).messages,[]);

 const quick={...event,text:'!ping',messageId:'quick-test'};
 await handleQuickCommand(quick,sendOneBotMessage,store.readDb(),matchQuickCommand(quick),{isOwner:false,isAdmin:false});
 detail=query().messages[0];assert.equal(detail.source.chain[0].module,'quick_command');assert.equal(detail.source.chain[0].operation,'ping');
 assert.ok(detail.source.cause.description.includes('!ping'));

 for(let i=0;i<9;i++)await send({...event,messageId:'page-'+i},'分页 '+i,{suppressReply:true});
 let cursor,ids=[];do{const page=query({limit:3,...(cursor?{before:cursor}:{})});assert.equal(page.ok,true);ids.push(...page.messages.map(m=>m.record_id));cursor=page.next_cursor;}while(cursor);
 assert.equal(new Set(ids).size,ids.length);assert.ok(ids.length>10,'archive exposes every page, not only five recent messages');

 const file=path.join(directory,archive.OWN_ARCHIVE_FILE),good=fs.readFileSync(file);
 fs.writeFileSync(file,'not a SQLite database');
 const degraded=await send(event,'档案故障仍发送');assert.equal(degraded.outcome,'confirmed_success');
 assert.equal(query().error,'archive_temporarily_unavailable');assert.equal(store.readDb().messages.at(-1).messageSource.certainty,'recorded');
 fs.writeFileSync(file,good);await facts.reconcileOwnMessageArchive();
 assert.equal(query({message_id:String(degraded.messageId)}).messages[0].source.certainty,'recorded');

 store.updateDb(db=>{for(let i=0;i<12010;i++)db.messages.push({id:'trim-'+i,role:'user',type:'group',groupId:'20001',userId:'10003',content:'普通历史',createdAt:new Date().toISOString()});});
 assert.ok(!store.readDb().messages.some(m=>m.sourceMessageId===String(sent.messageId)));
 assert.equal(query({message_id:String(sent.messageId)}).messages[0].source.cause.code,'direct_reply','archive survives chat-window retention');

 const restarted=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
   `const s=await import('./server/store.ts');const q=await import('./server/bot/ownMessageInspection.ts');const r=q.inspectOwnMessages(s.readDb(),${JSON.stringify(event)},{message_id:${JSON.stringify(String(sent.messageId))}});if(r.messages?.[0]?.source?.cause?.code!=='direct_reply')process.exit(1);console.log('archive-restart-ok');`],
   {cwd:process.cwd(),env:process.env,encoding:'utf8',windowsHide:true});
 assert.equal(restarted.status,0,restarted.stderr);assert.ok(restarted.stdout.includes('archive-restart-ok'));

 const snapshot=createBackup('manual');assert.equal(snapshot.ownMessageArchive,true);
 const afterSnapshot=await send(event,'备份之后真实发送的消息');
 fs.writeFileSync(path.join(directory,'db.json'),'{');
 const recovered=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
   `const s=await import('./server/store.ts');s.openStore();const q=await import('./server/bot/ownMessageInspection.ts');if(!q.inspectOwnMessages(s.readDb(),${JSON.stringify(event)},{message_id:${JSON.stringify(String(afterSnapshot.messageId))}}).messages?.length)process.exit(1);console.log('archive-core-recovery-ok');`],
   {cwd:process.cwd(),env:process.env,encoding:'utf8',windowsHide:true});
 assert.equal(recovered.status,0,recovered.stderr);assert.ok(recovered.stdout.includes('archive-core-recovery-ok'));
 archive.clearOwnArchive(directory,'group:20001');assert.deepEqual(query().messages,[]);
 assert.deepEqual(query({message_id:String(sent.messageId)}).messages,[]);
 assert.equal(facts.observeSelfMessage({post_type:'message_sent',message_type:'group',self_id:'10002',user_id:'10002',group_id:20001,message_id:sent.messageId,message:'清理后迟到回声'}),true);
 assert.deepEqual(query().messages,[],'cleared receipts cannot be resurrected by late self echoes');
 assert.ok(query({message_id:String(relayed.messageId)},{...event,groupId:'20002'}).messages.length);
 assert.equal(restoreBackup(snapshot.name).ok,true);assert.ok(query({message_id:String(sent.messageId)}).messages.length);
 deleteBackup(snapshot.name);assert.equal(fs.existsSync(path.join(directory,'backups',snapshot.name)+archive.ARCHIVE_BACKUP_SUFFIX),false);

 const protectedBefore=process.env.WUXIN_PRODUCTION_DATA_DIR;process.env.WUXIN_PRODUCTION_DATA_DIR=directory;
 try {assert.throws(()=>archive.clearOwnArchive(directory),/安全防护/);}finally{process.env.WUXIN_PRODUCTION_DATA_DIR=protectedBefore;}
 console.log('PASS own-message provenance: exact destination/quote/@, module and cause, requester vs broadcast, echo races, failures, unknown sources, cross-room/private/account privacy, complete cursor pages, independent fallback, retention/restart, backup/restore/purge and production guard');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));cleanupTestDir(directory);}
