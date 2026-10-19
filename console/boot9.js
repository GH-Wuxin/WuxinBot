// 随机发图：最近发送 + 每群开关（不再铺图池）
PAGES.randomImages = function () {
  const info = LIVE.randomImage;
  if (!info) return pageHead('随机发图', '读取中…', '') + card('加载中', '<div class="note">正在读取 /api/random-image</div>');
  const totals = info.totals || {};
  const groups = info.groups || [];
  const recent = (info.recent || []).slice(0, 12);
  const origin = location.protocol === 'file:' ? 'http://127.0.0.1:8787' : '';

  return pageHead('随机发图', '最近发了什么、每个群开没开，都在这里。', '')
    + grid4(['图池|' + ((info.pool && info.pool.count) || 0) + '|张', '参与群|' + groups.filter((g) => g.participates).length + '|共 ' + groups.length + ' 个', '今日发送|' + (totals.sent || 0) + '|次', '总开关|' + (info.config && info.config.enabled ? '开' : '关') + '|全局'])
    + '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">最近发送</span><span class="muted" style="font-size:12px">' + recent.length + ' 条</span></div>'
    + (recent.length
      ? '<div class="grid-tiles">' + recent.map(function (item) {
          const file = item.file || item.name || '';
          return '<div class="tile" style="padding:0;overflow:hidden;position:relative" title="' + esc(file) + '">'
            + '<img src="' + origin + '/api/random-image/file?name=' + encodeURIComponent(file) + '" style="width:100%;height:100%;object-fit:cover" alt="" />'
            + '<span style="position:absolute;left:8px;bottom:6px;font-size:11px;color:#fff;text-shadow:0 1px 3px #000">' + fmtClock(item.at) + '</span>'
            + '<span style="position:absolute;right:8px;bottom:6px;font-size:11px;color:#ffd0e4;text-shadow:0 1px 3px #000">' + esc(item.groupId || '') + '</span></div>';
        }).join('') + '</div>'
      : '<div class="empty">还没有发送记录</div>')
    + '</div>'
    + '<div class="card"><div class="card-head"><span class="card-title">每个群的开关</span><span class="muted" style="font-size:12px">点开关立即写入</span></div><div class="rows">'
    + groups.map(function (group) {
      const on = Boolean(group.randomImageEnabled);
      return '<div class="row"><div class="row-main"><div class="row-title">' + esc(group.name || group.groupId) + '</div>'
        + '<div class="row-sub">' + (group.chance != null ? (Number(group.chance) * 100).toFixed(1) + '% 命中 · ' + (group.hits || 0) + '/' + (group.rolls || 0) : '还没有开过') + '</div></div>'
        + '<select data-random-rate="' + group.groupId + '" style="background:#202024;color:#f3f3f5;border:1px solid #3b3b42;border-radius:8px;padding:5px 8px;margin-right:10px">'
        + '<option value="standard"' + ((group.randomImageRate || 'standard') === 'standard' ? ' selected' : '') + '>standard</option>'
        + '<option value="low"' + (group.randomImageRate === 'low' ? ' selected' : '') + '>low</option></select>'
        + '<button class="switch ' + (on ? 'is-on' : '') + '" onclick="toggleRandomGroup(&#39;' + group.groupId + '&#39;,this)"></button></div>';
    }).join('')
    + '</div></div>';
};
