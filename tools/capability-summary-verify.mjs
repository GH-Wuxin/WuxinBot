/**
 * 能力层验收：本轮能力摘要。
 *
 * 目的不是「她答得更好」，而是保证她对自己当前会什么的认识与运行状态一致，
 * 且这份认识来自已有元数据、有硬预算、不把受限能力说成开放。
 *
 * 覆盖：预算上限（含受保护内容本身溢出时的兜底）、限定词不被截断、命令入口来自
 * 元数据、未开放的命令不被宣传、以及摘要确实进了真实提示词（用 buildPrompt 而不是
 * 只看函数）。
 *
 * 表情可用性这一项必须与发送器同源。以前摘要自己读 db.settings.stickerPolicy，
 * 而发送器读 stickerDeliveryConfig —— 后者会被 WUXIN_STICKER_* 环境变量覆盖，
 * 于是下面这几个用例会失败。它们就是为那次错位补的。
 */
import assert from 'node:assert/strict';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-capability-summary');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const {
  buildCapabilitySummary, CAPABILITY_SUMMARY_BUDGET, CAPABILITY_SUMMARY_BOUNDARY,
} = await import('../server/bot/capabilitySummary.ts');
const { CAPABILITY_CATALOG } = await import('../server/bots/capabilityCatalog.ts');
const { QUICK_DEFS } = await import('../server/bot/commands/quick.meta.ts');

const states = [
  ['表情可发 + 搜索可用', { stickerState: 'live', searchAvailable: true }],
  ['表情关闭 + 无搜索', { stickerState: 'off', searchAvailable: false }],
  ['仅演练', { stickerState: 'dry-run', searchAvailable: true }],
  ['本群未开', { stickerState: 'group-closed', searchAvailable: false }],
];

for (const [label, input] of states) {
  const text = buildCapabilitySummary(input);
  const lines = text.split('\n');
  assert.ok(lines.length <= CAPABILITY_SUMMARY_BUDGET.maxLines, label + '：行数不得超上限');
  assert.ok(Array.from(text).length <= CAPABILITY_SUMMARY_BUDGET.maxPoints, label + '：码点数不得超上限');
  assert.ok(text.includes(CAPABILITY_SUMMARY_BOUNDARY), label + '：边界句必须保留');
  assert.ok(text.includes('未列出不等于不支持'), label + '：必须说明未列出 ≠ 不支持');
  assert.ok(text.includes('最终以发送校验为准'), label + '：表情可用性必须带限定');
}

// 四种状态必须各自说清楚，不能有两态说成同一句话
{
  const rendered = states.map(([, input]) => buildCapabilitySummary(input));
  assert.equal(new Set(rendered).size, states.length, '四种表情状态应当给出四种不同说法');
  assert.ok(buildCapabilitySummary({ stickerState: 'dry-run', searchAvailable: true }).includes('只演练'),
    '仅演练必须明说不会真的发出，这是最容易说成「可以发」的一态');
  assert.ok(buildCapabilitySummary({ stickerState: 'off', searchAvailable: true }).includes('关闭'),
    '关闭态要说明是功能关闭，而不是本群未开');
  assert.ok(buildCapabilitySummary({ stickerState: 'group-closed', searchAvailable: true }).includes('不在开放范围'),
    '本群未开要说明是范围问题，而不是功能关闭');
}

// 受保护内容本身溢出时，兜底不能把已经超限的内容再加长
{
  const original = { ...CAPABILITY_SUMMARY_BUDGET };
  try {
    CAPABILITY_SUMMARY_BUDGET.maxPoints = 40;
    CAPABILITY_SUMMARY_BUDGET.maxLines = 2;
    const text = buildCapabilitySummary({ stickerState: 'live', searchAvailable: true });
    assert.ok(Array.from(text).length <= 40, '兜底也必须守住码点预算，实际 ' + Array.from(text).length);
    assert.ok(text.split('\n').length <= 2, '兜底也必须守住行数预算');
    assert.ok(!text.includes('不是全量目录'), '不该再用「加长内容」的方式说明受限');
  } finally {
    CAPABILITY_SUMMARY_BUDGET.maxPoints = original.maxPoints;
    CAPABILITY_SUMMARY_BUDGET.maxLines = original.maxLines;
  }
}

// 未开放的命令不得被宣传成现成功能
const activeAliases = new Set(QUICK_DEFS.filter((d) => d.status === 'active').map((d) => d.aliases[0]));
const disabledOnlyAliases = QUICK_DEFS
  .filter((d) => d.status !== 'active' && d.capability)
  .map((d) => d.aliases[0])
  .filter((alias) => !activeAliases.has(alias));
const text = buildCapabilitySummary({ stickerState: 'live', searchAvailable: true });
for (const alias of disabledOnlyAliases) {
  assert.ok(!text.includes('!' + alias), '不该出现未开放的命令入口: !' + alias);
}

// 只能经命令调用的能力必须标注「仅命令」，并带上来自命令目录的入口
// 只统计「本来就要靠命令开启」的能力；工具面退役的条目不算命令功能。
const commandOnly = CAPABILITY_CATALOG.filter((item) => !item.callable && item.commandOnly);
assert.ok(commandOnly.length > 0, '目录里应当有只能经命令调用的能力');
for (const item of commandOnly) {
  const command = QUICK_DEFS.find((def) => def.capability === item.name && def.status === 'active');
  assert.ok(command, item.name + '：应当有对应的开放命令，否则摘要会指向一个不存在的入口');
  assert.ok(text.includes('!' + command.aliases[0]), item.name + '：命令入口应来自命令目录');
}
assert.ok(text.includes('仅命令'), '只能经命令调用的能力必须标明「仅命令」');

// 真的进了提示词：改群设置，摘要里的可用性要跟着变
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
ensureStore();

function promptFor(stickerGroupIds, mode = 'live') {
  updateDb((db) => {
    db.settings.selfQq = '900000001';
    db.settings.botNames = 'pippi';
    db.settings.osuSearchEnabled = false;
    db.settings.stickerPolicy = {
      mode, allGroups: false, groupIds: stickerGroupIds,
      groupCooldownSec: 0, userCooldownSec: 0, hourlyLimit: 10, dailyLimit: 20, userDailyLimit: 10,
      duplicateStickerCooldownSec: 0,
    };
    db.groups = [{ groupId: 'cap-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 }];
    db.messages = [];
    db.decisions = [];
  });
  const db = readDb();
  const group = db.groups.find((g) => String(g.groupId) === 'cap-group');
  const event = {
    source: 'onebot', type: 'group', messageId: 'cap-1', groupId: 'cap-group',
    userId: '900000002', nickname: 'fixture-user', text: '你好', atTargets: [], images: [], raw: {},
  };
  return JSON.stringify(buildPrompt(db, group, event, { policy: 'normal', allowCommands: false }, {}));
}

const allowed = promptFor(['cap-group']);
assert.ok(allowed.includes('【本轮能力】'), '能力摘要必须进入真实提示词');
assert.ok(allowed.includes('本群现在可以发'), '本群开放时摘要应说明可以发');

const denied = promptFor([]);
assert.ok(denied.includes('【本轮能力】'), '未开放时摘要仍应存在');
assert.ok(denied.includes('本群不在开放范围内'), '本群未开放时摘要必须说明发不了');

const dryRun = promptFor(['cap-group'], 'dry-run');
assert.ok(dryRun.includes('只演练'), '演练模式不得被说成可以发');

// 环境变量覆盖数据库 —— 这正是原来错位的地方
{
  const restore = process.env.WUXIN_STICKER_DELIVERY_MODE;
  try {
    process.env.WUXIN_STICKER_DELIVERY_MODE = 'off';
    const overridden = promptFor(['cap-group'], 'live');
    assert.ok(overridden.includes('发不了'),
      '数据库为 live 但环境变量关闭时，摘要必须说发不了（发送器按环境变量走）');
    assert.ok(!overridden.includes('本群现在可以发'), '环境变量关闭时不得宣称可以发');

    process.env.WUXIN_STICKER_DELIVERY_MODE = 'live';
    process.env.WUXIN_STICKER_ALL_GROUPS = 'true';
    const enabledByEnv = promptFor([], 'off');
    assert.ok(enabledByEnv.includes('本群现在可以发'),
      '数据库为 off 但环境变量开放时，摘要必须说可以发（否则她会该发而不发）');
  } finally {
    if (restore === undefined) delete process.env.WUXIN_STICKER_DELIVERY_MODE;
    else process.env.WUXIN_STICKER_DELIVERY_MODE = restore;
    delete process.env.WUXIN_STICKER_ALL_GROUPS;
  }
}

console.log('capability summary: budget (' + CAPABILITY_SUMMARY_BUDGET.maxLines + ' lines / '
  + CAPABILITY_SUMMARY_BUDGET.maxPoints + ' code points, fallback included), four sticker states, '
  + 'env-override parity with the sender, qualifiers preserved, metadata-derived, '
  + 'injected into the real prompt PASS');
