/**
 * 「控制台掐断回复」的验收。
 *
 * 要证明三件事：
 *   1. 一轮回复在跑的时候，登记表里看得见它；
 *   2. 掐断之后，这一轮什么都不发（正文、贴纸、失败提示都不发）；
 *   3. 没被掐断的回复照常发出去 —— 别把一个正常功能一起掐了。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-reply-abort-'));
process.env.DATA_DIR = dataDir;

const OWNER = '30000001';
const BOT = '30000002';
const GROUP = '990001';
const PORT = 19877;

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: '测试回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    }, 1200);
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const store = await import('../server/store.ts');
const { processIncoming } = await import('../server/bot.ts');
const { listReplyProcesses, abortReplyProcess } = await import('../server/bot/replyProcesses.ts');

store.ensureStore();
store.updateDb((db) => {
  db.settings.ownerQq = OWNER;
  db.settings.selfQq = BOT;
  db.settings.botNames = '小深,机器人,bot,Wuxin';
  db.settings.globalPaused = false;
  db.settings.onlyMentionMode = false;
  db.settings.llmProvider = 'openai-compatible';
  db.settings.apiKey = 'mock-key';
  db.settings.apiBaseUrl = 'http://127.0.0.1:' + PORT;
  db.settings.model = 'mock-model';
  db.settings.visionMode = 'off';
  db.settings.memoryEnabled = false;
  db.settings.enableWebSearch = false;
  db.settings.enableAutoModel = false;
  db.settings.thinkingNoticeMode = 'off';
  // mention 模式：被 @ 就一定进模型，不受自然接话阈值影响，测试才稳定。
  db.groups = [{ groupId: GROUP, name: 'AbortTest', enabled: true, mode: 'mention', maxPerHour: 100, cooldownSec: 0 }];
  db.messages = [];
  db.decisions = [];
  db.commandLogs = [];
  db.memories = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
  db.trustScores = {};
});

function event(overrides = {}) {
  return {
    source: 'reply-abort-test',
    type: 'group',
    messageId: 'ra-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    groupId: GROUP,
    userId: OWNER,
    nickname: 'Owner',
    text: '小深 你好',
    atTargets: [BOT],
    raw: {},
    ...overrides,
  };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

let failed = 0;
function check(ok, label, detail = '') {
  if (!ok) failed += 1;
  console.log((ok ? '  ok   ' : '  不符 ') + label + (detail ? '   ' + detail : ''));
}

try {
  // 1. 跑起来 → 登记表里看得见
  const sent = [];
  const running = processIncoming(event(), async (_event, text) => { sent.push(String(text || '')); });
  const appeared = await waitFor(() => listReplyProcesses().length > 0);
  const rows = listReplyProcesses();
  check(appeared && rows.length === 1, '运行中的回复出现在登记表里', JSON.stringify(rows.map((r) => ({ stage: r.stage, groupId: r.groupId }))));
  check(rows[0]?.groupId === GROUP && rows[0]?.userId === OWNER, '登记项带上了群和用户');
  check(typeof rows[0]?.elapsedMs === 'number', '登记项带上了已耗时');

  // 2. 掐断 → 一个字节都不发
  const abortResult = abortReplyProcess(rows[0].id);
  check(abortResult.ok === true, '掐断返回成功');
  await running;
  check(sent.length === 0, '掐断后没有任何内容发出去', JSON.stringify(sent));
  check(listReplyProcesses().length === 0, '结束后登记表清空');

  // 3. 没被掐断的照常发
  const sent2 = [];
  await processIncoming(event({ text: '小深 再问一次' }), async (_event, text) => { sent2.push(String(text || '')); });
  check(sent2.length > 0, '没被掐断的回复照常发出', JSON.stringify(sent2.slice(0, 1)));

  // 4. 掐一个已经结束的
  const missing = abortReplyProcess('rp-not-exist');
  check(missing.ok === false, '掐断不存在的进程返回失败');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
if (failed) {
  console.log('失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过：登记可见、掐断即停、未掐断照常发送');
