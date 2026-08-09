import { createShadowReasoningRouter } from '../../server/bot/reasoningRouter.js';
import type { ReasoningShadowSink } from '../../server/bot/reasoningRouter.js';
import { createScriptedAdapters } from './adapters.js';
import { assertReplayIsolation } from './isolation.js';
import { evaluateOracles } from './oracles.js';
import { TraceRecorder } from './trace.js';
import {
  type JsonValue,
  type ReplayRunResult,
  type ReplayScenario,
  type ReplayTerminal,
  toLlmTools,
} from './types.js';

export class ReplayHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayHarnessError';
  }
}

function terminalError(error: any): ReplayTerminal {
  return {
    kind: 'error',
    error: {
      name: String(error?.name || 'Error'),
      message: String(error?.message || error),
      ...(error?.code ? { code: String(error.code) } : {}),
    },
  };
}

export async function replayScenario(scenario: ReplayScenario): Promise<ReplayRunResult> {
  const isolation = assertReplayIsolation();
  const { runToolLoop } = await import('../../server/bots/executor.js');
  const recorder = new TraceRecorder(scenario.id, scenario.seed);
  recorder.push('harness_isolation', {
    ...isolation,
    // These booleans describe the actual dependency boundaries below. They do
    // not claim that the process is a general-purpose http/net sandbox.
    llmInjected: true,
    toolExecutorInjected: true,
  });
  const adapters = createScriptedAdapters(scenario, recorder);
  const baseRouter = createShadowReasoningRouter(2_000, () => {});
  const reasoningRouter: ReasoningShadowSink = {
    resolve: (input, turn) => baseRouter.resolve(input, turn),
    mergeTurn: (turn, decision) => baseRouter.mergeTurn(turn, decision),
    record(entry) {
      baseRouter.record(entry);
      recorder.reasoning(entry);
    },
    snapshot: () => baseRouter.snapshot(),
  };

  let terminal: ReplayTerminal;
  try {
    const state = scenario.initialState;
    const result = await runToolLoop(adapters.completeChat, {
      db: state.db || { settings: {} },
      messages: state.messages as any,
      tools: toLlmTools(state.toolSchemas),
      userId: state.context.userId,
      groupId: state.context.groupId,
      selfQq: state.context.selfQq,
      maxIterations: state.maxIterations,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      model: state.model,
      label: state.label || `Agent Replay ${scenario.id}`,
      requiredTool: state.requiredTool as any,
      deliverDirectContent: state.deliverDirectContent,
      turnId: `replay:${scenario.id}`,
      reasoningRouter,
      // The sole production seam required by Phase B. The default remains the
      // real executeToolCall; replay replaces only the dependency boundary.
      executeToolCallFn: adapters.executeToolCall,
    } as any);
    terminal = {
      kind: 'result',
      result: {
        text: String(result.text || ''),
        usage: result.usage as JsonValue,
        toolCallsMade: Number(result.toolCallsMade || 0),
        iterations: Number(result.iterations || 0),
        recommendToolCalled: Boolean(result.recommendToolCalled),
        images: [...(result.images || [])].map(String),
        directContent: String(result.directContent || ''),
      },
    };
  } catch (error) {
    terminal = terminalError(error);
  }

  const trace = recorder.finish(terminal);
  const consumption = adapters.consumption();
  const adapterError = trace.events.find((event) => event.type === 'adapter_error');
  if (adapterError) {
    throw new ReplayHarnessError(
      `scripted adapter contract failed at ${String((adapterError.data as any).boundary || 'unknown')} call ${String((adapterError.data as any).callIndex ?? '?')}`,
    );
  }
  const fullyConsumed = consumption.llmConsumed === consumption.llmTotal &&
    consumption.toolConsumed === consumption.toolTotal;
  const hasExplicitConsumptionContract = scenario.expected.enforced.some((spec) =>
    spec.kind === 'assertion' && spec.id === 'ASSERT_SCRIPT_CONSUMPTION');
  if (!fullyConsumed && !hasExplicitConsumptionContract) {
    throw new ReplayHarnessError(
      `script not fully consumed (llm ${consumption.llmConsumed}/${consumption.llmTotal}, tool ${consumption.toolConsumed}/${consumption.toolTotal})`,
    );
  }
  const oracles = evaluateOracles(scenario, trace, consumption);
  const passed = oracles
    .filter((oracle) => oracle.level === 'enforced')
    .every((oracle) => oracle.passed);
  return { scenario, trace, consumption, oracles, passed };
}
