import crypto from 'node:crypto';
import {
  currentRequestTraceId,
  redactTraceValue,
  traceEvent,
} from '../../requestTrace.js';
import {
  explainModelStickerEligibility,
  listModelStickers,
  pickForModel,
  validateStickerCatalog,
  type ModelStickerPolicy,
  type StickerPick,
} from './index.js';

export type StickerDebugMode = 'off' | 'dry-run' | 'trace-once';
export type StickerDebugTraceStatus = 'running' | 'completed' | 'failed' | 'dry_run';
export type StickerDebugStage =
  | 'started'
  | 'catalog_validated'
  | 'catalog_loaded'
  | 'model_selected'
  | 'selection_validated'
  | 'send_requested'
  | 'send_confirmed'
  | 'finished';

export interface StickerDebugScope {
  groupId?: string;
  userId?: string;
}

export interface StickerDebugState {
  mode: StickerDebugMode;
  scope: StickerDebugScope;
  changedAt: string;
  traceCount: number;
  lastTraceId?: string;
}

export interface StickerDebugEvent {
  seq: number;
  at: string;
  stage: StickerDebugStage;
  status: string;
  data?: Record<string, unknown>;
}

export interface StickerDebugTrace {
  id: string;
  requestId: string;
  operation: 'live' | 'dry-run';
  groupId: string;
  userId: string;
  messageId: string;
  mode: StickerDebugMode;
  status: StickerDebugTraceStatus;
  startedAt: string;
  finishedAt?: string;
  eventCount: number;
  events: StickerDebugEvent[];
}

export interface StickerDebugSession {
  traceId: string;
  mode: StickerDebugMode;
  record(stage: StickerDebugStage, status: string, data?: Record<string, unknown>): void;
  finish(status: Exclude<StickerDebugTraceStatus, 'running'>, data?: Record<string, unknown>): StickerDebugTrace;
  snapshot(): StickerDebugTrace | undefined;
}

export interface StickerDryRunInput {
  stickerId: string;
  groupId?: string;
  userId?: string;
  messageId?: string;
  policy?: ModelStickerPolicy;
  /** Full asset hashing is for manual diagnostics; runtime selection can skip it. */
  verifyHashes?: boolean;
}

export interface StickerDryRunResult {
  ok: boolean;
  trace: StickerDebugTrace;
  selected?: Pick<StickerPick, 'id' | 'name' | 'emotion' | 'risk'>;
  error?: string;
}

export interface StickerSelectionValidationResult {
  ok: boolean;
  selected?: Pick<StickerPick, 'id' | 'name' | 'emotion' | 'risk' | 'path'>;
  reason?: string;
  error?: string;
  validation?: ReturnType<typeof validateStickerCatalog>;
  candidateCount?: number;
}

const MAX_TRACES = 64;
const MAX_EVENTS = 40;
const traces = new Map<string, StickerDebugTrace>();
const order: string[] = [];

let state: StickerDebugState = {
  mode: 'off',
  scope: {},
  changedAt: new Date().toISOString(),
  traceCount: 0,
};

function cleanId(value: unknown, max = 160): string {
  return String(value ?? '').trim().slice(0, max);
}

function scopeMatches(input: { groupId?: unknown; userId?: unknown }, scope: StickerDebugScope): boolean {
  const groupId = cleanId(input.groupId, 80);
  const userId = cleanId(input.userId, 80);
  return (!scope.groupId || scope.groupId === groupId)
    && (!scope.userId || scope.userId === userId);
}

function snapshot(trace: StickerDebugTrace | undefined): StickerDebugTrace | undefined {
  if (!trace) return undefined;
  return {
    ...trace,
    events: trace.events.map((event) => ({
      ...event,
      ...(event.data ? { data: structuredClone(event.data) } : {}),
    })),
  };
}

function addTrace(trace: StickerDebugTrace): void {
  traces.set(trace.id, trace);
  order.push(trace.id);
  while (order.length > MAX_TRACES) {
    const expired = order.shift();
    if (expired) traces.delete(expired);
  }
  state.traceCount += 1;
  state.lastTraceId = trace.id;
}

function traceData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data || Object.keys(data).length === 0) return undefined;
  return redactTraceValue(data, 2) as Record<string, unknown>;
}

function recordEvent(
  trace: StickerDebugTrace,
  stage: StickerDebugStage,
  status: string,
  data: Record<string, unknown> = {},
): void {
  trace.eventCount += 1;
  trace.events.push({
    seq: trace.eventCount,
    at: new Date().toISOString(),
    stage,
    status: cleanId(status, 80),
    ...(Object.keys(data).length ? { data: traceData(data) } : {}),
  });
  trace.events = trace.events.slice(-MAX_EVENTS);

  traceEvent('TOOL', `sticker_debug_${stage}`, {
    status,
    stickerDebugTraceId: trace.id,
    ...data,
  });
}

function startTrace(
  input: {
    operation: 'live' | 'dry-run';
    groupId?: unknown;
    userId?: unknown;
    messageId?: unknown;
  },
  options: { force?: boolean; modeOverride?: StickerDebugMode } = {},
): StickerDebugSession | null {
  const effectiveMode = options.modeOverride || state.mode;
  if (!options.force && (effectiveMode === 'off' || !scopeMatches(input, state.scope))) return null;

  if (!options.force && effectiveMode === 'trace-once') {
    state = { ...state, mode: 'off', changedAt: new Date().toISOString() };
  }

  const trace: StickerDebugTrace = {
    id: `sticker:${Date.now().toString(36)}:${crypto.randomBytes(4).toString('hex')}`,
    requestId: currentRequestTraceId(),
    operation: input.operation,
    groupId: cleanId(input.groupId, 80),
    userId: cleanId(input.userId, 80),
    messageId: cleanId(input.messageId, 160),
    mode: effectiveMode,
    status: 'running',
    startedAt: new Date().toISOString(),
    eventCount: 0,
    events: [],
  };
  addTrace(trace);
  recordEvent(trace, 'started', 'running', {
    operation: trace.operation,
    requestId: trace.requestId || undefined,
    groupId: trace.groupId || undefined,
    userId: trace.userId || undefined,
    messageId: trace.messageId || undefined,
  });

  return {
    traceId: trace.id,
    mode: effectiveMode,
    record: (stage, status, data = {}) => {
      if (trace.status !== 'running') return;
      recordEvent(trace, stage, status, data);
    },
    finish: (status, data = {}) => {
      if (trace.status !== 'running') return snapshot(trace)!;
      recordEvent(trace, 'finished', status, data);
      trace.status = status;
      trace.finishedAt = new Date().toISOString();
      return snapshot(trace)!;
    },
    snapshot: () => snapshot(trace),
  };
}

export function getStickerDebugState(): StickerDebugState {
  return { ...state, scope: { ...state.scope } };
}

export function setStickerDebugMode(mode: StickerDebugMode, scope: StickerDebugScope = {}): StickerDebugState {
  state = {
    mode,
    scope: {
      ...(scope.groupId ? { groupId: cleanId(scope.groupId, 80) } : {}),
      ...(scope.userId ? { userId: cleanId(scope.userId, 80) } : {}),
    },
    changedAt: new Date().toISOString(),
    traceCount: state.traceCount,
    ...(state.lastTraceId ? { lastTraceId: state.lastTraceId } : {}),
  };
  return getStickerDebugState();
}

export function listStickerDebugTraces(limit = 20): StickerDebugTrace[] {
  const bounded = Math.max(1, Math.min(Number(limit) || 20, MAX_TRACES));
  return order.slice(-bounded).reverse()
    .map((id) => snapshot(traces.get(id)))
    .filter((trace): trace is StickerDebugTrace => Boolean(trace));
}

export function clearStickerDebugTraces(): void {
  traces.clear();
  order.splice(0, order.length);
  state = { ...state, traceCount: 0, lastTraceId: undefined };
}

/**
 * Validate a model-selected ID without creating a debug trace. Normal live
 * traffic uses this lower-half check; explicit dry-run requests use the full
 * traced wrapper below.
 */
export function validateStickerSelection(input: {
  stickerId: string;
  policy?: ModelStickerPolicy;
  verifyHashes?: boolean;
}): StickerSelectionValidationResult {
  let validation: ReturnType<typeof validateStickerCatalog>;
  try {
    validation = validateStickerCatalog({ verifyHashes: input.verifyHashes !== false });
  } catch {
    return { ok: false, reason: 'catalog_read_failed', error: '表情包清单或视觉标注无法读取' };
  }
  if (!validation.ok) {
    return { ok: false, reason: 'catalog_invalid', error: '表情包清单或视觉标注不完整', validation };
  }
  const policy = input.policy || {};
  const candidates = listModelStickers(policy);
  const stickerId = cleanId(input.stickerId, 80);
  if (!stickerId) return { ok: false, reason: 'unknown_id', error: '缺少 stickerId', validation, candidateCount: candidates.length };
  const eligibility = explainModelStickerEligibility(stickerId, policy);
  if (!eligibility.ok) {
    return {
      ok: false,
      reason: eligibility.reason,
      error: `图片未通过模型选择校验：${eligibility.reason}`,
      validation,
      candidateCount: candidates.length,
    };
  }
  const picked = pickForModel(stickerId, policy);
  if (!picked) {
    return {
      ok: false,
      reason: 'selection_resolution_failed',
      error: '图片不存在、未开放给模型或模式不允许',
      validation,
      candidateCount: candidates.length,
    };
  }
  return {
    ok: true,
    validation,
    candidateCount: candidates.length,
    selected: {
      id: picked.id,
      name: picked.name,
      emotion: picked.emotion,
      risk: picked.risk,
      path: picked.path,
    },
  };
}

/**
 * Offline lower-half check: validate a model-returned sticker ID and show
 * exactly what would be sent. No LLM call and no QQ request happen here.
 */
export function runStickerDryRun(input: StickerDryRunInput): StickerDryRunResult {
  const session = startTrace({
    operation: 'dry-run',
    groupId: input.groupId,
    userId: input.userId,
    messageId: input.messageId,
  }, { force: true, modeOverride: 'dry-run' });
  if (!session) throw new Error('无法创建表情调试 trace');

  let validation;
  try {
    validation = validateStickerCatalog({ verifyHashes: input.verifyHashes !== false });
  } catch (error) {
    const trace = session.finish('failed', {
      reason: 'catalog_read_failed',
      error: String((error as Error)?.message || error).slice(0, 300),
    });
    return { ok: false, trace, error: '表情包清单或视觉标注无法读取' };
  }
  session.record('catalog_validated', validation.ok ? 'ok' : 'failed', {
    manifestCount: validation.manifestCount,
    annotationCount: validation.annotationCount,
    missingAnnotations: validation.missingAnnotations,
    extraAnnotations: validation.extraAnnotations,
    duplicateIds: validation.duplicateIds,
    missingFiles: validation.missingFiles,
    hashMismatches: validation.hashMismatches,
    invalidEntries: validation.invalidEntries,
  });
  if (!validation.ok) {
    const trace = session.finish('failed', { reason: 'catalog_invalid' });
    return { ok: false, trace, error: '表情包清单或视觉标注不完整' };
  }

  const policy = input.policy || {};
  const candidates = listModelStickers(policy);
  session.record('catalog_loaded', 'ok', {
    candidateCount: candidates.length,
    maxRisk: policy.maxRisk || 'medium',
    allowedGates: policy.allowedGates || ['loose'],
    allowedModes: policy.allowedModes || ['random'],
    contextTopics: policy.contextTopics || [],
    verifyHashes: input.verifyHashes !== false,
  });

  const stickerId = cleanId(input.stickerId, 80);
  session.record('model_selected', stickerId ? 'received' : 'missing', {
    stickerId: stickerId || undefined,
    source: 'dry-run input',
  });
  const eligibility = stickerId
    ? explainModelStickerEligibility(stickerId, policy)
    : { ok: false, reason: 'unknown_id' as const };
  if (!eligibility.ok) {
    const trace = session.finish('failed', {
      reason: eligibility.reason,
      stickerId: stickerId || undefined,
      manifestEntry: eligibility.entry
        ? {
            name: eligibility.entry.name,
            risk: eligibility.entry.risk,
            gate: eligibility.entry.gate,
            mode: eligibility.entry.mode,
          }
        : undefined,
    });
    return {
      ok: false,
      trace,
      error: stickerId
        ? `图片未通过模型选择校验：${eligibility.reason}`
        : '缺少 stickerId',
    };
  }
  const picked = stickerId ? pickForModel(stickerId, policy) : null;
  if (!picked) {
    const trace = session.finish('failed', {
      reason: 'selection_resolution_failed',
      stickerId: stickerId || undefined,
    });
    return {
      ok: false,
      trace,
      error: stickerId ? '图片不存在、未开放给模型或模式不允许' : '缺少 stickerId',
    };
  }

  session.record('selection_validated', 'ok', {
    stickerId: picked.id,
    name: picked.name,
    emotion: picked.emotion,
    risk: picked.risk,
    pathPresent: true,
  });
  session.record('send_requested', 'skipped', {
    stickerId: picked.id,
    reason: 'dry_run',
  });
  const trace = session.finish('dry_run', {
    wouldSend: picked.id,
    sendSkipped: true,
  });
  return {
    ok: true,
    trace,
    selected: {
      id: picked.id,
      name: picked.name,
      emotion: picked.emotion,
      risk: picked.risk,
    },
  };
}

/** Entry point for the future live send_sticker tool. */
export function beginLiveStickerDebug(input: {
  groupId?: unknown;
  userId?: unknown;
  messageId?: unknown;
}): StickerDebugSession | null {
  return startTrace({ operation: 'live', ...input });
}

export function stickerDebugShouldDryRun(input: { groupId?: unknown; userId?: unknown }): boolean {
  return state.mode === 'dry-run' && scopeMatches(input, state.scope);
}
