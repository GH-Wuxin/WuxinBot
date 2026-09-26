import React, { useState } from 'react';
import { Save, Search, ShieldCheck, Trash2, UserRoundCog } from 'lucide-react';
import { Button, Card, EmptyState, Input, Pill, SectionHeader, Select, Slider, Switch, Textarea } from '../../components/ui/index.jsx';
import { api } from '../../lib/api.js';

const policyLabels = {
  normal: '正常', whitelist: '优先回应', priority: '重点关注', muted: '少回应', blocked: '不回应', admin: '管理员', owner: '所有者',
};
const policyOptions = Object.entries(policyLabels).map(([value, label]) => ({ value, label }));
const levelPpLabel = (experience) => `${Math.floor(Number(experience?.xp || 0) / 100) * 100}pp`;

export function MembersPage({ db, refreshState }) {
  const firstGroup = db.groups?.[0]?.groupId || '';
  const groupMap = Object.fromEntries((db.groups || []).map((group) => [String(group.groupId), group.name || group.groupId]));
  const memories = db.memories || [];
  const messages = db.messages || [];
  const experience = db.experience || {};
  const [form, setForm] = useState({ groupId: firstGroup, userId: '', nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, commandRoleId: '', note: '', customPrompt: '' });
  const [search, setSearch] = useState('');
  const [filterPolicy, setFilterPolicy] = useState('all');
  const [filterGroup, setFilterGroup] = useState('all');
  const [sortBy, setSortBy] = useState('recent');
  const [saving, setSaving] = useState(false);

  const displayName = (user) => {
    if (user.nickname && user.nickname !== user.userId) return user.nickname;
    const matchingMessages = messages.filter((message) => String(message.userId) === String(user.userId) && message.nickname && message.nickname !== String(user.userId));
    if (matchingMessages.length) return matchingMessages[matchingMessages.length - 1].nickname;
    return memories.find((memory) => String(memory.userId) === String(user.userId) && memory.nickname && memory.nickname !== String(user.userId))?.nickname || user.userId;
  };

  const recentSignal = (user) => {
    const latest = messages.filter((message) => String(message.userId) === String(user.userId)).slice(-1)[0];
    const memory = memories.find((entry) => String(entry.userId) === String(user.userId));
    const parts = [];
    if (latest) parts.push(`最后活跃：${groupMap[String(latest.groupId)]} ${new Date(latest.createdAt).toLocaleDateString('zh-CN')}`);
    else if (memory?.lastProfiledAt) parts.push(`最后画像：${new Date(memory.lastProfiledAt).toLocaleDateString('zh-CN')}`);
    if (memory?.summary) parts.push(`记忆：${memory.summary.slice(0, 38)}`);
    return parts.join(' · ');
  };

  const badges = (user) => {
    const values = [];
    if (user.policy === 'admin') values.push({ label: '管理', tone: 'warning' });
    if (user.policy === 'blocked') values.push({ label: '黑名单', tone: 'danger' });
    if (user.policy === 'priority') values.push({ label: '重点关注', tone: 'accent' });
    if (user.allowCommands) values.push({ label: '指令', tone: 'success' });
    if (user.note) values.push({ label: '备注', tone: 'neutral' });
    if (user.customPrompt) values.push({ label: '定制', tone: 'accent' });
    if (memories.some((memory) => String(memory.userId) === String(user.userId) && memory.enabled !== false && (memory.summary || memory.traits))) values.push({ label: '记忆', tone: 'success' });
    const exp = experience[String(user.userId)];
    if (exp) values.push({ label: levelPpLabel(exp), tone: Number(exp.xp || 0) >= 300 ? 'accent' : 'neutral' });
    return values;
  };

  let users = (db.users || []).filter((user) => {
    if (filterGroup !== 'all' && String(user.groupId) !== filterGroup) return false;
    if (filterPolicy !== 'all' && user.policy !== filterPolicy) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return displayName(user).toLowerCase().includes(query) || String(user.userId).includes(query) || (user.note || '').toLowerCase().includes(query);
  });
  if (sortBy === 'recent') {
    users = [...users].sort((left, right) => {
      const last = (user) => messages.filter((message) => String(message.userId) === String(user.userId)).slice(-1)[0];
      return new Date(last(right)?.createdAt || 0).getTime() - new Date(last(left)?.createdAt || 0).getTime();
    });
  } else if (sortBy === 'policy') {
    const order = { blocked: 0, muted: 1, normal: 2, whitelist: 3, priority: 4, admin: 5, owner: 6 };
    users = [...users].sort((left, right) => (order[right.policy] || 0) - (order[left.policy] || 0));
  } else {
    users = [...users].sort((left, right) => (right.attentionLevel || 3) - (left.attentionLevel || 3));
  }

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/users', { method: 'POST', body: form });
      setForm({ ...form, userId: '', nickname: '', policy: 'normal', attentionLevel: 3, allowCommands: false, commandRoleId: '', note: '', customPrompt: '' });
      await refreshState();
    } finally {
      setSaving(false);
    }
  };

  const removePolicy = async (user) => {
    if (!window.confirm(`删除 ${user.nickname || user.userId} 的成员策略？删除后会按普通用户处理。`)) return;
    await api(`/api/users/${user.groupId}/${user.userId}`, { method: 'DELETE' });
    await refreshState();
  };

  const groupOptions = [{ value: 'all', label: '全部群' }, ...(db.groups || []).map((group) => ({ value: String(group.groupId), label: group.name || String(group.groupId) }))];
  const commandRoleOptions = [{ value: '', label: '自动（按成员策略）' }, ...(db.settings.commandRoles || []).map((role) => ({ value: role.id, label: `${role.name} Lv.${role.level}` }))];

  return <div className="console-page members-page">
    <SectionHeader eyebrow="Context / Members" title="成员策略" description="为特定群成员设置回应策略、注意力和指令权限；没有策略的成员继续使用群默认行为。" />
    <div className="members-workspace">
      <Card className="console-section members-editor">
        <div className="console-section__title"><UserRoundCog size={18} /><div><h3>{form.userId ? '编辑成员策略' : '添加成员策略'}</h3><p>保存后写入现有 users 数据。</p></div></div>
        <div className="console-form-grid">
          <Input label="群号" value={form.groupId || ''} onChange={(event) => setForm({ ...form, groupId: event.target.value })} />
          <Input label="用户 QQ 号" value={form.userId || ''} onChange={(event) => setForm({ ...form, userId: event.target.value })} />
          <Input label="备注昵称" value={form.nickname || ''} onChange={(event) => setForm({ ...form, nickname: event.target.value })} />
          <Select label="回应策略" value={form.policy || 'normal'} onChange={(event) => setForm({ ...form, policy: event.target.value })} options={policyOptions} />
        </div>
        <Slider label="注意力等级" min={1} max={5} value={form.attentionLevel || 3} onChange={(attentionLevel) => setForm({ ...form, attentionLevel })} />
        <Switch label="允许管理指令" description="仍受指令用户组限制" checked={form.allowCommands === true} onChange={(event) => setForm({ ...form, allowCommands: event.target.checked })} />
        <Select label="指令用户组" value={form.commandRoleId || ''} onChange={(event) => setForm({ ...form, commandRoleId: event.target.value })} options={commandRoleOptions} />
        <Input label="备注" value={form.note || ''} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        <Textarea label="定制提示词" hint="可选；描述机器人对这位成员的特别态度。" rows={4} placeholder="例如：对这个群友可以更随意一些，偶尔开开玩笑。" value={form.customPrompt || ''} onChange={(event) => setForm({ ...form, customPrompt: event.target.value })} />
        <div className="console-actions console-actions--end"><Button variant="primary" icon={Save} loading={saving} disabled={!String(form.groupId).trim() || !String(form.userId).trim()} onClick={save}>保存成员策略</Button></div>
      </Card>

      <Card className="console-section members-list-panel">
        <div className="console-section__title"><ShieldCheck size={18} /><div><h3>已设置成员 · {users.length}</h3><p>筛选只影响当前视图。</p></div></div>
        <div className="console-toolbar members-toolbar">
          <span className="console-search"><Search size={15} /><input aria-label="搜索成员" placeholder="搜索昵称、QQ 或备注" value={search} onChange={(event) => setSearch(event.target.value)} /></span>
          <Select value={filterGroup} onChange={(event) => setFilterGroup(event.target.value)} options={groupOptions} />
          <Select value={filterPolicy} onChange={(event) => setFilterPolicy(event.target.value)} options={[{ value: 'all', label: '全部策略' }, ...policyOptions]} />
          <Select value={sortBy} onChange={(event) => setSortBy(event.target.value)} options={[{ value: 'recent', label: '最近活跃' }, { value: 'policy', label: '策略优先级' }, { value: 'level', label: '注意力等级' }]} />
        </div>
        <div className="console-list members-list">
          {users.map((user) => {
            const name = displayName(user);
            const role = user.commandRoleId && (db.settings.commandRoles || []).find((entry) => entry.id === user.commandRoleId);
            return <article className="console-list-item member-row" key={`${user.groupId}-${user.userId}`}>
              <div className="member-row__identity"><strong>{name}</strong><span>{name !== String(user.userId) ? `QQ ${user.userId} · ` : ''}{groupMap[String(user.groupId)] || user.groupId}</span></div>
              <div className="member-row__body"><div className="console-pills">{badges(user).map((badge) => <Pill key={badge.label} tone={badge.tone}>{badge.label}</Pill>)}</div><p>{policyLabels[user.policy] || user.policy}{role ? ` · ${role.name}` : ''} · 注意力 {user.attentionLevel || 3}{user.note ? ` · ${user.note}` : ''}</p>{recentSignal(user) && <small>{recentSignal(user)}</small>}</div>
              <div className="console-actions"><Button size="sm" onClick={() => setForm({ ...user })}>编辑</Button><Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => removePolicy(user)}>删除</Button></div>
            </article>;
          })}
          {!users.length && <EmptyState title="没有匹配的成员策略" description={db.users?.length ? '调整筛选条件后再试。' : '普通群友会按群默认模式处理。'} />}
        </div>
      </Card>
    </div>
  </div>;
}
