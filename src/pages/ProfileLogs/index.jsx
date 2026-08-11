import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, FileClock, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Input, LoadingState, MetricCard, Pill, SectionHeader, Select } from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const eventLabels = {
  'sample.accepted': ['样本采纳', 'accent'], 'sample.rejected': ['样本拒绝', 'warning'], 'evidence.created': ['证据创建', 'success'], 'evidence.rejected': ['证据拒绝', 'warning'],
  'profile.threshold_check': ['阈值检查', 'neutral'], 'profile.run_started': ['画像启动', 'accent'], 'profile.llm_result': ['LLM 返回', 'success'], 'profile.patch_applied': ['已更新', 'success'],
  'profile.no_change': ['无变化', 'neutral'], 'profile.error': ['错误', 'danger'],
};

export function ProfileLogsPage() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [filterUser, setFilterUser] = useState('');
  const [filterEvent, setFilterEvent] = useState('');
  const [filterRunId, setFilterRunId] = useState('');
  const [expanded, setExpanded] = useState({});
  const [status, setStatus] = useState({ loading: true, error: '' });

  const loadLogs = async () => {
    setStatus({ loading: true, error: '' });
    const params = new URLSearchParams();
    if (filterUser) params.set('userId', filterUser);
    if (filterEvent) params.set('event', filterEvent);
    if (filterRunId) params.set('runId', filterRunId);
    params.set('limit', '200');
    try {
      const data = await api(`/api/profile-logs?${params}`);
      setLogs(data.logs || []);
      setStats(data.stats || {});
      setStatus({ loading: false, error: '' });
    } catch (cause) {
      setStatus({ loading: false, error: cause.message || String(cause) });
    }
  };

  useEffect(() => { loadLogs(); }, [filterUser, filterEvent, filterRunId]);

  return <div className="console-page profile-logs-page">
    <SectionHeader eyebrow="Context / Profile Logs" title="画像日志" description="查看样本、证据与画像任务的实际运行记录。" actions={<Button icon={RefreshCw} onClick={loadLogs}>刷新</Button>} />
    {stats && <div className="profile-log-metrics"><MetricCard label="总日志" value={stats.total || 0} /><MetricCard label="今日画像任务" value={stats.recentRuns || 0} tone="accent" /><MetricCard label="今日错误" value={stats.recentErrors || 0} tone={stats.recentErrors ? 'accent' : 'neutral'} /></div>}
    <Card className="console-section">
      <div className="console-toolbar profile-log-toolbar"><Input placeholder="用户 QQ" value={filterUser} onChange={(event) => setFilterUser(event.target.value)} /><Input placeholder="Run ID" value={filterRunId} onChange={(event) => setFilterRunId(event.target.value)} /><Select value={filterEvent} onChange={(event) => setFilterEvent(event.target.value)} options={[{ value: '', label: '全部事件' }, ...Object.entries(eventLabels).map(([value, [label]]) => ({ value, label }))]} /></div>
      {status.loading ? <LoadingState label="正在读取画像日志…" /> : status.error ? <ErrorState title="画像日志读取失败" message={status.error} onRetry={loadLogs} /> : <div className="console-list profile-log-list">{logs.map((log) => {
        const [label, tone] = eventLabels[log.event] || [log.event, 'neutral'];
        const isExpanded = expanded[log.id];
        return <button type="button" className="console-list-item profile-log-row" key={log.id} onClick={() => setExpanded({ ...expanded, [log.id]: !isExpanded })}>
          <FileClock size={17} />
          <span className="profile-log-row__body"><span className="profile-log-row__heading"><Pill tone={tone}>{label}</Pill><strong>{log.nickname || log.userId}</strong>{log.groupId && <small>群 {log.groupId}</small>}</span><span>{log.detail}</span>{isExpanded && <code>runId: {log.runId || '(无)'}{log.meta ? `\nmeta: ${JSON.stringify(log.meta, null, 2).slice(0, 500)}` : ''}</code>}</span>
          <span className="profile-log-row__time">{log.createdAt ? new Date(log.createdAt).toLocaleString('zh-CN') : ''}{isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
        </button>;
      })}{!logs.length && <EmptyState title="暂无画像日志" description="当前筛选条件没有记录。" />}</div>}
    </Card>
  </div>;
}
