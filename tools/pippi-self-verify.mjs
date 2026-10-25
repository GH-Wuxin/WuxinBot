import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySocialState, normalizeSocialState } from '../server/bot/social/state.ts';
import { commitSelfProposal, correctSelfExperience, finishSelfFocus, readPippiSelf, selfContext, selfContextPrompt, markExperienceShared } from '../server/bot/social/self.ts';

const fixture = () => {
  const db = { settings: { ownerQq: 'owner' }, socialV2: emptySocialState(), ownerDirectives: [] };
  normalizeSocialState(db); return db;
};
const source = (id, scope = 'group:a', kind = 'message') => ({ id, scope, kind, at: '2026-10-26T00:00:00Z', ...(kind === 'message' ? { userId: 'member' } : { url: 'https://osu.ppy.sh/wiki/en/Gameplay/Accuracy', title: 'Accuracy' }) });
const proposal = id => ({ evidenceIds: [id], remember: { fact: '讨论了练习瓶颈', impression: '觉得可以先看看具体卡在哪里' } });
const commit = (db, p, sources, scope = 'group:a', revision = readPippiSelf(db).revision) => commitSelfProposal(db, p, { scope, sources, expectedRevision: revision });

test('additive migration retains ordinary relationships and Owner identity', () => {
  const db = fixture();
  db.socialV2.people = {
    owner: { userId: 'owner', affinity: { kind: 'ordinary', score: 12 }, familiarity: 88, revision: 3, updatedAt: 'before' },
    member: { userId: 'member', affinity: { kind: 'ordinary', score: 41 }, familiarity: 60, revision: 2, updatedAt: 'before' },
  };
  const ordinary = structuredClone(db.socialV2.people.member);
  normalizeSocialState(db);
  assert.deepEqual(db.socialV2.people.member, ordinary);
  assert.deepEqual(db.socialV2.people.owner.affinity, { kind: 'owner', label: '特殊' });
  assert.equal(readPippiSelf(db).experiences.length, 0);
  assert.equal(selfContextPrompt(db, 'group:a'), '');
  assert.equal(commit(db, null, []).applied, false);
});

test('actual evidence, optimistic versioning and identity cannot be supplied by the model', () => {
  const db = fixture(), before = structuredClone(db);
  assert.equal(commit(db, proposal('fabricated'), [source('real')]).reason, 'missing_actual_evidence');
  assert.equal(commit(db, { ...proposal('real'), ownerQq: 'member' }, [source('real')]).reason, 'invalid_proposal');
  assert.deepEqual(db, before);
  assert.equal(commit(db, proposal('real'), [source('real')]).applied, true);
  const after = structuredClone(db);
  assert.equal(commit(db, proposal('next'), [source('next')], 'group:a', 0).reason, 'stale_revision');
  assert.deepEqual(db, after);
  assert.equal(commit(db, proposal('real'), [source('real')]).applied, false);
  assert.equal(readPippiSelf(db).experiences.length, 1);
});

test('private experiences and mood reasons do not leak through global mood', () => {
  const db = fixture(), scope = 'private:owner';
  const p = { evidenceIds: ['private-source'], remember: { fact: '私密事件 secret-A', impression: '私密看法 secret-B' },
    mood: { label: 'secret-C 的事让我不快', reason: 'secret-D', publicTone: '烦躁' }, focus: { text: '关注 secret-E 的后续' } };
  assert.equal(commit(db, p, [source('private-source', scope)], scope).applied, true);
  const other = JSON.stringify(selfContext(db, 'group:b'));
  assert.ok(other.includes('烦躁'));
  assert.ok(!other.includes('secret-') && !other.includes('private-source'));
  assert.ok(JSON.stringify(selfContext(db, scope)).includes('secret-A'));
  assert.equal(commit(db, { ...p, mood: { ...p.mood, publicTone: 'secret-person' } }, [source('private-source', scope)], scope).reason, 'invalid_mood');
  assert.equal(commit(db, proposal('private-source'), [source('private-source', scope)], 'group:b').reason, 'missing_actual_evidence');
});

test('public reading can be used elsewhere, but sharing is separately confirmed and per scope', () => {
  const db = fixture(), p = proposal('read-1');
  p.remember.fact = '读取了准确率 Wiki';
  const result = commit(db, p, [source('read-1', 'public', 'reading')], 'public');
  assert.ok(selfContext(db, 'group:a').experiences.length);
  assert.equal(markExperienceShared(db, result.experienceId, 'group:a', ''), false);
  assert.equal(selfContext(db, 'group:a').experiences[0].sharedHere, false);
  assert.equal(markExperienceShared(db, result.experienceId, 'group:a', 'confirmed-message'), true);
  assert.equal(selfContext(db, 'group:a').experiences[0].sharedHere, true);
  assert.equal(selfContext(db, 'group:b').experiences[0].sharedHere, false);
  assert.ok(!JSON.stringify(selfContext(db, 'group:b')).includes('confirmed-message'));
});

test('correction survives replay; forgetting removes references and blocks same-source reconstruction', () => {
  const db = fixture(), p = { ...proposal('a'), focus: { text: '还想了解练习方式' }, mood: { label: '有些期待', reason: '这次交流', publicTone: '期待' } };
  const result = commit(db, p, [source('a')]);
  correctSelfExperience(db, result.experienceId, 0, { fact: '校正后的事实', impression: '暂时不下结论' });
  assert.equal(readPippiSelf(db).focus.length, 0);
  assert.equal(readPippiSelf(db).mood, null);
  assert.equal(commit(db, p, [source('a')]).reason, 'corrected_source');
  assert.throws(() => correctSelfExperience(db, result.experienceId, 0, { remove: true }), /已变化/);
  commit(db, proposal('a'), [source('a')]);
  assert.equal(readPippiSelf(db).experiences[0].fact, '校正后的事实');
  correctSelfExperience(db, result.experienceId, 1, { remove: true });
  assert.equal(readPippiSelf(db).focus.length, 0);
  assert.equal(readPippiSelf(db).mood, null);
  assert.equal(commit(db, proposal('a'), [source('a')]).reason, 'forgotten_source');
  assert.equal(commit(db, { ...proposal('a'), evidenceIds: ['a', 'new'] }, [source('a'), source('new')]).reason, 'forgotten_source');
  assert.ok(!selfContextPrompt(db, 'group:a').includes('校正后的事实'));
});

test('ending focus has version and scope checks', () => {
  const db = fixture(); commit(db, { ...proposal('a'), focus: { text: '关注A' } }, [source('a')]);
  const focus = readPippiSelf(db).focus[0];
  assert.equal(commit(db, { finishFocusIds: [focus.id] }, [], 'group:b').reason, 'invalid_focus_scope');
  assert.throws(() => finishSelfFocus(db, focus.id, 0), /已变化/);
  finishSelfFocus(db, focus.id, readPippiSelf(db).revision);
  assert.equal(readPippiSelf(db).focus.length, 0);
});

test('bounded records preserve current focus and prompt size without changing relationships', () => {
  const db = fixture();
  commit(db, { ...proposal('pinned'), focus: { text: '保留当前关注' } }, [source('pinned')]);
  const pinned = readPippiSelf(db).experiences[0].id;
  for (let i = 0; i < 1002; i++) commit(db, proposal('record-' + i), [source('record-' + i)]);
  assert.equal(readPippiSelf(db).experiences.length, 1000);
  assert.ok(readPippiSelf(db).experiences.some(e => e.id === pinned));
  assert.ok(JSON.stringify(selfContext(db, 'group:a', 'member')).length <= 2200);
  assert.deepEqual(db.socialV2.people, {});
  const restored = JSON.parse(JSON.stringify(db)); normalizeSocialState(restored);
  assert.deepEqual(restored.socialV2.self, db.socialV2.self);
});

test('malformed persisted self data is rejected instead of wiped', () => {
  const db = fixture(); db.socialV2.self.focus.push({ text: 'orphan', scope: 'group:a', experienceId: 'missing' });
  assert.throws(() => normalizeSocialState(db), /拒绝静默清空/);
  assert.equal(db.socialV2.self.focus.length, 1);
  for (const key of ['self', 'activity']) {
    const broken = fixture(); broken.socialV2[key] = null;
    assert.throws(() => normalizeSocialState(broken), /socialV2/);
    assert.equal(broken.socialV2[key], null);
  }
});
