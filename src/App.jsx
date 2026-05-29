import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  Cable,
  KeyRound,
  MessageCircle,
  Pause,
  Play,
  Settings,
  Shield,
  SlidersHorizontal,
  UserCog
} from 'lucide-react';
import './styles.css';

function api(path, options = {}) {
  return fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(async (res) => {
    let data;
    try { data = await res.json(); } catch { throw new Error(`服务器错误 (${res.status})`); }
    if (!res.ok || !data.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  });
}

const tabs = [
  { id: 'overview', label: '总览', icon: Activity },
  { id: 'groups', label: '群聊', icon: MessageCircle },
  { id: 'persona', label: '人设', icon: Brain },
  { id: 'model', label: '模型', icon: SlidersHorizontal },
  { id: 'members', label: '成员', icon: UserCog },
  { id: 'memory', label: '记忆', icon: BookOpen },
  { id: 'permissions', label: '权限', icon: KeyRound },
  { id: 'connect', label: 'QQ连接', icon: Cable },
  { id: 'logs', label: '日志', icon: Shield }
];

const modeLabels = {
  silent: '静默',
  mention: '只在 @ 时回复',
  light: '轻度参与',
  natural: '自然群友'
};

const policyLabels = {
  normal: '正常',
  whitelist: '优先回应',
  priority: '重点关注',
  muted: '少回应',
  blocked: '不回应',
  admin: '管理员',
  owner: '所有者'
};

const modelLabels = {
  'deepseek-v4-flash': 'V4 Flash',
  'deepseek-v4-pro': 'V4 Pro',
  'deepseek-chat': 'Chat',
  'deepseek-reasoner': 'Reasoner'
};

const commandLabels = {
  help: '查看帮助 /w help',
  ping: '在线检测 /w ping',
  why: '诊断 /w why',
  summarize: '群聊总结 /w summarize 5-99',
  summarizeLarge: '长群聊总结 /w summarize 100+',
  usage: '用量费用 /w usage',
  status: '查看群参数 /w status',
  rate: '每小时次数 /w rate',
  cooldown: '发言冷却 /w cooldown',
  mode: '回复模式 /w mode',
  preset: '场景预设 /w preset',
  modelShow: '查看模型 /w model show/list',
  modelSet: '切换模型 /w model · 纯人设 /w sysfacts',
  search: '联网搜索 /w search',
  thinking: '思考提示 /w thinking',
  pause: '暂停/恢复 /w pause resume',
  profile: '画像管理 /w profile',
  profileRetry: '画像定向重算 /w profile retry',
  groupProfileShow: '查看群画像 /w group profile show',
  groupProfileEdit: '编辑群画像 /w group profile update',
  relationshipShow: '查看关系画像 /w relation show',
  relationshipEdit: '编辑关系画像 /w relation update',
  promptShow: '查看提示词 /w prompt show',
  promptEdit: '修改提示词 /w prompt add/set/reset',
  promptSavebase: '保存提示词基准 /w prompt savebase',
  groupAdd: '添加活跃群聊 /w group add',
  note: '成员备注 /w note',
  memberPolicy: '成员管理 /w op/ban/trust... · /w refresh'
};

const sampleTypeLabels = {
  text: '真实文本',
  card: '分享卡片',
  media: '媒体',
  'image-summary': '图片摘要',
  command: '指令',
  'bot-output': '机器长文'
};

function App() {
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState(null);
  const [toast, setToast] = useState('');

  const refresh = async () => {
    const data = await api('/api/state');
    setState(data);
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const saveSettings = async (patch) => {
    const data = await api('/api/settings', { method: 'POST', body: patch });
    setState((old) => ({ ...old, db: data.db }));
    setToast('已保存设置');
    setTimeout(() => setToast(''), 1800);
  };

  if (!state) return <div className="boot">正在打开控制台...</div>;

  const db = state.db;
  const ActiveIcon = tabs.find((item) => item.id === tab)?.icon || Settings;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Bot size={28} />
          <div>
            <strong>QQ AI 群友</strong>
            <span>内部小群聊天机器人</span>
          </div>
        </div>
        <nav>
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div style={{ marginTop: 16 }}>
          <GlobalSearch db={db} setTab={setTab} />
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p>{db.settings.globalPaused ? '机器人已暂停' : '机器人运行中'}</p>
            <h1><ActiveIcon size={26} /> {tabs.find((item) => item.id === tab)?.label}</h1>
          </div>
          <button
            onClick={async () => { await api('/api/stop-all', { method: 'POST' }); refresh(); }}
            title="停止所有正在执行的后台操作（重算等）"
          >
            停止全部操作
          </button>
          <button
            className={db.settings.globalPaused ? 'primary' : 'danger'}
            onClick={() => saveSettings({ globalPaused: !db.settings.globalPaused })}
          >
            {db.settings.globalPaused ? <Play size={18} /> : <Pause size={18} />}
            {db.settings.globalPaused ? '恢复聊天' : '暂停机器人'}
          </button>
        </header>

        {toast && <div className="toast">{toast}</div>}

        <RecalcPanel />

        {tab === 'overview' && <Overview db={db} oneBot={state.oneBot} saveSettings={saveSettings} refresh={refresh} />}
        {tab === 'groups' && <Groups db={db} refresh={refresh} saveSettings={saveSettings} />}
        {tab === 'persona' && <Persona db={db} saveSettings={saveSettings} />}
        {tab === 'model' && <Model db={db} saveSettings={saveSettings} />}
        {tab === 'members' && <Members db={db} refresh={refresh} />}
        {tab === 'memory' && <Memory db={db} saveSettings={saveSettings} refresh={refresh} />}
        {tab === 'permissions' && <Permissions db={db} saveSettings={saveSettings} refresh={refresh} />}
        {tab === 'connect' && <Connect db={db} oneBot={state.oneBot} saveSettings={saveSettings} refresh={refresh} />}
        {tab === 'logs' && <Logs db={db} />}
      </main>
    </div>
  );
}

function Overview({ db, oneBot, saveSettings, refresh }) {
  const today = new Date().toISOString().slice(0, 10);
  const todayMessages = db.messages.filter((m) => m.createdAt?.startsWith(today));
  const [health, setHealth] = useState(null);
  useEffect(() => { api('/api/health').then(setHealth).catch(() => {}); const t = setInterval(() => { api('/api/health').then(setHealth).catch(() => {}); }, 5000); return () => clearInterval(t); }, []);
  const statusLevel = health?.status?.level || 'unknown';
  return (
    <>
      {health && (
        <section className="stats">
          <div className="stat" style={statusLevel === 'error' ? { borderColor: '#e4b4b4', background: '#fff5f5' } : statusLevel === 'warn' ? { borderColor: '#e1d4a8', background: '#fffef5' } : {}}>
            <span>整体状态</span>
            <strong style={{ fontSize: 18 }}>{statusLevel === 'ok' ? '✅' : statusLevel === 'warn' ? '⚠️' : '❌'} {health.status.text}</strong>
          </div>
          <Stat label="QQ连接" value={health.onebot.connected ? '已连接' : '断开'} />
          <Stat label="LLM延迟" value={health.llm.avgLatencyMs ? health.llm.avgLatencyMs + 'ms' : '暂无'} />
          <Stat label="LLM近期错误" value={health.llm.recentFailures || '无'} />
        </section>
      )}
      <section className="stats">
        <Stat label="启用群" value={db.groups.filter((g) => g.enabled).length} />
        <Stat label="今日消息" value={todayMessages.length} />
        <Stat label="累计回复" value={db.usage.replies} />
        <Stat label="累计 Token" value={db.usage.totalTokens} />
        {(() => {
          const exp = db.experience || {};
          const levels = [0, 0, 0, 0, 0];
          const levelEmojis = ['🌱', '💬', '🎯', '⭐', '👑'];
          for (const e of Object.values(exp)) levels[e.level || 0]++;
          const total = Object.keys(exp).length;
          if (!total) return null;
          return <Stat label="经验成员" value={`${total} 人 · ${levels.map((c, i) => c ? `${levelEmojis[i]}${c}` : '').filter(Boolean).join(' ')}`} />;
        })()}
      </section>
      <section className="panel actions">
        <button onClick={() => saveSettings({ onlyMentionMode: !db.settings.onlyMentionMode })}>
          {db.settings.onlyMentionMode ? '恢复正常参与' : '临时只在 @ 时回复'}
        </button>
        <button onClick={refresh}>刷新状态</button>
      </section>
      <section className="panel modelSwitch">
        <div>
          <h2>快速切换模型</h2>
          <p className="hint">日常聊天推荐 V4 Flash；想让它更认真、更慢一点时可以切 V4 Pro 或 Reasoner。</p>
        </div>
        <div className="segments">
          {Object.entries(modelLabels).map(([model, label]) => (
            <button
              key={model}
              className={db.settings.model === model ? 'selected' : ''}
              onClick={() => saveSettings({ model })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="grid two">
        <div className="panel">
          <h2>当前状态</h2>
          <Row label="模型" value={db.settings.model} />
          <Row label="LLM Key" value={db.settings.apiKey || '未填写'} />
          <Row label="OneBot 连接" value={oneBot.connected ? '已连接' : '未连接'} />
          <Row label="最近 QQ 事件" value={oneBot.lastEventAt || '暂无'} />
          <Row label="连接错误" value={oneBot.lastError || '无'} />
        </div>
        <div className="panel" style={{ overflow: 'auto', maxHeight: 'calc(100vh - 200px)' }}><Sandbox db={db} /></div>
      </section>
      <Backups />
    </>
  );
}

function GlobalSearch({ db, setTab }) {
  const [query, setQuery] = useState('');
  const allData = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim().toLowerCase();
    const results = [];
    for (const g of (db.groups || [])) {
      if (String(g.groupId).includes(q) || (g.name || '').toLowerCase().includes(q)) results.push({ label: `群: ${g.name || g.groupId}`, tab: 'groups' });
    }
    for (const u of (db.users || [])) {
      if (String(u.userId).includes(q) || (u.nickname || '').toLowerCase().includes(q) || (u.note || '').toLowerCase().includes(q)) results.push({ label: `成员: ${u.nickname || u.userId}`, tab: 'members' });
    }
    for (const m of (db.memories || [])) {
      if (String(m.userId).includes(q) || (m.nickname || '').toLowerCase().includes(q) || (m.summary || '').toLowerCase().includes(q)) results.push({ label: `记忆: ${m.nickname || m.userId}`, tab: 'memory' });
    }
    return results.slice(0, 20);
  }, [query, db]);
  return (
    <div>
      <input placeholder="全局搜索 QQ/昵称/群名..." value={query} onChange={(e) => setQuery(e.target.value)} style={{ background: '#1a2d28', border: '1px solid #3a554c', color: '#dbe9e3', fontSize: 13, padding: '8px 10px', borderRadius: 6, width: '100%' }} />
      {allData.length > 0 && (
        <div style={{ marginTop: 4, maxHeight: 200, overflow: 'auto' }}>
          {allData.map((r, i) => (
            <div key={i} onClick={() => { setTab(r.tab); setQuery(''); }} style={{ padding: '4px 6px', fontSize: 12, color: '#bad0c8', cursor: 'pointer', borderRadius: 4, marginTop: 2, background: 'transparent' }} onMouseOver={(e) => e.target.style.background = '#31544b'} onMouseOut={(e) => e.target.style.background = 'transparent'}>{r.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecalcPanel() {
  const [state, setState] = useState({ running: false, done: 0, total: 0, label: '', stopped: false });
  useEffect(() => {
    const poll = async () => {
      try { const data = await api('/api/recalc-status'); setState(data); } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, []);
  const start = () => api('/api/recalc', { method: 'POST' });
  const stop = () => api('/api/recalc/stop', { method: 'POST' });
  if (!state.running) {
    return (
      <section className="panel actions" style={{ marginBottom: 16 }}>
        <button onClick={start}>全局重算全部画像</button>
        <p className="hint">在后台重算所有个人/群聊/关系画像，不阻塞聊天。QQ 端 /w recalc 查看进度。</p>
      </section>
    );
  }
  const pct = state.total > 0 ? Math.round(state.done / state.total * 100) : 0;
  return (
    <section className="panel" style={{ marginBottom: 16, background: '#fefbf0', borderColor: '#e8d896' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{state.label} {pct}%</strong>
        <button onClick={stop} style={{ fontSize: 12, padding: '4px 10px' }}>停止重算</button>
      </div>
      <div style={{ height: 8, background: '#e8e2d0', borderRadius: 4, margin: '8px 0', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: pct + '%', background: '#3f7f6f', borderRadius: 4, transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontSize: 13, color: '#66716c' }}>{state.done}/{state.total}</span>
    </section>
  );
}

function Backups() {
  const [backups, setBackups] = useState([]);
  const [working, setWorking] = useState(false);
  const load = async () => { const d = await api('/api/backups'); setBackups(d.backups || []); };
  useEffect(() => { load(); }, []);
  const create = async () => { setWorking(true); await api('/api/backups', { method: 'POST', body: { type: 'manual' } }); await load(); setWorking(false); };
  const restore = async (name) => { if (!window.confirm('恢复将覆盖当前运行数据，恢复前会自动备份当前状态。确定恢复？')) return; setWorking(true); await api(`/api/backups/${name}/restore`, { method: 'POST' }); window.location.reload(); };
  const remove = async (name) => { if (!window.confirm('确定删除备份 ' + name + '？')) return; setWorking(true); await api(`/api/backups/${name}`, { method: 'DELETE' }); await load(); setWorking(false); };
  const manualBackups = backups.filter((b) => b.type === 'manual');
  const autoBackups = backups.filter((b) => b.type === 'auto' || b.type === 'pre-restore');
  return (
    <section className="grid two" style={{ marginTop: 16 }}>
      <div className="panel">
        <h2>备份与恢复</h2>
        <p className="hint">手动备份不自动删除。自动备份最多保留 10 份，恢复前备份最多保留 5 份。</p>
        <button className="primary wide" onClick={create} disabled={working}>{working ? '备份中...' : '立即手动备份'}</button>
        {manualBackups.length > 0 && (
          <>
            <h3 style={{ marginTop: 16, fontSize: 14 }}>手动备份</h3>
            <div className="cards">
              {manualBackups.map((b) => (
                <div className="item" key={b.name}>
                  <div><strong>{b.name}</strong><span>{(b.size / 1024).toFixed(1)} KB · {b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN') : ''}</span></div>
                  <div className="itemActions"><button onClick={() => restore(b.name)} disabled={working}>恢复</button><button onClick={() => remove(b.name)} disabled={working}>删除</button></div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="panel">
        <h2>自动备份</h2>
        {autoBackups.length === 0 && <p className="empty">暂无自动备份。启动后每 8 小时自动创建一份。</p>}
        <div className="cards" style={{ maxHeight: 320, overflow: 'auto' }}>
          {autoBackups.slice(0, 10).map((b) => (
            <div className="item" key={b.name}>
              <div><strong>{b.name}</strong><span>{(b.size / 1024).toFixed(1)} KB · {b.createdAt ? new Date(b.createdAt).toLocaleString('zh-CN') : ''}</span></div>
              <div className="itemActions"><button onClick={() => restore(b.name)} disabled={working}>恢复</button></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Groups({ db, refresh, saveSettings }) {
  const [form, setForm] = useState({ groupId: '', name: '', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 });
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [expandedProfiles, setExpandedProfiles] = useState({});
  const [editingProfiles, setEditingProfiles] = useState({});
  const [gpDrafts, setGpDrafts] = useState({});
  const messages = db.messages || [];
  const users = db.users || [];
  const memories = db.memories || [];
  const groupProfiles = db.groupProfiles || [];
  const messagesByGroup = useMemo(() => {
    const grouped = {};
    for (const message of messages) {
      const groupId = String(message.groupId || '');
      if (!groupId) continue;
      if (!grouped[groupId]) grouped[groupId] = [];
      grouped[groupId].push(message);
    }
    return grouped;
  }, [messages]);
  const save = async (payload) => {
    await api('/api/groups', { method: 'POST', body: payload });
    setForm({ groupId: '', name: '', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 });
    refresh();
  };
  const clearContext = async (group) => {
    const ok = window.confirm('只清空"' + (group.name || group.groupId) + '"的聊天上下文和决策日志，不会删除群配置。继续吗？');
    if (!ok) return;
    await api(`/api/clear-context/${group.groupId}`, { method: 'POST' });
    refresh();
  };
  const hasManualGroupName = (group) => {
    const name = String(group.name || '').trim();
    const groupId = String(group.groupId || '').trim();
    return Boolean(name && name !== groupId && name !== `群${groupId}` && name !== `群聊${groupId}` && name !== `群聊 ${groupId}`);
  };
  const recentGroupMessages = (groupId) => messagesByGroup[String(groupId)] || [];
  const latestMessage = (groupId) => {
    const list = recentGroupMessages(groupId);
    return list.length ? list[list.length - 1] : null;
  };
  const recentNames = (groupId, limit = 4) => {
    const seen = new Set();
    const names = [];
    for (const message of [...recentGroupMessages(groupId)].reverse()) {
      if (message.role === 'assistant') continue;
      const name = String(message.nickname || '').trim();
      const userId = String(message.userId || '').trim();
      if (!name || name === userId || seen.has(userId || name)) continue;
      seen.add(userId || name);
      names.push(name);
      if (names.length >= limit) break;
    }
    return names;
  };
  const configuredMembers = (groupId) => users.filter((user) => String(user.groupId) === String(groupId));
  const memoryMembers = (groupId) => memories.filter((memory) => (memory.groupsSeen || []).map(String).includes(String(groupId)));
  const displayGroupName = (group) => {
    if (hasManualGroupName(group)) return group.name;
    const names = recentNames(group.groupId, 2);
    if (names.length) return `${names.join('、')} 等人的群`;
    return `群 ${group.groupId}`;
  };
  const groupSignal = (group) => {
    const last = latestMessage(group.groupId);
    if (!last) return '';
    const who = last.role === 'assistant' ? '机器人' : (last.nickname || last.userId || '群友');
    const text = String(last.text || '').replace(/\s+/g, ' ').slice(0, 34);
    return `最后活跃: ${who} ${new Date(last.createdAt).toLocaleString('zh-CN')}${text ? ' · ' + text : ''}`;
  };
  const groupTags = (group) => {
    const tags = [];
    tags.push({ label: group.enabled ? '启用' : '停用', cls: group.enabled ? 'badge-memory' : 'badge-blocked' });
    if (group.mode === 'natural') tags.push({ label: '自然', cls: 'badge-priority' });
    if (group.mode === 'light') tags.push({ label: '轻度', cls: 'badge-cmd' });
    if (group.mode === 'mention') tags.push({ label: '@回复', cls: 'badge-note' });
    if (group.mode === 'silent') tags.push({ label: '静默', cls: 'badge-blocked' });
    if (hasManualGroupName(group)) tags.push({ label: '备注', cls: 'badge-custom' });
    const gp = groupProfiles.find((p) => String(p.groupId) === String(group.groupId));
    if (gp && gp.enabled !== false && gp.atmosphere) tags.push({ label: '画像', cls: 'badge-memory' });
    return tags;
  };
  const fillAutoName = () => {
    const names = recentNames(form.groupId, 2);
    if (!names.length) return;
    setForm({ ...form, name: `${names.join('、')} 等人的群` });
  };
  const sortedGroups = [...(db.groups || [])].filter((group) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const name = displayGroupName(group).toLowerCase();
    const manual = String(group.name || '').toLowerCase();
    const id = String(group.groupId || '');
    const members = recentNames(group.groupId, 8).join(' ').toLowerCase();
    const latest = String(latestMessage(group.groupId)?.text || '').toLowerCase();
    return name.includes(q) || manual.includes(q) || id.includes(q) || members.includes(q) || latest.includes(q);
  }).sort((a, b) => {
    if (sortBy === 'name') return displayGroupName(a).localeCompare(displayGroupName(b), 'zh-CN');
    if (sortBy === 'enabled') return Number(b.enabled === true) - Number(a.enabled === true);
    const aTime = latestMessage(a.groupId)?.createdAt ? new Date(latestMessage(a.groupId).createdAt).getTime() : 0;
    const bTime = latestMessage(b.groupId)?.createdAt ? new Date(latestMessage(b.groupId).createdAt).getTime() : 0;
    return bTime - aTime;
  });
  const formSuggestion = form.groupId && !hasManualGroupName(form) ? recentNames(form.groupId, 2) : [];
  return (
    <>
      <section className="panel" style={{ marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="switch" style={{ margin: 0 }}>
          <input type="checkbox" checked={db.settings.groupProfileAutoUpdate !== false} onChange={(e) => saveSettings({ groupProfileAutoUpdate: e.target.checked })} />
          群聊画像自动更新
        </label>
        <span style={{ fontSize: 14, color: '#66716c' }}>每</span>
        <input type="number" value={db.settings.groupProfileThreshold || 80} onChange={(e) => saveSettings({ groupProfileThreshold: Math.max(20, Math.min(500, Number(e.target.value) || 80)) })} style={{ width: 70, textAlign: 'center' }} />
        <span style={{ fontSize: 14, color: '#66716c' }}>条消息自动更新一次</span>
      </section>
      <section className="grid two">
      <div className="panel">
        <h2>{db.groups.some((group) => group.groupId === form.groupId) ? '编辑群设置' : '添加白名单群'}</h2>
        <Text label="QQ群号" value={form.groupId} onChange={(groupId) => setForm({ ...form, groupId })} />
        <Text label="群名称 / 备注" value={form.name} onChange={(name) => setForm({ ...form, name })} />
        <p className="hint">不填备注时，右侧会根据最近发言的群名片和成员记录自动辅助辨认。</p>
        {formSuggestion.length > 0 && (
          <button type="button" className="wide" onClick={fillAutoName}>用最近活跃成员生成备注</button>
        )}
        <Select label="回复模式" value={form.mode} onChange={(mode) => setForm({ ...form, mode })} options={modeLabels} />
        <Slider label="每小时最多回复" min={1} max={80} value={form.maxPerHour} onChange={(maxPerHour) => setForm({ ...form, maxPerHour })} />
        <Slider label="发言冷却秒数" min={0} max={180} value={form.cooldownSec} onChange={(cooldownSec) => setForm({ ...form, cooldownSec })} />
        <label className="switch"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用这个群</label>
        <button className="primary wide" onClick={() => save(form)}>保存群设置</button>
      </div>
      <div className="panel">
        <h2>已配置群 ({sortedGroups.length})</h2>
        <div className="filterBar">
          <input placeholder="搜索群名/群号/活跃成员..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="recent">最近活跃</option>
            <option value="enabled">启用优先</option>
            <option value="name">名称排序</option>
          </select>
        </div>
        <div className="cards">
          {sortedGroups.map((group) => {
            const name = displayGroupName(group);
            const names = recentNames(group.groupId, 4);
            const memberCount = configuredMembers(group.groupId).length;
            const memoryCount = memoryMembers(group.groupId).length;
            const signal = groupSignal(group);
            const gp = groupProfiles.find((p) => String(p.groupId) === String(group.groupId));
            const showProfile = expandedProfiles[group.groupId] || false;
            const toggleProfile = () => setExpandedProfiles({ ...expandedProfiles, [group.groupId]: !showProfile });
            const editing = editingProfiles[group.groupId] || false;
            const gpDraft = gpDrafts[group.groupId] || gp;
            const setGpDraftLocal = (update) => setGpDrafts({ ...gpDrafts, [group.groupId]: typeof update === 'function' ? update(gpDraft) : update });
            const gpToggle = async (enabled) => { await api(`/api/group-profiles/${group.groupId}`, { method: 'PATCH', body: { enabled } }); refresh(); };
            const gpUpdate = async () => { await api(`/api/group-profiles/${group.groupId}/update`, { method: 'POST' }); refresh(); };
            const gpClear = async () => { if (window.confirm('确定清除群画像？')) { await api(`/api/group-profiles/${group.groupId}`, { method: 'DELETE' }); refresh(); } };
            const gpSave = async () => { await api(`/api/group-profiles/${group.groupId}`, { method: 'PATCH', body: { atmosphere: gpDraft.atmosphere, topics: gpDraft.topics, humorStyle: gpDraft.humorStyle, pace: gpDraft.pace, boundaries: gpDraft.boundaries, botStrategy: gpDraft.botStrategy } }); setEditingProfiles({ ...editingProfiles, [group.groupId]: false }); refresh(); };
            const startEdit = () => { setGpDraftLocal({ ...gp }); setEditingProfiles({ ...editingProfiles, [group.groupId]: true }); };
            return (
              <article className="item" key={group.groupId} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div>
                    <strong>{name}</strong>
                    {name !== String(group.groupId) && <span className="qq-sub">群号 {group.groupId}</span>}
                    <div className="badges">{groupTags(group).map((tag) => <span key={tag.label} className={tag.cls}>{tag.label}</span>)}</div>
                    <span>{modeLabels[group.mode] || group.mode} · 每小时 {group.maxPerHour || 0} 次 · 冷却 {group.cooldownSec || 0} 秒</span>
                    <span>已设成员 {memberCount} · 有记忆成员 {memoryCount}</span>
                    {/* Group member experience levels */}
                    {(() => {
                      const groupExp = Object.entries(db.groupExperience || {})
                        .filter(([key]) => key.startsWith(group.groupId + ':'))
                        .map(([, v]) => v)
                        .sort((a, b) => (b.xpInGroup || 0) - (a.xpInGroup || 0))
                        .slice(0, 5);
                      if (!groupExp.length) return null;
                      const levelEmojis = ['🌱', '💬', '🎯', '⭐', '👑'];
                      return (
                        <span className="signal">成员等级：{groupExp.map((ge) => {
                          const exp = (db.experience || {})[ge.userId] || {};
                          const user = db.users?.find((u) => String(u.userId) === ge.userId);
                          const name = user?.customName || user?.nickname || ge.userId;
                          return `${levelEmojis[exp.level || 0] || '🌱'}${name}`;
                        }).join(' · ')}</span>
                      );
                    })()}
                    {names.length > 0 && <span className="signal">自动辨认: 最近活跃 {names.join('、')}</span>}
                    {signal && <span className="signal">{signal}</span>}
                  </div>
                  <div className="itemActions">
                    <button onClick={() => setForm({ ...group })}>编辑</button>
                    <button onClick={() => save({ ...group, enabled: !group.enabled })}>{group.enabled ? '停用' : '启用'}</button>
                    <button onClick={() => clearContext(group)} title="只清空本群聊天记录和决策日志，不影响设置、成员策略和画像">清空上下文</button>
                  </div>
                </div>
                {gp && (
                  <div style={{ marginTop: 8, padding: '8px 0', borderTop: '1px solid #ece9df' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer' }} onClick={toggleProfile}>
                        {showProfile ? '▾' : '▸'} 群聊画像 · 置信{Math.round(gp.confidence * 100)}% · {gp.evidenceCount}条依据
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => gpToggle(!gp.enabled)} style={{ fontSize: 12, padding: '4px 8px' }}>{gp.enabled !== false ? '停用注入' : '启用注入'}</button>
                        {editing ? (
                          <>
                            <button onClick={gpSave} style={{ fontSize: 12, padding: '4px 8px' }} className="primary">保存</button>
                            <button onClick={() => setEditingProfiles({ ...editingProfiles, [group.groupId]: false })} style={{ fontSize: 12, padding: '4px 8px' }}>取消</button>
                          </>
                        ) : (
                          <>
                            <button onClick={startEdit} style={{ fontSize: 12, padding: '4px 8px' }}>手动编辑</button>
                            <button onClick={gpUpdate} style={{ fontSize: 12, padding: '4px 8px' }}>LLM更新</button>
                            <button onClick={gpClear} style={{ fontSize: 12, padding: '4px 8px' }}>清除</button>
                          </>
                        )}
                      </div>
                    </div>
                    {showProfile && (
                      editing ? (
                        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                          {['atmosphere', 'topics', 'humorStyle', 'pace', 'botStrategy', 'boundaries'].map((field) => {
                            const labels = { atmosphere: '整体氛围', topics: '常见话题', humorStyle: '玩笑方式', pace: '聊天节奏', botStrategy: '说话策略', boundaries: '注意边界' };
                            return <label key={field} className="field" style={{ marginBottom: 0 }}>
                              <span>{labels[field] || field}</span>
                              <textarea rows={2} value={gpDraft[field] || ''} onChange={(e) => setGpDraftLocal({ ...gpDraft, [field]: e.target.value })} />
                            </label>;
                          })}
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, lineHeight: 1.8, color: '#52605a' }}>
                          {gp.atmosphere && <div>氛围：{gp.atmosphere}</div>}
                          {gp.topics && <div>话题：{gp.topics}</div>}
                          {gp.humorStyle && <div>玩笑：{gp.humorStyle}</div>}
                          {gp.pace && <div>节奏：{gp.pace}</div>}
                          {gp.botStrategy && <div>策略：{gp.botStrategy}</div>}
                          {gp.boundaries && <div>边界：{gp.boundaries}</div>}
                          <div style={{ marginTop: 4, color: '#999', fontSize: 12 }}>更新于 {gp.updatedAt ? new Date(gp.updatedAt).toLocaleString('zh-CN') : '未知'}</div>
                        </div>
                      )
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {db.groups.length > 0 && !sortedGroups.length && <p className="empty">没有匹配的群。换个群号、备注或活跃成员再搜。</p>}
          {!db.groups.length && <p className="empty">还没有白名单群。先填一个内部小群的 QQ 群号。</p>}
        </div>
      </div>
    </section>
    </>
  );
}

function Persona({ db, saveSettings }) {
  const [draft, setDraft] = useState(db.settings);
  return (
    <section className="panel">
      <h2>人设与说话方式</h2>
      <Text label="机器人名字，多个名字用英文逗号分开" value={draft.botNames} onChange={(botNames) => setDraft({ ...draft, botNames })} />
      <label className="field">
        <span>人设 Prompt</span>
        <textarea value={draft.personalityPrompt} onChange={(e) => setDraft({ ...draft, personalityPrompt: e.target.value })} rows={14} />
      </label>
      <p className="hint">建议保持"像群友、少长篇、不过度解释自己是 AI"这几个约束。这里就是机器人的性格核心。</p>
      <button className="primary" onClick={() => saveSettings({ botNames: draft.botNames, personalityPrompt: draft.personalityPrompt })}>保存人设</button>
    </section>
  );
}

function Model({ db, saveSettings }) {
  const [draft, setDraft] = useState(db.settings);
  const [testingLocal, setTestingLocal] = useState(false);
  const [localSearchStatus, setLocalSearchStatus] = useState(null);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const testLocalSearch = async () => {
    setTestingLocal(true);
    setLocalSearchStatus(null);
    try {
      const data = await api('/api/search/test-local', { method: 'POST' });
      if (data.baseUrl) {
        const patch = { enableWebSearch: true, searchProvider: 'searxng', searchBaseUrl: data.baseUrl };
        setDraft((prev) => ({ ...prev, ...patch }));
        await saveSettings(patch);
        setLocalSearchStatus({ ok: true, message: '已检测到本地 SearXNG，并已保存配置。' });
      } else {
        setLocalSearchStatus({ ok: false, message: data.message || '未检测到本地搜索服务' });
      }
    } catch (e) {
      setLocalSearchStatus({ ok: false, message: `检测失败：${e.message || '网络错误'}` });
    } finally {
      setTestingLocal(false);
    }
  };
  const changeProvider = (llmProvider) => {
    const next = { ...draft, llmProvider };
    if (llmProvider === 'deepseek' && !next.apiBaseUrl) next.apiBaseUrl = 'https://api.deepseek.com';
    if (llmProvider !== 'deepseek' && next.apiBaseUrl === 'https://api.deepseek.com') next.apiBaseUrl = '';
    setDraft(next);
  };
  const modelOptions = {
    'deepseek-chat': 'DeepSeek Chat（日常聊天）',
    'deepseek-reasoner': 'DeepSeek Reasoner（更慢更会想）',
    'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    ...(String(draft.apiBaseUrl || '').includes('mimo') || draft.llmProvider === 'openai-compatible' ? {
      'mimo-v2.5-pro': 'MiMo-V2.5-Pro（多模态）',
      'mimo-v2.5': 'MiMo-V2.5',
      'mimo-v2-omni': 'MiMo-V2-Omni（视觉理解）',
      'mimo-v2-pro': 'MiMo-V2-Pro'
    } : {})
  };
  const currentModel = draft.model || 'deepseek-v4-flash';
  if (currentModel && !modelOptions[currentModel]) {
    modelOptions[currentModel] = `当前自定义：${currentModel}`;
  }
  return (
    <section className="grid two">
      <div className="panel">
        <h2>LLM 接口设置</h2>
        <Select label="接口供应商" value={draft.llmProvider || 'deepseek'} onChange={changeProvider} options={{
          'deepseek': 'DeepSeek（默认）',
          'openai-compatible': 'OpenAI 兼容接口'
        }} />
        <Password label="API Key" value={draft.apiKey} onChange={(apiKey) => setDraft({ ...draft, apiKey })} />
        <Text label="API 地址" value={draft.apiBaseUrl} onChange={(apiBaseUrl) => setDraft({ ...draft, apiBaseUrl })} />
        <Select label="模型" value={currentModel} onChange={(model) => setDraft({ ...draft, model })} options={modelOptions} />
        <Text label="自定义模型名，留空则使用上面的选择" value={draft.customModel || ''} onChange={(customModel) => setDraft({ ...draft, customModel })} />
        <Select label="视觉能力" value={draft.visionMode || 'auto'} onChange={(visionMode) => setDraft({ ...draft, visionMode })} options={{
          'auto': '自动识别（推荐）',
          'on': '按多模态模型处理',
          'off': '按纯文字模型处理'
        }} />
        <Select label="图片传输方式" value={draft.visionImageTransport || 'auto'} onChange={(visionImageTransport) => setDraft({ ...draft, visionImageTransport })} options={{
          'auto': '自动（本地转data，公网走URL）',
          'url': '只传URL',
          'data': '转成data URL'
        }} />
        <Slider label="单次最多传入图片数" min={1} max={6} value={draft.visionMaxImages || 3} onChange={(visionMaxImages) => setDraft({ ...draft, visionMaxImages })} />
        <p className="hint">DeepSeek 官方接口会强制按纯文字处理。Mimo 等 OpenAI 兼容多模态接口可传图片；本地/内网图片会自动转成 data URL。</p>
        <Slider label="创造性" min={0} max={1.5} step={0.05} value={draft.temperature} onChange={(temperature) => setDraft({ ...draft, temperature })} />
        <Slider label="单次回复长度" min={80} max={1200} step={20} value={draft.maxTokens} onChange={(maxTokens) => setDraft({ ...draft, maxTokens })} />
        <Slider label="带入最近消息数" min={5} max={80} value={draft.contextLimit} onChange={(contextLimit) => setDraft({ ...draft, contextLimit })} />
        <Slider label="Owner 私聊上下文软上限字符" min={4000} max={60000} step={1000} value={draft.ownerPrivateContextCharBudget || 24000} onChange={(ownerPrivateContextCharBudget) => setDraft({ ...draft, ownerPrivateContextCharBudget })} />
        <label className="switch">
          <input type="checkbox" checked={draft.enableWebSearch === true} onChange={(e) => setDraft({ ...draft, enableWebSearch: e.target.checked })} /> 启用联网搜索（模型自动判断是否搜索）
        </label>
        {draft.enableWebSearch === true && (
          <>
            <div style={{ marginBottom: 12 }}>
              <button onClick={testLocalSearch} disabled={testingLocal} style={{ marginRight: 10 }}>
                {testingLocal ? '检测中…' : '检测本地搜索服务'}
              </button>
              {localSearchStatus && (
                <span style={{ fontSize: 13, color: localSearchStatus.ok ? '#4caf50' : '#c09853' }}>
                  {localSearchStatus.message}
                </span>
              )}
            </div>
            <Select label="搜索模式" value={draft.webSearchMode || 'balanced'} onChange={(webSearchMode) => setDraft({ ...draft, webSearchMode })} options={{
              'fast': '快速（更快但可能不全）',
              'balanced': '平衡（推荐）',
              'deep': '深度（更全面但稍慢）'
            }} />
            <details open={showAdvancedSearch} onToggle={(e) => setShowAdvancedSearch(e.target.open)} style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: '#888', userSelect: 'none' }}>高级设置</summary>
              <div style={{ marginTop: 8 }}>
                <Select label="真实搜索源" value={draft.searchProvider || 'disabled'} onChange={(searchProvider) => setDraft({ ...draft, searchProvider })} options={{
                  'disabled': '未接入（关闭）',
                  'searxng': 'SearXNG'
                }} />
                {draft.searchProvider === 'searxng' && (
                  <Text label="SearXNG 地址" value={draft.searchBaseUrl || ''} onChange={(searchBaseUrl) => setDraft({ ...draft, searchBaseUrl })} />
                )}
              </div>
            </details>
          </>
        )}
        <label className="switch">
          <input type="checkbox" checked={draft.enableAutoModel !== false} onChange={(e) => setDraft({ ...draft, enableAutoModel: e.target.checked })} /> 自动选择模型（复杂任务自动升级到 V4 Pro）
        </label>
        <Select label="思考状态提示" value={draft.thinkingNoticeMode || 'slow'} onChange={(thinkingNoticeMode) => setDraft({ ...draft, thinkingNoticeMode })} options={{
          'off': '关闭',
          'simple': '简短：正在思考…',
          'detail': '详细：深度思考中（模型名）',
          'slow': '仅慢请求显示（默认3秒延迟）'
        }} />
        {draft.thinkingNoticeMode === 'slow' && (
          <Text label="慢请求延迟（毫秒）" value={String(draft.thinkingNoticeDelayMs || 3000)} onChange={(v) => setDraft({ ...draft, thinkingNoticeDelayMs: Math.max(500, Number(v) || 3000) })} />
        )}
        <label className="switch">
          <input type="checkbox" checked={draft.ignoreSystemFacts === true} onChange={(e) => setDraft({ ...draft, ignoreSystemFacts: e.target.checked })} /> 纯人设模式
        </label>
        <label className="switch">
          <input type="checkbox" checked={draft.profileAntiRecencyV2 === true} onChange={(e) => setDraft({ ...draft, profileAntiRecencyV2: e.target.checked })} /> 画像V2防近因（长期画像/近期动态分层，实验性）
        </label>
        <label className="switch">
          <input type="checkbox" checked={draft.levelUpNotifyEnabled !== false} onChange={(e) => setDraft({ ...draft, levelUpNotifyEnabled: e.target.checked })} /> 升级恭喜通知（群内自动祝贺）
        </label>
        <button className="primary" onClick={() => saveSettings({ ...draft, model: draft.customModel?.trim() || draft.model, customModel: '' })}>保存模型设置</button>
      </div>
      <div className="panel">
        <h2>怎么选</h2>
        <p className="guide">默认供应商是 DeepSeek；如果以后接别家的 OpenAI 兼容 API，就切到兼容接口，填它自己的 API 地址和模型名。</p>
        <p className="guide">创造性越高越活泼，越低越稳。小群聊天可以从 0.85 开始。</p>
        <p className="guide">DeepSeek 官方 Chat API 没有内置搜索；点击"检测本地搜索服务"一键配置 SearXNG，或手动在高级设置中填写搜索源地址。未检测到真实搜索服务时，显式搜索请求会被拒绝，不会假装联网。</p>
      </div>
    </section>
  );
}

function Members({ db, refresh }) {
  const firstGroup = db.groups[0]?.groupId || '';
  const groupMap = Object.fromEntries((db.groups || []).map((g) => [String(g.groupId), g.name || g.groupId]));
  const roleOptions = Object.fromEntries((db.settings.commandRoles || []).map((role) => [role.id, role.name + ' Lv.' + role.level]));
  const memories = db.memories || [];
  const trustScores = db.trustScores || {};
  const experience = db.experience || {};
  const messages = db.messages || [];
  const [form, setForm] = useState({ groupId: firstGroup, userId: '', nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, commandRoleId: '', note: '', customPrompt: '' });
  const [search, setSearch] = useState('');
  const [filterPolicy, setFilterPolicy] = useState('all');
  const [filterGroup, setFilterGroup] = useState('all');
  const [sortBy, setSortBy] = useState('recent');
  const save = async () => {
    await api('/api/users', { method: 'POST', body: form });
    setForm({ ...form, userId: '', nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, commandRoleId: '', note: '', customPrompt: '' });
    refresh();
  };
  const removePolicy = async (user) => {
    const ok = window.confirm('删除 ' + (user.nickname || user.userId) + ' 的成员策略？删除后会按普通用户处理。');
    if (!ok) return;
    await api(`/api/users/${user.groupId}/${user.userId}`, { method: 'DELETE' });
    refresh();
  };

  // Display name helper: prefer nickname (if meaningful), else latest message name, else memory name, else QQ
  const displayName = (user) => {
    if (user.nickname && user.nickname !== user.userId) return user.nickname;
    const msgs = messages.filter((m) => String(m.userId) === String(user.userId) && m.nickname && m.nickname !== String(user.userId));
    if (msgs.length > 0) return msgs[msgs.length - 1].nickname;
    const mem = memories.find((m) => String(m.userId) === String(user.userId) && m.nickname && m.nickname !== String(user.userId));
    if (mem) return mem.nickname;
    return user.userId;
  };

  // Recent signal helper
  const recentSignal = (user) => {
    const msgs = messages.filter((m) => String(m.userId) === String(user.userId)).slice(-1);
    const mem = memories.find((m) => String(m.userId) === String(user.userId));
    const parts = [];
    if (msgs.length) {
      const m = msgs[0];
      parts.push('最后活跃: ' + groupMap[String(m.groupId)] + ' ' + new Date(m.createdAt).toLocaleDateString('zh-CN'));
    } else if (mem?.lastProfiledAt) {
      parts.push('最后画像: ' + new Date(mem.lastProfiledAt).toLocaleDateString('zh-CN'));
    }
    if (mem?.summary) parts.push('记忆: ' + mem.summary.slice(0, 30));
    return parts.join(' · ');
  };

  // Badge helper
  const badges = (user) => {
    const tags = [];
    if (user.policy === 'admin') tags.push({ label: '管理', cls: 'badge-admin' });
    if (user.policy === 'blocked') tags.push({ label: '黑名单', cls: 'badge-blocked' });
    if (user.policy === 'priority') tags.push({ label: '重点关注', cls: 'badge-priority' });
    if (user.allowCommands) tags.push({ label: '指令', cls: 'badge-cmd' });
    if (user.note) tags.push({ label: '备注', cls: 'badge-note' });
    if (user.customPrompt) tags.push({ label: '定制', cls: 'badge-custom' });
    if (memories.some((m) => String(m.userId) === String(user.userId) && m.enabled !== false && (m.summary || m.traits))) {
      tags.push({ label: '记忆', cls: 'badge-memory' });
    }
    const exp = experience[String(user.userId)];
    if (exp) {
      const levelEmojis = ['🌱', '💬', '🎯', '⭐', '👑'];
      const levelNames = ['新人', '群友', '活跃群友', '老熟人', '核心群友'];
      const lv = exp.level || 0;
      tags.push({ label: `${levelEmojis[lv] || '🌱'} Lv.${lv} ${levelNames[lv] || ''}`, cls: lv >= 3 ? 'badge-priority' : lv >= 1 ? 'badge-cmd' : '' });
    }
    return tags;
  };

  // Filtering and sorting
  let users = db.users.filter((u) => {
    if (filterGroup !== 'all' && String(u.groupId) !== filterGroup) return false;
    if (filterPolicy !== 'all' && u.policy !== filterPolicy) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = displayName(u).toLowerCase();
      const qq = String(u.userId);
      const note = (u.note || '').toLowerCase();
      if (!name.includes(q) && !qq.includes(q) && !note.includes(q)) return false;
    }
    return true;
  });
  if (sortBy === 'recent') {
    users = users.sort((a, b) => {
      const aMsgs = messages.filter((m) => String(m.userId) === String(a.userId));
      const bMsgs = messages.filter((m) => String(m.userId) === String(b.userId));
      const aLast = aMsgs.length ? new Date(aMsgs[aMsgs.length - 1].createdAt).getTime() : 0;
      const bLast = bMsgs.length ? new Date(bMsgs[bMsgs.length - 1].createdAt).getTime() : 0;
      return bLast - aLast;
    });
  } else if (sortBy === 'policy') {
    const order = { blocked: 0, muted: 1, normal: 2, whitelist: 3, priority: 4, admin: 5 };
    users = users.sort((a, b) => (order[b.policy] || 0) - (order[a.policy] || 0));
  } else if (sortBy === 'level') {
    users = users.sort((a, b) => (b.attentionLevel || 3) - (a.attentionLevel || 3));
  }

  const groupOptions = { 'all': '全部群' };
  for (const g of (db.groups || [])) groupOptions[String(g.groupId)] = g.name || g.groupId;

  return (
    <section className="grid two">
      <div className="panel">
        <h2>成员策略</h2>
        <Text label="群号" value={form.groupId} onChange={(groupId) => setForm({ ...form, groupId })} />
        <Text label="用户 QQ号" value={form.userId} onChange={(userId) => setForm({ ...form, userId })} />
        <Text label="备注昵称" value={form.nickname} onChange={(nickname) => setForm({ ...form, nickname })} />
        <Select label="机器人如何对待他" value={form.policy} onChange={(policy) => setForm({ ...form, policy })} options={policyLabels} />
        <Slider label="注意力等级" min={1} max={5} value={form.attentionLevel} onChange={(attentionLevel) => setForm({ ...form, attentionLevel })} />
        <label className="switch"><input type="checkbox" checked={form.allowCommands} onChange={(e) => setForm({ ...form, allowCommands: e.target.checked })} /> 允许管理指令</label>
        <Select label="指令用户组" value={form.commandRoleId || ''} onChange={(commandRoleId) => setForm({ ...form, commandRoleId })} options={{ '': '自动（按成员策略）', ...roleOptions }} />
        <Text label="备注" value={form.note} onChange={(note) => setForm({ ...form, note })} />
        <label className="field">
          <span>定制提示词（可选，机器人对该成员的特别态度）</span>
          <textarea value={form.customPrompt || ''} onChange={(e) => setForm({ ...form, customPrompt: e.target.value })} rows={4} placeholder="例如：对这个群友可以更随意一些，偶尔开开玩笑。" />
        </label>
        <button className="primary wide" onClick={save}>保存成员策略</button>
      </div>
      <div className="panel">
        <h2>已设置成员 ({users.length})</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input placeholder="搜索昵称/QQ/备注..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
          <select value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>{Object.entries(groupOptions).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={filterPolicy} onChange={(e) => setFilterPolicy(e.target.value)}>
            <option value="all">全部策略</option>
            {Object.entries(policyLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="recent">最近活跃</option>
            <option value="policy">策略优先级</option>
            <option value="level">注意力等级</option>
          </select>
        </div>
        <div className="cards">
          {users.map((user) => {
            const name = displayName(user);
            const tags = badges(user);
            const signal = recentSignal(user);
            const roleName = user.commandRoleId && (db.settings.commandRoles || []).find((r) => r.id === user.commandRoleId);
            return (
              <article className="item" key={`${user.groupId}-${user.userId}`}>
                <div>
                  <strong>{name}</strong>
                  {name !== String(user.userId) && <span className="qq-sub">QQ {user.userId}</span>}
                  <div className="badges">{tags.map((t) => <span key={t.label} className={t.cls}>{t.label}</span>)}</div>
                  <span>{groupMap[String(user.groupId)] || user.groupId} · {policyLabels[user.policy]}{roleName ? ' · ' + roleName.name : ''} · 注意力 {user.attentionLevel}{user.note ? ' · 备注: ' + user.note : ''}</span>
                  {signal && <span className="signal">{signal}</span>}
                </div>
                <div className="itemActions">
                  <button onClick={() => setForm(user)}>编辑</button>
                  <button onClick={() => removePolicy(user)}>删除策略</button>
                </div>
              </article>
            );
          })}
          {!db.users.length && <p className="empty">还没有成员策略。普通群友会按群默认模式处理。</p>}
        </div>
      </div>
    </section>
  );
}

function Memory({ db, saveSettings, refresh }) {
  const [memSearch, setMemSearch] = useState('');
  const memories = [...(db.memories || [])].filter((m) => {
    if (!memSearch.trim()) return true;
    const q = memSearch.trim().toLowerCase();
    return (m.nickname || '').toLowerCase().includes(q) || String(m.userId).includes(q) || (m.summary || '').toLowerCase().includes(q) || (m.traits || '').toLowerCase().includes(q) || (m.manualNotes || '').toLowerCase().includes(q);
  }).sort((a, b) =>
    Number(b.importanceLevel || 0) - Number(a.importanceLevel || 0) ||
    Number(b.messageCount || 0) - Number(a.messageCount || 0)
  );
  const [selectedId, setSelectedId] = useState(memories[0]?.userId || '');
  const selected = memories.find((memory) => String(memory.userId) === String(selectedId)) || memories[0];
  const [draft, setDraft] = useState(selected || {});
  const [settingsDraft, setSettingsDraft] = useState(db.settings);
  const [profileDirty, setProfileDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);

  useEffect(() => {
    if (profileDirty) return;
    const next = memories.find((memory) => String(memory.userId) === String(selectedId)) || memories[0] || {};
    setDraft(next);
  }, [db.memories, selectedId, profileDirty]);

  useEffect(() => {
    if (settingsDirty) return;
    setSettingsDraft(db.settings);
  }, [db.settings, settingsDirty]);

  const updateDraft = (patch) => {
    setProfileDirty(true);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const updateSettingsDraft = (patch) => {
    setSettingsDirty(true);
    setSettingsDraft((current) => ({ ...current, ...patch }));
  };

  const saveMemory = async () => {
    if (!draft.userId) return;
    await api(`/api/memories/${draft.userId}`, { method: 'POST', body: draft });
    setProfileDirty(false);
    refresh();
  };

  const deleteMemory = async () => {
    if (!draft.userId) return;
    const ok = window.confirm('删除 ' + (draft.nickname || draft.userId) + ' 的长期记忆？');
    if (!ok) return;
    await api(`/api/memories/${draft.userId}`, { method: 'DELETE' });
    setSelectedId('');
    setProfileDirty(false);
    refresh();
  };

  const saveMemorySettings = async () => {
    await saveSettings({
      memoryEnabled: settingsDraft.memoryEnabled !== false,
      memoryMinMessages: settingsDraft.memoryMinMessages,
      memoryUpdateEvery: settingsDraft.memoryUpdateEvery,
      memoryMaxChars: settingsDraft.memoryMaxChars,
      memorySampleRetain: settingsDraft.memorySampleRetain,
      visionMemoryEnabled: settingsDraft.visionMemoryEnabled !== false,
      visionMemoryPureImagePolicy: settingsDraft.visionMemoryPureImagePolicy || 'important'
    });
    setSettingsDirty(false);
    refresh();
  };

  return (
    <section className="grid two">
      <div className="panel">
        <h2>长期记忆设置</h2>
        <label className="switch">
          <input type="checkbox" checked={settingsDraft.memoryEnabled !== false} onChange={(e) => updateSettingsDraft({ memoryEnabled: e.target.checked })} />
          启用长期记忆
        </label>
        <Slider label="开始画像所需消息数" min={3} max={40} value={settingsDraft.memoryMinMessages || 8} onChange={(memoryMinMessages) => updateSettingsDraft({ memoryMinMessages })} />
        <Slider label="每隔多少条更新画像" min={3} max={40} value={settingsDraft.memoryUpdateEvery || 8} onChange={(memoryUpdateEvery) => updateSettingsDraft({ memoryUpdateEvery })} />
        <Slider label="每人保留样本数" min={30} max={300} step={10} value={settingsDraft.memorySampleRetain || 120} onChange={(memorySampleRetain) => updateSettingsDraft({ memorySampleRetain })} />
        <Slider label="注入提示词最大字数" min={200} max={1600} step={100} value={settingsDraft.memoryMaxChars || 900} onChange={(memoryMaxChars) => updateSettingsDraft({ memoryMaxChars })} />
        <label className="switch">
          <input type="checkbox" checked={settingsDraft.visionMemoryEnabled !== false} onChange={(e) => updateSettingsDraft({ visionMemoryEnabled: e.target.checked })} />
          图片摘要进入长期记忆（仅多模态模型）
        </label>
        <Select label="无配文图片摘要" value={settingsDraft.visionMemoryPureImagePolicy || 'important'} onChange={(visionMemoryPureImagePolicy) => updateSettingsDraft({ visionMemoryPureImagePolicy })} options={{
          'important': '只处理重点/信任/管理员',
          'all': '所有人都处理',
          'off': '不处理'
        }} />
        <button className="primary wide" onClick={saveMemorySettings}>保存记忆设置</button>
        <p className="hint">Owner 不做自动画像。管理员、重点关注、白名单会更快沉淀记忆；普通群友会慢一些。</p>
        <h2 className="sectionTitle">已记录对象 ({memories.length})</h2>
        <input placeholder="搜索昵称/QQ/画像关键词..." value={memSearch} onChange={(e) => setMemSearch(e.target.value)} style={{ marginBottom: 10 }} />
        <div className="cards memoryCards">
          {memories.map((memory) => (
            <button
              className={`memoryCard ${String(selected?.userId) === String(memory.userId) ? 'selected' : ''}`}
              key={memory.userId}
              onClick={() => {
                setProfileDirty(false);
                setSelectedId(memory.userId);
              }}
            >
              <strong>{memory.nickname || memory.userId}</strong>
              <span>{memory.userId} | Lv.{memory.importanceLevel || 0} | {memory.messageCount || 0} 条消息</span>
            </button>
          ))}
          {!memories.length && <p className="empty">还没有长期记忆。有人多聊几句后会自动出现。</p>}
        </div>
      </div>
      <div className="panel">
        <h2>画像编辑</h2>
        {!draft.userId ? (
          <p className="empty">先在左侧选择一个对象。</p>
        ) : (
          <>
            <Row label="QQ号" value={draft.userId} />
            <Row label="出现过的群" value={(draft.groupsSeen || []).join(', ') || '暂无'} />
            <Row label="画像文本样本" value={draft.profileMessageCount || 0} />
            <Row label="最近画像尝试" value={draft.lastProfileAttemptAt ? `${new Date(draft.lastProfileAttemptAt).toLocaleString()} · ${draft.lastProfileStatus || 'unknown'}` : '尚未尝试'} />
            {draft.lastProfileError && <Row label="画像生成状态" value={draft.lastProfileError} />}
            <Row label="最近画像时间" value={draft.lastProfiledAt ? new Date(draft.lastProfiledAt).toLocaleString() : '尚未自动画像'} />
            <Text label="昵称" value={draft.nickname} onChange={(nickname) => updateDraft({ nickname })} />
            <label className="switch">
              <input type="checkbox" checked={draft.enabled !== false} onChange={(e) => updateDraft({ enabled: e.target.checked })} />
              启用这个人的长期记忆
            </label>
            <Textarea label="整体印象" rows={3} value={draft.summary} onChange={(summary) => updateDraft({ summary })} />
            <Textarea label="性格/倾向" rows={3} value={draft.traits} onChange={(traits) => updateDraft({ traits })} />
            <Textarea label="说话风格" rows={3} value={draft.speechStyle} onChange={(speechStyle) => updateDraft({ speechStyle })} />
            <Textarea label="互动习惯" rows={3} value={draft.behavior} onChange={(behavior) => updateDraft({ behavior })} />
            <Textarea label="偏好/雷点" rows={3} value={draft.preferences} onChange={(preferences) => updateDraft({ preferences })} />
            <Textarea label="人工备注" rows={4} value={draft.manualNotes} onChange={(manualNotes) => updateDraft({ manualNotes })} />
            {draft.recentDynamics && draft.recentDynamics.length > 0 && (
              <>
                <h2 className="sectionTitle">近期动态</h2>
                <div className="cards">
                  {(draft.recentDynamics || []).slice(-5).reverse().map((rd, i) => (
                    <div className="item" key={i} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <strong>{rd.topic}</strong>
                      <span style={{ fontSize: 12, color: '#8ca19c' }}>{rd.summary} · 置信{Math.round((rd.confidence || 0) * 100)}% · {rd.evidenceCount}条 · {rd.firstSeenAt ? new Date(rd.firstSeenAt).toLocaleDateString('zh-CN') : '?'}~{rd.lastSeenAt ? new Date(rd.lastSeenAt).toLocaleDateString('zh-CN') : '?'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {draft.profileMeta && Object.keys(draft.profileMeta).length > 0 && (
              <div className="confidenceBar">
                {Object.entries(draft.profileMeta).filter(([, v]) => v.confidence > 0 || v.evidenceCount > 0).map(([field, meta]) => {
                  const labels = { traits: '性格', speechStyle: '说话', behavior: '互动', preferences: '偏好' };
                  const pct = Math.round((meta.confidence || 0) * 100);
                  const color = pct >= 70 ? '#4ade80' : pct >= 40 ? '#facc15' : '#f87171';
                  return <span key={field} title={`${labels[field] || field}: 置信度${pct}% · ${meta.evidenceCount || 0}条依据 · 更新于${meta.updatedAt ? new Date(meta.updatedAt).toLocaleDateString('zh-CN') : '未知'}`}>{labels[field] || field} <strong style={{ color }}>{pct}%</strong></span>;
                })}
              </div>
            )}
            <h2 className="sectionTitle">最近样本</h2>
            <div className="sampleList">
              {((draft.samples || []).slice(-10).reverse()).map((sample, index) => (
                <article className="sampleItem" key={`${sample.createdAt || index}-${index}`}>
                  <div className="sampleMeta">
                    <span className={`sampleType sampleType-${sample.type || 'text'}`}>{sampleTypeLabels[sample.type || 'text'] || sample.type || 'text'}</span>
                    {sample.riskLevel === 'high-risk' && <span className="badge-blocked" style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10 }}>高风险已降级</span>}
                    {sample.riskLevel === 'low-confidence' && <span className="badge-note" style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10 }}>低置信</span>}
                    <span>{sample.usedForProfile === false ? (sample.reason || '未进入画像') : '用于画像'}</span>
                    <span>{sample.createdAt ? new Date(sample.createdAt).toLocaleString() : ''}</span>
                  </div>
                  <p>{sample.content || '(empty)'}</p>
                  {sample.context && sample.context.nearby && sample.context.nearby.length > 0 ? (
                    <p className="contextHint">语境：{sample.context.nearby.slice(-2).map((m) => (m.nickname || m.userId) + '：' + m.content.slice(0, 40)).join(' → ')}</p>
                  ) : (
                    <p className="contextHint" style={{ color: '#c4b89a', borderLeftColor: '#e8dcc8' }}>旧版样本，无上下文记录</p>
                  )}
                </article>
              ))}
              {!(draft.samples || []).length && <p className="empty">还没有样本。</p>}
            </div>
            <div className="actions inlineActions">
              <button className="primary" onClick={saveMemory}>保存画像</button>
              <button onClick={deleteMemory}>删除记忆</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Permissions({ db, saveSettings, refresh }) {
  const [roles, setRoles] = useState(db.settings.commandRoles || []);
  const [permissions, setPermissions] = useState(db.settings.commandPermissions || {});
  const [permSearch, setPermSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  const sortedRoles = [...roles].sort((a, b) => Number(a.level) - Number(b.level));
  const roleOptions = Object.fromEntries(sortedRoles.map((role) => [role.id, role.name + ' Lv.' + role.level]));

  useEffect(() => {
    if (dirty) return;
    setRoles(db.settings.commandRoles || []);
    setPermissions(db.settings.commandPermissions || {});
  }, [db.settings.commandRoles, db.settings.commandPermissions, dirty]);

  const updateRole = (id, patch) => {
    setDirty(true);
    setRoles((current) => current.map((role) => role.id === id ? { ...role, ...patch } : role));
  };

  const addRole = () => {
    const id = `role_${Date.now()}`;
    setDirty(true);
    setRoles((current) => [...current, { id, name: 'New Role', level: 40, locked: false }]);
  };

  const removeRole = (id) => {
    const role = roles.find((item) => item.id === id);
    if (!role || role.locked) return;
    const ok = window.confirm('删除用户组"' + role.name + '"？已使用这个组的指令会改成普通群员。');
    if (!ok) return;
    setDirty(true);
    setRoles((current) => current.filter((item) => item.id !== id));
    setPermissions((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value === id ? 'guest' : value])));
  };

  const updatePermission = (key, value) => {
    setDirty(true);
    setPermissions((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    const cleanRoles = roles.map((role) => ({
      id: role.id,
      name: String(role.name || role.id).trim() || role.id,
      level: Math.max(0, Math.min(100, Number(role.level || 0))),
      locked: Boolean(role.locked)
    }));
    await saveSettings({ commandRoles: cleanRoles, commandPermissions: permissions });
    setDirty(false);
    refresh();
  };

  return (
    <section className="grid two">
      <div className="panel">
        <h2>指令用户组</h2>
        <p className="hint">等级越高权限越大。Owner 永远拥有全部权限，即使这里配置错了也不会锁死自己。</p>
        <div className="cards">
          {sortedRoles.map((role) => (
            <article className="roleEditor" key={role.id}>
              <Text label="用户组名称" value={role.name} onChange={(name) => updateRole(role.id, { name })} />
              <Slider label="权限等级" min={0} max={100} value={role.level} onChange={(level) => updateRole(role.id, { level })} />
              <div className="itemActions">
                <span className="pill">{role.locked ? '基础组' : role.id}</span>
                {!role.locked && <button onClick={() => removeRole(role.id)}>删除用户组</button>}
              </div>
            </article>
          ))}
        </div>
        <div className="actions inlineActions">
          <button onClick={addRole}>添加用户组</button>
          <button className="primary" onClick={save}>保存权限设置</button>
        </div>
      </div>
      <div className="panel">
        <h2>指令权限</h2>
        <p className="hint">每条指令选择"最低需要哪个用户组"。例如把 ping 设为普通群员，所有人都能用；把 usage 设为管理员，普通人就看不到用量。</p>
        <input placeholder="搜索指令..." value={permSearch} onChange={(e) => setPermSearch(e.target.value)} style={{ marginBottom: 10 }} />
        <div className="permissionList">
          {Object.entries(commandLabels).filter(([key, label]) => !permSearch.trim() || label.includes(permSearch.trim()) || key.includes(permSearch.trim().toLowerCase())).map(([key, label]) => (
            <label className="permissionRow" key={key}>
              <span>{label}</span>
              <select value={permissions[key] || 'owner'} onChange={(e) => updatePermission(key, e.target.value)}>
                {Object.entries(roleOptions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}

function Connect({ db, oneBot, saveSettings, refresh }) {
  const [draft, setDraft] = useState(db.settings);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null);
  const connect = async () => {
    await saveSettings(draft);
    await api('/api/onebot/connect', { method: 'POST' });
    refresh();
  };
  const autoDetect = async () => {
    setDetecting(true);
    setDetectResult(null);
    try {
      const data = await api('/api/onebot/autodetect');
      setDetectResult(data);
      if (data.detected) {
        setDraft({ ...draft, oneBotHttpUrl: data.detected.httpUrl, oneBotWsUrl: data.detected.wsUrl });
      }
    } catch {
      setDetectResult({ results: [], detected: null });
    } finally {
      setDetecting(false);
    }
  };
  const friendlyError = oneBot.lastError?.includes('ECONNREFUSED')
    ? '没有连上 OneBot WebSocket。通常是 NapCat/Lagrange 还没启动，或没有开启 WebSocket 服务端，或端口填错了。'
    : oneBot.lastError || '无';
  return (
    <section className="grid two">
      <div className="panel">
        <h2>NapCat / OneBot 连接</h2>
        <p className="hint">先启动 NapCat 并扫码登录 QQ 小号，然后点"自动检测"自动填入地址。如果检测不到，再看下面手动教程填。</p>
        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          <button className="primary" onClick={autoDetect} disabled={detecting}>
            {detecting ? '检测中...' : '自动检测'}
          </button>
          {detectResult?.detected && <span style={{ color: '#4ade80', fontSize: 14 }}>已检测到端口 {detectResult.detected.bestPort}</span>}
          {detectResult && !detectResult.detected && <span style={{ color: '#f87171', fontSize: 14 }}>未检测到 NapCat，请确认已启动</span>}
        </div>
        <Text label="OneBot HTTP 地址" value={draft.oneBotHttpUrl} onChange={(oneBotHttpUrl) => setDraft({ ...draft, oneBotHttpUrl })} />
        <Text label="OneBot WebSocket 地址" value={draft.oneBotWsUrl} onChange={(oneBotWsUrl) => setDraft({ ...draft, oneBotWsUrl })} />
        <Password label="Access Token，没有就留空" value={draft.oneBotAccessToken} onChange={(oneBotAccessToken) => setDraft({ ...draft, oneBotAccessToken })} />
        <Text label="机器人自己的 QQ号" value={draft.selfQq} onChange={(selfQq) => setDraft({ ...draft, selfQq })} />
        <Text label="你的 QQ号（Owner）" value={draft.ownerQq} onChange={(ownerQq) => setDraft({ ...draft, ownerQq })} />
        <button className="primary" onClick={connect}>保存并连接 QQ</button>
      </div>
      <div className="panel">
        <h2>连接状态</h2>
        <Row label="状态" value={oneBot.connected ? '已连接' : '未连接'} />
        <Row label="最近事件" value={oneBot.lastEventAt || '暂无'} />
        <Row label="错误" value={friendlyError} />
        <p className="guide">NapCat 或 Lagrange 开启 OneBot 后，把 HTTP 和 WebSocket 地址填到这里。</p>
        <div className="steps">
          <strong>NapCat 新手指南</strong>
          <p>1. 下载 NapCat（推荐 Windows 一键包），解压后启动。</p>
          <p>2. NapCat 会弹出二维码，用机器人的 QQ 小号扫码登录。</p>
          <p>3. 登录成功后，点本页的"自动检测"按钮，地址会自动填入。</p>
          <p>4. 如果检测不到，可能是端口换了。打开 NapCat WebUI（默认 http://127.0.0.1:6099/webui），在网络配置里查看 HTTP 和 WebSocket 的实际端口。</p>
        </div>
      </div>
    </section>
  );
}

function Logs({ db }) {
  const [logSearch, setLogSearch] = useState('');
  const filterLogs = (items) => {
    if (!logSearch.trim()) return items;
    const q = logSearch.trim().toLowerCase();
    return items.filter((item) => {
      const content = (item.content || item.reason || item.rawText || '').toLowerCase();
      const nickname = (item.nickname || item.userId || '').toLowerCase();
      return content.includes(q) || nickname.includes(q) || String(item.userId || '').includes(q);
    });
  };
  const messages = filterLogs([...db.messages].reverse()).slice(0, 80);
  const decisions = filterLogs([...db.decisions].reverse()).slice(0, 80);
  const commandLogs = filterLogs([...(db.commandLogs || [])].reverse()).slice(0, 100);
  const commandStatusLabels = {
    ok: '执行成功',
    denied: '权限拒绝',
    error: '执行失败',
    invalid: '参数有误',
    ignored: '已忽略'
  };
  const downloadDiagnostics = () => {
    window.location.href = '/api/diagnostics';
  };
  const clearAllContext = async () => {
    const ok = window.confirm('清空所有群的聊天上下文、决策日志和指令日志？这不会删除人设、模型、群配置和成员策略。');
    if (!ok) return;
    await api('/api/clear-context', { method: 'POST' });
    window.location.reload();
  };
  return (
    <>
      <section className="panel actions">
        <button className="primary" onClick={downloadDiagnostics}>导出诊断日志</button>
        <button onClick={clearAllContext}>清空全部上下文</button>
        <input placeholder="搜索消息/指令/昵称/QQ..." value={logSearch} onChange={(e) => setLogSearch(e.target.value)} style={{ width: '100%' }} />
        <p className="hint">遇到问题时点这里，会导出一个 JSON 文件。里面不会导出 API Key 明文，可以发给我分析。</p>
      </section>
      <section className="grid three">
        <div className="panel">
          <h2>聊天日志</h2>
          <div className="loglist">
            {messages.map((message) => (
              <div className={`log ${message.role}`} key={message.id}>
                <strong>{message.nickname || message.userId}</strong>
                <span>{message.groupId} | {new Date(message.createdAt).toLocaleString()} | {message.inContext === false ? '不进上下文' : '进入上下文'}</span>
                <p>{message.content}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>为什么回 / 为什么没回</h2>
          <div className="loglist">
            {decisions.map((decision) => (
              <div className="log" key={decision.id}>
                <strong>{decision.shouldReply ? '决定回复' : '保持沉默'}</strong>
                <span>{decision.groupId} · {decision.userId || '未知用户'} | {new Date(decision.createdAt).toLocaleString()}</span>
                <p>{decision.reason}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>指令与错误</h2>
          <div className="loglist">
            {commandLogs.map((log) => (
              <div className={`log command ${log.status || ''}`} key={log.id}>
                <strong>{commandStatusLabels[log.status] || log.status || '指令记录'} · {log.command || '未知指令'} {log.subCommand || ''}</strong>
                <span>{log.groupId} · {log.nickname || log.userId} · {log.userRoleId || 'guest'} | {new Date(log.createdAt).toLocaleString()} · {log.latencyMs || 0}ms</span>
                <p>{log.reason || log.errorMessage || log.rawText}</p>
                {log.errorMessage && <p className="errorText">{log.errorName || '错误'}：{log.errorMessage}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function Sandbox({ db }) {
  const groups = db.groups || [];
  const users = db.users || [];
  const [groupId, setGroupId] = useState(groups[0]?.groupId || '');
  const [userId, setUserId] = useState('');
  const [nickname, setNickname] = useState('');
  const [text, setText] = useState('小深，你觉得今天适合聊点什么？');
  const [atBot, setAtBot] = useState(false);
  const [memberPolicy, setMemberPolicy] = useState('');
  const [groupMode, setGroupMode] = useState('');
  const [useMemory, setUseMemory] = useState(true);
  const [useGroupProfile, setUseGroupProfile] = useState(true);
  const [useRelationship, setUseRelationship] = useState(true);
  const [callLlm, setCallLlm] = useState(false);
  const [result, setResult] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [running, setRunning] = useState(false);

  // Auto-fill nickname when user selected
  useEffect(() => {
    const u = users.find((u) => String(u.userId) === userId);
    if (u && u.nickname && u.nickname !== u.userId) setNickname(u.nickname);
  }, [userId, users]);

  // Collect all users from configured policies + message history for this group
  const groupUserMap = {};
  for (const u of users) { if (String(u.groupId) === String(groupId)) groupUserMap[u.userId] = u; }
  for (const m of (db.messages || [])) {
    if (String(m.groupId) === String(groupId) && m.role === 'user') {
      if (!groupUserMap[m.userId]) groupUserMap[m.userId] = { userId: m.userId, groupId, nickname: m.nickname || '', policy: 'normal' };
    }
  }
  const groupUsers = Object.values(groupUserMap);
  const allMessages = db.messages || [];
  const allMemories = db.memories || [];
  const displayUserLabel = (u) => {
    if (u.nickname && u.nickname !== String(u.userId)) return `${u.nickname} (${u.userId})`;
    const msgs = allMessages.filter((m) => String(m.userId) === String(u.userId) && m.nickname && m.nickname !== String(u.userId));
    if (msgs.length) return `${msgs[msgs.length - 1].nickname} (${u.userId})`;
    const mem = allMemories.find((m) => String(m.userId) === String(u.userId) && m.nickname && m.nickname !== String(u.userId));
    if (mem) return `${mem.nickname} (${u.userId})`;
    return `QQ ${u.userId}`;
  };
  const selfQq = db.settings.selfQq || '';

  const run = async () => {
    setRunning(true);
    setResult(null);
    const body = {
      groupId, userId: userId || 'sandbox-user', nickname: nickname || 'SandboxUser', text,
      atTargets: atBot ? [selfQq] : [],
      memberPolicy: memberPolicy || undefined,
      groupMode: groupMode || undefined,
      useMemory, useGroupProfile, useRelationship, callLlm,
    };
    const data = await api('/api/sandbox', { method: 'POST', body });
    setResult(data);
    setRunning(false);
  };

  return (
    <div className="panel">
      <h2>决策沙盒</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>群聊</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            {groups.map((g) => <option key={g.groupId} value={g.groupId}>{g.name || g.groupId}</option>)}
            {!groups.length && <option value="">无群</option>}
          </select>
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>发言人</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">自定义...</option>
            {groupUsers.map((u) => <option key={u.userId} value={u.userId}>{displayUserLabel(u)}</option>)}
          </select>
        </label>
        <input placeholder="昵称（可手改）" value={nickname} onChange={(e) => setNickname(e.target.value)} />
        <input placeholder="QQ号（可手改）" value={userId} onChange={(e) => setUserId(e.target.value)} />
      </div>
      <label className="field">
        <span>消息内容</span>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
        <label className="switch" style={{ margin: 0 }}><input type="checkbox" checked={atBot} onChange={(e) => setAtBot(e.target.checked)} /> @机器人</label>
        <label className="switch" style={{ margin: 0 }}><input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} /> 个人画像</label>
        <label className="switch" style={{ margin: 0 }}><input type="checkbox" checked={useGroupProfile} onChange={(e) => setUseGroupProfile(e.target.checked)} /> 群画像</label>
        <label className="switch" style={{ margin: 0 }}><input type="checkbox" checked={useRelationship} onChange={(e) => setUseRelationship(e.target.checked)} /> 关系画像</label>
        <label className="switch" style={{ margin: 0 }}><input type="checkbox" checked={callLlm} onChange={(e) => setCallLlm(e.target.checked)} /> 调模型生成回复</label>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>临时成员策略覆盖</span>
          <select value={memberPolicy} onChange={(e) => setMemberPolicy(e.target.value)}>
            <option value="">按真实配置</option>
            {Object.entries(policyLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>临时群模式覆盖</span>
          <select value={groupMode} onChange={(e) => setGroupMode(e.target.value)}>
            <option value="">按真实配置</option>
            {Object.entries(modeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <button className="primary wide" onClick={run} disabled={running}>{running ? '分析中...' : '运行沙盒分析'}</button>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="reply">
            <p><strong>决策：</strong><span style={{ color: result.decision?.shouldReply ? '#2f7d68' : '#b84b4b' }}>{result.decision?.shouldReply ? '会回复' : '不回复'}</span> · {result.decision?.reason}</p>
          </div>
          {result.context && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#52605a', lineHeight: 1.8 }}>
              <div>群：{result.context.group} · 策略：{result.context.userPolicy}</div>
              {result.context.memoryProfile && <div>个人画像：{result.context.memoryProfile.summary || '有'}</div>}
              {result.context.groupProfile && <div>群画像：{result.context.groupProfile.atmosphere || '有'} · 置信{Math.round((result.context.groupProfile.confidence || 0) * 100)}%</div>}
              {result.context.relationshipProfiles?.length > 0 && <div>关系画像：{result.context.relationshipProfiles.map((r) => r.pair + ' ' + r.style).join(' · ')}</div>}
            </div>
          )}
          {result.replyPreview && <div className="reply" style={{ marginTop: 8 }}><p><strong>回复预览：</strong>{result.replyPreview}</p></div>}
          {result.usage && <p className="hint" style={{ marginTop: 8 }}>Token: {result.usage.total_tokens || 0} (入{result.usage.prompt_tokens || 0}+出{result.usage.completion_tokens || 0})</p>}
          {result.promptPreview && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => setShowPrompt(!showPrompt)} style={{ fontSize: 12 }}>{showPrompt ? '收起 Prompt' : '查看 Prompt 预览'}</button>
              {showPrompt && <pre style={{ marginTop: 8, background: '#f8f7f2', padding: 12, borderRadius: 8, fontSize: 11, maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{result.promptPreview}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}

function Row({ label, value }) {
  return <div className="row"><span>{label}</span><strong>{String(value)}</strong></div>;
}

function Text({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input value={value || ''} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Textarea({ label, value, onChange, rows = 3 }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea className="profileTextarea" rows={rows} value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Password({ label, value, onChange }) {
  return <label className="field"><span>{label}</span><input type="password" placeholder={value === '已填写' ? '已填写，留空不改' : ''} value={value === '已填写' ? '' : value || ''} onChange={(e) => onChange(e.target.value)} /></label>;
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {Object.entries(options).map(([key, lbl]) => <option key={key} value={key}>{lbl}</option>)}
      </select>
    </label>
  );
}

function Slider({ label, min, max, step = 1, value, onChange }) {
  return (
    <label className="field">
      <span>{label}：{value}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

createRoot(document.getElementById('root')).render(<App />);
