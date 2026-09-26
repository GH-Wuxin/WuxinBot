import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, InlineHelp, Input, MetricCard, Pill, SectionHeader, SegmentedControl, StatusBadge } from '../../components/ui/index.jsx';

const botLabels = { yumu: 'Yumu / 雨沐', kanon: 'Kanon / 猫猫', hydrant: 'Hydrant / 消防栓', lazybot: 'LazyBot' };
const playerTabs = [
  { value: 'overview', label: '概览' }, { value: 'bp', label: 'BP' }, { value: 'recent', label: '最近' },
  { value: 'pplus', label: 'PP+' }, { value: 'bptype', label: '类型' }, { value: 'badges', label: '徽章' }, { value: 'analysis', label: '分析' }
];
const countryEmoji = (code) => !code || code.length !== 2 ? '🌐' : String.fromCodePoint(...[...code.toUpperCase()].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
const fmtDuration = (seconds) => `${Math.round(Number(seconds || 0) / 3600)} 小时`;
const fmtDate = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const number = (value, fallback = '-') => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : fallback;

function scoreLine(row) {
  const mods = Array.isArray(row.mods) && row.mods.length ? row.mods.join('') : 'NM';
  return `${row.title} [${row.version}] · ${row.stars ? Number(row.stars).toFixed(2) + '★' : '?★'} · ${mods} · ${row.acc ? Number(row.acc).toFixed(2) + '%' : '?'} · ${row.max_combo}x/${row.max_combo_total || '?'}x${row.pp ? ` · ${Number(row.pp).toFixed(1)}pp` : ''}${row.weighted_pp ? `（加权 ${Number(row.weighted_pp).toFixed(1)}）` : ''}${row.rank && row.rank !== 'F' ? ` · ${row.rank}` : ''}`;
}

export function OsuPage({ db, refreshState }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState('');
  const [operationError, setOperationError] = useState('');
  const [qq, setQq] = useState('');
  const [name, setName] = useState('');
  const [searchText, setSearchText] = useState('');
  const [drawer, setDrawer] = useState(null);
  const [unbind, setUnbind] = useState(null);

  const load = async () => {
    try {
      const nextStatus = await api('/api/osu/status');
      setStatus(nextStatus); setLoadError('');
    } catch (error) { setLoadError(error?.message || String(error)); }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  const run = async (key, task) => {
    setPending(key); setOperationError('');
    try { await task(); } catch (error) { setOperationError(error?.message || String(error)); }
    finally { setPending(''); }
  };
  const openPlayer = (osuId, username = '') => setDrawer({ osuId: Number(osuId), username });
  const doSearch = () => run('search', async () => {
    const query = searchText.trim();
    if (!query) return;
    if (/^\d{1,12}$/.test(query)) openPlayer(query);
    else { const data = await api(`/api/osu/search?name=${encodeURIComponent(query)}`); openPlayer(data.player.id, data.player.username); }
  });
  const addBinding = () => run('binding-add', async () => {
    await api('/api/osu/bindings', { method: 'POST', body: { action: 'add', qq, username: name } });
    setQq(''); setName(''); await Promise.all([load(), refreshState()]);
  });
  const removeBinding = () => run('binding-remove', async () => {
    await api('/api/osu/bindings', { method: 'POST', body: { action: 'remove', qq: unbind.qq } });
    setUnbind(null); await Promise.all([load(), refreshState()]);
  });
  return <div className="osu-page">
    <SectionHeader eyebrow="Runtime / osu!" title="osu! 工作流" description="绑定、玩家档案与分析都来自现有真实接口。" actions={<Button icon={RefreshCw} onClick={load}>刷新</Button>} />
    {loadError && <ErrorState title="osu! 状态读取失败" message={loadError} onRetry={load} />}
    {operationError && <ErrorState title="操作失败" message={operationError} />}
    <div className="osu-metrics"><MetricCard label="绑定账号" value={status?.bindings?.length ?? '…'} detail="QQ ↔ osu!" icon={UserRound} /><MetricCard label="玩家分析" value={status?.stats?.analyzeCount ?? '…'} detail="/w osu analyze" icon={Sparkles} /><MetricCard label="绑定指令" value={status?.stats?.bindCount ?? '…'} detail="/w osu bind" icon={ExternalLink} /><MetricCard label="API 429" value={status?.health?.api429Count ?? '…'} detail="运行期记录" /><MetricCard label="渲染失败" value={status?.health?.renderFailures ?? '…'} detail="运行期记录" /></div>

    <Card className="osu-player-search"><Search size={18} /><div><strong>检查玩家档案</strong><small>输入用户名或用户 ID，打开完整资料抽屉。</small></div><Input aria-label="osu! 用户名或 ID" value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') doSearch(); }} placeholder="用户名或 ID" /><Button variant="primary" loading={pending === 'search'} disabled={!searchText.trim()} onClick={doSearch}>查询</Button></Card>

    <Card className="osu-services"><SectionHeader eyebrow="External Services" title="外部 osu! 服务" description="Agent 工具调用依赖的本地服务状态。" /><div className="osu-services__list">{(status?.bots || []).map((bot) => <div key={bot.id}><StatusBadge tone={bot.up ? 'success' : 'danger'}>{bot.up ? 'Available' : 'Unavailable'}</StatusBadge><strong>{botLabels[bot.id] || bot.id}</strong><code>127.0.0.1:{bot.port}</code></div>)}{status && (status.bots || []).length === 0 && <EmptyState title="没有服务状态" />}</div></Card>

    <Card><SectionHeader eyebrow="Bindings" title="绑定管理" description="管理员维护入口；选择玩家名可打开档案。" />
        <div className="osu-binding-form"><Input label="QQ 号" value={qq} onChange={(event) => setQq(event.target.value)} /><Input label="osu! 用户名" value={name} onChange={(event) => setName(event.target.value)} /><Button variant="primary" loading={pending === 'binding-add'} disabled={!qq.trim() || !name.trim()} onClick={addBinding}>添加绑定</Button></div>
        <div className="osu-binding-list">{(status?.bindings || []).map((binding) => <div key={binding.qq}><button type="button" className="osu-binding-list__player" onClick={() => openPlayer(binding.id, binding.username)}><span>{binding.username || '未解析用户名'}</span><small>QQ {binding.qq} · osu! {binding.id || '-'}</small></button><IconButton label={`解除 ${binding.qq} 的绑定`} icon={Trash2} variant="danger-ghost" onClick={() => setUnbind(binding)} /></div>)}{status && (status.bindings || []).length === 0 && <EmptyState title="还没有绑定" description="添加绑定后可以直接打开玩家资料。" />}</div>
    </Card>
    {drawer && <PlayerDrawer key={drawer.osuId} osuId={drawer.osuId} username={drawer.username} onClose={() => setDrawer(null)} />}
    <ConfirmDialog open={Boolean(unbind)} title="解除 osu! 绑定？" description={unbind ? `QQ ${unbind.qq} 将不再绑定 ${unbind.username || unbind.id}。玩家公开档案不会被删除。` : ''} confirmLabel="解除绑定" busy={pending === 'binding-remove'} onCancel={() => setUnbind(null)} onConfirm={removeBinding} />
  </div>;
}

function PlayerDrawer({ osuId, username, onClose }) {
  const [tab, setTab] = useState('overview');
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState({});
  const [loading, setLoading] = useState({});
  const [bpPage, setBpPage] = useState(1);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    const close = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);

  const loadProfile = async (force = false) => {
    setProfileError('');
    try { const result = force ? await api(`/api/osu/player/${osuId}/refresh`, { method: 'POST' }) : await api(`/api/osu/player/${osuId}`); setProfile(result.profile); }
    catch (error) { setProfileError(error?.message || String(error)); }
  };
  useEffect(() => { loadProfile(); }, [osuId]);

  const loadTab = async (key, fetcher) => {
    setLoading((current) => ({ ...current, [key]: true }));
    try { const result = await fetcher(); setData((current) => ({ ...current, [key]: result })); }
    catch (error) { setData((current) => ({ ...current, [key]: { error: error?.message || String(error) } })); }
    finally { setLoading((current) => ({ ...current, [key]: false })); }
  };

  useEffect(() => {
    if (!profile) return;
    if (tab === 'bp' && data.bp === undefined && !loading.bp) loadTab('bp', () => api(`/api/osu/player/${osuId}/bp?start=${(bpPage - 1) * 20 + 1}&end=${bpPage * 20}`));
    else if (tab === 'recent' && data.recent === undefined && !loading.recent) loadTab('recent', () => api(`/api/osu/player/${osuId}/recent?limit=10`));
    else if (tab === 'pplus' && data.pplus === undefined && !loading.pplus) loadTab('pplus', () => api(`/api/osu/player/${osuId}/pplus`));
    else if (tab === 'bptype' && data.bptype === undefined && !loading.bptype) loadTab('bptype', () => api(`/api/osu/player/${osuId}/bptype`));
    else if (tab === 'badges' && data.badges === undefined && !loading.badges) loadTab('badges', async () => { const result = await api(`/api/osu/player/${osuId}`); return { badges: result.profile.player.badges || [] }; });
    else if (tab === 'analysis' && analysis === null) api(`/api/osu/player/${osuId}/analyze`).then((result) => setAnalysis(result.analysis)).catch(() => {});
  }, [tab, profile, data, loading, bpPage, osuId, analysis]);

  useEffect(() => {
    if (tab !== 'analysis' || analysis?.status !== 'running') return undefined;
    const timer = setInterval(async () => { try { const result = await api(`/api/osu/player/${osuId}/analyze`); setAnalysis(result.analysis); } catch { /* keep last state */ } }, 5000);
    return () => clearInterval(timer);
  }, [tab, analysis?.status, osuId]);

  const startAnalysis = async () => { setAnalyzing(true); try { const result = await api(`/api/osu/player/${osuId}/analyze`, { method: 'POST' }); setAnalysis(result.analysis); } finally { setAnalyzing(false); } };
  const forceRefresh = async () => { setRefreshing(true); try { await loadProfile(true); } finally { setRefreshing(false); } };
  const player = profile?.player || null;
  const bpResult = data.bp;
  const bpPages = Math.max(1, Math.ceil(Number(bpResult?.total || 0) / 20));

  return <div className="osu-player-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="osu-player-drawer" role="dialog" aria-modal="true" aria-label={`${player?.username || username || osuId} 玩家档案`}>
    <header className="osu-player-drawer__header">{player?.avatar_url ? <img src={player.avatar_url} alt="" width="58" height="58" /> : <span className="osu-player-drawer__avatar"><UserRound size={24} /></span>}<div><h2>{countryEmoji(player?.country_code)} {player?.username || username || `玩家 ${osuId}`}{player?.is_supporter && <span title="osu!supporter"> ◆</span>}</h2><p>ID {osuId}{player ? ` · ${player.country_name || ''} · ${number(player.pp)}pp · 全球 #${number(player.global_rank)} · 国内 #${number(player.country_rank)}` : ''}</p></div><IconButton label="关闭玩家档案" icon={X} onClick={onClose} /></header>
    <div className="osu-player-drawer__meta"><Pill>档案时间 {fmtDate(profile?.fetchedAt)}</Pill>{profile && !profile.stored && <Pill tone="warning">实时抓取</Pill>}<Button size="sm" icon={RefreshCw} loading={refreshing} onClick={forceRefresh}>更新档案</Button></div>
    {profileError && <ErrorState title="玩家档案加载失败" message={profileError} onRetry={() => loadProfile()} />}
    <div className="osu-player-drawer__tabs"><SegmentedControl value={tab} onChange={setTab} label="玩家资料分栏" options={playerTabs} /></div>
    <div className="osu-player-drawer__body">
      {tab === 'overview' && <OverviewTab player={player} />}
      {tab === 'bp' && <ScoreTab data={bpResult} loading={loading.bp} rows={bpResult?.bp} pages={bpPages} page={bpPage} onPage={(next) => { setBpPage(next); setData((current) => ({ ...current, bp: undefined })); }} />}
      {tab === 'recent' && <ScoreTab data={data.recent} loading={loading.recent} rows={data.recent?.recent} />}
      {tab === 'pplus' && <PPlusTab data={data.pplus} loading={loading.pplus} />}
      {tab === 'bptype' && <TextTab data={data.bptype} loading={loading.bptype} title="BP 类型分布（osu!oracle）" />}
      {tab === 'badges' && <BadgesTab data={data.badges} loading={loading.badges} />}
      {tab === 'analysis' && <AnalysisTab analysis={analysis} analyzing={analyzing} onStart={startAnalysis} />}
    </div>
  </aside></div>;
}

function ScoreTab({ data, loading, rows, pages = 1, page = 1, onPage }) {
  if (loading) return <div className="osu-tab-state">加载中…</div>;
  if (data?.error) return <ErrorState title="成绩加载失败" message={data.error} />;
  return <div>{onPage && pages > 1 && <div className="osu-pagination"><IconButton label="上一页" icon={ChevronLeft} disabled={page <= 1} onClick={() => onPage(page - 1)} /><span>{page} / {pages}</span><IconButton label="下一页" icon={ChevronRight} disabled={page >= pages} onClick={() => onPage(page + 1)} /></div>}<div className="osu-score-list">{(rows || []).map((row, index) => <article key={row.id || `${row.bid}-${row.bpRank || index}`}><strong>{row.bpRank ? `#${row.bpRank}` : `#${index + 1}`}</strong><span>{scoreLine(row)}</span></article>)}{data && (rows || []).length === 0 && <EmptyState title="暂无成绩" />}</div></div>;
}

function OverviewTab({ player }) {
  if (!player) return <div className="osu-tab-state">加载中…</div>;
  const grades = player.grade_counts || {};
  const history = player.rank_history || [];
  const min = Math.min(...history), max = Math.max(...history);
  return <div className="osu-overview"><div className="osu-overview__metrics"><MetricCard label="等级" value={`${player.level} · ${player.level_progress}%`} /><MetricCard label="准确率" value={`${Number(player.accuracy || 0).toFixed(2)}%`} /><MetricCard label="游玩次数" value={number(player.play_count)} /><MetricCard label="游戏时长" value={fmtDuration(player.play_time)} /><MetricCard label="最大连击" value={number(player.max_combo)} /><MetricCard label="总命中" value={number(player.total_hits)} /></div><SettingGroup title="账号档案"><SettingRow title="注册时间" control={<strong>{fmtDate(player.join_date)}</strong>} /><SettingRow title="评级分布" control={<strong>SSH {grades.ssh || 0} · SS {grades.ss || 0} · SH {grades.sh || 0} · S {grades.s || 0} · A {grades.a || 0}</strong>} /></SettingGroup>{history.length > 1 && <Card className="osu-rank-chart"><strong>全球排名走势 · 近 90 天</strong><svg width="100%" height="110" viewBox={`0 0 ${history.length * 2} 100`} preserveAspectRatio="none"><polyline fill="none" stroke="var(--v2-accent)" strokeWidth="2" points={history.map((rank, index) => `${index * 2},${Math.max(2, Math.min(98, 8 + (rank - min) / Math.max(1, max - min) * 84))}`).join(' ')} /></svg></Card>}{player.badges?.length > 0 && <div className="osu-badges osu-badges--compact">{player.badges.map((badge, index) => <img key={index} src={badge.image_url} alt={badge.description} title={badge.description} />)}</div>}</div>;
}

function PPlusTab({ data, loading }) {
  if (loading) return <div className="osu-tab-state">加载中…</div>;
  if (data?.error) return <ErrorState title="PP+ 加载失败" message={data.error} />;
  const bars = data?.bars;
  if (!bars) return <EmptyState title="PP+ 数据暂不可用" description="服务可能未启动，或该玩家尚未被分析。" />;
  const dims = ['jump', 'flow', 'speed', 'stamina', 'precision', 'accuracy'];
  const labels = { jump: 'Jump', flow: 'Flow', speed: 'Speed', stamina: 'Stamina', precision: 'Precision', accuracy: 'Accuracy' };
  const center = 80, radius = 60, values = dims.map((dim) => Number(bars[dim]) || 0), maxScale = Math.max(15, ...values);
  const angle = (index) => Math.PI * 2 * index / dims.length - Math.PI / 2;
  const point = (index, value) => { const r = Math.max(0, Number(value) || 0) / maxScale * radius; return `${center + r * Math.cos(angle(index))},${center + r * Math.sin(angle(index))}`; };
  const ring = (fraction) => dims.map((_, index) => `${center + fraction * radius * Math.cos(angle(index))},${center + fraction * radius * Math.sin(angle(index))}`).join(' ');
  return <div className="osu-pplus"><svg viewBox="0 0 160 160" aria-label="PP+ 六维雷达图">{[.25, .5, .75, 1].map((fraction) => <polygon key={fraction} points={ring(fraction)} />)}<polygon className="osu-pplus__baseline" points={ring(15 / maxScale)} /><polygon className="osu-pplus__value" points={dims.map((dim, index) => point(index, bars[dim])).join(' ')} /></svg><InlineHelp>虚线为 15 基准线（LazyBot expertPlus 上限）。</InlineHelp><div>{dims.map((dim) => <MetricCard key={dim} label={labels[dim]} value={Number(bars[dim] || 0).toFixed(2)} />)}<MetricCard label="Total PP+" value={number(bars.ppTotal)} /></div></div>;
}

function TextTab({ data, loading, title }) {
  if (loading) return <div className="osu-tab-state">加载中…</div>;
  if (data?.error) return <ErrorState title="数据加载失败" message={data.error} />;
  if (!data?.text) return <EmptyState title="暂无数据" />;
  return <div><InlineHelp>{title}</InlineHelp><pre className="osu-analysis-text">{data.text}</pre></div>;
}

function BadgesTab({ data, loading }) {
  if (loading) return <div className="osu-tab-state">加载中…</div>;
  const badges = data?.badges || [];
  if (badges.length === 0) return <EmptyState title="该玩家没有官方徽章" />;
  return <div className="osu-badges">{badges.map((badge, index) => <article key={index}><img src={badge.image_url} alt={badge.description} /><strong>{badge.description}</strong><small>{fmtDate(badge.awarded_at)}</small></article>)}</div>;
}

function AnalysisTab({ analysis, analyzing, onStart }) {
  return <div className="osu-analysis"><div className="osu-analysis__actions"><Button variant="primary" icon={Sparkles} onClick={onStart} loading={analyzing} disabled={analysis?.status === 'running'}>{analysis?.status === 'running' ? '分析中' : '触发 LLM 分析'}</Button><InlineHelp>控制台触发不经过 QQ 侧冷却；同一玩家同时只运行一个任务。</InlineHelp></div>{analysis?.status === 'running' && <div className="osu-tab-state">分析生成中，完成后会自动显示…</div>}{analysis?.status === 'error' && <ErrorState title="分析失败" message={analysis.error} />}{analysis?.status === 'done' && <><p className="osu-analysis__time">完成于 {fmtDate(analysis.finishedAt)} · 开始于 {fmtDate(analysis.at)}</p><pre className="osu-analysis-text">{analysis.text}</pre></>}{!analysis && <EmptyState title="还没有分析记录" description="触发后会在这里展示当前玩家的完整报告。" />}</div>;
}
