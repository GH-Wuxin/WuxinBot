import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Menu, Pause, Play, Search, Square, X } from 'lucide-react';
import { navigationGroups, pageMeta } from '../../app/navigation.js';
import { Button, IconButton, StatusBadge } from '../ui/index.jsx';

function GlobalSearch({ db, onNavigate, compact = false }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.trim().toLowerCase();
    const found = [];
    for (const group of db.groups || []) if (String(group.groupId).includes(needle) || String(group.name || '').toLowerCase().includes(needle)) found.push({ key: `group:${group.groupId}`, label: group.name || group.groupId, kind: '群聊', page: 'groups' });
    for (const user of db.users || []) if (String(user.userId).includes(needle) || String(user.nickname || '').toLowerCase().includes(needle) || String(user.note || '').toLowerCase().includes(needle)) found.push({ key: `user:${user.groupId}:${user.userId}`, label: user.nickname || user.userId, kind: '成员', page: 'members' });
    for (const memory of db.memories || []) if (String(memory.userId).includes(needle) || String(memory.nickname || '').toLowerCase().includes(needle) || String(memory.summary || '').toLowerCase().includes(needle)) found.push({ key: `memory:${memory.userId}`, label: memory.nickname || memory.userId, kind: '记忆', page: 'memory' });
    return found.slice(0, 12);
  }, [query, db]);
  return <div className={`shell-search${compact ? ' shell-search--compact' : ''}`}><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群、成员、记忆" aria-label="全局搜索" />{results.length > 0 && <div className="shell-search__results">{results.map((result) => <button key={result.key} type="button" onClick={() => { onNavigate(result.page); setQuery(''); }}><span>{result.label}</span><small>{result.kind}</small></button>)}</div>}</div>;
}

export function AppShell({ page, onNavigate, db, oneBot, onPauseToggle, onStopAll, children }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const meta = pageMeta(page);
  const oneBotOnline = oneBot.accountOnline !== false && Boolean(oneBot.connected || oneBot.transportConnected);
  const paused = Boolean(db.settings.globalPaused);

  useEffect(() => {
    setNavigationOpen(false);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [page]);

  useEffect(() => {
    if (!navigationOpen) return undefined;
    const close = (event) => { if (event.key === 'Escape') setNavigationOpen(false); };
    document.addEventListener('keydown', close);
    document.body.classList.add('console-nav-open');
    return () => {
      document.removeEventListener('keydown', close);
      document.body.classList.remove('console-nav-open');
    };
  }, [navigationOpen]);

  const navigate = (id) => {
    onNavigate(id);
    setNavigationOpen(false);
  };

  return <div className={`console-v2 app-shell${navigationOpen ? ' app-shell--nav-open' : ''}`}>
    <header className="app-shell__mobile-bar">
      <IconButton label="打开导航" icon={Menu} aria-expanded={navigationOpen} aria-controls="console-navigation" onClick={() => setNavigationOpen(true)} />
      <span className="app-shell__mobile-brand"><Bot size={18} /><strong>WuxinBot</strong></span>
      <span className="app-shell__mobile-page">{meta.label}</span>
    </header>
    {navigationOpen && <button type="button" className="app-shell__nav-backdrop" aria-label="关闭导航" onClick={() => setNavigationOpen(false)} />}
    <aside className="app-shell__sidebar" aria-label="Console sidebar">
      <div className="app-shell__brand"><span className="app-shell__brand-mark"><Bot size={22} /></span><div><strong>WuxinBot</strong><small>Console V2</small></div><IconButton className="app-shell__nav-close" label="关闭导航" icon={X} onClick={() => setNavigationOpen(false)} /></div>
      <GlobalSearch db={db} onNavigate={navigate} />
      <nav id="console-navigation" className="app-shell__nav" aria-label="Console navigation">{navigationGroups.map((group) => <section key={group.label} className="app-shell__nav-group"><h2>{group.label}</h2>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={page === item.id ? 'is-active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon size={17} /><span>{item.label}</span></button>; })}</section>)}</nav>
      <div className="app-shell__status"><StatusBadge tone={oneBotOnline ? 'success' : 'danger'}>{oneBotOnline ? 'OneBot Connected' : 'OneBot Offline'}</StatusBadge><StatusBadge tone={paused ? 'warning' : 'success'}>{paused ? 'Bot Paused' : 'Bot Running'}</StatusBadge></div>
    </aside>
    <div className="app-shell__workspace"><header className="app-shell__topbar"><div><span>{meta.description}</span><h1>{meta.label}</h1></div><div className="app-shell__topbar-actions"><Button icon={Square} onClick={onStopAll}>停止后台操作</Button><Button variant={paused ? 'primary' : 'warning'} icon={paused ? Play : Pause} onClick={onPauseToggle}>{paused ? '恢复聊天' : '暂停机器人'}</Button></div></header><main className="app-shell__main">{children}</main></div>
  </div>;
}
