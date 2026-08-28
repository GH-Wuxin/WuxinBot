export function correlateChatRecords(messages = [], decisions = []) {
  const byRequestId = new Map();
  const byMessageId = new Map();
  for (const decision of decisions) {
    if (decision.requestId && !byRequestId.has(decision.requestId)) byRequestId.set(decision.requestId, decision);
    if (decision.messageId && !byMessageId.has(decision.messageId)) byMessageId.set(decision.messageId, decision);
  }
  const usedDecisionIds = new Set();
  const rows = messages.map((message) => {
    // Stable identifiers only: never timestamps, nicknames, positions, or proximity.
    const decision = (message.requestId && byRequestId.get(message.requestId))
      || (message.sourceMessageId && byMessageId.get(message.sourceMessageId)) || null;
    if (decision) usedDecisionIds.add(decision.id);
    return { kind: 'message', message, decision, requestId: message.requestId || decision?.requestId || '' };
  });
  for (const decision of decisions) {
    if (!usedDecisionIds.has(decision.id)) rows.push({ kind: 'decision', message: null, decision, requestId: decision.requestId || '' });
  }
  return rows.sort((left, right) => {
    const leftTime = new Date(left.message?.createdAt || left.decision?.createdAt || 0).getTime();
    const rightTime = new Date(right.message?.createdAt || right.decision?.createdAt || 0).getTime();
    return rightTime - leftTime;
  });
}

export function requestProgressSnapshot(trace, now = Date.now()) {
  const events = trace?.events || [];
  const lastEvent = events.at(-1) || null;
  const startedAt = new Date(trace?.startedAt || 0).getTime();
  const lastProgressAt = new Date(lastEvent?.at || trace?.startedAt || 0).getTime();
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const idleMs = Number.isFinite(lastProgressAt) ? Math.max(0, now - lastProgressAt) : elapsedMs;
  return {
    active: trace?.status === 'active',
    phase: lastEvent?.phase || 'INGRESS',
    eventName: lastEvent?.name || 'request_started',
    elapsedMs,
    idleMs,
    longIdle: trace?.status === 'active' && idleMs >= 30_000,
  };
}
