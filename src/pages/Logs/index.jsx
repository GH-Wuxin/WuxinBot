import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BrainCircuit, ChevronLeft, ChevronRight, Download, Search, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Pill, SectionHeader, SegmentedControl, Select, StatusBadge } from '../../components/ui/index.jsx';
import { usePollingResource } from '../../app/polling.js';
import { api, subscribeRequestTraceStream } from '../../lib/api.js';
import { correlateChatRecords, requestProgressSnapshot } from './correlation.js';
import { buildRequestEntries, filterLogEntries } from './explorer.js';

const commandStatusLabels = { ok: '执行成功', denied: '权限拒绝', error: '执行失败', invalid: '参数有误', ignored: '已忽略' };
const phaseLabels = {
  INGRESS: '入口', NORMALIZE: '规范化', GATE: '回复闸门', ROUTER: '路由', KB: '知识库', TOOL: '工具',
  PROMPT: '提示构建', MODEL: '模型', REVIEW: '审查', REWRITE: '改写', QUEUE: '队列', SEND: '发送', COMPLETE: '完成', ERROR: '错误',
};
const traceEventLabels = {
  agent_planner_decision: 'Agent 本轮决策',
  tool_call_started: '开始执行工具',
  tool_call_completed: '工具执行完成',
  tool_call_failed: '工具执行失败',
  tool_call_duplicate_skipped: '跳过重复调用',
  tool_evidence_returned_to_model: '证据已返回模型',
};

export function LogsPage({ db }) {
  const [logSearch, setLogSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [streamTraces, setStreamTraces] = useState(null);
  const [streamState, setStreamState] = useState('connecting');
  const [streamError, setStreamError] = useState('');
  const [channel, setChannel] = useState('requests');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [listPage, setListPage] = useState(0);
  const detailRef = useRef(null);
  const listRef = useRef(null);
  useEffect(() => {
    if (!selectedId) return;
    detailRef.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 640px)').matches) detailRef.current?.scrollIntoView({ block: 'start' });
  }, [selectedId]);
  useEffect(() => {
    let flushTimer = null;
    const pending = new Map();
    const flush = () => {
      flushTimer = null;
      if (!pending.size) return;
      const updates = [...pending.values()];
      pending.clear();
      setStreamTraces((current) => {
        const next = [...(current || [])];
        for (const trace of updates) {
          const index = next.findIndex((entry) => entry.id === trace.id);
          if (index >= 0) next[index] = trace;
          else next.unshift(trace);
        }
        return next.slice(0, 80);
      });
    };
    const unsubscribe = subscribeRequestTraceStream({
      onMessage: (message) => {
        if (message?.type === 'snapshot' && Array.isArray(message.traces)) {
          pending.clear();
          setStreamTraces(message.traces);
        } else if (message?.type === 'upsert' && message.trace?.id) {
          pending.set(message.trace.id, message.trace);
          if (!flushTimer) flushTimer = window.setTimeout(flush, 100);
        }
      },
      onState: (state, error = '') => {
        setStreamState(state);
        setStreamError(error);
      },
    });
    return () => {
      if (flushTimer) window.clearTimeout(flushTimer);
      unsubscribe?.();
    };
  }, []);
  const query = logSearch.trim().toLowerCase();
  const traceResource = usePollingResource(
    async () => (await api('/api/request-traces?limit=80')).traces || [],
    10_000,
    { initialData: [], enabled: streamState !== 'connected' },
  );
  const traces = streamTraces ?? traceResource.data ?? [];
  const chatRows = useMemo(() => correlateChatRecords(
    [...(db.messages || [])].reverse().slice(0, 160),
    [...(db.decisions || [])].reverse().slice(0, 160),
  ), [db.messages, db.decisions]);
  const requestEntries = useMemo(() => buildRequestEntries(chatRows, traces), [chatRows, traces]);
  const commandEntries = useMemo(() => [...(db.commandLogs || [])].reverse().slice(0, 100).map(log => ({
    id: 'command:' + log.id, log, title: (log.command || '未知指令') + ' ' + (log.subCommand || ''),
    groupId: log.groupId, preview: log.reason || log.errorMessage || log.rawText, at: log.createdAt,
    status: log.status || 'unknown', duration: log.latencyMs ?? null, tokens: null,
  })), [db.commandLogs]);
  const filtered = useMemo(() => filterLogEntries(channel === 'requests' ? requestEntries : commandEntries, filter, query), [channel, requestEntries, commandEntries, filter, query]);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(listPage, pageCount - 1);
  const pageEntries = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = filtered.find(entry => entry.id === selectedId) || pageEntries[0];
  useEffect(() => {
    if (selected?.trace?.status !== 'active') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selected?.trace?.id, selected?.trace?.status]);
  const selectChannel = value => { setChannel(value); setFilter('all'); setListPage(0); setSelectedId(null); };
  const selectFilter = value => { setFilter(value); setListPage(0); setSelectedId(null); };

  const clearAllContext = async () => {
    if (!window.confirm('清空所有群的聊天上下文、决策日志和指令日志？这不会删除人设、模型、群配置和成员策略。')) return;
    await api('/api/clear-context', { method: 'POST', timeoutMs: 15000 });
    window.location.reload();
  };

  return <div className="console-page logs-page">
    <SectionHeader title="运行日志" actions={<><Button icon={Download} onClick={() => { window.location.href = '/api/diagnostics'; }}>导出诊断</Button><details className="osu-shell-operations"><summary>更多操作</summary><div><Button variant="danger-ghost" icon={Trash2} onClick={clearAllContext}>清空全部上下文</Button></div></details></>} />
    <div className="osu-log-tabs"><SegmentedControl label="日志分类" value={channel} onChange={selectChannel} options={[{ value: 'requests', label: '会话与请求' }, { value: 'commands', label: '指令与错误' }]} /><StatusBadge tone={streamState === 'connected' ? 'success' : 'warning'}>{streamState === 'connected' ? '实时连接' : '连接恢复中'}</StatusBadge></div>
    <div className="osu-log-toolbar"><span className="console-search"><Search size={15} /><input aria-label="搜索日志" placeholder="搜索消息、群号、模型或事件…" value={logSearch} onChange={event => { setLogSearch(event.target.value); setListPage(0); setSelectedId(null); }} /></span><Select aria-label="筛选日志" value={filter} onChange={event => selectFilter(event.target.value)} options={[{ value: 'all', label: '全部记录' }, { value: 'failed', label: '失败 / 拒绝' }, { value: 'slow', label: '慢请求 ≥ 30秒' }, ...(channel === 'requests' ? [{ value: 'active', label: '进行中' }, { value: 'silent', label: '未回复' }, { value: 'costly', label: '已记录用量 ≥ 5万' }] : [])]} /></div>
    {(streamError || traceResource.error) && <p className="osu-inline-warning">实时追踪暂不可用，使用轮询重试：{streamError || traceResource.error}</p>}
    <div className={'osu-log-workspace' + (selectedId && selected ? ' has-selection' : '')}>
      <section className="osu-request-list" aria-label="请求列表" ref={listRef} tabIndex={-1}><header><span>最近记录</span><small>{filtered.length} 条匹配 · 每页 {pageSize} 条</small></header>{pageEntries.length ? pageEntries.map(entry => <button type="button" key={entry.id} className={'osu-request-item' + (selected?.id === entry.id ? ' is-selected' : '')} onClick={() => setSelectedId(entry.id)} aria-pressed={selected?.id === entry.id}>
        <span className="osu-request-item__top"><strong>{entry.title}</strong><Pill tone={entry.status === 'active' ? 'warning' : ['failed','error','denied','invalid'].includes(entry.status) ? 'danger' : ['completed','ok'].includes(entry.status) ? 'success' : 'neutral'}>{entryStatusLabels[entry.status] || entry.status}</Pill></span>
        <span className="osu-request-item__preview">{entry.preview || '暂无正文'}</span><span className="osu-request-item__meta"><span>{new Date(entry.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} · {entry.groupId || '私聊'}</span><span>{entry.tokens == null ? '— Token' : entry.tokens.toLocaleString() + ' Token'}{entry.duration == null ? '' : ' · ' + formatElapsed(entry.duration)}</span></span>
      </button>) : <EmptyState title="没有匹配的记录" description="试试其他关键词或筛选条件。" />}
        <footer><Button size="sm" variant="ghost" icon={ChevronLeft} disabled={currentPage === 0} onClick={() => { setListPage(currentPage - 1); setSelectedId(null); }}>上一页</Button><span>{currentPage + 1} / {pageCount}</span><Button size="sm" variant="ghost" icon={ChevronRight} disabled={currentPage + 1 >= pageCount} onClick={() => { setListPage(currentPage + 1); setSelectedId(null); }}>下一页</Button></footer>
      </section>
      <Card className="osu-request-detail" aria-label="请求详情" ref={detailRef} tabIndex={-1}><Button className="osu-log-back" variant="ghost" icon={ChevronLeft} onClick={() => { setSelectedId(null); window.requestAnimationFrame(() => { listRef.current?.focus({ preventScroll: true }); listRef.current?.scrollIntoView({ block: 'start' }); }); }}>返回记录列表</Button>{selected ? <><header><h3>{selected.title}</h3><p>{new Date(selected.at).toLocaleString('zh-CN')} · {selected.groupId || '私聊'}</p></header>
        {selected.row && <ChatDecisionRow row={selected.row} trace={selected.trace} />}
        {selected.log && <article className="log-row"><header><strong>{commandStatusLabels[selected.log.status] || '指令记录'}</strong><Pill>{selected.log.nickname || selected.log.userId}</Pill></header><p>{selected.preview}</p><span>{selected.log.userRoleId || 'guest'} · {formatElapsed(selected.log.latencyMs || 0)}</span>{selected.log.errorMessage && <small>{selected.log.errorName || '错误'}：{selected.log.errorMessage}</small>}</article>}
        {selected.trace ? <><div className="osu-detail-section"><BrainCircuit size={16} /><h4>请求时间线</h4><small>{selected.trace.eventCount ?? selected.trace.events?.length ?? 0} 个事件</small></div><TraceRow key={selected.trace.id} trace={selected.trace} now={now} expanded /></> : !selected.log && <p className="osu-muted">暂无关联的请求追踪。</p>}
        <p className="osu-log-footnote">Token 仅统计已保留的模型追踪，非账单；“—”表示未知。</p>
      </> : <EmptyState title="选择一条记录" />}</Card>
    </div>
  </div>;
}

function ChatDecisionRow({ row, trace }) {
  const { message, decision } = row;
  return <article className={`log-row chat-decision-row ${!message || !decision ? 'is-unmatched' : ''}`}>
    <header><strong>{message ? (message.nickname || message.userId) : '未关联的决策'}</strong>{decision ? <Pill tone={decision.shouldReply ? 'success' : 'neutral'}>{decision.shouldReply ? '决定回复' : '未回复'}</Pill> : <Pill>暂无决策记录</Pill>}</header>
    <span>{message?.groupId || decision?.groupId} · {message?.userId || decision?.userId || '未知用户'} · {new Date(message?.createdAt || decision?.createdAt).toLocaleString()}</span>
    {message && <p>{message.content}</p>}
    {message && <div className="chat-context-state"><Pill>{message.inContext === false ? '不进入上下文' : '进入上下文'}</Pill></div>}
    {decision && <div className="decision-inline"><b>{decision.shouldReply ? '为何回复' : '为何沉默'}</b><span>{decision.reason}</span></div>}
    {(row.requestId || message?.sourceMessageId || decision?.messageId) && <code className="trace-id">{row.requestId || `message:${message?.sourceMessageId || decision?.messageId}`}</code>}
    {trace && <small className="trace-link-state"><Activity size={11} /> {entryStatusLabels[trace.status] || trace.status} · {trace.eventCount ?? trace.events?.length ?? 0} 个事件</small>}
  </article>;
}

function formatElapsed(milliseconds) {
  if (milliseconds < 10_000) return `${Math.max(0, milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const entryStatusLabels = { active: '进行中', completed: '完成', failed: '失败', silent: '未回复', reply: '决定回复', unknown: '无状态', ...commandStatusLabels };

function TraceRow({ trace, now, expanded = false }) {
  const progress = requestProgressSnapshot(trace, now);
  const phaseName = phaseLabels[progress.phase] || progress.phase;
  return <details className="log-row trace-row" open={expanded || trace.status === 'active'}>
    <summary><span><strong>{trace.nickname || trace.userId || '请求'}</strong><small>{trace.groupId} · {new Date(trace.startedAt).toLocaleTimeString()}</small></span><span className="trace-row__status"><Pill tone={trace.status === 'failed' ? 'danger' : trace.status === 'completed' ? 'success' : 'warning'}>{entryStatusLabels[trace.status] || trace.status}</Pill>{progress.active && <b>{formatElapsed(progress.elapsedMs)}</b>}</span></summary>
    <code className="trace-id">{trace.id}</code>
    {progress.active && <div className={`trace-live-strip ${progress.longIdle ? 'is-idle' : ''}`}>
      <Activity size={13} />
      <div><strong>正在执行：{phaseName}</strong><span>{progress.eventName} · 已运行 {formatElapsed(progress.elapsedMs)} · {progress.longIdle ? `已有 ${formatElapsed(progress.idleMs)} 没有新事件` : `最近进展 ${formatElapsed(progress.idleMs)} 前`}</span>{progress.phase === 'MODEL' && <small>DeepSeek 流会实时显示供应商返回的 raw CoT；该轮关闭 thinking 或供应商未返回时不会显示。</small>}</div>
    </div>}
    <div className="trace-timeline">{(trace.events || []).map((event) => <TraceEvent key={event.id} event={event} />)}</div>
  </details>;
}

function TraceEvent({ event }) {
  const data = event.data || {};
  const response = data.response || {};
  const isModelResult = event.phase === 'MODEL' && event.name === 'model_call_completed';
  const isModelStream = event.phase === 'MODEL' && event.name === 'model_call_streaming';
  const isAgentDecision = event.phase === 'TOOL' && event.name === 'agent_planner_decision';
  const isEvidenceReturn = event.phase === 'TOOL' && event.name === 'tool_evidence_returned_to_model';
  return <div className={`trace-event trace-event--${String(event.status || '').toLowerCase()}`}>
    <div className="trace-event__head"><Pill>{phaseLabels[event.phase] || event.phase}</Pill><strong>{traceEventLabels[event.name] || event.name}</strong><span>{event.durationMs != null ? `${event.durationMs}ms` : new Date(event.at).toLocaleTimeString()}</span></div>
    {isAgentDecision && <div className="model-call-detail">
      <strong>第 {data.iteration} 轮：{data.decision === 'call_tools' ? `模型决定调用 ${(data.toolNames || []).join('、')}` : '模型认为证据充足，开始作答'}</strong>
      <small>当前上下文已有 {data.evidenceMessagesAvailable || 0} 条工具证据</small>
    </div>}
    {isEvidenceReturn && <div className="model-call-detail">
      <strong>{data.toolName || '工具'} 的证据已交回模型</strong>
      <small>{data.evidenceLength || 0} 字符 · 图片 {data.imageCount || 0} 张 · 模型将自主判断继续调用还是结束</small>
    </div>}
    {(isModelResult || isModelStream) && <div className="model-call-detail">
      <span>{data.purpose} · {data.provider}/{data.model} · 第 {data.attempt} 次</span>
      {isModelStream && response.reasoningExposed && <details open><summary>供应商 raw CoT（实时）</summary><LivePre>{response.reasoning}</LivePre></details>}
      {isModelStream && response.content && <details open><summary>模型输出（实时）</summary><LivePre>{response.content}</LivePre></details>}
      {isModelStream && !response.reasoningExposed && !response.content && <small>模型流已连接，正在等待首个内容片段……</small>}
      {isModelResult && <details><summary>模型输出</summary><pre>{response.content || '（空内容）'}</pre></details>}
      {isModelResult && <details><summary>供应商 raw CoT</summary><pre>{response.reasoningExposed ? response.reasoning : 'Provider did not expose reasoning_content.'}</pre></details>}
      {isModelResult && response.toolCalls?.length > 0 && <details><summary>工具调用 ({response.toolCalls.length})</summary><pre>{JSON.stringify(response.toolCalls, null, 2)}</pre></details>}
      <small>{isModelStream ? `${event.status === 'ok' ? '流式接收完成' : '流式接收中'} · 待组装工具 ${response.toolCallsPending || 0}` : `输入: ${response.usage?.promptTokens ?? 'n/a'} · 缓存命中: ${response.usage?.cachedTokens ?? 'n/a'} · 缓存写入: ${response.usage?.cacheWriteTokens ?? 'n/a'} · 输出: ${response.usage?.completionTokens ?? 'n/a'} · reasoning: ${response.usage?.reasoningTokens ?? 'n/a'} · 总计: ${response.usage?.totalTokens ?? 'n/a'} · streaming: ${data.streaming ? 'yes' : 'no'}`}</small>
    </div>}
    {!isModelResult && !isAgentDecision && !isEvidenceReturn && Object.keys(data).length > 0 && <details><summary>详情</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>}
  </div>;
}

function LivePre({ children }) {
  const elementRef = useRef(null);
  useEffect(() => {
    const element = elementRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [children]);
  return <pre ref={elementRef}>{children}</pre>;
}
