// Player skill memory: extract, store, and retrieve osu! player assessments.
import type { PlayerSkillRecord } from './types.js';
import { readDb, updateDb, nowIso } from '../store.js';

const CURRENT_VERSION = 2;
const DEFAULT_MODE = 'osu';
const DEFAULT_CONTEXT_LIMIT = 3;

const MODE_ALIASES: Record<string, string> = {
  std: 'osu',
  standard: 'osu',
  osu: 'osu',
  taiko: 'taiko',
  catch: 'fruits',
  ctb: 'fruits',
  fruits: 'fruits',
  mania: 'mania',
};

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactText(value: unknown, maxLength = 240): string {
  const text = String(value || '')
    .replace(/^【结论】\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function normalizeSkillMode(mode: unknown): string {
  const key = String(mode || DEFAULT_MODE).trim().toLowerCase();
  return MODE_ALIASES[key] || key || DEFAULT_MODE;
}

/**
 * A skill record represents an osu! account in one ruleset. QQ is deliberately
 * not part of this key: it is a lookup alias and may be unknown or rebound.
 */
export function skillRecordKey(
  record: Pick<PlayerSkillRecord, 'osuUserId' | 'osuUsername' | 'mode'>
): string {
  const osuUserId = finiteNumber(record.osuUserId);
  const account = osuUserId > 0
    ? String(Math.trunc(osuUserId))
    : `name:${String(record.osuUsername || '').trim().toLowerCase()}`;
  return `${account}:${normalizeSkillMode(record.mode)}`;
}

function normalizedRecord(record: PlayerSkillRecord): PlayerSkillRecord {
  const mode = normalizeSkillMode(record.mode);
  const modComposition: Record<string, number> = Object.fromEntries(
    Object.entries(record.modComposition || {})
      .map(([label, count]) => [
        String(label || 'NM').toUpperCase(),
        Math.max(0, Math.trunc(finiteNumber(count))),
      ] as [string, number])
      .filter(([, count]) => Number(count) > 0)
  );
  const topMods = Array.isArray(record.topMods) && record.topMods.length > 0
    ? record.topMods.map(value => String(value).toUpperCase())
    : Object.entries(modComposition)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([label]) => label);

  const normalized: PlayerSkillRecord = {
    ...record,
    recordKey: skillRecordKey({ ...record, mode }),
    userId: String(record.userId || '').trim(),
    osuUsername: String(record.osuUsername || '').trim(),
    osuUserId: Math.trunc(finiteNumber(record.osuUserId)),
    mode,
    pp: finiteNumber(record.pp),
    rank: Math.max(0, Math.trunc(finiteNumber(record.rank))),
    countryRank: record.countryRank === undefined
      ? undefined
      : Math.max(0, Math.trunc(finiteNumber(record.countryRank))),
    accuracy: finiteNumber(record.accuracy),
    playCount: Math.max(0, Math.trunc(finiteNumber(record.playCount))),
    hoursPlayed: Math.max(0, finiteNumber(record.hoursPlayed)),
    level: Math.max(0, finiteNumber(record.level)),
    ppPlus: record.ppPlus
      ? Object.fromEntries(Object.entries(record.ppPlus).map(([key, value]) => [key, finiteNumber(value)]))
      : undefined,
    modComposition: Object.keys(modComposition).length > 0 ? modComposition : undefined,
    topMods: topMods.length > 0 ? topMods : undefined,
    summary: compactText(record.summary),
    recentSummary: record.recentSummary ? compactText(record.recentSummary, 220) : undefined,
    lastAnalyzed: String(record.lastAnalyzed || nowIso()),
    version: Math.max(CURRENT_VERSION, Math.trunc(finiteNumber(record.version))),
  };
  return normalized;
}

function recordTimestamp(record: PlayerSkillRecord): number {
  const full = new Date(record.lastAnalyzed || 0).getTime();
  const recent = new Date(record.lastRecentAnalyzed || 0).getTime();
  return Math.max(Number.isFinite(full) ? full : 0, Number.isFinite(recent) ? recent : 0);
}

function mergeRecords(existing: PlayerSkillRecord, incoming: PlayerSkillRecord): PlayerSkillRecord {
  const normalizedExisting = normalizedRecord(existing);
  const normalizedIncoming = normalizedRecord(incoming);
  return normalizedRecord({
    ...normalizedExisting,
    ...normalizedIncoming,
    // An analysis of an unbound username must not erase a known QQ binding.
    userId: normalizedIncoming.userId || normalizedExisting.userId,
    // Full analysis updates do not implicitly erase the latest Recent summary.
    recentSummary: normalizedIncoming.recentSummary ?? normalizedExisting.recentSummary,
    lastRecentAnalyzed: normalizedIncoming.lastRecentAnalyzed ?? normalizedExisting.lastRecentAnalyzed,
  });
}

function normalizedUniqueRecords(records: PlayerSkillRecord[]): PlayerSkillRecord[] {
  const unique = new Map<string, PlayerSkillRecord>();
  for (const raw of records || []) {
    const current = normalizedRecord(raw);
    const key = current.recordKey!;
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, current);
      continue;
    }
    // Legacy stores could contain duplicates. Let the newer full analysis win
    // while preserving QQ/Recent data from the other copy.
    const newer = recordTimestamp(current) >= recordTimestamp(previous) ? current : previous;
    const older = newer === current ? previous : current;
    unique.set(key, mergeRecords(older, newer));
  }
  return [...unique.values()];
}

// ── Extract a skill record from analysis results ──

export function extractSkillRecord(params: {
  userId?: string;
  osuUsername: string;
  osuUserId: number;
  mode: string;
  pp: number;
  rank: number;
  countryRank?: number;
  accuracy: number;
  playCount: number;
  /** Prefer the raw osu! API play_time value so conversion is done once here. */
  playTimeSeconds?: number;
  /** Backward-compatible input for older callers. */
  hoursPlayed?: number;
  level: number;
  levelProgress?: number;
  ppPlus?: Record<string, number>;
  modComposition?: Record<string, number>;
  topMods?: string[];
  gradeCounts?: Record<string, number>;
  summary: string;
  recentSummary?: string;
}): PlayerSkillRecord {
  const hoursPlayed = params.playTimeSeconds === undefined
    ? finiteNumber(params.hoursPlayed)
    : finiteNumber(params.playTimeSeconds) / 3600;
  const level = finiteNumber(params.level) + finiteNumber(params.levelProgress) / 100;
  return normalizedRecord({
    recordKey: '',
    userId: String(params.userId || '').trim(),
    osuUsername: params.osuUsername,
    osuUserId: params.osuUserId,
    mode: params.mode,
    pp: params.pp,
    rank: params.rank,
    countryRank: params.countryRank,
    accuracy: params.accuracy,
    playCount: params.playCount,
    hoursPlayed,
    level,
    ppPlus: params.ppPlus,
    modComposition: params.modComposition,
    topMods: params.topMods,
    gradeCounts: params.gradeCounts,
    summary: params.summary,
    recentSummary: params.recentSummary,
    lastAnalyzed: nowIso(),
    version: CURRENT_VERSION,
  });
}

// ── Save/update records without nesting database locks ──

export function upsertSkillRecordInDb(db: any, record: PlayerSkillRecord): PlayerSkillRecord {
  db.skillStore ||= { records: [], updatedAt: '' };
  const records = normalizedUniqueRecords(db.skillStore.records || []);
  const incoming = normalizedRecord(record);
  const index = records.findIndex(item => item.recordKey === incoming.recordKey);
  const saved = index >= 0 ? mergeRecords(records[index], incoming) : incoming;
  if (index >= 0) records[index] = saved;
  else records.push(saved);
  db.skillStore.records = records;
  db.skillStore.updatedAt = nowIso();
  return saved;
}

export function saveSkillRecord(record: PlayerSkillRecord): void {
  updateDb(db => {
    upsertSkillRecordInDb(db, record);
  });
}

export function updateRecentSkillRecordInDb(
  db: any,
  identity: {
    osuUserId?: number;
    osuUsername?: string;
    userId?: string;
    mode?: string;
  },
  recentSummary: string
): PlayerSkillRecord | undefined {
  db.skillStore ||= { records: [], updatedAt: '' };
  const records = normalizedUniqueRecords(db.skillStore.records || []);
  const mode = normalizeSkillMode(identity.mode);
  const osuUserId = Math.trunc(finiteNumber(identity.osuUserId));
  const username = String(identity.osuUsername || '').trim().toLowerCase();
  const qq = String(identity.userId || '').trim();
  const index = osuUserId > 0
    ? records.findIndex(record => record.mode === mode && record.osuUserId === osuUserId)
    : username
      ? records.findIndex(record => record.mode === mode && record.osuUsername.toLowerCase() === username)
      : records.findIndex(record => record.mode === mode && Boolean(qq) && record.userId === qq);
  if (index < 0) return undefined;

  const timestamp = nowIso();
  records[index] = normalizedRecord({
    ...records[index],
    userId: qq || records[index].userId,
    recentSummary: compactText(recentSummary, 220),
    lastRecentAnalyzed: timestamp,
  });
  db.skillStore.records = records;
  db.skillStore.updatedAt = timestamp;
  return records[index];
}

// ── QQ binding resolution ──

function bindingMatches(value: unknown, osuUserId: number, osuUsername: string): boolean {
  const key = String(value || '').trim().toLowerCase();
  return key === String(osuUserId) || Boolean(osuUsername && key === osuUsername.toLowerCase());
}

export function resolveSkillQq(params: {
  bindings?: Record<string, string | number>;
  requesterQq?: string | number;
  mentionedQqs?: Array<string | number>;
  osuUserId: number;
  osuUsername?: string;
}): string {
  const bindings = params.bindings || {};
  const preferred = [
    ...(params.mentionedQqs || []).map(String),
    String(params.requesterQq || ''),
  ].filter(Boolean);
  for (const qq of preferred) {
    if (bindingMatches(bindings[qq], params.osuUserId, String(params.osuUsername || ''))) return qq;
  }
  const reverse = Object.entries(bindings).find(([, value]) =>
    bindingMatches(value, params.osuUserId, String(params.osuUsername || ''))
  );
  return reverse?.[0] || '';
}

// ── Lookup skill records ──

function preferredModeFromText(text: string): string | undefined {
  const value = String(text || '').toLowerCase();
  if (/(?:^|\W)(?:mania|下落式)(?:$|\W)/u.test(value)) return 'mania';
  if (/(?:^|\W)(?:taiko|太鼓)(?:$|\W)/u.test(value)) return 'taiko';
  if (/(?:^|\W)(?:catch|ctb|fruits|接水果)(?:$|\W)/u.test(value)) return 'fruits';
  if (/(?:^|\W)(?:std|standard|osu!std)(?:$|\W)/u.test(value)) return 'osu';
  return undefined;
}

function sortMatches(records: PlayerSkillRecord[], preferredMode?: string): PlayerSkillRecord[] {
  const normalizedMode = preferredMode ? normalizeSkillMode(preferredMode) : undefined;
  return [...records].sort((a, b) => {
    const preferredDiff = Number(b.mode === normalizedMode) - Number(a.mode === normalizedMode);
    if (preferredDiff) return preferredDiff;
    const stdDiff = Number(b.mode === DEFAULT_MODE) - Number(a.mode === DEFAULT_MODE);
    if (stdDiff) return stdDiff;
    return recordTimestamp(b) - recordTimestamp(a);
  });
}

export function lookupSkills(identifier: string | number, mode?: string): PlayerSkillRecord[] {
  const rawKey = String(identifier ?? '').trim();
  if (!rawKey) return [];
  const explicit = rawKey.match(/^(qq|osu(?:id)?):(.+)$/i);
  const kind = explicit?.[1]?.toLowerCase();
  const key = String(explicit?.[2] || rawKey).trim();
  const lower = key.toLowerCase();
  const records = normalizedUniqueRecords(readDb().skillStore?.records || []);
  const qqMatches = records.filter(record => record.userId && record.userId === key);
  const osuMatches = records.filter(record =>
    String(record.osuUserId) === key || record.osuUsername.toLowerCase() === lower
  );
  const matches = kind === 'qq'
    ? qqMatches
    : kind?.startsWith('osu')
      ? osuMatches
      // In the rare numeric collision, QQ is the safer default for chat users.
      : (qqMatches.length > 0 ? qqMatches : osuMatches);
  return sortMatches(matches, mode)
    .filter(record => !mode || record.mode === normalizeSkillMode(mode));
}

export function lookupSkill(
  userIdOrUsernameOrOsuId: string | number,
  mode?: string
): PlayerSkillRecord | undefined {
  return lookupSkills(userIdOrUsernameOrOsuId, mode)[0];
}

export function lookupSkillByQQ(qq: string, mode?: string): PlayerSkillRecord | undefined {
  return lookupSkill(`qq:${String(qq)}`, mode);
}

export function lookupSkillByOsu(
  osuUsernameOrId: string | number,
  mode?: string
): PlayerSkillRecord | undefined {
  return lookupSkill(`osu:${String(osuUsernameOrId)}`, mode);
}

export function lookupSkillByOsuId(osuUserId: string | number, mode?: string): PlayerSkillRecord | undefined {
  const id = String(osuUserId).trim();
  if (!id) return undefined;
  return sortMatches(
    normalizedUniqueRecords(readDb().skillStore?.records || [])
      .filter(record => String(record.osuUserId) === id),
    mode
  ).find(record => !mode || record.mode === normalizeSkillMode(mode));
}

export function allSkillRecords(): PlayerSkillRecord[] {
  return sortMatches(normalizedUniqueRecords(readDb().skillStore?.records || []));
}

// ── Save skill data from an osu! API response ──

export function saveSkillFromApiData(params: {
  userId?: string;
  osuApiUser: any;
  ppPlusData?: Record<string, number>;
  mode?: string;
  summary?: string;
}): void {
  const { userId, osuApiUser, ppPlusData, mode, summary } = params;
  if (!osuApiUser?.id) return;
  const stats = osuApiUser.statistics || {};
  saveSkillRecord(extractSkillRecord({
    userId,
    osuUsername: String(osuApiUser.username || ''),
    osuUserId: Number(osuApiUser.id),
    mode: mode || DEFAULT_MODE,
    pp: Number(stats.pp || 0),
    rank: Number(stats.global_rank || stats.rank || 0),
    countryRank: Number(stats.country_rank || 0),
    accuracy: Number(stats.hit_accuracy || 0),
    playCount: Number(stats.play_count || 0),
    playTimeSeconds: Number(stats.play_time || 0),
    level: Number(stats.level?.current || 0),
    levelProgress: Number(stats.level?.progress || 0),
    ppPlus: ppPlusData,
    gradeCounts: osuApiUser.grade_counts || stats.grade_counts || {},
    summary: summary || '',
  }));
}

// ── Bounded prompt context ──

function numericTokenAppears(text: string, value: number): boolean {
  if (!(value > 0)) return false;
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(text);
}

function formatContextRecord(record: PlayerSkillRecord): string {
  const rank = record.rank > 0 ? `全球 #${record.rank.toLocaleString()}` : '未上榜';
  const ppPlusTop = record.ppPlus
    ? Object.entries(record.ppPlus)
        .filter(([key, value]) => key !== 'ppTotal' && value > 0)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([key, value]) => `${key} ${value.toFixed(1)}`)
        .join('、')
    : '';
  const mods = record.modComposition
    ? Object.entries(record.modComposition)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, count]) => `${label} ${count}`)
        .join('、')
    : record.topMods?.slice(0, 3).join('、') || '';
  const details = [
    `${record.osuUsername}（${record.mode}）`,
    `${record.pp.toLocaleString()}pp`,
    rank,
    `Acc ${record.accuracy.toFixed(2)}%`,
    ppPlusTop ? `PP+ ${ppPlusTop}` : '',
    mods ? `BP Mods ${mods}` : '',
  ].filter(Boolean).join('｜');
  const notes = [
    record.summary ? `完整档案：${compactText(record.summary, 150)}` : '',
    record.recentSummary ? `近期：${compactText(record.recentSummary, 120)}` : '',
  ].filter(Boolean).join('；');
  return `- ${details}${notes ? `\n  ${notes}` : ''}`;
}

export function relevantPlayersSkillBlock(params: {
  userId?: string | number;
  text?: string;
  mentionedQqs?: Array<string | number>;
  maxRecords?: number;
}): string {
  const all = normalizedUniqueRecords(readDb().skillStore?.records || []);
  if (all.length === 0) return '';

  const text = String(params.text || '');
  const textLower = text.toLowerCase();
  const preferredMode = preferredModeFromText(text);
  const maxRecords = Math.max(1, Math.min(6, Math.trunc(params.maxRecords || DEFAULT_CONTEXT_LIMIT)));
  const selected: PlayerSkillRecord[] = [];
  const selectedKeys = new Set<string>();

  const addIdentityMatches = (matches: PlayerSkillRecord[]) => {
    const sorted = sortMatches(matches, preferredMode);
    const best = preferredMode
      ? sorted.find(record => record.mode === preferredMode)
      : sorted[0];
    if (!best || selectedKeys.has(best.recordKey!)) return;
    selected.push(best);
    selectedKeys.add(best.recordKey!);
  };

  // Speaker first, then explicit QQ mentions, then usernames/osu IDs present in text.
  const speakerQq = String(params.userId || '').trim();
  if (speakerQq) addIdentityMatches(all.filter(record => record.userId === speakerQq));
  for (const qq of params.mentionedQqs || []) {
    const key = String(qq || '').trim();
    if (key) addIdentityMatches(all.filter(record => record.userId === key));
    if (selected.length >= maxRecords) break;
  }
  if (selected.length < maxRecords) {
    const textMatches = all.filter(record =>
      (record.osuUsername.length >= 2 && textLower.includes(record.osuUsername.toLowerCase())) ||
      numericTokenAppears(text, record.osuUserId)
    );
    const identities = new Map<string, PlayerSkillRecord[]>();
    for (const record of textMatches) {
      const key = String(record.osuUserId || record.osuUsername.toLowerCase());
      const group = identities.get(key) || [];
      group.push(record);
      identities.set(key, group);
    }
    for (const matches of identities.values()) {
      addIdentityMatches(matches);
      if (selected.length >= maxRecords) break;
    }
  }

  if (selected.length === 0) return '';
  const lines = [
    '',
    '【与当前对话相关的 osu! 技能记忆】',
    ...selected.slice(0, maxRecords).map(formatContextRecord),
    '这些是旧分析留下的有限记忆。只在当前话题相关时自然使用，不要逐项背诵。',
  ];
  return lines.join('\n');
}

export function casualSkillBlock(userId: string): string {
  return relevantPlayersSkillBlock({ userId, maxRecords: 1 });
}

/**
 * Legacy export kept for callers outside the main prompt path. It is bounded
 * by design and should not be injected into every group message.
 */
export function allPlayersSkillBlock(maxRecords = 6): string {
  const records = allSkillRecords().slice(0, Math.max(1, Math.min(6, maxRecords)));
  if (records.length === 0) return '';
  return [
    '',
    '【近期分析过的 osu! 玩家（有界）】',
    ...records.map(formatContextRecord),
    '仅在相关时使用；需要其他玩家时调用技能查询工具。',
  ].join('\n');
}
