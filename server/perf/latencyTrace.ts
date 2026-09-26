// Default-off, behavior-transparent latency tracing for performance audits.
//
// Enabled only by PERF_TRACE=1. When disabled every function is a cheap no-op
// and no file I/O is performed. Traces are kept in memory and can optionally
// be appended as JSONL to PERF_TRACE_DIR while enabled.
//
// Privacy contract: callers may only pass stage names, counts, booleans and
// enum-like values in `meta`. Never pass message text, QQ ids, osu ids,
// usernames, URLs or any other private content.
import fs from 'node:fs';
import path from 'node:path';

const ENABLED = process.env.PERF_TRACE === '1';
const TRACE_DIR = process.env.PERF_TRACE_DIR || '';
const MAX_TRACES = 500;

export interface LatencyMeta {
  [key: string]: string | number | boolean | null | undefined;
}

export interface LatencySpan {
  stage: string;
  elapsedMs: number;
  sincePrevMs: number;
  monotonicNs: bigint;
  meta?: LatencyMeta;
}

export interface LatencyTrace {
  traceId: string;
  scope: string;
  startedAtMs: number;
  startedAtNs: bigint;
  finished: boolean;
  finishedAtMs: number;
  durationMs: number;
  spans: LatencySpan[];
  meta?: LatencyMeta;
}

const traces = new Map<string, LatencyTrace>();
const active = new Map<string, { startedAtNs: bigint; lastNs: bigint }>();
let seq = 0;

export function isLatencyTraceEnabled(): boolean {
  return ENABLED;
}

export function beginLatencyTrace(scope: string, meta?: LatencyMeta): string | null {
  if (!ENABLED) return null;
  const startedAtNs = process.hrtime.bigint();
  const startedAtMs = performance.now();
  seq += 1;
  const traceId = `${Date.now().toString(36)}-${seq.toString(36)}-${scope.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  traces.set(traceId, {
    traceId,
    scope,
    startedAtMs,
    startedAtNs,
    finished: false,
    finishedAtMs: 0,
    durationMs: 0,
    spans: [],
    meta: sanitizeMeta(meta),
  });
  active.set(traceId, { startedAtNs, lastNs: startedAtNs });
  appendTraceLine('begin', { traceId, scope, meta: sanitizeMeta(meta) });
  return traceId;
}

export function markLatencySpan(
  traceId: string | null | undefined,
  stage: string,
  meta?: LatencyMeta,
): void {
  if (!ENABLED || !traceId) return;
  const state = active.get(traceId);
  const trace = traces.get(traceId);
  if (!state || !trace) return;
  const nowNs = process.hrtime.bigint();
  const elapsedMs = Number(nowNs - state.startedAtNs) / 1e6;
  const sincePrevMs = Number(nowNs - state.lastNs) / 1e6;
  state.lastNs = nowNs;
  trace.spans.push({
    stage,
    elapsedMs,
    sincePrevMs,
    monotonicNs: nowNs,
    meta: sanitizeMeta(meta),
  });
  appendTraceLine('span', { traceId, stage, elapsedMs, sincePrevMs, meta: sanitizeMeta(meta) });
}

export function finishLatencyTrace(traceId: string | null | undefined, meta?: LatencyMeta): void {
  if (!ENABLED || !traceId) return;
  const state = active.get(traceId);
  const trace = traces.get(traceId);
  if (!state || !trace) return;
  trace.finished = true;
  trace.finishedAtMs = performance.now();
  trace.durationMs = trace.finishedAtMs - trace.startedAtMs;
  if (meta) trace.meta = { ...(trace.meta || {}), ...sanitizeMeta(meta) };
  active.delete(traceId);
  appendTraceLine('finish', { traceId, durationMs: trace.durationMs, meta: trace.meta });
  if (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (oldest) traces.delete(oldest);
  }
}

export function getLatencyTraces(): LatencyTrace[] {
  return [...traces.values()];
}

export function clearLatencyTraces(): void {
  traces.clear();
  active.clear();
}

function sanitizeMeta(meta?: LatencyMeta): LatencyMeta | undefined {
  if (!meta) return undefined;
  const out: LatencyMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.length > 80) continue;
    out[key] = value;
  }
  return out;
}

function appendTraceLine(kind: string, payload: Record<string, unknown>): void {
  if (!TRACE_DIR) return;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    const file = path.join(TRACE_DIR, 'latency-trace.jsonl');
    fs.appendFileSync(file, `${JSON.stringify({ kind, atNs: process.hrtime.bigint().toString(), ...payload })}\n`, 'utf8');
  } catch {
    // Tracing must never affect application behavior.
  }
}
