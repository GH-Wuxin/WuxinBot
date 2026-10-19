// 真实数据绑定（三）：拉取 + 写操作 + 启动

async function refreshBoot() {
  try {
    const state = await callApi('/api/state');
    const db = state.db || {};
    LIVE.settings = db.settings || {};
    LIVE.users = db.users || [];
    LIVE.memories = db.memories || [];
    LIVE.rawGroups = db.groups || [];
    if (Array.isArray(db.groups)) {
      db.groups.forEach((group) => {
        const row = DATA.groupRows.find((item) => String(item.id) === String(group.groupId));
        if (row) { row.modeKey = group.mode; row.maxPerHour = group.maxPerHour; row.cooldown = group.cooldownSec; }
      });
    }
    LIVE.bindings = Number((db.settings && db.settings.boundCount) || (db.users || []).filter((u) => u.osuUsername || u.osuId).length || 0);
  } catch (error) { LIVE.error = String(error.message || error); }

  try { DATA2.snapshots = (await callApi('/api/config-snapshots')).snapshots || []; } catch (error) { DATA2.snapshots = []; }
  try { LIVE.relationships = (await callApi('/api/relationship-profiles')).profiles || []; } catch (error) { LIVE.relationships = []; }
  try { LIVE.profileLogs = (await callApi('/api/profile-logs?limit=60')).logs || []; } catch (error) { LIVE.profileLogs = []; }
  try { LIVE.codex = await callApi('/api/codex/status'); } catch (error) { LIVE.codex = null; }
}

async function bootAll() {
  await Promise.all([refreshRuntime(), loadTraces(), refreshBoot()]);
  render(window.__page || 'overview');
}

function flash(message, tone) { notify(message, tone || 'pink'); }

document.addEventListener('click', async function (event) {
  const proc = event.target.closest('[data-proc]');
  if (proc) {
    event.preventDefault();
    try {
      if (!RUNTIME.available) { flash('需要桌面端才能控制进程', 'pink'); return; }
      if (proc.dataset.proc === 'start-all') await window.desktop.startAll();
      else if (proc.dataset.proc === 'stop-all') await window.desktop.stopAll();
      else if (proc.dataset.proc === 'start') await window.desktop.start(proc.dataset.id);
      else if (proc.dataset.proc === 'stop') await window.desktop.stop(proc.dataset.id);
      else if (proc.dataset.proc === 'restart') await window.desktop.restart(proc.dataset.id);
      await refreshRuntime();
      render('runtime');
      flash('已执行：' + proc.dataset.proc, 'pink');
    } catch (error) { flash('失败：' + (error.message || error), 'danger'); }
    return;
  }

  const groupToggle = event.target.closest('[data-group-toggle]');
  if (groupToggle) {
    event.preventDefault();
    const id = groupToggle.dataset.groupToggle;
    const row = DATA.groupRows.find((item) => String(item.id) === String(id));
    try {
      await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId: id, name: row ? row.name : '', enabled: !(row && row.enabled), mode: (row && row.modeKey) || 'mention', maxPerHour: row ? row.maxPerHour : undefined, cooldownSec: row ? row.cooldown : undefined }) });
      if (row) row.enabled = !row.enabled;
      render(window.__page || 'groups');
      flash('已更新群状态');
    } catch (error) { flash('失败：' + error.message, 'danger'); }
    return;
  }

  const save = event.target.closest('[data-group-save]');
  if (save) {
    event.preventDefault();
    const id = save.dataset.groupSave;
    const row = DATA.groupRows.find((item) => String(item.id) === String(id));
    const max = Number((document.getElementById('groupMax') || {}).value || 0);
    const cooldown = Number((document.getElementById('groupCooldown') || {}).value || 0);
    try {
      await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId: id, name: row ? row.name : '', enabled: row ? row.enabled : true, mode: (row && row.modeKey) || 'mention', maxPerHour: max, cooldownSec: cooldown }) });
      if (row) { row.maxPerHour = max; row.cooldown = cooldown; }
      render('groups');
      flash('群设置已保存');
    } catch (error) { flash('保存失败：' + error.message, 'danger'); }
    return;
  }

  const del = event.target.closest('[data-group-delete]');
  if (del) {
    event.preventDefault();
    if (!confirm('确定删除这个群的全部配置？')) return;
    try {
      await callApi('/api/groups/' + encodeURIComponent(del.dataset.groupDelete), { method: 'DELETE' });
      DATA.groupRows = DATA.groupRows.filter((item) => String(item.id) !== String(del.dataset.groupDelete));
      selectedGroupId = DATA.groupRows[0] ? DATA.groupRows[0].id : '';
      render('groups');
      flash('已删除该群');
    } catch (error) { flash('删除失败：' + error.message, 'danger'); }
    return;
  }

  const add = event.target.closest('[data-group="add"]');
  if (add) {
    event.preventDefault();
    const groupId = prompt('群号');
    if (!groupId) return;
    const name = prompt('群名称') || groupId;
    try {
      await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId: String(groupId).trim(), name, enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 }) });
      await refreshBoot();
      DATA.groupRows.push({ name, id: String(groupId).trim(), mode: 'mention', modeKey: 'mention', enabled: true, members: 0, active: false });
      render('groups');
      flash('已添加群');
    } catch (error) { flash('添加失败：' + error.message, 'danger'); }
    return;
  }

  const profileBtn = event.target.closest('[data-group-profile]');
  if (profileBtn) {
    event.preventDefault();
    await loadGroupProfile(profileBtn.dataset.groupProfile);
    return;
  }

  const backupCreate = event.target.closest('[data-backup-create]');
  if (backupCreate) {
    event.preventDefault();
    try { await callApi('/api/backups', { method: 'POST', body: '{}' }); flash('备份已创建'); await hydrate(); render('maintenance'); }
    catch (error) { flash('备份失败：' + error.message, 'danger'); }
    return;
  }
  const backupRestore = event.target.closest('[data-backup-restore]');
  if (backupRestore) {
    event.preventDefault();
    if (!confirm('恢复这个备份？当前数据会被覆盖。')) return;
    try { await callApi('/api/backups/' + encodeURIComponent(backupRestore.dataset.backupRestore) + '/restore', { method: 'POST', body: '{}' }); flash('已恢复，页面将刷新'); setTimeout(() => location.reload(), 800); }
    catch (error) { flash('恢复失败：' + error.message, 'danger'); }
    return;
  }
  const backupDelete = event.target.closest('[data-backup-delete]');
  if (backupDelete) {
    event.preventDefault();
    if (!confirm('删除这个备份文件？')) return;
    try { await callApi('/api/backups/' + encodeURIComponent(backupDelete.dataset.backupDelete), { method: 'DELETE' }); flash('已删除备份'); await hydrate(); render('maintenance'); }
    catch (error) { flash('删除失败：' + error.message, 'danger'); }
    return;
  }
  const recalcStart = event.target.closest('[data-recalc-start]');
  if (recalcStart) {
    event.preventDefault();
    try { await callApi('/api/recalc', { method: 'POST', body: '{}' }); flash('重算已开始'); await hydrate(); render('maintenance'); }
    catch (error) { flash('重算失败：' + error.message, 'danger'); }
    return;
  }
  const recalcStop = event.target.closest('[data-recalc-stop]');
  if (recalcStop) {
    event.preventDefault();
    try { await callApi('/api/recalc/stop', { method: 'POST', body: '{}' }); flash('已停止重算'); await hydrate(); render('maintenance'); }
    catch (error) { flash('停止失败：' + error.message, 'danger'); }
    return;
  }
  const memoryDelete = event.target.closest('[data-memory-delete]');
  if (memoryDelete) {
    event.preventDefault();
    if (!confirm('删除这条记忆？')) return;
    try { await callApi('/api/memories/' + encodeURIComponent(memoryDelete.dataset.memoryDelete), { method: 'DELETE' }); LIVE.memories = LIVE.memories.filter((m) => String(m.userId) !== String(memoryDelete.dataset.memoryDelete)); render('memory'); flash('已删除记忆'); }
    catch (error) { flash('删除失败：' + error.message, 'danger'); }
    return;
  }
  const snapshotBtn = event.target.closest('[data-snapshot]');
  if (snapshotBtn) {
    event.preventDefault();
    if (!confirm('恢复这个配置快照？')) return;
    try { await callApi('/api/config-snapshots/' + snapshotBtn.dataset.snapshot + '/restore', { method: 'POST', body: '{}' }); flash('已恢复快照'); setTimeout(() => location.reload(), 800); }
    catch (error) { flash('恢复失败：' + error.message, 'danger'); }
    return;
  }
}, true);

/* 暂停按钮：同步写入后台 */
document.getElementById('pauseBtn').addEventListener('click', async function () {
  try { await callApi('/api/settings', { method: 'POST', body: JSON.stringify({ globalPaused: Boolean(DATA.paused) }) }); flash(DATA.paused ? '已暂停（已写入后台）' : '已恢复（已写入后台）'); }
  catch (error) { flash('写入失败：' + error.message, 'danger'); }
});

bootAll();
