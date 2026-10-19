// osu 抽屉排版 + 三页细节
function osuEmpty(text) { return '<div class="empty">' + esc(text) + '</div>'; }
function osuTable(headers, rows) {
  return '<table class="table"><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

window.osuLookup = async function () {
  const input = document.getElementById('osuName');
  const name = (input && input.value.trim()) || 'Pippi';
  let player;
  try { player = await osuSearch(name); } catch (error) { flash('查不到：' + error.message, 'danger'); return; }
  const tabs = ['概览', 'BP', '最近', 'PP+', '类型', '技能'];
  openDrawer({ title: player.username || name, sub: 'osu! #' + player.id, tabs: tabs.map((label) => ({ label, html: '<div class="note">加载中…</div>' })) });
  const set = (index, html) => { drawerTabsCache[index].html = html; if (document.querySelectorAll('.drawer-tabs button')[index]?.classList.contains('is-active')) drawerTab(index); };

  try {
    const payload = await osuPlayerTab(player.id, '概览');
    const p = (payload.profile && payload.profile.player) || {};
    const stats = (payload.profile && payload.profile.stats) || {};
    set(0, '<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">'
      + '<img src="' + esc(p.avatar_url || '') + '" alt="" style="width:64px;height:64px;border-radius:50%;border:2px solid rgba(255,102,170,.45)" />'
      + '<div><div style="font-size:20px;font-weight:800">' + esc(p.username || name) + '</div>'
      + '<div class="muted" style="font-size:12px">' + esc(p.country_name || p.country_code || '') + (p.is_supporter ? ' · supporter' : '') + '</div></div></div>'
      + readGrid([['PP', String(p.pp != null ? p.pp : stats.pp || '—')], ['全球排名', p.global_rank ? '#' + p.global_rank : '未上榜'], ['国家排名', p.country_rank ? '#' + p.country_rank : '—'], ['准确率', p.accuracy != null ? Number(p.accuracy).toFixed(2) + '%' : '—']]));
  } catch (error) { set(0, osuEmpty('读取失败：' + error.message)); }

  try {
    const payload = await osuPlayerTab(player.id, 'BP');
    const rows = (payload.bp || []).map((item) => [
      '#' + item.bpRank,
      '<b>' + esc(item.title) + '</b><div class="muted" style="font-size:11px">' + esc(item.artist) + ' · ' + esc(item.version) + '</div>',
      Number(item.stars || 0).toFixed(2) + '★',
      (item.mods || []).join('') || 'NM',
      Number(item.acc || 0).toFixed(2) + '%',
      item.pp != null ? item.pp + 'pp' : '—'
    ]);
    set(1, rows.length ? osuTable(['名次', '谱面', '星数', 'mods', 'acc', 'pp'], rows) : osuEmpty('没有 BP 数据'));
  } catch (error) { set(1, osuEmpty('读取失败：' + error.message)); }

  try {
    const payload = await osuPlayerTab(player.id, '最近');
    const rows = (payload.recent || []).map((item) => [
      String(item.played_at || '').slice(5, 16).replace('T', ' '),
      '<b>' + esc(item.title || '') + '</b>',
      item.stars != null ? Number(item.stars).toFixed(2) + '★' : '—',
      item.acc != null ? Number(item.acc).toFixed(2) + '%' : '—',
      item.pp != null ? item.pp + 'pp' : '—'
    ]);
    set(2, rows.length ? osuTable(['时间', '谱面', '星数', 'acc', 'pp'], rows) : osuEmpty('最近没有成绩'));
  } catch (error) { set(2, osuEmpty('读取失败：' + error.message)); }

  try {
    const payload = await osuPlayerTab(player.id, 'PP+');
    const bars = payload.bars;
    if (!bars) set(3, osuEmpty('PP+ 服务暂时没有这个人的数据'));
    else {
      const entries = Array.isArray(bars) ? bars : Object.entries(bars).map(([key, value]) => ({ label: key, value }));
      set(3, entries.map((bar) => {
        const value = Number(bar.value || bar.score || 0);
        return '<div class="bar-row"><span>' + esc(bar.label || bar.name || '') + '</span><div class="bar"><i style="width:' + Math.max(2, Math.min(100, value / 20 * 100)) + '%"></i></div><b>' + value + '</b></div>';
      }).join(''));
    }
  } catch (error) { set(3, osuEmpty('读取失败：' + error.message)); }

  try {
    const payload = await osuPlayerTab(player.id, '类型');
    set(4, '<div class="note" style="white-space:pre-wrap;line-height:1.9">' + esc(payload.text || '没有分析结果') + '</div>');
  } catch (error) { set(4, osuEmpty('读取失败：' + error.message)); }

  try {
    const payload = await osuPlayerTab(player.id, '技能');
    const record = payload.record;
    if (!record) set(5, osuEmpty('还没有技能画像，先跑一次 /w info'));
    else {
      const axes = record.axes || [];
      set(5, (Array.isArray(axes) ? axes : []).map((axis) => '<div class="bar-row"><span>' + esc(axis.label || axis.key) + '</span><div class="bar"><i style="width:' + Math.max(2, Math.min(100, Number(axis.ceiling || 0) / 10 * 100)) + '%"></i></div><b>' + Number(axis.ceiling || 0) + '</b></div>').join('') || '<div class="note">' + esc(JSON.stringify(record).slice(0, 400)) + '</div>');
    }
  } catch (error) { set(5, osuEmpty('读取失败：' + error.message)); }
};

/* 三页排版细节 */
(function polish() {
  const persona = PAGES.persona;
  PAGES.persona = function () {
    return persona().replace('<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">', '<div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)">');
  };
  const agent = PAGES.agent;
  PAGES.agent = function () {
    return agent() + '<div class="note" style="margin-top:16px">诊断数据每次进入本页重新拉取；沙盒已移除，Agent 只保留运行配置与诊断。</div>';
  };
})();
