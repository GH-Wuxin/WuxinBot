import React, { useState } from 'react';
import { Activity, Bot, Clock3, MessageCircle, Radio, RefreshCw, UsersRound, Zap } from 'lucide-react';
import { usePollingResource } from '../../app/polling.js';
import { api } from '../../lib/api.js';
import { Button, Card, ErrorState, LoadingState, MetricCard, SegmentedControl, SectionHeader, StatusBadge, Switch } from '../../components/ui/index.jsx';

const modelLabels = {
  'deepseek-v4-flash': 'V4 Flash（视觉）',
  'deepseek-v4-pro': 'V4 Pro',
  'deepseek-chat': 'Chat',
  'deepseek-reasoner': 'Reasoner'
};

const formatNumber = (value) => Number(value || 0).toLocaleString('zh-CN');
const compactNumber = (value) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value || 0));

function healthTone(level) {
  if (level === 'ok') return 'success';
  if (level === 'warn') return 'warning';
  if (level === 'error') return 'danger';
  return 'neutral';
}

function UsageChart({ usageStats, usage }) {
  const [period, setPeriod] = useState('hourly24');
  const data = period === 'all' ? [] : (usageStats?.[period] || []);
  const maxTokens = Math.max(1, ...data.map((item) => Number(item.totalTokens || 0)));
  const periodLabel = period === 'all' ? '历史累计' : period === 'daily7' ? '近 7 天' : '近 24 小时';
  const breakdown = period === 'all' ? usage : data.reduce((total, item) => ({
    totalTokens: total.totalTokens + Number(item.totalTokens || 0),
    promptTokens: total.promptTokens + Number(item.promptTokens || 0),
    cachedTokens: total.cachedTokens + Number(item.cachedTokens || 0),
    cacheWriteTokens: total.cacheWriteTokens + Number(item.cacheWriteTokens || 0),
    completionTokens: total.completionTokens + Number(item.completionTokens || 0),
    reasoningTokens: total.reasoningTokens + Number(item.reasoningTokens || 0),
    requests: total.requests + Number(item.requests || 0),
  }), { totalTokens: 0, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, requests: 0 });
  const totals = [
    { label: period === 'all' ? '累计总量' : period === 'daily7' ? '7 天总量' : '24 小时总量', value: breakdown?.totalTokens },
    { label: '输入', value: breakdown?.promptTokens },
    { label: '缓存命中', value: breakdown?.cachedTokens },
    { label: '缓存写入', value: breakdown?.cacheWriteTokens },
    { label: '输出', value: breakdown?.completionTokens },
    { label: 'Reasoning', value: breakdown?.reasoningTokens },
  ];
  return <Card className="dashboard-usage"><SectionHeader eyebrow="Activity" title="Token 用量" description={`${periodLabel} · ${formatNumber(breakdown?.totalTokens)} Token · ${formatNumber(breakdown?.requests)} 次请求`} actions={<SegmentedControl value={period} onChange={setPeriod} label="Token 统计周期" options={[{ value: 'all', label: '总览' }, { value: 'daily7', label: '7 天' }, { value: 'hourly24', label: '24 小时' }]} />} /><div className="dashboard-usage__totals" aria-label={`${periodLabel} Token 明细`}>{totals.map((item) => <div key={item.label}><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>)}</div><p className="dashboard-usage__note">缓存命中、缓存写入和 reasoning 从支持明细统计的版本开始累计。</p>{period === 'all' ? <div className="dashboard-usage__empty">总览显示历史累计；切换到 7 天或 24 小时可查看最近消耗分布。</div> : data.length === 0 ? <div className="dashboard-usage__empty">当前周期还没有用量记录。</div> : <div className={`dashboard-usage__chart dashboard-usage__chart--${period}`} role="img" aria-label={`${periodLabel} Token 用量柱状图`}>{data.map((item, index) => {
    const height = item.totalTokens > 0 ? Math.max(5, Math.round(Number(item.totalTokens) / maxTokens * 100)) : 0;
    const showLabel = period === 'daily7' || index % 4 === 3 || index === data.length - 1;
    const title = `${item.label} · ${formatNumber(item.totalTokens)} Token · 输入 ${formatNumber(item.promptTokens)} · 缓存命中 ${formatNumber(item.cachedTokens)} · 缓存写入 ${formatNumber(item.cacheWriteTokens)} · 输出 ${formatNumber(item.completionTokens)} · reasoning ${formatNumber(item.reasoningTokens)} · ${item.requests} 次`;
    return <div className="dashboard-usage__column" key={item.start} title={title}><span className="dashboard-usage__value">{item.totalTokens ? compactNumber(item.totalTokens) : ''}</span><div className="dashboard-usage__track"><span className="dashboard-usage__bar" style={{ '--usage-height': `${height}%` }} /></div><small>{showLabel ? item.label : ''}</small></div>;
  })}</div>}</Card>;
}

export function DashboardPage({ db, oneBot, saveSettings, refreshState }) {
  const health = usePollingResource(() => api('/api/health'), 5000);
  const healthData = health.data;
  const level = healthData?.status?.level || 'unknown';
  const oneBotLabel = healthData?.onebot?.accountOnline === false ? '账号离线' : healthData?.onebot?.connected ? '已连接' : '未连接';
  const enabledGroups = (db.groups || []).filter((group) => group.enabled).length;
  const experienceEntries = Object.values(db.experience || {});
  const highestPp = experienceEntries.length ? Math.max(...experienceEntries.map((entry) => Math.floor(Number(entry.xp || 0) / 100) * 100)) : 0;
  return <div className="dashboard-page">
    <Card className="dashboard-hero"><div><StatusBadge tone={db.settings.globalPaused ? 'warning' : 'success'}>{db.settings.globalPaused ? 'PAUSED' : 'ONLINE'}</StatusBadge><h2>WuxinBot 正在{db.settings.globalPaused ? '等待恢复' : '参与群聊'}</h2><p>pippi · {oneBotLabel} · 当前模型 {db.settings.model}</p></div><Button icon={RefreshCw} onClick={refreshState}>刷新状态</Button></Card>

    <section className="dashboard-metrics" aria-label="今日指标">
      <MetricCard icon={UsersRound} label="启用群" value={enabledGroups} detail={`共 ${(db.groups || []).length} 个配置`} />
      <MetricCard icon={MessageCircle} label="今日消息" value={formatNumber(db.stateStats?.todayMessages ?? db.messages?.length)} detail={`累计回复 ${formatNumber(db.usage?.replies)}`} />
      <MetricCard icon={Zap} label="今日 Token" value={compactNumber(db.usageStats?.today?.totalTokens)} detail={`累计 ${compactNumber(db.usage?.totalTokens)}`} tone="accent" />
      <MetricCard icon={Activity} label="经验成员" value={experienceEntries.length} detail={experienceEntries.length ? `最高 ${formatNumber(highestPp)}pp` : '暂无经验记录'} />
    </section>

    <section className="dashboard-grid">
      <Card className="dashboard-health"><SectionHeader eyebrow="System Health" title="服务健康" description="来自 /api/health 的实时状态" />{health.loading && !healthData ? <LoadingState label="正在读取健康状态…" /> : health.error && !healthData ? <ErrorState message={health.error} onRetry={health.refresh} /> : <div className="dashboard-health__list">
        <div><StatusBadge tone={healthTone(level)}>{healthData?.status?.text || '状态未知'}</StatusBadge><span>整体状态</span></div>
        <div><StatusBadge tone={oneBotLabel === '已连接' ? 'success' : 'danger'}>{oneBotLabel}</StatusBadge><span>OneBot / QQ</span></div>
        <div><strong>{healthData?.llm?.avgLatencyMs ? `${healthData.llm.avgLatencyMs} ms` : '暂无'}</strong><span>LLM 平均延迟</span></div>
        <div><strong>{healthData?.llm?.recentFailures || '无'}</strong><span>LLM 近期错误</span></div>
      </div>}{health.error && healthData && <p className="dashboard-health__stale">刷新失败，正在显示上一次状态：{health.error}</p>}</Card>

      <Card className="dashboard-runtime"><SectionHeader eyebrow="Runtime" title="当前运行状态" description="只展示现有状态，不推断 Agent telemetry" /><div className="dashboard-runtime__rows"><div><span>模型</span><strong>{db.settings.model}</strong></div><div><span>OneBot transport</span><strong>{(oneBot.transportConnected ?? oneBot.connected) ? 'Connected' : 'Disconnected'}</strong></div><div><span>最近 QQ 事件</span><strong>{oneBot.lastEventAt || '暂无'}</strong></div><div><span>重连次数</span><strong>{oneBot.reconnectCount ?? 0}</strong></div></div></Card>
    </section>

    <UsageChart usageStats={db.usageStats} usage={db.usage} />

    <section className="dashboard-controls">
      <Card><SectionHeader eyebrow="Conversation" title="参与方式" description="立即写入现有 settings" /><Switch checked={Boolean(db.settings.onlyMentionMode)} onChange={(event) => saveSettings({ onlyMentionMode: event.target.checked })} label="临时只在 @ 时回复" description="关闭后恢复各群自己的参与模式。" /></Card>
      <Card><SectionHeader eyebrow="Model" title="快速切换模型" description="切换当前默认聊天模型" /><SegmentedControl value={db.settings.model} onChange={(model) => saveSettings({ model })} label="快速切换模型" options={Object.entries(modelLabels).map(([value, label]) => ({ value, label }))} /></Card>
    </section>
  </div>;
}
