import { getUserBestScores, getUserById } from '../osu/api.js';
import { normalizedScoreMods } from '../osu/scoreMetrics.js';
import {
  getSkillProfilerIdentity,
  requestSkillProfilerAnalysisCachedWithFetch,
  type SkillProfilerIdentity,
} from './skillProfiler.js';
import { saveAndGetCqCode } from './render.js';
import { renderPlayerSkillComparisonCard, renderPlayerSkillProfileCard } from './playerSkillComparisonCard.js';

export const PLAYER_SKILL_AXES = [
  'aim_control',
  'jump_aim',
  'spatial_precision',
  'flow_aim',
  'raw_speed',
  'finger_control',
  'stamina',
  'endurance',
  'reading',
] as const;

export type PlayerSkillAxis = typeof PLAYER_SKILL_AXES[number];

export const PLAYER_SKILL_TIERS = ['BEGINNER', 'PLAYER', 'EXPERT', 'WORLD_CLASS'] as const;
export type PlayerSkillTier = typeof PLAYER_SKILL_TIERS[number];
export type PlayerSkillRatingStatus = 'RATED' | 'INSUFFICIENT_EVIDENCE';

export const PLAYER_SKILL_ARCHETYPES = [
  'ALL_ROUNDER',
  'AIM',
  'JUMP',
  'FLOW',
  'PRECISION',
  'CONTROL',
  'FLOW_SPEED',
  'SPEED',
  'RHYTHM',
  'STAMINA',
  'ENDURANCE',
  'READING',
  'TECH',
] as const;
export type PlayerSkillArchetype = typeof PLAYER_SKILL_ARCHETYPES[number];

export const PLAYER_SKILL_TITLE_POLICY_ID = 'AGGREGATE_SPECIALTY_FOUR_TIER_TITLES_V01';

export const PLAYER_SKILL_ARCHETYPE_LABELS: Readonly<Record<PlayerSkillArchetype, string>> = {
  ALL_ROUNDER: 'All-Rounder',
  AIM: 'Aim',
  JUMP: 'Jump Aim',
  FLOW: 'Flow Aim',
  PRECISION: 'Precision Aim',
  CONTROL: 'Aim Control',
  FLOW_SPEED: 'Flow Speed',
  SPEED: 'Speed',
  RHYTHM: 'Rhythm Control',
  STAMINA: 'Stamina',
  ENDURANCE: 'Endurance',
  READING: 'Reading',
  TECH: 'Technical',
};

export const PLAYER_SKILL_TITLES: Readonly<Record<
  PlayerSkillArchetype,
  Readonly<Record<PlayerSkillTier, string>>
>> = {
  ALL_ROUNDER: { BEGINNER: 'BEGINNER', PLAYER: 'ALL-ROUNDER', EXPERT: 'COMPLETE PLAYER', WORLD_CLASS: 'MASTER OF ALL' },
  AIM: { BEGINNER: 'BEGINNER', PLAYER: 'AIM ALL-ROUNDER', EXPERT: 'AIM VIRTUOSO', WORLD_CLASS: 'GOD OF AIM' },
  JUMP: { BEGINNER: 'BEGINNER', PLAYER: 'JUMP PLAYER', EXPERT: 'AIM ACE', WORLD_CLASS: 'GOD OF AIM' },
  FLOW: { BEGINNER: 'BEGINNER', PLAYER: 'FLOW PLAYER', EXPERT: 'FLOW SPECIALIST', WORLD_CLASS: 'FLOW SOVEREIGN' },
  PRECISION: { BEGINNER: 'BEGINNER', PLAYER: 'PRECISION PLAYER', EXPERT: 'SHARPSHOOTER', WORLD_CLASS: 'PIXEL PERFECT' },
  CONTROL: { BEGINNER: 'BEGINNER', PLAYER: 'AIM TECHNICIAN', EXPERT: 'CURSOR TACTICIAN', WORLD_CLASS: 'CURSOR ARCHITECT' },
  FLOW_SPEED: { BEGINNER: 'BEGINNER', PLAYER: 'STREAM PLAYER', EXPERT: 'STREAM ACE', WORLD_CLASS: 'STREAM SOVEREIGN' },
  SPEED: { BEGINNER: 'BEGINNER', PLAYER: 'SPEED PLAYER', EXPERT: 'SPEED DEMON', WORLD_CLASS: 'SPEED INCARNATE' },
  RHYTHM: { BEGINNER: 'BEGINNER', PLAYER: 'TAPPING PLAYER', EXPERT: 'TAPPING VIRTUOSO', WORLD_CLASS: 'HUMAN METRONOME' },
  STAMINA: { BEGINNER: 'BEGINNER', PLAYER: 'STAMINA PLAYER', EXPERT: 'IRON FINGERS', WORLD_CLASS: 'ENDLESS ENGINE' },
  ENDURANCE: { BEGINNER: 'BEGINNER', PLAYER: 'MARATHON PLAYER', EXPERT: 'ENDURANCE ACE', WORLD_CLASS: 'THE UNBREAKABLE' },
  READING: { BEGINNER: 'BEGINNER', PLAYER: 'SIGHTREADER', EXPERT: 'READING SAVANT', WORLD_CLASS: 'ALL-SEEING' },
  TECH: { BEGINNER: 'BEGINNER', PLAYER: 'TECH PLAYER', EXPERT: 'TECH SPECIALIST', WORLD_CLASS: 'MECHANICAL GENIUS' },
};

export const PLAYER_SKILL_AXIS_LABELS: Readonly<Record<PlayerSkillAxis, string>> = {
  aim_control: 'Aim Control',
  jump_aim: 'Jump Aim',
  spatial_precision: 'Micro Precision',
  flow_aim: 'Flow Aim',
  raw_speed: 'Raw Speed',
  finger_control: 'Finger Control',
  stamina: 'Stamina',
  endurance: 'Endurance',
  reading: 'Reading',
};

const SUPPORTED_PROFILER_MODS = new Set(['NF', 'EZ', 'HD', 'HR', 'SD', 'HT', 'DT', 'PF']);
const PROFILER_MOD_ORDER = ['NF', 'EZ', 'HD', 'HR', 'SD', 'DT', 'HT', 'PF'];

interface WeightedValue {
  value: number;
  weight: number;
}

export interface ScoreAchievementQuality {
  accuracy: number;
  comboRatio: number;
  missRate: number;
  fullCombo: boolean;
  accuracyQuality: number;
  comboQuality: number;
  missQuality: number;
  overall: number;
}

export interface AnalyzedBp {
  rank: number;
  beatmapId: number;
  mods: string[];
  pp: number;
  accuracy: number;
  weight: number;
  scoreQuality?: ScoreAchievementQuality;
  axes: Record<PlayerSkillAxis, number>;
  demandAxes?: Record<PlayerSkillAxis, number>;
  primaryType: string;
}

const PLAYER_PROFILE_LIMIT = 50;
const BP_RANK_DECAY = 0.95;
const PROFILE_ANALYSIS_CONCURRENCY = 3;
const PLAYER_PROFILE_CACHE_TTL_MS = 30 * 60_000;
const playerProfileCache = new Map<string, { at: number; payload: Record<string, unknown> }>();
const STAR_EQUIVALENT_PLAYER_AXES = new Set<PlayerSkillAxis>([
  'aim_control',
  'jump_aim',
  'spatial_precision',
  'flow_aim',
  'raw_speed',
  'finger_control',
  'reading',
]);

export type AggregatedPlayerAxis = {
  key: PlayerSkillAxis;
  label: string;
  ceiling: number;
  median: number;
};

export interface PlayerSkillIdentity {
  status: PlayerSkillRatingStatus;
  tier: PlayerSkillTier | null;
  archetype: PlayerSkillArchetype;
  title: string;
  tierScore: number;
}

export interface PlayerSkillEvidenceSummary {
  sampleCount: number;
  effectiveSampleSize: number;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const bounded = clamp01(value);
  return bounded * bounded * (3 - 2 * bounded);
}

function scoreHitObjectCount(score: any): number {
  const statistics = score?.statistics || {};
  const counts = [
    statistics.count_300 ?? statistics.great,
    statistics.count_100 ?? statistics.ok,
    statistics.count_50 ?? statistics.meh,
    statistics.count_miss ?? statistics.miss,
  ].map((value) => Math.max(0, Number(value || 0)));
  return counts.reduce((sum, value) => sum + value, 0);
}

function estimatedBeatmapMaxCombo(score: any, objectCount: number): number {
  const reported = Math.max(0, Number(score?.beatmap?.max_combo || 0));
  if (reported > 0) return reported;
  const circles = Math.max(0, Number(score?.beatmap?.count_circles || 0));
  const sliders = Math.max(0, Number(score?.beatmap?.count_sliders || 0));
  const spinners = Math.max(0, Number(score?.beatmap?.count_spinners || 0));
  // The v2 best-score response does not expose beatmap.max_combo. A standard
  // slider contributes its head, tail and usually at least part of one repeat /
  // tick chain, so 2.5 is a deliberately conservative estimator. This keeps a
  // low-combo hard-map pass from looking like an FC merely because hit-object
  // count is much smaller than real combo.
  const estimated = circles + sliders * 2.5 + spinners;
  return estimated > 0 ? Math.max(objectCount, estimated) : objectCount;
}

export function scoreAchievementQuality(score: any): ScoreAchievementQuality {
  const rawAccuracy = Math.max(0, Number(score?.accuracy || 0));
  const accuracy = rawAccuracy > 1 ? rawAccuracy / 100 : rawAccuracy;
  const objectCount = scoreHitObjectCount(score);
  const maximumCombo = estimatedBeatmapMaxCombo(score, objectCount);
  const comboDenominator = maximumCombo > 0 ? maximumCombo : objectCount;
  const comboRatio = comboDenominator > 0
    ? clamp01(Number(score?.max_combo || 0) / comboDenominator)
    : 0;
  const missCount = Math.max(0, Number(score?.statistics?.count_miss ?? score?.statistics?.miss ?? 0));
  const missRate = objectCount > 0 ? clamp01(missCount / objectCount) : (missCount > 0 ? 1 : 0);
  const fullCombo = missCount === 0 && (score?.perfect === true || comboRatio >= 0.985);
  const accuracyQuality = smoothstep((accuracy - 0.75) / 0.245);
  const comboQuality = Math.sqrt(comboRatio);
  const missQuality = Math.exp(-missRate * 36);
  const overall = clamp01(accuracyQuality * 0.40 + comboQuality * 0.40 + missQuality * 0.20);
  return {
    accuracy: rounded(accuracy * 100, 2),
    comboRatio: rounded(comboRatio, 3),
    missRate: rounded(missRate, 4),
    fullCombo,
    accuracyQuality: rounded(accuracyQuality, 3),
    comboQuality: rounded(comboQuality, 3),
    missQuality: rounded(missQuality, 3),
    overall: rounded(overall, 3),
  };
}

const AXIS_QUALITY_WEIGHTS: Readonly<Record<PlayerSkillAxis, readonly [number, number, number]>> = {
  aim_control: [0.25, 0.55, 0.20],
  jump_aim: [0.15, 0.65, 0.20],
  spatial_precision: [0.25, 0.55, 0.20],
  flow_aim: [0.25, 0.50, 0.25],
  raw_speed: [0.65, 0.15, 0.20],
  finger_control: [0.65, 0.15, 0.20],
  stamina: [0.55, 0.20, 0.25],
  endurance: [0.35, 0.35, 0.30],
  reading: [0.30, 0.45, 0.25],
};

export function demonstratedAxisValue(axis: PlayerSkillAxis, demand: number, quality: ScoreAchievementQuality): number {
  const demandValue = Math.max(0, Number(demand || 0));
  const [accuracyWeight, comboWeight, missWeight] = AXIS_QUALITY_WEIGHTS[axis];
  const evidence = clamp01(
    quality.accuracyQuality * accuracyWeight
    + quality.comboQuality * comboWeight
    + quality.missQuality * missWeight
  );
  // A pass on a hard map still proves something, so the score never erases the
  // map demand. It cannot, however, claim the full demand without a convincing
  // ACC/combo/miss result. Repeated strong maps can still establish a specialty.
  const achievementMultiplier = 0.50 + 0.50 * Math.pow(evidence, 0.85);
  // Low ACC and low combo are a joint failure signal. On extreme maps, keeping
  // a fixed percentage of raw demand lets a barely survived pass inflate the
  // player ceiling forever. A reciprocal denominator makes that contribution
  // approach a finite ceiling as demand rises, while one weak signal alone does
  // not trigger the same collapse.
  const jointFailure = (1 - quality.accuracyQuality) * (1 - quality.comboQuality);
  const extremeDemandLoad = Math.max(0, demandValue - 6) / 4;
  const reciprocalRetention = 1 / (1 + 1.25 * jointFailure * extremeDemandLoad);

  // A genuinely excellent FC is positive evidence rather than merely the
  // absence of a penalty. Keep the bonus deliberately small and continuous so
  // 99%+ FCs can edge above map demand without starting another inflation loop.
  const excellence = quality.fullCombo && quality.accuracy >= 99
    ? smoothstep((quality.accuracy - 98.5) / 1.2)
    : 0;
  const excellenceBonus = 1 + 0.04 * excellence;
  return demandValue * achievementMultiplier * reciprocalRetention * excellenceBonus;
}

export function bpRankWeight(rank: number): number {
  return BP_RANK_DECAY ** Math.max(0, Math.floor(Number(rank) || 1) - 1);
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function weightedQuantile(values: WeightedValue[], quantile: number): number | null {
  const sorted = values
    .filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((left, right) => left.value - right.value);
  if (!sorted.length) return null;
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = Math.max(0, Math.min(1, quantile)) * total;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= target) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

export function scoreMods(score: any): string[] {
  const normalized = normalizedScoreMods(score);
  if (normalized.includes('FL')) throw new Error('FL_UNSUPPORTED');
  return [...new Set(normalized
    .map((mod) => mod === 'NC' ? 'DT' : mod)
    .filter((mod) => SUPPORTED_PROFILER_MODS.has(mod)))]
    .sort((left, right) => PROFILER_MOD_ORDER.indexOf(left) - PROFILER_MOD_ORDER.indexOf(right));
}

export function rounded(value: number, digits = 1): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function playerAxisStrength(axis: AggregatedPlayerAxis): number {
  return axis.ceiling * 0.68 + axis.median * 0.32;
}

function playerWorldStrength(axis: AggregatedPlayerAxis): number {
  const ceilingCap = STAR_EQUIVALENT_PLAYER_AXES.has(axis.key) ? 10 : 8.8;
  return Math.min(axis.ceiling, ceilingCap) * 0.68 + axis.median * 0.32;
}

function pairIncludes(pair: ReadonlySet<PlayerSkillAxis>, left: PlayerSkillAxis, right: PlayerSkillAxis): boolean {
  return pair.size === 2 && pair.has(left) && pair.has(right);
}

function singleAxisArchetype(axis: PlayerSkillAxis): PlayerSkillArchetype {
  if (axis === 'jump_aim') return 'JUMP';
  if (axis === 'flow_aim') return 'FLOW';
  if (axis === 'spatial_precision') return 'PRECISION';
  if (axis === 'aim_control') return 'CONTROL';
  if (axis === 'raw_speed') return 'SPEED';
  if (axis === 'finger_control') return 'RHYTHM';
  if (axis === 'stamina') return 'STAMINA';
  if (axis === 'endurance') return 'ENDURANCE';
  return 'READING';
}

function pairedAxisArchetype(top: PlayerSkillAxis, second: PlayerSkillAxis): PlayerSkillArchetype {
  const pair = new Set<PlayerSkillAxis>([top, second]);
  if (pairIncludes(pair, 'flow_aim', 'raw_speed')) return 'FLOW_SPEED';
  if (pairIncludes(pair, 'flow_aim', 'finger_control')) return 'TECH';
  if (
    pairIncludes(pair, 'jump_aim', 'spatial_precision')
    || pairIncludes(pair, 'jump_aim', 'aim_control')
    || pairIncludes(pair, 'jump_aim', 'flow_aim')
    || pairIncludes(pair, 'aim_control', 'spatial_precision')
    || pairIncludes(pair, 'flow_aim', 'aim_control')
    || pairIncludes(pair, 'flow_aim', 'spatial_precision')
  ) {
    return 'AIM';
  }
  if (pairIncludes(pair, 'raw_speed', 'finger_control')) return 'RHYTHM';
  if (
    pairIncludes(pair, 'raw_speed', 'stamina')
    || pairIncludes(pair, 'raw_speed', 'endurance')
  ) {
    return 'SPEED';
  }
  if (
    pairIncludes(pair, 'flow_aim', 'stamina')
    || pairIncludes(pair, 'flow_aim', 'endurance')
  ) {
    return 'FLOW';
  }
  if (pairIncludes(pair, 'stamina', 'endurance')) return 'ENDURANCE';
  if (
    pairIncludes(pair, 'reading', 'finger_control')
    || pairIncludes(pair, 'reading', 'aim_control')
    || pairIncludes(pair, 'reading', 'spatial_precision')
  ) {
    return 'TECH';
  }
  return singleAxisArchetype(top);
}

export function inferPlayerSkillIdentity(
  axes: AggregatedPlayerAxis[],
  evidence: PlayerSkillEvidenceSummary = { sampleCount: 50, effectiveSampleSize: 50 },
): PlayerSkillIdentity {
  if (!axes.length) throw new Error('PLAYER_SKILL_IDENTITY_NO_AXES');
  const ranked = [...axes]
    .map((axis) => ({ ...axis, strength: playerAxisStrength(axis) }))
    .sort((left, right) => (
      right.strength - left.strength
      || PLAYER_SKILL_AXES.indexOf(left.key) - PLAYER_SKILL_AXES.indexOf(right.key)
    ));
  const top = ranked[0];
  const second = ranked[1] || top;
  const breadth = ranked[Math.min(6, ranked.length - 1)].strength;
  const tierScore = top.strength;

  let archetype: PlayerSkillArchetype;
  if (top.strength - breadth <= 0.8) {
    archetype = 'ALL_ROUNDER';
  } else {
    const coPrimary = top.strength - second.strength <= 1.0
      && second.strength >= top.strength * 0.82;
    archetype = coPrimary
      ? pairedAxisArchetype(top.key, second.key)
      : singleAxisArchetype(top.key);
  }

  const rated = evidence.sampleCount >= 12 && evidence.effectiveSampleSize >= 10;
  if (!rated) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      tier: null,
      archetype,
      title: 'UNRATED',
      tierScore: rounded(tierScore, 2),
    };
  }

  let tier: PlayerSkillTier;
  if (tierScore < 3.5) {
    tier = 'BEGINNER';
  } else {
    // World titles require a full-enough profile in addition to the P80/P50
    // shape.  The first route rewards an exceptional repeated specialty; the
    // second covers genuinely world-class broad players whose axes stay just
    // below 10 instead of requiring artificial overflow.
    const worldSupport = evidence.sampleCount >= 30 && evidence.effectiveSampleSize >= 20;
    const exceptionalSpecialty = ranked.slice(0, 2).some((axis) => {
      if (STAR_EQUIVALENT_PLAYER_AXES.has(axis.key)) {
        // Overflow remains visible on the card, but it must not let four narrow
        // outliers manufacture a world title without a strong BP50 baseline.
        return axis.ceiling >= 10 && playerWorldStrength(axis) >= 9;
      }
      return axis.ceiling >= 8.8 && playerWorldStrength(axis) >= 8.2;
    });
    const broadWorldClass = top.ceiling >= 9
      && top.median >= 6.5
      && playerWorldStrength(top) >= 8.5
      && playerWorldStrength(second) >= 7.5;
    if (worldSupport && (exceptionalSpecialty || broadWorldClass)) tier = 'WORLD_CLASS';
    else if (tierScore >= 6.5) tier = 'EXPERT';
    else tier = 'PLAYER';
  }
  return {
    status: 'RATED',
    tier,
    archetype,
    title: PLAYER_SKILL_TITLES[archetype][tier],
    tierScore: rounded(tierScore, 2),
  };
}

export function playerProfileCacheKey(
  osuId: number,
  limit: number,
  identity: SkillProfilerIdentity,
): string {
  return JSON.stringify([
    PLAYER_SKILL_TITLE_POLICY_ID,
    identity.algorithmId,
    identity.mapDemandVersion,
    osuId,
    limit,
  ]);
}

export function aggregatePlayerSkillProfile(analyzed: AnalyzedBp[]): {
  axes: AggregatedPlayerAxis[];
  primaryAxes: string[];
  profileType: string;
  profileTitle: string;
  profileStatus: PlayerSkillRatingStatus;
  profileTier: PlayerSkillTier | null;
  profileArchetype: PlayerSkillArchetype;
  profileTierScore: number;
} {
  if (!analyzed.length) throw new Error('PLAYER_SKILL_PROFILE_NO_VALID_BP');
  const axes = PLAYER_SKILL_AXES.map((axis) => {
    const samples = analyzed.map((item) => ({ value: item.axes[axis], weight: item.weight }));
    // BP50 is evidence, not a complete ability test. The weighted 80th percentile
    // keeps a player's demonstrated strengths visible without letting one outlier
    // dictate the whole card. The weighted median is the breadth/normal polygon.
    const ceiling = weightedQuantile(samples, 0.80) ?? 0;
    const median = weightedQuantile(samples, 0.50) ?? 0;
    return {
      key: axis,
      label: PLAYER_SKILL_AXIS_LABELS[axis],
      // Keep the real aggregate. The renderer owns the non-linear overflow
      // projection; 10 remains the reference frame, not a destructive clamp.
      ceiling: rounded(Math.max(0, ceiling)),
      median: rounded(Math.max(0, median)),
    };
  });
  const primaryAxes = [...axes]
    .sort((left, right) => playerAxisStrength(right) - playerAxisStrength(left))
    .slice(0, 2)
    .map((axis) => axis.label);
  const positiveWeights = analyzed
    .map((item) => Number(item.weight))
    .filter((weight) => Number.isFinite(weight) && weight > 0);
  const weightSum = positiveWeights.reduce((sum, weight) => sum + weight, 0);
  const squaredWeightSum = positiveWeights.reduce((sum, weight) => sum + weight * weight, 0);
  const effectiveSampleSize = squaredWeightSum > 0 ? weightSum * weightSum / squaredWeightSum : 0;
  const identity = inferPlayerSkillIdentity(axes, {
    sampleCount: analyzed.length,
    effectiveSampleSize,
  });
  return {
    axes,
    primaryAxes,
    // Keep type and title separate: type names the aggregate specialty, while
    // title adds the evidence tier.  Neither is a vote over per-map labels.
    profileType: PLAYER_SKILL_ARCHETYPE_LABELS[identity.archetype],
    profileTitle: identity.title,
    profileStatus: identity.status,
    profileTier: identity.tier,
    profileArchetype: identity.archetype,
    profileTierScore: identity.tierScore,
  };
}

export async function buildPlayerSkillProfilePayload(osuId: number, limit = PLAYER_PROFILE_LIMIT): Promise<Record<string, unknown>> {
  const safeLimit = Math.max(1, Math.min(PLAYER_PROFILE_LIMIT, Math.floor(limit)));
  const profilerIdentity = await getSkillProfilerIdentity();
  const cacheKey = playerProfileCacheKey(osuId, safeLimit, profilerIdentity);
  const cached = playerProfileCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PLAYER_PROFILE_CACHE_TTL_MS) return cached.payload;
  const [user, scores] = await Promise.all([
    getUserById(osuId, 'osu'),
    getUserBestScores(osuId, 'osu', safeLimit),
  ]);
  const analyzed: AnalyzedBp[] = [];
  const failures: Array<{ rank: number; beatmapId: number; reason: string }> = [];
  const modCounts = new Map<string, number>();

  const scoreResults = await mapLimit(scores.slice(0, safeLimit), PROFILE_ANALYSIS_CONCURRENCY, async (score: any, index) => {
    const rank = index + 1;
    const beatmapId = Number(score?.beatmap?.id || score?.beatmap_id || 0);
    try {
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error('BEATMAP_ID_MISSING');
      const mods = scoreMods(score);
      const modLabel = mods.length ? mods.join('') : 'NM';
      const analysis = await requestSkillProfilerAnalysisCachedWithFetch(beatmapId, mods);
      if (analysis?.status !== 'OK' || !analysis?.axes) throw new Error(`ANALYSIS_${analysis?.status || 'INVALID'}`);
      const quality = scoreAchievementQuality(score);
      const demandAxes = {} as Record<PlayerSkillAxis, number>;
      const demonstratedAxes = {} as Record<PlayerSkillAxis, number>;
      for (const axis of PLAYER_SKILL_AXES) {
        const value = finite(analysis.axes?.[axis]?.stars);
        if (value === null) throw new Error(`AXIS_${axis.toUpperCase()}_MISSING`);
        demandAxes[axis] = value;
        demonstratedAxes[axis] = demonstratedAxisValue(axis, value, quality);
      }
      return { ok: true as const, modLabel, analyzed: {
        rank,
        beatmapId,
        mods,
        pp: finite(score?.pp) || 0,
        accuracy: quality.accuracy,
        weight: bpRankWeight(rank),
        scoreQuality: quality,
        axes: demonstratedAxes,
        demandAxes,
        primaryType: String(analysis?.archetype?.primary_type || 'BALANCED'),
      } satisfies AnalyzedBp };
    } catch (error: any) {
      return { ok: false as const, failure: { rank, beatmapId, reason: String(error?.message || error).slice(0, 160) } };
    }
  });
  for (const result of scoreResults) {
    if (result.ok) {
      analyzed.push(result.analyzed);
      modCounts.set(result.modLabel, (modCounts.get(result.modLabel) || 0) + 1);
    } else {
      failures.push(result.failure);
    }
  }

  const aggregate = aggregatePlayerSkillProfile(analyzed);
  const stats: any = user.statistics || {};
  const payload = {
    player: {
      osuId: user.id,
      username: user.username,
      avatarUrl: user.avatar_url,
      coverUrl: user.cover_url || user.avatar_url,
      countryCode: user.country_code || '',
      globalRank: finite(stats.global_rank),
      countryRank: finite(stats.country_rank),
      pp: finite(stats.pp),
      accuracy: finite(stats.hit_accuracy),
    },
    sample: {
      requested: safeLimit,
      valid: analyzed.length,
      failed: failures.length,
      failures,
      averageScoreQuality: rounded(
        analyzed.reduce((sum, item) => sum + Number(item.scoreQuality?.overall || 0), 0) / Math.max(1, analyzed.length),
        3,
      ),
      bpRankDecay: BP_RANK_DECAY,
      modCounts: [...modCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([mods, count]) => ({ mods, count })),
    },
    profile: {
      methodology: 'BP50 score-adjusted demand · reciprocal low-ACC×low-combo hard-demand penalty · FC excellence ≤4% · 0.95^(rank-1) · weighted P80/P50 · aggregate specialty four-tier title',
      primaryAxes: aggregate.primaryAxes,
      profileType: aggregate.profileType,
      profileTitle: aggregate.profileTitle,
      profileStatus: aggregate.profileStatus,
      profileTier: aggregate.profileTier,
      profileArchetype: aggregate.profileArchetype,
      profileTierScore: aggregate.profileTierScore,
      titlePolicy: PLAYER_SKILL_TITLE_POLICY_ID,
      profilerIdentity,
      axes: aggregate.axes,
    },
  };
  playerProfileCache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}

export async function renderPlayerSkillProfile(osuId: number, limit = PLAYER_PROFILE_LIMIT): Promise<{
  buffer: Buffer;
  cqCode: string;
  payload: Record<string, unknown>;
} | null> {
  const payload = await buildPlayerSkillProfilePayload(osuId, limit);
  const buffer = await renderPlayerSkillProfileCard(payload);
  return {
    buffer,
    cqCode: saveAndGetCqCode(buffer, 'skill'),
    payload,
  };
}

export async function renderPlayerSkillComparison(leftOsuId: number, rightOsuId: number, limit = PLAYER_PROFILE_LIMIT): Promise<{
  buffer: Buffer;
  cqCode: string;
  payload: Record<string, unknown>;
} | null> {
  const [left, right] = await Promise.all([
    buildPlayerSkillProfilePayload(leftOsuId, limit),
    buildPlayerSkillProfilePayload(rightOsuId, limit),
  ]);
  const payload = { left, right, limit };
  const buffer = await renderPlayerSkillComparisonCard(payload);
  return {
    buffer,
    cqCode: saveAndGetCqCode(buffer, 'skill'),
    payload,
  };
}
