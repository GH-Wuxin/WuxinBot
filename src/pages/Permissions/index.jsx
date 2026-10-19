import React, { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ui/index.jsx';

// 版式对齐原型 PAGES.permissions：命令 × 角色矩阵表；保留原有的「命令最低权限」模型。
const commandLabels = {
  help: '查看帮助 /w help', ping: '在线检测 /w ping', why: '诊断 /w why', summarize: '群聊总结 /w summarize 5-99', summarizeLarge: '长群聊总结 /w summarize 100+', status: '查看群参数 /w status', rate: '每小时次数 /w rate', cooldown: '发言冷却 /w cooldown', mode: '回复模式 /w mode', preset: '场景预设 /w preset', modelShow: '查看模型 /w model show/list', modelSet: '切换模型 /w model · 纯人设 /w sysfacts', search: '联网搜索 /w search', thinking: '思考提示 /w thinking', pause: '暂停/恢复 /w pause resume', profile: '画像管理 /w profile', profileRetry: '画像定向重算 /w profile retry', groupProfileShow: '查看群画像 /w group profile show', groupProfileEdit: '编辑群画像 /w group profile update', relationshipShow: '查看关系画像 /w relation show', relationshipEdit: '编辑关系画像 /w relation update', promptShow: '查看提示词 /w prompt show', promptEdit: '修改提示词 /w prompt add/set/reset', promptSavebase: '保存提示词基准 /w prompt savebase', groupAdd: '添加活跃群聊 /w group add', note: '成员备注 /w note', memberPolicy: '成员管理 /w op/ban/trust... · /w refresh',
};
const matrixRoles = [
  { id: 'guest', label: '群员' },
  { id: 'admin', label: '管理' },
  { id: 'owner', label: '主人' },
];

export function PermissionsPage({ db, saveSettings, refreshState }) {
  const [roles, setRoles] = useState(db.settings.commandRoles || []);
  const [permissions, setPermissions] = useState(db.settings.commandPermissions || {});
  const [permSearch, setPermSearch] = useState('');
  const [roleToRemove, setRoleToRemove] = useState(null);
  const [dirty, setDirty] = useState(false);
  const sortedRoles = [...roles].sort((left, right) => Number(left.level) - Number(right.level));
  const roleOptions = sortedRoles.map((role) => ({ value: role.id, label: `${role.name} Lv.${role.level}` }));
  const levelOf = (id) => {
    if (id === 'owner') return 100;
    const role = sortedRoles.find((entry) => entry.id === id);
    return role ? Number(role.level || 0) : 0;
  };
  const allowed = (commandKey, roleId) => levelOf(permissions[commandKey] || 'owner') <= levelOf(roleId);

  useEffect(() => {
    if (dirty) return;
    setRoles(db.settings.commandRoles || []);
    setPermissions(db.settings.commandPermissions || {});
  }, [db.settings.commandRoles, db.settings.commandPermissions, dirty]);

  const updateRole = (id, patch) => { setDirty(true); setRoles((current) => current.map((role) => role.id === id ? { ...role, ...patch } : role)); };
  const addRole = () => { setDirty(true); setRoles((current) => [...current, { id: `role_${Date.now()}`, name: 'New Role', level: 40, locked: false }]); };
  const removeRole = (id) => {
    const role = roles.find((entry) => entry.id === id);
    if (!role || role.locked) return;
    setDirty(true);
    setRoles((current) => current.filter((entry) => entry.id !== id));
    setPermissions((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value === id ? 'guest' : value])));
  };
  const save = async () => {
    const cleanRoles = roles.map((role) => ({ id: role.id, name: String(role.name || role.id).trim() || role.id, level: Math.max(0, Math.min(100, Number(role.level || 0))), locked: Boolean(role.locked) }));
    await saveSettings({ commandRoles: cleanRoles, commandPermissions: permissions });
    setDirty(false);
    await refreshState();
  };
  const filteredCommands = Object.entries(commandLabels).filter(([key, label]) => !permSearch.trim() || label.includes(permSearch.trim()) || key.includes(permSearch.trim().toLowerCase()));

  return <>
    <div className="page-head">
      <div><h1>权限</h1><p>谁能用哪条命令，按群和身份分开。</p></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={!dirty} onClick={save}>保存权限</button>
      </div>
    </div>

    <div className="searchbar" style={{ marginBottom: 16 }}>
      <span className="muted">搜索</span>
      <input value={permSearch} onChange={(event) => setPermSearch(event.target.value)} placeholder="搜索指令，例如 model / 搜索 / 画像" aria-label="搜索指令" />
      <span className="chip">{filteredCommands.length} 条指令</span>
    </div>

    <div className="card">
      <table className="table">
        <thead><tr><th>命令</th><th>说明</th><th>最低权限</th><th>群员</th><th>管理</th><th>主人</th></tr></thead>
        <tbody>
          {filteredCommands.map(([key, label]) => <tr key={key}>
            <td><b>{key}</b></td>
            <td className="muted">{label}</td>
            <td>
              <select
                aria-label={`${label} 最低权限`}
                value={permissions[key] || 'owner'}
                onChange={(event) => { setDirty(true); setPermissions((current) => ({ ...current, [key]: event.target.value })); }}
                style={{ background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 8, color: 'var(--text)', padding: '5px 8px', fontSize: 12 }}
              >
                {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </td>
            {matrixRoles.map((role) => <td key={role.id}>{allowed(key, role.id) ? <span className="pink">✓</span> : <span className="muted">—</span>}</td>)}
          </tr>)}
          {!filteredCommands.length && <tr><td colSpan="6" className="muted">没有匹配的指令。</td></tr>}
        </tbody>
      </table>
      <div className="note" style={{ marginTop: 12 }}>改完立刻生效；对已在进行中的请求无效。主人始终保留完整权限。</div>
    </div>

    <div className="grid grid-2" style={{ marginTop: 16, alignItems: 'start' }}>
      <div className="card">
        <div className="card-head"><span className="card-title">指令用户组</span><span className="muted" style={{ fontSize: 12 }}>等级越高，权限越大</span></div>
        <div className="rows">
          {sortedRoles.map((role) => <div className="row" key={role.id}>
            <div className="row-main">
              <input
                aria-label={`${role.name} 用户组名称`}
                value={role.name}
                onChange={(event) => updateRole(role.id, { name: event.target.value })}
                style={{ background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontWeight: 650, padding: 0, width: '100%' }}
              />
              <div className="row-sub">{role.locked ? '基础组' : role.id}</div>
            </div>
            <input
              aria-label={`${role.name} 权限等级`}
              type="number"
              min="0"
              max="100"
              value={role.level}
              onChange={(event) => updateRole(role.id, { level: Number(event.target.value) })}
              style={{ width: 64, background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 8, color: 'var(--text)', padding: '5px 8px', textAlign: 'right' }}
            />
            {!role.locked && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setRoleToRemove(role); }}>删除</button>}
          </div>)}
        </div>
        <button type="button" className="btn btn-sm" style={{ marginTop: 12 }} onClick={addRole}>添加用户组</button>
      </div>

      <div className="card">
        <div className="card-head"><span className="card-title">矩阵口径</span></div>
        <div className="note">
          表格里的 ✓ 表示该角色的等级不低于这条指令要求的最低权限。修改「最低权限」会实时改变右侧三列的显示，点右上角「保存权限」写回服务端。
        </div>
        <div className="kv"><span>用户组</span><b>{sortedRoles.length} 个</b></div>
        <div className="kv"><span>指令</span><b>{Object.keys(commandLabels).length} 条</b></div>
        <div className="kv"><span>未保存改动</span><b>{dirty ? '有' : '无'}</b></div>
      </div>
    </div>
    <ConfirmDialog
      open={Boolean(roleToRemove)}
      title="删除用户组？"
      description={roleToRemove ? `删除「${roleToRemove.name}」后，已使用这个组的指令会改成普通群员。` : ""}
      confirmLabel="删除用户组"
      onCancel={() => setRoleToRemove(null)}
      onConfirm={() => { const target = roleToRemove; setRoleToRemove(null); if (target) removeRole(target.id); }}
    />
  </>;
}
