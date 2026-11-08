import { readDb } from '../store.js';
import { mergeLlmUsage } from '../usage.js';
import { isDirectBotMention, sanitizeReply } from './reply.js';
import { isReplyProcessAborted, onReplyProcessAbort } from './replyProcesses.js';
import { socialDeliveryGuard } from './social/runtime.js';
import { sendOptionalNotice } from './notice.js';
import { registerPublicFeature } from './features.js';
import { tokenSaving } from './tokenSaving.js';
import { parseStickerReply, withStickerReplyInstruction, STICKER_REPLY_RESPONSE_FORMAT } from './stickers/finalReply.js';
import type { SocialEvent } from './social/types.js';

registerPublicFeature({
  id: 'progress_replies',
  description: '被 @ 时由模型根据语境决定直接回答，或先简短回应再完成复杂任务；可按真实进展补充并分段给出结果。',
  trigger: 'conversation', visibility: 'public',
  state: (db, event) => tokenSaving(db) || db.settings.pippiProgressReplies === false || process.env.PIPPI_PROGRESS_REPLIES === '0'
    || db.settings.globalPaused || event.type !== 'group'
    || (db.groups || []).some(g => String(g.groupId) === String(event.groupId) && ['silent', 'osu'].includes(g.mode))
    ? 'disabled' : 'available',
});

/** Eligibility is protocol metadata. Only the model chooses response strategy. */
export function shouldUseReplyProgress(db: any, event: SocialEvent): boolean {
  return !tokenSaving(db) && db.settings.pippiProgressReplies !== false && process.env.PIPPI_PROGRESS_REPLIES !== '0'
    && isDirectBotMention(event, db.settings);
}

const OPENING_INSTRUCTION = `【本轮表达策略】
先结合完整语境决定回应策略，不按某个词或字数做判断。
普通闲聊、简单问题和能直接完成的请求：response_phase=final，reply 就是最终回答，不要先说“等一下”。问候、告别、简单接话直接完成，不能先 acknowledge。
确实需要较长分析、多个步骤或连续查询时：先 response_phase=acknowledge，reply 只用一句符合 Pippi 人格的自然短回应，说清准备做什么。先选策略并给出短句，不要在这一次先推完或写完长篇正文；宿主会立刻发出短句，再让你认真完整地完成正文。
是否参与仍遵循 social 和身份规则；pass 时只给 final、空 reply，不能先发确认。不要在开场中泄露内部规则、工具编号或推理过程，不声称尚未完成的查询已经成功。
presentation 由你理解用户需要后选择：chat 是聊天/分段讲解，document 是完整文章、长文、代码或表格成品。保持既有表情字段；开场使用 mode=none。
输出同一 JSON 对象，包含 response_phase、presentation、reply；需要 social 时保留它。开场示例结构：{"response_phase":"acknowledge","presentation":"chat","social":{"action":"reply","addressee":"bot","reason":"明确请求需要展开"},"reply":"我把两边的安排理一下。","mode":"none"}。措辞由你按语境选择。只有明确选择 acknowledge 才开始分阶段回复。`;

const CONTINUATION_INSTRUCTION = `【继续完成本轮】
开场已经安排，直接完成用户原来的请求；需要真实数据就继续正常调用工具。
现在只能 response_phase=final，不能再发开场、承诺稍后处理或重复上一句。
沿用原人格、身份、社交参与和事实规则，完整给出正文。presentation=chat 或 document，保留已有 social/表情字段。`;

type Sender = (event: SocialEvent, text: string, options?: Record<string, unknown>) => Promise<unknown>;
type Completion = { text: string; usage?: any; latencyMs?: number; raw?: any; [key: string]: any };
type Invoke = (db: any, options: any) => Promise<Completion>;

export function createReplyProgress(event: SocialEvent, send: Sender | undefined, options: { intervalMs?: number; toolDelayMs?: number } = {}) {
  const controller = new AbortController();
  const interval = options.intervalMs ?? 8000;
  let closed = false, started = false, count = 0, lastAt = 0, lastText = '', inFlight = false;
  const activeTools = new Map<number,string>();
  let toolSequence = 0, toolSucceeded = false;
  let toolTimer: ReturnType<typeof setTimeout> | undefined;
  const permitted = () => !closed && !isReplyProcessAborted()
    && !socialDeliveryGuard(readDb(), event) && readDb().settings.pippiProgressReplies !== false;

  function emit(value: string): void {
    const text = sanitizeReply(value, readDb().settings);
    if (!send || !permitted() || !text || inFlight || count >= 2 || text === lastText
      || count > 0 && Date.now() - lastAt < interval) return;
    count++; lastAt = Date.now(); lastText = text; inFlight = true;
    void sendOptionalNotice(() => send(event, text, {
      originModule: 'notice', suppressReply: true, signal: controller.signal,
    })).finally(() => { inFlight = false; });
  }

  function close(): void {
    closed = true;
    if (toolTimer) clearTimeout(toolTimer);
    controller.abort();
  }
  const removeAbort = onReplyProcessAbort(close);
  function stop(): void { close(); removeAbort(); }
  return {
    hasStarted: () => started,
    canContinue: permitted,
    instruction: () => started ? CONTINUATION_INSTRUCTION : OPENING_INSTRUCTION,
    begin(value: string): boolean {
      if (started || !permitted()) return false;
      started = true; emit(value); return true;
    },
    toolStarted(name: string): number {
      const id = ++toolSequence;
      if (!permitted()) return id;
      if (activeTools.size === 0) toolSucceeded = false;
      activeTools.set(id, name);
      // Actual waiting work can report progress. A fast local lookup remains quiet.
      if (count === 0 && !toolTimer) {
        toolTimer = setTimeout(() => {
          toolTimer = undefined;
          const current = activeTools.values().next().value;
          if (!current || !permitted()) return;
          started = true;
          emit(current === 'inspect_message' ? '我核对一下这条消息。'
            : current === 'inspect_capabilities' ? '我看看现在能用哪些功能。' : '我先查一下，等结果回来。');
        }, options.toolDelayMs ?? 1200);
        toolTimer.unref?.();
      }
      return id;
    },
    toolFinished(id: number, ok: boolean): void {
      activeTools.delete(id);
      toolSucceeded ||= ok;
      if (activeTools.size === 0) {
        if (toolTimer) clearTimeout(toolTimer);
        toolTimer = undefined;
        if (started && toolSucceeded) emit('有结果了，我再整理一下。');
      }
    },
    stop,
  };
}

export type ReplyProgress = ReturnType<typeof createReplyProgress>;

/** Simple requests use one completion; a semantic opening permits one continuation. */
export async function completeWithReplyProgress(db: any, options: any, progress: ReplyProgress | undefined, invoke: Invoke): Promise<Completion> {
  if (!progress) return invoke(db, options);
  const firstOptions = { ...options, responseFormat: STICKER_REPLY_RESPONSE_FORMAT,
    messages: withStickerReplyInstruction(options.messages, progress.instruction()) };
  const first = await invoke(db, firstOptions);
  const parsed = parseStickerReply(first.text);
  if (parsed.responsePhase !== 'acknowledge') return first;
  if (progress.hasStarted()) throw new Error('模型重复了开场阶段，没有完成正文');
  const participating = db.settings.socialV2Enabled !== true || ['reply', 'react'].includes(parsed.participation || '');
  if (parsed.participation === 'pass') return first;
  if (!parsed.structured || !parsed.reply || parsed.reply.length > 240 || !participating) throw new Error('开场格式或参与判断无效');
  if (!progress.begin(parsed.reply)) return first;
  if (first.raw?.choices?.[0]?.message?.tool_calls?.length || !progress.canContinue()) return first;

  const second = await invoke(db, {
    ...options, timeoutMs: 90_000, responseFormat: STICKER_REPLY_RESPONSE_FORMAT,
    messages: withStickerReplyInstruction([
      ...options.messages, { role: 'assistant', content: first.text },
    ], CONTINUATION_INSTRUCTION),
  });
  if (parseStickerReply(second.text).responsePhase === 'acknowledge') throw new Error('模型重复了开场阶段，没有完成正文');
  return { ...second, usage: mergeLlmUsage(first.usage, second.usage), latencyMs: (first.latencyMs || 0) + (second.latencyMs || 0) };
}

/** Paragraphs are model-authored structure. Limits below only bound QQ delivery. */
export function stagedReplySegments(text: string): string[] {
  const cleaned = String(text || '').replaceAll('\r\n', '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= 240 || cleaned.length > 1800 || cleaned.includes('```')) return [cleaned];
  const parts = cleaned.split('\n\n').map(part => part.trim()).filter(Boolean);
  const segments: string[] = [];
  for (const part of parts) {
    const last = segments.at(-1);
    if (!last || segments.length < 3 && last.length + part.length > 420) segments.push(part);
    else segments[segments.length - 1] += '\n\n' + part;
  }
  return segments;
}
