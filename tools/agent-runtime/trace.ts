import { createHash } from 'node:crypto';
import type { LlmToolCall } from '../../server/bots/types.js';
import type { ReasoningShadowRecord } from '../../server/bot/reasoningRouter.js';
import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  TRACE_VERSION,
  type JsonValue,
  type ReplayTerminal,
  type ReplayTrace,
  type ReplayTraceEvent,
  type TraceEventType,
} from './types.js';

export function sanitizeTraceString(input: string): string {
  return String(input)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d{13}\b/g, '<timestamp_ms>')
    .replace(/(?:[A-Za-z]:[\\/])(?:[^<>:"|?*\r\n]+[\\/])*[^<>:"|?*\r\n]*?(?=:\d+:\d+|[)\],;]|$)/g, '<abs_path>')
    .replace(/(^|[\s("'=])\/(?:[^/\s:]+\/)+[^)\]\s,:;]*/g, '$1<abs_path>')
    .replace(/<abs_path>:\d+:\d+/g, '<stack_location>')
    .replace(/((?:https?:\/\/[^\s/:]+)|\b(?:localhost|127\.0\.0\.1)):\d{2,5}\b/gi, '$1:<port>')
    .replace(/\bport\s*[=:]\s*\d{2,5}\b/gi, 'port=<port>');
}

function identityToken(kind: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex');
  return `<${kind}:${digest}>`;
}

function sanitizeIdentityString(input: string): string {
  const value = String(input);
  if (/^<[a-z_]+:[0-9a-f]{64}>$/i.test(value)) return value;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(value)) {
    return identityToken('uuid', value);
  }
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/.test(value) || /\b\d{13}\b/.test(value)) {
    return identityToken('timestamp', value);
  }
  if (/[A-Za-z]:[\\/]|\\\\|(?:^|[\s("'=])\//.test(value)) {
    return identityToken('path', value);
  }
  if (/((?:https?:\/\/[^\s/:]+)|\b(?:localhost|127\.0\.0\.1)):\d{2,5}\b/i.test(value) ||
      /\bport\s*[=:]\s*\d{2,5}\b/i.test(value)) {
    return identityToken('port', value);
  }
  return value;
}

function normalized(value: unknown, keyHint = '', identityAware = false): JsonValue {
  if (value === null || typeof value === 'boolean') return value as null | boolean;
  if (typeof value === 'string') {
    return identityAware ? sanitizeIdentityString(value) : sanitizeTraceString(value);
  }
  if (typeof value === 'number') {
    if (/^(?:ts|timestamp|createdAt|latencyMs|durationMs|elapsedMs|port)$/i.test(keyHint)) {
      return identityAware
        ? identityToken(keyHint || 'volatile', String(value))
        : `<${keyHint || 'volatile'}>`;
    }
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) return value.map((item) => normalized(item, keyHint, identityAware));
  if (value && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      const childIdentityAware = identityAware || ['args', 'context', 'data', 'metadata'].includes(key);
      if (item !== undefined) output[key] = normalized(item, key, childIdentityAware);
    }
    return output;
  }
  return String(value ?? '');
}

export function parseToolArguments(call: LlmToolCall): {
  args: JsonValue;
  malformed: boolean;
  rawArguments?: string;
} {
  const raw = String(call.function?.arguments || '{}');
  try {
    return { args: JSON.parse(raw) as JsonValue, malformed: false };
  } catch {
    return { args: null, malformed: true, rawArguments: raw };
  }
}

export class TraceRecorder {
  readonly events: ReplayTraceEvent[] = [];
  private readonly callIds = new Map<string, string>();

  constructor(
    readonly scenarioId: string,
    readonly seed: number,
  ) {}

  toolCallId(rawId: string): string {
    const key = String(rawId || '<empty>');
    let alias = this.callIds.get(key);
    if (!alias) {
      alias = `tc${this.callIds.size + 1}`;
      this.callIds.set(key, alias);
    }
    return alias;
  }

  push(type: TraceEventType, data: Record<string, unknown>): ReplayTraceEvent {
    const event: ReplayTraceEvent = {
      seq: this.events.length,
      type,
      data: normalized(data) as Record<string, JsonValue>,
    };
    this.events.push(event);
    return event;
  }

  reasoning(record: ReasoningShadowRecord): void {
    this.push('reasoning', {
      callRole: record.callRole,
      decision: record.decision,
      input: record.input,
      actual: record.actual,
    });
  }

  finish(terminal: ReplayTerminal): ReplayTrace {
    const safeTerminal = normalized(terminal) as unknown as ReplayTerminal;
    this.push('terminal', safeTerminal as unknown as Record<string, unknown>);
    return {
      traceVersion: TRACE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      scenarioId: sanitizeTraceString(this.scenarioId),
      seed: this.seed,
      events: this.events,
      terminal: safeTerminal,
    };
  }
}

function compactData(event: ReplayTraceEvent): string {
  const d = event.data as Record<string, any>;
  switch (event.type) {
    case 'llm_call':
      return `llm#${d.callIndex} label=${JSON.stringify(d.label || '')} tools=${JSON.stringify(d.exposedTools || [])}`;
    case 'llm_result':
      return `llm#${d.callIndex} result text=${JSON.stringify(d.text)} toolCalls=${JSON.stringify(d.toolCalls || [])}`;
    case 'llm_throw':
      return `llm#${d.callIndex} throw ${d.error?.name || 'Error'}: ${d.error?.message || ''}`;
    case 'tool_call':
      return `tool#${d.callIndex} ${d.toolCallId} ${d.name} args=${JSON.stringify(d.args)}`;
    case 'tool_result':
      return `tool#${d.callIndex} ${d.toolCallId} ok=${d.ok} final=${Boolean(d.final)} direct=${Boolean(d.directContent)} images=${d.imageCount || 0}`;
    case 'tool_throw':
      return `tool#${d.callIndex} ${d.toolCallId} throw ${d.error?.name || 'Error'}: ${d.error?.message || ''}`;
    case 'scheduler_tick':
      return `tick ${d.tick} ${d.label || ''}`.trim();
    case 'settlement_attempt':
      return `${d.boundary}#${d.callIndex} ${d.attempt} accepted=${Boolean(d.accepted)}`;
    case 'turn_control':
      return `turn_control ${d.kind} tick=${d.tick}`;
    case 'control_suppressed':
      return `control_suppressed ${d.kind} tick=${d.tick}`;
    case 'runtime_settled_after_control':
      return `runtime_settled_after_control ${d.controlKind} outcome=${d.outcome}`;
    case 'final_signal_observed':
      return `final_signal_observed ${d.toolCallId || ''}`.trim();
    case 'business_effect':
      return `business_effect ${d.kind || ''}`.trim();
    case 'housekeeping_effect':
      return `housekeeping_effect ${d.kind || ''}`.trim();
    case 'harness_isolation':
      return `harness_isolation fetchBlocked=${Boolean(d.fetchBlocked)} llmInjected=${Boolean(d.llmInjected)} toolExecutorInjected=${Boolean(d.toolExecutorInjected)}`;
    case 'reasoning':
      return `reasoning ${d.callRole} -> ${d.decision?.mode}/${d.decision?.reasonCode}`;
    case 'adapter_error':
      return `adapter_error ${d.message || ''}`;
    case 'terminal':
      return `terminal ${d.kind}`;
  }
}

export function formatReplayTrace(trace: ReplayTrace): string {
  return trace.events
    .map((event) => `${String(event.seq).padStart(3, '0')} ${compactData(event)}`)
    .join('\n');
}

export function normalizedJson(value: unknown): string {
  return JSON.stringify(normalized(value), null, 2);
}

/** Stable semantic comparison form: sorted keys, with sensitive identities
 * replaced by deterministic digests instead of collapsing distinct values. */
export function semanticJson(value: unknown): string {
  return JSON.stringify(normalized(value, '', true), null, 2);
}
