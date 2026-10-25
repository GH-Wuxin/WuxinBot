import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';
import { Avatar, groupAvatarUrl, userAvatarUrl } from '../../components/Avatar.jsx';
import { resolveNickname } from '../../lib/names.js';
import { RefreshButton } from '../../components/ui/RefreshButton.jsx';

// 版式对齐原型 PAGES.groups：左列表 + 右详情（kv）+ 群内 Bot。
// 编辑能力保留：默认只读展示，点「编辑策略」切到 .field 表单。
const emptyGroup = { groupId: '', name: '', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 };
const modeOptions = [
  { value: 'silent', label: '静默' },
  { value: 'mention', label: '@ 回复' },
  { value: 'light', label: '轻度参与' },
  { value: 'natural', label: '自然群友' },
  { value: 'osu', label: '仅 osu! 指令' },
];
const botNames = { yumu: '雨沐', kanon: '猫猫', hydrant: '消防栓', lazybot: 'LazyBot' };
const profileFields = [
  ['atmosphere', '整体氛围'], ['topics', '常见话题'], ['humorStyle', '玩笑方式'],
  ['pace', '聊天节奏'], ['botStrategy', '说话策略'], ['boundaries', '注意边界'],
];
const modeLabel = (mode) => modeOptions.find((item) => item.value === mode)?.label || mode || '未设置';
const hasProfileContent = (profile) => profileFields.some(([field]) => String(profile?.[field] || '').trim());
const levelPpLabel = (entry) => `${Math.floor(Number(entry?.xp || 0) / 100) * 100}pp`;

export function GroupsPage({ db, refreshState, saveSettings }) {
  const groups = db.groups || [];
  const [selectedId, setSelectedId] = useState(groups[0]?.groupId || '');
  const [creating, setCreating] = useState(groups.length === 0);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(groups[0] ? { ...groups[0] } : { ...emptyGroup });
  const [search, setSearch] = useState('');
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState({});
  const [botToggles, setBotToggles] = useState({});
  const [pending, setPending] = useState('');
  const [operationError, setOperationError] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);

  const selectedGroup = groups.find((group) => String(group.groupId) === String(selectedId)) || null;
  const selectedProfile = (db.groupProfiles || []).find((profile) => String(profile.groupId) === String(selectedId)) || null;

  useEffect(() => {
    if (creating) return;
    if (selectedId && groups.some((group) => String(group.groupId) === String(selectedId))) return;
    const first = groups[0];
    if (first) { setSelectedId(first.groupId); setForm({ ...first }); }
    else { setCreating(true); setSelectedId(''); setForm({ ...emptyGroup }); }
  }, [groups, selectedId, creating]);

  useEffect(() => {
    setProfileEditing(false);
    setProfileDraft(selectedProfile ? { ...selectedProfile } : {});
  }, [selectedId]);

  const messagesByGroup = useMemo(() => {
    const output = {};
    for (const message of db.messages || []) {
      const groupId = String(message.groupId || '');
      if (!groupId) continue;
      if (!output[groupId]) output[groupId] = [];
      output[groupId].push(message);
    }
    return output;
  }, [db.messages]);

  const recentMessages = (groupId) => messagesByGroup[String(groupId)] || [];
  const latestMessage = (groupId) => recentMessages(groupId).at(-1) || null;
  const recentNames = (groupId, limit = 4) => {
    const seen = new Set();
    const names = [];
    for (const message of [...recentMessages(groupId)].reverse()) {
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
  const hasManualName = (group) => {
    const name = String(group?.name || '').trim();
    const id = String(group?.groupId || '').trim();
    return Boolean(name && name !== id && name !== `群${id}` && name !== `群聊${id}` && name !== `群聊 ${id}`);
  };
  const displayName = (group) => {
    if (hasManualName(group)) return group.name;
    const names = recentNames(group.groupId, 2);
    return names.length ? `${names.join('、')} 等人的群` : `群 ${group.groupId}`;
  };
  const groupCounts = (groupId) => ({
    policies: (db.users || []).filter((user) => String(user.groupId) === String(groupId)).length,
    memories: (db.memories || []).filter((memory) => (memory.groupsSeen || []).map(String).includes(String(groupId))).length,
  });
  const latestTimestamp = (groupId) => {
    const createdAt = latestMessage(groupId)?.createdAt;
    return createdAt ? new Date(createdAt).getTime() : 0;
  };

  const visibleGroups = [...groups].filter((group) => {
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return displayName(group).toLowerCase().includes(needle)
      || String(group.name || '').toLowerCase().includes(needle)
      || String(group.groupId).includes(needle)
      || recentNames(group.groupId, 8).join(' ').toLowerCase().includes(needle);
  }).sort((left, right) => latestTimestamp(right.groupId) - latestTimestamp(left.groupId));

  const runAction = async (key, action) => {
    setPending(key);
    setOperationError('');
    try { await action(); } catch (error) { setOperationError(error?.message || String(error)); throw error; } finally { setPending(''); }
  };

  const selectGroup = (group) => {
    if (!group) return;
    setCreating(false);
    setEditing(false);
    setSelectedId(group.groupId);
    setForm({ ...group });
  };
  const startCreate = () => {
    setCreating(true);
    setEditing(true);
    setSelectedId('');
    setForm({ ...emptyGroup });
    setProfileEditing(false);
  };
  const saveGroup = async (payload = form) => runAction('save-group', async () => {
    await api('/api/groups', { method: 'POST', body: payload, timeoutMs: 15000 });
    await refreshState();
    setCreating(false);
    setEditing(false);
    setSelectedId(payload.groupId);
    setForm({ ...payload });
  });
  const toggleGroup = async (group) => runAction(`toggle-${group.groupId}`, async () => {
    await api('/api/groups', { method: 'POST', body: { ...group, enabled: !group.enabled }, timeoutMs: 15000 });
    await refreshState();
  });

  const toggleBot = async (botId, enabled) => {
    const groupId = selectedGroup.groupId;
    setBotToggles((current) => ({ ...current, [groupId]: { ...(current[groupId] || {}), [botId]: enabled } }));
    try {
      await runAction(`bot-${botId}`, async () => {
        await api('/api/group-bot-config', { method: 'POST', body: { groupId, botId, enabled }, timeoutMs: 15000 });
        await refreshState();
      });
    } catch {
      setBotToggles((current) => ({ ...current, [groupId]: { ...(current[groupId] || {}), [botId]: !enabled } }));
    }
  };

  const updateProfile = () => runAction('profile-update', async () => {
    await api(`/api/group-profiles/${selectedGroup.groupId}/update`, { method: 'POST', timeoutMs: 75000 });
    await refreshState();
  });
  const toggleProfile = () => runAction('profile-toggle', async () => {
    await api(`/api/group-profiles/${selectedGroup.groupId}`, { method: 'PATCH', body: { enabled: !selectedProfile.enabled }, timeoutMs: 15000 });
    await refreshState();
  });
  const saveProfile = () => runAction('profile-save', async () => {
    const body = Object.fromEntries(profileFields.map(([field]) => [field, profileDraft[field] || '']));
    await api(`/api/group-profiles/${selectedGroup.groupId}`, { method: 'PATCH', body, timeoutMs: 15000 });
    setProfileEditing(false);
    await refreshState();
  });
  const clearContext = () => runAction('clear-context', async () => {
    await api(`/api/clear-context/${selectedGroup.groupId}`, { method: 'POST', timeoutMs: 15000 });
    await refreshState();
  });

  const selectedCounts = selectedGroup ? groupCounts(selectedGroup.groupId) : { policies: 0, memories: 0 };
  const selectedNames = selectedGroup ? recentNames(selectedGroup.groupId, 4) : [];
  const groupBots = selectedGroup ? { yumu: true, kanon: true, hydrant: true, lazybot: true, ...((db.groupBotConfig || {})[selectedGroup.groupId] || {}), ...(botToggles[selectedGroup.groupId] || {}) } : {};
  const experienceRows = selectedGroup
    ? Object.entries(db.groupExperience || {})
      .filter(([key]) => key.startsWith(`${selectedGroup.groupId}:`))
      .map(([, entry]) => entry)
      .sort((left, right) => Number(right.xpInGroup || 0) - Number(left.xpInGroup || 0))
      .slice(0, 5)
    : [];

  return <>
    <div className="page-head">
      <div><h1>群聊</h1><p>选择群聊，查看实际生效的回复模式与参与策略。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <RefreshButton onClick={() => refreshState()} />
        <button type="button" className="btn btn-primary" onClick={startCreate}>添加群</button>
      </div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="群名、群号或活跃成员" />
      <span className="chip">{groups.length} 个群</span>
    </div>

    {operationError && <div className="note" style={{ color: 'var(--red)', marginBottom: 12 }}>{operationError}</div>}

    <div className="grid grid-main">
      <div className="card">
        <div className="card-head"><span className="card-title">已配置群</span><span className="muted" style={{ fontSize: 12 }}>按最近活跃排序</span></div>
        <div className="rows">
          {visibleGroups.map((group) => {
            const active = !creating && String(selectedId) === String(group.groupId);
            return <div key={group.groupId} className={'row group-row' + (active ? ' is-selected' : '')} onClick={() => selectGroup(group)}>
              <Avatar name={displayName(group)} src={groupAvatarUrl(group.groupId, group.avatarUrl || group.avatar_url)} size={30} />
              <div className="row-main">
                <div className="row-title">{displayName(group)}</div>
                <div className="row-sub">{group.groupId} · {modeLabel(group.participation?.mode || group.mode)}{group.participation?.reason ? ` · ${group.participation.reason}` : ''}</div>
              </div>
              <span className={'chip' + (group.enabled ? ' chip--mint' : '')}>{group.enabled ? '启用' : '停用'}</span>
              <button
                type="button"
                className={'switch' + (group.enabled ? ' is-on' : '')}
                aria-label={displayName(group) + ' 启用状态'}
                onClick={(event) => { event.stopPropagation(); toggleGroup(group); }}
              />
            </div>;
          })}
          {!visibleGroups.length && <div className="note">没有匹配的群。</div>}
        </div>
      </div>

      <div className="stack">
        {creating ? <div className="card">
          <div className="card-head"><span className="card-title">添加白名单群</span></div>
          <div className="field"><label>QQ 群号</label><input value={form.groupId || ''} onChange={(event) => setForm({ ...form, groupId: event.target.value })} placeholder="例如 106717635" /></div>
          <div className="field"><label>群名称 / 备注</label><input value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="不填会用活跃成员辅助辨认" /></div>
          <div className="field"><label>回复模式</label><select value={form.mode || 'mention'} onChange={(event) => setForm({ ...form, mode: event.target.value })}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => { setCreating(false); setEditing(false); }}>取消</button>
            <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={!String(form.groupId || '').trim() || pending === 'save-group'} onClick={() => saveGroup()}>{pending === 'save-group' ? '保存中…' : '创建群'}</button>
          </div>
        </div> : selectedGroup && <>
          <div className="card">
            <div className="card-head"><span className="card-title">{displayName(selectedGroup)}</span><span className={'chip ' + (selectedGroup.enabled ? 'chip--mint' : 'chip--amber')}>{selectedGroup.enabled ? '启用中' : '已停用'}</span></div>
            <div className="note" style={{ marginBottom: 12 }}>{selectedGroup.groupId} · {selectedCounts.policies} 个成员策略 · {selectedCounts.memories} 个记忆成员</div>
            <div className="note" style={{ marginBottom: 12 }}>当前生效：{modeLabel(selectedGroup.participation?.mode || selectedGroup.mode)}{selectedGroup.participation?.reason ? ` · ${selectedGroup.participation.reason}（本群设置：${modeLabel(selectedGroup.mode)}）` : ''}</div>
            {editing ? <>
              <div className="field"><label>回复模式</label><select value={form.mode || 'mention'} onChange={(event) => setForm({ ...form, mode: event.target.value })}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
              <div className="field"><label>每小时上限</label><input type="number" min="1" max="80" value={form.maxPerHour ?? 20} onChange={(event) => setForm({ ...form, maxPerHour: Number(event.target.value) })} /></div>
              <div className="field"><label>发言冷却（秒）</label><input type="number" min="0" max="180" value={form.cooldownSec ?? 30} onChange={(event) => setForm({ ...form, cooldownSec: Number(event.target.value) })} /></div>
              <div className="field"><label>群名称 / 备注</label><input value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => { setEditing(false); setForm({ ...selectedGroup }); }}>取消</button>
                <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={pending === 'save-group'} onClick={() => saveGroup()}>{pending === 'save-group' ? '保存中…' : '保存群设置'}</button>
              </div>
            </> : <>
              <div className="kv"><span>回复模式</span><b>{modeLabel(selectedGroup.mode)}</b></div>
              <div className="kv"><span>每小时上限</span><b>{selectedGroup.maxPerHour || 0} 条</b></div>
              <div className="kv"><span>发言冷却</span><b>{selectedGroup.cooldownSec || 0} 秒</b></div>
              <div className="kv"><span>群画像置信度</span><b>{selectedProfile ? Math.round(Number(selectedProfile.confidence || 0) * 100) + '% · ' + (selectedProfile.evidenceCount || 0) + ' 条依据' : '暂无'}</b></div>
              <div className="kv"><span>群内 Bot</span><b>{Object.values(groupBots).filter((value) => value !== false).length} 个</b></div>
              {selectedNames.length > 0 && <div className="kv"><span>最近活跃</span><b style={{ fontWeight: 500 }}>{selectedNames.join('、')}</b></div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setEditing(true)}>编辑策略</button>
                <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => setProfileEditing(true)}>查看群画像</button>
              </div>
            </>}
          </div>

          <div className="card">
            <div className="card-head"><span className="card-title">群内 Bot</span><span className="muted" style={{ fontSize: 12 }}>开关立即生效</span></div>
            <div className="rows">
              {Object.entries(botNames).map(([botId, name]) => {
                const on = groupBots[botId] !== false;
                return <div className="row" key={botId}>
                  <div className="row-main"><div className="row-title">{name}</div><div className="row-sub">{on ? '该群启用' : '未启用'}</div></div>
                  <button type="button" className={'switch' + (on ? ' is-on' : '')} aria-label={name + ' 开关'} disabled={pending === `bot-${botId}`} onClick={() => toggleBot(botId, !on)} />
                </div>;
              })}
            </div>
          </div>
        </>}
      </div>
    </div>

    {!creating && selectedGroup && <div className="grid grid-2" style={{ marginTop: 16 }}>
      <div className="card">
        <div className="card-head">
          <span className="card-title">群聊画像</span>
          <span className="muted" style={{ fontSize: 12 }}>{selectedProfile ? (hasProfileContent(selectedProfile) ? `置信 ${Math.round(Number(selectedProfile.confidence || 0) * 100)}% · ${selectedProfile.evidenceCount || 0} 条依据` : `待生成 · 已累计 ${selectedProfile.pendingMessageCount || 0} 条`) : '暂无画像'}</span>
        </div>
        {!selectedProfile ? <div className="note">群画像记录建立后，生成、注入和编辑操作会显示在这里。</div> : profileEditing ? <>
          {profileFields.map(([field, label]) => <div className="field" key={field}><label>{label}</label><textarea rows="2" value={profileDraft[field] || ''} onChange={(event) => setProfileDraft({ ...profileDraft, [field]: event.target.value })} /></div>)}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => { setProfileEditing(false); setProfileDraft({ ...selectedProfile }); }}>取消</button>
            <button type="button" className="btn btn-primary" disabled={pending === 'profile-save'} onClick={saveProfile}>保存画像</button>
          </div>
        </> : <>
          {!hasProfileContent(selectedProfile) && <div className="note">还没有有效群聊画像。自动更新会继续累计真实聊天，也可以手动触发更新。</div>}
          {selectedProfile.lastUpdateStatus === 'failed' && selectedProfile.lastUpdateError && <div className="note" style={{ color: 'var(--red)' }}>上次更新失败：{selectedProfile.lastUpdateError}</div>}
          {profileFields.map(([field, label]) => selectedProfile[field] ? <div className="kv" key={field} style={{ display: 'block' }}><span>{label}</span><br /><b style={{ fontWeight: 500 }}>{selectedProfile[field]}</b></div> : null)}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            <button type="button" className="btn" disabled={pending === 'profile-toggle'} onClick={toggleProfile}>{selectedProfile.enabled !== false ? '停用注入' : '启用注入'}</button>
            <button type="button" className="btn" onClick={() => { setProfileDraft({ ...selectedProfile }); setProfileEditing(true); }}>手动编辑</button>
            <button type="button" className="btn btn-primary" disabled={pending === 'profile-update'} onClick={updateProfile}>{pending === 'profile-update' ? '更新中…' : 'LLM 更新'}</button>
          </div>
        </>}
      </div>

      <div className="stack">
        {experienceRows.length > 0 && <div className="card">
          <div className="card-head"><span className="card-title">成员等级</span><span className="muted" style={{ fontSize: 12 }}>本群经验前五</span></div>
          <table className="table"><thead><tr><th>成员</th><th>经验</th></tr></thead><tbody>
            {experienceRows.map((entry) => {
              const experience = (db.experience || {})[entry.userId] || {};
              const name = resolveNickname(db, entry.userId) || entry.userId;
              return <tr key={entry.userId}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Avatar name={name} src={userAvatarUrl(entry.userId)} size={22} />
                    <b>{name}</b>
                  </span>
                </td>
                <td className="muted">{levelPpLabel(experience)}</td>
              </tr>;
            })}
          </tbody></table>
        </div>}
        <div className="card">
          <div className="card-head"><span className="card-title">画像自动更新</span></div>
          <div className="row">
            <div className="row-main"><div className="row-title">自动更新</div><div className="row-sub">累计到阈值后自动刷新群画像</div></div>
            <button
              type="button"
              className={'switch' + (db.settings.groupProfileAutoUpdate !== false ? ' is-on' : '')}
              aria-label="群聊画像自动更新"
              onClick={() => saveSettings({ groupProfileAutoUpdate: db.settings.groupProfileAutoUpdate === false })}
            />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>更新阈值（条）</label>
            <input
              type="number"
              min="20"
              max="500"
              value={db.settings.groupProfileThreshold || 80}
              onChange={(event) => saveSettings({ groupProfileThreshold: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="card danger">
          <div className="card-title">数据操作</div>
          <div className="note" style={{ margin: '8px 0 14px' }}>清空上下文会删除该群的聊天上下文和决策日志，不会删除群配置。</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" disabled={pending === 'clear-context'} onClick={() => setClearConfirm(true)}>清空群上下文</button>
          </div>
        </div>
      </div>
    </div>}
    <ConfirmDialog
      open={clearConfirm}
      title="清空群上下文？"
      description={selectedGroup ? `只清空「${displayName(selectedGroup)}」的聊天上下文和决策日志，不会删除群配置、成员策略或画像。` : ""}
      confirmLabel="清空上下文"
      busy={pending === "clear-context"}
      onCancel={() => setClearConfirm(false)}
      onConfirm={() => { setClearConfirm(false); return clearContext(); }}
    />
  </>;
}
