import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import {chromium} from 'playwright-core';import {queryLogEntries} from '../server/logRecords.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executablePath=[process.env.WUXIN_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&fs.existsSync(p));
assert.ok(executablePath,'Headless Chromium required');
const now=Date.now(),initial={settings:{selfQq:'10002'},groups:[{groupId:'g1',name:'测试群一'},{groupId:'g2',name:'测试群二'}],messages:[],decisions:[],commandLogs:[],usageEvents:[]};
for(let i=0;i<180;i++){
 const at=new Date(now-180000+i*900).toISOString(),groupId=i%2?'g1':'g2';
 initial.messages.push({id:'m'+i,sourceMessageId:'m'+i,requestId:'r'+i,role:'user',type:'group',groupId,userId:'u'+i,nickname:'群友'+i,content:'今天的练习记录 '+i,createdAt:at});
 if(i%3===0)initial.messages.push({id:'a'+i,requestId:'r'+i,replyToMessageId:'m'+i,replyToUserId:'u'+i,role:'assistant',type:'group',groupId,userId:'bot',nickname:'Pippi',content:i===3?'我记得这条唯一回复：慢慢来就好':'练得挺稳呀 '+i,createdAt:at});
}
const current=structuredClone(initial),streams=new Set(),requests=[];let fail=false;
const bundle=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {LogsPage} from './src/pages/Logs/index.jsx';
 import './src/styles/tokens.css';import './src/styles/globals.css';import './src/styles/components.css';import './src/styles/prototype.css';import './src/styles/overrides.css';
 function Fixture(){const [db,setDb]=React.useState(${JSON.stringify(initial)});window.setFixtureDb=setDb;return <LogsPage db={db}/>;}
 createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,write:false,outdir:'out',define:{'import.meta.env.DEV':'false'}});
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1'),file=bundle.outputFiles.find(f=>'/'+path.basename(f.path)===url.pathname);
 if(file){res.setHeader('Content-Type',file.path.endsWith('.css')?'text/css':'text/javascript');return res.end(file.contents);}
 if(url.pathname==='/api/request-traces/stream'){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: '+JSON.stringify({type:'snapshot',traces:[]})+'\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;
 }
 if(url.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(url.pathname==='/api/logs'){
   requests.push(Object.fromEntries(url.searchParams));
   if(fail){res.statusCode=500;return res.end(JSON.stringify({ok:false,error:'模拟读取失败'}));}
   try{return res.end(JSON.stringify({ok:true,...queryLogEntries(current,[],Object.fromEntries(url.searchParams))}));}
   catch(error){res.statusCode=400;return res.end(JSON.stringify({ok:false,error:error.message}));}
  }
  return res.end(JSON.stringify({ok:true,traces:[]}));
 }
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root" class="console-v2" style="padding:24px"></div><script src="/stdin.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1380,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.waitForFunction(()=>document.querySelector('.rows')?.getAttribute('aria-busy')==='false');
 await page.getByRole('button',{name:'已回复',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.rows')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.log-item .log-reply-preview').length===8);
 assert.equal(await page.locator('.log-item').count(),8);assert.equal(await page.locator('.log-item .log-reply-preview').count(),8);
 assert.equal(await page.getByText('收到的消息',{exact:true}).count(),1);assert.equal(await page.getByText('Pippi 回复',{exact:true}).count(),1);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('2 / 8',{exact:true}).waitFor();
 const ids=await page.locator('.log-item').evaluateAll(items=>items.map(e=>e.dataset.entryId));await page.locator('.log-item').nth(2).click();
 const selected=await page.locator('.log-item.is-active').getAttribute('data-entry-id'),requestCount=requests.length;
 const fresh=new Date().toISOString();current.messages.push({id:'new',sourceMessageId:'new',requestId:'new-request',role:'user',type:'group',groupId:'g1',userId:'fresh',nickname:'新消息',content:'刚来的消息',createdAt:fresh},
  {id:'new-answer',requestId:'new-request',replyToMessageId:'new',replyToUserId:'fresh',role:'assistant',type:'group',groupId:'g1',userId:'bot',content:'新回复',createdAt:fresh});
 await page.evaluate(db=>window.setFixtureDb(db),current);
 for(const stream of streams)stream.write('data: '+JSON.stringify({type:'upsert',trace:{id:'new-request',status:'active',startedAt:fresh,events:[]}})+'\n\n');
 await page.getByRole('button',{name:'有新记录 · 点击更新',exact:true}).waitFor();
 assert.deepEqual(await page.locator('.log-item').evaluateAll(items=>items.map(e=>e.dataset.entryId)),ids);
 assert.equal(await page.locator('.log-item.is-active').getAttribute('data-entry-id'),selected);assert.equal(requests.length,requestCount,'Live messages must not refetch or reorder history');
 await page.getByRole('button',{name:'上一页',exact:true}).click();await page.getByText('1 / 8',{exact:true}).waitFor();
 assert.ok(!await page.locator('.log-item[data-entry-id="chat:message:new"]').count());
 await page.getByRole('button',{name:'有新记录 · 点击更新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.log-item')?.getAttribute('data-entry-id')==='chat:message:new');
 assert.equal(await page.locator('.log-item').first().getAttribute('data-entry-id'),'chat:message:new');
 await page.getByLabel('搜索日志').fill('唯一回复');await page.waitForFunction(()=>document.querySelectorAll('.log-item').length===1&&document.querySelector('.log-item')?.textContent.includes('唯一回复'));
 assert.ok((await page.locator('.log-conversation').innerText()).includes('今天的练习记录 3'));
 assert.ok((await page.locator('.log-conversation').innerText()).includes('慢慢来就好'));
 await page.getByLabel('筛选群聊').selectOption('g2');await page.getByText('没有匹配的记录。',{exact:true}).waitFor();
 await page.getByLabel('筛选群聊').selectOption('g1');await page.waitForFunction(()=>document.querySelectorAll('.log-item').length===1);
 await page.getByLabel('筛选日期').fill('2000-01-01');await page.getByText('没有匹配的记录。',{exact:true}).waitFor();
 await page.getByLabel('筛选日期').fill('');await page.waitForFunction(()=>document.querySelectorAll('.log-item').length===1);
 if(process.env.WUXIN_LOGS_SCREENSHOT)await page.screenshot({path:process.env.WUXIN_LOGS_SCREENSHOT,fullPage:true});
 fail=true;await page.getByRole('button',{name:'更新记录',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('.log-item').count(),1,'Read failure must keep visible records');
 fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role="alert"]')&&document.querySelector('.rows')?.getAttribute('aria-busy')==='false');
 assert.deepEqual(errors,[]);console.log('PASS logs UI: replied filter, paired transcript, stable pagination/selection during SSE, explicit refresh, old reply search, groups and failure recovery');
}finally{await browser?.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
