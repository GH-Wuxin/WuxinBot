import { updateDb, nowIso } from './store.js';
import { applyUsageTotals, usageEventFields } from './usage.js';
import { currentRequestIdentity, redactTraceValue, traceEvent } from './requestTrace.js';

interface Invocation {
  invocationId: string;
  provider: string;
  model: string;
  purpose: string;
  startedAt: number;
  usage?: any;
  error?: unknown;
  fallbackFrom?: string;
}

// One logical provider invocation (including unknown usage on failure), before
// tool synthesis/QQ delivery. No prompts, output text or credentials are stored.
export function recordLlmInvocation(call: Invocation) {
  const usage = { ...call.usage, accounted: false };
  const usageKnown = typeof usage.usage_known === 'boolean' ? usage.usage_known
    : ['total_tokens', 'prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens']
        .some(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]));
  try {
    updateDb(db => {
      db.usageEvents ||= [];
      if (db.usageEvents.some(event => event?.id === call.invocationId)) return;
      applyUsageTotals(db.usage, usage);
      db.usage.requests = Number(db.usage.requests || 0) + 1;
      db.usageEvents.push({
        id: call.invocationId, kind: 'llm-call', ...currentRequestIdentity(),
        provider: call.provider, model: call.model, purpose: call.purpose,
        status: call.error ? 'failed' : 'completed', usageKnown,
        fallbackFrom: call.fallbackFrom,
        error: call.error ? redactTraceValue(String(call.error).slice(0, 500)) : undefined,
        durationMs: Date.now() - call.startedAt, ...usageEventFields(usage), createdAt: nowIso(),
      });
      db.usageEvents = db.usageEvents.slice(-5000);
    });
    return { ...usage, accounted: true, usage_known: usageKnown };
  } catch (error) {
    // A ledger I/O error is not a provider failure: never spend again by retrying
    // the model because its already-completed accounting write failed.
    traceEvent('ERROR', 'llm_ledger_write_failed', { invocationId: call.invocationId, error: String(error) });
    console.error('[llm-ledger] usage persistence failed:', redactTraceValue(String(error)));
    return { ...usage, usage_known: usageKnown };
  }
}
