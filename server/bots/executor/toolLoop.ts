// Tool loop: bounded model/tool iterations, evidence checks, budgets and final synthesis.
// Extracted from executor.ts without changing the public tool loop contract.
import { mergeLlmUsage } from '../../usage.js';
import { sanitizeToolResult, looksLikeToolCallMarkup, stripToolCallMarkup, parseToolCallMarkup } from '../guard.js';
import { buildV2ModelToolResult, normalizeAgentToolCall, osuCapabilityForToolCall } from '../agentToolContracts.js';
import { withStickerReplyInstruction } from '../../bot/stickers/finalReply.js';
import { normalizePlayerName } from '../playerName.js';
import { traceEvent } from '../../requestTrace.js';
import { thinkingParamsForLevel } from '../../bot/llm.js';
import type { LlmCompletionMeta } from '../../bot/llm.js';
import { emptyTurnState, reasoningEnabledFor, reasoningInput } from '../../bot/reasoningRouter.js';
import type { LlmCallRole, ReasoningDecision, ReasoningLevel, ReasoningInput, ReasoningShadowRecord, ReasoningShadowSink, ReasoningTurnState } from '../../bot/reasoningRouter.js';
import type { LlmTool, LlmToolCall, ToolResult } from '../types.js';

export interface RequiredTool {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * A model-first turn may plan freely, but it cannot finish normally until a
 * successful, safe tool result matching this requirement has been observed.
 */
export interface EvidenceRequirement extends RequiredTool {}

export interface ToolExecutionContext {
  db: any;
  userId: string;
  groupId?: string;
  sendMessage?: (event: any, text: string, extra?: any) => Promise<any>;
  event?: any;
  selfQq?: string;
}

export type ToolExecutor = (
  toolCall: LlmToolCall,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

// AGENT_TOOL_SURFACE_HARDENING_V01 A2 — hard tool-call budget.
// maxIterations only bounds LLM rounds. These two bounds are the real
// executor-side limits:
//   - per response: a single assistant message may dispatch at most 4 calls;
//   - per turn: a whole user/processIncoming turn may dispatch at most 8 calls
//     TOTAL across every runToolLoop invoked for that turn (bot.ts can run a
//     second requiredTool=recommend loop after the first; callers carry the
//     budget with toolCallsExecutedBeforeLoop).
// Evidence for the conservative values: replay fixtures and production seams
// observe 0..2 settled calls per turn (recommend/bp chains); 4/8 keeps every
// legitimate chain while bounding a malicious 100-call response. Excess calls
// are never executed: they receive a synthetic tool result and the loop goes
// straight to safe synthesis, preserving any direct payload already collected.
export const AGENT_MAX_TOOL_CALLS_PER_RESPONSE = 4;
export const AGENT_MAX_TOOL_CALLS_PER_TURN = 8;

export interface ToolLoopOptions {
  db: any;
  messages: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string }>;
  tools: LlmTool[];
  /**
   * 第二层（发图）工具。第一层整批执行完后，如果提供了这个列表，
   * 后续规划轮会切换成它；不提供就保持单层行为。
   */
  imageTools?: LlmTool[];
  /** Local self-inspection must not force a higher reasoning tier than plain chat. */
  lightweightToolsOnly?: boolean;
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
  /** Model-first evidence invariant. A bounded deterministic fallback runs if unmet. */
  evidenceRequirement?: EvidenceRequirement;
  /**
   * When true, the structured tool payload is returned verbatim for the caller
   * to append after the LLM lead (command-style delivery). When false (default,
   * natural chat), named-bot panels the executor tagged as direct-delivery
   * products (DIRECT_RESULT_COMMANDS / structured text panels) are still
   * returned verbatim; deterministic osu data routes and ordinary tool Q&A
   * stay inside the tool message and the LLM must integrate the key facts
   * into its own reply instead.
   */
  deliverDirectContent?: boolean;
  /** Keep the model in the planning loop after collecting a panel/image. */
  continueAfterDirectPayload?: boolean;
  /** Skip an identical successful call if the model repeats it in one loop. */
  deduplicateToolCalls?: boolean;
  /** Return typed evidence envelopes to the model instead of prose blobs. */
  structuredToolResults?: boolean;
  /** Optional response envelope requested only for the final synthesis call. */
  finalResponseFormat?: Record<string, unknown> | (() => Record<string, unknown> | undefined);
  /** Instruction paired with finalResponseFormat; never sent to planner turns. */
  finalResponseInstruction?: string | (() => string);
  /** Shadow reasoning: per-turn id + router. Recording only; never applied. */
  turnId?: string;
  reasoningRouter?: ReasoningShadowSink;
  /** Test seam for fully offline replay. Production defaults to executeToolCall. */
  executeToolCallFn?: ToolExecutor;
  /**
   * Tool calls already executed earlier in the SAME user/processIncoming turn
   * by a previous runToolLoop. bot.ts passes this when the recommendation hard
   * guard runs a second loop. Charged against AGENT_MAX_TOOL_CALLS_PER_TURN.
   */
  toolCallsExecutedBeforeLoop?: number;
}

export interface ToolLoopResult {
  text: string;
  usage: any;
  toolCallsMade: number;
  iterations: number;
  /** True when a query_osu recommend tool call completed successfully this turn. */
  recommendToolCalled: boolean;
  /** Image references/CQ codes are kept out of LLM messages and returned to the caller. */
  images: string[];
  /** Images delivered to QQ only; never persisted as conversation media. */
  deliverOnlyImages?: string[];
  /** Structured text that the caller must append verbatim after the short LLM lead. */
  directContent: string;
  /** A2 accounting: calls not executed because a hard cap was reached. */
  toolCallsSkippedByCap?: number;
  /** A2 accounting: true when either hard cap stopped execution this turn. */
  hardCapReached?: boolean;
  /** Total executed tool calls across all runToolLoop invocations of this turn. */
  toolCallsMadeThisTurn?: number;
  /** Whether this loop (including its bounded fallback) satisfied required evidence. */
  evidenceRequirementSatisfied?: boolean;
  /** True when the model did not satisfy evidence and the deterministic fallback ran. */
  evidenceFallbackExecuted?: boolean;
}

/** Preserve completed work when a caller starts a bounded corrective loop. */
export function mergeToolLoopResults(previous: ToolLoopResult, next: ToolLoopResult): ToolLoopResult {
  return {
    ...next,
    usage: mergeLlmUsage(previous.usage, next.usage),
    images: [...new Set([...(previous.images || []), ...(next.images || [])])],
    deliverOnlyImages: [...new Set([...(previous.deliverOnlyImages || []), ...(next.deliverOnlyImages || [])])],
    directContent: [...new Set([previous.directContent, next.directContent].filter(Boolean))].join('\n\n'),
    toolCallsMade: previous.toolCallsMade + next.toolCallsMade,
    iterations: previous.iterations + next.iterations,
    recommendToolCalled: previous.recommendToolCalled || next.recommendToolCalled,
    toolCallsSkippedByCap: (previous.toolCallsSkippedByCap || 0) + (next.toolCallsSkippedByCap || 0),
    hardCapReached: previous.hardCapReached || next.hardCapReached,
    evidenceRequirementSatisfied: previous.evidenceRequirementSatisfied || next.evidenceRequirementSatisfied,
    evidenceFallbackExecuted: previous.evidenceFallbackExecuted || next.evidenceFallbackExecuted,
  };
}

function parsedCanonicalToolArgs(toolCall: LlmToolCall): Record<string, unknown> {
  const canonical = normalizeAgentToolCall(toolCall);
  try {
    const parsed = JSON.parse(canonical.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function evidenceValueEquals(key: string, expected: unknown, actual: unknown): boolean {
  if (key === 'username') {
    return normalizePlayerName(String(expected || '')) === normalizePlayerName(String(actual || ''));
  }
  if (typeof expected === 'number' || typeof actual === 'number') {
    const left = Number(expected);
    const right = Number(actual);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return String(expected ?? '').trim().toLowerCase() === String(actual ?? '').trim().toLowerCase();
}

/** Match capability plus the detector's explicit constraints, not raw JSON ordering. */
function toolResultSatisfiesEvidence(
  requirement: EvidenceRequirement | undefined,
  toolCall: LlmToolCall,
  result: ToolResult,
): boolean {
  if (!requirement || !result.ok) return false;
  const canonical = normalizeAgentToolCall(toolCall);
  if (String(canonical.function.name || '') !== String(requirement.toolName || '')) return false;

  const callArgs = parsedCanonicalToolArgs(toolCall);
  const resultArgs = result.metadata?.args && typeof result.metadata.args === 'object'
    ? result.metadata.args as Record<string, unknown>
    : {};
  for (const [key, expected] of Object.entries(requirement.args || {})) {
    if (expected === undefined || key === 'compact') continue;
    const actual = resultArgs[key] ?? callArgs[key];
    if (actual === undefined || !evidenceValueEquals(key, expected, actual)) return false;
  }
  return true;
}

function sanitizeDirectDeliveryContent(content: string): string {
  const links: string[] = [];
  return String(content || '')
    // Never allow an intercepted QQ bot to inject a second CQ operation. Images
    // are already carried in ToolResult.images and appended structurally.
    .replace(/\[CQ:[^\]]+\]/gi, '')
    // Official osu! beatmap links are safe and useful; stash them in
    // slash-free placeholders before the path-hiding rules run.
    .replace(/(https?:\/\/osu\.ppy\.sh\/beatmaps\/\d+)/g, (match) => {
      links.push(match);
      return `__OSU_MAP_LINK_${links.length - 1}__`;
    })
    .replace(/[A-Za-z]:[\\/][^\s,，。]*/g, '[路径已隐藏]')
    .replace(/\/[^\s,，。]+\/[^\s,，。]+/g, '[路径已隐藏]')
    .replace(/\\[^\s,，。]+\\[^\s,，。]+/g, '[路径已隐藏]')
    .replace(/__OSU_MAP_LINK_(\d+)__/g, (_, index) => links[Number(index)])
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * Model responses that write tool invocations as literal XML/DSML text must
 * never reach the chat. When a direct payload (panel/image) already exists,
 * the lead is cosmetic and pure markup is dropped so the caller uses its
 * deterministic fallback lead. Without a payload, pure markup becomes a
 * neutral fallback instead of a silent failure.
 */
const TOOL_MARKUP_FALLBACK_TEXT = '这个问题我暂时答不上来，你换个说法，或者让我查点具体数据试试？';

function sanitizeToolReplyText(text: string): string {
  const raw = String(text || '');
  if (!looksLikeToolCallMarkup(raw)) return raw;
  return stripToolCallMarkup(raw);
}

function finalReplyText(text: string): string {
  const raw = String(text || '');
  if (!looksLikeToolCallMarkup(raw)) return raw;
  return stripToolCallMarkup(raw) || TOOL_MARKUP_FALLBACK_TEXT;
}

export async function runToolLoop(
  completeChatFn: (db: any, options: any) => Promise<{
    text: string;
    usage: any;
    meta?: LlmCompletionMeta;
    raw?: unknown;
  }>,
  options: ToolLoopOptions
): Promise<ToolLoopResult> {
  const {
    db, messages, tools, imageTools, userId, groupId,
    sendMessage, event, selfQq,
    maxIterations = 5, temperature, maxTokens, model, label,
    requiredTool, evidenceRequirement, deliverDirectContent = false,
    continueAfterDirectPayload = false, deduplicateToolCalls = false,
    structuredToolResults = false,
    finalResponseFormat,
    finalResponseInstruction,
  } = options;
  const executeToolCallFn = options.executeToolCallFn;
  if (typeof executeToolCallFn !== 'function') throw new Error('runToolLoop requires executeToolCallFn');
  // 阶段切换：第一层（文本）→ 第二层（图片）。模型看到的工具面在两轮之间变化。
  let activeTools = tools;
  let imagePhaseActive = false;
  const executeTracedToolCall = async (toolCall: any, toolContext: any) => {
    const startedAt = Date.now();
    const toolName = String(toolCall?.function?.name || 'unknown');
    let traceArguments = toolCall?.function?.arguments || {};
    try { traceArguments = JSON.parse(String(traceArguments)); } catch { /* redactor handles raw text */ }
    traceEvent('TOOL', 'tool_call_started', {
      status: 'running',
      toolCallId: toolCall?.id,
      toolName,
      arguments: traceArguments,
    });
    try {
      const result = await executeToolCallFn(toolCall, toolContext);
      traceEvent('TOOL', 'tool_call_completed', {
        status: result?.ok ? 'ok' : 'error',
        durationMs: Date.now() - startedAt,
        toolCallId: toolCall?.id,
        toolName,
        ok: Boolean(result?.ok),
        error: result?.error || '',
        contentLength: String(result?.content || '').length,
        imageCount: result?.images?.length || 0,
      });
      return result;
    } catch (error) {
      traceEvent('TOOL', 'tool_call_failed', {
        status: 'error',
        durationMs: Date.now() - startedAt,
        toolCallId: toolCall?.id,
        toolName,
        error: error?.message || String(error),
      });
      throw error;
    }
  };

  // Shared user-turn budget. The recommendation hard guard in bot.ts may run a
  // second runToolLoop after the first; each loop reports the turn total and
  // the caller feeds it back through toolCallsExecutedBeforeLoop.
  const parsedPriorCalls = Number(options.toolCallsExecutedBeforeLoop || 0);
  const toolCallsExecutedBeforeLoop = Number.isFinite(parsedPriorCalls)
    ? Math.max(0, Math.min(AGENT_MAX_TOOL_CALLS_PER_TURN, Math.floor(parsedPriorCalls)))
    : 0;
  const turnToolCallsMade = (): number =>
    Math.min(AGENT_MAX_TOOL_CALLS_PER_TURN, toolCallsExecutedBeforeLoop + toolCallsMade);

  let currentMessages = [...messages];
  let totalUsage: any = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  let toolCallsMade = 0;
  let iterations = 0;
  let recommendToolCalled = false;
  let lastToolFailed = false;
  let toolCallsSkippedByCap = 0;
  let hardCapReached = false;
  let evidenceRequirementSatisfied = false;
  const collectedImages: string[] = [];
  const collectedDeliverOnlyImages: string[] = [];
  const collectedDirectContent: string[] = [];
  const successfulToolCallSignatures = new Set<string>();

  const collectDeliverOnlyImages = (result: ToolResult | undefined): void => {
    for (const image of result?.deliverOnlyImages || []) {
      const imageRef = String(image || '').trim();
      if (imageRef && !collectedDeliverOnlyImages.includes(imageRef)) {
        collectedDeliverOnlyImages.push(imageRef);
      }
    }
  };

  const mergeEvidenceFallback = async (): Promise<ToolLoopResult> => {
    const fallback = await runToolLoop(completeChatFn, {
      ...options,
      messages: currentMessages,
      requiredTool: evidenceRequirement,
      evidenceRequirement,
      deliverDirectContent: deliverDirectContent || evidenceRequirement?.args?.capability === 'recommend',
      toolCallsExecutedBeforeLoop: turnToolCallsMade(),
    });
    const combinedImages = [...collectedImages];
    for (const image of fallback.images || []) {
      if (!combinedImages.includes(image)) combinedImages.push(image);
    }
    const combinedDirect = [...collectedDirectContent];
    if (fallback.directContent && !combinedDirect.includes(fallback.directContent)) {
      combinedDirect.push(fallback.directContent);
    }
    const combinedDeliverOnlyImages = [...collectedDeliverOnlyImages];
    for (const image of fallback.deliverOnlyImages || []) {
      if (image && !combinedDeliverOnlyImages.includes(image)) combinedDeliverOnlyImages.push(image);
    }
    return {
      ...fallback,
      usage: mergeLlmUsage(totalUsage, fallback.usage),
      toolCallsMade: toolCallsMade + fallback.toolCallsMade,
      iterations: iterations + fallback.iterations,
      recommendToolCalled: recommendToolCalled || fallback.recommendToolCalled,
      images: combinedImages,
      deliverOnlyImages: combinedDeliverOnlyImages,
      directContent: combinedDirect.filter(Boolean).join('\n\n'),
      toolCallsSkippedByCap: toolCallsSkippedByCap + (fallback.toolCallsSkippedByCap || 0),
      hardCapReached: hardCapReached || Boolean(fallback.hardCapReached),
      toolCallsMadeThisTurn: fallback.toolCallsMadeThisTurn ?? turnToolCallsMade(),
      evidenceRequirementSatisfied: Boolean(fallback.evidenceRequirementSatisfied),
      evidenceFallbackExecuted: true,
    };
  };

  const toolCallSignature = (toolCall: LlmToolCall): string => {
    const canonical = normalizeAgentToolCall(toolCall);
    let args: unknown = canonical.function.arguments || '{}';
    try {
      const parsed = JSON.parse(String(args));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = Object.fromEntries(Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)));
      } else {
        args = parsed;
      }
    } catch { /* raw arguments remain part of the signature */ }
    return `${canonical.function.name}:${JSON.stringify(args)}`;
  };
  const syntheticModelToolError = (toolCall: LlmToolCall, content: string, error: string): string =>
    structuredToolResults
      ? buildV2ModelToolResult(toolCall, {
          toolCallId: toolCall.id,
          ok: false,
          content,
          error,
        }, {
          safeContent: content,
          imageCount: 0,
          directContentAttached: false,
          nextStepHint: '该调用没有产生新证据。请使用已有证据、修正参数、改用其他工具，或在无法继续时明确说明。',
        })
      : content;
  const turnId = options.turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const reasoningRouter = options.reasoningRouter;
  let reasoningTurn: ReasoningTurnState = emptyTurnState();
  const reasoningRecords: ReasoningShadowRecord[] = [];
  const wireEnabled = reasoningEnabledFor(db);
  const wireForLevel = (level: ReasoningLevel) => thinkingParamsForLevel(level, wireEnabled);
  const decideCall = (
    callRole: LlmCallRole,
    input: ReasoningInput,
  ): ReasoningDecision => {
    const decision = reasoningRouter
      ? reasoningRouter.resolve(input, reasoningTurn)
      : { level: 'off', source: 'rule', reasonCode: 'fast_default' } as const;
    if (reasoningRouter) reasoningTurn = reasoningRouter.mergeTurn(reasoningTurn, decision);
    return decision;
  };
  const recordCall = (
    callRole: LlmCallRole,
    input: ReasoningInput,
    meta: LlmCompletionMeta | null,
    decision: ReasoningDecision,
  ): void => {
    if (!reasoningRouter) return;
    const record: ReasoningShadowRecord = {
      turnId,
      ts: Date.now(),
      callRole,
      decision,
      input,
      actual: meta,
    };
    reasoningRecords.push(record);
    reasoningRouter.record(record);
  };

  // ── Required tool: execute before LLM, LLM only writes lead ──
  if (requiredTool) {
    // The required call is part of the SAME user-turn budget. When a previous
    // loop already consumed the turn cap (recommendation hard guard case), the
    // deterministic tool must NOT execute and must not ask the LLM for a
    // fabricated answer.
    if (turnToolCallsMade() >= AGENT_MAX_TOOL_CALLS_PER_TURN) {
      console.warn(
        `[agent] requiredTool "${requiredTool.toolName}" refused: user-turn tool budget exhausted ` +
        `(${turnToolCallsMade()}/${AGENT_MAX_TOOL_CALLS_PER_TURN})`,
      );
      return {
        text: '本轮工具调用已达上限，这次查询没有执行，请稍后再试。',
        usage: totalUsage,
        toolCallsMade: 0,
        iterations: 0,
        recommendToolCalled: false,
        images: [],
        deliverOnlyImages: [],
        directContent: '',
        toolCallsSkippedByCap: 1,
        hardCapReached: true,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied: false,
      };
    }

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

    const result = await executeTracedToolCall(syntheticCall, {
      db, userId, groupId, sendMessage, event, selfQq
    });
    collectDeliverOnlyImages(result);
    if (
      result.ok &&
      requiredTool.toolName === 'query_osu' &&
      requiredTool.args.capability === 'recommend'
    ) {
      recommendToolCalled = true;
    }

    // Terminal deterministic reply (cooldown or failed fallback): deliver
    // verbatim and never let the LLM lead or comment on it.
    if (result.final) {
      const terminalSatisfied = toolResultSatisfiesEvidence(
        evidenceRequirement,
        syntheticCall,
        result,
      );
      if (evidenceRequirement && !terminalSatisfied && result.metadata?.terminal !== 'fallback_unavailable') {
        return {
          text: '[系统] 工具返回结果与本轮取证要求不匹配，无法生成有数据依据的回答。',
          usage: totalUsage,
          toolCallsMade: 1,
          iterations: 1,
          recommendToolCalled,
          images: [],
          deliverOnlyImages: collectedDeliverOnlyImages,
          directContent: '',
          toolCallsSkippedByCap: 0,
          hardCapReached: false,
          toolCallsMadeThisTurn: turnToolCallsMade(),
          evidenceRequirementSatisfied: false,
        };
      }
      return {
        text: '',
        usage: totalUsage,
        toolCallsMade: 1,
        iterations: 1,
        recommendToolCalled,
        images: result.images || [],
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: sanitizeDirectDeliveryContent(result.directContent || result.content),
        toolCallsSkippedByCap: 0,
        hardCapReached: false,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied: terminalSatisfied,
      };
    }

    // Deterministic routing owns failures: the LLM never gets a chance to
    // improvise a recommendation (or any data) when the tool itself failed.
    if (!result.ok) {
      return {
        text: String(result.content || '查询失败，请稍后再试。'),
        usage: totalUsage,
        toolCallsMade: 1,
        iterations: 1,
        recommendToolCalled,
        images: [],
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: '',
        toolCallsSkippedByCap: 0,
        hardCapReached: false,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied: false,
      };
    }

    const safeContent = sanitizeToolResult(result.content, result.metadata?.provider === 'osu-official' ? 40000 : result.metadata?.provider === 'pippi-self-inspection' ? 12000 : 4000);
    evidenceRequirementSatisfied = toolResultSatisfiesEvidence(
      evidenceRequirement,
      syntheticCall,
      result,
    );
    if (evidenceRequirement && !evidenceRequirementSatisfied) {
      return {
        text: '[系统] 工具返回结果与本轮取证要求不匹配，无法生成有数据依据的回答。',
        usage: totalUsage,
        toolCallsMade: 1,
        iterations: 1,
        recommendToolCalled,
        images: [],
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: '',
        toolCallsSkippedByCap: 0,
        hardCapReached: false,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied: false,
      };
    }
      if (result.ok) {
        for (const image of result.images || []) {
          const imageRef = String(image || '').trim();
          if (imageRef && !collectedImages.includes(imageRef)) {
            collectedImages.push(imageRef);
          }
        }
        // Deterministic natural-language osu routes keep the payload as
        // reference material for the LLM unless the caller opted into
        // command-style delivery (recommend). Panels from named-bot calls are
        // handled in the normal loop below, where the tool name is known.
        if (deliverDirectContent) {
          const dc = sanitizeDirectDeliveryContent(result.directContent || '');
          if (dc && !collectedDirectContent.includes(dc)) {
            collectedDirectContent.push(dc);
          }
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
      let toolNote = '';
      if (collectedDirectContent.length > 0) {
        toolNote = '[交付说明：系统会在你的回复后原样附上完整结果。你可以根据上面的数据给出 pippi 的自然评价——说出你的真实看法，不用限制长度。但有一个硬规则：你引用的任何数字（PP、准确率、星数、combo）和 Mod 组合必须与上面工具返回的数据逐字一致，不准脑补、不准美化、不准四舍五入。]';
      } else if (hasDirect) {
        toolNote = deliverDirectContent
          ? '[结果图片会由系统附上。请给出一句简短、自然的引导或短评，不要复述任何条目。]'
          : '[结果图片会由系统附上。你可以自然点评这张图，但不要把工具返回的原始数据整段贴出来。]';
      } else if (result.ok) {
        toolNote = deliverDirectContent
          ? ''
          : '[数据仅供你参考：请把关键信息自然地融入回答，不要贴完整原始报表，也不要逐条复述条目；禁止用“查好了/看完了”之类的空话代替实际内容。结果图片（如有）会由系统附上。]';
      }
      currentMessages.push({
        role: 'tool',
        tool_call_id: syntheticCall.id,
        content: toolNote ? `${safeContent}\n\n${toolNote}` : safeContent
      });


    const noDirectPayload = collectedImages.length === 0 && collectedDirectContent.length === 0;
    const leadRole: LlmCallRole = noDirectPayload ? 'tool_synthesis' : 'decorative_lead';
    // Keep complete source lines: do not cut numbers or fabricate a summary.
    const sourceLines = sanitizeDirectDeliveryContent(safeContent)
      .split('\n')
      .filter((line) => line.trim() && line.length <= 400)
      .slice(0, 6);
    const synthesisFallback = noDirectPayload && sourceLines.length
      ? `自动整理失败，以下为已查询到的数据摘录：\n${sourceLines.join('\n')}`
      : (noDirectPayload ? '[系统] 已完成查询，但结果为空，请稍后重试。' : '');
    const leadInput = reasoningInput(leadRole, {
      requiredTool: true,
      toolSelectionRequired: false,
      toolCallsMade: 1,
      iterations: 1,
      maxIterations,
      hasDirectPayload: !noDirectPayload,
    });
    const leadDecision = decideCall(leadRole, leadInput);
    let leadResponse;
    try {
      leadResponse = await completeChatFn(db, {
        messages: currentMessages,
        temperature,
        maxTokens,
        model,
        ...wireForLevel(leadDecision.level),
        label: label ? `${label} [required lead]` : undefined,
        traceRole: leadRole,
        tracePurpose: 'required_tool_lead',
      });
    } catch {
      // Only a real direct payload makes the LLM text optional.
      return {
        text: synthesisFallback,
        usage: totalUsage,
        toolCallsMade,
        iterations,
        recommendToolCalled,
        images: collectedImages,
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: collectedDirectContent.join('\n\n'),
        toolCallsSkippedByCap: 0,
        hardCapReached: false,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied,
      };
    }

    recordCall(leadRole, leadInput, leadResponse?.meta || null, leadDecision);

    if (leadResponse.usage) {
      totalUsage = mergeLlmUsage(totalUsage, leadResponse.usage);
    }

    let leadText = sanitizeToolReplyText(leadResponse.text);
    if (!leadText && looksLikeToolCallMarkup(String(leadResponse.text || '')) && noDirectPayload) {
      // The lead came back as pure tool-call markup and there is no direct
      // payload to fall back on: retry once with an explicit corrective turn
      // so the query result is not silently lost behind "查好了。"-style text.
      currentMessages.push({
        role: 'user',
        content: '[系统] 你上一条只输出了工具调用标记，用户什么都没收到。请直接用自然语言给出简短评价或说明，禁止输出任何 XML/DSML/tool_calls/invoke/parameter 文本。',
      });
      try {
        const retryResponse = await completeChatFn(db, {
          messages: currentMessages,
          temperature,
          maxTokens,
          model,
          ...wireForLevel(leadDecision.level),
          label: label ? `${label} [required lead retry]` : undefined,
          traceRole: leadRole,
          tracePurpose: 'required_tool_lead_retry',
        });
        recordCall(leadRole, leadInput, retryResponse?.meta || null, leadDecision);
        if (retryResponse.usage) {
          totalUsage = mergeLlmUsage(totalUsage, retryResponse.usage);
        }
        leadText = sanitizeToolReplyText(retryResponse.text);
      } catch {
        leadText = '';
      }
    }

    return {
      text: leadText || synthesisFallback,
      usage: totalUsage,
      toolCallsMade,
      iterations,
      recommendToolCalled,
      images: collectedImages,
      deliverOnlyImages: collectedDeliverOnlyImages,
      directContent: collectedDirectContent.join('\n\n'),
      toolCallsSkippedByCap: 0,
      hardCapReached: false,
      toolCallsMadeThisTurn: turnToolCallsMade(),
      evidenceRequirementSatisfied,
    };
  }

  while (iterations < maxIterations) {
    iterations++;
    const hasDirectPayload = collectedDirectContent.length > 0 || collectedImages.length > 0;
    const directPayloadIsTerminal = hasDirectPayload && !continueAfterDirectPayload &&
      (!evidenceRequirement || evidenceRequirementSatisfied);

    // A5 — previousToolFailed is batch/turn-level sticky: it means "at least
    // one tool failed since the last planner decision", not "the single most
    // recent tool failed". Consume the snapshot for this planner input, then
    // reset; the executor loop below re-accumulates failures for the next
    // planner round.
    const previousToolFailed = lastToolFailed;
    lastToolFailed = false;

    const plannerInput = reasoningInput(directPayloadIsTerminal ? 'decorative_lead' : options.lightweightToolsOnly ? 'conversation' : 'tool_planner', {
      requiredTool: false,
      toolSelectionRequired: !options.lightweightToolsOnly && !directPayloadIsTerminal && Array.isArray(tools) && tools.length > 0,
      toolCallsMade,
      iterations,
      maxIterations,
      hasDirectPayload,
      previousToolFailed,
    });
    const plannerDecision = decideCall(plannerInput.callRole, plannerInput);
    const plannerWire = wireForLevel(plannerDecision.level);
    const thinkingOn = plannerWire.thinking?.type === 'enabled';
    // A model may finish immediately after a tool result, before the bounded
    // final-synthesis fallback. Give that finishing path the same envelope
    // contract without adding another model request. Tool calls still take
    // precedence when the model decides more evidence is needed.
    const finishingInstruction = typeof finalResponseInstruction === 'function' ? finalResponseInstruction() : finalResponseInstruction;
    const plannerMessages = finishingInstruction
      ? withStickerReplyInstruction(currentMessages, `${finishingInstruction}\n如果仍需要工具，先使用结构化 tool_calls；只有决定结束本轮时才输出上面的 JSON。`)
      : currentMessages;
    let response;
    try {
      response = await completeChatFn(db, {
        messages: plannerMessages,
        // A direct payload is already the requested product. The next model
        // turn is only a cosmetic lead, so tools must be disabled or some
        // providers will issue the same query_bot call again.
        tools: directPayloadIsTerminal ? undefined : activeTools,
        // Contract A: with tools present, auto is already the default, so
        // omit tool_choice on thinking calls; keep explicit auto on fast calls.
        tool_choice: directPayloadIsTerminal || thinkingOn ? undefined : 'auto',
        ...plannerWire,
        temperature,
        maxTokens,
        model,
        label: label ? `${label} [工具循环 ${iterations}]` : undefined,
        ...(options.lightweightToolsOnly && !thinkingOn ? { responseFormat: typeof finalResponseFormat === 'function' ? finalResponseFormat() : finalResponseFormat } : {}),
        ...(options.lightweightToolsOnly ? { promptModule: 'conversation' } : {}),
        traceRole: plannerInput.callRole,
        tracePurpose: directPayloadIsTerminal ? 'tool_result_lead' : 'tool_planning',
        retainToolsOnEmpty: Boolean(evidenceRequirement && !evidenceRequirementSatisfied),
      });
    } catch (error) {
      // Once a trusted direct payload has been collected, the follow-up LLM is
      // only writing a cosmetic one-line lead. Never discard a complete panel
      // or image because that optional lead timed out; bot.ts will supply its
      // deterministic fallback. Initial calls and ordinary tools still fail
      // normally so errors are not hidden.
      if (collectedDirectContent.length > 0 || collectedImages.length > 0) {
        if (evidenceRequirement && !evidenceRequirementSatisfied) {
          return mergeEvidenceFallback();
        }
        return {
          text: '',
          usage: totalUsage,
          toolCallsMade,
          iterations,
          recommendToolCalled,
          images: collectedImages,
          deliverOnlyImages: collectedDeliverOnlyImages,
          directContent: collectedDirectContent.join('\n\n'),
          toolCallsSkippedByCap,
          hardCapReached,
          toolCallsMadeThisTurn: turnToolCallsMade(),
          evidenceRequirementSatisfied,
        };
      }
      throw error;
    }

    recordCall(plannerInput.callRole, plannerInput, response?.meta || null, plannerDecision);

    // Merge usage
    if (response.usage) {
      totalUsage = mergeLlmUsage(totalUsage, response.usage);
    }

    // Check for tool calls in the response
    const raw = (response as any).raw;
    const choice = raw?.choices?.[0];
    const message = choice?.message;

    // Tools were intentionally absent on this cosmetic lead turn. Even if a
    // non-conforming provider still emits tool_calls, never execute them after
    // the complete direct payload has already been obtained.
    if (directPayloadIsTerminal) {
      return {
        text: sanitizeToolReplyText(response.text),
        usage: totalUsage,
        toolCallsMade,
        iterations,
        recommendToolCalled,
        images: collectedImages,
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: collectedDirectContent.join('\n\n'),
        toolCallsSkippedByCap,
        hardCapReached,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied,
      };
    }

    // Structured tool calls are the primary protocol. Some providers also (or
    // instead) emit the invocation as XML/DSML text in `content`; parse that
    // markup so it goes through the same validated executor instead of being
    // returned to the user verbatim.
    let toolCalls: LlmToolCall[] = message?.tool_calls || [];
    if (!toolCalls.length && looksLikeToolCallMarkup(response.text || '')) {
      const parsed = parseToolCallMarkup(response.text || '');
      if (parsed.length) {
        // Only tool names exposed in this round's schema may be routed from
        // text markup. Unknown names are dropped: a model cannot summon a tool
        // that was never offered in this loop.
        const exposedNames = new Set(
          (activeTools || []).map((tool: LlmTool) => tool?.function?.name).filter((name: unknown): name is string => Boolean(name)),
        );
        const allowed = parsed.filter((call) => exposedNames.has(call.name));
        toolCalls = allowed.map((call, index) => ({
          id: `dsml_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args || {})
          }
        }));
      }
    }

    if (structuredToolResults) {
      traceEvent('TOOL', 'agent_planner_decision', {
        status: toolCalls.length > 0 ? 'running' : 'ok',
        iteration: iterations,
        decision: toolCalls.length > 0 ? 'call_tools' : 'finish',
        toolNames: toolCalls.map((call) => call.function?.name || 'unknown'),
        evidenceMessagesAvailable: currentMessages.filter((item) => item.role === 'tool').length,
      });
    }

    // If no tool calls (structured or parsed), we have the final answer.
    if (!toolCalls.length) {
      if (evidenceRequirement && !evidenceRequirementSatisfied) {
        return mergeEvidenceFallback();
      }
      return {
        text: finalReplyText(response.text),
        usage: totalUsage,
        toolCallsMade,
        iterations,
        recommendToolCalled,
        images: collectedImages,
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: collectedDirectContent.join('\n\n'),
        toolCallsSkippedByCap,
        hardCapReached,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied,
      };
    }

    // Add assistant message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: message?.content || '',
      tool_calls: toolCalls,
      // DeepSeek thinking contract: preserve reasoning_content on the
      // assistant tool_calls message so the next tool-result round carries it.
      ...(typeof message?.reasoning_content === 'string' && message.reasoning_content
        ? { reasoning_content: message.reasoning_content }
        : {})
    });

    // A2 — hard tool-call budget. Never trust maxIterations to bound the work:
    // a single response may contain an arbitrary number of tool_calls. The
    // executable allowance for this batch is min(per-response cap, remaining
    // SHARED turn budget); everything beyond it gets a synthetic "not executed"
    // result so the assistant/tool message alternation stays balanced.
    const turnRemaining = Math.max(0, AGENT_MAX_TOOL_CALLS_PER_TURN - turnToolCallsMade());
    const executableThisResponse = Math.min(AGENT_MAX_TOOL_CALLS_PER_RESPONSE, turnRemaining);
    const overflowThisResponse = Math.max(0, toolCalls.length - executableThisResponse);
    if (overflowThisResponse > 0) {
      toolCallsSkippedByCap += overflowThisResponse;
      hardCapReached = true;
      console.warn(
        `[agent] tool-call hard cap reached: ${toolCalls.length} call(s) in this response, ` +
        `executed ${turnToolCallsMade()}/${AGENT_MAX_TOOL_CALLS_PER_TURN} this user turn so far, ` +
        `executing ${executableThisResponse}, skipping ${overflowThisResponse} ` +
        `(per-response ${AGENT_MAX_TOOL_CALLS_PER_RESPONSE}, per-turn ${AGENT_MAX_TOOL_CALLS_PER_TURN})`,
      );
    }

    // 只读的 osu 工具在一批里互不依赖，先并发发出去，循环里按顺序消费。
    // 记账、去重、证据判定、final 短路仍然只发生在下面这一个单点上。
    const prefetchedResults = new Map<string, Promise<any>>();
    const batchDuplicateIds = new Set<string>();
    if (deduplicateToolCalls) {
      const seen = new Set<string>();
      for (const call of toolCalls.slice(0, executableThisResponse)) {
        const signature = toolCallSignature(call);
        if (seen.has(signature) || successfulToolCallSignatures.has(signature)) batchDuplicateIds.add(call.id);
        seen.add(signature);
      }
    }
    {
      const candidates = toolCalls
        .slice(0, executableThisResponse)
        .filter((call) => {
          if (batchDuplicateIds.has(call.id)) return false;
          const capability = String(osuCapabilityForToolCall(call) || '');
          // 发图工具必须串行：渲染服务是单客户端管道，并发只会互相排队。
          const isImageCapability = capability === 'score_image' || capability.endsWith('_image');
          return capability !== 'recommend' && capability !== 'match' && !isImageCapability;
        });
      if (candidates.length > 1) {
        for (const call of candidates) {
          prefetchedResults.set(
            call.id,
            executeTracedToolCall(call, { db, userId, groupId, sendMessage, event, selfQq }),
          );
        }
        traceEvent('TOOL', 'tool_batch_parallel', { status: 'running', count: candidates.length });
      }
    }

    // Execute each tool call
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const tc = toolCalls[callIndex];
      if (callIndex >= executableThisResponse) {
        const skippedByResponse = callIndex >= AGENT_MAX_TOOL_CALLS_PER_RESPONSE;
        const content = `[系统] 达到工具调用上限（${skippedByResponse ? '单轮响应' : '本轮总计'}），此调用未执行。`;
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: syntheticModelToolError(tc, content, 'TOOL_CALL_LIMIT_REACHED')
        });
        continue;
      }

      let callDeliversDirect = deliverDirectContent;
      if (!callDeliversDirect) {
        callDeliversDirect = osuCapabilityForToolCall(tc) === 'recommend';
      }

      const callSignature = toolCallSignature(tc);
      if (deduplicateToolCalls && (successfulToolCallSignatures.has(callSignature) || batchDuplicateIds.has(tc.id))) {
        traceEvent('TOOL', 'tool_call_duplicate_skipped', {
          status: 'skipped',
          toolCallId: tc.id,
          toolName: tc.function?.name || '',
        });
        const content = '[系统] 完全相同的工具调用本轮已经派发；本次未重复执行。请使用对应结果继续判断，或修改参数后再调用。';
        currentMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: syntheticModelToolError(tc, content, 'DUPLICATE_TOOL_CALL_SKIPPED'),
        });
        continue;
      }

      const prefetched = prefetchedResults.get(tc.id);
      const result = prefetched
        ? await prefetched
        : await executeTracedToolCall(tc, { db, userId, groupId, sendMessage, event, selfQq });
      collectDeliverOnlyImages(result);
      // Accounting is tied to the executor boundary, not to whether its
      // returned content is safe enough to expose to the LLM. Reaching this
      // line means one tool call actually executed and settled with a result.
      toolCallsMade++;
      lastToolFailed = lastToolFailed || !result.ok;
      if (result.ok && deduplicateToolCalls) successfulToolCallSignatures.add(callSignature);
      if (result.ok && !recommendToolCalled) {
        recommendToolCalled = osuCapabilityForToolCall(tc) === 'recommend';
      }

      const safeContent = sanitizeToolResult(result.content, result.metadata?.provider === 'osu-official' ? 40000 : result.metadata?.provider === 'pippi-self-inspection' ? 12000 : 4000);
      if (toolResultSatisfiesEvidence(evidenceRequirement, tc, result)) {
        evidenceRequirementSatisfied = true;
      }

      // Terminal deterministic reply: stop the loop immediately and deliver
      // verbatim; the LLM never sees the result and cannot add claims.
      if (result.final) {
        if (evidenceRequirement && !evidenceRequirementSatisfied && result.metadata?.terminal !== 'fallback_unavailable') {
          return mergeEvidenceFallback();
        }
        const finalDirect = sanitizeDirectDeliveryContent(result.directContent || result.content);
        return {
          text: '',
          usage: totalUsage,
          toolCallsMade,
          iterations,
          recommendToolCalled,
          images: [...new Set([...collectedImages, ...(result.images || [])])],
          deliverOnlyImages: collectedDeliverOnlyImages,
          directContent: [...collectedDirectContent, finalDirect].filter(Boolean).join('\n\n'),
          toolCallsSkippedByCap,
          hardCapReached,
          toolCallsMadeThisTurn: turnToolCallsMade(),
          evidenceRequirementSatisfied,
        };
      }

      let acceptedDirectContent = '';
      if (result.ok) {
        for (const image of result.images || []) {
          const imageRef = String(image || '').trim();
          if (imageRef && !collectedImages.includes(imageRef)) {
            collectedImages.push(imageRef);
          }
        }

        // Named-bot (query_bot) results tagged as direct-delivery products are
        // panels from an explicitly invoked bot and must be delivered verbatim
        // even in natural chat: the LLM only writes a short lead and is never
        // asked to reconstruct the panel (that caused the truncated "#2 Sid..."
        // regression). Deterministic query_osu natural routes stay reference-
        // only unless callDeliversDirect opts into command-style delivery.
        const isNamedBotTool = String(tc.function?.name || '') === 'query_bot';
        if (callDeliversDirect || (isNamedBotTool && result.directContent)) {
          const directContent = sanitizeDirectDeliveryContent(result.directContent || '');
          if (directContent) {
            acceptedDirectContent = directContent;
            if (!collectedDirectContent.includes(directContent)) {
              collectedDirectContent.push(directContent);
            }
          }
        }
      }

      const hasDirectDelivery = Boolean(
        result.ok && ((result.images?.length || 0) > 0 || acceptedDirectContent)
      );
      let toolNote = '';
      if (acceptedDirectContent) {
        toolNote = '[交付说明：系统会在你的回复后原样附上完整结果。你可以根据上面的数据给出 pippi 的自然评价——说出你的真实看法，不用限制长度。但有一个硬规则：你引用的任何数字（PP、准确率、星数、combo）和 Mod 组合必须与上面工具返回的数据逐字一致，不准脑补、不准美化、不准四舍五入。]';
      } else if (hasDirectDelivery) {
        toolNote = deliverDirectContent
          ? '[结果图片会由系统附上。请给出一句简短、自然的引导或短评，不要复述任何条目。]'
          : continueAfterDirectPayload
            ? '[结果图片会由系统附上。先判断任务是否还需要其他证据：需要就继续调用工具，足够了再自然回答；不要整段复述原始数据。]'
            : '[结果图片会由系统附上。你可以自然点评这张图，但不要把工具返回的原始数据整段贴出来。]';
      } else if (result.ok) {
        toolNote = deliverDirectContent
          ? ''
          : '[数据仅供你参考：请把关键信息自然地融入回答，不要贴完整原始报表，也不要逐条复述条目；禁止用“查好了/看完了”之类的空话代替实际内容。结果图片（如有）会由系统附上。]';
      }
      const modelToolContent = structuredToolResults
        ? buildV2ModelToolResult(tc, result, {
            safeContent,
            imageCount: result.ok ? (result.images?.length || 0) : 0,
            directContentAttached: Boolean(acceptedDirectContent),
            nextStepHint: toolNote || undefined,
          })
        : toolNote ? `${safeContent}\n\n${toolNote}` : safeContent;
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: modelToolContent
      });
      if (structuredToolResults) {
        traceEvent('TOOL', 'tool_evidence_returned_to_model', {
          status: result.ok ? 'ok' : 'error',
          iteration: iterations,
          toolCallId: tc.id,
          toolName: tc.function?.name || '',
          capability: osuCapabilityForToolCall(tc) || null,
          evidenceLength: safeContent.length,
          imageCount: result.ok ? (result.images?.length || 0) : 0,
          directContentAttached: Boolean(acceptedDirectContent),
          modelWillDecideAgain: true,
        });
      }
    }

    // 第一层整批执行完后切到第二层：模型下一轮只会看到发图工具；
    // 它不调用就正常结束，不会为了出图而出图。
    if (!imagePhaseActive && imageTools && imageTools.length > 0) {
      imagePhaseActive = true;
      // 图片工具排在前面，但保留文本工具：像"先查 BP1、再查这张图星数"
      // 这种链式查询需要第二轮还能取数，否则能力会倒退。
      activeTools = [...imageTools, ...tools];
      traceEvent('TOOL', 'tool_phase_switched', {
        status: 'ok',
        phase: 'image',
        toolCount: imageTools.length,
      });
    }

    // A2 — once either hard cap has been tripped, stop accepting model
    // decisions. All outstanding calls in this batch already received a
    // synthetic "not executed" result, so the message history stays balanced
    // and we fall straight through to final synthesis.
    if (hardCapReached) break;
  }

  if (evidenceRequirement && !evidenceRequirementSatisfied) {
    return mergeEvidenceFallback();
  }

  // Max iterations reached — ask LLM for final answer
  let finalPrompt: string;
  if (collectedDirectContent.length > 0) {
    finalPrompt = '请给出一句简短、自然的引导或短评。完整工具结果会由系统原样附上，不要复述任何条目，也不要再调用工具。';
  } else if (collectedImages.length > 0) {
    finalPrompt = deliverDirectContent
      ? '结果图片会由系统附上。请给出一句简短、自然的引导或短评，不要复述任何条目，也不要再调用工具。'
      : '结果图片会由系统附上。请基于图片内容给出一句自然点评，不要把工具返回的原始数据整段贴出来，也不要再调用工具。';
  } else {
    finalPrompt = '请基于以上工具调用结果给出 pippi 的自然评价，不要再调用工具。';
  }
  const finishingInstruction = typeof finalResponseInstruction === 'function' ? finalResponseInstruction() : finalResponseInstruction;
  const finishingFormat = typeof finalResponseFormat === 'function' ? finalResponseFormat() : finalResponseFormat;
  if (finishingInstruction) {
    finalPrompt += `\n\n${finishingInstruction}`;
  }
  currentMessages.push({
    role: 'user',
    content: finalPrompt
  });

  const synthesisInput = reasoningInput('tool_synthesis', {
    requiredTool: false,
    toolSelectionRequired: false,
    toolCallsMade,
    iterations,
    maxIterations,
    hasDirectPayload: collectedDirectContent.length > 0 || collectedImages.length > 0,
    previousToolFailed: lastToolFailed,
  });
  const synthesisDecision = decideCall('tool_synthesis', synthesisInput);
  let finalResponse;
  try {
    finalResponse = await completeChatFn(db, {
      messages: currentMessages,
      // Deliberately omit tools after the cap. A prompt alone cannot guarantee
      // that a tool-capable model will stop emitting calls.
      ...wireForLevel(synthesisDecision.level),
      temperature,
      maxTokens,
      model,
      ...(finishingFormat ? { responseFormat: finishingFormat } : {}),
      label: label ? `${label} [最终回答]` : undefined,
      traceRole: 'tool_synthesis',
      tracePurpose: 'tool_result_synthesis',
    });
  } catch (error) {
    if (collectedDirectContent.length > 0 || collectedImages.length > 0) {
      return {
        text: '',
        usage: totalUsage,
        toolCallsMade,
        iterations,
        recommendToolCalled,
        images: collectedImages,
        deliverOnlyImages: collectedDeliverOnlyImages,
        directContent: collectedDirectContent.join('\n\n'),
        toolCallsSkippedByCap,
        hardCapReached,
        toolCallsMadeThisTurn: turnToolCallsMade(),
        evidenceRequirementSatisfied,
      };
    }
    throw error;
  }

  recordCall('tool_synthesis', synthesisInput, finalResponse?.meta || null, synthesisDecision);

  if (finalResponse.usage) {
    totalUsage = mergeLlmUsage(totalUsage, finalResponse.usage);
  }

  return {
    text: finalReplyText(finalResponse.text),
    usage: totalUsage,
    toolCallsMade,
    iterations,
    recommendToolCalled,
    images: collectedImages,
    deliverOnlyImages: collectedDeliverOnlyImages,
    directContent: collectedDirectContent.join('\n\n'),
    toolCallsSkippedByCap,
    hardCapReached,
    toolCallsMadeThisTurn: turnToolCallsMade(),
    evidenceRequirementSatisfied,
  };
}
