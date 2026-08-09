// osu! beatmap recommendation engine (MVP: real-time collaborative filtering).
//
// Principle (borrowed from osu!helper): for each of the player's top plays,
// look at the beatmap leaderboard, find players whose pp on that map is close
// to the player's own, then collect those players' top plays as candidates.
// Candidates are ranked by how many similar players play them, adjusted for
// the player's mod preferences and star-rating window.
//
// The official /beatmaps/search endpoint is currently unusable with client
// credentials ("Specified beatmap difficulty couldn't be found"), so the
// fallback for sparse players is a relaxed pp window re-run; if even that
// yields nothing we fail honestly instead of inventing maps.

import { updateDb } from '../store.js';
import { cacheGet, cacheSet } from './cache.js';
import { RECOMMEND_COOLDOWN } from '../bot/commands/commandConstants.js';
import {
  getUser,
  getUserById,
  getUserBestScores,
  getBeatmapScores,
  getBeatmapAttributes,
} from './api.js';
import {
  applyModStats,
  describeFilters,
  isEmptyFilters,
  splitModCombo,
} from './recommendFilters.js';
import type { RecommendFilters } from './recommendFilters.js';
import type { OsuScore, OsuUser } from './types.js';

export interface RecommendCandidate {
  beatmapId: number;
  beatmapsetId: number;
  title: string;
  artist: string;
  creator: string;
  version: string;
  coverUrl: string;
  mapUrl: string;
  stars: number;
  /** Base (NM) difficulty rating, kept for "playable" caps after mod enrichment. */
  baseStars: number;
  bpm: number;
  ar: number;
  cs: number;
  od: number;
  hp: number;
  totalLength: number;
  mods: string[];
  pp: number;
  similarCount: number;
}

export interface RecommendResult {
  ok: boolean;
  candidates: RecommendCandidate[];
  source: 'collab' | 'relaxed' | 'none';
  reason?: string;
  stats?: {
    topPlayCount: number;
    similarPlayers: number;
    apiCalls: number;
    elapsedMs: number;
    topStarMax?: number;
    topStarMean?: number;
    topModdedStarMax?: number;
    topModdedStarMean?: number;
    topMods?: string[];
  };
}

export interface PlayerTarget {
  kind: 'username' | 'id';
  value: string | number;
}

export const RECOMMEND_COOLDOWN_MS = RECOMMEND_COOLDOWN.ms;
export const RECOMMEND_HISTORY_DAYS = 7;

const DEFAULT_COUNT = 3;
const MAX_COUNT = 5;
const TOP_PLAYS = 30;
const OWN_TOP = 100;
const SIMILAR_TOP = 50;
const SIMILAR_PER_MAP = 5;
const SIMILAR_PER_MAP_RELAXED = 10;
const MAX_SIMILAR_PLAYERS = 120;
const CONCURRENCY = 20;
const TIME_BUDGET_MS = 60_000;
const CANDIDATE_CACHE_TTL_MS = 30 * 60_000;
const CANDIDATE_POOL_SIZE = 12;
const SIMILAR_TOP_CACHE_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const S_RANKS = new Set(['S', 'SH', 'SS', 'SSH']);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error(`osu! API timeout after ${ms}ms`)), ms);
});

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  try {
    return await Promise.race([promise, timeout(ms)]);
  } catch {
    return null;
  }
}

async function fetchSimilarTopWithCache(playerId: number): Promise<OsuScore[] | null> {
  const cacheKey = `simTop:${playerId}:osu:50`;
  const cached = cacheGet<OsuScore[]>(cacheKey);
  if (cached) return cached;
  // One retry per request: a single flaky call must not starve the candidate
  // pool, but a truly dead endpoint should not stall the whole batch.
  let scores = await withTimeout(fetchBestScoresWithRetry(playerId, SIMILAR_TOP), REQUEST_TIMEOUT_MS);
  if (!scores) {
    scores = await withTimeout(fetchBestScoresWithRetry(playerId, SIMILAR_TOP), REQUEST_TIMEOUT_MS);
  }
  if (scores) cacheSet(cacheKey, scores, SIMILAR_TOP_CACHE_TTL_MS);
  return scores;
}

async function fetchLeaderboardWithRetry(beatmapId: number): Promise<OsuScore[]> {
  let scores = await withTimeout(fetchBeatmapScoresWithRetry(beatmapId), REQUEST_TIMEOUT_MS);
  if (!scores) {
    scores = await withTimeout(fetchBeatmapScoresWithRetry(beatmapId), REQUEST_TIMEOUT_MS);
  }
  return scores || [];
}

async function fetchBestScoresWithRetry(userId: number, limit: number): Promise<OsuScore[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getUserBestScores(userId, 'osu', limit);
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (attempt === 0 && message.includes('429')) {
        await sleep(1000);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`osu! API 429 after retries (user ${userId})`);
}

async function fetchBeatmapScoresWithRetry(beatmapId: number): Promise<OsuScore[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getBeatmapScores(beatmapId, 'osu');
    } catch (error) {
      const message = String((error as Error)?.message || error);
      if (attempt === 0 && message.includes('429')) {
        await sleep(1000);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`osu! API 429 after retries (beatmap ${beatmapId})`);
}

// ── Cooldown & anti-repeat persistence ──

export function checkRecommendCooldown(db: any, osuUserId: number): number {
  // Cooldown lives in its own map so clearing it never wipes anti-repeat history.
  const map = db?.osuRecommendCooldowns;
  if (map && typeof map === 'object') {
    const lastAt = Number(map[String(osuUserId)] || 0);
    return lastAt > 0 ? Math.max(0, RECOMMEND_COOLDOWN_MS - (Date.now() - lastAt)) : 0;
  }
  // Legacy fallback: records written before the cooldown map existed.
  const records = Array.isArray(db?.osuRecommendations) ? db.osuRecommendations : [];
  const last = records
    .filter((r: any) => Number(r.osuUserId) === Number(osuUserId))
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!last) return 0;
  const elapsed = Date.now() - new Date(last.createdAt).getTime();
  return Math.max(0, RECOMMEND_COOLDOWN_MS - elapsed);
}

export function loadRecommendHistory(db: any, osuUserId: number): Set<number> {
  const cutoff = Date.now() - RECOMMEND_HISTORY_DAYS * 86_400_000;
  const out = new Set<number>();
  for (const r of (db?.osuRecommendations || [])) {
    if (Number(r.osuUserId) !== Number(osuUserId)) continue;
    if (new Date(r.createdAt).getTime() < cutoff) continue;
    if (Number(r.beatmapsetId) > 0) out.add(Number(r.beatmapsetId));
  }
  return out;
}

export function markRecommendation(osuUserId: number, candidates: RecommendCandidate[]): void {
  const now = new Date().toISOString();
  updateDb((draft: any) => {
    draft.osuRecommendCooldowns = draft.osuRecommendCooldowns || {};
    draft.osuRecommendCooldowns[String(osuUserId)] = Date.now();
    draft.osuRecommendations = draft.osuRecommendations || [];
    for (const c of candidates) {
      draft.osuRecommendations.push({
        osuUserId: Number(osuUserId),
        beatmapId: c.beatmapId,
        beatmapsetId: c.beatmapsetId,
        createdAt: now,
      });
    }
    draft.osuRecommendations = draft.osuRecommendations.slice(-2000);
  });
}

export function clearRecommendCooldown(osuUserId: number): void {
  updateDb((draft: any) => {
    if (draft.osuRecommendCooldowns) {
      delete draft.osuRecommendCooldowns[String(osuUserId)];
    }
  });
}

export function clearRecommendHistory(osuUserId: number): number {
  let removed = 0;
  updateDb((draft: any) => {
    const id = Number(osuUserId);
    const before = (draft.osuRecommendations || []).length;
    draft.osuRecommendations = (draft.osuRecommendations || []).filter(
      (r: any) => Number(r.osuUserId) !== id,
    );
    removed = before - draft.osuRecommendations.length;
    if (draft.osuRecommendCooldowns) {
      delete draft.osuRecommendCooldowns[String(id)];
    }
  });
  return removed;
}

// ── Cached candidate pool (per player, in-memory) ──

interface CandidateCacheEntry {
  candidates: RecommendCandidate[];
  source: 'collab' | 'relaxed';
  at: number;
  topStarMax?: number;
  topStarMean?: number;
  topModdedStarMax?: number;
  topModdedStarMean?: number;
  topMods?: string[];
}

function candidateCacheGet(osuUserId: number): CandidateCacheEntry | null {
  const entry = cacheGet<CandidateCacheEntry>(`reco:${osuUserId}`);
  return entry || null;
}

function candidateCacheSet(osuUserId: number, entry: CandidateCacheEntry): void {
  cacheSet(`reco:${osuUserId}`, entry, CANDIDATE_CACHE_TTL_MS);
}

// ── Preference helpers ──

function playerPreferredMods(db: any, username: string): string[] {
  const record = (db?.skillStore?.records || []).find(
    (r: any) => String(r.osuUsername || '').toLowerCase() === String(username || '').toLowerCase(),
  );
  if (record?.topMods?.length) return splitModCombo(String(record.topMods[0])) || [];
  if (record?.modComposition) {
    const entries = Object.entries(record.modComposition).sort((a, b) => Number(b[1]) - Number(a[1]));
    if (entries.length > 0) return splitModCombo(String(entries[0][0])) || [];
  }
  return [];
}

function candidateHasMod(modsList: string[], mod: string): boolean {
  return modsList.includes(mod) || (mod === 'DT' && modsList.includes('NC'));
}

function candidateFromScore(score: OsuScore): RecommendCandidate | null {
  const beatmap = score.beatmap;
  const beatmapset = score.beatmapset || (beatmap as any)?.beatmapset;
  const beatmapId = Number(beatmap?.id || (score as any).beatmap_id || 0);
  if (!beatmapId) return null;
  const beatmapsetId = Number(beatmapset?.id || beatmap?.beatmapset_id || 0);
  const stars = Number(beatmap?.difficulty_rating || 0);
  const pp = Number(score.pp || 0);
  const modKey = (score.mods || []).slice().sort().join('');
  return {
    beatmapId,
    beatmapsetId,
    title: String(beatmapset?.title_unicode || beatmapset?.title || '未知谱面'),
    artist: String(beatmapset?.artist || ''),
    creator: String(beatmapset?.creator || ''),
    version: String(beatmap?.version || ''),
    coverUrl: String(beatmapset?.covers?.cover || ''),
    mapUrl: `https://osu.ppy.sh/beatmaps/${beatmapId}`,
    stars,
    baseStars: stars,
    bpm: Number(beatmap?.bpm || 0),
    ar: Number(beatmap?.ar || 0),
    cs: Number(beatmap?.cs || 0),
    od: Number(beatmap?.accuracy || 0),
    hp: Number(beatmap?.drain || 0),
    totalLength: Number(beatmap?.total_length || 0),
    mods: modKey ? splitModCombo(modKey) || [] : [],
    pp,
    similarCount: 0,
  };
}

// ── Mod-adjusted enrichment & filter application ──

function needsModAdjustedFilters(filters: RecommendFilters | undefined): boolean {
  if (!filters) return false;
  return filters.bpmMin !== undefined || filters.bpmMax !== undefined ||
    filters.arMin !== undefined || filters.arMax !== undefined ||
    filters.csMin !== undefined || filters.csMax !== undefined ||
    filters.odMin !== undefined || filters.odMax !== undefined ||
    filters.hpMin !== undefined || filters.hpMax !== undefined ||
    filters.starMin !== undefined || filters.starMax !== undefined;
}

async function enrichCandidateMods(candidate: RecommendCandidate): Promise<boolean> {
  // Star rating is the only mod-dependent value the API exposes directly;
  // AR/CS/OD/HP/BPM/length are converted locally with the standard formulas.
  let starsOk = true;
  if (candidate.mods.length > 0) {
    try {
      const attrs = await withTimeout(
        getBeatmapAttributes(candidate.beatmapId, 'osu', candidate.mods),
        REQUEST_TIMEOUT_MS,
      );
      if (attrs?.attributes && Number.isFinite(attrs.attributes.star_rating) && attrs.attributes.star_rating > 0) {
        candidate.stars = attrs.attributes.star_rating;
      } else {
        starsOk = false;
      }
    } catch {
      starsOk = false;
    }
  }
  const adjusted = applyModStats({
    ar: candidate.ar,
    cs: candidate.cs,
    od: candidate.od,
    hp: candidate.hp,
    bpm: candidate.bpm,
    length: candidate.totalLength,
  }, candidate.mods);
  candidate.ar = adjusted.ar;
  candidate.cs = adjusted.cs;
  candidate.od = adjusted.od;
  candidate.hp = adjusted.hp;
  candidate.bpm = adjusted.bpm;
  candidate.totalLength = adjusted.length;
  return starsOk;
}

async function enrichCandidates(
  candidates: RecommendCandidate[],
  deadline: number,
  strict: boolean,
): Promise<RecommendCandidate[]> {
  const out: RecommendCandidate[] = [];
  await mapLimit(candidates, CONCURRENCY, async (c) => {
    if (Date.now() > deadline) return;
    const ok = await enrichCandidateMods(c);
    if (!strict || ok) out.push(c);
  });
  return out;
}

function inRange(value: number | undefined, min?: number, max?: number): boolean {
  if (value === undefined || !Number.isFinite(value)) return min === undefined && max === undefined;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function matchesFilters(candidate: RecommendCandidate, filters: RecommendFilters | undefined): boolean {
  if (isEmptyFilters(filters)) return true;
  const f = filters as RecommendFilters;
  if (!inRange(candidate.bpm, f.bpmMin, f.bpmMax)) return false;
  if (!inRange(candidate.ar, f.arMin, f.arMax)) return false;
  if (!inRange(candidate.cs, f.csMin, f.csMax)) return false;
  if (!inRange(candidate.od, f.odMin, f.odMax)) return false;
  if (!inRange(candidate.hp, f.hpMin, f.hpMax)) return false;
  if (!inRange(candidate.stars, f.starMin, f.starMax)) return false;
  if (!inRange(candidate.totalLength, f.lengthMin, f.lengthMax)) return false;
  if (!inRange(candidate.similarCount, f.similarMin, f.similarMax)) return false;
  if (f.forbidMods?.length && f.forbidMods.some((mod) => candidateHasMod(candidate.mods, mod))) return false;
  return true;
}

// ── Main engine ──

export async function recommendForPlayer(
  target: PlayerTarget,
  db: any,
  options: {
    count?: number;
    excludeBeatmapsetIds?: Set<number>;
    timeBudgetMs?: number;
    bypassCache?: boolean;
    filters?: RecommendFilters;
    filterStatement?: string;
  } = {},
): Promise<RecommendResult> {
  const count = Math.min(Math.max(options.count ?? DEFAULT_COUNT, 1), MAX_COUNT);
  const deadline = Date.now() + (options.timeBudgetMs ?? TIME_BUDGET_MS);
  const startedAt = Date.now();
  let apiCalls = 0;

  const user: OsuUser = target.kind === 'id'
    ? await getUserById(Number(target.value), 'osu')
    : await getUser(String(target.value), 'osu');
  apiCalls += 1;

  if (!options.bypassCache) {
    const cached = candidateCacheGet(user.id);
    if (cached) {
      const playableCap = options.filters?.playable && cached.topStarMax
        ? cached.topStarMax * 1.1
        : undefined;
      const filtered = cached.candidates
        .filter((c) => !(options.excludeBeatmapsetIds || new Set<number>()).has(c.beatmapsetId))
        .filter((c) => matchesFilters(c, options.filters))
        .filter((c) => !playableCap || c.baseStars <= playableCap)
        .slice(0, count);
      if (filtered.length > 0) {
        return {
          ok: true,
          candidates: filtered,
          source: cached.source,
          stats: {
            topPlayCount: 0,
            similarPlayers: 0,
            apiCalls: 0,
            elapsedMs: Date.now() - startedAt,
            topStarMax: cached.topStarMax,
            topStarMean: cached.topStarMean,
            topModdedStarMax: cached.topModdedStarMax,
            topModdedStarMean: cached.topModdedStarMean,
            topMods: cached.topMods,
          },
        };
      }
      // All cached candidates were already recommended: fall through and
      // regenerate with the exclusion set applied during aggregation.
    }
  }

  const topScores = await fetchBestScoresWithRetry(user.id, TOP_PLAYS);
  apiCalls += 1;
  if (!Array.isArray(topScores) || topScores.length === 0) {
    return { ok: false, candidates: [], source: 'none', reason: '该玩家没有 osu! 成绩，无法生成推荐。' };
  }

  const ownTop100 = await fetchBestScoresWithRetry(user.id, OWN_TOP).catch(() => []);
  apiCalls += 1;
  const ownBeatmapIds = new Set<number>();
  const ownBeatmapsetIds = new Set<number>();
  for (const s of ownTop100 || []) {
    if (Number(s.beatmap?.id) > 0) ownBeatmapIds.add(Number(s.beatmap.id));
    const setId = Number(s.beatmapset?.id || s.beatmap?.beatmapset_id || 0);
    if (setId > 0) ownBeatmapsetIds.add(setId);
  }

  const topStars = topScores.map((s) => Number(s.beatmap?.difficulty_rating || 0)).filter((v) => v > 0);
  const avgPp = mean(topScores.map((s) => Number(s.pp || 0)));
  const topStarMax = Math.max(...topStars);
  const topStarMean = mean(topStars);
  let topMods = playerPreferredMods(db, user.username);
  if (!topMods.length) {
    // Fall back to the actual dominant mod combo in the player's top plays.
    const freq = new Map<string, number>();
    for (const s of topScores.slice(0, 10)) {
      const combo = [...new Set((s.mods || []).map((m) => String(m).toUpperCase()))].sort().join('');
      if (combo) freq.set(combo, (freq.get(combo) || 0) + 1);
    }
    const dominant = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (dominant) topMods = splitModCombo(dominant[0]) || [];
  }
  // Mod-adjusted star range of the player's own top plays (top 10). This is
  // what "Top 星数" actually means in play: base 5★ + DT is ~7.5★ in game.
  const topModdedStars = (await mapLimit(topScores.slice(0, 10), 5, async (s: OsuScore) => {
    const mods = (s.mods || []).filter(Boolean);
    if (!mods.length) return Number(s.beatmap?.difficulty_rating || 0);
    try {
      const attrs = await withTimeout(
        getBeatmapAttributes(Number(s.beatmap?.id || 0), 'osu', mods),
        REQUEST_TIMEOUT_MS,
      );
      apiCalls += 1;
      return attrs?.attributes?.star_rating || 0;
    } catch {
      return 0;
    }
  })).filter((v: number) => v > 0);
  const topModdedStarMax = topModdedStars.length > 0 ? Math.max(...topModdedStars) : 0;
  const topModdedStarMean = topModdedStars.length > 0 ? mean(topModdedStars) : 0;
  const starsUpper = options.filters?.playable
    ? topStarMax * 1.1
    : topStarMax * 1.3;
  const starsLower = mean(topStars) * 0.7;
  const exclude = options.excludeBeatmapsetIds || new Set<number>();

  // Stage 1: leaderboard-based similar players.
  async function collectSimilarPlayers(perMap: number): Promise<Map<number, { count: number; totalDelta: number }>> {
    const similar = new Map<number, { count: number; totalDelta: number }>();
    await mapLimit(topScores, CONCURRENCY, async (score) => {
      if (Date.now() > deadline) return;
      const beatmapId = Number(score.beatmap?.id || 0);
      if (!beatmapId) return;
      let leaderboard: OsuScore[];
      try {
        leaderboard = await fetchLeaderboardWithRetry(beatmapId);
        apiCalls += 1;
      } catch {
        return;
      }
      if (!Array.isArray(leaderboard) || leaderboard.length === 0) return;
      const ownPp = Number(score.pp || 0);
      const ranked = leaderboard
        .filter(
          (s) =>
            Number(s.pp || 0) > 0 &&
            Number(s.user_id || 0) > 0 &&
            Number(s.user_id) !== user.id,
        )
        .map((s) => ({ s, delta: Math.abs(Number(s.pp) - ownPp) }))
        .sort((a, b) => a.delta - b.delta)
        .slice(0, perMap);
      for (const { s, delta } of ranked) {
        const playerId = Number(s.user_id);
        const entry = similar.get(playerId) || { count: 0, totalDelta: 0 };
        entry.count += 1;
        entry.totalDelta += delta;
        similar.set(playerId, entry);
      }
    });
    return similar;
  }

  // Stage 2: aggregate candidate maps from similar players' top plays.
  async function collectCandidates(
    similar: Map<number, { count: number; totalDelta: number }>,
    ppWindow: { min: number; max: number },
    limitPlayers: number,
  ): Promise<RecommendCandidate[]> {
    const rankedPlayers = [...similar.entries()]
      .map(([id, v]) => ({
        id: Number(id),
        score: v.count * 1000 / (1 + v.totalDelta / Math.max(v.count, 1) / 10),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limitPlayers);

    interface Agg {
      candidate: RecommendCandidate;
      players: Set<number>;
      pps: number[];
      mods: Map<string, number>;
    }
    const agg = new Map<number, Agg>();

    await mapLimit(rankedPlayers, CONCURRENCY, async (p) => {
      if (Date.now() > deadline) return;
      let scores: OsuScore[];
      try {
        scores = (await fetchSimilarTopWithCache(p.id)) || [];
        apiCalls += 1;
      } catch {
        return;
      }
      for (const s of scores || []) {
        const pp = Number(s.pp || 0);
        if (pp <= 0 || pp < ppWindow.min || pp > ppWindow.max) continue;
        if (!S_RANKS.has(String(s.rank || ''))) continue;
        const beatmapId = Number(s.beatmap?.id || 0);
        if (!beatmapId || ownBeatmapIds.has(beatmapId)) continue;
        const setId = Number(s.beatmapset?.id || s.beatmap?.beatmapset_id || 0);
        if (setId > 0 && (ownBeatmapsetIds.has(setId) || exclude.has(setId))) continue;
        const base = candidateFromScore(s);
        if (!base) continue;
        const stars = base.stars;
        if (stars > 0 && (stars < starsLower || stars > starsUpper)) continue;
        let entry = agg.get(beatmapId);
        if (!entry) {
          entry = { candidate: base, players: new Set(), pps: [], mods: new Map() };
          agg.set(beatmapId, entry);
        }
        entry.players.add(p.id);
        entry.pps.push(pp);
        const modKey = (s.mods || []).slice().sort().join('');
        entry.mods.set(modKey, (entry.mods.get(modKey) || 0) + 1);
      }
    });

    const preferred = playerPreferredMods(db, user.username);
    const filterPreferred = options.filters?.preferMods || [];
    const candidates = [...agg.values()].map((entry) => {
      const mods = [...entry.mods.entries()].sort((a, b) => b[1] - a[1])[0];
      const modsList = mods && mods[0] ? splitModCombo(mods[0]) || [] : [];
      let score = entry.players.size * 100;
      const modOverlap = preferred.length > 0 && preferred.every((m) => candidateHasMod(modsList, m));
      if (modOverlap) score += 15;
      const filterOverlap = filterPreferred.length > 0 && filterPreferred.every((m) => candidateHasMod(modsList, m));
      if (filterOverlap) score += 12;
      const stars = entry.candidate.stars;
      if (stars > 0 && stars >= mean(topStars) * 0.9 && stars <= mean(topStars) * 1.15) score += 10;
      return {
        candidate: {
          ...entry.candidate,
          mods: modsList,
          pp: Math.round(median(entry.pps) * 10) / 10,
          similarCount: entry.players.size,
        },
        score,
      };
    });

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, Math.max(count, CANDIDATE_POOL_SIZE)).map((c) => c.candidate);
  }

  // Pass 1: strict collaborative filtering.
  const similarStrict = await collectSimilarPlayers(SIMILAR_PER_MAP);
  let result = await collectCandidates(similarStrict, { min: avgPp * 0.75, max: avgPp * 1.35 }, MAX_SIMILAR_PLAYERS);
  let source: 'collab' | 'relaxed' = 'collab';

  // Pass 2: relaxed window + more similar players when we are short.
  if (result.length < count) {
    const similarRelaxed = await collectSimilarPlayers(SIMILAR_PER_MAP_RELAXED);
    const relaxed = await collectCandidates(similarRelaxed, { min: avgPp * 0.5, max: avgPp * 1.5 }, MAX_SIMILAR_PLAYERS);
    if (relaxed.length > result.length) {
      result = relaxed;
      source = 'relaxed';
    }
  }

  // Enrich the whole candidate pool with mod-adjusted attributes first, then
  // apply the user's filters against those adjusted values. When numeric
  // filters exist, candidates whose attributes could not be fetched are
  // dropped instead of being filtered on misleading base values.
  const strictEnrich = needsModAdjustedFilters(options.filters);
  result = await enrichCandidates(result, deadline, strictEnrich);

  const finalCandidates = result
    .filter((c) => matchesFilters(c, options.filters))
    .filter((c) => !exclude.has(c.beatmapsetId))
    .slice(0, count);

  if (result.length === 0 || finalCandidates.length === 0) {
    if (!isEmptyFilters(options.filters)) {
      const filterText = options.filterStatement
        ? `筛选条件（${options.filterStatement}）`
        : `筛选条件（${describeFilters(options.filters)}）`;
      return {
        ok: false,
        candidates: [],
        source: 'none',
        reason: `${filterText}下没有找到合适的谱面。可以放宽条件或换个说法再试。`,
        stats: {
          topPlayCount: topScores.length,
          similarPlayers: similarStrict.size,
          apiCalls,
          elapsedMs: Date.now() - startedAt,
        },
      };
    }
    return {
      ok: false,
      candidates: [],
      source: 'none',
      reason: '同分段数据太少或最近推荐的图还没消化，暂时推不出合适的图。先去打几把热热手，之后我就能给你挑了。',
      stats: {
        topPlayCount: topScores.length,
        similarPlayers: similarStrict.size,
        apiCalls,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  candidateCacheSet(user.id, {
    candidates: result,
    source,
    at: Date.now(),
    topStarMax,
    topStarMean,
    topModdedStarMax,
    topModdedStarMean,
    topMods,
  });
  return {
    ok: true,
    candidates: finalCandidates,
    source,
    stats: {
      topPlayCount: topScores.length,
      similarPlayers: similarStrict.size,
      apiCalls,
      elapsedMs: Date.now() - startedAt,
      topStarMax,
      topStarMean,
      topModdedStarMax,
      topModdedStarMean,
      topMods,
    },
  };
}

export function formatRecommendLine(candidate: RecommendCandidate, index: number): string {
  const stars = candidate.stars > 0 ? `${candidate.stars.toFixed(2)}★` : '星数未知';
  const bpm = candidate.bpm > 0 ? `BPM ${Math.round(candidate.bpm)}` : '';
  const ar = candidate.ar > 0 ? `AR ${candidate.ar.toFixed(1)}` : '';
  const length = candidate.totalLength > 0
    ? `${Math.floor(candidate.totalLength / 60)}:${String(candidate.totalLength % 60).padStart(2, '0')}`
    : '';
  const mods = candidate.mods.length > 0 ? `[${candidate.mods.join('')}]` : 'NM';
  const reason = candidate.similarCount > 0
    ? `${candidate.similarCount} 名同分段玩家在打`
    : '推荐候选';
  return [
    `#${index + 1} ${candidate.title}${candidate.version ? ` [${candidate.version}]` : ''}`,
    `${stars}｜${mods}｜${candidate.pp > 0 ? `约 ${candidate.pp}pp` : 'pp 未知'}｜${ar}｜${bpm}｜${length}`,
    `理由：${reason}`,
    `BID ${candidate.beatmapId}｜${candidate.mapUrl}`,
  ].join('\n');
}
