// Quick-context pending observation synchronization (QUICK_CONTEXT_FIX_QB08).
//
// Quick replies keep their latency contract: the visible reply is sent first
// and the observation work (e.g. buildQuickShadowSummary) still runs
// fire-and-forget. To close the visible-vs-context race WITHOUT waiting on the
// visible path, quickRouter writes a placeholder context record synchronously
// and registers the hydration promise here. The NEXT conversational turn for
// the same conversation identity drains (bounded-await) the pending entries
// that became visible before that turn, then builds its LLM context from the
// now-complete db.messages.
//
// Strict isolation rules:
// - key = group:<groupId>:<userId> for group messages, private:<userId> for
//   private messages; a user never waits for another user's shadow work and a
//   group never waits for another group.
// - only entries registered before the turn begins are awaited; a quick
//   command that becomes visible later is not relevant to this turn.
// - a NEW quick operation only registers a NEW entry; it can never overwrite
//   an older entry (the placeholder record holds the conversation slot).
// - hydration failures settle the promise (fallback placeholder remains), so a
//   conversational turn can never hang on shadow failure.
// - the bounded wait uses QUICK_CONTEXT_PENDING_WAIT_MS. Default 30000ms is
//   derived from the shadow chain's own two serial osu! API calls (15s each);
//   the exact policy value is a separate configuration decision documented in
//   the QB-08 audit.
import { markLatencySpan } from '../perf/latencyTrace.js';

export interface PendingQuickObservation {
  id: string;
  key: string;
  visibleAt: number;
  promise: Promise<void>;
}

const pendingByKey = new Map<string, PendingQuickObservation[]>();
const MAX_PENDING_PER_PROCESS = 256;
const MAX_PENDING_PER_KEY = 16;

function positiveEnvMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function quickContextPendingKey(event: any): string {
  return event?.type === 'group'
    ? `group:${String(event.groupId || '')}:${String(event.userId || '')}`
    : `private:${String(event.userId || '')}`;
}

function sweepExpiredEntries(now: number): void {
  // Entries remove themselves on settle; this sweep is a defensive leak guard
  // for pathological non-settling work. Hydration can still finish later.
  for (const [key, entries] of pendingByKey) {
    const alive = entries.filter((entry) => now - entry.visibleAt < 15 * 60_000);
    if (alive.length === 0) pendingByKey.delete(key);
    else pendingByKey.set(key, alive);
  }
}

export function registerPendingQuickObservation(
  event: any,
  work: () => Promise<void>,
): void {
  const key = quickContextPendingKey(event);
  const id = `qobs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let entry: PendingQuickObservation | null = null;
  const promise = (async () => {
    try {
      await work();
    } catch {
      // Failure semantics: the placeholder record is already in db.messages;
      // hydration failures must never make a later turn hang.
    } finally {
      if (entry) {
        const list = pendingByKey.get(key);
        if (list) {
          const next = list.filter((item) => item !== entry);
          if (next.length === 0) pendingByKey.delete(key);
          else pendingByKey.set(key, next);
        }
      }
    }
  })();
  entry = { id, key, visibleAt: Date.now(), promise };

  const list = pendingByKey.get(key) || [];
  list.push(entry);
  if (list.length > MAX_PENDING_PER_KEY) list.shift();
  pendingByKey.set(key, list);
  if (pendingByKey.size > MAX_PENDING_PER_PROCESS) sweepExpiredEntries(entry.visibleAt);
}

/**
 * Await pending quick observations for the SAME conversation identity as the
 * given event. Returns timing stats; never throws and never waits for entries
 * that were registered after this turn started.
 */
export async function settlePendingQuickObservations(
  event: any,
  traceId?: string | null,
): Promise<{ waitedMs: number; pendingCount: number }> {
  const key = quickContextPendingKey(event);
  const entries = [...(pendingByKey.get(key) || [])];
  if (entries.length === 0) return { waitedMs: 0, pendingCount: 0 };
  if (traceId) markLatencySpan(traceId, 'quick_context_drain_start', { pendingCount: entries.length });
  const startedAt = Date.now();
  const waitMs = positiveEnvMs('QUICK_CONTEXT_PENDING_WAIT_MS', 30_000);
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), waitMs);
  });
  await Promise.race([
    Promise.allSettled(entries.map((entry) => entry.promise)),
    timeout,
  ]);
  const waitedMs = Date.now() - startedAt;
  if (traceId) markLatencySpan(traceId, 'quick_context_drain_done', { waitedMs, pendingCount: entries.length });
  return { waitedMs, pendingCount: entries.length };
}

/** Test/debug seam only; production never calls this. */
export function quickContextPendingCountForTest(): number {
  let count = 0;
  for (const entries of pendingByKey.values()) count += entries.length;
  return count;
}
