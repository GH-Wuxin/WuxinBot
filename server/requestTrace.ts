import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export const TRACE_PHASES = [
  'INGRESS', 'NORMALIZE', 'GATE', 'ROUTER', 'KB', 'TOOL', 'PROMPT',
  'MODEL', 'REVIEW', 'REWRITE', 'QUEUE', 'SEND', 'COMPLETE', 'ERROR',
] as const;

type TracePhase = typeof TRACE_PHASES[number];
type TraceStatus = 'active' | 'completed' | 'failed';

export interface RequestTraceEvent {
  id: string;
  seq: number;
  at: string;
  phase: TracePhase;
  name: string;
  status?: string;
  durationMs?: number;
  data?: unknown;
}

export interface RequestTrace {
  id: string;
  messageId: string;
  groupId: string;
  userId: string;
  nickname: string;
  messageType: string;
  status: TraceStatus;
  startedAt: string;
  finishedAt?: string;
  eventCount: number;
  events: RequestTraceEvent[];
}

const MAX_REQUESTS = 160;
const MAX_EVENTS_PER_REQUEST = 120;
const MAX_STRING = 12_000;
const context = new AsyncLocalStorage<{ requestId: string }>();
const traces = new Map<string, RequestTrace>();
const order: string[] = [];
const subscribers = new Set<(trace: unknown) => void>();
const MAX_SUBSCRIBERS = 32;
const secretKey = /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|passwd|secret/i;
const secretValue = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}/gi;

function safeString(value: unknown, max = MAX_STRING) {
  return String(value ?? '')
    .replace(secretValue, '[REDACTED]')
    .replace(/((?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|passwd|secret)\s*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1[REDACTED]')
    .slice(0, max);
}

function parseToolArguments(value: unknown) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function redactTraceValue(value: unknown, depth = 0): unknown {
  try {
    if (depth > 5) return '[TRUNCATED]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return safeString(value);
    if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactTraceValue(item, depth + 1));
    if (typeof value === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
        output[key] = secretKey.test(key) ? '[REDACTED]' : redactTraceValue(item, depth + 1);
      }
      return output;
    }
    return safeString(value);
  } catch {
    return '[UNAVAILABLE]';
  }
}

export function requestTraceIdFor(event: any) {
  const messageId = safeString(event?.messageId || crypto.randomUUID(), 160);
  const groupId = safeString(event?.groupId || 'private', 80);
  return `qq:${groupId}:${messageId}`;
}

function publishTrace(trace: RequestTrace) {
  try {
    if (subscribers.size === 0) return;
    const snapshot = redactTraceValue(trace);
    for (const subscriber of subscribers) {
      try { subscriber(snapshot); } catch { /* A broken console client is isolated. */ }
    }
  } catch {
    // Publishing diagnostics must never affect the QQ path.
  }
}

export function subscribeRequestTraces(listener: (trace: unknown) => void) {
  try {
    if (subscribers.size >= MAX_SUBSCRIBERS) return null;
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  } catch {
    return null;
  }
}

export function startRequestTrace(event: any, requestId = requestTraceIdFor(event)) {
  try {
    const trace: RequestTrace = {
      id: requestId,
      messageId: safeString(event?.messageId, 160),
      groupId: safeString(event?.groupId, 80),
      userId: safeString(event?.userId, 80),
      nickname: safeString(event?.nickname, 120),
      messageType: safeString(event?.type, 30),
      status: 'active',
      startedAt: new Date().toISOString(),
      eventCount: 0,
      events: [],
    };
    traces.set(requestId, trace);
    const oldIndex = order.indexOf(requestId);
    if (oldIndex >= 0) order.splice(oldIndex, 1);
    order.push(requestId);
    while (order.length > MAX_REQUESTS) {
      const expired = order.shift();
      if (expired) traces.delete(expired);
    }
    publishTrace(trace);
    return requestId;
  } catch {
    return requestId;
  }
}

export function currentRequestTraceId() {
  try { return context.getStore()?.requestId || ''; } catch { return ''; }
}

export function withRequestTrace<T>(requestId: string, fn: () => T): T {
  return context.run({ requestId }, fn);
}

export function traceEvent(phase: TracePhase, name: string, detail: Record<string, unknown> = {}) {
  try {
    const requestId = currentRequestTraceId();
    const trace = traces.get(requestId);
    if (!trace || trace.status !== 'active' || !TRACE_PHASES.includes(phase)) return;
    trace.eventCount += 1;
    const { status, durationMs, ...data } = detail;
    trace.events.push({
      id: crypto.randomUUID(),
      seq: trace.eventCount,
      at: new Date().toISOString(),
      phase,
      name: safeString(name, 160),
      ...(status ? { status: safeString(status, 40) } : {}),
      ...(Number.isFinite(Number(durationMs)) ? { durationMs: Number(durationMs) } : {}),
      ...(Object.keys(data).length ? { data: redactTraceValue(data) } : {}),
    });
    trace.events = trace.events.slice(-MAX_EVENTS_PER_REQUEST);
    publishTrace(trace);
  } catch {
    // Console observability must never affect the QQ message path.
  }
}

export function traceModelStream(invocationId: string, detail: Record<string, unknown> = {}) {
  try {
    const trace = traces.get(currentRequestTraceId());
    if (!trace || trace.status !== 'active') return;
    const safeInvocationId = safeString(invocationId, 160);
    let existing: RequestTraceEvent | undefined;
    for (let index = trace.events.length - 1; index >= 0; index -= 1) {
      const event = trace.events[index];
      const data = event.data as Record<string, unknown> | undefined;
      if (event.phase === 'MODEL' && event.name === 'model_call_streaming' && data?.invocationId === safeInvocationId) {
        existing = event;
        break;
      }
    }
    const { status, durationMs, ...data } = detail;
    const next = { invocationId: safeInvocationId, ...data };
    if (existing) {
      existing.at = new Date().toISOString();
      if (status) existing.status = safeString(status, 40);
      if (Number.isFinite(Number(durationMs))) existing.durationMs = Number(durationMs);
      existing.data = redactTraceValue(next);
    } else {
      trace.eventCount += 1;
      trace.events.push({
        id: crypto.randomUUID(),
        seq: trace.eventCount,
        at: new Date().toISOString(),
        phase: 'MODEL',
        name: 'model_call_streaming',
        ...(status ? { status: safeString(status, 40) } : {}),
        ...(Number.isFinite(Number(durationMs)) ? { durationMs: Number(durationMs) } : {}),
        data: redactTraceValue(next),
      });
      trace.events = trace.events.slice(-MAX_EVENTS_PER_REQUEST);
    }
    publishTrace(trace);
  } catch {
    // Streaming diagnostics must never affect the model request.
  }
}

export function finishRequestTrace(status: Exclude<TraceStatus, 'active'>, detail: Record<string, unknown> = {}) {
  try {
    const trace = traces.get(currentRequestTraceId());
    if (!trace || trace.status !== 'active') return;
    traceEvent(status === 'failed' ? 'ERROR' : 'COMPLETE', status === 'failed' ? 'request_failed' : 'request_completed', {
      status,
      ...detail,
    });
    trace.status = status;
    trace.finishedAt = new Date().toISOString();
    publishTrace(trace);
  } catch {
    // Fail open.
  }
}

export function listRequestTraces(limit = 80) {
  try {
    return order.slice(-Math.max(1, Math.min(Number(limit) || 80, MAX_REQUESTS))).reverse()
      .map((id) => traces.get(id))
      .filter(Boolean)
      .map((trace) => redactTraceValue(trace));
  } catch {
    return [];
  }
}

export function extractProviderResponseTrace(response: any) {
  const message = response?.choices?.[0]?.message || {};
  const reasoning = ['reasoning_content', 'reasoning', 'thinking']
    .map((key) => typeof message?.[key] === 'string' ? message[key] : '')
    .find(Boolean) || '';
  const usage = response?.usage || {};
  return redactTraceValue({
    content: typeof message?.content === 'string' ? message.content : '',
    reasoning,
    reasoningExposed: Boolean(reasoning),
    toolCalls: (message?.tool_calls || []).map((call: any) => ({
      id: call?.id,
      name: call?.function?.name,
      arguments: parseToolArguments(call?.function?.arguments),
    })),
    finishReason: response?.choices?.[0]?.finish_reason || '',
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
    },
  });
}

export function clearRequestTracesForTest() {
  traces.clear();
  order.splice(0, order.length);
  subscribers.clear();
}
