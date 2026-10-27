// Pure projections shared by the history API and console; never mutate persisted records.
type RecordLike = Record<string, any>;
const millis = (value: unknown) => { const time=Date.parse(String(value)); return Number.isFinite(time) ? time : 0; };
const chronological = (a: RecordLike, b: RecordLike) => millis(b.at) - millis(a.at) || String(a.id).localeCompare(String(b.id));
const key = (groupId: unknown, id: unknown) => JSON.stringify([String(groupId || ''), String(id || '')]);
function indexUnique(map: Map<string, any>, id: string, value: any) {
  map.set(id, map.has(id) ? null : value);
}

export function correlateChatRecords(messages: RecordLike[] = [], decisions: RecordLike[] = []) {
  const incoming = messages.filter(m => m.role !== 'assistant');
  const byRequest = new Map<string, any>(), byMessage = new Map<string, any>();
  const rows: RecordLike[] = incoming.map(message => ({ kind:'message', message, replies:[], decision:null, requestId:message.requestId || '' }));
  for (const row of rows) {
    const m = row.message;
    if (m.requestId) indexUnique(byRequest, key(m.groupId, m.requestId), row);
    if (m.sourceMessageId) indexUnique(byMessage, key(m.groupId, m.sourceMessageId), row);
  }
  const used = new Set<string>();
  const orderedDecisions=decisions.map(decision=>({decision,at:millis(decision.createdAt)})).sort((a,b)=>b.at-a.at).map(item=>item.decision);
  for (const decision of orderedDecisions) {
    const row = (decision.requestId && byRequest.get(key(decision.groupId, decision.requestId)))
      || (decision.messageId && byMessage.get(key(decision.groupId, decision.messageId)));
    if (!row || (decision.userId && row.message.userId && String(decision.userId) !== String(row.message.userId))) continue;
    if (!row.decision) row.decision = decision;
    if (!row.requestId && decision.requestId) { row.requestId = decision.requestId; indexUnique(byRequest,key(decision.groupId,decision.requestId),row); }
    used.add(decision.id);
  }
  const decisionRows = new Map<string, any>();
  for (const decision of orderedDecisions) {
    if (used.has(decision.id)) continue;
    const id = key(decision.groupId, decision.requestId || decision.messageId || decision.id);
    if (decisionRows.has(id)) continue;
    const row = { kind:'decision', message:null, replies:[], decision, requestId:decision.requestId || '' };
    rows.push(row); decisionRows.set(id,row);
    if (decision.requestId) indexUnique(byRequest,key(decision.groupId,decision.requestId),row);
    if (decision.messageId && !byMessage.has(key(decision.groupId,decision.messageId))) byMessage.set(key(decision.groupId,decision.messageId),row);
  }
  for (const reply of messages.filter(m => m.role === 'assistant')) {
    const row = (reply.requestId && byRequest.get(key(reply.groupId,reply.requestId)))
      || (reply.replyToMessageId && byMessage.get(key(reply.groupId,reply.replyToMessageId)));
    const target = row?.message?.userId || row?.decision?.userId;
    if (row && (!target || !reply.replyToUserId || String(reply.replyToUserId) === String(target))) {
      row.replies.push(reply);
      if (!row.requestId && reply.requestId) row.requestId = reply.requestId;
    } else rows.push({ kind:'reply', message:null, replies:[reply], decision:null, requestId:reply.requestId || '', orphanReply:true });
  }
  for (const row of rows) row.replies.sort((a: RecordLike,b: RecordLike) => millis(a.createdAt)-millis(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  return rows.sort((a,b) => millis(b.message?.createdAt || b.decision?.createdAt || b.replies[0]?.createdAt) - millis(a.message?.createdAt || a.decision?.createdAt || a.replies[0]?.createdAt));
}

export function requestProgressSnapshot(trace: RecordLike, now = Date.now()) {
  const last = trace?.events?.at(-1);
  const elapsedMs = Math.max(0, now - (millis(trace?.startedAt) || now));
  const idleMs = Math.max(0, now - (millis(last?.at || trace?.startedAt) || now));
  return { active:trace?.status === 'active', phase:last?.phase || 'INGRESS', eventName:last?.name || 'request_started', elapsedMs, idleMs,
    longIdle:trace?.status === 'active' && idleMs >= 30000 };
}

export function traceMetrics(trace?: RecordLike | null) {
  const usage = (trace?.events || []).filter((e: RecordLike) => e.name === 'model_call_completed')
    .map((e: RecordLike) => e.data?.response?.usage?.totalTokens).filter((n: unknown) => typeof n === 'number' && Number.isFinite(n));
  const start = Date.parse(trace?.startedAt), end = Date.parse(trace?.finishedAt);
  return { tokens:usage.length ? usage.reduce((a:number,b:number)=>a+b,0) : null,
    duration:Number.isFinite(start) && Number.isFinite(end) ? Math.max(0,end-start) : null };
}
function traceReplied(trace?: RecordLike | null) {
  return (trace?.events || []).some((e: RecordLike) => e.name === 'reply_sent'
    || (e.name === 'request_completed' && e.data?.replied === true)
    || (e.name === 'qq_delivery_completed' && ['ok','completed','confirmed_success','accepted_unknown'].includes(e.status || e.data?.status)));
}
export function buildRequestEntries(rows: RecordLike[], traces: RecordLike[] = []) {
  const byId = new Map(traces.map(t => [t.id,t])), seen = new Set();
  const entries = rows.map(row => {
    const item = row.message || row.decision || row.replies?.[0];
    const candidate = byId.get(row.requestId), trace = candidate && (!candidate.groupId || !item.groupId || String(candidate.groupId) === String(item.groupId)) ? candidate : null;
    if (trace) seen.add(trace.id);
    // History must not enter/leave the replied filter when the short-lived trace cache rotates.
    const replied = (row.replies || []).length > 0;
    const failed = trace?.status === 'failed';
    const status = failed ? 'failed' : replied ? 'replied' : trace?.status === 'active' ? 'active'
      : row.decision?.shouldReply === false ? 'silent' : trace?.status || (row.decision?.shouldReply ? 'reply' : 'unknown');
    const blocked = !replied && status !== 'active' && row.decision?.shouldReply === false;
    return { id:'chat:' + row.kind + ':' + item.id, row, requestId:row.requestId, trace, status, replied, blocked,
      title:row.message?.nickname || row.message?.userId || (row.orphanReply ? '原消息未保留' : row.decision?.userId || '未关联的决策'),
      groupId:item.groupId, messageType:item.type || (item.groupId === 'private' ? 'private' : 'group'),
      userId:row.message?.userId || row.decision?.userId || item.replyToUserId || '',
      preview:row.message?.content || row.decision?.reason || (row.orphanReply ? 'Pippi 的历史回复' : '无消息正文'),
      blockReason:blocked ? String(row.decision?.reason || '') : '',
      at:item.createdAt, ...traceMetrics(trace) };
  });
  for (const trace of traces) if (!seen.has(trace.id)) entries.push({ id:'trace:'+trace.id, row:null, requestId:trace.id, trace,
    status:trace.status === 'failed' ? 'failed' : traceReplied(trace) ? 'replied' : trace.status, replied:traceReplied(trace),
    blocked:false, blockReason:'', title:trace.nickname || trace.userId || '请求', groupId:trace.groupId,
    messageType:trace.messageType || 'group', userId:trace.userId || '', preview:'请求追踪 · 原消息未保留', at:trace.startedAt, ...traceMetrics(trace) });
  return entries.sort((a,b) => Number(b.status === 'active') - Number(a.status === 'active') || chronological(a,b));
}

export const LOG_FILTERS = ['all','replied','blocked','silent','failed','active','slow','costly'];
export function filterLogEntries(entries: RecordLike[], filter: string, query = '') {
  const needle = query.trim().toLowerCase();
  return entries.filter(e => {
    const searchable = needle ? [e.title,e.userId,e.groupId,e.groupName,e.preview,e.blockReason,e.log?.rawText,...(e.models || []),
      ...(e.row?.replies || []).map((r: RecordLike)=>r.content), ...(e.trace?.events || []).map((x: RecordLike)=>[x.name,x.data?.model,x.data?.returnedModel].filter(Boolean).join(' '))].filter(Boolean).join('\n').toLowerCase() : '';
    return (!needle || searchable.includes(needle)) && (filter === 'all' || (filter === 'replied' && e.replied === true)
      || (filter === 'failed' && ['failed','error','denied','invalid'].includes(e.status)) || (filter === 'active' && e.status === 'active')
      || (filter === 'silent' && e.status === 'silent') || (filter === 'blocked' && e.blocked === true)
      || (filter === 'slow' && e.duration != null && e.duration >= 30000) || (filter === 'costly' && e.tokens != null && e.tokens >= 50000));
  });
}

/** An as-of boundary freezes incoming messages, replies, decisions and recorded usage across pages. */
export function queryLogEntries(db: RecordLike, traces: RecordLike[], query: RecordLike = {}, now = Date.now()) {
  const integer = (name:string, fallback:number, max:number, min=0) => {
    const raw = query[name], n = raw === undefined || raw === '' ? fallback : Number(raw);
    if (Array.isArray(raw) || (raw && typeof raw === 'object') || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(name+' 参数无效');
    return n;
  };
  const channel = String(query.channel || 'requests'), filter = String(query.filter || 'all');
  if (!['requests','commands'].includes(channel) || !LOG_FILTERS.includes(filter)) throw new Error('日志分类或筛选无效');
  const asOf = integer('asOf',now,now+60000), from = integer('from',0,Number.MAX_SAFE_INTEGER), to = integer('to',asOf,Number.MAX_SAFE_INTEGER);
  if (from > to) throw new Error('日期范围无效');
  const size = integer('pageSize',8,50,1), requestedPage = integer('page',0,10000);
  if (typeof query.q !== 'undefined' && (typeof query.q !== 'string' || query.q.length > 200)) throw new Error('搜索文本最多 200 字');
  if (typeof query.group !== 'undefined' && (typeof query.group !== 'string' || query.group.length > 100)) throw new Error('群筛选无效');
  const before = (x: RecordLike, field='createdAt') => millis(x[field]) <= asOf;
  const messages = (db.messages || []).filter((m: RecordLike)=>before(m));
  const decisions = (db.decisions || []).filter((d: RecordLike)=>before(d));
  const snapshotTraces = traces.filter(t=>before(t,'startedAt')).map(t=>{
    const finished = !t.finishedAt || before(t,'finishedAt');
    return { ...t, events:(t.events || []).filter((e: RecordLike)=>before(e,'at')), status:finished ? t.status : 'active', finishedAt:finished ? t.finishedAt : undefined };
  });
  const groups = new Map<string,string>((db.groups || []).map((g: RecordLike)=>[String(g.groupId),String(g.name || '')]));
  const usage = new Map<string,{tokens:number;models:Set<string>}>();
  for (const u of db.usageEvents || []) {
    if (!u.requestId || !before(u) || u.accountingExcluded || u.usageKnown === false || !(u.totalTokens > 0 || u.usageKnown === true)) continue;
    const id = key(u.groupId,u.requestId), tally=usage.get(id) || {tokens:0,models:new Set<string>()};
    tally.tokens += Number(u.totalTokens || 0); if(u.model)tally.models.add(u.model); usage.set(id,tally);
  }
  let entries: RecordLike[] = channel === 'commands'
    ? (db.commandLogs || []).filter((l: RecordLike)=>before(l)).map((log: RecordLike)=>({id:'command:'+log.id,log,title:[log.command || '未知指令',log.subCommand].filter(Boolean).join(' '),
      groupId:log.groupId,userId:log.userId,messageType:log.type,preview:log.reason || log.errorMessage || log.rawText,at:log.createdAt,status:log.status || 'unknown',duration:log.latencyMs ?? null,tokens:null}))
    : buildRequestEntries(correlateChatRecords(messages,decisions),snapshotTraces).filter(entry=>entry.row);
  entries=entries.map((e):RecordLike=>{const u=usage.get(key(e.groupId,e.requestId));return {...e,groupName:groups.get(String(e.groupId)) || '',...(u?{tokens:u.tokens,models:[...u.models]}:{})};})
    .filter(e=>millis(e.at)>=from && millis(e.at)<=to && (!query.group || (query.group==='__private' ? e.messageType==='private' : String(e.groupId)===query.group)));
  const filtered=filterLogEntries(entries,filter,query.q || '').sort(chronological);
  const pageCount=Math.max(1,Math.ceil(filtered.length/size)),page=Math.min(requestedPage,pageCount-1);
  return {asOf,entries:filtered.slice(page*size,(page+1)*size),total:filtered.length,page,pageSize:size,pageCount,
    retainedMessages:(db.messages || []).length, oldestMessageAt:db.messages?.[0]?.createdAt || null};
}
