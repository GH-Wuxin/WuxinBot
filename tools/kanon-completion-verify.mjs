import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require=createRequire(path.join(root,'package.json'));
const {WebSocketServer}=require('ws');
const profile='repository';

const output=path.join(process.env.KANON_TEST_DATA_DIR || (await import('node:os')).tmpdir(),`kanon-completion-${Date.now()}`);
delete process.env.BRIDGE_SELF_ID;
fs.mkdirSync(output,{recursive:true});
process.env.BRIDGE_OUTPUT_DIR=path.join(output,'images');
process.env.BRIDGE_TIMELINE='1';process.env.BRIDGE_TIMELINE_DIR=output;
process.env.BRIDGE_SETTLE_MS='160';process.env.BRIDGE_MAX_POST_REPLY_MS='320';
const wss=new WebSocketServer({host:'127.0.0.1',port:0});
await new Promise(resolve=>wss.once('listening',resolve));
process.env.BRIDGE_URL_KANON=`ws://127.0.0.1:${wss.address().port}`;
process.env.BRIDGE_URL_YUMU=process.env.BRIDGE_URL_KANON;
const {callLocalBot}=await import(pathToFileURL(path.join(root,'server/bots/localBridge.ts')).href);
let counter=0,passed=0;
const image=Buffer.from('image-fixture').toString('base64');
wss.on('connection',(socket,request)=>{
  let event,mode,replies=0;
  const send=payload=>{if(socket.readyState===1)socket.send(JSON.stringify(payload));};
  const reply=(text,isImage=false)=>send({action:'send_group_msg',echo:`${++replies}`,params:{message:[isImage?{type:'image',data:{file:`base64://${image}`}}:{type:'text',data:{text}}]}});
  const complete=(id=event.wuxin_request_id)=>send({post_type:'meta_event',meta_event_type:'wuxin_bridge',sub_type:'command_complete',wuxin_request_id:id});
  socket.on('message',raw=>{
    const message=JSON.parse(String(raw));
    if(message.post_type==='message'){
      event=message;mode=event.raw_message.slice('!case '.length);
      if(mode!=='other_bot')assert.equal(request.headers['x-wuxin-completion'],'1');
      if(mode==='other_bot'){assert.equal(request.headers['x-wuxin-completion'],undefined);assert.equal(event.wuxin_request_id,undefined);reply('other');return;}
      assert.match(event.wuxin_request_id,/^[a-f0-9-]{36}$/);
      if(mode==='empty'){complete();return;}
      if(mode==='late'){setTimeout(()=>{reply('late');complete();},120);return;}
      if(mode==='early'){complete();setTimeout(()=>reply('after early marker'),20);return;}
      if(mode==='terminal'){reply('finished');complete();reply('',true);return;}
      reply(mode);
      if(mode==='wrong'){complete('00000000-0000-0000-0000-000000000000');setTimeout(()=>reply('second'),35);}
      return;
    }
    if(message.status==='ok'&&message.echo){
      if(mode==='legacy'||mode==='other_bot')return;
      if(mode==='multi'&&message.echo==='1'){reply('',true);return;}
      if(mode==='wrong'&&message.echo==='1')return;
      complete();
    }
  });
});
function lastFinish(){return fs.readFileSync(path.join(output,'bridge-timeline.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.kind==='finish').at(-1);}
async function test(name,run){await run();passed++;console.log('PASS '+name);}
const call=(mode,bot='kanon',timeout=500)=>callLocalBot(bot,'!case '+mode,{groupId:'990012',userId:String(995000+counter++),nickname:'OfflineContract'},timeout);
try{
  await test('single reply finishes on correlated completion',async()=>{const r=await call('single');assert.equal(r.text,'single');assert.equal(r.frames,1);assert.equal(lastFinish().meta.endReason,'command_complete');assert.equal(lastFinish().meta.settleFired,false);});
  await test('multiple acknowledged frames are preserved',async()=>{const r=await call('multi');assert.equal(r.frames,2);assert.equal(r.images.length,1);assert.equal(r.text,'multi');assert.equal(lastFinish().meta.endReason,'command_complete');});
  await test('foreign request ID cannot truncate the reply',async()=>{const r=await call('wrong');assert.equal(r.frames,2);assert.equal(r.text,'wrong\nsecond');});
  await test('completion before any reply is ignored',async()=>{const r=await call('early');assert.equal(r.text,'after early marker');assert.equal(lastFinish().meta.endReason,'command_complete');});
  await test('completion with no reply does not fabricate success',async()=>{await assert.rejects(call('empty','kanon',70),/超时/);});
  await test('late reply and completion cannot revive timeout',async()=>{await assert.rejects(call('late','kanon',60),/超时/);});
  await test('legacy Kanon retains its settling window',async()=>{const r=await call('legacy');assert.equal(r.text,'legacy');assert.equal(lastFinish().meta.endReason,'settle');});
  await test('other bots retain the original protocol',async()=>{const r=await call('other_bot','yumu');assert.equal(r.text,'other');assert.equal(lastFinish().meta.endReason,'settle');});
  await test('terminal result cannot be mutated by trailing frames',async()=>{const r=await call('terminal');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(r.frames,1);assert.equal(r.images.length,0);});
  await test('concurrent requests remain isolated',async()=>{const all=await Promise.all(Array.from({length:12},()=>call('multi')));for(const r of all){assert.equal(r.frames,2);assert.equal(r.images.length,1);assert.equal(r.text,'multi');}});
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({profile,passed},null,2));
  console.log(JSON.stringify({profile,passed,output}));
}finally{for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));}
