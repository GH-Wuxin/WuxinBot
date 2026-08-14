import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-group-profile-'));
process.env.DATA_DIR = tmpDir;

const { writeDb, readDb } = await import('../server/store.ts');
const { updateGroupProfile, maybeAutoUpdateGroupProfile, hasGroupProfileContent } = await import('../server/bot/groupProfile.ts');

const GROUP_ID = 'gp-test';
const PORT = 19877;
const baseDb = {
  settings: {
    ownerQq: 'owner',
    selfQq: 'bot',
    llmProvider: 'openai-compatible',
    apiKey: 'mock-key',
    apiBaseUrl: `http://127.0.0.1:${PORT}`,
    model: 'mock-model',
    groupProfileAutoUpdate: true,
    groupProfileThreshold: 20,
  },
  groups: [{ groupId: GROUP_ID, name: '群画像测试群', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 }],
  users: [],
  memories: [],
  groupProfiles: [],
  relationshipProfiles: [],
  trustScores: {},
  experience: {},
  groupExperience: {},
  messages: Array.from({ length: 12 }, (_, i) => ({
    id: `m-${i}`,
    role: 'user',
    groupId: GROUP_ID,
    userId: `u-${i % 3}`,
    nickname: `用户${i % 3}`,
    content: `这是一条用于群聊画像的真实聊天消息 ${i}`,
    text: `这是一条用于群聊画像的真实聊天消息 ${i}`,
    inContext: true,
    createdAt: new Date(Date.now() - (12 - i) * 60000).toISOString(),
  })),
  decisions: [],
  commandLogs: [],
  adminActions: [],
  usageEvents: [],
  usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 },
};

let mockResponse = {};

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-group-profile',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(mockResponse) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }));
      });
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const server = await startMockServer();
try {
  console.log('Test 1: all-empty LLM output is rejected');
  writeDb({
    ...baseDb,
    groupProfiles: [{
      groupId: GROUP_ID,
      enabled: true,
      atmosphere: '旧氛围',
      topics: '旧话题',
      humorStyle: '',
      pace: '',
      boundaries: '',
      botStrategy: '',
      confidence: 0.6,
      evidenceCount: 10,
      pendingMessageCount: 20,
      lastAutoUpdateAt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  });
  mockResponse = { atmosphere: '', topics: '', humorStyle: '', pace: '', boundaries: '', botStrategy: '', confidence: 0.2 };
  const emptyResult = await updateGroupProfile(readDb(), GROUP_ID);
  assert(emptyResult.ok === false, 'empty profile should fail');
  const afterEmpty = readDb().groupProfiles[0];
  assert(afterEmpty.atmosphere === '旧氛围', 'old profile should be preserved');
  assert(hasGroupProfileContent(afterEmpty), 'old profile should still count as content');
  console.log('PASS: Test 1');

  console.log('Test 2: valid LLM output writes profile');
  mockResponse = {
    atmosphere: '熟人闲聊，节奏中等',
    topics: '游戏、日常、项目调试',
    humorStyle: '轻度吐槽',
    pace: '中速',
    boundaries: '不要过度评价个人',
    botStrategy: '短句接话，少解释后台',
    confidence: 0.78,
  };
  const okResult = await updateGroupProfile(readDb(), GROUP_ID);
  assert(okResult.ok === true, 'valid profile should succeed');
  const afterOk = readDb().groupProfiles[0];
  assert(afterOk.atmosphere.includes('熟人闲聊'), 'new profile should be written');
  assert(afterOk.pendingMessageCount === 0, 'pending should reset after success');
  console.log('PASS: Test 2');

  console.log('Test 3: auto update failure keeps retry progress below threshold');
  writeDb({
    ...baseDb,
    groupProfiles: [{
      groupId: GROUP_ID,
      enabled: true,
      atmosphere: '',
      topics: '',
      humorStyle: '',
      pace: '',
      boundaries: '',
      botStrategy: '',
      confidence: 0,
      evidenceCount: 0,
      pendingMessageCount: 20,
      lastAutoUpdateAt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  });
  mockResponse = { atmosphere: '', topics: '', humorStyle: '', pace: '', boundaries: '', botStrategy: '', confidence: 0 };
  await maybeAutoUpdateGroupProfile(GROUP_ID);
  const afterAutoFail = readDb().groupProfiles[0];
  assert(afterAutoFail.pendingMessageCount > 0, 'failed auto update should keep progress');
  assert(afterAutoFail.pendingMessageCount < 20, 'failed auto update should not immediately retrigger');
  assert(afterAutoFail.lastUpdateStatus === 'failed', 'failure status should be recorded');
  console.log('PASS: Test 3');

  console.log('\nAll group profile verification tests PASSED.');
} finally {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
