/**
 * Skill 家族文本工具：格式与工具面。
 *
 * 不联网、不调分析器，只验证两件事：
 *   1. 四个技能工具真的出现在 V2 工具面上，参数与描述正确；
 *   2. 文本格式化能在真实 payload 形状上产出可读、可核对的内容。
 */
import assert from 'node:assert/strict';
import {
  formatPlayerSkillText,
  formatRecentSkillText,
  formatSkillCompareText,
} from '../server/bots/skillToolText.ts';
import { buildBotToolSchemas } from '../server/bots/registry.ts';

const playerPayload = {
  player: { username: 'Pippi', pp: 8231.4, globalRank: 12340, countryRank: 45, accuracy: 98.2 },
  sample: {
    requested: 50, valid: 48, failed: 2, averageScoreQuality: 0.831,
    modCounts: [{ mods: 'HD', count: 21 }, { mods: 'HR', count: 8 }],
  },
  profile: {
    profileTier: 'EXPERT', profileTitle: '跳跃型', primaryAxes: ['跳跃瞄准', '流动瞄准'],
    axes: [
      { key: 'jump_aim', label: '跳跃瞄准', ceiling: 8.4, median: 7.1 },
      { key: 'flow_aim', label: '流动瞄准', ceiling: 6.2, median: 5.8 },
    ],
  },
};

const text = formatPlayerSkillText(playerPayload);
assert.match(text, /Pippi/);
assert.match(text, /PP 8,231/);
assert.match(text, /全球 #12,340/);
assert.match(text, /EXPERT/);
assert.match(text, /跳跃瞄准：8\.4，中位 7\.1/);
assert.match(text, /HD×21/);
assert.match(text, /有效 48\/50/);

const recent = formatRecentSkillText({
  player: { username: 'Pippi' },
  sample: { fetched: 128, inWindow: 96, groups: 42, completed: 40, skipped: 2, days: 5 },
  profile: { axes: [{ key: 'jump_aim', label: '跳跃瞄准', ceiling: 7.7, median: 6.9 }] },
});
assert.match(recent, /最近 5 天/);
assert.match(recent, /成绩 128 条/);
assert.match(recent, /跳跃瞄准：7\.7/);

const compare = formatSkillCompareText(
  { player: { username: 'A' }, profile: { axes: [{ label: '跳跃瞄准', ceiling: 8.4 }, { label: '流动瞄准', ceiling: 5.0 }] } },
  { player: { username: 'B' }, profile: { axes: [{ label: '跳跃瞄准', ceiling: 6.0 }, { label: '流动瞄准', ceiling: 6.4 }] } },
);
assert.match(compare, /A vs B/);
assert.match(compare, /\+2\.4/);
assert.match(compare, /-1\.4/);
assert.match(compare, /A 更强：跳跃瞄准/);
assert.match(compare, /B 更强：流动瞄准/);

const registry = { updatedAt: '', bots: [{ id: 'yumu', name: '雨沐', channel: 'internal', enabled: true, commands: [] }] };
const tools = buildBotToolSchemas(registry, { surface: 'v2' });
const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
for (const name of ['osu_beatmap_skill', 'osu_player_skill', 'osu_recent_skill', 'osu_compare_skill']) {
  assert.ok(byName.has(name), 'missing tool: ' + name);
}
const compareTool = byName.get('osu_compare_skill');
assert.deepEqual(Object.keys(compareTool.function.parameters.properties), ['left', 'right']);
assert.deepEqual(compareTool.function.parameters.required, ['left', 'right']);
const beatmapSkill = byName.get('osu_beatmap_skill');
assert.deepEqual(Object.keys(beatmapSkill.function.parameters.properties), ['username', 'bp_rank', 'beatmap_id', 'mods']);
assert.ok(!beatmapSkill.function.parameters.required, 'BP 名次与 BID 二选一，不能强制必填');

for (const name of ['osu_beatmap_skill', 'osu_player_skill', 'osu_recent_skill', 'osu_compare_skill']) {
  const description = String(byName.get(name).function.description || '');
  assert.ok(description.length > 40, name + ' 描述太短，模型没有足够信息判断何时调用');
  assert.ok(!description.includes('只读工具；需要实时或精确数据时调用'), name + ' 仍在用模板描述');
}

console.log('skill text tools: formatting + tool surface PASS');
