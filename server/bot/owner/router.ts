// Pure route resolution for owner-command dispatch.
// It decides handlerKey + exact permission key for every /w branch, including
// the historical quirks (preset denies with `mode`, group add owner text, etc).
import {
  isMemberPolicyCommand,
} from '../commands/owner.meta.js';
import type { OwnerHandlerContext, OwnerHandlerKey } from './types.js';

export type OwnerRouteResolution =
  | {
      kind: 'handler';
      handlerKey: OwnerHandlerKey;
      permissionKey?: string;
      denyReplyKey?: string;
    }
  | {
      kind: 'reply';
      reply?: string;
      reason: string;
      replied: boolean;
    };

const POLICY_COMMAND_PATHS = new Set([
  '/op', '/deop', '/ban', '/unban', '/trust', '/focus', '/quiet', '/normal',
  '/拉黑', '/取消拉黑', '/白名单', '/重点关注', '/少回应', '/正常', '/设管理员', '/取消管理员',
]);

function denyRoute(permissionKey: string, handlerKey?: OwnerHandlerKey, denyReplyKey?: string): OwnerRouteResolution {
  return { kind: 'handler', handlerKey: handlerKey || (permissionKey as OwnerHandlerKey), permissionKey, denyReplyKey };
}

function directRoute(handlerKey: OwnerHandlerKey, permissionKey?: string, denyReplyKey?: string): OwnerRouteResolution {
  return { kind: 'handler', handlerKey, permissionKey, denyReplyKey };
}

export function resolveOwnerRoute(ctx: OwnerHandlerContext): OwnerRouteResolution {
  const { command, isWuxinCommand, subCommand, parts, commandArgs, permissions, commandUserPolicy, target } = ctx;

  if (command === '/help' && !isWuxinCommand) {
    return { kind: 'reply', replied: false, reason: '忽略裸 /help，避免和其他 bot 冲突' };
  }

  if (command === '/help') return directRoute('help', 'help');
  if (command === '/my') return { kind: 'handler', handlerKey: 'my' };
  if (command === '/lv') return { kind: 'handler', handlerKey: 'lv' };
  if (command === '/top') return { kind: 'handler', handlerKey: 'top' };
  if (command === '/nick') return { kind: 'handler', handlerKey: 'nick' };
  if (command === '/style') return { kind: 'handler', handlerKey: 'style' };
  if (command === '/me') return { kind: 'handler', handlerKey: 'me' };

  if (command === '/exp') {
    if (!permissions.isOwner) {
      return {
        kind: 'reply',
        reply: '只有 bot 所有者可以使用 /w exp。',
        reason: 'exp 权限限制',
        replied: Boolean(ctx.sendMessage),
      };
    }
    return { kind: 'handler', handlerKey: 'exp' };
  }

  if (POLICY_COMMAND_PATHS.has(command)) {
    if (command === '/op' && !permissions.isOwner) {
      return {
        kind: 'reply',
        reply: '只有 bot 所有者可以使用 /w op。',
        reason: 'op 权限限制',
        replied: Boolean(ctx.sendMessage),
      };
    }
    if (!target) {
      const reply = `用法：/w ${command.slice(1)} @某人`;
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    return directRoute('memberPolicy', 'memberPolicy');
  }

  if (command === '/preset') return directRoute('preset', 'preset', 'mode');
  if (command === '/why') return directRoute('why', 'why');
  if (command === '/pause') return directRoute('pause', 'pause');
  if (command === '/resume') return directRoute('resume', 'pause');

  if (command === '/prompt') {
    if (subCommand === 'show') return denyRoute('promptShow');
    if (subCommand === 'savebase') return denyRoute('promptSavebase');
    return { kind: 'handler', handlerKey: 'promptEdit', permissionKey: subCommand === 'add' || subCommand === 'set' || subCommand === 'reset' ? 'promptEdit' : undefined };
  }

  if (command === '/relation') {
    const targetA = (ctx.event.atTargets && ctx.event.atTargets[0]) || parts[3];
    const targetB = (ctx.event.atTargets && ctx.event.atTargets[1]) || parts[4];
    if (!targetA || !targetB) {
      const reply = '用法：/w relation show|update|clear @某人 @某人';
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    const relAction = subCommand || 'show';
    if (relAction === 'show') return directRoute('relationShow', 'relationshipShow');
    if (relAction === 'update' || relAction === 'clear') return directRoute('relationEdit', 'relationshipEdit');
    const reply = '用法：/w relation show|update|clear @某人 @某人';
    return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
  }

  if (command === '/group') {
    if (subCommand === 'profile') {
      const profileAction = (parts[3] || '').toLowerCase();
      if (profileAction === 'show') return directRoute('groupProfileShow', 'groupProfileShow');
      if (profileAction === 'update' || profileAction === 'clear' || profileAction === 'on' || profileAction === 'off') {
        return directRoute('groupProfileEdit', 'groupProfileEdit');
      }
      const reply = '用法：/w group profile show|update|clear|on|off';
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    if (subCommand !== 'add') {
      const reply = '用法：/w group add [群名] 或 /w group profile show|update|clear|on|off';
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    if (!(permissions.isOwner || commandUserPolicy.policy === 'owner')) {
      const reply = '这个指令只有所有者可以使用。';
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    return { kind: 'handler', handlerKey: 'groupAdd' };
  }

  if (command === '/rate') return directRoute('rate', 'rate');
  if (command === '/cooldown') return directRoute('cooldown', 'cooldown');
  if (command === '/mode') return directRoute('mode', 'mode');
  if (command === '/status') return directRoute('status', 'status');

  if (command === '/refresh') return directRoute('refresh', 'memberPolicy');
  if (command === '/recalc') return { kind: 'handler', handlerKey: 'recalc' };
  if (command === '/ping') return directRoute('ping', 'ping');
  if (command === '/usage') return directRoute('usage', 'usage');

  if (command === '/model') {
    const arg = String(parts[2] || '').trim();
    if (!arg || arg === 'show' || arg === 'list') return directRoute('modelShow', 'modelShow');
    return directRoute('modelSet', 'modelSet');
  }

  if (command === '/search') return directRoute('search', 'search');
  if (command === '/thinking') return directRoute('thinking', 'thinking');
  if (command === '/sysfacts') return directRoute('sysfacts', 'search');

  if (command === '/summarize') {
    const countArg = parseInt(parts[2], 10);
    const N = Number.isFinite(countArg) && countArg >= 5 ? countArg : 50;
    if (N < 5 || N > 500) {
      const reply = '总结消息条数范围：5-500。';
      return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
    }
    return directRoute('summarize', N >= 100 ? 'summarizeLarge' : 'summarize');
  }

  if (command === '/note') return directRoute('note', 'note');
  if (command === '/profile') return directRoute('profile', 'profile');

  if (command === '/osu') {
    const clearAction = String(commandArgs || '').trim().split(/\s+/)[0].toLowerCase();
    if (subCommand === 'bind') return directRoute('osu.bind', 'osuBind');
    if (subCommand === 'analyze') return directRoute('osu.analyze', 'osuAnalyze');
    if (subCommand === 'recent') return directRoute('osu.recent', 'osuRecent');
    if (subCommand === 'clear') {
      const mapping: Record<string, { handlerKey: OwnerHandlerKey; permissionKey: string }> = {
        bind: { handlerKey: 'osu.clear.bind', permissionKey: 'osuClearBind' },
        history: { handlerKey: 'osu.clear.history', permissionKey: 'osuClearHistory' },
        cooldown: { handlerKey: 'osu.clear.cooldown', permissionKey: 'osuClearCooldown' },
        recommend: { handlerKey: 'osu.clear.recommend', permissionKey: 'osuClearRecommend' },
        cache: { handlerKey: 'osu.clear.cache', permissionKey: 'osuClearCache' },
      };
      const mapped = mapping[clearAction];
      if (mapped) return directRoute(mapped.handlerKey, mapped.permissionKey);
      return directRoute('osu.help', 'osuHelp');
    }
    return directRoute('osu.help', 'osuHelp');
  }

  if (!isWuxinCommand) {
    return { kind: 'reply', replied: false, reason: '忽略非 Wuxin 裸斜杠指令，避免和其他 bot 冲突' };
  }

  const reply = command === '/'
    ? '用 /w help 查看 Wuxin 指令。'
    : `未知 Wuxin 指令：${command}。用 /w help 查看帮助。`;
  return { kind: 'reply', reply, reason: reply, replied: Boolean(ctx.sendMessage) };
}

/** Export for verifier introspection. */
export const OWNER_MEMBER_POLICY_PATHS = POLICY_COMMAND_PATHS;
