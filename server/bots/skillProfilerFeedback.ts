import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../store.js';

export const SKILL_PROFILER_FEEDBACK_FILE = 'skill-profiler-feedback.jsonl';
export const MAX_SKILL_FEEDBACK_CHARS = 4_000;
const MAX_FEEDBACK_FILE_BYTES = 32 * 1024 * 1024;

export interface SkillProfilerFeedbackRecord {
  schemaVersion: 2;
  id: string;
  beatmapId: number;
  mods: string[];
  effectiveMods: string[];
  neutralMods: string[];
  message: string;
  groupId: string;
  userId: string;
  nickname: string;
  sourceMessageId: string;
  createdAt: string;
  analysis: Record<string, unknown> | null;
}

let appendQueue: Promise<void> = Promise.resolve();

export function skillProfilerFeedbackPath(): string {
  return path.join(getDataDir(), SKILL_PROFILER_FEEDBACK_FILE);
}

export function compactSkillProfilerSnapshot(analysis: any): Record<string, unknown> {
  const axes = Object.fromEntries(
    Object.entries(analysis?.axes || {}).map(([axis, raw]: [string, any]) => [axis, {
      stars: Number.isFinite(Number(raw?.stars)) ? Number(raw.stars) : null,
      confidence: String(raw?.confidence || 'UNKNOWN'),
      unit: String(raw?.unit || ''),
    }]),
  );
  return {
    beatmapId: Number(analysis?.beatmap?.beatmap_id || 0),
    title: String(analysis?.beatmap?.title || ''),
    version: String(analysis?.beatmap?.version || ''),
    mods: Array.isArray(analysis?.mod_context?.requested_mods)
      ? analysis.mod_context.requested_mods.map((mod: unknown) => String(mod))
      : Array.isArray(analysis?.mod_context?.effective_mods)
        ? analysis.mod_context.effective_mods.map((mod: unknown) => String(mod))
      : [],
    effectiveMods: Array.isArray(analysis?.mod_context?.effective_mods)
      ? analysis.mod_context.effective_mods.map((mod: unknown) => String(mod))
      : [],
    neutralMods: Array.isArray(analysis?.mod_context?.neutral_mods)
      ? analysis.mod_context.neutral_mods.map((mod: unknown) => String(mod))
      : [],
    axes,
    archetype: {
      status: String(analysis?.archetype?.status || 'UNKNOWN'),
      primaryType: String(analysis?.archetype?.primary_type || 'UNKNOWN'),
      dominantAxes: Array.isArray(analysis?.archetype?.dominant_axes)
        ? analysis.archetype.dominant_axes.map((axis: unknown) => String(axis))
        : [],
      confidence: String(analysis?.archetype?.confidence || 'UNKNOWN'),
    },
    algorithmId: String(analysis?.identity?.algorithm_id || 'UNKNOWN'),
    mapDemandVersion: String(analysis?.identity?.map_demand_version || 'UNKNOWN'),
  };
}

export async function appendSkillProfilerFeedback(
  record: SkillProfilerFeedbackRecord,
): Promise<void> {
  const filePath = skillProfilerFeedbackPath();
  const line = `${JSON.stringify(record)}\n`;
  const write = async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { /* first record */ }
    if (size + Buffer.byteLength(line, 'utf8') > MAX_FEEDBACK_FILE_BYTES) {
      throw new Error('SKILL_PROFILER_FEEDBACK_STORE_FULL');
    }
    await fs.promises.appendFile(filePath, line, { encoding: 'utf8', flag: 'a' });
  };
  const pending = appendQueue.then(write, write);
  appendQueue = pending.catch(() => undefined);
  return pending;
}
