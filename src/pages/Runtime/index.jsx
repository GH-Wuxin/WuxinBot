import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    const source = process.source === 'external' ? '检测到已有进程' : '本窗口启动';
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
  const busyRef = useRef('');
  const [stopping, setStopping] = useState('');
  const stoppingRef = useRef('');
  const [error, setError] = useState('');
  const [inspectionError, setInspectionError] = useState('');
  const [detecting, setDetecting] = useState(false);
  const refreshInFlight = useRef(null);
  const mounted = useRef(false);
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState(null);
  const [logs, setLogs] = useState([]);
  const [takingOver, setTakingOver] = useState(null);
  const [startup, setStartup] = useState(null);
  const startupSequence = useRef(0);
  const dismissTimer = useRef(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => () => window.clearTimeout(dismissTimer.current), []);

  // 一键启动期间每 500ms 走一次时钟，让进度条和耗时看起来是「活的」。
  useEffect(() => {
    if (!startup) return undefined;
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [startup]);

  const refresh = useCallback(() => {
    if (!desktop) return Promise.resolve();
    if (refreshInFlight.current) return refreshInFlight.current;
    setDetecting(true);
    const pending = (async () => {
      try {
        const [next, autoLaunch] = await Promise.all([
          window.desktop.runtime.getState(),
          window.desktop.runtime.getAutoLaunch(),
        ]);
        if (!mounted.current) return;
        setSnapshot({ ...next, settings: { ...next.settings, autoLaunch } });
        setInspectionError('');
        if (standalone) onServerReady?.();
        return { ok: true };
      } catch (cause) {
        const message = cause?.message || String(cause);
        if (mounted.current) setInspectionError(message);
        return { ok: false, error: message };
      } finally {
        refreshInFlight.current = null;
        if (mounted.current) setDetecting(false);
      }
    })();
    refreshInFlight.current = pending;
    return pending;
  }, [desktop, standalone, onServerReady]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const unsubscribe = desktop ? window.desktop.runtime.onLog((message) => {
      setLogs((current) => [...current, message].slice(-8));
    }) : () => {};
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, [desktop, refresh]);

  const invoke = async (label, task) => {
    if (busyRef.current || stoppingRef.current) return { ok: false, error: '已有操作进行中' };
    busyRef.current = label;
    setBusy(label);
    setError('');
    try {
      const result = await task();
      const failures = Array.isArray(result) ? result.filter((item) => item && item.ok === false && !item.cancelled) : [];
      const message = failures.map((item) => `${item.id}: ${item.error || '操作失败'}`).join('；');
      if (message) setError(message);
      const inspection = await refresh();
      return { ok: !failures.length, result, error: message, inspectionError: inspection?.ok === false ? inspection.error : '' };
    } catch (cause) {
      const message = cause?.message || String(cause);
      setError(message);
      return { ok: false, error: message };
    } finally {
      busyRef.current = '';
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
  const externalCount = processes.filter((process) => process.status === 'running' && process.source === 'external').length;
  const enabledCount = processes.filter((process) => process.enabled).length;
  const controlsDisabled = Boolean(busy || stopping || !snapshot || inspectionError);
  const interruptible = busy === 'start-all' || processes.some((process) => process.id === busy);
  const stopDisabled = Boolean(!snapshot || inspectionError || stopping || busy && !interruptible);

  const stopNow = async (id = '') => {
    if (stoppingRef.current || busyRef.current && busyRef.current !== 'start-all' && !processes.some((process) => process.id === busyRef.current)) return;
    stoppingRef.current = id || 'all';
    setStopping(stoppingRef.current);
    setError('');
    setStartup((current) => current && !current.done ? { ...current,
      cancelledIds: [...new Set([...current.cancelledIds, ...(id ? [id] : current.ids.filter((target) =>
        !processes.some((process) => process.id === target && process.source === 'external' && process.status === 'running')))])],
    } : current);
    try {
      const result = id ? await window.desktop.runtime.stop(id) : await window.desktop.runtime.stopAll();
      const failures = Array.isArray(result) ? result.filter((item) => item?.ok === false) : [];
      if (failures.length) setError(failures.map((item) => `${item.id}: ${item.error || '停止失败'}`).join('；'));
      await refresh();
    } catch (cause) {
      setError(cause?.message || String(cause));
    } finally {
      stoppingRef.current = '';
      setStopping('');
    }
  };

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
    if (busyRef.current || stoppingRef.current) return;
    const ids = processes.filter((process) => process.enabled).map((process) => process.id);
    const runId = ++startupSequence.current;
    window.clearTimeout(dismissTimer.current);
    setStartup({ runId, startedAt: Date.now(), ids, done: false, finishedAt: 0, results: [], cancelledIds: [], error: '' });
    const outcome = await invoke('start-all', () => window.desktop.runtime.startAll());
    if (!mounted.current) return;
    setStartup((current) => current?.runId === runId ? { ...current, done: true, finishedAt: Date.now(),
      results: Array.isArray(outcome.result) ? outcome.result : [], error: outcome.error || outcome.inspectionError || '',
    } : current);
    dismissTimer.current = window.setTimeout(() => setStartup((current) => current?.runId === runId ? null : current), 3200);
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
      <div><h1>运行控制</h1><p>打开时自动检测已有进程，一键启动会跳过已在运行的组件。</p></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" disabled={detecting} onClick={() => void refresh()}>{detecting ? '检测中…' : '重新检测'}</button>
        <button type="button" className="btn btn-primary" disabled={controlsDisabled} onClick={startAllNow}>{busy === 'start-all' ? '启动中…' : '一键启动'}</button>
        <button type="button" className="btn" disabled={stopDisabled} onClick={() => stopNow()}>{stopping === 'all' ? '停止中…' : '停止本窗口进程'}</button>
        <button type="button" className="btn" disabled={controlsDisabled} onClick={() => invoke('restart-all', () => window.desktop.runtime.restartAll())}>{busy === 'restart-all' ? '重启中…' : '重启本窗口进程'}</button>
      </div>
    </div>

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">组件</div><div className="stat-value">{snapshot ? processes.length : '—'}</div><div className="stat-note">每 2.5 秒自动检测</div></div>
      <div className="card stat"><div className="stat-label">运行中</div><div className="stat-value">{snapshot ? runningCount : '—'}</div><div className="stat-note">{snapshot ? `${externalCount} 个外部启动 · ${runningCount - externalCount} 个本窗口启动` : '正在检测已有进程'}</div></div>
      <div className="card stat"><div className="stat-label">已启用</div><div className="stat-value">{snapshot ? enabledCount : '—'}</div><div className="stat-note">一键启动会包含这些</div></div>
      <div className="card stat"><div className="stat-label">客户端</div><div className="stat-value">{snapshot ? (snapshot.settings?.autoLaunch ? '自启' : '手动') : '—'}</div><div className="stat-note">Windows 登录启动</div></div>
    </div>

    {startup && <StartupPanel startup={startup} processes={processes} now={clockNow} />}

    {error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
    {inspectionError && <div className="note" role="alert" style={{ color: 'var(--red)', marginBottom: 12 }}>检测失败：{inspectionError}{snapshot ? '；当前显示上次检测结果，请重新检测。' : '；请重新检测。'}</div>}
    {!snapshot && !inspectionError && <div className="note" role="status" style={{ marginBottom: 12 }}>正在检测本机已有进程…</div>}
    {standalone && loadError && <div className="note" style={{ color: 'var(--amber)', marginBottom: 12 }}>控制台连接失败，服务器就绪后会自动进入完整界面（每 10 秒重试）：{loadError}</div>}

    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><span className="card-title">客户端行为</span><span className="muted" style={{ fontSize: 12 }}>只影响 Desktop 与它管理的进程</span></div>
      <div className="row">
        <div className="row-main"><div className="row-title">Windows 登录时启动客户端</div><div className="row-sub">使用 Electron 登录项，不创建旧的脚本快捷方式</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.autoLaunch ? ' is-on' : '')} disabled={controlsDisabled} aria-label="Windows 登录时启动客户端" onClick={() => invoke('auto-launch', async () => { await window.desktop.runtime.setAutoLaunch(!snapshot?.settings?.autoLaunch); })} />
      </div>
      <div className="row">
        <div className="row-main"><div className="row-title">打开客户端时启动已启用组件</div><div className="row-sub">已有进程会自动识别；关闭此项后仍会检测运行状态</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.startOnOpen ? ' is-on' : '')} disabled={controlsDisabled} aria-label="打开客户端时启动已启用组件" onClick={() => invoke('start-on-open', () => window.desktop.runtime.updateSettings({ startOnOpen: !snapshot?.settings?.startOnOpen }))} />
      </div>
      <div className="row">
        <div className="row-main"><div className="row-title">关闭窗口时停止已管理进程</div><div className="row-sub">只停止本窗口启动的组件及其子进程；外部运行的服务保持运行</div></div>
        <button type="button" className={'switch' + (snapshot?.settings?.stopOnClose !== false ? ' is-on' : '')} disabled={controlsDisabled} aria-label="关闭窗口时停止已管理进程" onClick={() => invoke('stop-on-close', () => window.desktop.runtime.updateSettings({ stopOnClose: snapshot?.settings?.stopOnClose === false }))} />
      </div>
    </div>

    {groups.map((group) => <section key={group.label} className="proc-group">
      <div className="proc-group-head"><span className="proc-eyebrow">PROCESS GROUP</span><h2>{group.label}</h2><span className="muted">{group.processes.length} 个组件</span></div>
      {group.processes.map((process) => {
        const label = process.status === 'running' && process.source === 'external' ? '已在运行' : statusLabel(process.status)[0];
        const isBusy = controlsDisabled;
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
            <button type="button" className="btn btn-sm" disabled={isBusy || process.status !== 'stopped' || !process.enabled} onClick={() => invoke(process.id, () => window.desktop.runtime.start(process.id))}>启动</button>
            <button type="button" className="btn btn-sm" disabled={stopDisabled || !process.managed && !process.startPending && busy !== process.id} onClick={() => stopNow(process.id)}>{stopping === process.id ? '停止中…' : '停止'}</button>
            <button type="button" className="btn btn-sm" disabled={isBusy || !process.enabled || process.status === 'missing' || process.status === 'conflict' || process.source === 'external'} onClick={() => invoke(`restart:${process.id}`, () => window.desktop.runtime.restart(process.id))}>重启</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => editing === process.id ? (setEditing(''), setDraft(null)) : beginEdit(process)}>配置</button>
          </div>

          {process.status === 'conflict' && (process.portProcesses || []).length > 0 && <div className="note" style={{ marginTop: 12 }}>
            <div style={{ color: 'var(--text)' }}>端口 {process.port} 当前被这些进程占用：</div>
            {process.portProcesses.map((item) => <div key={item.pid} style={{ marginTop: 6 }}>
              <b style={{ color: 'var(--text)' }}>{item.name || '未知进程'}</b>
              <span> PID {item.pid}{item.kind === 'matching' ? ' · 同组件的其他实例' : item.kind === 'foreign' ? ' · 其他进程' : ''}</span>
              {item.executablePath && <div style={{ fontSize: 11 }}>{item.executablePath}</div>}
            </div>)}
            <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} disabled={isBusy} onClick={() => setTakingOver(process)}>停止占用进程并启动</button>
          </div>}

          {editing === process.id && draft && <div className="note" style={{ marginTop: 12 }}>
            <div className="field"><label>启动文件</label><input value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></div>
            <div className="field"><label>工作目录</label><input value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></div>
            <div className="field"><label>参数（每行一个）</label><textarea rows="4" value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} /></div>
            <button type="button" className="btn btn-sm btn-primary" disabled={isBusy} onClick={() => saveEdit(process)}>保存配置</button>
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
  const done = startup.done;
  const results = new Map(startup.results.map((result) => [result.id, result]));
  const rows = startup.ids.map((id) => {
    const process = processes.find((entry) => entry.id === id) || { id, label: id };
    const result = results.get(id);
    const state = result?.ok === false && !result.cancelled ? 'failed'
      : result?.cancelled || startup.cancelledIds.includes(id) ? 'cancelled'
        : process.status === 'running' && process.ready ? 'ready'
          : ['conflict', 'missing', 'unready'].includes(process.status) || done ? 'failed' : 'starting';
    const label = state === 'ready' ? (process.source === 'external' ? '已在运行，已跳过' : '已就绪')
      : state === 'cancelled' ? '启动已取消'
        : state === 'failed' ? (process.status === 'unready' ? '未就绪' : '失败')
          : process.startPending || process.status === 'starting' ? '等待就绪' : '等待启动';
    return { ...process, state, labelText: label, error: state === 'failed' ? result?.error || process.lastError : '' };
  });
  const total = rows.length;
  const ready = rows.filter((process) => process.state === 'ready').length;
  const failed = rows.filter((process) => process.state === 'failed').length;
  const cancelled = rows.filter((process) => process.state === 'cancelled').length;
  const success = done && total > 0 && ready === total && !startup.error;
  const badge = !done ? (cancelled ? '正在取消' : '启动中')
    : failed || startup.error ? (ready ? '部分失败' : '启动失败')
      : cancelled ? '已取消' : success ? '启动完成' : '没有待启动组件';
  const elapsed = (Math.max(0, (startup.finishedAt || now) - startup.startedAt) / 1000).toFixed(1);
  const percent = total ? Math.round((ready / total) * 100) : 0;
  const borderColor = !done ? 'rgba(255, 102, 170, 0.42)'
    : success ? 'rgba(92, 214, 180, 0.42)' : 'rgba(255, 204, 34, 0.45)';
  return <div className="card" aria-label="一键启动进度" style={{ marginBottom: 16, borderColor }}>
    <div className="card-head">
      <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span className={'chip ' + (!done ? 'chip--pink' : success ? 'chip--mint' : 'chip--amber')}>{badge}</span>
        一键启动
      </span>
      <span className="muted" style={{ fontSize: 12 }}>{ready}/{total} 就绪 · {elapsed}s{failed ? ` · ${failed} 个失败` : ''}{cancelled ? ` · ${cancelled} 个取消` : ''}</span>
    </div>
    <div className="meter" style={{ marginBottom: 12 }}><i style={{ width: percent + '%' }} /></div>
    <div className="rows" style={{ maxHeight: 216, overflowY: 'auto' }}>
      {rows.map((process) => {
        const { state } = process;
        return <div className="row" key={process.id} style={{ padding: '6px 10px' }}>
          <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: state === 'ready' ? 'var(--mint)' : state === 'failed' ? 'var(--amber)' : 'var(--muted)' }}>
            {state === 'ready' ? <Check size={14} /> : state === 'failed' ? <AlertTriangle size={14} /> : state === 'starting' ? <Loader2 size={14} className="proc-spin" /> : <Circle size={7} />}
          </span>
          <div className="row-main"><div className="row-title" style={{ fontSize: 13 }}>{process.label}</div>{process.error && <div className="row-sub">{process.error}</div>}</div>
          <span className="muted" style={{ fontSize: 11 }}>{process.labelText}</span>
        </div>;
      })}
      {!rows.length && <div className="note">没有已启用的组件。</div>}
    </div>
  </div>;
}
