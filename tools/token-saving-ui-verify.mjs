import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = [process.env.WUXIN_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', chromium.executablePath()].find(p => p && fs.existsSync(p));
assert.ok(executablePath, 'Headless Chromium required');
const initial = { settings: { tokenSavingMode: false, memoryUpdateEvery: 30, pippiActivityEnabled: true }, usage: {}, usageStats: {}, groups: [], messages: [], experience: {} };
const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import {api} from './src/lib/api.js';
  import {DashboardPage} from './src/pages/Dashboard/index.jsx';
  import './src/styles/tokens.css'; import './src/styles/globals.css'; import './src/styles/components.css';
  import './src/styles/prototype.css'; import './src/styles/overrides.css';
  function Fixture(){const [db,setDb]=React.useState(${JSON.stringify(initial)}); return <DashboardPage db={db} oneBot={{}}
    refreshState={async()=>{}} onNavigate={()=>{}} saveSettings={async patch=>{const result=await api('/api/settings',{method:'POST',body:patch});setDb(result.db);}}/>;}
  createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, write: false, outdir: 'out' });
let fail = false; const patches = [], current = structuredClone(initial);
const server = http.createServer(async (req, res) => {
  const file = bundle.outputFiles.find(f => '/' + path.basename(f.path) === req.url);
  if (file) { res.setHeader('Content-Type', file.path.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(file.contents); }
  if (req.url.startsWith('/api/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/settings') {
      if (fail) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: '测试保存失败' })); }
      const patch = JSON.parse(raw); patches.push(patch); Object.assign(current.settings, patch);
      return res.end(JSON.stringify({ ok: true, db: current }));
    }
    return res.end(JSON.stringify({ ok: true, llm: {} }));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root" class="console-v2" style="padding:24px"></div><script src="/stdin.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true }); const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '开启节能模式', exact: true }).click();
  await page.getByRole('button', { name: '节能模式：已开启', exact: true }).waitFor();
  assert.deepEqual(patches, [{ tokenSavingMode: true }]);
  assert.equal(current.settings.memoryUpdateEvery, 30); assert.equal(current.settings.pippiActivityEnabled, true);
  assert.ok(await page.getByText(/画像仍会更新/).isVisible());
  fail = true; await page.getByRole('button', { name: '节能模式：已开启', exact: true }).click();
  await page.getByRole('alert').waitFor(); assert.equal(current.settings.tokenSavingMode, true);
  fail = false; await page.getByRole('button', { name: '节能模式：已开启', exact: true }).click();
  await page.getByRole('button', { name: '开启节能模式', exact: true }).waitFor(); assert.equal(current.settings.tokenSavingMode, false);
  assert.equal(await page.getByText(/画像仍会更新/).count(), 0); assert.deepEqual(errors, []);
  console.log('PASS overview saving toggle: immediate save, failure feedback, original preferences retained');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
