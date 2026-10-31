/**
 * @ 渲染验收：她能不能分清「谁在跟谁说话」。
 *
 * 起因：@ 段只有 QQ 号，历史里渲染成 [CQ:at,qq=123]，于是「@她」和「@别人」结构完全
 * 相同，她只能猜；而上下文里也从没告诉她自己的 QQ 是哪个，连猜都没依据。
 *
 * 做法照 AstrBot：入库时查名字（群里片优先、空则回退 QQ 昵称），随消息存下来，
 * 渲染成 @名字(QQ)，她自己渲染成 @你。
 */
import assert from 'node:assert/strict';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-mention-render');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const { displayName, collectMentionedQqs } = await import('../server/bot/memberDirectory.ts');
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { sanitizeReply } = await import('../server/bot/reply.ts');

assert.equal(
  sanitizeReply('hello [CQ:at,qq=all] [CQ:image,file=file:///C:/secret.png]', { botNames: 'Wuxin' }),
  'hello',
  'model/user text must not create QQ control segments',
);

const SELF = '3312171148';

// ── 1. 名字优先群名片，其次 QQ 昵称，都没有退回号码 ──
assert.equal(displayName({ qq: '1', card: '群名片', nickname: 'QQ昵称' }, '1'), '群名片');
assert.equal(displayName({ qq: '1', card: '', nickname: 'QQ昵称' }, '1'), 'QQ昵称');
assert.equal(displayName({ qq: '1', card: '', nickname: '' }, '1'), '1');
assert.equal(displayName(undefined, '1'), '1', '查不到必须退回号码，不能空着');

// ── 2. 从文本里挑出要查的 QQ ──
{
  const qqs = collectMentionedQqs(['[CQ:at,qq=111] 你好 [CQ:at,qq=222,name=x] 在吗', undefined, '']);
  assert.deepEqual(qqs.sort(), ['111', '222']);
  assert.deepEqual(collectMentionedQqs(['[CQ:at,qq=all] 全体']), [], 'all 不是具体的人');
  assert.deepEqual(collectMentionedQqs(['[CQ:at,qq=111] [CQ:at,qq=111]']), ['111'], '同一个号只查一次');
}

// ── 3. 真的渲染进提示词了吗 ──
ensureStore();
const promptFor = (messages) => {
  updateDb((db) => {
    db.settings.selfQq = SELF;
    db.settings.botNames = 'pippi';
    db.settings.osuSearchEnabled = false;
    db.settings.memoryEnabled = false;
    db.groups = [{ groupId: 'mr-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 }];
    db.messages = messages;
    db.decisions = [];
  });
  const db = readDb();
  const group = db.groups.find((g) => String(g.groupId) === 'mr-group');
  const event = {
    source: 'onebot', type: 'group', messageId: 'mr-1', groupId: 'mr-group',
    userId: '900000002', nickname: 'fixture-user', text: '你好', atTargets: [], images: [], raw: {},
  };
  return JSON.stringify(buildPrompt(db, group, event, { policy: 'normal', allowCommands: false }, {}));
};

const base = { role: 'user', type: 'group', groupId: 'mr-group', media: undefined, inContext: true };
const withMentions = promptFor([
  { ...base, id: 'm1', userId: '1001', nickname: '真人', content: '[CQ:at,qq=2002] 你打得不错', createdAt: new Date(Date.now() - 90_000).toISOString(),
    mentions: [{ qq: '2002', card: '被夸的人', nickname: 'qq昵称B' }] },
  { ...base, id: 'm2', userId: '1003', nickname: '另一个人', content: '[CQ:at,qq=' + SELF + '] 你在吗', createdAt: new Date(Date.now() - 60_000).toISOString(),
    mentions: [] },
]);

assert.ok(withMentions.includes('@被夸的人(2002)'), '被别人 @ 的目标应渲染成群名片 + 号码');
assert.ok(!withMentions.includes('[CQ:at,qq=2002]'), '裸号码不该再出现');
assert.ok(withMentions.includes('@你'), '@她自己必须渲染成 @你');
assert.ok(!withMentions.includes('@' + SELF), '她自己的号码不该直接暴露成 @号码');

// ── 4. 上下文必须告诉她自己是哪个 QQ ──
assert.ok(withMentions.includes(SELF), '上下文里必须有她自己的 QQ');
assert.ok(withMentions.includes('@ 到这个号就是在跟你说话'), '要说明 @ 到这个号意味着什么');

// ── 5. 查不到名字时退回号码，不崩 ──
const withoutNames = promptFor([
  { ...base, id: 'm3', userId: '1004', nickname: '某人', content: '[CQ:at,qq=3003] 早', createdAt: new Date(Date.now() - 30_000).toISOString() },
]);
assert.ok(withoutNames.includes('(3003)'), '拿不到名字应保留号码，便于她至少知道是同一个号');

console.log('mention render: display-name fallback, self-@ as @你, name+QQ rendering, '
  + 'unknown-name degradation, and self-QQ disclosure PASS');
