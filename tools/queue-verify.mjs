/**
 * 回复队列验证测试
 *
 * 使用内置 mock LLM 服务器模拟慢响应，确保锁在测试期间保持。
 *
 * 测试场景:
 * 1. 基本排队 — 锁被持时时新消息返回 queued=true
 * 2. 队列排空 — 第一条回复完成后自动处理队列中下一条
 * 3. 队列上限 — 超过10条时丢弃新消息
 * 4. 指令绕过 — /w 指令不受队列阻塞
 * 5. 队列统计 — getReplyQueueStats 返回正确数据
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDb, writeDb } from '../server/store.ts';
import { processIncoming, getReplyQueueStats } from '../server/bot.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin', 'db.json');

const TEST_OWNER = '20000001';
const TEST_BOT = '20000002';
const TEST_USER = '20000003';
const TEST_GROUP = '880001';
const GROUP_KEY = `group:${TEST_GROUP}`;
const MOCK_PORT = 19876;
const MOCK_DELAY_MS = 1500;

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function event(overrides) {
  return {
    source: 'queue-test',
    type: 'group',
    messageId: `qt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    groupId: TEST_GROUP,
    userId: TEST_OWNER,
    nickname: 'QueueOwner',
    text: '',
    atTargets: [TEST_BOT],
    raw: {},
    ...overrides,
  };
}

// Wait for queue to drain (poll until empty, with timeout)
async function waitForDrain(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = getReplyQueueStats();
    if (Object.keys(stats).length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForDrain: timeout after ${timeoutMs}ms, stats: ${JSON.stringify(getReplyQueueStats())}`);
}

function instantSM() {
  const sent = [];
  const fn = async (evt, text) => { sent.push(String(text || '')); };
  return { fn, sent };
}

// Mock LLM server — responds after a delay
function startMockServer(delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: '测试回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }));
        }, delayMs);
      });
    });
    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

function setupDb(original) {
  const db = structuredClone(original);
  db.settings.ownerQq = TEST_OWNER;
  db.settings.selfQq = TEST_BOT;
  db.settings.botNames = '小深,机器人,bot,Wuxin';
  db.settings.globalPaused = false;
  db.settings.onlyMentionMode = false;
  db.settings.llmProvider = 'openai-compatible';
  db.settings.apiKey = 'mock-key-for-test';
  db.settings.apiBaseUrl = `http://127.0.0.1:${MOCK_PORT}`;
  db.settings.model = 'mock-model';
  db.settings.visionMode = 'off';
  db.settings.temperature = 0.4;
  db.settings.maxTokens = 50;
  db.settings.contextLimit = 5;
  db.settings.ownerPrivateContextCharBudget = 4000;
  db.settings.memoryEnabled = false;
  db.settings.enableWebSearch = false;
  db.settings.enableAutoModel = false;
  db.settings.thinkingNoticeMode = 'off';
  db.groups = [
    ...(db.groups || []).filter((g) => String(g.groupId) !== TEST_GROUP),
    { groupId: TEST_GROUP, name: 'QueueTest', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
  ];
  db.messages = [];
  db.decisions = [];
  db.commandLogs = [];
  db.memories = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
  db.trustScores = {};
  writeDb(db);
  return db;
}

async function main() {
  const originalRaw = fs.readFileSync(dbPath, 'utf8').replace(/^﻿/, '');
  const original = JSON.parse(originalRaw);
  let server;

  try {
    server = await startMockServer(MOCK_DELAY_MS);
    console.log(`Mock LLM server on :${MOCK_PORT} (${MOCK_DELAY_MS}ms delay)\n`);

    // ============================================================
    // Test 1: Basic queue — locked state causes queued=true
    // ============================================================
    console.log('Test 1: Basic queue — locked state causes queued=true');
    setupDb(original);

    // Fire first message — owner @bot, will take ~1.5s due to mock LLM delay
    const sm1 = instantSM();
    const p1 = processIncoming(event({ text: '小深 第一条消息', messageId: 't1-m1' }), sm1.fn);

    // Wait a bit for the first message to acquire the lock (reaches LLM call)
    await new Promise((r) => setTimeout(r, 200));

    // Fire second message — should be queued because lock is held
    const sm2 = instantSM();
    const r2 = await processIncoming(
      event({ text: '小深 第二条消息', messageId: 't1-m2', userId: TEST_USER, nickname: 'TestUser', atTargets: [TEST_BOT] }),
      sm2.fn
    );
    assert(r2.replied === false, 'second message should not reply');
    assert(r2.queued === true, `second message should be queued, got queued=${r2.queued}`);
    assert(r2.queuePosition === 1, `queue position should be 1, got ${r2.queuePosition}`);

    // Wait for first message to complete
    await p1;
    await waitForDrain();

    console.log('PASS: Test 1 — locked state causes queued=true');

    // ============================================================
    // Test 2: Queue drain — queued message is processed after unlock
    // ============================================================
    console.log('Test 2: Queue drain — queued message processed after unlock');

    const db2 = readDb();
    const t2dec = (db2.decisions || []).filter((d) => d.messageId === 't1-m2');
    assert(t2dec.length >= 1, `queued message should have a decision after drain, found ${t2dec.length}`);

    const stats2 = getReplyQueueStats();
    assert(!stats2[GROUP_KEY] || stats2[GROUP_KEY].queued === 0, `queue should be empty after drain, got: ${JSON.stringify(stats2[GROUP_KEY])}`);

    console.log('PASS: Test 2 — queued message processed after drain');

    // ============================================================
    // Test 3: Queue limit — 11th message is dropped
    // ============================================================
    console.log('Test 3: Queue limit — overflow drops message');
    setupDb(original);

    // Fire a slow first message (must mention bot to trigger reply)
    const p3 = processIncoming(event({ text: '小深 持有锁', messageId: 't3-lock' }), instantSM().fn);
    await new Promise((r) => setTimeout(r, 200));

    // Enqueue 10 messages
    for (let i = 1; i <= 10; i++) {
      const r = await processIncoming(
        event({ text: `小深 排队${i}`, messageId: `t3-q${i}`, userId: `${TEST_USER}-${i}`, nickname: `U${i}`, atTargets: [TEST_BOT] }),
        instantSM().fn
      );
      assert(r.queued === true, `msg ${i} should be queued`);
    }

    // 11th should be dropped
    const r3over = await processIncoming(
      event({ text: '小深 溢出', messageId: 't3-over', userId: `${TEST_USER}-11`, nickname: 'U11', atTargets: [TEST_BOT] }),
      instantSM().fn
    );
    assert(r3over.replied === false, 'overflow should not reply');
    assert(r3over.queued !== true, 'overflow should NOT be queued');

    const stats3 = getReplyQueueStats();
    assert(stats3[GROUP_KEY]?.queued === 10, `should have 10 queued, got ${stats3[GROUP_KEY]?.queued}`);

    await p3;
    await waitForDrain(60000); // 10 queued messages take ~15s to drain

    console.log('PASS: Test 3 — queue limit (10) enforced, 11th dropped');

    // ============================================================
    // Test 4: Commands bypass queue — /w ping works when locked
    // ============================================================
    console.log('Test 4: Commands bypass queue — /w ping works when locked');
    setupDb(original);

    // Fire a slow message to hold the lock
    const p4 = processIncoming(event({ text: '小深 持有锁', messageId: 't4-lock' }), instantSM().fn);
    await new Promise((r) => setTimeout(r, 200));

    // /w ping should bypass the queue (commands handled before lock check)
    const { fn: sm4, sent: sent4 } = instantSM();
    const r4 = await processIncoming(
      event({ text: '/w ping', messageId: 't4-cmd', userId: TEST_OWNER, nickname: 'Owner', atTargets: [] }),
      sm4
    );
    assert(r4.replied === true, '/w ping should reply when locked');
    assert(sent4.some((s) => s.includes('pong')), '/w ping should send pong');

    await p4;
    await waitForDrain();

    console.log('PASS: Test 4 — /w ping bypasses queue');

    // ============================================================
    // Test 5: Queue stats — getReplyQueueStats returns correct data
    // ============================================================
    console.log('Test 5: Queue stats — getReplyQueueStats returns correct data');
    setupDb(original);

    // Initially empty
    const stats5empty = getReplyQueueStats();
    assert(Object.keys(stats5empty).length === 0, 'should have no queues initially');

    // Hold lock and enqueue 3
    const p5 = processIncoming(event({ text: '小深 持有锁', messageId: 't5-lock' }), instantSM().fn);
    await new Promise((r) => setTimeout(r, 200));

    for (let i = 1; i <= 3; i++) {
      await processIncoming(
        event({ text: `小深 消息${i}`, messageId: `t5-q${i}`, userId: `${TEST_USER}-${i}`, nickname: `U${i}`, atTargets: [TEST_BOT] }),
        instantSM().fn
      );
    }

    const stats5active = getReplyQueueStats();
    assert(stats5active[GROUP_KEY]?.locked === true, 'should show locked');
    assert(stats5active[GROUP_KEY]?.queued === 3, `should show 3 queued, got ${stats5active[GROUP_KEY]?.queued}`);

    await p5;
    await waitForDrain();

    const stats5done = getReplyQueueStats();
    assert(!stats5done[GROUP_KEY] || stats5done[GROUP_KEY].queued === 0, 'should be clean after drain');

    console.log('PASS: Test 5 — getReplyQueueStats returns correct data');

    // ============================================================
    console.log('\nAll queue verification tests PASSED.');
  } finally {
    if (server) server.close();
    fs.writeFileSync(dbPath, originalRaw, 'utf8');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
