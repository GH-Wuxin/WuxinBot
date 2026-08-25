import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-profile-log-'));
process.env.DATA_DIR = tmpDir;

const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const {
  recordMemoryObservation,
  commitMemoryProfileResult,
  maybeUpdateMemoryProfile,
} = await import('../server/bot/memory.ts');

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function resetDb() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  ensureStore();
  updateDb((db) => {
    db.settings.ownerQq = 'owner';
    db.settings.selfQq = 'bot';
    db.settings.memoryEnabled = true;
    db.settings.memoryMinMessages = 5;
    db.settings.memoryUpdateEvery = 5;
    db.groups = [{ groupId: 'g1', name: '画像日志测试群', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 }];
    db.memories = [];
    db.profileLogs = [];
    db.profileV3 = {};
    db.messages = [];
    db.decisions = [];
    db.usageEvents = [];
    db.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 };
  });
}

function event(id, text) {
  return {
    type: 'group',
    groupId: 'g1',
    userId: 'u1',
    nickname: '用户1',
    messageId: id,
    text,
    atTargets: [],
    createdAt: new Date().toISOString(),
  };
}

try {
  console.log('Test 1: sample/evidence/threshold logs persist');
  resetDb();
  const result = recordMemoryObservation(
    event('m1', '我喜欢打CS2，也经常和朋友聊游戏。'),
    { policy: 'normal', attentionLevel: 3, allowCommands: false },
  );
  const db1 = readDb();
  const events1 = (db1.profileLogs || []).map((log) => log.event);
  assert(result.shouldUpdate === false, 'first sample should not trigger profile update');
  assert(events1.includes('sample.accepted'), 'sample.accepted should be logged');
  assert(events1.includes('evidence.created'), 'evidence.created should be logged');
  assert(events1.includes('profile.threshold_check'), 'profile.threshold_check should be logged');
  assert(db1.profileV3?.u1?.evidence?.length === 1, 'profileV3 evidence should persist');

  console.log('Test 2: commit logs patch/no-change after DB mutation');
  const outcome = commitMemoryProfileResult('u1', {
    runId: 'run-test',
    profile: {
      longTermUpdates: { summary: '喜欢聊游戏。' },
      confidence: { preferences: 0.6 },
    },
    usage: { total_tokens: 3, prompt_tokens: 2, completion_tokens: 1 },
  });
  const db2 = readDb();
  const patchLog = (db2.profileLogs || []).find((log) => log.event === 'profile.patch_applied');
  assert(outcome.ok && outcome.hasProfile, 'commit should create a usable profile');
  assert(patchLog?.runId === 'run-test', 'patch log should keep runId');
  assert(db2.memories[0].summary === '喜欢聊游戏。', 'memory summary should persist');

  console.log('Test 3: failed profile run keeps run_started + profile.error with same runId');
  resetDb();
  updateDb((db) => {
    db.settings.llmProvider = 'openai-compatible';
    db.settings.apiBaseUrl = 'http://127.0.0.1:1/v1';
    db.settings.apiKey = 'bad-key';
    db.settings.model = 'bad-model';
    db.memories.push({
      userId: 'u1',
      nickname: '用户1',
      enabled: true,
      importanceLevel: 2,
      messageCount: 5,
      profileMessageCount: 5,
      pendingCount: 5,
      groupsSeen: ['g1'],
      samples: [{
        content: '我喜欢打CS2，也经常和朋友聊游戏。',
        type: 'text',
        usedForProfile: true,
        riskLevel: 'normal',
        reason: '真实文本',
        context: { groupId: 'g1', messageId: 'm-fail', nearby: [], atTargets: [] },
        createdAt: new Date().toISOString(),
      }],
      summary: '',
      traits: '',
      speechStyle: '',
      behavior: '',
      preferences: '',
      recentDynamics: [],
      profileMeta: {},
    });
  });
  const failedOutcome = await maybeUpdateMemoryProfile(event('m-fail-trigger', '触发画像'));
  const logs3 = readDb().profileLogs || [];
  const started = logs3.find((log) => log.event === 'profile.run_started');
  const failed = logs3.find((log) => log.event === 'profile.error');
  assert(started, 'profile.run_started should be logged before LLM failure');
  assert(failed, 'profile.error should be logged after LLM failure');
  assert(started.runId && started.runId === failed.runId, 'failure log should keep the same runId');
  assert(failedOutcome?.ok === false, 'failed scheduler outcome should be observable');
  const failedMemory = readDb().memories.find((item) => item.userId === 'u1');
  assert(failedMemory?.profileFailureCount === 1, 'failure count should persist');
  assert(new Date(failedMemory?.profileRetryAfter || 0).getTime() > Date.now(), 'retry backoff should persist');

  const backedOff = await maybeUpdateMemoryProfile(event('m-backoff-trigger', '再次触发画像'));
  const logsAfterBackoff = readDb().profileLogs || [];
  assert(backedOff?.skipped === true && backedOff?.reason === '画像失败退避中', 'automatic retry should respect backoff');
  assert(logsAfterBackoff.some((log) => log.event === 'profile.backoff'), 'profile.backoff should be logged');

  console.log('\nAll profile log verification tests PASSED.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
