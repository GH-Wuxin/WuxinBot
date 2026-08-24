import { getRenderServer, renderPanel } from './renderServer.js';
import { saveAndGetCqCode } from './render.js';

const AXIS_LABELS: Readonly<Record<string, string>> = {
  aim_control: 'Aim Control',
  jump_aim: 'Jump Aim',
  spatial_precision: 'Spatial Precision',
  flow_aim: 'Flow Aim',
  raw_speed: 'Raw Speed',
  finger_control: 'Finger Control',
  stamina: 'Stamina',
  endurance: 'Endurance',
  reading: 'Reading',
};

const AIM_AXES = ['aim_control', 'jump_aim', 'spatial_precision', 'flow_aim'];
const TAPPING_AXES = ['raw_speed', 'finger_control', 'stamina', 'endurance'];

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function difficultyValue(difficulty: any, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finite(difficulty?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function requestedMods(modContext: any): string[] {
  const mods = Array.isArray(modContext?.requested_mods) && modContext.requested_mods.length
    ? modContext.requested_mods
    : modContext?.effective_mods;
  const normalized = Array.isArray(mods)
    ? mods.map((mod) => String(mod).trim().toUpperCase()).filter(Boolean)
    : [];
  return normalized.length ? normalized : ['NM'];
}

function axisCard(analysis: any, axis: string): Record<string, unknown> {
  const item = analysis?.axes?.[axis] || {};
  return {
    key: axis,
    label: AXIS_LABELS[axis] || axis,
    value: finite(item.stars),
    confidence: String(item.confidence || 'UNKNOWN'),
    unit: item.unit === 'bounded_0_10' ? 'bounded_0_10' : 'star_equivalent',
  };
}

function readableAxis(value: unknown): string {
  const key = String(value || '');
  return AXIS_LABELS[key] || key.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstWarning(analysis: any): string {
  const warning = Array.isArray(analysis?.warnings) ? analysis.warnings.find(Boolean) : null;
  if (!warning) return '';
  if (typeof warning === 'string') return warning;
  return String(warning?.message || warning?.code || '');
}

export function buildSkillProfilerCardPayload(analysis: any): Record<string, unknown> {
  if (analysis?.status !== 'OK' || !analysis?.beatmap || !analysis?.axes) {
    throw new Error('SKILL_PROFILER_CARD_ANALYSIS_INVALID');
  }
  const beatmap = analysis.beatmap;
  const context = analysis.analysis_context || {};
  const difficulty = context.difficulty || beatmap.metadata?.difficulty || {};
  const setId = finite(beatmap.beatmapset_id);
  const mods = requestedMods(analysis.mod_context);
  const neutralMods = Array.isArray(analysis?.mod_context?.neutral_mods)
    ? analysis.mod_context.neutral_mods.map((mod: unknown) => String(mod).toUpperCase()).filter(Boolean)
    : [];
  const archetype = analysis.archetype || {};
  return {
    beatmap: {
      beatmapId: finite(beatmap.beatmap_id),
      beatmapsetId: setId,
      artist: String(beatmap.artist || ''),
      title: String(beatmap.title || ''),
      version: String(beatmap.version || ''),
      creator: String(beatmap.creator || ''),
      coverUrl: setId && setId > 0 ? `https://assets.ppy.sh/beatmaps/${setId}/covers/cover.jpg` : '',
      stars: finite(beatmap.local_nm_stars),
      bpm: finite(context.bpm_max),
      lengthSeconds: finite(context.duration_ms) === null ? null : Number(context.duration_ms) / 1000,
      ar: difficultyValue(difficulty, 'ApproachRate', 'AR', 'ar'),
      od: difficultyValue(difficulty, 'OverallDifficulty', 'OD', 'od'),
      cs: difficultyValue(difficulty, 'CircleSize', 'CS', 'cs'),
      hp: difficultyValue(difficulty, 'HPDrainRate', 'HP', 'hp'),
    },
    analysis: {
      mods: mods.join(''),
      neutralMods: neutralMods.join('/'),
      primaryType: String(archetype.primary_type || 'UNCLASSIFIED').replaceAll('_', ' '),
      dominantAxes: Array.isArray(archetype.dominant_axes)
        ? archetype.dominant_axes.map(readableAxis)
        : [],
      warning: firstWarning(analysis),
    },
    groups: {
      aim: AIM_AXES.map((axis) => axisCard(analysis, axis)),
      tapping: TAPPING_AXES.map((axis) => axisCard(analysis, axis)),
      reading: [axisCard(analysis, 'reading')],
    },
  };
}

export async function renderSkillProfilerCard(
  analysis: any,
): Promise<{ buffer: Buffer; cqCode: string } | null> {
  if (!getRenderServer().hasClients()) return null;
  try {
    const payload = buildSkillProfilerCardPayload(analysis);
    const buffer = await renderPanel('panel_Skill', payload);
    return { buffer, cqCode: saveAndGetCqCode(buffer, 'skill') };
  } catch (error) {
    console.error('[render] panel_Skill failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
