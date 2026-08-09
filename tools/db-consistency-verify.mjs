// db-consistency-verify.mjs — JSON DB / state-consistency regression suite
// for the MiMo audit candidates C1-C4. Fully offline: temp DATA_DIR plus the
// local osu! API mock. Only C1 is a confirmed bug; C2/C3/C4 are locked as
// current-behavior-is-correct so future "clean it all up" changes can't
// silently break product semantics.
//
// C1: clearRelationshipProfile must drop pendingPairCounts evidence.
// C2: DELETE /api/users is "delete member policy" (GUI confirm text), not a
//     full user wipe; group/global data ownership must stay isolated.
// C3: osu caches are keyed by osuUserId (or QQ+target); A→B rebind must not
//     surface A's cached data under B's identity.
// C4: profileLogs are already capped at the write point (MAX_LOGS=2000).

import fs from 'node:fs';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';
import { startOsuApiMock } from './osu-api-mock.mjs';

const testDataDir = createTestDataDir('wuxin-db-consistency');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

let passed = 0;
let failed = 0;
function assert(cond, label, msg) {
  if (cond) {
    console.log(`PASS [${label}]`);
    passed++;
  } else {
    console.error(`FAIL [${label}]: ${msg || 'assertion failed'}`);
    failed++;
  }
}

function fixtureUser(id, username, pp) {
  return {
    id,
    username,
    country_code: 'CN',
    avatar_url: 'https://mock.invalid/a.png',
    is_online: true,
    join_date: '2021-01-01T00:00:00Z',
    statistics: {
      level: { current: 50, progress: 0 },
      global_rank: Math.max(1, Math.round(1_000_000 - pp * 100)),
      country_rank: 1,
      pp,
      ranked_score: 1,
      total_score: 1,
      total_hits: 1,
      hit_accuracy: 98,
      play_count: 100,
      play_time: 1000,
      maximum_combo: 1000,
      replays_watched_by_others: 0,
      is_ranked: true,
      grade_counts: { ss: 0, s: 0, a: 0 },
    },
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
    follower_count: 0,
    support_level: 0,
    country: { code: 'CN', name: 'China' },
  };
}

function fixtureScore(id, userId, beatmapId, pp, mods = []) {
  return {
    id,
    user_id: userId,
    accuracy: 0.98,
    max_combo: 1000,
    mods,
    pp,
    rank: 'S',
    score: 1_000_000,
    statistics: { count_50: 0, count_100: 10, count_300: 500, count_geki: 0, count_katsu: 0, count_miss: 0 },
    beatmap: { id: beatmapId, difficulty_rating: 6.0, version: 'Fixture', mode: 'osu', ar: 9, bpm: 180, cs: 4, total_length: 180, hit_length: 180, count_circles: 500, count_sliders: 100, count_spinners: 0 },
    beatmapset: { id: 7000 + beatmapId, title: 'Fixture', artist: 'Fixture', creator: 'Fixture' },
    created_at: '2026-08-08T00:00:00Z',
    ended_at: '2026-08-08T00:01:00Z',
    mode: 'osu',
    weight: { percentage: 100, pp },
  };
}

async function main() {
  // ── Offline osu! API mock: PlayerA(111) and PlayerB(222) ──
  const mock = await startOsuApiMock({
    fixture: {
      users: new Map([
        [111, fixtureUser(111, 'PlayerA', 3000)],
        [222, fixtureUser(222, 'PlayerB', 3200)],
      ]),
      best: new Map([
        [111, [fixtureScore(901, 111, 1001, 300)]],
        [222, [fixtureScore(902, 222, 1002, 320)]],
      ]),
      recent: new Map([[222, [fixtureScore(903, 222, 1003, 310)]]]),
      matches: new Map(),
      leaderboards: new Map(),
    },
  });
  process.env.OSU_API_BASE_URL = mock.apiBase;
  process.env.OSU_TOKEN_URL = mock.tokenUrl;
  process.env.OSU_CLIENT_ID = 'db-consistency-client';
  process.env.OSU_CLIENT_SECRET = 'db-consistency-secret';

  const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
  const { clearRelationshipProfile } = await import('../server/bot/relationshipProfile.ts');
  const { writeProfileLog } = await import('../server/bot/profileLog.ts');
  const {
    markRecommendation,
    checkRecommendCooldown,
    loadRecommendHistory,
    clearRecommendHistory,
  } = await import('../server/osu/recommender.ts');
  const { handleOsuCommand } = await import('../server/osu/commands.ts');

  ensureStore();
  const now = new Date().toISOString();
  const perms = { isOwner: false, isAdmin: false };

  // ════════════════════════════════════════════════════════════════════════
  // C1: clearRelationshipProfile must also delete pendingPairCounts evidence
  // ════════════════════════════════════════════════════════════════════════
  updateDb((db) => {
    db.relationshipProfiles = [{
      groupId: 'g1', pairKey: '111:222', userA: '111', userB: '222',
      enabled: true, interactionStyle: '互相调侃', commonTopics: '游戏',
      tone: '轻松', botStrategy: '偶尔插话', boundaries: '不要起哄',
      confidence: 0.6, evidenceCount: 30, signalCount: 30,
      lastInteractionAt: now, createdAt: now, updatedAt: now,
    }];
    // 30 >= auto-update threshold (25): leftover evidence would immediately
    // re-trigger profile rebuild after the manual delete.
    db.pendingPairCounts = { 'g1:111:222': 30, 'g1:111:333': 12 };
  });

  clearRelationshipProfile('g1', '111', '222');
  const c1 = readDb();
  assert(c1.relationshipProfiles.length === 0, 'c1:profile-deleted', 'profile should be gone');
  assert(!('g1:111:222' in (c1.pendingPairCounts || {})), 'c1:pending-evidence-deleted', 'pending count must not survive clear');
  assert((c1.pendingPairCounts || {})['g1:111:333'] === 12, 'c1:unrelated-pending-preserved', 'other pairs untouched');

  // Reversed argument order must hit the same sorted pending key.
  updateDb((db) => {
    db.relationshipProfiles.push({
      groupId: 'g1', pairKey: '111:222', userA: '111', userB: '222',
      enabled: true, interactionStyle: '互相调侃', commonTopics: '游戏',
      tone: '轻松', botStrategy: '偶尔插话', boundaries: '不要起哄',
      confidence: 0.6, evidenceCount: 25, signalCount: 25,
      lastInteractionAt: now, createdAt: now, updatedAt: now,
    });
    db.pendingPairCounts['g1:111:222'] = 25;
  });
  clearRelationshipProfile('g1', '222', '111');
  const c1b = readDb();
  assert(c1b.relationshipProfiles.length === 0 && !('g1:111:222' in (c1b.pendingPairCounts || {})), 'c1:reversed-args-same-key', 'reversed args must clear the same pending key');

  // ════════════════════════════════════════════════════════════════════════
  // C2: DELETE /api/users is "delete member policy" — scope isolation
  // ════════════════════════════════════════════════════════════════════════
  // GUI confirm (src/App.jsx): "删除 X 的成员策略？删除后会按普通用户处理。"
  // The API only removes the group-scoped user policy entry; memories and
  // experience are global per-QQ and must survive. This test pins the exact
  // filter used by DELETE /api/users/:groupId/:userId so a future "cascade
  // everything" change fails loudly.
  updateDb((db) => {
    db.users = [
      { groupId: 'g123', userId: 'u456', nickname: 'X', policy: 'admin', attentionLevel: 5, allowCommands: true },
      { groupId: 'g789', userId: 'u456', nickname: 'X', policy: 'normal', attentionLevel: 3, allowCommands: false },
      { groupId: 'g123', userId: 'u999', nickname: 'Y', policy: 'normal', attentionLevel: 3, allowCommands: false },
    ];
    db.memories = [{ userId: 'u456', nickname: 'X', summary: 'global memory', samples: [], createdAt: now }];
    db.experience = { u456: 123 };
    db.groupExperience = { 'g123:u456': 50, 'g789:u456': 60, 'g123:u999': 10 };
    db.messages = [{ groupId: 'g123', userId: 'u456', content: 'old', role: 'user', createdAt: now }];
    db.commandLogs = [{ groupId: 'g123', userId: 'u456', command: '/w ping', createdAt: now }];
    db.pendingPairCounts = { 'g123:u456:u999': 3 };
    db.relationshipProfiles = [{ groupId: 'g123', pairKey: 'u456:u999', userA: 'u456', userB: 'u999', enabled: true, confidence: 0.5, evidenceCount: 6, interactionStyle: 'x', commonTopics: 'x', tone: 'x', botStrategy: 'x', boundaries: 'x', createdAt: now, updatedAt: now }];
    db.pendingLevelUps = [{ userId: 'u456', level: 5, createdAt: now }];
  });

  // Exact DELETE /api/users/:groupId/:userId mutation (server/index.ts).
  updateDb((db) => {
    db.users = db.users.filter(
      (user) => !(String(user.groupId) === 'g123' && String(user.userId) === 'u456'),
    );
  });
  const c2 = readDb();
  assert(!c2.users.some((u) => u.groupId === 'g123' && u.userId === 'u456'), 'c2:policy-removed', 'target policy entry removed');
  assert(c2.users.some((u) => u.groupId === 'g789' && u.userId === 'u456'), 'c2:other-group-user-preserved', 'same QQ in another group must survive');
  assert(c2.users.some((u) => u.groupId === 'g123' && u.userId === 'u999'), 'c2:other-user-preserved', 'other user in same group must survive');
  assert((c2.memories || []).some((m) => m.userId === 'u456'), 'c2:global-memory-preserved', 'global memory is user-scoped, not group-scoped');
  assert(c2.experience && c2.experience.u456 === 123, 'c2:global-experience-preserved', 'global XP must survive policy deletion');
  assert((c2.groupExperience || {})['g789:u456'] === 60, 'c2:other-group-xp-preserved', 'XP in the other group must survive');

  // Re-adding the same QQ in the same group recreates a policy entry; global
  // state "resurrecting" is the intended design, not a bug.
  updateDb((db) => {
    db.users.push({ groupId: 'g123', userId: 'u456', nickname: 'X', policy: 'normal', attentionLevel: 3, allowCommands: false, createdAt: now, updatedAt: now });
  });
  const c2b = readDb();
  assert(c2b.users.some((u) => u.groupId === 'g123' && u.userId === 'u456'), 'c2:re-add-works', 'policy can be re-added');
  assert(c2b.experience && c2b.experience.u456 === 123, 'c2:global-data-survives-re-add', 'global data persistence after re-add is by design');

  // ════════════════════════════════════════════════════════════════════════
  // C3: osu caches must not leak account A data under account B
  // ════════════════════════════════════════════════════════════════════════
  updateDb((db) => {
    db.settings.pplusBaseUrl = 'http://127.0.0.1:1'; // fast offline failure, PP+ is optional
    db.osuBindings = { Q: { id: 222, username: 'PlayerB' } };
    db.skillStore = {
      records: [
        { mode: 'osu', osuUserId: 111, osuUsername: 'PlayerA', recentSummary: 'A' },
        { mode: 'osu', osuUserId: 222, osuUsername: 'PlayerB', recentSummary: 'B' },
      ],
    };
    db.osuAnalyses = [
      { userId: 'Q', target: '111', displayName: 'PlayerA', osuUserId: 111, mode: 'osu', analysisType: 'full', formatVersion: 89, createdAt: now, fullText: 'A-OLD-REPORT', baseline: { topAverageStars: 6, topAverageAcc: 0.98 } },
      { userId: 'Q', target: '222', displayName: 'PlayerB', osuUserId: 222, mode: 'osu', analysisType: 'full', formatVersion: 89, createdAt: now, fullText: 'B-FRESH-REPORT', baseline: { topAverageStars: 6, topAverageAcc: 0.98 } },
    ];
    db.osuRecentAnalyses = [
      { userId: 'Q', target: '111', displayName: 'PlayerA', osuUserId: 111, mode: 'osu', formatVersion: 4, createdAt: now, fullText: 'A-OLD-RECENT' },
      { userId: 'Q', target: '222', displayName: 'PlayerB', osuUserId: 222, mode: 'osu', formatVersion: 4, createdAt: now, fullText: 'B-FRESH-RECENT' },
    ];
  });

  const event = { userId: 'Q', groupId: 'g', atTargets: [] };

  // Analyze default (binding = B): must show B's cache, never A's.
  const analyzeB = await handleOsuCommand(event, null, perms, 'analyze', '');
  assert(analyzeB.text === 'B-FRESH-REPORT', 'c3:analyze-default-uses-B', `got=${analyzeB.text}`);

  // Analyze explicit 111: A's old cache is only reachable when A is the
  // explicitly requested target — that is correct, not a leak. (The row
  // written while bound to A is keyed by A's resolved id/username used at
  // write time; requesting A again is allowed to reuse it.)
  const analyzeA = await handleOsuCommand(event, null, perms, 'analyze', '111');
  assert(analyzeA.text === 'A-OLD-REPORT', 'c3:analyze-explicit-A-is-A', `got=${analyzeA.text}`);

  // Recent: same QQ has both A and B cache rows; B's row is keyed by B's
  // osuUserId and must win after rebinding to B.
  const recentB = await handleOsuCommand(event, null, perms, 'recent', '');
  assert(recentB.text === 'B-FRESH-RECENT', 'c3:recent-uses-B-osuUserId', `got=${recentB.text}`);

  // Recommend cooldown/history are osuUserId-keyed and must not cross over.
  markRecommendation(111, [{ beatmapId: 1, beatmapsetId: 701 }]);
  markRecommendation(222, [{ beatmapId: 2, beatmapsetId: 702 }]);
  const c3r = readDb();
  assert(checkRecommendCooldown(c3r, 111) > 0 && checkRecommendCooldown(c3r, 222) > 0, 'c3:cooldowns-account-scoped', 'both accounts have their own cooldown');
  assert(loadRecommendHistory(c3r, 222).has(702) && !loadRecommendHistory(c3r, 222).has(701), 'c3:recommend-history-isolated', 'B must not see A history');
  clearRecommendHistory(111);
  const c3r2 = readDb();
  assert(checkRecommendCooldown(c3r2, 222) > 0, 'c3:clear-A-does-not-touch-B-cooldown', 'unbinding/clearing A must not reset B cooldown');
  assert(loadRecommendHistory(c3r2, 222).has(702), 'c3:clear-A-does-not-touch-B-history', 'B anti-repeat history intact');

  // ════════════════════════════════════════════════════════════════════════
  // C4: profileLogs already have a write-point cap (MAX_LOGS = 2000)
  // ════════════════════════════════════════════════════════════════════════
  updateDb((db) => {
    db.profileLogs = Array.from({ length: 5000 }, (_, i) => ({
      id: `old-${i}`, runId: 'old-run', event: 'profile.no_change',
      userId: 'u', detail: 'x', createdAt: '2020-01-01T00:00:00.000Z',
    }));
  });
  writeProfileLog({ runId: 'new-run', event: 'profile.patch_applied', userId: 'u', detail: 'newest' });
  const c4a = readDb();
  assert((c4a.profileLogs || []).length === 2000, 'c4:over-cap-trimmed-to-2000', `got=${(c4a.profileLogs || []).length}`);
  assert(c4a.profileLogs[c4a.profileLogs.length - 1].runId === 'new-run', 'c4:newest-kept', 'newest entry must survive');
  assert(!c4a.profileLogs.some((l) => l.id === 'old-0'), 'c4:oldest-dropped', 'oldest entries must be dropped');
  writeProfileLog({ runId: 'new-run-2', event: 'profile.patch_applied', userId: 'u', detail: 'newest-2' });
  const c4b = readDb();
  assert((c4b.profileLogs || []).length === 2000 && c4b.profileLogs[c4b.profileLogs.length - 1].runId === 'new-run-2', 'c4:repeated-write-idempotent', 'cap must stay stable across writes');

  // Under-cap arrays are untouched.
  updateDb((db) => { db.profileLogs = []; });
  writeProfileLog({ runId: 'r1', event: 'profile.no_change', userId: 'u', detail: 'a' });
  writeProfileLog({ runId: 'r2', event: 'profile.no_change', userId: 'u', detail: 'b' });
  assert((readDb().profileLogs || []).length === 2, 'c4:under-cap-not-trimmed', 'under-cap array must not be trimmed');

  await mock.close();
  cleanupTestDir(testDataDir);
}

main()
  .then(() => {
    console.log(`\nDB-CONSISTENCY-VERIFY: passed=${passed} failed=${failed}`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('DB-CONSISTENCY-VERIFY crashed:', error);
    process.exit(1);
  });
