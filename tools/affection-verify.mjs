import assert from 'node:assert/strict';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-affection');
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(dataDir);

const OWNER = '10001';
const SELF = '10002';
const TARGET = '10003';
const GROUP = '20001';
const OTHER_GROUP = '20002';
const now = new Date().toISOString();

async function main() {
  const store = await import('../server/store.ts');
  const state = await import('../server/bot/social/state.ts');
  const runtime = await import('../server/bot/social/runtime.ts');
  const reflection = await import('../server/bot/social/reflection.ts');
  store.ensureStore();

  const event = (overrides = {}) => ({
    source: 'onebot',
    type: 'group',
    messageId: `affection-${Math.random().toString(16).slice(2)}`,
    groupId: GROUP,
    userId: TARGET,
    nickname: '成员甲',
    text: '最近练习有点累，不过还在继续。',
    atTargets: [],
    images: [],
    raw: {},
    socialDirect: true,
    ...overrides,
  });

  const view = () => ({
    summary: '本群关系摘要',
    preferredNames: [],
    style: '',
    mood: { label: '平静', reason: '正常交流', updatedAt: now },
    lastEvaluatedAt: now,
    lastReason: '上一次正常交流',
    revision: 1,
    updatedAt: now,
  });

  const transition = ({ scope = `group:${GROUP}`, userId = TARGET, reason, scoreBefore = 50, scoreAfter = 52,
    familiarityBefore = 20, familiarityAfter = 21, at = now } = {}) => ({
    id: `transition-${Math.random().toString(16).slice(2)}`,
    userId,
    scope,
    messageIds: [`evidence-${Math.random().toString(16).slice(2)}`],
    source: 'llm',
    reason,
    before: {
      person: { userId, affinity: { kind: 'ordinary', score: scoreBefore }, familiarity: familiarityBefore,
        revision: 1, updatedAt: at },
      view: null,
    },
    after: {
      person: { userId, affinity: { kind: 'ordinary', score: scoreAfter }, familiarity: familiarityAfter,
        revision: 2, updatedAt: at },
      view: null,
    },
    createdAt: at,
  });

  const seed = ({ score = 50, familiarity = 20, transitions = [], ownerQq = OWNER, messages = [] } = {}) => {
    store.updateDb((db) => {
      db.settings.ownerQq = ownerQq;
      db.settings.selfQq = SELF;
      db.settings.socialV2Enabled = true;
      db.settings.globalPaused = false;
      db.settings.tokenSavingMode = false;
      db.settings.memoryEnabled = false;
      db.settings.osuSearchEnabled = false;
      db.settings.enableAutoModel = false;
      db.settings.thinkingNoticeMode = 'off';
      db.settings.levelUpNotifyEnabled = false;
      db.settings.stickerPolicy = { mode: 'off' };
      db.settings.socialMaxAssessmentsPerHour = 60;
      db.groups = [{ groupId: GROUP, name: '测试群', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 }];
      db.users = [];
      db.messages = messages;
      db.decisions = [];
      db.socialV2 = state.emptySocialState();
      db.socialV2.people[TARGET] = {
        userId: TARGET,
        affinity: { kind: 'ordinary', score },
        familiarity,
        revision: 1,
        updatedAt: now,
      };
      db.socialV2.views[`group:${GROUP}/${TARGET}`] = view();
      db.socialV2.transitions = transitions;
    });
  };

  const assess = async ({ score = 50, familiarity = 20, transitions = [], ownerQq = OWNER, delta = 0,
    familiarityDelta = 0, evidenceIds, text = '最近练习有点累，不过还在继续。', userId = TARGET } = {}) => {
    seed({ score, familiarity, transitions, ownerQq });
    const e = event({ text, userId });
    let captured, systemPrompt;
    const invoke = async (_db, options) => {
      systemPrompt = String(options.messages[0]?.content || '');
      captured = JSON.parse(options.messages.at(-1).content);
      return {
        text: JSON.stringify({
          action: 'pass',
          addressee: 'group',
          reason: 'fixture assessment',
          evidenceIds: evidenceIds === undefined ? captured.target.messageIds : evidenceIds,
          affinityDelta: delta,
          familiarityDelta,
          summary: null,
          preferredNames: null,
          style: null,
          mood: null,
        }),
        usage: { total_tokens: 10 },
      };
    };
    const result = await runtime.assessSocialTurn(e, 'initial', invoke);
    return { result, captured, systemPrompt, event: e, db: store.readDb() };
  };

  // Low affinity: normal friendly exchange and a small repair are allowed.
  let run = await assess({ score: 10, familiarity: 10, delta: 2, familiarityDelta: 1 });
  assert.ok(run.result);
  assert.match(run.systemPrompt, /affinity 和 familiarity/);
  assert.match(run.systemPrompt, /recentRelationshipChanges/);
  assert.equal(run.captured.relationship.affinity.score, 10);
  assert.equal(run.captured.relationship.familiarity, 10);
  assert.equal(run.db.socialV2.people[TARGET].affinity.score, 12);
  assert.equal(run.db.socialV2.people[TARGET].familiarity, 11);

  // Neutral relationship: the model still receives current values and can move them.
  run = await assess({ score: 50, familiarity: 30, delta: 1 });
  assert.equal(run.captured.relationship.affinity.score, 50);
  assert.equal(run.db.socialV2.people[TARGET].affinity.score, 51);

  // High affinity + repeated praise/chat: fixture model follows the instruction
  // and returns 0; the path must preserve the existing score and not create a
  // transition. Recent evidence is actually passed to the model.
  const repeated = [
    transition({ reason: '重复夸赞：今天也很厉害', scoreBefore: 90, scoreAfter: 92 }),
    transition({ reason: '重复闲聊：继续加油', scoreBefore: 92, scoreAfter: 93 }),
  ];
  run = await assess({ score: 90, familiarity: 80, transitions: repeated, delta: 0, familiarityDelta: 0 });
  assert.equal(run.captured.relationship.affinity.score, 90);
  assert.equal(run.captured.recentRelationshipChanges.length, 2);
  assert.deepEqual(run.captured.recentRelationshipChanges.map((c) => c.reason), repeated.map((t) => t.reason));
  assert.equal(run.db.socialV2.people[TARGET].affinity.score, 90);
  assert.equal(run.db.socialV2.people[TARGET].familiarity, 80);
  assert.equal(run.db.socialV2.transitions.length, 2);

  // High affinity + genuinely new evidence can still rise.
  run = await assess({ score: 90, familiarity: 80, delta: 2, familiarityDelta: 1 });
  assert.equal(run.db.socialV2.people[TARGET].affinity.score, 92);
  assert.equal(run.db.socialV2.people[TARGET].familiarity, 81);

  // No evidence + any state change is rejected by the existing structured guard.
  run = await assess({ score: 50, familiarity: 30, delta: 2, evidenceIds: [] });
  assert.equal(run.result, null);
  assert.equal(run.db.socialV2.people[TARGET].affinity.score, 50);
  assert.equal(run.db.socialV2.people[TARGET].familiarity, 30);
  assert.equal(run.db.socialV2.transitions.length, 0);

  // Owner identity is forced; affinity cannot be changed, familiarity can.
  run = await assess({ ownerQq: OWNER, userId: OWNER, delta: 5, familiarityDelta: 2 });
  assert.ok(run.result);
  assert.equal(run.captured.relationship.affinity.kind, 'owner');
  assert.equal(run.db.socialV2.people[OWNER].affinity.kind, 'owner');
  assert.equal('score' in run.db.socialV2.people[OWNER].affinity, false);
  assert.equal(run.db.socialV2.people[OWNER].familiarity, 2);

  // Same message evidence cannot be rewarded twice.
  run = await assess({ score: 50, familiarity: 30, delta: 2 });
  const scoreAfterFirst = run.db.socialV2.people[TARGET].affinity.score;
  const transitionsAfterFirst = run.db.socialV2.transitions.length;
  const again = await runtime.assessSocialTurn(run.event, 'initial', async (_db, options) => {
    const captured = JSON.parse(options.messages.at(-1).content);
    return { text: JSON.stringify({ action: 'pass', addressee: 'group', reason: 'duplicate fixture',
      evidenceIds: captured.target.messageIds, affinityDelta: 2, familiarityDelta: 0,
      summary: null, preferredNames: null, style: null, mood: null }), usage: { total_tokens: 10 } };
  });
  assert.ok(again);
  assert.equal(store.readDb().socialV2.people[TARGET].affinity.score, scoreAfterFirst);
  assert.equal(store.readDb().socialV2.transitions.length, transitionsAfterFirst);

  // Recent changes are bounded to the same target and exact scope; other
  // groups, other users, and future transitions are not leaked.
  const privacyTransitions = [
    transition({ reason: '本群近期一次真实互动', scoreBefore: 50, scoreAfter: 52 }),
    transition({ scope: `group:${OTHER_GROUP}`, reason: 'OTHER_GROUP_PRIVATE', scoreBefore: 50, scoreAfter: 55 }),
    transition({ userId: '19999', reason: 'OTHER_USER_PRIVATE', scoreBefore: 50, scoreAfter: 60 }),
    transition({ scope: `private:${TARGET}`, reason: 'PRIVATE_SCOPE_DETAIL', scoreBefore: 50, scoreAfter: 55 }),
    ...Array.from({ length: 8 }, (_, i) => transition({ reason: `本群近期第${i + 2}次`, scoreBefore: 50, scoreAfter: 51 })),
  ];
  run = await assess({ score: 50, familiarity: 30, transitions: privacyTransitions, delta: 0 });
  const recent = run.captured.recentRelationshipChanges;
  assert.equal(recent.length, 6);
  assert.ok(recent.every((c) => !String(c.reason).includes('PRIVATE')));
  assert.ok(recent.every((c) => Array.isArray(c.messageIds) && c.messageIds.length === 1));

  // Reflection passes the same bounded recent changes, excluding other scope,
  // other user, and records created after the DB/person snapshot was read.
  const reflectionTransitions = [
    transition({ reason: '反射时可见的本群记录', scoreBefore: 50, scoreAfter: 51 }),
    transition({ scope: `group:${OTHER_GROUP}`, reason: 'REFLECTION_OTHER_GROUP', scoreBefore: 50, scoreAfter: 60 }),
    transition({ userId: '19999', reason: 'REFLECTION_OTHER_USER', scoreBefore: 50, scoreAfter: 60 }),
    transition({ reason: 'REFLECTION_FUTURE', scoreBefore: 50, scoreAfter: 60, at: new Date(Date.now() + 60_000).toISOString() }),
  ];
  seed({ score: 50, familiarity: 30, transitions: reflectionTransitions, messages: [{
    id: 'reflection-target', sourceMessageId: 'reflection-target', type: 'group', role: 'user',
    userId: TARGET, senderId: TARGET, groupId: GROUP, content: '今天继续练习。', createdAt: now, inContext: true,
  }] });
  const reflectionEvent = event({ messageId: 'reflection-target', socialMessageIds: ['reflection-target'] });
  const snapshot = reflection.captureSocialReflection(reflectionEvent);
  let reflectionCaptured;
  const reflectionInvoke = async (_db, options) => {
    reflectionCaptured = JSON.parse(options.messages.at(-1).content);
    return { text: JSON.stringify({ action: 'reply', addressee: 'group', reason: 'reflection fixture',
      evidenceIds: snapshot.ids, affinityDelta: 0, familiarityDelta: 0,
      summary: null, preferredNames: null, style: null, mood: null }), usage: { total_tokens: 10 } };
  };
  await reflection.queueSocialReflection(snapshot, { action: 'reply', replied: true }, reflectionInvoke);
  assert.ok(reflectionCaptured);
  assert.equal(reflectionCaptured.relationship.affinity.score, 50);
  assert.equal(reflectionCaptured.relationship.familiarity, 30);
  assert.equal(reflectionCaptured.recentRelationshipChanges.length, 1);
  assert.equal(reflectionCaptured.recentRelationshipChanges[0].reason, '反射时可见的本群记录');
  assert.ok(!JSON.stringify(reflectionCaptured.recentRelationshipChanges).includes('REFLECTION_'));

  // Deterministic queue order: A is delayed before commit, B is queued before
  // A commits, then A is released. B must read A's updated score and also see
  // A's newly committed reward transition, even though A's transition is
  // created after B.queuedAt. Future/other-scope records remain excluded.
  const queueTransitions = [
    transition({ reason: 'QUEUE_FUTURE', scoreBefore: 50, scoreAfter: 60, at: new Date(Date.now() + 60_000).toISOString() }),
    transition({ scope: `group:${OTHER_GROUP}`, reason: 'QUEUE_OTHER_GROUP', scoreBefore: 50, scoreAfter: 60 }),
    transition({ userId: '19999', reason: 'QUEUE_OTHER_USER', scoreBefore: 50, scoreAfter: 60 }),
  ];
  seed({ score: 50, familiarity: 30, transitions: queueTransitions, messages: [
    { id: 'queue-a', sourceMessageId: 'queue-a', type: 'group', role: 'user', userId: TARGET,
      senderId: TARGET, groupId: GROUP, content: 'A 的真实互动', createdAt: now, inContext: true },
    { id: 'queue-b', sourceMessageId: 'queue-b', type: 'group', role: 'user', userId: TARGET,
      senderId: TARGET, groupId: GROUP, content: 'B 的真实互动', createdAt: now, inContext: true },
  ] });
  const aEvent = event({ messageId: 'queue-a', socialMessageIds: ['queue-a'], text: 'A 的真实互动' });
  const bEvent = event({ messageId: 'queue-b', socialMessageIds: ['queue-b'], text: 'B 的真实互动' });
  const aSnapshot = reflection.captureSocialReflection(aEvent);
  const bSnapshot = reflection.captureSocialReflection(bEvent);
  let releaseA;
  const aGate = new Promise((resolve) => { releaseA = resolve; });
  let aStarted;
  const aStartedPromise = new Promise((resolve) => { aStarted = resolve; });
  const aInvoke = async (_db, options) => {
    const input = JSON.parse(options.messages.at(-1).content);
    aStarted();
    await aGate;
    return { text: JSON.stringify({ action: 'reply', addressee: 'group', reason: 'A reward',
      evidenceIds: input.target.messageIds, affinityDelta: 2, familiarityDelta: 1,
      summary: null, preferredNames: null, style: null, mood: null }), usage: { total_tokens: 10 } };
  };
  let bCaptured;
  const bInvoke = async (_db, options) => {
    bCaptured = JSON.parse(options.messages.at(-1).content);
    return { text: JSON.stringify({ action: 'reply', addressee: 'group', reason: 'B after A',
      evidenceIds: bCaptured.target.messageIds, affinityDelta: 0, familiarityDelta: 0,
      summary: null, preferredNames: null, style: null, mood: null }), usage: { total_tokens: 10 } };
  };
  const aJob = reflection.queueSocialReflection(aSnapshot, { action: 'reply', replied: true }, aInvoke);
  await aStartedPromise;
  const bJob = reflection.queueSocialReflection(bSnapshot, { action: 'reply', replied: true }, bInvoke);
  releaseA();
  await Promise.all([aJob, bJob]);
  assert.ok(bCaptured);
  assert.equal(bCaptured.relationship.affinity.score, 52);
  assert.equal(bCaptured.relationship.familiarity, 31);
  assert.equal(bCaptured.recentRelationshipChanges.length, 1);
  assert.equal(bCaptured.recentRelationshipChanges[0].reason, 'A reward');
  assert.deepEqual(bCaptured.recentRelationshipChanges[0].messageIds, ['queue-a']);
  assert.ok(!JSON.stringify(bCaptured.recentRelationshipChanges).includes('QUEUE_'));

  console.log('affection: low/neutral/high, repeat, new evidence, Owner, privacy, no-evidence, reflection and queue consistency PASS');
}

try {
  await main();
} finally {
  cleanupTestDir(dataDir);
}
