import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Edit3, RefreshCw, Save, Sparkles, Trash2, Users } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Input, LoadingState, Pill, SectionHeader, Select, Textarea } from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const profileFields = [
  ['interactionStyle', '互动方式'], ['commonTopics', '共同话题'], ['tone', '语气'], ['botStrategy', 'Bot 插话策略'], ['boundaries', '边界'],
];

export function RelationshipsPage({ db, refreshState }) {
  const groupOptions = (db.groups || []).map((group) => ({ value: String(group.groupId), label: group.name || String(group.groupId) }));
  const groupMap = Object.fromEntries(groupOptions.map((option) => [option.value, option.label]));
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [form, setForm] = useState({ groupId: db.groups?.[0]?.groupId || '', userA: '', userB: '' });
  const [expanded, setExpanded] = useState({});
  const [editing, setEditing] = useState({});
  const [drafts, setDrafts] = useState({});
  const [loadingKey, setLoadingKey] = useState('');
  const [relationshipData, setRelationshipData] = useState({ profiles: [], candidates: [], loading: true, error: '' });

  const rawProfileStamp = (db.relationshipProfiles || []).map((profile) => `${profile.groupId}:${profile.pairKey}:${profile.updatedAt}:${profile.enabled}`).join('|');
  const pendingStamp = Object.entries(db.pendingPairCounts || {}).map(([key, value]) => `${key}:${value}`).join('|');
  const loadRelationships = async () => {
    try {
      const data = await api('/api/relationship-profiles');
      setRelationshipData({ profiles: data.profiles || [], candidates: data.candidates || [], loading: false, error: '' });
    } catch (cause) {
      setRelationshipData((current) => ({ ...current, loading: false, error: cause.message || String(cause) }));
    }
  };

  useEffect(() => {
    let cancelled = false;
    api('/api/relationship-profiles').then((data) => {
      if (!cancelled) setRelationshipData({ profiles: data.profiles || [], candidates: data.candidates || [], loading: false, error: '' });
    }).catch((cause) => {
      if (!cancelled) setRelationshipData((current) => ({ ...current, loading: false, error: cause.message || String(cause) }));
    });
    return () => { cancelled = true; };
  }, [rawProfileStamp, pendingStamp]);

  const userName = (userId, groupId) => {
    const user = db.users?.find((entry) => String(entry.userId) === String(userId) && String(entry.groupId) === String(groupId));
    if (user?.customName) return user.customName;
    if (user?.nickname) return user.nickname;
    const memory = db.memories?.find((entry) => String(entry.userId) === String(userId));
    if (memory?.nickname) return memory.nickname;
    return [...(db.messages || [])].reverse().find((message) => String(message.userId) === String(userId) && message.nickname)?.nickname || String(userId);
  };

  const profiles = relationshipData.profiles || [];
  const candidates = (relationshipData.candidates || []).filter((candidate) => groupFilter === 'all' || String(candidate.groupId) === groupFilter);
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
      const result = await api('/api/relationship-profiles/update', { method: 'POST', body: { groupId, userA, userB } });
      if (result.skipped) alert(`未保存关系画像：${result.reason || '互动证据不足'}`);
      await refreshState();
      await loadRelationships();
    } catch (cause) {
      alert(`更新失败：${cause.message}`);
    } finally {
      setLoadingKey('');
    }
  };

  const doPatch = async (profile, patch) => {
    await api(`/api/relationship-profiles/${profile.groupId}/${profile.userA}/${profile.userB}`, { method: 'PATCH', body: patch });
    await refreshState();
    await loadRelationships();
  };

  const doDelete = async (profile) => {
    const label = `${profile.userAName || userName(profile.userA, profile.groupId)} ↔ ${profile.userBName || userName(profile.userB, profile.groupId)}`;
    if (!window.confirm(`删除 ${label} 的关系画像？`)) return;
    await api(`/api/relationship-profiles/${profile.groupId}/${profile.userA}/${profile.userB}`, { method: 'DELETE' });
    await refreshState();
    await loadRelationships();
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

  return <div className="console-page relationships-page">
    <SectionHeader eyebrow="Context / Relationships" title="关系画像" description="查看成员之间已经形成的互动模式，或用现有证据生成和更新画像。" actions={<Button icon={RefreshCw} onClick={loadRelationships}>刷新</Button>} />
    <div className="relationship-metrics">
      <Card><span>已生成</span><strong>{profiles.length}</strong></Card>
      <Card><span>候选关系对</span><strong>{candidates.length}</strong></Card>
      <Card><span>当前群筛选</span><strong>{groupFilter === 'all' ? '全部群' : groupMap[groupFilter] || groupFilter}</strong></Card>
    </div>
    {relationshipData.loading && <LoadingState label="正在读取关系画像…" />}
    {relationshipData.error && <ErrorState title="关系画像读取失败" message={relationshipData.error} onRetry={loadRelationships} />}
    {!relationshipData.loading && !relationshipData.error && <div className="relationships-workspace">
      <div className="console-setting-stack">
        <Card className="console-section relationship-generator">
          <div className="console-section__title"><Sparkles size={18} /><div><h3>生成 / 更新</h3><p>使用当前数据库中的互动证据。</p></div></div>
          <Select label="群" value={form.groupId} onChange={(event) => setForm({ ...form, groupId: event.target.value })} options={groupOptions} />
          <div className="console-form-grid"><Input label="用户 A QQ" value={form.userA} onChange={(event) => setForm({ ...form, userA: event.target.value })} /><Input label="用户 B QQ" value={form.userB} onChange={(event) => setForm({ ...form, userB: event.target.value })} /></div>
          <Button variant="primary" icon={Sparkles} loading={Boolean(loadingKey)} disabled={!form.groupId || !form.userA || !form.userB} onClick={() => doUpdate(form.groupId, form.userA, form.userB)}>LLM 更新</Button>
        </Card>
        <Card className="console-section">
          <div className="console-section__title"><Users size={18} /><div><h3>候选关系对 · {candidates.length}</h3><p>最多展示前 20 个真实候选。</p></div></div>
          <div className="console-list relationship-candidates">{candidates.slice(0, 20).map((candidate) => {
            const key = `${candidate.groupId}:${candidate.userA}:${candidate.userB}`;
            return <article className="console-list-item relationship-candidate" key={candidate.pairKey + candidate.groupId}><div><strong>{candidate.userAName || userName(candidate.userA, candidate.groupId)} ↔ {candidate.userBName || userName(candidate.userB, candidate.groupId)}</strong><span>{candidate.groupName || groupMap[candidate.groupId] || candidate.groupId} · 互动 {candidate.count} 次</span></div><Button size="sm" loading={loadingKey === key} disabled={Boolean(loadingKey)} onClick={() => doUpdate(candidate.groupId, candidate.userA, candidate.userB)}>生成</Button></article>;
          })}{!candidates.length && <EmptyState title="暂无候选关系对" description="等待更多真实互动样本积累。" />}</div>
        </Card>
      </div>

      <Card className="console-section relationships-list-panel">
        <div className="console-section__title"><Users size={18} /><div><h3>已生成 · {filtered.length}</h3><p>展开后可检查或手动编辑字段。</p></div></div>
        <div className="console-toolbar"><Input aria-label="搜索关系画像" placeholder="搜索昵称、QQ 或话题" value={search} onChange={(event) => setSearch(event.target.value)} /><Select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} options={[{ value: 'all', label: '全部群' }, ...groupOptions]} /></div>
        <div className="console-list relationships-list">{filtered.map((profile) => {
          const key = profile.pairKey + profile.groupId;
          const isExpanded = expanded[key];
          const isEditing = editing[key];
          const draft = drafts[key] || profile;
          return <article className="console-list-item relationship-row" key={key}>
            <header><div><strong>{profile.userAName || userName(profile.userA, profile.groupId)} ↔ {profile.userBName || userName(profile.userB, profile.groupId)}</strong><span>{groupMap[profile.groupId] || profile.groupId} · {profile.updatedAt ? new Date(profile.updatedAt).toLocaleString('zh-CN') : '未知时间'}</span><div className="console-pills"><Pill tone={profile.enabled !== false ? 'success' : 'neutral'}>{profile.enabled !== false ? '启用' : '停用'}</Pill><Pill>证据 {profile.evidenceCount || 0}</Pill><Pill tone="accent">置信 {Math.round((profile.confidence || 0) * 100)}%</Pill></div></div><div className="console-actions"><Button size="sm" icon={isExpanded ? ChevronUp : ChevronDown} onClick={() => setExpanded({ ...expanded, [key]: !isExpanded })}>{isExpanded ? '收起' : '展开'}</Button><Button size="sm" loading={loadingKey === `${profile.groupId}:${profile.userA}:${profile.userB}`} disabled={Boolean(loadingKey)} onClick={() => doUpdate(profile.groupId, profile.userA, profile.userB)}>LLM 更新</Button><Button size="sm" onClick={() => doPatch(profile, { enabled: profile.enabled === false })}>{profile.enabled !== false ? '停用' : '启用'}</Button><Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => doDelete(profile)}>删除</Button></div></header>
            {isExpanded && (isEditing ? <div className="relationship-row__edit">{profileFields.map(([field, label]) => <Textarea key={field} label={label} rows={2} value={draft[field] || ''} onChange={(event) => setDrafts({ ...drafts, [key]: { ...draft, [field]: event.target.value } })} />)}<div className="console-actions console-actions--end"><Button onClick={() => setEditing({ ...editing, [key]: false })}>取消</Button><Button variant="primary" icon={Save} onClick={() => saveEdit(profile)}>保存</Button></div></div> : <div className="relationship-row__details">{profileFields.map(([field, label]) => profile[field] && <div key={field}><span>{label}</span><p>{profile[field]}</p></div>)}<Button size="sm" icon={Edit3} onClick={() => startEdit(profile)}>手动编辑</Button></div>)}
          </article>;
        })}{!filtered.length && <EmptyState title="没有匹配的关系画像" description="调整筛选条件，或在左侧生成新的画像。" />}</div>
      </Card>
    </div>}
  </div>;
}
