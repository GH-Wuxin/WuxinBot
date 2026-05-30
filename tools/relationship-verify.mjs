import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-relationship-'));
process.env.DATA_DIR = tmpDir;

const { writeDb, readDb } = await import('../server/store.ts');
const { incrementPairPending } = await import('../server/bot/relationshipProfile.ts');

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function makeMessages(groupId, userA, userB) {
  const ids = [userA, userB, userA, userB, userA, userB];
  return ids.map((userId, index) => ({
    id: `${groupId}-${index}`,
    role: 'user',
    groupId,
    userId,
    nickname: userId,
    content: index % 2 === 0 ? `回合 ${index} [CQ:at,qq=${userB}]` : `回合 ${index} [CQ:at,qq=${userA}]`,
    text: index % 2 === 0 ? `回合 ${index}` : `回合 ${index}`,
    inContext: true,
    createdAt: new Date(Date.now() - (10 - index) * 60000).toISOString(),
  }));
}

try {
  writeDb({
    settings: { ownerQq: 'owner', selfQq: 'bot' },
    groups: [
      { groupId: 'g1', name: '关系测试1', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
      { groupId: 'g2', name: '关系测试2', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
    ],
    users: [],
    memories: [],
    groupProfiles: [],
    relationshipProfiles: [],
    trustScores: {},
    experience: {},
    groupExperience: {},
    messages: [
      ...makeMessages('g1', '1001', '1002'),
      ...makeMessages('g2', '1001', '1002'),
    ],
    pendingPairCounts: { '1001:1002': 30 },
    decisions: [],
    commandLogs: [],
    adminActions: [],
    usageEvents: [],
    usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 },
  });

  console.log('Test 1: relationship pending keys are group-scoped');
  incrementPairPending(readDb(), 'g1', '1001');
  incrementPairPending(readDb(), 'g2', '1001');
  const counts = readDb().pendingPairCounts || {};

  assert(counts['g1:1001:1002'] > 0, 'g1 pair count should exist');
  assert(counts['g2:1001:1002'] > 0, 'g2 pair count should exist');
  assert(!Object.prototype.hasOwnProperty.call(counts, '1001:1002'), 'legacy pair-only key should be cleaned');

  console.log('PASS: Test 1 — group-scoped relationship pending counts');
  console.log('\nAll relationship verification tests PASSED.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
