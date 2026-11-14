import assert from 'node:assert/strict';
import {createTestDataDir, cleanupTestDir, assertNotProduction} from './test-isolation.mjs';
const dir = createTestDataDir('wuxin-mention-length');
process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test'; assertNotProduction(dir);
try {
  const store = await import('../server/store.ts');
  const {buildPrompt, groupReplyLengthPrompt} = await import('../server/bot/prompt.ts');
  store.ensureStore(); const db = structuredClone(store.readDb());
  db.settings.selfQq = '10002'; db.settings.ownerQq = '10001';
  const base = {type:'group', groupId:'20001', userId:'10003', nickname:'fixture', messageId:'length-case', text:'pippi解释一下', atTargets:[], images:[]};
  const group = {groupId:'20001', enabled:true, mode:'natural'};
  const {oneBotToInternal} = await import('../server/bot/inboundContext.ts');
  const rawBase={post_type:'message',message_type:'group',group_id:20001,user_id:10003,message_id:42,self_id:10002,sender:{nickname:'fixture'}};
  for(const [message,expected] of [
    [[{type:'at',data:{qq:'10002'}},{type:'text',data:{text:'解释一下'}}],true],
    [[{type:'text',data:{text:'@Pippi [CQ:at,qq=10002]'}}],false],
    [[{type:'reply',data:{id:'9'}},{type:'text',data:{text:'pippi'}}],false],
    ['[CQ:at,qq=10002]解释一下',true],
    ['@Pippi解释一下',false],
  ]) {
    const event=oneBotToInternal({...rawBase,message});
    assert.ok(groupReplyLengthPrompt(db,event).includes(expected?'@ 不代表必须长答':'都按简短群聊回应'));
  }
  const cases = [
    ['actual self mention', {atTargets:['10002']}, true],
    ['numeric protocol id', {atTargets:[10002]}, true],
    ['mixed self and member', {atTargets:['10004','10002']}, true],
    ['member only', {atTargets:['10004']}, false],
    ['at all', {atTargets:['all']}, false],
    ['plain name', {text:'pippi'}, false],
    ['plain at text', {text:'@Pippi @10002'}, false],
    ['name flag not protocol', {nameMentioned:true,socialDirect:true}, false],
    ['quoted self mention', {quotedMessage:{userId:'10004',text:'@Pippi',atTargets:['10002']}}, false],
    ['natural continuation', {text:'为什么'}, false],
  ];
  for (const saving of [false,true]) {
    db.settings.tokenSavingMode=saving;
    for (const [name,patch,long] of cases) {
      const event={...base,...patch};
      const messages=buildPrompt(db,group,event,{policy:'normal'});
      const system=messages[0].content;
      assert.ok(system.includes(long?'@ 不代表必须长答':'都按简短群聊回应'), `${saving} ${name}`);
      assert.equal((system.match(/【本轮群聊篇幅】/g)||[]).length,1);
      assert.ok(system.includes('长句'));
      assert.equal(system.includes('通常只说一句短句'), !long);
      if(!long) assert.ok(system.includes('不得用逗号把多个意思串成长难句'));
    }
    for(const event of [{...base,type:'private',atTargets:['10002']},{...base,text:'/w info',atTargets:['10002']}]) {
      assert.ok(!buildPrompt(db,group,event,{policy:'normal'})[0].content.includes('【本轮群聊篇幅】'));
    }
  }
  for (const scene of ['serious','osu_analysis']) {
    assert.ok(groupReplyLengthPrompt(db,base,scene).includes('都按简短群聊回应'));
    assert.ok(groupReplyLengthPrompt(db,{...base,atTargets:['10002']},scene).includes('@ 不代表必须长答'));
    for (const saving of [false,true]) {
      db.settings.tokenSavingMode=saving;
      const prompt=buildPrompt(db,group,{...base,text:'请详细解释复杂问题'},{policy:'normal'},{scene})[0].content;
      assert.ok(prompt.includes('都按简短群聊回应'));
    }
  }
  db.settings.selfQq=''; assert.ok(groupReplyLengthPrompt(db,{...base,atTargets:['']}).includes('都按简短群聊回应'));
  console.log('mention length: actual self/member/all, plain text, quoted mention, missing self, private/command, saving and full prompt PASS');
} finally {cleanupTestDir(dir);}