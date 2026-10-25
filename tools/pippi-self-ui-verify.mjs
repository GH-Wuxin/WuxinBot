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
const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client';
  import {SelfPanel} from './src/pages/Social/SelfPanel.jsx'; import {api} from './src/lib/api.js';
  import './src/styles/tokens.css'; import './src/styles/globals.css'; import './src/styles/components.css';
  import './src/styles/prototype.css'; import './src/styles/overrides.css'; import './src/pages/Social/social.css';
  function Fixture(){const [db,setDb]=React.useState({settings:{pippiActivityEnabled:false,pippiActivityDailyTokens:30000,pippiActivityMaxWakes:3,pippiActivityForumIds:[2,13]}});
    return <SelfPanel db={db} scope="group:room" refreshState={async()=>{}} saveSettings={async patch=>{await api('/api/settings',{method:'POST',body:patch});setDb({...db,settings:{...db.settings,...patch}});}}/>;}
  createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle: true, write: false, outdir: 'out' });
let experience = { id: 'actual', revision: 0, createdAt: '2026-10-26T00:00:00Z', scope: 'public', fact: '读了练习讨论', impression: '想听听后续',
  sources: [{ id: 'source', kind: 'reading', at: '2026-10-26T00:00:00Z', url: 'https://osu.ppy.sh/home/news/1', title: '实际来源' }], shared: [] };
let conflict = false, deleted = false; const settings = [], edits = [];
const server = http.createServer(async (req, res) => {
  const file = bundle.outputFiles.find(f => '/' + path.basename(f.path) === req.url);
  if (file) { res.setHeader('Content-Type', file.path.endsWith('.css') ? 'text/css' : 'text/javascript'); return res.end(file.contents); }
  if (req.url.startsWith('/api/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json'); const json = value => res.end(JSON.stringify(value));
    if (req.url === '/api/settings') { settings.push(JSON.parse(raw)); return json({ ok: true }); }
    if (req.method === 'PATCH') {
      edits.push(JSON.parse(raw)); if (conflict) { res.statusCode = 409; return json({ ok: false, error: '经历已变化，请刷新' }); }
      experience = { ...experience, ...JSON.parse(raw), revision: experience.revision + 1 }; return json({ ok: true });
    }
    if (req.method === 'DELETE') { deleted = true; return json({ ok: true }); }
    return json({ ok: true, self: { revision: 1, mood: { label: '好奇', reason: '看了新讨论', publicTone: '期待', scope: 'public', updatedAt: '2026-10-26T00:00:00Z' }, focus: [] },
      total: deleted ? 0 : 1, experiences: deleted ? [] : [experience], activity: { dailyTokens: 30000, tokens: 1500, unknownTokens: 200, wakes: 1, maxWakes: 3, logs: [] } });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/stdin.css"><div id="root" class="console-v2" style="padding:24px"></div><script src="/stdin.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('读了练习讨论', { exact: true }).waitFor();
  await page.getByText('允许自主阅读', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[type="checkbox"]')?.checked);
  assert.equal(await page.getByLabel('允许自主阅读').isChecked(), true);
  await page.getByLabel('后台每日 Token 额度').fill('25000');
  await page.getByRole('button', { name: '保存活动设置' }).click();
  await page.waitForFunction(() => !document.querySelector('button[disabled]'));
  assert.equal(settings[0].pippiActivityEnabled, true); assert.equal(settings[1].pippiActivityDailyTokens, 25000);
  await page.getByRole('button', { name: '校正', exact: true }).click();
  await page.getByLabel('实际经历').fill('校正后的真实经历');
  conflict = true; await page.getByRole('button', { name: '保存校正' }).click();
  await page.getByRole('alert').waitFor(); assert.equal(edits[0].revision, 0);
  conflict = false; await page.getByRole('button', { name: '保存校正' }).click();
  await page.getByText('校正后的真实经历', { exact: true }).waitFor();
  if (process.env.WUXIN_UI_SCREENSHOT) await page.screenshot({ path: process.env.WUXIN_UI_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 480, height: 1000 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'narrow layout must not overflow');
  await page.getByRole('button', { name: '忘记', exact: true }).click();
  await page.getByText('还没有值得留下的经历。阅读失败、未发送的草稿不会成为已完成的交流。', { exact: true }).waitFor();
  assert.equal(deleted, true); assert.deepEqual(errors, []);
  console.log('PASS Pippi console: toggle, budget, revision conflict, correction, forget, narrow layout');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
