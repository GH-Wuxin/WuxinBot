// Tool executor: handles LLM tool calls, runs the tool loop, manages bot communication.
import type { LlmToolCall, ToolResult, BotResponse, LlmTool, BotCommand } from './types.js';
import { validateOperation, sanitizeToolResult, isSafeToolResult } from './guard.js';
import { loadRegistry, enabledBots, findBot, findCommand, availableCommands, internalCapabilitySupported, INTERNAL_CAPABILITIES } from './registry.js';
import { lookupSkill, lookupSkillByQQ } from './skills.js';
import { getRenderServer } from './renderServer.js';
import { scoreStarRating } from '../osu/scoreMetrics.js';
import { enrichScoreStarRatings } from '../osu/starRating.js';
import type { OsuMode, OsuScore, OsuUser } from '../osu/types.js';

// ── Pending bot responses (correlationId → resolver) ──

const pendingBotCalls = new Map<string, {
  correlationId: string;
  botId: string;
  channel: 'qq_private' | 'qq_group';
  groupId?: string;
  createdAt: number;
  textParts: Array<{ text: string; progress: boolean }>;
  images: string[];
  rawMessageId: string;
  resolve: (response: BotResponse) => void;
  timeout: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
}>();

const BOT_RESPONSE_TIMEOUT_MS = 20_000;
const BOT_TEXT_SETTLE_MS = 1_200;
const BOT_PROGRESS_SETTLE_MS = 10_000;

type PendingBotCall = (typeof pendingBotCalls extends Map<string, infer T> ? T : never);

function boundedDelay(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(19_000, Math.round(parsed)));
}

function responsePolicy(db: any, bot: any): {
  textSettleMs: number;
  progressSettleMs: number;
  progressKeywords: string[];
} {
  const local = bot?.responsePolicy && typeof bot.responsePolicy === 'object'
    ? bot.responsePolicy
    : {};
  const settings = db?.settings || {};
  const configuredKeywords = local.progressKeywords ?? settings.botResponseProgressKeywords;
  const progressKeywords = Array.isArray(configuredKeywords)
    ? configuredKeywords
    : String(configuredKeywords || '').split(/[\n,，]+/);
  return {
    textSettleMs: boundedDelay(
      local.textSettleMs ?? settings.botResponseTextSettleMs,
      BOT_TEXT_SETTLE_MS
    ),
    progressSettleMs: boundedDelay(
      local.progressSettleMs ?? settings.botResponseProgressSettleMs,
      BOT_PROGRESS_SETTLE_MS
    ),
    progressKeywords: progressKeywords.map((value: unknown) => String(value).trim()).filter(Boolean)
  };
}

function looksLikeProgressResponse(text: string, keywords: string[]): boolean {
  const value = String(text || '').replace(/\[图片\]/g, '').trim();
  if (!value) return false;
  if (keywords.some((keyword) => value.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()))) {
    return true;
  }
  return /^(?:正在(?:查询|处理|生成|渲染|获取|加载|计算)|查询中|处理中|生成中|渲染中|请稍候|请稍等|稍等(?:一下)?|已收到(?:请求|指令)?|开始查询|loading\b|processing\b|please wait\b)/i.test(value);
}

function finishPendingBotCall(entry: PendingBotCall, timeoutWithoutContent = false): void {
  const current = pendingBotCalls.get(entry.correlationId);
  if (current !== entry) return;
  clearTimeout(entry.timeout);
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  pendingBotCalls.delete(entry.correlationId);

  const substantive = entry.textParts.filter((part) => !part.progress).map((part) => part.text);
  const allText = entry.textParts.map((part) => part.text);
  const selectedText = substantive.length > 0
    ? substantive
    : (entry.images.length > 0 ? [] : allText);
  const text = [...new Set(selectedText)].join('\n').trim();
  const ok = Boolean(text || entry.images.length > 0);
  entry.resolve({
    correlationId: entry.correlationId,
    botId: entry.botId,
    ok,
    text,
    images: [...entry.images],
    rawMessageId: entry.rawMessageId,
    error: ok ? undefined : (timeoutWithoutContent ? '机器人响应超时' : undefined)
  });
}

function schedulePendingSettlement(entry: PendingBotCall, delayMs: number): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = setTimeout(() => finishPendingBotCall(entry), delayMs);
}

// ── Register a pending call ──

export function registerPendingBotCall(
  request: {
    correlationId: string;
    botId: string;
    channel: 'qq_private' | 'qq_group';
    groupId?: string;
  },
  timeoutMs: number = BOT_RESPONSE_TIMEOUT_MS
): Promise<BotResponse> {
  const { correlationId, botId, channel } = request;
  const groupId = request.groupId ? String(request.groupId) : undefined;
  const routeBusy = [...pendingBotCalls.values()].some((pending) =>
    pending.botId === botId &&
    pending.channel === channel &&
    (channel !== 'qq_group' || String(pending.groupId || '') === String(groupId || ''))
  );
  if (routeBusy) {
    throw new Error(`bot_route_busy: ${botId}/${channel}${groupId ? `/${groupId}` : ''}`);
  }
  return new Promise((resolve) => {
    const entry = {
      correlationId,
      botId,
      channel,
      groupId,
      createdAt: Date.now(),
      textParts: [],
      images: [],
      rawMessageId: '',
      resolve,
      timeout: undefined as unknown as NodeJS.Timeout
    };
    entry.timeout = setTimeout(() => finishPendingBotCall(entry, true), timeoutMs);
    pendingBotCalls.set(correlationId, entry);
  });
}

function cancelPendingBotCall(correlationId: string): void {
  const pending = pendingBotCalls.get(correlationId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  if (pending.settleTimer) clearTimeout(pending.settleTimer);
  pendingBotCalls.delete(correlationId);
}

// ── Called when a message arrives that might be a bot response ──

export function tryResolveBotResponse(
  db: any,
  event: {
    userId?: string;
    type?: 'private' | 'group';
    groupId?: string;
    text?: string;
    images?: { url?: string; file?: string }[];
    messageId?: string;
  }
): boolean {
  const senderQq = String(event.userId || '');
  const registry = loadRegistry(db);
  const eventChannel = event.type === 'group' || event.groupId ? 'qq_group' : 'qq_private';
  const eventGroupId = event.groupId ? String(event.groupId) : undefined;
  const candidateBots = (registry.bots || []).filter(
    (candidate) =>
      candidate.enabled &&
      candidate.qq === senderQq &&
      candidate.channel === eventChannel &&
      (eventChannel !== 'qq_group' ||
        String(candidate.groupId || eventGroupId || '') === String(eventGroupId || ''))
  );
  if (candidateBots.length === 0) return false;
  const candidateBotIds = new Set(candidateBots.map((bot) => bot.id));

  // A QQ bot normally does not echo our correlation ID. Match only calls on
  // the exact bot/channel/group route, then resolve that route's oldest
  // request. Other groups and private calls remain independent.
  const entry = [...pendingBotCalls.values()]
    .filter((pending) =>
      candidateBotIds.has(pending.botId) &&
      pending.channel === eventChannel &&
      (eventChannel !== 'qq_group' ||
        String(pending.groupId || '') === String(eventGroupId || ''))
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!entry) return false;
  const bot = candidateBots.find((candidate) => candidate.id === entry.botId)!;

  const text = String(event.text || '').replace(/^\s*\[图片\]\s*$/, '').trim();
  const images = (event.images || []).map((img) => img.url || img.file || '').filter(Boolean);
  const policy = responsePolicy(db, bot);
  if (text) {
    const progress = looksLikeProgressResponse(text, policy.progressKeywords);
    if (!entry.textParts.some((part) => part.text === text)) {
      entry.textParts.push({ text, progress });
    }
  }
  for (const image of images) {
    if (!entry.images.includes(image)) entry.images.push(image);
  }
  if (event.messageId) entry.rawMessageId = String(event.messageId);

  // An image is a reliable terminal signal for osu! panel bots. Text-only bots
  // settle after a short quiet window so split replies can be combined. Known
  // progress messages get a longer configurable grace period, while the hard
  // request timeout above remains the final bound and returns any text received.
  if (entry.images.length > 0) {
    finishPendingBotCall(entry);
  } else if (entry.textParts.length > 0) {
    const latest = entry.textParts[entry.textParts.length - 1];
    schedulePendingSettlement(
      entry,
      latest.progress ? policy.progressSettleMs : policy.textSettleMs
    );
  }
  return true;
}

// ── Execute a single tool call ──

export interface BpQuerySelection {
  startRank: number;
  endRank: number;
  explicit: boolean;
  single: boolean;
  /** yumu official !bs style: dense five-column layout once ≥10 scores. */
  compact?: boolean;
}

function hasQueryParam(params: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(params, key) &&
    params[key] !== undefined &&
    params[key] !== null &&
    params[key] !== '';
}

function integerQueryParam(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Convert validated query_bot parameters into one deterministic BP slice.
 * An ordinary `/bp` remains BP1-10 for compatibility; BP1/BP10 and explicit
 * ranges only fetch and render the requested rows.
 */
export function resolveBpQuerySelection(params: Record<string, unknown>): BpQuerySelection {
  const rank = hasQueryParam(params, 'bp_rank')
    ? integerQueryParam(params.bp_rank)
    : null;
  if (rank !== null) {
    return { startRank: rank, endRank: rank, explicit: true, single: true, compact: params.compact === true };
  }

  const start = hasQueryParam(params, 'bp_start')
    ? integerQueryParam(params.bp_start)
    : null;
  const end = hasQueryParam(params, 'bp_end')
    ? integerQueryParam(params.bp_end)
    : null;
  if (start !== null || end !== null) {
    const startRank = start ?? end ?? 1;
    const endRank = end ?? startRank;
    return {
      startRank,
      endRank,
      explicit: true,
      single: startRank === endRank,
      compact: params.compact === true,
    };
  }

  return { startRank: 1, endRank: 10, explicit: false, single: false };
}

export function parseEmbeddedBpCommand(command: string): {
  command: string;
  selection?: BpQuerySelection;
  error?: string;
} {
  const value = String(command || '').trim();
  const match = /^([!/]?(?:bp|bplist|bs))\s*#?\s*(\d{1,3})(?:\s*(?:-|~|到|至)\s*(\d{1,3}))?$/iu.exec(value);
  if (!match) return { command: value };

  const startRank = Number(match[2]);
  const endRank = match[3] ? Number(match[3]) : startRank;
  if (
    !Number.isInteger(startRank) ||
    !Number.isInteger(endRank) ||
    startRank < 1 ||
    endRank > 100 ||
    startRank > endRank
  ) {
    return {
      command: match[1],
      error: 'BP 名次必须是 1 到 100，且范围起点不能大于终点',
    };
  }
  if (endRank - startRank + 1 > 100) {
    return {
      command: match[1],
      error: '一次最多查询 100 张 BP',
    };
  }
  return {
    command: match[1],
    selection: {
      startRank,
      endRank,
      explicit: true,
      single: startRank === endRank,
      compact: /^[!/]?bs\b/i.test(value),
    },
  };
}

export function parseBpSelectionFromUserText(text: string): {
  selection?: BpQuerySelection;
  error?: string;
} {
  const match = /BP\s*#?\s*(\d{1,3})(?:\s*(?:-|~|到|至)\s*(?:BP\s*#?\s*)?(\d{1,3}))?(?!\d)/iu.exec(
    String(text || ''),
  );
  if (!match) return {};

  const startRank = Number(match[1]);
  const endRank = match[2] ? Number(match[2]) : startRank;
  if (startRank < 1 || endRank > 100 || startRank > endRank) {
    return { error: 'BP 名次必须是 1 到 100，且范围起点不能大于终点' };
  }
  if (endRank - startRank + 1 > 100) {
    return { error: '一次最多查询 100 张 BP' };
  }
  return {
    selection: {
      startRank,
      endRank,
      explicit: true,
      single: startRank === endRank,
    },
  };
}

function bpSelectionSuffix(selection: BpQuerySelection | undefined): string {
  if (!selection?.explicit) return '';
  return selection.single
    ? `#${selection.startRank}`
    : `#${selection.startRank}-${selection.endRank}`;
}

const DIRECT_RESULT_COMMANDS = new Set([
  'recent',
  'info',
  'profile',
  'card',
  'bp',
  'bplist',
  'bp_type',
  'ppplus',
  'skill',
]);

/**
 * Lists and data panels are products in their own right. If a renderer is
 * unavailable, their text fallback must be delivered verbatim instead of
 * asking the LLM to reconstruct it from a tool message.
 */
function directContentForBotResult(
  command: BotCommand,
  content: string,
  images: string[] = [],
): string | undefined {
  const text = String(content || '').trim();
  if (!text || images.length > 0) return undefined;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const looksLikeStructuredResult =
    lines.length >= 3 &&
    lines.some((line) =>
      /^(?:#\d+\b|[-•]\s|【[^】]+】|\w[\w +.-]*:\s)|\|\s*(?:NM|[A-Z]{2,})\s*\|/u.test(line)
    );

  if (
    DIRECT_RESULT_COMMANDS.has(String(command.name || '').toLocaleLowerCase()) ||
    command.returns === 'image' ||
    command.returns === 'both' ||
    looksLikeStructuredResult
  ) {
    return text;
  }
  return undefined;
}

export async function executeToolCall(
  toolCall: LlmToolCall,
  context: {
    db: any;
    userId: string;
    groupId?: string;
    sendMessage?: (event: any, text: string, extra?: any) => Promise<any>;
    event?: any;
    selfQq?: string;
  }
): Promise<ToolResult> {
  const { db, userId, groupId, event } = context;
  const toolName = toolCall.function.name;
  let args: Record<string, unknown> = {};

  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    return {
      toolCallId: toolCall.id,
      ok: false,
      content: '',
      error: `无法解析工具参数: ${toolCall.function.arguments}`
    };
  }

  // ── Validate ──

  const validation = validateOperation({ type: toolName as any, params: args });
  if (!validation.ok) {
    return {
      toolCallId: toolCall.id,
      ok: false,
      content: `操作被安全策略拒绝: ${(validation as any).reason}`,
      error: (validation as any).reason
    };
  }

  // ── Execute ──

  switch (toolName) {
    case 'list_bots': {
      const registry = loadRegistry(db);
      const bots = enabledBots(registry);
      const list = bots.map((b) =>
        `- ${b.name}（${b.id}）：${b.description}。可用指令：${availableCommands(b).map((c) => `${c.name}（${c.trigger}）`).join('、') || '暂无'}`
      ).join('\n');
      return {
        toolCallId: toolCall.id,
        ok: true,
        content: bots.length > 0 ? `可用的机器人：\n${list}` : '当前没有已启用的机器人。'
      };
    }

    case 'get_player_skill': {
      const player = String(args.player || '').trim();
      if (!player) {
        return { toolCallId: toolCall.id, ok: false, content: '未指定玩家', error: '缺少玩家标识' };
      }

      // Resolve through QQ binding if the player identifier looks like a QQ or nickname
      let record = lookupSkill(player);
      if (!record) {
        const target = resolveInternalPlayerTarget(context.db, context.userId, player);
        if (target) {
          try {
            const user = await loadInternalOsuUser(target);
            if (user?.username) {
              record = lookupSkill(user.username);
            }
          } catch { /* binding resolved but user fetch failed — fall through */ }
        }
      }
      // Also try direct QQ lookup
      if (!record && /^\d{5,}$/.test(player)) {
        record = lookupSkillByQQ(player);
      }

      if (!record) {
        return {
          toolCallId: toolCall.id,
          ok: true,
          content: `没有找到玩家 "${player}" 的技能记录。可能还没有被分析过，或者需要先用 /w osu bind 绑定账号。`
        };
      }

      return {
        toolCallId: toolCall.id,
        ok: true,
        content: formatSkillResult(record)
      };
    }

    case 'get_recent_score': {
      // For now, returns the recent summary from skill record
      const requestedPlayer = String(args.player || '').trim();
      const player = requestedPlayer || String(userId || '').trim();
      const record = player ? lookupSkill(player) : undefined;
      if (!record) {
        return {
          toolCallId: toolCall.id,
          ok: true,
          content: `没有找到玩家 "${player}" 的最近成绩记录。`
        };
      }

      return {
        toolCallId: toolCall.id,
        ok: true,
        content: [
          `${record.osuUsername} 的技能记录：`,
          `PP: ${record.pp.toLocaleString()}，全球排名 #${record.rank.toLocaleString()}`,
          `准确率: ${record.accuracy.toFixed(1)}%`,
          record.recentSummary ? `最近表现: ${record.recentSummary}` : '',
          record.summary ? `总体评价: ${record.summary}` : '',
          `最后分析时间: ${record.lastAnalyzed}`,
        ].filter(Boolean).join('\n')
      };
    }

    case 'query_osu': {
      const capability = String(args.capability || '').trim();
      const oUsername = String(args.username || '').trim();

      if (!capability) {
        return { toolCallId: toolCall.id, ok: false, content: '需要指定 capability', error: '缺少 capability 参数' };
      }
      if (!internalCapabilitySupported(capability)) {
        return { toolCallId: toolCall.id, ok: false, content: `未知的 osu! 查询类型 "${capability}"。支持：${INTERNAL_CAPABILITIES.map((c) => c.name).join('、')}`, error: `unsupported_capability: ${capability}` };
      }

      const oIsBp = capability === 'bp';
      const oHasBpRank = hasQueryParam(args, 'bp_rank') && !hasQueryParam(args, 'bp_start');
      const oHasBpRange = hasQueryParam(args, 'bp_start') || hasQueryParam(args, 'bp_end');
      const oBpSelection: BpQuerySelection | undefined = oIsBp
        ? (oHasBpRank
            ? resolveBpQuerySelection({ bp_rank: args.bp_rank, compact: args.compact })
            : oHasBpRange
              ? resolveBpQuerySelection({ bp_start: args.bp_start, bp_end: args.bp_end, compact: args.compact })
              : (parseBpSelectionFromUserText(String(context.event?.text || '')).selection || resolveBpQuerySelection({})))
        : undefined;

      try {
        const rawResult = await executeInternalBotCommand(
          'wuxin_internal',
          capability,
          oUsername || '',
          context,
          oBpSelection,
        );
        const result = typeof rawResult === 'string'
          ? { content: rawResult, images: [] as string[] }
          : { content: rawResult.content, images: rawResult.images || [] };
        return {
          toolCallId: toolCall.id,
          ok: true,
          content: `Wuxin 内部 osu! 查询（capability=${capability}，数据来源：osu! API v2 / PP+ / skill store）：\n${result.content}`,
          images: result.images,
          directContent: directContentForBotResult(
            { name: capability, trigger: '', description: '', params: [], returns: result.images.length > 0 ? 'image' : 'text' },
            result.content,
            result.images,
          ),
          metadata: {
            requestId: toolCall.id,
            requestedCapability: capability,
            actualExecutor: 'wuxin_internal',
            dataSource: capability === 'ppplus' || capability === 'skill' ? 'ppplus_skill_store' : 'osu_api',
            renderer: result.images.length > 0 ? 'yumu_image' : 'none',
            command: capability,
            args: { capability, ...(oBpSelection ? { bp_start: oBpSelection.startRank, bp_end: oBpSelection.endRank } : {}) },
            success: true,
          }
        };
      } catch (err) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `Wuxin 内部查询失败: ${String(err?.message || err)}`,
          error: String(err?.message || err),
          metadata: {
            requestId: toolCall.id,
            requestedCapability: capability,
            actualExecutor: 'wuxin_internal',
            success: false,
            errorCode: String(err?.message || err).slice(0, 200),
          }
        };
      }
    }

    case 'query_external_bot': {
      const extBotId = String(args.bot || '').trim();
      const extCommand = String(args.command || '').trim();
      if (!extBotId || !extCommand) {
        return { toolCallId: toolCall.id, ok: false, content: '需要指定 bot 和 command' };
      }
      const extRegistry = loadRegistry(db);
      const extBot = findBot(extRegistry, extBotId);
      if (!extBot) {
        return { toolCallId: toolCall.id, ok: false, content: `未找到外部机器人 "${extBotId}"。`, metadata: { requestedBot: extBotId, actualExecutor: 'none', success: false } };
      }
      if (!extBot.qq || extBot.channel === 'internal') {
        return { toolCallId: toolCall.id, ok: false, content: `"${extBot.name}" 当前未通过外部 QQ 通道接入 Harness。Wuxin 内部 osu! 工具可以提供类似数据。`, metadata: { requestedBot: extBot.id, actualExecutor: 'none', success: false } };
      }
      // QQ channel relay — same as legacy query_bot for external bots
      if (!context.sendMessage || !context.event) {
        return { toolCallId: toolCall.id, ok: false, content: `无法向 ${extBot.name} 发送消息：消息通道未就绪。` };
      }
      try {
        const correlationId = `${extBot.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const responsePromise = registerPendingBotCall({ correlationId, botId: extBot.id, channel: extBot.channel, groupId: extBot.channel === 'qq_group' ? String(extBot.groupId || context.groupId || '') : undefined });
        const botEvent = { ...context.event, type: extBot.channel === 'qq_group' ? 'group' : 'private', userId: extBot.channel === 'qq_group' ? undefined : extBot.qq, groupId: extBot.channel === 'qq_group' ? String(extBot.groupId || context.groupId || '') : undefined, text: extCommand, messageId: `bot_cmd_${Date.now()}`, raw: context.event.raw || {} };
        await context.sendMessage(botEvent, extCommand);
        const response = await responsePromise;
        if (response.ok) {
          return {
            toolCallId: toolCall.id, ok: true,
            content: `已向 ${extBot.name} 发送指令 "${extCommand}"。\n${response.text || ''}`,
            images: response.images,
            metadata: { requestId: toolCall.id, requestedBot: extBot.id, actualExecutor: extBot.id, transport: extBot.channel, success: true }
          };
        }
        return { toolCallId: toolCall.id, ok: false, content: `${extBot.name} 查询失败: ${response.error || '无响应'}`, metadata: { requestedBot: extBot.id, actualExecutor: extBot.id, success: false } };
      } catch (err) {
        return { toolCallId: toolCall.id, ok: false, content: `向 ${extBot.name} 发送指令失败: ${String(err?.message || err)}`, metadata: { requestedBot: extBot.id, success: false } };
      }
    }

    case 'query_bot': {
      const botId = String(args.bot || '').trim();
      const embeddedBpCommand = parseEmbeddedBpCommand(String(args.command || '').trim());
      const command = embeddedBpCommand.command;
      const username = String(args.username || '').trim();

      if (!botId || !command) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: '需要指定机器人（bot）和指令（command）',
          error: '缺少必要参数'
        };
      }

      const registry = loadRegistry(db);
      const bot = findBot(registry, botId);
      if (!bot) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `没有找到机器人 "${botId}"。可用的机器人可以用 list_bots 查看。`
        };
      }

      if (!bot.enabled) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `机器人 "${bot.name}" 未启用。`
        };
      }

      // Group-level bot toggle — allows per-group disabling of individual bots
      const groupBotEnabled = context.groupId
        ? (context.db?.groupBotConfig?.[String(context.groupId)]?.[botId] !== false)
        : true;
      if (!groupBotEnabled) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `[内部] ${bot.name} 在本群不可用。请换一个机器人或直接用文字回答，不要向用户解释原因。`
        };
      }

      const cmd = findCommand(bot, command);
      if (!cmd) {
        const supported = availableCommands(bot);
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `机器人 "${bot.name}" 不支持指令 "${command}"。支持的指令：${supported.map((c) => `${c.name}（${c.trigger}）`).join('、') || '暂无'}`,
          error: `unsupported_command: ${bot.id}/${command}`
        };
      }

      const hasExplicitBpParams = ['bp_rank', 'bp_start', 'bp_end']
        .some((key) => hasQueryParam(args, key));
      if (!hasExplicitBpParams && embeddedBpCommand.error) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: embeddedBpCommand.error,
          error: 'invalid_bp_range',
        };
      }

      const isBpCommand = cmd.name === 'bp' || cmd.name === 'bplist';
      if (!isBpCommand && hasExplicitBpParams) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: `参数 bp_rank/bp_start/bp_end 只能用于 BP 指令，不能用于 "${cmd.name}"。`,
          error: 'bp_selector_on_non_bp_command',
        };
      }
      const eventBpSelection = isBpCommand &&
        !hasExplicitBpParams &&
        !embeddedBpCommand.selection
        ? parseBpSelectionFromUserText(String(context.event?.text || ''))
        : {};
      if (eventBpSelection.error) {
        return {
          toolCallId: toolCall.id,
          ok: false,
          content: eventBpSelection.error,
          error: 'invalid_bp_range',
        };
      }
      const bpSelection = isBpCommand
        ? (
            hasExplicitBpParams
              ? resolveBpQuerySelection(args)
              : embeddedBpCommand.selection ||
                eventBpSelection.selection ||
                resolveBpQuerySelection({})
          )
        : undefined;
      const fullCommand = [
        cmd.trigger,
        username,
        bpSelectionSuffix(bpSelection),
      ].filter(Boolean).join(' ');

      // Internal channel: call Wuxin's own osu! module directly
      if (bot.channel === 'internal') {
        try {
          const rawResult = await executeInternalBotCommand(
            bot.id,
            cmd.name,
            username || '',
            context,
            bpSelection,
          );
          const result = typeof rawResult === 'string'
            ? { content: rawResult, images: [] as string[] }
            : { content: rawResult.content, images: rawResult.images || [] };
          return {
            toolCallId: toolCall.id,
            ok: true,
            content: `已通过 ${bot.name} 执行 "${fullCommand}"：\n${result.content}`,
            images: result.images,
            directContent: directContentForBotResult(cmd, result.content, result.images),
            metadata: {
              botId: bot.id,
              command: fullCommand,
              internal: true,
              ...(bpSelection ? {
                bpStart: bpSelection.startRank,
                bpEnd: bpSelection.endRank,
              } : {}),
            }
          };
        } catch (err) {
          return {
            toolCallId: toolCall.id,
            ok: false,
            content: `${bot.name} 内部执行失败: ${String(err?.message || err)}`,
            error: String(err?.message || err)
          };
        }
      }

      // QQ channel: send private message to the bot (different QQ account)
      if (bot.channel === 'qq_private' || bot.channel === 'qq_group') {
        if (!bot.qq) {
          return {
            toolCallId: toolCall.id,
            ok: false,
            content: `机器人 "${bot.name}" 未配置 QQ 号。`
          };
        }

        // Same QQ account guard
        if (context.selfQq && bot.qq === context.selfQq) {
          return {
            toolCallId: toolCall.id,
            ok: false,
            content: `机器人 "${bot.name}" 和 pippi 使用同一个 QQ 号，无法通过 QQ 消息通信。请将机器人的 channel 改为 internal。`
          };
        }

        if (!context.sendMessage || !context.event) {
          return {
            toolCallId: toolCall.id,
            ok: false,
            content: `无法向 ${bot.name} 发送消息：消息通道未就绪。`
          };
        }

        try {
          const correlationId = `${bot.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const targetGroupId = bot.channel === 'qq_group'
            ? String(bot.groupId || context.groupId || '')
            : undefined;
          if (bot.channel === 'qq_group' && !targetGroupId) {
            return {
              toolCallId: toolCall.id,
              ok: false,
              content: `无法向 ${bot.name} 发送消息：没有可用的群号。`,
              error: '缺少群聊目标'
            };
          }
          const responsePromise = registerPendingBotCall({
            correlationId,
            botId: bot.id,
            channel: bot.channel,
            groupId: targetGroupId
          });

          const botEvent = {
            ...context.event,
            type: bot.channel === 'qq_group' ? 'group' : 'private',
            userId: bot.channel === 'qq_group' ? undefined : bot.qq,
            groupId: targetGroupId,
            text: fullCommand,
            messageId: `bot_cmd_${Date.now()}`,
            raw: context.event.raw || {}
          };

          try {
            await context.sendMessage(botEvent, fullCommand);
          } catch (error) {
            cancelPendingBotCall(correlationId);
            throw error;
          }
          const response = await responsePromise;

          if (response.ok) {
            const imageNote = response.images.length > 0
              ? `\n机器人返回了 ${response.images.length} 张图片。`
              : '';
            return {
              toolCallId: toolCall.id,
              ok: true,
              content: `已向 ${bot.name} 发送指令 "${fullCommand}"。${imageNote}\n${response.text || ''}`,
              images: response.images,
              directContent: directContentForBotResult(cmd, response.text, response.images),
              metadata: {
                botId: bot.id,
                command: fullCommand,
                responseText: response.text,
                ...(bpSelection ? {
                  bpStart: bpSelection.startRank,
                  bpEnd: bpSelection.endRank,
                } : {}),
              }
            };
          } else {
            return {
              toolCallId: toolCall.id,
              ok: false,
              content: `${bot.name} 查询失败: ${response.error || '无响应'}`,
              error: response.error
            };
          }
        } catch (err) {
          return {
            toolCallId: toolCall.id,
            ok: false,
            content: `向 ${bot.name} 发送指令失败: ${String(err?.message || err)}`,
            error: String(err?.message || err)
          };
        }
      }

      return {
        toolCallId: toolCall.id,
        ok: false,
        content: `${bot.name} 的通信方式 "${bot.channel}" 不受支持。`
      };
    }

    default:
      return {
        toolCallId: toolCall.id,
        ok: false,
        content: `未知的工具: ${toolName}`,
        error: `unknown_tool: ${toolName}`
      };
  }
}

// ── Internal bot command execution ──

export interface InternalPlayerTarget {
  kind: 'id' | 'username';
  value: number | string;
}

export interface InternalBotCommandResult {
  content: string;
  images?: string[];
}

function scoreModAcronyms(score: OsuScore): string[] {
  const rawMods: unknown[] = Array.isArray((score as any).mods) ? (score as any).mods : [];
  const acronyms = rawMods.map((mod): string => {
    if (typeof mod === 'string') return mod;
    if (mod && typeof mod === 'object' && 'acronym' in mod) {
      return String((mod as { acronym?: unknown }).acronym || '');
    }
    return '';
  }).map((mod) => mod.toUpperCase()).filter((mod) => mod && mod !== 'NM');
  return [...new Set<string>(acronyms)];
}

export function resolveInternalPlayerTarget(
  db: any,
  requestingUserId: string,
  explicitUsername: string
): InternalPlayerTarget | null {
  const explicit = String(explicitUsername || '').trim();
  if (explicit) return { kind: 'username', value: explicit };

  const binding = db?.osuBindings?.[String(requestingUserId)];
  if (typeof binding === 'number' && Number.isFinite(binding) && binding > 0) {
    return { kind: 'id', value: binding };
  }
  if (typeof binding === 'string' && binding.trim()) {
    const value = binding.trim();
    return /^\d+$/.test(value)
      ? { kind: 'id', value: Number(value) }
      : { kind: 'username', value };
  }
  if (binding && typeof binding === 'object') {
    const id = Number(binding.osuUserId ?? binding.userId ?? binding.id ?? 0);
    if (Number.isFinite(id) && id > 0) return { kind: 'id', value: id };
    const username = String(binding.osuUsername ?? binding.username ?? '').trim();
    if (username) return { kind: 'username', value: username };
  }

  // Read-only legacy fallback for databases created before osuBindings.
  const legacyUser = (db?.users || []).find(
    (user: any) => String(user.userId) === String(requestingUserId)
  );
  const legacyUsername = String(legacyUser?.osuUsername || '').trim();
  return legacyUsername ? { kind: 'username', value: legacyUsername } : null;
}

export async function loadInternalOsuUser(target: InternalPlayerTarget): Promise<OsuUser> {
  const { getUser, getUserById } = await import('../osu/api.js');
  return target.kind === 'id'
    ? getUserById(Number(target.value), 'osu')
    : getUser(String(target.value), 'osu');
}

function scoreTitle(score: OsuScore): string {
  const beatmapset = (score as any).beatmapset || (score as any).beatmap?.beatmapset || {};
  return String(beatmapset.title_unicode || beatmapset.title || '未知谱面');
}

function scoreAccuracyPercent(score: OsuScore): number | null {
  const raw = Number(score.accuracy);
  if (!Number.isFinite(raw)) return null;
  return raw >= 0 && raw <= 1 ? raw * 100 : raw;
}

export function formatInternalScoreLine(
  score: OsuScore,
  options: { index?: number; includeCombo?: boolean; includeWeight?: boolean } = {}
): string {
  const stars = scoreStarRating(score);
  const accuracy = scoreAccuracyPercent(score);
  const mods = scoreModAcronyms(score);
  const beatmap = score.beatmap || ({} as OsuScore['beatmap']);
  const prefix = options.index ? `#${options.index} ` : '';
  const difficulty = beatmap.version ? ` [${beatmap.version}]` : '';
  const fields = [
    `[${score.rank || 'F'}] ${scoreTitle(score)}${difficulty}`,
    stars > 0 ? `${stars.toFixed(2)}★` : '星数暂不可用',
    mods.length ? mods.join('') : 'NM',
    accuracy === null ? 'Acc ?' : `${accuracy.toFixed(2)}%`,
  ];
  if (options.includeCombo) {
    fields.push(`${score.max_combo || 0}/${beatmap.max_combo || '?'}x`);
  }
  fields.push(`${Number(score.pp || 0).toFixed(1)}pp`);
  if (options.includeWeight) {
    const weighted = Number((score as any).weight?.pp);
    fields.push(`加权 ${Number.isFinite(weighted) ? weighted.toFixed(1) : Number(score.pp || 0).toFixed(1)}pp`);
  }
  return `${prefix}${fields.join(' | ')}`;
}

function scoreForRenderer(score: OsuScore): OsuScore {
  const stars = scoreStarRating(score);
  if (stars <= 0 || !score.beatmap) return score;
  return {
    ...score,
    beatmap: { ...score.beatmap, difficulty_rating: stars }
  };
}

export function selectBpScores<T>(
  scores: T[],
  selection: BpQuerySelection,
): Array<{ rank: number; score: T }> {
  if (!Array.isArray(scores) || scores.length === 0) return [];
  const startIndex = Math.max(0, selection.startRank - 1);
  const endIndex = Math.max(startIndex, selection.endRank);
  return scores.slice(startIndex, endIndex).map((score, index) => ({
    rank: selection.startRank + index,
    score,
  }));
}

export function buildBpListRenderOptions(ranks: number[], compact = false): {
  startRank: number;
  ranks: number[];
  compact: boolean;
} {
  const normalizedRanks = (Array.isArray(ranks) ? ranks : [])
    .filter((rank) => Number.isInteger(rank) && rank >= 1 && rank <= 100);
  return {
    startRank: normalizedRanks[0] || 1,
    ranks: normalizedRanks,
    // Match yumu-bot's BPService: the official !bs path switches to the
    // dense five-column layout once the list reaches 10 scores; the QQ
    // double-column layout stays the default for ordinary bp queries.
    compact: compact && normalizedRanks.length >= 10,
  };
}

function internalPlayTimeHours(user: OsuUser): number {
  const seconds = Number(user.statistics?.play_time || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 3600 : 0;
}

function internalGradeCounts(user: OsuUser): Record<string, number> {
  const nested = (user.statistics as any)?.grade_counts || {};
  const topLevel = (user as any)?.grade_counts || {};
  return { ...nested, ...topLevel };
}

export function formatInternalProfileText(user: OsuUser): string {
  const statistics = user.statistics || ({} as OsuUser['statistics']);
  const grades = internalGradeCounts(user);
  return [
    `${user.username} 的 osu! 信息：`,
    `- PP: ${(statistics.pp || 0).toLocaleString()}，全球排名 #${(statistics.global_rank || 0).toLocaleString()}`,
    `- 国家排名: #${(statistics.country_rank || 0).toLocaleString()}（${(user as any).country?.name || ''}）`,
    `- 准确率: ${(statistics.hit_accuracy || 0).toFixed(2)}%`,
    `- 游玩次数: ${(statistics.play_count || 0).toLocaleString()}，游戏时间: ${internalPlayTimeHours(user).toFixed(0)} 小时`,
    `- 等级: ${(statistics.level as any)?.current || 0}`,
    `- 评级: SSH ${grades.ssh || 0}，SS ${grades.ss || 0}，SH ${grades.sh || 0}，S ${grades.s || 0}，A ${grades.a || 0}`,
  ].join('\n');
}

export function formatInternalInfoText(user: OsuUser, ppPlusNote = ''): string {
  const statistics = user.statistics || ({} as OsuUser['statistics']);
  return [
    `${user.username} 的 osu! 信息：`,
    `- PP: ${(statistics.pp || 0).toLocaleString()}，全球排名 #${(statistics.global_rank || 0).toLocaleString()}`,
    `- 准确率: ${(statistics.hit_accuracy || 0).toFixed(2)}%`,
    `- 游玩次数: ${(statistics.play_count || 0).toLocaleString()}，游戏时间: ${internalPlayTimeHours(user).toFixed(0)} 小时`,
    ppPlusNote,
  ].filter(Boolean).join('\n');
}

export async function executeInternalBotCommand(
  botId: string,
  commandName: string,
  username: string,
  context: { db: any; userId: string; groupId?: string },
  bpSelection?: BpQuerySelection,
): Promise<string | InternalBotCommandResult> {
  const { db, userId } = context;

  const target = resolveInternalPlayerTarget(db, userId, username);
  if (!target) {
    throw new Error('无法确定要查询的 osu! 用户名。请先使用 /w osu bind 绑定账号，或在指令中指定用户名。');
  }

  const requestedPlayer = String(target.value);
  let user: OsuUser;
  try {
    user = await loadInternalOsuUser(target);
  } catch (error) {
    throw new Error(`找不到 osu! 用户 "${requestedPlayer}"：${String(error?.message || error)}`);
  }
  if (!user?.id) throw new Error(`找不到 osu! 用户 "${requestedPlayer}"。`);

  switch (commandName) {
    case 'recent': {
      const { getUserRecentScores } = await import('../osu/api.js');
      const rawScores = await getUserRecentScores(user.id, 'osu', 1);
      if (!Array.isArray(rawScores) || rawScores.length === 0) {
        return `${user.username} 最近没有 osu! 成绩记录。`;
      }

      const [score] = (await enrichScoreStarRatings(rawScores, 'osu')).scores;
      const scoreLine = formatInternalScoreLine(score, { includeCombo: true });

      // Try to render a score image via yumu-image
      if (getRenderServer().hasClients()) {
        try {
          // 雨沐 original single-score panel (E5), same as its !r/!p output.
          const { renderScoreCard } = await import('./render.js');
          const rendered = await renderScoreCard(scoreForRenderer(score), user, null);
          if (rendered) {
            return {
              content: `${user.username} 最近一次 osu! 成绩：\n${scoreLine}`,
              images: [rendered.cqCode]
            };
          }
        } catch { /* fall through to text */ }
      }

      return `${user.username} 最近一次 osu! 成绩：\n${scoreLine}`;
    }

    case 'profile': {
      return formatInternalProfileText(user);
    }

    case 'info':
    case 'card': {
      // Try to render a player info card via yumu-image
      if (getRenderServer().hasClients()) {
        try {
          const { renderCompactInfoCard } = await import('./render.js');
          const rendered = await renderCompactInfoCard(user);
          if (rendered) {
            return {
              content: [
                `${user.username} 的 osu! 信息卡：`,
                `PP: ${(user.statistics?.pp || 0).toLocaleString()} | 全球 #${(user.statistics?.global_rank || 0).toLocaleString()} | 准确率 ${(user.statistics?.hit_accuracy || 0).toFixed(2)}%`
              ].join('\n'),
              images: [rendered.cqCode]
            };
          }
        } catch { /* fall through to text */ }
      }

      // Text fallback
      const ppPlusNote = context.db?.skillStore?.records
        ? (() => {
            const record = (context.db.skillStore.records as any[]).find(
              (r: any) => r.osuUsername?.toLowerCase() === user.username?.toLowerCase()
            );
            if (!record?.ppPlus) return '';
            const top3 = Object.entries(record.ppPlus as Record<string, number>)
              .filter(([, v]) => v > 0)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 3)
              .map(([k, v]) => `${k} ${(v as number).toFixed(1)}`)
              .join('、');
            return top3 ? `\n- PP+ 突出维度: ${top3}` : '';
          })()
        : '';

      return formatInternalInfoText(user, ppPlusNote);
    }

    case 'bp_type': {
      // osu!oracle BP type analysis. Deterministic tool result so the LLM can
      // never fabricate proportions: it only decides WHEN to call this tool.
      const { runBpTypeAnalysis } = await import('./bpTypeAnalysis.js');
      const text = await runBpTypeAnalysis(db, String(userId), username);
      return { content: text };
    }

    case 'bp':
    case 'bplist': {
      const { getUserBestScores } = await import('../osu/api.js');
      const selection = bpSelection || resolveBpQuerySelection({});
      const rawScores = await getUserBestScores(user.id, 'osu', selection.endRank);

      if (!Array.isArray(rawScores) || rawScores.length === 0) {
        return `${user.username} 没有 osu! 最佳成绩记录。`;
      }

      const selectedScores = selectBpScores(rawScores, selection);
      if (selectedScores.length === 0) {
        return `${user.username} 没有 BP${selection.startRank} 的成绩记录。`;
      }

      const scores = (await enrichScoreStarRatings(
        selectedScores.map((entry) => entry.score),
        'osu',
      )).scores;
      const rankedScores = scores.map((score, index) => ({
        rank: selectedScores[index].rank,
        score,
      }));
      const actualStart = rankedScores[0].rank;
      const actualEnd = rankedScores[rankedScores.length - 1].rank;
      const label = actualStart === actualEnd
        ? `BP${actualStart}`
        : `BP${actualStart}-${actualEnd}`;
      const lines = [`${user.username} 的 ${label}：`];
      for (const entry of rankedScores) {
        lines.push(`  ${formatInternalScoreLine(entry.score, {
          index: entry.rank,
          includeWeight: true,
        })}`);
      }
      const content = lines.join('\n');

      if (getRenderServer().hasClients()) {
        try {
          if (rankedScores.length === 1) {
            const { renderScoreCard } = await import('./render.js');
            const rendered = await renderScoreCard(
              scoreForRenderer(rankedScores[0].score),
              user,
              rankedScores[0].rank,
            );
            if (rendered) {
              return { content, images: [rendered.cqCode] };
            }
          } else {
            // One panel for the whole range, like yumu-bot's BPService:
            // !bs switches to the compact five-column layout at ≥10 scores.
            const { renderBestScoresList } = await import('./render.js');
            const rendered = await renderBestScoresList(
              user,
              rankedScores.map((entry) => scoreForRenderer(entry.score)),
              buildBpListRenderOptions(
                rankedScores.map((entry) => entry.rank),
                bpSelection?.compact,
              ),
            );
            if (rendered) {
              return { content, images: [rendered.cqCode] };
            }
          }
        } catch {
          // Rendering is an enhancement. The complete deterministic BP text
          // below remains available if yumu-image is offline or rejects data.
        }
      }

      return content;
    }

    case 'pplus':
    case 'ppplus':
    case 'skill': {
      // PP+ dimensions — try to fetch from PP+ service
      try {
        const { getPlayerBars } = await import('../osu/pplus.js');
        const bars = await getPlayerBars(user.id);
        if (bars) {
          const entries = Object.entries(bars)
            .filter(([key, v]) => key !== 'ppTotal' && v > 0)
            .sort(([, a], [, b]) => b - a);
          if (entries.length === 0) return `${user.username} 的 PP+ 数据为空。`;
          const barLines = entries.map(([k, v]) => `  ${k}: ${'█'.repeat(Math.min(Math.round(v), 20))} ${v.toFixed(2)}`);
          return [`${user.username} 的 PP+ 维度（15.0 = 基准线，可超出）：`, ...barLines].join('\n');
        }
      } catch {
        // PP+ service unavailable — use cached skill data
      }

      // Fallback to skill store
      const record = context.db?.skillStore?.records
        ? (context.db.skillStore.records as any[]).find(
            (r: any) => r.osuUsername?.toLowerCase() === user.username?.toLowerCase()
          )
        : null;

      if (record?.ppPlus) {
        const entries = Object.entries(record.ppPlus as Record<string, number>)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => b - a);
        const barLines = entries.map(([k, v]) => `  ${k}: ${v.toFixed(2)}`);
        return [`${user.username} 的 PP+ 维度（缓存数据）：`, ...barLines, '（数据来自最近一次分析，可能不是最新的）'].join('\n');
      }

      return `${user.username} 的 PP+ 数据暂不可用。PP+ 服务可能需要启动，或者玩家还没有被分析过。`;
    }

    default:
      throw new Error(`internal_command_not_implemented: ${botId}/${commandName}`);
  }
}

// ── Format skill record for LLM consumption ──

function formatSkillResult(record: any): string {
  const ppPlus = record.ppPlus
    ? Object.entries(record.ppPlus as Record<string, number>)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join('、')
    : '暂无';

  const mods = record.topMods?.length ? record.topMods.join('、') : '暂无';

  return [
    `玩家 ${record.osuUsername}（QQ:${record.userId}）的 osu! 技能记录：`,
    `- PP: ${(record.pp || 0).toLocaleString()}，全球排名 #${(record.rank || 0).toLocaleString()}（${record.mode} 模式）`,
    `- 准确率: ${(record.accuracy || 0).toFixed(1)}%`,
    `- 游玩次数: ${(record.playCount || 0).toLocaleString()}，游戏时间: ${(record.hoursPlayed || 0).toFixed(0)} 小时`,
    `- PP+ 维度: ${ppPlus}`,
    `- 常用 Mods: ${mods}`,
    record.summary ? `- 分析摘要: ${record.summary}` : '',
    record.recentSummary ? `- 最近表现: ${record.recentSummary}` : '',
    `- 最后分析: ${record.lastAnalyzed}`,
  ].filter(Boolean).join('\n');
}

// ── Tool loop: keep calling LLM until text response ──

export interface RequiredTool {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolLoopOptions {
  db: any;
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }>;
  tools: LlmTool[];
  userId: string;
  groupId?: string;
  sendMessage?: (event: any, text: string, extra?: any) => Promise<any>;
  event?: any;
  selfQq?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  label?: string;
  /** When set, execute this tool before the first LLM call. LLM only writes a short lead. */
  requiredTool?: RequiredTool;
}

export interface ToolLoopResult {
  text: string;
  usage: any;
  toolCallsMade: number;
  iterations: number;
  /** Image references/CQ codes are kept out of LLM messages and returned to the caller. */
  images: string[];
  /** Structured text that the caller must append verbatim after the short LLM lead. */
  directContent: string;
}

function sanitizeDirectDeliveryContent(content: string): string {
  return String(content || '')
    // Never allow an intercepted QQ bot to inject a second CQ operation. Images
    // are already carried in ToolResult.images and appended structurally.
    .replace(/\[CQ:[^\]]+\]/gi, '')
    .replace(/[A-Za-z]:[\\/][^\s,，。]*/g, '[路径已隐藏]')
    .replace(/\/[^\s,，。]+\/[^\s,，。]+/g, '[路径已隐藏]')
    .replace(/\\[^\s,，。]+\\[^\s,，。]+/g, '[路径已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export async function runToolLoop(
  completeChatFn: (db: any, options: any) => Promise<{ text: string; usage: any }>,
  options: ToolLoopOptions
): Promise<ToolLoopResult> {
  const {
    db, messages, tools, userId, groupId,
    sendMessage, event, selfQq,
    maxIterations = 5, temperature, maxTokens, model, label,
    requiredTool
  } = options;

  let currentMessages = [...messages];
  let totalUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  let toolCallsMade = 0;
  let iterations = 0;
  const collectedImages: string[] = [];
  const collectedDirectContent: string[] = [];

  // ── Required tool: execute before LLM, LLM only writes lead ──
  if (requiredTool) {
    iterations = 1;
    toolCallsMade = 1;

    const syntheticCall: LlmToolCall = {
      id: `required_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: requiredTool.toolName,
        arguments: JSON.stringify(requiredTool.args)
      }
    };

    const result = await executeToolCall(syntheticCall, {
      db, userId, groupId, sendMessage, event, selfQq
    });

    const safeContent = sanitizeToolResult(result.content);
    if (isSafeToolResult(safeContent)) {
      if (result.ok) {
        for (const image of result.images || []) {
          const imageRef = String(image || '').trim();
          if (imageRef && !collectedImages.includes(imageRef)) {
            collectedImages.push(imageRef);
          }
        }
        const dc = sanitizeDirectDeliveryContent(result.directContent || '');
        if (dc && isSafeToolResult(dc) && !collectedDirectContent.includes(dc)) {
          collectedDirectContent.push(dc);
        }
      }

      const hasDirect = result.ok &&
        ((result.images?.length || 0) > 0 || Boolean(collectedDirectContent.length));

      // Required protocol order: assistant(tool_calls) → tool(tool_call_id)
      currentMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: [syntheticCall]
      });
      currentMessages.push({
        role: 'tool',
        tool_call_id: syntheticCall.id,
        content: hasDirect
          ? `${safeContent}\n\n[交付说明：系统会在你的回复后原样附上完整结果。你可以根据上面的数据给出 pippi 的自然评价——说出你的真实看法，不用限制长度。但有一个硬规则：你引用的任何数字（PP、准确率、星数、combo）和 Mod 组合必须与上面工具返回的数据逐字一致，不准脑补、不准美化、不准四舍五入。]`
          : safeContent
      });
    } else {
      currentMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: [syntheticCall]
      });
      currentMessages.push({
        role: 'tool',
        tool_call_id: syntheticCall.id,
        content: '[工具结果被安全过滤器拦截]'
      });
    }

    // LLM turn — tools disabled, only writes a short lead
    let leadResponse;
    try {
      leadResponse = await completeChatFn(db, {
        messages: currentMessages,
        temperature,
        maxTokens,
        model,
        label: label ? `${label} [required lead]` : undefined
      });
    } catch {
      // Lead is cosmetic — return the direct payload without it
      return {
        text: '',
        usage: totalUsage,
        toolCallsMade,
        iterations,
        images: collectedImages,
        directContent: collectedDirectContent.join('\n\n')
      };
    }

    if (leadResponse.usage) {
      totalUsage.total_tokens += leadResponse.usage.total_tokens || 0;
      totalUsage.prompt_tokens += leadResponse.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += leadResponse.usage.completion_tokens || 0;
    }

    return {
      text: leadResponse.text,
      usage: totalUsage,
      toolCallsMade,
      iterations,
      images: collectedImages,
      directContent: collectedDirectContent.join('\n\n')
    };
  }

  while (iterations < maxIterations) {
    iterations++;
    const hasDirectPayload = collectedDirectContent.length > 0 || collectedImages.length > 0;

    let response;
    try {
      response = await completeChatFn(db, {
        messages: currentMessages,
        // A direct payload is already the requested product. The next model
        // turn is only a cosmetic lead, so tools must be disabled or some
        // providers will issue the same query_bot call again.
        tools: hasDirectPayload ? undefined : tools,
        tool_choice: hasDirectPayload ? undefined : 'auto',
        temperature,
        maxTokens,
        model,
        label: label ? `${label} [工具循环 ${iterations}]` : undefined
      });
    } catch (error) {
      // Once a trusted direct payload has been collected, the follow-up LLM is
      // only writing a cosmetic one-line lead. Never discard a complete panel
      // or image because that optional lead timed out; bot.ts will supply its
      // deterministic fallback. Initial calls and ordinary tools still fail
      // normally so errors are not hidden.
      if (collectedDirectContent.length > 0 || collectedImages.length > 0) {
        return {
          text: '',
          usage: totalUsage,
          toolCallsMade,
          iterations,
          images: collectedImages,
          directContent: collectedDirectContent.join('\n\n')
        };
      }
      throw error;
    }

    // Merge usage
    if (response.usage) {
      totalUsage.total_tokens += response.usage.total_tokens || 0;
      totalUsage.prompt_tokens += response.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += response.usage.completion_tokens || 0;
    }

    // Check for tool calls in the response
    const raw = (response as any).raw;
    const choice = raw?.choices?.[0];
    const message = choice?.message;

    // Tools were intentionally absent on this cosmetic lead turn. Even if a
    // non-conforming provider still emits tool_calls, never execute them after
    // the complete direct payload has already been obtained.
    if (hasDirectPayload) {
      return {
        text: response.text,
        usage: totalUsage,
        toolCallsMade,
        iterations,
        images: collectedImages,
        directContent: collectedDirectContent.join('\n\n')
      };
    }

    // If no tool calls, we have the final answer
    if (!message?.tool_calls?.length) {
      return {
        text: response.text,
        usage: totalUsage,
        toolCallsMade,
        iterations,
        images: collectedImages,
        directContent: collectedDirectContent.join('\n\n')
      };
    }

    // Process tool calls
    const toolCalls: LlmToolCall[] = message.tool_calls;

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: toolCalls
    });

    // Execute each tool call
    for (const tc of toolCalls) {
      const result = await executeToolCall(tc, {
        db, userId, groupId, sendMessage, event, selfQq
      });

      // Sanitize and validate result
      const safeContent = sanitizeToolResult(result.content);
      if (!isSafeToolResult(safeContent)) {
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '[工具结果被安全过滤器拦截]'
        });
        continue;
      }

      let acceptedDirectContent = '';
      if (result.ok) {
        for (const image of result.images || []) {
          const imageRef = String(image || '').trim();
          if (imageRef && !collectedImages.includes(imageRef)) {
            collectedImages.push(imageRef);
          }
        }

        const directContent = sanitizeDirectDeliveryContent(result.directContent || '');
        if (directContent && isSafeToolResult(directContent)) {
          acceptedDirectContent = directContent;
          if (!collectedDirectContent.includes(directContent)) {
            collectedDirectContent.push(directContent);
          }
        }
      }

      const hasDirectDelivery = Boolean(
        result.ok && ((result.images?.length || 0) > 0 || acceptedDirectContent)
      );
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: hasDirectDelivery
          ? `${safeContent}\n\n[交付说明：系统会在你的回复后原样附上完整结果。你可以根据上面的数据给出 pippi 的自然评价——说出你的真实看法，不用限制长度。但有一个硬规则：你引用的任何数字（PP、准确率、星数、combo）和 Mod 组合必须与上面工具返回的数据逐字一致，不准脑补、不准美化、不准四舍五入。]`
          : safeContent
      });

      toolCallsMade++;
    }
  }

  // Max iterations reached — ask LLM for final answer
  currentMessages.push({
    role: 'user',
    content: collectedDirectContent.length > 0 || collectedImages.length > 0
      ? '请给出一句简短、自然的引导或短评。完整工具结果会由系统原样附上，不要复述任何条目，也不要再调用工具。'
      : '请基于以上工具调用结果给出 pippi 的自然评价，不要再调用工具。'
  });

  let finalResponse;
  try {
    finalResponse = await completeChatFn(db, {
      messages: currentMessages,
      // Deliberately omit tools after the cap. A prompt alone cannot guarantee
      // that a tool-capable model will stop emitting calls.
      temperature,
      maxTokens,
      model,
      label: label ? `${label} [最终回答]` : undefined
    });
  } catch (error) {
    if (collectedDirectContent.length > 0 || collectedImages.length > 0) {
      return {
        text: '',
        usage: totalUsage,
        toolCallsMade,
        iterations,
        images: collectedImages,
        directContent: collectedDirectContent.join('\n\n')
      };
    }
    throw error;
  }

  if (finalResponse.usage) {
    totalUsage.total_tokens += finalResponse.usage.total_tokens || 0;
    totalUsage.prompt_tokens += finalResponse.usage.prompt_tokens || 0;
    totalUsage.completion_tokens += finalResponse.usage.completion_tokens || 0;
  }

  return {
    text: finalResponse.text,
    usage: totalUsage,
    toolCallsMade,
    iterations,
    images: collectedImages,
    directContent: collectedDirectContent.join('\n\n')
  };
}
