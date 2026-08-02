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
import { getUser, getUserById, getUserBestScores, getBeatmapScores } from './api.js';
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
  bpm: number;
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
  };
}

export interface PlayerTarget {
  kind: 'username' | 'id';
  value: string | number;
}

export const RECOMMEND_COOLDOWN_MS = 10 * 60_000;
export const RECOMMEND_HISTORY_DAYS = 7;

const DEFAULT_COUNT = 3;
const MAX_COUNT = 5;
const TOP_PLAYS = 30;
const OWN_TOP = 100;
const SIMILAR_TOP = 50;
const SIMILAR_PER_MAP = 5;
const SIMILAR_PER_MAP_RELAXED = 10;
const MAX_SIMILAR_PLAYERS = 150;
const CONCURRENCY = 10;
const TIME_BUDGET_MS = 45_000;
const CANDIDATE_CACHE_TTL_MS = 30 * 60_000;
const CANDIDATE_POOL_SIZE = 12;

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

// ── Cached candidate pool (per player, in-memory) ──

interface CandidateCacheEntry {
  candidates: RecommendCandidate[];
  source: 'collab' | 'relaxed';
  at: number;
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
  if (record?.topMods?.length) return String(record.topMods[0]).toUpperCase().split('');
  if (record?.modComposition) {
    const entries = Object.entries(record.modComposition).sort((a, b) => Number(b[1]) - Number(a[1]));
    if (entries.length > 0) return String(entries[0][0]).toUpperCase().split('');
  }
  return [];
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
    bpm: Number(beatmap?.bpm || 0),
    totalLength: Number(beatmap?.total_length || 0),
    mods: modKey ? modKey.split(/(?=[A-Z])/).filter(Boolean) : [],
    pp,
    similarCount: 0,
  };
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
      const filtered = cached.candidates
        .filter((c) => !(options.excludeBeatmapsetIds || new Set<number>()).has(c.beatmapsetId))
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
  const starsUpper = Math.max(...topStars) * 1.3;
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
        leaderboard = await fetchBeatmapScoresWithRetry(beatmapId);
        apiCalls += 1;
      } catch {
        return;
      }
      if (!Array.isArray(leaderboard) || leaderboard.length === 0) return;
      const ownPp = Number(score.pp || 0);
      const ranked = leaderboard
        .filter((s) => Number(s.pp || 0) > 0 && Number(s.user_id || 0) > 0)
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
        scores = await fetchBestScoresWithRetry(p.id, SIMILAR_TOP);
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
    const candidates = [...agg.values()].map((entry) => {
      const mods = [...entry.mods.entries()].sort((a, b) => b[1] - a[1])[0];
      const modsList = mods && mods[0] ? mods[0].split(/(?=[A-Z])/).filter(Boolean) : [];
      let score = entry.players.size * 100;
      const modOverlap = preferred.length > 0 && preferred.every((m) => modsList.includes(m));
      if (modOverlap) score += 15;
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

  const finalCandidates = result
    .filter((c) => !exclude.has(c.beatmapsetId))
    .slice(0, count);

  if (result.length === 0 || finalCandidates.length === 0) {
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

  candidateCacheSet(user.id, { candidates: result, source, at: Date.now() });
  return {
    ok: true,
    candidates: finalCandidates,
    source,
    stats: {
      topPlayCount: topScores.length,
      similarPlayers: similarStrict.size,
      apiCalls,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

export function formatRecommendLine(candidate: RecommendCandidate, index: number): string {
  const stars = candidate.stars > 0 ? `${candidate.stars.toFixed(2)}★` : '星数未知';
  const bpm = candidate.bpm > 0 ? `BPM ${Math.round(candidate.bpm)}` : '';
  const length = candidate.totalLength > 0
    ? `${Math.floor(candidate.totalLength / 60)}:${String(candidate.totalLength % 60).padStart(2, '0')}`
    : '';
  const mods = candidate.mods.length > 0 ? `[${candidate.mods.join('')}]` : 'NM';
  const reason = candidate.similarCount > 0
    ? `${candidate.similarCount} 名同分段玩家在打`
    : '推荐候选';
  return [
    `#${index + 1} ${candidate.title}${candidate.version ? ` [${candidate.version}]` : ''}`,
    `${stars}｜${mods}｜${candidate.pp > 0 ? `约 ${candidate.pp}pp` : 'pp 未知'}｜${bpm}｜${length}`,
    `理由：${reason}`,
    `BID ${candidate.beatmapId}｜${candidate.mapUrl}`,
  ].join('\n');
}
