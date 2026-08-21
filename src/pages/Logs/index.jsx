import React, { useEffect, useMemo, useState } from 'react';
import { Activity, BrainCircuit, Download, MessageSquare, Search, TerminalSquare, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Pill, SectionHeader } from '../../components/ui/index.jsx';
import { usePollingResource } from '../../app/polling.js';
import { api } from '../../lib/api.js';
import { correlateChatRecords, requestProgressSnapshot } from './correlation.js';

const commandStatusLabels = { ok: '执行成功', denied: '权限拒绝', error: '执行失败', invalid: '参数有误', ignored: '已忽略' };
const phaseLabels = {
  INGRESS: '入口', NORMALIZE: '规范化', GATE: '回复闸门', ROUTER: '路由', KB: '知识库', TOOL: '工具',
  PROMPT: '提示构建', MODEL: '模型', REVIEW: '审查', REWRITE: '改写', QUEUE: '队列', SEND: '发送', COMPLETE: '完成', ERROR: '错误',
};

function matchesSearch(item, query) {
  return !query || JSON.stringify(item || {}).toLowerCase().includes(query);
}

export function LogsPage({ db }) {
  const [logSearch, setLogSearch] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const query = logSearch.trim().toLowerCase();
  const traceResource = usePollingResource(
    async () => (await api('/api/request-traces?limit=80')).traces || [],
    2000,
    { initialData: [] },
  );
  const traces = traceResource.data || [];
  const traceById = useMemo(() => new Map(traces.map((trace) => [trace.id, trace])), [traces]);
  const chatRows = useMemo(() => correlateChatRecords(
    [...(db.messages || [])].reverse().slice(0, 160),
    [...(db.decisions || [])].reverse().slice(0, 160),
  ).filter((row) => matchesSearch(row, query)).slice(0, 100), [db.messages, db.decisions, query]);
  const visibleTraces = traces.filter((trace) => matchesSearch(trace, query)).sort((left, right) => {
    if (left.status === 'active' && right.status !== 'active') return -1;
    if (right.status === 'active' && left.status !== 'active') return 1;
    return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
  });
  const commandLogs = [...(db.commandLogs || [])].reverse().filter((log) => matchesSearch(log, query)).slice(0, 100);

  const clearAllContext = async () => {
    if (!window.confirm('清空所有群的聊天上下文、决策日志和指令日志？这不会删除人设、模型、群配置和成员策略。')) return;
    await api('/api/clear-context', { method: 'POST' });
    window.location.reload();
  };

  return <div className="console-page logs-page">
    <SectionHeader eyebrow="System / Logs" title="运行日志" description="聊天决策、请求阶段与模型调用实时追踪；追踪只驻留内存，不进入模型上下文。" actions={<><Button icon={Download} onClick={() => { window.location.href = '/api/diagnostics'; }}>导出诊断日志</Button><Button variant="danger-ghost" icon={Trash2} onClick={clearAllContext}>清空全部上下文</Button></>} />
    <Card className="logs-toolbar"><span className="console-search"><Search size={15} /><input aria-label="搜索日志" placeholder="搜索消息、阶段、模型、指令或 QQ" value={logSearch} onChange={(event) => setLogSearch(event.target.value)} /></span><p>请求追踪每 2 秒刷新；密钥已脱敏，模型未返回思考字段时不会推测。</p></Card>
    <div className="logs-grid">
      <LogColumn icon={MessageSquare} title="聊天与决策" count={chatRows.length}>{chatRows.map((row) => <ChatDecisionRow key={`${row.kind}:${row.message?.id || row.decision?.id}`} row={row} trace={traceById.get(row.requestId)} />)}</LogColumn>
      <LogColumn icon={BrainCircuit} title="请求追踪 / 模型思考" count={visibleTraces.length} subtitle={traceResource.error || '活动请求自动展开 · 每秒计时 / 2 秒同步'}>{visibleTraces.map((trace) => <TraceRow key={trace.id} trace={trace} now={now} />)}</LogColumn>
      <LogColumn icon={TerminalSquare} title="指令与错误" count={commandLogs.length}>{commandLogs.map((log) => <article className="log-row" key={log.id}><header><strong>{log.command || '未知指令'} {log.subCommand || ''}</strong><Pill tone={log.status === 'ok' ? 'success' : log.status === 'error' || log.status === 'denied' ? 'danger' : 'warning'}>{commandStatusLabels[log.status] || log.status || '指令记录'}</Pill></header><span>{log.groupId} · {log.nickname || log.userId} · {log.userRoleId || 'guest'} · {new Date(log.createdAt).toLocaleString()} · {log.latencyMs || 0}ms</span><p>{log.reason || log.errorMessage || log.rawText}</p>{log.errorMessage && <small>{log.errorName || '错误'}：{log.errorMessage}</small>}</article>)}</LogColumn>
    </div>
  </div>;
}

function ChatDecisionRow({ row, trace }) {
  const { message, decision } = row;
  return <article className={`log-row chat-decision-row ${!message || !decision ? 'is-unmatched' : ''}`}>
    <header><strong>{message ? (message.nickname || message.userId) : '未关联的决策'}</strong>{decision ? <Pill tone={decision.shouldReply ? 'success' : 'neutral'}>{decision.shouldReply ? 'Reply' : 'Silent'}</Pill> : <Pill>暂无决策记录</Pill>}</header>
    <span>{message?.groupId || decision?.groupId} · {message?.userId || decision?.userId || '未知用户'} · {new Date(message?.createdAt || decision?.createdAt).toLocaleString()}</span>
    {message && <p>{message.content}</p>}
    {message && <div className="chat-context-state"><Pill>{message.inContext === false ? '不进入上下文' : '进入上下文'}</Pill></div>}
    {decision && <div className="decision-inline"><b>{decision.shouldReply ? '为何回复' : '为何沉默'}</b><span>{decision.reason}</span></div>}
    {(row.requestId || message?.sourceMessageId || decision?.messageId) && <code className="trace-id">{row.requestId || `message:${message?.sourceMessageId || decision?.messageId}`}</code>}
    {trace && <small className="trace-link-state"><Activity size={11} /> {trace.status} · {trace.eventCount} events</small>}
  </article>;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function TraceRow({ trace, now }) {
  const progress = requestProgressSnapshot(trace, now);
  const phaseName = phaseLabels[progress.phase] || progress.phase;
  return <details className="log-row trace-row" open={trace.status === 'active'}>
    <summary><span><strong>{trace.nickname || trace.userId || '请求'}</strong><small>{trace.groupId} · {new Date(trace.startedAt).toLocaleTimeString()}</small></span><span className="trace-row__status"><Pill tone={trace.status === 'failed' ? 'danger' : trace.status === 'completed' ? 'success' : 'warning'}>{trace.status}</Pill>{progress.active && <b>{formatElapsed(progress.elapsedMs)}</b>}</span></summary>
    <code className="trace-id">{trace.id}</code>
    {progress.active && <div className={`trace-live-strip ${progress.longIdle ? 'is-idle' : ''}`}>
      <Activity size={13} />
      <div><strong>正在执行：{phaseName}</strong><span>{progress.eventName} · 已运行 {formatElapsed(progress.elapsedMs)} · {progress.longIdle ? `已有 ${formatElapsed(progress.idleMs)} 没有新事件` : `最近进展 ${formatElapsed(progress.idleMs)} 前`}</span>{progress.phase === 'MODEL' && <small>当前模型接口为非流式；输出与真实 reasoning 会在本次调用返回后出现。</small>}</div>
    </div>}
    <div className="trace-timeline">{(trace.events || []).map((event) => <TraceEvent key={event.id} event={event} />)}</div>
  </details>;
}

function TraceEvent({ event }) {
  const data = event.data || {};
  const response = data.response || {};
  const isModelResult = event.phase === 'MODEL' && event.name === 'model_call_completed';
  return <div className={`trace-event trace-event--${String(event.status || '').toLowerCase()}`}>
    <div className="trace-event__head"><Pill>{phaseLabels[event.phase] || event.phase}</Pill><strong>{event.name}</strong><span>{event.durationMs != null ? `${event.durationMs}ms` : new Date(event.at).toLocaleTimeString()}</span></div>
    {isModelResult && <div className="model-call-detail">
      <span>{data.purpose} · {data.provider}/{data.model} · 第 {data.attempt} 次</span>
      <details><summary>模型输出</summary><pre>{response.content || '（空内容）'}</pre></details>
      <details><summary>供应商思考</summary><pre>{response.reasoningExposed ? response.reasoning : 'Reasoning not exposed by provider.'}</pre></details>
      {response.toolCalls?.length > 0 && <details><summary>工具调用 ({response.toolCalls.length})</summary><pre>{JSON.stringify(response.toolCalls, null, 2)}</pre></details>}
      <small>tokens: {response.usage?.totalTokens ?? 'n/a'} · reasoning: {response.usage?.reasoningTokens ?? 'n/a'} · cache: {response.usage?.cachedTokens ?? 'n/a'} · streaming: {data.streaming ? 'yes' : 'no'}</small>
    </div>}
    {!isModelResult && Object.keys(data).length > 0 && <details><summary>详情</summary><pre>{JSON.stringify(data, null, 2)}</pre></details>}
  </div>;
}

function LogColumn({ icon: Icon, title, count, subtitle, children }) {
  return <Card className="console-section log-column"><div className="console-section__title"><Icon size={18} /><div><h3>{title}</h3><p>{subtitle || `当前显示 ${count} 条`}</p></div></div><div className="console-list log-column__list">{children}{!count && <EmptyState title="暂无记录" />}</div></Card>;
}
