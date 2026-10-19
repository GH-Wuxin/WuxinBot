import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Circle, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '../../components/ui/index.jsx';

// 版式对齐原型 PAGES.runtime：数字卡 + PROCESS GROUP 分组 + .proc 卡片。
const statusCopy = {
  running: ['运行中', 'success'],
  stopped: ['已停止', 'neutral'],
  missing: ['路径不存在', 'danger'],
  starting: ['等待就绪', 'warning'],
  unready: ['尚未就绪', 'warning'],
  conflict: ['端口占用', 'danger'],
};
const dotColor = (status) => status === 'running' ? 'var(--mint)'
  : status === 'conflict' || status === 'missing' ? 'var(--red)'
    : status === 'starting' || status === 'unready' ? 'var(--amber)'
      : 'var(--muted)';

function isDesktop() {
  return Boolean(typeof window !== 'undefined' && window.desktop?.isDesktop && window.desktop.runtime);
}

function statusLabel(status) {
  return statusCopy[status] || ['未知', 'warning'];
}

function processSummary(process) {
  if (['running', 'starting', 'unready'].includes(process.status)) {
    const source = process.source === 'external' ? '外部运行' : '本窗口启动';
    return process.pids?.length ? `${source} · PID ${process.pids.join(', ')}` : source;
  }
  if (process.status === 'conflict') return process.lastError || `端口 ${process.port} 已被其他程序占用`;
  if (process.status === 'missing') return process.lastError || '启动条件未满足，可在配置中修改路径';
  return process.port ? `监听端口 ${process.port}` : '等待启动';
}

function editableDraft(process) {
  return {
    command: process.command || '',
    cwd: process.cwd || '',
    args: (process.args || []).join('\n'),
  };
}

export function RuntimePage({ standalone = false, onServerReady, loadError = '' }) {
  const desktop = isDesktop();
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState(null);
  const [logs, setLogs] = useState([]);
  const [takingOver, setTakingOver] = useState(null);
  const [startup, setStartup] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  // 一键启动期间每 500ms 走一次时钟，让进度条和耗时看起来是「活的」。
  useEffect(() => {
    if (!startup) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startup]);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      const [next, autoLaunch] = await Promise.all([
        window.desktop.runtime.getState(),
        window.desktop.runtime.getAutoLaunch(),
      ]);
      setSnapshot({ ...next, settings: { ...next.settings, autoLaunch } });
      setError('');
      if (standalone) onServerReady?.();
    } catch (cause) {
      setError(cause?.message || String(cause));
    }
  }, [desktop, onServerReady]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const unsubscribe = desktop ? window.desktop.runtime.onLog((message) => {
      setLogs((current) => [...current, message].slice(-8));
    }) : () => {};
    return () => {
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [desktop, refresh]);

  const invoke = async (label, task) => {
    setBusy(label);
    setError('');
    try {
      const result = await task();
      const failures = Array.isArray(result) ? result.filter((item) => item && item.ok === false) : [];
      if (failures.length) setError(failures.map((item) => `${item.id}: ${item.error || '启动失败'}`).join('；'));
      await refresh();
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally {
      setBusy('');
    }
  };

  const processes = snapshot?.processes || [];
  const groups = useMemo(() => {
    const result = [];
    for (const process of processes) {
      let group = result.find((entry) => entry.label === process.group);
      if (!group) {
        group = { label: process.group || '其他', processes: [] };
        result.push(group);
      }
      group.processes.push(process);
    }
    return result;
  }, [processes]);
  const runningCount = processes.filter((process) => process.status === 'running').length;
  const enabledCount = processes.filter((process) => process.enabled).length;

  const updateProcess = async (process, patch, stopWhenDisabled = false) => {
    await invoke(`update:${process.id}`, async () => {
      await window.desktop.runtime.updateProcess(process.id, patch);
      if (stopWhenDisabled && patch.enabled === false && process.status === 'running') await window.desktop.runtime.stop(process.id);
    });
  };

  const beginEdit = (process) => {
    setEditing(process.id);
    setDraft(editableDraft(process));
  };

  const startAllNow = async () => {
    const ids = processes.filter((process) => process.enabled).map((process) => process.id);
    setStartup({ startedAt: Date.now(), ids, done: false, finishedAt: 0 });
    try {
      await invoke('start-all', () => window.desktop.runtime.startAll());
    } finally {
      setStartup((current) => current ? { ...current, done: true, finishedAt: Date.now() } : current);
      window.setTimeout(() => setStartup(null), 3200);
    }
  };

  const saveEdit = async (process) => {
    const args = String(draft?.args || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    await updateProcess(process, { command: draft?.command, cwd: draft?.cwd, args });
    setEditing('');
    setDraft(null);
  };

  if (!desktop) {
    return <>
      <div className="page-head"><div><h1>运行控制</h1><p>此页只在 WuxinBot Desktop 中提供。</p></div></div>
    </>;
  }

  const content = <>
    <div className="page-head">
      <div><h1>运行控制</h1><p>这台机器上真正在跑的进程；谁能一键启动、谁只是外部进程，都写清楚。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={busy === 'start-all'} onClick={startAllNow}>{busy === 'start-all' ? '启动中…' : '一键启动'}</button>
        <button type="button" className="btn" disabled={busy === 'stop-all'} onClick={() => invoke('stop-all', () => window.desktop.runtime.stopAll())}>{busy === 'stop-all' ? '停止中…' : '全部停止'}</button>
        <button type="button" className="btn" disabled={busy === 'restart-all'} onClick={() => invoke('restart-all', () => window.desktop.runtime.restartAll())}>{busy === 'restart-all' ? '重启中…' : '重启'}</button>
      </div>
    </div>

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">组件</div><div className="stat-value">{processes.length}</div><div className="stat-note">本窗口管理</div></div>
      <div className="card stat"><div className="stat-label">运行中</div><div className="stat-value">{runningCount}</div><div className="stat-note">{runningCount === processes.length ? '全部正常' : '实时检测到的进程'}</div></div>
      <div className="card stat"><div className="stat-label">已启用</div><div className="stat-value">{enabledCount}</div><div className="stat-note">一键启动会包含这些</div></div>
      <div className="card stat"><div className="stat-label">客户端</div><div className="stat-value">{snapshot?.settings?.autoLaunch ? '自启' : '手动'}</div><div className="stat-note">Windows 登录启动</div></div>
    </div>

    {startup && <StartupPanel startup={startup} processes={processes} now={clockNow} />}

    {error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
    {standalone && loadError && <div className="note" style={{ color: 'var(--amber)', marginBottom: 12 }}>控制台连接失败，服务器就绪后会自动进入完整界面（每 10 秒重试）：{loadError}</div>}

    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><span className="card-title">客户端行为</span><span className="muted" style={{ fontSize: 12 }}>只影响 Desktop 与它管理的进程</span></div>
      <div className="row">
        <div className="row-main"><div className="row-title">Windows 登录时启动客户端</div><div className="row-sub">使用 Electron 登录项，不创建旧的脚本快捷方式</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.autoLaunch ? ' is-on' : '')} aria-label="Windows 登录时启动客户端" onClick={() => invoke('auto-launch', async () => { await window.desktop.runtime.setAutoLaunch(!snapshot?.settings?.autoLaunch); })} />
      </div>
      <div className="row">
        <div className="row-main"><div className="row-title">打开客户端时启动已启用组件</div><div className="row-sub">关闭后只打开控制台，组件由你手动启动</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.startOnOpen ? ' is-on' : '')} aria-label="打开客户端时启动已启用组件" onClick={() => invoke('start-on-open', () => window.desktop.runtime.updateSettings({ startOnOpen: !snapshot?.settings?.startOnOpen }))} />
      </div>
      <div className="row">
        <div className="row-main"><div className="row-title">关闭窗口时停止已管理进程</div><div className="row-sub">只停止本窗口启动的组件及其子进程；外部运行的服务保持运行</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.stopOnClose !== false ? ' is-on' : '')} aria-label="关闭窗口时停止已管理进程" onClick={() => invoke('stop-on-close', () => window.desktop.runtime.updateSettings({ stopOnClose: snapshot?.settings?.stopOnClose === false }))} />
      </div>
    </div>

    {groups.map((group) => <section key={group.label} className="proc-group">
      <div className="proc-group-head"><span className="proc-eyebrow">PROCESS GROUP</span><h2>{group.label}</h2><span className="muted">{group.processes.length} 个组件</span></div>
      {group.processes.map((process) => {
        const [label] = statusLabel(process.status);
        const isBusy = busy === process.id || busy === `update:${process.id}`;
        return <div className={'proc' + (busy === process.id ? ' is-starting' : '')} key={process.id}>
          <div className="proc-head">
            <span className="status-dot" style={{ background: dotColor(process.status) }} />
            <b>{process.label}</b>
            <span className={'chip' + (process.status === 'running' ? ' chip--mint' : process.status === 'conflict' || process.status === 'missing' ? ' chip--amber' : '')}>{label}</span>
          </div>
          <div className="proc-meta">{processSummary(process)}{process.status !== 'conflict' && process.port ? ` · 端口 ${process.port}` : ''}</div>
          <div className="proc-toggles">
            <span className="proc-toggle">进程启用
              <button type="button" className={'switch' + (process.enabled ? ' is-on' : '')} aria-label="进程启用" disabled={isBusy} onClick={() => updateProcess(process, { enabled: !process.enabled }, true)} />
            </span>
            <span className="proc-toggle">自动启动
              <button type="button" className={'switch' + (process.autoStart ? ' is-on' : '')} aria-label="自动启动" disabled={isBusy || !process.enabled} onClick={() => updateProcess(process, { autoStart: !process.autoStart })} />
            </span>
          </div>
          <div className="proc-actions">
            <button type="button" className="btn btn-sm" disabled={process.status !== 'stopped' || !process.enabled} onClick={() => invoke(process.id, () => window.desktop.runtime.start(process.id))}>启动</button>
            <button type="button" className="btn btn-sm" disabled={!process.managed} onClick={() => invoke(`stop:${process.id}`, () => window.desktop.runtime.stop(process.id))}>停止</button>
            <button type="button" className="btn btn-sm" disabled={!process.enabled || process.status === 'missing' || process.status === 'conflict' || process.source === 'external'} onClick={() => invoke(`restart:${process.id}`, () => window.desktop.runtime.restart(process.id))}>重启</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => editing === process.id ? (setEditing(''), setDraft(null)) : beginEdit(process)}>配置</button>
          </div>

          {process.status === 'conflict' && (process.portProcesses || []).length > 0 && <div className="note" style={{ marginTop: 12 }}>
            <div style={{ color: 'var(--text)' }}>端口 {process.port} 当前被这些进程占用：</div>
            {process.portProcesses.map((item) => <div key={item.pid} style={{ marginTop: 6 }}>
              <b style={{ color: 'var(--text)' }}>{item.name || '未知进程'}</b>
              <span> PID {item.pid}{item.kind === 'matching' ? ' · 同组件的其他实例' : item.kind === 'foreign' ? ' · 其他进程' : ''}</span>
              {item.executablePath && <div style={{ fontSize: 11 }}>{item.executablePath}</div>}
            </div>)}
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} disabled={busy === `takeover:${process.id}`} onClick={() => setTakingOver(process)}>停止占用进程并启动</button>
          </div>}

          {editing === process.id && draft && <div className="note" style={{ marginTop: 12 }}>
            <div className="field"><label>启动文件</label><input value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></div>
            <div className="field"><label>工作目录</label><input value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></div>
            <div className="field"><label>参数（每行一个）</label><textarea rows="4" value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} /></div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy === `update:${process.id}`} onClick={() => saveEdit(process)}>保存配置</button>
          </div>}

          {process.lastError && <div className="note" style={{ color: 'var(--red)', marginTop: 10 }}>{process.lastError}</div>}
        </div>;
      })}
    </section>)}
    </> ;

  const logCard = <div className="card" style={{ marginTop: 16 }}>
    <div className="card-head"><span className="card-title">最近操作</span><button type="button" className="btn btn-sm btn-ghost" onClick={() => setLogs([])}>清空</button></div>
    {logs.length
      ? <div className="rows">{logs.map((entry, index) => <div className="row" key={`${entry.id || 'runtime'}-${index}`}>
        <div className="row-main"><div className="row-sub" style={{ marginTop: 0 }}>{entry.message || JSON.stringify(entry)}</div></div>
      </div>)}</div>
      : <div className="note">尚无新的进程操作。</div>}
  </div>;

  const takeoverDialog = <ConfirmDialog
    open={Boolean(takingOver)}
    title={takingOver ? `停止占用进程并启动 ${takingOver.label}` : ''}
    description={takingOver ? `将强制终止：${(takingOver.portProcesses || []).map((item) => `${item.name || '未知进程'} (PID ${item.pid})`).join('、')}，包括它们的子进程。随后启动 ${takingOver.label}（端口 ${takingOver.port}）。这会立即中断这些进程正在做的事。` : ''}
    confirmLabel="停止并启动"
    busy={busy === `takeover:${takingOver?.id}`}
    onCancel={() => setTakingOver(null)}
    onConfirm={() => { const target = takingOver; setTakingOver(null); return invoke(`takeover:${target.id}`, () => window.desktop.runtime.takeOver(target.id)); }}
  />;

  if (standalone) {
    return <div className="runtime-standalone" style={{ padding: '40px 28px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <span className="brand-puck" aria-hidden="true" style={{ width: 34, height: 34 }}>w!</span>
        <strong style={{ fontSize: 16 }}>WuxinBot Desktop</strong>
        <span className="muted" style={{ fontSize: 12 }}>本地运行控制</span>
      </header>
      <main style={{ maxWidth: 1320, margin: '0 auto' }}>{content}{logCard}{takeoverDialog}</main>
    </div>;
  }

  return <>{content}{logCard}{takeoverDialog}</>;
}

// 一键启动的实时面板：跟着 2.5s 的状态轮询走，启动中显示转圈，结束显示结果。
function StartupPanel({ startup, processes, now }) {
  const rows = processes.filter((process) => startup.ids.includes(process.id));
  const total = Math.max(1, rows.length);
  const ready = rows.filter((process) => process.status === 'running').length;
  const failed = rows.filter((process) => ['conflict', 'missing'].includes(process.status)).length;
  const done = startup.done;
  const elapsed = (((startup.finishedAt || now) - startup.startedAt) / 1000).toFixed(1);
  const percent = Math.round((ready / total) * 100);
  const borderColor = done
    ? (failed ? 'rgba(255, 204, 34, 0.45)' : 'rgba(92, 214, 180, 0.42)')
    : 'rgba(255, 102, 170, 0.42)';
  return <div className="card" style={{ marginBottom: 16, borderColor }}>
    <div className="card-head">
      <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span className={'chip ' + (done ? (failed ? 'chip--amber' : 'chip--mint') : 'chip--pink')}>{done ? (failed ? '部分失败' : '启动完成') : '启动中'}</span>
        一键启动
      </span>
      <span className="muted" style={{ fontSize: 12 }}>{ready}/{total} 就绪 · {elapsed}s{failed ? ` · ${failed} 个失败` : ''}</span>
    </div>
    <div className="meter" style={{ marginBottom: 12 }}><i style={{ width: percent + '%' }} /></div>
    <div className="rows" style={{ maxHeight: 216, overflowY: 'auto' }}>
      {rows.map((process) => {
        const state = process.status === 'running' ? 'ready'
          : ['conflict', 'missing'].includes(process.status) ? 'failed'
            : done ? 'idle' : 'starting';
        return <div className="row" key={process.id} style={{ padding: '6px 10px' }}>
          <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: state === 'ready' ? 'var(--mint)' : state === 'failed' ? 'var(--amber)' : 'var(--muted)' }}>
            {state === 'ready' ? <Check size={14} /> : state === 'failed' ? <AlertTriangle size={14} /> : state === 'starting' ? <Loader2 size={14} className="proc-spin" /> : <Circle size={7} />}
          </span>
          <div className="row-main"><div className="row-title" style={{ fontSize: 13 }}>{process.label}</div></div>
          <span className="muted" style={{ fontSize: 11 }}>{state === 'ready' ? '已就绪' : state === 'failed' ? '失败' : state === 'starting' ? '启动中' : '未启动'}</span>
        </div>;
      })}
      {!rows.length && <div className="note">没有已启用的组件。</div>}
    </div>
  </div>;
}
