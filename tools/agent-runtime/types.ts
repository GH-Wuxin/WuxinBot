import type { LlmTool, LlmToolCall, ToolResult } from '../../server/bots/types.js';

export const SCHEMA_VERSION = 1 as const;
export const TRACE_VERSION = 1 as const;
export const GENERATOR_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ReplayMessage {
  role: string;
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface ReplayToolSchema {
  name: string;
  description?: string;
  parameters?: {
    type: 'object';
    properties?: Record<string, JsonValue>;
    required?: string[];
  };
}

export interface ReplayLlmExpectation {
  exposedTools?: string[];
  labelIncludes?: string;
  messageRoles?: string[];
}

export interface ReplayLlmToolCall {
  id?: string;
  name: string;
  args?: Record<string, JsonValue>;
  rawArguments?: string;
}

export interface ReplayCompletionMeta {
  finishReason?: string | null;
  reasoningTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  contentEmpty?: boolean;
  hadToolCalls?: boolean;
  model?: string;
  provider?: string;
  latencyMs?: number;
}

export interface ReplayLlmReturnStep {
  outcome: 'return';
  expect?: ReplayLlmExpectation;
  text?: string;
  toolCalls?: ReplayLlmToolCall[];
  finishReason?: string;
  usage?: Record<string, JsonValue>;
  meta?: ReplayCompletionMeta;
}

export interface ReplayLlmThrowStep {
  outcome: 'throw';
  expect?: ReplayLlmExpectation;
  error?: {
    name?: string;
    message: string;
    code?: string;
  };
}

export type ReplayLlmStep = ReplayLlmReturnStep | ReplayLlmThrowStep;

export interface ReplayToolExpectation {
  name?: string;
  args?: Record<string, JsonValue>;
  argsSubset?: Record<string, JsonValue>;
}

export interface ReplayToolReturnStep {
  outcome: 'return';
  expect?: ReplayToolExpectation;
  effects?: Array<{
    kind: string;
    class?: 'business' | 'housekeeping';
    data?: Record<string, JsonValue>;
  }>;
  result: Omit<ToolResult, 'toolCallId'> & { toolCallId?: string };
}

export interface ReplayToolThrowStep {
  outcome: 'throw';
  expect?: ReplayToolExpectation;
  error?: {
    name?: string;
    message: string;
    code?: string;
  };
}

export type ReplayToolStep = ReplayToolReturnStep | ReplayToolThrowStep;

export type RuntimeInvariantId =
  | 'RT_FINAL_NO_LLM'
  | 'RT_FINAL_NO_TOOL'
  | 'RT_FINAL_NO_EFFECT'
  | 'RT_DIRECT_EMIT_ONCE'
  | 'RT_DIRECT_LEAD_LIMIT'
  | 'RT_REQUIRED_ONCE'
  | 'RT_BOUNDED_LOOP'
  | 'RR_MONOTONIC_LOOP'
  | 'HARNESS_ISOLATED'
  | 'TRACE_DETERMINISTIC'
  | 'RT_FINAL_PAYLOAD_VALID'
  | 'RT_FINAL_IMAGES_PRESERVED'
  | 'RT_EXPOSED_SCHEMA_ONLY'
  | 'RT_TOOL_COUNT_EXACT'
  | 'RT_BATCH_FAILURE_MEMORY'
  | 'RT_EFFECT_IDEMPOTENCY'
  | 'RT_TOOL_THROW_RECOVERY'
  | 'RT_TARGET_LOCK'
  | 'RT_ABORT_NO_LATE_EFFECT'
  | 'RT_MALFORMED_RESULT'
  | 'LLM_REASONING_EXHAUSTION'
  | 'LLM_ATTEMPT_METADATA'
  | 'RR_REQUIRED_ROLE'
  | 'RR_TOOL_SELECTION_SIGNAL'
  | 'SEM_FACT_PRECEDENCE';

export type ReplayAssertionId =
  | 'ASSERT_TERMINAL_KIND'
  | 'ASSERT_LLM_CALL_COUNT'
  | 'ASSERT_TOOL_CALL_COUNT'
  | 'ASSERT_TOOL_CALLS_MADE'
  | 'ASSERT_ITERATIONS_AT_MOST'
  | 'ASSERT_DIRECT_CONTENT'
  | 'ASSERT_TEXT'
  | 'ASSERT_RECOMMEND_TOOL_CALLED'
  | 'ASSERT_SCRIPT_CONSUMPTION'
  | 'ASSERT_SIDECAR_FACTS';

export type OracleSpec =
  | { kind: 'invariant'; id: RuntimeInvariantId; config?: JsonValue; note?: string }
  | { kind: 'assertion'; id: ReplayAssertionId; value?: JsonValue; note?: string };

export interface ReplayOracleSidecar {
  actor?: {
    userId: string;
    groupId?: string;
  };
  target?: {
    callIndex?: number;
    toolName: string;
    args?: Record<string, JsonValue>;
    argsSubset?: Record<string, JsonValue>;
  };
  facts?: Array<{
    path: string;
    equals: JsonValue;
  }>;
  constraints?: Array<{
    callIndex?: number;
    path: string;
    equals: JsonValue;
  }>;
  symbolicClaims?: Array<{
    id: string;
    path: string;
    operator: 'equals' | 'contains' | 'not_contains';
    value: JsonValue;
  }>;
}

export interface ReplayScenario {
  schemaVersion: typeof SCHEMA_VERSION;
  traceVersion: typeof TRACE_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  id: string;
  seed: number;
  initialState: {
    context: {
      userId: string;
      groupId?: string;
      selfQq?: string;
    };
    db?: Record<string, JsonValue>;
    messages: ReplayMessage[];
    toolSchemas: ReplayToolSchema[];
    maxIterations?: number;
    temperature?: number;
    maxTokens?: number;
    model?: string;
    label?: string;
    deliverDirectContent?: boolean;
    requiredTool?: {
      toolName: string;
      args: Record<string, JsonValue>;
    };
  };
  llmSteps: ReplayLlmStep[];
  toolSteps: ReplayToolStep[];
  oracleSidecar?: ReplayOracleSidecar;
  expected: {
    enforced: OracleSpec[];
    candidate?: OracleSpec[];
  };
  minimalReproduction?: string;
}

export interface ReplayConsumption {
  llmConsumed: number;
  llmTotal: number;
  toolConsumed: number;
  toolTotal: number;
}

export interface ReplayTerminalResult {
  kind: 'result';
  result: {
    text: string;
    usage: JsonValue;
    toolCallsMade: number;
    iterations: number;
    recommendToolCalled: boolean;
    images: string[];
    directContent: string;
  };
}

export interface ReplayTerminalError {
  kind: 'error';
  error: {
    name: string;
    message: string;
    code?: string;
  };
}

export type ReplayTerminal = ReplayTerminalResult | ReplayTerminalError;

export type TraceEventType =
  | 'llm_call'
  | 'llm_result'
  | 'llm_throw'
  | 'tool_call'
  | 'tool_result'
  | 'tool_throw'
  | 'final_signal_observed'
  | 'business_effect'
  | 'housekeeping_effect'
  | 'harness_isolation'
  | 'reasoning'
  | 'adapter_error'
  | 'terminal';

export interface ReplayTraceEvent {
  seq: number;
  type: TraceEventType;
  data: Record<string, JsonValue>;
}

export interface ReplayTrace {
  traceVersion: typeof TRACE_VERSION;
  schemaVersion: typeof SCHEMA_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  scenarioId: string;
  seed: number;
  events: ReplayTraceEvent[];
  terminal: ReplayTerminal;
}

export interface OracleResult {
  level: 'enforced' | 'candidate';
  kind: 'invariant' | 'assertion';
  id: RuntimeInvariantId | ReplayAssertionId;
  passed: boolean;
  detail: string;
  note?: string;
}

export interface ReplayRunResult {
  scenario: ReplayScenario;
  trace: ReplayTrace;
  consumption: ReplayConsumption;
  oracles: OracleResult[];
  passed: boolean;
}

export function toLlmTools(schemas: ReplayToolSchema[]): LlmTool[] {
  return schemas.map((schema) => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description || `offline replay tool: ${schema.name}`,
      parameters: {
        type: 'object',
        properties: schema.parameters?.properties || {},
        required: schema.parameters?.required || [],
      },
    },
  }));
}
