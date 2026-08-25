import { getUserBestScores, getUserById } from '../osu/api.js';
import { normalizedScoreMods } from '../osu/scoreMetrics.js';
import { requestSkillProfilerAnalysisWithFetch } from './skillProfiler.js';
import { getRenderServer, renderPanel } from './renderServer.js';
import { saveAndGetCqCode } from './render.js';

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

interface AnalyzedBp {
  rank: number;
  beatmapId: number;
  mods: string[];
  pp: number;
  accuracy: number;
  weight: number;
  axes: Record<PlayerSkillAxis, number>;
  primaryType: string;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function scoreMods(score: any): string[] {
  const normalized = normalizedScoreMods(score);
  if (normalized.includes('FL')) throw new Error('FL_UNSUPPORTED');
  return [...new Set(normalized
    .map((mod) => mod === 'NC' ? 'DT' : mod)
    .filter((mod) => SUPPORTED_PROFILER_MODS.has(mod)))]
    .sort((left, right) => PROFILER_MOD_ORDER.indexOf(left) - PROFILER_MOD_ORDER.indexOf(right));
}

function rounded(value: number, digits = 1): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function titleCase(value: unknown): string {
  return String(value || 'Balanced')
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function aggregatePlayerSkillProfile(analyzed: AnalyzedBp[]): {
  axes: Array<{ key: PlayerSkillAxis; label: string; ceiling: number; median: number }>;
  primaryAxes: string[];
  profileType: string;
} {
  if (!analyzed.length) throw new Error('PLAYER_SKILL_PROFILE_NO_VALID_BP');
  const axes = PLAYER_SKILL_AXES.map((axis) => {
    const samples = analyzed.map((item) => ({ value: item.axes[axis], weight: item.weight }));
    // BP20 is evidence, not a complete ability test. The weighted 80th percentile
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
    .sort((left, right) => (right.ceiling * 0.68 + right.median * 0.32) - (left.ceiling * 0.68 + left.median * 0.32))
    .slice(0, 2)
    .map((axis) => axis.label);
  const typeWeights = new Map<string, number>();
  for (const item of analyzed) {
    const type = titleCase(item.primaryType);
    typeWeights.set(type, (typeWeights.get(type) || 0) + item.weight);
  }
  const profileType = [...typeWeights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || 'Balanced';
  return { axes, primaryAxes, profileType };
}

export async function buildPlayerSkillProfilePayload(osuId: number, limit = 20): Promise<Record<string, unknown>> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const [user, scores] = await Promise.all([
    getUserById(osuId, 'osu'),
    getUserBestScores(osuId, 'osu', safeLimit),
  ]);
  const analyzed: AnalyzedBp[] = [];
  const failures: Array<{ rank: number; beatmapId: number; reason: string }> = [];
  const modCounts = new Map<string, number>();

  for (let index = 0; index < scores.slice(0, safeLimit).length; index += 1) {
    const score: any = scores[index];
    const rank = index + 1;
    const beatmapId = Number(score?.beatmap?.id || score?.beatmap_id || 0);
    try {
      if (!Number.isSafeInteger(beatmapId) || beatmapId <= 0) throw new Error('BEATMAP_ID_MISSING');
      const mods = scoreMods(score);
      const modLabel = mods.length ? mods.join('') : 'NM';
      modCounts.set(modLabel, (modCounts.get(modLabel) || 0) + 1);
      const analysis = await requestSkillProfilerAnalysisWithFetch(beatmapId, mods);
      if (analysis?.status !== 'OK' || !analysis?.axes) throw new Error(`ANALYSIS_${analysis?.status || 'INVALID'}`);
      const axisValues = {} as Record<PlayerSkillAxis, number>;
      for (const axis of PLAYER_SKILL_AXES) {
        const value = finite(analysis.axes?.[axis]?.stars);
        if (value === null) throw new Error(`AXIS_${axis.toUpperCase()}_MISSING`);
        axisValues[axis] = value;
      }
      analyzed.push({
        rank,
        beatmapId,
        mods,
        pp: finite(score?.pp) || 0,
        accuracy: (finite(score?.accuracy) || 0) * 100,
        weight: 0.95 ** index,
        axes: axisValues,
        primaryType: String(analysis?.archetype?.primary_type || 'BALANCED'),
      });
    } catch (error: any) {
      failures.push({ rank, beatmapId, reason: String(error?.message || error).slice(0, 160) });
    }
  }

  const aggregate = aggregatePlayerSkillProfile(analyzed);
  const stats: any = user.statistics || {};
  return {
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
      modCounts: [...modCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([mods, count]) => ({ mods, count })),
    },
    profile: {
      methodology: 'BP20 weighted P80 / weighted median',
      primaryAxes: aggregate.primaryAxes,
      profileType: aggregate.profileType,
      axes: aggregate.axes,
    },
  };
}

export async function renderPlayerSkillProfile(osuId: number, limit = 20): Promise<{
  buffer: Buffer;
  cqCode: string;
  payload: Record<string, unknown>;
} | null> {
  if (!getRenderServer().hasClients()) return null;
  const payload = await buildPlayerSkillProfilePayload(osuId, limit);
  const buffer = await renderPanel('panel_SkillPlayer', payload);
  return {
    buffer,
    cqCode: saveAndGetCqCode(buffer, 'skill'),
    payload,
  };
}
