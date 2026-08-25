// Owner help handlers split from server/bot/ownerCommands.ts.
import {
  getAllCommandHelpEntries,
  canListCommand,
  type CommandHelpEntry,
} from '../commands/index.js';
import {
  userCommandRoleId,
  commandRoleName,
  commandRoleLevel,
  hasCommandPermission,
} from '../commands.js';
import { sendForwardText } from '../reply.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export const OWNER_FALLBACK_HELP = `Wuxin 指令 · 都可以简写为 /w

【成员管理】
/w op @某人 · 设为管理员
/w deop @某人 · 取消管理员
/w ban @某人 · 拉黑不回应
/w unban @某人 · 解除黑名单
/w trust @某人 · 优先回应
/w focus @某人 · 重点关注
/w quiet @某人 · 少回应
/w normal @某人 · 恢复正常

【备注与画像】
/w note @某人 内容 · 设置备注
/w note show @某人 · 查看备注
/w note clear @某人 · 清除备注
/w profile @某人 · 更新画像
/w profile show @某人 · 查看画像
/w profile samples @某人 · 画像依据
/w profile retry @某人 方向 · 按指定方向重算画像
/w profile rule @某人 规则 · 画像约束
/w profile clear @某人 · 清除画像

【人设】
/w prompt show · 查看人设摘要
/w prompt add 内容 · 追加人设
/w prompt set 内容 · 覆盖人设
/w prompt reset · 重置为基线
/w prompt savebase · 保存为基线(仅owner)

【群聊设置】
/w group add [群名] · 加群(仅owner)
/w group profile show · 查看群画像
/w group profile update · 更新群画像
/w group profile clear · 清除群画像
/w rate 数字 · 每小时回复上限
/w cooldown 秒数 · 发言冷却
/w mode silent|mention|light|natural · 回复模式
/w status · 查看群参数

【模型与搜索】
/w model 模型名 · 切换模型
/w model list · 模型列表
/w search on|off · 开关搜索
/w search status · 搜索状态
/w search fast|balanced|deep · 搜索模式
/w thinking off|simple|detail|slow [ms]|status · 思考提示
/w sysfacts on|off · 纯人设模式
/w summarize 条数 · 总结群聊

【osu!】
/w skill profile [玩家名] · 用成绩质量与名次衰减后的真实 BP50 生成玩家 Skill 雷达画像
/w skill compare <玩家A> | <玩家B> · 生成两名玩家的 BP50 Skill 对比图
/w skill <BP名次或BID> [+Mods] · 指定玩家：<玩家名> <BP名次>；纯数字名用 p:[玩家名]
/w cd <BID> [+Mods] <反馈> · 按谱面和 Mod 提交分析异议；不写 Mod 表示 NM

【系统】
/w preset class|away|sleep|active|silent|debug · 场景预设
/w usage · 今日用量
/w pause · 暂停
/w resume · 恢复
/w why · 最近为什么回/没回
/w my · 我的权限
/w refresh · 全局重算(仅owner)
/w recalc · 重算进度
/w ping · 检查在线
/w help · 本帮助 | /w help 成员|人设|群聊|系统 分组查看

具体权限以控制台”权限”页为准。`;

// Single source: command metadata (commands/index.ts). Runtime filtering
// still honors db.settings.commandPermissions overrides via permissionKey.
export function ownerHelpEntries(): CommandHelpEntry[] {
  return getAllCommandHelpEntries().filter((entry) => entry.namespace === 'wuxin');
}

const entryLine = (entry: CommandHelpEntry) => `${entry.canonicalSyntax} · ${entry.description}`;

export function entryAllowed(db, userPolicy, perms, entry: CommandHelpEntry): boolean {
  return hasCommandPermission(db, userPolicy, perms, entry.permissionKey || entry.id)
    && canListCommand(entry.visibility, entry.discoverability, entry.permission, {
      isOwner: Boolean(perms.isOwner),
      isAdmin: Boolean(perms.isAdmin),
    });
}

export function buildOwnerHelpText(db, userPolicy, perms): string {
  const allowed = ownerHelpEntries().filter((d) => entryAllowed(db, userPolicy, perms, d));
  const byGroup: Record<string, string[]> = {};
  for (const d of allowed) {
    const group = d.group || '其他';
    if (!byGroup[group]) byGroup[group] = [];
    const line = entryLine(d);
    if (!byGroup[group].includes(line)) byGroup[group].push(line);
  }
  const lines = ['Wuxin 指令 · 都可以简写为 /w · 以下是你有权限的指令'];
  for (const [group, cmds] of Object.entries(byGroup)) {
    lines.push(`\n【${group}】`);
    for (const cmd of cmds) lines.push(cmd);
  }
  lines.push('\n具体权限以控制台"权限"页为准。');
  return lines.join('\n');
}

export async function ownerHelpHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const groupFilter = ctx.subCommand;
  let text = buildOwnerHelpText(ctx.commandDb, ctx.commandUserPolicy, ctx.permissions);
  if (groupFilter) {
    const allGroups = text.split('\n\n');
    const matched = allGroups.filter((g) => g.includes(`【${groupFilter}】`));
    if (matched.length) text = matched.join('\n\n') + '\n\n具体权限以控制台"权限"页为准。';
  }
  if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 指令帮助', text);
  return { replied: Boolean(ctx.sendMessage), reason: '显示指令帮助' };
}

export async function ownerMyHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const userRoleId = userCommandRoleId(db, ctx.commandUserPolicy, { isOwner: ctx.permissions.isOwner, isAdmin: ctx.permissions.isAdmin });
  const roleName = commandRoleName(db, userRoleId);
  const roleLevel = commandRoleLevel(db, userRoleId);
  const entries = ownerHelpEntries();
  const allowed = entries.filter((p) => entryAllowed(db, ctx.commandUserPolicy, ctx.permissions, p));
  const denied = entries.filter((p) => !entryAllowed(db, ctx.commandUserPolicy, ctx.permissions, p));
  const byGroup: Record<string, string[]> = {};
  for (const p of allowed) {
    const group = p.group || '其他';
    if (!byGroup[group]) byGroup[group] = [];
    const line = '  ' + entryLine(p);
    if (!byGroup[group].includes(line)) byGroup[group].push(line);
  }
  const lines = [`你的身份：${roleName}（等级 ${roleLevel}）`, `QQ：${ctx.event.userId}`, '', '—— 可用指令 ——'];
  for (const [group, cmds] of Object.entries(byGroup)) { lines.push(`\n【${group}】`); lines.push(...cmds); }
  if (denied.length > 0) { lines.push('\n—— 无权限 ——'); for (const p of denied) lines.push('  ' + entryLine(p) + '（需更高权限）'); }
  if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, '我的权限', lines.join('\n'));
  return { replied: Boolean(ctx.sendMessage), reason: `显示 ${ctx.event.userId} 权限` };
}
