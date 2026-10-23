import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browserPath=[process.env.WUXIN_TEST_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium',
  chromium.executablePath()].find(file=>file&&fs.existsSync(file));
assert.ok(browserPath,'A headless Chromium browser is required');
const bundle=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {MaintenancePage} from './src/pages/Maintenance/index.jsx';
  import './src/styles/tokens.css';import './src/styles/globals.css';
  import './src/styles/components.css';import './src/styles/prototype.css';import './src/styles/overrides.css';
  createRoot(document.getElementById('root')).render(<MaintenancePage/>);
`},bundle:true,write:false,outdir:'out',define:{'process.env.NODE_ENV':'"development"'}});
const files=new Map(bundle.outputFiles.map(file=>[path.basename(file.path),file.contents]));
let count=24,prunes=0,fail=false,restoreAttempts=0;
const server=http.createServer(async(req,res)=>{
  const name=req.url.slice(1);
  if(files.has(name)){res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/javascript');res.end(files.get(name));return;}
  if(req.url.startsWith('/api/')){
    res.setHeader('content-type','application/json');
    const reply=value=>res.end(JSON.stringify({ok:true,...value}));
    if(req.url==='/api/recalc-status')return reply({running:false});
    if(req.url==='/api/backups'&&req.method==='GET')return reply({retention:{auto:5,preRestore:5,manual:5},backups:Array.from({length:count},(_,i)=>({name:`auto-2026-10-23T10-${String(i).padStart(2,'0')}-00-000Z.json`,type:'auto',createdAt:`2026-10-23T10:${String(i).padStart(2,'0')}:00Z`,size:66_000_000}))});
    if(req.url==='/api/backups/prune'){
      prunes++;if(fail){res.statusCode=500;return res.end(JSON.stringify({ok:false,error:'测试磁盘只读'}));}
      const removed=Math.max(0,count-5);count=5;return reply({removed,failed:[]});
    }
    if(req.url.endsWith('/restore')){restoreAttempts++;res.statusCode=500;return res.end(JSON.stringify({ok:false,error:'测试恢复失败'}));}
    res.statusCode=404;res.end('{}');return;
  }
  res.setHeader('content-type','text/html; charset=utf-8');
  res.end('<!doctype html><html><link rel="stylesheet" href="/stdin.css"><div id="root" class="console-v2" style="padding:32px"></div><script src="/stdin.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({executablePath:browserPath,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'Asia/Shanghai'});
  page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText(/共 24 份/).waitFor();
  assert.match(await page.locator('tbody tr').first().innerText(),/18:23/,'UTC snapshot time is displayed in the local timezone, newest first');
  const open=async()=>{await page.getByRole('button',{name:'清理超限',exact:true}).click();await page.getByRole('dialog').waitFor();};
  await open();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(prunes,0);
  await open();await page.getByRole('dialog').getByRole('button',{name:'清理',exact:true}).click();
  await page.getByRole('status').filter({hasText:'已清理 19 份备份'}).waitFor();
  await page.getByText(/共 5 份/).waitFor();assert.equal(prunes,1);
  await open();await page.getByRole('dialog').getByRole('button',{name:'清理',exact:true}).click();
  await page.getByRole('status').filter({hasText:'没有符合条件'}).waitFor();
  fail=true;await open();await page.getByRole('dialog').getByRole('button',{name:'清理',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'测试磁盘只读'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'清理超限',exact:true}).isEnabled(),true);
  await page.locator('tbody tr').first().getByRole('button',{name:'恢复',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'恢复',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'测试恢复失败'}).waitFor();assert.equal(restoreAttempts,1);
  assert.equal(await page.getByRole('button',{name:'立即备份',exact:true}).isEnabled(),true,'restore failure must release the busy state');
  assert.deepEqual(errors,[]);
  console.log('PASS: real maintenance buttons, confirmation/cancel, cleanup/no-op feedback, failed operations, local dates and newest-first order');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
