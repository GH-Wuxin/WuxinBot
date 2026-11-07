import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const directory = createTestDataDir('wuxin-presence');
const store = await import('../server/store.ts');
const socialState = await import('../server/bot/social/state.ts');
const presence = await import('../server/bot/presence.ts');

store.ensureStore();
const iso = () => new Date().toISOString();
const event = (extra = {}) => ({
  source: 'onebot',
  type: 'group',
  groupId: '20001',
  userId: '10003',
  nickname: 'Fixture',
  text: '今天打图手感不错',
  messageId: 'm-' + Math.random().toString(36).slice(2),
  atTargets: [],
  ...extra,
});

function seed(extra = {}) {
  store.updateDb(db => {
    Object.assign(db.settings, {
      presenceEnabled: true,
      socialV2Enabled: true,
      tokenSavingMode: false,
      globalPaused: false,
      ownerQq: '10001',
      selfQq: '10002',
      llmProvider: 'openai-compatible',
      apiBaseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fixture-key',
      model: 'deepseek-v4.1-flash',
      ...extra,
    });
    db.groups = [{ groupId: '20001', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 }];
    db.socialV2 = socialState.emptySocialState();
    socialState.normalizeSocialState(db);
  });
  presence.resetPresenceRuntime();
}

const observationInvoke = async (_db, options) => {
  const payload = JSON.parse(options.messages.at(-1).content);
  return {
    text: JSON.stringify({
      observations: [{
        messageIds: payload.messages.map((message) => message.messageId),
        topic: '打图手感',
        sentiment: '轻松',
        salience: 0.6,
        noticed: '他说今天打图手感不错',
        moodDelta: 0.2,
        energyDelta: -0.1,
        interestDelta: 0.3,
        people: [{ userId: '10003', warmthDelta: 0.2, familiarityDelta: 0.1, impression: '喜欢打图，状态好的时候会分享' }],
        openThread: { topic: '今天的手感', participants: ['10003'], note: '还没说具体成绩' },
        culture: { phrase: '手感不错', meaning: '打图状态好' },
      }],
    }),
    usage: { total_tokens: 12 },
  };
};

const reflectionInvoke = async () => ({
  text: JSON.stringify({
    self: { mood: { label: '好奇', reason: '他今天状态不错' }, energy: 55, interest: 70, valence: 60, focus: ['打图手感'] },
    people: [{ userId: '10003', impression: '喜欢打图，状态好的时候会分享', warmthDelta: 1.5, familiarityDelta: 0.5 }],
    threads: [{ topic: '今天的手感', status: 'open', participants: ['10003'], note: '还没说具体成绩' }],
    culture: [{ phrase: '手感不错', meaning: '打图状态好' }],
    noticing: ['他今天打图手感不错'],
  }),
  usage: { total_tokens: 15 },
});

try {
  await test('presence is off by default for new installs', () => {
    assert.equal(store.readDb().settings.presenceEnabled, false);
  });

  await test('every eligible message is observed without creating a reply', async () => {
    seed();
    const before = store.readDb().messages.length;
    const a = event({ messageId: 'm-1' });
    const b = event({ messageId: 'm-2', userId: '10004', nickname: 'Other', text: '我在练新图' });
    presence.observeMessage(a, { schedule: false });
    presence.observeMessage(b, { schedule: false });
    await presence.flushPresence('20001', { invoke: observationInvoke });
    const snapshot = presence.presenceSnapshot(store.readDb());
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.groups['20001'].observations, 1);
    assert.equal(snapshot.groups['20001'].people, 2);
    assert.match(snapshot.groups['20001'].recent[0].noticed, /手感不错/);
    assert.equal(store.readDb().messages.length, before);
  });

  await test('duplicate message ids are observed once', async () => {
    seed();
    const same = event({ messageId: 'm-duplicate' });
    presence.observeMessage(same, { schedule: false });
    presence.observeMessage(same, { schedule: false });
    let batchSize = 0;
    await presence.flushPresence('20001', {
      invoke: async (_db, options) => {
        batchSize = JSON.parse(options.messages.at(-1).content).messages.length;
        return { text: JSON.stringify({ observations: [] }), usage: { total_tokens: 1 } };
      },
    });
    assert.equal(batchSize, 1);
  });

  await test('reflection updates mood, impressions, threads and culture', async () => {
    seed();
    presence.observeMessage(event({ messageId: 'm-reflect' }), { schedule: false });
    await presence.flushPresence('20001', { invoke: observationInvoke });
    await presence.reflectPresence('20001', { invoke: reflectionInvoke, force: true });
    const snapshot = presence.presenceSnapshot(store.readDb());
    assert.equal(snapshot.self.mood.label, '好奇');
    assert.equal(snapshot.groups['20001'].openThreads[0].topic, '今天的手感');
    assert.ok(snapshot.groups['20001'].openThreads[0].note);
    assert.equal(snapshot.groups['20001'].culture, 1);
    assert.match(snapshot.groups['20001'].noticing.join(' '), /手感不错/);
    assert.equal(snapshot.groups['20001'].people, 1);
  });

  await test('presence knows Pippi is itself and sees its own recent replies', async () => {
    seed();
    store.updateDb(db => {
      db.messages = (db.messages || []).filter(m => !(m.role === 'assistant' && String(m.groupId) === '20001'));
      db.messages.push({
        id: 'self-1', type: 'group', groupId: '20001', role: 'assistant', userId: 'bot',
        nickname: '机器人', content: '嗯，我醒着呢', inContext: true, createdAt: new Date().toISOString(),
      });
    });
    presence.observeMessage(event({
      messageId: 'm-self-id', userId: '10004', nickname: 'Wuxin',
      text: '所以我要在这个群恢复pippi的LLM功能了',
    }), { schedule: false });
    let captured; let system = '';
    await presence.flushPresence('20001', {
      invoke: async (_db, options) => {
        captured = JSON.parse(options.messages.at(-1).content);
        system = String(options.messages[0]?.content || '');
        return { text: JSON.stringify({ observations: [] }), usage: { total_tokens: 1 } };
      },
    });
    assert.equal(captured.bot.name, 'Pippi');
    assert.equal(captured.bot.userId, '10002');
    assert.ok(captured.selfMessages.some(message => /我醒着呢/.test(message.text)));
    assert.match(system, /Pippi 就是你自己/);
    assert.match(system, /selfMessages/);
  });

  await test('reflection also treats Pippi as self and sees its own replies', async () => {
    seed();
    store.updateDb(db => {
      db.messages = (db.messages || []).filter(m => !(m.role === 'assistant' && String(m.groupId) === '20001'));
      db.messages.push({
        id: 'self-2', type: 'group', groupId: '20001', role: 'assistant', userId: 'bot',
        nickname: '机器人', content: '嗯，我醒着呢', inContext: true, createdAt: new Date().toISOString(),
      });
    });
    presence.observeMessage(event({ messageId: 'm-reflect-self' }), { schedule: false });
    await presence.flushPresence('20001', { invoke: observationInvoke });
    let captured; let system = '';
    await presence.reflectPresence('20001', {
      force: true,
      invoke: async (_db, options) => {
        captured = JSON.parse(options.messages.at(-1).content);
        system = String(options.messages[0]?.content || '');
        return {
          text: JSON.stringify({
            self: { mood: { label: '平静', reason: '' }, energy: 60, interest: 50, valence: 50, focus: [] },
            people: [],
            threads: [{ topic: 'pippi 的 LLM 功能怎么恢复', status: 'open', participants: ['10004'], note: '被点名的一方还没露面' }],
            culture: [], noticing: [],
          }),
          usage: { total_tokens: 1 },
        };
      },
    });
    assert.equal(captured.bot.name, 'Pippi');
    assert.equal(captured.bot.userId, '10002');
    assert.ok(captured.selfMessages.some(message => /我醒着呢/.test(message.text)));
    assert.match(system, /Pippi 就是你自己/);
    assert.match(system, /threads 里关于你的事/);
    const stored = store.readDb().socialV2.presence.groups['20001'].threads.find(thread => /pippi/i.test(thread.topic));
    assert.equal(stored.status, 'closed');
    assert.match(stored.note, /已经回应/);
  });

  await test('prompt block is scoped, compact and forbids forced callbacks', async () => {
    seed();
    presence.observeMessage(event({ messageId: 'm-prompt' }), { schedule: false });
    await presence.flushPresence('20001', { invoke: observationInvoke });
    const block = presence.presencePromptBlock(store.readDb(), event({ messageId: 'm-current' }));
    assert.match(block, /你最近在群里注意到的/);
    assert.match(block, /不要为了证明/);
    assert.match(block, /Pippi 就是你自己/);
    assert.match(block, /手感不错/);
    assert.doesNotMatch(block, /另一个群/);
    const other = presence.presencePromptBlock(store.readDb(), {
      ...event({ messageId: 'm-other' }),
      groupId: '99999',
    });
    assert.equal(other, '');
  });

  await test('the real saving prompt receives the presence block', async () => {
    seed({ tokenSavingMode: true });
    presence.observeMessage(event({ messageId: 'm-prompt-build' }), { schedule: false });
    await presence.flushPresence('20001', { invoke: observationInvoke });
    const { buildPrompt } = await import('../server/bot/prompt.ts');
    const db = store.readDb();
    const prompt = buildPrompt(db, db.groups[0], event({ messageId: 'm-prompt-build-current' }), { policy: 'normal' });
    const serialized = JSON.stringify(prompt);
    assert.match(serialized, /你最近在群里注意到的/);
    assert.match(serialized, /不要为了证明/);
  });

  await test('fabricated message ids and users are ignored', async () => {
    seed();
    presence.observeMessage(event({ messageId: 'm-safe' }), { schedule: false });
    await presence.flushPresence('20001', {
      invoke: async () => ({
        text: JSON.stringify({
          observations: [{
            messageIds: ['forged-message'],
            topic: '伪造',
            sentiment: 'unknown',
            salience: 1,
            noticed: '这条不应该存在',
            people: [{ userId: '99999', warmthDelta: 5, impression: '伪造用户' }],
          }],
        }),
        usage: { total_tokens: 1 },
      }),
    });
    const snapshot = presence.presenceSnapshot(store.readDb());
    const stored = store.readDb().socialV2.presence.groups['20001'];
    assert.equal(snapshot.groups['20001'].observations, 0);
    assert.equal(snapshot.groups['20001'].people, 1);
    assert.ok(stored.people['10003']);
    assert.equal(stored.people['99999'], undefined);
    assert.ok(stored.people['10003'].warmth < 51);
  });
} finally {
  presence.resetPresenceRuntime();
  cleanupTestDir(directory);
}
