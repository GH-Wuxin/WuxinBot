// 真实数据绑定（一）：运行控制 / 群聊 / 维护 / 日志
const RUNTIME = { available: false, groups: [], settings: null, error: '' };

async function refreshRuntime() {
  if (!window.desktop || !window.desktop.runtime || typeof window.desktop.runtime.getState !== 'function') {
    RUNTIME.available = false;
    return;
  }
  try {
    const state = await window.desktop.runtime.getState();
    RUNTIME.available = true;
    RUNTIME.settings = state.settings || state;
    RUNTIME.groups = state.groups || state.processGroups || [];
    RUNTIME.processes = state.processes || state.items || [];
  } catch (error) {
    RUNTIME.error = String((error && error.message) || error);
  }
}

function runtimeStatus(proc) {
  return proc.status || proc.state || (proc.running ? 'running' : 'stopped');
}

PAGES.runtime = function () {
  if (!RUNTIME.available) {
    return pageHead('运行控制', '进程由桌面端管理；在浏览器里只能看状态。', '<button class="btn" onclick="location.reload()">刷新</button>')
      + card('桌面端未连接', '<div class="note">这个页面需要 Electron 的进程管理接口（window.desktop）。在浏览器里打开时看不到进程列表。</div>');
  }
  const groups = RUNTIME.groups.length ? RUNTIME.groups : [{ label: '进程', processes: RUNTIME.processes }];
  const total = groups.reduce((sum, group) => sum + (group.processes || group.items || []).length, 0);
  const running = groups.reduce((sum, group) => sum + (group.processes || group.items || []).filter((proc) => runtimeStatus(proc) === 'running').length, 0);
  const body = groups.map(function (group) {
    const items = group.processes || group.items || [];
    return '<section class="proc-group"><div class="proc-group-head"><span class="proc-eyebrow">PROCESS GROUP</span><h2>' + esc(group.label || group.name || '进程') + '</h2><span class="muted">' + items.length + ' 个组件</span></div>'
      + items.map(function (proc) {
        const runningProc = runtimeStatus(proc) === 'running';
        const pids = proc.pids || (proc.pid ? [proc.pid] : []);
        const pidText = pids.length ? pids.slice(0, 4).join(', ') + (pids.length > 4 ? ' …（共 ' + pids.length + ' 个）' : '') : '—';
        return '<div class="proc"><div class="proc-head"><span class="status-dot" style="background:' + (runningProc ? 'var(--mint)' : 'var(--muted)') + '"></span><b>' + esc(proc.label || proc.name || proc.id) + '</b>' + chip(runningProc ? '运行中' : '已停止', runningProc ? 'chip--mint' : '') + '</div>'
          + '<div class="proc-meta">' + (proc.managed === false ? '外部运行' : '本窗口启动') + ' · PID ' + pidText + '</div>'
          + '<div class="proc-toggles">'
          + '<span class="proc-toggle">进程启用' + switchEl(proc.enabled !== false) + '</span>'
          + '<span class="proc-toggle">参与一键启动' + switchEl(proc.oneClick !== false) + '</span>'
          + '<span class="proc-toggle">自动启动' + switchEl(proc.autoStart === true) + '</span>'
          + '</div>'
          + '<div class="proc-actions"><button class="btn btn-sm" data-proc="start" data-id="' + esc(proc.id) + '">启动</button>'
          + '<button class="btn btn-sm" data-proc="stop" data-id="' + esc(proc.id) + '">停止</button>'
          + '<button class="btn btn-sm" data-proc="restart" data-id="' + esc(proc.id) + '">重启</button>'
          + '<button class="btn btn-sm btn-ghost" onclick="openProc(\'' + esc(proc.label || proc.id) + '\')">配置</button></div></div>';
      }).join('') + '</section>';
  }).join('');
  return pageHead('运行控制', '这台机器上真正在跑的进程，直接来自桌面端。', '<button class="btn btn-primary" data-proc="start-all">一键启动</button><button class="btn" data-proc="stop-all">全部停止</button>')
    + grid4(['组件|' + total + '|本窗口管理', '运行中|' + running + '|实时状态', '进程数|' + groups.reduce((sum, g) => sum + (g.processes || g.items || []).reduce((n, p) => n + ((p.pids || []).length || 1), 0), 0) + '|含子进程', '外部运行|1|WuxinBot 自身'])
    + body;
};

PAGES.groups = function () {
  const rows = DATA.groupRows;
  if (!rows.length) {
    return pageHead('群聊', '还没有配置任何群。', '<button class="btn btn-primary" data-group="add">添加群</button>')
      + card('空', '<div class="note">在群里发一条消息，或点右上角添加群。</div>');
  }
  const current = rows.filter((row) => String(row.id) === String(selectedGroupId))[0] || rows[0];
  const list = rows.map(function (group) {
    const active = String(group.id) === String(current.id);
    return '<div class="row group-row' + (active ? ' is-selected' : '') + '" onclick="selectGroup(\'' + group.id + '\')">'
      + avatar((group.name || '?').slice(0, 1), 30)
      + '<div class="row-main"><div class="row-title">' + esc(group.name) + '</div><div class="row-sub">' + group.id + ' · ' + group.members + ' 位成员 ' + chip(group.mode) + '</div></div>'
      + '<button class="switch ' + (group.enabled ? 'is-on' : '') + '" data-group-toggle="' + group.id + '" aria-label="启用"></button></div>';
  }).join('');
  return pageHead('群聊', '左边选群，右边看这个群的策略。', '<button class="btn btn-primary" data-group="add">添加群</button>')
    + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">搜索</span><input id="groupSearch" placeholder="群名或群号" />' + chip(rows.length + ' 个群') + '</div>'
    + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">已配置群</span><span class="muted" style="font-size:12px">点击切换</span></div><div class="rows" id="groupList">' + list + '</div></div>'
    + '<div class="stack"><div class="card"><div class="card-head"><span class="card-title">' + esc(current.name) + '</span>' + chip(current.enabled ? '启用中' : '已停用', current.enabled ? 'chip--mint' : 'chip--amber') + '</div>'
    + '<div class="note" style="margin-bottom:12px">' + current.id + ' · ' + current.members + ' 位成员</div>'
    + kv('回复模式', current.mode) + kv('每小时上限', (current.maxPerHour || '—') + ' 条') + kv('发言冷却', (current.cooldown || '—') + ' 秒')
    + '<div class="field" style="margin-top:14px"><label>每小时上限</label><input id="groupMax" type="number" value="' + (current.maxPerHour || 0) + '" /></div>'
    + '<div class="field"><label>发言冷却（秒）</label><input id="groupCooldown" type="number" value="' + (current.cooldown || 0) + '" /></div>'
    + '<div style="display:flex;gap:8px"><button class="btn btn-primary" style="flex:1" data-group-save="' + current.id + '">保存</button>'
    + '<button class="btn" data-group-delete="' + current.id + '">删除群</button></div></div>'
    + card('群画像', '<div id="groupProfileBody" class="note">加载中…</div>', '<span style="cursor:pointer" data-group-profile="' + current.id + '">刷新</span>')
    + '</div></div>';
};

PAGES.logs = function () {
  const traces = LIVE.traces || [];
  const items = traces.slice(0, 30).map(function (trace, index) {
    const time = fmtClock(trace.startedAt);
    const who = trace.nickname || trace.userId || '未知';
    const text = (trace.content || trace.text || '').slice(0, 60) || trace.messageId || '';
    return '<div class="log-item ' + (index === 0 ? 'is-active' : '') + '" data-trace="' + index + '">'
      + '<div style="display:flex;justify-content:space-between"><span class="log-user">' + esc(who) + '</span>' + chip(trace.status === 'completed' ? '已回复' : (trace.status || '处理中'), trace.status === 'completed' ? 'chip--mint' : 'chip--amber') + '</div>'
      + '<div class="log-text">' + esc(text) + '</div>'
      + '<div class="log-time">' + time + ' · ' + esc(trace.groupId || '') + ' · ' + esc(trace.id || '') + '</div></div>';
  }).join('');
  return pageHead('日志', '最近的请求轨迹，来自 /api/request-traces。', '<button class="btn btn-ghost" onclick="refreshTraces()">刷新</button>' + chip('实时', 'chip--mint'))
    + '<div class="logs"><div class="card"><div class="card-head"><span class="card-title">最近请求</span><span class="muted" style="font-size:12px">' + traces.length + ' 条</span></div><div class="rows" id="logList">' + (items || '<div class="empty">暂无请求记录</div>') + '</div></div>'
    + '<div class="card" id="traceDetail"><div class="card-head"><span class="card-title">选择左侧一条查看详情</span></div><div class="note">请求轨迹包含判定、工具调用和回复结果。</div></div></div>';
};

window.refreshTraces = async function () {
  await loadTraces();
  render('logs');
};
