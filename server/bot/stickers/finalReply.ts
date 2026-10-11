import { listModelStickers } from './index.js';

export interface ParsedStickerReply {
  reply: string;
  stickerId: string | null;
  mode: 'none' | 'text_image' | 'image_only';
  structured: boolean;
}

/** OpenAI-compatible JSON mode; Codex receives the same contract as an adapter instruction. */
export const STICKER_REPLY_RESPONSE_FORMAT = { type: 'json_object' } as const;

export interface StickerReplyCapability {
  enabled: boolean;
  instruction: string | null;
  reason: 'enabled' | 'route' | 'off' | 'catalog_unavailable';
}

let cachedInstruction: string | null = null;

function compactStickerCatalog(): string {
  return listModelStickers()
    .map((entry) => {
      const bestFor = entry.visual?.bestFor?.slice(0, 3).join('/') || '一般轻松反应';
      const avoid = entry.visual?.avoid?.slice(0, 2).join('/') || '严肃场合';
      return `${entry.id} | ${entry.emotion} | ${entry.description} | 适合:${bestFor} | 避免:${avoid}`;
    })
    .join('\n');
}

export function buildStickerReplyInstruction(): string {
  if (cachedInstruction) return cachedInstruction;
  cachedInstruction = [
    '【最终回复格式】',
    '你现在处于最终回答阶段。决定结束本轮时，只输出一个 JSON 对象，不要输出 Markdown 代码块或额外解释。',
    '如果仍需要工具取证，优先使用结构化 tool_calls；不要把工具调用写进 reply。工具结果返回后，再输出最终 JSON。',
    'reply 是真正要发给用户的自然语言回复，使用当前对话语言；选择 image_only 时填写空字符串。',
    'mode 只能是 none、text_image 或 image_only：大多数回复用 none；文字仍有主要信息且表情只是辅助时用 text_image；图片本身即可完成轻松回应时才用 image_only。',
    'sticker_id 只能填写下面清单中的精确 ID，mode=none 时必须为 null。严肃查询、工具结果复述、错误说明和没有明显情绪时用 none。',
    '工具或系统状态确认（例如查询结果已返回、图片渲染完成/已发出、绑定成功、请求完成）默认用 none；只有当前语境明确需要庆祝、安慰或玩笑，且图片提供额外情绪价值时才用 text_image。尤其“图片渲染完成，结果已经发出”不得附加 received、hello 等确认贴纸。',
    'JSON 结构：{"reply":"...","mode":"none|text_image|image_only","sticker_id":null或"清单中的ID"}',
    '可选图片清单：',
    compactStickerCatalog(),
  ].join('\n');
  return cachedInstruction;
}

/**
 * Resolve the optional model-selected sticker protocol once per turn.
 * A broken optional catalogue must degrade to the ordinary text path instead
 * of escaping into the main model call. `buildInstruction` is injectable only
 * so the failure boundary itself can be tested without touching installed
 * sticker assets.
 */
export function resolveStickerReplyCapability(options: {
  eligible: boolean;
  deliveryMode: string;
  buildInstruction?: () => string;
}): StickerReplyCapability {
  if (!options.eligible) return { enabled: false, instruction: null, reason: 'route' };
  if (options.deliveryMode === 'off') return { enabled: false, instruction: null, reason: 'off' };
  try {
    const instruction = (options.buildInstruction || buildStickerReplyInstruction)();
    return instruction.trim()
      ? { enabled: true, instruction, reason: 'enabled' }
      : { enabled: false, instruction: null, reason: 'catalog_unavailable' };
  } catch {
    return { enabled: false, instruction: null, reason: 'catalog_unavailable' };
  }
}

function unwrapJsonText(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function jsonCandidates(value: string): string[] {
  const normalized = unwrapJsonText(value);
  const candidates = [normalized];
  const extracted: string[] = [];

  // Find bounded, balanced JSON objects in one pass instead of repeatedly
  // rescanning every opening brace. This handles valid JSON followed by a
  // model tail, ignores braces inside strings, and stays linear on malformed
  // or adversarial output.
  const starts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      starts.push(index);
      continue;
    }
    if (character === '}' && starts.length > 0) {
      const start = starts.pop()!;
      extracted.push(normalized.slice(start, index + 1));
      if (extracted.length > 8) extracted.shift();
    }
  }
  return [...candidates, ...extracted.reverse().filter((candidate) => candidate !== normalized)];
}

function malformedStickerReplyFallback(raw: string): string | null {
  const looksLikeEnvelope = /["']reply["']\s*:/u.test(raw)
    && /["'](?:mode|sticker_id)["']\s*:/u.test(raw);
  if (!looksLikeEnvelope) return null;

  // Recover only a complete JSON string value. If the reply itself is cut off,
  // use a stable neutral acknowledgement rather than exposing protocol text.
  const replyMatch = raw.match(/["']reply["']\s*:\s*("(?:\\.|[^"\\])*")/u);
  if (replyMatch) {
    try {
      const recovered = JSON.parse(replyMatch[1]);
      if (typeof recovered === 'string') return recovered.trim() || '收到。';
    } catch {
      // Fall through to the neutral protocol-error acknowledgement.
    }
  }
  return '收到。';
}

/**
 * Parse the final model envelope. Invalid output remains ordinary reply text
 * and never produces a sticker decision.
 */
export function parseStickerReply(value: unknown): ParsedStickerReply {
  const raw = String(value ?? '').trim();
  if (!raw) return { reply: '', stickerId: null, mode: 'none', structured: false };
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.reply !== 'string') {
        continue;
      }
      const requestedMode = parsed.mode === 'none' || parsed.mode === 'text_image' || parsed.mode === 'image_only'
        ? parsed.mode
        : null;
      const stickerId = parsed.sticker_id === null || parsed.sticker_id === undefined
        ? null
        : typeof parsed.sticker_id === 'string' && parsed.sticker_id.trim()
          ? parsed.sticker_id.trim()
          : null;
      const mode = requestedMode || (stickerId ? (parsed.reply.trim() ? 'text_image' : 'image_only') : 'none');
      if (mode === 'none' || !stickerId) {
        return { reply: parsed.reply.trim(), stickerId: null, mode: 'none', structured: true };
      }
      return {
        reply: mode === 'image_only' ? '' : parsed.reply.trim(),
        stickerId,
        mode,
        structured: true,
      };
    } catch {
      // Try the bounded object slice before treating the content as plain text.
    }
  }
  return {
    reply: malformedStickerReplyFallback(raw) ?? raw,
    stickerId: null,
    mode: 'none',
    structured: false,
  };
}

/** Add the final-output contract without modifying the caller's message array. */
export function withStickerReplyInstruction<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  instruction = buildStickerReplyInstruction(),
): T[] {
  const next = messages.map((message) => ({ ...message }));
  const systemIndex = next.findIndex((message) => message.role === 'system');
  if (systemIndex >= 0) {
    const system = next[systemIndex];
    next[systemIndex] = {
      ...system,
      content: `${String(system.content || '')}\n\n${instruction}`,
    };
  } else {
    next.unshift({ role: 'system', content: instruction } as T);
  }
  return next;
}
