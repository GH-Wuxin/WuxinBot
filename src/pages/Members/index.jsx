import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ui/index.jsx';
import { Avatar, groupAvatarUrl, userAvatarUrl } from '../../components/Avatar.jsx';

// 版式对齐原型 PAGES.members：成员表 + 右侧档案卡；成员来源是消息与成员策略的并集。
const policyLabels = {
  normal: '正常', whitelist: '优先回应', priority: '重点关注', muted: '少回应', blocked: '不回应', admin: '管理员', owner: '所有者',
};
const policyOptions = Object.entries(policyLabels);
const levelPpLabel = (experience) => `${Math.floor(Number(experience?.xp || 0) / 100) * 100}pp`;

export function MembersPage({ db, refreshState }) {
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [policyConfirm, setPolicyConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bindings, setBindings] = useState([]);
  const [form, setForm] = useState(null);

  const groups = db.groups || [];
  const groupMap = Object.fromEntries(groups.map((group) => [String(group.groupId), group.name || group.groupId]));
  const policies = db.users || [];
  const messages = db.messages || [];
  const experience = db.experience || {};

  useEffect(() => {
    let alive = true;
    api('/api/osu/status', { timeoutMs: 10000 })
      .then((data) => { if (alive) setBindings(Array.isArray(data?.bindings) ? data.bindings : []); })
      .catch(() => { if (alive) setBindings([]); });
    return () => { alive = false; };
  }, []);

  const bindingMap = useMemo(() => Object.fromEntries(bindings.map((binding) => [String(binding.qq), binding])), [bindings]);

  const rows = useMemo(() => {
    const map = new Map();
    const ensure = (groupId, userId) => {
      const key = `${groupId}:${userId}`;
      if (!map.has(key)) map.set(key, { key, groupId, userId, nickname: '', count: 0, lastAt: 0, policy: null });
      return map.get(key);
    };
    for (const message of messages) {
      if (!message.userId || message.role === 'assistant') continue;
      const row = ensure(String(message.groupId || ''), String(message.userId));
      row.count += 1;
      const at = new Date(message.createdAt || 0).getTime();
      if (at > row.lastAt) { row.lastAt = at; row.nickname = message.nickname || row.nickname; }
    }
    for (const policy of policies) {
      const row = ensure(String(policy.groupId), String(policy.userId));
      row.policy = policy;
      row.nickname = policy.nickname || row.nickname;
    }
    return [...map.values()].map((row) => {
      const binding = bindingMap[row.userId];
      return {
        ...row,
        name: row.nickname || row.policy?.nickname || row.userId,
        groupName: groupMap[row.groupId] || row.groupId || '—',
        policyLabel: policyLabels[row.policy?.policy] || (row.policy ? row.policy.policy : '群员'),
        osu: binding ? (binding.username || binding.id || '已绑定') : '—',
        level: levelPpLabel(experience[row.userId]),
        lastText: new Date(row.lastAt || 0).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    }).filter((row) => {
      if (!search.trim()) return true;
      const needle = search.trim().toLowerCase();
      return row.name.toLowerCase().includes(needle) || row.userId.includes(needle) || row.groupName.toLowerCase().includes(needle);
    }).sort((left, right) => right.lastAt - left.lastAt);
  }, [messages, policies, bindingMap, experience, groupMap, search]);

  const selected = rows.find((row) => row.key === selectedKey) || rows[0] || null;
  const selectedPolicy = selected?.policy || null;
  const recentMessages = useMemo(() => {
    if (!selected) return [];
    return messages
      .filter((message) => String(message.userId) === selected.userId && String(message.groupId || '') === selected.groupId)
      .slice(-4)
      .reverse();
  }, [messages, selected]);

  useEffect(() => {
    setEditing(false);
    setForm(selected ? {
      groupId: selected.groupId,
      userId: selected.userId,
      nickname: selected.policy?.nickname || selected.nickname || '',
      policy: selected.policy?.policy || 'normal',
      attentionLevel: selected.policy?.attentionLevel || 3,
      allowCommands: Boolean(selected.policy?.allowCommands),
      commandRoleId: selected.policy?.commandRoleId || '',
      note: selected.policy?.note || '',
      customPrompt: selected.policy?.customPrompt || '',
    } : null);
  }, [selectedKey]);

  const startEdit = () => {
    if (!selected) return;
    setForm({
      groupId: selected.groupId,
      userId: selected.userId,
      nickname: selected.policy?.nickname || selected.nickname || '',
      policy: selected.policy?.policy || 'normal',
      attentionLevel: selected.policy?.attentionLevel || 3,
      allowCommands: Boolean(selected.policy?.allowCommands),
      commandRoleId: selected.policy?.commandRoleId || '',
      note: selected.policy?.note || '',
      customPrompt: selected.policy?.customPrompt || '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await api('/api/users', { method: 'POST', body: form, timeoutMs: 15000 });
      setEditing(false);
      await refreshState();
    } finally {
      setSaving(false);
    }
  };

  const removePolicy = async () => {
    if (!selected?.policy) return;
    await api(`/api/users/${selected.groupId}/${selected.userId}`, { method: 'DELETE', timeoutMs: 15000 });
    setEditing(false);
    await refreshState();
  };

  const exportRows = () => {
    const header = ['昵称', 'QQ', '群', '身份', 'osu!', '等级', '消息数', '最后活跃'];
    const lines = [header, ...rows.map((row) => [row.name, row.userId, row.groupName, row.policyLabel, row.osu, row.level, row.count, row.lastText])]
      .map((cells) => cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wuxin-members-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <>
    <div className="page-head">
      <div><h1>成员</h1><p>谁在这个群里、什么身份、绑没绑 osu!。</p></div>
      <div style={{ display: 'flex', gap: 8 }}><button type="button" className="btn" onClick={exportRows}>导出</button></div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="昵称、QQ 号或群名" aria-label="搜索成员" />
      <span className="chip">{rows.length} 位成员</span>
    </div>

    <div className="grid grid-main">
      <div className="card">
        <div className="card-head"><span className="card-title">成员表</span><span className="muted" style={{ fontSize: 12 }}>按最近活跃排序</span></div>
        <div style={{ maxHeight: 620, overflowY: 'auto' }}>
          <table className="table" style={{ whiteSpace: 'nowrap' }}>
            <thead><tr><th>昵称</th><th>QQ</th><th>群</th><th>身份</th><th>osu!</th><th>消息</th></tr></thead>
            <tbody>
              {rows.map((row) => <tr
                key={row.key}
                onClick={() => setSelectedKey(row.key)}
                style={{ cursor: 'pointer', background: selected?.key === row.key ? 'var(--pink-soft)' : undefined }}
              >
                <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Avatar name={row.name} src={userAvatarUrl(row.userId)} size={24} />
                    <b>{row.name}</b>
                  </span>
                </td>
                <td className="muted">{row.userId}</td>
                <td>{row.groupName}</td>
                <td><span className={'chip' + (row.policy?.policy === 'admin' || row.policy?.policy === 'owner' ? ' chip--pink' : '')}>{row.policyLabel}</span></td>
                <td className="muted">{row.osu}</td>
                <td>{row.count.toLocaleString()}</td>
              </tr>)}
              {!rows.length && <tr><td colSpan="6" className="muted">没有匹配的成员。</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="stack">
        {selected ? <div className="card">
          <div className="card-head">
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Avatar name={selected.name} src={userAvatarUrl(selected.userId)} size={26} />
              {selected.name}
            </span>
            <span className={'chip' + (selected.policy ? ' chip--mint' : '')}>{selected.policyLabel}</span>
          </div>
          {editing && form ? <>
            <div className="field"><label>备注昵称</label><input value={form.nickname} onChange={(event) => setForm({ ...form, nickname: event.target.value })} /></div>
            <div className="field"><label>回应策略</label>
              <select value={form.policy} onChange={(event) => setForm({ ...form, policy: event.target.value })}>
                {policyOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div className="field"><label>注意力等级（1–5）</label><input type="number" min="1" max="5" value={form.attentionLevel} onChange={(event) => setForm({ ...form, attentionLevel: Number(event.target.value) })} /></div>
            <div className="row">
              <div className="row-main"><div className="row-title">允许管理指令</div><div className="row-sub">仍受指令用户组限制</div></div>
              <button type="button" className={'switch' + (form.allowCommands ? ' is-on' : '')} aria-label="允许管理指令" onClick={() => setForm({ ...form, allowCommands: !form.allowCommands })} />
            </div>
            <div className="field" style={{ marginTop: 12 }}><label>备注</label><input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div>
            <div className="field"><label>定制提示词</label><textarea rows="3" value={form.customPrompt} onChange={(event) => setForm({ ...form, customPrompt: event.target.value })} placeholder="可选；描述机器人对这位成员的特别态度" /></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setEditing(false)}>取消</button>
              <button type="button" className="btn btn-primary" style={{ flex: 1 }} disabled={saving} onClick={save}>{saving ? '保存中…' : '保存策略'}</button>
            </div>
          </> : <>
            <div className="kv"><span>QQ</span><b>{selected.userId}</b></div>
            <div className="kv"><span>群</span><b>{selected.groupName}</b></div>
            <div className="kv"><span>身份</span><b>{selected.policyLabel}</b></div>
            <div className="kv"><span>osu!</span><b>{selected.osu}</b></div>
            <div className="kv"><span>等级</span><b>{selected.level}</b></div>
            <div className="kv"><span>消息</span><b>{selected.count.toLocaleString()}</b></div>
            <div className="kv"><span>最后活跃</span><b>{selected.lastText}</b></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={startEdit}>编辑策略</button>
              {selected.policy && <button type="button" className="btn" onClick={() => setPolicyConfirm(true)}>删除策略</button>}
            </div>
          </>}
        </div> : <div className="card"><div className="note">还没有成员数据。</div></div>}

        <div className="card">
          <div className="card-head"><span className="card-title">最近动态</span><span className="muted" style={{ fontSize: 12 }}>最近 4 条</span></div>
          <div className="rows">
            {recentMessages.map((message) => <div className="row" key={message.id}>
              <div className="row-main">
                <div className="row-title" style={{ fontWeight: 500 }}>{String(message.content || '').slice(0, 60)}</div>
                <div className="row-sub">{new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
              </div>
            </div>)}
            {!recentMessages.length && <div className="note">没有可显示的消息。</div>}
          </div>
        </div>
      </div>
    </div>
    <ConfirmDialog
      open={policyConfirm}
      title="删除成员策略？"
      description={selected ? `删除 ${selected.name} 的策略后，该成员会按所在群的默认策略处理；聊天记录与画像不受影响。` : ""}
      confirmLabel="删除策略"
      onCancel={() => setPolicyConfirm(false)}
      onConfirm={() => { setPolicyConfirm(false); return removePolicy(); }}
    />
  </>;
}
