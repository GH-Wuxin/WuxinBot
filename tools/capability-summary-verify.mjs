/**
 * 能力层验收：本轮能力摘要。
 *
 * 目的不是「她答得更好」，而是保证她对自己当前会什么的认识与运行状态一致，
 * 且这份认识来自已有元数据、有硬预算、不把受限能力说成开放。
 *
 * 覆盖：预算上限、限定词不被截断、命令入口来自元数据、未开放的命令不被宣传、
 * 以及摘要确实进了真实提示词（用 buildPrompt 而不是只看函数）。
 */
import assert from 'node:assert/strict';
import { createTestDataDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-capability-summary');
process.env.DATA_DIR = dataDir;
assertNotProduction(dataDir);

const { buildCapabilitySummary, CAPABILITY_SUMMARY_BUDGET, CAPABILITY_SUMMARY_BOUNDARY } = await import(
  '../server/bot/capabilitySummary.ts'
);
const { CAPABILITY_CATALOG } = await import('../server/bots/capabilityCatalog.ts');
const { QUICK_DEFS } = await import('../server/bot/commands/quick.meta.ts');

const states = [
  ['表情可用 + 搜索可用', { stickerAvailable: true, searchAvailable: true }],
  ['表情不可用 + 无搜索', { stickerAvailable: false, searchAvailable: false }],
];

for (const [label, input] of states) {
  const text = buildCapabilitySummary(input);
  const lines = text.split('\n');
  assert.ok(lines.length <= CAPABILITY_SUMMARY_BUDGET.maxLines, label + '：行数不得超上限');
  assert.ok(Array.from(text).length <= CAPABILITY_SUMMARY_BUDGET.maxPoints, label + '：码点数不得超上限');
  assert.ok(text.includes(CAPABILITY_SUMMARY_BOUNDARY), label + '：边界句必须保留');
  assert.ok(text.includes('未列出不等于不支持'), label + '：必须说明未列出 ≠ 不支持');
  // 表情那句不论可用与否都要带限定，不能被压成一句「支持」
  assert.ok(text.includes('最终以发送校验为准'), label + '：表情可用性必须带限定');
}

// 未开放的命令不得被宣传成现成功能
const activeAliases = new Set(QUICK_DEFS.filter((d) => d.status === 'active').map((d) => d.aliases[0]));
const disabledOnlyAliases = QUICK_DEFS
  .filter((d) => d.status !== 'active' && d.capability)
  .map((d) => d.aliases[0])
  .filter((alias) => !activeAliases.has(alias));
const text = buildCapabilitySummary({ stickerAvailable: true, searchAvailable: true });
for (const alias of disabledOnlyAliases) {
  assert.ok(!text.includes('!' + alias), '不该出现未开放的命令入口: !' + alias);
}

// 只能经命令调用的能力必须标注「仅命令」，并带上来自命令目录的入口
const commandOnly = CAPABILITY_CATALOG.filter((item) => !item.callable);
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

function promptFor(stickerGroupIds) {
  updateDb((db) => {
    db.settings.selfQq = '900000001';
    db.settings.botNames = 'pippi';
    db.settings.searchProvider = 'disabled';
    db.settings.enableWebSearch = false;
    db.settings.stickerPolicy = {
      mode: 'live', allGroups: false, groupIds: stickerGroupIds,
      groupCooldownSec: 0, userCooldownSec: 0, hourlyLimit: 10, dailyLimit: 20, userDailyLimit: 10,
      duplicateStickerCooldownSec: 0,
    };
    db.groups = [{ groupId: 'cap-group', name: 'fixture', enabled: true, mode: 'natural', cooldownSec: 0, maxPerHour: 20 }];
  });
  const db = readDb();
  const group = db.groups.find((g) => String(g.groupId) === 'cap-group');
  const event = {
    source: 'onebot', type: 'group', messageId: 'cap-1', groupId: 'cap-group',
    userId: '900000002', nickname: 'fixture-user', text: '你好', atTargets: [], images: [], raw: {},
  };
  return buildPrompt(db, group, event, { policy: 'normal', allowCommands: false }, {});
}

const allowed = JSON.stringify(promptFor(['cap-group']));
assert.ok(allowed.includes('【本轮能力】'), '能力摘要必须进入真实提示词');
assert.ok(allowed.includes('本群现在可以发'), '本群开放时摘要应说明可以发');

const denied = JSON.stringify(promptFor([]));
assert.ok(denied.includes('【本轮能力】'), '未开放时摘要仍应存在');
assert.ok(denied.includes('本群现在发不了'), '本群未开放时摘要必须说明发不了');

console.log('capability summary: budget (' + CAPABILITY_SUMMARY_BUDGET.maxLines + ' lines / '
  + CAPABILITY_SUMMARY_BUDGET.maxPoints + ' code points), qualifiers preserved, metadata-derived, injected into real prompt PASS');
