import type {
  JsonValue,
  OracleResult,
  OracleSpec,
  ReplayAssertionId,
  ReplayConsumption,
  ReplayScenario,
  ReplayTrace,
  RuntimeInvariantId,
} from './types.js';
import { normalizedJson, semanticJson } from './trace.js';

export interface InvariantDefinition {
  id: RuntimeInvariantId;
  level: 'enforced' | 'candidate';
  implemented: boolean;
  description: string;
}

export const INVARIANT_REGISTRY: Readonly<Record<RuntimeInvariantId, InvariantDefinition>> = {
  RT_FINAL_NO_LLM: { id: 'RT_FINAL_NO_LLM', level: 'enforced', implemented: true, description: 'No LLM call after a final ToolResult crosses the executor boundary.' },
  RT_FINAL_NO_TOOL: { id: 'RT_FINAL_NO_TOOL', level: 'enforced', implemented: true, description: 'No tool call after a final ToolResult crosses the executor boundary.' },
  RT_FINAL_NO_EFFECT: { id: 'RT_FINAL_NO_EFFECT', level: 'enforced', implemented: true, description: 'No business effect after final; housekeeping is ignored.' },
  RT_DIRECT_EMIT_ONCE: { id: 'RT_DIRECT_EMIT_ONCE', level: 'enforced', implemented: true, description: 'The configured deterministic payload reaches the terminal result exactly once.' },
  RT_DIRECT_LEAD_LIMIT: { id: 'RT_DIRECT_LEAD_LIMIT', level: 'enforced', implemented: true, description: 'A direct payload permits at most one tools-disabled decorative generation and never executes tool_calls returned by it.' },
  RT_REQUIRED_ONCE: { id: 'RT_REQUIRED_ONCE', level: 'enforced', implemented: true, description: 'A requiredTool scenario executes exactly one tool.' },
  RT_BOUNDED_LOOP: { id: 'RT_BOUNDED_LOOP', level: 'enforced', implemented: true, description: 'The production loop terminates within its iteration bound.' },
  RR_MONOTONIC_LOOP: { id: 'RR_MONOTONIC_LOOP', level: 'enforced', implemented: true, description: 'Substantive reasoning never drops from thinking to fast.' },
  HARNESS_ISOLATED: { id: 'HARNESS_ISOLATED', level: 'enforced', implemented: true, description: 'Replay uses temp DATA_DIR, a production DB guard, a fetch tripwire, and injected LLM/tool boundaries.' },
  TRACE_DETERMINISTIC: { id: 'TRACE_DETERMINISTIC', level: 'enforced', implemented: true, description: 'Normalized trace contains no volatile path, UUID, timestamp, port or latency.' },
  RT_TOOL_COUNT_EXACT: { id: 'RT_TOOL_COUNT_EXACT', level: 'enforced', implemented: true, description: 'Reported toolCallsMade equals executor calls that settled with a ToolResult.' },
  RT_FINAL_PAYLOAD_VALID: { id: 'RT_FINAL_PAYLOAD_VALID', level: 'candidate', implemented: false, description: 'Final payload shape contract is not yet a tagged union.' },
  RT_FINAL_IMAGES_PRESERVED: { id: 'RT_FINAL_IMAGES_PRESERVED', level: 'candidate', implemented: false, description: 'Candidate for final image retention.' },
  RT_EXPOSED_SCHEMA_ONLY: { id: 'RT_EXPOSED_SCHEMA_ONLY', level: 'candidate', implemented: false, description: 'Candidate for rejecting off-schema model calls.' },
  RT_BATCH_FAILURE_MEMORY: { id: 'RT_BATCH_FAILURE_MEMORY', level: 'candidate', implemented: false, description: 'Candidate for retaining any failure in a tool batch.' },
  RT_EFFECT_IDEMPOTENCY: { id: 'RT_EFFECT_IDEMPOTENCY', level: 'candidate', implemented: true, description: 'Identical business effects occur at most once.' },
  RT_TOOL_THROW_RECOVERY: { id: 'RT_TOOL_THROW_RECOVERY', level: 'candidate', implemented: false, description: 'Candidate for tool throw recovery policy.' },
  RT_TARGET_LOCK: { id: 'RT_TARGET_LOCK', level: 'candidate', implemented: true, description: 'Actor, target and constraints remain locked in observed calls.' },
  RT_ABORT_NO_LATE_EFFECT: { id: 'RT_ABORT_NO_LATE_EFFECT', level: 'candidate', implemented: true, description: 'No new LLM/tool/result/business activity may cross an accepted harness abort/timeout boundary.' },
  RT_MALFORMED_RESULT: { id: 'RT_MALFORMED_RESULT', level: 'candidate', implemented: false, description: 'Candidate malformed-result policy.' },
  LLM_REASONING_EXHAUSTION: { id: 'LLM_REASONING_EXHAUSTION', level: 'candidate', implemented: false, description: 'Needs an injectable completeChat retry transport.' },
  LLM_ATTEMPT_METADATA: { id: 'LLM_ATTEMPT_METADATA', level: 'candidate', implemented: false, description: 'Needs per-attempt completion metadata.' },
  RR_REQUIRED_ROLE: { id: 'RR_REQUIRED_ROLE', level: 'candidate', implemented: false, description: 'Candidate requiredTool call-role correction.' },
  RR_TOOL_SELECTION_SIGNAL: { id: 'RR_TOOL_SELECTION_SIGNAL', level: 'candidate', implemented: false, description: 'Candidate tool-selection signal validation.' },
  SEM_FACT_PRECEDENCE: { id: 'SEM_FACT_PRECEDENCE', level: 'candidate', implemented: false, description: 'Needs symbolic semantic comparison.' },
};

function events(trace: ReplayTrace, type: string) {
  return trace.events.filter((event) => event.type === type);
}

function getPath(root: any, path: string): unknown {
  return String(path || '').split('.').filter(Boolean).reduce((value, key) => value?.[key], root);
}

function same(actual: unknown, expected: unknown): boolean {
  return semanticJson(actual) === semanticJson(expected);
}

function firstFinalSeq(trace: ReplayTrace): number {
  return trace.events.find((event) => event.type === 'final_signal_observed')?.seq ?? Number.POSITIVE_INFINITY;
}

function observedRoot(trace: ReplayTrace, consumption: ReplayConsumption) {
  return { terminal: trace.terminal, trace, consumption };
}

function checkSidecarTarget(scenario: ReplayScenario, trace: ReplayTrace): [boolean, string] {
  const target = scenario.oracleSidecar?.target;
  if (!target) return [false, 'oracleSidecar.target is missing'];
  const calls = events(trace, 'tool_call');
  const index = target.callIndex ?? 0;
  const locked = calls[index]?.data as any;
  if (!locked) return [false, `tool call ${index} is missing`];
  if (locked.name !== target.toolName) return [false, `tool ${locked.name} != ${target.toolName}`];
  const relevant = calls.slice(index).map((event) => event.data as any).filter((call) => call.name === target.toolName);
  for (const call of relevant) {
    if (target.args && !same(call.args, target.args)) return [false, 'locked target args drifted'];
    if (target.argsSubset) {
      for (const [key, value] of Object.entries(target.argsSubset)) {
        if (!same(call.args?.[key], value)) return [false, `locked target arg ${key} drifted`];
      }
    }
  }
  return [true, `${relevant.length} relevant tool calls match target sidecar`];
}

function evaluateInvariant(
  id: RuntimeInvariantId,
  config: JsonValue | undefined,
  scenario: ReplayScenario,
  trace: ReplayTrace,
  consumption: ReplayConsumption,
): [boolean, string] {
  const definition = INVARIANT_REGISTRY[id];
  if (!definition.implemented) return [false, `diagnostic-only: ${definition.description}`];
  const finalSeq = firstFinalSeq(trace);
  switch (id) {
    case 'RT_FINAL_NO_LLM': {
      if (!Number.isFinite(finalSeq)) return [false, 'no final signal observed'];
      const bad = trace.events.find((event) => event.seq > finalSeq && event.type === 'llm_call');
      return bad ? [false, `LLM call at seq ${bad.seq} after final`] : [true, 'no LLM call after final'];
    }
    case 'RT_FINAL_NO_TOOL': {
      if (!Number.isFinite(finalSeq)) return [false, 'no final signal observed'];
      const bad = trace.events.find((event) => event.seq > finalSeq && event.type === 'tool_call');
      return bad ? [false, `tool call at seq ${bad.seq} after final`] : [true, 'no tool call after final'];
    }
    case 'RT_FINAL_NO_EFFECT': {
      if (!Number.isFinite(finalSeq)) return [false, 'no final signal observed'];
      const bad = trace.events.find((event) => event.seq > finalSeq && event.type === 'business_effect');
      return bad ? [false, `business effect at seq ${bad.seq} after final`] : [true, 'no business effect after final'];
    }
    case 'RT_DIRECT_EMIT_ONCE': {
      if (trace.terminal.kind !== 'result') return [false, 'terminal is not a result'];
      const expected = (config as any)?.equals;
      if (typeof expected !== 'string') return [false, 'config.equals string is required'];
      return trace.terminal.result.directContent === expected
        ? [true, 'direct payload preserved']
        : [false, `directContent ${JSON.stringify(trace.terminal.result.directContent)} != ${JSON.stringify(expected)}`];
    }
    case 'RT_DIRECT_LEAD_LIMIT': {
      if (trace.terminal.kind !== 'result') return [false, 'terminal is not a result'];
      const hasAcceptedDirect = trace.terminal.result.directContent.length > 0 ||
        trace.terminal.result.images.length > 0;
      if (!hasAcceptedDirect) return [false, 'terminal has no runtime-accepted direct payload'];
      const firstToolResult = trace.events.find((event) => event.type === 'tool_result');
      if (!firstToolResult) return [false, 'accepted direct payload has no tool result boundary'];
      const lead = trace.events.find((event) => event.seq > firstToolResult.seq &&
        event.type === 'llm_call' &&
        Array.isArray((event.data as any).exposedTools) &&
        (event.data as any).exposedTools.length === 0 &&
        ((event.data as any).toolChoice === null || (event.data as any).toolChoice === undefined));

      // A terminal ToolResult deliberately has no decorative generation. A
      // later final signal cannot erase an earlier decorative-tool violation.
      if (Number.isFinite(finalSeq) && (!lead || finalSeq < lead.seq)) {
        const afterFinal = trace.events.find((event) => event.seq > finalSeq &&
          (event.type === 'llm_call' || event.type === 'tool_call'));
        return afterFinal
          ? [false, `${afterFinal.type} at seq ${afterFinal.seq} after terminal direct result`]
          : [true, 'terminal direct result triggered no decorative generation or tool execution'];
      }

      // The first tools-disabled LLM call after any tool settlement is the
      // observable direct-lead boundary. This allows remaining calls from the
      // already-planned batch, while still catching tool_calls returned by the
      // decorative generation itself.
      if (!lead) return [false, 'accepted non-terminal direct payload has no tools-disabled lead call'];
      const laterLlm = trace.events.filter((event) => event.seq >= lead.seq && event.type === 'llm_call');
      if (laterLlm.length > 1) return [false, `${laterLlm.length} LLM calls at or after direct lead boundary`];
      const callIndex = (lead.data as any).callIndex;
      const settlement = trace.events.find((event) => event.seq > lead.seq &&
        (event.type === 'llm_result' || event.type === 'llm_throw') &&
        (event.data as any).callIndex === callIndex);
      if (!settlement) return [false, `decorative LLM call ${callIndex} did not settle in trace`];
      const executedAfterSettlement = trace.events.find((event) =>
        event.seq > settlement.seq && event.type === 'tool_call');
      if (executedAfterSettlement) {
        return [false, `tool call at seq ${executedAfterSettlement.seq} after decorative LLM settlement`];
      }
      return [true, 'one tools-disabled decorative LLM call; returned tool_calls executed=0'];
    }
    case 'RT_REQUIRED_ONCE': {
      if (!scenario.initialState.requiredTool) return [false, 'scenario has no requiredTool'];
      const count = events(trace, 'tool_call').length;
      return count === 1 ? [true, 'requiredTool executed exactly once'] : [false, `requiredTool executions=${count}`];
    }
    case 'RT_BOUNDED_LOOP': {
      const bound = scenario.initialState.requiredTool ? 1 : (scenario.initialState.maxIterations ?? 5);
      const llmBound = scenario.initialState.requiredTool ? 1 : bound + 1;
      const llmCount = events(trace, 'llm_call').length;
      const toolCount = events(trace, 'tool_call').length;
      const iterationsOk = trace.terminal.kind === 'error' || trace.terminal.result.iterations <= bound;
      const requiredToolsOk = !scenario.initialState.requiredTool || toolCount <= 1;
      const ok = llmCount <= llmBound && requiredToolsOk && iterationsOk;
      return ok
        ? [true, `llmCalls=${llmCount}/${llmBound}, toolCalls=${toolCount}`]
        : [false, `bound exceeded: llmCalls=${llmCount}/${llmBound}, toolCalls=${toolCount}`];
    }
    case 'HARNESS_ISOLATED': {
      const event = events(trace, 'harness_isolation')[0];
      const data = event?.data as any;
      return event && data.tempDataDir === true && data.fetchBlocked === true &&
          data.networkBlockScope === 'globalThis.fetch' && data.productionDbBaselineCaptured === true &&
          data.llmInjected === true && data.toolExecutorInjected === true
        ? [true, 'temp DATA_DIR, fetch-only tripwire, DB guard and injected dependency boundaries observed']
        : [false, 'isolation evidence missing'];
    }
    case 'TRACE_DETERMINISTIC': {
      const serialized = normalizedJson(trace);
      const volatile = /[A-Za-z]:[\\/]|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b\d{13}\b|"latencyMs"\s*:\s*\d|localhost:\d{2,5}/i.test(serialized);
      return volatile ? [false, 'normalized trace still contains volatile data'] : [true, 'trace is normalized'];
    }
    case 'RT_TOOL_COUNT_EXACT': {
      if (trace.terminal.kind !== 'result') return [false, 'terminal is not a result'];
      const count = events(trace, 'tool_call').length;
      return trace.terminal.result.toolCallsMade === count
        ? [true, `reported and observed tool count are ${count}`]
        : [false, `reported ${trace.terminal.result.toolCallsMade}, observed ${count}`];
    }
    case 'RT_TARGET_LOCK': {
      const targetResult = checkSidecarTarget(scenario, trace);
      if (!targetResult[0]) return targetResult;
      const actor = scenario.oracleSidecar?.actor;
      if (!actor) return [false, 'oracleSidecar.actor is missing'];
      const toolEvents = events(trace, 'tool_call');
      if (toolEvents.length === 0) return [false, 'no tool calls observed'];
      const bad = toolEvents.find((event) => {
        const context = (event.data as any).context;
        return context?.userId !== actor.userId ||
          (actor.groupId !== undefined && context?.groupId !== actor.groupId);
      });
      if (bad) return [false, `actor drift at seq ${bad.seq}`];
      const constraints = scenario.oracleSidecar?.constraints || [];
      const calls = events(trace, 'tool_call');
      for (const constraint of constraints) {
        const call = calls[constraint.callIndex ?? 0]?.data as any;
        const actual = getPath(call, constraint.path);
        if (!same(actual, constraint.equals)) return [false, `${constraint.path} differs`];
      }
      return [true, `target, actor and ${constraints.length} constraints locked`];
    }
    case 'RR_MONOTONIC_LOOP': {
      const RANK = { off: 0, high: 1, max: 2 };
      let maxRank = 0;
      for (const event of events(trace, 'reasoning')) {
        const data = event.data as any;
        if (data.callRole === 'decorative_lead') continue;
        const level = String(data.decision?.level || 'off');
        const rank = RANK[level] ?? 0;
        if (rank > maxRank) maxRank = rank;
        if (rank < maxRank) return [false, `${level} downgrade at seq ${event.seq}`];
      }
      return [true, 'substantive reasoning is monotonic'];
    }
    case 'RT_EFFECT_IDEMPOTENCY': {
      const seen = new Set<string>();
      for (const event of events(trace, 'business_effect')) {
        const data = event.data as any;
        const key = normalizedJson({ kind: data.kind, data: data.data, idempotencyKey: data.data?.idempotencyKey });
        if (seen.has(key)) return [false, `duplicate business effect at seq ${event.seq}`];
        seen.add(key);
      }
      return [true, 'no duplicate business effect'];
    }
    case 'RT_ABORT_NO_LATE_EFFECT': {
      const control = trace.events.find((event) => event.type === 'turn_control');
      if (!control) return [false, 'no accepted abort/timeout control boundary'];
      const prohibited = new Set([
        'llm_call', 'llm_result', 'llm_throw',
        'tool_call', 'tool_result', 'tool_throw', 'final_signal_observed',
        'business_effect',
      ]);
      const late = trace.events.find((event) => event.seq > control.seq && prohibited.has(event.type));
      return late
        ? [false, `${late.type} at seq ${late.seq} after ${String((control.data as any).kind)} terminal`]
        : [true, 'no LLM/tool/result/business activity after abort/timeout terminal'];
    }
    default:
      return [false, `unimplemented invariant ${id}`];
  }
}

function evaluateAssertion(
  id: ReplayAssertionId,
  value: JsonValue | undefined,
  scenario: ReplayScenario,
  trace: ReplayTrace,
  consumption: ReplayConsumption,
): [boolean, string] {
  const result = trace.terminal.kind === 'result' ? trace.terminal.result : null;
  switch (id) {
    case 'ASSERT_TERMINAL_KIND': return [trace.terminal.kind === value, `terminal=${trace.terminal.kind}`];
    case 'ASSERT_LLM_CALL_COUNT': return [events(trace, 'llm_call').length === value, `llmCalls=${events(trace, 'llm_call').length}`];
    case 'ASSERT_TOOL_CALL_COUNT': return [events(trace, 'tool_call').length === value, `toolCalls=${events(trace, 'tool_call').length}`];
    case 'ASSERT_TOOL_CALLS_MADE': return [result?.toolCallsMade === value, `toolCallsMade=${result?.toolCallsMade}`];
    case 'ASSERT_ITERATIONS_AT_MOST': return [Boolean(result && result.iterations <= Number(value)), `iterations=${result?.iterations}`];
    case 'ASSERT_DIRECT_CONTENT': return [result?.directContent === value, `directContent=${JSON.stringify(result?.directContent)}`];
    case 'ASSERT_TEXT': return [result?.text === value, `text=${JSON.stringify(result?.text)}`];
    case 'ASSERT_RECOMMEND_TOOL_CALLED': return [result?.recommendToolCalled === value, `recommendToolCalled=${result?.recommendToolCalled}`];
    case 'ASSERT_SETTLEMENT_ATTEMPTS': {
      const count = events(trace, 'settlement_attempt').length;
      return [count === value, `settlementAttempts=${count}`];
    }
    case 'ASSERT_ACCEPTED_SETTLEMENTS': {
      const count = events(trace, 'settlement_attempt')
        .filter((event) => (event.data as any).accepted === true).length;
      return [count === value, `acceptedSettlements=${count}`];
    }
    case 'ASSERT_CONTROL_KIND': {
      const kind = (events(trace, 'turn_control')[0]?.data as any)?.kind;
      return [kind === value, `controlKind=${String(kind || 'none')}`];
    }
    case 'ASSERT_RUNTIME_SETTLED_AFTER_CONTROL': {
      const actual = events(trace, 'runtime_settled_after_control').length > 0;
      return [actual === value, `runtimeSettledAfterControl=${actual}`];
    }
    case 'ASSERT_SCRIPT_CONSUMPTION': return [same(consumption, value), `consumption=${normalizedJson(consumption)}`];
    case 'ASSERT_SIDECAR_FACTS': {
      const root = observedRoot(trace, consumption);
      const facts = scenario.oracleSidecar?.facts || [];
      const bad = facts.find((fact) => !same(getPath(root, fact.path), fact.equals));
      return bad ? [false, `fact ${bad.path} differs`] : [true, `${facts.length} sidecar facts match`];
    }
  }
}

export function evaluateOracles(
  scenario: ReplayScenario,
  trace: ReplayTrace,
  consumption: ReplayConsumption,
): OracleResult[] {
  const output: OracleResult[] = [];
  for (const [level, specs] of [
    ['enforced', scenario.expected.enforced],
    ['candidate', scenario.expected.candidate || []],
  ] as const) {
    for (const spec of specs as OracleSpec[]) {
      const [passed, detail] = spec.kind === 'invariant'
        ? evaluateInvariant(spec.id, spec.config, scenario, trace, consumption)
        : evaluateAssertion(spec.id, spec.value, scenario, trace, consumption);
      output.push({ level, kind: spec.kind, id: spec.id, passed, detail, note: spec.note });
    }
  }
  return output;
}
