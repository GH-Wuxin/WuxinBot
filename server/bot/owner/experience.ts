// Owner experience/nick/style/me handlers split from server/bot/ownerCommands.ts.
import { readDb, updateDb, nowIso } from '../../store.js';
import {
  getExperience,
  getUnlockedFeatures,
  getLevelInfo,
  levelToPp,
  levelFromXp,
  formatXpBar,
} from '../experience.js';
import { extractAtQq, parseTargetAndRest, llmContentFilter } from '../gate.js';
import { sendForwardText } from '../reply.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerLvHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const targetQq = extractAtQq(ctx.subCommand || ctx.parts[2] || '') || ctx.event.userId;
  const exp = getExperience(db, targetQq);
  const targetUser = (db.users || []).find((u) => String(u.userId) === targetQq);
  const nickname = targetUser?.nickname || targetQq;
  const isSelf = String(targetQq) === String(ctx.event.userId);
  const bar = formatXpBar(exp);
  const features = getUnlockedFeatures(exp.level);
  const lines = [bar];
  if (features.length) lines.push('已解锁: ' + features.join(' · '));
  if (exp.level >= 2) {
    const user = (db.users || []).find((u) => String(u.userId) === targetQq);
    if (user?.customName) lines.push(`称呼: ${user.customName}`);
  }
  const title = isSelf ? '我的等级' : `${nickname} 的等级`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, lines.join('\n'));
  return { replied: Boolean(ctx.sendMessage), reason: title };
}

export async function ownerTopHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const groupId = String(ctx.event.groupId);
  // Collect all users who have experience in this group
  const groupEntries = Object.entries((db.groupExperience as Record<string, any>) || {})
    .filter(([key]) => key.startsWith(groupId + ':'))
    .map(([, v]) => v)
    .sort((a, b) => (b.xpInGroup || 0) - (a.xpInGroup || 0))
    .slice(0, 10);
  if (groupEntries.length === 0) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '还没有人在本群获得经验。');
    return { replied: Boolean(ctx.sendMessage), reason: '排行榜为空' };
  }
  const lines = ['🏆 群经验排行'];
  for (let i = 0; i < groupEntries.length; i++) {
    const ge = groupEntries[i];
    const exp = getExperience(db, ge.userId);
    const info = getLevelInfo(exp.level);
    const user = (db.users || []).find((u) => String(u.userId) === ge.userId);
    const name = user?.customName || user?.nickname || ge.userId;
    const currentPp = levelToPp(exp.level);
    const nextPp = levelToPp(exp.level + 1);
    const progress = Math.min(10, Math.max(0, Math.round(((exp.xp - currentPp) / (nextPp - currentPp)) * 10)));
    const bar = '█'.repeat(progress) + '░'.repeat(10 - progress);
    lines.push(`${i + 1}. ${name}  ${exp.xp} XP ${bar}（${currentPp}pp）`);
  }
  if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, '群经验排行', lines.join('\n'));
  return { replied: Boolean(ctx.sendMessage), reason: '显示排行榜' };
}

export async function ownerNickHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const parsedTarget = parseTargetAndRest(ctx.commandArgs, ctx.event, { allowNumeric: false });
  const targetQq = parsedTarget.targetQq;
  const isTargetOther = targetQq && String(targetQq) !== String(ctx.event.userId);

  if (isTargetOther && !ctx.permissions.isOwner && !ctx.permissions.isAdmin) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '只有管理员可以设置他人的称呼。');
    return { replied: Boolean(ctx.sendMessage), reason: '权限不足' };
  }

  const realTarget = targetQq || ctx.event.userId;
  const exp = getExperience(db, realTarget);
  if (!isTargetOther && exp.level < 2 && !ctx.permissions.isOwner && !ctx.permissions.isAdmin) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `设置称呼需要达到 200pp 等级（Lv.2）。你当前是 ${levelToPp(exp.level)}pp（Lv.${exp.level}）。`);
    return { replied: Boolean(ctx.sendMessage), reason: '等级不足' };
  }

  // Extract the name (after @mention or after /nick)
  let name = '';
  if (targetQq) {
    name = parsedTarget.rest;
  } else {
    name = ctx.commandArgs.trim();
  }

  if (name === 'clear' || name === '清除') {
    updateDb((draft) => {
      const u = (draft.users || []).find((u) => String(u.userId) === realTarget && String(u.groupId) === String(ctx.event.groupId));
      if (u) { u.customName = ''; u.updatedAt = nowIso(); }
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '称呼已清除。');
    return { replied: Boolean(ctx.sendMessage), reason: '清除称呼' };
  }

  if (!name) {
    const user = (db.users || []).find((u) => String(u.userId) === realTarget);
    const current = user?.customName;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, current ? `当前称呼：${current}` : '还未设置称呼。用 /w nick 称呼 来设置。');
    return { replied: Boolean(ctx.sendMessage), reason: '查看称呼' };
  }

  // Content filter: basic safety
  if (name.length > 20 || name.length < 1) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '称呼长度需要 1-20 个字符。');
    return { replied: Boolean(ctx.sendMessage), reason: '称呼长度不合规' };
  }

  // LLM content filter
  const nickFilter = await llmContentFilter(name, '称呼');
  if (!nickFilter.ok) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `内容不合适：${nickFilter.reason}。请换一个。`);
    return { replied: Boolean(ctx.sendMessage), reason: '称呼内容被过滤' };
  }

  updateDb((draft) => {
    if (!draft.users) draft.users = [];
    let u = draft.users.find((u) => String(u.userId) === realTarget && String(u.groupId) === String(ctx.event.groupId));
    if (!u) {
      u = { groupId: String(ctx.event.groupId), userId: String(realTarget), nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, customName: name, createdAt: nowIso(), updatedAt: nowIso() };
      draft.users.push(u);
    } else {
      u.customName = name;
      u.updatedAt = nowIso();
    }
  });
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `称呼已设置为：${name}`);
  return { replied: Boolean(ctx.sendMessage), reason: '设置称呼' };
}

export async function ownerStyleHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const parsedTarget = parseTargetAndRest(ctx.commandArgs, ctx.event, { allowNumeric: false });
  const targetQq = parsedTarget.targetQq;
  const isTargetOther = targetQq && String(targetQq) !== String(ctx.event.userId);

  if (isTargetOther && !ctx.permissions.isOwner && !ctx.permissions.isAdmin) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '只有管理员可以设置他人的交互风格。');
    return { replied: Boolean(ctx.sendMessage), reason: '权限不足' };
  }

  const realTarget = targetQq || ctx.event.userId;
  const exp = getExperience(db, realTarget);
  if (!isTargetOther && exp.level < 3 && !ctx.permissions.isOwner && !ctx.permissions.isAdmin) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `设置个人风格需要达到 300pp 等级（Lv.3）。你当前是 ${levelToPp(exp.level)}pp（Lv.${exp.level}）。`);
    return { replied: Boolean(ctx.sendMessage), reason: '等级不足' };
  }

  let content = '';
  if (targetQq) {
    content = parsedTarget.rest;
  } else {
    content = ctx.commandArgs.trim();
  }

  if (content === 'clear' || content === '清除') {
    updateDb((draft) => {
      const u = (draft.users || []).find((u) => String(u.userId) === realTarget && String(u.groupId) === String(ctx.event.groupId));
      if (u) { u.customStyle = ''; u.updatedAt = nowIso(); }
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '个人风格已清除。');
    return { replied: Boolean(ctx.sendMessage), reason: '清除风格' };
  }

  if (!content) {
    const user = (db.users || []).find((u) => String(u.userId) === realTarget);
    const current = user?.customStyle;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, current ? `当前个人风格：${current}` : '还未设置个人风格。用 /w style 内容 来设置。');
    return { replied: Boolean(ctx.sendMessage), reason: '查看风格' };
  }

  // Content filter: basic safety
  if (content.length > 200) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '个人风格长度上限 200 字。');
    return { replied: Boolean(ctx.sendMessage), reason: '风格内容过长' };
  }

  // LLM content filter
  const styleFilter = await llmContentFilter(content, '交互风格');
  if (!styleFilter.ok) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `内容不合适：${styleFilter.reason}。请修改。`);
    return { replied: Boolean(ctx.sendMessage), reason: '风格内容被过滤' };
  }

  updateDb((draft) => {
    if (!draft.users) draft.users = [];
    let u = draft.users.find((u) => String(u.userId) === realTarget && String(u.groupId) === String(ctx.event.groupId));
    if (!u) {
      u = { groupId: String(ctx.event.groupId), userId: String(realTarget), nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, customStyle: content, createdAt: nowIso(), updatedAt: nowIso() };
      draft.users.push(u);
    } else {
      u.customStyle = content;
      u.updatedAt = nowIso();
    }
  });
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '个人风格已设置。Bot 回复你时会参考这个风格。');
  return { replied: Boolean(ctx.sendMessage), reason: '设置风格' };
}

export async function ownerMeHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const exp = getExperience(db, ctx.event.userId);
  if (exp.level < 1 && !ctx.permissions.isOwner && !ctx.permissions.isAdmin) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `查看画像需要达到 100pp 等级（Lv.1）。你当前是 ${levelToPp(exp.level)}pp（Lv.${exp.level}）。`);
    return { replied: Boolean(ctx.sendMessage), reason: '等级不足' };
  }
  const mem = (db.memories || []).find((m) => String(m.userId) === String(ctx.event.userId));
  if (!mem) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '还没有关于你的画像数据。多聊聊天就有了。');
    return { replied: Boolean(ctx.sendMessage), reason: '无画像' };
  }
  const info = getLevelInfo(exp.level);
  const lines = [
    `📋 Wuxin 眼中的你`,
    `───────────────`,
    mem.summary && `整体：${mem.summary}`,
    mem.traits && `性格：${mem.traits}`,
    mem.speechStyle && `说话：${mem.speechStyle}`,
    mem.behavior && `行为：${mem.behavior}`,
    mem.preferences && `偏好：${mem.preferences}`,
    mem.manualNotes && `备注：${mem.manualNotes}`,
    `───────────────`,
    `${info.emoji} ${info.title} · ${exp.xp} XP · 活跃 ${exp.activeDays} 天`,
  ].filter(Boolean);
  if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, '我的画像', lines.join('\n'));
  return { replied: Boolean(ctx.sendMessage), reason: '查看画像' };
}

export async function ownerExpHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = ctx.commandDb;
  const parsedTarget = parseTargetAndRest(ctx.commandArgs, ctx.event);
  const targetQq = parsedTarget.targetQq;
  if (!targetQq) {
    // Show usage
    const usage = '用法：\n/w exp @某人 · 查看经验详情\n/w exp @某人 add <XP> · 增加XP\n/w exp @某人 set <XP> · 设置XP\n/w exp @某人 reset · 重置为0';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, usage);
    return { replied: Boolean(ctx.sendMessage), reason: 'exp 用法' };
  }
  const exp = getExperience(db, targetQq);
  const info = getLevelInfo(exp.level);
  const user = (db.users || []).find((u) => String(u.userId) === targetQq);
  const nickname = user?.nickname || user?.customName || targetQq;

  // Parse subcommand after @mention
  const action = parsedTarget.rest.trim().toLowerCase();
  const actionParts = action.split(/\s+/);
  const verb = actionParts[0];
  const amount = Number(actionParts[1]);

  if (verb === 'add' && Number.isFinite(amount) && amount > 0) {
    updateDb((draft) => {
      if (!draft.experience) draft.experience = {};
      let e = draft.experience[targetQq];
      if (!e) {
        e = { xp: 0, level: 0, dailyXp: 0, dailyDate: '', activeDays: 0, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
        draft.experience[targetQq] = e;
      }
      e.xp += amount;
      // Re-evaluate level (level N = N*100 XP)
      const newLevel = levelFromXp(e.xp);
      if (newLevel > e.level) { e.level = newLevel; e.lastLevelUpAt = nowIso(); }
    });
    const newExp = getExperience(readDb(), targetQq);
    const newInfo = getLevelInfo(newExp.level);
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `已给 ${nickname} 增加 ${amount} XP → ${newExp.xp} XP（${newInfo.title}）`);
    return { replied: Boolean(ctx.sendMessage), reason: 'exp add' };
  }

  if (verb === 'set' && Number.isFinite(amount) && amount >= 0) {
    updateDb((draft) => {
      if (!draft.experience) draft.experience = {};
      let e = draft.experience[targetQq];
      if (!e) {
        e = { xp: 0, level: 0, dailyXp: 0, dailyDate: '', activeDays: 0, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
        draft.experience[targetQq] = e;
      }
      e.xp = amount;
      e.level = levelFromXp(e.xp);
    });
    const newExp = getExperience(readDb(), targetQq);
    const newInfo = getLevelInfo(newExp.level);
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `已将 ${nickname} 的 XP 设为 ${amount} → ${newInfo.title}`);
    return { replied: Boolean(ctx.sendMessage), reason: 'exp set' };
  }

  if (verb === 'reset') {
    updateDb((draft) => {
      if (draft.experience) delete draft.experience[targetQq];
      if (draft.groupExperience) {
        for (const key of Object.keys(draft.groupExperience)) {
          if (key.endsWith(':' + targetQq)) delete draft.groupExperience[key];
        }
      }
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `已重置 ${nickname} 的全部经验数据。`);
    return { replied: Boolean(ctx.sendMessage), reason: 'exp reset' };
  }

  // Default: show info
  const bar = formatXpBar(exp);
  const features = getUnlockedFeatures(exp.level);
  const lines = [bar];
  if (features.length) lines.push('已解锁: ' + features.join(' · '));
  if (user?.customName) lines.push(`称呼: ${user.customName}`);
  if (user?.customStyle) lines.push(`风格: ${user.customStyle.slice(0, 50)}`);
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, lines.join('\n'));
  return { replied: Boolean(ctx.sendMessage), reason: 'exp 查看' };
}
