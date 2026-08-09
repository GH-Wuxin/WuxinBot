import { buildLlmCompletionMeta } from '../../server/bot/llm.js';
import type { LlmToolCall, ToolResult } from '../../server/bots/types.js';
import type {
  ReplayConsumption,
  ReplayLlmExpectation,
  ReplayScenario,
  ReplaySettlementPlan,
  ReplayToolExpectation,
} from './types.js';
import { normalizedJson, parseToolArguments, semanticJson, TraceRecorder } from './trace.js';
import type { DeterministicSettlementScheduler } from './scheduler.js';

export class ReplayAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayAdapterError';
  }
}

function makeScriptedError(spec: { name?: string; message: string; code?: string } | undefined): Error {
  const error = new Error(spec?.message || 'scripted failure');
  error.name = spec?.name || 'Error';
  if (spec?.code) (error as any).code = spec.code;
  return error;
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return semanticJson(actual) === semanticJson(expected);
}

function subsetMatches(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return sameJson(actual, expected);
  }
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>)
    .every(([key, value]) => subsetMatches((actual as Record<string, unknown>)[key], value));
}

function assertLlmExpectation(
  expect: ReplayLlmExpectation | undefined,
  options: any,
  callIndex: number,
): void {
  if (!expect) return;
  const exposedTools = (options.tools || []).map((tool: any) => String(tool?.function?.name || ''));
  const messageRoles = (options.messages || []).map((message: any) => String(message?.role || ''));
  if (expect.exposedTools && !sameJson(exposedTools, expect.exposedTools)) {
    throw new ReplayAdapterError(
      `LLM step ${callIndex}: exposed tools ${normalizedJson(exposedTools)} != ${normalizedJson(expect.exposedTools)}`,
    );
  }
  if (expect.messageRoles && !sameJson(messageRoles, expect.messageRoles)) {
    throw new ReplayAdapterError(
      `LLM step ${callIndex}: message roles ${normalizedJson(messageRoles)} != ${normalizedJson(expect.messageRoles)}`,
    );
  }
  if (expect.labelIncludes !== undefined && !String(options.label || '').includes(expect.labelIncludes)) {
    throw new ReplayAdapterError(
      `LLM step ${callIndex}: label ${JSON.stringify(options.label || '')} does not include ${JSON.stringify(expect.labelIncludes)}`,
    );
  }
}

function assertToolExpectation(
  expect: ReplayToolExpectation | undefined,
  toolCall: LlmToolCall,
  callIndex: number,
): void {
  if (!expect) return;
  const parsed = parseToolArguments(toolCall);
  const name = String(toolCall.function?.name || '');
  if (expect.name !== undefined && name !== expect.name) {
    throw new ReplayAdapterError(`tool step ${callIndex}: name ${name} != ${expect.name}`);
  }
  if (expect.args !== undefined && !sameJson(parsed.args, expect.args)) {
    throw new ReplayAdapterError(
      `tool step ${callIndex}: args ${normalizedJson(parsed.args)} != ${normalizedJson(expect.args)}`,
    );
  }
  if (expect.argsSubset !== undefined && !subsetMatches(parsed.args, expect.argsSubset)) {
    throw new ReplayAdapterError(
      `tool step ${callIndex}: args ${normalizedJson(parsed.args)} do not contain ${normalizedJson(expect.argsSubset)}`,
    );
  }
}

function settleScripted<T>(args: {
  scheduler?: DeterministicSettlementScheduler;
  recorder: TraceRecorder;
  plan?: ReplaySettlementPlan;
  boundary: 'llm' | 'tool';
  callIndex: number;
  produce: () => T;
}): Promise<T> {
  if (!args.plan) {
    try {
      return Promise.resolve(args.produce());
    } catch (error) {
      return Promise.reject(error);
    }
  }
  if (!args.scheduler) {
    return Promise.reject(new ReplayAdapterError('scheduled settlement requires the deterministic scheduler'));
  }

  let accepted = false;
  return new Promise<T>((resolve, reject) => {
    const attempts = [
      { tick: args.plan!.atTick, attempt: 'primary', attemptIndex: 0 },
      ...(args.plan!.duplicateAtTicks || []).map((tick, index) => ({
        tick,
        attempt: 'duplicate',
        attemptIndex: index + 1,
      })),
    ];
    for (const attempt of attempts) {
      args.scheduler!.scheduleAt(
        attempt.tick,
        `${args.boundary}#${args.callIndex}:${attempt.attempt}#${attempt.attemptIndex}`,
        () => {
          const wins = !accepted;
          args.recorder.push('settlement_attempt', {
            boundary: args.boundary,
            callIndex: args.callIndex,
            attempt: attempt.attempt,
            attemptIndex: attempt.attemptIndex,
            requestedTick: attempt.tick,
            accepted: wins,
          });
          if (!wins) return;
          accepted = true;
          try {
            resolve(args.produce());
          } catch (error) {
            reject(error);
          }
        },
      );
    }
  });
}

export function createScriptedAdapters(
  scenario: ReplayScenario,
  recorder: TraceRecorder,
  scheduler?: DeterministicSettlementScheduler,
): {
  completeChat: (db: any, options: any) => Promise<any>;
  executeToolCall: (toolCall: LlmToolCall, context: any) => Promise<ToolResult>;
  consumption: () => ReplayConsumption;
} {
  let llmIndex = 0;
  let toolIndex = 0;

  const completeChat = async (_db: any, options: any): Promise<any> => {
    const callIndex = llmIndex;
    const step = scenario.llmSteps[llmIndex++];
    const exposedTools = (options.tools || []).map((tool: any) => String(tool?.function?.name || ''));
    recorder.push('llm_call', {
      callIndex,
      label: String(options.label || ''),
      exposedTools,
      toolChoice: options.tool_choice ?? null,
      messageRoles: (options.messages || []).map((message: any) => String(message?.role || '')),
      messageCount: (options.messages || []).length,
    });
    if (!step) {
      const error = new ReplayAdapterError(`unexpected LLM call ${callIndex}; script has ${scenario.llmSteps.length} steps`);
      recorder.push('adapter_error', { boundary: 'llm', callIndex, message: error.message });
      throw error;
    }
    try {
      assertLlmExpectation(step.expect, options, callIndex);
    } catch (error: any) {
      recorder.push('adapter_error', { boundary: 'llm', callIndex, message: String(error?.message || error) });
      throw error;
    }
    return settleScripted({
      scheduler,
      recorder,
      plan: step.settlement,
      boundary: 'llm',
      callIndex,
      produce: () => {
        if (step.outcome === 'throw') {
          const error = makeScriptedError(step.error);
          recorder.push('llm_throw', {
            callIndex,
            error: { name: error.name, message: error.message, code: (error as any).code },
          });
          throw error;
        }

        const toolCalls: LlmToolCall[] = (step.toolCalls || []).map((call, index) => ({
          id: call.id || `llm${callIndex + 1}_tool${index + 1}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.rawArguments !== undefined ? call.rawArguments : JSON.stringify(call.args || {}),
          },
        }));
        const text = String(step.text || '');
        const finishReason = step.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop');
        const usage = {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          ...(step.usage || {}),
        };
        const raw = {
          choices: [{
            finish_reason: finishReason,
            message: { content: text, tool_calls: toolCalls.length > 0 ? toolCalls : undefined },
          }],
          usage,
        };
        const builtMeta = buildLlmCompletionMeta(raw, {
          model: step.meta?.model || options.model || 'offline-scripted',
          provider: step.meta?.provider || 'offline',
          latencyMs: step.meta?.latencyMs || 0,
        });
        const meta = { ...builtMeta, ...(step.meta || {}) };
        recorder.push('llm_result', {
          callIndex,
          text,
          finishReason,
          meta,
          toolCalls: toolCalls.map((call) => ({
            id: recorder.toolCallId(call.id),
            name: call.function.name,
            ...parseToolArguments(call),
          })),
        });
        return { text, usage, raw, meta, provider: 'offline', model: meta.model, latencyMs: meta.latencyMs };
      },
    });
  };

  const executeToolCall = async (toolCall: LlmToolCall, context: any): Promise<ToolResult> => {
    const callIndex = toolIndex;
    const step = scenario.toolSteps[toolIndex++];
    const parsed = parseToolArguments(toolCall);
    const toolCallId = recorder.toolCallId(toolCall.id);
    recorder.push('tool_call', {
      callIndex,
      toolCallId,
      name: String(toolCall.function?.name || ''),
      ...parsed,
      context: {
        userId: String(context?.userId || ''),
        groupId: context?.groupId === undefined ? null : String(context.groupId),
      },
    });
    if (!step) {
      const error = new ReplayAdapterError(`unexpected tool call ${callIndex}; script has ${scenario.toolSteps.length} steps`);
      recorder.push('adapter_error', { boundary: 'tool', callIndex, toolCallId, message: error.message });
      throw error;
    }
    try {
      assertToolExpectation(step.expect, toolCall, callIndex);
    } catch (error: any) {
      recorder.push('adapter_error', { boundary: 'tool', callIndex, toolCallId, message: String(error?.message || error) });
      throw error;
    }
    return settleScripted({
      scheduler,
      recorder,
      plan: step.settlement,
      boundary: 'tool',
      callIndex,
      produce: () => {
        if (step.outcome === 'throw') {
          const error = makeScriptedError(step.error);
          recorder.push('tool_throw', {
            callIndex,
            toolCallId,
            error: { name: error.name, message: error.message, code: (error as any).code },
          });
          throw error;
        }
        const result: ToolResult = {
          ...step.result,
          toolCallId: toolCall.id,
          images: step.result.images ? [...step.result.images] : undefined,
        };
        for (const effect of step.effects || []) {
          recorder.push(effect.class === 'housekeeping' ? 'housekeeping_effect' : 'business_effect', {
            toolCallId,
            kind: effect.kind,
            data: effect.data || {},
          });
        }
        recorder.push('tool_result', {
          callIndex,
          toolCallId,
          ok: result.ok,
          content: result.content,
          directContent: result.directContent ?? null,
          final: Boolean(result.final),
          images: result.images || [],
          imageCount: result.images?.length || 0,
          error: result.error ?? null,
          metadata: result.metadata ?? null,
        });
        if (result.final) {
          // This is the observable dependency boundary, not an internal SUT hook:
          // a terminal ToolResult has been returned to runToolLoop. Any later
          // LLM/tool/business-effect event is therefore a contract violation.
          recorder.push('final_signal_observed', { toolCallId, callIndex });
        }
        return result;
      },
    });
  };

  return {
    completeChat,
    executeToolCall,
    consumption: () => ({
      llmConsumed: llmIndex,
      llmTotal: scenario.llmSteps.length,
      toolConsumed: toolIndex,
      toolTotal: scenario.toolSteps.length,
    }),
  };
}
