import React, { useEffect, useState } from 'react';
import { KeyRound, Plus, Save, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Card, EmptyState, Input, Pill, SectionHeader, Select, Slider } from '../../components/ui/index.jsx';

const commandLabels = {
  help: '查看帮助 /w help', ping: '在线检测 /w ping', why: '诊断 /w why', summarize: '群聊总结 /w summarize 5-99', summarizeLarge: '长群聊总结 /w summarize 100+', usage: '用量费用 /w usage', status: '查看群参数 /w status', rate: '每小时次数 /w rate', cooldown: '发言冷却 /w cooldown', mode: '回复模式 /w mode', preset: '场景预设 /w preset', modelShow: '查看模型 /w model show/list', modelSet: '切换模型 /w model · 纯人设 /w sysfacts', search: '联网搜索 /w search', thinking: '思考提示 /w thinking', pause: '暂停/恢复 /w pause resume', profile: '画像管理 /w profile', profileRetry: '画像定向重算 /w profile retry', groupProfileShow: '查看群画像 /w group profile show', groupProfileEdit: '编辑群画像 /w group profile update', relationshipShow: '查看关系画像 /w relation show', relationshipEdit: '编辑关系画像 /w relation update', promptShow: '查看提示词 /w prompt show', promptEdit: '修改提示词 /w prompt add/set/reset', promptSavebase: '保存提示词基准 /w prompt savebase', groupAdd: '添加活跃群聊 /w group add', note: '成员备注 /w note', memberPolicy: '成员管理 /w op/ban/trust... · /w refresh',
};

export function PermissionsPage({ db, saveSettings, refreshState }) {
  const [roles, setRoles] = useState(db.settings.commandRoles || []);
  const [permissions, setPermissions] = useState(db.settings.commandPermissions || {});
  const [permSearch, setPermSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  const sortedRoles = [...roles].sort((left, right) => Number(left.level) - Number(right.level));
  const roleOptions = sortedRoles.map((role) => ({ value: role.id, label: `${role.name} Lv.${role.level}` }));

  useEffect(() => {
    if (dirty) return;
    setRoles(db.settings.commandRoles || []);
    setPermissions(db.settings.commandPermissions || {});
  }, [db.settings.commandRoles, db.settings.commandPermissions, dirty]);

  const updateRole = (id, patch) => { setDirty(true); setRoles((current) => current.map((role) => role.id === id ? { ...role, ...patch } : role)); };
  const addRole = () => { setDirty(true); setRoles((current) => [...current, { id: `role_${Date.now()}`, name: 'New Role', level: 40, locked: false }]); };
  const removeRole = (id) => {
    const role = roles.find((entry) => entry.id === id);
    if (!role || role.locked || !window.confirm(`删除用户组“${role.name}”？已使用这个组的指令会改成普通群员。`)) return;
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

  return <div className="console-page permissions-page">
    <SectionHeader eyebrow="System / Permissions" title="指令权限" description="定义指令用户组和每条指令需要的最低权限；Owner 永远保留完整权限。" actions={<Button variant="primary" icon={Save} onClick={save} disabled={!dirty}>保存权限设置</Button>} />
    <div className="permissions-workspace">
      <Card className="console-section permissions-roles">
        <div className="console-section__title"><ShieldCheck size={18} /><div><h3>指令用户组</h3><p>等级越高，权限越大。</p></div></div>
        <div className="console-list role-list">{sortedRoles.map((role) => <article className="console-list-item role-row" key={role.id}>
          <header><Input aria-label={`${role.name} 用户组名称`} value={role.name} onChange={(event) => updateRole(role.id, { name: event.target.value })} /><Pill tone={role.locked ? 'success' : 'neutral'}>{role.locked ? '基础组' : role.id}</Pill></header>
          <Slider label="权限等级" min={0} max={100} value={role.level} onChange={(level) => updateRole(role.id, { level })} />
          {!role.locked && <div className="console-actions console-actions--end"><Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => removeRole(role.id)}>删除用户组</Button></div>}
        </article>)}</div>
        <Button icon={Plus} onClick={addRole}>添加用户组</Button>
      </Card>

      <Card className="console-section permissions-command-card">
        <div className="console-section__title"><KeyRound size={18} /><div><h3>指令最低权限 · {filteredCommands.length}</h3><p>选择每条指令最低需要的用户组。</p></div></div>
        <span className="console-search"><Search size={15} /><input aria-label="搜索指令" placeholder="搜索指令" value={permSearch} onChange={(event) => setPermSearch(event.target.value)} /></span>
        <div className="permission-command-list">{filteredCommands.map(([key, label]) => <div className="permission-command-row" key={key}><div><strong>{label}</strong><span>{key}</span></div><Select aria-label={`${label} 最低权限`} value={permissions[key] || 'owner'} onChange={(event) => { setDirty(true); setPermissions((current) => ({ ...current, [key]: event.target.value })); }} options={roleOptions} /></div>)}{!filteredCommands.length && <EmptyState title="没有匹配的指令" />}</div>
      </Card>
    </div>
  </div>;
}
