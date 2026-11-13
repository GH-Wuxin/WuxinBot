// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
// Reply output: sanitization, segmentation, merged-forward, rewrite guard.
// Extracted from bot.ts.
import { completeChat, thinkingParamsForLevel } from './llm.js';
import { buildRewriteEntry, classifyTimeout, recordRewriteTelemetry, textChanged } from './rewriteTelemetry.js';
import { updateDb } from '../store.js';
import { modelSupportsVision } from './prompt.js';
import { emptyTurnState, reasoningEnabledFor, reasoningInput } from './reasoningRouter.js';
import { looksLikeToolCallMarkup, stripToolCallMarkup } from '../bots/guard.js';
import { traceEvent } from '../requestTrace.js';
import { activeModelName } from '../modelConfig.js';

export function normalReplyRewriteSkipReason(options: {
  rewriteEligible: boolean;
  toolEvidenceProtected: boolean;
  hasDirectToolDelivery: boolean;
  longForm: boolean;
}): string | null {
  if (!options.rewriteEligible) return null;
  if (options.toolEvidenceProtected) return 'tool_evidence_invariant';
  if (options.hasDirectToolDelivery) return 'direct_tool_delivery';
  if (options.longForm) return 'long_form';
  return null;
}

export function sanitizeReply(text, settings) {
  // Model/user text must never create a QQ control segment. Host-owned CQ
  // codes (reply, @, image, sticker) are added by the delivery layer later.
  let cleaned = String(text || '')
    .replace(/\[CQ:[^\]]+\]/gi, ' ')
    .trim();
  const names = [
    '机器人',
    'bot',
    'Bot',
    'AI',
    ...String(settings.botNames || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  ];

  for (let i = 0; i < 3; i += 1) {
    const before = cleaned;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`^\\s*${escaped}\\s*[:：,，]\\s*`, 'i'), '');
    }
    cleaned = cleaned.replace(/^\s*(助手|群友|AI群友)\s*[:：,，]\s*/i, '');
    if (cleaned === before) break;
  }

  if (looksLikeToolCallMarkup(cleaned)) {
    cleaned = stripToolCallMarkup(cleaned);
  }

  return cleaned.trim();
}

export function splitReplySegments(text) {
  const cleaned = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');

  if (!cleaned) return [];
  if (cleaned.length <= 34 && !cleaned.includes('\n')) return [cleaned];

  // Spans that must survive segmentation intact: fenced code, inline code,
  // URLs and command invocations. Placeholders contain none of the punctuation
  // used by the splitter, so they cannot be cut in half.
  const protectedSpans = [];
  const protect = (value, pattern) => value.replace(pattern, (match) => {
    const token = `\u0000${protectedSpans.length}\u0000`;
    protectedSpans.push(match);
    return token;
  });
  let shielded = cleaned;
  shielded = protect(shielded, /```[\s\S]*?```/g);
  shielded = protect(shielded, /`[^`\n]+`/g);
  shielded = protect(shielded, /https?:\/\/[^\s<>"'，。！？；）】]+/g);
  shielded = protect(shielded, /![\w/]+(?:\s+[^\s，。！？；]+)?/g);
  shielded = protect(shielded, /\/w(?:uxin)?[^\s，。！？；\n]*/gi);

  let parts = shielded
    .split(/\n+|(?<=[。！？!?])\s*|(?<=[。！？!?])/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    parts = shielded
      .split(/(?<=[，,；;])\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (parts.length <= 1) return [cleaned];

  const restore = (value) => value.replace(/\u0000(\d+)\u0000/g, (_match, index) => (
    protectedSpans[Number(index)] ?? ''
  ));
  const segments = [];
  for (const part of parts) {
    const last = segments[segments.length - 1] || '';
    if (!last || restore(last).length + restore(part).length > 42 || segments.length >= 3) {
      segments.push(part);
    } else {
      segments[segments.length - 1] = `${last}${part}`;
    }
  }

  if (segments.length <= 3) return segments.map(restore);
  return [
    segments[0],
    segments[1],
    segments.slice(2).join('')
  ].filter(Boolean).map(restore);
}

/**
 * Only an actual @mention of Pippi should produce a QQ native reply. Natural
 * unsolicited group participation must stay as an ordinary group message;
 * otherwise every proactive interjection gets a distracting quote bubble.
 */
export function isDirectBotMention(event, settings = {}) {
  if (event?.source !== 'onebot' || event?.type !== 'group') return false;
  const botQq = String(settings?.selfQq || event?.raw?.self_id || '').trim();
  if (!botQq || !Array.isArray(event?.atTargets)) return false;
  return event.atTargets.some((qq) => String(qq) === botQq);
}

export function replyToCurrentMessageOptions(event, extra = {}) {
  const explicitReplyId = String(extra?.replyToMessageId || '').trim();
  if (event?.source !== 'onebot' || event?.type !== 'group' || !event?.messageId) return extra;
  if (event?.replyToCurrentMessage !== true && !explicitReplyId) return extra;
  return {
    ...extra,
    replyToMessageId: String(event.messageId),
    mentionSender: true,
  };
}

export async function sendReplySegments(sendMessage, event, replyText) {
  const segments = splitReplySegments(replyText).slice(0, 3);
  if (!sendMessage) return segments;
  for (let index = 0; index < segments.length; index += 1) {
    await sendMessage(
      event,
      segments[index],
      index === 0 ? replyToCurrentMessageOptions(event) : { suppressReply: true },
    );
  }
  return segments;
}

/**
 * Narrow identity guard. The legacy rewrite is no longer a style/length
 * classifier: only a reply that denies its own @ / reply target gets corrected.
 * Tone, punctuation, role-play and implementation wording are left to the
 * persona prompt and sanitization instead of a hidden second writer.
 */
export function isWeirdReply(text) {
  const value = String(text || '');
  const patterns = [
    /(没有|没)回应.*(at|@).*(不是|不).*(自己|我)/,
    /(没有|没)回应.*(at|@).*(其他|别人|群友)/,
    /(at|@).*(不是|不).*(自己|我|本)/,
    /(at|@).*(是|的是).*(其他|别人|群友)/,
    /刚才.*(at|@).*(不是|错)/,
    /你.*(at|@).*(别人|其他)/,
    /我.*(不该|不应该|不能).*(回复|回应|说话|插话)/,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

export function isIdentityQuestion(text) {
  const value = String(text || '')
    .replace(/\[CQ:at[^\]]+\]/g, '')
    .replace(/[？?！!。.，,\s]+$/g, '')
    .trim();
  return /^(我是谁[啊呀呢]?|你知道我是谁吗|知道我是谁吗|认得我吗|你认识我吗|我是哪位|我是哪个)$/i.test(value);
}

export function neutralIdentityReply(event, settings = {}) {
  const name = String(event.nickname || event.userId || '').trim() || String(event.userId || '这个账号');
  const qq = String(event.userId || '').trim();
  if (settings.ownerQq && qq && qq === String(settings.ownerQq)) {
    return `你是 ${name}（QQ:${qq}），我这边识别为最高权限用户。`;
  }
  return qq ? `你是 ${name}（QQ:${qq}），我这边按这个昵称识别。` : `你是 ${name}，我这边按这个昵称识别。`;
}

export async function rewriteNormalReply(db, originalText, event, options = {}) {
  const { reasoningRouter, turnId, completeChatFn = completeChat, telemetryWriteFn } = options;
  const rewriteInput = reasoningInput('rewrite', { previousFastFailure: true });
  let rewriteTurn = emptyTurnState();
  const rewriteDecision = reasoningRouter
    ? reasoningRouter.resolve(rewriteInput, rewriteTurn)
    : { level: 'off', source: 'rule', reasonCode: 'fast_default' };
  if (reasoningRouter) rewriteTurn = reasoningRouter.mergeTurn(rewriteTurn, rewriteDecision);
  const rewriteWire = thinkingParamsForLevel(rewriteDecision.level, reasoningEnabledFor(db));
  const startedAt = Date.now();
  traceEvent('REWRITE', 'reply_rewrite_started', {
    status: 'running',
    originalLength: String(originalText || '').length,
  });
  let response;
  let telemetryResult = 'ERROR_FALLBACK';
  try {
    response = await completeChatFn(db, {
      model: activeModelName(db.settings),
      messages: [
        {
          role: 'system',
          content: `只修正下面这句 QQ 群聊回复里的身份错误：否认自己收到 @、说自己不该回复，或把 @ 对象认错。
要求：
- 只输出修正后的回复，不要解释修改过程
- 保留原回复的其他内容、语气和长度；不要顺便改写文风
- 如果原回复没有身份错误，原样输出
- 不要提系统、后台、owner 等实现细节`
        },
        {
          role: 'user',
          content: `当前发言者：${event.nickname || event.userId}（QQ:${event.userId}）
原回复：${originalText}`
        }
      ],
      temperature: 0.25,
      maxTokens: 180,
      ...rewriteWire,
      label: '回复改写',
      traceRole: 'rewrite',
      tracePurpose: 'reply_rewrite',
    });
    const rewrittenText = String(response.text || originalText);
    const changed = textChanged(originalText, rewrittenText);
    telemetryResult = response.text
      ? (changed ? 'CHANGED' : 'UNCHANGED')
      : 'EMPTY_FALLBACK';
    response = { ...response, text: response.text || originalText };
  } catch (error) {
    telemetryResult = classifyTimeout(error) ? 'TIMEOUT_FALLBACK' : 'ERROR_FALLBACK';
    response = { text: originalText, usage: {} };
  }
  if (reasoningRouter && turnId) {
    reasoningRouter.record({
      turnId,
      ts: Date.now(),
      callRole: 'rewrite',
      decision: rewriteDecision,
      input: rewriteInput,
      actual: response?.meta || null,
    });
  }
  const usage = response?.usage || {};
  const usageAvailable = Boolean(
    Number.isFinite(usage.prompt_tokens ?? usage.input_tokens)
    || Number.isFinite(usage.completion_tokens ?? usage.output_tokens),
  );
  const telemetry = buildRewriteEntry({
    event,
    turnId,
    eligible: true,
    invoked: true,
    provider: response?.provider,
    model: response?.model,
    usage,
    usageAvailable,
    latencyMs: Date.now() - startedAt,
    result: telemetryResult,
    originalText,
    rewrittenText: response?.text || originalText,
  });
  await recordRewriteTelemetry(db, telemetry, telemetryWriteFn || updateDb);
  traceEvent('REWRITE', 'reply_rewrite_completed', {
    status: telemetryResult,
    durationMs: Date.now() - startedAt,
    changed: textChanged(originalText, response?.text || originalText),
    outputLength: String(response?.text || originalText).length,
  });
  return {
    text: response?.text || originalText,
    usage,
    telemetry,
  };
}

export function visualLimitationReply(event, db) {
  const canSee = db ? modelSupportsVision(db) : false;
  if (canSee) {
    // Vision-capable model but didn't get images this round (temporary limitation)
    if (event.text.includes('[表情') || event.text.includes('[图片]')) {
      return '这轮我没有拿到可读的图片内容。你重新发图或简单描述一下，我再接着聊。';
    }
    return '这轮我没有拿到可读的媒体内容。你描述一下内容，我可以继续接。';
  }
  // Text-only model: be honest about the permanent limitation
  return '我是文字模式，看不了图片和表情包。你可以用文字描述一下内容，我继续接。';
}

export async function sendForwardText(sendMessage, event, title, text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 260) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < line.length; index += 260) {
        chunks.push(line.slice(index, index + 260));
      }
      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > 260 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const nodes = chunks.map((content, index) => ({
    type: 'node',
    data: {
      name: index === 0 ? title : `${title} ${index + 1}`,
      uin: (event.raw?.self_id || 'REDACTED_QQ_005'),
      content
    }
  }));

  if (!sendMessage) return false;
  await sendMessage(event, title, { forwardNodes: nodes });
  return true;
}

export async function sendForwardBlocks(sendMessage, event, title, text) {
  const rawBlocks = String(text || '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks = [];
  for (const block of rawBlocks) {
    if (block.length <= 420) {
      chunks.push(block);
      continue;
    }
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    let current = '';
    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (current && next.length > 420) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
  }

  const nodes = chunks.map((content, index) => ({
    type: 'node',
    data: {
      name: index === 0 ? title : `${title} ${index + 1}`,
      uin: (event.raw?.self_id || 'REDACTED_QQ_005'),
      content
    }
  }));

  if (!sendMessage) return false;
  await sendMessage(event, title, { forwardNodes: nodes });
  return true;
}
