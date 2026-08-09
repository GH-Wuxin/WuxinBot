// Reasoning Router — Phase 2 v1: production wiring support.
// Decisions are pure and deterministic. When `reasoningEnabledFor(db)` is
// true, call sites translate `ReasoningLevel` into wire params via
// `thinkingParamsForLevel` (llm.ts). Shadow telemetry is always recorded,
// including while the kill switch is off.
// The old taskComplexityScore / autoModelForTask are intentionally untouched
// and not used here.

import type { LlmCompletionMeta } from './llm.js';

export type LlmCallRole =
  | 'conversation'
  | 'tool_planner'
  | 'tool_synthesis'
  | 'decorative_lead'
  | 'rewrite';

export type ReasoningLevel = 'off' | 'high' | 'max';

export type ReasoningSource = 'rule' | 'inherit' | 'escalation';

export type ReasonCode =
  | 'simple_chat'
  | 'context_dependency'
  | 'deterministic_tool'
  | 'direct_delivery'
  | 'tool_selection'
  | 'tool_ambiguity'
  | 'tool_multi_step'
  | 'tool_failure_recovery'
  | 'history_constraint_compare'
  | 'structured_fact_compare'
  | 'user_correction'
  | 'conflicting_context'
  | 'fast_failure_escalation'
  | 'fast_default';

/**
 * Structured-only input: enums / booleans / numbers. Deliberately no user
 * text, no conversation history, no tool payloads — shadow records must stay
 * small and safe.
 */
export interface ReasoningInput {
  callRole: LlmCallRole;
  /** A deterministic tool was already chosen by code (requiredTool path). */
  requiredTool: boolean;
  /** The model must decide among exposed tools (no reliable narrowing source). */
  toolSelectionRequired: boolean;
  toolCallsMade: number;
  iterations: number;
  maxIterations: number;
  hasDirectPayload: boolean;
  terminalFinal: boolean;
  previousToolFailed: boolean;
  /** Only from existing deterministic state; no keyword heuristics in v1. */
  ambiguousTarget: boolean;
  /** Existing deterministic context signal AND prior context is present. */
  contextDependent: boolean;
  userCorrection: boolean;
  constraintCount: number;
  requiresStructuredComparison: boolean;
  previousFastFailure: boolean;
}

export interface ReasoningDecision {
  level: ReasoningLevel;
  source: ReasoningSource;
  reasonCode: ReasonCode;
}

export interface ReasoningTurnState {
  maxLevel: ReasoningLevel;
  rootReasonCode: ReasonCode | null;
}

export interface ReasoningShadowRecord {
  turnId: string;
  ts: number;
  callRole: LlmCallRole;
  decision: ReasoningDecision;
  input: ReasoningInput;
  actual: LlmCompletionMeta | null;
}

export interface ReasoningShadowSink {
  resolve(input: ReasoningInput, turn: ReasoningTurnState): ReasoningDecision;
  mergeTurn(turn: ReasoningTurnState, decision: ReasoningDecision): ReasoningTurnState;
  record(entry: ReasoningShadowRecord): void;
  snapshot(): readonly ReasoningShadowRecord[];
}

const LEVEL_RANK: Record<ReasoningLevel, number> = { off: 0, high: 1, max: 2 };

export function emptyTurnState(): ReasoningTurnState {
  return { maxLevel: 'off', rootReasonCode: null };
}

export function reasoningInput(
  callRole: LlmCallRole,
  partial: Partial<ReasoningInput> = {},
): ReasoningInput {
  return {
    callRole,
    requiredTool: false,
    toolSelectionRequired: false,
    toolCallsMade: 0,
    iterations: 0,
    maxIterations: 0,
    hasDirectPayload: false,
    terminalFinal: false,
    previousToolFailed: false,
    ambiguousTarget: false,
    contextDependent: false,
    userCorrection: false,
    constraintCount: 0,
    requiresStructuredComparison: false,
    previousFastFailure: false,
    ...partial,
  };
}

export function resolveReasoningMode(
  input: ReasoningInput,
  turn: ReasoningTurnState = emptyTurnState(),
): ReasoningDecision {
  switch (input.callRole) {
    case 'decorative_lead':
      // Cosmetic lead after a direct payload: never thinking, never inherit.
      return { level: 'off', source: 'rule', reasonCode: 'direct_delivery' };
    case 'conversation':
      if (input.contextDependent) {
        return { level: 'high', source: 'rule', reasonCode: 'context_dependency' };
      }
      return { level: 'off', source: 'rule', reasonCode: 'simple_chat' };
    case 'rewrite':
      if (input.previousFastFailure) {
        return { level: 'max', source: 'escalation', reasonCode: 'fast_failure_escalation' };
      }
      return { level: 'off', source: 'rule', reasonCode: 'fast_default' };
    case 'tool_planner':
      if (input.terminalFinal || input.requiredTool) {
        return { level: 'off', source: 'rule', reasonCode: 'deterministic_tool' };
      }
      if (input.hasDirectPayload) {
        return { level: 'off', source: 'rule', reasonCode: 'direct_delivery' };
      }
      if (input.previousToolFailed) {
        return { level: 'max', source: 'rule', reasonCode: 'tool_failure_recovery' };
      }
      if (input.ambiguousTarget) {
        return { level: 'max', source: 'rule', reasonCode: 'tool_ambiguity' };
      }
      if (input.toolCallsMade > 0 && input.iterations > 1) {
        return { level: 'max', source: 'rule', reasonCode: 'tool_multi_step' };
      }
      if (input.toolSelectionRequired) {
        return { level: 'max', source: 'rule', reasonCode: 'tool_selection' };
      }
      if (input.contextDependent) {
        return { level: 'high', source: 'rule', reasonCode: 'context_dependency' };
      }
      return { level: 'off', source: 'rule', reasonCode: 'fast_default' };
    case 'tool_synthesis':
      if (input.hasDirectPayload || input.terminalFinal) {
        return { level: 'off', source: 'rule', reasonCode: 'direct_delivery' };
      }
      if (turn.maxLevel !== 'off' && turn.rootReasonCode) {
        // Inherit the ORIGINAL root cause that raised the turn's reasoning
        // level; the reasonCode is never 'inherit'.
        return { level: turn.maxLevel, source: 'inherit', reasonCode: turn.rootReasonCode };
      }
      if (input.requiresStructuredComparison) {
        return { level: 'max', source: 'rule', reasonCode: 'structured_fact_compare' };
      }
      return { level: 'off', source: 'rule', reasonCode: 'fast_default' };
  }
}

/**
 * Monotonic turn-level upgrade: off < high < max. Once a substantive call
 * raises the level, later substantive synthesis inherits it. Fast decisions
 * never clear state; the first non-off root reason code is preserved.
 */
export function mergeTurnState(
  turn: ReasoningTurnState,
  decision: ReasoningDecision,
): ReasoningTurnState {
  if (LEVEL_RANK[decision.level] > LEVEL_RANK[turn.maxLevel]) {
    return {
      maxLevel: decision.level,
      rootReasonCode: turn.rootReasonCode ?? decision.reasonCode,
    };
  }
  return turn;
}

/**
 * One-line structured telemetry for the shadow record. Contains ONLY the
 * agreed observation fields; never user text, history, tool payloads, or
 * tool result bodies. Callers correlate to business logs via turnId.
 */
export function formatShadowRecord(record: ReasoningShadowRecord): string {
  const meta = record.actual;
  return JSON.stringify({
    ts: record.ts,
    turnId: record.turnId,
    callRole: record.callRole,
    level: record.decision.level,
    source: record.decision.source,
    reasonCode: record.decision.reasonCode,
    actualModel: meta?.model ?? '',
    finishReason: meta?.finishReason ?? null,
    reasoningTokens: meta?.reasoningTokens ?? 0,
    completionTokens: meta?.completionTokens ?? 0,
    totalTokens: meta?.totalTokens ?? 0,
    latencyMs: meta?.latencyMs ?? 0,
    toolCalls: meta?.hadToolCalls ? 1 : 0,
    textEmpty: meta?.contentEmpty ?? false,
  });
}

export function createShadowReasoningRouter(
  capacity = 2000,
  log: (line: string) => void = (line) => console.log(`[reasoning-shadow] ${line}`),
): ReasoningShadowSink {
  const ring: ReasoningShadowRecord[] = [];
  return {
    resolve: (input, turn) => resolveReasoningMode(input, turn),
    mergeTurn: (turn, decision) => mergeTurnState(turn, decision),
    record(entry) {
      ring.push(entry);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
      log(formatShadowRecord(entry));
    },
    snapshot: () => ring,
  };
}

/** Resolve + merge + record in one step; returns the merged turn state. */
export function decideAndRecord(
  router: ReasoningShadowSink,
  turnId: string,
  input: ReasoningInput,
  actual: LlmCompletionMeta | null,
  turn: ReasoningTurnState = emptyTurnState(),
): { decision: ReasoningDecision; turn: ReasoningTurnState } {
  const decision = router.resolve(input, turn);
  const nextTurn = router.mergeTurn(turn, decision);
  router.record({ turnId, ts: Date.now(), callRole: input.callRole, decision, input, actual });
  return { decision, turn: nextTurn };
}

/**
 * Kill switch: startup-level hard veto via REASONING_ENABLED=false|0 (same
 * pattern as KB_ENABLED) AND runtime settings.reasoningEnabled. While off,
 * call sites must still run the router for shadow telemetry but must not send
 * any thinking/reasoning_effort wire params.
 */
export function reasoningEnabledFor(db: any): boolean {
  const env = String(process.env.REASONING_ENABLED ?? '').trim().toLowerCase();
  if (env === 'false' || env === '0') return false;
  return Boolean(db?.settings?.reasoningEnabled);
}
