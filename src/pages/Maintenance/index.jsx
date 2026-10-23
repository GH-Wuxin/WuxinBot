import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';

// 版式对齐原型 PAGES.maintenance：左「备份」表 + 右「重算任务」。
const typeLabels = { manual: '手动', auto: '自动', 'pre-restore': '恢复前' };
const backupTime = (backup) => {
  if (backup?.createdAt) return new Date(backup.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(String(backup?.name || ''));
  if (!match) return '—';
  const [, year, month, day, hour, minute] = match;
  return `${Number(month)}/${Number(day)} ${hour}:${minute}`;
};
const backupKind = (backup) => {
  const known = typeLabels[backup?.type];
  if (known) return known;
  const name = String(backup?.name || '');
  if (/^auto/i.test(name)) return '自动';
  if (/^manual/i.test(name)) return '手动';
  if (/pre-restore/i.test(name)) return '恢复前';
  if (/pre-config/i.test(name)) return '改配置前';
  return '备份';
};

export function MaintenancePage() {
  return <>
    <div className="page-head">
      <div><h1>维护</h1><p>备份、恢复、重算，都在这里，谨慎操作。</p></div>
      <div />
    </div>
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <BackupsPanel />
      <RecalcPanel />
    </div>
  </>;
}

function RecalcPanel() {
  const [state, setState] = useState({ running: false, done: 0, total: 0, label: '', stopped: false });
  const pollInFlight = useRef(false);
  useEffect(() => {
    const poll = async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try { setState(await api('/api/recalc-status', { timeoutMs: 10000 })); }
      catch { /* keep last state */ }
      finally { pollInFlight.current = false; }
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, []);
  const percent = state.total > 0 ? Math.round(state.done / state.total * 100) : 0;

  return <div className="stack">
    <div className="card">
      <div className="card-head">
        <span className="card-title">重算任务</span>
        <span className={'chip' + (state.running ? ' chip--amber' : ' chip--mint')}>{state.running ? '进行中' : '空闲'}</span>
      </div>
      <div className="kv"><span>当前任务</span><b>{state.running ? (state.label || '正在重算') : '无'}</b></div>
      <div className="kv"><span>进度</span><b>{state.running ? `${state.done} / ${state.total}` : '—'}</b></div>
      <div className="kv"><span>结果</span><b>{state.stopped ? '已停止' : state.running ? `${percent}%` : '待启动'}</b></div>
      <div className="meter" style={{ marginTop: 14 }}><i style={{ width: percent + '%' }} /></div>
      <div className="note" style={{ marginTop: 8 }}>后台重算个人、群聊与关系画像，不阻塞聊天；QQ 端可用 /w recalc 查看进度。</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {state.running
          ? <button type="button" className="btn" style={{ flex: 1 }} onClick={() => api('/api/recalc/stop', { method: 'POST' })}>停止重算</button>
          : <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => api('/api/recalc', { method: 'POST' })}>全部重算</button>}
      </div>
    </div>

    <div className="card">
      <div className="card-head"><span className="card-title">备份规则</span></div>
      <div className="note">运行期间自动快照约每 5 分钟一次，按已保存的份数保留最新备份（0 = 不限）。恢复前会再备份当前状态。手动备份只有设置上限才会被清理；「清理 30 天前」只处理过期的自动及恢复前备份。</div>
    </div>
  </div>;
}

function BackupsPanel() {
  const [backups, setBackups] = useState([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [retention, setRetention] = useState({ auto: 10, preRestore: 5, manual: 0 });
  const [retentionDraft, setRetentionDraft] = useState({ auto: '10', preRestore: '5', manual: '0' });
  const load = async () => {
    try {
      const data = await api('/api/backups');
      setBackups(data.backups || []);
      if (data.retention) {
        setRetention(data.retention);
        setRetentionDraft({ auto: String(data.retention.auto), preRestore: String(data.retention.preRestore), manual: String(data.retention.manual) });
      }
      setError('');
    }
    catch (cause) { setError(cause.message || String(cause)); }
  };
  useEffect(() => { load(); }, []);
  const create = async () => {
    setError(''); setNotice('');
    setWorking(true);
    try { await api('/api/backups', { method: 'POST', body: { type: 'manual' } }); await load(); setNotice('备份已创建。'); }
    catch (cause) { setError(cause.message || String(cause)); }
    finally { setWorking(false); }
  };
  const restore = async (name) => {
    setError(''); setNotice('');
    setWorking(true);
    try { await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }); window.location.reload(); }
    catch (cause) { setError(cause.message || String(cause)); }
    finally { setWorking(false); }
  };
  const remove = async (name) => {
    setError(''); setNotice('');
    setWorking(true);
    try { await api(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }); await load(); setNotice('备份已删除。'); }
    catch (cause) { setError(cause.message || String(cause)); }
    finally { setWorking(false); }
  };
  const saveRetention = async () => {
    setError(''); setNotice('');
    setWorking(true);
    try {
      const result = await api('/api/backups/retention', {
        method: 'POST',
        body: {
          auto: Number(retentionDraft.auto),
          preRestore: Number(retentionDraft.preRestore),
          manual: Number(retentionDraft.manual),
        },
      });
      await load();
      setNotice(`保留规则已保存，清理了 ${result.removed || 0} 份旧备份。`);
      if (result.failed?.length) setError(`${result.failed.length} 份备份删除失败，请检查文件访问权限后重试。`);
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally {
      setWorking(false);
    }
  };
  const prune = async (olderThanDays) => {
    setError(''); setNotice('');
    setWorking(true);
    try {
      const result = await api('/api/backups/prune', { method: 'POST', body: olderThanDays ? { olderThanDays } : {} });
      await load();
      setNotice(result.removed ? `已清理 ${result.removed} 份备份。` : '没有符合条件的备份需要清理。');
      if (result.failed?.length) setError(`${result.failed.length} 份备份删除失败，请检查文件访问权限后重试。`);
    } catch (cause) {
      setError(cause.message || String(cause));
    } finally {
      setWorking(false);
    }
  };
  const totalSize = backups.reduce((sum, backup) => sum + Number(backup.size || 0), 0);

    const sorted = [...backups].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));

  return <div className="card">
    <div className="card-head">
      <span className="card-title">备份</span>
      <button type="button" className="btn btn-sm" disabled={working} onClick={create}>{working ? '处理中…' : '立即备份'}</button>
    </div>
    {error && <div className="note" role="alert" style={{ color: 'var(--red)' }}>{error}</div>}
    {notice && <div className="note" role="status">{notice}</div>}
    <div className="note" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
      <span className="muted">保留份数（0 = 不限）</span>
      {[['auto', '自动'], ['preRestore', '恢复前'], ['manual', '手动']].map(([key, label]) => (
        <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>{label}</span>
          <input
            className="input"
            style={{ width: 64, padding: '4px 8px' }}
            inputMode="numeric"
            value={retentionDraft[key]}
            onChange={(event) => setRetentionDraft((current) => ({ ...current, [key]: event.target.value.replace(/[^0-9]/g, '') }))}
          />
        </label>
      ))}
      <button type="button" className="btn btn-sm" disabled={working} onClick={saveRetention}>保存</button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={working} onClick={() => setConfirm({ kind: 'prune' })}>清理超限</button>
      <button type="button" className="btn btn-sm btn-ghost" disabled={working} onClick={() => setConfirm({ kind: 'prune-old' })}>清理 30 天前</button>
      <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
        共 {backups.length} 份 · {(totalSize / 1024 / 1024).toFixed(1)} MB
      </span>
    </div>
    <div style={{ maxHeight: 520, overflowY: 'auto' }}>
      <table className="table" style={{ whiteSpace: 'nowrap' }}>
        <thead><tr><th>时间</th><th>大小</th><th>类型</th><th style={{ textAlign: 'right', width: 150 }}>操作</th></tr></thead>
        <tbody>
          {sorted.map((backup) => <tr key={backup.name}>
            <td className="muted" title={backup.name}>{backupTime(backup)}</td>
            <td>{(Number(backup.size || 0) / 1024).toFixed(1)} KB</td>
            <td><span className="chip">{backupKind(backup)}</span></td>
            <td style={{ textAlign: 'right' }}>
              <button type="button" className="btn btn-sm" disabled={working} onClick={() => setConfirm({ kind: 'restore', name: backup.name })}>恢复</button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={working} style={{ marginLeft: 6 }} onClick={() => setConfirm({ kind: 'delete', name: backup.name })}>删除</button>
            </td>
          </tr>)}
          {!sorted.length && <tr><td colSpan="4" className="muted">暂无备份。</td></tr>}
        </tbody>
      </table>
    </div>
    <ConfirmDialog
      open={Boolean(confirm)}
      title={confirm?.kind === 'delete'
        ? `删除备份 ${confirm.name}？`
        : confirm?.kind === 'prune'
          ? '按保留份数清理？'
          : confirm?.kind === 'prune-old'
            ? '删除 30 天前的自动备份？'
            : '恢复这份备份？'}
      description={confirm?.kind === 'delete'
        ? '删除后无法找回。删掉自动备份不会影响当前运行数据，下次按计划会再生成新的。'
        : confirm?.kind === 'prune'
          ? `按已保存规则清理：自动 ${retention.auto || '不限'} 份、恢复前 ${retention.preRestore || '不限'} 份、手动 ${retention.manual || '不限'} 份。超过上限的旧备份会被删除。`
          : confirm?.kind === 'prune-old'
            ? '只会删除 30 天前的自动/恢复前备份，手动备份保留。'
            : '恢复将覆盖当前运行数据，恢复前会自动备份当前状态。'}
      confirmLabel={confirm?.kind === 'delete' ? '删除' : confirm?.kind === 'prune' || confirm?.kind === 'prune-old' ? '清理' : '恢复'}
      busy={working}
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const target = confirm;
        setConfirm(null);
        if (!target) return;
        if (target.kind === 'prune') return prune();
        if (target.kind === 'prune-old') return prune(30);
        return target.kind === 'delete' ? remove(target.name) : restore(target.name);
      }}
    />
  </div>;
}
