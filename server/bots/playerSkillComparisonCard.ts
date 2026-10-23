import {imageDataUrl} from './skillCard/images.js';
import sharp from 'sharp';
import {PLAYER_SKILL_AXIS_DEFINITIONS} from './playerSkillAxes.js';
import type {PlayerSkillAxis} from './playerSkillAxes.js';

const WIDTH = 1280;
const HEIGHT = 720;
const RECENT_MAIN = '#64e5c0';
const RECENT_DOWN = '#ef9098';
const RECENT_WARN = '#e8c26d';
const AXIS_COLORS = ['#70dfc3', '#77b7f3', '#e6b987', '#c3a8ef', '#f0d477', '#e5a9be', '#a7cbd2', '#b0b6dd', '#9ccdb8'];
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

function rank(value: unknown): string {
  return finite(value) > 0 ? `#${Math.round(finite(value)).toLocaleString('en-US')}` : '—';
}

function number(value: unknown, digits = 1): string {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
}

function pp(value: unknown): string {
  return Math.round(finite(value)).toLocaleString('en-US');
}

function initials(value: unknown): string {
  const chars = [...String(value || '?').trim()].filter(Boolean);
  return chars.slice(0, 2).join('').toUpperCase() || '?';
}

function avatarTag(dataUrl: string, username: unknown, cx: number, cy: number, clipId: string, stroke: string): string {
  const image = dataUrl
    ? `<image x="${cx - 34}" y="${cy - 34}" width="68" height="68" href="${dataUrl}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    : `<text x="${cx}" y="${cy + 8}" text-anchor="middle" fill="${stroke}" font-size="22" font-weight="700">${esc(initials(username))}</text>`;
  return `<circle cx="${cx}" cy="${cy}" r="39" fill="#101b28" stroke="${stroke}" stroke-width="2"/>${image}`;
}

function avatarDefs(): string {
  return '<clipPath id="avatar-left"><circle cx="80" cy="72" r="34"/></clipPath><clipPath id="avatar-right"><circle cx="1200" cy="72" r="34"/></clipPath>';
}

function recentAxes(profile: any): any[] {
  const byKey = new Map<string, any>((Array.isArray(profile.axes) ? profile.axes : []).map((axis: any) => [String(axis.key), axis]));
  const axes = PLAYER_SKILL_AXIS_DEFINITIONS.map((definition, index) => {
    const axis: any = byKey.get(definition.key) || {};
    return {
      key: definition.key as PlayerSkillAxis,
      label: definition.label,
      value: axis.value === null || axis.value === undefined ? null : finite(axis.value),
      reference: finite(axis.reference),
      delta: axis.delta === null || axis.delta === undefined ? null : finite(axis.delta),
      evidence: String(axis.evidence || 'INSUFFICIENT'),
      samples: finite(axis.samples),
      color: AXIS_COLORS[index % AXIS_COLORS.length],
    };
  });
  if (axes.length !== 9) throw new Error('PLAYER_RECENT_SKILL_AXES_INVALID');
  return axes;
}

function recentStateSummary(axes: any[]): string {
  const usable = axes.filter((axis) => axis.value !== null);
  const rising = usable.filter((axis) => finite(axis.delta) > 0.2).length;
  const falling = usable.filter((axis) => finite(axis.delta) < -0.2).length;
  const unknown = axes.length - usable.length;
  const strongest = [...usable].sort((a, b) => finite(b.delta) - finite(a.delta))[0];
  const weakest = [...usable].sort((a, b) => finite(a.delta) - finite(b.delta))[0];
  return [
    `<rect x="48" y="178" width="350" height="58" rx="8" fill="#10252a" stroke="${RECENT_MAIN}" stroke-opacity="0.25"/>`,
    text('近期上升', 68, 199, 12, {fill: '#8db7ae', spacing: 1.1}),
    text(`${rising} 项`, 68, 224, 23, {fill: RECENT_MAIN, weight: 700}),
    text(strongest ? `${strongest.label}  +${number(strongest.delta)}` : '没有足够证据', 160, 220, 15, {fill: '#e5f2ee'}),
    `<rect x="465" y="178" width="350" height="58" rx="8" fill="#241a22" stroke="${RECENT_DOWN}" stroke-opacity="0.25"/>`,
    text('近期回落', 485, 199, 12, {fill: '#b89ca3', spacing: 1.1}),
    text(`${falling} 项`, 485, 224, 23, {fill: RECENT_DOWN, weight: 700}),
    text(weakest ? `${weakest.label}  ${number(weakest.delta)}` : '没有明显回落', 577, 220, 15, {fill: '#f5dfdf'}),
    `<rect x="882" y="178" width="350" height="58" rx="8" fill="#241f16" stroke="${RECENT_WARN}" stroke-opacity="0.25"/>`,
    text('证据边界', 902, 199, 12, {fill: '#b9a77f', spacing: 1.1}),
    text(`${unknown} 项未评级`, 902, 220, 17, {fill: '#f3d99b', weight: 650}),
    text('缺少近期有效完成证据时保留未知', 902, 233, 10, {fill: '#b2a483'}),
  ].join('');
}

function scaleMax(values: number[]): number {
  const max = Math.max(10, ...values.map((value) => Math.max(0, value)));
  return Math.max(10, Math.ceil(max * 2) / 2);
}

function recentRows(axes: any[]): string {
  const max = scaleMax(axes.flatMap((axis) => [axis.reference, axis.value ?? 0]));
  const x0 = 300;
  const x1 = 936;
  const width = x1 - x0;
  const startY = 274;
  return axes.map((axis, index) => {
    const y = startY + index * 40;
    const refX = x0 + Math.min(max, Math.max(0, axis.reference)) / max * width;
    const valueX = axis.value === null ? x0 : x0 + Math.min(max, Math.max(0, axis.value)) / max * width;
    const delta = axis.delta;
    const color = axis.value === null ? '#71818e' : delta !== null && delta > 0.2 ? RECENT_MAIN : delta !== null && delta < -0.2 ? RECENT_DOWN : '#b7c3ca';
    const deltaText = axis.value === null ? '证据不足' : axis.evidence === 'LOWER_BOUND' ? `${number(axis.value)} 下界` : delta === null || Math.abs(delta) < 0.2 ? '—' : `${delta > 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(1)}`;
    const evidenceText = axis.value === null ? '近期未形成有效证据' : axis.evidence === 'LOWER_BOUND' ? '低于长期上限 · 仅作下界' : `${finite(axis.samples)} 组有效证据`;
    return [
      `<line x1="48" x2="1232" y1="${y + 30}" y2="${y + 30}" stroke="#ffffff" stroke-opacity="0.07"/>`,
      text(axis.label, 52, y + 2, 15, {weight: 650}),
      text(evidenceText, 52, y + 19, 11, {fill: '#8397a4'}),
      `<line x1="${x0}" x2="${x1}" y1="${y + 16}" y2="${y + 16}" stroke="#314353" stroke-width="4" stroke-linecap="round"/>`,
      `<line x1="${refX}" x2="${refX}" y1="${y + 7}" y2="${y + 26}" stroke="#dce9ef" stroke-opacity="0.85" stroke-width="2"/>`,
      axis.value === null ? `<line x1="${x0}" x2="${x1}" y1="${y + 16}" y2="${y + 16}" stroke="#71818e" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="5 6"/>` : `<line x1="${x0}" x2="${valueX}" y1="${y + 16}" y2="${y + 16}" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`,
      axis.value === null ? '' : `<circle cx="${valueX}" cy="${y + 16}" r="5" fill="${color}" stroke="#f2f6f7" stroke-opacity="0.8"/>`,
      text(axis.value === null ? '—' : number(axis.value), 1010, y + 21, 17, {anchor: 'end', fill: color, weight: 700}),
      text(deltaText, 1110, y + 21, 15, {anchor: 'end', fill: color, weight: 650}),
    ].join('');
  }).join('');
}

function recentSvg(payload: Record<string, any>, cover: string, avatar: string): string {
  const player = payload.player || {};
  const sample = payload.sample || {};
  const axes = recentAxes(payload.profile || {});
  const completed = finite(sample.completed);
  const analyzed = finite(sample.analyzed);
  const skipped = finite(sample.skipped);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs>${avatarDefs()}<linearGradient id="recent-bg" x2="1"><stop stop-color="#071c25"/><stop offset="0.58" stop-color="#101b20"/><stop offset="1" stop-color="#241719"/></linearGradient><linearGradient id="recent-cover" x2="1"><stop stop-color="#0b1720" stop-opacity="0.92"/><stop offset="1" stop-color="#160e16" stop-opacity="0.68"/></linearGradient><style>text { font-family: "MiSans", "Noto Sans SC", "Segoe UI", sans-serif; font-variant-numeric: tabular-nums; }</style></defs>
<rect width="1280" height="720" fill="url(#recent-bg)"/>${cover ? `<image x="840" y="0" width="440" height="720" href="${cover}" preserveAspectRatio="xMidYMid slice" opacity="0.23"/>` : ''}<rect width="1280" height="720" fill="url(#recent-cover)"/>
${text('RECENT FORM', 48, 25, 12, {fill: '#90aaa9', spacing: 2.4, weight: 650})}${text('近期状态面板', 1232, 25, 13, {anchor: 'end', fill: '#e8c26d', spacing: 1.8, weight: 700})}
${avatarTag(avatar, player.username, 80, 72, 'avatar-left', '#ff9dbe')}${text(compact(player.username || `osu! ${player.osuId || '?'}`, 25), 132, 53, 29, {weight: 700})}${text(`${String(player.countryCode || '—').toUpperCase()} · GLOBAL ${rank(player.globalRank)} · ${pp(player.pp)}pp`, 132, 80, 14, {fill: '#b5c7cf', spacing: 0.5})}${text(`最近 ${finite(sample.days, 5)} 天 · ${completed} 张完成谱面 · ${analyzed} 组有效证据`, 132, 108, 16, {fill: '#ff9dbe', weight: 650})}${text(`获取 ${finite(sample.fetched)} 条 · 去重 ${finite(sample.groups)} 组 · 跳过 ${skipped} 组`, 132, 132, 12, {fill: '#879aa5'})}
${text('RECENT PERFORMANCE', 1232, 82, 17, {anchor: 'end', fill: '#f0d99d', spacing: 1.4, weight: 700})}${text('同 BID + 需求 Mods 去重', 1232, 108, 12, {anchor: 'end', fill: '#b8c1c0'})}<line x1="48" x2="1232" y1="159" y2="159" stroke="#e5d49d" stroke-opacity="0.42"/>${recentStateSummary(axes)}${recentRows(axes)}
<line x1="48" x2="1232" y1="655" y2="655" stroke="#dce9ef" stroke-opacity="0.13"/>${text('近期有效发挥', 48, 684, 11, {fill: RECENT_MAIN, spacing: 1.4, weight: 700})}${text('线条 = 近期值  ·  白色标记 = BP50 长期参考  ·  ▲/▼ = 差值', 150, 684, 11, {fill: '#a6b6bc'})}${text('FAIL 降权 · 24H 100% → DAY5 85% · 差值 <0.2 不标记', 1232, 684, 11, {anchor: 'end', fill: '#7f929d', spacing: 0.6})}
</svg>`;
}

export {renderPlayerSkillProfileCard} from './skillCard/cards.js';

export async function renderPlayerRecentSkillProfileCard(payload: Record<string, any>): Promise<Buffer> {
  const player = payload.player || {};
  const [cover, avatar] = await Promise.all([
    imageDataUrl(player.coverUrl || player.avatarUrl),
    imageDataUrl(player.avatarUrl, player.osuId),
  ]);
  return sharp(Buffer.from(recentSvg(payload, cover, avatar)), {density: 144}).png({compressionLevel: 9}).toBuffer();
}

export {buildPlayerSkillComparisonHtml,renderPlayerSkillComparisonCard} from './skillCard/comparison.js';
