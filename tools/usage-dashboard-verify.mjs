import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {buildUsageStats,initializeUsageHistory} from '../server/usage.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executablePath=[process.env.WUXIN_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&fs.existsSync(p));
assert.ok(executablePath,'Headless Chromium required');
const now=Date.parse('2026-11-09T05:20:00Z');
const events=Array.from({length:40},(_,i)=>({createdAt:new Date(now-i*3600_000).toISOString(),totalTokens:1000+i*100,promptTokens:800+i*80,completionTokens:200+i*20,cachedTokens:400,cacheMetricsAvailable:true}));
events.push({createdAt:'2026-11-03T02:00:00Z',totalTokens:5000,promptTokens:4000,completionTokens:1000,cachedTokens:2000,cacheMetricsAvailable:true});
const usage={totalTokens:212000000,promptTokens:200000000,completionTokens:12000000,requests:70000,cachedTokens:10000000,cacheMeasuredPromptTokens:20000000,cacheMeasuredRequests:800};
usage.history=initializeUsageHistory(usage,events,now);
const stats=buildUsageStats(usage,events,now);
const initial={settings:{model:'fixture'},usage:{...usage,history:undefined},usageStats:stats,groups:[],messages:[],experience:{}};
const bundle=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {DashboardPage} from './src/pages/Dashboard/index.jsx';
 import './src/styles/tokens.css';import './src/styles/globals.css';import './src/styles/components.css';
 import './src/styles/prototype.css';import './src/styles/overrides.css';import './src/pages/Dashboard/usage.css';
 function Fixture(){const [db,setDb]=React.useState(${JSON.stringify(initial)});window.updateUsage=setDb;return <DashboardPage db={db} oneBot={{}} saveSettings={async()=>{}} refreshState={async()=>{}} onNavigate={()=>{}}/>;}
 createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,write:false,outdir:'out'});
const server=http.createServer((req,res)=>{
 const file=bundle.outputFiles.find(f=>'/'+path.basename(f.path)===req.url);
 if(file){res.setHeader('Content-Type',file.path.endsWith('.css')?'text/css':'text/javascript');return res.end(file.contents);}
 if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({ok:true,llm:{avgLatencyMs:1500}}));}
 res.setHeader('Content-Type','text/html;charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root" class="console-v2" style="padding:24px"></div><script src="/stdin.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({executablePath,headless:true});
 const page=await browser.newPage({viewport:{width:1380,height:1050},timezoneId:'America/New_York'}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto('http://127.0.0.1:'+server.address().port);
 const card=page.locator('.usage-card'),buttons=card.locator('.usage-bar');
 const sum=(rows,key)=>rows.reduce((s,p)=>s+Number(p[key]||0),0);
 const checkRange=async(period,label,rows)=>{
  await card.getByRole('button',{name:label,exact:true}).click();await page.waitForFunction(p=>document.querySelector('.usage-card').dataset.period===p,period);
  assert.equal(await buttons.count(),rows.length);assert.equal(Number(await card.locator('.usage-total').getAttribute('data-value')),sum(rows,'totalTokens'));
  assert.equal(await card.locator('[data-usage="input"]').innerText(),sum(rows,'promptTokens').toLocaleString('en-US'));
  assert.equal(await card.locator('[data-usage="output"]').innerText(),sum(rows,'completionTokens').toLocaleString('en-US'));
  assert.equal(await card.locator('.usage-requests').innerText(),sum(rows,'requests').toLocaleString('en-US')+' 次请求');
  const ticks=await card.locator('.usage-axis span').evaluateAll(els=>els.map(e=>({start:e.dataset.start,label:e.textContent})));
  for(const tick of ticks)assert.ok(rows.some(p=>String(p.start)===tick.start&&p.label===tick.label),'Axis label must refer to a real displayed bucket');
  assert.ok(!(await card.locator('.usage-axis').innerText()).includes('24:00'));
 };
 await checkRange('hourly24','24 小时',stats.hourly24);
 assert.equal(await card.locator('.usage-axis span').first().innerText(),'14:00');
 await buttons.first().hover();await card.getByRole('tooltip').waitFor();assert.ok((await card.getByRole('tooltip').innerText()).includes('11/08 14:00'));
 const shifted=buildUsageStats(usage,[],now+3600_000);
 await page.evaluate(db=>window.updateUsage(db),{...initial,usageStats:shifted});
 await page.waitForFunction(()=>document.querySelector('.usage-axis span').textContent==='15:00');
 assert.ok((await card.getByRole('tooltip').innerText()).includes('11/08 15:00'),'Hover text must update when buckets roll without pointer movement');
 await page.evaluate(db=>window.updateUsage(db),initial);
 await checkRange('daily7','7 天',stats.daily7);await buttons.last().focus();assert.ok((await card.getByRole('tooltip').innerText()).includes('11/09'));
 if(process.env.WUXIN_USAGE_SCREENSHOT_DIR){fs.mkdirSync(process.env.WUXIN_USAGE_SCREENSHOT_DIR,{recursive:true});await card.screenshot({path:path.join(process.env.WUXIN_USAGE_SCREENSHOT_DIR,'usage-seven-days.png')});}
 await checkRange('daily30','30 天',stats.daily30);assert.equal(await card.locator('.usage-note').count(),1,'Missing historical data must be disclosed');
 await checkRange('month','本月',stats.month);assert.equal(await card.locator('.usage-axis span').first().innerText(),'11/1');
 await card.getByRole('button',{name:'总用量',exact:true}).click();assert.equal(Number(await card.locator('.usage-total').getAttribute('data-value')),usage.totalTokens);
 assert.equal(await buttons.count(),0);assert.equal(await card.locator('.usage-axis').count(),0);assert.equal(await card.locator('[data-usage="cache-rate"]').innerText(),'50.0%');
 await page.setViewportSize({width:390,height:900});await checkRange('hourly24','24 小时',stats.hourly24);await buttons.last().hover();
 const overflow=await card.evaluate(e=>e.scrollWidth>e.clientWidth+2);assert.equal(overflow,false,'Usage card must fit narrow screens, including tooltip');
 if(process.env.WUXIN_USAGE_SCREENSHOT_DIR)await card.screenshot({path:path.join(process.env.WUXIN_USAGE_SCREENSHOT_DIR,'usage-mobile.png')});
 await page.evaluate(db=>window.updateUsage(db),{...initial,usage:{},usageStats:buildUsageStats({},[],now)});
 await page.getByText('所选时段暂无已记录用量',{exact:true}).waitFor();assert.equal(await card.locator('[data-usage="cache-rate"]').innerText(),'—');
 assert.ok(!(await card.innerText()).includes('NaN'));assert.deepEqual(errors,[]);
 console.log('PASS usage dashboard: five ranges, matching totals and details, real axes, live hover rollover, browser timezone independence, partial history, lifetime total, narrow layout and empty state');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
