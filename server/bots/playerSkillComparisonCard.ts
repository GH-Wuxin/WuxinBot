import {imageDataUrl} from './skillCard/images.js';
import sharp from 'sharp';
import type { PlayerSkillAxis } from './playerSkillProfile.js';

const WIDTH = 1280;
const HEIGHT = 720;
const OVERFLOW_MULTIPLIER = 1.8;
function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compact(value: unknown, maxLength = 28): string {
  const chars = [...String(value ?? '')];
  return chars.length <= maxLength ? chars.join('') : `${chars.slice(0, maxLength - 1).join('')}…`;
}

function profileTitleColor(tier: unknown): string {
  if (tier === 'WORLD_CLASS') return '#ffcf62';
  if (tier === 'EXPERT') return '#e9b65b';
  if (tier === 'PLAYER') return '#63dcff';
  return '#aab8c4';
}

function profileTitleFontSize(title: string): number {
  const length = [...title].length;
  if (length <= 20) return 24;
  if (length <= 26) return 21;
  return 18;
}

export function playerProfileTitlePresentation(profile: Record<string, any>): {
  title: string;
  color: string;
  fontSize: number;
} {
  const title = String(profile.profileTitle || profile.profileType || 'Beginner').toUpperCase();
  return {
    title,
    color: profileTitleColor(profile.profileTier),
    fontSize: profileTitleFontSize(title),
  };
}

function text(value: unknown, x: number, y: number, size: number, options: Record<string, unknown> = {}): string {
  return `<text x="${x}" y="${y}" fill="${options.fill || '#eef4fa'}" fill-opacity="${options.opacity ?? 1}" font-size="${size}" font-weight="${options.weight || 500}" text-anchor="${options.anchor || 'start'}" letter-spacing="${options.spacing || 0}">${esc(value)}</text>`;
}

function comparisonValues(left: number, right: number, x: number, y: number, anchor: string): string {
  const leftFill = left > 10 ? '#ffcf62' : '#42d5ff';
  const rightFill = right > 10 ? '#ffcf62' : '#ff5fae';
  return `<text x="${x}" y="${y}" font-size="15" font-weight="700" text-anchor="${anchor}"><tspan fill="${leftFill}">${left.toFixed(1)}</tspan><tspan fill="#8fa2b2"> / </tspan><tspan fill="${rightFill}">${right.toFixed(1)}</tspan></text>`;
}

function projected(value: unknown, allowOverflow = false): number {
  const raw = Math.max(0, finite(value));
  if (!allowOverflow || raw <= 10) return Math.min(10, raw);
  return 10 + (raw - 10) * OVERFLOW_MULTIPLIER;
}

function polar(cx: number, cy: number, radius: number, index: number, count: number, value = 10, allowOverflow = false) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
  const scaled = radius * projected(value, allowOverflow) / 10;
  return { x: cx + Math.cos(angle) * scaled, y: cy + Math.sin(angle) * scaled, cos: Math.cos(angle), sin: Math.sin(angle) };
}

function rank(value: unknown): string {
  return finite(value) > 0 ? `#${Math.round(finite(value)).toLocaleString('en-US')}` : '—';
}

function playerBlock(data: any, side: 'left' | 'right'): string {
  const player = data.player || {};
  const profile = data.profile || {};
  const sample = data.sample || {};
  const left = side === 'left';
  const anchor = left ? 'start' : 'end';
  const x = left ? 150 : 1130;
  const primary = Array.isArray(profile.primaryAxes) ? profile.primaryAxes.slice(0, 2).join(' · ') : '—';
  return [
    text(compact(player.username || `osu! ${player.osuId || '?'}`, 24), x, 53, 30, { anchor, weight: 680 }),
    text(`${String(player.countryCode || '—').toUpperCase()} · GLOBAL ${rank(player.globalRank)}`, x, 82, 14, { anchor, fill: '#b9c7d4', spacing: 0.7 }),
    text(`${finite(player.pp).toLocaleString('en-US', { maximumFractionDigits: 0 })}pp · ${finite(player.accuracy).toFixed(2)}%`, x, 108, 18, { anchor, weight: 620, fill: left ? '#42d5ff' : '#ff5fae' }),
    text(`主要能力  ${compact(primary, 28)}`, x, 137, 14, { anchor, fill: '#dce7ef', weight: 550 }),
    text(`BP50  ${finite(sample.valid)}/${finite(sample.requested, 50)} VALID`, x, 161, 13, { anchor, fill: '#92a4b4', weight: 540 }),
  ].join('');
}

function radarGeometry(axes: any[], cx: number, cy: number, radius: number) {
  const count = axes.length;
  const grid = [2, 4, 6, 8, 10].map((level) => {
    const points = axes.map((_: any, index: number) => {
      const point = polar(cx, cy, radius, index, count, level);
      return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${points}" fill="none" stroke="#e4edf4" stroke-opacity="${level === 10 ? 0.30 : 0.13}"/>`;
  }).join('');
  const spokes = axes.map((_: any, index: number) => {
    const point = polar(cx, cy, radius, index, count, 10);
    return `<path d="M${cx} ${cy}L${point.x.toFixed(1)} ${point.y.toFixed(1)}" stroke="#e4edf4" stroke-opacity="0.12"/>`;
  }).join('');
  return { count, grid, spokes };
}

export {renderPlayerSkillProfileCard} from './skillCard/cards.js';

export async function renderPlayerRecentSkillProfileCard(payload: Record<string, any>): Promise<Buffer> {
  const player = payload.player || {};
  const sample = payload.sample || {};
  const profile = payload.profile || {};
  const axes = (Array.isArray(profile.axes) ? profile.axes : []).slice(0, 9).map((axis: any) => ({
    key: axis.key as PlayerSkillAxis,
    label: axis.label || axis.key,
    value: axis.value === null || axis.value === undefined ? null : finite(axis.value),
    reference: finite(axis.reference),
    delta: axis.delta === null || axis.delta === undefined ? null : finite(axis.delta),
    evidence: String(axis.evidence || 'INSUFFICIENT'),
    samples: finite(axis.samples),
  }));
  if (axes.length !== 9) throw new Error('PLAYER_RECENT_SKILL_AXES_INVALID');
  const [cover, avatar] = await Promise.all([
    imageDataUrl(player.coverUrl || player.avatarUrl),
    imageDataUrl(player.avatarUrl, player.osuId),
  ]);
  const cx = 640;
  const cy = 425;
  const radius = 180;
  const { count, grid, spokes } = radarGeometry(axes, cx, cy, radius);
  const referencePoints = axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius, index, count, axis.reference, true);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
  const recentPoints = axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius, index, count, axis.value ?? 0, true);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
  const nodes = axes.map((axis: any, index: number) => {
    if (axis.value === null) return '';
    const point = polar(cx, cy, radius, index, count, axis.value, true);
    const exceptional = axis.value > 10;
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${exceptional ? 7 : 5}" fill="${exceptional ? '#ffcf62' : '#ff5fae'}" stroke="${exceptional ? '#fff1ad' : '#ffabd0'}" stroke-width="2"/>`;
  }).join('');
  const labels = axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius + 48, index, count, 10);
    const anchor = point.cos > 0.22 ? 'start' : point.cos < -0.22 ? 'end' : 'middle';
    const y = point.y + (point.sin < -0.75 ? -5 : point.sin > 0.75 ? 5 : 0);
    const value = axis.value === null
      ? '近期证据不足'
      : axis.evidence === 'LOWER_BOUND' ? `${axis.value.toFixed(1)} 下界` : axis.value.toFixed(1);
    const color = axis.value !== null && axis.value > 10 ? '#ffcf62' : axis.evidence === 'LOWER_BOUND' ? '#ffd28c' : '#ff72b7';
    const delta = axis.delta === null ? '' : `  ${axis.delta > 0 ? '▲' : '▼'}${Math.abs(axis.delta).toFixed(1)}`;
    return text(axis.label, point.x, y, 15, { anchor, weight: 610 })
      + text(`${value}${delta}`, point.x, y + 21, axis.value === null ? 12 : 16, { anchor, weight: 720, fill: color });
  }).join('');
  const completed = finite(sample.completed);
  const analyzed = finite(sample.analyzed);
  const skipped = finite(sample.skipped);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs><filter id="blur"><feGaussianBlur stdDeviation="28"/></filter><filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#02050a" flood-opacity="0.60"/></filter><linearGradient id="recent-overlay" x2="1" y2="1"><stop stop-color="#071928" stop-opacity="0.89"/><stop offset="0.56" stop-color="#100d1d" stop-opacity="0.91"/><stop offset="1" stop-color="#1b0817" stop-opacity="0.88"/></linearGradient><clipPath id="recent-avatar"><circle cx="82" cy="82" r="55"/></clipPath><style>text { font-family: "MiSans", "Noto Sans SC", "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }</style></defs>
<rect width="1280" height="720" fill="#07101a"/>${cover ? `<image x="-45" y="-45" width="1370" height="810" href="${cover}" preserveAspectRatio="xMidYMid slice" filter="url(#blur)" opacity="0.50"/>` : ''}<rect width="1280" height="720" fill="url(#recent-overlay)"/>
<g filter="url(#shadow)"><circle cx="82" cy="82" r="59" fill="#0b1724" stroke="#ff5fae" stroke-width="2"/>${avatar ? `<image x="27" y="27" width="110" height="110" href="${avatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#recent-avatar)"/>` : ''}</g>
${text(compact(player.username || `osu! ${player.osuId || '?'}`, 30), 158, 55, 32, { weight: 700 })}${text(`${String(player.countryCode || '—').toUpperCase()} · GLOBAL ${rank(player.globalRank)} · ${finite(player.pp).toLocaleString('en-US', { maximumFractionDigits: 0 })}pp`, 158, 87, 16, { fill: '#b9c7d4', weight: 560, spacing: 0.4 })}${text(`最近 ${finite(sample.days, 5)} 天 · ${completed} 张完成谱面 · ${analyzed} 组有效证据`, 158, 119, 17, { fill: '#ff8fc5', weight: 620 })}${text(`获取 ${finite(sample.fetched)} 条 · 去重 ${finite(sample.groups)} 组 · 跳过 ${skipped} 组`, 158, 147, 14, { fill: '#91a3b2', weight: 540, spacing: 0.5 })}
${text('RECENT SKILL PROFILE', 1218, 61, 16, { anchor: 'end', fill: '#9facb8', weight: 650, spacing: 2.5 })}${text('近期发挥 vs BP50 长期画像', 1218, 99, 22, { anchor: 'end', fill: '#e9b65b', weight: 700 })}${text('同 BID + 需求 Mods 去重', 1218, 132, 15, { anchor: 'end', fill: '#dce7ef', weight: 560 })}<path d="M24 184H1256" stroke="#e1b45c" stroke-opacity="0.68" stroke-width="1.5"/>
${grid}${spokes}<polygon points="${referencePoints}" fill="#9ecce7" fill-opacity="0.035" stroke="#a8c7da" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="7 8"/><polygon points="${recentPoints}" fill="#ff4fa3" fill-opacity="0.15" stroke="#ff5fae" stroke-width="3.2" stroke-linejoin="round"/>${nodes}${labels}<circle cx="${cx}" cy="${cy}" r="5" fill="#07111d"/>
<path d="M34 675H1246" stroke="#ffffff" stroke-opacity="0.12"/><path d="M44 704H82" stroke="#ff5fae" stroke-width="4" stroke-linecap="round"/>${text('近期有效发挥', 94, 709, 14, { fill: '#d9c4d0' })}<path d="M250 704H288" stroke="#a8c7da" stroke-opacity="0.70" stroke-width="2" stroke-dasharray="6 6"/>${text('BP50 长期参考', 300, 709, 14, { fill: '#a9bac6' })}${text('FAIL 降权 · 24H 100% → DAY5 85% · 差值 <0.2 不标记', 1238, 709, 12, { anchor: 'end', fill: '#8999a8', weight: 560, spacing: 1.1 })}
</svg>`;
  return sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}

export async function renderPlayerSkillComparisonCard(payload: Record<string, any>): Promise<Buffer> {
  const left = payload.left || {};
  const right = payload.right || {};
  const leftPlayer = left.player || {};
  const rightPlayer = right.player || {};
  const leftAxes = Array.isArray(left.profile?.axes) ? left.profile.axes : [];
  const rightByKey = new Map<PlayerSkillAxis, any>((Array.isArray(right.profile?.axes) ? right.profile.axes : []).map((axis: any) => [axis.key, axis]));
  const axes = leftAxes.slice(0, 9).map((axis: any) => ({
    key: axis.key as PlayerSkillAxis,
    label: axis.label || axis.key,
    left: finite(axis.ceiling),
    right: finite(rightByKey.get(axis.key)?.ceiling),
  }));
  if (axes.length !== 9) throw new Error('PLAYER_SKILL_COMPARE_AXES_INVALID');
  const [leftCover, rightCover, leftAvatar, rightAvatar] = await Promise.all([
    imageDataUrl(leftPlayer.coverUrl || leftPlayer.avatarUrl),
    imageDataUrl(rightPlayer.coverUrl || rightPlayer.avatarUrl),
    imageDataUrl(leftPlayer.avatarUrl, leftPlayer.osuId),
    imageDataUrl(rightPlayer.avatarUrl, rightPlayer.osuId),
  ]);
  const cx = 640;
  const cy = 425;
  const radius = 180;
  const { count, grid, spokes } = radarGeometry(axes, cx, cy, radius);
  const points = (side: 'left' | 'right') => axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius, index, count, axis[side], true);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
  const nodes = (side: 'left' | 'right', color: string) => axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius, index, count, axis[side], true);
    const fill = axis[side] > 10 ? '#ffcf62' : color;
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="5" fill="${fill}" stroke="${color}" stroke-width="2"/>`;
  }).join('');
  const labels = axes.map((axis: any, index: number) => {
    const point = polar(cx, cy, radius + 38, index, count, 10);
    const anchor = point.cos > 0.22 ? 'start' : point.cos < -0.22 ? 'end' : 'middle';
    const y = point.y + (point.sin < -0.75 ? -5 : point.sin > 0.75 ? 5 : 0);
    return text(axis.label, point.x, y, 15, { anchor, weight: 610 })
      + comparisonValues(axis.left, axis.right, point.x, y + 20, anchor);
  }).join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs><filter id="blur"><feGaussianBlur stdDeviation="25"/></filter><filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#02050a" flood-opacity="0.60"/></filter><linearGradient id="overlay"><stop stop-color="#061421" stop-opacity="0.88"/><stop offset="0.5" stop-color="#06101b" stop-opacity="0.93"/><stop offset="1" stop-color="#160817" stop-opacity="0.88"/></linearGradient><clipPath id="avatar-left"><circle cx="82" cy="82" r="55"/></clipPath><clipPath id="avatar-right"><circle cx="1198" cy="82" r="55"/></clipPath><style>text { font-family: "MiSans", "Noto Sans SC", "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }</style></defs>
<rect width="1280" height="720" fill="#07101a"/>${leftCover ? `<image x="-60" y="-30" width="760" height="780" href="${leftCover}" preserveAspectRatio="xMidYMid slice" filter="url(#blur)" opacity="0.42"/>` : ''}${rightCover ? `<image x="580" y="-30" width="760" height="780" href="${rightCover}" preserveAspectRatio="xMidYMid slice" filter="url(#blur)" opacity="0.42"/>` : ''}<rect width="1280" height="720" fill="url(#overlay)"/>
<g filter="url(#shadow)"><circle cx="82" cy="82" r="59" fill="#0b1724" stroke="#42d5ff" stroke-width="2"/>${leftAvatar ? `<image x="27" y="27" width="110" height="110" href="${leftAvatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-left)"/>` : ''}</g><g filter="url(#shadow)"><circle cx="1198" cy="82" r="59" fill="#160d1a" stroke="#ff5fae" stroke-width="2"/>${rightAvatar ? `<image x="1143" y="27" width="110" height="110" href="${rightAvatar}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-right)"/>` : ''}</g>
${playerBlock(left, 'left')}${playerBlock(right, 'right')}${text('PLAYER SKILL', 640, 57, 15, { anchor: 'middle', fill: '#9facb8', weight: 650, spacing: 2.8 })}${text('VERSUS', 640, 92, 27, { anchor: 'middle', fill: '#e9b65b', weight: 720, spacing: 4 })}<path d="M24 184H1256" stroke="#e1b45c" stroke-opacity="0.68" stroke-width="1.5"/>
${grid}${spokes}<polygon points="${points('left')}" fill="#35d7ff" fill-opacity="0.16" stroke="#42d5ff" stroke-width="3" stroke-linejoin="round"/><polygon points="${points('right')}" fill="#ff4fa3" fill-opacity="0.13" stroke="#ff5fae" stroke-width="3" stroke-linejoin="round"/>${nodes('left', '#42d5ff')}${nodes('right', '#ff5fae')}${labels}<circle cx="${cx}" cy="${cy}" r="5" fill="#07111d"/>
<path d="M34 675H1246" stroke="#ffffff" stroke-opacity="0.11"/><path d="M44 704H82" stroke="#42d5ff" stroke-width="4" stroke-linecap="round"/>${text(compact(leftPlayer.username || 'LEFT', 20), 94, 709, 14, { fill: '#bdd0dc' })}<path d="M1030 704H1068" stroke="#ff5fae" stroke-width="4" stroke-linecap="round"/>${text(compact(rightPlayer.username || 'RIGHT', 20), 1080, 709, 14, { fill: '#bdd0dc' })}${text('BP50 · SCORE QUALITY ADJUSTED · 0.95 RANK DECAY', 640, 709, 12, { anchor: 'middle', fill: '#8999a8', weight: 560, spacing: 1.8 })}
</svg>`;
  return sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}
