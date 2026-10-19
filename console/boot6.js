// 群设置：完整版
const GROUP_MODES = [['mention', '@ 回复'], ['silent', '静默'], ['light', '轻度参与'], ['natural', '自然群友'], ['osu', '仅 osu! 指令']];

PAGES.groups = function () {
  const rows = DATA.groupRows;
  if (!rows.length) {
    return pageHead('群聊', '还没有配置任何群。', '<button class="btn btn-primary" data-group="add">添加群</button>')
      + card('空', '<div class="note">在群里发一条消息，或点右上角添加群。</div>');
  }
  const current = rows.filter((row) => String(row.id) === String(selectedGroupId))[0] || rows[0];
  const groupId = String(current.id);
  const botConfig = (LIVE.groupBotConfig || {})[groupId] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
  const pairs = (LIVE.relationships || []).filter((pair) => String(pair.groupId) === groupId).slice(0, 6);
  const members = (LIVE.users || []).filter((user) => String(user.groupId) === groupId);

  const list = rows.map(function (group) {
    const active = String(group.id) === groupId;
    return '<div class="row group-row' + (active ? ' is-selected' : '') + '" onclick="selectGroup(\'' + group.id + '\')">'
      + avatar((group.name || '?').slice(0, 1), 30)
      + '<div class="row-main"><div class="row-title">' + esc(group.name) + '</div><div class="row-sub">' + group.id + ' · ' + group.members + ' 位成员 ' + chip(group.mode) + '</div></div>'
      + '<button class="switch ' + (group.enabled ? 'is-on' : '') + '" data-group-toggle="' + group.id + '" aria-label="启用"></button></div>';
  }).join('');

  return pageHead('群聊', '左边选群，右边是这个群的全部策略。', '<button class="btn btn-primary" data-group="add">添加群</button>')
    + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">搜索</span><input id="groupSearch" placeholder="群名或群号" />' + chip(rows.length + ' 个群') + '</div>'
    + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">已配置群</span><span class="muted" style="font-size:12px">点击切换</span></div><div class="rows" id="groupList">' + list + '</div></div>'
    + '<div class="stack">'
    + '<div class="card"><div class="card-head"><span class="card-title">' + esc(current.name) + '</span>' + chip(current.enabled ? '启用中' : '已停用', current.enabled ? 'chip--mint' : 'chip--amber') + '</div>'
    + '<div class="note" style="margin-bottom:12px">' + groupId + ' · ' + current.members + ' 位成员 · 创建于 ' + fmtStamp(current.createdAt || '') + '</div>'
    + '<div class="field"><label>回复模式</label><select id="groupMode">' + GROUP_MODES.map(([value, label]) => '<option value="' + value + '"' + ((current.modeKey || 'mention') === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></div>'
    + '<div class="field"><label>每小时上限（条）</label><input id="groupMax" type="number" value="' + (current.maxPerHour || 0) + '" /></div>'
    + '<div class="field"><label>发言冷却（秒）</label><input id="groupCooldown" type="number" value="' + (current.cooldown || 0) + '" /></div>'
    data-group-save="' + groupId + '">保存全部</button>'
    + '<button class="btn" data-group-delete="' + groupId + '">删除群</button></div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">外部 osu! bot</span><span class="muted" style="font-size:12px">这个群允许谁回复</span></div><div class="rows">'
    + ['yumu', 'kanon', 'hydrant', 'lazybot'].map((bot) => '<div class="row"><div class="row-main"><div class="row-title">' + bot + '</div><div class="row-sub">' + (botConfig[bot] ? '允许在本群回复' : '本群已禁用') + '</div></div>'
      + '<button class="switch ' + (botConfig[bot] ? 'is-on' : '') + '" data-group-bot="' + bot + '" data-bot-group="' + groupId + '"></button></div>').join('')
    + '</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">群画像</span><span style="cursor:pointer" data-group-profile="' + groupId + '">刷新</span></div><div id="groupProfileBody" class="note">加载中…</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">关系</span><span class="muted" style="font-size:12px">' + pairs.length + ' 对</span></div><div class="rows">'
    + (pairs.map((pair) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(pair.userA) + ' × ' + esc(pair.userB) + '</div><div class="row-sub">' + esc(pair.interactionStyle || '') + '</div></div></div>').join('') || '<div class="empty">这个群还没有关系画像</div>')
    + '</div></div>'
    + '<div class="card"><div class="card-head"><span class="card-title">成员</span><span class="muted" style="font-size:12px">' + members.length + ' 位</span></div><div class="rows">'
    + (members.slice(0, 8).map((user) => '<div class="row"><div class="row-main"><div class="row-title">' + esc(user.nickname || user.userId) + '</div><div class="row-sub">' + esc(user.userId) + '</div></div></div>').join('') || '<div class="empty">还没有成员记录</div>')
    + '</div></div>'
    + '</div></div>';
};

/* bot 开关：一次写一个 */
document.addEventListener('click', async function (event) {
  const bot = event.target.closest('[data-group-bot]');
  if (bot) {
    event.preventDefault();
    const groupId = bot.dataset.botGroup;
    const botId = bot.dataset.groupBot;
    const config = (LIVE.groupBotConfig || {})[groupId] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    const next = !config[botId];
    bot.classList.toggle('is-on', next);
    try {
      await callApi('/api/group-bot-config', { method: 'POST', body: JSON.stringify({ groupId, botId, enabled: next }) });
      LIVE.groupBotConfig[groupId] = Object.assign({}, config, { [botId]: next });
      const label = bot.parentElement.querySelector('.row-sub');
      if (label) label.textContent = next ? '允许在本群回复' : '本群已禁用';
      flash(botId + (next ? ' 已允许' : ' 已禁用'));
    } catch (error) {
      bot.classList.toggle('is-on', !next);
      flash('保存失败：' + error.message, 'danger');
    }
  }
}, true);

async function loadGroupExtras() {
  try { LIVE.groupBotConfig = (await callApi('/api/group-bot-config')).config || {}; } catch (error) { LIVE.groupBotConfig = {}; }
}

var __bootAllGroup = bootAll;
bootAll = async function () { await __bootAllGroup(); await loadGroupExtras(); render(window.__page || 'overview'); };
bootAll();

document.addEventListener('click', function (event) {
  const randomSwitch = event.target.closest('[data-group-random]');
  if (randomSwitch) {
    event.preventDefault();
    randomSwitch.classList.toggle('is-on');
    notify(randomSwitch.classList.contains('is-on') ? '已打开随机发图，记得保存' : '已关闭随机发图，记得保存', 'pink');
  }
}, true);
