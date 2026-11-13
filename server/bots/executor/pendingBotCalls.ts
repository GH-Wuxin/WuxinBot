// External bot bridge: pending correlation, route draining, response settlement,
// and failure status stickers. Extracted from executor.ts without behavior changes.
import { loadRegistry } from '../registry.js';
import { stickerPath } from '../../bot/stickers/index.js';
import type { BotResponse } from '../types.js';

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
  drainPolicy?: PendingDrainPolicy;
}>();

const BOT_RESPONSE_TIMEOUT_MS = 20_000;
const BOT_TEXT_SETTLE_MS = 1_200;
const BOT_PROGRESS_SETTLE_MS = 10_000;
const BOT_IMAGE_DRAIN_MS = 2_000;
const BOT_TEXT_DRAIN_MS = 5_000;
const BOT_TIMEOUT_DRAIN_MS = 10_000;

/**
 * Route lifecycle drain. External QQ bots cannot echo our correlation id, so
 * after a pending call finishes we keep the route in a short draining window:
 * messages from the bot during this window are treated as tail messages of the
 * just-finished request and absorbed, and new calls on the same route are
 * rejected. This prevents a late response (e.g. after a timeout) from being
 * claimed by the next request.
 */
const routeDrainUntil = new Map<string, number>();
const routeDrainTimers = new Map<string, NodeJS.Timeout>();

function routeDrainKey(botId: string, channel: string, groupId?: string): string {
  return `${botId}\u0000${channel}\u0000${String(groupId || '')}`;
}

function setRouteDrain(key: string, drainMs: number): void {
  const existing = routeDrainTimers.get(key);
  if (existing) clearTimeout(existing);
  const drainUntil = Date.now() + drainMs;
  routeDrainUntil.set(key, drainUntil);
  const timer = setTimeout(() => {
    routeDrainUntil.delete(key);
    routeDrainTimers.delete(key);
  }, drainMs);
  timer.unref?.();
  routeDrainTimers.set(key, timer);
}

export interface PendingDrainPolicy {
  imageMs: number;
  textMs: number;
  timeoutMs: number;
}

type PendingBotCall = (typeof pendingBotCalls extends Map<string, infer T> ? T : never);

function boundedDelay(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(19_000, Math.round(parsed)));
}

export function responsePolicy(db: any, bot: any): {
  textSettleMs: number;
  progressSettleMs: number;
  progressKeywords: string[];
  imageDrainMs: number;
  textDrainMs: number;
  timeoutDrainMs: number;
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
    progressKeywords: progressKeywords.map((value: unknown) => String(value).trim()).filter(Boolean),
    imageDrainMs: boundedDelay(
      local.imageDrainMs ?? settings.botResponseImageDrainMs,
      BOT_IMAGE_DRAIN_MS
    ),
    textDrainMs: boundedDelay(
      local.textDrainMs ?? settings.botResponseTextDrainMs,
      BOT_TEXT_DRAIN_MS
    ),
    timeoutDrainMs: boundedDelay(
      local.timeoutDrainMs ?? settings.botResponseTimeoutDrainMs,
      BOT_TIMEOUT_DRAIN_MS
    ),
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

  // Late messages from the request we just finished can still arrive: a
  // timeout tail, a text->image panel, or a trailing caption. Keep the route
  // draining so those messages are absorbed instead of claiming the next call.
  const policy = entry.drainPolicy;
  const drainMs = timeoutWithoutContent
    ? (policy?.timeoutMs ?? BOT_TIMEOUT_DRAIN_MS)
    : (entry.images.length > 0
        ? (policy?.imageMs ?? BOT_IMAGE_DRAIN_MS)
        : (policy?.textMs ?? BOT_TEXT_DRAIN_MS));
  setRouteDrain(routeDrainKey(entry.botId, entry.channel, entry.groupId), drainMs);
  const substantive = entry.textParts.filter((part) => !part.progress).map((part) => part.text);
  const allText = entry.textParts.map((part) => part.text);
  const selectedText = substantive.length > 0
    ? substantive
    : (entry.images.length > 0 ? [] : allText);
  const text = [...new Set(selectedText)].join('\n').trim();
  const ok = Boolean(substantive.some(text => text.trim()) || entry.images.length > 0);
  entry.resolve({
    correlationId: entry.correlationId,
    botId: entry.botId,
    ok,
    text,
    images: [...entry.images],
    rawMessageId: entry.rawMessageId,
    error: ok ? undefined : '机器人未返回查询结果（仅进度或响应超时）'
  });
}

function schedulePendingSettlement(entry: PendingBotCall, delayMs: number): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = setTimeout(() => finishPendingBotCall(entry), delayMs);
}

// ── 工具失败 → 状态图 ──

/**
 * 把工具失败分类到对应的状态图。
 *
 * 为什么集中在这里：osu 层有 20+ 个抛错点（超时 / 5xx / 429 / 404 / 空数据 / 凭据缺失），
 * 在每个 throw 处各挂一次既散又容易漏。错误串本来就是用户可见文案的来源，在这里一处分类即可全覆盖。
 *
 * 配置缺失刻意返回 null（不发图）：那不是「服务挂了」，等不回来，要的是运维动作；
 * 发 service_down 会让用户以为等等就好。
 */
export function failureStickerFor(message: unknown): string | null {
  const m = String((message as any)?.message || message || '');
  if (/未配置|未设置|请在环境变量/.test(m)) return null;
  if (/资源不存在|不存在|没有可用|score_not_found|not_found/i.test(m)) return 'no_data';
  // 上游状态码有两种写法：osu 层是「osu! API 500 /path」，PP+ 是「认证 HTTP 500」。
  // 不写成裸的 /[45]\d\d/ —— 错误串里常带 pp 值、用户 ID 之类的数字，会误判。
  if (/超时|timeout|网络|请求失败|(?:API|HTTP)\s*[45]\d\d|\b429\b|不可用|认证失败|failed/i.test(m)) return 'service_down';
  return null;
}

/**
 * 给失败的 ToolResult 挂上状态图（走 deliverOnlyImages：只下发，不进会话媒体）。
 *
 * 注意这是**代码通路** —— 图不依赖 LLM，所以 LLM 挂掉时「服务挂了」这张照样发得出去。
 * 取不到图时原样返回，不影响失败结果本身。
 */
export function withFailureSticker<T extends Record<string, unknown>>(result: T, message: unknown): T {
  const id = failureStickerFor(message);
  if (!id) return result;
  const file = stickerPath(id);
  return file ? ({ ...result, deliverOnlyImages: [file] } as T) : result;
}

// ── Register a pending call ──

export function routeFailureToolMessage(botName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.startsWith('bot_route_draining')) {
    return `${botName} 上一条查询还在收尾，请稍等几秒再试。`;
  }
  return `向 ${botName} 发送指令失败: ${message}`;
}

export function registerPendingBotCall(
  request: {
    correlationId: string;
    botId: string;
    channel: 'qq_private' | 'qq_group';
    groupId?: string;
    drainPolicy?: PendingDrainPolicy;
  },
  timeoutMs: number = BOT_RESPONSE_TIMEOUT_MS
): Promise<BotResponse> {
  const { correlationId, botId, channel } = request;
  const groupId = request.groupId ? String(request.groupId) : undefined;
  const drainKey = routeDrainKey(botId, channel, groupId);
  const drainUntil = routeDrainUntil.get(drainKey);
  if (drainUntil !== undefined && Date.now() < drainUntil) {
    const remainingMs = drainUntil - Date.now();
    throw new Error(
      `bot_route_draining: ${botId}/${channel}${groupId ? `/${groupId}` : ''} (${Math.ceil(remainingMs / 1000)}s)`
    );
  }
  if (drainUntil !== undefined) {
    // Lazy cleanup in case a timer was lost; expired drains must not stick.
    routeDrainUntil.delete(drainKey);
    const staleTimer = routeDrainTimers.get(drainKey);
    if (staleTimer) {
      clearTimeout(staleTimer);
      routeDrainTimers.delete(drainKey);
    }
  }
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
      timeout: undefined as unknown as NodeJS.Timeout,
      drainPolicy: request.drainPolicy ?? {
        imageMs: BOT_IMAGE_DRAIN_MS,
        textMs: BOT_TEXT_DRAIN_MS,
        timeoutMs: BOT_TIMEOUT_DRAIN_MS,
      },
    };
    entry.timeout = setTimeout(() => finishPendingBotCall(entry, true), timeoutMs);
    pendingBotCalls.set(correlationId, entry);
  });
}

export function cancelPendingBotCall(correlationId: string): void {
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

  // While the route is draining, absorb messages from the bot as tail
  // responses of the previous request instead of resolving the next one.
  const draining = candidateBots.some((candidate) => {
    const until = routeDrainUntil.get(routeDrainKey(candidate.id, eventChannel, eventGroupId));
    return until !== undefined && Date.now() < until;
  });
  if (draining) return true;

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
  entry.drainPolicy = {
    imageMs: policy.imageDrainMs,
    textMs: policy.textDrainMs,
    timeoutMs: policy.timeoutDrainMs,
  };
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
