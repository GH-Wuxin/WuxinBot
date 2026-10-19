import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, IconButton, InlineHelp, Input, MetricCard, Pill, SectionHeader, SegmentedControl, StatusBadge } from '../../components/ui/index.jsx';
import { Avatar, userAvatarUrl } from '../../components/Avatar.jsx';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

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
  const statusInFlight = useRef(false);

  const load = async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const nextStatus = await api('/api/osu/status', { timeoutMs: 10000 });
      setStatus(nextStatus); setLoadError('');
    } catch (error) { setLoadError(error?.message || String(error)); }
    finally { statusInFlight.current = false; }
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
    else { const data = await api(`/api/osu/search?name=${encodeURIComponent(query)}`, { timeoutMs: 20000 }); openPlayer(data.player.id, data.player.username); }
  });
  const addBinding = () => run('binding-add', async () => {
    await api('/api/osu/bindings', { method: 'POST', body: { action: 'add', qq, username: name }, timeoutMs: 15000 });
    setQq(''); setName(''); await Promise.all([load(), refreshState()]);
  });
  const removeBinding = () => run('binding-remove', async () => {
    await api('/api/osu/bindings', { method: 'POST', body: { action: 'remove', qq: unbind.qq }, timeoutMs: 15000 });
    setUnbind(null); await Promise.all([load(), refreshState()]);
  });
  const bindings = status?.bindings || [];
  const bots = status?.bots || [];
  const toolRows = [...(db.commandLogs || [])]
    .filter((log) => /osu/i.test(String(log.command || '') + ' ' + String(log.subCommand || '')))
    .slice(-8)
    .reverse();
  const stamp = (value) => {
    const date = new Date(value || '');
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  };
  const elapsed = (ms) => (Number.isFinite(Number(ms)) && ms != null ? (Number(ms) / 1000).toFixed(1) + 's' : '—');

  return <>
    <div className="page-head">
      <div><h1>osu!</h1><p>能力、数据源和调用情况；查谁不是这一页的重点。</p></div>
      <div style={{ display: 'flex', gap: 8 }}><RefreshButton onClick={load} label="刷新状态" /></div>
    </div>

    {loadError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>osu! 状态读取失败：{loadError}</div>}
    {operationError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>操作失败：{operationError}</div>}

    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card stat"><div className="stat-label">绑定账号</div><div className="stat-value">{number(bindings.length)}</div><div className="stat-note">QQ ↔ osu!</div></div>
      <div className="card stat"><div className="stat-label">玩家分析</div><div className="stat-value">{number(status?.stats?.analyzeCount)}</div><div className="stat-note">/w osu analyze</div></div>
      <div className="card stat"><div className="stat-label">绑定指令</div><div className="stat-value">{number(status?.stats?.bindCount)}</div><div className="stat-note">/w osu bind</div></div>
      <div className="card stat"><div className="stat-label">API 429</div><div className="stat-value">{number(status?.health?.api429Count)}</div><div className="stat-note">运行期记录</div></div>
    </div>

    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><span className="card-title">查人</span><span className="muted" style={{ fontSize: 12 }}>输入用户名、ID 或主页链接</span></div>
      <div className="searchbar">
        <span className="muted">@</span>
        <input
          aria-label="osu! 用户名或 ID"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') doSearch(); }}
          placeholder="输入 osu! 用户名、ID 或主页链接"
        />
        <button type="button" className="btn btn-primary" disabled={!searchText.trim() || pending === 'search'} onClick={doSearch}>{pending === 'search' ? '查询中…' : '查询'}</button>
      </div>
    </div>

    <div className="grid grid-main">
      <div className="card">
        <div className="card-head"><span className="card-title">工具调用</span><span className="muted" style={{ fontSize: 12 }}>最近 osu! 指令 · {toolRows.length} 条</span></div>
        <table className="table">
          <thead><tr><th>时间</th><th>工具</th><th>目标</th><th>耗时</th><th>结果</th></tr></thead>
          <tbody>
            {toolRows.map((log) => <tr key={log.id}>
              <td className="muted">{stamp(log.createdAt)}</td>
              <td><b>{[log.command, log.subCommand].filter(Boolean).join(' ') || 'osu'}</b></td>
              <td className="muted">{log.nickname || log.userId || '—'}</td>
              <td>{elapsed(log.latencyMs)}</td>
              <td><span className={'chip' + (log.status === 'ok' ? ' chip--mint' : log.status === 'error' || log.status === 'denied' ? ' chip--amber' : '')}>{log.status === 'ok' ? '成功' : log.status || '—'}</span></td>
            </tr>)}
            {!toolRows.length && <tr><td colSpan="5" className="muted">最近还没有 osu! 指令记录。</td></tr>}
          </tbody>
        </table>
        <div className="note" style={{ marginTop: 12 }}>结果来自指令日志；失败与降级都会如实标出。</div>
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">外部 osu! 服务</span><span className="muted" style={{ fontSize: 12 }}>{bots.filter((bot) => bot.up).length} 在线</span></div>
          <div className="rows">
            {bots.map((bot) => <div className="row" key={bot.id}>
              <span className="status-dot" style={{ background: bot.up ? 'var(--mint)' : 'var(--red)' }} />
              <div className="row-main">
                <div className="row-title">{botLabels[bot.id] || bot.id}</div>
                <div className="row-sub">127.0.0.1:{bot.port}</div>
              </div>
              <span className={'chip' + (bot.up ? ' chip--mint' : '')}>{bot.up ? '可用' : '离线'}</span>
            </div>)}
            {!bots.length && <div className="note">没有服务状态。</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><span className="card-title">本地能力</span></div>
          <div className="kv"><span>渲染失败</span><b>{number(status?.health?.renderFailures)}</b></div>
          <div className="kv"><span>玩家分析</span><b>{number(status?.stats?.analyzeCount)}</b></div>
          <div className="kv"><span>绑定指令</span><b>{number(status?.stats?.bindCount)}</b></div>
          <div className="kv"><span>API 429</span><b>{number(status?.health?.api429Count)}</b></div>
        </div>
      </div>
    </div>

    <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><span className="card-title">当前工具面</span><span className="muted" style={{ fontSize: 12 }}>osu! 相关</span></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {['best_score', 'best_scores', 'player', 'pp_plus', 'bp_type', 'recommend', 'beatmap', 'pp_calc', 'leaderboard', 'beatmap_skill', 'player_skill', 'recent_skill', 'compare_skill'].map((name) => <span className="chip" key={name}>{name}</span>)}
        </div>
        <div className="note" style={{ marginTop: 10 }}>发图工具在第一层数据回来后才会出现。</div>
      </div>
      <div className="card">
        <div className="card-head"><span className="card-title">绑定</span><span className="muted" style={{ fontSize: 12 }}>{bindings.length} 个</span></div>
        <div className="rows" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {bindings.map((binding) => <div className="row" key={binding.qq}>
            <Avatar name={binding.username || binding.qq} src={userAvatarUrl(binding.qq)} size={26} />
            <div className="row-main">
              <button
                type="button"
                className="row-title"
                style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => openPlayer(binding.id, binding.username)}
              >{binding.username || '未解析用户名'}</button>
              <div className="row-sub">QQ {binding.qq} · osu! {binding.id || '-'}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUnbind(binding)}>解绑</button>
          </div>)}
          {!bindings.length && <div className="note">还没有绑定。</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input className="osu-inline-input" aria-label="QQ 号" placeholder="QQ 号" value={qq} onChange={(event) => setQq(event.target.value)} style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 10, color: 'var(--text)', padding: '8px 12px' }} />
          <input aria-label="osu! 用户名" placeholder="osu! 用户名" value={name} onChange={(event) => setName(event.target.value)} style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 10, color: 'var(--text)', padding: '8px 12px' }} />
          <button type="button" className="btn btn-primary" disabled={!qq.trim() || !name.trim() || pending === 'binding-add'} onClick={addBinding}>{pending === 'binding-add' ? '绑定中…' : '绑定'}</button>
        </div>
      </div>
    </div>

    {drawer && <PlayerDrawer key={drawer.osuId} osuId={drawer.osuId} username={drawer.username} onClose={() => setDrawer(null)} />}
    <ConfirmDialog open={Boolean(unbind)} title="解除 osu! 绑定？" description={unbind ? `QQ ${unbind.qq} 将不再绑定 ${unbind.username || unbind.id}。玩家公开档案不会被删除。` : ''} confirmLabel="解除绑定" busy={pending === 'binding-remove'} onCancel={() => setUnbind(null)} onConfirm={removeBinding} />
  </>;
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
    try { const result = force ? await api(`/api/osu/player/${osuId}/refresh`, { method: 'POST', timeoutMs: 30000 }) : await api(`/api/osu/player/${osuId}`, { timeoutMs: 20000 }); setProfile(result.profile); }
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
    if (tab === 'bp' && data.bp === undefined && !loading.bp) loadTab('bp', () => api(`/api/osu/player/${osuId}/bp?start=${(bpPage - 1) * 20 + 1}&end=${bpPage * 20}`, { timeoutMs: 60000 }));
    else if (tab === 'recent' && data.recent === undefined && !loading.recent) loadTab('recent', () => api(`/api/osu/player/${osuId}/recent?limit=10`, { timeoutMs: 45000 }));
    else if (tab === 'pplus' && data.pplus === undefined && !loading.pplus) loadTab('pplus', () => api(`/api/osu/player/${osuId}/pplus`, { timeoutMs: 20000 }));
    else if (tab === 'bptype' && data.bptype === undefined && !loading.bptype) loadTab('bptype', () => api(`/api/osu/player/${osuId}/bptype`, { timeoutMs: 75000 }));
    else if (tab === 'badges' && data.badges === undefined && !loading.badges) loadTab('badges', async () => { const result = await api(`/api/osu/player/${osuId}`, { timeoutMs: 20000 }); return { badges: result.profile.player.badges || [] }; });
    else if (tab === 'analysis' && analysis === null) {
      const controller = new AbortController();
      api(`/api/osu/player/${osuId}/analyze`, { signal: controller.signal, timeoutMs: 15000 })
        .then((result) => setAnalysis(result.analysis))
        .catch(() => {});
      return () => controller.abort();
    }
  }, [tab, profile, data, loading, bpPage, osuId, analysis]);

  useEffect(() => {
    if (tab !== 'analysis' || analysis?.status !== 'running') return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api(`/api/osu/player/${osuId}/analyze`, { signal: controller.signal, timeoutMs: 15000 });
        if (!controller.signal.aborted) setAnalysis(result.analysis);
      } catch { /* keep last state */ }
      finally { inFlight = false; }
    };
    const timer = setInterval(poll, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [tab, analysis?.status, osuId]);

  const startAnalysis = async () => { setAnalyzing(true); try { const result = await api(`/api/osu/player/${osuId}/analyze`, { method: 'POST', timeoutMs: 15000 }); setAnalysis(result.analysis); } finally { setAnalyzing(false); } };
  const forceRefresh = async () => { setRefreshing(true); try { await loadProfile(true); } finally { setRefreshing(false); } };
  const player = profile?.player || null;
  const bpResult = data.bp;
  const bpPages = Math.max(1, Math.ceil(Number(bpResult?.total || 0) / 20));

  return <div className="drawer-root is-open">
    <div className="drawer-backdrop" onClick={onClose} />
    <aside className="drawer" role="dialog" aria-modal="true" aria-label={`${player?.username || username || osuId} 玩家档案`}>
      <div className="drawer-head">
        <div>
          <h3>{countryEmoji(player?.country_code)} {player?.username || username || `玩家 ${osuId}`}</h3>
          <p>
            {player
              ? `osu! #${number(player.global_rank)} · ${number(player.pp)}pp · ${Number(player.accuracy || 0).toFixed(2)}%`
              : `ID ${osuId} · 档案读取中`}
          </p>
        </div>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭玩家档案">×</button>
      </div>

      <div className="drawer-tabs">
        {playerTabs.map((item) => <button key={item.value} type="button" className={tab === item.value ? 'is-active' : ''} onClick={() => setTab(item.value)}>{item.label}</button>)}
      </div>

      <div className="drawer-body">
        {profileError && <div className="note" style={{ color: 'var(--red)', marginBottom: 10 }}>玩家档案加载失败：{profileError}</div>}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <span className="chip">档案时间 {fmtDate(profile?.fetchedAt)}</span>
          {profile && !profile.stored && <span className="chip chip--amber">实时抓取</span>}
          <button type="button" className="btn btn-sm" disabled={refreshing} onClick={forceRefresh} style={{ marginLeft: 'auto' }}>{refreshing ? '更新中…' : '更新档案'}</button>
        </div>

        {tab === 'overview' && <OverviewTab player={player} />}
        {tab === 'bp' && <ScoreTab data={bpResult} loading={loading.bp} rows={bpResult?.bp} pages={bpPages} page={bpPage} onPage={(next) => { setBpPage(next); setData((current) => ({ ...current, bp: undefined })); }} />}
        {tab === 'recent' && <ScoreTab data={data.recent} loading={loading.recent} rows={data.recent?.recent} />}
        {tab === 'pplus' && <PPlusTab data={data.pplus} loading={loading.pplus} />}
        {tab === 'bptype' && <TextTab data={data.bptype} loading={loading.bptype} title="BP 类型分布（osu!oracle）" />}
        {tab === 'badges' && <BadgesTab data={data.badges} loading={loading.badges} />}
        {tab === 'analysis' && <AnalysisTab analysis={analysis} analyzing={analyzing} onStart={startAnalysis} />}
      </div>
    </aside>
  </div>;
}

function ScoreTab({ data, loading, rows, pages = 1, page = 1, onPage }) {
  if (loading) return <div className="note">加载中…</div>;
  if (data?.error) return <div className="note" style={{ color: 'var(--red)' }}>成绩加载失败：{data.error}</div>;
  return <div>
    {onPage && pages > 1 && <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span className="muted" style={{ fontSize: 12 }}>{page} / {pages}</span>
      <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>}
    <div className="rows">
      {(rows || []).map((row, index) => <div className="row" key={row.id || `${row.bid}-${row.bpRank || index}`}>
        <div className="row-main">
          <div className="row-title">#{row.bpRank || index + 1}</div>
          <div className="row-sub" style={{ whiteSpace: 'normal' }}>{scoreLine(row)}</div>
        </div>
      </div>)}
      {data && (rows || []).length === 0 && <div className="note">暂无成绩。</div>}
    </div>
  </div>;
}

function OverviewTab({ player }) {
  if (!player) return <div className="note">加载中…</div>;
  const grades = player.grade_counts || {};
  const history = player.rank_history || [];
  const min = Math.min(...history);
  const max = Math.max(...history);
  return <div>
    <div className="kv"><span>全球排名</span><b>#{number(player.global_rank)}</b></div>
    <div className="kv"><span>国内排名</span><b>#{number(player.country_rank)}</b></div>
    <div className="kv"><span>PP</span><b>{number(player.pp)}</b></div>
    <div className="kv"><span>准确率</span><b>{Number(player.accuracy || 0).toFixed(2)}%</b></div>
    <div className="kv"><span>游玩次数</span><b>{number(player.play_count)}</b></div>
    <div className="kv"><span>游戏时长</span><b>{fmtDuration(player.play_time)}</b></div>
    <div className="kv"><span>最大连击</span><b>{number(player.max_combo)}</b></div>
    <div className="kv"><span>总命中</span><b>{number(player.total_hits)}</b></div>
    <div className="kv"><span>注册时间</span><b>{fmtDate(player.join_date)}</b></div>
    <div className="kv"><span>评级分布</span><b>SSH {grades.ssh || 0} · SS {grades.ss || 0} · SH {grades.sh || 0} · S {grades.s || 0} · A {grades.a || 0}</b></div>

    {history.length > 1 && <div style={{ marginTop: 14 }}>
      <div className="card-title" style={{ marginBottom: 8 }}>全球排名走势 · 近 90 天</div>
      <svg width="100%" height="110" viewBox={`0 0 ${history.length * 2} 100`} preserveAspectRatio="none">
        <polyline fill="none" stroke="var(--pink)" strokeWidth="2" points={history.map((rank, index) => `${index * 2},${Math.max(2, Math.min(98, 8 + (rank - min) / Math.max(1, max - min) * 84))}`).join(' ')} />
      </svg>
    </div>}

    {player.badges?.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
      {player.badges.map((badge, index) => <img key={index} src={badge.image_url} alt={badge.description} title={badge.description} style={{ width: 40, height: 40, borderRadius: 8 }} />)}
    </div>}
  </div>;
}

function PPlusTab({ data, loading }) {
  if (loading) return <div className="note">加载中…</div>;
  if (data?.error) return <div className="note" style={{ color: 'var(--red)' }}>PP+ 加载失败：{data.error}</div>;
  const bars = data?.bars;
  if (!bars) return <div className="note">PP+ 数据暂不可用：服务可能未启动，或该玩家尚未被分析。</div>;
  const dims = [['jump', '跳跃'], ['flow', '读图'], ['speed', '速度'], ['stamina', '耐力'], ['precision', '准确'], ['accuracy', '稳定']];
  return <div>
    <div className="card-title" style={{ marginBottom: 10 }}>PP+ 维度</div>
    {dims.map(([key, label]) => {
      const value = Number(bars[key] || 0);
      const percent = Math.max(0, Math.min(100, (value / 20) * 100));
      return <div className="bar-row" key={key}>
        <span>{label}</span>
        <div className="bar"><i style={{ width: percent + '%' }} /></div>
        <b>{value.toFixed(2)}</b>
      </div>;
    })}
    <div className="kv" style={{ marginTop: 10 }}><span>Total PP+</span><b>{number(bars.ppTotal)}</b></div>
    <div className="note" style={{ marginTop: 8 }}>条形按 20 为满刻度显示；数值来自 LazyBot PP+ 分析。</div>
  </div>;
}

function TextTab({ data, loading, title }) {
  if (loading) return <div className="note">加载中…</div>;
  if (data?.error) return <div className="note" style={{ color: 'var(--red)' }}>数据加载失败：{data.error}</div>;
  if (!data?.text) return <div className="note">暂无数据。</div>;
  return <div>
    <div className="note" style={{ marginBottom: 8 }}>{title}</div>
    <pre style={{ maxHeight: 460, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--soft)' }}>{data.text}</pre>
  </div>;
}

function BadgesTab({ data, loading }) {
  if (loading) return <div className="note">加载中…</div>;
  const badges = data?.badges || [];
  if (badges.length === 0) return <div className="note">该玩家没有官方徽章。</div>;
  return <div className="rows">
    {badges.map((badge, index) => <div className="row" key={index}>
      <img src={badge.image_url} alt={badge.description} style={{ width: 40, height: 40, borderRadius: 8 }} />
      <div className="row-main">
        <div className="row-title" style={{ whiteSpace: 'normal' }}>{badge.description}</div>
        <div className="row-sub">{fmtDate(badge.awarded_at)}</div>
      </div>
    </div>)}
  </div>;
}

function AnalysisTab({ analysis, analyzing, onStart }) {
  return <div>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
      <button type="button" className="btn btn-primary btn-sm" disabled={analyzing || analysis?.status === 'running'} onClick={onStart}>{analysis?.status === 'running' ? '分析中…' : '生成 Analyze 报告'}</button>
      <span className="note" style={{ margin: 0 }}>控制台触发不经过 QQ 侧冷却；同一玩家同时只运行一个任务。</span>
    </div>
    {analysis?.status === 'running' && <div className="note">分析生成中，完成后会自动显示…</div>}
    {analysis?.status === 'error' && <div className="note" style={{ color: 'var(--red)' }}>分析失败：{analysis.error}</div>}
    {analysis?.status === 'done' && <>
      <div className="note">完成于 {fmtDate(analysis.finishedAt)} · 开始于 {fmtDate(analysis.at)}</div>
      {analysis.source === 'fallback' && <div className="note" style={{ color: 'var(--amber)' }}>本次 LLM 输出未通过事实校验，已显示确定性安全报告。</div>}
      <pre style={{ maxHeight: 460, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--soft)' }}>{analysis.text}</pre>
    </>}
    {!analysis && <div className="note">还没有分析记录，触发后会在这里展示当前玩家的完整报告。</div>}
  </div>;
}
