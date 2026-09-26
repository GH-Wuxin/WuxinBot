import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-profile-queue-'));
process.env.DATA_DIR = tmpDir;

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

let activeRequests = 0;
let peakRequests = 0;
let requestCount = 0;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  requestCount += 1;
  activeRequests += 1;
  peakRequests = Math.max(peakRequests, activeRequests);
  req.resume();
  setTimeout(() => {
    activeRequests -= 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `queue-test-${requestCount}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'queue-test-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            longTermUpdates: { summary: '稳定参与群聊。' },
            recentDynamicsUpdates: [],
            preserveExisting: [],
            removeOrDowngrade: [],
            confidence: { behavior: 0.6 },
          }),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  }, 80);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();

try {
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { maybeUpdateMemoryProfile, getMemoryProfileQueueStatus } = await import('../server/bot/memory.ts');
  ensureStore();
  const sample = (userId, index) => ({
    content: `${userId} 的有效画像样本 ${index}`,
    type: 'text', usedForProfile: true, riskLevel: 'normal', reason: '真实文本',
    context: { groupId: 'g1', messageId: `${userId}-${index}`, nearby: [], atTargets: [] },
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
  });
  const memory = (userId) => ({
    id: userId, userId, nickname: `用户${userId}`, enabled: true,
    importanceLevel: 2, messageCount: 6, profileMessageCount: 6, pendingCount: 6,
    groupsSeen: ['g1'], samples: Array.from({ length: 6 }, (_, index) => sample(userId, index)),
    summary: '', traits: '', speechStyle: '', behavior: '', preferences: '',
    manualNotes: '', profilingRule: '', profileMeta: {}, recentDynamics: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  updateDb((db) => {
    db.settings.memoryEnabled = true;
    db.settings.ownerQq = 'owner';
    db.settings.selfQq = 'bot';
    db.settings.llmProvider = 'openai-compatible';
    db.settings.apiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    db.settings.apiKey = 'queue-test-key';
    db.settings.model = 'queue-test-model';
    db.memories = [memory('u1'), memory('u2')];
    db.messages = [];
    db.profileLogs = [];
    db.decisions = [];
    db.usageEvents = [];
  });

  const event = (userId) => ({
    type: 'group', groupId: 'g1', userId, nickname: `用户${userId}`,
    messageId: `queue-${userId}`, text: '触发画像', atTargets: [],
  });
  const first = maybeUpdateMemoryProfile(event('u1'));
  const duplicate = maybeUpdateMemoryProfile(event('u1'));
  const second = maybeUpdateMemoryProfile(event('u2'));
  assert(first === duplicate, 'same-user updates should coalesce to one promise');
  assert(getMemoryProfileQueueStatus().trackedUsers === 2, 'two users should be tracked while queued/running');

  const outcomes = await Promise.all([first, duplicate, second]);
  assert(outcomes.every((outcome) => outcome.ok), `all queued outcomes should succeed: ${JSON.stringify(outcomes)}`);
  assert(requestCount === 2, `same-user coalescing should issue 2 requests, got ${requestCount}`);
  assert(peakRequests === 1, `profile LLM concurrency must stay at 1, got ${peakRequests}`);
  assert(getMemoryProfileQueueStatus().trackedUsers === 0, 'queue tracking should clear after completion');

  const db = readDb();
  assert(db.memories.every((item) => item.summary === '稳定参与群聊。'), 'both profile results should commit');
  assert((db.profileLogs || []).filter((log) => log.event === 'profile.queued').length === 2, 'each distinct user should have a queued log');
  assert((db.profileLogs || []).filter((log) => log.event === 'profile.run_started').length === 2, 'each queued task should start once');

  console.log('PASS: profile updates are globally serialized and same-user calls are coalesced');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
