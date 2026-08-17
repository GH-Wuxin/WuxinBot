// Lightweight telemetry for rewriteNormalReply.
//
// Purpose: make the normal-chat rewrite guard measurable without adding LLM
// calls, synchronous diff work, or a new database collection. Events reuse
// the existing `usageEvents` stream with kind='rewrite-reply'.
//
// Privacy: full plaintext is never stored. Only ids, hashes, character counts,
// usage, latency and the deterministic result code are persisted.
import crypto from 'node:crypto';
import { updateDb, nowIso } from '../store.js';

export type RewriteTelemetryResult =
  | 'SKIPPED'
  | 'UNCHANGED'
  | 'CHANGED'
  | 'ERROR_FALLBACK'
  | 'EMPTY_FALLBACK'
  | 'TIMEOUT_FALLBACK'
  | 'OTHER_FALLBACK';

export interface RewriteTelemetryEntry {
  id: string;
  kind: 'rewrite-reply';
  eventType: string;
  messageId?: string;
  turnId?: string;
  groupId?: string;
  userId?: string;
  eligible: boolean;
  invoked: boolean;
  skipReason?: string;
  provider?: string;
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  usageAvailable: boolean;
  latencyMs?: number | null;
  result: RewriteTelemetryResult;
  originalChars: number;
  rewrittenChars: number;
  contentChanged: boolean;
  originalHash?: string;
  rewrittenHash?: string;
  createdAt: string;
}

export function sha256Text(text: unknown): string {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Deterministic light normalization used only for content_changed comparison.
 * This is intentionally NOT prose cleanup: trim, unify newlines, collapse
 * whitespace. No LLM is involved.
 */
export function normalizeRewriteText(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textChanged(original: unknown, rewritten: unknown): boolean {
  return normalizeRewriteText(original) !== normalizeRewriteText(rewritten);
}

export function usageToken(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function classifyTimeout(error: unknown): boolean {
  const message = String((error as { message?: string } | undefined)?.message || '');
  return /超时|timeout|aborted/i.test(message);
}

export interface BuildRewriteEntryInput {
  event?: {
    type?: string;
    messageId?: string;
    groupId?: string;
    userId?: string;
  };
  turnId?: string;
  eligible: boolean;
  invoked: boolean;
  skipReason?: string;
  provider?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number | null;
    input_tokens?: number | null;
    completion_tokens?: number | null;
    output_tokens?: number | null;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
    input_tokens_details?: { cached_tokens?: number | null } | null;
  } | null;
  usageAvailable: boolean;
  latencyMs?: number | null;
  result: RewriteTelemetryResult;
  originalText?: string;
  rewrittenText?: string;
  createdAt?: string;
}

export function buildRewriteEntry(input: BuildRewriteEntryInput): RewriteTelemetryEntry {
  const originalText = input.originalText ?? '';
  const rewrittenText = input.rewrittenText ?? '';
  const usage = input.usage || null;
  const promptTokens = usageToken(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = usageToken(usage?.completion_tokens ?? usage?.output_tokens);
  const cachedTokens = usageToken(
    usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.input_tokens_details?.cached_tokens
    ?? null,
  );
  const originalChars = originalText.length;
  const rewrittenChars = rewrittenText.length;
  const contentChanged = textChanged(originalText, rewrittenText);
  return {
    id: crypto.randomUUID(),
    kind: 'rewrite-reply',
    eventType: String(input.event?.type || 'unknown'),
    messageId: input.event?.messageId ? String(input.event.messageId) : undefined,
    turnId: input.turnId ? String(input.turnId) : undefined,
    groupId: input.event?.groupId ? String(input.event.groupId) : undefined,
    userId: input.event?.userId ? String(input.event.userId) : undefined,
    eligible: Boolean(input.eligible),
    invoked: Boolean(input.invoked),
    skipReason: input.skipReason || undefined,
    provider: input.provider || undefined,
    model: input.model || undefined,
    inputTokens: promptTokens,
    outputTokens: outputTokens,
    cachedInputTokens: cachedTokens,
    usageAvailable: Boolean(input.usageAvailable),
    latencyMs: typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
      ? input.latencyMs
      : null,
    result: input.result,
    originalChars,
    rewrittenChars,
    contentChanged,
    originalHash: sha256Text(originalText),
    rewrittenHash: sha256Text(rewrittenText),
    createdAt: input.createdAt || nowIso(),
  };
}

/**
 * Persist one rewrite telemetry event into db.usageEvents.
 *
 * Failure contract: a telemetry write failure must never alter the user reply.
 * The caller is reply.ts / bot.ts; this function catches every error and only
 * logs it. It does not add to db.usage totals here because bot.ts already
 * merges the rewrite LLM usage into the reply usage aggregate exactly once.
 */
export async function recordRewriteTelemetry(
  _db: unknown,
  entry: RewriteTelemetryEntry,
  writeFn: (mutator: (draft: any) => void) => void = updateDb,
): Promise<boolean> {
  try {
    writeFn((draft: any) => {
      draft.usageEvents ||= [];
      draft.usageEvents.push(entry);
      draft.usageEvents = draft.usageEvents.slice(-5000);
    });
    return true;
  } catch (error) {
    console.error('[rewrite-telemetry] write failed (reply unaffected):', String(error?.message || error));
    return false;
  }
}
