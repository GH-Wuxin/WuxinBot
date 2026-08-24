// Image rendering via the yumu-image WebSocket protocol.
// Converts osu! API v2 objects into the field names consumed by yumu-image.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getBeatmapAttributes, getBeatmap } from '../osu/api.js';
import type { OsuMode } from '../osu/types.js';
import { detectRenderedImageType, getRenderServer, renderPanel } from './renderServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDER_OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'data', 'yumu-renders');
// Rendered BP lists are cached per score signature so repeated "!bs 1-100"
// style queries answer instantly without re-running enrichment/rendering.
const RENDER_CACHE_TTL_MS = 30 * 60_000;
const renderedPanelCache = new Map<string, { at: number; cqCode: string }>();
const MAX_SAVED_RENDERS = 512;
const MAX_SAVED_RENDER_BYTES = 512 * 1024 * 1024;
const MAX_RENDER_AGE_MS = 7 * 24 * 3600_000;
const SAVED_RENDER_PATTERN = /^(?:info|score|bp|skill)-\d{13}(?:-[0-9a-f]{8})?\.(?:jpe?g|png|webp)$/i;
// Keep some headroom below renderServer.ts's hard 128 KiB limit so a slightly
// larger score list still renders instead of silently degrading to text.
const RENDER_PAYLOAD_SAFE_BYTES = 120 * 1024;
// Hard ceiling for a single render task. Mirrors renderServer.ts's transport
// limit (4 MiB) so the failure message is consistent.
const MAX_RENDER_PAYLOAD_BYTES = 4 * 1024 * 1024;
// Fields consumed only by profile-style panels (D0/D2/D…) that this project
// does not render. They can be pruned when a multi-score payload runs large.
const PANEL_IRRELEVANT_USER_FIELDS = [
  'user_achievements',
  'monthly_playcounts',
  'replays_watched_counts',
  'matchmaking_stats',
  'daily_challenge_user_stats',
  'account_history',
  'team'
] as const;

/** Run async work with a bounded concurrency to avoid API rate-limit bursts. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function ensureOutputDir(): void {
  if (!existsSync(RENDER_OUTPUT_DIR)) mkdirSync(RENDER_OUTPUT_DIR, { recursive: true });
}

function finiteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function modeName(value: unknown): OsuMode {
  const normalized = String(value || 'osu').toLowerCase();
  if (normalized === 'standard') return 'osu';
  if (normalized === 'catch') return 'fruits';
  if (normalized === 'taiko' || normalized === 'fruits' || normalized === 'mania') return normalized;
  return 'osu';
}

function rulesetId(mode: OsuMode): number {
  return { osu: 0, taiko: 1, fruits: 2, mania: 3 }[mode];
}

function modAcronyms(mods: unknown): string[] {
  if (!Array.isArray(mods)) return [];
  return [...new Set(mods.map((mod) => {
    if (typeof mod === 'string') return mod.toUpperCase();
    if (mod && typeof mod === 'object') return String((mod as Record<string, unknown>).acronym || '').toUpperCase();
    return '';
  }).filter((mod) => mod && mod !== 'NM'))];
}

function yumuMods(mods: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(mods)) return [];
  return mods.map((mod): Record<string, unknown> | null => {
    if (typeof mod === 'string') {
      const acronym = mod.toUpperCase();
      return acronym && acronym !== 'NM' ? { acronym } : null;
    }
    if (!mod || typeof mod !== 'object') return null;
    const source = mod as Record<string, unknown>;
    const acronym = String(source.acronym || '').toUpperCase();
    return acronym && acronym !== 'NM' ? { ...source, acronym } : null;
  }).filter((mod): mod is Record<string, unknown> => mod !== null);
}

function normalizeStatistics(raw: unknown): Record<string, number> {
  const statistics = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    perfect: finiteNumber(statistics.perfect, statistics.count_geki),
    great: finiteNumber(statistics.great, statistics.count_300),
    good: finiteNumber(statistics.good, statistics.count_katsu),
    ok: finiteNumber(statistics.ok, statistics.count_100),
    meh: finiteNumber(statistics.meh, statistics.count_50),
    miss: finiteNumber(statistics.miss, statistics.count_miss),
    ignore_hit: finiteNumber(statistics.ignore_hit),
    ignore_miss: finiteNumber(statistics.ignore_miss),
    large_tick_hit: finiteNumber(statistics.large_tick_hit),
    large_tick_miss: finiteNumber(statistics.large_tick_miss),
    small_tick_hit: finiteNumber(statistics.small_tick_hit),
    small_tick_miss: finiteNumber(statistics.small_tick_miss),
    slider_tail_hit: finiteNumber(statistics.slider_tail_hit),
    large_bonus: finiteNumber(statistics.large_bonus),
    small_bonus: finiteNumber(statistics.small_bonus)
  };
}

function maximumStatistics(apiScore: any, beatmap: any, actual: Record<string, number>): Record<string, number> {
  const supplied = normalizeStatistics(apiScore?.maximum_statistics);
  const hitObjects = finiteNumber(beatmap?.count_circles)
    + finiteNumber(beatmap?.count_sliders)
    + finiteNumber(beatmap?.count_spinners);

  const maximum: Record<string, number> = {};
  for (const key of Object.keys(actual)) maximum[key] = Math.max(actual[key], supplied[key] || 0);
  // Legacy osu!std scores only expose count_300/count_100/count_50/count_miss.
  // The maximum number of 300s is the number of hit objects in the beatmap.
  if (modeName(apiScore?.mode) === 'osu' && hitObjects > 0) {
    maximum.great = Math.max(maximum.great, hitObjects);
  }
  return maximum;
}

// ── osu! API user → yumu-image user ──

export function buildYumuUser(
  apiUser: any,
  opts: { panelCompact?: boolean } = {}
): Record<string, unknown> {
  const source = apiUser || {};
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    // osu! API returns the player's raw profile-page HTML in `page`; no yumu
    // panel consumes it and it can exceed 80 KiB, which alone can blow the
    // renderer request limit on multi-score payloads.
    if (key === 'page') continue;
    if (opts.panelCompact && (PANEL_IRRELEVANT_USER_FIELDS as readonly string[]).includes(key)) {
      continue;
    }
    profile[key] = value;
  }
  const stats = (profile as any).statistics || {};
  const levelCurrent = finiteNumber(stats.level?.current, stats.level_current);
  const levelProgress = finiteNumber(stats.level?.progress, stats.level_progress);
  const countryCode = String(apiUser?.country?.code || apiUser?.country_code || '');
  const pp = finiteNumber(stats.pp, apiUser?.pp);
  const globalRank = finiteNumber(stats.global_rank, stats.rank, apiUser?.global_rank);
  const countryRank = finiteNumber(stats.country_rank, apiUser?.country_rank);
  const hitAccuracy = finiteNumber(stats.hit_accuracy, apiUser?.accuracy);
  const directPlayTime = finiteNumber(stats.play_time, apiUser?.play_time);
  const playTime = directPlayTime > 0
    ? directPlayTime
    : finiteNumber(stats.total_hours_played, apiUser?.total_hours_played) * 3600;
  const rankHistory = apiUser?.rank_history || stats.rank_history || null;
  const gradeCounts = stats.grade_counts || {};

  return {
    ...profile,
    id: finiteNumber(apiUser?.id),
    username: String(apiUser?.username || ''),
    avatar_url: String(apiUser?.avatar_url || ''),
    country: {
      ...(apiUser?.country || {}),
      code: countryCode,
      name: String(apiUser?.country?.name || '')
    },
    country_code: countryCode,
    cover_url: String(apiUser?.cover_url || apiUser?.cover?.url || ''),
    is_online: Boolean(apiUser?.is_online),
    is_supporter: Boolean(apiUser?.is_supporter),
    playstyle: Array.isArray(apiUser?.playstyle) ? apiUser.playstyle : [],
    join_date: apiUser?.join_date || null,
    follower_count: finiteNumber(apiUser?.follower_count),
    rank_history: rankHistory,
    // panel_Gamma consumes flattened fields.
    pp,
    global_rank: globalRank,
    country_rank: countryRank,
    accuracy: hitAccuracy,
    play_count: finiteNumber(stats.play_count, apiUser?.play_count),
    play_time: playTime,
    total_hits: finiteNumber(stats.total_hits, apiUser?.total_hits),
    level_current: levelCurrent,
    level_progress: levelProgress,
    // Other panels consume the official nested statistics object, but yumu's
    // current schema uses level_current/level_progress rather than level:{}.
    statistics: {
      ...stats,
      pp,
      global_rank: globalRank,
      country_rank: countryRank,
      hit_accuracy: hitAccuracy,
      play_count: finiteNumber(stats.play_count, apiUser?.play_count),
      play_time: playTime,
      total_hits: finiteNumber(stats.total_hits, apiUser?.total_hits),
      maximum_combo: finiteNumber(stats.maximum_combo),
      level_current: levelCurrent,
      level_progress: levelProgress,
      level: { current: levelCurrent, progress: levelProgress },
      grade_counts: gradeCounts,
      // yumu's ranks components (D2/D3) read flattened count_* fields instead
      // of the osu! API's nested grade_counts object.
      count_ssh: finiteNumber(gradeCounts.ssh),
      count_ss: finiteNumber(gradeCounts.ss),
      count_sh: finiteNumber(gradeCounts.sh),
      count_s: finiteNumber(gradeCounts.s),
      count_a: finiteNumber(gradeCounts.a),
      rank_history: rankHistory,
      total_score: finiteNumber(stats.total_score),
      ranked_score: finiteNumber(stats.ranked_score),
      replays_watched_by_others: finiteNumber(stats.replays_watched_by_others, stats.replays_watched)
    }
  };
}

const DAY_MS = 86_400_000;

function dayNumber(year: number, month: number, date: number): number {
  return Math.floor(Date.UTC(year, month, date) / DAY_MS);
}

function dayAtOffset(ms: number, offsetHours: number): number {
  const shifted = new Date(ms + offsetHours * 3600_000);
  return dayNumber(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
}

function formatMonthDay(day: number): string {
  const date = new Date(day * DAY_MS);
  return `${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function formatShortYear(year: number): string {
  return String(year % 100).padStart(2, '0');
}

function scoreTimestampMs(score: unknown): number | null {
  const raw = (score as any)?.ended_at || (score as any)?.created_at;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * D3 "BP" heat matrix (best_arr). Mirrors yumu-bot's InfoService.BestsArray:
 * 91 days ending at this week's Sunday, filtered by UTC+8 local date and
 * grouped by UTC date, newest day last.
 */
function buildBestsArray(scores: readonly unknown[]): {
  count: number[];
  max: number;
  time: string;
  week0: string;
  week4: string;
  week8: string;
} {
  const now = new Date();
  const today = dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfWeek = today + ((7 - now.getDay()) % 7);
  const start = endOfWeek - 90;

  const counts = new Map<number, number>();
  for (const score of scores) {
    const ms = scoreTimestampMs(score);
    if (ms == null) continue;
    const localDay = dayAtOffset(ms, 8);
    if (localDay > start && localDay <= endOfWeek) {
      const groupedDay = dayAtOffset(ms, 0);
      counts.set(groupedDay, (counts.get(groupedDay) || 0) + 1);
    }
  }

  const count: number[] = [];
  let max = 0;
  let maxDay = 0;
  for (let day = start; day <= endOfWeek; day++) {
    const value = counts.get(day) || 0;
    count.push(value);
    if (value > max) {
      max = value;
      maxDay = day;
    }
  }

  return {
    count,
    max,
    time: max > 0 ? formatMonthDay(maxDay) : '-',
    week0: formatMonthDay(endOfWeek),
    week4: formatMonthDay(endOfWeek - 28),
    week8: formatMonthDay(endOfWeek - 56),
  };
}

/**
 * D3 "PC" heat matrix (playcount_arr). Mirrors yumu-bot's
 * InfoService.PlaycountsArray: monthly playcounts from three years plus the
 * current quarter back to this December.
 */
function buildPlaycountsArray(monthlies: unknown): {
  count: number[];
  max: number;
  time: string;
  year0: string;
  year1: string;
  year2: string;
  year3: string;
  quarter: number;
} {
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  const quarter = Math.floor((thisMonth - 1) / 3) + 1;
  const latest = { year: thisYear, month: 12 };
  const start = { year: thisYear - 3, month: quarter * 3 - 2 };

  const months = new Map<string, number>();
  if (Array.isArray(monthlies)) {
    for (const item of monthlies) {
      const startDate = String((item as any)?.start_date || '');
      const match = /^(\d{4})-(\d{2})/.exec(startDate);
      if (match) {
        months.set(
          `${Number(match[1])}-${Number(match[2])}`,
          Number((item as any)?.count) || 0,
        );
      }
    }
  }

  const count: number[] = [];
  let max = 0;
  let maxMonth = '';
  let year = start.year;
  let month = start.month;
  while (year < latest.year || (year === latest.year && month <= latest.month)) {
    const key = `${year}-${month}`;
    const value = months.get(key) || 0;
    count.push(value);
    if (value > max) {
      max = value;
      maxMonth = key;
    }
    if (month === 12) {
      year++;
      month = 1;
    } else {
      month++;
    }
  }

  return {
    count,
    max,
    time: max > 0 ? maxMonth : '-',
    year0: formatShortYear(thisYear),
    year1: formatShortYear(thisYear - 1),
    year2: formatShortYear(thisYear - 2),
    year3: formatShortYear(thisYear - 3),
    quarter,
  };
}

interface RankingInterval {
  start: number;
  end: number;
  improvement: number;
  length: number;
}

/**
 * D3 ranking chart payload (ranking_arr). Mirrors yumu-bot's
 * InfoService.RankingArray including its improvement-interval scan.
 */
export function buildRankingArray(rankHistory: unknown): {
  ranking: number[];
  statistics: {
    intervals: RankingInterval[];
    top: number;
    bottom: number;
    improvement: number;
  };
} {
  const raw = Array.isArray((rankHistory as any)?.data)
    ? ((rankHistory as any).data as unknown[]).map((value) => Number(value))
    : [];
  const ranking = raw.filter((value) => Number.isFinite(value));
  const padded = [...ranking];
  while (padded.length < 90) padded.unshift(0);

  const intervals: RankingInterval[] = [];
  let startIndex = -1;
  let currentImprovement = 0;
  let lastValidRank: number | null = null;

  for (let i = 0; i < padded.length; i++) {
    const currentRank = padded[i];
    if (currentRank === 0) {
      if (startIndex !== -1) {
        const endIndex = i - 1;
        const intervalLength = endIndex - startIndex + 1;
        if (intervalLength >= 1) {
          intervals.push({
            start: startIndex,
            end: endIndex,
            improvement: currentImprovement,
            length: intervalLength,
          });
        }
        startIndex = -1;
        currentImprovement = 0;
      }
      lastValidRank = null;
      continue;
    }

    if (lastValidRank != null && currentRank < lastValidRank) {
      if (startIndex === -1) startIndex = i - 1;
      currentImprovement += lastValidRank - currentRank;
    } else if (startIndex !== -1) {
      const endIndex = i - 1;
      const intervalLength = endIndex - startIndex + 1;
      if (intervalLength >= 1) {
        intervals.push({
          start: startIndex,
          end: endIndex,
          improvement: currentImprovement,
          length: intervalLength,
        });
      }
      startIndex = -1;
      currentImprovement = 0;
    }
    lastValidRank = currentRank;
  }

  if (startIndex !== -1) {
    const endIndex = padded.length - 1;
    const intervalLength = endIndex - startIndex + 1;
    if (intervalLength >= 1) {
      intervals.push({
        start: startIndex,
        end: endIndex,
        improvement: currentImprovement,
        length: intervalLength,
      });
    }
  }

  const nonZero = padded.filter((value) => value > 0);
  const top = nonZero.length > 0 ? Math.min(...nonZero) : 0;
  const bottom = nonZero.length > 0 ? Math.max(...nonZero) : 0;
  const improvement = intervals.reduce((sum, interval) => sum + interval.improvement, 0);

  return {
    ranking,
    statistics: { intervals, top, bottom, improvement },
  };
}

/**
 * D3 "highest rank" block. Mirrors yumu-bot's InfoService.HighestRanking.
 */
function buildHighestRank(apiUser: any): { rank: number; time: string } {
  const highest = apiUser?.rank_highest;
  if (highest && Number(highest.rank) > 0 && highest.updated_at) {
    return { rank: Number(highest.rank), time: String(highest.updated_at) };
  }

  const ranks = Array.isArray(apiUser?.rank_history?.data)
    ? (apiUser.rank_history.data as unknown[]).map(Number)
    : [];
  if (ranks.length > 0) {
    const padded = [...ranks];
    while (padded.length < 90) padded.unshift(0);
    const minRank = Math.min(...padded);
    const index = padded.indexOf(minRank);
    return {
      rank: minRank,
      time: new Date(Date.now() - (89 - index) * DAY_MS).toISOString(),
    };
  }

  const globalRank = Number(apiUser?.statistics?.global_rank || apiUser?.global_rank || 0);
  return {
    rank: globalRank > 0 ? globalRank : -1,
    time: new Date().toISOString(),
  };
}

/**
 * Bonus pp, mirroring yumu-bot's DataUtil.getBonusPP(bests, user.pp).
 */
function buildBonusPp(scores: readonly unknown[], apiUser: any): number {
  let bestPP = 0;
  for (const score of scores) {
    bestPP += Number((score as any)?.weight?.pp) || 0;
  }
  const userPP = Number(apiUser?.statistics?.pp || apiUser?.pp || 0);
  const maxBonusPP = (417 - 1 / 3) * (1 - Math.pow(0.995, 1000));
  return Math.min(Math.max(userPP - bestPP, 0), maxBonusPP);
}

/**
 * Build the exact payload consumed by yumu-image's panel_D3, matching
 * yumu-bot's InfoService v3 (`/i` / 玩家信息). apiScores should already be
 * star-enriched so the top-six BP cards show modded star ratings.
 */
export async function buildYumuInfoPayload(
  apiUser: any,
  apiScores: readonly unknown[],
): Promise<Record<string, unknown>> {
  const user = {
    ...buildYumuUser(apiUser),
    mode: 'osu',
    user_achievements_count: Number((apiUser as any)?.user_achievements?.length || 0),
    beatmap_playcounts_count: Number((apiUser as any)?.beatmap_playcounts_count || 0),
    matchmaking_stats: (apiUser as any)?.matchmaking_stats || [],
  };
  const bests = await mapLimit(
    apiScores.slice(0, 6),
    6,
    (score) => buildYumuScore(score, apiUser),
  );

  return {
    user,
    bests,
    best_arr: buildBestsArray(apiScores),
    playcount_arr: buildPlaycountsArray((apiUser as any)?.monthly_playcounts),
    ranking_arr: buildRankingArray(apiUser?.rank_history),
    highest_rank: buildHighestRank(apiUser),
    percentiles: {},
    history_day: 0,
    history_user: null,
    bonus_pp: buildBonusPp(apiScores, apiUser),
  };
}

/**
 * osu! score responses carry a MicroUser, not another full user profile.
 * Keeping this object small is also essential for multi-BP panels: repeating
 * a full `/users/{id}` response ten times exceeds the renderer request limit.
 */
function buildYumuMicroUser(apiUser: any): Record<string, unknown> {
  const countryCode = String(apiUser?.country?.code || apiUser?.country_code || '');
  return {
    id: finiteNumber(apiUser?.id, apiUser?.user_id),
    user_id: finiteNumber(apiUser?.user_id, apiUser?.id),
    username: String(apiUser?.username || ''),
    avatar_url: String(apiUser?.avatar_url || ''),
    country_code: countryCode,
    country: {
      ...(apiUser?.country || {}),
      code: countryCode,
      name: String(apiUser?.country?.name || '')
    },
    is_supporter: Boolean(apiUser?.is_supporter),
    default_group: apiUser?.default_group || ''
  };
}

async function resolveModdedStarRating(apiScore: any): Promise<number> {
  const enriched = finiteNumber(
    apiScore?.star_rating_source === 'modded' ? apiScore?.modded_star_rating : undefined,
    apiScore?.attributes?.stars,
    apiScore?.attributes?.star_rating,
    apiScore?.difficulty_attributes?.star_rating
  );
  if (enriched > 0) return enriched;

  const beatmap = apiScore?.beatmap || {};
  const beatmapId = finiteNumber(apiScore?.beatmap_id, beatmap?.id);
  const mods = modAcronyms(apiScore?.mods);
  const baseStars = finiteNumber(beatmap?.difficulty_rating);

  // The executor already tried official attributes for this score and marked
  // it unavailable. Re-hitting the API at render time only risks 429 bursts
  // and would drop the whole panel; fall back to the base star rating.
  if (String(apiScore?.star_rating_source) === 'unavailable') {
    return baseStars;
  }
  if (beatmapId <= 0) return baseStars;
  if (mods.length === 0 && baseStars > 0) return baseStars;

  try {
    const response = await getBeatmapAttributes(beatmapId, modeName(apiScore?.mode), mods);
    const starRating = finiteNumber(response?.attributes?.star_rating);
    if (starRating > 0) return starRating;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[render] Mod 星数获取失败，使用基础星数：${detail}`);
    return baseStars;
  }
  return baseStars;
}

// ── osu! API score → yumu-image score ──

export async function buildYumuScore(apiScore: any, apiUser: any): Promise<Record<string, any>> {
  const beatmap = apiScore?.beatmap || {};
  const beatmapset = apiScore?.beatmapset || beatmap?.beatmapset || {};
  const mode = modeName(apiScore?.mode || beatmap?.mode);
  const statistics = normalizeStatistics(apiScore?.statistics);
  const moddedStars = await resolveModdedStarRating(apiScore);
  const rank = String(apiScore?.rank || 'F');
  const endedAt = apiScore?.ended_at || apiScore?.created_at || new Date().toISOString();
  const scoreId = finiteNumber(apiScore?.id, apiScore?.best_id);
  const totalScore = finiteNumber(apiScore?.total_score, apiScore?.score);
  const isLazer = Boolean(apiScore?.is_lazer ?? (finiteNumber(apiScore?.build_id) > 0));

  const yumuBeatmapset = {
    ...beatmapset,
    id: finiteNumber(beatmapset?.id, beatmap?.beatmapset_id),
    title: String(beatmapset?.title || ''),
    title_unicode: String(beatmapset?.title_unicode || beatmapset?.title || ''),
    artist: String(beatmapset?.artist || ''),
    artist_unicode: String(beatmapset?.artist_unicode || beatmapset?.artist || ''),
    creator: String(beatmapset?.creator || ''),
    covers: beatmapset?.covers || {},
    status: beatmapset?.status || beatmap?.status || '',
    ranked: beatmapset?.ranked ?? beatmap?.ranked ?? beatmapset?.status ?? beatmap?.status ?? ''
  };

  // The osu! API v2 /scores/best endpoint returns a stripped beatmap object
  // that often omits max_combo, ar, od, cs, hp, etc.  Fetch the full beatmap
  // when key fields are missing so the panel shows complete data.
  let fullBeatmap = beatmap;
  const beatmapId = finiteNumber(beatmap?.id, apiScore?.beatmap_id);
  if (beatmapId > 0 && (finiteNumber(beatmap?.max_combo) <= 0 || finiteNumber(beatmap?.ar) <= 0)) {
    try {
      fullBeatmap = await getBeatmap(beatmapId);
    } catch {
      // panel will still render, just without the enriched fields
    }
  }

  const yumuBeatmap = {
    ...fullBeatmap,
    id: beatmapId,
    beatmapset_id: finiteNumber(fullBeatmap?.beatmapset_id, yumuBeatmapset.id),
    mode,
    mode_int: finiteNumber(fullBeatmap?.mode_int, rulesetId(mode)),
    difficulty_rating: moddedStars,
    original_rating: finiteNumber(fullBeatmap?.difficulty_rating),
    ar: finiteNumber(fullBeatmap?.ar, beatmap?.ar),
    od: finiteNumber(fullBeatmap?.od, fullBeatmap?.accuracy, beatmap?.od, beatmap?.accuracy),
    accuracy: finiteNumber(fullBeatmap?.accuracy, fullBeatmap?.od, beatmap?.accuracy, beatmap?.od),
    cs: finiteNumber(fullBeatmap?.cs, beatmap?.cs),
    hp: finiteNumber(fullBeatmap?.drain, fullBeatmap?.hp, beatmap?.drain, beatmap?.hp),
    drain: finiteNumber(fullBeatmap?.drain, fullBeatmap?.hp, beatmap?.drain, beatmap?.hp),
    bpm: finiteNumber(fullBeatmap?.bpm, beatmapset?.bpm, beatmap?.bpm),
    version: String(fullBeatmap?.version || beatmap?.version || ''),
    total_length: finiteNumber(fullBeatmap?.total_length, beatmap?.total_length),
    hit_length: finiteNumber(fullBeatmap?.hit_length, beatmap?.hit_length),
    max_combo: finiteNumber(fullBeatmap?.max_combo, beatmap?.max_combo),
    count_circles: finiteNumber(fullBeatmap?.count_circles, beatmap?.count_circles),
    count_sliders: finiteNumber(fullBeatmap?.count_sliders, beatmap?.count_sliders),
    count_spinners: finiteNumber(fullBeatmap?.count_spinners, beatmap?.count_spinners),
    status: fullBeatmap?.status || beatmap?.status || beatmapset?.status || '',
    ranked: fullBeatmap?.ranked ?? fullBeatmap?.status ?? beatmap?.ranked ?? beatmap?.status ?? beatmapset?.ranked ?? beatmapset?.status ?? '',
    beatmapset: yumuBeatmapset
  };

  return {
    ...apiScore,
    id: scoreId,
    best_id: finiteNumber(apiScore?.best_id, scoreId),
    user_id: finiteNumber(apiScore?.user_id, apiUser?.id),
    mods: yumuMods(apiScore?.mods),
    mode,
    ruleset_id: finiteNumber(apiScore?.ruleset_id, rulesetId(mode)),
    pp: finiteNumber(apiScore?.pp),
    accuracy: finiteNumber(apiScore?.accuracy, apiScore?.legacy_accuracy),
    legacy_accuracy: finiteNumber(apiScore?.legacy_accuracy, apiScore?.accuracy),
    max_combo: finiteNumber(apiScore?.max_combo),
    total_score: totalScore,
    legacy_total_score: finiteNumber(apiScore?.legacy_total_score, apiScore?.score, totalScore),
    classic_total_score: finiteNumber(apiScore?.classic_total_score, apiScore?.score, totalScore),
    passed: apiScore?.passed !== false,
    rank,
    legacy_rank: String(apiScore?.legacy_rank || rank),
    ended_at: endedAt,
    created_at: apiScore?.created_at || endedAt,
    beatmap_id: yumuBeatmap.id,
    beatmapset_id: yumuBeatmapset.id,
    statistics,
    maximum_statistics: maximumStatistics(apiScore, beatmap, statistics),
    user: buildYumuMicroUser(apiUser),
    beatmap: yumuBeatmap,
    beatmapset: yumuBeatmapset,
    is_lazer: isLazer,
    is_perfect_combo: Boolean(apiScore?.is_perfect_combo ?? apiScore?.perfect),
    legacy_perfect: Boolean(apiScore?.legacy_perfect ?? apiScore?.perfect)
  };
}

export interface YumuBestScoresOptions {
  /** BP position of the first score when a range other than BP1 is rendered. */
  startRank?: number;
  /** Explicit BP positions. Takes precedence over startRank. */
  ranks?: number[];
  /** yumu-image's five-column compact layout. */
  compact?: boolean;
  /** Optional historical user snapshot used by yumu's header card. */
  historyUser?: any;
}

/**
 * Build the exact multi-score payload used by yumu-bot's BPService:
 * `imageService.getPanel(body, "A4")`.
 */
export async function buildYumuBestScoresPayload(
  apiUser: any,
  apiScores: any[],
  options: YumuBestScoresOptions = {}
): Promise<Record<string, any>> {
  const sourceScores = Array.isArray(apiScores) ? apiScores : [];
  if (sourceScores.length === 0) {
    throw new Error('BP 列表为空，无法渲染 panel_A4');
  }

  const scores = await mapLimit(sourceScores, 8, (score) => buildYumuScore(score, apiUser));
  const startRank = Math.max(1, Math.trunc(finiteNumber(options.startRank, 1)));
  const ranks = scores.map((_, index) => {
    const explicit = Number(options.ranks?.[index]);
    return Number.isSafeInteger(explicit) && explicit > 0 ? explicit : startRank + index;
  });

  const payload: Record<string, any> = {
    user: buildYumuUser(apiUser),
    history_user: options.historyUser ? buildYumuUser(options.historyUser) : null,
    scores,
    rank: ranks,
    panel: 'BS',
    compact: options.compact === true
  };

  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > RENDER_PAYLOAD_SAFE_BYTES) {
    // panel_A4 uses only the header card and per-score MicroUsers; profile-only
    // fields (achievements, playcount history, …) are safe to drop here.
    payload.user = buildYumuUser(apiUser, { panelCompact: true });
    if (options.historyUser) {
      payload.history_user = buildYumuUser(options.historyUser, { panelCompact: true });
    }
  }

  const finalBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (finalBytes > MAX_RENDER_PAYLOAD_BYTES) {
    throw new Error(`BP 渲染参数仍超过 4096 KiB 限制（${finalBytes} 字节），已回退文字列表`);
  }

  return payload;
}

function scoreAttributes(apiScore: any, score: Record<string, any>): Record<string, number> {
  const supplied = apiScore?.attributes
    || apiScore?.performance_attributes
    || apiScore?.score_attributes
    || {};

  const attributes: Record<string, number> = {
    pp: finiteNumber(supplied.pp, apiScore?.pp),
    stars: finiteNumber(score?.beatmap?.difficulty_rating),
    // panel_E5 combo bar
    combo: finiteNumber(score?.max_combo, apiScore?.max_combo, supplied?.combo),
    max_combo: finiteNumber(
      score?.beatmap?.max_combo,
      apiScore?.beatmap?.max_combo,
      supplied?.max_combo
    )
  };

  const mappings: Array<[string, string[]]> = [
    ['pp_accuracy', ['pp_accuracy', 'accuracy', 'aim_difficulty']],
    ['pp_aim', ['pp_aim', 'aim']],
    ['pp_speed', ['pp_speed', 'speed']],
    ['pp_flashlight', ['pp_flashlight', 'flashlight']],
    ['pp_reading', ['pp_reading', 'reading']],
    ['pp_difficulty', ['pp_difficulty', 'difficulty']],
    ['full_pp', ['full_pp', 'full_combo_pp', 'fc_pp']],
    ['perfect_pp', ['perfect_pp', 'perfect_combo_pp', 'if_fc_pp']],
    ['effective_miss_count', ['effective_miss_count']]
  ];
  for (const [target, sources] of mappings) {
    for (const source of sources) {
      const value = Number(supplied?.[source]);
      if (Number.isFinite(value)) {
        attributes[target] = value;
        break;
      }
    }
  }

  // If the API didn't provide perfect_pp, try the weighted performance data
  if (!Number.isFinite(attributes.perfect_pp) || attributes.perfect_pp <= 0) {
    const weighted = apiScore?.weighted_performance_attributes
      || apiScore?.weighted_pp_attributes
      || {};
    const ppIfFc = finiteNumber(
      weighted?.perfect_pp,
      weighted?.full_pp,
      weighted?.fc_pp
    );
    if (ppIfFc > 0) attributes.perfect_pp = ppIfFc;
  }

  return attributes;
}

// ── Render specific panels ──

export async function renderPlayerInfo(
  apiUser: any,
  apiScores: readonly unknown[] = [],
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;

  try {
    // yumu-bot's `/i` (玩家信息) renders the D3 "Information v5" panel; the
    // Gamma card remains the separate `/card`/`ic` output.
    const payload = await buildYumuInfoPayload(apiUser, apiScores);
    const buffer = await renderPanel('panel_D3', payload);
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'info') };
  } catch (err) {
    console.error('[render] panel_D3 failed:', (err as Error).message);
    try {
      const buffer = await renderPanel('panel_Gamma', { panel: 'info', user: buildYumuUser(apiUser) });
      return { buffer, cqCode: saveAndGetCqCode(buffer, 'info') };
    } catch (fallbackError) {
      console.error('[render] panel_Gamma fallback failed:', (fallbackError as Error).message);
      return null;
    }
  }
}

export interface ScoreCardEnrichment {
  /** rosu pp 分解（pp_aim/pp_speed/pp_accuracy/…、full_pp/perfect_pp、stars 等）。 */
  attributes?: Record<string, number> | null;
  /** 雨沐 26 段物件密度数组（E5 密度折线）。 */
  density26?: number[] | null;
}

export async function renderScoreCard(
  apiScore: any,
  apiUser: any,
  position?: number | null,
  enrichment?: ScoreCardEnrichment,
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;

  try {
    const score = await buildYumuScore(apiScore, apiUser);
    const baseBeatmap = apiScore?.beatmap || {};
    const attributes = {
      ...scoreAttributes(apiScore, score),
      ...(enrichment?.attributes || {}),
    };
    const payload: Record<string, unknown> = {
      panel: '',
      user: buildYumuUser(apiUser),
      history_user: null,
      score,
      // yumu-image 的 E5 密度折线直接吃数组（26 段物件分组）；没有数据时留空。
      density: Array.isArray(enrichment?.density26) && enrichment.density26.length > 0
        ? enrichment.density26
        : {},
      progress: 1,
      original: {
        cs: finiteNumber(baseBeatmap.cs),
        ar: finiteNumber(baseBeatmap.ar),
        od: finiteNumber(baseBeatmap.od, baseBeatmap.accuracy),
        hp: finiteNumber(baseBeatmap.drain, baseBeatmap.hp)
      },
      attributes,
      position: position ?? 0,
      health: { time: [], percent: [] }
    };
    const buffer = await renderPanel('panel_E5', payload);
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'score') };
  } catch (err) {
    console.error('[render] panel_E5 failed:', (err as Error).message);
    return null;
  }
}

export async function renderCompactInfoCard(apiUser: any): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;

  try {
    const buffer = await renderPanel('panel_Gamma', { panel: 'info', user: buildYumuUser(apiUser) });
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'info') };
  } catch (err) {
    console.error('[render] panel_Gamma failed:', (err as Error).message);
    return null;
  }
}

export async function renderCompactScoreCard(
  apiUser: any,
  apiScore: any
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;

  try {
    const score = await buildYumuScore(apiScore, apiUser);
    const buffer = await renderPanel('panel_Gamma', { panel: 'score', score });
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'score') };
  } catch (err) {
    console.error('[render] panel_Gamma score failed:', (err as Error).message);
    return null;
  }
}

// ── Save image and get CQ code ──

export async function renderBestScoresList(
  apiUser: any,
  apiScores: any[],
  options: YumuBestScoresOptions = {}
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;

  const cacheKey = bpListCacheKey(apiUser, apiScores, options);
  const cached = renderedPanelCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RENDER_CACHE_TTL_MS) {
    const cachedFile = cqCodeToFilePath(cached.cqCode);
    if (cachedFile && existsSync(cachedFile)) {
      return { buffer: readFileSync(cachedFile), cqCode: cached.cqCode };
    }
    renderedPanelCache.delete(cacheKey);
  }

  try {
    const payload = await buildYumuBestScoresPayload(apiUser, apiScores, options);
    const buffer = await renderPanel('panel_A4', payload);
    const cqCode = saveAndGetCqCode(buffer, 'bp');
    renderedPanelCache.set(cacheKey, { at: Date.now(), cqCode });
    return { buffer, cqCode };
  } catch (err) {
    console.error('[render] panel_A4 failed:', (err as Error).message);
    return null;
  }
}

// ── Beatmap recommendation card ──
// MVP renders the official beatmapset cover as a QQ image; yumu-image has no
// dedicated beatmap panel yet, and the text payload always carries the links.
export async function renderBeatmapCard(
  candidate: { coverUrl: string },
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!candidate?.coverUrl) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(candidate.coverUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 1024) return null;
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'bp') };
  } catch {
    return null;
  }
}

export function bpListCacheKey(
  apiUser: any,
  apiScores: any[],
  options: YumuBestScoresOptions
): string {
  const ranks = (options.ranks || []).join(',') || String(options.startRank || 1);
  const scores = (Array.isArray(apiScores) ? apiScores : []).map((score) => {
    const mods = Array.isArray(score?.mods)
      ? score.mods.map((mod: any) => (typeof mod === 'string' ? mod : mod?.acronym || '')).join('')
      : '';
    return `${score?.id || score?.best_id || 0}:${mods}:${score?.pp || 0}:${score?.ended_at || score?.created_at || ''}:${score?.rank || ''}`;
  }).join('|');
  const history = options.historyUser
    ? `:h${canonicalHistorySignature(options.historyUser)}`
    : '';
  return `a4:${apiUser?.id || 0}:${ranks}:${options.compact ? 'c' : 'n'}:${scores}${history}`;
}

/**
 * Stable fingerprint of a history_user snapshot for rendered-panel caching.
 * Two snapshots of the same osuUserId at different points in time render
 * different header cards, so keying by id alone is a silent-wrong-result
 * bug. The signature covers every field buildYumuUser keeps (object keys are
 * canonicalized so equal snapshots with different key order match), and
 * ignores `page`, which buildYumuUser always drops from render payloads.
 */
function canonicalHistorySignature(historyUser: any): string {
  return createHash('sha1')
    .update(canonicalJsonValue(historyUser, new WeakSet()))
    .digest('hex')
    .slice(0, 16);
}

function canonicalJsonValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (seen.has(value as object)) return '"<circular>"';
  seen.add(value as object);
  if (Array.isArray(value)) {
    const out = value.map((v) => canonicalJsonValue(v, seen)).join(',');
    seen.delete(value as object);
    return `[${out}]`;
  }
  const record = value as Record<string, unknown>;
  const out = Object.keys(record)
    .filter((key) => key !== 'page')
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], seen)}`)
    .join(',');
  seen.delete(value as object);
  return `{${out}}`;
}

function cqCodeToFilePath(cqCode: string): string | null {
  const match = /\[CQ:image,file=(file:\/\/[^\]]+)\]/.exec(cqCode || '');
  if (!match) return null;
  try {
    return fileURLToPath(match[1]);
  } catch {
    return null;
  }
}

function pruneRenderOutput(): void {
  const now = Date.now();
  const files = readdirSync(RENDER_OUTPUT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SAVED_RENDER_PATTERN.test(entry.name))
    .map((entry) => {
      const filepath = path.join(RENDER_OUTPUT_DIR, entry.name);
      try {
        const stat = statSync(filepath);
        return { filepath, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { filepath: string; mtimeMs: number; size: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  let remainingCount = files.length;
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    const expired = now - file.mtimeMs > MAX_RENDER_AGE_MS;
    const overBudget = remainingCount > MAX_SAVED_RENDERS || remainingBytes > MAX_SAVED_RENDER_BYTES;
    if (!expired && !overBudget) continue;
    // These are generated cache files under a dedicated directory and can be
    // recreated. Names outside our own strict pattern are never touched.
    try {
      unlinkSync(file.filepath);
      remainingCount--;
      remainingBytes -= file.size;
    } catch {
      // A file may still be in use by NapCat; leave it for a later pass.
    }
  }
}

export function saveAndGetCqCode(buffer: Buffer, prefix: 'info' | 'score' | 'bp' | 'skill'): string {
  const extension = detectRenderedImageType(buffer);
  if (!extension) throw new Error('渲染器返回的内容不是 JPEG、PNG 或 WebP 图片');

  ensureOutputDir();
  const filename = `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  const filepath = path.join(RENDER_OUTPUT_DIR, filename);
  writeFileSync(filepath, buffer, { flag: 'wx' });
  pruneRenderOutput();

  return `[CQ:image,file=${pathToFileURL(filepath).href}]`;
}
