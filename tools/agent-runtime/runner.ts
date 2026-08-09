import { createShadowReasoningRouter } from '../../server/bot/reasoningRouter.js';
import type { ReasoningLevel, ReasoningShadowSink } from '../../server/bot/reasoningRouter.js';
import { createScriptedAdapters } from './adapters.js';
import { assertReplayIsolation } from './isolation.js';
import { evaluateOracles } from './oracles.js';
import { DeterministicSettlementScheduler } from './scheduler.js';
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

function terminalResult(result: any): ReplayTerminal {
  return {
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
}

function usesSymbolicSettlement(scenario: ReplayScenario): boolean {
  return Boolean(
    scenario.faultProfile?.symbolicControl ||
    scenario.llmSteps.some((step) => step.settlement) ||
    scenario.toolSteps.some((step) => step.settlement),
  );
}

export interface ReplayExecutionOptions {
  /** Harness-only Shadow decision override. It never reaches completeChat. */
  scriptedReasoningMode?: 'fast' | 'thinking' | ReasoningLevel;
}

const SCRIPTED_LEVEL: Record<string, ReasoningLevel> = {
  fast: 'off',
  thinking: 'max',
  off: 'off',
  high: 'high',
  max: 'max',
};

export async function replayScenario(
  scenario: ReplayScenario,
  execution: ReplayExecutionOptions = {},
): Promise<ReplayRunResult> {
  const isolation = assertReplayIsolation();
  const { runToolLoop } = await import('../../server/bots/executor.js');
  const recorder = new TraceRecorder(scenario.id, scenario.seed);
  recorder.push('harness_isolation', {
    ...isolation,
    // These booleans describe the actual dependency boundaries below. They do
    // not claim that the process is a general-purpose http/net sandbox.
    llmInjected: true,
    toolExecutorInjected: true,
    ...(execution.scriptedReasoningMode ? { scriptedReasoningMode: execution.scriptedReasoningMode } : {}),
  });
  const scheduler = usesSymbolicSettlement(scenario)
    ? new DeterministicSettlementScheduler(recorder)
    : undefined;
  const adapters = createScriptedAdapters(scenario, recorder, scheduler);
  const baseRouter = createShadowReasoningRouter(2_000, () => {});
  const scriptedLevel = execution.scriptedReasoningMode
    ? SCRIPTED_LEVEL[execution.scriptedReasoningMode]
    : undefined;
  const reasoningRouter: ReasoningShadowSink = {
    resolve: (input, turn) => scriptedLevel
      ? {
          level: scriptedLevel,
          source: 'rule',
          reasonCode: scriptedLevel === 'off' ? 'fast_default' : 'structured_fact_compare',
        }
      : baseRouter.resolve(input, turn),
    mergeTurn: (turn, decision) => baseRouter.mergeTurn(turn, decision),
    record(entry) {
      baseRouter.record(entry);
      recorder.reasoning(entry);
    },
    snapshot: () => baseRouter.snapshot(),
  };

  let terminal: ReplayTerminal;
  const state = scenario.initialState;
  const invokeRuntime = () => runToolLoop(adapters.completeChat, {
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

  if (!scheduler) {
    try {
      terminal = terminalResult(await invokeRuntime());
    } catch (error) {
      terminal = terminalError(error);
    }
  } else {
    let runtimeSettled = false;
    let runtimeTerminal: ReplayTerminal | undefined;
    let controlAccepted: { kind: 'abort' | 'timeout'; tick: number } | undefined;
    const control = scenario.faultProfile?.symbolicControl;
    const abortController = new AbortController();
    if (control) {
      scheduler.scheduleAt(control.atTick, `turn-control:${control.kind}`, () => {
        if (runtimeSettled) {
          recorder.push('control_suppressed', { kind: control.kind, tick: scheduler.tick });
          return;
        }
        abortController.abort(control.kind);
        controlAccepted = { kind: control.kind, tick: scheduler.tick };
        recorder.push('turn_control', {
          kind: control.kind,
          tick: scheduler.tick,
          abortSignal: abortController.signal.aborted,
          scope: 'harness_outer_turn',
        });
      });
    }

    const runtimePromise = invokeRuntime()
      .then((result) => {
        runtimeTerminal = terminalResult(result);
      })
      .catch((error) => {
        runtimeTerminal = terminalError(error);
      })
      .finally(() => {
        runtimeSettled = true;
        if (controlAccepted) {
          recorder.push('runtime_settled_after_control', {
            controlKind: controlAccepted.kind,
            controlTick: controlAccepted.tick,
            outcome: runtimeTerminal?.kind || 'unknown',
          });
        }
      });

    await scheduler.flushRuntimeMicrotasks();
    let guard = 0;
    while (!runtimeSettled || scheduler.pending > 0) {
      if (++guard > 10_000) throw new ReplayHarnessError('symbolic scheduler exceeded 10000 actions');
      if (scheduler.pending > 0) {
        await scheduler.runNext();
        continue;
      }
      await scheduler.flushRuntimeMicrotasks();
      if (!runtimeSettled && scheduler.pending === 0) {
        throw new ReplayHarnessError('runtime is pending with no symbolic settlement action');
      }
    }
    await runtimePromise;
    terminal = controlAccepted
      ? terminalError(Object.assign(
          new Error(`symbolic ${controlAccepted.kind} accepted before runtime settlement`),
          { name: controlAccepted.kind === 'abort' ? 'ReplayAbort' : 'ReplayTimeout', code: 'SYMBOLIC_TURN_TERMINAL' },
        ))
      : (runtimeTerminal || terminalError(new Error('runtime settled without an outcome')));
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
