import { getUserById, getUserRecentScores } from '../osu/api.js';
import { enrichScoreStarRatings } from '../osu/starRating.js';
import type { OsuScore } from '../osu/types.js';
import { saveAndGetCqCode } from './render.js';
import { renderPlayerRecentSkillProfileCard } from './playerSkillComparisonCard.js';
import {
  buildPlayerSkillProfilePayload,
  demonstratedAxisValue,
  mapLimit,
  PLAYER_SKILL_AXES,
  PLAYER_SKILL_AXIS_LABELS,
  rounded,
  scoreAchievementQuality,
  scoreMods,
  weightedQuantile,
  type PlayerSkillAxis,
} from './playerSkillProfile.js';
import { requestSkillProfilerAnalysisCachedWithFetch } from './skillProfiler.js';

const PAGE_SIZE = 50;
const TARGET_COMPLETED_GROUPS = 25;
const MIN_COMPLETED_GROUPS = 5;
const MAX_RAW_SCORES = 500;
const MAX_AGE_MS = 5 * 24 * 60 * 60_000;
const CACHE_TTL_MS = 5 * 60_000;
const ANALYSIS_CONCURRENCY = 3;
const recentCache = new Map<number, { at: number; payload: Record<string, any> }>();
const recentInflight = new Map<number, Promise<Record<string, any>>>();

export type RecentEvidence = 'SUFFICIENT' | 'LOWER_BOUND' | 'INSUFFICIENT';

export function recentScorePassed(score: any): boolean {
  if (typeof score?.passed === 'boolean') return score.passed;
  return String(score?.rank || '').toUpperCase() !== 'F';
}

export function canonicalRecentMods(score: any): string[] {
  return scoreMods(score).filter((mod) => !['NF', 'SD', 'PF'].includes(mod));
}

export function recentScoreGroupKey(score: any): string {
  const beatmapId = Number(score?.beatmap?.id || score?.beatmap_id || 0);
  return `${beatmapId}:${canonicalRecentMods(score).join(',') || 'NM'}`;
}

function scoreTime(score: any): number {
  const value = Date.parse(String(score?.ended_at || score?.created_at || ''));
  return Number.isFinite(value) ? value : 0;
}

export function recentTimeWeight(timestamp: string | number, now = Date.now()): number {
  const at = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(at)) return 0.85;
  const ageDays = Math.max(0, now - at) / 86_400_000;
  if (ageDays <= 1) return 1;
  const progress = Math.min(1, (ageDays - 1) / 4);
  return 1 - 0.15 * progress * progress * (3 - 2 * progress);
}

export function recentScoreCompletion(score: any): number {
  if (recentScorePassed(score)) return 1;
  const stats = score?.statistics || {};
  const judged = ['count_300', 'count_100', 'count_50', 'count_miss'].some((key) => stats[key] !== undefined)
    ? ['count_300', 'count_100', 'count_50', 'count_miss'].reduce((sum, key) => sum + Math.max(0, Number(stats[key] || 0)), 0)
    : ['great', 'ok', 'meh', 'miss'].reduce((sum, key) => sum + Math.max(0, Number(stats[key] || 0)), 0);
  const map = score?.beatmap || {};
  const objects = Math.max(0, Number(map.count_circles || 0))
    + Math.max(0, Number(map.count_sliders || 0))
    + Math.max(0, Number(map.count_spinners || 0));
  return objects > 0 ? Math.max(0, Math.min(1, judged / objects)) : 0;
}

export function recentFailureEvidence(score: any): number {
  if (recentScorePassed(score)) return 1;
  const completion = recentScoreCompletion(score);
  const quality = scoreAchievementQuality(score).overall;
  return Math.min(0.78, Math.pow(completion, 2.15) * (0.35 + 0.65 * quality));
}

interface RecentGroup {
  key: string;
  beatmapId: number;
  mods: string[];
  attempts: any[];
  completed: boolean;
}

export function groupRecentScores(scores: any[]): RecentGroup[] {
  const groups = new Map<string, RecentGroup>();
  for (const score of scores) {
    const beatmapId = Number(score?.beatmap?.id || score?.beatmap_id || 0);
    if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) continue;
    let mods: string[];
    try { mods = canonicalRecentMods(score); } catch { continue; }
    const key = `${beatmapId}:${mods.join(',') || 'NM'}`;
    const group = groups.get(key) || { key, beatmapId, mods, attempts: [], completed: false };
    group.attempts.push(score);
    group.completed ||= recentScorePassed(score);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    Math.max(...right.attempts.map(scoreTime)) - Math.max(...left.attempts.map(scoreTime)));
}

export function validRecentDemand(totalStars: number, axes: Record<string, number>, score: any): boolean {
  const values = Object.values(axes);
  if (!Number.isFinite(totalStars) || totalStars <= 0 || totalStars > 20) return false;
  if (values.length !== PLAYER_SKILL_AXES.length || values.some((value) => !Number.isFinite(value) || value < 0 || value > 20)) return false;
  if (totalStars < 15) return true;
  const map = score?.beatmap || {};
  const objects = Number(map.count_circles || 0) + Number(map.count_sliders || 0) + Number(map.count_spinners || 0);
  return objects >= 20 && Number(map.total_length || map.hit_length || 0) >= 10;
}

function bestAttempt(group: RecentGroup): any {
  const passed = group.attempts.filter(recentScorePassed);
  const candidates = passed.length ? passed : group.attempts;
  return [...candidates].sort((left, right) => {
    const leftValue = scoreAchievementQuality(left).overall * recentFailureEvidence(left);
    const rightValue = scoreAchievementQuality(right).overall * recentFailureEvidence(right);
    return rightValue - leftValue || scoreTime(right) - scoreTime(left);
  })[0];
}

async function collectRecentScores(osuId: number, now: number): Promise<{ scores: OsuScore[]; fetched: number }> {
  const collected: OsuScore[] = [];
  const seenScoreIds = new Set<string>();
  for (let offset = 0; offset < MAX_RAW_SCORES; offset += PAGE_SIZE) {
    const page = await getUserRecentScores(osuId, 'osu', PAGE_SIZE, offset);
    if (!page.length) break;
    const fresh = page.filter((score) => {
      const identity = String(score?.id || `${recentScoreGroupKey(score)}:${scoreTime(score)}:${score?.score || 0}`);
      if (seenScoreIds.has(identity)) return false;
      seenScoreIds.add(identity);
      return true;
    });
    if (!fresh.length) break; // defensive: stop if an API/proxy ignores offset
    collected.push(...fresh);
    const inWindow = collected.filter((score) => now - scoreTime(score) <= MAX_AGE_MS);
    const completed = groupRecentScores(inWindow).filter((group) => group.completed).length;
    const oldest = Math.min(...fresh.map(scoreTime).filter(Boolean));
    if (completed >= TARGET_COMPLETED_GROUPS || page.length < PAGE_SIZE || (oldest > 0 && now - oldest >= MAX_AGE_MS)) break;
  }
  return {
    scores: collected.filter((score) => {
      const at = scoreTime(score);
      return at > 0 && now - at >= 0 && now - at <= MAX_AGE_MS;
    }),
    fetched: collected.length,
  };
}

interface RecentAnalyzedGroup {
  completed: boolean;
  recency: number;
  quality: number;
  stability: number;
  failureEvidence: number;
  demandAxes: Record<PlayerSkillAxis, number>;
  axes: Record<PlayerSkillAxis, number>;
}

export function aggregateRecentSkillProfile(groups: RecentAnalyzedGroup[], longTerm: any[]): any[] {
  const longByKey = new Map(longTerm.map((axis: any) => [axis.key, Number(axis.ceiling || 0)]));
  return PLAYER_SKILL_AXES.map((axis) => {
    const samples = groups.map((group) => {
      const peak = Math.max(...PLAYER_SKILL_AXES.map((key) => group.demandAxes[key]), 0.1);
      const salience = 0.30 + 0.70 * Math.sqrt(Math.max(0, group.demandAxes[axis]) / peak);
      const weight = group.recency * salience * group.stability * (group.completed ? 1 : group.failureEvidence * 0.55);
      return { value: group.axes[axis], demand: group.demandAxes[axis], weight, completed: group.completed };
    }).filter((sample) => sample.weight >= 0.08 && sample.value > 0);
    const reference = longByKey.get(axis) || 0;
    // A low recent value is only a decline if the recent maps actually tested
    // roughly that level. Merely playing maps whose Jump/Reading demand is far
    // below the BP50 ceiling produces a lower bound, not a fake red arrow.
    const testingThreshold = Math.max(1, reference * 0.80);
    const tested = samples.filter((sample) => sample.demand >= testingThreshold && sample.weight >= 0.15).length;
    const supported = samples.filter((sample) => sample.completed && sample.weight >= 0.35).length;
    const evidence: RecentEvidence = tested >= 3 ? 'SUFFICIENT' : supported >= 1 ? 'LOWER_BOUND' : 'INSUFFICIENT';
    const value = evidence === 'INSUFFICIENT' ? null : weightedQuantile(samples, 0.82);
    const deltaRaw = evidence === 'SUFFICIENT' && value !== null ? value - reference : null;
    return {
      key: axis,
      label: PLAYER_SKILL_AXIS_LABELS[axis],
      value: value === null ? null : rounded(Math.max(0, value)),
      reference: rounded(reference),
      delta: deltaRaw === null || Math.abs(deltaRaw) < 0.2 ? null : rounded(deltaRaw),
      evidence,
      samples: tested,
    };
  });
}

async function buildUncached(osuId: number): Promise<Record<string, any>> {
  const now = Date.now();
  const [user, collected, longTerm] = await Promise.all([
    getUserById(osuId, 'osu'),
    collectRecentScores(osuId, now),
    buildPlayerSkillProfilePayload(osuId, 50),
  ]);
  const enriched = await enrichScoreStarRatings(collected.scores, 'osu');
  const groups = groupRecentScores(enriched.scores);
  const completedGroups = groups.filter((group) => group.completed).length;
  if (completedGroups < MIN_COMPLETED_GROUPS) throw new Error(`RECENT_SKILL_INSUFFICIENT:${completedGroups}`);
  const failures: Array<{ beatmapId: number; reason: string }> = [];
  const analyzed = await mapLimit(groups, ANALYSIS_CONCURRENCY, async (group): Promise<RecentAnalyzedGroup | null> => {
    const score = bestAttempt(group);
    try {
      const totalStars = Number(score?.modded_star_rating ?? (group.mods.length ? NaN : score?.beatmap?.difficulty_rating));
      const analysis = await requestSkillProfilerAnalysisCachedWithFetch(group.beatmapId, group.mods);
      if (analysis?.status !== 'OK' || !analysis?.axes) throw new Error(`ANALYSIS_${analysis?.status || 'INVALID'}`);
      const demand = {} as Record<PlayerSkillAxis, number>;
      for (const axis of PLAYER_SKILL_AXES) demand[axis] = Number(analysis.axes?.[axis]?.stars);
      if (!validRecentDemand(totalStars, demand, score)) throw new Error('OUT_OF_DOMAIN');
      const quality = scoreAchievementQuality(score);
      const result = {} as Record<PlayerSkillAxis, number>;
      const failEvidence = recentFailureEvidence(score);
      for (const axis of PLAYER_SKILL_AXES) {
        result[axis] = demonstratedAxisValue(axis, demand[axis], quality) * (group.completed ? 1 : failEvidence);
      }
      const successfulAttempts = group.attempts.filter(recentScorePassed);
      const stability = group.attempts.length <= 1 ? 1 : 0.85 + 0.15 * successfulAttempts.length / group.attempts.length;
      return {
        completed: group.completed,
        recency: recentTimeWeight(Math.max(...group.attempts.map(scoreTime)), now),
        quality: quality.overall,
        stability,
        failureEvidence: failEvidence,
        demandAxes: demand,
        axes: result,
      };
    } catch (error: any) {
      failures.push({ beatmapId: group.beatmapId, reason: String(error?.message || error).slice(0, 120) });
      return null;
    }
  });
  const valid = analyzed.filter((item): item is RecentAnalyzedGroup => Boolean(item));
  const validCompleted = valid.filter((item) => item.completed).length;
  if (validCompleted < MIN_COMPLETED_GROUPS) throw new Error(`RECENT_SKILL_INSUFFICIENT_AFTER_FILTER:${validCompleted}`);
  const longTermProfile = (longTerm as any).profile || {};
  const axes = aggregateRecentSkillProfile(valid, Array.isArray(longTermProfile.axes) ? longTermProfile.axes : []);
  const stats: any = user.statistics || {};
  return {
    player: {
      osuId: user.id, username: user.username, avatarUrl: user.avatar_url,
      coverUrl: user.cover_url || user.avatar_url, countryCode: user.country_code || '',
      globalRank: stats.global_rank, pp: stats.pp, accuracy: stats.hit_accuracy,
    },
    sample: {
      fetched: collected.fetched, inWindow: collected.scores.length, groups: groups.length,
      completed: completedGroups, analyzed: valid.length, skipped: failures.length, failures,
      days: 5, targetCompleted: TARGET_COMPLETED_GROUPS,
    },
    profile: { mode: 'recent', axes, referenceMethod: 'BP50', recentMethod: 'Recent 50 → backfill up to 5 days · deduped map+mods · weighted upper evidence' },
  };
}

export async function buildPlayerRecentSkillProfilePayload(osuId: number): Promise<Record<string, any>> {
  const cached = recentCache.get(osuId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.payload;
  const existing = recentInflight.get(osuId);
  if (existing) return existing;
  const pending = buildUncached(osuId);
  recentInflight.set(osuId, pending);
  try {
    const payload = await pending;
    recentCache.set(osuId, { at: Date.now(), payload });
    return payload;
  } finally {
    if (recentInflight.get(osuId) === pending) recentInflight.delete(osuId);
  }
}

export async function renderPlayerRecentSkillProfile(osuId: number): Promise<{ buffer: Buffer; cqCode: string; payload: Record<string, any> }> {
  const payload = await buildPlayerRecentSkillProfilePayload(osuId);
  const buffer = await renderPlayerRecentSkillProfileCard(payload);
  return { buffer, cqCode: saveAndGetCqCode(buffer, 'skill'), payload };
}
