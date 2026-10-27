import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePollingResource } from '../../app/polling.js';
import { api, subscribeRequestTraceStream } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';
import { Avatar, userAvatarUrl } from '../../components/Avatar.jsx';
import { Activity, AlertTriangle, CheckCircle2, FileText, Inbox, PenLine, Send, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { requestProgressSnapshot } from './correlation.js';
import { queryLogEntries } from '../../../server/logRecords.ts';
import { buildRequestEntries, filterLogEntries } from './explorer.js';

// 版式对齐原型 PAGES.logs：左「最近记录」+ 右详情（消息 + 请求时间线）。
const phaseLabels = {
  INGRESS: '入口', NORMALIZE: '规范化', GATE: '回复闸门', ROUTER: '路由', KB: '知识库', TOOL: '工具',
  PROMPT: '提示构建', MODEL: '模型', REVIEW: '审查', REWRITE: '改写', QUEUE: '队列', SEND: '发送', COMPLETE: '完成', ERROR: '错误',
};
const waitingEventLabels = {
  prompt_snapshot_created: '等待模型响应',
  model_call_started: '等待模型响应',
};
const traceEventLabels = {
  agent_planner_decision: 'Agent 本轮决策',
  tool_call_started: '开始执行工具',
  tool_call_completed: '工具执行完成',
  tool_call_failed: '工具执行失败',
  tool_call_duplicate_skipped: '跳过重复调用',
  tool_evidence_returned_to_model: '证据已返回模型',
  tool_batch_parallel: '并行执行多个工具',
  tool_phase_switched: '工具阶段切换',
  model_call_started: '开始调用模型',
  model_call_completed: '模型返回',
  model_call_failed: '模型调用失败',
  model_call_streaming: '模型流式输出',
  provider_fallback_reused: '复用回退通道',
  prompt_snapshot_created: '生成提示词快照',
  reply_rewrite_started: '开始改写回复',
  reply_rewrite_completed: '回复改写完成',
  thinking_notice_failed: '思考提示发送失败',
  knowledge_retrieval_completed: '知识库检索完成',
  message_received: '收到消息',
  onebot_message_received: '收到 OneBot 消息',
  reply_gate_decided: '闸门判定',
  reply_sent: '回复已发送',
  request_completed: '请求完成',
};

// 没收录的事件名：snake_case 转成可读短语，别把 onebot_message_received 这种原样甩给用户。
const eventLabel = (name) => {
  if (traceEventLabels[name]) return traceEventLabels[name];
  const text = String(name || '');
  if (/[\u4e00-\u9fff]/.test(text)) return text;
  return text.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
};

// 判断这条是不是 bot 自己（Pippi）：assistant 消息的 userId 是 bot，追踪里的昵称是 Pippi。
// bot 的头像就用 bot 自己的 QQ 号（settings.selfQq）去取，和群里看到的保持一致。
const isPippi = (entry) => {
  const userId = String(entry?.userId || entry?.row?.message?.userId || '');
  if (userId === 'bot') return true;
  const title = String(entry?.title || '').trim();
  return /^pippi\b/i.test(title) || title === '机器人';
};
const avatarFor = (entry, botQq) => {
  if (isPippi(entry)) return userAvatarUrl(botQq);
  return userAvatarUrl(entry?.userId || entry?.row?.message?.userId);
};

const entryStatusLabels = { replied: '已回复', active: '进行中', completed: '完成', failed: '失败', silent: '未回复', reply: '决定回复', unknown: '无状态', ok: '执行成功', denied: '权限拒绝', error: '执行失败', invalid: '参数有误', ignored: '已忽略' };
const filters = [
  { value: 'all', label: '全部' },
  { value: 'replied', label: '已回复' },
  { value: 'blocked', label: '被阻断' },
  { value: 'silent', label: '未回复' },
  { value: 'failed', label: '失败' },
  { value: 'active', label: '进行中' },
  { value: 'slow', label: '慢请求' },
];
const stamp = (value) => {
  const date = new Date(value || '');
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : '—';
};
const formatElapsed = (milliseconds) => {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 10_000) return (Math.max(0, milliseconds) / 1000).toFixed(1) + 's';
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return seconds + 's';
  return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [phaseFilter, setPhaseFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState(() => queryLogEntries(db, [], {}));
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const snapshotRef = useRef(null);
  const rowsRef = useRef(null);
  useEffect(() => { if (rowsRef.current) rowsRef.current.scrollTop=0; }, [history]);
  const botQq = db?.settings?.selfQq || '';
  // 群号后面跟上群名，日志里才认得出是哪个群。
  const groupNames = useMemo(
    () => new Map((db?.groups || []).map((group) => [String(group.groupId), String(group.name || '').trim()])),
    [db?.groups],
  );
  const groupLabel = (groupId) => {
    if (!groupId || groupId === 'private') return '私聊';
    const name = groupNames.get(String(groupId));
    return name ? `${groupId} · ${name}` : String(groupId);
  };

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

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(logSearch.trim()); setListPage(0); setSelectedId(null); }, 250);
    return () => window.clearTimeout(timer);
  }, [logSearch]);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    const params = new URLSearchParams({ channel, filter, q:query, page:String(listPage), pageSize:'8', group:groupFilter });
    if (snapshotRef.current !== null) params.set('asOf', String(snapshotRef.current));
    if (dateFilter) {
      const start = new Date(dateFilter+'T00:00:00'), end = new Date(start);
      end.setDate(end.getDate()+1); params.set('from',String(start.getTime())); params.set('to',String(end.getTime()-1));
    }
    setHistoryLoading(true); setHistoryError('');
    api('/api/logs?'+params, {signal:controller.signal}).then(result => {
      if (!alive) return;
      snapshotRef.current=result.asOf; setHistory(result);
    }).catch(error => { if(alive && error?.name !== 'AbortError') setHistoryError(error.message || String(error)); })
      .finally(() => { if(alive) setHistoryLoading(false); });
    return () => { alive=false; controller.abort(); };
  }, [channel,filter,query,listPage,groupFilter,dateFilter,refreshKey]);
  const refreshHistory = () => { snapshotRef.current=null; setListPage(0); setRefreshKey(n=>n+1); };
  const traceResource = usePollingResource(
    async () => (await api('/api/request-traces?limit=80')).traces || [],
    10_000,
    { initialData: [], enabled: streamState !== 'connected' },
  );
  // 仅开发环境：?trace=fixture 时动态加载示例追踪；生产构建里这段和 fixture 模块都会消失。
  const [demoTraces, setDemoTraces] = useState([]);
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const params = new URLSearchParams(window.location.search);
    if (params.get('trace') !== 'fixture') return undefined;
    let alive = true;
    import('./traceFixture.js')
      .then(({ createDemoTraces }) => { if (alive) setDemoTraces(createDemoTraces(params.get('live') === '1')); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const traces = [...demoTraces, ...(streamTraces ?? traceResource.data ?? [])];
  const fixtureEntries=demoTraces.length ? filterLogEntries(buildRequestEntries([],demoTraces),filter,query) : null;
  const pageEntries=fixtureEntries || history.entries || [], pageCount=fixtureEntries ? 1 : history.pageCount || 1, currentPage=fixtureEntries ? 0 : history.page || 0;
  const selectedBase=pageEntries.find(entry=>entry.id===selectedId) || pageEntries[0];
  const selected=selectedBase ? {...selectedBase,trace:traces.find(trace=>trace.id===selectedBase.requestId) || selectedBase.trace} : null;
  const hasNewRecords=[...(db.messages || []),...(db.decisions || []),...(db.commandLogs || [])].some(item=>Date.parse(item.createdAt)>history.asOf)
    || traces.some(trace=>Date.parse(trace.events?.at(-1)?.at || trace.startedAt)>history.asOf);

  useEffect(() => {
    if (selected?.trace?.status !== 'active') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [selected?.trace?.id, selected?.trace?.status]);

  // 换一条记录就把阶段过滤清掉，免得看到上一个请求的筛选状态。
  useEffect(() => { setPhaseFilter(''); }, [selected?.id]);

  const selectChannel = (value) => { setChannel(value); setFilter('all'); setListPage(0); setSelectedId(null); };
  const selectFilter = (value) => { setFilter(value); setListPage(0); setSelectedId(null); };

  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const clearAllContext = async () => {
    setClearing(true);
    try {
      await api('/api/clear-context', { method: 'POST', timeoutMs: 15000 });
      window.location.reload();
    } finally {
      setClearing(false);
    }
  };

  const exportDiagnostics = async () => {
    setExporting(true);
    setExportError('');
    try {
      const data = await api('/api/diagnostics', { timeoutMs: 15000 });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `wuxin-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setExportError(error?.message || String(error));
    } finally {
      setExporting(false);
    }
  };

  const progress = selected?.trace ? requestProgressSnapshot(selected.trace, now) : null;

  return <>
    <div className="page-head">
      <div><h1>日志</h1><p>按一轮对话找记录，原消息和 Pippi 的回复放在一起。</p></div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className={'chip ' + (streamState === 'connected' ? 'chip--mint' : 'chip--amber')}>{streamState === 'connected' ? '追踪已连接' : '连接恢复中'}</span>
        <button type="button" className="btn btn-ghost" disabled={exporting} onClick={exportDiagnostics}>{exporting ? '导出中…' : '导出诊断'}</button>
        <button type="button" className="btn btn-ghost" onClick={() => setClearConfirm(true)}>清空全部上下文</button>
      </div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={logSearch} onChange={(event) => { setLogSearch(event.target.value); setListPage(0); setSelectedId(null); }} placeholder="搜索原消息、Pippi 回复、昵称或 QQ" maxLength={200} aria-label="搜索日志" />
      <div className="seg">
        <button type="button" className={channel === 'requests' ? 'is-active' : ''} onClick={() => selectChannel('requests')}>会话与请求</button>
        <button type="button" className={channel === 'commands' ? 'is-active' : ''} onClick={() => selectChannel('commands')}>指令与错误</button>
      </div>
    </div>

    <div className="log-history-controls">
      <label>群聊 <select aria-label="筛选群聊" value={groupFilter} onChange={event=>{setGroupFilter(event.target.value);setListPage(0);setSelectedId(null);}}>
        <option value="">全部群聊与私聊</option><option value="__private">私聊</option>
        {(db.groups || []).map(group=><option key={group.groupId} value={String(group.groupId)}>{group.name || group.groupId}</option>)}
      </select></label>
      <label>日期 <input type="date" aria-label="筛选日期" title="按触发消息的日期筛选" value={dateFilter} onChange={event=>{setDateFilter(event.target.value);setListPage(0);setSelectedId(null);}} /></label>
      {(groupFilter || dateFilter || logSearch) && <button type="button" className="btn btn-sm btn-ghost" onClick={()=>{setGroupFilter('');setDateFilter('');setLogSearch('');setQuery('');setListPage(0);setSelectedId(null);}}>清除条件</button>}
      <button type="button" className={'btn btn-sm'+(hasNewRecords?' btn-primary':'')} disabled={historyLoading} onClick={refreshHistory}>{historyLoading?'读取中…':hasNewRecords?'有新记录 · 点击更新':'更新记录'}</button>
      <span className="muted">翻页时列表保持不动</span>
    </div>
    {historyError && <div className="note" role="alert">历史记录读取失败：{historyError} <button type="button" className="btn btn-sm" onClick={refreshHistory}>重试</button></div>}

    {(streamError || traceResource.error || exportError) && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>
      {exportError ? '诊断导出失败：' + exportError : '实时追踪暂不可用，使用轮询重试：' + (streamError || traceResource.error)}
    </div>}

    <div className="logs">
      <div className="card">
        <div className="card-head">
          <span className="card-title">{channel === 'requests' ? '对话记录' : '指令记录'}</span>
          <div className="seg">
            {filters.filter(item=>channel==='requests' || ['all','failed','slow'].includes(item.value)).map((item) => <button key={item.value} type="button" className={filter === item.value ? 'is-active' : ''} onClick={() => selectFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{history.total} 条 · 每页 {history.pageSize} 条 · 截至 {stamp(history.asOf)}</div>
        <div className="rows" ref={rowsRef} aria-busy={historyLoading}>
          {pageEntries.map((entry) => <div
            key={entry.id}
            data-entry-id={entry.id}
            className={'log-item' + (selected?.id === entry.id ? ' is-active' : '')}
            onClick={() => setSelectedId(entry.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(entry.id); } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Avatar name={entry.title} src={avatarFor(entry, botQq)} size={24} />
                <span className="log-user">{entry.title}</span>
              </span>
              <span className={'chip' + (entry.blocked ? ' chip--amber' : entry.replied || entry.status === 'completed' || entry.status === 'ok' ? ' chip--mint' : entry.status === 'active' ? ' chip--amber' : '')}>{entry.blocked ? '阻断' : (entryStatusLabels[entry.status] || entry.status)}</span>
            </div>
            <div className="log-text log-preview">{entry.preview || '暂无正文'}</div>
            {entry.row?.replies?.length > 0 && <div className="log-reply-preview">Pippi · {entry.row.replies.map(reply=>reply.content || (reply.sticker?'[表情包]':'[图片]')).join(' / ')}</div>}
            {entry.blocked && entry.blockReason && <div className="log-time" style={{ color: 'var(--amber)' }}>闸门：{entry.blockReason}</div>}
            <div className="log-time">{stamp(entry.at)} · {groupLabel(entry.groupId)} · {entry.tokens == null ? '— Token' : entry.tokens.toLocaleString() + ' Token'}{entry.duration == null ? '' : ' · ' + formatElapsed(entry.duration)}</div>
          </div>)}
          {!pageEntries.length && <div className="note">没有匹配的记录。</div>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
          <button type="button" className="btn btn-sm" disabled={historyLoading || currentPage === 0} onClick={() => { setListPage(currentPage - 1); setSelectedId(null); }}>上一页</button>
          <span className="muted" style={{ fontSize: 12 }}>{currentPage + 1} / {pageCount}</span>
          <button type="button" className="btn btn-sm" disabled={historyLoading || currentPage + 1 >= pageCount} onClick={() => { setListPage(currentPage + 1); setSelectedId(null); }}>下一页</button>
        </div>
      </div>

      <div className="card">
        {selected ? <>
          <div className="card-head">
            <span className="card-title">{selected.title}</span>
            <span className={'chip' + (selected.blocked ? ' chip--amber' : selected.replied || selected.status === 'completed' || selected.status === 'ok' ? ' chip--mint' : selected.status === 'active' ? ' chip--amber' : '')}>{selected.blocked ? '阻断' : (entryStatusLabels[selected.status] || selected.status)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{stamp(selected.at)} · {groupLabel(selected.groupId)}{selected.row?.message?.userId ? ' · ' + selected.row.message.userId : ''}</div>
          <div className="log-conversation">
            {selected.row?.message ? <LogMessage message={selected.row.message} label="收到的消息" botQq={botQq}/> : <div className="note">{selected.row?.orphanReply ? '这条历史回复的原消息未保留，已保留回复正文；不会按时间猜测关联。' : selected.preview || '原消息未保留'}</div>}
            {(selected.row?.replies || []).map(reply=><LogMessage key={reply.id} message={reply} label="Pippi 回复" botQq={botQq}/>)}
            {channel==='requests' && !selected.row?.replies?.length && <div className="note">{selected.replied?'追踪记录显示已发送回复，当前列表没有回复正文；可点击更新记录。':'本轮尚未记录到 Pippi 的回复。'}</div>}
          </div>

          <details className="log-diagnostics"><summary>处理详情与请求时间线</summary>

          {selected.row?.decision && <div className="note" style={{ marginBottom: 10 }}>
            <b style={{ color: selected.blocked ? 'var(--amber)' : 'var(--text)' }}>
              {selected.row.decision.shouldReply ? '为何回复' : selected.replied ? '初始判断（后续已回复）' : selected.blocked ? '被闸门阻断' : '为何沉默'}
            </b>
            <div>{selected.row.decision.reason}</div>
          </div>}

          {progress?.active && <div className="note" style={{ marginBottom: 10 }}>
            正在执行：{waitingEventLabels[progress.eventName] || phaseLabels[progress.phase] || progress.phase} · 已运行 {formatElapsed(progress.elapsedMs)}
          </div>}

          <div className="card-title" style={{ marginTop: 20 }}>请求时间线</div>
          {selected.trace ? (() => {
            const allEvents = selected.trace.events || [];
            const visibleEvents = phaseFilter ? allEvents.filter((event) => event.phase === phaseFilter) : allEvents;
            const lastEvent = allEvents[allEvents.length - 1];
            const traceActive = selected.trace.status === 'active';
            return <>
              <TimelineOverview
                trace={selected.trace}
                activePhase={phaseFilter}
                onSelect={(phase) => setPhaseFilter((current) => current === phase ? '' : phase)}
              />
              {phaseFilter && <div className="note" style={{ marginBottom: 8 }}>
                只看「{phaseLabels[phaseFilter] || phaseFilter}」· {visibleEvents.length} 个事件
                <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 8 }} onClick={() => setPhaseFilter('')}>显示全部</button>
              </div>}
              <div className="timeline">
                {visibleEvents.map((event) => <TraceEvent
                  key={event.id}
                  event={event}
                  totalMs={traceDuration(selected.trace)}
                  live={traceActive && event === lastEvent}
                />)}
                {!allEvents.length && <div className="note">这条追踪还没有事件。</div>}
              </div>
            </>;
          })() : <div className="note">原消息与回复可独立查看；这轮的详细追踪已不在最近缓存中。</div>}

          <div className="note" style={{ marginTop: 16 }}>Token 为本请求已记录的模型用量；“—”表示未记录。历史范围取决于后台保留的数据。</div>
          </details>
        </> : <div className="note">选择一条记录。</div>}
      </div>
    </div>
    <ConfirmDialog
      open={clearConfirm}
      title="清空全部上下文？"
      description="清空所有群的聊天上下文、决策日志和指令日志。这不会删除人设、模型、群配置和成员策略。"
      confirmLabel="清空"
      busy={clearing}
      onCancel={() => setClearConfirm(false)}
      onConfirm={() => { setClearConfirm(false); return clearAllContext(); }}
    />
  </>;
}

function LogMessage({message,label,botQq}) {
  const assistant=message.role==='assistant';
  return <article className={'log-message'+(assistant?' log-message--reply':'')}>
    <div className="log-message-head"><Avatar name={assistant?'Pippi':message.nickname || message.userId} src={userAvatarUrl(assistant?botQq:message.userId)} size={24}/>
      <strong>{label}</strong><span>{assistant?'Pippi':message.nickname || message.userId}</span><time>{stamp(message.createdAt)}</time></div>
    <div className="log-message-text">{message.content || (message.sticker?'[表情包]':message.media?.images?.length?'[图片]':'（无文字内容）')}</div>
    {(message.media?.images?.length > 0 || message.sticker) && <div className="log-time">{message.media?.images?.length > 0 ? '图片 × '+message.media.images.length : ''}{message.sticker ? ' 表情：'+message.sticker.id : ''}</div>}
  </article>;
}

// 每个阶段的配色与图标：时间线上靠颜色和图标区分「入口 / 闸门 / 提示 / 模型 / 工具 / 改写 / 发送」。
const PHASE_META = {
  INGRESS: { color: '#7fb2ff', icon: Inbox, label: '入口' },
  GATE: { color: '#ffcc22', icon: ShieldCheck, label: '闸门' },
  PROMPT: { color: '#b98cff', icon: FileText, label: '提示' },
  MODEL: { color: '#ff66aa', icon: Sparkles, label: '模型' },
  TOOL: { color: '#5cd6b4', icon: Wrench, label: '工具' },
  REWRITE: { color: '#ff9f6b', icon: PenLine, label: '改写' },
  SEND: { color: '#6bd0ff', icon: Send, label: '发送' },
  COMPLETE: { color: '#5cd6b4', icon: CheckCircle2, label: '完成' },
  ERROR: { color: '#ff5c5c', icon: AlertTriangle, label: '错误' },
};

const fmtDuration = (ms) => (ms < 1000 ? Math.round(ms) + "ms" : formatElapsed(ms));

const traceDuration = (trace) => {
  const start = Date.parse(trace?.startedAt);
  const end = Date.parse(trace?.finishedAt);
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  return (trace?.events || []).reduce((sum, event) => sum + Number(event.durationMs || 0), 0);
};

function TimelineOverview({ trace, activePhase = '', onSelect }) {
  const events = trace.events || [];
  const total = traceDuration(trace) || events.reduce((sum, event) => sum + Number(event.durationMs || 0), 0);
  const groups = [];
  for (const event of events) {
    const meta = PHASE_META[event.phase] || { color: 'var(--muted)', label: phaseLabels[event.phase] || event.phase };
    const ms = Number(event.durationMs || 0);
    const last = groups[groups.length - 1];
    if (last && last.key === event.phase) last.ms += ms;
    else groups.push({ key: event.phase, label: meta.label, color: meta.color, ms });
  }
  const sum = groups.reduce((acc, group) => acc + group.ms, 0) || 1;
  return <div style={{ marginBottom: 14 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 13, fontWeight: 700 }}>{total ? formatElapsed(total) : '—'}</span>
      <span className="muted" style={{ fontSize: 11 }}>总耗时 · {events.length} 个事件</span>
      <span className="chip" style={{ marginLeft: 'auto' }}>{entryStatusLabels[trace.status] || trace.status}</span>
    </div>
    <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--raise)' }}>
      {groups.map((group, index) => <div
        key={group.key + index}
        role="button"
        tabIndex={0}
        title={`${group.label} · ${formatElapsed(group.ms)}（点击只看这一阶段）`}
        onClick={() => onSelect?.(group.key)}
        onKeyDown={(event) => { if (event.key === 'Enter') onSelect?.(group.key); }}
        style={{
          width: Math.max(2, (group.ms / sum) * 100) + '%',
          background: group.color,
          opacity: activePhase && activePhase !== group.key ? 0.25 : 0.85,
          cursor: 'pointer',
          transition: 'opacity 160ms var(--ease)',
        }}
      />)}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
      {groups.map((group, index) => {
        const active = activePhase === group.key;
        return <button
          key={'legend-' + group.key + index}
          type="button"
          onClick={() => onSelect?.(group.key)}
          title={`只看 ${group.label}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '2px 6px',
            borderRadius: 999, border: '1px solid transparent', background: active ? 'var(--pink-soft)' : 'transparent',
            color: active ? 'var(--text)' : 'var(--muted)', cursor: 'pointer',
            opacity: activePhase && !active ? 0.5 : 1,
          }}
        >
          <i style={{ width: 7, height: 7, borderRadius: '50%', background: group.color, display: 'inline-block' }} />
          {group.label}
        </button>;
      })}
    </div>
  </div>;
}

function TraceEvent({ event, totalMs = 0, live = false }) {
  const data = event.data || {};
  const response = data.response || {};
  const meta = PHASE_META[event.phase] || { color: 'var(--muted)', icon: Activity, label: phaseLabels[event.phase] || event.phase };
  const PhaseIcon = meta.icon;
  const duration = Number(event.durationMs || 0);
  const share = totalMs > 0 ? Math.min(100, Math.max(2, (duration / totalMs) * 100)) : 0;
  const isModelResult = event.phase === 'MODEL' && event.name === 'model_call_completed';
  const isModelStream = event.phase === 'MODEL' && event.name === 'model_call_streaming';
  const isAgentDecision = event.phase === 'TOOL' && event.name === 'agent_planner_decision';
  const isEvidenceReturn = event.phase === 'TOOL' && event.name === 'tool_evidence_returned_to_model';
  const tone = event.status === 'error' || event.status === 'failed' ? 'is-warn' : 'is-ok';
  const glow = meta.color.startsWith('#') ? meta.color + '22' : 'rgba(255,255,255,.08)';
  return <div className={'tl ' + tone + (live ? ' is-live' : '')}>
    <span className="tl-dot" style={{ borderColor: meta.color, boxShadow: `0 0 0 4px ${glow}` }} />
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PhaseIcon size={14} style={{ color: meta.color, flex: '0 0 auto' }} />
        <span className="tl-title" style={{ flex: 1, minWidth: 0 }}>{eventLabel(event.name)}</span>
        {duration > 0 && <span className="chip" style={{ fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{fmtDuration(duration)}</span>}
      </div>
      {share > 0 && <div style={{ height: 3, borderRadius: 999, background: 'var(--raise)', margin: '7px 0 5px', overflow: 'hidden' }}>
        <div style={{ width: share + '%', height: '100%', background: meta.color, opacity: 0.85 }} />
      </div>}
      <div className="tl-sub">{meta.label} · {duration > 0 ? fmtDuration(duration) : new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</div>
      {isAgentDecision && <div className="note">
        <b style={{ color: 'var(--text)' }}>第 {data.iteration} 轮：{data.decision === 'call_tools' ? '模型决定调用 ' + (data.toolNames || []).join('、') : '模型认为证据充足，开始作答'}</b>
        <div>当前上下文已有 {data.evidenceMessagesAvailable || 0} 条工具证据</div>
      </div>}
      {isEvidenceReturn && <div className="note">
        <b style={{ color: 'var(--text)' }}>{data.toolName || '工具'} 的证据已交回模型</b>
        <div>{data.evidenceLength || 0} 字符 · 图片 {data.imageCount || 0} 张</div>
      </div>}
      {(isModelResult || isModelStream) && <div className="note">
        <div>{data.purpose} · {data.provider}/{data.model} · 第 {data.attempt} 次</div>
        {isModelResult && typeof data.thinkingEnabled === 'boolean' && <div>
          请求思考：{data.thinkingEnabled ? (data.requestedReasoningEffort || '开启（供应商默认档位）') : 'off'}
          {' · '}返回思考 Token：{response.usage?.reasoningTokens ?? '未提供'}
          {' · '}思考内容：{response.reasoningExposed ? '已返回' : '未返回'}
        </div>}
        {isModelResult && data.thinkingEnabled && data.reasoningObserved === false && <div>本次已请求思考，供应商未返回思考内容或正数思考用量；不代表本地关闭了思考。</div>}
        {isModelResult && data.returnedModel && data.returnedModel !== data.model && <div>供应商返回模型：{data.returnedModel}</div>}
        {isModelStream && response.reasoningExposed && <details open><summary>供应商 raw CoT（实时）</summary><LivePre>{response.reasoning}</LivePre></details>}
        {isModelStream && response.content && <details open><summary>模型输出（实时）</summary><LivePre>{response.content}</LivePre></details>}
        {isModelStream && !response.reasoningExposed && !response.content && <div>模型流已连接，正在等待首个内容片段……</div>}
        {isModelResult && <details><summary>模型输出</summary><pre className="trace-pre">{response.content || '（空内容）'}</pre></details>}
        {isModelResult && <details><summary>供应商 raw CoT</summary><pre className="trace-pre">{response.reasoningExposed ? response.reasoning : 'Provider did not expose reasoning_content.'}</pre></details>}
        {isModelResult && response.toolCalls?.length > 0 && <details><summary>工具调用 ({response.toolCalls.length})</summary><pre className="trace-pre">{JSON.stringify(response.toolCalls, null, 2)}</pre></details>}
        <div>{isModelStream
          ? `${event.status === 'ok' ? '流式接收完成' : '流式接收中'} · 待组装工具 ${response.toolCallsPending || 0}`
          : `输入 ${response.usage?.promptTokens ?? 'n/a'} · 缓存命中 ${response.usage?.cachedTokens ?? 'n/a'} · 输出 ${response.usage?.completionTokens ?? 'n/a'} · 总计 ${response.usage?.totalTokens ?? 'n/a'}`}</div>
      </div>}
      {!isModelResult && !isAgentDecision && !isEvidenceReturn && <EventData data={data} status={event.status} error={event.error} />}
    </div>
  </div>;
}

// 事件详情：先把 data 里能读懂的几个字段摆出来，原始 JSON 折叠在最后，
// 不再让时间线里每一行都挂着一坨 JSON。
const DATA_LABELS = {
  status: '状态', osuId: '玩家', toolName: '工具', toolNames: '工具', count: '数量',
  provider: '供应商', model: '模型', purpose: '用途', attempt: '第几次', error: '错误',
  reason: '原因', port: '端口', promptCallId: '提示词快照', moduleId: '模块',
  evidenceLength: '证据字符', imageCount: '图片', iteration: '轮次', competitors: '并发',
  cached: '命中缓存', requested: '请求条数', completed: '已完成', failed: '失败',
};
const DATA_ORDER = ['osuId', 'toolName', 'moduleId', 'provider', 'model', 'purpose', 'attempt', 'count', 'requested', 'completed', 'failed', 'competitors', 'evidenceLength', 'imageCount', 'iteration', 'port', 'cached', 'reason', 'error', 'status'];
const renderValue = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.length > 3 ? `${value.slice(0, 3).join('、')} 等 ${value.length} 项` : value.join('、');
  if (typeof value === 'object') return '';
  const text = String(value);
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
};

function EventData({ data, status, error }) {
  const entries = DATA_ORDER
    .filter((key) => data[key] != null && data[key] !== '' && renderValue(data[key]))
    .slice(0, 4)
    .map((key) => (DATA_LABELS[key] ? `${DATA_LABELS[key]} ${renderValue(data[key])}` : renderValue(data[key])));
  const raw = Object.keys(data || {}).length > 0 || (error && Object.keys(error).length > 0);
  return <>
    {entries.length > 0 && <div className="tl-sub" style={{ color: 'var(--soft)' }}>{entries.join(' · ')}</div>}
    {status === 'error' && !data.error && <div className="tl-sub" style={{ color: 'var(--amber)' }}>执行失败</div>}
    {raw && <details style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--muted)' }}>原始数据</summary>
      <pre className="trace-pre">{JSON.stringify(error ? { ...data, error } : data, null, 2)}</pre>
    </details>}
  </>;
}

function LivePre({ children }) {
  const elementRef = useRef(null);
  useEffect(() => {
    const element = elementRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [children]);
  return <pre ref={elementRef} className="trace-pre">{children}</pre>;
}
