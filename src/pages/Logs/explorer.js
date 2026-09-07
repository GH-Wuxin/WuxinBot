const millis = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : 0;
export function traceMetrics(trace) {
  const usages = (trace?.events || []).filter(event => event.name === 'model_call_completed').map(event => event.data?.response?.usage?.totalTokens).filter(value => typeof value === 'number' && Number.isFinite(value));
  const start = Date.parse(trace?.startedAt);
  const end = Date.parse(trace?.finishedAt);
  return { tokens: usages.length ? usages.reduce((sum, value) => sum + value, 0) : null,
    duration: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null };
}
export function buildRequestEntries(rows, traces) {
  const byId = new Map(traces.map(trace => [trace.id, trace]));
  const seen = new Set();
  const entries = rows.map(row => {
    const trace = row.requestId ? byId.get(row.requestId) : null;
    if (trace) seen.add(trace.id);
    const item = row.message || row.decision;
    const status = trace?.status === 'active' || trace?.status === 'failed' ? trace.status : row.decision?.shouldReply === false ? 'silent' : trace?.status || (row.decision?.shouldReply ? 'reply' : 'unknown');
    return { id: 'chat:' + row.kind + ':' + item.id, row, trace, status,
      title: row.message?.nickname || item.userId || '未关联的决策', groupId: item.groupId,
      preview: row.message?.content || row.decision?.reason || '无消息正文', at: item.createdAt, ...traceMetrics(trace) };
  });
  for (const trace of traces) if (!seen.has(trace.id)) entries.push({ id: 'trace:' + trace.id, trace, status: trace.status, title: trace.nickname || trace.userId || '请求', groupId: trace.groupId, preview: '请求追踪 · 无关联消息', at: trace.startedAt, ...traceMetrics(trace) });
  return entries.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || millis(b.at) - millis(a.at));
}
export function filterLogEntries(entries, filter, query = '') {
  const needle = query.trim().toLowerCase();
  return entries.filter(entry => (!needle || JSON.stringify(entry).toLowerCase().includes(needle)) && (
    filter === 'all' || (filter === 'failed' && ['failed', 'error', 'denied', 'invalid'].includes(entry.status)) ||
    (filter === 'active' && entry.status === 'active') || (filter === 'silent' && entry.status === 'silent') ||
    (filter === 'slow' && entry.duration != null && entry.duration >= 30000) ||
    (filter === 'costly' && entry.tokens != null && entry.tokens >= 50000)
  ));
}
