// Optional headless visual smoke test; serves synthetic data only and never opens a desktop window.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const args = process.argv.slice(2), get = (name) => args[args.indexOf(name) + 1];
const executablePath = get('--browser'), output = path.resolve(get('--output'));
const directory = createTestDataDir('wuxin-social-ui'); process.env.DATA_DIR = directory; process.env.NODE_ENV = 'test';
const { ensureStore, readDb } = await import('../server/store.ts'); ensureStore();
const db = structuredClone(readDb());
db.settings.ownerQq = '10001'; db.settings.socialV2Enabled = true;
db.groups = [{ groupId: '20001', name: '夜晚的练习室', mode: 'natural', enabled: true }];
db.socialV2Summary = { revision: 1, people: 3 };
const at = new Date().toISOString();
const people = [
  { userId: '10001', nickname: 'Owner', affinity: { kind: 'owner', label: '特殊' }, familiarity: 60 },
  { userId: '10003', nickname: '小甲', affinity: { kind: 'ordinary', score: 78 }, familiarity: 42 },
  { userId: '10004', nickname: '阿乙', affinity: { kind: 'ordinary', score: 50 }, familiarity: 12 },
].map((p) => ({ ...p, revision: 1, updatedAt: at, view: { revision: 1, summary: '聊起最近的练习，会自然地分享遇到的难点。',
  preferredNames: ['小甲'], style: '直接自然，偶尔接梗，不反复起外号', mood: { label: '轻松', reason: '刚刚分享了练习顺利的消息', updatedAt: at }, updatedAt: at } }));
let data = { ok: true, people, directives: [], transitions: [], feedback: [], usage: { calls: 12, tokens: 13620 }, decisions: [
  { id: 'd1', userId: '10003', action: 'reply', reason: '“为什么”接着上一句解释，明确在问 Pippi。', evidenceIds: ['m12', 'm13'], durationMs: 1210, totalTokens: 900, stage: 'assessment', createdAt: at },
  { id: 'd2', userId: '10004', action: 'pass', reason: '对话在两位群友之间，已经得到充分回答。', evidenceIds: ['m11'], durationMs: 805, totalTokens: 820, stage: 'assessment', createdAt: at },
] };
const dist = path.resolve('dist');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    let result = { ok: true };
    if (url.pathname === '/api/state/revision') result = { ok: true, revision: 'fixture-1' };
    if (url.pathname === '/api/state') result = { ok: true, revision: 'fixture-1', db, oneBot: { connected: false } };
    if (url.pathname === '/api/social') result = data;
    if (url.pathname === '/api/social/feedback') data = { ...data, feedback: [{ ...body, id: 'f1' }] };
    if (url.pathname === '/api/social/preferences') people.find((p) => p.userId === body.userId).view.preferredNames = body.preferredNames;
    res.end(JSON.stringify(result)); return;
  }
  const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
  await page.locator('[data-page="__more"]').click();
  await page.locator('[data-page="social"]').click();
  await page.getByRole('button', { name: /小甲/ }).click();
  await page.getByText('刚刚分享了练习顺利的消息').waitFor();
  fs.mkdirSync(path.dirname(output), { recursive: true }); await page.screenshot({ path: output, fullPage: true });
  await page.getByRole('button', { name: '应该接话', exact: true }).first().click();
  await page.getByRole('button', { name: '校正称呼与偏好' }).click();
  await page.getByLabel('已接受称呼（逗号分隔，最多三个）').fill('阿甲');
  await page.getByRole('button', { name: '保存校正' }).click();
  await page.getByText('阿甲', { exact: true }).waitFor();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: output.replace(/\.png$/, '-narrow.png'), fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ ok: true, browserErrors: errors.length, feedbackSaved: data.feedback.length, preferredNames: people[1].view.preferredNames, screenshot: output }));
} finally { await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); cleanupTestDir(directory); }
