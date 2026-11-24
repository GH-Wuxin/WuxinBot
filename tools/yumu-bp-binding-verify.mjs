// Real quick-router/persistence/OneBot transport. Only a loopback fake Yumu;
// no QQ, osu! API, LLM, or production stores. Run: node --import tsx tools/yumu-bp-binding-verify.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {createTestDataDir,assertNotProduction,cleanupTestDir} from './test-isolation.mjs';

const dir = createTestDataDir('yumu-bp-binding');
assertNotProduction(dir);
// Even a missing DATA_DIR can only resolve to another directory in this fixture.
Object.assign(process.env,{APPDATA:dir,WUXIN_PRODUCTION_DATA_DIR:path.join(dir,'unused-sentinel'),NODE_ENV:'test',BRIDGE_OUTPUT_DIR:path.join(dir,'bridge'),BRIDGE_SETTLE_MS:'5',BRIDGE_MAX_POST_REPLY_MS:'20'});
const server = new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>server.once('listening',resolve));
process.env.BRIDGE_URL_YUMU = 'ws://127.0.0.1:'+server.address().port;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII=';
const calls = [], fetches = [];
const savedFetch = globalThis.fetch;
globalThis.fetch = async input => { fetches.push(String(input)); throw Error('Unexpected outgoing fetch in offline BP test'); };
let response = 'image';
server.on('connection',socket=>socket.on('message',data=>{
  const m = JSON.parse(String(data));
  if(m.post_type!=='message') return;
  calls.push(m);
  if(response==='drop') return socket.close();
  const message = response==='image' ? [{type:'image',data:{file:'base64://'+png}}]
    : response==='auth' ? '你的令牌失效或是没有绑定。请授权。(!bi)' : 'Provider text';
  socket.send(JSON.stringify({action:'send_msg',params:{message},echo:'fixture'}));
}));
try {
  const {getDataDir,ensureStore,readDb,writeDb} = await import('../server/store.ts');
  const {handleQuickCommand,matchQuickCommand} = await import('../server/bot/quickRouter.ts');
  const {settlePendingQuickObservations} = await import('../server/bot/quickContext.ts');
  assert.equal(fs.realpathSync(getDataDir()),fs.realpathSync(dir));
  ensureStore();
  const db = structuredClone(readDb());
  db.groups = [{groupId:'919191',enabled:true,mode:'chat'}];
  db.settings.globalPaused = false;
  db.osuBindings = {'10001':{osuUserId:707,osuUsername:'Bound Player'},'10002':808,'10003':{username:'Name Only'}};
  writeDb(db);
  let seq = 0;
  async function run(command,wire,options={}) {
    response = options.response ?? 'image';
    const event = {type:'group',groupId:'919191',userId:options.userId ?? '10001',nickname:'Fixture',text:command,
      messageId:'bp-test-'+(++seq),atTargets:options.at ?? [],raw:{}};
    const sent = [], before = calls.length;
    const match = matchQuickCommand(event);
    assert.equal(match.def.source,'yumu');
    const result = await handleQuickCommand(event,async(_e,m)=>sent.push(m),db,match,{isAdmin:false,isOwner:false});
    await settlePendingQuickObservations(event);
    assert.equal(result.replied,true);
    assert.equal(sent.length,1);
    assert.equal(calls.length-before,wire ? 1 : 0);
    if(wire) {
      const request = calls.at(-1);
      assert.equal(request.raw_message,wire);
      assert(!(Array.isArray(request.message) && request.message.some(s=>s.type==='at')), 'target must not be sent twice');
    }
    const row = readDb().messages.findLast(m=>m.role==='assistant' && m.replyToMessageId===event.messageId);
    assert(row,'missing assistant observation');
    if(response==='image' && wire) {
      const file = /^\[CQ:image,file=(.+)\]$/.exec(sent[0])?.[1];
      assert(file && fs.readFileSync(fileURLToPath(file)).equals(Buffer.from(png,'base64')),'forward actual provider image, not a replacement');
      assert.match(row.content,/雨沐 BP 面板/); assert.match(row.content,/结果见原图/);
      assert.equal(row.media.images[0],sent[0]);
      assert(!row.pendingQuickId);
      if(options.evidence) assert(row.content.includes(options.evidence));
    } else if(options.expect) {
      assert.match(sent[0],options.expect);
      assert(row.content.includes(sent[0]));
    }
    assert.deepEqual(fetches,[], 'must not fetch scores or hydrate filtered observations with unfiltered BP');
  }
  await run('!b client=lazer','!b uid=707 client=lazer',{evidence:'client=lazer'});
  await run('!b Other Player client=lazer','!b Other Player client=lazer',{evidence:'查询对象：Other Player；'});
  await run('!bs [CQ:at,qq=10002] :mania mod=dt pp >= 500 #2','!bs :mania uid=808 mod=dt pp >= 500 #2');
  await run('!b :m uid=999 client=stable','!b :m uid=999 client=stable',{userId:'unbound'});
  await run('!b qq=10003 星数≥7','!b qq=10003 星数≥7',{userId:'unbound'});
  await run('!b +HR','!b uid=808 +HR',{at:['10002']});
  await run('!b title="Blue  Zenith :m"','!b Name Only title="Blue  Zenith :m"',{userId:'10003'});
  await run('!b title=Blue Zenith','!b uid=707 title=Blue Zenith');
  await run('!b pp>=500 Other Player','!b pp>=500 Other Player',{evidence:'查询对象：Other Player；'});
  await run('!b :mania','!b :mania uid=707');
  await run('!b','!b Bound Player',{response:'text',expect:/Provider text/});
  await run('!bs 3-5','!bs Bound Player 3-5',{response:'text',expect:/Provider text/});
  await run('!bs # 5','!bs Bound Player # 5',{response:'text',expect:/Provider text/});
  await run('!b # 155 pp>=400','!b uid=707 # 155 pp>=400');
  await run('!b client=lazer',null,{userId:'unbound',expect:/你还没绑定/});
  await run('!b mod=DT',null,{at:['12345'],expect:/对方还没绑定/});
  await run('!b client=lazer','!b uid=707 client=lazer',{response:'drop',expect:/备用查询不支持这组 BP 筛选条件/});
  await run('!b Other Player +DT','!b Other Player +DT',{response:'drop',expect:/备用查询不支持这组 BP 筛选条件/});
  await run('!b client=lazer','!b uid=707 client=lazer',{response:'auth',expect:/^你的令牌失效或是没有绑定。请授权。$/});
  console.log('PASS '+seq+' offline Yumu BP routing cases; no external fetches');
} finally {
  globalThis.fetch = savedFetch;
  for(const socket of server.clients) socket.terminate();
  await new Promise(resolve=>server.close(resolve));
  cleanupTestDir(dir);
}
