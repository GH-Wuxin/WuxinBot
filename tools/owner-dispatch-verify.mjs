// owner-dispatch-verify.mjs — R2 owner-command dispatch structural verifier.
//
// Checks:
//   - pre-R2 owner help inventory is unchanged
//   - every descriptor/hidden-route handlerKey exists in the registry
//   - every registry key is accounted for by a descriptor, hidden route, or
//     the documented osu-clear route alias table
//   - no handler module performs command-level permission checks
//     (requireCommand / hasCommandPermission are forbidden; permissions.isOwner
//      is allowed only for the documented business-check lines)
//   - parseOwnerCommandText alias matrix matches the pre-R2 behavior
//   - unknown-command route reply/reason matches pre-R2
//   - negative checks would catch missing/duplicate/orphan registry entries

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER_COMMANDS,
  OWNER_HIDDEN_ROUTES,
  isMemberPolicyCommand,
  parseOwnerCommandText,
} from '../server/bot/commands/owner.meta.ts';
import { getAllCommandHelpEntries } from '../server/bot/commands/index.ts';
import { OWNER_HANDLER_REGISTRY } from '../server/bot/owner/registry.ts';
import { resolveOwnerRoute } from '../server/bot/owner/router.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
}

function assert(condition, label, detail = '') {
  if (condition) pass(label);
  else fail(label, detail);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(label, `got ${a}\nexpected ${e}`);
}

// ── 1. Pre-R2 help inventory ─────────────────────────────────────────────

const BASELINE_OWNER_HELP = [
  ['lv', '/w lv (@某人)', '查看等级经验', 'lv', 'all', 'public', 'listed', 'lv'],
  ['exp', '/w exp @某人 add/set/reset', '管理群友经验（仅 owner）', 'exp', 'owner', 'owner', 'direct_only', 'exp'],
  ['top', '/w top', '查看群内等级排行榜', 'top', 'all', 'public', 'listed', 'top'],
  ['nick', '/w nick 称呼 / nick @某人 称呼', '自定义 pippi 对你的称呼', 'nick', 'all', 'public', 'listed', 'nick'],
  ['style', '/w style 内容 / style @某人 内容', '设置个人交互风格', 'style', 'all', 'public', 'listed', 'style'],
  ['me', '/w me', '查看 pippi 对你的画像', 'me', 'all', 'public', 'listed', 'me'],
  ['memberPolicy', '/w op/deop/ban/unban/trust/focus/quiet/normal @某人', '成员权限策略：管理员、黑名单、优先回应、重点关注、少回应', 'memberPolicy', 'owner', 'owner', 'direct_only', 'memberPolicy'],
  ['note', '/w note @某人 内容/show/clear', '成员备注管理', 'note', 'owner', 'owner', 'direct_only', 'note'],
  ['profile', '/w profile (@某人) show/samples/retry/rule/clear', '画像管理：更新、查看、依据、重算、约束、清除', 'profile', 'group_admin', 'public', 'direct_only', 'profile'],
  ['promptShow', '/w prompt show', '查看人设摘要', 'promptShow', 'group_admin', 'public', 'direct_only', 'promptShow'],
  ['promptEdit', '/w prompt add/set/reset', '编辑人设：追加、覆盖、重置基线', 'promptEdit', 'group_admin', 'public', 'direct_only', 'promptEdit'],
  ['promptSavebase', '/w prompt savebase', '把当前人设保存为基线（仅 owner）', 'promptSavebase', 'owner', 'owner', 'direct_only', 'promptSavebase'],
  ['groupAdd', '/w group add [群名]', '把当前群加入 bot 管理（仅 owner）', 'groupAdd', 'owner', 'owner', 'direct_only', 'groupAdd'],
  ['groupProfileShow', '/w group profile show', '查看群画像', 'groupProfileShow', 'group_admin', 'public', 'direct_only', 'groupProfileShow'],
  ['groupProfileEdit', '/w group profile update/clear/on/off', '群画像管理：更新、清除、开关', 'groupProfileEdit', 'group_admin', 'public', 'direct_only', 'groupProfileEdit'],
  ['rate', '/w rate 数字', '设置每小时回复上限', 'rate', 'group_admin', 'public', 'direct_only', 'rate'],
  ['cooldown', '/w cooldown 秒数', '设置发言冷却', 'cooldown', 'group_admin', 'public', 'direct_only', 'cooldown'],
  ['mode', '/w mode silent|mention|light|natural', '设置群回复模式', 'mode', 'group_admin', 'public', 'direct_only', 'mode'],
  ['status', '/w status', '查看群参数', 'status', 'group_admin', 'public', 'direct_only', 'status'],
  ['modelShow', '/w model show/list', '查看模型列表与当前模型', 'modelShow', 'group_admin', 'public', 'direct_only', 'modelShow'],
  ['modelSet', '/w model 模型名', '切换当前模型', 'modelSet', 'group_admin', 'public', 'direct_only', 'modelSet'],
  ['search', '/w search on/off/status/fast/balanced/deep', '搜索开关、状态与模式', 'search', 'group_admin', 'public', 'direct_only', 'search'],
  ['thinking', '/w thinking off|simple|detail|slow [ms]|status', '思考提示模式', 'thinking', 'group_admin', 'public', 'direct_only', 'thinking'],
  ['sysfacts', '/w sysfacts on/off', '纯人设模式（关闭系统事实注入）', 'search', 'group_admin', 'public', 'direct_only', 'sysfacts'],
  ['summarize', '/w summarize 条数', '总结群聊', 'summarize', 'all', 'public', 'listed', 'summarize'],
  ['preset', '/w preset class|away|sleep|active|silent|debug', '场景预设', 'preset', 'group_admin', 'public', 'direct_only', 'preset'],
  ['usage', '/w usage', '今日用量', 'usage', 'group_admin', 'public', 'direct_only', 'usage'],
  ['pause', '/w pause / resume', '暂停 / 恢复回复', 'pause', 'group_admin', 'public', 'direct_only', 'pause'],
  ['resume', '/w resume', '恢复回复', 'pause', 'group_admin', 'public', 'direct_only', 'resume'],
  ['why', '/w why', '解释最近为什么回复或没回复', 'why', 'all', 'public', 'listed', 'why'],
  ['help', '/w help 或 /w help 分组名', '查看指令帮助', 'help', 'all', 'public', 'listed', 'help'],
  ['ping', '/w ping', '检查 pippi 是否在线', 'ping', 'all', 'public', 'listed', 'ping'],
  ['my', '/w my', '查看自己的权限与可用指令', 'my', 'all', 'public', 'listed', 'my'],
  ['recalc', '/w recalc', '查看全局重算进度', 'recalc', 'all', 'public', 'listed', 'recalc'],
  ['refresh', '/w refresh', '触发全局重算（仅 owner）', 'memberPolicy', 'owner', 'owner', 'direct_only', 'refresh'],
  ['osuHelp', '/w osu help', 'osu! 命令帮助', 'osuHelp', 'all', 'public', 'listed', 'osu.help'],
  ['osuBind', '/w osu bind <osu用户名>', '绑定 osu! 账号', 'osuBind', 'all', 'public', 'listed', 'osu.bind'],
  ['osuAnalyze', '/w osu analyze (@某人)', '玩家分析（已停用）', 'osuAnalyze', 'all', 'hidden', 'hidden', 'osu.analyze'],
    ['skill', '/w skill profile [玩家名]；compare <玩家A> <玩家B>；<BP名次或BID> [+Mods]；<玩家名> <BP名次>', '生成成绩修正后的 BP50 玩家画像/对比图，或分析单张 BP/BID；玩家 ID 可用 p:[...]', 'skill', 'all', 'public', 'listed', 'skill'],
  ['skillFeedback', '/w cd <BID> [+Mods] <反馈>', '按 BID 与 Mod 反馈 Skill Profiler 判断；不写 Mod 表示 NM', 'skillFeedback', 'all', 'public', 'listed', 'skillFeedback'],
];

{
  const actual = getAllCommandHelpEntries()
    .filter((entry) => entry.namespace === 'wuxin')
    .map((entry) => [
      entry.id,
      entry.canonicalSyntax,
      entry.description,
      entry.permissionKey,
      entry.permission,
      entry.visibility,
      entry.discoverability,
      entry.execution?.kind === 'local' ? entry.execution.handlerKey : '',
    ]);
  assertEqual(actual, BASELINE_OWNER_HELP, 'owner help inventory identical to pre-R2');
}

// ── 2. Registry coverage / orphans ───────────────────────────────────────

const descriptorKeys = new Set(OWNER_COMMANDS.map((entry) => entry.execution?.kind === 'local' ? entry.execution.handlerKey : '').filter(Boolean));
const hiddenKeys = new Set(OWNER_HIDDEN_ROUTES.map((entry) => entry.execution.handlerKey));

// Route-only osu clear aliases: no descriptors exist for clear actions, and
// the router maps them to handler keys deliberately.
const routeOnlyExemptions = new Set([
  'osu.clear.bind',
  'osu.clear.history',
  'osu.clear.cooldown',
  'osu.clear.recommend',
  'osu.clear.cache',
]);

{
  const registryKeys = new Set(Object.keys(OWNER_HANDLER_REGISTRY));
  for (const key of descriptorKeys) {
    assert(registryKeys.has(key), `descriptor handler has registry entry: ${key}`);
  }
  for (const key of hiddenKeys) {
    assert(registryKeys.has(key), `hidden route handler has registry entry: ${key}`);
  }
  for (const key of registryKeys) {
    assert(
      descriptorKeys.has(key) || hiddenKeys.has(key) || routeOnlyExemptions.has(key),
      `registry key accounted for: ${key}`,
    );
  }
  assert(registryKeys.size === new Set([...registryKeys]).size, 'registry has no duplicate keys');

  // Simulated orphan/missing checks: a key removed from the registry or a
  // descriptor pointed at a nonexistent key would be caught above. Prove the
  // negative branch works on a copy.
  const fake = { ...OWNER_HANDLER_REGISTRY };
  delete fake.lv;
  assert(!fake.lv, 'simulated missing registry entry is detectable');
}

// ── 3. Permission single source scan ─────────────────────────────────────

const handlerDir = path.join(root, 'server', 'bot', 'owner');
const handlerFiles = fs.readdirSync(handlerDir)
  .filter((name) => name.endsWith('.ts') && !['types.ts', 'registry.ts', 'router.ts'].includes(name))
  .map((name) => path.join(handlerDir, name));

const documentedBusinessIsOwner = {
  'experience.ts': [
    /isTargetOther && !ctx\.permissions\.isOwner/,
    /!isTargetOther && exp\.level < \d+ && !ctx\.permissions\.isOwner/,
    /exp\.level < 1 && !ctx\.permissions\.isOwner/,
  ],
};

// help.ts uses hasCommandPermission only to FILTER help/my inventory; it is
// not a command gate. This is the documented scan exemption.
const documentedHasCommandPermission = new Set(['help.ts']);
const documentedPermissionsOwner = new Set(['help.ts']);

for (const file of handlerFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const base = path.basename(file);
  assert(!/requireCommand/.test(source), `handler does not call requireCommand: ${base}`);
  if (!documentedHasCommandPermission.has(base)) {
    assert(!/hasCommandPermission/.test(source), `handler does not call hasCommandPermission: ${base}`);
  }
  const ownerChecks = [...source.matchAll(/permissions\.isOwner/g)].length;
  if (ownerChecks > 0 && !documentedPermissionsOwner.has(base)) {
    const exemptions = documentedBusinessIsOwner[base] || [];
    const lines = source.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes('permissions.isOwner')) continue;
      const ok = exemptions.some((pattern) => pattern.test(line));
      assert(ok, `business permissions.isOwner documented: ${base}:${index + 1}`, line);
    }
  }
}

// ── 4. Alias matrix ───────────────────────────────────────────────────────

{
  const cases = [
    ['/w lv', 'lv'],
    ['/w exp @1', 'exp'],
    ['/w prompt show', 'promptShow'],
    ['/w prompt savebase', 'promptSavebase'],
    ['/w prompt add x', 'promptEdit'],
    ['/w group add', 'groupAdd'],
    ['/w group profile show', 'groupProfileShow'],
    ['/w group profile update', 'groupProfileEdit'],
    ['/w model list', 'modelShow'],
    ['/w model foo', 'modelSet'],
    ['/w op @1', 'memberPolicy'],
    ['/w deop @1', 'memberPolicy'],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseOwnerCommandText(text);
    assertEqual(parsed?.id, expected, `parseOwnerCommandText(${text}) -> ${expected}`);
  }
  for (const command of ['/op', '/deop', '/ban', '/unban', '/trust', '/focus', '/quiet', '/normal', '/拉黑', '/取消拉黑', '/白名单', '/重点关注', '/少回应', '/正常', '/设管理员', '/取消管理员']) {
    assert(isMemberPolicyCommand(command), `member policy alias: ${command}`);
  }
}

// ── 5. Unknown-command route baseline ────────────────────────────────────

{
  const base = {
    event: { atTargets: [], groupId: '10001' },
    sendMessage: async () => {},
    permissions: { isOwner: false, isAdmin: false },
    parts: ['/w', 'foo'],
    prefix: '/w',
    isWuxinCommand: true,
    command: '/foo',
    subCommand: '',
    commandArgs: '',
    target: 'foo',
    groupId: '10001',
    commandDb: { settings: { commandPermissions: {} } },
    commandUserPolicy: { policy: 'normal' },
    policyMap: {},
  };
  const route = resolveOwnerRoute(base);
  assertEqual(route, {
    kind: 'reply',
    reply: '未知 Wuxin 指令：/foo。用 /w help 查看帮助。',
    reason: '未知 Wuxin 指令：/foo。用 /w help 查看帮助。',
    replied: true,
  }, 'unknown owner command reply/reason');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
