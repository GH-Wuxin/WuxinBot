// Owner command handlers for /w system commands (why/pause/prompt/refresh/recalc/
// ping/usage/model/search/thinking/sysfacts/summarize). Decomposed from
// server/bot/ownerCommands.ts; permission preambles are handled by dispatch.
import { defaultPrompt, readDb, updateDb, nowIso } from '../../store.js';
import { applyUsageTotals, usageEventFields } from '../../usage.js';
import {
  getRecalcProgress,
  startRecalc,
  tickRecalc,
  finishRecalc,
  setBotPaused,
} from '../../health.js';
import { maybeUpdateMemoryProfile } from '../memory.js';
import { updateGroupProfile } from '../groupProfile.js';
import { updateRelationshipProfile } from '../relationshipProfile.js';
import { completeChat } from '../llm.js';
import {
  sumUsageSince,
  startOfLocalDayTime,
  getPricing,
  calcCost,
} from '../prompt.js';
import { activateModelProfile, activeProviderLabel } from '../../modelConfig.js';
import { isSearchAvailable, getLastSearchStatus } from '../search.js';
import { sendForwardText } from '../reply.js';
import { OWNER_FALLBACK_HELP } from './help.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerWhyHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = readDb();
  const lastDecision = [...(db.decisions || [])].reverse().find((d) => String(d.groupId) === String(ctx.event.groupId));
  if (!lastDecision) { const reply = '还没有本群的回复决策记录。'; if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply); return { replied: Boolean(ctx.sendMessage), reason: reply }; }
  const lastMsg = [...(db.messages || [])].reverse().find((m) => String(m.groupId) === String(ctx.event.groupId) && m.role === 'user');
  const reply = `最近一条消息：${lastMsg ? `${lastMsg.nickname || lastMsg.userId}：${(lastMsg.content || '').slice(0, 80)}` : '无'}`
    + `\n决策：${lastDecision.shouldReply ? '回复了' : '没有回复'}`
    + `\n原因：${lastDecision.reason}`
    + `\n时间：${lastDecision.createdAt ? new Date(lastDecision.createdAt).toLocaleString('zh-CN') : '未知'}`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerPauseHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const pausing = ctx.command === '/pause';
  updateDb((draft) => {
    draft.settings.globalPaused = pausing;
    setBotPaused(pausing);
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: ctx.event.userId,
      action: `/wuxin ${ctx.command.slice(1)}`,
      targetUserId: 'bot',
      groupId: ctx.event.groupId,
      detail: pausing ? '暂停机器人' : '恢复机器人',
      createdAt: nowIso()
    });
  });
  const reply = pausing ? '已暂停，不再自动回复。用 /w resume 恢复。' : '已恢复，正常参与群聊。';
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerPromptHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const promptText = ctx.parts.slice(3).join(' ').trim();
  if (ctx.subCommand === 'show') {
    const db = readDb();
    const prompt = db.settings.personalityPrompt || '';
    const reply = `当前完整提示词：\n${prompt}`;
    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 当前提示词', reply);
    return { replied: Boolean(ctx.sendMessage), reason: '显示完整提示词' };
  }

  if (ctx.subCommand === 'reset') {
    updateDb((draft) => {
      draft.settings.personalityPrompt = draft.settings.baselinePersonalityPrompt || defaultPrompt;
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: '/wuxin prompt reset',
        targetUserId: 'bot',
        groupId: ctx.event.groupId,
        detail: '重置提示词',
        createdAt: nowIso()
      });
    });
    const reply = '已重置提示词。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if (ctx.subCommand === 'savebase') {
    updateDb((draft) => {
      draft.settings.baselinePersonalityPrompt = draft.settings.personalityPrompt || defaultPrompt;
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: '/wuxin prompt savebase',
        targetUserId: 'bot',
        groupId: ctx.event.groupId,
        detail: '保存当前提示词为 reset 基线',
        createdAt: nowIso()
      });
    });
    const reply = '已把当前提示词保存为 reset 基线。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if ((ctx.subCommand === 'add' || ctx.subCommand === 'set') && !promptText) {
    const reply = '用法：/wuxin prompt add 内容，或 /wuxin prompt set 内容';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if (ctx.subCommand === 'add' || ctx.subCommand === 'set') {
    updateDb((draft) => {
      draft.settings.personalityPrompt = ctx.subCommand === 'set'
        ? promptText
        : `${draft.settings.personalityPrompt || ''}\n\n${promptText}`.trim();
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: `/wuxin prompt ${ctx.subCommand}`,
        targetUserId: 'bot',
        groupId: ctx.event.groupId,
        detail: promptText.slice(0, 240),
        createdAt: nowIso()
      });
    });
    const reply = ctx.subCommand === 'set' ? '已覆盖提示词。' : '已追加提示词规则。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, OWNER_FALLBACK_HELP);
  return { replied: Boolean(ctx.sendMessage), reason: '未知 prompt 指令' };
}

export async function ownerRefreshHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const state = getRecalcProgress();
  if (state.running) { const reply = `正在重算中：${state.done}/${state.total}（${state.label}）`; if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply); return { replied: Boolean(ctx.sendMessage), reason: reply }; }
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, '正在重算全部画像，稍候…');
  const db = readDb();
  const mems = (db.memories || []).filter((m) => m.enabled && (m.samples || []).filter((s) => s.usedForProfile).length >= 3);
  const gps = (db.groups || []).filter((g) => g.enabled);
  const rels = (db.relationshipProfiles || []).filter((r) => r.enabled !== false);
  const total = mems.length + gps.length + rels.length;
  startRecalc(total, 'QQ端重算');
  let pCount = 0, gCount = 0, rCount = 0;
  for (const mem of mems) {
    if (getRecalcProgress().stopped) break;
    try {
      const outcome = await maybeUpdateMemoryProfile({
        ...ctx.event,
        userId: String(mem.userId),
        nickname: mem.nickname || String(mem.userId),
        messageId: `${ctx.event.messageId || 'memory-recalc'}:${mem.userId}`,
      }, { force: true, kind: 'memory-recalc' });
      if (outcome.ok) pCount++;
    } catch { /* skip */ }
    tickRecalc();
  }
  for (const g of gps) {
    if (getRecalcProgress().stopped) break;
    try { const r = await updateGroupProfile(readDb(), g.groupId); if (r.ok) gCount++; } catch { /* skip */ }
    tickRecalc();
  }
  for (const rp of rels) {
    if (getRecalcProgress().stopped) break;
    try {
      const r = await updateRelationshipProfile(readDb(), rp.groupId, rp.userA, rp.userB);
      if (r?.ok !== false && !r?.skipped) rCount++;
    } catch { /* skip */ }
    tickRecalc();
  }
  finishRecalc(getRecalcProgress().stopped ? 'QQ端已停止' : 'QQ端全部重算完成');
  const reply = getRecalcProgress().stopped
    ? `重算已停止。完成：个人${pCount}/群${gCount}/关系${rCount}`
    : `全部重算完成。\n个人画像：${pCount} 人\n群聊画像：${gCount} 群\n关系画像：${rCount} 对`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerRecalcHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const state = getRecalcProgress();
  if (!state.running) { const reply = '当前没有正在进行的重算。'; if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply); return { replied: Boolean(ctx.sendMessage), reason: reply }; }
  const pct = state.total > 0 ? Math.round(state.done / state.total * 100) : 0;
  const bar = '█'.repeat(pct / 10) + '░'.repeat(10 - pct / 10);
  const reply = `${state.label}\n[${bar}] ${pct}%\n${state.done}/${state.total} 已完成`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerPingHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const reply = 'pong，我在。';
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerUsageHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = readDb();
  const today = sumUsageSince(db, startOfLocalDayTime());

  // Calculate today's cost from usageEvents (per-model accurate)
  const todayStart = startOfLocalDayTime();
  const todayByModel: Record<string, { prompt: number; completion: number; requests: number }> = {};
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

  const reply = `今日用量：
请求：${today.requests} 次 | Token：${today.totalTokens}
输入：${today.promptTokens} | 输出：${today.completionTokens}
${costLines.length > 0 ? `费用明细：\n${costLines.join('\n')}\n今日合计：¥${totalCost.toFixed(4)}` : '今日暂无费用明细'}
---
累计：${db.usage.totalTokens || 0} Token（约 ¥${allTimeCost.toFixed(2)}）
累计请求：${db.usage.requests || 0} 次`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: '显示今日 token 用量' };
}

export async function ownerModelHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const arg = String(ctx.parts[2] || '').trim();
  const knownModels = [
    'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-omni', 'mimo-v2-pro',
    'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'
  ];
  if (!arg || arg === 'show') {
    const db = readDb();
    const reply = `当前模型：${db.settings.model}\n接口：${activeProviderLabel(db.settings)}\nAPI Key：${db.settings.apiKey ? '已配置' : '未配置'}`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: '显示当前模型' };
  }
  if (arg === 'list') {
    const reply = `可选模型：
${knownModels.join('\n')}
也可以直接填写当前接口支持的自定义模型名。`;
    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, 'Wuxin 模型列表', reply);
    return { replied: Boolean(ctx.sendMessage), reason: '显示模型列表' };
  }

  let switchedSettings;
  updateDb((draft) => {
    draft.settings = activateModelProfile(draft.settings, arg);
    switchedSettings = draft.settings;
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: ctx.event.userId,
      action: '/wuxin model',
      targetUserId: 'bot',
      groupId: ctx.event.groupId,
      detail: `模型切换为 ${arg}；接口=${activeProviderLabel(draft.settings)}`,
      createdAt: nowIso()
    });
  });
  const reply = `已切换模型：${arg}\n接口：${activeProviderLabel(switchedSettings)}${switchedSettings?.apiKey ? '' : '\n注意：该接口的 API Key 尚未配置，请到控制台“模型”页填写。'}`;
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerSearchHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const arg = (ctx.parts[2] || '').toLowerCase();
  if (arg === 'on' || arg === 'off') {
    updateDb((draft) => {
      draft.settings.enableWebSearch = arg === 'on';
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: `/wuxin search ${arg}`,
        targetUserId: 'bot',
        groupId: ctx.event.groupId,
        detail: `联网搜索${arg === 'on' ? '开启' : '关闭'}`,
        createdAt: nowIso()
      });
    });
    const reply = `已${arg === 'on' ? '开启' : '关闭'}联网搜索。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if (arg === 'status') {
    const db = readDb();
    const statusLine = db.settings.enableWebSearch ? '已开启' : '已关闭';
    const searchAvailable = isSearchAvailable(db);
    const lastSearch = getLastSearchStatus(db);
    const searchInfo = searchAvailable
      ? `真实搜索源：${db.settings.searchProvider} (${db.settings.searchBaseUrl})`
      : '未接入真实搜索源，显式搜索会拒绝（避免瞎编）';
    const lastLine = lastSearch
      ? `最近搜索：${lastSearch.resultCount}条结果 · ${lastSearch.latencyMs}ms${lastSearch.error ? ' · 错误：' + lastSearch.error : ''}`
      : '暂无搜索记录';
    const reply = `联网搜索：${statusLine}，模式：${db.settings.webSearchMode || 'balanced'}。${searchInfo}。${lastLine}。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  if (['fast', 'balanced', 'deep'].includes(arg)) {
    updateDb((draft) => {
      draft.settings.enableWebSearch = true;
      draft.settings.webSearchMode = arg;
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: `/wuxin search ${arg}`,
        targetUserId: 'bot',
        groupId: ctx.event.groupId,
        detail: `联网搜索模式切换为 ${arg}`,
        createdAt: nowIso()
      });
    });
    const reply = `已设置联网搜索模式为 ${arg}，并已开启搜索。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  const reply = '用法：/w search on|off|status|fast|balanced|deep';
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerThinkingHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const arg = (ctx.parts[2] || '').toLowerCase();
  if (arg === 'off' || arg === 'simple' || arg === 'detail') {
    updateDb((draft) => { draft.settings.thinkingNoticeMode = arg; });
    const labels = { off: '已关闭思考提示', simple: '已设为简短提示（正在思考…）', detail: '已设为详细提示（含模型名）' };
    const reply = labels[arg] || `已设为 ${arg} 模式`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  if (arg === 'slow') {
    const delayMs = parseInt(ctx.parts[3], 10);
    const delay = Number.isFinite(delayMs) && delayMs >= 500 ? delayMs : 3000;
    updateDb((draft) => { draft.settings.thinkingNoticeMode = 'slow'; draft.settings.thinkingNoticeDelayMs = delay; });
    const reply = `已设为慢请求提示模式，${delay}ms 内未回复才提示"正在思考…"。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  if (arg === 'status') {
    const db = readDb();
    const mode = db.settings.thinkingNoticeMode || 'slow';
    const delay = db.settings.thinkingNoticeDelayMs || 3000;
    const labels = { off: '关闭', simple: '简短提示', detail: '详细提示（含模型名）', slow: `慢请求提示（${delay}ms 延迟）` };
    const reply = `思考提示：${labels[mode] || mode}`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  const reply = '用法：/w thinking off|simple|detail|slow [毫秒]|status。默认 slow 3000ms。例如 /w thinking slow 5000';
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerSysfactsHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const arg = (ctx.parts[2] || '').toLowerCase();
  if (arg === 'on' || arg === 'off') {
    updateDb((draft) => { draft.settings.ignoreSystemFacts = arg === 'on'; });
    const reply = arg === 'on' ? '已开启纯人设模式，底层系统信息不再注入。' : '已关闭纯人设模式，底层系统信息恢复注入。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  if (arg === 'status') {
    const db = readDb();
    const reply = `纯人设模式：${db.settings.ignoreSystemFacts ? '已开启（底层信息不注入）' : '已关闭（底层信息正常注入）'}。`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }
  const reply = '用法：/w sysfacts on|off|status';
  if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
  return { replied: Boolean(ctx.sendMessage), reason: reply };
}

export async function ownerSummarizeHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const countArg = parseInt(ctx.parts[2], 10);
  const N = Number.isFinite(countArg) && countArg >= 5 ? countArg : 50;

  if (N < 5 || N > 500) {
    const reply = '总结消息条数范围：5-500。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  const db = readDb();
  const groupMessages = (db.messages || [])
    .filter((m) => String(m.groupId) === String(ctx.event.groupId))
    .filter((m) => m.content && m.content.trim())
    .slice(-N);

  if (groupMessages.length < 5) {
    const reply = '这个群的聊天记录还太少（至少需要 5 条有内容的发言），没法总结。';
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    return { replied: Boolean(ctx.sendMessage), reason: reply };
  }

  const formatted = groupMessages.map((m) => {
    const time = new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const name = m.nickname || m.userId || '未知';
    return `[${time}] ${name}：${m.content}`;
  }).join('\n');

  const summaryPrompt = `请用简洁中文总结以下 ${groupMessages.length} 条 QQ 群聊消息，用 2-5 条要点概括主要话题和讨论内容。不要提及具体 QQ 号，用"有人/群友"代替。`;

  try {
    const response = await completeChat(db, {
      model: db.settings.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是群聊总结助手，用中文输出。' },
        { role: 'user', content: `${summaryPrompt}\n\n${formatted}` }
      ],
      temperature: 0.3,
      maxTokens: 500,
      timeoutMs: 45_000,
      label: '群聊总结'
    });

    const summary = response.text || '无法生成总结。';

    updateDb((draft) => {
      draft.usage.requests += 1;
      applyUsageTotals(draft.usage, response.usage);
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({
        id: crypto.randomUUID(),
        groupId: ctx.event.groupId,
        userId: ctx.event.userId,
        model: db.settings.model,
        ...usageEventFields(response.usage),
        createdAt: nowIso()
      });
      draft.adminActions.push({
        id: crypto.randomUUID(),
        operatorUserId: ctx.event.userId,
        action: `/wuxin summarize ${N}`,
        targetUserId: 'group',
        groupId: ctx.event.groupId,
        detail: `总结 ${groupMessages.length} 条消息`,
        createdAt: nowIso()
      });
    });

    if (ctx.sendMessage) await sendForwardText(ctx.sendMessage, ctx.event, `群聊总结 (${groupMessages.length}条)`, summary);
    return { replied: Boolean(ctx.sendMessage), text: summary, reason: `总结 ${groupMessages.length} 条消息` };
  } catch (error) {
    const reply = `总结失败：${error.message}`;
    if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply);
    updateDb((draft) => {
      draft.usage.errors += 1;
    });
    return { replied: Boolean(ctx.sendMessage), error: error.message, reason: reply };
  }
}
