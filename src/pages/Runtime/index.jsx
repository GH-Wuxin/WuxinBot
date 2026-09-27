import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Circle, MonitorCog, Play, Power, RefreshCw, Save, Settings2, Square } from 'lucide-react';
import { Button, Card, Pill, SectionHeader, SettingGroup, Switch } from '../../components/ui/index.jsx';

const statusCopy = {
  running: ['运行中', 'success'],
  stopped: ['已停止', 'neutral'],
  missing: ['路径不存在', 'danger'],
};

function isDesktop() {
  return Boolean(typeof window !== 'undefined' && window.desktop?.isDesktop && window.desktop.runtime);
}

function statusLabel(status) {
  return statusCopy[status] || ['未知', 'warning'];
}

function processSummary(process) {
  if (process.status === 'running') return process.pids?.length ? `PID ${process.pids.join(', ')}` : '已检测到进程';
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

export function RuntimePage({ standalone = false, onServerReady }) {
  const desktop = isDesktop();
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState(null);
  const [logs, setLogs] = useState([]);

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
      if (failures.length) {
        setError(failures.map((item) => `${item.id}: ${item.error || '启动失败'}`).join('；'));
      }
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

  const saveEdit = async (process) => {
    const args = String(draft?.args || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    await updateProcess(process, { command: draft?.command, cwd: draft?.cwd, args });
    setEditing('');
    setDraft(null);
  };

  if (!desktop) {
    return <div className="runtime-page"><SectionHeader eyebrow="DESKTOP ONLY" title="运行控制" description="此页只在 WuxinBot Desktop 中提供。" /></div>;
  }

  const content = <>
    <SectionHeader
      eyebrow="WUXINBOT DESKTOP"
      title="运行控制"
      description="统一管理 WuxinBot、NapCat、PP+、外部 Bot 与可选分析服务。每个进程都可以单独启停。"
      actions={<div className="runtime-page__actions"><Button icon={Play} variant="primary" loading={busy === 'start-all'} onClick={() => invoke('start-all', () => window.desktop.runtime.startAll())}>启动已启用组件</Button><Button icon={Square} loading={busy === 'stop-all'} onClick={() => invoke('stop-all', () => window.desktop.runtime.stopAll())}>停止组件</Button><Button icon={RefreshCw} loading={busy === 'restart-all'} onClick={() => invoke('restart-all', () => window.desktop.runtime.restartAll())}>重启组件</Button></div>}
    />

    <div className="runtime-page__summary">
      <Card className="runtime-summary-card"><span>运行中</span><strong>{runningCount}</strong><small>实时检测到的进程</small></Card>
      <Card className="runtime-summary-card"><span>已启用</span><strong>{enabledCount}</strong><small>一键启动会包含这些组件</small></Card>
      <Card className="runtime-summary-card"><span>客户端</span><strong>{snapshot?.settings?.autoLaunch ? '自启' : '手动'}</strong><small>Windows 登录启动状态</small></Card>
    </div>

    <SettingGroup title="客户端行为" description="这些开关只控制 Desktop 客户端和它管理的进程，不会重新安装或注册旧脚本。">
      <div className="runtime-settings-grid">
        <Switch checked={Boolean(snapshot?.settings?.autoLaunch)} label="Windows 登录时启动客户端" description="使用 Electron 登录项，不创建旧的脚本快捷方式。" onChange={(event) => invoke('auto-launch', async () => { await window.desktop.runtime.setAutoLaunch(event.target.checked); })} />
        <Switch checked={Boolean(snapshot?.settings?.startOnOpen)} label="打开客户端时启动已启用组件" description="关闭后只打开控制台，组件由你手动启动。" onChange={(event) => invoke('start-on-open', () => window.desktop.runtime.updateSettings({ startOnOpen: event.target.checked }))} />
        <Switch checked={snapshot?.settings?.stopOnClose !== false} label="关闭窗口时停止已管理进程" description="关闭 Desktop 后结束 WuxinBot、NapCat 和已启用的相关进程。" onChange={(event) => invoke('stop-on-close', () => window.desktop.runtime.updateSettings({ stopOnClose: event.target.checked }))} />
      </div>
    </SettingGroup>

    {error && <div className="runtime-page__error" role="alert">{error}</div>}

    <div className="runtime-process-groups">
      {groups.map((group) => <section key={group.label} className="runtime-process-group"><header><div><span className="section-header__eyebrow">PROCESS GROUP</span><h3>{group.label}</h3></div><span className="runtime-process-group__count">{group.processes.length} 个组件</span></header><div className="runtime-process-grid">{group.processes.map((process) => {
        const [label, tone] = statusLabel(process.status);
        const isBusy = busy === process.id || busy === `update:${process.id}`;
        return <Card key={process.id} className={`runtime-process-card runtime-process-card--${process.status}`}>
          <div className="runtime-process-card__header"><div className="runtime-process-card__title"><span className={`runtime-process-card__icon runtime-process-card__icon--${tone}`}><MonitorCog size={17} /></span><div><h4>{process.label}</h4><small>{processSummary(process)}</small></div></div><Pill tone={tone}>{label}</Pill></div>
          <div className="runtime-process-card__switches"><Switch checked={Boolean(process.enabled)} label="进程启用" description="参与一键启动" disabled={isBusy} onChange={(event) => updateProcess(process, { enabled: event.target.checked }, true)} /><Switch checked={Boolean(process.autoStart)} label="自动启动" description="客户端打开时启动" disabled={isBusy || !process.enabled} onChange={(event) => updateProcess(process, { autoStart: event.target.checked })} /></div>
          <div className="runtime-process-card__actions"><Button size="sm" icon={Play} variant="primary" disabled={process.status === 'running' || process.status === 'missing' || !process.enabled} loading={busy === process.id} onClick={() => invoke(process.id, () => window.desktop.runtime.start(process.id))}>启动</Button><Button size="sm" icon={Square} disabled={process.status !== 'running'} loading={busy === `stop:${process.id}`} onClick={() => invoke(`stop:${process.id}`, () => window.desktop.runtime.stop(process.id))}>停止</Button><Button size="sm" icon={RefreshCw} disabled={!process.enabled || process.status === 'missing'} loading={busy === `restart:${process.id}`} onClick={() => invoke(`restart:${process.id}`, () => window.desktop.runtime.restart(process.id))}>重启</Button><Button size="sm" icon={Settings2} onClick={() => editing === process.id ? (setEditing(''), setDraft(null)) : beginEdit(process)}>配置</Button></div>
          {editing === process.id && draft && <div className="runtime-process-card__editor"><label>启动文件<input className="ui-input" value={draft.command} onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))} /></label><label>工作目录<input className="ui-input" value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} /></label><label>参数（每行一个）<textarea className="ui-textarea" rows="4" value={draft.args} onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))} /></label><Button size="sm" icon={Save} variant="primary" loading={busy === `update:${process.id}`} onClick={() => saveEdit(process)}>保存配置</Button></div>}
          {process.lastError && <p className="runtime-process-card__error">{process.lastError}</p>}
        </Card>;
      })}</div></section>)}
    </div>

    <Card className="runtime-log-card"><header><div><span className="section-header__eyebrow">DESKTOP LOG</span><h3>最近操作</h3></div><Button size="sm" onClick={() => setLogs([])}>清空</Button></header>{logs.length ? <ul>{logs.map((entry, index) => <li key={`${entry.id || 'runtime'}-${index}`}><Circle size={8} /> <span>{entry.message || JSON.stringify(entry)}</span></li>)}</ul> : <p>尚无新的进程操作。</p>}</Card>
  </>;

  return standalone ? <div className="runtime-standalone console-v2"><header className="runtime-standalone__brand"><span className="app-shell__brand-mark">w!</span><strong>WuxinBot Desktop</strong><small>本地运行控制</small></header><main className="runtime-standalone__main">{content}</main></div> : <div className="runtime-page">{content}</div>;
}
