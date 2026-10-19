// 真实数据绑定（二）：其余页面 + 写操作
const DATA2 = { snapshots: [], profiles: [], logs: [], codex: null, diagnostics: null, groupProfile: null };

async function callApi(path, options) {
  const response = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || (path + ' -> ' + response.status));
  return payload;
}

async function loadTraces() {
  try {
    const payload = await callApi('/api/request-traces?limit=30');
    LIVE.traces = payload.traces || [];
  } catch (error) { LIVE.traces = []; LIVE.traceError = String(error.message || error); }
}

async function loadGroupProfile(groupId) {
  try {
    const payload = await callApi('/api/group-profiles/' + encodeURIComponent(groupId));
    DATA2.groupProfile = payload.profile || payload.data || payload;
  } catch (error) { DATA2.groupProfile = null; }
  const body = document.getElementById('groupProfileBody');
  if (!body) return;
  const profile = DATA2.groupProfile;
  if (!profile) { body.textContent = '这个群还没有生成画像。'; return; }
  body.innerHTML = readGrid([
    ['置信度', (profile.confidence != null ? Math.round(profile.confidence * (profile.confidence <= 1 ? 100 : 1)) + '%' : '—')],
    ['依据条数', String(profile.evidenceCount || profile.samples || '—')],
    ['摘要', String(profile.summary || profile.text || '—').slice(0, 80)]
  ]);
}

PAGES.maintenance = function () {
  const backups = LIVE.backups || [];
  const rows = backups.length
    ? backups.map((item) => '<tr><td class="muted">' + esc(item.at) + '</td><td>' + item.size + '</td>'
      + '<td style="text-align:right;white-space:nowrap"><button class="btn btn-ghost" style="font-size:12px" data-backup-restore="' + esc(item.name) + '">恢复</button>'
      + '<button class="btn btn-ghost" style="font-size:12px" data-backup-delete="' + esc(item.name) + '">删除</button></td></tr>').join('')
    : '<tr><td colspan="3" class="muted">暂无备份</td></tr>';
  const snapshots = (DATA2.snapshots || []).slice(0, 6).map((snap, index) =>
    '<div class="row"><div class="row-main"><div class="row-title">' + esc(snap.label || snap.reason || ('快照 #' + index)) + '</div>'
    + '<div class="row-sub">' + esc(String(snap.at || snap.createdAt || '').slice(0, 16).replace('T', ' ')) + '</div></div>'
    + '<button class="btn btn-ghost" style="font-size:12px" data-snapshot="' + index + '">恢复</button></div>').join('');
  const recalc = LIVE.recalc || { running: false, total: 0, done: 0 };
  const percent = recalc.total ? Math.round(recalc.done / recalc.total * 100) : 0;
  return pageHead('维护', '备份、恢复、重算，全部直连后台。', '<button class="btn" onclick="location.reload()">刷新</button>')
    + '<div class="grid grid-2" style="margin-bottom:16px">'
    + '<div class="card"><div class="card-head"><span class="card-title">备份</span><button class="btn" data-backup-create="1">立即备份</button></div>'
    + '<table class="table"><thead><tr><th>时间</th><th>大小</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="stack"><div class="card"><div class="card-head"><span class="card-title">重算任务</span>' + chip(recalc.running ? '运行中' : '空闲', recalc.running ? 'chip--mint' : '') + '</div>'
    + (recalc.total ? kv('进度', recalc.done + ' / ' + recalc.total) + '<div class="progress"><i style="width:' + percent + '%"></i></div>' : '<div class="note">当前没有重算任务。</div>')
    + '<div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-primary" data-recalc-start="1">全部重算</button><button class="btn" data-recalc-stop="1">停止</button></div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">配置快照</span></div><div class="rows">' + (snapshots || '<div class="empty">暂无快照</div>') + '</div></div>'
    + '</div></div>';
};

PAGES.members = function () {
  const users = LIVE.users || [];
  if (!users.length) {
    return pageHead('成员', '后台还没有成员记录；群里有消息后会自动出现。', '') + card('空', '<div class="note">当前 db.users 为空。</div>');
  }
  const rows = users.slice(0, 60).map((user) => '<tr><td><b>' + esc(user.nickname || user.userId) + '</b></td><td class="muted">' + esc(user.userId) + '</td><td>' + esc(user.groupId || '') + '</td>'
    + '<td>' + chip(user.role || '成员', user.role === 'owner' ? 'chip--pink' : '') + '</td><td class="muted">' + esc(user.osuUsername || user.osuId || '—') + '</td>'
    + '<td>' + Number(user.messageCount || 0) + '</td></tr>').join('');
  return pageHead('成员', '来自 db.users，共 ' + users.length + ' 位。', '')
    + '<div class="card"><table class="table"><thead><tr><th>昵称</th><th>QQ</th><th>群</th><th>身份</th><th>osu!</th><th>消息</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
};

PAGES.memory = function () {
  const memories = LIVE.memories || [];
  if (!memories.length) return pageHead('记忆', '还没有记忆条目。', '') + card('空', '<div class="note">当前 db.memories 为空。</div>');
  const rows = memories.slice(0, 50).map((memory) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(memory.nickname || memory.userId) + '</div>'
    + '<div class="row-sub">' + esc(String(memory.summary || '').slice(0, 70)) + '</div></div>'
    + '<button class="btn btn-ghost" style="font-size:12px" data-memory-delete="' + esc(memory.userId) + '">删除</button></div>').join('');
  return pageHead('记忆', '来自 db.memories，共 ' + memories.length + ' 条。', '')
    + '<div class="card"><div class="card-head"><span class="card-title">记忆条目</span><span class="muted" style="font-size:12px">最近 50 条</span></div><div class="rows">' + rows + '</div></div>';
};

PAGES.relationships = function () {
  const profiles = (LIVE.relationships || []).slice(0, 30);
  if (!profiles.length) return pageHead('关系', '还没有关系画像。', '') + card('空', '<div class="note">当前 relationship-profiles 为空。</div>');
  const rows = profiles.map((profile) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(profile.userA) + ' × ' + esc(profile.userB) + '</div>'
    + '<div class="row-sub">' + esc(profile.interactionStyle || profile.commonTopics || '').slice(0, 60) + '</div></div>'
    + chip(profile.enabled === false ? '停用' : '启用', profile.enabled === false ? 'chip--amber' : 'chip--mint') + '</div>').join('');
  return pageHead('关系', '来自 /api/relationship-profiles，共 ' + profiles.length + ' 对。', '')
    + '<div class="card"><div class="rows">' + rows + '</div></div>';
};

PAGES.profileLogs = function () {
  const logs = (LIVE.profileLogs || []).slice(0, 60);
  if (!logs.length) return pageHead('画像日志', '还没有画像流水。', '') + card('空', '<div class="note">当前 profile-logs 为空。</div>');
  const rows = logs.map((log) => '<tr><td class="muted">' + esc(String(log.createdAt || log.at || '').slice(5, 16).replace('T', ' ')) + '</td>'
    + '<td><b>' + esc(log.nickname || log.userId) + '</b></td><td>' + chip(log.event || '事件') + '</td>'
    + '<td>' + esc(String(log.detail || '').slice(0, 80)) + '</td></tr>').join('');
  return pageHead('画像日志', '来自 /api/profile-logs，最近 60 条。', '')
    + '<div class="card"><table class="table"><thead><tr><th>时间</th><th>成员</th><th>事件</th><th>详情</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
};

PAGES.permissions = function () {
  const perms = (LIVE.settings && LIVE.settings.commandPermissions) || {};
  const entries = Object.entries(perms);
  if (!entries.length) return pageHead('权限', '后台没有配置指令权限。', '') + card('空', '<div class="note">commandPermissions 为空。</div>');
  const rows = entries.map(([command, role]) => '<tr><td><b>' + esc(command) + '</b></td><td>' + chip(role) + '</td></tr>').join('');
  return pageHead('权限', '来自 settings.commandPermissions。', '')
    + '<div class="card"><table class="table"><thead><tr><th>指令</th><th>所需身份</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
};

PAGES.model = function () {
  const settings = LIVE.settings || {};
  return pageHead('模型', '当前配置来自 db.settings。', '')
    + '<div class="grid grid-2">' + card('账号与模型', kv('供应商', esc(settings.llmProvider || '—')) + kv('模型', esc(settings.model || '—')) + kv('API 地址', esc(settings.apiBaseUrl || '—')) + kv('API Key', settings.apiKey ? '已配置' : '未配置'))
    + card('搜索与视觉', kv('搜索供应商', esc(settings.searchProvider || '—')) + kv('视觉模型', esc(settings.visionModel || settings.model || '—')) + kv('Codex', LIVE.codex ? (LIVE.codex.loggedIn ? '已登录' : '未登录') : '未知')) + '</div>';
};

PAGES.integrations = function () {
  const bots = LIVE.osuBots || [];
  return pageHead('集成', '外部服务状态来自 /api/osu/status。', '')
    + '<div class="grid grid-2">' + card('外部 osu! bot', '<div class="rows">' + bots.map((bot) => listRow('<span class="status-dot" style="background:' + (bot.up ? 'var(--mint)' : 'var(--red)') + '"></span>', bot.id, '端口 ' + bot.port, chip(bot.up ? '在线' : '离线', bot.up ? 'chip--mint' : 'chip--amber'))).join('') + '</div>')
    + card('OneBot', kv('连接', LIVE.connected ? '已连接' : '未连接') + kv('429 计数', String(LIVE.osu429 || 0))) + '</div>';
};

PAGES.osu = function () {
  const bots = LIVE.osuBots || [];
  return pageHead('osu!', '服务与调用情况，来自 /api/osu/status。', '<button class="btn" onclick="location.reload()">刷新</button>')
    + grid4(['在线服务|' + bots.filter((b) => b.up).length + '|共 ' + bots.length + ' 个', 'API 429|' + (LIVE.osu429 || 0) + '|限流次数', '渲染服务|' + (LIVE.renderer && LIVE.renderer.listening ? '在线' : '离线') + '|yumu-image', '绑定|' + (LIVE.bindings || 0) + '|QQ → osu!'])
    + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">外部 osu! 服务</span></div><div class="rows">'
    + bots.map((bot) => listRow('<span class="status-dot" style="background:' + (bot.up ? 'var(--mint)' : 'var(--red)') + '"></span>', bot.id, '127.0.0.1:' + bot.port, chip(bot.up ? '可用' : '离线', bot.up ? 'chip--mint' : 'chip--amber'))).join('')
    + '</div></div><div class="stack">' + card('查人', '<div class="searchbar"><span class="pink">@</span><input placeholder="osu! 用户名" /><button class="btn btn-primary" onclick="notify(\'查人需要接入 /api/osu/player，下一步做\',\'pink\')">查询</button></div><div class="note" style="margin-top:10px">玩家档案接口已存在，前端抽屉还没接。</div>') + '</div></div>';
};
