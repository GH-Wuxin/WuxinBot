// 真实数据绑定（五）：osu! 查人 / 随机发图 / 人设 / Agent / 写操作
/* ---------- osu! 查人 ---------- */
async function osuSearch(name) {
  const payload = await callApi('/api/osu/search?name=' + encodeURIComponent(name));
  return payload.player;
}
async function osuPlayerTab(osuId, tab) {
  if (tab === '概览') return callApi('/api/osu/player/' + osuId);
  if (tab === 'BP') return callApi('/api/osu/player/' + osuId + '/bp?limit=10');
  if (tab === '最近') return callApi('/api/osu/player/' + osuId + '/recent?limit=10');
  if (tab === 'PP+') return callApi('/api/osu/player/' + osuId + '/pplus');
  if (tab === '类型') return callApi('/api/osu/player/' + osuId + '/bptype');
  return callApi('/api/osu/player/' + osuId + '/skill');
}
window.osuLookup = async function () {
  const input = document.getElementById('osuName');
  const name = (input && input.value.trim()) || 'Pippi';
  try {
    const player = await osuSearch(name);
    const tabs = ['概览', 'BP', '最近', 'PP+', '类型', '技能'];
    openDrawer({ title: player.username || name, sub: 'osu! #' + player.id, tabs: tabs.map((label) => ({ label, html: '<div class="note">加载中…</div>' })) });
    tabs.forEach(async (label, index) => {
      try {
        const payload = await osuPlayerTab(player.id, label);
        const data = payload.player || payload.scores || payload.bars || payload.analysis || payload;
        const html = '<div class="note" style="white-space:pre-wrap;max-height:70vh;overflow:auto">' + esc(JSON.stringify(data, null, 2)).slice(0, 6000) + '</div>';
        drawerTabsCache[index].html = html;
        if (document.querySelectorAll('.drawer-tabs button')[index]?.classList.contains('is-active')) drawerTab(index);
      } catch (error) {
        drawerTabsCache[index].html = '<div class="note">读取失败：' + esc(error.message) + '</div>';
      }
    });
  } catch (error) { flash('查不到：' + error.message, 'danger'); }
};

PAGES.osu = function () {
  const bots = LIVE.osuBots || [];
  return pageHead('osu!', '服务状态 + 查人。', '<button class="btn" onclick="location.reload()">刷新</button>')
    + grid4(['在线服务|' + bots.filter((b) => b.up).length + '|共 ' + bots.length + ' 个', 'API 429|' + (LIVE.osu429 || 0) + '|限流次数', '渲染服务|' + (LIVE.renderer && LIVE.renderer.listening ? '在线' : '离线') + '|yumu-image', '绑定|' + (LIVE.bindings || 0) + '|QQ → osu!'])
    + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">外部 osu! 服务</span></div><div class="rows">'
    + bots.map((bot) => listRow('<span class="status-dot" style="background:' + (bot.up ? 'var(--mint)' : 'var(--red)') + '"></span>', bot.id, '127.0.0.1:' + bot.port, chip(bot.up ? '可用' : '离线', bot.up ? 'chip--mint' : 'chip--amber'))).join('')
    + '</div></div><div class="stack">' + card('查人', '<div class="searchbar"><span class="pink">@</span><input id="osuName" placeholder="osu! 用户名" value="Pippi" /><button class="btn btn-primary" onclick="osuLookup()">查询</button></div><div class="note" style="margin-top:10px">抽屉里按需加载：概览 / BP / 最近 / PP+ / 类型 / 技能。</div>') + '</div></div>';
};

/* ---------- 随机发图 ---------- */
PAGES.randomImages = function () {
  const info = LIVE.randomImage;
  if (!info) return pageHead('随机发图', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/random-image</div>');
  const totals = info.totals || {};
  return pageHead('随机发图', '图池与概率来自 /api/random-image。', '')
    + grid4(['图池|' + ((info.pool && info.pool.count) || 0) + '|张', '参与群|' + ((info.groups || []).length) + '|个', '今日发送|' + (totals.sent || 0) + '|次', '总开关|' + (info.config && info.config.enabled ? '开' : '关') + '|全局'])
    + '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">图池预览</span><span class="muted" style="font-size:12px">' + esc((info.pool && info.pool.dir) || '') + '</span></div><div class="grid-tiles">'
    + (LIVE.randomFiles || []).slice(0, 24).map((file) => '<div class="tile" style="padding:0;overflow:hidden"><img src="' + (location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '') + '/api/random-image/file?name=' + encodeURIComponent(file) + '" style="width:100%;height:100%;object-fit:cover" alt="" /></div>').join('')
    + '</div></div>'
    + '<div class="grid grid-2">' + card('最近发送', '<div class="rows">' + ((info.recent || []).slice(0, 8).map((item) => listRow('', esc(item.file || item.name || '—'), esc(item.groupId || ''), '<span class="row-value" style="color:var(--muted)">' + esc(fmtClock(item.at)) + '</span>')).join('') || '<div class="empty">暂无</div>') + '</div>')
    + card('参与群', '<div class="rows">' + ((info.groups || []).map((group) => listRow('', esc(group.name || group.groupId), (group.chance != null ? (Number(group.chance) * 100).toFixed(1) + '%' : '—') + ' · 命中 ' + (group.hits || 0) + '/' + (group.rolls || 0), chip(group.participates ? '发图中' : '未开启', group.participates ? 'chip--mint' : 'chip--amber'))).join('') || '<div class="empty">暂无</div>') + '</div>') + '</div>';
};

/* ---------- 人设 ---------- */
PAGES.persona = function () {
  const studio = LIVE.persona;
  if (!studio) return pageHead('人设', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/persona/studio</div>');
  const calls = LIVE.promptCalls || [];
  const modules = studio.modules || [];
  return pageHead('人设', '模块与注入方式来自 /api/persona/studio。', '')
    + '<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">'
    + '<div class="card"><div class="card-head"><span class="card-title">人格模块</span><span class="muted" style="font-size:12px">' + modules.length + ' 个</span></div><div class="rows">'
    + modules.map((module) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(module.name) + (module.isOverridden ? chip('已覆盖', 'chip--pink') : '') + '</div>'
      + '<div class="row-sub">' + esc(module.description) + '</div></div></div>').join('')
    + '</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">最近 Prompt 调用</span><span class="muted" style="font-size:12px">' + calls.length + ' 条</span></div><div class="rows">'
    + (calls.slice(0, 12).map((call) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(call.moduleName || call.moduleId) + '</div>'
      + '<div class="row-sub">' + esc(fmtClock(call.at)) + ' · ' + esc(call.model || '') + ' · ' + esc(call.purpose || '') + '</div></div></div>').join('') || '<div class="empty">暂无</div>')
    + '</div></div></div>';
};

/* ---------- Agent ---------- */
PAGES.agent = function () {
  const diag = LIVE.diagnostics;
  const settings = LIVE.settings || {};
  if (!diag) return pageHead('Agent', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/diagnostics</div>');
  return pageHead('Agent', '运行时与诊断来自 /api/diagnostics。', '')
    + grid4(['进程|' + esc(diag.app && diag.app.node || '—') + '|Node', '群|' + ((diag.groups || []).length) + '|已配置', '记忆|' + ((diag.memories || []).length) + '|条', '用量|' + (((diag.usage || {}).totalTokens || 0) / 10000).toFixed(1) + '|万 tokens'])
    + '<div class="grid grid-2">'
    + card('运行时', kv('模型', esc(settings.model || '—')) + kv('供应商', esc(settings.llmProvider || '—')) + kv('搜索', esc(settings.searchProvider || '—')) + kv('工具结果结构化', '开启'))
    + card('准入与并发', kv('LLM 准入', JSON.stringify(diag.llmAdmission || {}).slice(0, 60)) + kv('入站队列', JSON.stringify(diag.inboundAdmission || {}).slice(0, 60)) + kv('后台任务', JSON.stringify(diag.backgroundTasks || {}).slice(0, 60)))
    + '</div>';
};

/* ---------- 写操作补充 ---------- */
document.addEventListener('click', async function (event) {
  const memoryRecalc = event.target.closest('[data-memory-recalc]');
  if (memoryRecalc) {
    event.preventDefault();
    try { await callApi('/api/memories/' + encodeURIComponent(memoryRecalc.dataset.memoryRecalc) + '/recalculate', { method: 'POST', body: '{}' }); flash('已提交重算'); }
    catch (error) { flash('重算失败：' + error.message, 'danger'); }
    return;
  }
  const memberDelete = event.target.closest('[data-member-delete]');
  if (memberDelete) {
    event.preventDefault();
    if (!confirm('删除这个成员记录？')) return;
    try { await callApi('/api/users/' + encodeURIComponent(memberDelete.dataset.group) + '/' + encodeURIComponent(memberDelete.dataset.memberDelete), { method: 'DELETE' }); await refreshBoot(); render('members'); flash('已删除成员'); }
    catch (error) { flash('删除失败：' + error.message, 'danger'); }
    return;
  }
  const permSave = event.target.closest('[data-perm-save]');
  if (permSave) {
    event.preventDefault();
    const perms = {};
    document.querySelectorAll('[data-perm-key]').forEach((select) => { perms[select.dataset.permKey] = select.value; });
    try { await callApi('/api/settings', { method: 'POST', body: JSON.stringify({ commandPermissions: perms }) }); flash('权限已保存'); }
    catch (error) { flash('保存失败：' + error.message, 'danger'); }
    return;
  }
  const modelSave = event.target.closest('[data-model-save]');
  if (modelSave) {
    event.preventDefault();
    const model = (document.getElementById('modelName') || {}).value || '';
    const provider = (document.getElementById('modelProvider') || {}).value || 'deepseek';
    const baseUrl = (document.getElementById('modelBase') || {}).value || '';
    try { await callApi('/api/settings', { method: 'POST', body: JSON.stringify({ model, llmProvider: provider, apiBaseUrl: baseUrl }) }); flash('模型设置已保存'); await refreshBoot(); render('model'); }
    catch (error) { flash('保存失败：' + error.message, 'danger'); }
  }
}, true);

async function loadExtras() {
  try { LIVE.randomImage = await callApi('/api/random-image'); } catch (error) { LIVE.randomImage = null; }
  try { LIVE.persona = await callApi('/api/persona/studio'); } catch (error) { LIVE.persona = null; }
  try { LIVE.promptCalls = (await callApi('/api/persona/prompt-calls?limit=12')).promptCalls || []; } catch (error) { LIVE.promptCalls = []; }
  try { LIVE.randomFiles = (await callApi('/api/random-image/list')).files || []; } catch (error) { LIVE.randomFiles = []; }
  try { LIVE.diagnostics = await callApi('/api/diagnostics'); } catch (error) { LIVE.diagnostics = null; }
  try { LIVE.replyProcesses = (await callApi('/api/reply-processes')).processes || []; } catch (error) { LIVE.replyProcesses = []; }
}

const __bootAllBase = bootAll;
bootAll = async function () {
  await __bootAllBase();
  await loadExtras();
  render(window.__page || 'overview');
};

/* ---------- 权限 / 模型 / 成员 / 记忆：带写操作 ---------- */
const PERM_ROLES = ['guest', 'admin', 'owner'];
PAGES.permissions = function () {
  const perms = (LIVE.settings && LIVE.settings.commandPermissions) || {};
  const entries = Object.entries(perms);
  if (!entries.length) return pageHead('权限', '没有权限配置。', '') + card('空', '<div class="note">commandPermissions 为空。</div>');
  return pageHead('权限', '修改后保存会写入 settings。', '<button class="btn btn-primary" data-perm-save="1">保存权限</button>')
    + '<div class="card"><table class="table"><thead><tr><th>指令</th><th>所需身份</th></tr></thead><tbody>'
    + entries.map(([command, role]) => '<tr><td><b>' + esc(command) + '</b></td><td><select data-perm-key="' + esc(command) + '" style="background:#202024;color:#f3f3f5;border:1px solid #3b3b42;border-radius:8px;padding:5px 8px">'
      + PERM_ROLES.map((option) => '<option value="' + option + '"' + (option === role ? ' selected' : '') + '>' + option + '</option>').join('') + '</select></td></tr>').join('')
    + '</tbody></table></div>';
};

PAGES.model = function () {
  const settings = LIVE.settings || {};
  return pageHead('模型', '保存会写入 settings。', '<button class="btn btn-primary" data-model-save="1">保存模型设置</button>')
    + '<div class="grid grid-2">'
    + card('供应商与模型', '<div class="field"><label>供应商</label><select id="modelProvider"><option value="deepseek"' + (settings.llmProvider === 'deepseek' ? ' selected' : '') + '>DeepSeek</option><option value="openai"' + (settings.llmProvider === 'openai' ? ' selected' : '') + '>OpenAI 兼容</option><option value="codex"' + (settings.llmProvider === 'codex' ? ' selected' : '') + '>Codex</option></select></div>'
      + '<div class="field"><label>模型</label><input id="modelName" value="' + esc(settings.model || '') + '" /></div>'
      + '<div class="field"><label>API 地址</label><input id="modelBase" value="' + esc(settings.apiBaseUrl || '') + '" /></div>'
      + '<div class="note">API Key：' + (settings.apiKey ? '已配置（留空不覆盖）' : '未配置') + '</div>')
    + card('用量', kv('今日 Token', wan(LIVE.todayTokens) + ' 万') + kv('今日请求', String(LIVE.todayRequests || 0)) + kv('Codex', LIVE.codex ? (LIVE.codex.loggedIn ? '已登录' : '未登录') : '未知'))
    + '</div>';
};

PAGES.members = function () {
  const users = LIVE.users || [];
  if (!users.length) return pageHead('成员', '后台还没有成员记录。', '') + card('空', '<div class="note">当前 db.users 为空；机器人收到群消息后才会写入。</div>');
  return pageHead('成员', '共 ' + users.length + ' 位。', '')
    + '<div class="card"><table class="table"><thead><tr><th>昵称</th><th>QQ</th><th>群</th><th>osu!</th><th>消息</th><th></th></tr></thead><tbody>'
    + users.slice(0, 80).map((user) => '<tr><td><b>' + esc(user.nickname || user.userId) + '</b></td><td class="muted">' + esc(user.userId) + '</td><td>' + esc(user.groupId || '') + '</td>'
      + '<td class="muted">' + esc(user.osuUsername || user.osuId || '—') + '</td><td>' + Number(user.messageCount || 0) + '</td>'
      + '<td style="text-align:right"><button class="btn btn-ghost" style="font-size:12px" data-member-delete="' + esc(user.userId) + '" data-group="' + esc(user.groupId || '') + '">删除</button></td></tr>').join('')
    + '</tbody></table></div>';
};

PAGES.memory = function () {
  const memories = LIVE.memories || [];
  if (!memories.length) return pageHead('记忆', '还没有记忆条目。', '') + card('空', '<div class="note">db.memories 为空。</div>');
  return pageHead('记忆', '共 ' + memories.length + ' 条，最近 50 条。', '')
    + '<div class="card"><div class="rows">'
    + memories.slice(0, 50).map((memory) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(memory.nickname || memory.userId) + '</div>'
      + '<div class="row-sub">' + esc(String(memory.summary || '').slice(0, 70)) + '</div></div>'
      + '<button class="btn btn-ghost" style="font-size:12px" data-memory-recalc="' + esc(memory.userId) + '">重算</button>'
      + '<button class="btn btn-ghost" style="font-size:12px" data-memory-delete="' + esc(memory.userId) + '">删除</button></div>').join('')
    + '</div></div>';
};

bootAll();