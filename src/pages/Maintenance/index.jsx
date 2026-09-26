import React, { useEffect, useState } from 'react';
import { ArchiveRestore, DatabaseBackup, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, InlineHelp, SectionHeader } from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

export function MaintenancePage() {
  return <div className="console-page maintenance-page">
    <SectionHeader eyebrow="System / Maintenance" title="维护与恢复" description="重算画像、创建备份或恢复数据库；高风险操作保留确认步骤。" />
    <RecalcPanel />
    <BackupsPanel />
  </div>;
}

function RecalcPanel() {
  const [state, setState] = useState({ running: false, done: 0, total: 0, label: '', stopped: false });
  useEffect(() => {
    const poll = async () => { try { setState(await api('/api/recalc-status')); } catch { /* keep last state */ } };
    poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, []);
  const percent = state.total > 0 ? Math.round(state.done / state.total * 100) : 0;
  return <Card className="console-section maintenance-recalc">
    <div className="console-section__title"><RotateCcw size={18} /><div><h3>全局画像重算</h3><p>后台重算个人、群聊与关系画像，不阻塞聊天。</p></div></div>
    {state.running ? <div className="recalc-progress"><div><strong>{state.label || '正在重算'} · {percent}%</strong><span>{state.done}/{state.total}</span></div><span className="recalc-progress__track"><i style={{ width: `${percent}%` }} /></span><Button size="sm" variant="warning" icon={Square} onClick={() => api('/api/recalc/stop', { method: 'POST' })}>停止重算</Button></div> : <div className="maintenance-action-row"><div><strong>当前没有重算任务</strong><span>QQ 端可使用 /w recalc 查看进度。</span></div><Button variant="primary" icon={Play} onClick={() => api('/api/recalc', { method: 'POST' })}>开始全局重算</Button></div>}
  </Card>;
}

function BackupsPanel() {
  const [backups, setBackups] = useState([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    try { const data = await api('/api/backups'); setBackups(data.backups || []); setError(''); }
    catch (cause) { setError(cause.message || String(cause)); }
  };
  useEffect(() => { load(); }, []);
  const create = async () => { setWorking(true); try { await api('/api/backups', { method: 'POST', body: { type: 'manual' } }); await load(); } finally { setWorking(false); } };
  const restore = async (name) => {
    if (!window.confirm('恢复将覆盖当前运行数据，恢复前会自动备份当前状态。确定恢复？')) return;
    setWorking(true);
    await api(`/api/backups/${name}/restore`, { method: 'POST' });
    window.location.reload();
  };
  const remove = async (name) => {
    if (!window.confirm(`确定删除备份 ${name}？`)) return;
    setWorking(true);
    try { await api(`/api/backups/${name}`, { method: 'DELETE' }); await load(); } finally { setWorking(false); }
  };
  const manual = backups.filter((backup) => backup.type === 'manual');
  const automatic = backups.filter((backup) => backup.type === 'auto' || backup.type === 'pre-restore');
  const renderBackup = (backup, removable) => <article className="console-list-item backup-row" key={backup.name}><DatabaseBackup size={17} /><div><strong>{backup.name}</strong><span>{(backup.size / 1024).toFixed(1)} KB · {backup.createdAt ? new Date(backup.createdAt).toLocaleString('zh-CN') : ''}</span></div><div className="console-actions"><Button size="sm" icon={ArchiveRestore} disabled={working} onClick={() => restore(backup.name)}>恢复</Button>{removable && <Button size="sm" variant="danger-ghost" icon={Trash2} disabled={working} onClick={() => remove(backup.name)}>删除</Button>}</div></article>;
  return <div className="maintenance-backups">
    <Card className="console-section"><div className="console-section__title"><DatabaseBackup size={18} /><div><h3>手动备份 · {manual.length}</h3><p>手动备份不会自动删除。</p></div></div><Button variant="primary" icon={DatabaseBackup} loading={working} onClick={create}>立即手动备份</Button>{error && <InlineHelp tone="danger">{error}</InlineHelp>}<div className="console-list backup-list">{manual.map((backup) => renderBackup(backup, true))}{!manual.length && <EmptyState title="暂无手动备份" />}</div></Card>
    <Card className="console-section"><div className="console-section__title"><ArchiveRestore size={18} /><div><h3>自动备份 · {automatic.length}</h3><p>自动备份最多保留 10 份，恢复前备份最多保留 5 份。</p></div></div><div className="console-list backup-list">{automatic.slice(0, 10).map((backup) => renderBackup(backup, false))}{!automatic.length && <EmptyState title="暂无自动备份" description="启动后每 8 小时自动创建一份。" />}</div></Card>
  </div>;
}
