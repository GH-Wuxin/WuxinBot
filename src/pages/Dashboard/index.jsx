import React, { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Clock3, MessageCircle, RefreshCw, UsersRound, Zap } from 'lucide-react';
import { usePollingResource } from '../../app/polling.js';
import { api } from '../../lib/api.js';
import { Button, Card, ErrorState, LoadingState, SegmentedControl, SectionHeader, StatusBadge, Switch } from '../../components/ui/index.jsx';
import { formatNumber, periodLabels, quotaWindows, shortNumber, usagePeriods, usageSummary } from './usageView.js';

const apiModels = { 'deepseek-v4-flash': 'V4 Flash', 'deepseek-v4-pro': 'V4 Pro', 'deepseek-chat': 'Chat', 'deepseek-reasoner': 'Reasoner' };
const codexModels = { 'gpt-5.6-luna': 'Luna', 'gpt-5.6-terra': 'Terra', 'gpt-5.6-sol': 'Sol' };
const percent = value => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%';
const localTime = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '暂无';

function Score({ value }) {
  const short = shortNumber(value);
  return <span className="osu-score" title={formatNumber(value)}>{short.value}<small>{short.unit}</small></span>;
}

function UsageChart({ summary, period, onPeriodChange }) {
  const [hovered, setHovered] = useState(null);
  const { points, totals, cached, cacheWrite, cacheRate, measuredInput } = summary;
  const maximum = Math.max(1, ...points.map(point => Number(point.totalTokens || 0)));
  const selected = points.find(point => point.start === hovered);
  const label = periodLabels[period];
  return <Card className="osu-usage">
    <header className="osu-usage__heading"><h2>Token 用量</h2><SegmentedControl value={period} onChange={onPeriodChange} label="Token 统计周期" options={usagePeriods} /></header>
    <div className="osu-usage__score"><div><Score value={totals.totalTokens} /><span className="osu-score-unit">TOKENS</span></div><p>{formatNumber(totals.requests)} 次请求</p></div>
    {period !== 'all' && <><div className={'osu-chart' + (period === 'daily7' ? ' osu-chart--daily' : '')}>
      {!points.length ? <div className="osu-chart__empty">暂无用量记录</div> : <>
        <div className="osu-chart__axis"><span>峰值 {shortNumber(maximum).value}{shortNumber(maximum).unit}</span><span>0</span></div>
        <div className="osu-chart__bars" style={{ '--bar-count': points.length }} onMouseLeave={() => setHovered(null)}>{points.map((point, index) => <button type="button" key={point.start} className={'osu-chart__column' + (hovered === point.start ? ' is-focused' : '')} onMouseEnter={() => setHovered(point.start)} onFocus={() => setHovered(point.start)} onBlur={() => setHovered(null)} onClick={() => setHovered(point.start)} aria-label={point.label + '：' + formatNumber(point.totalTokens) + ' Token，' + formatNumber(point.requests) + ' 次请求'} title={`${point.label} · 输入 ${formatNumber(point.promptTokens)} · 缓存命中 ${formatNumber(point.cachedTokens)} · 缓存写入 ${formatNumber(point.cacheWriteTokens)} · 输出 ${formatNumber(point.completionTokens)} · 推理 ${formatNumber(point.reasoningTokens)}`}>
          <span className="osu-chart__plot"><span className="osu-chart__bar" style={{ height: (Number(point.totalTokens) > 0 ? Math.max(2, Number(point.totalTokens) / maximum * 100) : 0) + '%' }} /></span>
          <span className="osu-chart__label">{period === 'daily7' || index === 0 || index % 4 === 3 || index === points.length - 1 ? point.label : ''}</span>
        </button>)}</div>
      </>}
    </div>
    <div className="osu-chart__caption" aria-live="polite">{selected ? selected.label + ' · ' + formatNumber(selected.totalTokens) + ' Token · ' + formatNumber(selected.requests) + ' 次请求' : '点击柱条查看明细'}</div></>}
    <div className="osu-usage__breakdown" aria-label={label + ' Token 明细'}>
      <div><span><ArrowDownLeft size={15} />输入</span><strong>{formatNumber(totals.promptTokens)}</strong></div>
      <div><span><ArrowUpRight size={15} />输出</span><strong>{formatNumber(totals.completionTokens)}</strong></div>
      <div><span><Zap size={15} />缓存命中</span><strong>{formatNumber(cached)}</strong></div>
      <div><span>缓存命中率</span><strong className="osu-text-mint">{percent(cacheRate)}</strong></div>
    </div>
    <details className="osu-usage__notes"><summary>统计口径与更多明细<ChevronRight size={14} /></summary><p>{label}精确总量：{formatNumber(totals.totalTokens)} Token。</p><p>缓存命中率只使用可观测输入：{formatNumber(cached)} / {formatNumber(measuredInput)}；缺少明细不当作零命中。缓存命中属于输入的明细，不重复加到总量。</p><p>缓存写入：{formatNumber(cacheWrite)} · 推理 Token：{formatNumber(totals.reasoningTokens)}。历史上未记录的明细无法补算。</p></details>
  </Card>;
}

function QuotaPanel({ enabled, onNavigate }) {
  const resource = usePollingResource(() => api('/api/codex/rate-limits', { timeoutMs: 20000 }), 60000, { enabled });
  const windows = quotaWindows(resource.data?.limits);
  return <Card className="osu-quota"><SectionHeader title={enabled ? 'Codex 额度' : 'API 模型通道'} actions={<Button variant="ghost" size="sm" onClick={() => onNavigate('model')}>管理<ChevronRight size={14} /></Button>} />
    {!enabled ? <p className="osu-muted">当前使用 API 通道。此处不将本地 Token 统计换算为供应商余额。</p> : resource.loading && !resource.data ? <LoadingState label="正在读取额度…" /> : resource.error ? <ErrorState title="额度暂不可用" message={resource.error} onRetry={resource.refresh} /> : !windows.length ? <p className="osu-muted">供应商尚未返回额度窗口。</p> : <div className="osu-quota__windows">{windows.map(window => <div key={window.key} className="osu-quota__window">
      <small>{window.bucket}</small><div><strong>{window.label}</strong><span>{window.used == null ? '未知' : percent(100 - window.used) + ' 剩余'}</span></div>
      <div className={'osu-meter' + (window.used >= 90 ? ' osu-meter--warning' : '')} role="meter" aria-label={window.label + '剩余额度'} aria-valuemin={0} aria-valuemax={100} {...(window.used == null ? { 'aria-valuetext': '未知' } : { 'aria-valuenow': 100 - window.used })}><span style={{ width: (window.used == null ? 0 : 100 - window.used) + '%' }} /></div>
      <p>{window.resetsAt ? localTime(window.resetsAt * 1000) + ' 重置' : '重置时间未知'}</p>
    </div>)}</div>}
    <footer>账号额度与本地 Token 用量是两个口径</footer>
  </Card>;
}

export function DashboardPage({ db, oneBot, saveSettings, refreshState, onNavigate }) {
  const [period, setPeriod] = useState('hourly24');
  const health = usePollingResource(() => api('/api/health'), 5000);
  const codexActive = db.settings.llmProvider === 'codex-app-server';
  const effectiveModel = db.settings.effectiveModel || (codexActive ? db.settings.codexModel : db.settings.model) || '未设置';
  const online = !health.error && health.data?.onebot?.accountOnline !== false && health.data?.onebot?.connected;
  const paused = Boolean(db.settings.globalPaused);
  const summary = usageSummary(db.usageStats, db.usage, period);
  const enabledGroups = (db.groups || []).filter(group => group.enabled).length;
  const experienceEntries = Object.values(db.experience || {});
  const highestPp = experienceEntries.reduce((max, entry) => Math.max(max, Math.floor(Number(entry.xp || 0) / 100) * 100), 0);
  const modelOptions = Object.entries(codexActive ? codexModels : apiModels).map(([value, label]) => ({ value, label }));
  if (!modelOptions.some(option => option.value === effectiveModel)) modelOptions.push({ value: effectiveModel, label: effectiveModel });
  const statusText = health.error ? '状态刷新失败' : !health.data ? '正在连接' : paused ? '已暂停' : health.data.status?.text || '未知';
  const statusTone = health.error ? 'danger' : paused ? 'warning' : health.data?.status?.level === 'ok' ? 'success' : health.data?.status?.level === 'error' ? 'danger' : 'warning';
  return <div className="dashboard-page osu-dashboard">
    <div className="osu-session-bar"><StatusBadge tone={statusTone}>{statusText}</StatusBadge><span><span className="osu-muted">当前模型</span> {effectiveModel}</span><span><UsersRound size={14} />{enabledGroups} 个群已启用</span><Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => { refreshState(); health.refresh(); }}>刷新状态</Button></div>
    {health.error && <p className="osu-inline-warning" role="status">无法获取最新运行状态：{health.error}。请检查服务连接。</p>}
    <div className="osu-dashboard__stage"><UsageChart summary={summary} period={period} onPeriodChange={setPeriod} /><aside className="osu-dashboard__rail"><QuotaPanel enabled={codexActive} onNavigate={onNavigate} /><Card className="osu-health"><SectionHeader title="运行状态" />
      <div className="osu-health__row"><span>QQ / OneBot</span><StatusBadge tone={online ? 'success' : 'neutral'}>{!health.data || health.error ? '未知' : health.data.onebot?.accountOnline === false ? '账号离线' : online ? '已连接' : '未连接'}</StatusBadge></div>
      <div className="osu-health__row"><span><Clock3 size={14} />模型平均延迟</span><strong>{health.error ? '—' : health.data?.llm?.avgLatencyMs ? (health.data.llm.avgLatencyMs / 1000).toFixed(1) + ' 秒' : '暂无'}</strong></div>
      <div className="osu-health__row"><span>近期模型错误</span><strong>{health.error ? '—' : health.data ? health.data.llm?.recentFailures || '无' : '—'}</strong></div>
      <details className="osu-usage__notes"><summary>连接详情<ChevronRight size={14} /></summary><p>OneBot 传输：{(oneBot.transportConnected ?? oneBot.connected) ? '已连接' : '未连接'}<br />最近 QQ 事件：{localTime(oneBot.lastEventAt)}<br />重连次数：{oneBot.reconnectCount ?? 0}<br />经验最高：{formatNumber(highestPp)}pp</p></details>
      <Button variant="ghost" size="sm" onClick={() => onNavigate('logs')}>查看运行日志<ChevronRight size={14} /></Button>
    </Card></aside></div>
    <section className="osu-today" aria-label="自然日与累计指标"><div><MessageCircle size={18} /><span>今日消息<small>今日 00:00 至今</small></span><strong>{formatNumber(db.stateStats?.todayMessages ?? db.messages?.length)}</strong></div><div><Zap size={18} /><span>今日 Token<small>与滚动 24 小时不同</small></span><strong>{shortNumber(db.usageStats?.today?.totalTokens).value}{shortNumber(db.usageStats?.today?.totalTokens).unit}</strong></div><div><UsersRound size={18} /><span>经验成员<small>累计 {formatNumber(db.usage?.replies)} 次回复</small></span><strong>{Object.keys(db.experience || {}).length}</strong></div></section>
    <section className="dashboard-controls"><Card><SectionHeader title="参与方式" /><Switch checked={Boolean(db.settings.onlyMentionMode)} onChange={event => saveSettings({ onlyMentionMode: event.target.checked })} label="临时只在 @ 时回复" description="立即生效；关闭后恢复各群自己的参与模式。" /></Card><Card><SectionHeader title="快速切换模型" actions={<Button variant="ghost" size="sm" onClick={() => onNavigate('model')}>设置<ChevronRight size={14} /></Button>} /><SegmentedControl value={effectiveModel} onChange={model => saveSettings(codexActive ? { codexModel: model } : { model })} label="快速切换模型" options={modelOptions} /></Card></section>
  </div>;
}
