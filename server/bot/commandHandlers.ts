// Individual command handlers extracted from the runOwnerCommand if-else chain.
// Each handler: async (ctx) => { replied, text?, reason? }
// The ctx object carries: event, sendMessage, permissions, commandDb, requireCommand,
// parts, subCommand, target, groupId, policyMap

import { readDb, updateDb, nowIso, defaultPrompt } from '../store.js';
import { describePolicy, describeModel, getPricing, calcCost, sumUsageSince, startOfLocalDayTime } from './prompt.js';
import { sendForwardText } from './reply.js';
import OpenAI from 'openai';

export function buildHelpText() {
  return `Wuxin 指令：
/wuxin op @某人 或 /wuxin op QQ号 - 设为管理员
/wuxin deop @某人 - 取消管理员
/wuxin ban @某人 - 不回应
/wuxin unban @某人 - 解除黑名单
/wuxin trust @某人 - 优先回应
/wuxin focus @某人 - 重点关注
/wuxin quiet @某人 - 少回应
/wuxin normal @某人 - 恢复正常
/wuxin note @某人 内容 - 设置成员备注
/wuxin note show @某人 - 查看成员备注
/wuxin note clear @某人 - 清除成员备注
/wuxin prompt show - 查看当前提示词摘要
/wuxin prompt add 内容 - 追加提示词规则
/wuxin prompt set 内容 - 覆盖提示词
/wuxin prompt reset - 重置提示词
/wuxin prompt savebase - 把当前提示词保存为 reset 基线
/wuxin rate 数字 - 设置本群每小时最多回复次数
/wuxin cooldown 秒数 - 设置本群发言冷却
/wuxin mode silent/mention/light/natural - 设置本群回复模式
/wuxin status - 查看本群运行参数
/wuxin model show/list/模型名 - 查看或切换模型
/wuxin search on|off - 开关联网搜索
/wuxin search status - 查看搜索状态
/wuxin search fast|balanced|deep - 设置搜索模式
/wuxin summarize 条数 - 总结最近群聊（默认50，100+需要管理员）
/wuxin usage - 查看今日 token
/wuxin ping - 检查在线
/wuxin help - 查看这段帮助
具体谁能用哪条指令，以控制台"权限"页为准。
也可以把 /wuxin 简写为 /w`;
}

export async function cmdHelp(ctx) {
  if (!(await ctx.requireCommand('help'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
  if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 指令帮助', buildHelpText());
  return { replied: Boolean(ctx.sendMessage), reason: '显示 owner 指令帮助' };
}

export async function cmdPrompt(ctx, promptAction, promptText) {
  if (promptAction === 'show') {
    if (!(await ctx.requireCommand('promptShow'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    const db = readDb();
    const prompt = db.settings.personalityPrompt || '';
    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 当前提示词', `当前完整提示词：\n${prompt}`);
    return { replied: Boolean(ctx.sendMessage), reason: '显示完整提示词' };
  }
  if (promptAction === 'reset') {
    if (!(await ctx.requireCommand('promptEdit'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    updateDb((draft) => {
      draft.settings.personalityPrompt = draft.settings.baselinePersonalityPrompt || defaultPrompt;
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: '/wuxin prompt reset', targetUserId: 'bot', groupId: ctx.event.groupId, detail: '重置提示词', createdAt: nowIso() });
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '已重置提示词。');
    return { replied: Boolean(ctx.sendMessage), reason: '已重置提示词。' };
  }
  if (promptAction === 'savebase') {
    if (!(await ctx.requireCommand('promptSavebase'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    updateDb((draft) => {
      draft.settings.baselinePersonalityPrompt = draft.settings.personalityPrompt || defaultPrompt;
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: '/wuxin prompt savebase', targetUserId: 'bot', groupId: ctx.event.groupId, detail: '保存当前提示词为 reset 基线', createdAt: nowIso() });
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '已把当前提示词保存为 reset 基线。');
    return { replied: Boolean(ctx.sendMessage), reason: '已把当前提示词保存为 reset 基线。' };
  }
  if ((promptAction === 'add' || promptAction === 'set') && !promptText) {
    if (!(await ctx.requireCommand('promptEdit'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '用法：/wuxin prompt add 内容，或 /wuxin prompt set 内容');
    return { replied: Boolean(ctx.sendMessage), reason: '用法提示' };
  }
  if (promptAction === 'add' || promptAction === 'set') {
    if (!(await ctx.requireCommand('promptEdit'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    updateDb((draft) => {
      draft.settings.personalityPrompt = promptAction === 'set' ? promptText : `${draft.settings.personalityPrompt || ''}\n\n${promptText}`.trim();
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin prompt ${promptAction}`, targetUserId: 'bot', groupId: ctx.event.groupId, detail: promptText.slice(0, 240), createdAt: nowIso() });
    });
    const reply = promptAction === 'set' ? '已覆盖提示词。' : '已追加提示词规则。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  return null; // unknown prompt subcommand, fall through to help
}

export async function cmdSearch(ctx, arg) {
  if (!(await ctx.requireCommand('search'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
  if (arg === 'on' || arg === 'off') {
    updateDb((draft) => {
      draft.settings.enableWebSearch = arg === 'on';
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin search ${arg}`, targetUserId: 'bot', groupId: ctx.event.groupId, detail: `联网搜索${arg === 'on' ? '开启' : '关闭'}`, createdAt: nowIso() });
    });
    const reply = `已${arg === 'on' ? '开启' : '关闭'}联网搜索。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  if (arg === 'status') {
    const db = readDb();
    const reply = `联网搜索：${db.settings.enableWebSearch ? '已开启' : '已关闭'}，模式：${db.settings.webSearchMode || 'balanced'}，当前模型：${db.settings.model || '未设置'}。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  if (['fast', 'balanced', 'deep'].includes(arg)) {
    updateDb((draft) => {
      draft.settings.enableWebSearch = true;
      draft.settings.webSearchMode = arg;
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin search ${arg}`, targetUserId: 'bot', groupId: ctx.event.groupId, detail: `联网搜索模式切换为 ${arg}`, createdAt: nowIso() });
    });
    const reply = `已设置联网搜索模式为 ${arg}，并已开启搜索。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  return null; // unknown arg
}

export async function cmdSummarize(ctx, N) {
  if (N < 5 || N > 500) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '总结消息条数范围：5-500。');
    return { replied: Boolean(ctx.sendMessage), reason: '总结范围不符' };
  }
  const permKey = N >= 100 ? 'summarizeLarge' : 'summarize';
  if (!(await ctx.requireCommand(permKey))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };

  const db = readDb();
  const groupMessages = (db.messages || [])
    .filter((m) => String(m.groupId) === String(ctx.event.groupId))
    .filter((m) => m.content && m.content.trim())
    .slice(-N);

  if (groupMessages.length < 5) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '这个群的聊天记录还太少（至少需要 5 条有内容的发言），没法总结。');
    return { replied: Boolean(ctx.sendMessage), reason: '消息太少' };
  }

  const formatted = groupMessages.map((m) => {
    const time = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const name = m.nickname || m.userId || '未知';
    return `[${time}] ${name}：${m.content}`;
  }).join('\n');

  try {
    const client = new OpenAI({ apiKey: db.settings.apiKey, baseURL: db.settings.apiBaseUrl || 'https://api.deepseek.com' });
    const response = await client.chat.completions.create({
      model: db.settings.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是群聊总结助手，用中文输出。' },
        { role: 'user', content: `请用简洁中文总结以下 ${groupMessages.length} 条 QQ 群聊消息，用 2-5 条要点概括主要话题和讨论内容。不要提及具体 QQ 号，用"有人/群友"代替。\n\n${formatted}` }
      ],
      temperature: 0.3, max_tokens: 500
    });
    const summary = response.choices?.[0]?.message?.content?.trim() || '无法生成总结。';
    updateDb((draft) => {
      draft.usage.requests += 1;
      draft.usage.totalTokens += response.usage?.total_tokens || 0;
      draft.usage.promptTokens += response.usage?.prompt_tokens || 0;
      draft.usage.completionTokens += response.usage?.completion_tokens || 0;
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({ id: crypto.randomUUID(), groupId: ctx.event.groupId, userId: ctx.event.userId, model: db.settings.model, totalTokens: response.usage?.total_tokens || 0, promptTokens: response.usage?.prompt_tokens || 0, completionTokens: response.usage?.completion_tokens || 0, createdAt: nowIso() });
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin summarize ${N}`, targetUserId: 'group', groupId: ctx.event.groupId, detail: `总结 ${groupMessages.length} 条消息`, createdAt: nowIso() });
    });
    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, `群聊总结 (${groupMessages.length}条)`, summary);
    return { replied: Boolean(ctx.sendMessage), text: summary, reason: `总结 ${groupMessages.length} 条消息` };
  } catch (error) {
    const reply = `总结失败：${error.message}`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    updateDb((draft) => { draft.usage.errors += 1; });
    return { replied: Boolean(ctx.sendMessage), error: error.message, reason: reply };
  }
}

export async function cmdRateCooldownModeStatus(ctx, command, value) {
  const permKey = { '/rate': 'rate', '/cooldown': 'cooldown', '/mode': 'mode', '/status': 'status' }[command];
  if (!(await ctx.requireCommand(permKey))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
  const db = readDb();
  // getGroup is in bot.ts - we access it via the ctx
  if (command === '/status') {
    const modeName = { silent: '静默', mention: '只在 @ 时回复', light: '轻度参与', natural: '自然群友' };
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `本群参数：\n模式：${modeName[ctx.group?.mode] || ctx.group?.mode}\n每小时最多回复：${ctx.group?.maxPerHour}\n发言冷却：${ctx.group?.cooldownSec} 秒`);
    return { replied: Boolean(ctx.sendMessage), reason: '显示群运行参数' };
  }
  let reply = '';
  updateDb((draft) => {
    const group = draft.groups.find((entry) => String(entry.groupId) === String(ctx.event.groupId));
    if (!group) return;
    if (command === '/rate') {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 1 || v > 200) { reply = '用法：/wuxin rate 20。范围 1 到 200。'; return; }
      group.maxPerHour = Math.round(v);
      reply = `已设置本群每小时最多回复 ${group.maxPerHour} 次。`;
    }
    if (command === '/cooldown') {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > 600) { reply = '用法：/wuxin cooldown 30。范围 0 到 600 秒。'; return; }
      group.cooldownSec = Math.round(v);
      reply = `已设置本群发言冷却 ${group.cooldownSec} 秒。`;
    }
    if (command === '/mode') {
      const allowed = ['silent', 'mention', 'light', 'natural'];
      if (!allowed.includes(String(value || '').toLowerCase())) { reply = '用法：/wuxin mode silent|mention|light|natural。'; return; }
      group.mode = String(value || '').toLowerCase();
      reply = `已设置本群回复模式为 ${group.mode}。`;
    }
    group.updatedAt = nowIso();
    draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin ${command.slice(1)}`, targetUserId: 'group', groupId: ctx.event.groupId, detail: reply, createdAt: nowIso() });
  });
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply || '设置失败，请检查指令格式。');
  return { replied: Boolean(ctx.sendMessage), reason: reply || '群运行参数设置失败' };
}

export async function cmdPingUsageModel(ctx, command, arg) {
  if (command === '/ping') {
    if (!(await ctx.requireCommand('ping'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, 'pong，我在。');
    return { replied: Boolean(ctx.sendMessage), reason: 'pong' };
  }
  if (command === '/usage') {
    if (!(await ctx.requireCommand('usage'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    const db = readDb();
    const today = sumUsageSince(db, startOfLocalDayTime());
    const todayStart = startOfLocalDayTime();
    const todayByModel = {};
    for (const e of (db.usageEvents || [])) {
      if (new Date(e.createdAt).getTime() < todayStart) continue;
      const m = e.model || 'unknown';
      if (!todayByModel[m]) todayByModel[m] = { prompt: 0, completion: 0, requests: 0 };
      todayByModel[m].prompt += e.promptTokens || 0;
      todayByModel[m].completion += e.completionTokens || 0;
      todayByModel[m].requests += 1;
    }
    const costLines = [];
    let totalCost = 0;
    for (const [m, data] of Object.entries(todayByModel)) {
      const p = getPricing(m);
      const cost = calcCost(data.prompt, data.completion, p);
      totalCost += cost;
      costLines.push(`${p.label}：¥${cost.toFixed(4)}（${data.requests}次）`);
    }
    const allTimeP = getPricing(db.settings.model);
    const allTimeCost = calcCost(db.usage.promptTokens || 0, db.usage.completionTokens || 0, allTimeP);
    const reply = `今日用量：\n请求：${today.requests} 次 | Token：${today.totalTokens}\n输入：${today.promptTokens} | 输出：${today.completionTokens}\n${costLines.length > 0 ? `费用明细：\n${costLines.join('\n')}\n今日合计：¥${totalCost.toFixed(4)}` : '今日暂无费用明细'}\n---\n累计：${db.usage.totalTokens || 0} Token（约 ¥${allTimeCost.toFixed(2)}）\n累计请求：${db.usage.requests || 0} 次`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: '显示今日 token 用量' };
  }
  if (command === '/model') {
    const knownModels = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
    if (!arg || arg === 'show') {
      if (!(await ctx.requireCommand('modelShow'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
      const db = readDb();
      if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `当前模型：${db.settings.model}`);
      return { replied: Boolean(ctx.sendMessage), reason: '显示当前模型' };
    }
    if (arg === 'list') {
      if (!(await ctx.requireCommand('modelShow'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
      if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 模型列表', `可选模型：\n${knownModels.join('\n')}\n也可以直接填写 DeepSeek 支持的自定义模型名。`);
      return { replied: Boolean(ctx.sendMessage), reason: '显示模型列表' };
    }
    if (!(await ctx.requireCommand('modelSet'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
    updateDb((draft) => {
      draft.settings.model = arg;
      draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: '/wuxin model', targetUserId: 'bot', groupId: ctx.event.groupId, detail: `模型切换为 ${arg}`, createdAt: nowIso() });
    });
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, `已切换模型：${arg}`);
    return { replied: Boolean(ctx.sendMessage), reason: `已切换模型：${arg}` };
  }
  return null;
}

export async function cmdNote(ctx, action, noteTarget, noteText) {
  if (!(await ctx.requireCommand('note'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
  if (!noteTarget) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '用法：/wuxin note @某人 内容，/wuxin note show @某人，/wuxin note clear @某人');
    return { replied: Boolean(ctx.sendMessage), reason: '缺少目标' };
  }
  if (action === 'show') {
    const db = readDb();
    const user = db.users.find((entry) => String(entry.groupId) === String(ctx.event.groupId) && String(entry.userId) === String(noteTarget));
    const reply = user?.note ? `${noteTarget} 的备注：${user.note}` : `${noteTarget} 还没有备注。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  const nextNote = action === 'clear' ? '' : noteText;
  if (action !== 'clear' && !nextNote) {
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '备注内容不能为空。用法：/wuxin note @某人 内容');
    return { replied: Boolean(ctx.sendMessage), reason: '备注为空' };
  }
  updateDb((draft) => {
    const idx = draft.users.findIndex((user) => String(user.groupId) === String(ctx.event.groupId) && String(user.userId) === String(noteTarget));
    if (idx >= 0) draft.users[idx] = { ...draft.users[idx], note: nextNote, updatedAt: nowIso() };
    else draft.users.push({ id: crypto.randomUUID(), groupId: ctx.event.groupId, userId: noteTarget, nickname: noteTarget, policy: 'normal', attentionLevel: 3, allowCommands: false, note: nextNote, createdAt: nowIso(), updatedAt: nowIso() });
    draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: `/wuxin note ${action || 'set'}`, targetUserId: noteTarget, groupId: ctx.event.groupId, detail: nextNote || '清除备注', createdAt: nowIso() });
  });
  const reply = action === 'clear' ? `已清除 ${noteTarget} 的备注。` : `已给 ${noteTarget} 设置备注。`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function cmdMemberPolicy(ctx, command, target, groupId) {
  if (!(await ctx.requireCommand('memberPolicy'))) return { replied: Boolean(ctx.sendMessage), reason: 'denied' };
  if (!target) {
    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 指令帮助', buildHelpText());
    return { replied: Boolean(ctx.sendMessage), reason: '缺少目标' };
  }
  updateDb((draft) => {
    const existingIndex = draft.users.findIndex((user) => String(user.groupId) === String(groupId) && String(user.userId) === String(target));
    const policyMap = { '/op': 'admin', '/deop': 'normal', '/ban': 'blocked', '/unban': 'normal', '/trust': 'whitelist', '/focus': 'priority', '/quiet': 'muted', '/normal': 'normal' };
    const entry = { groupId, userId: target, nickname: target, policy: policyMap[command], attentionLevel: policyMap[command] === 'priority' ? 5 : 3, allowCommands: policyMap[command] === 'admin' };
    if (existingIndex >= 0) draft.users[existingIndex] = { ...draft.users[existingIndex], ...entry, updatedAt: nowIso() };
    else draft.users.push({ ...entry, id: crypto.randomUUID(), createdAt: nowIso(), updatedAt: nowIso() });
    draft.adminActions.push({ id: crypto.randomUUID(), operatorUserId: ctx.event.userId, action: command, targetUserId: target, groupId, detail: `设置为 ${policyMap[command]}`, createdAt: nowIso() });
  });
  const policyMap = { '/op': 'admin', '/deop': 'normal', '/ban': 'blocked', '/unban': 'normal', '/trust': 'whitelist', '/focus': 'priority', '/quiet': 'muted', '/normal': 'normal' };
  const reply = `已把 ${target} 设置为 ${describePolicy(policyMap[command])}。`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}
