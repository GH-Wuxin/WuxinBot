import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const dir = createTestDataDir('wuxin-pippi-activity');
process.env.OSU_CLIENT_ID = 'fixture'; process.env.OSU_CLIENT_SECRET = 'fixture';
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { emptySocialState, normalizeSocialState, isSystemOwner } = await import('../server/bot/social/state.ts');
const { readPippiSelf, readPippiActivity, correctSelfExperience } = await import('../server/bot/social/self.ts');
const { runPippiActivityCycle, activityDay, reserveActivityTokens, settleActivityTokens, recoverActivityReservations,
  pippiActivityStatus, startPippiActivity, stopPippiActivity } = await import('../server/bot/activity.ts');
const { completeChat } = await import('../server/bot/llm.ts');
const { reserveLlmInvocation } = await import('../server/llmPolicy.ts');
ensureStore();
const now = Date.now(), iso = new Date(now).toISOString();
const seed = (settings = {}) => updateDb(db => {
  Object.assign(db.settings, { ownerQq: 'owner', selfQq: 'bot', socialV2Enabled: true, globalPaused: false,
    pippiActivityEnabled: true, pippiActivityDailyTokens: 30000, pippiActivityMaxWakes: 3, pippiActivityForumIds: [],
    osuSearchEnabled: true, llmProvider: 'openai-compatible', apiKey: 'fixture', model: 'fixture',
    personalityPrompt: '', personaPromptSections: {}, personaModulePrompts: {}, ...settings });
  db.socialV2 = emptySocialState(); normalizeSocialState(db);
  db.groups = [{ groupId: 'room', name: 'Fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 }];
  db.users = []; db.messages = [{ id: 'recent', role: 'user', type: 'group', groupId: 'room', userId: 'member',
    content: '最近在练读图', createdAt: iso }]; db.ownerDirectives = [];
});
const ledger = (at = now) => readPippiActivity(readDb()).days[activityDay(at)];
const response = (value, usage = { total_tokens: 100 }) => ({ text: JSON.stringify(value), usage });
const article = 'https://osu.ppy.sh/home/news/fixture';
const search = async args => ({ kind: args.kind, results: [{ title: 'A real article', url: article, snippet: 'New reading practice discussion' }] });
const readCall = { id: 'read', type: 'function', function: { name: 'read_osu', arguments: JSON.stringify({ url: article }) } };
const execute = async () => ({ ok: true, content: 'Actual published text', metadata: { reading: { id: 'reading:fixture', url: article, title: 'Fixture', at: iso } } });
const self = { evidenceIds: ['reading:fixture'], remember: { fact: '读了练习方法的讨论', impression: '对慢速读图的效果有点好奇' },
  mood: { label: '有点好奇', reason: '看到新观点', publicTone: '期待' }, focus: { text: '关注练习建议的后续' } };
const reading = (share = false, afterFinal) => {
  let calls = 0;
  return async (_db, options) => {
    assert.equal(options.completionBudget, 2048); assert.equal(options.requestMaxRetries, 0); assert.equal(options.retryOnEmpty, false);
    calls++;
    if (calls === 1) return { text: '', usage: { total_tokens: 100 }, raw: { choices: [{ message: { tool_calls: [readCall] } }] } };
    if (calls === 2) return response({ self, share });
    if (afterFinal) await afterFinal();
    return response({ action: 'share', text: '慢一点读图说不定更容易发现卡在哪' });
  };
};

try {
  await test('reservations count once, reasoning is included, unknown usage is conservative and crash recovery persists', () => {
    seed(); const a = reserveActivityTokens(1000, now);
    assert.equal(pippiActivityStatus(readDb(), now).reservedTokens, 1000);
    settleActivityTokens(a, { prompt_tokens: 200, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 150 } });
    settleActivityTokens(a, { total_tokens: 500 }); assert.equal(ledger().tokens, 500);
    settleActivityTokens(reserveActivityTokens(900, now)); assert.equal(ledger().unknownTokens, 900);
    reserveActivityTokens(700, now); updateDb(recoverActivityReservations);
    assert.equal(ledger().tokens, 2100); assert.equal(ledger().unknownTokens, 1600);
    assert.deepEqual(ledger().reservations, {});
    assert.throws(() => reserveActivityTokens(30000, now), /DAILY_BUDGET/);
    assert.equal(reserveActivityTokens(1000, now + 86400000).amount, 1000);
    assert.equal(activityDay(Date.parse('2026-10-25T16:00:00Z')), '2026-10-26');
  });
  await test('background activity can never impersonate Owner, including an ID collision', () => {
    seed({ ownerQq: 'pippi-activity' });
    assert.equal(isSystemOwner(readDb(), { userId: 'pippi-activity', source: 'pippi-activity' }), false);
    assert.equal(isSystemOwner(readDb(), { userId: 'pippi-activity', source: 'onebot' }), true);
  });
  await test('no news, disabled state, pause, unavailable output cap and foreground work spend no model tokens', async () => {
    let calls = 0; const invoke = async () => { calls++; return response({ self: null }); };
    for (const settings of [{ pippiActivityEnabled: false }, { globalPaused: true }, { socialV2Enabled: false }, { llmProvider: 'codex-app-server' }]) {
      seed(settings); await runPippiActivityCycle({ search, invoke }, now);
    }
    seed(); await runPippiActivityCycle({ search: async () => ({ results: [] }), invoke }, now);
    const slot = await reserveLlmInvocation();
    try { await runPippiActivityCycle({ search, invoke }, now + 3600000); } finally { slot.release(); }
    assert.equal(calls, 0);
  });
  await test('one actual reading commits once; wake gap, source versions and state reload prevent duplicate work', async () => {
    seed(); await runPippiActivityCycle({ search, execute, invoke: reading() }, now);
    assert.equal(ledger().tokens, 200); assert.equal(ledger().wakes, 1);
    assert.equal(readPippiSelf(readDb()).experiences.length, 1);
    updateDb(db => { db.socialV2 = JSON.parse(JSON.stringify(db.socialV2)); });
    let extra = 0;
    await runPippiActivityCycle({ search, invoke: async () => { extra++; } }, now + 60000);
    assert.equal(extra, 0); assert.equal(readPippiActivity(readDb()).pending.length, 0);
    await runPippiActivityCycle({ search, execute, invoke: reading() }, now + 5 * 3600000);
    assert.equal(readPippiSelf(readDb()).experiences.length, 1);
  });
  await test('model cannot remember an unread candidate or a failed article', async () => {
    seed(); await runPippiActivityCycle({ search, invoke: async () => response({ self, share: true }) }, now);
    assert.equal(readPippiSelf(readDb()).experiences.length, 0);
    seed(); await runPippiActivityCycle({ search, execute: async () => ({ ok: false, content: 'not readable' }), invoke: reading() }, now);
    assert.equal(readPippiSelf(readDb()).experiences.length, 0);
  });
  await test('daily cap reserves before a request; unknown failures consume their reservation with no retry', async () => {
    seed({ pippiActivityDailyTokens: 1000 }); let calls = 0;
    await runPippiActivityCycle({ search, invoke: async () => { calls++; } }, now);
    assert.equal(calls, 0); assert.match(readPippiActivity(readDb()).lastOutcome, /预留/);
    seed(); await runPippiActivityCycle({ search, invoke: async () => { calls++; throw new Error('unknown upstream failure'); } }, now);
    assert.equal(calls, 1); assert.ok(ledger().unknownTokens > 2048); assert.deepEqual(ledger().reservations, {});
    assert.equal(ledger().wakes, 1);
  });
  await test('three calls and two tools bound a model that keeps requesting tools', async () => {
    seed({ pippiActivityDailyTokens: 100000 }); let calls = 0, tools = 0;
    await runPippiActivityCycle({ search, execute: async () => { tools++; return execute(); }, invoke: async () => {
      calls++; return { text: '', usage: { total_tokens: 100 }, raw: { choices: [{ message: { tool_calls: [readCall, { ...readCall, id: 'second' }] } }] } };
    } }, now);
    assert.equal(calls, 3); assert.equal(tools, 2); assert.equal(ledger().tokens, 300);
  });
  await test('single-flight cycle and disabling during a call stop further requests and state changes', async () => {
    seed(); let release, entered; const started = new Promise(resolve => { entered = resolve; });
    const pending = runPippiActivityCycle({ search, invoke: async () => { entered(); await new Promise(resolve => { release = resolve; }); return response({ self }); } }, now);
    await started;
    await runPippiActivityCycle({ search, invoke: async () => assert.fail('overlapping cycle') }, now);
    updateDb(db => { db.settings.pippiActivityEnabled = false; }); release(); await pending;
    assert.equal(readPippiSelf(readDb()).experiences.length, 0); assert.equal(ledger().wakes, 1);
  });
  for (const confirmed of [false, true]) await test(`sharing records actual confirmation: ${confirmed}`, async () => {
    seed(); const sent = [];
    await runPippiActivityCycle({ search, execute, invoke: reading(true), send: async (event, text) => {
      sent.push({ event, text }); return { outcome: confirmed ? 'confirmed_success' : 'unknown', messageId: 'receipt' };
    } }, now);
    assert.equal(sent.length, 1); assert.equal(sent[0].event.source, 'pippi-activity');
    assert.equal(readPippiSelf(readDb()).experiences[0].shared.length, confirmed ? 1 : 0);
    assert.equal(readDb().messages.filter(m => m.role === 'assistant').length, confirmed ? 1 : 0);
    assert.equal(ledger().shares['group:room'], 1); assert.equal(ledger().tokens, 300);
  });
  for (const mode of ['light', 'mention', 'osu', 'silent']) await test(`autonomous reading cannot open a conversation in ${mode} mode`, async () => {
    seed(); updateDb(db => { db.groups[0].mode = mode; });
    await runPippiActivityCycle({ search, execute, invoke: reading(true), send: async () => assert.fail('must not send') }, now);
    assert.equal(ledger().tokens, 200);
  });
  for (const mutation of ['mode', 'new-message', 'forget', 'pause']) await test(`stale sharing cancelled after ${mutation}`, async () => {
    seed(); const change = () => updateDb(db => {
      if (mutation === 'mode') db.groups[0].mode = 'mention';
      if (mutation === 'pause') db.settings.globalPaused = true;
      if (mutation === 'new-message') db.messages.push({ ...db.messages[0], id: 'newer' });
      if (mutation === 'forget') { const e = readPippiSelf(db).experiences[0]; correctSelfExperience(db, e.id, e.revision, { remove: true }); }
    });
    await runPippiActivityCycle({ search, execute, invoke: reading(true, change), send: async () => assert.fail('stale draft sent') }, now);
  });
  await test('shutdown aborts an in-flight call and settles unknown usage', async () => {
    seed(); startPippiActivity(async () => assert.fail('unexpected send'));
    let entered; const started = new Promise(resolve => { entered = resolve; });
    const pending = runPippiActivityCycle({ search, invoke: async (_db, options) => {
      entered(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } }, now);
    await started; stopPippiActivity(); await pending;
    assert.equal(pippiActivityStatus(readDb()).busy, false); assert.ok(ledger().unknownTokens > 0);
  });
  await test('HTTP transport preserves low thinking and bounded completion, never uncaps or retries an empty/error response', async () => {
    seed({ llmProvider: 'deepseek' }); const bodies = []; let fail = false;
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json');
      if (fail) { res.statusCode = 503; return res.end(JSON.stringify({ error: { message: 'fixture failure' } })); }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'bounded fixture' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 2048, total_tokens: 2058 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      updateDb(db => { db.settings.apiBaseUrl = `http://127.0.0.1:${server.address().port}/v1`; });
      const options = { messages: [{ role: 'user', content: 'fixture' }], thinking: { type: 'enabled' }, reasoning_effort: 'low',
        completionBudget: 2048, requestMaxRetries: 0, retryOnEmpty: false };
      await completeChat(readDb(), options); assert.equal(bodies.length, 1);
      assert.equal(bodies[0].max_tokens, 2048); assert.equal(bodies[0].reasoning_effort, 'low'); assert.equal(bodies[0].thinking.type, 'enabled');
      fail = true; await assert.rejects(() => completeChat(readDb(), options)); assert.equal(bodies.length, 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
} finally { stopPippiActivity(); cleanupTestDir(dir); }
