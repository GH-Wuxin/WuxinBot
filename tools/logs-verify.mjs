import assert from 'node:assert/strict';
import {correlateChatRecords,buildRequestEntries,filterLogEntries,queryLogEntries} from '../server/logRecords.ts';
const time=Date.parse('2026-10-27T00:00:00Z'),iso=n=>new Date(time+n).toISOString();
const user=(id,group='g',extra={})=>({id,role:'user',sourceMessageId:id,requestId:'r:'+id,groupId:group,type:'group',userId:'u',nickname:'测试用户',content:'原消息 '+id,createdAt:iso(0),...extra});
const reply=(id,parent,extra={})=>({id,role:'assistant',requestId:'r:'+parent,replyToMessageId:parent,replyToUserId:'u',groupId:'g',type:'group',userId:'bot',content:'回复 '+id,createdAt:iso(1),...extra});
let rows=correlateChatRecords([user('one'),reply('a','one'),reply('b','one')],[{id:'d',messageId:'one',groupId:'g',shouldReply:false,createdAt:iso(0)}]);
assert.equal(rows.length,1);assert.equal(rows[0].replies.length,2);
let entries=buildRequestEntries(rows,[]);assert.equal(entries[0].replied,true);assert.equal(entries[0].status,'replied');assert.equal(entries[0].blocked,false);
assert.equal(filterLogEntries(entries,'replied').length,1);assert.equal(filterLogEntries(entries,'all','回复 b').length,1);
assert.equal(filterLogEntries(buildRequestEntries(correlateChatRecords([user('not-sent')],[{id:'pending',groupId:'g',messageId:'not-sent',shouldReply:true}]),[]),'replied').length,0);

rows=correlateChatRecords([user('same','g1'),user('same','g2'),reply('scoped','same',{groupId:'g1'})],[]);
assert.equal(rows.find(r=>r.message?.groupId==='g1').replies.length,1);assert.equal(rows.find(r=>r.message?.groupId==='g2').replies.length,0);
rows=correlateChatRecords([user('legacy','g',{requestId:undefined}),reply('legacy-answer','legacy',{requestId:undefined}),reply('unknown','missing',{requestId:undefined,replyToMessageId:undefined})],[]);
assert.equal(rows.find(r=>r.message?.id==='legacy').replies[0].id,'legacy-answer');assert.equal(rows.filter(r=>r.orphanReply).length,1);
rows=correlateChatRecords([user('target','g',{requestId:undefined}),reply('via-decision','target',{requestId:'inferred-request',replyToMessageId:undefined})],
  [{id:'mapped',groupId:'g',messageId:'target',requestId:'inferred-request',userId:'u'}]);
assert.equal(rows.length,1);assert.equal(rows[0].replies[0].id,'via-decision');
rows=correlateChatRecords([user('bad'),reply('wrong-user','bad',{replyToUserId:'other'})],[]);
assert.equal(rows.find(r=>r.message?.id==='bad').replies.length,0);assert.equal(rows.filter(r=>r.orphanReply).length,1);
console.log('PASS exact reply grouping, legacy IDs, cross-room/user boundaries and actual-reply filtering');

const db={groups:[{groupId:'g',name:'测试群'}],messages:[],decisions:[],usageEvents:[],commandLogs:[]};
for(let i=0;i<900;i++)db.messages.push(user('m'+i,'g',{createdAt:iso(i)}));
db.messages.push(reply('old-answer','m1',{createdAt:iso(2),content:'只有这条回复里有 唯一答案'}));
const old=structuredClone(db);
let result=queryLogEntries(db,[],{filter:'replied'},time+1000);
assert.equal(result.total,1);assert.equal(result.entries[0].row.message.id,'m1','Search all retained history, not only latest 160/500');
assert.equal(queryLogEntries(db,[],{q:'唯一答案'},time+1000).total,1);
assert.equal(queryLogEntries(db,[],{q:'测试群',group:'g'},time+1000).total,900);
assert.equal(queryLogEntries(db,[],{group:'elsewhere'},time+1000).total,0);
assert.equal(queryLogEntries(db,[],{from:time+100,to:time+199},time+1000).total,100);
const snapshot=queryLogEntries(db,[],{page:1,pageSize:8},time+1000);
db.messages.push(user('newer','g',{createdAt:iso(1001)}),reply('later','m880',{createdAt:iso(1002)}));
db.decisions.push({id:'later-decision',messageId:'m880',groupId:'g',shouldReply:false,createdAt:iso(1003)});
const after=queryLogEntries(db,[{id:'transient',status:'active',startedAt:iso(300)}],{page:1,pageSize:8,asOf:snapshot.asOf},time+2000);
assert.deepEqual(after.entries.map(e=>e.id),snapshot.entries.map(e=>e.id));assert.equal(after.total,snapshot.total);
assert.equal(queryLogEntries(db,[],{filter:'replied',asOf:snapshot.asOf},time+2000).total,1);
assert.equal(queryLogEntries(db,[],{filter:'replied'},time+2000).total,2);
assert.deepEqual(old.messages.slice(0,900),db.messages.slice(0,900),'Projection must not mutate source');

db.usageEvents=[{requestId:'r:m1',groupId:'g',totalTokens:120,model:'fixture-model',usageKnown:true,createdAt:iso(4)},
  {requestId:'r:m1',groupId:'g',totalTokens:999,accountingExcluded:true,createdAt:iso(5)},
  {requestId:'r:m1',groupId:'other',totalTokens:800,createdAt:iso(5)}];
result=queryLogEntries(db,[],{filter:'replied',q:'fixture-model'},time+2000);
assert.equal(result.total,1);assert.equal(result.entries[0].tokens,120);
db.messages.push(user('private','private',{type:'private',createdAt:iso(200)}));
assert.equal(queryLogEntries(db,[],{group:'__private'},time+2000).total,1);
db.commandLogs.push({id:'cmd',command:'/w',subCommand:'info',groupId:'g',status:'error',rawText:'command fixture',createdAt:iso(100)});
assert.equal(queryLogEntries(db,[],{channel:'commands',filter:'failed'},time+2000).total,1);
for(const q of [{page:-1},{pageSize:1000},{asOf:'nope'},{from:500,to:1},{q:'x'.repeat(201)},{channel:'other'},{filter:'bogus'},{group:['g']}]) assert.throws(()=>queryLogEntries(db,[],q,time+2000));
console.log('PASS retained-history search, reply-text search, stable pages, date/group filters, ledger deduplication and validation');
