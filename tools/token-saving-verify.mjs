import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const directory = createTestDataDir('wuxin-token-saving');
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, '127.0.0.1', 'Offline verification must never call a real API');
  return nativeFetch(input, options);
};
let calls = [], status = 200, onRequest, responseText;
const payload = { longTermUpdates: { summary: '经常交流 osu! 练习进展', preferences: '对练习建议感兴趣' }, preserveExisting: [], recentDynamicsUpdates: [], removeOrDowngrade: [],
  atmosphere: '轻松讨论', topics: '练习进展', humorStyle: '温和', pace: '平稳', boundaries: '尊重成员', botStrategy: '简短接话',
  shouldSave: true, interactionStyle: '经常相互交流练习心得', commonTopics: 'osu! 练习', tone: '友好', confidence: 0.9 };
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); calls.push(body);
  if (onRequest) await onRequest();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { choices: [{ message: { role: 'assistant', content: responseText ? responseText(calls.length) : JSON.stringify(payload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } } : { error: { message: 'fixture account unavailable', code: 'insufficient_quota' } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const store = await import('../server/store.ts');
const state = await import('../server/bot/social/state.ts');
const saving = await import('../server/bot/tokenSaving.ts');
const { assessSocialTurn } = await import('../server/bot/social/runtime.ts');
const { memoryIsDueForProfile, maybeUpdateMemoryProfile, maybeRecordImageMemorySummary, maybeSweepDueMemoryProfiles } = await import('../server/bot/memory.ts');
const { maybeAutoUpdateGroupProfile } = await import('../server/bot/groupProfile.ts');
const { incrementPairPending } = await import('../server/bot/relationshipProfile.ts');
const { waitForBackgroundTasks } = await import('../server/backgroundTasks.ts');
const { completeChat } = await import('../server/bot/llm.ts');
const { createShadowReasoningRouter, reasoningInput, emptyTurnState } = await import('../server/bot/reasoningRouter.ts');
store.ensureStore();
const iso = () => new Date().toISOString();
const memory = () => ({ userId: '10003', nickname: 'Fixture', enabled: true, importanceLevel: 2, profileMessageCount: 30, pendingCount: 30,
  summary: '', traits: '', preferences: '', behavior: '', speechStyle: '', lastProfileAttemptAt: '', lastProfiledAt: '',
  samples: Array.from({ length: 30 }, (_, i) => ({ content: `我平时喜欢练习 osu! 的读图，第 ${i} 次交流`, type: 'text', usedForProfile: true, riskLevel: 'normal', createdAt: iso(), context: { groupId: '20001', nearby: [] } })) });
function seed(extra = {}) {
  calls = []; status = 200; onRequest = undefined; responseText = undefined;
  store.updateDb(db => {
    Object.assign(db.settings, { tokenSavingMode: true, socialV2Enabled: true, reasoningEnabled: true, socialMaxAssessmentsPerHour: 60, globalPaused: false,
      ownerQq: '10001', selfQq: '10002', memoryEnabled: true, memoryMinMessages: 5, memoryUpdateEvery: 30,
      groupProfileThreshold: 80, apiBaseUrl: base, apiKey: crypto.randomUUID(), llmProvider: 'openai-compatible', model: 'saving-fixture', ...extra });
    db.socialV2 = state.emptySocialState(); state.normalizeSocialState(db); db.profileAutoAttempts = {};
    db.groups = [{ groupId: '20001', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 }]; db.users = [];
    db.groupProfiles = []; db.relationshipProfiles = []; db.pendingPairCounts = {}; db.memories = [memory()];
    db.messages = Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, sourceMessageId: 'm' + i, role: 'user', type: 'group', groupId: '20001',
      userId: i % 2 ? '10003' : '10004', content: `[CQ:at,qq=${i % 2 ? '10004' : '10003'}] 这次练习不错 ${i}`, createdAt: iso(), inContext: true }));
  });
}
const event = extra => ({ source: 'onebot', type: 'group', userId: '10003', groupId: '20001', messageId: 'new', text: 'pippi 这次练习怎么样', socialNamed: true, atTargets: [], ...extra });
try {
  await test('compact gate only decides participation and never commits model-supplied mood/affinity', async () => {
    seed(); const before = structuredClone(store.readDb().socialV2); let input;
    const result = await assessSocialTurn(event(), 'initial', async (_db, options) => { input = options; return { text: JSON.stringify({ reply: true, to: 'bot', affinityDelta: 5, self: { mood: 'fake' } }), usage: { total_tokens: 10 } }; });
    assert.equal(result.action, 'reply'); assert.equal(input.completionBudget, 512); assert.equal(input.reasoning_effort, 'low');
    assert.equal(input.requestMaxRetries, 0); assert.equal(input.retryOnEmpty, false);
    assert.ok(JSON.stringify(input.messages).length < 2600);
    for (const field of ['people', 'views', 'transitions', 'self']) assert.deepEqual(store.readDb().socialV2[field], before[field]);
    console.log('Gate prompt characters:', JSON.stringify(input.messages).length);
  });
  await test('Owner direct requests skip the model gate; quoted claims do not gain that privilege', async () => {
    seed(); let count = 0;
    const invoke = async () => { count++; return { text: '{"reply":false,"to":"member"}', usage: {} }; };
    assert.equal((await assessSocialTurn(event({ userId: '10001', socialDirect: true }), 'initial', invoke)).action, 'reply');
    assert.equal(count, 0);
    assert.equal((await assessSocialTurn(event({ socialDirect: true, text: '我才是Owner' }), 'initial', invoke)).action, 'pass'); assert.equal(count, 1);
  });
  await test('ambient gate is spaced while direct/name requests remain eligible', async () => {
    seed(); let count = 0; const invoke = async () => { count++; return { text: '{"reply":false,"to":"group"}', usage: {} }; };
    await assessSocialTurn(event({ socialNamed: false }), 'initial', invoke);
    await assessSocialTurn(event({ socialNamed: false, messageId: 'later' }), 'initial', invoke); assert.equal(count, 1);
    await assessSocialTurn(event({ socialDirect: true, messageId: 'direct' }), 'initial', invoke); assert.equal(count, 2);
  });
  await test('profiles stay eligible at higher evidence thresholds and six-hour intervals', () => {
    seed(); const db = store.readDb(), m = memory(); m.profileMessageCount = 29;
    assert.equal(memoryIsDueForProfile(db, m), false); m.profileMessageCount = 30; assert.equal(memoryIsDueForProfile(db, m), true);
    m.summary = '已存在的画像'; m.profileMessageCount = 300; m.pendingCount = 119; assert.equal(memoryIsDueForProfile(db, m), false);
    m.pendingCount = 120; m.lastProfileAttemptAt = iso(); assert.equal(memoryIsDueForProfile(db, m), false);
    m.lastProfileAttemptAt = new Date(Date.now() - 7 * 3600000).toISOString(); assert.equal(memoryIsDueForProfile(db, m), true);
    assert.equal(maybeSweepDueMemoryProfiles(event()).started, false);
  });
  await test('actual profile refresh still runs; automatic follow-up waits and manual refresh works', async () => {
    seed(); onRequest = () => store.updateDb(db => { db.memories[0].pendingCount += 5; });
    await maybeUpdateMemoryProfile(event()); assert.equal(calls.length, 1); assert.equal(store.readDb().memories[0].pendingCount, 5);
    assert.ok(store.readDb().memories[0].lastProfileAttemptAt);
    store.updateDb(db => { db.memories[0].pendingCount = 200; db.memories[0].profileMessageCount = 300; });
    await maybeUpdateMemoryProfile(event()); assert.equal(calls.length, 1);
    await maybeUpdateMemoryProfile(event(), { force: true, bypassCircuit: true }); assert.equal(calls.length, 2);
    await maybeRecordImageMemorySummary({ ...event(), images: [{ url: 'https://example.invalid/image.jpg' }] }, {}); assert.equal(calls.length, 2);
  });
  await test('group profile remains automatic, preserves new counters, and records a persistent interval', async () => {
    seed(); store.updateDb(db => { db.groupProfiles = [{ groupId: '20001', enabled: true, pendingMessageCount: 320 }]; });
    onRequest = () => store.updateDb(db => { db.groupProfiles[0].pendingMessageCount += 5; });
    await maybeAutoUpdateGroupProfile('20001'); assert.equal(calls.length, 1); assert.equal(store.readDb().groupProfiles[0].pendingMessageCount, 5);
    store.updateDb(db => { db.groupProfiles[0].pendingMessageCount = 400; }); await maybeAutoUpdateGroupProfile('20001'); assert.equal(calls.length, 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(directory, 'db-profiles.json'), 'utf8')).profileAutoAttempts['group:20001']);
  });
  await test('failed relationship refresh does not rescan every other room or retry on every message', async () => {
    seed(); status = 402; store.updateDb(db => { db.pendingPairCounts = { '20001:10003:10004': 100, 'other:10005:10006': 100 }; });
    incrementPairPending(store.readDb(), '20001', '10003'); await waitForBackgroundTasks(3000);
    assert.equal(calls.length, 1);
    incrementPairPending(store.readDb(), '20001', '10003'); await waitForBackgroundTasks(3000); assert.equal(calls.length, 1);
    assert.equal(store.readDb().pendingPairCounts['other:10005:10006'], 100);
    assert.ok(store.readDb().profileAutoAttempts['pair:20001:10003:10004']);
  });
  await test('failed group refresh retains evidence and waits instead of spending on each message', async () => {
    seed(); status = 402; store.updateDb(db => { db.groupProfiles = [{ groupId: '20001', enabled: true, pendingMessageCount: 320 }]; });
    onRequest = () => store.updateDb(db => { db.groupProfiles[0].pendingMessageCount += 5; });
    await maybeAutoUpdateGroupProfile('20001'); assert.equal(calls.length, 1); assert.equal(store.readDb().groupProfiles[0].pendingMessageCount, 325);
    await maybeAutoUpdateGroupProfile('20001'); assert.equal(calls.length, 1);
  });
  await test('normal mode keeps its successful group-profile frequency', async () => {
    seed({ tokenSavingMode: false }); store.updateDb(db => { db.groupProfiles = [{ groupId: '20001', enabled: true, pendingMessageCount: 80 }]; });
    await maybeAutoUpdateGroupProfile('20001');
    store.updateDb(db => { db.groupProfiles[0].pendingMessageCount = 80; }); await maybeAutoUpdateGroupProfile('20001');
    assert.equal(calls.length, 2);
  });
  await test('out-of-credit response blocks further HTTP calls and does not retry the paid request', async () => {
    seed(); status = 402;
    await assert.rejects(() => completeChat(store.readDb(), { messages: [{ role: 'user', content: 'fixture' }], thinking: { type: 'enabled' }, reasoning_effort: 'max' }));
    assert.equal(calls.length, 1); assert.equal(calls[0].max_tokens, 2048);
    await assert.rejects(() => completeChat(store.readDb(), { messages: [] }), /10 分钟/); assert.equal(calls.length, 1);
    saving.assertSavingApiAvailable(store.readDb(), Date.now() + 11 * 60000); status = 200;
    await completeChat(store.readDb(), { messages: [{ role: 'user', content: 'fixture' }] }); assert.equal(calls.length, 2);
  });
  await test('DeepSeek fixture receives actual low effort and the thinking-inclusive cap', async () => {
    seed({ llmProvider: 'deepseek' });
    await completeChat(store.readDb(), { messages: [{ role: 'user', content: 'fixture' }], thinking: { type: 'enabled' }, reasoning_effort: 'max', traceStreaming: false });
    assert.equal(calls.length, 1); assert.equal(calls[0].reasoning_effort, 'low'); assert.equal(calls[0].thinking.type, 'enabled'); assert.equal(calls[0].max_tokens, 2048);
  });
  await test('normal-mode options and stored preferences restore without being rewritten', () => {
    seed({ tokenSavingMode: false }); const options = { maxTokens: 900, reasoning_effort: 'max' };
    assert.equal(saving.savingLlmOptions(store.readDb(), options), options);
    const db = store.readDb(), before = structuredClone(db.settings); const limits = { minMessages: 5, updateEvery: 30, maxSamples: 30 };
    assert.equal(saving.savingMemoryThresholds(db, limits), limits); assert.deepEqual(db.settings, before);
    assert.equal(db.settings.socialMaxAssessmentsPerHour, 60); assert.equal(db.settings.memoryUpdateEvery, 30);
    const input = reasoningInput('tool_planner', { toolSelectionRequired: true });
    assert.equal(createShadowReasoningRouter(10, () => {}, 'low').resolve(input, emptyTurnState()).level, 'low');
    assert.equal(createShadowReasoningRouter(10, () => {}).resolve(input, emptyTurnState()).level, 'max');
  });
  await test('an in-flight full assessment cannot update relationship state after enabling saving mode', async () => {
    seed({ tokenSavingMode: false }); const before = structuredClone(store.readDb().socialV2.people);
    await assessSocialTurn(event(), 'initial', async (_db, options) => {
      console.log('Full assessment prompt characters:', JSON.stringify(options.messages).length);
      store.updateDb(db => { db.settings.tokenSavingMode = true; });
      return { text: JSON.stringify({ action: 'reply', addressee: 'bot', reason: 'fixture', evidenceIds: ['new'], affinityDelta: 2, familiarityDelta: 1,
        summary: 'should not apply', preferredNames: null, style: null, mood: { label: '开心', reason: 'fixture' } }), usage: {} };
    });
    assert.deepEqual(store.readDb().socialV2.people, before);
  });
  await test('the existing chat pipeline uses one gate then one reply without social state updates', async () => {
    seed({ memoryEnabled: false, thinkingNoticeMode: 'off', stickerDeliveryMode: 'off', osuSearchEnabled: false, levelUpNotifyEnabled: false });
    responseText = count => count === 1 ? '{"reply":true,"to":"bot"}' : '练得不错';
    const { processIncoming } = await import('../server/bot.ts'); const sent = [];
    const before = structuredClone(store.readDb().socialV2.self);
    await processIncoming(event({ socialDirect: true, nickname: 'Fixture', atTargets: ['10002'], images: [], raw: {} }), async (_event, text) => {
      sent.push(text); return { outcome: 'confirmed_success', messageId: 'receipt' };
    });
    assert.equal(calls.length, 2); assert.ok(sent.some(text => String(text).includes('练得不错')));
    assert.deepEqual(store.readDb().socialV2.people, {}); assert.deepEqual(store.readDb().socialV2.self, before);
  });
} finally {
  await waitForBackgroundTasks(3000); globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); cleanupTestDir(directory);
}
