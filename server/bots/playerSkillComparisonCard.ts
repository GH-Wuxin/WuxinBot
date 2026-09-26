import {imageDataUrl} from './skillCard/images.js';
import {tierEmblemDataUrls} from './skillCard/cards.js';
import {ratingPresentation} from './skillCard/presentation.js';
import sharp from 'sharp';
import {PLAYER_SKILL_AXIS_DEFINITIONS} from './playerSkillAxes.js';
import type {PlayerSkillAxis} from './playerSkillAxes.js';

const WIDTH = 1280;
const HEIGHT = 720;
const RECENT_MAIN = '#64e5c0';
const RECENT_DOWN = '#ef9098';
const RECENT_WARN = '#e8c26d';
// Keep comparison surfaces on the same neutral graphite palette as /w info's
// player card. Tier colors remain reserved for player-specific accents.
const INFO_PAPER = '#171b20';
const INFO_PANEL = '#1e242a';
const INFO_RULE = '#384149';
const INFO_RULE_SOFT = '#2b333a';
const INFO_MUTED = '#a6afb5';
const AXIS_COLORS = ['#70dfc3', '#77b7f3', '#e6b987', '#c3a8ef', '#f0d477', '#e5a9be', '#a7cbd2', '#b0b6dd', '#9ccdb8'];
const COMPARISON_AXES: ReadonlyArray<{key: PlayerSkillAxis; label: string; unit: 'star' | 'independent'}> =
  PLAYER_SKILL_AXIS_DEFINITIONS.map(({key, label, unit}) => ({key, label, unit}));
const PP_PLUS_AXES = [
  {key: 'jump', label: 'Jump'},
  {key: 'flow', label: 'Flow'},
  {key: 'speed', label: 'Speed'},
  {key: 'stamina', label: 'Stamina'},
  {key: 'precision', label: 'Precision'},
  {key: 'accuracy', label: 'Accuracy'},
] as const;

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

function valueOrNull(value: unknown): number | null {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function comparisonAxes(left: any, right: any): any[] {
  const byKey = (side: any) => new Map<PlayerSkillAxis, any>(
    (Array.isArray(side.profile?.axes) ? side.profile.axes : []).map((axis: any) => [axis.key, axis]),
  );
  const leftByKey = byKey(left);
  const rightByKey = byKey(right);
  const axes = COMPARISON_AXES.map((definition) => ({
    ...definition,
    left: valueOrNull(leftByKey.get(definition.key)?.ceiling),
    right: valueOrNull(rightByKey.get(definition.key)?.ceiling),
  }));
  if (COMPARISON_AXES.some((axis) => !leftByKey.has(axis.key) || !rightByKey.has(axis.key))) {
    throw new Error('PLAYER_SKILL_COMPARE_AXES_INVALID');
  }
  return axes;
}

function profileRatingPresentation(side: any): any {
  const player = side.player || {};
  const profile = side.profile || {};
  const view = ratingPresentation({
    ...profile,
    rows: Array.isArray(side.rows) ? side.rows : [],
    player: {statistics: {global_rank: player.globalRank, country_rank: player.countryRank, pp: player.pp}},
  });
  return view;
}

function boostedTierColor(hex: string, _level: number): string {
  // presentation.ts owns the perceptually tuned Tier accent. Re-saturating it
  // here makes the comparison card disagree with the player card.
  return hex;
}

function profileSide(side: any): any {
  const ratingView = profileRatingPresentation(side);
  const tier = ratingView.rated && ratingView.tier ? ratingView.tier : null;
  const color = String(tier?.color || '#aeb5ad');
  return {
    player: side.player || {},
    sample: side.sample || {},
    tier,
    rating: ratingView.rated ? valueOrNull(ratingView.value) : null,
    color,
    radarColor: boostedTierColor(color, Number(tier?.level || 1)),
  };
}

function shiftColorLightness(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(...channels), min = Math.min(...channels), delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === channels[0]) hue = 60 * (((channels[1] - channels[2]) / delta) % 6);
    else if (max === channels[1]) hue = 60 * ((channels[2] - channels[0]) / delta + 2);
    else hue = 60 * ((channels[0] - channels[1]) / delta + 4);
    if (hue < 0) hue += 360;
  }
  const shiftedLightness = Math.max(.48, Math.min(.88, lightness + amount));
  const chroma = (1 - Math.abs(2 * shiftedLightness - 1)) * saturation;
  const huePart = hue / 60;
  const x = chroma * (1 - Math.abs(huePart % 2 - 1));
  const rgb = huePart < 1 ? [chroma, x, 0]
    : huePart < 2 ? [x, chroma, 0]
      : huePart < 3 ? [0, chroma, x]
        : huePart < 4 ? [0, x, chroma]
          : huePart < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  const match = shiftedLightness - chroma / 2;
  return `#${rgb.map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function comparisonColors(left: any, right: any): {left: string; right: string} {
  if (left.tier?.level === right.tier?.level) {
    const base = left.radarColor;
    return {left: shiftColorLightness(base, -.11), right: shiftColorLightness(base, .10)};
  }
  return {left: left.radarColor, right: right.radarColor};
}

function tierRoman(level: unknown): string {
  return ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'][Math.max(0, Math.min(11, Math.round(finite(level, 1)) - 1))];
}

function comparisonAvatar(dataUrl: string, cx: number, cy: number, clipId: string, color: string, username: unknown): string {
  const image = dataUrl
    ? `<image x="${cx - 34}" y="${cy - 34}" width="68" height="68" href="${dataUrl}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    : `<text x="${cx}" y="${cy + 7}" text-anchor="middle" fill="${color}" font-size="22" font-weight="700">${esc(initials(username))}</text>`;
  return `<circle cx="${cx}" cy="${cy}" r="39" fill="${INFO_PAPER}" stroke="${color}" stroke-width="1.7"/>${image}`;
}

function comparisonPlayerHeader(side: any, placement: 'left' | 'right', avatar: string, playerColor: string): string {
  const {player, sample, tier, color} = side;
  const left = placement === 'left';
  const avatarX = left ? 61 : 786;
  const nameX = left ? 108 : 832;
  const y = 137;
  const username = compact(player.username || `osu! ${player.osuId || '?'}`, 25);
  const tierName = tier?.en || 'UNRATED';
  const avatarMarkup = comparisonAvatar(avatar, avatarX, 140, left ? 'compare-avatar-left' : 'compare-avatar-right', playerColor, player.username);
  const emblemKey = tier ? (tier.level === 12 ? 'prism' : tierRoman(tier.level).toLowerCase()) : '';
  const emblemDataUrl = emblemKey ? tierEmblemDataUrls[emblemKey] || '' : '';
  const emblemX = left ? 442 : 1180;
  const emblemMarkup = emblemDataUrl
    ? `<image data-tier-emblem="${tier.level}" x="${emblemX}" y="119" width="42" height="42" href="${emblemDataUrl}" preserveAspectRatio="xMidYMid meet" opacity=".58"/>`
    : '';
  const name = text(username, nameX, y, 18, {fill: playerColor, weight: 700});
  const metadata = text(`${String(player.countryCode || '—').toUpperCase()} · GLOBAL ${rank(player.globalRank)} · ${pp(player.pp)}pp · ${number(player.accuracy, 2)}%`, nameX, 156, 9.5, {fill: playerColor, weight: 600});
  const tierText = tier ? `<tspan fill="#7e8984">TIER ${tierRoman(tier.level)} · </tspan><tspan fill="${color}">${esc(tierName)}</tspan>` : `<tspan fill="${color}">INSUFFICIENT EVIDENCE</tspan>`;
  const sampleLine = `<text x="${nameX}" y="172" fill="#7e8984" font-size="8" font-weight="500" letter-spacing=".35">${tierText}<tspan fill="#7e8984"> · BP50 ${finite(sample.valid)}/${finite(sample.requested, 50)} VALID</tspan></text>`;
  return `${avatarMarkup}${emblemMarkup}${name}${metadata}${sampleLine}`;
}

function radarPoint(value: number, max: number, index: number, cx: number, cy: number, radius: number, axisCount = COMPARISON_AXES.length): {x: number; y: number} {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / axisCount;
  const scaled = radius * Math.max(0, Math.min(max, value)) / max;
  return {x: cx + Math.cos(angle) * scaled, y: cy + Math.sin(angle) * scaled};
}

function radarPolygon(values: number[], maxima: number[], cx: number, cy: number, radius: number, axisCount = COMPARISON_AXES.length): string {
  return values.map((value, index) => {
    const point = radarPoint(value, maxima[index], index, cx, cy, radius, axisCount);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(' ');
}

function comparisonRadar(axes: any[], leftColor: string, rightColor: string): string {
  const coreMax = Math.max(10, Math.ceil(Math.max(0, ...axes.filter((axis) => axis.unit === 'star')
    .flatMap((axis) => [axis.left, axis.right]).filter((value): value is number => value !== null)) * 1.08 * 2) / 2);
  const maxima = axes.map((axis) => axis.unit === 'independent' ? 10 : coreMax);
  const cx = 414, cy = 438, radius = 157, labelRadius = 198;
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) =>
    `<polygon class="radar-grid" points="${radarPolygon(maxima.map((max) => max * ratio), maxima, cx, cy, radius)}" fill="none" stroke="${INFO_RULE}" stroke-opacity="${ratio === 1 ? .62 : .24}" stroke-width="${ratio === 1 ? 1.1 : .8}"/>`,
  ).join('');
  const spokes = axes.map((axis, index) => {
    const point = radarPoint(maxima[index], maxima[index], index, cx, cy, radius);
    return `<line x1="${cx}" y1="${cy}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${INFO_RULE}" stroke-opacity=".24" stroke-width=".7"/>`;
  }).join('');
  const series = (key: 'left' | 'right', color: string): string => {
    const points = axes.map((axis, index) => axis[key] === null ? null : radarPoint(axis[key], maxima[index], index, cx, cy, radius));
    const dash = key === 'right' ? ' stroke-dasharray="5 3"' : '';
    if (points.every((point) => point !== null)) {
      return `<polygon class="profile-series ${key}" data-series="${key}" points="${points.map((point) => `${point!.x.toFixed(1)},${point!.y.toFixed(1)}`).join(' ')}" fill="${color}" fill-opacity=".10" stroke="${color}" stroke-width="2" stroke-linejoin="round"${dash}/>`;
    }
    return points.map((point, index) => {
      const next = (index + 1) % points.length;
      if (!point || !points[next]) return '';
      return `<line class="profile-series ${key}" data-series="${key}" x1="${point.x.toFixed(1)}" y1="${point.y.toFixed(1)}" x2="${points[next]!.x.toFixed(1)}" y2="${points[next]!.y.toFixed(1)}" stroke="${color}" stroke-width="2"${dash}/>`;
    }).join('');
  };
  const leftShape = series('left', leftColor);
  const rightShape = series('right', rightColor);
  const leftDots = axes.map((axis, index) => {
    if (axis.left === null) return '';
    const point = radarPoint(axis.left, maxima[index], index, cx, cy, radius);
    return `<circle class="radar-dot left" data-marker="circle" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.8" fill="${leftColor}" stroke="${INFO_PANEL}" stroke-width="1.3"/>`;
  }).join('');
  const rightDots = axes.map((axis, index) => {
    if (axis.right === null) return '';
    const point = radarPoint(axis.right, maxima[index], index, cx, cy, radius);
    const x = point.x, y = point.y, markerRadius = 4.5;
    return `<polygon class="radar-dot right" data-marker="diamond" points="${x.toFixed(1)},${(y - markerRadius).toFixed(1)} ${(x + markerRadius).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(y + markerRadius).toFixed(1)} ${(x - markerRadius).toFixed(1)},${y.toFixed(1)}" fill="${rightColor}" stroke="${INFO_PANEL}" stroke-width="1.3"/>`;
  }).join('');
  const labels = axes.map((axis, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length;
    const x = cx + Math.cos(angle) * labelRadius;
    const y = cy + Math.sin(angle) * labelRadius;
    const anchor = Math.cos(angle) > .22 ? 'start' : Math.cos(angle) < -.22 ? 'end' : 'middle';
    const labelY = y + (Math.sin(angle) < -.65 ? 5 : Math.sin(angle) > .65 ? 5 : 3);
    const leftValue = axis.left === null ? '—' : number(axis.left);
    const rightValue = axis.right === null ? '—' : number(axis.right);
    const suffix = axis.unit === 'independent' ? ' · /10' : '';
    return `<g class="axis-value" data-axis-label="${axis.key}" data-unit="${axis.unit}">${text(axis.label, Number(x.toFixed(1)), Number(labelY.toFixed(1)), 10, {fill: '#e7e4dc', weight: 600, anchor})}<text x="${x.toFixed(1)}" y="${(labelY + 14).toFixed(1)}" font-size="9.3" font-weight="650" text-anchor="${anchor}"><tspan fill="${leftColor}">${leftValue}</tspan><tspan fill="#a0a5a0"> / </tspan><tspan fill="${rightColor}">${rightValue}</tspan><tspan fill="#a0a5a0" font-size="6.8">${suffix}</tspan></text></g>`;
  }).join('');
  return `<g class="comparison-radar" data-core-max="${coreMax}" data-index-max="10">${grid}${spokes}${leftShape}${rightShape}${leftDots}${rightDots}${labels}<circle cx="${cx}" cy="${cy}" r="2.2" fill="${INFO_PAPER}"/></g>`;
}

function comparisonSignal(left: any, right: any, leftName: string, rightName: string, leftColor: string, rightColor: string): {label: string; color: string; delta: number | null} {
  const leftRating = valueOrNull(left.rating);
  const rightRating = valueOrNull(right.rating);
  if (leftRating === null || rightRating === null) return {label: 'Insufficient Skill Rating', color: '#a0a5a0', delta: null};
  const delta = rightRating - leftRating;
  if (delta === 0) return {label: 'Skill Rating tied', color: '#c8b47f', delta};
  return delta > 0
    ? {label: `${compact(rightName, 18)} leads by Skill Rating`, color: rightColor, delta}
    : {label: `${compact(leftName, 18)} leads by Skill Rating`, color: leftColor, delta};
}

function skillRating(value: unknown): string {
  return valueOrNull(value) === null ? '—' : Math.round(Number(value)).toLocaleString('en-US');
}

function ppPlusValue(source: any, key: string): number | null {
  const raw = source?.ppPlus?.[key];
  return valueOrNull(raw && typeof raw === 'object' ? raw.value : raw);
}

function comparisonPpPlusAxes(left: any, right: any): any[] {
  return PP_PLUS_AXES.map((definition) => ({
    ...definition,
    left: ppPlusValue(left, definition.key),
    right: ppPlusValue(right, definition.key),
  }));
}

function comparisonPpPlusRadar(left: any, right: any, leftColor: string, rightColor: string): string {
  const axes = comparisonPpPlusAxes(left, right);
  const count = PP_PLUS_AXES.length;
  const valid = axes.flatMap((axis) => [axis.left, axis.right]).filter((value): value is number => value !== null);
  if (!valid.length) {
    return text('PP+ DATA UNAVAILABLE', 995, 400, 12, {fill: '#7f8983', weight: 650, anchor: 'middle', spacing: 1.1});
  }
  const max = Math.max(15, Math.ceil(Math.max(0, ...valid) * 1.08 * 2) / 2);
  const cx = 995, cy = 392, radius = 116, labelRadius = 146;
  const grid = [0.25, 0.5, 0.75, 1].map((ratio) =>
    `<polygon class="ppplus-grid" points="${radarPolygon(Array.from({length: count}, () => max * ratio), Array.from({length: count}, () => max), cx, cy, radius, count)}" fill="none" stroke="${INFO_RULE}" stroke-opacity="${ratio === 1 ? .62 : .24}" stroke-width="${ratio === 1 ? 1.1 : .8}"/>`,
  ).join('');
  const spokes = axes.map((_, index) => {
    const point = radarPoint(max, max, index, cx, cy, radius, count);
    return `<line x1="${cx}" y1="${cy}" x2="${point.x.toFixed(1)}" y2="${point.y.toFixed(1)}" stroke="${INFO_RULE}" stroke-opacity=".24" stroke-width=".7"/>`;
  }).join('');
  const baseline = `<polygon class="ppplus-baseline" points="${radarPolygon(Array.from({length: count}, () => Math.min(15, max)), Array.from({length: count}, () => max), cx, cy, radius, count)}" fill="none" stroke="${INFO_MUTED}" stroke-opacity=".8" stroke-width="1.1" stroke-dasharray="5 4"/>`;
  const series = (key: 'left' | 'right', color: string): string => {
    const points = axes.map((axis, index) => axis[key] === null ? null : radarPoint(axis[key], max, index, cx, cy, radius, count));
    const dash = key === 'right' ? ' stroke-dasharray="5 3"' : '';
    if (points.every((point) => point !== null)) {
      return `<polygon class="ppplus-series ${key}" data-series="${key}" points="${points.map((point) => `${point!.x.toFixed(1)},${point!.y.toFixed(1)}`).join(' ')}" fill="${color}" fill-opacity=".08" stroke="${color}" stroke-width="1.9" stroke-linejoin="round"${dash}/>`;
    }
    return points.map((point, index) => {
      const next = (index + 1) % points.length;
      if (!point || !points[next]) return '';
      return `<line class="ppplus-series ${key}" data-series="${key}" x1="${point.x.toFixed(1)}" y1="${point.y.toFixed(1)}" x2="${points[next]!.x.toFixed(1)}" y2="${points[next]!.y.toFixed(1)}" stroke="${color}" stroke-width="1.9"${dash}/>`;
    }).join('');
  };
  const leftShape = series('left', leftColor);
  const rightShape = series('right', rightColor);
  const leftDots = axes.map((axis, index) => {
    if (axis.left === null) return '';
    const point = radarPoint(axis.left, max, index, cx, cy, radius, count);
    return `<circle class="ppplus-dot left" data-ppplus-axis="${axis.key}" data-marker="circle" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.7" fill="${leftColor}" stroke="${INFO_PANEL}" stroke-width="1.2"/>`;
  }).join('');
  const rightDots = axes.map((axis, index) => {
    if (axis.right === null) return '';
    const point = radarPoint(axis.right, max, index, cx, cy, radius, count);
    const markerRadius = 4.4;
    return `<polygon class="ppplus-dot right" data-ppplus-axis="${axis.key}" data-marker="diamond" points="${point.x.toFixed(1)},${(point.y - markerRadius).toFixed(1)} ${(point.x + markerRadius).toFixed(1)},${point.y.toFixed(1)} ${point.x.toFixed(1)},${(point.y + markerRadius).toFixed(1)} ${(point.x - markerRadius).toFixed(1)},${point.y.toFixed(1)}" fill="${rightColor}" stroke="${INFO_PANEL}" stroke-width="1.2"/>`;
  }).join('');
  const labels = axes.map((axis, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    const x = cx + Math.cos(angle) * labelRadius;
    const y = cy + Math.sin(angle) * labelRadius;
    const anchor = Math.cos(angle) > .22 ? 'start' : Math.cos(angle) < -.22 ? 'end' : 'middle';
    const labelY = y + (Math.sin(angle) < -.65 ? -2 : Math.sin(angle) > .65 ? 5 : 3);
    const leftValue = axis.left === null ? '—' : number(axis.left, 2);
    const rightValue = axis.right === null ? '—' : number(axis.right, 2);
    return `<g class="ppplus-axis-value" data-ppplus-axis="${axis.key}">${text(axis.label, Number(x.toFixed(1)), Number(labelY.toFixed(1)), 9.5, {fill: '#e7e4dc', weight: 600, anchor})}<text x="${x.toFixed(1)}" y="${(labelY + 13).toFixed(1)}" font-size="8.7" font-weight="650" text-anchor="${anchor}"><tspan fill="${leftColor}">${leftValue}</tspan><tspan fill="#a0a5a0"> / </tspan><tspan fill="${rightColor}">${rightValue}</tspan></text></g>`;
  }).join('');
  return `<g class="comparison-ppplus-radar" data-ppplus-max="${max}" data-ppplus-index-max="15">${grid}${spokes}${baseline}${leftShape}${rightShape}${leftDots}${rightDots}${labels}<circle cx="${cx}" cy="${cy}" r="2" fill="${INFO_PAPER}"/></g>`;
}

function comparisonPanelNotes(axes: any[], leftColor: string, rightColor: string): string {
  const valid = axes.filter((axis) => axis.left !== null && axis.right !== null);
  const meaningful = valid.filter((axis) => Math.abs(axis.right - axis.left) >= .15)
    .sort((a, b) => Math.abs(b.right - b.left) - Math.abs(a.right - a.left));
  const output = [
    text('CORE SCALE', 43, 590, 7.5, {fill: '#7f8983', weight: 650, spacing: 1.05}),
    text('Experimental equivalent ★ · Stamina / Endurance independent /10', 43, 608, 8.1, {fill: '#a0a5a0'}),
    text('Radar display-only · Skill Rating uses weighted profile aggregate', 43, 623, 8.1, {fill: '#a0a5a0'}),
    text('PP+ DISPLAY', 750, 590, 7.5, {fill: '#7f8983', weight: 650, spacing: 1.05}),
    text('15 = ExpertPlus benchmark · relative shape inside PP+ only', 750, 608, 8.1, {fill: '#a0a5a0'}),
    text('LARGEST SKILL GAP', 750, 625, 7.5, {fill: '#7f8983', weight: 650, spacing: 1.05}),
    text('PP+ SOURCE · github.com/Apeuriox/lazybot-pp-plus', 1238, 660, 7.2, {fill: '#76818a', anchor: 'end', spacing: .15}),
  ];
  if (!meaningful.length) {
    output.push(text('All dimensions remain close', 1238, 646, 9.5, {fill: '#b6bab3', anchor: 'end'}));
  } else {
    const axis = meaningful[0];
    const delta = axis.right - axis.left;
    output.push(text(axis.label, 750, 646, 9.5, {fill: '#b6bab3', weight: 550}));
    output.push(text(`${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`, 1238, 646, 9.5, {fill: delta > 0 ? rightColor : leftColor, weight: 650, anchor: 'end'}));
  }
  return output.join('');
}

export function buildPlayerSkillComparisonSvg(payload: Record<string, any>, leftAvatar = '', rightAvatar = ''): string {
  const left = profileSide(payload.left || {});
  const right = profileSide(payload.right || {});
  const leftPlayer = left.player;
  const rightPlayer = right.player;
  const axes = comparisonAxes(payload.left || {}, payload.right || {});
  const colors = comparisonColors(left, right);
  const signal = comparisonSignal(left, right, leftPlayer.username || 'Left player', rightPlayer.username || 'Right player', colors.left, colors.right);
  const ppPlusRadar = comparisonPpPlusRadar(payload.left || {}, payload.right || {}, colors.left, colors.right);
  const defs = `<clipPath id="compare-avatar-left"><circle cx="61" cy="140" r="34"/></clipPath><clipPath id="compare-avatar-right"><circle cx="786" cy="140" r="34"/></clipPath><style>text{font-family:"Segoe UI","Arial",sans-serif;font-variant-numeric:tabular-nums}</style>`;
  const ratingDelta = signal.delta === null ? '—' : `${signal.delta > 0 ? '+' : signal.delta < 0 ? '−' : ''}${Math.abs(signal.delta).toLocaleString('en-US')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" data-design="tier-radar-v2" data-ppplus="true" data-left-tier="${left.tier?.level || 0}" data-right-tier="${right.tier?.level || 0}" data-left-rating="${left.rating ?? ''}" data-right-rating="${right.rating ?? ''}" data-left-color="${colors.left}" data-right-color="${colors.right}" data-left-tier-color="${left.color}" data-right-tier-color="${right.color}">
<defs>${defs}</defs><rect width="${WIDTH}" height="${HEIGHT}" fill="${INFO_PAPER}"/><rect x="20" y="20" width="1240" height="680" fill="${INFO_PANEL}" stroke="${INFO_RULE_SOFT}" stroke-width=".7"/>
${text('Skill Profiler', 42, 46, 10, {fill: '#e7e4dc', weight: 650})}${text('PLAYER COMPARISON', 42, 72, 23, {fill: '#e7e4dc', weight: 700, spacing: 1.2})}${text('BP50 PROFILE  /  INDEPENDENT VIEW', 43, 89, 8, {fill: '#a0a5a0', spacing: .65})}${text('PROFILE COMPARISON', 1238, 46, 7, {anchor: 'end', fill: '#6e7773', weight: 650, spacing: 1})}${text('9 SKILL  ·  6 PP+', 1238, 62, 7, {anchor: 'end', fill: '#acdafb', weight: 650, spacing: .8})}
<line x1="43" y1="100" x2="1238" y2="100" stroke="${INFO_RULE}" stroke-width=".7"/>
${comparisonPlayerHeader(left, 'left', leftAvatar, colors.left)}<line x1="493" y1="118" x2="493" y2="168" stroke="${INFO_RULE}" stroke-width=".7"/><circle cx="514" cy="140" r="3.2" fill="${signal.color}"/>${text(signal.label, 528, 143, 9.2, {fill: signal.color, weight: 650, spacing: .25})}${text('SKILL RATING', 514, 158, 7, {fill: '#7e8984', weight: 650, spacing: .75})}<text x="514" y="173" font-size="10" font-weight="650"><tspan fill="${colors.left}">${skillRating(left.rating)}</tspan><tspan fill="#a0a5a0">  /  </tspan><tspan fill="${colors.right}">${skillRating(right.rating)}</tspan><tspan fill="${signal.color}" font-size="8.5">  ·  Δ ${ratingDelta}</tspan></text><line x1="746" y1="118" x2="746" y2="168" stroke="${INFO_RULE}" stroke-width=".7"/>${comparisonPlayerHeader(right, 'right', rightAvatar, colors.right)}
<line x1="43" y1="186" x2="1238" y2="186" stroke="${INFO_RULE}" stroke-opacity=".65" stroke-width=".7"/>
${text('PLAYER SKILL PROFILE', 43, 209, 8.5, {fill: '#a0a5a0', weight: 650, spacing: 1})}${text('9 DIMENSIONS', 43, 222, 7.5, {fill: '#6e7773', weight: 600, spacing: .65})}${text('PP+ PROFILE', 750, 209, 8.5, {fill: '#a0a5a0', weight: 650, spacing: 1})}${text('6 DIMENSIONS  ·  15 EXPERTPLUS', 1238, 209, 7.5, {anchor: 'end', fill: '#6e7773', weight: 600, spacing: .65})}<line x1="43" y1="233" x2="1238" y2="233" stroke="${INFO_RULE}" stroke-opacity=".5" stroke-width=".7"/><line x1="714" y1="249" x2="714" y2="649" stroke="${INFO_RULE}" stroke-width=".7"/>
${comparisonRadar(axes, colors.left, colors.right)}${ppPlusRadar}${comparisonPanelNotes(axes, colors.left, colors.right)}
<line x1="43" y1="670" x2="1238" y2="670" stroke="${INFO_RULE}" stroke-opacity=".55" stroke-width=".7"/>${text(compact(leftPlayer.username || 'Left player', 22), 43, 689, 8, {fill: colors.left, weight: 650})}${text(compact(rightPlayer.username || 'Right player', 22), 1238, 689, 8, {anchor: 'end', fill: colors.right, weight: 650})}${text('BP50  ·  SCORE QUALITY ADJUSTED  ·  |Δ| < 0.15 = CLOSE', 640, 689, 7, {anchor: 'middle', fill: '#6e7773', weight: 600, spacing: .45})}
</svg>`;
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

export async function renderPlayerSkillComparisonCard(payload: Record<string, any>): Promise<Buffer> {
  const leftPlayer = payload.left?.player || {};
  const rightPlayer = payload.right?.player || {};
  const [leftAvatar, rightAvatar] = await Promise.all([
    imageDataUrl(leftPlayer.avatarUrl, leftPlayer.osuId),
    imageDataUrl(rightPlayer.avatarUrl, rightPlayer.osuId),
  ]);
  return sharp(Buffer.from(buildPlayerSkillComparisonSvg(payload, leftAvatar, rightAvatar)), {density: 144}).png({compressionLevel: 9}).toBuffer();
}
