// /w osu commands: binding, help and shared cache maintenance.

import { readDb, updateDb } from '../store.js';
import { withSticker } from '../bot/stickers/index.js';
import { syncLazybotBinding, removeLazybotBinding } from '../bots/bindingSync.js';
import { OSU_SUBCOMMANDS, OSU_CLEAR_ACTIONS_META, type OsuClearActionId, type OsuCommandId } from '../bot/commands/osu.meta.js';
import { OWNER_COMMANDS } from '../bot/commands/owner.meta.js';
import { canViewCommand, canListCommand, type CommandPermissions } from '../bot/commands/index.js';

/**
 * Normalize every osuBindings format that has existed in Wuxin's database.
 *
 * Legacy databases stored a numeric user id or a username directly. Newer
 * bindings store both as an object. Keeping this normalization at the command
 * boundary prevents an object binding from becoming "[object Object]" in an
 * osu! API request.
 */
export function resolveOsuBindingValue(binding: any): string | number | null {
  if (typeof binding === 'number' && Number.isFinite(binding) && binding > 0) {
    return binding;
  }
  if (typeof binding === 'string') {
    const value = binding.trim();
    if (!value) return null;
    return /^\d+$/.test(value) ? Number(value) : value;
  }
  if (binding && typeof binding === 'object') {
    const id = Number(binding.osuUserId ?? binding.userId ?? binding.id ?? 0);
    if (Number.isFinite(id) && id > 0) return id;
    const username = String(binding.osuUsername ?? binding.username ?? '').trim();
    if (username) return username;
  }
  return null;
}

interface OsuCommandContext {
  event: any;
  sendMessage: any;
  permissions: any;
  subCommand: string;
  args: string;
  subFree: string;
}

type OsuHandler = (ctx: OsuCommandContext) => Promise<{ replied?: boolean; reason?: string; text?: string; error?: string }>;

async function handleOsuBind(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree } = ctx;
  const username = String(subFree || '').trim();
  if (!username) {
    if (sendMessage) await sendMessage(event, '用法：/w osu bind <osu用户名>');
    return { replied: true, reason: 'osu bind 缺用户名' };
  }
  let userId: number;
  try {
    const { getUser } = await import('./api.js');
    const user = await getUser(username);
    userId = user.id;
  } catch (error) {
    const msg = `osu! 用户 "${username}" 查不到。`;
    // 查无此人 —— 属于「查无数据」，附 no_data（不是服务故障）。
    if (sendMessage) await sendMessage(event, withSticker(msg, 'no_data'));
    return { replied: true, reason: msg };
  }
  updateDb((draft) => {
    draft.osuBindings = draft.osuBindings || {};
    draft.osuBindings[String(event.userId)] = { id: userId, username };
  });
  // Unified binding: mirror into LazyBot's token table so /ppp & friends
  // work without a separate /link. Non-fatal when the sync is unavailable.
  const syncResult = await syncLazybotBinding(event.userId, { id: userId, username });
  if (!syncResult.ok && !syncResult.skipped) {
    console.error(`[bind] LazyBot 绑定同步失败: ${syncResult.error || '未知错误'}`);
  }
  const msg = `已将 QQ 绑定到 osu! ${username}（ID: ${userId}）。`;
  // 绑定成功：附 bound 表情。图由代码触发，不依赖 LLM。
  if (sendMessage) await sendMessage(event, withSticker(msg, 'bound'));
  return { replied: true, reason: msg };
}

async function handleClearBind(ctx: OsuCommandContext) {
  const { event, sendMessage } = ctx;
  // A binding is a long-lived association (it is also synced to LazyBot), so a
  // bare /w osu clear bind must not silently drop it. Require "confirm".
  const confirmed = /(?:^|\s)confirm(?:\s|$)/i.test(String(ctx.subFree || '').toLowerCase());
  if (!confirmed) {
    const current = readDb().osuBindings?.[String(event.userId)];
    const reply = current
      ? `解绑会删除你与 osu! 玩家「${current.username}」的绑定（并同步到 LazyBot），操作不可撤销。\n确认请发送：/w osu clear bind confirm`
      : '你当前没有 osu! 绑定。';
    if (sendMessage) await sendMessage(event, reply);
    return { replied: true, reason: reply };
  }
  updateDb((draft) => {
    draft.osuBindings = draft.osuBindings || {};
    delete draft.osuBindings[String(event.userId)];
  });
  const syncResult = await removeLazybotBinding(event.userId);
  if (!syncResult.ok && !syncResult.skipped) {
    console.error(`[bind] LazyBot 解绑同步失败: ${syncResult.error || '未知错误'}`);
  }
  if (sendMessage) await sendMessage(event, '已删除你的 osu! 绑定。');
  return { replied: true, reason: 'osu clear bind' };
}

async function handleClearCooldown(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions, subFree } = ctx;
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear cooldown 非 owner' };
  }
  const targetArg = String(subFree || '').replace(/^cooldown\s*/, '').trim();
  if (!targetArg) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear cooldown <osu用户名或ID>');
    return { replied: true, reason: 'osu clear cooldown 缺目标' };
  }
  const needleId = /^\d+$/.test(targetArg) ? Number(targetArg) : 0;
  let recommendOsuId = needleId;
  if (!recommendOsuId) {
    try {
      const { getUser } = await import('./api.js');
      recommendOsuId = (await getUser(targetArg)).id;
    } catch {
      // Name resolution failed; recommend cooldown stays untouched.
    }
  }
  let removedRecommend = 0;
  updateDb((draft) => {
    if (recommendOsuId > 0 && draft.osuRecommendCooldowns?.[String(recommendOsuId)] !== undefined) {
      delete draft.osuRecommendCooldowns[String(recommendOsuId)];
      removedRecommend = 1;
    }
  });
  const reply = `已清除 ${targetArg} 的冷却（推图 ${removedRecommend} 条）。推图防重复历史保留。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: true, reason: reply };
}

async function handleClearRecommend(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions, subFree } = ctx;
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear recommend 非 owner' };
  }
  const targetArg = String(subFree || '').replace(/^recommend\s*/, '').trim();
  if (!targetArg) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear recommend <osu用户名或ID>');
    return { replied: true, reason: 'osu clear recommend 缺目标' };
  }
  let recommendOsuId = /^\d+$/.test(targetArg) ? Number(targetArg) : 0;
  if (!recommendOsuId) {
    try {
      const { getUser } = await import('./api.js');
      recommendOsuId = (await getUser(targetArg)).id;
    } catch {
      if (sendMessage) await sendMessage(event, `找不到 osu! 用户 "${targetArg}"，无法清除推图历史。`);
      return { replied: true, reason: 'osu clear recommend 找不到目标' };
    }
  }
  const { clearRecommendHistory } = await import('./recommender.js');
  const removed = clearRecommendHistory(recommendOsuId);
  const reply = `已清除 ${targetArg} 的推图历史（防重复记录 ${removed} 条，冷却已重置）。`;
  if (sendMessage) await sendMessage(event, reply);
  return { replied: true, reason: reply };
}

async function handleClearCache(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions } = ctx;
  // Global BP-type cache wipe affects every user: owner
  // only. Permission is checked before any mutation.
  if (!permissions?.isOwner) {
    if (sendMessage) await sendMessage(event, '该操作仅限 owner。');
    return { replied: true, reason: 'osu clear cache 非 owner' };
  }
  updateDb((draft) => {
    draft.osuTypeAnalyses = [];
  });
  if (sendMessage) await sendMessage(event, '已清除所有玩家的 BP 类型分析缓存。');
  return { replied: true, reason: 'osu clear cache' };
}

const CLEAR_ACTIONS = {
  bind: handleClearBind,
  cooldown: handleClearCooldown,
  recommend: handleClearRecommend,
  cache: handleClearCache,
} satisfies Record<OsuClearActionId, OsuHandler>;

async function handleOsuClear(ctx: OsuCommandContext) {
  const { event, sendMessage, subFree } = ctx;
  const action = String(subFree || '').trim();
  // Strict parsing: no fuzzy correction. `clear caches` / `clear cache xxx`
  // and bare `clear` all land in the usage path without executing anything.
  // The single exception is `bind confirm`: unbinding drops a long-lived
  // association, so it needs an explicit second word (see handleClearBind).
  const key: OsuClearActionId | null = action === 'bind' || action === 'bind confirm' ? 'bind'
    : action === 'cache' ? 'cache'
    : action === 'cooldown' || action.startsWith('cooldown ') ? 'cooldown'
    : action === 'recommend' || action.startsWith('recommend ') ? 'recommend'
    : null;
  if (!key) {
    if (sendMessage) await sendMessage(event, '用法：/w osu clear bind（删除绑定）/ /w osu clear cooldown <玩家>（取消指定玩家冷却，仅 owner）/ /w osu clear recommend <玩家>（清除指定玩家推图历史，仅 owner）/ /w osu clear cache（清除全部缓存，仅 owner）');
    return { replied: true, reason: 'osu clear 缺参数' };
  }
  return CLEAR_ACTIONS[key](ctx);
}

function renderOsuHelp(permissions: any): string {
  const perms: CommandPermissions = {
    isOwner: Boolean(permissions?.isOwner),
    isAdmin: Boolean(permissions?.isAdmin),
  };
  const lines = ['osu! 命令：'];
  for (const sub of Object.values(OSU_SUBCOMMANDS)) {
    if (!canViewCommand(sub.visibility, perms)) continue;
    if (sub.id === 'clear') {
      for (const action of Object.values(OSU_CLEAR_ACTIONS_META)) {
        if (!canViewCommand(action.visibility, perms)) continue;
        if (!canListCommand(action.visibility, action.discoverability, action.permission, perms)) continue;
        lines.push(`${action.syntax} — ${action.description}`);
      }
      continue;
    }
    lines.push(`${sub.syntax} — ${sub.description}`);
  }
  const skill = OWNER_COMMANDS.find((entry) => entry.id === 'skill');
  const info = OWNER_COMMANDS.find((entry) => entry.id === 'info');
  const update = OWNER_COMMANDS.find((entry) => entry.id === 'osuUpdate');
  const feedback = OWNER_COMMANDS.find((entry) => entry.id === 'skillFeedback');
  if (info && canListCommand(info.visibility, info.discoverability, info.permission, perms)) {
    lines.push(`${info.syntax} — ${info.description}`);
  }
  if (update && canListCommand(update.visibility, update.discoverability, update.permission, perms)) {
    lines.push(`${update.syntax} — ${update.description}`);
  }
  if (skill && canListCommand(skill.visibility, skill.discoverability, skill.permission, perms)) {
    lines.push('/w skill compare <玩家A> <玩家B> — 空格分隔；玩家名含空格时用 p:[玩家ID]');
    lines.push('/w skill <BP名次或BID> [+Mods] — 分析自己或指定玩家的单张 BP/BID');
  }
  if (feedback && canListCommand(feedback.visibility, feedback.discoverability, feedback.permission, perms)) {
    lines.push(`${feedback.syntax} — ${feedback.description}`);
  }
  return lines.join('\n');
}

async function handleOsuHelp(ctx: OsuCommandContext) {
  const { event, sendMessage, permissions } = ctx;
  if (sendMessage) await sendMessage(event, renderOsuHelp(permissions));
  return { replied: true, reason: 'osu help' };
}

const OSU_HANDLERS = {
  bind: handleOsuBind,
  clear: handleOsuClear,
  help: handleOsuHelp,
} satisfies Record<OsuCommandId, OsuHandler>;

export async function handleOsuCommand(
  event: any,
  sendMessage: any,
  permissions: any,
  subCommand: string,
  args: string,
) {
  const sub = String(subCommand || 'help').toLowerCase();
  const subFree = String(args || '').startsWith(sub + ' ') ? String(args).slice(sub.length + 1)
    : String(args || '') === sub ? '' : String(args || '');
  const handler = OSU_HANDLERS[sub as OsuCommandId];
  if (!handler) {
    if (sendMessage) await sendMessage(event, `未知 osu 子命令：${subCommand}`);
    return { replied: true, reason: `未知 osu 子命令: ${subCommand}` };
  }
  return handler({ event, sendMessage, permissions, subCommand: sub, args, subFree });
}
