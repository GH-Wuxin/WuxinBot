// WuxinBot console prototype — mock data only, no backend.
const DATA = {
  model: 'deepseek-flash', paused: false,
  points: [42,38,0,0,26,54,71,88,60,34,20,14,0,0,0,8,22,40,33,18,9,12,26,44],
  groupRows: [
    { name: '老干妈', id: 106717635, mode: '自然群友', enabled: true, members: 89, active: true },
    { name: "NakanoOoOo's MC #2", id: 682919016, mode: '轻度参与', enabled: true, members: 101, active: false },
    { name: 'shanden', id: 885215108, mode: '@ 回复', enabled: true, members: 56, active: false },
    { name: '闪灯杯', id: 712531032, mode: '@ 回复', enabled: true, members: 261, active: false },
    { name: '三角洲', id: 865512115, mode: '@ 回复', enabled: true, members: 6, active: true },
    { name: 'Lazybot', id: 1062372980, mode: '仅 osu! 指令', enabled: true, members: 16, active: false },
    { name: 'HD', id: 1106318435, mode: '@ 回复', enabled: true, members: 15, active: false }
  ],
  player: { name: 'Pippi', rank: 12340, pp: '8,231', acc: '98.20%', plays: '48,921', bps: [
    { rank: 1, title: 'Yomi yori Kikoyu', diff: 'Kyoufuu', stars: 7.8, pp: 612, mods: 'HDHR' },
    { rank: 2, title: 'Blue Zenith', diff: 'FOUR DIMENSIONS', stars: 7.4, pp: 587, mods: 'HR' },
    { rank: 3, title: 'The Sun, The Moon, The Star', diff: 'Eclipse', stars: 7.1, pp: 543, mods: 'HD' },
    { rank: 4, title: 'Freedom Dive', diff: 'Four Dimensions', stars: 6.9, pp: 501, mods: 'NM' },
    { rank: 5, title: 'Image Material', diff: 'INFINITY', stars: 6.6, pp: 476, mods: 'HD' },
    { rank: 6, title: 'Kimi no Kioku', diff: 'Memories', stars: 6.2, pp: 421, mods: 'HDDT' }
  ] },
  logs: [
    { user: 'b2', text: '真的假的', time: '10/19 12:09', group: '106717635', active: true, events: [
      { title: '收到群消息', sub: 'onebot_message_received · 12:09:26', tone: '' },
      { title: '回复闸门判定', sub: '仅 @ 时回复 → 不回复', tone: 'warn' },
      { title: '未调用工具', sub: 'reply_gate_decided · 0.4s', tone: 'ok' }
    ] },
    { user: 'Kaffu-', text: '窗外的天气 🌧 就像是你多变的表情 🎵', time: '10/19 12:09', group: '106717635', active: false, events: [] },
    { user: 'mikured', text: '元旦到底放多少天', time: '10/19 12:09', group: '106717635', active: false, events: [] },
    { user: '我爱说实话爱说实话', text: '踏吧踏吧踏吧踏吧', time: '10/19 12:09', group: '106717635', active: false, events: [] }
  ],
  members: [
    { name: '老干妈', qq: '106717635', group: '三角洲', role: '群主', bound: '10984982', msgs: 4821 },
    { name: 'Kaffu-', qq: '1903478548', group: '老干妈', role: '成员', bound: '—', msgs: 2140 },
    { name: 'mikured', qq: '2284319302', group: '老干妈', role: '管理', bound: '6699436', msgs: 1890 },
    { name: 'Hoshino Tented', qq: '1005042620', group: 'NakanoOoOo', role: '成员', bound: '10984982', msgs: 1203 }
  ]
};

const starColor = (stars) => { const hue = Math.max(0, Math.min(205, 205 - (stars - 1) * 27)); return 'hsl(' + hue + ' 90% 62%)'; };
const chip = (text, cls) => '<span class="chip ' + (cls || '') + '">' + text + '</span>';
const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';
const card = (title, body, more) => '<div class="card"><div class="card-head"><span class="card-title">' + title + '</span>' + (more ? '<a class="card-more" href="#">' + more + '</a>' : '') + '</div>' + body + '</div>';
const listRow = (left, title, sub, right) => '<div class="row">' + left + '<div class="row-main"><div class="row-title">' + title + '</div>' + (sub ? '<div class="row-sub">' + sub + '</div>' : '') + '</div>' + (right || '') + '</div>';
const avatar = (text, size) => '<span class="avatar" style="width:' + (size || 28) + 'px;height:' + (size || 28) + 'px;font-size:11px">' + text + '</span>';
const switchEl = (on) => '<button class="switch ' + (on ? 'is-on' : '') + '"></button>';
const barRow = (label, pct) => '<div class="bar-row"><span>' + label + '</span><div class="bar"><i style="width:' + pct + '%"></i></div><b>' + pct + '%</b></div>';
const pageHead = (title, sub, actions) => '<div class="page-head"><div><h1>' + title + '</h1><p>' + sub + '</p></div><div style="display:flex;gap:8px">' + (actions || '') + '</div></div>';
const PAGES = {};
const grid4 = (items) => '<div class="grid grid-4" style="margin-bottom:16px">' + items.map((s) => { const p = s.split('|'); return '<div class="card stat"><div class="stat-label">' + p[0] + '</div><div class="stat-value">' + p[1] + '</div><div class="stat-note">' + p[2] + '</div></div>'; }).join('') + '</div>';

PAGES.overview = () => {
  const max = Math.max.apply(null, DATA.points);
  const bars = DATA.points.map((v, i) => '<i style="height:' + Math.max(3, Math.round(v / max * 100)) + '%;animation-delay:' + (i * 16) + 'ms" data-hour="' + String(i).padStart(2, '0') + ':00" data-tokens="' + v + '"></i>').join('') + '<span class="chart-guide"></span><div class="chart-tip"></div>';
  return pageHead('总览', '这台机器人现在在做什么，今天花了多少。', '<button class="btn btn-ghost">刷新状态</button><button class="btn">更多操作</button>')
  + '<div class="hero"><div><span class="hero-eyebrow">WuxinBot · 在线</span>'
  + '<h2>今天已经回了 <em>1,374</em> 句话</h2><p>11 个群在跑 · 平均延迟 1.2 秒 · 缓存命中 48.5%</p></div>'
  + '<div class="hero-side"><div><span>今日 Token</span><b>68.7 万</b></div><div><span>经验成员</span><b>457</b></div><div><span>模型</span><b>flash</b></div></div></div>'
  
  + grid4(['机器人|运行中|OneBot 已连接 · 11 个群启用', '今日消息|1,374|00:00 至今', '今日 Token|68.7<span class="stat-unit">万</span>|昨日 74.7 万 · −8%', '经验成员|457|累计 4,440 次回复'])
  + '<div class="grid grid-main" style="margin-bottom:16px"><div class="card"><div class="card-head"><span class="card-title">Token 用量 · 24 小时</span><span class="muted" style="font-size:12px">821 次请求</span></div>'
  + '<div style="font:800 44px/1 var(--num);letter-spacing:-.04em;font-variant-numeric:tabular-nums">536.8<span style="font-size:18px;color:var(--muted);margin-left:6px">万</span></div>'
  + '<div class="chart">' + bars + '</div><div class="chart-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>'
  + '<div class="legend"><div><span>输入</span><strong>4,991,094</strong></div><div><span>输出</span><strong>376,697</strong></div><div><span>缓存命中</span><strong>2,422,784</strong></div><div><span>命中率</span><strong class="mint">48.5%</strong></div></div></div>'
  + '<div class="stack">' + card('运行状态', kv('QQ / OneBot', '<span class="mint">已连接</span>') + kv('模型平均延迟', '1.2 秒') + kv('近期模型错误', '无') + kv('当前模型', 'deepseek-flash'), '详情 →')
  + card('模型通道', '<div class="note">API 通道计费与本地 Token 是两个口径，这里不做换算。</div><div class="meter" style="margin-top:14px"><i style="width:62%"></i></div><div class="card-more" style="margin-top:8px">本月额度 62%</div>', '管理 →') + '</div></div>'
  + '<div class="grid grid-2">'
  + card('群聊', '<div class="rows">' + DATA.groupRows.slice(0, 5).map((g) => listRow(avatar(g.name.slice(0, 1)), g.name, g.members + ' 位成员 · ' + g.mode, chip(g.enabled ? '启用' : '停用', g.enabled ? 'chip--mint' : '') + switchEl(g.enabled))).join('') + '</div>', '全部 →')
  + card('最近回复', '<div class="rows">' + DATA.logs.map((l) => listRow(avatar(l.user.slice(0, 1)), l.user, l.text, '<span class="row-value" style="color:var(--muted);font-weight:500">' + l.time.split(' ')[1] + '</span>')).join('') + '</div>', '日志 →')
  + '</div>';
};

var selectedGroupId = '865512115';
var GROUP_DETAIL = {
  '106717635': { maxPerHour: 120, cooldown: 60, confidence: 88, evidence: 132, bots: ['雨沐', '猫猫', '消防栓'] },
  '682919016': { maxPerHour: 60, cooldown: 90, confidence: 74, evidence: 96, bots: ['雨沐'] },
  '885215108': { maxPerHour: 200, cooldown: 30, confidence: 92, evidence: 75, bots: ['雨沐', '猫猫'] },
  '712531032': { maxPerHour: 200, cooldown: 30, confidence: 81, evidence: 64, bots: ['雨沐', '猫猫', 'LazyBot'] },
  '865512115': { maxPerHour: 200, cooldown: 30, confidence: 92, evidence: 75, bots: ['雨沐', '猫猫', '消防栓', 'LazyBot'] },
  '1062372980': { maxPerHour: 40, cooldown: 120, confidence: 66, evidence: 28, bots: ['雨沐'] },
  '1106318435': { maxPerHour: 80, cooldown: 45, confidence: 71, evidence: 41, bots: ['雨沐', '猫猫'] }
};

window.selectGroup = function (id) {
  selectedGroupId = String(id);
  render('groups');
};

PAGES.groups = function () {
  var rows = DATA.groupRows;
  var current = rows.filter(function (row) { return String(row.id) === String(selectedGroupId); })[0] || rows[0];
  var detail = GROUP_DETAIL[String(current.id)] || { maxPerHour: 120, cooldown: 30, confidence: 80, evidence: 40, bots: ['雨沐'] };
  var list = rows.map(function (group) {
    var active = String(group.id) === String(selectedGroupId);
    return '<div class="row group-row' + (active ? ' is-selected' : '') + '" onclick="selectGroup(\'' + group.id + '\')">'
      + avatar(group.name.slice(0, 1), 30)
      + '<div class="row-main"><div class="row-title">' + group.name + ' ' + (group.active ? chip('最近活跃', 'chip--pink') : '') + '</div>'
      + '<div class="row-sub">' + group.id + ' · ' + group.members + ' 位成员 ' + chip(group.mode) + '</div></div>'
      + switchEl(group.enabled) + '</div>';
  }).join('');

  return pageHead('群聊', '左边选群，右边看这个群的策略；只读，改策略要等写操作那一轮。', '<button class="btn">刷新</button>')
    + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">搜索</span><input id="groupSearch" placeholder="群名、群号或活跃成员" />' + chip(rows.length + ' 个群') + '</div>'
    + '<div class="grid grid-main">'
    + '<div class="card"><div class="card-head"><span class="card-title">已配置群</span><span class="muted" style="font-size:12px">按最近活跃排序</span></div><div class="rows" id="groupList">' + list + '</div></div>'
    + '<div class="stack">'
    + '<div class="card"><div class="card-head"><span class="card-title">' + current.name + '</span>' + chip(current.enabled ? '启用中' : '已停用', current.enabled ? 'chip--mint' : 'chip--amber') + '</div>'
    + '<div class="note" style="margin-bottom:12px">' + current.id + ' · ' + current.members + ' 位成员</div>'
    + kv('回复模式', current.mode) + kv('每小时上限', detail.maxPerHour + ' 条') + kv('发言冷却', detail.cooldown + ' 秒')
    + kv('群画像置信度', detail.confidence + '% · ' + detail.evidence + ' 条依据') + kv('群内 Bot', detail.bots.length + ' 个')
    + '<div style="display:flex;gap:8px;margin-top:16px"><button class="btn" style="flex:1" onclick="openGroupProfile(\'' + current.name + '\')">查看群画像</button></div>'
    + '</div>'
    + card('群内 Bot（只读）', '<div class="rows">' + ['雨沐', '猫猫', '消防栓', 'LazyBot'].map(function (name) {
        var on = detail.bots.indexOf(name) >= 0;
        return listRow('', name, on ? '该群启用' : '未启用', switchEl(on));
      }).join('') + '</div>')
    + '</div></div>';
};

PAGES.osu = () => pageHead('osu!', '能力、数据源和调用情况；查谁不是这一页的重点。', '<button class="btn">刷新状态</button>')
  + grid4(['今日调用|128|osu! 工具合计', '成功率|99.2%|近 24 小时', '平均耗时|1.4 秒|含谱面分析', 'API 429|0|未触发限流'])
  + '<div class="grid grid-main">'
  + '<div class="card"><div class="card-head"><span class="card-title">工具调用</span><span class="muted" style="font-size:12px">最近 24 小时 · 128 次</span></div>'
  + '<table class="table"><thead><tr><th>时间</th><th>工具</th><th>目标</th><th>耗时</th><th>结果</th></tr></thead><tbody>'
  + [
    ['12:09', 'osu_get_best_score', 'Pippi · BP3', '1.2s', 'ok'],
    ['12:07', 'osu_player_skill', 'Pippi', '21.6s', 'ok'],
    ['12:04', 'osu_beatmap_skill', 'BID 4288226', '6.7s', 'fail'],
    ['12:01', 'osu_send_score_card', 'Pippi · BP3', '3.4s', 'ok'],
    ['11:58', 'osu_compare_skill', 'A × B', '32.1s', 'ok'],
    ['11:52', 'search_web', 'yomi yori', '1.1s', 'ok']
  ].map((row) => '<tr><td class="muted">' + row[0] + '</td><td><span class="tool-name">' + row[1] + '</span></td><td class="muted">' + row[2] + '</td><td>' + row[3] + '</td><td>' + (row[4] === 'ok' ? chip('成功', 'chip--mint') : chip('降级', 'chip--amber')) + '</td></tr>').join('')
  + '</tbody></table>'
  + '<div class="note" style="margin-top:12px">降级指桥接或渲染不可用时退回内部实现，结果仍会返回，只是形态不同。</div></div>'
  + '<div class="stack">'
  + card('外部 osu! 服务', '<div class="rows">' + [['雨沐', '8388'], ['猫猫', '7700'], ['消防栓', '8800'], ['LazyBot', '1145']].map((a) => listRow('<span class="status-dot"></span>', a[0], '127.0.0.1:' + a[1], chip('可用', 'chip--mint'))).join('') + '</div>', '4 在线')
  + card('本地能力', kv('本地谱面库', '1,284 张') + kv('分类器', 'v0.40 · ATOMIC_V07') + kv('渲染服务', '<span class="mint">已连接</span>') + kv('缓存命中', '48.5%'))
  + '</div></div>'
  + '<div class="grid grid-2" style="margin-top:16px">'
  + card('当前工具面', '<div style="display:flex;flex-wrap:wrap;gap:6px">' + ['best_score', 'best_scores', 'player', 'pp_plus', 'bp_type', 'recommend', 'beatmap', 'pp_calc', 'leaderboard', 'beatmap_skill', 'player_skill', 'recent_skill', 'compare_skill'].map((n) => chip(n)).join('') + '</div><div class="note" style="margin-top:10px">文本 13 个；发图 7 个，只在第一层数据回来后出现。</div>', '工具说明 →')
  + card('绑定', '<div class="rows">' + [['Hoshino Tented', '10984982'], ['Fyu_Neru', '6699436'], ['Stick_Fish', '13358640']].map((a) => listRow('', a[0], 'osu! ' + a[1], '<button class="btn btn-ghost" style="font-size:12px">解绑</button>')).join('') + '</div>', '185 个 →')
  + '</div>';

PAGES.logs = () => pageHead('日志', '一条消息从进来到决定回不回，每一步都能查。', '<button class="btn btn-ghost">导出诊断</button>' + chip('实时连接', 'chip--mint'))
  + '<div class="logs"><div class="card"><div class="card-head"><span class="card-title">最近记录</span><span class="muted" style="font-size:12px">160 条 · 每页 8 条</span></div><div class="rows" id="logList">'
  + DATA.logs.map((l) => '<div class="log-item ' + (l.active ? 'is-active' : '') + '" data-user="' + l.user + '"><div style="display:flex;justify-content:space-between"><span class="log-user">' + l.user + '</span>' + chip('未回复') + '</div><div class="log-text">' + l.text + '</div><div class="log-time">' + l.time + ' · ' + l.group + ' · — Token · 0.5s</div></div>').join('')
  + '</div></div><div class="card"><div class="card-head"><span class="card-title">b2 的消息</span>' + chip('未回复', 'chip--amber') + '</div><div class="muted" style="font-size:12px">106717635 · 1903478548 · 10/19 12:09:26</div><div class="log-text" style="margin:14px 0">真的假的</div><div class="card-title" style="margin-top:20px">请求时间线</div><div class="timeline">'
  + DATA.logs[0].events.map((e) => '<div class="tl ' + (e.tone === 'ok' ? 'is-ok' : e.tone === 'warn' ? 'is-warn' : '') + '"><span class="tl-dot"></span><div><div class="tl-title">' + e.title + '</div><div class="tl-sub">' + e.sub + '</div></div></div>').join('')
  + '</div></div></div>';

PAGES.randomImages = () => pageHead('随机发图', '独立的随机表情包模块，和聊天回复互不影响。', '<button class="btn">预览概率</button>')
  + grid4(['今日发送|12|过去 24 小时', '命中群|3|有画像的群', '当前概率|1 / 25|每次回复掷一次', '图池|64 张|本地目录'])
  + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">图池</span><a class="card-more" href="#">管理目录 →</a></div><div class="grid-tiles">' + Array.from({ length: 12 }, (_, i) => '<div class="tile">' + (i + 1) + '</div>').join('') + '</div></div>'
  + '<div class="stack">' + card('发送设置', kv('总开关', '<span class="mint">开启</span>') + kv('触发概率', '1 / 25') + kv('冷却', '10 分钟') + kv('参与群', '3 个') + '<button class="btn btn-primary" style="margin-top:16px;width:100%">保存</button>')
  + card('最近发送', '<div class="rows">' + [['三角洲','12:04','#07'],['老干妈','11:52','#19'],['三角洲','11:31','#03']].map((a) => listRow('', a[0] + ' · ' + a[2], '发送成功', '<span class="row-value" style="color:var(--muted)">' + a[1] + '</span>')).join('') + '</div>') + '</div></div>';

PAGES.agent = () => pageHead('Agent', '在沙盒里看它怎么想、怎么调工具，再决定要不要上线。', '<button class="btn btn-ghost">清空</button><button class="btn">保存配置</button>')
  + '<div class="grid grid-main"><div class="stack">' + card('最近决策', '<div class="rows">' + [['12:08','BP3 → 成绩卡','2 次工具 · 1.8s'],['11:57','推荐谱面','1 次工具 · 2.4s'],['11:40','闲聊，不调用','0 次工具 · 0.6s']].map((a) => listRow('', a[1], a[0] + ' · ' + a[2], chip('完成', 'chip--mint'))).join('') + '</div>') + '</div>'
  + '<div class="stack">' + card('运行配置', kv('运行时', 'model_first（两层工具）') + kv('单轮工具上限', '6') + kv('单轮并发', '4') + kv('证据兜底', '开启') + kv('搜索', 'balanced'))
  + card('本轮工具面', '<div style="display:flex;flex-wrap:wrap;gap:6px">' + ['best_score','best_scores','player','pp_plus','bp_type','recommend','beatmap','pp_calc','leaderboard'].map((n) => chip(n)).join('') + '</div><div class="note" style="margin-top:10px">发图工具在第一层数据回来后才会出现。</div>') + '</div></div>';

PAGES.members = () => pageHead('成员', '谁在这个群里、什么身份、绑没绑 osu!。', '<button class="btn">导出</button>')
  + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">搜索</span><input placeholder="昵称或 QQ 号" /></div>'
  + '<div class="grid grid-main"><div class="card"><table class="table"><thead><tr><th>昵称</th><th>QQ</th><th>群</th><th>身份</th><th>osu!</th><th>消息</th></tr></thead><tbody>'
  + DATA.members.map((m) => '<tr><td><b>' + m.name + '</b></td><td class="muted">' + m.qq + '</td><td>' + m.group + '</td><td>' + chip(m.role, m.role === '群主' ? 'chip--pink' : '') + '</td><td class="muted">' + m.bound + '</td><td>' + m.msgs.toLocaleString() + '</td></tr>').join('')
  + '</tbody></table></div><div class="stack">' + card('Hoshino Tented', kv('QQ', '1005042620') + kv('群', "NakanoOoOo's MC #2") + kv('身份', '成员') + kv('osu!', '10984982') + kv('记忆条数', '17 条'))
  + card('最近动态', '<div class="rows">' + [['21:14','发了 12 条消息'],['20:02','被记录 1 条记忆'],['18:40','查了一次 BP']].map((a) => listRow('', a[1], a[0], '')).join('') + '</div>') + '</div></div>';

PAGES.persona = () => pageHead('人设', '按实际调用模块查看人格是如何注入的。', '<button class="btn btn-ghost">刷新调用记录</button><button class="btn btn-primary">保存更改</button>')
  + '<div class="grid" style="grid-template-columns:260px minmax(0,1fr);gap:16px"><div class="card"><div class="card-head"><span class="card-title">人格层</span></div><div class="rows">'
  + ['完整人格核心','osu! 分析人格','osu! 基础知识','事实边界','日常聊天场景','命令反馈场景','群聊形态','被 @ 时的回答形态'].map((n, i) => '<div class="row" style="' + (i === 0 ? 'background:var(--pink-soft);border-radius:10px' : '') + '"><div class="row-main"><div class="row-title">' + n + '</div></div></div>').join('')
  + '</div></div><div class="stack"><div class="card"><div class="card-head"><span class="card-title">完整人格核心</span>' + chip('PERSONA LAYER') + '</div><div class="note" style="margin-bottom:14px">日常、命令与严肃对话共用的身份、性格和表达方式。</div><div class="field"><label>Prompt 内容</label><textarea>你是 pippi，osu! 的吉祥物。pippi 是完整而持续的身份，不是“普通 AI 助手”。</textarea></div><div class="muted" style="font-size:12px">没有覆盖时会直接使用代码内置文本；保存后只对新发起的请求生效。</div></div>'
  + card('实际整理调用', '<div class="rows">' + [['12:09','群聊 · 完整人格核心 + 日常聊天场景'],['12:04','查 BP · 完整人格核心 + osu! 分析人格'],['11:58','闲聊 · 完整人格核心']].map((a) => listRow('', a[1], a[0], '')).join('') + '</div>', '32 条') + '</div></div>';

PAGES.memory = () => pageHead('记忆', '长期画像和近期动态分开放，别把一次闲聊当成永久印象。', '<button class="btn">重算画像</button>')
  + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">搜索</span><input placeholder="昵称、QQ 或记忆内容" /></div>'
  + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">记忆条目</span><span class="muted" style="font-size:12px">按最近更新</span></div><div class="rows">'
  + [['老干妈','最近沉迷 7★ 跳图，喜欢 HDHR。','2 小时前'],['Kaffu-','在准备考试，晚上活跃。','昨天'],['mikured','常问天气和放假安排。','3 天前']].map((a) => listRow(avatar(a[0].slice(0, 1)), a[0], a[1], '<span class="row-value" style="color:var(--muted);font-weight:500">' + a[2] + '</span>')).join('')
  + '</div></div><div class="stack">' + card('记忆策略', kv('长期画像', '开启') + kv('近期动态', '7 天') + kv('单群上限', '500 条') + kv('写入方式', 'LLM 提取 + 人工确认'))
  + card('本周变化', barRow('新增记忆', 68) + barRow('更新记忆', 41) + barRow('被覆盖', 12)) + '</div></div>';

PAGES.relationships = () => pageHead('关系', '谁和谁熟，靠一起出现和互动的证据说话。', '<button class="btn">重新计算</button>')
  + '<div class="grid grid-main"><div class="card"><div class="card-head"><span class="card-title">关系强度</span><span class="muted" style="font-size:12px">共 28 对</span></div>'
  + [['老干妈 × Kaffu-', 86], ['mikured × 闪灯杯', 72], ['三角洲 × Lazybot', 58], ['老干妈 × mikured', 44], ['Hoshino × Kaffu-', 31]].map((a) => barRow(a[0], a[1])).join('')
  + '</div><div class="stack">' + card('画像口径', '<div class="note">关系强度由共同出现次数、互相 @、连续对话轮次加权得到；不包含私聊内容。</div>')
  + card('最近变化', '<div class="rows">' + [['老干妈 × Kaffu-','本周 +12'],['mikured × 闪灯杯','本周 +7'],['三角洲 × Lazybot','本周 −3']].map((a) => listRow('', a[0], a[1], '')).join('') + '</div>') + '</div></div>';

PAGES.profileLogs = () => pageHead('画像日志', '每次画像更新都留一条证据，方便回查为什么这么记。', '<button class="btn">导出</button>')
  + '<div class="searchbar" style="margin-bottom:16px"><span class="muted">筛选</span><input placeholder="按成员或关键词" /><div class="seg"><button class="is-active">全部</button><button>新增</button><button>覆盖</button></div></div>'
  + '<div class="card"><table class="table"><thead><tr><th>时间</th><th>成员</th><th>类型</th><th>变化</th><th>来源</th></tr></thead><tbody>'
  + [['10/19 12:08','老干妈','更新','最近沉迷 7★ 跳图 → 加入 HDHR','群聊证据 · 32 条'],['10/18 21:40','Kaffu-','新增','在准备考试，晚上活跃','群聊证据 · 11 条'],['10/17 09:12','mikured','覆盖','常问天气 → 常问天气和放假安排','群聊证据 · 6 条']].map((a) => '<tr><td class="muted">' + a[0] + '</td><td><b>' + a[1] + '</b></td><td>' + chip(a[2], a[2] === '新增' ? 'chip--mint' : '') + '</td><td>' + a[3] + '</td><td class="muted">' + a[4] + '</td></tr>').join('')
  + '</tbody></table></div>';

PAGES.model = () => pageHead('模型', '换模型只影响之后的请求，已经在跑的不受影响。', '<button class="btn btn-ghost">测试连接</button><button class="btn btn-primary">保存模型设置</button>')
  + '<div class="card" style="margin-bottom:16px"><div style="display:flex;align-items:center;gap:16px"><span class="brand-puck" style="box-shadow:none">AI</span><div><div class="muted" style="font-size:12px">当前运行模型</div><div style="font-size:20px;font-weight:800;letter-spacing:-.02em">deepseek-flash</div></div><span style="margin-left:auto" class="muted">设置已同步</span></div></div>'
  + '<div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px">' + card('供应商与模型', '<div class="field"><label>接口供应商</label><select><option>DeepSeek（默认）</option><option>OpenAI 兼容</option><option>Codex 配额</option></select></div><div class="field"><label>API Key</label><input placeholder="已配置；留空不覆盖" /></div><div class="field"><label>API 地址</label><input value="https://api.deepseek.com" /></div><div class="field"><label>模型</label><select><option>deepseek-flash</option><option>deepseek-v4-pro</option></select></div>')
  + '<div class="stack">' + card('用量与限额', kv('本月请求', '8,214') + kv('本月 Token', '2.1 亿') + kv('平均延迟', '1.2 秒') + kv('错误率', '0.3%') + '<div class="meter" style="margin-top:14px"><i style="width:62%"></i></div><div class="note" style="margin-top:8px">额度使用 62%</div>')
  + card('视觉与搜索', kv('视觉模型', 'deepseek-flash') + kv('联网搜索', 'balanced') + kv('搜索供应商', 'Tavily')) + '</div></div>';

PAGES.integrations = () => pageHead('集成', 'OneBot 和外部服务都在这一页，断了会直接标红。', '<button class="btn">测试全部</button>')
  + '<div class="grid grid-2"><div class="stack">' + card('OneBot v11', kv('传输', 'HTTP 127.0.0.1:3000') + kv('上报', 'POST /onebot/event') + kv('状态', '<span class="mint">已连接</span>') + kv('账号', '1005042620'), '文档 →')
  + card('外部 osu! bot', '<div class="rows">' + [['雨沐','8388'],['猫猫','7700'],['消防栓','8800'],['LazyBot','1145']].map((a) => listRow('<span class="status-dot"></span>', a[0], 'ws://127.0.0.1:' + a[1], chip('已连接', 'chip--mint'))).join('') + '</div>') + '</div>'
  + '<div class="stack">' + card('联网搜索', kv('供应商', 'Tavily') + kv('模式', 'balanced') + kv('单轮上限', '2 次'))
  + card('Webhook / 回调', kv('控制台地址', 'http://127.0.0.1:8787') + kv('回调鉴权', '已开启') + '<div class="note" style="margin-top:10px">回调只接受来自 OneBot 的签名请求。</div>') + '</div></div>';

PAGES.permissions = () => pageHead('权限', '谁能用哪条命令，按群和身份分开。', '<button class="btn btn-primary">保存权限</button>')
  + '<div class="card"><table class="table"><thead><tr><th>命令</th><th>说明</th><th>群员</th><th>管理</th><th>主人</th></tr></thead><tbody>'
  + [['bp','查 BP','x','x','x'],['recent','最近成绩','x','x','x'],['skill','技能分析','x','x','x'],['pause','暂停机器人','','','x'],['preset','切换预设','','','x'],['maintenance','维护操作','','','x']].map((a) => '<tr><td><b>' + a[0] + '</b></td><td class="muted">' + a[1] + '</td>' + a.slice(2).map((v) => '<td>' + (v === 'x' ? '<span class="pink">✓</span>' : '<span class="muted">—</span>') + '</td>').join('') + '</tr>').join('')
  + '</tbody></table><div class="note" style="margin-top:12px">改完立刻生效；对已在进行中的请求无效。</div></div>';

PAGES.maintenance = () => pageHead('维护', '备份、恢复、重算，都在这里，谨慎操作。', '')
  + '<div class="grid grid-2"><div class="card"><div class="card-head"><span class="card-title">备份</span><button class="btn">立即备份</button></div><table class="table"><thead><tr><th>时间</th><th>大小</th><th></th></tr></thead><tbody>'
  + [['10/19 03:00','4.2 MB'],['10/18 03:00','4.1 MB'],['10/17 03:00','4.0 MB']].map((a) => '<tr><td class="muted">' + a[0] + '</td><td>' + a[1] + '</td><td style="text-align:right"><button class="btn btn-ghost" style="font-size:12px">恢复</button></td></tr>').join('')
  + '</tbody></table></div><div class="stack"><div class="card"><div class="card-head"><span class="card-title">重算任务</span></div>' + kv('群画像', '队列中 2') + kv('成员记忆', '空闲') + kv('关系强度', '空闲') + '<button class="btn" style="margin-top:14px">全部重算</button></div>'
  + '<div class="card danger"><div class="card-title">危险操作</div><div class="note" style="margin:8px 0 14px">会清空运行时缓存并断开所有外部 bot，不会删数据。</div><div style="display:flex;gap:8px"><button class="btn">清空缓存</button><button class="btn">重启服务</button></div></div></div></div>';

const PROCESS_GROUPS = [
  { label: '数据库', items: [
    { name: 'PostgreSQL', launch: '本窗口启动', pids: ['31400', '32276', '30896', '29768', '28944', '30828', '31880', '17624', '24396', '11600'], enabled: true, oneClick: true, auto: true },
    { name: 'MariaDB', launch: '本窗口启动', pids: ['32092', '31856'], enabled: true, oneClick: true, auto: true }
  ] },
  { label: 'PP+ / 外部 Bot', items: [
    { name: 'PP+ PerformancePlus', launch: '本窗口启动', pids: ['31816', '32712'], enabled: true, oneClick: true, auto: true },
    { name: 'PP+ Aggregate', launch: '本窗口启动', pids: ['3412', '24224'], enabled: true, oneClick: true, auto: true }
  ] },
  { label: '外部 Bot', items: [
    { name: 'yumu-image 渲染器', launch: '本窗口启动', pids: ['33012', '36552', '33540', '35624', '36564', '36744', '33228', '13256', '35584', '3424', '1400', '40716', '33524', '28208', '20068', '43688'], enabled: true, oneClick: true, auto: true },
    { name: '雨沐 YumuBot', launch: '本窗口启动', pids: ['35064', '7536'], enabled: true, oneClick: true, auto: true },
    { name: '猫猫 KanonBot', launch: '本窗口启动', pids: ['38024', '38172'], enabled: true, oneClick: true, auto: true },
    { name: '消防栓 Hydrant', launch: '本窗口启动', pids: ['38704', '38636'], enabled: true, oneClick: true, auto: true },
    { name: 'LazyBot', launch: '本窗口启动', pids: ['39228', '39180'], enabled: true, oneClick: true, auto: true }
  ] },
  { label: '消息入口', items: [
    { name: 'NapCat / QQ', launch: '本窗口启动', pids: ['27928', '28452', '38992', '39116', '12036', '28376'], enabled: true, oneClick: true, auto: true }
  ] },
  { label: '分析服务', items: [
    { name: 'Skill Profiler', launch: '本窗口启动', pids: ['35616', '25488', '37092', '11524', '17684', '13540', '18444', '44656'], enabled: true, oneClick: true, auto: true }
  ] },
  { label: '核心服务', items: [
    { name: 'WuxinBot', launch: '外部运行', pids: ['39440'], enabled: true, oneClick: false, auto: true }
  ] }
];

const procCard = (item) => {
  const pidText = item.pids.slice(0, 4).join(', ') + (item.pids.length > 4 ? ' …（共 ' + item.pids.length + ' 个）' : '');
  return '<div class="proc">'
    + '<div class="proc-head"><span class="status-dot"></span><b>' + item.name + '</b>' + chip('运行中', 'chip--mint') + '</div>'
    + '<div class="proc-meta">' + item.launch + ' · PID ' + pidText + '</div>'
    + '<div class="proc-toggles">'
    + [['进程启用', item.enabled], ['参与一键启动', item.oneClick], ['自动启动', item.auto]].map((a) => '<span class="proc-toggle">' + a[0] + switchEl(a[1]) + '</span>').join('')
    + '</div>'
    + '<div class="proc-actions"><button class="btn btn-sm">启动</button><button class="btn btn-sm">停止</button><button class="btn btn-sm">重启</button><button class="btn btn-sm btn-ghost">配置</button></div>'
    + '</div>';
};

PAGES.runtime = () => {
  const total = PROCESS_GROUPS.reduce((sum, group) => sum + group.items.length, 0);
  const running = PROCESS_GROUPS.reduce((sum, group) => sum + group.items.filter((item) => item.enabled).length, 0);
  const pids = PROCESS_GROUPS.reduce((sum, group) => sum + group.items.reduce((n, item) => n + item.pids.length, 0), 0);
  return pageHead('运行控制', '这台机器上真正在跑的进程；谁能一键启动、谁只是外部进程，都写清楚。', '<button class="btn btn-primary">一键启动</button><button class="btn">全部停止</button>')
  + grid4(['组件|' + total + '|本窗口管理', '运行中|' + running + '|全部正常', '进程数|' + pids + '|含子进程', '外部运行|1|WuxinBot 自身'])
  + PROCESS_GROUPS.map((group) => '<section class="proc-group"><div class="proc-group-head"><span class="proc-eyebrow">PROCESS GROUP</span><h2>' + group.label + '</h2><span class="muted">' + group.items.length + ' 个组件</span></div>' + group.items.map(procCard).join('') + '</section>').join('');
};

const PRIMARY = ['overview', 'groups', 'osu', 'logs', 'runtime'];
const view = document.getElementById('view');
const moreMenu = document.getElementById('moreMenu');
function wireChart() {
  const chart = document.querySelector('.chart');
  if (!chart) return;
  const tip = chart.querySelector('.chart-tip');
  const guide = chart.querySelector('.chart-guide');
  const total = DATA.points.reduce((sum, n) => sum + n, 0) || 1;
  chart.querySelectorAll('i').forEach((bar) => {
    bar.addEventListener('animationend', () => { bar.style.animation = 'none'; }, { once: true });
    const enter = () => {
      const x = bar.offsetLeft + bar.offsetWidth / 2;
      const share = Math.round(Number(bar.dataset.tokens) / total * 1000) / 10;
      chart.classList.add('is-hovering');
      bar.classList.add('is-hot');
      tip.innerHTML = '<b>' + bar.dataset.tokens + ' 万</b><small>' + bar.dataset.hour + ' · 占 ' + share + '%</small>';
      tip.style.left = x + 'px';
      tip.style.top = bar.offsetTop + 'px';
      tip.classList.add('is-on');
      guide.style.left = x + 'px';
      guide.classList.add('is-on');
    };
    const leave = () => {
      chart.classList.remove('is-hovering');
      bar.classList.remove('is-hot');
      tip.classList.remove('is-on');
      guide.classList.remove('is-on');
    };
    bar.addEventListener('pointerenter', enter);
    bar.addEventListener('pointerleave', leave);
    bar.addEventListener('focus', enter);
    bar.addEventListener('blur', leave);
  });
}

function wire() {
  document.querySelectorAll('.switch').forEach((el) => el.addEventListener('click', () => el.classList.toggle('is-on')));
  document.querySelectorAll('.log-item').forEach((el) => el.addEventListener('click', () => {
    document.querySelectorAll('.log-item').forEach((n) => n.classList.remove('is-active'));
    el.classList.add('is-active');
  }));
  document.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    seg.querySelectorAll('button').forEach((n) => n.classList.remove('is-active')); btn.classList.add('is-active');
  }));
  const search = document.getElementById('groupSearch');
  if (search) search.addEventListener('input', () => {
    const needle = search.value.trim().toLowerCase();
    document.querySelectorAll('#groupList .row').forEach((row) => { row.style.display = row.dataset.name.toLowerCase().includes(needle) ? '' : 'none'; });
  });
}

function countUp(scope) {
  scope.querySelectorAll('.stat-value, .hero em, .hero-side b').forEach((el) => {
    const node = [...el.childNodes].find((child) => child.nodeType === 3 && /\d/.test(child.textContent));
    if (!node) return;
    const raw = node.textContent.trim();
    const numeric = (raw.match(/[0-9.,]+/) || [''])[0];
    const target = Number(numeric.replace(/,/g, ''));
    if (!Number.isFinite(target) || target <= 0) return;
    const decimals = (numeric.split('.')[1] || '').length;
    const started = performance.now();
    const duration = 680;
    const tick = (now) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = target * eased;
      node.textContent = decimals
        ? value.toFixed(decimals)
        : Math.round(value).toLocaleString('en-US');
      if (progress < 1) requestAnimationFrame(tick);
      else node.textContent = decimals ? target.toFixed(decimals) : target.toLocaleString('en-US');
    };
    requestAnimationFrame(tick);
  });
}

function render(page) {
  view.innerHTML = PAGES[page] ? PAGES[page]() : PAGES.overview();
  document.querySelectorAll('.tab').forEach((tab) => {
    const id = tab.dataset.page;
    tab.classList.toggle('is-active', id === page || (id === '__more' && !PRIMARY.includes(page)));
  });
  moreMenu.hidden = true;
  wire();
  wireChart();
  countUp(view);
}
window.goto = render;
document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab'); if (!tab) return;
  if (tab.dataset.page === '__more') { moreMenu.hidden = !moreMenu.hidden; return; }
  render(tab.dataset.page);
});
moreMenu.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-page]'); if (btn) render(btn.dataset.page);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#moreMenu') && !event.target.closest('#moreBtn')) moreMenu.hidden = true;
});
const pauseBtn = document.getElementById('pauseBtn');
pauseBtn.addEventListener('click', () => {
  DATA.paused = !DATA.paused;
  pauseBtn.textContent = DATA.paused ? '恢复' : '暂停';
  pauseBtn.classList.toggle('btn-primary', DATA.paused);
  document.querySelector('.status-dot').style.background = DATA.paused ? 'var(--amber)' : 'var(--mint)';
  document.querySelector('.status-text').textContent = DATA.paused ? '已暂停 · ' + DATA.model : '已连接 · ' + DATA.model;
  var eyebrow = document.querySelector('.hero-eyebrow');
  if (eyebrow) eyebrow.textContent = DATA.paused ? 'WuxinBot · 已暂停' : 'WuxinBot · 在线';
  var firstStat = document.querySelector('#view .stat .stat-value');
  if (firstStat && /运行中|已暂停/.test(firstStat.textContent)) {
    firstStat.textContent = DATA.paused ? '已暂停' : '运行中';
  }
  var firstNote = document.querySelector('#view .stat .stat-note');
  if (firstNote && /OneBot/.test(firstNote.textContent)) {
    firstNote.textContent = DATA.paused ? '暂停期间不会回复任何消息' : 'OneBot 已连接 · 11 个群启用';
  }
});
render('overview');


/* ================== 只读增强层 ================== */
function esc(value) { return String(value == null ? '' : value); }
function readGrid(rows) {
  return '<dl class="read-grid">' + rows.map(function (row) { return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>'; }).join('') + '</dl>';
}
function ensureDrawerRoot() {
  var root = document.getElementById('drawerRoot');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'drawerRoot';
  root.className = 'drawer-root';
  root.innerHTML = '<div class="drawer-backdrop" onclick="closeDrawer()"></div>'
    + '<aside class="drawer" role="dialog" aria-modal="true">'
    + '<div class="drawer-head"><div><h3 id="drawerTitle"></h3><p id="drawerSub"></p></div><button class="drawer-close" onclick="closeDrawer()" aria-label="关闭">×</button></div>'
    + '<div class="drawer-tabs" id="drawerTabs"></div>'
    + '<div class="drawer-body" id="drawerBody"></div>'
    + '</aside>';
  document.body.appendChild(root);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeDrawer(); });
  return root;
}
var drawerTabsCache = [];
function openDrawer(config) {
  var root = ensureDrawerRoot();
  document.getElementById('drawerTitle').textContent = config.title || '';
  document.getElementById('drawerSub').textContent = config.sub || '';
  drawerTabsCache = config.tabs || [];
  var tabsEl = document.getElementById('drawerTabs');
  tabsEl.innerHTML = drawerTabsCache.map(function (tab, index) {
    return '<button class="' + (index === 0 ? 'is-active' : '') + '" onclick="drawerTab(' + index + ')">' + esc(tab.label) + '</button>';
  }).join('');
  drawerTab(0);
  root.classList.add('is-open');
}
function drawerTab(index) {
  var tabsEl = document.getElementById('drawerTabs');
  Array.prototype.forEach.call(tabsEl.children, function (node, i) { node.classList.toggle('is-active', i === index); });
  document.getElementById('drawerBody').innerHTML = drawerTabsCache[index] ? drawerTabsCache[index].html : '';
}
function closeDrawer() { var root = document.getElementById('drawerRoot'); if (root) root.classList.remove('is-open'); }
window.closeDrawer = closeDrawer;
window.drawerTab = drawerTab;

/* ---------- 顶栏全局搜索 ---------- */
var SEARCH_INDEX = [
  { label: '老干妈', kind: '群聊', page: 'groups' },
  { label: '三角洲', kind: '群聊', page: 'groups' },
  { label: 'Lazybot', kind: '群聊', page: 'groups' },
  { label: 'Kaffu-', kind: '成员', page: 'members' },
  { label: 'mikured', kind: '成员', page: 'members' },
  { label: 'Hoshino Tented', kind: '成员', page: 'members' },
  { label: '老干妈 · 7★ 跳图 HDHR', kind: '记忆', page: 'memory' },
  { label: 'Kaffu- · 准备考试', kind: '记忆', page: 'memory' }
];
(function mountSearch() {
  var bar = document.querySelector('.topbar');
  if (!bar || document.querySelector('.shell-search')) return;
  var wrap = document.createElement('div');
  wrap.className = 'shell-search';
  wrap.innerHTML = '<input id="shellSearch" placeholder="搜索群、成员、记忆" aria-label="全局搜索" />'
    + '<div class="shell-results" id="shellResults"></div>';
  bar.insertBefore(wrap, document.querySelector('.topbar-right'));
  var input = wrap.querySelector('#shellSearch');
  var results = wrap.querySelector('#shellResults');
  input.addEventListener('input', function () {
    var needle = input.value.trim().toLowerCase();
    if (!needle) { results.classList.remove('is-open'); results.innerHTML = ''; return; }
    var hits = SEARCH_INDEX.filter(function (item) { return item.label.toLowerCase().indexOf(needle) >= 0; }).slice(0, 8);
    results.innerHTML = hits.length
      ? hits.map(function (item) { return '<button onclick="searchGo(\'' + item.page + '\')"><span>' + esc(item.label) + '</span><small>' + item.kind + '</small></button>'; }).join('')
      : '<button disabled><span>没有匹配</span><small>—</small></button>';
    results.classList.add('is-open');
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.shell-search')) results.classList.remove('is-open');
  });
})();
function searchGo(page) {
  closeDrawer();
  render(page);
  var results = document.getElementById('shellResults');
  if (results) results.classList.remove('is-open');
  var input = document.getElementById('shellSearch');
  if (input) input.value = '';
}
window.searchGo = searchGo;

/* ---------- osu! 查人抽屉 ---------- */
var PLAYER = {
  name: 'Pippi', rank: 12340, pp: '8,231', acc: '98.20%', plays: '48,921',
  bp: [
    ['1', 'Yomi yori Kikoyu', 'Kyoufuu', '7.8', 'HDHR', '612'],
    ['2', 'Blue Zenith', 'FOUR DIMENSIONS', '7.4', 'HR', '587'],
    ['3', 'The Sun, The Moon, The Star', 'Eclipse', '7.1', 'HD', '543'],
    ['4', 'Freedom Dive', 'Four Dimensions', '6.9', 'NM', '501'],
    ['5', 'Image Material', 'INFINITY', '6.6', 'HD', '476']
  ],
  recent: [
    ['12:04', 'Freedom Dive', '6.9★', '98.1%', '412pp'],
    ['11:41', 'Image Material', '6.6★', '97.4%', '381pp'],
    ['10:52', 'Blue Zenith', '7.4★', '99.0%', '604pp']
  ],
  pplus: [['跳跃', 17.4], ['速度', 15.8], ['准确', 14.9], ['耐力', 13.2], ['读图', 12.6]],
  types: [['跳跃 aim', 62], ['切换 alt', 21], ['技术 tech', 12], ['串图 stream', 5]],
  skill: { tier: 'EXPERT', title: '跳跃型', axes: [['跳跃瞄准', 8.4], ['流动瞄准', 6.2], ['瞄准控制', 7.1], ['空间精度', 6.8], ['手速', 7.6], ['指法控制', 6.4], ['读图', 5.9], ['耐力', 6.1], ['持久力', 5.7]] }
};
function bpRows(list) {
  return '<div class="bp-list">' + list.map(function (row) {
    return '<div class="bp" style="--star:hsl(' + Math.max(0, 205 - (Number(row[3]) - 1) * 27) + ' 90% 62%)">'
      + '<span class="bp-rank">#' + row[0] + '</span>'
      + '<span class="bp-title">' + row[1] + '<small>' + row[2] + ' · ' + row[4] + '</small></span>'
      + '<span class="bp-stars">' + row[3] + '★</span>'
      + '<span class="bp-pp">' + row[5] + 'pp</span></div>';
  }).join('') + '</div>';
}
window.openPlayer = function () {
  openDrawer({
    title: PLAYER.name,
    sub: 'osu! #' + PLAYER.rank.toLocaleString() + ' · ' + PLAYER.pp + 'pp · ' + PLAYER.acc,
    tabs: [
      { label: '概览', html: readGrid([['全球排名', '#' + PLAYER.rank.toLocaleString()], ['PP', PLAYER.pp], ['准确率', PLAYER.acc], ['游玩次数', PLAYER.plays], ['常用 mods', 'HD · HR'], ['绑定 QQ', '1005042620']]) + '<div class="card-head" style="margin-top:18px"><span class="card-title">PP+ 维度</span></div>' + PLAYER.pplus.map(function (row) { return '<div class="bar-row"><span>' + row[0] + '</span><div class="bar"><i style="width:' + Math.min(100, row[1] / 20 * 100) + '%"></i></div><b>' + row[1] + '</b></div>'; }).join('') },
      { label: 'BP', html: bpRows(PLAYER.bp) },
      { label: '最近', html: '<table class="table"><thead><tr><th>时间</th><th>谱面</th><th>星数</th><th>准确率</th><th>PP</th></tr></thead><tbody>' + PLAYER.recent.map(function (row) { return '<tr><td class="muted">' + row[0] + '</td><td>' + row[1] + '</td><td>' + row[2] + '</td><td>' + row[3] + '</td><td class="pink">' + row[4] + '</td></tr>'; }).join('') + '</tbody></table>' },
      { label: '类型', html: PLAYER.types.map(function (row) { return '<div class="bar-row"><span>' + row[0] + '</span><div class="bar"><i style="width:' + row[1] + '%"></i></div><b>' + row[1] + '%</b></div>'; }).join('') },
      { label: '技能', html: readGrid([['评级', PLAYER.skill.tier], ['类型', PLAYER.skill.title]]) + '<div class="card-head" style="margin-top:18px"><span class="card-title">九维能力</span></div>' + PLAYER.skill.axes.map(function (row) { return '<div class="bar-row"><span>' + row[0] + '</span><div class="bar"><i style="width:' + (row[1] / 10 * 100) + '%"></i></div><b>' + row[1] + '</b></div>'; }).join('') }
    ]
  });
};

/* ---------- 群画像抽屉 ---------- */
window.openGroupProfile = function (name) {
  openDrawer({
    title: name + ' · 群画像',
    sub: '自动更新 · 最近 2 小时',
    tabs: [
      { label: '画像', html: readGrid([['置信度', '92%'], ['依据条数', '75 条'], ['主要话题', 'osu! · 作业 · 天气'], ['活跃时段', '20:00 - 00:30'], ['更新阈值', '500 条'], ['最近更新', '10/19 12:04']]) },
      { label: '证据', html: '<div class="evidence">' + ['10/19 · 连续 6 条在聊 7★ 跳图', '10/18 · 3 人提到期末作业', '10/17 · 群内互称外号开始固定', '10/16 · 夜间活跃度上升'].map(function (text) { return '<div>' + text + '</div>'; }).join('') + '</div>' },
      { label: '成员', html: readGrid([['成员数', '89'], ['活跃成员', '23'], ['有记忆', '41'], ['有绑定', '12']]) }
    ]
  });
};

/* ---------- 成员 / 记忆抽屉 ---------- */
window.openMember = function (name, qq) {
  openDrawer({
    title: name,
    sub: 'QQ ' + qq + ' · 三角洲',
    tabs: [
      { label: '资料', html: readGrid([['身份', '群主'], ['消息数', '4,821'], ['osu! 绑定', '10984982'], ['最近活跃', '12:09'], ['记忆条数', '89']]) },
      { label: '记忆', html: '<div class="evidence"><div>最近沉迷 7★ 跳图，喜欢 HDHR。</div><div>常在深夜出现，偏好技术图。</div></div>' },
      { label: '关系', html: readGrid([['最强关系', 'Kaffu-（86）'], ['共同出现', '1,204 次'], ['互相 @', '318 次']]) }
    ]
  });
};
window.openMemory = function (name) {
  openDrawer({
    title: name + ' · 记忆',
    sub: '长期画像 · 最近更新 2 小时前',
    tabs: [
      { label: '当前', html: readGrid([['摘要', '最近沉迷 7★ 跳图，喜欢 HDHR'], ['来源', '群聊证据 · 32 条'], ['置信度', '高'], ['写入时间', '10/19 12:08']]) },
      { label: '历史', html: '<div class="evidence"><div>10/18 · 记录“喜欢 HD 跳图”</div><div>10/12 · 记录“常打 6★ 图”</div><div>10/03 · 首次写入</div></div>' }
    ]
  });
};

/* ---------- 运行控制：配置抽屉 ---------- */
window.openProc = function (name) {
  openDrawer({
    title: name,
    sub: '本窗口启动 · 运行中',
    tabs: [
      { label: '进程', html: readGrid([['状态', '运行中'], ['PID 数', '10'], ['启动方式', '本窗口启动'], ['自动启动', '客户端打开时启动'], ['工作目录', 'G:\\WuxinBot Desktop\\resources\\app.asar.unpacked']]) },
      { label: 'PID', html: '<div class="evidence"><div>PID 31400 · postgres: checkpointer</div><div>PID 32276 · postgres: walwriter</div><div>PID 30896 · postgres: autovacuum launcher</div><div>PID 29768 · postgres: stats collector</div></div>' },
      { label: '日志', html: '<div class="evidence"><div>12:04 · ready to accept connections</div><div>11:58 · checkpoint complete</div><div>08:12 · database system is ready</div></div>' }
    ]
  });
};


/* ---------- 页面只读增强 ---------- */
(function enhancePages() {
  var osuPage = PAGES.osu;
  PAGES.osu = function () {
    return osuPage().replace(
      '<div class="grid grid-main">',
      '<div class="card" style="margin-bottom:16px"><div class="card-head"><span class="card-title">查人</span><span class="muted" style="font-size:12px">只读：不发绑定、不触发分析重算</span></div><div class="searchbar"><span class="pink">@</span><input placeholder="输入 osu! 用户名、ID 或主页链接" /><button class="btn btn-primary" onclick="openPlayer()">查询</button></div></div><div class="grid grid-main">'
    );
  };
  })();

function wireReadOnly() {
  var page = window.__page || 'overview';
  if (page === 'members') {
    Array.prototype.forEach.call(document.querySelectorAll('#view table tbody tr'), function (row) {
      var cells = row.querySelectorAll('td');
      if (cells.length < 2) return;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () { openMember(cells[0].textContent.trim(), cells[1].textContent.trim()); });
    });
  }
  if (page === 'memory') {
    Array.prototype.forEach.call(document.querySelectorAll('#view .rows .row'), function (row) {
      var title = row.querySelector('.row-title');
      if (!title) return;
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () { openMemory(title.textContent.trim()); });
    });
  }
  if (page === 'runtime') {
    Array.prototype.forEach.call(document.querySelectorAll('#view .proc'), function (card) {
      var name = card.querySelector('.proc-head b');
      var button = card.querySelector('.proc-actions .btn-ghost');
      if (!name || !button) return;
      button.addEventListener('click', function () { openProc(name.textContent.trim()); });
    });
  }
}

var __renderBase = render;
render = function (page) { window.__page = page; __renderBase(page); wireReadOnly(); };
render(window.__page || 'overview');

window.goto = render;


/* ---------- 只读：模型 / 集成 / 维护 / 日志 ---------- */
(function moreReadOnly() {
  var modelPage = PAGES.model;
  PAGES.model = function () {
    return modelPage() + '<div style="margin-top:16px">'
      + card('Codex 通道（只读）', readGrid([
        ['登录状态', '已登录 · 账户 wuxin@example.com'],
        ['配额窗口', '5 小时 · 已用 38%'],
        ['速率限制', '剩余 42 次 / 分钟'],
        ['最近重置', '10/19 08:00']
      ]), '管理 →')
      + '</div>';
  };

  var integrationsPage = PAGES.integrations;
  PAGES.integrations = function () {
    return integrationsPage() + '<div class="grid grid-2" style="margin-top:16px">'
      + card('OneBot 自动探测（只读）', readGrid([
        ['监听地址', '127.0.0.1:3000'],
        ['上报地址', 'http://127.0.0.1:8787/onebot/event'],
        ['最后心跳', '12:09:41 · 3 秒前'],
        ['协议版本', 'OneBot v11 · NapCat 4.x']
      ]))
      + card('表情调试（只读）', readGrid([
        ['最近决策', '拒发 · 本群不在开放范围'],
        ['今日命中率', '12 次发送 / 41 次掷骰'],
        ['最近失败原因', '发送校验未通过']
      ]))
      + '</div>';
  };

  var maintenancePage = PAGES.maintenance;
  PAGES.maintenance = function () {
    return maintenancePage() + '<div class="grid grid-2" style="margin-top:16px">'
      + card('重算进度（只读）', readGrid([
        ['当前任务', '群画像重算'],
        ['队列', '2 个群等待'],
        ['进度', '已处理 7 / 11']
      ]) + '<div class="progress"><i style="width:64%"></i></div>')
      + card('配置快照（只读）', '<div class="rows">' + [
        ['10/19 12:00', '保存设置模型'],
        ['10/18 21:14', '修改群参与模式'],
        ['10/17 09:02', '写入权限矩阵']
      ].map(function (row) { return listRow('', row[1], '', '<span class="row-value" style="color:var(--muted);font-weight:500">' + row[0] + '</span>'); }).join('') + '</div>')
      + '</div>';
  };

  var logsPage = PAGES.logs;
  PAGES.logs = function () {
    return logsPage().replace(
      '<div class="card-head"><span class="card-title">最近记录</span>',
      '<div class="card-head"><span class="card-title">最近记录</span><div class="seg" id="logFilter"><button class="is-active" data-kind="all">全部</button><button data-kind="no-reply">未回复</button><button data-kind="replied">已回复</button><button data-kind="tool">用了工具</button></div>'
    );
  };
})();

function wireLogsFilter() {
  var seg = document.getElementById('logFilter');
  if (!seg) return;
  seg.addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    Array.prototype.forEach.call(seg.children, function (node) { node.classList.remove('is-active'); });
    button.classList.add('is-active');
    var kind = button.dataset.kind;
    Array.prototype.forEach.call(document.querySelectorAll('#logList .log-item'), function (item) {
      var hasTool = /工具/.test(item.textContent);
      var replied = /已回复/.test(item.textContent);
      var show = kind === 'all' || (kind === 'tool' && hasTool) || (kind === 'replied' && replied) || (kind === 'no-reply' && !replied);
      item.style.display = show ? '' : 'none';
    });
  });
}

var __renderFinal = render;
render = function (page) {
  __renderFinal(page);
  if ((window.__page || '') === 'logs') wireLogsFilter();
};
window.goto = render;
render(window.__page || 'overview');


/* ---------- 只读守卫：写操作按钮显式禁用 ---------- */
function applyReadOnlyGuard() {
  var verbs = ['保存', '清空', '重算', '备份', '恢复', '启动', '停止', '重启', '一键', '添加', '删除', '绑定', '解绑', '发送', '测试', '修改', '写入', '重置', '保存更改', '保存权限'];
  Array.prototype.forEach.call(document.querySelectorAll('#view button, .osu-shell-operations button'), function (button) {
    if (button.dataset.guarded) return;
    var text = button.textContent.trim();
    if (!text) return;
    var isWrite = verbs.some(function (verb) { return text.indexOf(verb) >= 0; });
    if (!isWrite) return;
    button.dataset.guarded = '1';
    button.classList.add('is-guarded');
    button.setAttribute('aria-disabled', 'true');
    button.title = '只读模式：写操作在下一阶段接入';
    button.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); }, true);
  });
}

var __renderGuard = render;
render = function (page) {
  __renderGuard(page);
  applyReadOnlyGuard();
};
window.goto = render;
render(window.__page || 'overview');


/* ---------- 让操作按钮可点：确认弹窗 + 提示 ---------- */
applyReadOnlyGuard = function () {};

function ensureUiRoot() {
  var root = document.getElementById('uiRoot');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'uiRoot';
  root.innerHTML = '<div class="toast" id="toast" hidden></div>'
    + '<div class="modal-root" id="modalRoot" hidden><div class="modal-back"></div>'
    + '<div class="modal" role="dialog" aria-modal="true">'
    + '<h3 id="modalTitle"></h3><p id="modalText"></p>'
    + '<div class="modal-actions"><button class="btn" id="modalCancel">取消</button><button class="btn btn-primary" id="modalOk">确认</button></div>'
    + '</div></div>';
  document.body.appendChild(root);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.querySelector('#modalRoot .modal-back').addEventListener('click', closeModal);
  return root;
}

var toastTimer = null;
function notify(message, tone) {
  ensureUiRoot();
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast is-on' + (tone ? ' toast--' + tone : '');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove('is-on'); toast.hidden = true; }, 2400);
}

var modalConfirm = null;
function openModal(title, text, confirmText, onConfirm) {
  ensureUiRoot();
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  document.getElementById('modalOk').textContent = confirmText || '确认';
  modalConfirm = onConfirm;
  document.getElementById('modalRoot').hidden = false;
}
function closeModal() {
  var root = document.getElementById('modalRoot');
  if (root) root.hidden = true;
  modalConfirm = null;
}
document.addEventListener('click', function (event) {
  if (event.target && event.target.id === 'modalOk') {
    var action = modalConfirm;
    closeModal();
    if (action) action();
  }
});

var DESTRUCTIVE = ['删除', '清空', '恢复', '重启', '停止', '解绑'];
var SOFT = ['保存', '添加', '绑定', '测试', '重算', '备份', '启动', '一键', '重置'];

document.addEventListener('click', function (event) {
  var button = event.target.closest('#view button, .osu-shell-operations button');
  if (!button) return;
  if (button.dataset.mockBound) return;
  // wired buttons own their handlers
  if (button.dataset && Object.keys(button.dataset).length) return;
  var text = button.textContent.trim();
  if (!text) return;
  var destructive = DESTRUCTIVE.some(function (verb) { return text.indexOf(verb) >= 0; });
  var soft = SOFT.some(function (verb) { return text.indexOf(verb) >= 0; });
  if (!destructive && !soft) return;
  event.preventDefault();
  event.stopPropagation();
  if (destructive) {
    openModal(text, '这是演示环境：确认后会展示结果，但不会写入任何数据。第二次确认才会真正执行。', '确认' + text.replace(/^(.*?)(群|备份|缓存|服务|绑定)?$/, '$1'), function () {
      notify('已执行「' + text + '」（演示，未写入数据）', 'pink');
    });
    return;
  }
  notify('已执行「' + text + '」（演示，未写入数据）', 'pink');
}, true);


/* ---------- 演示动作：直接出结果，不假装确认 ---------- */
openModal = function () {};

function addBackupRow() {
  var table = document.querySelector('#view .table tbody');
  if (!table) return;
  var now = new Date();
  var stamp = String(now.getMonth() + 1).padStart(2, '0') + '/' + String(now.getDate()).padStart(2, '0') + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  var row = document.createElement('tr');
  row.innerHTML = '<td class="muted">' + stamp + '</td><td>4.3 MB</td><td style="text-align:right"><button class="btn btn-ghost" style="font-size:12px">恢复</button></td>';
  table.insertBefore(row, table.firstChild);
}

function runRecalc() {
  var bar = document.querySelector('#view .progress i');
  if (bar) bar.style.width = '100%';
  var label = document.querySelector('#view .read-grid dd');
  if (label) label.textContent = '已处理 11 / 11';
}

document.addEventListener('click', function (event) {
  var button = event.target.closest('#view button, .osu-shell-operations button');
  if (!button) return;
  var text = button.textContent.trim();
  if (!text) return;
  if (text === '立即备份') {
    event.preventDefault();
    addBackupRow();
    notify('已创建备份（演示）', 'pink');
    return;
  }
  if (text === '全部重算') {
    event.preventDefault();
    runRecalc();
    notify('重算已开始，进度已更新（演示）', 'pink');
    return;
  }
  if (text === '恢复') {
    event.preventDefault();
    var row = button.closest('tr');
    if (!row) return;
    var stamp = (row.cells[0] ? row.cells[0].textContent : '').trim();
    var cell = button.parentElement;
    cell.innerHTML = '<span class="chip chip--mint">已恢复 · ' + stamp + '</span>';
    row.classList.add('is-restored');
    var list = row.parentElement;
    if (list && list.firstElementChild !== row) list.insertBefore(row, list.firstElementChild);
    var title = document.querySelector('#view .card .card-title');
    if (title && title.textContent.indexOf('备份') >= 0) {
      var head = title.parentElement;
      var existing = head.querySelector('.restored-note');
      if (!existing) { existing = document.createElement('span'); existing.className = 'restored-note muted'; head.appendChild(existing); }
      existing.textContent = '当前数据来自 ' + stamp + ' 的备份';
    }
    notify('已从 ' + stamp + ' 的备份恢复（演示，未写入数据）', 'pink');
    return;
  }
  if (text === '清空缓存' || text === '重启服务' || text === '重启进程') {
    event.preventDefault();
    notify('已执行「' + text + '」（演示）', 'pink');
    return;
  }
}, true);


/* ================== 顶栏搜索 2.0：页面 + 功能 ================== */
(function mountFeatureSearch() {
  var old = document.querySelector('.shell-search');
  if (old) old.remove();

  var FEATURES = [
    { label: '总览', page: 'overview', kind: '页面', keys: '首页 dashboard 概览' },
    { label: 'Token 用量图表', page: 'overview', kind: '功能', keys: '用量 token 统计 图表 24小时' },
    { label: '运行状态', page: 'overview', kind: '功能', keys: '健康 状态 延迟 错误' },
    { label: '群聊', page: 'groups', kind: '页面', keys: '群 列表' },
    { label: '群策略 / 回复模式', page: 'groups', kind: '功能', keys: '模式 上限 冷却 策略 配置' },
    { label: '群画像', page: 'groups', kind: '功能', keys: '画像 置信度 证据 群' },
    { label: '群内 Bot 开关', page: 'groups', kind: '功能', keys: 'bot 雨沐 猫猫 消防栓 lazy' },
    { label: '随机发图', page: 'randomImages', kind: '页面', keys: '表情包 图池 随机' },
    { label: '发图概率与冷却', page: 'randomImages', kind: '功能', keys: '概率 冷却 触发' },
    { label: 'Agent', page: 'agent', kind: '页面', keys: '运行配置 决策' },
    { label: 'Agent 运行配置', page: 'agent', kind: '功能', keys: '工具上限 并发 证据兜底' },
    { label: 'osu!', page: 'osu', kind: '页面', keys: 'osu 查询' },
    { label: '查人 / 玩家档案', page: 'osu', kind: '功能', keys: '查人 玩家 档案 bp pp 技能 类型', action: 'player' },
    { label: 'osu! 工具调用记录', page: 'osu', kind: '功能', keys: '工具 调用 耗时 成功率' },
    { label: '外部 osu! 服务', page: 'osu', kind: '功能', keys: '雨沐 猫猫 消防栓 lazybot 服务' },
    { label: '绑定管理', page: 'osu', kind: '功能', keys: '绑定 账号 qq osu' },
    { label: '日志', page: 'logs', kind: '页面', keys: 'log 记录' },
    { label: '请求时间线', page: 'logs', kind: '功能', keys: '时间线 判定 证据' },
    { label: '成员', page: 'members', kind: '页面', keys: '用户 群友' },
    { label: '身份与绑定', page: 'members', kind: '功能', keys: '身份 群主 管理 绑定' },
    { label: '人设', page: 'persona', kind: '页面', keys: '人格 prompt 语气' },
    { label: '人格层编辑', page: 'persona', kind: '功能', keys: '人格层 覆盖 prompt 编辑' },
    { label: '记忆', page: 'memory', kind: '页面', keys: '记忆 画像' },
    { label: '记忆条目与重算', page: 'memory', kind: '功能', keys: '记忆 重算 编辑' },
    { label: '关系', page: 'relationships', kind: '页面', keys: '关系 熟悉' },
    { label: '关系强度', page: 'relationships', kind: '功能', keys: '强度 共同出现 互 @' },
    { label: '画像日志', page: 'profileLogs', kind: '页面', keys: '画像 流水 证据' },
    { label: '模型', page: 'model', kind: '页面', keys: 'llm 供应商' },
    { label: '供应商与 API Key', page: 'model', kind: '功能', keys: 'key 地址 模型 供应商' },
    { label: 'Codex 通道', page: 'model', kind: '功能', keys: 'codex 配额 登录' },
    { label: '集成', page: 'integrations', kind: '页面', keys: 'onebot 外部服务' },
    { label: 'OneBot 连接', page: 'integrations', kind: '功能', keys: 'onebot 探测 上报' },
    { label: '表情调试', page: 'integrations', kind: '功能', keys: '表情 sticker 调试' },
    { label: '权限', page: 'permissions', kind: '页面', keys: '命令 权限 矩阵' },
    { label: '命令权限矩阵', page: 'permissions', kind: '功能', keys: '命令 群员 管理 主人' },
    { label: '维护', page: 'maintenance', kind: '页面', keys: '备份 恢复 重算' },
    { label: '备份与恢复', page: 'maintenance', kind: '功能', keys: '备份 恢复 快照' },
    { label: '重算任务', page: 'maintenance', kind: '功能', keys: '重算 群画像 记忆 关系' },
    { label: '运行控制', page: 'runtime', kind: '页面', keys: '进程 服务' },
    { label: '进程启停与配置', page: 'runtime', kind: '功能', keys: '启动 停止 重启 pid 进程' },
    { label: 'PostgreSQL / MariaDB', page: 'runtime', kind: '功能', keys: 'postgres mysql mariadb 数据库' },
    { label: '外部 Bot 进程', page: 'runtime', kind: '功能', keys: '雨沐 猫猫 消防栓 lazybot 渲染' },
    { label: 'Skill Profiler', page: 'runtime', kind: '功能', keys: '分析服务 profiler 技能' }
  ];

  var bar = document.querySelector('.topbar');
  var wrap = document.createElement('div');
  wrap.className = 'shell-search';
  wrap.innerHTML = '<input id="shellSearch" placeholder="搜索页面、功能、群、成员" aria-label="全局搜索" /><div class="shell-results" id="shellResults"></div>';
  bar.insertBefore(wrap, document.querySelector('.topbar-right'));
  var input = wrap.querySelector('#shellSearch');
  var results = wrap.querySelector('#shellResults');

  function rowsFor(needle) {
    var hits = FEATURES.filter(function (item) {
      return (item.label + ' ' + item.keys + ' ' + item.page).toLowerCase().indexOf(needle) >= 0;
    });
    var people = SEARCH_INDEX.filter(function (item) {
      return item.label.toLowerCase().indexOf(needle) >= 0;
    }).map(function (item) { return { label: item.label, page: item.page, kind: item.kind }; });
    return hits.slice(0, 6).concat(people.slice(0, 4)).slice(0, 10);
  }

  input.addEventListener('input', function () {
    var needle = input.value.trim().toLowerCase();
    if (!needle) { results.classList.remove('is-open'); results.innerHTML = ''; return; }
    var hits = rowsFor(needle);
    results.innerHTML = hits.length
      ? hits.map(function (item, index) {
          return '<button data-index="' + index + '"><span>' + esc(item.label) + '</span><small>' + item.kind + ' · ' + item.page + '</small></button>';
        }).join('')
      : '<button disabled><span>没有找到「' + esc(input.value) + '」</span><small>试试 备份 / 进程 / 查人</small></button>';
    results.dataset.hits = JSON.stringify(hits);
    results.classList.add('is-open');
  });

  results.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-index]');
    if (!button) return;
    var hits = JSON.parse(results.dataset.hits || '[]');
    var hit = hits[Number(button.dataset.index)];
    if (!hit) return;
    closeDrawer();
    render(hit.page);
    results.classList.remove('is-open');
    input.value = '';
    if (hit.action === 'player') setTimeout(function () { openPlayer(); }, 120);
    if (hit.kind === '功能') notify('已定位到：' + hit.label, 'pink');
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.shell-search')) results.classList.remove('is-open');
  });
  window.searchGo = function (page) { closeDrawer(); render(page); results.classList.remove('is-open'); input.value = ''; };
})();


/* ================== 状态特效 ================== */
function rippleFrom(target, palette) {
  var rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : { x: innerWidth / 2, y: 40, width: 0, height: 0 };
  var x = rect.x + rect.width / 2;
  var y = rect.y + rect.height / 2;
  var el = document.createElement('div');
  el.className = 'ripple';
  if (palette === 'danger') el.style.background = 'radial-gradient(circle at center, rgba(255, 92, 92, 0.26), rgba(255, 92, 92, 0.08) 55%, transparent 75%)';
  if (palette === 'mint') el.style.background = 'radial-gradient(circle at center, rgba(92, 214, 180, 0.24), rgba(92, 214, 180, 0.08) 55%, transparent 75%)';
  document.body.appendChild(el);
  var radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 80;
  el.animate([
    { clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)', opacity: 0.95 },
    { clipPath: 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)', opacity: 0 }
  ], { duration: 680, easing: 'cubic-bezier(.22,1,.36,1)' }).onfinish = function () { el.remove(); };
}

var lastPaused = false;
function syncPauseEffect(button, animate) {
  if (DATA.paused === lastPaused) return;
  lastPaused = DATA.paused;
  document.body.classList.toggle('is-paused', DATA.paused);
  if (animate && button) rippleFrom(button, DATA.paused ? 'amber' : 'pink');
}
document.getElementById('pauseBtn').addEventListener('click', function (event) {
  syncPauseEffect(event.currentTarget, true);
});

document.addEventListener('click', function (event) {
  var button = event.target.closest('#view button');
  if (!button) return;
  var text = button.textContent.trim();
  if (text === '全部停止') rippleFrom(button, 'danger');
  if (text === '一键启动' || text === '启动') rippleFrom(button, 'mint');
});


/* 行操作后的闪一下 */
document.addEventListener('click', function (event) {
  var button = event.target.closest('#view button');
  if (!button) return;
  var text = button.textContent.trim();
  if (text === '立即备份') {
    setTimeout(function () {
      var row = document.querySelector('#view .table tbody tr');
      if (row) { row.classList.add('row-flash'); setTimeout(function () { row.classList.remove('row-flash'); }, 950); }
    }, 60);
  }
  if (text === '恢复') {
    var row = button.closest('tr');
    if (row) { row.classList.add('row-flash'); setTimeout(function () { row.classList.remove('row-flash'); }, 950); }
  }
}, true);
