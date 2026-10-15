/**
 * 「刚才为什么没开口」的验收。
 *
 * 要证明的不只是"记下来了"，还有三条防「变成借口」的结构限制：
 *   1. 只覆盖回复没生成出来这一种，所以她只能用这行字解释自己的缺席；
 *   2. 只留一小时内的（不能翻旧账）；
 *   3. 按群隔离（不能拿别的群的失败当话题），且措辞明说不用主动提。
 */
import assert from 'node:assert/strict';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-reply-failures');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const {
  appendReplyFailure, recentReplyFailures, replyFailureNotice,
  REPLY_FAILURE_WINDOW_MS, REPLY_FAILURE_NOTICE_MAX, REPLY_FAILURE_KEEP,
} = await import('../server/bot/replyFailures.ts');
const { classifyLlmFailure, describeLlmFailure } = await import('../server/bot/llmFailure.ts');

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

// ── 1. 分类：标记取自线上实际出现的错误消息 ──
const cases = [
  ['Selected model is at capacity. Please try a different model.', 'capacity'],
  ['Codex App Server 调用超时 240 秒', 'timeout'],
  ['workspace routing discovery timed out', 'timeout'],
  [{ status: 429, message: 'x' }, 'capacity'],
  [{ status: 503, message: 'x' }, 'capacity'],
  ['Invalid API key', 'auth'],
  ['image too large', 'other'],
];
for (const [error, want] of cases) {
  const got = classifyLlmFailure(error);
  assert.equal(got, want, '分类不符: ' + JSON.stringify(error).slice(0, 40) + ' → ' + got);
}

// ── 2. 措辞是人话，不是错误码 ──
for (const kind of ['capacity', 'timeout', 'auth', 'other']) {
  const text = describeLlmFailure(kind);
  assert.ok(text && !/[a-z_]{4,}/.test(text), kind + ' 的说法不该出现机器码: ' + text);
}

// ── 3. 只看一小时内的；超窗的必须消失 ──
{
  const failures = [
    { at: ago(5), groupId: 'g1', kind: 'capacity' },
    { at: ago(30), groupId: 'g1', kind: 'timeout' },
    { at: ago(90), groupId: 'g1', kind: 'capacity' },
  ];
  const recent = recentReplyFailures(failures, 'g1', NOW);
  assert.equal(recent.length, 2, '超出一小时的应当被排除');
  assert.ok(REPLY_FAILURE_WINDOW_MS === 60 * 60 * 1000);
}

// ── 4. 上限三条 ──
{
  const failures = Array.from({ length: 10 }, (_, i) => ({ at: ago(i + 1), groupId: 'g1', kind: 'capacity' }));
  const recent = recentReplyFailures(failures, 'g1', NOW);
  assert.equal(recent.length, REPLY_FAILURE_NOTICE_MAX, '最多列 ' + REPLY_FAILURE_NOTICE_MAX + ' 条');
}

// ── 5. 按群隔离：别的群的失败不能出现在这个群 ──
{
  const failures = [
    { at: ago(3), groupId: 'other-group', kind: 'capacity' },
    { at: ago(4), groupId: 'g1', kind: 'timeout' },
  ];
  const notice = replyFailureNotice(failures, 'g1', NOW);
  assert.ok(notice.includes('响应超时'), '本群的失败要出现');
  assert.ok(!notice.includes('模型容量不足'), '别的群的失败不得出现');
  assert.equal(replyFailureNotice(failures, 'no-failure-group', NOW), '', '没有失败时应当什么都不注入');
}

// ── 6. 措辞必须把性质定死：背景事实、别主动提、别当理由 ──
{
  const notice = replyFailureNotice([{ at: ago(8), groupId: 'g1', kind: 'capacity' }], 'g1', NOW);
  assert.ok(notice.includes('系统记录'), '按系统日志的口吻写');
  assert.ok(notice.includes('8 分钟前'), '要带相对时间');
  assert.ok(notice.includes('模型容量不足'), '要带错误类型');
  assert.ok(notice.includes('别主动提'), '必须写明不用主动提');
  assert.ok(notice.includes('也别当理由'), '必须写明不能当理由');
}

// ── 7. 只记「回复没生成出来」这一种：发图失败/权限拒绝不进这里 ──
{
  // appendReplyFailure 只接受显式传入的条目，调用方在 bot.ts 里用 !deliveryStarted 把关。
  // 这里守住存储层的行为：追加后长度被截住，且返回的是新数组（store 在赋值时做快照）。
  const before = [{ at: ago(1), groupId: 'g1', kind: 'other' }];
  const after = appendReplyFailure(before, { at: ago(0), groupId: 'g1', kind: 'capacity' });
  assert.notEqual(after, before, '必须返回新数组，原地 push 不会落盘');
  assert.equal(before.length, 1, '不得修改传入的数组');
  assert.equal(after.length, 2);
  const flooded = Array.from({ length: REPLY_FAILURE_KEEP + 20 }, (_, i) => ({ at: ago(i), groupId: 'g1', kind: 'other' }));
  assert.equal(appendReplyFailure(flooded, { at: ago(0), groupId: 'g1', kind: 'capacity' }).length, REPLY_FAILURE_KEEP);
}

// ── 8. 真的进了提示词吗 ──
{
  const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
  const { buildPrompt } = await import('../server/bot/prompt.ts');
  ensureStore();
  const promptFor = (failures) => {
    updateDb((db) => {
      db.settings.selfQq = '900000001';
      db.settings.botNames = 'pippi';
      db.settings.searchProvider = 'disabled';
      db.settings.enableWebSearch = false;
      db.replyFailures = failures;
      db.groups = [{ groupId: 'rf-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 }];
    });
    const db = readDb();
    const group = db.groups.find((g) => String(g.groupId) === 'rf-group');
    const event = {
      source: 'onebot', type: 'group', messageId: 'rf-1', groupId: 'rf-group',
      userId: '900000002', nickname: 'fixture-user', text: '你好', atTargets: [], images: [], raw: {},
    };
    return JSON.stringify(buildPrompt(db, group, event, { policy: 'normal', allowCommands: false }, {}));
  };
  const withFailure = promptFor([{ at: new Date(Date.now() - 5 * 60_000).toISOString(), groupId: 'rf-group', kind: 'capacity' }]);
  assert.ok(withFailure.includes('未能回复'), '有近期失败时提示词里应出现这行');
  assert.ok(withFailure.includes('模型容量不足'), '应带上错误类型');
  const withoutFailure = promptFor([]);
  assert.ok(!withoutFailure.includes('未能回复'), '没有失败时不该出现这行');
}

console.log('reply failures: classification, 1h window, 3-item cap, per-group isolation, '
  + 'no-excuse wording, and real prompt injection PASS');
