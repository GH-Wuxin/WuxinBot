import React, { useEffect, useMemo, useState } from 'react';
import { Bot, ChevronRight, MessageCircle, Plus, RefreshCw, Save, Search, Trash2, UsersRound, WandSparkles } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, GroupAvatar, Input, ListRow, NumberInput, Pill, SectionHeader, SegmentedControl, Select, SettingRow, Switch, Textarea } from '../../components/ui/index.jsx';

const emptyGroup = { groupId: '', name: '', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 };
const modeOptions = [
  { value: 'silent', label: '静默' },
  { value: 'mention', label: '@ 回复' },
  { value: 'light', label: '轻度参与' },
  { value: 'natural', label: '自然群友' }
];
const sortOptions = [
  { value: 'recent', label: '最近活跃' },
  { value: 'enabled', label: '启用优先' },
  { value: 'name', label: '名称排序' }
];
const botNames = { yumu: '雨沐', kanon: '猫猫', hydrant: '消防栓', lazybot: 'LazyBot' };
const profileFields = [
  ['atmosphere', '整体氛围'], ['topics', '常见话题'], ['humorStyle', '玩笑方式'],
  ['pace', '聊天节奏'], ['botStrategy', '说话策略'], ['boundaries', '注意边界']
];
const profileContentFields = profileFields.map(([field]) => field);
const hasProfileContent = (profile) => profileContentFields.some((field) => String(profile?.[field] || '').trim());
const modeLabel = (mode) => modeOptions.find((item) => item.value === mode)?.label || mode;
const levelPpLabel = (entry) => `${Math.floor(Number(entry?.xp || 0) / 100) * 100}pp`;

export function GroupsPage({ db, refreshState, saveSettings }) {
  const groups = db.groups || [];
  const [selectedId, setSelectedId] = useState(groups[0]?.groupId || '');
  const [creating, setCreating] = useState(groups.length === 0);
  const [form, setForm] = useState(groups[0] ? { ...groups[0] } : { ...emptyGroup });
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [profileExpanded, setProfileExpanded] = useState(true);
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileDraft, setProfileDraft] = useState({});
  const [botToggles, setBotToggles] = useState({});
  const [pending, setPending] = useState('');
  const [operationError, setOperationError] = useState('');
  const [confirmation, setConfirmation] = useState(null);

  const selectedGroup = groups.find((group) => String(group.groupId) === String(selectedId)) || null;
  const selectedProfile = (db.groupProfiles || []).find((profile) => String(profile.groupId) === String(selectedId)) || null;

  useEffect(() => {
    if (creating) return;
    if (selectedId && groups.some((group) => String(group.groupId) === String(selectedId))) return;
    const first = groups[0];
    if (first) {
      setSelectedId(first.groupId);
      setForm({ ...first });
    } else {
      setCreating(true);
      setSelectedId('');
      setForm({ ...emptyGroup });
    }
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
    memories: (db.memories || []).filter((memory) => (memory.groupsSeen || []).map(String).includes(String(groupId))).length
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
      || recentNames(group.groupId, 8).join(' ').toLowerCase().includes(needle)
      || String(latestMessage(group.groupId)?.text || '').toLowerCase().includes(needle);
  }).sort((left, right) => {
    if (sortBy === 'name') return displayName(left).localeCompare(displayName(right), 'zh-CN');
    if (sortBy === 'enabled') return Number(right.enabled === true) - Number(left.enabled === true);
    return latestTimestamp(right.groupId) - latestTimestamp(left.groupId);
  });

  const runAction = async (key, action) => {
    setPending(key);
    setOperationError('');
    try { await action(); } catch (error) { setOperationError(error?.message || String(error)); throw error; } finally { setPending(''); }
  };

  const selectGroup = (group) => {
    setCreating(false);
    setSelectedId(group.groupId);
    setForm({ ...group });
    setProfileExpanded(true);
  };
  const startCreate = () => {
    setCreating(true);
    setSelectedId('');
    setForm({ ...emptyGroup });
    setProfileEditing(false);
  };
  const saveGroup = async (payload = form) => runAction('save-group', async () => {
    await api('/api/groups', { method: 'POST', body: payload });
    await refreshState();
    setCreating(false);
    setSelectedId(payload.groupId);
    setForm({ ...payload });
  });
  const toggleGroupEnabled = () => saveGroup({ ...selectedGroup, enabled: !selectedGroup.enabled });
  const useSuggestedName = () => {
    const names = recentNames(form.groupId, 2);
    if (names.length) setForm((current) => ({ ...current, name: `${names.join('、')} 等人的群` }));
  };

  const toggleBot = async (botId, enabled) => {
    const groupId = selectedGroup.groupId;
    setBotToggles((current) => ({ ...current, [groupId]: { ...(current[groupId] || {}), [botId]: enabled } }));
    try {
      await runAction(`bot-${botId}`, async () => {
        await api('/api/group-bot-config', { method: 'POST', body: { groupId, botId, enabled } });
        await refreshState();
      });
    } catch {
      setBotToggles((current) => ({ ...current, [groupId]: { ...(current[groupId] || {}), [botId]: !enabled } }));
    }
  };

  const updateProfile = () => runAction('profile-update', async () => {
    await api(`/api/group-profiles/${selectedGroup.groupId}/update`, { method: 'POST' });
    await refreshState();
  });
  const toggleProfile = () => runAction('profile-toggle', async () => {
    await api(`/api/group-profiles/${selectedGroup.groupId}`, { method: 'PATCH', body: { enabled: !selectedProfile.enabled } });
    await refreshState();
  });
  const saveProfile = () => runAction('profile-save', async () => {
    const body = Object.fromEntries(profileFields.map(([field]) => [field, profileDraft[field] || '']));
    await api(`/api/group-profiles/${selectedGroup.groupId}`, { method: 'PATCH', body });
    setProfileEditing(false);
    await refreshState();
  });

  const openConfirmation = (kind) => setConfirmation({ kind, group: selectedGroup });
  const confirmationCopy = !confirmation
    ? { title: '', description: '', label: '' }
    : confirmation.kind === 'delete-group'
      ? { title: `删除 ${displayName(confirmation.group)}？`, description: '将同时删除该群的成员策略、聊天记录、决策日志、命令日志、群画像、关系画像和 Bot 开关配置。此操作不可恢复。', label: '永久删除群' }
      : confirmation.kind === 'clear-context'
        ? { title: `清空 ${displayName(confirmation.group)} 的上下文？`, description: '只清空这个群的聊天上下文和决策日志，不会删除群配置、成员策略或画像。', label: '清空上下文' }
        : { title: `清除 ${displayName(confirmation.group)} 的群画像？`, description: '现有群画像内容会被删除；真实聊天和群配置不会被删除。', label: '清除群画像' };
  const confirmAction = async () => {
    const current = confirmation;
    if (!current) return;
    await runAction(`confirm-${current.kind}`, async () => {
      if (current.kind === 'delete-group') await api(`/api/groups/${current.group.groupId}`, { method: 'DELETE' });
      if (current.kind === 'clear-context') await api(`/api/clear-context/${current.group.groupId}`, { method: 'POST' });
      if (current.kind === 'clear-profile') await api(`/api/group-profiles/${current.group.groupId}`, { method: 'DELETE' });
      setConfirmation(null);
      await refreshState();
      if (current.kind === 'delete-group') {
        const remaining = groups.filter((group) => String(group.groupId) !== String(current.group.groupId));
        if (remaining[0]) selectGroup(remaining[0]); else startCreate();
      }
    }).catch(() => {});
  };

  const selectedCounts = selectedGroup ? groupCounts(selectedGroup.groupId) : { policies: 0, memories: 0 };
  const selectedNames = selectedGroup ? recentNames(selectedGroup.groupId, 4) : [];
  const selectedLatest = selectedGroup ? latestMessage(selectedGroup.groupId) : null;
  const groupBots = selectedGroup ? { yumu: true, kanon: true, hydrant: true, lazybot: true, ...((db.groupBotConfig || {})[selectedGroup.groupId] || {}), ...(botToggles[selectedGroup.groupId] || {}) } : {};
  const experienceRows = selectedGroup ? Object.entries(db.groupExperience || {}).filter(([key]) => key.startsWith(`${selectedGroup.groupId}:`)).map(([, entry]) => entry).sort((left, right) => Number(right.xpInGroup || 0) - Number(left.xpInGroup || 0)).slice(0, 5) : [];

  return <div className="groups-page">
    <Card className="groups-settings-bar"><SettingRow title="群聊画像自动更新" description="根据真实群聊累计自动维护群画像。" control={<Switch checked={db.settings.groupProfileAutoUpdate !== false} onChange={(event) => saveSettings({ groupProfileAutoUpdate: event.target.checked })} disabled={false} />} /><NumberInput label="更新阈值" min={20} max={500} value={db.settings.groupProfileThreshold || 80} suffix="条" onChange={(value) => saveSettings({ groupProfileThreshold: value })} /></Card>
    {operationError && <ErrorState title="操作失败" message={operationError} />}
    <div className="groups-workspace">
      <Card className="groups-list-panel"><SectionHeader eyebrow="Runtime / Groups" title={`已配置群 · ${groups.length}`} actions={<Button size="sm" variant="primary" icon={Plus} onClick={startCreate}>添加群</Button>} /><div className="groups-filter"><div className="groups-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索群名、群号或活跃成员" /></div><SegmentedControl value={sortBy} onChange={setSortBy} label="群排序" options={sortOptions} /></div><div className="groups-list">{visibleGroups.map((group) => {
        const counts = groupCounts(group.groupId);
        const profile = (db.groupProfiles || []).find((item) => String(item.groupId) === String(group.groupId));
        const avatarUrl = group.avatarUrl || group.avatar_url || '';
        return <ListRow key={group.groupId} selected={!creating && String(selectedId) === String(group.groupId)} onClick={() => selectGroup(group)} leading={<GroupAvatar src={avatarUrl} name={displayName(group)} />} title={displayName(group)} subtitle={`${group.groupId} · ${counts.policies} 策略成员 · ${counts.memories} 记忆成员`} trailing={<ChevronRight size={16} />}><span className="groups-list__pills"><Pill tone={group.enabled ? 'success' : 'danger'}>{group.enabled ? '启用' : '停用'}</Pill><Pill tone="accent">{modeLabel(group.mode)}</Pill>{profile && hasProfileContent(profile) && <Pill>画像</Pill>}</span></ListRow>;
      })}{groups.length === 0 && <EmptyState title="还没有白名单群" description="添加一个群后，可以配置参与模式、画像和外部 Bot。" action={<Button variant="primary" icon={Plus} onClick={startCreate}>添加第一个群</Button>} />}{groups.length > 0 && visibleGroups.length === 0 && <EmptyState title="没有匹配的群" description="换个群号、备注或活跃成员再试。" />}</div></Card>

      <div className="groups-detail-panel">
        {(creating || selectedGroup) && <Card className="groups-editor"><SectionHeader eyebrow={creating ? 'New Group' : `Group ${selectedGroup.groupId}`} title={creating ? '添加白名单群' : displayName(selectedGroup)} description={creating ? '创建群配置后才会开始处理这个群的消息。' : `${modeLabel(selectedGroup.mode)} · 每小时 ${selectedGroup.maxPerHour || 0} 次 · 冷却 ${selectedGroup.cooldownSec || 0} 秒`} actions={!creating && <Button size="sm" variant={selectedGroup.enabled ? 'warning' : 'primary'} onClick={toggleGroupEnabled} loading={pending === 'save-group'}>{selectedGroup.enabled ? '停用群' : '启用群'}</Button>} />
          {!creating && <div className="groups-summary"><Pill tone={selectedGroup.enabled ? 'success' : 'danger'}>{selectedGroup.enabled ? 'Enabled' : 'Disabled'}</Pill><Pill>{selectedCounts.policies} 个成员策略</Pill><Pill>{selectedCounts.memories} 个记忆成员</Pill>{selectedNames.length > 0 && <Pill tone="accent">最近：{selectedNames.join('、')}</Pill>}</div>}
          {!creating && selectedLatest && <p className="groups-last-activity"><MessageCircle size={14} />最后活跃 · {selectedLatest.role === 'assistant' ? '机器人' : selectedLatest.nickname || selectedLatest.userId} · {new Date(selectedLatest.createdAt).toLocaleString('zh-CN')}</p>}
          <div className="groups-form-grid"><Input label="QQ群号" value={form.groupId || ''} onChange={(event) => setForm({ ...form, groupId: event.target.value })} /><Input label="群名称 / 备注" value={form.name || ''} onChange={(event) => setForm({ ...form, name: event.target.value })} hint="不填时会使用最近活跃成员辅助辨认。" /><Select label="回复模式" value={form.mode || 'mention'} onChange={(event) => setForm({ ...form, mode: event.target.value })} options={modeOptions} /><Input label="每小时最多回复" type="number" min="1" max="80" value={form.maxPerHour ?? 20} onChange={(event) => setForm({ ...form, maxPerHour: Number(event.target.value) })} /><Input label="发言冷却（秒）" type="number" min="0" max="180" value={form.cooldownSec ?? 30} onChange={(event) => setForm({ ...form, cooldownSec: Number(event.target.value) })} /><Switch checked={Boolean(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} label="启用这个群" /></div>
          <div className="groups-editor__actions">{recentNames(form.groupId, 2).length > 0 && !hasManualName(form) && <Button icon={WandSparkles} onClick={useSuggestedName}>使用活跃成员生成备注</Button>}<Button variant="primary" icon={Save} loading={pending === 'save-group'} disabled={!String(form.groupId || '').trim()} onClick={() => saveGroup()}>保存群设置</Button></div>
        </Card>}

        {!creating && selectedGroup && <>
          <Card><SectionHeader eyebrow="External Integrations" title="群内 Bot" description="切换时沿用现有 group-bot-config 行为。" /><div className="groups-bot-grid">{Object.entries(botNames).map(([botId, name]) => <Switch key={botId} checked={groupBots[botId] !== false} disabled={pending === `bot-${botId}`} onChange={(event) => toggleBot(botId, event.target.checked)} label={name} description={groupBots[botId] !== false ? '当前启用' : '当前停用'} />)}</div></Card>

          <Card className="groups-profile"><SectionHeader eyebrow="Context" title="群聊画像" description={selectedProfile ? (hasProfileContent(selectedProfile) ? `置信 ${Math.round(Number(selectedProfile.confidence || 0) * 100)}% · ${selectedProfile.evidenceCount || 0} 条依据` : `待生成 · 已累计 ${selectedProfile.pendingMessageCount || 0} 条`) : '当前没有群画像记录'} actions={selectedProfile && <Button size="sm" variant="ghost" onClick={() => setProfileExpanded((value) => !value)}>{profileExpanded ? '收起' : '展开'}</Button>} />{!selectedProfile ? <EmptyState title="暂无群画像" description="群画像记录建立后，生成、注入和编辑操作会显示在这里。" /> : profileExpanded && <>{profileEditing ? <div className="groups-profile__fields">{profileFields.map(([field, label]) => <Textarea key={field} label={label} rows="2" value={profileDraft[field] || ''} onChange={(event) => setProfileDraft({ ...profileDraft, [field]: event.target.value })} />)}</div> : <div className="groups-profile__content">{!hasProfileContent(selectedProfile) && <p>还没有有效群聊画像。自动更新会继续累计真实聊天，也可以手动触发更新。</p>}{selectedProfile.lastUpdateStatus === 'failed' && selectedProfile.lastUpdateError && <p className="groups-profile__error">上次更新失败：{selectedProfile.lastUpdateError}</p>}{profileFields.map(([field, label]) => selectedProfile[field] && <div key={field}><span>{label}</span><p>{selectedProfile[field]}</p></div>)}</div>}<div className="groups-profile__actions"><Button onClick={toggleProfile} loading={pending === 'profile-toggle'}>{selectedProfile.enabled !== false ? '停用注入' : '启用注入'}</Button>{profileEditing ? <><Button variant="primary" icon={Save} onClick={saveProfile} loading={pending === 'profile-save'}>保存画像</Button><Button onClick={() => { setProfileEditing(false); setProfileDraft({ ...selectedProfile }); }}>取消</Button></> : <><Button onClick={() => { setProfileDraft({ ...selectedProfile }); setProfileEditing(true); }}>手动编辑</Button><Button icon={RefreshCw} onClick={updateProfile} loading={pending === 'profile-update'}>LLM 更新</Button><Button variant="danger-ghost" onClick={() => openConfirmation('clear-profile')}>清除画像</Button></>}</div></>}</Card>

          {experienceRows.length > 0 && <Card><SectionHeader eyebrow="Community" title="成员等级" description="当前群内经验最高的五名成员" /><div className="groups-experience">{experienceRows.map((entry) => {
            const experience = (db.experience || {})[entry.userId] || {};
            const user = (db.users || []).find((item) => String(item.userId) === String(entry.userId));
            return <div key={entry.userId}><UsersRound size={15} /><strong>{user?.customName || user?.nickname || entry.userId}</strong><Pill tone="accent">{levelPpLabel(experience)}</Pill></div>;
          })}</div></Card>}

          <Card className="groups-danger-zone"><SectionHeader eyebrow="Danger Zone" title="数据操作" description="这些操作会清理或永久删除已有数据。" /><div><Button variant="danger-ghost" icon={RefreshCw} onClick={() => openConfirmation('clear-context')}>清空群上下文</Button><Button variant="danger" icon={Trash2} onClick={() => openConfirmation('delete-group')}>删除群及关联数据</Button></div></Card>
        </>}
      </div>
    </div>
    <ConfirmDialog open={Boolean(confirmation)} title={confirmationCopy.title} description={confirmationCopy.description} confirmLabel={confirmationCopy.label} busy={pending.startsWith('confirm-')} onCancel={() => setConfirmation(null)} onConfirm={confirmAction} />
  </div>;
}
