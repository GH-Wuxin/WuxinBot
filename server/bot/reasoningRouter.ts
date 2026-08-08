// Reasoning Router — Phase 1: SHADOW ONLY.
// Decisions are pure, deterministic and are only recorded; no production LLM
// call changes thinking, model, tool routing, or the user-facing reply.
// The old taskComplexityScore / autoModelForTask are intentionally untouched
// and not used here.

import type { LlmCompletionMeta } from './llm.js';

export type LlmCallRole =
  | 'conversation'
  | 'tool_planner'
  | 'tool_synthesis'
  | 'decorative_lead'
  | 'rewrite';

export type ReasoningMode = 'fast' | 'thinking';

export type ReasoningSource = 'rule' | 'inherit' | 'escalation';

export type ReasonCode =
  | 'simple_chat'
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
  userCorrection: boolean;
  constraintCount: number;
  requiresStructuredComparison: boolean;
  previousFastFailure: boolean;
}

export interface ReasoningDecision {
  mode: ReasoningMode;
  source: ReasoningSource;
  reasonCode: ReasonCode;
}

export interface ReasoningTurnState {
  thinkingTriggered: boolean;
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

export function emptyTurnState(): ReasoningTurnState {
  return { thinkingTriggered: false, rootReasonCode: null };
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
      return { mode: 'fast', source: 'rule', reasonCode: 'direct_delivery' };
    case 'conversation':
      // v1 keeps conversation on fast. user_correction / constraint compare /
      // conflicting context triggers are intentionally not enabled yet.
      return { mode: 'fast', source: 'rule', reasonCode: 'simple_chat' };
    case 'rewrite':
      if (input.previousFastFailure) {
        return { mode: 'thinking', source: 'escalation', reasonCode: 'fast_failure_escalation' };
      }
      return { mode: 'fast', source: 'rule', reasonCode: 'fast_default' };
    case 'tool_planner':
      if (input.terminalFinal || input.requiredTool) {
        return { mode: 'fast', source: 'rule', reasonCode: 'deterministic_tool' };
      }
      if (input.hasDirectPayload) {
        return { mode: 'fast', source: 'rule', reasonCode: 'direct_delivery' };
      }
      if (input.previousToolFailed) {
        return { mode: 'thinking', source: 'rule', reasonCode: 'tool_failure_recovery' };
      }
      if (input.ambiguousTarget) {
        return { mode: 'thinking', source: 'rule', reasonCode: 'tool_ambiguity' };
      }
      if (input.toolCallsMade > 0 && input.iterations > 1) {
        return { mode: 'thinking', source: 'rule', reasonCode: 'tool_multi_step' };
      }
      if (input.toolSelectionRequired) {
        return { mode: 'thinking', source: 'rule', reasonCode: 'tool_selection' };
      }
      return { mode: 'fast', source: 'rule', reasonCode: 'fast_default' };
    case 'tool_synthesis':
      if (input.hasDirectPayload || input.terminalFinal) {
        return { mode: 'fast', source: 'rule', reasonCode: 'direct_delivery' };
      }
      if (turn.thinkingTriggered && turn.rootReasonCode) {
        // Inherit the ORIGINAL root cause that made a planner think; the
        // reasonCode is never 'inherit'.
        return { mode: 'thinking', source: 'inherit', reasonCode: turn.rootReasonCode };
      }
      if (input.requiresStructuredComparison) {
        return { mode: 'thinking', source: 'rule', reasonCode: 'structured_fact_compare' };
      }
      return { mode: 'fast', source: 'rule', reasonCode: 'fast_default' };
  }
}

/**
 * Monotonic turn-level upgrade: once any substantive call decided thinking,
 * later substantive synthesis inherits it. Fast decisions never clear state.
 */
export function mergeTurnState(
  turn: ReasoningTurnState,
  decision: ReasoningDecision,
): ReasoningTurnState {
  if (decision.mode === 'thinking' && !turn.thinkingTriggered) {
    return { thinkingTriggered: true, rootReasonCode: decision.reasonCode };
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
    shadowMode: record.decision.mode,
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
