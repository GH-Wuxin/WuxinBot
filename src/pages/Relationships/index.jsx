import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';
import { Avatar, userAvatarUrl } from '../../components/Avatar.jsx';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

// 版式对齐原型 PAGES.relationships：左侧关系强度条 + 右侧画像口径；下方保留完整管理列表。
const profileFields = [
  ['interactionStyle', '互动方式'], ['commonTopics', '共同话题'], ['tone', '语气'], ['botStrategy', 'Bot 插话策略'], ['boundaries', '边界'],
];

export function RelationshipsPage({ db, refreshState }) {
  const groupOptions = (db.groups || []).map((group) => ({ value: String(group.groupId), label: group.name || String(group.groupId) }));
  const groupMap = Object.fromEntries(groupOptions.map((option) => [option.value, option.label]));
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [form, setForm] = useState({ groupId: db.groups?.[0]?.groupId || '', userA: '', userB: '' });
  const [showAll, setShowAll] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [editing, setEditing] = useState({});
  const [drafts, setDrafts] = useState({});
  const [loadingKey, setLoadingKey] = useState('');
  const [relationshipData, setRelationshipData] = useState({ profiles: [], candidates: [], loading: true, error: '' });
  const relationshipRequestRef = useRef(null);
  const relationshipAbortRef = useRef(null);

  const rawProfileStamp = (db.relationshipProfiles || []).map((profile) => `${profile.groupId}:${profile.pairKey}:${profile.updatedAt}:${profile.enabled}`).join('|');
  const pendingStamp = Object.entries(db.pendingPairCounts || {}).map(([key, value]) => `${key}:${value}`).join('|');
  const loadRelationships = useCallback(() => {
    if (relationshipRequestRef.current) return relationshipRequestRef.current;
    const controller = new AbortController();
    relationshipAbortRef.current = controller;
    let request;
    request = (async () => {
      try {
        const data = await api('/api/relationship-profiles', { signal: controller.signal, timeoutMs: 15000 });
        setRelationshipData({ profiles: data.profiles || [], candidates: data.candidates || [], loading: false, error: '' });
      } catch (cause) {
        if (cause?.message !== '请求已取消') {
          setRelationshipData((current) => ({ ...current, loading: false, error: cause.message || String(cause) }));
        }
      } finally {
        if (relationshipRequestRef.current === request) relationshipRequestRef.current = null;
        if (relationshipAbortRef.current === controller) relationshipAbortRef.current = null;
      }
    })();
    relationshipRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => { void loadRelationships(); }, [rawProfileStamp, pendingStamp, loadRelationships]);
  useEffect(() => () => relationshipAbortRef.current?.abort(), []);

  const userName = (userId, groupId) => {
    const user = db.users?.find((entry) => String(entry.userId) === String(userId) && String(entry.groupId) === groupId);
    if (user?.customName) return user.customName;
    if (user?.nickname) return user.nickname;
    const memory = db.memories?.find((entry) => String(entry.userId) === String(userId));
    if (memory?.nickname) return memory.nickname;
    return [...(db.messages || [])].reverse().find((message) => String(message.userId) === String(userId) && message.nickname)?.nickname || String(userId);
  };

  const profiles = relationshipData.profiles || [];
  const candidates = (relationshipData.candidates || []).filter((candidate) => groupFilter === 'all' || String(candidate.groupId) === groupFilter);
  const pairLabel = (profile) => `${profile.userAName || userName(profile.userA, profile.groupId)} ↔ ${profile.userBName || userName(profile.userB, profile.groupId)}`;
  const filtered = profiles.filter((profile) => {
    if (groupFilter !== 'all' && String(profile.groupId) !== groupFilter) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [profile.userAName || userName(profile.userA, profile.groupId), profile.userBName || userName(profile.userB, profile.groupId), profile.userA, profile.userB, profile.interactionStyle, profile.commonTopics]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });

  const doUpdate = async (groupId, userA, userB) => {
    const key = `${groupId}:${userA}:${userB}`;
    setLoadingKey(key);
    try {
      const result = await api('/api/relationship-profiles/update', { method: 'POST', body: { groupId, userA, userB }, timeoutMs: 75000 });
      if (result.skipped) alert(`未保存关系画像：${result.reason || '互动证据不足'}`);
      await refreshState();
    } catch (cause) {
      alert(`更新失败：${cause.message}`);
    } finally {
      setLoadingKey('');
    }
  };

  const doPatch = async (profile, patch) => {
    await api(`/api/relationship-profiles/${profile.groupId}/${profile.userA}/${profile.userB}`, { method: 'PATCH', body: patch, timeoutMs: 15000 });
    await refreshState();
  };

  const doDelete = async (profile) => {
    await api(`/api/relationship-profiles/${profile.groupId}/${profile.userA}/${profile.userB}`, { method: 'DELETE', timeoutMs: 15000 });
    await refreshState();
  };

  const startEdit = (profile) => {
    const key = profile.pairKey + profile.groupId;
    setEditing({ ...editing, [key]: true });
    setDrafts({ ...drafts, [key]: { ...profile } });
  };

  const saveEdit = async (profile) => {
    const key = profile.pairKey + profile.groupId;
    const draft = drafts[key] || profile;
    await doPatch(profile, Object.fromEntries(profileFields.map(([field]) => [field, draft[field]])));
    setEditing({ ...editing, [key]: false });
  };

  return <>
    <div className="page-head">
      <div><h1>关系</h1><p>谁和谁熟，靠一起出现和互动的证据说话。</p></div>
      <div style={{ display: 'flex', gap: 8 }}><RefreshButton onClick={loadRelationships} /></div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="昵称、QQ 或话题" aria-label="搜索关系画像" />
      <select
        value={groupFilter}
        onChange={(event) => setGroupFilter(event.target.value)}
        aria-label="按群筛选"
        style={{ background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 999, color: 'var(--text)', padding: '6px 12px', fontSize: 12 }}
      >
        <option value="all">全部群</option>
        {groupOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <span className="chip">{filtered.length} 对</span>
    </div>

    {relationshipData.error && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>关系画像读取失败：{relationshipData.error}</div>}

    <div className="grid grid-main" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><span className="card-title">关系强度</span><span className="muted" style={{ fontSize: 12 }}>共 {filtered.length} 对 · 按置信度</span></div>
        {filtered.slice(0, 12).map((profile) => {
          const confidence = Math.round(Number(profile.confidence || 0) * 100);
          return <div className="bar-row" key={profile.pairKey + profile.groupId}>
            <span title={pairLabel(profile)}>{pairLabel(profile)}</span>
            <div className="bar"><i style={{ width: confidence + '%' }} /></div>
            <b>{confidence}%</b>
          </div>;
        })}
        {!filtered.length && <div className="note">{relationshipData.loading ? '正在读取关系画像…' : '还没有关系画像。'}</div>}
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head"><span className="card-title">画像口径</span></div>
          <div className="note">关系强度由共同出现次数、互相 @、连续对话轮次加权得到；不包含私聊内容。条上的百分比是画像置信度。</div>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">生成 / 更新</span></div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label>群</label>
            <select value={form.groupId} onChange={(event) => setForm({ ...form, groupId: event.target.value })}>
              {groupOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="field"><label>用户 A QQ</label><input value={form.userA} onChange={(event) => setForm({ ...form, userA: event.target.value })} /></div>
          <div className="field"><label>用户 B QQ</label><input value={form.userB} onChange={(event) => setForm({ ...form, userB: event.target.value })} /></div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 6 }}
            disabled={!form.groupId || !form.userA || !form.userB || Boolean(loadingKey)}
            onClick={() => doUpdate(form.groupId, form.userA, form.userB)}
          >{loadingKey === `${form.groupId}:${form.userA}:${form.userB}` ? '更新中…' : 'LLM 更新'}</button>
        </div>

        <div className="card">
          <div className="card-head"><span className="card-title">候选关系对</span><span className="muted" style={{ fontSize: 12 }}>{candidates.length} 对 · 最多 20</span></div>
          <div className="rows" style={{ maxHeight: 340, overflowY: 'auto' }}>
            {candidates.slice(0, 20).map((candidate) => {
              const key = `${candidate.groupId}:${candidate.userA}:${candidate.userB}`;
              return <div className="row" key={candidate.pairKey + candidate.groupId}>
                <div className="row-main">
                  <div className="row-title">{candidate.userAName || userName(candidate.userA, candidate.groupId)} ↔ {candidate.userBName || userName(candidate.userB, candidate.groupId)}</div>
                  <div className="row-sub">{candidate.groupName || groupMap[candidate.groupId] || candidate.groupId} · 互动 {candidate.count} 次</div>
                </div>
                <button type="button" className="btn btn-sm" disabled={Boolean(loadingKey)} onClick={() => doUpdate(candidate.groupId, candidate.userA, candidate.userB)}>{loadingKey === key ? '生成中…' : '生成'}</button>
              </div>;
            })}
            {!candidates.length && <div className="note">暂无候选关系对，等待更多真实互动样本。</div>}
          </div>
        </div>
      </div>
    </div>

    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><span className="card-title">全部关系画像</span><span className="muted" style={{ fontSize: 12 }}>{filtered.length} 条</span></div>
      <div className="rows">
        {(showAll ? filtered : filtered.slice(0, 20)).map((profile) => {
          const key = profile.pairKey + profile.groupId;
          const isExpanded = expanded[key];
          const isEditing = editing[key];
          const draft = drafts[key] || profile;
          return <div key={key} style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 4 }}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' }}>
                <Avatar name={profile.userAName || userName(profile.userA, profile.groupId)} src={userAvatarUrl(profile.userA)} size={24} />
                <span style={{ marginLeft: -8, borderRadius: '50%', boxShadow: '0 0 0 2px var(--panel)' }}>
                  <Avatar name={profile.userBName || userName(profile.userB, profile.groupId)} src={userAvatarUrl(profile.userB)} size={24} />
                </span>
              </span>
              <div className="row-main">
                <div className="row-title">{pairLabel(profile)}</div>
                <div className="row-sub">{groupMap[profile.groupId] || profile.groupId} · {profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('zh-CN') : '未知时间'} · {profile.enabled !== false ? '启用' : '停用'} · 证据 {profile.evidenceCount || 0}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded({ ...expanded, [key]: !isExpanded })}>{isExpanded ? '收起' : '展开'}</button>
                <button type="button" className="btn btn-sm" disabled={Boolean(loadingKey)} onClick={() => doUpdate(profile.groupId, profile.userA, profile.userB)}>LLM 更新</button>
                <button type="button" className="btn btn-sm" onClick={() => doPatch(profile, { enabled: profile.enabled === false })}>{profile.enabled !== false ? '停用' : '启用'}</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeleteTarget(profile)}>删除</button>
              </div>
            </div>
            {isExpanded && (isEditing
              ? <div style={{ padding: '8px 10px 4px' }}>
                {profileFields.map(([field, label]) => <div className="field" key={field}><label>{label}</label><textarea rows="2" value={draft[field] || ''} onChange={(event) => setDrafts({ ...drafts, [key]: { ...draft, [field]: event.target.value } })} /></div>)}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing({ ...editing, [key]: false })}>取消</button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => saveEdit(profile)}>保存</button>
                </div>
              </div>
              : <div style={{ padding: '4px 10px 8px' }}>
                {profileFields.map(([field, label]) => profile[field] ? <div className="kv" key={field} style={{ display: 'block' }}><span>{label}</span><br /><b style={{ fontWeight: 500 }}>{profile[field]}</b></div> : null)}
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => startEdit(profile)}>手动编辑</button>
              </div>)}
          </div>;
        })}
        {!filtered.length && <div className="note">没有匹配的关系画像。</div>}
        {!showAll && filtered.length > 20 && <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button type="button" className="btn btn-sm" onClick={() => setShowAll(true)}>显示全部 {filtered.length} 条</button>
        </div>}
      </div>
    </div>
    <ConfirmDialog
      open={Boolean(deleteTarget)}
      title="删除关系画像？"
      description={deleteTarget ? `将删除 ${pairLabel(deleteTarget)} 的关系画像；原始聊天记录与成员策略不受影响。` : ""}
      confirmLabel="删除画像"
      onCancel={() => setDeleteTarget(null)}
      onConfirm={() => { const target = deleteTarget; setDeleteTarget(null); return target ? doDelete(target) : undefined; }}
    />
  </>;
}
