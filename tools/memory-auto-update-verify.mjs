/**
 * Memory auto-update trigger verification.
 *
 * Covers the non-LLM part of the profile updater:
 * - due detection for initial profiles
 * - cooldown protection after a recent attempt
 * - stored importance level lowering thresholds
 * - owner/self exclusion
 * - sweep target ordering
 */

import { memoryIsDueForProfile, findDueMemoryProfileTarget } from '../server/bot/memory.ts';

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function oldIso(minutesAgo = 60) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function recentIso(minutesAgo = 5) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function db(memories) {
  return {
    settings: {
      memoryEnabled: true,
      memoryMinMessages: 5,
      memoryUpdateEvery: 5,
      ownerQq: 'owner',
      selfQq: 'bot',
    },
    experience: {},
    memories,
  };
}

function memory(patch = {}) {
  return {
    userId: 'u1',
    nickname: 'user',
    enabled: true,
    importanceLevel: 2,
    profileMessageCount: 0,
    pendingCount: 0,
    summary: '',
    traits: '',
    speechStyle: '',
    behavior: '',
    preferences: '',
    samples: [],
    groupsSeen: ['g1'],
    lastProfileAttemptAt: '',
    lastProfiledAt: '',
    ...patch,
  };
}

async function main() {
  const initialReady = memory({ profileMessageCount: 5, pendingCount: 1, lastProfileAttemptAt: oldIso(120) });
  assert(memoryIsDueForProfile(db([initialReady]), initialReady), 'initial profile should become due after min messages');

  const recentAttempt = memory({ profileMessageCount: 20, pendingCount: 20, lastProfileAttemptAt: recentIso(5) });
  assert(!memoryIsDueForProfile(db([recentAttempt]), recentAttempt), 'recent attempt should suppress auto retry');

  const existingNotEnough = memory({ summary: 'existing', profileMessageCount: 20, pendingCount: 4, lastProfileAttemptAt: oldIso(120) });
  assert(!memoryIsDueForProfile(db([existingNotEnough]), existingNotEnough), 'normal existing profile needs updateEvery pending messages');

  const importantDue = memory({ userId: 'important', summary: 'existing', importanceLevel: 4, profileMessageCount: 20, pendingCount: 3, lastProfileAttemptAt: oldIso(120) });
  assert(memoryIsDueForProfile(db([importantDue]), importantDue), 'high-importance profile should use a lower update threshold');

  const owner = memory({ userId: 'owner', profileMessageCount: 99, pendingCount: 99, lastProfileAttemptAt: oldIso(120) });
  assert(!memoryIsDueForProfile(db([owner]), owner), 'owner should not be auto-profiled');

  const targetDb = db([
    importantDue,
    memory({ userId: 'newbie', profileMessageCount: 6, pendingCount: 1, lastProfileAttemptAt: oldIso(120) }),
  ]);
  const target = findDueMemoryProfileTarget(targetDb);
  assert(target?.memory.userId === 'newbie', 'sweep should prioritize empty initial profiles over existing updates');

  console.log('PASS: memory auto-update trigger verification');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
