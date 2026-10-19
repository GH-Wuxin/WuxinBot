// 随机发图页：每个群的真实开关
PAGES.randomImages = function () {
  const info = LIVE.randomImage;
  if (!info) return pageHead('随机发图', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/random-image</div>');
  const totals = info.totals || {};
  const groups = info.groups || [];
  return pageHead('随机发图', '图池、概率和每个群的开关都在这里。', '')
    + grid4(['图池|' + ((info.pool && info.pool.count) || 0) + '|张', '参与群|' + groups.filter((g) => g.participates).length + '|共 ' + groups.length + ' 个', '今日发送|' + (totals.sent || 0) + '|次', '总开关|' + (info.config && info.config.enabled ? '开' : '关') + '|全局'])
    + '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">图池预览</span><span class="muted" style="font-size:12px">' + esc((info.pool && info.pool.dir) || '') + '</span></div><div class="grid-tiles">'
    + ((LIVE.randomFiles || []).slice(0, 24).map((file) => '<div class="tile" style="padding:0;overflow:hidden"><img src="' + (location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '') + '/api/random-image/file?name=' + encodeURIComponent(file) + '" style="width:100%;height:100%;object-fit:cover" alt="" /></div>').join(''))
    + '</div></div>'
    + '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">每个群的开关</span><span class="muted" style="font-size:12px">改完立即写入</span></div><div class="rows">'
    + groups.map((group) => {
      const row = (DATA.groupRows || []).find((item) => String(item.id) === String(group.groupId)) || {};
      const on = Boolean(group.randomImageEnabled);
      return '<div class="row"><div class="row-main"><div class="row-title">' + esc(group.name || group.groupId) + '</div>'
        + '<div class="row-sub">' + (group.chance != null ? (Number(group.chance) * 100).toFixed(1) + '% 命中 · ' + (group.hits || 0) + '/' + (group.rolls || 0) : '还没有开过') + '</div></div>'
        + '<select data-random-rate="' + group.groupId + '" style="background:#202024;color:#f3f3f5;border:1px solid #3b3b42;border-radius:8px;padding:5px 8px;margin-right:10px">'
        + '<option value="standard"' + ((group.randomImageRate || 'standard') === 'standard' ? ' selected' : '') + '>standard</option>'
        + '<option value="low"' + (group.randomImageRate === 'low' ? ' selected' : '') + '>low</option></select>'
        + '<button class="switch ' + (on ? 'is-on' : '') + '" onclick="toggleRandomGroup(&#39;' + group.groupId + '&#39;,this)"></button></div>';
    }).join('')
    + '</div></div>'
    + '<div class="grid grid-2">' + card('最近发送', '<div class="rows">' + ((info.recent || []).slice(0, 8).map((item) => listRow('', esc(item.file || item.name || '—'), esc(item.groupId || ''), '<span class="row-value" style="color:var(--muted)">' + fmtClock(item.at) + '</span>')).join('') || '<div class="empty">暂无</div>') + '</div>') + '</div>';
};

document.addEventListener('click', async function (event) {
  const toggle = event.target.closest('[data-random-group]');
  if (toggle) {
    event.preventDefault();
    const groupId = toggle.dataset.randomGroup;
    const rowData = (DATA.groupRows || []).find((item) => String(item.id) === String(groupId)) || {};
    const meta = { name: rowData.name, mode: rowData.modeKey || 'mention', maxPerHour: rowData.maxPerHour, cooldown: rowData.cooldown };
    const next = !toggle.classList.contains('is-on');
    const rateSelect = document.querySelector('[data-random-rate="' + groupId + '"]');
    const rate = rateSelect ? rateSelect.value : 'standard';
    toggle.classList.toggle('is-on', next);
    try {
      await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId, name: meta.name || groupId, enabled: true, mode: meta.mode || 'mention', maxPerHour: meta.maxPerHour, cooldownSec: meta.cooldown, randomImageEnabled: next, randomImageRate: rate }) });
      const group = (LIVE.randomImage.groups || []).find((item) => String(item.groupId) === String(groupId));
      if (group) { group.randomImageEnabled = next; group.participates = next; }
      const row = (DATA.groupRows || []).find((item) => String(item.id) === String(groupId));
      if (row) { row.randomImageEnabled = next; row.randomImageRate = rate; }
      flash(next ? '已开启这个群的随机发图' : '已关闭这个群的随机发图');
    } catch (error) {
      toggle.classList.toggle('is-on', !next);
      flash('保存失败：' + error.message, 'danger');
    }
    return;
  }
  const rateSelect = event.target.closest('[data-random-rate]');
  if (rateSelect && rateSelect.tagName === 'SELECT') {
    // 只在下一次切换时随保存一起写入
  }
}, true);

window.toggleRandomGroup = async function (groupId, button) {
  const row = (DATA.groupRows || []).find((item) => String(item.id) === String(groupId)) || {};
  const rateSelect = document.querySelector('[data-random-rate="' + groupId + '"]');
  const next = !button.classList.contains('is-on');
  button.classList.toggle('is-on', next);
  try {
    await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId, name: row.name || groupId, enabled: row.enabled !== false, mode: row.modeKey || 'mention', maxPerHour: row.maxPerHour, cooldownSec: row.cooldown, randomImageEnabled: next, randomImageRate: (rateSelect && rateSelect.value) || row.randomImageRate || 'standard' }) });
    if (row) { row.randomImageEnabled = next; }
    const group = (LIVE.randomImage.groups || []).find((item) => String(item.groupId) === String(groupId));
    if (group) { group.randomImageEnabled = next; group.participates = next; }
    flash(next ? '已开启这个群的随机发图' : '已关闭这个群的随机发图');
  } catch (error) {
    button.classList.toggle('is-on', !next);
    flash('保存失败：' + error.message, 'danger');
  }
};
