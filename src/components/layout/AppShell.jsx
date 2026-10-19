import React, { useEffect, useMemo, useRef, useState } from 'react';
import { paletteForButton, pulseButton } from '../../lib/ripple.js';
import { Avatar, userAvatarUrl } from '../Avatar.jsx';

// 结构与 class 名严格对齐原型 index.html 的 .topbar，不做重设计。
const PRIMARY = [
  { id: 'overview', label: '总览' },
  { id: 'groups', label: '群聊' },
  { id: 'osu', label: 'osu!' },
  { id: 'logs', label: '日志' },
  { id: 'runtime', label: '运行控制' },
];

const MORE_GROUPS = [
  {
    title: '运行与群聊',
    items: [
      { id: 'randomImages', label: '随机发图' },
      { id: 'agent', label: 'Agent' },
    ],
  },
  {
    title: '群友与记忆',
    items: [
      { id: 'members', label: '成员' },
      { id: 'persona', label: '人设' },
      { id: 'memory', label: '记忆' },
      { id: 'relationships', label: '关系' },
      { id: 'profileLogs', label: '画像日志' },
    ],
  },
  {
    title: '系统设置',
    items: [
      { id: 'model', label: '模型' },
      { id: 'integrations', label: '集成' },
      { id: 'permissions', label: '权限' },
      { id: 'maintenance', label: '维护' },
    ],
  },
];

const SEARCH_FEATURES = [
  { label: '总览', page: 'overview', kind: '页面', keys: '首页 概览 dashboard' },
  { label: '群聊', page: 'groups', kind: '页面', keys: '群 参与模式 开关' },
  { label: 'osu!', page: 'osu', kind: '页面', keys: '查分 玩家 绑定' },
  { label: '日志', page: 'logs', kind: '页面', keys: '请求 时间线 决策' },
  { label: '运行控制', page: 'runtime', kind: '页面', keys: '进程 服务 启动' },
  { label: '随机发图', page: 'randomImages', kind: '页面', keys: '表情 图池 概率' },
  { label: 'Agent', page: 'agent', kind: '页面', keys: '工具 决策 沙盒' },
  { label: '成员', page: 'members', kind: '页面', keys: '群友 QQ 身份' },
  { label: '人设', page: 'persona', kind: '页面', keys: '人格 prompt 分层' },
  { label: '记忆', page: 'memory', kind: '页面', keys: '长期画像 近期动态' },
  { label: '关系', page: 'relationships', kind: '页面', keys: '关系强度 互动' },
  { label: '画像日志', page: 'profileLogs', kind: '页面', keys: '画像 证据 变化' },
  { label: '模型', page: 'model', kind: '页面', keys: 'llm 供应商 key' },
  { label: '集成', page: 'integrations', kind: '页面', keys: 'onebot 外部服务 webhook' },
  { label: '权限', page: 'permissions', kind: '页面', keys: '命令 角色 矩阵' },
  { label: '维护', page: 'maintenance', kind: '页面', keys: '备份 恢复 重算' },
  // 功能项：与原型一样可以搜到页内区块，而不是只能搜到页面名。
  { label: '备份与恢复', page: 'maintenance', kind: '功能', keys: '备份 恢复 快照' },
  { label: '重算任务', page: 'maintenance', kind: '功能', keys: '重算 群画像 记忆 关系' },
  { label: '进程启停与配置', page: 'runtime', kind: '功能', keys: '启动 停止 重启 pid 进程' },
  { label: 'PostgreSQL / MariaDB', page: 'runtime', kind: '功能', keys: 'postgres mysql mariadb 数据库' },
  { label: '外部 Bot 进程', page: 'runtime', kind: '功能', keys: '雨沐 猫猫 消防栓 lazybot 渲染' },
  { label: 'OneBot 连接', page: 'integrations', kind: '功能', keys: 'onebot 探测 上报 webhook' },
  { label: 'Codex 通道', page: 'model', kind: '功能', keys: 'codex 配额 登录' },
  { label: '供应商与 API Key', page: 'model', kind: '功能', keys: 'key 地址 模型 供应商' },
  { label: '命令权限矩阵', page: 'permissions', kind: '功能', keys: '命令 群员 管理 主人' },
  { label: '人格层编辑', page: 'persona', kind: '功能', keys: '人格 prompt 分层 注入' },
  { label: '群画像自动更新', page: 'groups', kind: '功能', keys: '画像 阈值 自动' },
  { label: '玩家档案抽屉', page: 'osu', kind: '功能', keys: '玩家 bp 技能 分析' },
  { label: '日志时间线', page: 'logs', kind: '功能', keys: '请求 事件 阶段' },
  { label: '随机图池', page: 'randomImages', kind: '功能', keys: '图池 表情 概率 群开关' },
];

export function AppShell({ page, onNavigate, db, oneBot, onPauseToggle, children }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [query, setQuery] = useState('');
  const paused = Boolean(db?.settings?.globalPaused);
  const model = db?.settings?.effectiveModel || db?.settings?.model || '未设置';
  const online = oneBot?.accountOnline !== false && Boolean(oneBot?.connected || oneBot?.transportConnected);
  const isPrimary = PRIMARY.some((item) => item.id === page);

  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const features = SEARCH_FEATURES
      .filter((item) => (item.label + ' ' + item.keys).toLowerCase().includes(needle))
      .map((item) => ({ label: item.label, page: item.page, kind: item.kind }));
    const groups = (db?.groups || [])
      .filter((group) => String(group.groupId).includes(needle) || String(group.name || '').toLowerCase().includes(needle))
      .map((group) => ({ label: group.name || group.groupId, page: 'groups', kind: '群聊' }));
    return features.slice(0, 6).concat(groups.slice(0, 4)).slice(0, 10);
  }, [query, db]);

  useEffect(() => {
    setMoreOpen(false);
    setQuery('');
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [page]);

  // 波纹只等状态真的变了再放：点击时记一笔，paused 变化后用 effect 触发；
  // 接口失败时 paused 不变，波纹不会出现。
  const pauseRef = useRef(null);
  const ripplePending = useRef(null);
  useEffect(() => {
    document.body.classList.toggle('is-paused', paused);
    if (!ripplePending.current) return;
    window.clearTimeout(ripplePending.current);
    ripplePending.current = null;
    pulseButton(pauseRef.current, paused ? 'amber' : 'pink');
  }, [paused]);

  // 原型里「全部停止 / 一键启动 / 启动」这些按钮点击时也有波纹。
  useEffect(() => {
    const onClick = (event) => {
      const button = event.target instanceof Element ? event.target.closest('#view button') : null;
      if (!button) return;
      const palette = paletteForButton(button.textContent.trim());
      if (palette) pulseButton(button, palette);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (event) => {
      const target = event.target;
      if (target instanceof Element && (target.closest('#moreMenu') || target.closest('#moreBtn'))) return;
      setMoreOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreOpen]);

  const navigate = (id) => {
    onNavigate(id);
    setMoreOpen(false);
    setQuery('');
  };

  return <>
    <header className="topbar">
      <div className="brand">
        <span className="brand-puck" aria-hidden="true">w!</span>
        <span className="brand-name">WuxinBot</span>
        <span className="brand-tag">control</span>
      </div>
      <nav className="tabs" id="tabs" aria-label="主导航">
        {PRIMARY.map((item) => <button
          key={item.id}
          type="button"
          className={'tab' + (page === item.id ? ' is-active' : '')}
          data-page={item.id}
          onClick={() => navigate(item.id)}
        >{item.label}</button>)}
        <button
          type="button"
          className={'tab' + (!isPrimary ? ' is-active' : '')}
          id="moreBtn"
          data-page="__more"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((value) => !value)}
        >更多 <span className="caret">▾</span></button>
      </nav>
      <div className="shell-search">
        <svg className="shell-search__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="6.9" cy="6.9" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="10.3" y1="10.3" x2="13.8" y2="13.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索页面、功能、群、成员"
          aria-label="全局搜索"
        />
        {query.trim() && <div className="shell-results is-open">
          {searchResults.length
            ? searchResults.map((item) => <button key={item.kind + item.label + item.page} type="button" onClick={() => navigate(item.page)}>
              <span>{item.label}</span><small>{item.kind} · {item.page}</small>
            </button>)
            : <button type="button" disabled><span>没有找到「{query}」</span><small>试试 备份 / 进程 / 查人</small></button>}
        </div>}
      </div>
      <div className="topbar-right">
        <span className="status-dot" title={online ? 'OneBot 在线' : 'OneBot 未连接'} style={{ background: online ? 'var(--mint)' : 'var(--amber)' }} />
        <span className="status-text">{paused ? '已暂停 · ' : (online ? '已连接 · ' : '未连接 · ') + model}</span>
        <button
          type="button"
          ref={pauseRef}
          className={'btn ' + (paused ? 'btn-primary' : 'btn-ghost')}
          id="pauseBtn"
          onClick={() => {
            // 记一笔待触发的波纹；状态没变（请求失败）就不会放。
            ripplePending.current = window.setTimeout(() => { ripplePending.current = null; }, 4000);
            onPauseToggle();
          }}
        >{paused ? '恢复' : '暂停'}</button>
        <span title={`Pippi · 机器人自身（QQ ${db?.settings?.selfQq || '未配置'}）`}>
          <Avatar name="Pippi" src={userAvatarUrl(db?.settings?.selfQq)} size={30} />
        </span>
      </div>
      {moreOpen && <div className="more-menu" id="moreMenu">
        {MORE_GROUPS.map((group) => <div key={group.title}>
          <h4>{group.title}</h4>
          {group.items.map((item) => <button
            key={item.id}
            type="button"
            data-page={item.id}
            className={page === item.id ? 'is-active' : undefined}
            onClick={() => navigate(item.id)}
          >{item.label}</button>)}
        </div>)}
      </div>}
    </header>
    <main id="view" className="view">{children}</main>
  </>;
}
