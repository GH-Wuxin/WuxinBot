// 从原型 console/app.js 原样复制的渲染 helper（纯字符串，无业务逻辑）
export function esc(value) { return String(value == null ? '' : value); }

export const chip = (text, cls) => '<span class="chip ' + (cls || '') + '">' + text + '</span>';

export const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>';

export const card = (title, body, more) => '<div class="card"><div class="card-head"><span class="card-title">' + title + '</span>' + (more ? '<a class="card-more" href="#">' + more + '</a>' : '') + '</div>' + body + '</div>';

export const listRow = (left, title, sub, right) => '<div class="row">' + left + '<div class="row-main"><div class="row-title">' + title + '</div>' + (sub ? '<div class="row-sub">' + sub + '</div>' : '') + '</div>' + (right || '') + '</div>';

export const avatar = (text, size) => '<span class="avatar" style="width:' + (size || 28) + 'px;height:' + (size || 28) + 'px;font-size:11px">' + text + '</span>';

export const switchEl = (on) => '<button class="switch ' + (on ? 'is-on' : '') + '"></button>';

export const barRow = (label, pct) => '<div class="bar-row"><span>' + label + '</span><div class="bar"><i style="width:' + pct + '%"></i></div><b>' + pct + '%</b></div>';

export const pageHead = (title, sub, actions) => '<div class="page-head"><div><h1>' + title + '</h1><p>' + sub + '</p></div><div style="display:flex;gap:8px">' + (actions || '') + '</div></div>';

export const grid4 = (items) => '<div class="grid grid-4" style="margin-bottom:16px">' + items.map((s) => { const p = s.split('|'); return '<div class="card stat"><div class="stat-label">' + p[0] + '</div><div class="stat-value">' + p[1] + '</div><div class="stat-note">' + p[2] + '</div></div>'; }).join('') + '</div>';
