import React, { useCallback, useEffect, useRef, useState } from 'react';
import './styles/tokens.css';
import './styles/globals.css';
import './styles/components.css';
import { AppShell } from './components/layout/AppShell.jsx';
import { DashboardPage } from './pages/Dashboard/index.jsx';
import { GroupsPage } from './pages/Groups/index.jsx';
import { AgentPage } from './pages/Agent/index.jsx';
import { OsuPage } from './pages/Osu/index.jsx';
import { MembersPage } from './pages/Members/index.jsx';
import { PersonaPage } from './pages/Persona/index.jsx';
import { MemoryPage } from './pages/Memory/index.jsx';
import { RelationshipsPage } from './pages/Relationships/index.jsx';
import { ProfileLogsPage } from './pages/ProfileLogs/index.jsx';
import { ModelsPage } from './pages/Models/index.jsx';
import { IntegrationsPage } from './pages/Integrations/index.jsx';
import { PermissionsPage } from './pages/Permissions/index.jsx';
import { LogsPage } from './pages/Logs/index.jsx';
import { MaintenancePage } from './pages/Maintenance/index.jsx';
import { api, rememberAdminPassword, resetAdminAuthPrompt } from './lib/api.js';

export function App() {
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState(null);
  const [toast, setToast] = useState('');
  const [loadError, setLoadError] = useState('');
  const refreshInFlight = useRef(null);
  const refreshAbort = useRef(null);
  const mounted = useRef(false);

  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const controller = new AbortController();
    refreshAbort.current = controller;
    const request = (async () => {
      try {
        const data = await api('/api/state', { signal: controller.signal, timeoutMs: 10000 });
        if (mounted.current) {
          setState(data);
          setLoadError('');
        }
      } catch (error) {
        if (mounted.current && error?.message !== '请求已取消') setLoadError(error.message || String(error));
      } finally {
        if (refreshAbort.current === controller) refreshAbort.current = null;
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer = null;
    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      if (!stopped && document.visibilityState !== 'hidden') timer = window.setTimeout(run, 10000);
    };
    const run = async () => {
      await refresh();
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (timer) window.clearTimeout(timer);
        timer = null;
      } else {
        void run();
      }
    };
    void run();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      mounted.current = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      refreshAbort.current?.abort();
    };
  }, [refresh]);

  const saveSettings = async (patch) => {
    const data = await api('/api/settings', { method: 'POST', body: patch });
    rememberAdminPassword(patch.adminPassword);
    setState((current) => ({ ...current, db: data.db }));
    setToast('已保存设置');
    setTimeout(() => setToast(''), 1800);
  };

  if (!state) {
    return <div className="boot"><p>{loadError || '正在打开控制台...'}</p>{loadError && <button onClick={() => { resetAdminAuthPrompt(); refresh(); }}>重试</button>}</div>;
  }

  const db = state.db;
  return <AppShell
    page={tab}
    onNavigate={setTab}
    db={db}
    oneBot={state.oneBot}
    onStopAll={async () => { await api('/api/stop-all', { method: 'POST' }); refresh(); }}
    onPauseToggle={() => saveSettings({ globalPaused: !db.settings.globalPaused })}
  >
    {toast && <div className="toast">{toast}</div>}
    {tab === 'overview' && <DashboardPage db={db} oneBot={state.oneBot} saveSettings={saveSettings} refreshState={refresh} />}
    {tab === 'groups' && <GroupsPage db={db} refreshState={refresh} saveSettings={saveSettings} />}
    {tab === 'agent' && <AgentPage db={db} />}
    {tab === 'osu' && <OsuPage db={db} refreshState={refresh} />}
    {tab === 'members' && <MembersPage db={db} refreshState={refresh} />}
    {tab === 'persona' && <PersonaPage db={db} saveSettings={saveSettings} />}
    {tab === 'memory' && <MemoryPage db={db} saveSettings={saveSettings} refreshState={refresh} />}
    {tab === 'relationships' && <RelationshipsPage db={db} refreshState={refresh} />}
    {tab === 'profileLogs' && <ProfileLogsPage />}
    {tab === 'model' && <ModelsPage db={db} saveSettings={saveSettings} />}
    {tab === 'integrations' && <IntegrationsPage db={db} oneBot={state.oneBot} saveSettings={saveSettings} refreshState={refresh} />}
    {tab === 'permissions' && <PermissionsPage db={db} saveSettings={saveSettings} refreshState={refresh} />}
    {tab === 'logs' && <LogsPage db={db} />}
    {tab === 'maintenance' && <MaintenancePage />}
  </AppShell>;
}
