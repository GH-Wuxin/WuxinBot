import React, { useState } from 'react';
import { usePollingResource } from '../../app/polling.js';
import { api } from '../../lib/api.js';
import { Avatar, groupAvatarUrl, userAvatarUrl } from '../../components/Avatar.jsx';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

// 结构与 class 名对齐原型 PAGES.overview，数据换成本地真实字段。
const num = (value) => Number(value || 0).toLocaleString('en-US');
const wan = (value) => (Number(value || 0) / 10000).toFixed(1);
const shortWan = (value) => {
  const n = Number(value || 0);
  return n >= 10000 ? (n / 10000).toFixed(1) + '万' : num(n);
};
const modeLabel = (mode) => ({ mention: '@ 回复', natural: '自然群友', light: '轻度参与', osu: '仅 osu! 指令' }[mode] || mode || '未设置');
const timeOf = (iso) => {
  const date = new Date(iso || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
};



export function DashboardPage({ db, oneBot, refreshState, onNavigate }) {
  const [hovered, setHovered] = useState(null);
  const health = usePollingResource(() => api('/api/health'), 5000);
  const settings = db.settings || {};
  const paused = Boolean(settings.globalPaused);
  const model = settings.effectiveModel || settings.model || '未设置';
  const online = oneBot?.accountOnline !== false && Boolean(oneBot?.connected || oneBot?.transportConnected);

  const groups = db.groups || [];
  const enabledGroups = groups.filter((group) => group.enabled).length;
  const experienceCount = Object.keys(db.experience || {}).length;
  const today = db.usageStats?.today || {};
  const hourly = db.usageStats?.hourly24 || [];
  const points = hourly.map((point) => Number(point.totalTokens || 0));
  const maximum = Math.max(1, ...points);
  const total24h = points.reduce((sum, value) => sum + value, 0);
  const cacheRate = today.cacheMeasuredPromptTokens
    ? (Number(today.cachedTokens || 0) / Number(today.cacheMeasuredPromptTokens)) * 100
    : null;
  const latencyMs = health.error ? null : health.data?.llm?.avgLatencyMs;
  const failures = health.error ? null : health.data?.llm?.recentFailures;
  const daily7 = db.usageStats?.daily7 || [];
  const yesterday = daily7.length > 1 ? daily7[daily7.length - 2] : null;
  const yesterdayTokens = Number(yesterday?.totalTokens || 0);
  const todayTokens = Number(today.totalTokens || 0);
  const tokenDelta = yesterdayTokens > 0 ? ((todayTokens - yesterdayTokens) / yesterdayTokens) * 100 : null;
  const replies = (db.messages || []).filter((message) => message.role === 'assistant').slice(-4).reverse();
  const statusText = health.error ? '状态刷新失败' : paused ? '已暂停' : online ? '运行中' : '未连接';

  return <>
    <div className="page-head">
      <div><h1>总览</h1><p>这台机器人现在在做什么，今天花了多少。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <RefreshButton className="btn btn-ghost" label="刷新状态" onClick={() => Promise.all([refreshState(), health.refresh()])} />
        <button type="button" className="btn" onClick={() => onNavigate('runtime')}>更多操作</button>
      </div>
    </div>

    <div className="hero">
      <div>
        <span className="hero-eyebrow">{paused ? 'WuxinBot · 已暂停' : 'WuxinBot · 在线'}</span>
        <h2>今天已经回了 <em>{num(today.requests)}</em> 次请求</h2>
        <p>{enabledGroups} 个群在跑 · 平均延迟 {latencyMs ? (latencyMs / 1000).toFixed(1) + ' 秒' : '—'} · 缓存命中 {cacheRate == null ? '—' : cacheRate.toFixed(1) + '%'}</p>
      </div>
      <div className="hero-side">
        <div><span>今日 Token</span><b>{wan(today.totalTokens)} 万</b></div>
        <div><span>经验成员</span><b>{num(experienceCount)}</b></div>
        <div><span>模型</span><b>{String(model).replace(/^deepseek-/, '')}</b></div>
      </div>
    </div>

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">机器人</div><div className="stat-value">{statusText}</div><div className="stat-note">OneBot {online ? '已连接' : '未连接'} · {enabledGroups} 个群启用</div></div>
      <div className="card stat"><div className="stat-label">今日消息</div><div className="stat-value">{num(db.stateStats?.todayMessages)}</div><div className="stat-note">00:00 至今</div></div>
      <div className="card stat"><div className="stat-label">今日 Token</div><div className="stat-value">{wan(todayTokens)}<span className="stat-unit">万</span></div><div className="stat-note">昨日 {wan(yesterdayTokens)} 万{tokenDelta == null ? '' : ' · ' + (tokenDelta >= 0 ? '+' : '') + tokenDelta.toFixed(0) + '%'}</div></div>
      <div className="card stat"><div className="stat-label">经验成员</div><div className="stat-value">{num(experienceCount)}</div><div className="stat-note">累计 {num(db.usage?.replies)} 次回复</div></div>
    </div>

    <div className="grid grid-main" style={{ marginBottom: 16 }}>
      <div className="card">
        <div className="card-head"><span className="card-title">Token 用量 · 24 小时</span><span className="muted" style={{ fontSize: 12 }}>{num(today.requests)} 次请求</span></div>
        <div style={{ font: '800 44px/1 var(--num)', letterSpacing: '-.04em', fontVariantNumeric: 'tabular-nums' }}>{wan(total24h)}<span style={{ fontSize: 18, color: 'var(--muted)', marginLeft: 6 }}>万</span></div>
        <div className={'chart' + (hovered ? ' is-hovering' : '')} onMouseLeave={() => setHovered(null)}>
          {points.map((tokens, index) => <i
            key={hourly[index]?.start || index}
            className={hovered?.index === index ? 'is-hot' : undefined}
            style={{ height: Math.max(3, Math.round((tokens / maximum) * 100)) + '%', animationDelay: index * 16 + 'ms' }}
            data-hour={hourly[index]?.label || String(index).padStart(2, '0') + ':00'}
            data-tokens={tokens}
            onPointerEnter={(event) => setHovered({
              index,
              tokens,
              label: hourly[index]?.label || String(index).padStart(2, '0') + ':00',
              x: event.currentTarget.offsetLeft + event.currentTarget.offsetWidth / 2,
              y: event.currentTarget.offsetTop,
            })}
            onPointerLeave={() => setHovered(null)}
          />)}
          <span className={'chart-guide' + (hovered ? ' is-on' : '')} style={hovered ? { left: hovered.x } : undefined} />
          <div className={'chart-tip' + (hovered ? ' is-on' : '')} style={hovered ? { left: hovered.x, top: hovered.y } : undefined}>
            {hovered && <>
              <b>{num(hovered.tokens)}</b>
              <small>{hovered.label} · 占 {total24h > 0 ? ((hovered.tokens / total24h) * 100).toFixed(1) : '0.0'}%</small>
            </>}
          </div>
        </div>
        <div className="chart-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
        <div className="legend">
          <div><span>输入</span><strong>{num(today.promptTokens)}</strong></div>
          <div><span>输出</span><strong>{num(today.completionTokens)}</strong></div>
          <div><span>缓存命中</span><strong>{num(today.cachedTokens)}</strong></div>
          <div><span>命中率</span><strong className="mint">{cacheRate == null ? '—' : cacheRate.toFixed(1) + '%'}</strong></div>
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">运行状态</span><a className="card-more" href="#" onClick={(event) => { event.preventDefault(); onNavigate('logs'); }}>详情 →</a></div>
          <div className="kv"><span>QQ / OneBot</span><b className={online ? 'mint' : undefined}>{health.error ? '未知' : online ? '已连接' : '未连接'}</b></div>
          <div className="kv"><span>模型平均延迟</span><b>{latencyMs ? (latencyMs / 1000).toFixed(1) + ' 秒' : '暂无'}</b></div>
          <div className="kv"><span>近期模型错误</span><b>{failures ? String(failures) : '无'}</b></div>
          <div className="kv"><span>当前模型</span><b>{model}</b></div>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">模型通道</span><a className="card-more" href="#" onClick={(event) => { event.preventDefault(); onNavigate('model'); }}>管理 →</a></div>
          <div className="note">API 通道计费与本地 Token 是两个口径，这里不做换算。</div>
          <div className="kv"><span>接口供应商</span><b>{settings.llmProvider === 'codex-app-server' ? 'Codex 配额' : 'OpenAI 兼容'}</b></div>
          <div className="kv"><span>今日请求</span><b>{num(today.requests)}</b></div>
        </div>
      </div>
    </div>

    <div className="grid grid-2">
      <div className="card">
        <div className="card-head"><span className="card-title">群聊</span><a className="card-more" href="#" onClick={(event) => { event.preventDefault(); onNavigate('groups'); }}>全部 →</a></div>
        <div className="rows">
          {groups.slice(0, 5).map((group) => <div className="row" key={group.groupId}>
            <Avatar name={group.name} src={groupAvatarUrl(group.groupId, group.avatarUrl || group.avatar_url)} size={28} />
            <div className="row-main">
              <div className="row-title">{group.name || group.groupId}</div>
              <div className="row-sub">{group.groupId} · {modeLabel(group.mode)}</div>
            </div>
            <span className={'chip' + (group.enabled ? ' chip--mint' : '')}>{group.enabled ? '启用' : '停用'}</span>
            <button type="button" className={'switch' + (group.enabled ? ' is-on' : '')} aria-label={(group.name || group.groupId) + ' 启用状态'} />
          </div>)}
          {!groups.length && <div className="note">还没有配置群聊。</div>}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">最近回复</span><a className="card-more" href="#" onClick={(event) => { event.preventDefault(); onNavigate('logs'); }}>日志 →</a></div>
        <div className="rows">
          {replies.map((message) => <div className="row" key={message.id}>
            <Avatar
              name={message.replyToNickname || message.nickname}
              src={userAvatarUrl(message.replyToUserId || message.userId)}
              size={28}
            />
            <div className="row-main">
              <div className="row-title">{message.replyToNickname || message.nickname || '机器人'}</div>
              <div className="row-sub">{String(message.content || '').slice(0, 40)}</div>
            </div>
            <span className="row-value" style={{ color: 'var(--muted)', fontWeight: 500 }}>{timeOf(message.createdAt)}</span>
          </div>)}
          {!replies.length && <div className="note">最近还没有回复记录。</div>}
        </div>
      </div>
    </div>
  </>;
}
