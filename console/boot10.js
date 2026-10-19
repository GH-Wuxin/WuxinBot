// 随机发图：对齐旧控制台结构（模块设置 / 图池 / 参与群 / 最近发送）
function randomConfig() {
  const cfg = (LIVE.settings && LIVE.settings.randomImage) || {};
  return {
    enabled: cfg.enabled !== false,
    standard: cfg.standard || { base: 0.005, step: 0.0005 },
    low: cfg.low || { base: 0.001, step: 0.0002 },
    recentWindow: Number(cfg.recentWindow || 8),
    recentDecay: Number(cfg.recentDecay || 0.35)
  };
}

PAGES.randomImages = function () {
  const info = LIVE.randomImage;
  if (!info) return pageHead('随机发图', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/random-image</div>');
  const cfg = randomConfig();
  const groups = (DATA.groupRows || []);
  const stats = new Map((info.groups || []).map((group) => [String(group.groupId), group]));
  const recent = (info.recent || []).slice(0, 12);
  const origin = location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '';

  return pageHead('随机发图', '偶尔向已启用的群单独发一张图，和文字回复互不影响。', '<button class="btn" data-random-refresh="1">刷新</button>')
    + '<div class="grid grid-2" style="margin-bottom:16px">'
    + '<div class="card"><div class="card-head"><span class="card-title">模块设置</span></div>'
    + '<div class="field" style="display:flex;align-items:center;justify-content:space-between"><label style="margin:0">启用模块</label><button class="switch ' + (cfg.enabled ? 'is-on' : '') + '" data-random-module="1"></button></div>'
    + '<div class="field"><label>低频基础概率（%）</label><input id="randomLow" type="number" step="0.01" value="' + (cfg.low.base * 100).toFixed(3) + '" /></div>'
    + '<div class="field"><label>标准基础概率（%）</label><input id="randomStd" type="number" step="0.01" value="' + (cfg.standard.base * 100).toFixed(3) + '" /></div>'
    + '<button class="btn btn-primary" data-random-save-config="1" style="width:100%">保存模块设置</button></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">图池状态</span></div>'
    + kv('图片', ((info.pool && info.pool.count) || 0) + ' 张')
    + kv('掷骰', (info.totals && info.totals.rolls ? info.totals.rolls : 0) + ' 次')
    + kv('命中', (info.totals && info.totals.hits ? info.totals.hits : 0) + ' 次')
    + '<div class="note" style="margin-top:10px">图池目录自动扫描，增删图片约 30 秒内生效。</div></div></div>'
    + '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">参与群</span><span class="muted" style="font-size:12px">每个群单独控制</span></div><div class="rows">'
    + groups.map(function (group) {
      const groupId = String(group.id);
      const stat = stats.get(groupId) || {};
      const on = group.randomImageEnabled === true;
      const rate = group.randomImageRate === 'low' ? 'low' : 'standard';
      const statsLine = stat.participates
        ? '掷骰 ' + (stat.rolls || 0) + ' · 命中 ' + (stat.hits || 0) + ' · 当前 ' + (stat.chance != null ? (Number(stat.chance) * 100).toFixed(2) + '%' : '—') + ' · ' + (stat.lastFile || '还没发过')
        : (cfg.enabled && on ? '等待第一条消息' : '模块或本群未开启');
      return '<div class="row' + (on ? '' : ' is-dim') + '"><div class="row-main"><div class="row-title">' + esc(group.name) + '</div>'
        + '<div class="row-sub">' + groupId + ' · 文字模式：' + esc(group.mode || '—') + '</div>'
        + '<div class="row-sub" style="color:var(--muted)">' + esc(statsLine) + '</div></div>'
        + '<div class="row-actions" style="display:flex;align-items:center;gap:10px">'
        + '<select data-random-rate="' + groupId + '" style="background:#202024;color:#f3f3f5;border:1px solid #3b3b42;border-radius:8px;padding:5px 8px">'
        + '<option value="low"' + (rate === 'low' ? ' selected' : '') + '>低频</option>'
        + '<option value="standard"' + (rate === 'standard' ? ' selected' : '') + '>标准</option></select>'
        + '<button class="switch ' + (on ? 'is-on' : '') + '" data-random-group="' + groupId + '"></button></div></div>';
    }).join('')
    + '</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">最近发送</span><span class="muted" style="font-size:12px">' + recent.length + ' 条</span></div>'
    + (recent.length ? '<div class="grid-tiles">' + recent.map(function (item) {
        return '<figure class="tile-fig"><img src="' + origin + '/api/random-image/file?name=' + encodeURIComponent(item.file) + '" alt="" loading="lazy" />'
          + '<figcaption>' + esc(String(item.file || '').replace(/^pippi-/i, '').replace(/\.png$/i, '')) + '<small>' + esc(item.groupName || item.groupId || '') + ' · ' + fmtStamp(item.at) + '</small></figcaption></figure>';
      }).join('') + '</div>' : '<div class="empty">还没有发过图</div>')
    + '</div>';
};

document.addEventListener('click', async function (event) {
  const moduleSwitch = event.target.closest('[data-random-module]');
  if (moduleSwitch) {
    event.preventDefault();
    const cfg = randomConfig();
    const next = !cfg.enabled;
    moduleSwitch.classList.toggle('is-on', next);
    cfg.enabled = next;
    try { await callApi('/api/settings', { method: 'POST', body: JSON.stringify({ randomImage: cfg }) }); flash(next ? '随机发图已开启' : '随机发图已关闭'); await refreshBoot(); render('randomImages'); }
    catch (error) { flash('保存失败：' + error.message, 'danger'); }
    return;
  }
  const saveCfg = event.target.closest('[data-random-save-config]');
  if (saveCfg) {
    event.preventDefault();
    const cfg = randomConfig();
    cfg.low = Object.assign({}, cfg.low, { base: Number((document.getElementById('randomLow') || {}).value || 0) / 100 });
    cfg.standard = Object.assign({}, cfg.standard, { base: Number((document.getElementById('randomStd') || {}).value || 0) / 100 });
    try { await callApi('/api/settings', { method: 'POST', body: JSON.stringify({ randomImage: cfg }) }); flash('模块设置已保存'); await refreshBoot(); render('randomImages'); }
    catch (error) { flash('保存失败：' + error.message, 'danger'); }
    return;
  }
  const toggle = event.target.closest('[data-random-group]');
  if (toggle) {
    event.preventDefault();
    const groupId = toggle.dataset.randomGroup;
    const row = (DATA.groupRows || []).find((item) => String(item.id) === String(groupId)) || {};
    const next = !toggle.classList.contains('is-on');
    const rateSelect = document.querySelector('[data-random-rate="' + groupId + '"]');
    toggle.classList.toggle('is-on', next);
    try {
      await callApi('/api/groups', { method: 'POST', body: JSON.stringify({ groupId, name: row.name || groupId, enabled: row.enabled !== false, mode: row.modeKey || 'mention', maxPerHour: row.maxPerHour, cooldownSec: row.cooldown, randomImageEnabled: next, randomImageRate: (rateSelect && rateSelect.value) || row.randomImageRate || 'standard' }) });
      row.randomImageEnabled = next;
      flash(next ? '已开启这个群的随机发图' : '已关闭这个群的随机发图');
    } catch (error) { toggle.classList.toggle('is-on', !next); flash('保存失败：' + error.message, 'danger'); }
    return;
  }
  const rate = event.target.closest('[data-random-rate]');
  if (rate && rate.tagName === 'SELECT') { return; }
  if (event.target.closest('[data-random-refresh]')) { window.goto('randomImages'); }
}, true);
