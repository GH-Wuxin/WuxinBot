import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
const directory = createTestDataDir('wuxin-group-context');
process.env.NODE_ENV = 'test';
const store = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { selectAdaptiveGroupContext } = await import('../server/bot/contextSearch.ts');
const { assessSocialParticipation, revalidateSocialReply } = await import('../server/bot/social/runtime.ts');
const { emptySocialState } = await import('../server/bot/social/state.ts');
const { SocialCoordinator } = await import('../server/bot/social/coordinator.ts');
store.ensureStore();
const group = { groupId: 'g', name: '测试群', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 100 };
const settings = { selfQq: 'bot', ownerQq: 'owner', contextLimit: 30, groupContextSearchEnabled: true,
  groupContextSearchPoolSize: 800, groupContextSearchMaxExtra: 48, groupContextSearchCharBudget: 20000,
  tokenSavingMode: false, socialV2Enabled: true, socialMaxAssessmentsPerHour: 60,
  globalPaused: false, onlyMentionMode: false, memoryEnabled: false, osuSearchEnabled: false, presenceEnabled: false };
const row = (id, content, extras = {}) => ({ id: 'local-' + id, sourceMessageId: id, groupId: 'g', type: 'group',
  accountId: 'bot', role: 'user', userId: 'b', nickname: '乙', createdAt: new Date().toISOString(), inContext: true,
  content, ...extras });
const event = (extras = {}) => ({ source: 'onebot', type: 'group', groupId: 'g', messageId: 'target', userId: 'a',
  nickname: '甲', text: '他过了吗？', atTargets: [], ...extras });
const dbFor = (messages, overrides = {}) => ({ ...structuredClone(store.readDb()), groups: [group], users: [], messages,
  settings: { ...store.readDb().settings, ...settings, ...overrides } });
const prompt = (db, e) => buildPrompt(db, group, e, { policy: 'normal' }).map(m => m.content);
const filler = (n) => Array.from({ length: n }, (_, i) => row('noise-' + i, '无关闲聊'));
const antecedent = row('source', '小林已经通过资格赛', { userId: 'a', nickname: '甲' });
const last = row('target', '他过了吗？', { userId: 'a', nickname: '甲' });

await test('busy room preserves prior speaker context without a deictic word list; main prompt meets the fence', () => {
  const db = dbFor([antecedent, ...filler(85), last, row('future', '来自未来的新话题'), row('other', '别账号', { accountId: 'other' })]);
  for (const text of ['他过了吗？', '那他呢？', '过了吗？', 'hello']) {
    const sel = selectAdaptiveGroupContext(db, event({ text }));
    assert(sel.messages.includes(antecedent));
    assert(!sel.messages.some(m => ['future', 'other', 'target'].includes(m.sourceMessageId)));
    assert.equal(sel.stats.reason, 'conversation_links');
  }
  const p = prompt(db, event());
  assert.match(p[1], /消息#source.*甲（QQ:a）：小林已经通过资格赛/);
  assert.doesNotMatch(p.join('\n'), /来自未来的新话题|别账号|按当前句子本身回应/);
  assert.match(p[0], /没有通过 QQ 实际 @ 你/);
  assert.match(prompt(db, event({atTargets:['bot']}))[0], /通过 QQ 实际 @ 了你/);
});

await test('two speakers and old nested replies retain source IDs and account/room isolation', () => {
  const origin = row('first', '陈的方案', { userId: 'c', nickname:'丙' });
  const reply = row('inner', '这个能过', { replyMessageId:'first' });
  const stale = row('wrong-account', '另账号原话', { accountId:'other', userId:'a' });
  const otherRoom = row('wrong-room', '另群原话', { groupId:'other', userId:'a' });
  const db = dbFor([origin, reply, ...filler(85), stale, otherRoom, last, row('future', '新内容')]);
  const p = prompt(db, event({ replyMessageId:'inner' }));
  assert.match(p[1], /消息#first.*丙（QQ:c）：陈的方案/);
  assert.match(p[1], /消息#inner；回复消息#first.*乙（QQ:b）：这个能过/);
  assert.match(p.at(-1), /消息#target；回复消息#inner.*甲（QQ:a）/);
  assert.doesNotMatch(p.join('\n'), /另账号原话|另群原话|新内容/);
});

await test('ambient quoted fragment plus unquoted follow-up retain original quote, room fence and distinct current IDs', async () => {
  const coordinator = new SocialCoordinator(10);
  const e1 = event({ messageId:'q', text:'这一项呢', replyMessageId:'source',
    quotedMessage:{ messageId:'source', text:antecedent.content, nickname:'丙', userId:'c', images:[] } });
  let p;
  const run = async e => {
    const db = dbFor([row('source', antecedent.content, { userId:'c', nickname:'丙' }), row('q','这一项呢', {userId:'a'}),
      row('target','再补一句', {userId:'a'}), row('future','这是后来的话')]);
    p = prompt(db,e);
    return {replied:true};
  };
  await Promise.all([coordinator.submit(e1, 0, run), coordinator.submit(event({text:'再补一句'}), 0, run)]);
  assert.match(p.at(-1), /消息#q；回复消息#source.*这一项呢/);
  assert.match(p.at(-1), /所回复的 QQ 消息｜丙（QQ:c）.*小林已经通过资格赛/);
  assert.match(p.at(-1), /消息#target.*再补一句/);
  assert.doesNotMatch(p[1], /消息#q\]|再补一句|这是后来的话/);
});

await test('the actual participation payload shares evidence IDs with generation, not late or unseen turns', async () => {
  store.updateDb(db => Object.assign(db, dbFor([antecedent, ...filler(85), last, row('future','后来才转话题')])));
  const e = event();
  let got;
  const result = await assessSocialParticipation(e, 'initial', async (_db, opts) => {
    got = JSON.parse(opts.messages.at(-1).content);
    return {text:JSON.stringify({action:'reply', addressee:'bot', reason:'同话题继续'})};
  });
  assert.equal(result?.action,'reply');
  assert.equal(got.bot.userId,'bot');
  assert(got.timeline.some(m => m.messageId==='source' && m.senderId==='a'));
  assert(!got.timeline.some(m => ['future','target'].includes(m.messageId)));
  store.updateDb(db => db.messages.push(row('later','门控结束后才出现')));
  const generated = prompt(store.readDb(), e);
  assert.deepEqual([...generated[1].matchAll(/\[消息#([^；\]]+)/g)].map(m=>m[1]), got.timeline.map(m=>m.messageId));
  assert.doesNotMatch(generated.join('\n'), /后来才转话题|门控结束后才出现/);
  let fresh;
  await revalidateSocialReply(e,'原话',{},async (_db, opts) => {
    fresh = JSON.parse(opts.messages.at(-1).content).fresh;
    return {text:JSON.stringify({action:'keep', reason:'测试'})};
  });
  assert.deepEqual(fresh.map(m=>m.messageId), ['future','later']);
});

await test('saving and explicitly disabled extra retrieval stay bounded', () => {
  for (const controls of [{tokenSavingMode:true}, {groupContextSearchEnabled:false}]) {
    const db = dbFor([antecedent, ...filler(85), last], controls);
    const sel = selectAdaptiveGroupContext(db,event());
    assert(!sel.messages.includes(antecedent));
    assert(sel.messages.length <= (controls.tokenSavingMode ? 8 : 30));
    assert.equal(sel.stats.reason, 'disabled');
  }
});
await test('compact gate and reply retain the first quoted fragment without inheriting its @ or later chatter', async () => {
  const coordinator = new SocialCoordinator(10);
  const e1 = event({ messageId:'q-save', text:'这项呢？', replyMessageId:'q-ref',
    quotedMessage:{ messageId:'q-ref', text:'原话里 [CQ:at,qq=bot] 只是引用', nickname:'丙', userId:'c', images:[] } });
  const e2 = event({ messageId:'target-save', text:'我补一句' });
  let gateCalls = 0;
  const run = async e => {
    store.updateDb(db => {
      Object.assign(db, dbFor([row('q-ref', '原话', { userId:'c', nickname:'丙' }), ...filler(24),
        row('q-save',e1.text,{userId:'a'}), row('target-save',e2.text,{userId:'a'}), row('late-saving','后来才说')],
        {tokenSavingMode:true}));
      db.socialV2 = emptySocialState();
    });
    let gate;
    const decision = await assessSocialParticipation(e, 'initial', async (_db, opts) => {
      gateCalls++;
      gate = JSON.parse(opts.messages.at(-1).content);
      return {text:'{"reply":true,"to":"bot"}'};
    });
    assert.equal(decision?.action, 'reply');
    assert.equal(gate.batch[0].replyTo, 'q-ref');
    assert.equal(gate.batch[0].quote.nickname, '丙');
    assert.deepEqual(gate.batch[0].atTargets, []);
    assert(!gate.recent.some(m => m.id === 'late-saving' || m.id === e1.messageId || m.id === e2.messageId));
    assert(gate.recent.length <= 8);
    const rendered = prompt(store.readDb(),e);
    assert.match(rendered.at(-1), /所回复的 QQ 消息｜丙（QQ:c）/);
    assert.match(rendered[0], /没有通过 QQ 实际 @ 你/);
    assert.doesNotMatch(rendered.join('\n'), /后来才说/);
    return {replied:true};
  };
  const [r] = await Promise.all([coordinator.submit(e1,0,run), coordinator.submit(e2,0,run)]);
  assert(r.replied);
  assert.equal(gateCalls, 1);
  const direct = await assessSocialParticipation(event({socialDirect:true, atTargets:['bot']}), 'initial',
    async () => { throw Error('direct compact @ must not run the gate') });
  assert.equal(direct?.action, 'reply');
});
cleanupTestDir(directory);
