// 真实数据适配层：把 /api/* 的结果灌进原型的数据结构。
// 请求失败时保留演示数据，界面不白屏。
function fmtClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '').slice(11, 19);
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '').slice(0, 16).replace('T', ' ');
  const pad = (n) => String(n).padStart(2, '0');
  return (date.getMonth() + 1) + '/' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

const LIVE = { ready: false, error: '', source: 'mock', hourly: [], painted: false };

async function api(path) {
  const response = await __apiFetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(path + ' -> ' + response.status);
  return response.json();
}

function modeLabel(mode) {
  return ({ mention: '@ 回复', silent: '静默', light: '轻度参与', natural: '自然群友', osu: '仅 osu! 指令' })[mode] || mode || '—';
}

function stampFromName(name) {
  const match = String(name || '').match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return '';
  const iso = match[1] + '-' + match[2] + '-' + match[3] + 'T' + match[4] + ':' + match[5] + ':' + match[6] + 'Z';
  return fmtStamp(iso);
}

function sizeLabel(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '—';
  return value > 1024 * 1024 * 1024 ? (value / 1073741824).toFixed(1) + ' GB' : (value / 1048576).toFixed(1) + ' MB';
}

function wan(value) {
  const number = Number(value || 0);
  return number >= 10000 ? (number / 10000).toFixed(1) : String(number);
}

async function hydrate() {
  try {
    const [state, health, osu, backups, recalc] = await Promise.all([
      api('/api/state'),
      api('/api/health').catch(() => null),
      api('/api/osu/status').catch(() => null),
      api('/api/backups').catch(() => null),
      api('/api/recalc-status').catch(() => null)
    ]);

    const db = (state && state.db) || {};
    const settings = db.settings || {};
    const usage = db.usageStats || {};
    const today = usage.today || {};

    DATA.groupRows = (db.groups || []).map((group) => ({
      name: group.name || String(group.groupId),
      id: group.groupId,
      mode: modeLabel(group.mode),
      enabled: group.enabled !== false,
      members: Number(group.memberCount || 0),
      active: false,
      randomImageEnabled: group.randomImageEnabled === true,
      randomImageRate: group.randomImageRate || 'standard',
      createdAt: group.createdAt || '',
      maxPerHour: group.maxPerHour,
      cooldown: group.cooldownSec
    }));

    LIVE.paused = Boolean(settings.globalPaused);
    LIVE.model = settings.effectiveModel || settings.model || '未设置';
    LIVE.connected = Boolean(health && health.onebot && health.onebot.accountOnline !== false && health.onebot.connected !== false);
    LIVE.latency = health && health.llm && health.llm.avgLatencyMs ? Math.round(health.llm.avgLatencyMs / 100) / 10 : null;
    LIVE.groups = DATA.groupRows.length;
    LIVE.todayTokens = Number(today.totalTokens || 0);
    LIVE.todayRequests = Number(today.requests || 0);
    LIVE.experience = Object.keys(db.experience || {}).length;
    LIVE.memoryCount = (db.memories || []).length;
    LIVE.hourly = Array.isArray(usage.hourly24) ? usage.hourly24.map((hour) => Number(hour.totalTokens || 0)) : [];
    LIVE.messages = Array.isArray(db.messages) ? db.messages.length : null;

    if (backups && Array.isArray(backups.backups)) {
      LIVE.backups = backups.backups.slice(0, 8).map((item) => ({
        at: stampFromName(item.name) || String(item.createdAt || '').slice(0, 16).replace('T', ' '),
        size: sizeLabel(item.size),
        name: item.name
      }));
    }
    if (recalc) LIVE.recalc = { running: Boolean(recalc.running), total: Number(recalc.total || 0), done: Number(recalc.done || 0) };
    if (osu) {
      LIVE.osu429 = osu.health && Number(osu.health.api429Count || 0);
      LIVE.osuBots = Array.isArray(osu.bots) ? osu.bots : [];
    }

    LIVE.ready = true;
    LIVE.source = 'live';
    LIVE.error = '';
  } catch (error) {
    LIVE.error = String((error && error.message) || error);
    LIVE.source = 'mock';
  }

  paintLive();
  if (!LIVE.painted) {
    LIVE.painted = true;
    render(window.__page || 'overview');
  }
  paintOverview();
}

function paintLive() {
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (dot) dot.style.background = LIVE.paused ? 'var(--amber)' : LIVE.connected === false ? 'var(--red)' : 'var(--mint)';
  if (text) {
    const prefix = LIVE.paused ? '已暂停 · ' : LIVE.connected === false ? '未连接 · ' : '已连接 · ';
    text.textContent = prefix + (LIVE.model || '未设置') + (LIVE.latency ? ' · ' + LIVE.latency + 's' : '');
  }
  if (LIVE.paused) document.body.classList.add('is-paused');
  else document.body.classList.remove('is-paused');

  const badge = document.getElementById('liveBadge');
  if (badge) {
    badge.textContent = LIVE.source === 'live' ? '实时数据' : '演示数据';
    badge.className = 'chip ' + (LIVE.source === 'live' ? 'chip--mint' : 'chip--amber');
    badge.title = LIVE.error || '';
  }
}

function paintOverview() {
  if ((window.__page || 'overview') !== 'overview') return;
  const em = document.querySelector('.hero em');
  if (em && LIVE.messages != null) em.textContent = Number(LIVE.messages).toLocaleString('en-US');

  const stats = document.querySelectorAll('#view .stat-value');
  if (stats[1] && LIVE.messages != null) stats[1].textContent = Number(LIVE.messages).toLocaleString('en-US');
  if (stats[2] && LIVE.todayTokens) stats[2].innerHTML = wan(LIVE.todayTokens) + '<span class="stat-unit">万</span>';
  if (stats[3] && LIVE.experience != null) stats[3].textContent = LIVE.experience;

  const heroSide = document.querySelectorAll('.hero-side b');
  if (heroSide[0] && LIVE.todayTokens) heroSide[0].textContent = wan(LIVE.todayTokens) + ' 万';
  if (heroSide[1] && LIVE.experience != null) heroSide[1].textContent = LIVE.experience;
  if (heroSide[2] && LIVE.model) heroSide[2].textContent = LIVE.model;

  const bars = document.querySelectorAll('.chart i');
  if (bars.length && LIVE.hourly.length === bars.length) {
    const max = Math.max.apply(null, LIVE.hourly) || 1;
    LIVE.hourly.forEach((value, index) => {
      bars[index].style.height = Math.max(3, Math.round(value / max * 100)) + '%';
      bars[index].dataset.tokens = wan(value);
    });
  }
}

(function wireMaintenance() {
  const base = PAGES.maintenance;
  PAGES.maintenance = function () {
    let html = base();
    if (LIVE.backups && LIVE.backups.length) {
      const rows = LIVE.backups.map((item) => '<tr><td class="muted">' + item.at + '</td><td>' + item.size + '</td>'
        + '<td style="text-align:right"><button class="btn btn-ghost" style="font-size:12px">恢复</button></td></tr>').join('');
      html = html.replace(/<tbody>[\s\S]*?<\/tbody>/, '<tbody>' + rows + '</tbody>');
    }
    return html;
  };
})();

setTimeout(hydrate, 150);
setInterval(hydrate, 20000);