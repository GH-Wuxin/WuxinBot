import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Avatar, userAvatarUrl } from '../../components/Avatar.jsx';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

// 版式对齐原型 PAGES.profileLogs：筛选栏 + 证据表（时间/成员/类型/变化/来源）。
const eventLabels = {
  'sample.accepted': ['样本采纳', 'accent'], 'sample.rejected': ['样本拒绝', 'warning'], 'evidence.created': ['证据创建', 'success'], 'evidence.rejected': ['证据拒绝', 'warning'],
  'profile.threshold_check': ['阈值检查', 'neutral'], 'profile.queued': ['画像入队', 'accent'], 'profile.backoff': ['失败退避', 'warning'], 'profile.run_started': ['画像启动', 'accent'], 'profile.llm_result': ['LLM 返回', 'success'], 'profile.patch_applied': ['已更新', 'success'],
  'profile.no_change': ['无变化', 'neutral'], 'profile.error': ['错误', 'danger'],
};
const chipTone = (tone) => tone === 'success' ? ' chip--mint' : tone === 'accent' ? ' chip--pink' : tone === 'warning' || tone === 'danger' ? ' chip--amber' : '';

export function ProfileLogsPage() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [filterUser, setFilterUser] = useState('');
  const [filterEvent, setFilterEvent] = useState('');
  const [filterRunId, setFilterRunId] = useState('');
  const [expanded, setExpanded] = useState({});
  const [status, setStatus] = useState({ loading: true, error: '' });
  const requestAbort = useRef(null);
  const requestSerial = useRef(0);

  const loadLogs = async () => {
    const serial = ++requestSerial.current;
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    setStatus({ loading: true, error: '' });
    const params = new URLSearchParams();
    if (filterUser) params.set('userId', filterUser);
    if (filterEvent) params.set('event', filterEvent);
    if (filterRunId) params.set('runId', filterRunId);
    params.set('limit', '200');
    try {
      const data = await api(`/api/profile-logs?${params}`, { signal: controller.signal, timeoutMs: 20000 });
      if (serial !== requestSerial.current) return;
      setLogs(data.logs || []);
      setStats(data.stats || {});
      setStatus({ loading: false, error: '' });
    } catch (cause) {
      if (controller.signal.aborted || serial !== requestSerial.current) return;
      setStatus({ loading: false, error: cause.message || String(cause) });
    } finally {
      if (requestAbort.current === controller) requestAbort.current = null;
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadLogs(); }, 250);
    return () => {
      window.clearTimeout(timer);
      requestAbort.current?.abort();
    };
  }, [filterUser, filterEvent, filterRunId]);

  const exportLogs = () => {
    const blob = new Blob([JSON.stringify({ stats, logs }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wuxin-profile-logs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const stamp = (value) => {
    const date = new Date(value || '');
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  };

  return <>
    <div className="page-head">
      <div><h1>画像日志</h1><p>每次画像更新都留一条证据，方便回查为什么这么记。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-ghost" onClick={exportLogs}>导出</button>
        <RefreshButton onClick={loadLogs} />
      </div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">筛选</span>
      <input value={filterUser} onChange={(event) => setFilterUser(event.target.value)} placeholder="用户 QQ" aria-label="用户 QQ" style={{ maxWidth: 160 }} />
      <input value={filterRunId} onChange={(event) => setFilterRunId(event.target.value)} placeholder="Run ID" aria-label="Run ID" style={{ maxWidth: 220 }} />
      <select
        value={filterEvent}
        onChange={(event) => setFilterEvent(event.target.value)}
        aria-label="事件类型"
        style={{ background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 999, color: 'var(--text)', padding: '6px 12px', fontSize: 12 }}
      >
        <option value="">全部事件</option>
        {Object.entries(eventLabels).map(([value, [label]]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <span className="chip">{logs.length} 条</span>
    </div>

    {status.error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>画像日志读取失败：{status.error}</div>}

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">总日志</div><div className="stat-value">{stats?.total ?? 0}</div><div className="stat-note">当前库内保留</div></div>
      <div className="card stat"><div className="stat-label">今日画像任务</div><div className="stat-value">{stats?.recentRuns ?? 0}</div><div className="stat-note">今天发起</div></div>
      <div className="card stat"><div className="stat-label">今日错误</div><div className="stat-value">{stats?.recentErrors ?? 0}</div><div className="stat-note">失败与退避</div></div>
      <div className="card stat"><div className="stat-label">画像队列</div><div className="stat-value">{stats?.queue?.queued ?? 0}</div><div className="stat-note">{stats?.queue?.activeUserId ? '1 运行中' : '空闲'}</div></div>
    </div>

    <div className="card">
      <div className="card-head"><span className="card-title">证据记录</span><span className="muted" style={{ fontSize: 12 }}>{status.loading ? '读取中…' : `${logs.length} 条`}</span></div>
      <div style={{ maxHeight: 620, overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>时间</th><th>成员</th><th>类型</th><th>变化</th><th>来源</th></tr></thead>
          <tbody>
            {logs.map((log) => {
              const [label, tone] = eventLabels[log.event] || [log.event, 'neutral'];
              const isExpanded = expanded[log.id];
              return <React.Fragment key={log.id}>
                <tr onClick={() => setExpanded({ ...expanded, [log.id]: !isExpanded })} style={{ cursor: 'pointer' }}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{stamp(log.createdAt)}</td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Avatar name={log.nickname || log.userId} src={userAvatarUrl(log.userId)} size={22} />
                      <b>{log.nickname || log.userId}</b>
                      {log.groupId ? <span className="muted">· 群 {log.groupId}</span> : null}
                    </span>
                  </td>
                  <td><span className={'chip' + chipTone(tone)}>{label}</span></td>
                  <td>{log.detail}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{log.runId ? String(log.runId).slice(0, 12) : '—'}</td>
                </tr>
                {isExpanded && <tr>
                  <td colSpan="5" style={{ background: 'var(--panel-2)' }}>
                    <div className="note">runId: {log.runId || '(无)'}</div>
                    {log.meta && <pre style={{ margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{JSON.stringify(log.meta, null, 2).slice(0, 800)}</pre>}
                  </td>
                </tr>}
              </React.Fragment>;
            })}
            {!logs.length && <tr><td colSpan="5" className="muted">{status.loading ? '正在读取画像日志…' : '当前筛选条件没有记录。'}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}
