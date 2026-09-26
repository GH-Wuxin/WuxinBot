// Recommend filter translation.
//
// Stage 1 (pippi's tool loop) decides that the player wants beatmap
// recommendations. Stage 2 (this module) turns the player's natural-language
// constraints into one canonical statement, which a deterministic parser then
// converts into structured filters. Filters are applied against mod-adjusted
// values (DT/HR change AR/BPM/star), so the pure BPM speed math also lives
// here where it can be unit-tested without the engine.

import { completeChat } from '../bot/llm.js';

export const OSU_FILTER_MODEL = 'deepseek-v4-flash';

export interface RecommendFilters {
  bpmMin?: number;
  bpmMax?: number;
  arMin?: number;
  arMax?: number;
  csMin?: number;
  csMax?: number;
  odMin?: number;
  odMax?: number;
  hpMin?: number;
  hpMax?: number;
  starMin?: number;
  starMax?: number;
  lengthMin?: number;
  lengthMax?: number;
  similarMin?: number;
  similarMax?: number;
  /** "能打/打得动" — engine caps candidates at the player's Top star × 1.1. */
  playable?: boolean;
  forbidMods?: string[];
  preferMods?: string[];
}

export function isEmptyFilters(f: RecommendFilters | undefined | null): boolean {
  if (!f) return true;
  return !f.bpmMin && !f.bpmMax && !f.arMin && !f.arMax &&
    !f.csMin && !f.csMax && !f.odMin && !f.odMax && !f.hpMin && !f.hpMax &&
    !f.starMin && !f.starMax && !f.lengthMin && !f.lengthMax &&
    !f.similarMin && !f.similarMax &&
    !f.playable &&
    !f.forbidMods?.length && !f.preferMods?.length;
}

export function applyModBpm(baseBpm: number, mods: string[] = []): number {
  if (!Number.isFinite(baseBpm) || baseBpm <= 0) return baseBpm;
  const set = new Set((mods || []).map((m) => String(m).toUpperCase()));
  let multiplier = 1;
  if (set.has('DT') || set.has('NC')) multiplier *= 1.5;
  if (set.has('HT')) multiplier *= 0.75;
  return Math.round(baseBpm * multiplier * 100) / 100;
}

const FIELD_LABELS: Record<string, string> = {
  bpm: 'BPM',
  ar: 'AR',
  cs: 'CS',
  od: 'OD',
  hp: 'HP',
  star: '星数',
  length: '时长',
  similar: '同分段人数',
};

const FIELD_MIN: Record<string, number> = { bpm: 1, ar: 0, cs: 0, od: 0, hp: 0, star: 0, length: 1, similar: 0 };
const FIELD_MAX: Record<string, number> = {
  bpm: 1000, ar: 11, cs: 10, od: 10, hp: 10, star: 20, length: 36000, similar: 500,
};

const FIELD_KEY: Record<string, { min: string; max: string }> = {
  bpm: { min: 'bpmMin', max: 'bpmMax' },
  ar: { min: 'arMin', max: 'arMax' },
  cs: { min: 'csMin', max: 'csMax' },
  od: { min: 'odMin', max: 'odMax' },
  hp: { min: 'hpMin', max: 'hpMax' },
  star: { min: 'starMin', max: 'starMax' },
  length: { min: 'lengthMin', max: 'lengthMax' },
  similar: { min: 'similarMin', max: 'similarMax' },
};

const VALID_FIELDS = new Set(Object.keys(FIELD_KEY));
const KNOWN_MOD_COMBOS = ['NC', 'DT', 'HD', 'HR', 'HT', 'EZ', 'FL', 'SO', 'NF'];

function splitModCombo(combo: string): string[] | null {
  const out: string[] = [];
  let rest = String(combo || '').toUpperCase();
  while (rest) {
    const hit = KNOWN_MOD_COMBOS.find((mod) => rest.startsWith(mod));
    if (!hit) return null;
    out.push(hit);
    rest = rest.slice(hit.length);
  }
  return out.length ? out : null;
}

export { splitModCombo };

function normalizeStatement(raw: string): string {
  return String(raw || '')
    .replace(/```[a-z]*/gi, '')
    .replace(/```/g, '')
    .replace(/[，、;；]/g, ' ')
    .replace(/[＜＞≤≥]/g, (ch) => ({ '＜': '<', '＞': '>', '≤': '<=', '≥': '>=' })[ch] || ch)
    .replace(/^\s*recommend\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Mod-adjusted stat conversion ──
//
// The osu! API v2 /beatmaps/{id}/attributes endpoint only returns star rating
// and strain metrics; AR/CS/OD/HP are NOT included. Filtering against
// mod-adjusted values therefore requires converting the beatmap's base stats
// with the standard stable formulas (difficulty mods first, then speed mods).

export interface BaseBeatmapStats {
  ar: number;
  cs: number;
  od: number;
  hp: number;
  bpm: number;
  length: number;
}

export interface ModAdjustedStats {
  ar: number;
  cs: number;
  od: number;
  hp: number;
  bpm: number;
  length: number;
}

function approachTimeFromAr(ar: number): number {
  return ar <= 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5);
}

function arFromApproachTime(ms: number): number {
  if (ms <= 1200) return 5 + (1200 - ms) / 150;
  return (1800 - ms) / 120;
}

function hitWindow300FromOd(od: number): number {
  return 80 - 6 * od;
}

function odFromHitWindow(ms: number): number {
  return (80 - ms) / 6;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function applyModStats(base: BaseBeatmapStats, mods: string[] = []): ModAdjustedStats {
  const set = new Set((mods || []).map((m) => String(m).toUpperCase()));
  let ar = Number(base.ar) || 0;
  let cs = Number(base.cs) || 0;
  let od = Number(base.od) || 0;
  let hp = Number(base.hp) || 0;
  let bpm = Number(base.bpm) || 0;
  let length = Number(base.length) || 0;

  if (set.has('HR')) {
    ar = Math.min(10, ar * 1.4);
    od = Math.min(10, od * 1.4);
    cs = Math.min(10, cs * 1.3);
    hp = Math.min(10, hp * 1.4);
  }
  if (set.has('EZ')) {
    ar = ar * 0.5;
    od = od * 0.5;
    cs = cs * 0.5;
    hp = hp * 0.5;
  }

  let speed = 1;
  if (set.has('DT') || set.has('NC')) speed = 1.5;
  else if (set.has('HT')) speed = 0.75;
  if (speed !== 1) {
    ar = arFromApproachTime(approachTimeFromAr(ar) / speed);
    od = odFromHitWindow(hitWindow300FromOd(od) / speed);
    bpm = bpm * speed;
    length = length / speed;
  }

  ar = Math.min(11, Math.max(0, ar));
  od = Math.min(10, Math.max(0, od));
  cs = Math.min(10, Math.max(0, cs));
  hp = Math.min(10, Math.max(0, hp));
  return {
    ar: round1(ar),
    cs: round1(cs),
    od: round1(od),
    hp: round1(hp),
    bpm: Math.round(bpm * 100) / 100,
    length: Math.round(length),
  };
}

function clampBounds(field: string, min: number | undefined, max: number | undefined): string | null {
  const lo = FIELD_MIN[field];
  const hi = FIELD_MAX[field];
  if (min !== undefined && (min < lo || min > hi)) return `${FIELD_LABELS[field]} 下限 ${min} 超出 ${lo}-${hi}`;
  if (max !== undefined && (max < lo || max > hi)) return `${FIELD_LABELS[field]} 上限 ${max} 超出 ${lo}-${hi}`;
  if (min !== undefined && max !== undefined && min > max) {
    return `${FIELD_LABELS[field]} 区间矛盾（${min} > ${max}）`;
  }
  return null;
}

export function parseRecommendStatement(raw: string): {
  ok: boolean;
  filters: RecommendFilters;
  reason?: string;
} {
  const statement = normalizeStatement(raw);
  if (!statement) return { ok: false, filters: {}, reason: '空语句' };
  if (/^invalid\b/i.test(statement) || /无法理解|条件矛盾|看不懂/i.test(statement)) {
    return { ok: false, filters: {}, reason: statement.replace(/^invalid\s*[:：]?\s*/i, '') || '条件无效' };
  }

  const filters: RecommendFilters = {};
  const mods: { forbid: string[]; prefer: string[] } = { forbid: [], prefer: [] };

  if (/\bplayable\b/i.test(statement)) {
    filters.playable = true;
  }

  // 9<ar<10.3 / 9<=ar<=10.3
  const rangeRe = /(\d+(?:\.\d+)?)\s*(?:<|<=)\s*(ar|bpm|cs|od|hp|star|length|similar)\s*(?:<|<=)\s*(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = rangeRe.exec(statement)) !== null) {
    const field = m[2];
    const lo = Number(m[1]);
    const hi = Number(m[3]);
    const bad = clampBounds(field, lo, hi);
    if (bad) return { ok: false, filters, reason: bad };
    filters[FIELD_KEY[field].min] = lo;
    filters[FIELD_KEY[field].max] = hi;
  }

  // ar>=9 / ar>9 / bpm<=180 / ar<10.3
  const sideRe = /\b(ar|bpm|cs|od|hp|star|length|similar)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)/g;
  while ((m = sideRe.exec(statement)) !== null) {
    const field = m[1];
    const value = Number(m[3]);
    const key = FIELD_KEY[field];
    const bad = clampBounds(field, m[2].startsWith('>') ? value : undefined, m[2].startsWith('<') ? value : undefined);
    if (bad) return { ok: false, filters, reason: bad };
    if (m[2] === '>=' || m[2] === '>') filters[key.min] = value;
    else filters[key.max] = value;
  }

  // bpm 160-200 / ar 9~10.3
  const dashRe = /\b(ar|bpm|cs|od|hp|star|length|similar)\s*(\d+(?:\.\d+)?)\s*(?:-|~|至)\s*(\d+(?:\.\d+)?)/g;
  while ((m = dashRe.exec(statement)) !== null) {
    const field = m[1];
    const lo = Number(m[2]);
    const hi = Number(m[3]);
    const bad = clampBounds(field, lo, hi);
    if (bad) return { ok: false, filters, reason: bad };
    filters[FIELD_KEY[field].min] = lo;
    filters[FIELD_KEY[field].max] = hi;
  }

  // no_dt / prefer_hd / no_dt prefer_hdhr
  const modRe = /\b(no|prefer|only)_?([a-z]{2,8})\b/gi;
  while ((m = modRe.exec(statement)) !== null) {
    const kind = m[1].toLowerCase();
    const modsList = splitModCombo(String(m[2] || ''));
    if (!modsList) continue;
    if (kind === 'no') mods.forbid.push(...modsList);
    else mods.prefer.push(...modsList);
  }

  if (mods.forbid.length) filters.forbidMods = [...new Set(mods.forbid)];
  if (mods.prefer.length) filters.preferMods = [...new Set(mods.prefer)];

  const parsedAny = Object.keys(filters).length > 0;
  if (!parsedAny) {
    return { ok: false, filters, reason: `无法识别筛选语句：${statement}` };
  }
  const badSide = clampBounds('bpm', filters.bpmMin, filters.bpmMax) ||
    clampBounds('ar', filters.arMin, filters.arMax) ||
    clampBounds('cs', filters.csMin, filters.csMax) ||
    clampBounds('od', filters.odMin, filters.odMax) ||
    clampBounds('hp', filters.hpMin, filters.hpMax) ||
    clampBounds('star', filters.starMin, filters.starMax) ||
    clampBounds('length', filters.lengthMin, filters.lengthMax) ||
    clampBounds('similar', filters.similarMin, filters.similarMax);
  if (badSide) return { ok: false, filters, reason: badSide };

  return { ok: true, filters };
}

export function describeFilters(filters: RecommendFilters): string {
  if (isEmptyFilters(filters)) return '';
  const parts: string[] = [];
  const fmt = (lo?: number, hi?: number) => {
    if (lo !== undefined && hi !== undefined) return `${lo}-${hi}`;
    if (lo !== undefined) return `≥${lo}`;
    if (hi !== undefined) return `≤${hi}`;
    return '';
  };
  const add = (label: string, lo?: number, hi?: number) => {
    const v = fmt(lo, hi);
    if (v) parts.push(`${label} ${v}`);
  };
  add('BPM', filters.bpmMin, filters.bpmMax);
  add('AR', filters.arMin, filters.arMax);
  add('CS', filters.csMin, filters.csMax);
  add('OD', filters.odMin, filters.odMax);
  add('HP', filters.hpMin, filters.hpMax);
  add('星数', filters.starMin, filters.starMax);
  add('时长', filters.lengthMin, filters.lengthMax);
  add('同分段人数', filters.similarMin, filters.similarMax);
  if (filters.playable) parts.push('能打的范围');
  if (filters.forbidMods?.length) parts.push(`不带 ${filters.forbidMods.join('')}`);
  if (filters.preferMods?.length) parts.push(`偏好 ${filters.preferMods.join('')}`);
  return parts.join('，');
}

const FILTER_HINT_RE =
  /\d+\s*(bpm|星|秒|分|分钟)|(bpm|ar|cs|od|hp|star|mod|dt|hd|hr|nc|ht|ez|fl)\b|(星数|难度|难|简单|容易|轻松|低星|高星|时长|长度|读图|速度|同分段|同段|热度|热门|冷门|多人|少人|能打|打得动|玩得动|[<>≤≥])/i;

const TRANSLATOR_SYSTEM = [
  '你是 osu! 谱面推荐筛选翻译器。把玩家对谱面的限制翻译成一行规范语句，格式：',
  'recommend 条件1 条件2 ...',
  '支持字段：bpm、ar（读图速度 0-11）、cs、od、hp、star（星数）、length（时长，秒）、similar（同分段玩家数，热度）。',
  '区间写法：9<ar<10.3、160<bpm<200；单边写法：bpm<=180、ar>=9、star>=6。',
  'similar 写法：similar>=10（同分段超过 10 人在打）、similar<=5（冷门一点）。',
  '玩家说“能打/打得动/别太难/符合水平”时输出 playable（引擎会按该玩家 Top 星数收紧上限，不要再猜具体星数）。',
  '中文说法也支持：180以下/不超过180=bpm<=180；9以上=ar>=9；“难/高星/低星/简单/轻松”等按星数翻译成合理区间（如 star<=5、star>=7）。',
  'Mod 偏好写法：no_dt（不要 DT）、no_hr、prefer_dt、prefer_hdhr。',
  '规则：',
  '- 玩家没提到的字段一律不出现；',
  '- 过滤依据是带 Mod 后的实际数值（例如 DT 后 BPM 会变快、AR 会变高），你只需要忠实翻译用户意图；',
  '- 只输出这一行，不要解释、不要换行、不要 JSON；',
  '- 玩家条件矛盾或无法理解时，只输出 INVALID：简短原因。',
].join('\n');

export async function translateRecommendFilters(
  text: string,
  db: any,
): Promise<{
  ok: boolean;
  filters: RecommendFilters;
  statement: string;
  usedLlm: boolean;
  reason?: string;
}> {
  const userText = String(text || '').trim();
  if (!FILTER_HINT_RE.test(userText)) {
    return { ok: true, filters: {}, statement: '', usedLlm: false };
  }

  let result;
  try {
    result = await completeChat(db, {
      model: OSU_FILTER_MODEL,
      messages: [
        { role: 'system', content: TRANSLATOR_SYSTEM },
        { role: 'user', content: userText },
      ],
      temperature: 0,
      maxTokens: 240,
      timeoutMs: 20_000,
      requestMaxRetries: 1,
      label: '推荐筛选翻译',
    });
  } catch (error) {
    return {
      ok: false,
      filters: {},
      statement: '',
      usedLlm: true,
      reason: `筛选翻译服务暂时不可用：${String((error as Error)?.message || error)}`,
    };
  }

  const statement = normalizeStatement(String(result?.text || ''));
  if (!statement) {
    return { ok: false, filters: {}, statement: '', usedLlm: true, reason: '筛选翻译返回为空' };
  }
  const parsed = parseRecommendStatement(statement);
  if (!parsed.ok) {
    return { ok: false, filters: {}, statement, usedLlm: true, reason: parsed.reason };
  }
  return { ok: true, filters: parsed.filters, statement, usedLlm: true };
}
