// 真实数据绑定（四）：运行控制（IPC）、日志详情、osu! 查人
PAGES.runtime = function () {
  if (!RUNTIME.available || !(RUNTIME.processes || []).length) {
    return pageHead('运行控制', '进程由桌面端管理。', '')
      + card('桌面端未连接', '<div class="note">浏览器里看不到进程；请用 WuxinBot Desktop 打开。</div>');
  }
  const groups = {};
  RUNTIME.processes.forEach((proc) => { const key = proc.group || '进程'; (groups[key] = groups[key] || []).push(proc); });
  const total = RUNTIME.processes.length;
  const running = RUNTIME.processes.filter((proc) => proc.status === 'running').length;
  const pids = RUNTIME.processes.reduce((sum, proc) => sum + (proc.pids || []).length, 0);
  const body = Object.keys(groups).map(function (group) {
    return '<section class="proc-group"><div class="proc-group-head"><span class="proc-eyebrow">PROCESS GROUP</span><h2>' + esc(group) + '</h2><span class="muted">' + groups[group].length + ' 个组件</span></div>'
      + groups[group].map(function (proc) {
        const runningProc = proc.status === 'running';
        const pidsText = (proc.pids || []).length ? proc.pids.slice(0, 4).join(', ') + ((proc.pids || []).length > 4 ? ' …（共 ' + proc.pids.length + ' 个）' : '') : '—';
        return '<div class="proc"><div class="proc-head"><span class="status-dot" style="background:' + (runningProc ? 'var(--mint)' : 'var(--muted)') + '"></span><b>' + esc(proc.label) + '</b>'
          + chip(runningProc ? '运行中' : '已停止', runningProc ? 'chip--mint' : '') + '</div>'
          + '<div class="proc-meta">' + (proc.managed ? '本窗口启动' : '外部运行') + ' · PID ' + pidsText + ' · 端口 ' + (proc.port || '—') + '</div>'
          + '<div class="proc-toggles"><span class="proc-toggle">进程启用<button class="switch ' + (proc.enabled !== false ? 'is-on' : '') + '" data-rt-enable="' + esc(proc.id) + '"></button></span>'
          + '<span class="proc-toggle">自动启动<button class="switch ' + (proc.autoStart === true ? 'is-on' : '') + '" data-rt-auto="' + esc(proc.id) + '"></button></span></div>'
          + '<div class="proc-actions"><button class="btn btn-sm" data-rt="start" data-id="' + esc(proc.id) + '">启动</button>'
          + '<button class="btn btn-sm" data-rt="stop" data-id="' + esc(proc.id) + '">停止</button>'
          + '<button class="btn btn-sm" data-rt="restart" data-id="' + esc(proc.id) + '">重启</button>'
          + '</div></div>';
      }).join('') + '</section>';
  }).join('');
  return pageHead('运行控制', '进程状态直接来自桌面端。', '<button class="btn btn-primary" data-rt="start-all">一键启动</button><button class="btn" data-rt="stop-all">全部停止</button>')
    + grid4(['组件|' + total + '|桌面端管理', '运行中|' + running + '|实时', '进程数|' + pids + '|含子进程', '自动启动|' + RUNTIME.processes.filter((p) => p.autoStart).length + '|开机自启']) + body;
};

PAGES.logs = function () {
  const traces = LIVE.traces || [];
  const items = traces.slice(0, 40).map(function (trace, index) {
    const time = fmtClock(trace.startedAt);
    return '<div class="log-item ' + (index === 0 ? 'is-active' : '') + '" data-trace="' + index + '">'
      + '<div style="display:flex;justify-content:space-between"><span class="log-user">' + esc(trace.nickname || trace.userId) + '</span>' + chip(trace.status || '—', trace.status === 'replied' ? 'chip--mint' : 'chip--amber') + '</div>'
      + '<div class="log-text">' + esc(trace.messageId || '') + ' · ' + esc(trace.id) + '</div>'
      + '<div class="log-time">' + time + ' · ' + esc(trace.groupId) + ' · ' + (trace.eventCount || 0) + ' 个事件</div></div>';
  }).join('');
  return pageHead('日志', '请求轨迹来自 /api/request-traces。', '<button class="btn btn-ghost" data-logs-refresh="1">刷新</button>')
    + '<div class="logs"><div class="card"><div class="card-head"><span class="card-title">最近请求</span><span class="muted" style="font-size:12px">' + traces.length + ' 条</span></div>'
    + '<div class="rows" id="logList">' + (items || '<div class="empty">暂无记录</div>') + '</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title" id="traceTitle">选择一条查看时间线</span><span class="muted" style="font-size:12px" id="traceStatus"></span></div>'
    + '<div id="traceBody" class="note">左边点一条记录。</div></div></div>';
};

function renderTrace(index) {
  const trace = (LIVE.traces || [])[index];
  if (!trace) return;
  document.getElementById('traceTitle').textContent = trace.nickname || trace.userId || trace.id;
  document.getElementById('traceStatus').textContent = (trace.status || '') + ' · ' + (trace.eventCount || 0) + ' 个事件';
  const body = document.getElementById('traceBody');
  body.innerHTML = '<div class="timeline">' + (trace.events || []).map(function (event) {
    const data = event.data ? JSON.stringify(event.data) : '';
    return '<div class="tl ' + (event.status === 'error' ? 'is-warn' : 'is-ok') + '"><span class="tl-dot"></span><div>'
      + '<div class="tl-title">' + esc(event.name) + ' <span class="muted" style="font-size:11px">' + esc(event.phase) + '</span></div>'
      + '<div class="tl-sub">' + esc(fmtClock(event.at)) + (event.status ? ' · ' + esc(event.status) : '') + '</div>'
      + (data ? '<div class="tl-sub" style="opacity:.75">' + esc(data.slice(0, 160)) + '</div>' : '')
      + '</div></div>';
  }).join('') + '</div>';
}

document.addEventListener('click', function (event) {
  const traceItem = event.target.closest('[data-trace]');
  if (traceItem) {
    Array.prototype.forEach.call(document.querySelectorAll('.log-item'), (node) => node.classList.remove('is-active'));
    traceItem.classList.add('is-active');
    renderTrace(Number(traceItem.dataset.trace));
    return;
  }
  if (event.target.closest('[data-logs-refresh]')) { loadTraces().then(() => render('logs')); return; }

  const rt = event.target.closest('[data-rt]');
  if (rt) {
    event.preventDefault();
    const action = rt.dataset.rt;
    const id = rt.dataset.id;
    const runtime = window.desktop && window.desktop.runtime;
    if (!runtime) return flash('需要桌面端', 'pink');
    const run = action === 'start-all' ? runtime.startAll() : action === 'stop-all' ? runtime.stopAll()
      : action === 'start' ? runtime.start(id) : action === 'stop' ? runtime.stop(id) : runtime.restart(id);
    Promise.resolve(run).then(() => refreshRuntime()).then(() => render('runtime')).then(() => flash('已执行：' + action)).catch((error) => flash('失败：' + error.message, 'danger'));
    return;
  }
  const auto = event.target.closest('[data-rt-auto]');
  if (auto) {
    const id = auto.dataset.rtAuto;
    const proc = (RUNTIME.processes || []).find((item) => item.id === id);
    if (!proc || !window.desktop) return;
    window.desktop.runtime.updateProcess(id, { autoStart: !proc.autoStart }).then(() => refreshRuntime()).then(() => render('runtime')).then(() => flash('自动启动已切换'));
    return;
  }
  const enable = event.target.closest('[data-rt-enable]');
  if (enable) {
    const id = enable.dataset.rtEnable;
    const proc = (RUNTIME.processes || []).find((item) => item.id === id);
    if (!proc || !window.desktop) return;
    window.desktop.runtime.updateProcess(id, { enabled: proc.enabled === false }).then(() => refreshRuntime()).then(() => render('runtime')).then(() => flash('启用状态已切换'));
  }
}, true);
