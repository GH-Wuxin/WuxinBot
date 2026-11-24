import { startProfileRecalculation } from '../profileRecalculation.js';
// Owner command handlers for /w system commands (why/pause/prompt/refresh/recalc/
// ping/model/search/thinking/sysfacts/summarize). Decomposed from
// server/bot/ownerCommands.ts; permission preambles are handled by dispatch.
import { defaultPrompt, readDb, updateDb, nowIso } from '../../store.js';
import { applyUsageTotals, usageEventFields } from '../../usage.js';
import {
  getRecalcProgress,
  setBotPaused,
} from '../../health.js';
import { completeChat } from '../llm.js';
import { activeModelName, activateModelProfile, activeProviderLabel, updateProviderSettings } from '../../modelConfig.js';
import { sanitizeReply, sendForwardText } from '../reply.js';
import { OWNER_FALLBACK_HELP } from './help.js';
import type { OwnerHandlerContext, OwnerCommandResult } from './types.js';

export async function ownerWhyHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const db = readDb();
  const lastDecision = [...(db.decisions || [])].reverse().find((d) => String(d.groupId) === String(ctx.event.groupId));
  if (!lastDecision) { const reply = '还没有本群的回复决策记录。'; if (ctx.sendMessage) await ctx.sendMessage(ctx.event, reply); return { replied: Boolean(ctx.sendMessage), reason: reply }; }
  const lastMsg = [...(db.messages || [])].reverse().find((m) => String(m.groupId) === String(ctx.event.groupId) && m.role === 'user');
  const rawReply = `最近一条消息：${lastMsg ? `${lastMsg.nickname || lastMsg.userId}：${(lastMsg.content || '').slice(0, 80)}` : '无'}`
    + `\n决策：${lastDecision.shouldReply ? '回复了' : '没有回复'}`
    + `\n原因：${lastDecision.reason}`
    + `\n时间：${lastDecision.createdAt ? new Date(lastDecision.createdAt).toLocaleString('zh-CN') : '未知'}`;
  const reply = sanitizeReply(rawReply, db.settings);
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
  const counts = startProfileRecalculation(ctx.event);
  const state = getRecalcProgress();
  const reply = counts
    ? `已开始全局重算：个人画像 ${counts.memories} 人、群画像 ${counts.groups} 群、关系画像 ${counts.relationships} 对。用 /w recalc 查看进度。`
    : `正在重算中：${state.done}/${state.total}（${state.label}）`;
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

export async function ownerModelHandler(ctx: OwnerHandlerContext): Promise<OwnerCommandResult> {
  const arg = String(ctx.parts[2] || '').trim();
  const currentSettings = readDb().settings;
  const knownModels = currentSettings.llmProvider === 'codex-app-server'
    ? ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']
    : [
        'mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-omni', 'mimo-v2-pro',
        'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'
      ];
  if (!arg || arg === 'show') {
    const db = readDb();
    const credential = db.settings.llmProvider === 'codex-app-server'
      ? '认证：ChatGPT 登录'
      : `API Key：${db.settings.apiKey ? '已配置' : '未配置'}`;
    const reply = `当前模型：${activeModelName(db.settings)}\n接口：${activeProviderLabel(db.settings)}\n${credential}`;
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
    draft.settings = draft.settings.llmProvider === 'codex-app-server'
      ? updateProviderSettings(draft.settings, { codexModel: arg })
      : activateModelProfile(draft.settings, arg);
    switchedSettings = draft.settings;
    draft.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: ctx.event.userId,
      action: '/wuxin model',
      targetUserId: 'bot',
      groupId: ctx.event.groupId,
      detail: `模型切换为 ${activeModelName(draft.settings)}；接口=${activeProviderLabel(draft.settings)}`,
      createdAt: nowIso()
    });
  });
  const missingCredential = switchedSettings?.llmProvider !== 'codex-app-server' && !switchedSettings?.apiKey;
  const reply = `已切换模型：${activeModelName(switchedSettings)}\n接口：${activeProviderLabel(switchedSettings)}${missingCredential ? '\n注意：该接口的 API Key 尚未配置，请到控制台“模型”页填写。' : ''}`;
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
      model: activeModelName(db.settings),
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
      if (!response.usage?.accounted) draft.usage.requests += 1;
      applyUsageTotals(draft.usage, response.usage);
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({
        id: crypto.randomUUID(),
        groupId: ctx.event.groupId,
        userId: ctx.event.userId,
        model: response.model || activeModelName(db.settings),
        provider: response.provider || db.settings.llmProvider,
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
