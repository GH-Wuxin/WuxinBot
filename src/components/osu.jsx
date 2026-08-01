// osu! console tab: player search, binding management, quick-router switches,
// stats, and a slide-out player drawer (profile/BP/recent/PP+/type/badges/analysis).
import React, { useEffect, useMemo, useRef, useState } from 'react';

const ADMIN_PASSWORD_KEY = 'wuxinAdminPassword';
let authPromptActive = false;
let authPromptCancelled = false;

async function api(path, options = {}, allowAuthRetry = true) {
  const savedPassword = window.sessionStorage.getItem(ADMIN_PASSWORD_KEY) || '';
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(savedPassword ? { 'X-Wuxin-Admin-Password': savedPassword } : {}),
      ...(options.headers || {})
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data;
  try { data = await res.json(); } catch { throw new Error(`服务器错误 (${res.status})`); }
  if (res.status === 401 && allowAuthRetry && !authPromptActive && !authPromptCancelled) {
    authPromptActive = true;
    const password = window.prompt('控制台已启用管理密码，请输入：');
    authPromptActive = false;
    if (password === null) {
      authPromptCancelled = true;
      throw new Error('需要管理密码');
    }
    window.sessionStorage.setItem(ADMIN_PASSWORD_KEY, password);
    return api(path, options, false);
  }
  if (!res.ok || !data.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const botLabels = { yumu: '雨沐', kanon: '猫猫', hydrant: '消防栓', lazybot: 'LazyBot' };
const tabLabels = { overview: '概览', bp: 'BP', recent: '最近', pplus: 'PP+', bptype: '类型', badges: '徽章', analysis: '分析' };
const countryEmoji = (code) => {
  if (!code || code.length !== 2) return '🌐';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};

function Stat({ label, value }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

function fmtDuration(seconds) {
  const hours = Math.round(Number(seconds || 0) / 3600);
  return `${hours} 小时`;
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function scoreLine(row) {
  const mods = Array.isArray(row.mods) && row.mods.length ? row.mods.join('') : 'NM';
  return `${row.bpRank ? `#${row.bpRank} ` : ''}${row.title} [${row.version}] | ${row.stars ? row.stars.toFixed(2) + '★' : '?★'} | ${mods} | ${row.acc ? row.acc.toFixed(2) + '%' : '?'} | ${row.max_combo}x/${row.max_combo_total || '?'}x${row.pp ? ` | ${row.pp.toFixed(1)}pp` : ''}${row.weighted_pp ? ` (加权 ${row.weighted_pp.toFixed(1)})` : ''}${row.rank !== 'F' ? ` | ${row.rank}` : ''}`;
}

export function Osu({ db, refresh }) {
  const [status, setStatus] = useState(null);
  const [qq, setQq] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [drawer, setDrawer] = useState(null); // { osuId, username }

  const load = async () => {
    try { setStatus(await api('/api/osu/status')); } catch { /* keep last */ }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  const addBinding = async () => {
    if (!qq.trim() || !name.trim()) return;
    setBusy(true);
    try {
      await api('/api/osu/bindings', { method: 'POST', body: { action: 'add', qq, username: name } });
      setQq('');
      setName('');
      await load();
      await refresh();
    } finally { setBusy(false); }
  };

  const removeBinding = async (targetQq) => {
    if (!window.confirm(`确定解除 QQ ${targetQq} 的 osu! 绑定？`)) return;
    await api('/api/osu/bindings', { method: 'POST', body: { action: 'remove', qq: targetQq } });
    await load();
    await refresh();
  };

  const toggleGroupQuick = async (groupId, enabled) => {
    await api('/api/osu/quick', { method: 'POST', body: { groupId, enabled } });
    await load();
  };

  const toggleGlobal = async (enabled) => {
    await api('/api/osu/quick', { method: 'POST', body: { global: enabled } });
    await load();
  };

  const openPlayer = (osuId, username) => setDrawer({ osuId: Number(osuId), username });

  const doSearch = async () => {
    const query = searchText.trim();
    if (!query) return;
    setSearching(true);
    try {
      if (/^\d{1,12}$/.test(query)) {
        openPlayer(query, '');
      } else {
        const data = await api(`/api/osu/search?name=${encodeURIComponent(query)}`);
        openPlayer(data.player.id, data.player.username);
      }
    } catch (error) {
      window.alert(String(error?.message || error));
    } finally { setSearching(false); }
  };

  const byCommand = Object.entries(status?.stats?.byCommand || {}).slice(0, 10);
  const bySource = Object.entries(status?.stats?.bySource || {});

  return (
    <>
      <section className="stats">
        <Stat label="绑定账号" value={status?.bindings?.length ?? '…'} />
        <Stat label="快捷指令调用" value={status?.stats?.quickTotal ?? '…'} />
        <Stat label="/w osu analyze" value={status?.stats?.analyzeCount ?? '…'} />
        <Stat label="/w osu bind" value={status?.stats?.bindCount ?? '…'} />
        <Stat label="osu API 429" value={status?.health?.api429Count ?? '…'} />
        <Stat label="渲染失败" value={status?.health?.renderFailures ?? '…'} />
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            placeholder="查询任意 osu! 玩家（用户名或 ID），回车或点查询…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={doSearch} disabled={searching || !searchText.trim()}>
            {searching ? '查询中…' : '查询'}
          </button>
        </div>
        <p className="hint">点击下方绑定表中的玩家，或搜索任意公开玩家，都会打开资料抽屉。</p>
      </section>

      <section className="panel actions" style={{ marginBottom: 16 }}>
        <strong>原 bot 服务</strong>
        <span className="hint" style={{ flex: 1 }}>快捷指令通过本地桥接直连原 bot。</span>
        {(status?.bots || []).map((bot) => (
          <span key={bot.id} className="pill" style={bot.up ? { background: '#e3f2ea', color: '#1f6e52' } : { background: '#fde8e8', color: '#b34444' }}>
            {botLabels[bot.id] || bot.id} · {bot.port} {bot.up ? '在线' : '离线'}
          </span>
        ))}
      </section>

      <section className="grid two">
        <div className="panel">
          <h2>绑定管理</h2>
          <p className="hint">唯一的绑定入口是 /w osu bind；这里供管理员直接维护，点击行打开玩家资料。</p>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <input placeholder="QQ 号" value={qq} onChange={(e) => setQq(e.target.value)} style={{ flex: 1 }} />
            <input placeholder="osu 用户名" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1.4 }} />
            <button className="primary" onClick={addBinding} disabled={busy || !qq.trim() || !name.trim()}>添加</button>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 420 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#66716c' }}>
                  <th style={{ padding: '6px 8px' }}>QQ</th>
                  <th style={{ padding: '6px 8px' }}>osu ID</th>
                  <th style={{ padding: '6px 8px' }}>用户名</th>
                  <th style={{ padding: '6px 8px' }}></th>
                </tr>
              </thead>
              <tbody>
                {(status?.bindings || []).map((b) => (
                  <tr
                    key={b.qq}
                    style={{ borderTop: '1px solid #eee', cursor: 'pointer' }}
                    onClick={() => openPlayer(b.id, b.username)}
                    onMouseOver={(e) => { e.currentTarget.style.background = '#f2f7f4'; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = ''; }}
                  >
                    <td style={{ padding: '6px 8px' }}>{b.qq}</td>
                    <td style={{ padding: '6px 8px' }}>{b.id || '-'}</td>
                    <td style={{ padding: '6px 8px' }}>{b.username || '-'}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      <button style={{ fontSize: 12, padding: '3px 10px' }} onClick={(e) => { e.stopPropagation(); removeBinding(b.qq); }}>解绑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h2>快捷路由开关</h2>
          <p className="hint">快捷指令默认按群关闭；原 bot 停服后可以全局开启。</p>
          <label className="switch">
            <input type="checkbox" checked={Boolean(status?.quickRouterEnabled)} onChange={(e) => toggleGlobal(e.target.checked)} />
            全局开启快捷路由
          </label>
          <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            {(status?.groups || []).map((g) => (
              <label className="switch" key={g.groupId} style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={Boolean(g.quick)}
                  disabled={!g.enabled}
                  onChange={(e) => toggleGroupQuick(g.groupId, e.target.checked)}
                />
                {g.name || g.groupId}（{g.groupId}）{!g.enabled && <span className="hint"> · 群未启用</span>}
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="grid two" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>快捷指令统计</h2>
          <div className="cards">
            {byCommand.length === 0 && <p className="hint">还没有快捷指令记录。</p>}
            {byCommand.map(([command, count]) => (
              <article className="card" key={command} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{command}</strong>
                <span className="pill">{count}</span>
              </article>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {bySource.map(([source, count]) => (
              <span className="pill" key={source}>{botLabels[source] || source} · {count}</span>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>最近快捷指令</h2>
          <div className="loglist">
            {(status?.recentQuick || []).map((log) => (
              <div className="log command" key={log.id}>
                <strong>quick:{log.command} · {log.outcome || 'ok'}</strong>
                <span>{log.groupId} · {log.nickname || log.userId} | {log.createdAt ? new Date(log.createdAt).toLocaleString() : ''}</span>
                {log.detail && <p>{log.detail}</p>}
              </div>
            ))}
            {(status?.recentQuick || []).length === 0 && <p className="hint">暂无记录。</p>}
          </div>
        </div>
      </section>

      {drawer && <PlayerDrawer osuId={drawer.osuId} username={drawer.username} onClose={() => setDrawer(null)} />}
    </>
  );
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

  const loadProfile = async (force = false) => {
    setProfileError('');
    try {
      const data = force
        ? await api(`/api/osu/player/${osuId}/refresh`, { method: 'POST' })
        : await api(`/api/osu/player/${osuId}`);
      setProfile(data.profile);
    } catch (error) {
      setProfileError(String(error?.message || error));
    }
  };

  useEffect(() => { loadProfile(); /* eslint-disable-next-line */ }, [osuId]);

  const loadTab = async (key, fetcher) => {
    setLoading((old) => ({ ...old, [key]: true }));
    try {
      const result = await fetcher();
      setData((old) => ({ ...old, [key]: result }));
    } catch (error) {
      setData((old) => ({ ...old, [key]: { error: String(error?.message || error) } }));
    } finally {
      setLoading((old) => ({ ...old, [key]: false }));
    }
  };

  useEffect(() => {
    if (!profile) return;
    if (tab === 'bp' && data.bp === undefined && !loading.bp) {
      loadTab('bp', () => api(`/api/osu/player/${osuId}/bp?start=${(bpPage - 1) * 20 + 1}&end=${bpPage * 20}`));
    } else if (tab === 'recent' && data.recent === undefined && !loading.recent) {
      loadTab('recent', () => api(`/api/osu/player/${osuId}/recent?limit=10`));
    } else if (tab === 'pplus' && data.pplus === undefined && !loading.pplus) {
      loadTab('pplus', () => api(`/api/osu/player/${osuId}/ppplus`));
    } else if (tab === 'bptype' && data.bptype === undefined && !loading.bptype) {
      loadTab('bptype', () => api(`/api/osu/player/${osuId}/bptype`));
    } else if (tab === 'badges' && data.badges === undefined && !loading.badges) {
      loadTab('badges', async () => {
        const p = await api(`/api/osu/player/${osuId}`);
        return { badges: p.profile.player.badges || [] };
      });
    } else if (tab === 'analysis' && analysis === null) {
      api(`/api/osu/player/${osuId}/analyze`).then((r) => setAnalysis(r.analysis)).catch(() => {});
    }
  }, [tab, profile, data, loading, bpPage, osuId, analysis]);

  // Poll analysis while running.
  useEffect(() => {
    if (tab !== 'analysis' || analysis?.status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const r = await api(`/api/osu/player/${osuId}/analyze`);
        setAnalysis(r.analysis);
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [tab, analysis?.status, osuId]);

  const startAnalysis = async () => {
    setAnalyzing(true);
    try {
      const r = await api(`/api/osu/player/${osuId}/analyze`, { method: 'POST' });
      setAnalysis(r.analysis);
    } finally { setAnalyzing(false); }
  };

  const refresh = async () => {
    setRefreshing(true);
    try { await loadProfile(true); } finally { setRefreshing(false); }
  };

  const player = profile?.player || null;
  const bpResult = data.bp;
  const bpTotal = bpResult?.total || 0;
  const bpPages = Math.max(1, Math.ceil(bpTotal / 20));

  return (
    <div className="osu-drawer-overlay" onClick={onClose}>
      <aside className="osu-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="osu-drawer-header">
          {player?.avatar_url ? <img src={player.avatar_url} alt="" width={56} height={56} style={{ borderRadius: 8 }} /> : <div style={{ width: 56, height: 56, borderRadius: 8, background: '#eee' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              {player ? countryEmoji(player.country_code) : ''} {player?.username || username || `玩家 ${osuId}`}
              {player?.is_supporter && <span title="osu!supporter">💎</span>}
            </h2>
            <p className="hint" style={{ margin: '2px 0 0' }}>
              ID {osuId} {player ? `· ${player.country_name || ''} · ${player.pp.toLocaleString()}pp · 全球 #${player.global_rank.toLocaleString()} · 国内 #${player.country_rank.toLocaleString()}` : ''}
            </p>
          </div>
          <button onClick={onClose} style={{ alignSelf: 'flex-start' }}>✕</button>
        </header>

        {profile && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="pill">档案时间：{fmtDate(profile.fetchedAt)}</span>
            {!profile.stored && <span className="pill">本次为实时抓取</span>}
            <button onClick={refresh} disabled={refreshing} style={{ fontSize: 12, padding: '3px 10px' }}>
              {refreshing ? '刷新中…' : '更新档案'}
            </button>
          </div>
        )}
        {profileError && <p className="hint" style={{ color: '#b34444' }}>{profileError}</p>}

        <nav className="osu-drawer-tabs">
          {Object.entries(tabLabels).map(([key, label]) => (
            <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>
          ))}
        </nav>

        <div className="osu-drawer-body">
          {tab === 'overview' && <OverviewTab player={player} />}
          {tab === 'bp' && (
            <div>
              {bpTotal > 0 && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                  {Array.from({ length: bpPages }, (_, i) => i + 1).map((page) => (
                    <button key={page} className={page === bpPage ? 'selected' : ''} style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => { setBpPage(page); setData((old) => ({ ...old, bp: undefined })); }}>
                      {page}
                    </button>
                  ))}
                </div>
              )}
              {loading.bp && <p className="hint">加载中…</p>}
              {bpResult?.error && <p className="hint" style={{ color: '#b34444' }}>{bpResult.error}</p>}
              {bpResult?.bp && (
                <div className="osu-score-list">
                  {bpResult.bp.map((row) => (
                    <div key={row.id || `${row.bid}-${row.bpRank}`} className="osu-score-row" title={`${row.title} [${row.version}] · ${row.bid}`}>
                      <strong>#{row.bpRank}</strong>
                      <span>{scoreLine(row)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'recent' && (
            <div>
              {loading.recent && <p className="hint">加载中…</p>}
              {data.recent?.error && <p className="hint" style={{ color: '#b34444' }}>{data.recent.error}</p>}
              {data.recent?.recent && (
                <div className="osu-score-list">
                  {data.recent.recent.map((row, index) => (
                    <div key={index} className="osu-score-row">
                      <span>{scoreLine(row)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'pplus' && <PPlusTab data={data.pplus} loading={loading.pplus} />}
          {tab === 'bptype' && <TextTab data={data.bptype} loading={loading.bptype} title="BP 类型分布（osu!oracle）" />}
          {tab === 'badges' && <BadgesTab data={data.badges} loading={loading.badges} />}
          {tab === 'analysis' && (
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                <button className="primary" onClick={startAnalysis} disabled={analyzing || analysis?.status === 'running'}>
                  {analysis?.status === 'running' ? '分析中…' : '触发 LLM 分析'}
                </button>
                <span className="hint">控制台触发不经过 QQ 侧冷却；同一玩家同时只跑一个任务。</span>
              </div>
              {analysis?.status === 'running' && <p className="hint">分析生成中（约 3-4 分钟），完成后自动显示…</p>}
              {analysis?.status === 'error' && <p className="hint" style={{ color: '#b34444' }}>分析失败：{analysis.error}</p>}
              {analysis?.status === 'done' && (
                <div>
                  <p className="hint">完成于 {fmtDate(analysis.finishedAt)} · 开始于 {fmtDate(analysis.at)}</p>
                  <pre className="osu-analysis-text">{analysis.text}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function OverviewTab({ player }) {
  if (!player) return <p className="hint">加载中…</p>;
  const grades = player.grade_counts || {};
  return (
    <div>
      <section className="stats" style={{ marginBottom: 12 }}>
        <Stat label="等级" value={`${player.level} (${player.level_progress}%)`} />
        <Stat label="准确率" value={`${player.accuracy.toFixed(2)}%`} />
        <Stat label="游玩次数" value={player.play_count.toLocaleString()} />
        <Stat label="游戏时长" value={fmtDuration(player.play_time)} />
        <Stat label="最大连击" value={player.max_combo.toLocaleString()} />
        <Stat label="总命中" value={player.total_hits.toLocaleString()} />
      </section>
      <div className="row"><span>入坑日期</span><strong>{fmtDate(player.join_date)}</strong></div>
      <div className="row">
        <span>评级分布</span>
        <strong>SSH {grades.ssh} · SS {grades.ss} · SH {grades.sh} · S {grades.s} · A {grades.a}</strong>
      </div>
      {player.rank_history?.length > 1 && (
        <div style={{ marginTop: 12 }}>
          <p className="hint">全球排名走势（近 90 天，越低越好）</p>
          <svg width="100%" height="90" viewBox={`0 0 ${player.rank_history.length * 2} 100`} preserveAspectRatio="none" style={{ border: '1px solid #eee', borderRadius: 6, background: '#faf9f5' }}>
            <polyline
              fill="none"
              stroke="#3f7f6f"
              strokeWidth="2"
              points={player.rank_history.map((rank, index) => `${index * 2},${Math.max(2, Math.min(98, 8 + (rank - Math.min(...player.rank_history)) / Math.max(1, Math.max(...player.rank_history) - Math.min(...player.rank_history)) * 84))}`).join(' ')}
            />
          </svg>
        </div>
      )}
      {player.badges?.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="hint">官方徽章（{player.badges.length}）</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {player.badges.map((badge, index) => (
              <img key={index} src={badge.image_url} alt={badge.description} title={badge.description} width={48} height={48} style={{ borderRadius: 4, background: '#f0efe9' }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PPlusTab({ data, loading }) {
  if (loading) return <p className="hint">加载中…</p>;
  if (data?.error) return <p className="hint" style={{ color: '#b34444' }}>{data.error}</p>;
  const bars = data?.bars;
  if (!bars) return <p className="hint">PP+ 数据暂不可用（服务可能未启动，或该玩家未被分析）。</p>;
  const dims = ['jump', 'flow', 'speed', 'stamina', 'precision', 'accuracy'];
  const labels = { jump: '跳图', flow: '串图', speed: '速度', stamina: '耐力', precision: '精确', accuracy: '准度' };
  const center = 80;
  const radius = 60;
  const angle = (index) => (Math.PI * 2 * index) / dims.length - Math.PI / 2;
  const point = (index, value) => {
    const r = (Math.max(0, Math.min(15, Number(value) || 0)) / 15) * radius;
    return `${center + r * Math.cos(angle(index)).toFixed(4)},${center + r * Math.sin(angle(index)).toFixed(4)}`;
  };
  const polygon = dims.map((dim, index) => point(index, bars[dim])).join(' ');
  const grid = [3, 6, 9, 12, 15].map((level) =>
    dims.map((_, index) => {
      const r = (level / 15) * radius;
      return `${center + r * Math.cos(angle(index))},${center + r * Math.sin(angle(index))}`;
    }).join(' ')
  );
  return (
    <div>
      <svg width="220" height="170" viewBox="0 0 160 160" style={{ display: 'block', margin: '0 auto' }}>
        {grid.map((points, index) => <polygon key={index} points={points} fill="none" stroke="#ddd" />)}
        {dims.map((_, index) => {
          const x = center + radius * Math.cos(angle(index));
          const y = center + radius * Math.sin(angle(index));
          return <line key={index} x1={center} y1={center} x2={x} y2={y} stroke="#eee" />;
        })}
        <polygon points={polygon} fill="rgba(63,127,111,0.25)" stroke="#3f7f6f" strokeWidth="2" />
        {dims.map((dim, index) => {
          const value = Number(bars[dim]) || 0;
          const [x, y] = point(index, value).split(',');
          return <circle key={dim} cx={x} cy={y} r="2.5" fill="#3f7f6f" />;
        })}
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 8 }}>
        {dims.map((dim) => (
          <div className="row" key={dim} style={{ margin: 0 }}>
            <span>{labels[dim]}</span>
            <strong>{Number(bars[dim] || 0).toFixed(2)}</strong>
          </div>
        ))}
        <div className="row" style={{ margin: 0 }}>
          <span>总 PP+</span>
          <strong>{Number(bars.ppTotal || 0).toLocaleString()}</strong>
        </div>
      </div>
    </div>
  );
}

function TextTab({ data, loading, title }) {
  if (loading) return <p className="hint">加载中…</p>;
  if (data?.error) return <p className="hint" style={{ color: '#b34444' }}>{data.error}</p>;
  if (!data?.text) return <p className="hint">暂无数据。</p>;
  return (
    <div>
      <p className="hint">{title}</p>
      <pre className="osu-analysis-text">{data.text}</pre>
    </div>
  );
}

function BadgesTab({ data, loading }) {
  if (loading) return <p className="hint">加载中…</p>;
  const badges = data?.badges || [];
  if (badges.length === 0) return <p className="hint">该玩家没有官方徽章。</p>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
      {badges.map((badge, index) => (
        <div key={index} className="card" style={{ textAlign: 'center' }}>
          <img src={badge.image_url} alt={badge.description} width={64} height={64} style={{ borderRadius: 6 }} />
          <p style={{ fontSize: 12, margin: '6px 0 0' }}>{badge.description}</p>
          <p className="hint" style={{ margin: 0 }}>{fmtDate(badge.awarded_at)}</p>
        </div>
      ))}
    </div>
  );
}
