// Shared star-rating enrichment. Both the osu! collector and the internal
// executor paths enrich modded scores through the official beatmap-attributes
// endpoint; this is the single implementation both of them use.

import { normalizedScoreMods } from './scoreMetrics.js';
import type { OsuMode, OsuScore } from './types.js';

export type BeatmapAttributeFetcher = (
  beatmapId: number,
  mode: OsuMode,
  mods: string[],
) => Promise<{ attributes?: { star_rating?: number } }>;

const STAR_ATTRIBUTE_CONCURRENCY = 8;

interface StarAttributeTask {
  key: string;
  beatmapId: number;
  mods: string[];
}

function scoreModAcronyms(score: OsuScore): string[] {
  const rawMods: unknown[] = Array.isArray((score as any).mods)
    ? (score as any).mods
    : [];
  const acronyms = rawMods
    .map((mod): string => {
      if (typeof mod === 'string') return mod;
      if (mod && typeof mod === 'object' && 'acronym' in mod) {
        return String((mod as { acronym?: unknown }).acronym || '');
      }
      return '';
    })
    .map((mod) => mod.toUpperCase())
    .filter((mod) => mod && mod !== 'NM');
  return [...new Set<string>(acronyms)];
}

function scoreMods(score: OsuScore): string[] {
  return normalizedScoreMods({
    mods: scoreModAcronyms(score),
  } as Pick<OsuScore, 'mods'>);
}

function starAttributeKey(score: OsuScore, mode: OsuMode): string | null {
  const beatmapId = Number(score.beatmap?.id || 0);
  if (beatmapId <= 0) return null;
  return `${beatmapId}:${mode}:${scoreMods(score).join(',')}`;
}

/**
 * Enrich score stars with osu!'s official beatmap-attributes endpoint. A
 * modded score whose attributes request fails is marked unavailable so its
 * base difficulty can never masquerade as the played difficulty.
 */
export async function enrichScoreStarRatings(
  scores: OsuScore[],
  mode: OsuMode,
  fetchAttributes?: BeatmapAttributeFetcher,
): Promise<{ scores: OsuScore[]; failed: number }> {
  const attributeFetcher =
    fetchAttributes || (await import('./api.js')).getBeatmapAttributes;

  const tasks = new Map<string, StarAttributeTask>();
  for (const score of scores) {
    const mods = scoreMods(score);
    if (mods.length === 0) continue;
    const key = starAttributeKey(score, mode);
    if (!key || tasks.has(key)) continue;
    tasks.set(key, { key, beatmapId: Number(score.beatmap.id), mods });
  }

  const ratings = new Map<string, number>();
  const failedKeys = new Set<string>();
  const pending = [...tasks.values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const task = pending[cursor++];
      try {
        const result = await attributeFetcher(task.beatmapId, mode, task.mods);
        const starRating = Number(result.attributes?.star_rating || 0);
        if (starRating <= 0) throw new Error('star_rating 缺失');
        ratings.set(task.key, starRating);
      } catch {
        failedKeys.add(task.key);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(STAR_ATTRIBUTE_CONCURRENCY, pending.length) },
      () => worker(),
    ),
  );

  return {
    scores: scores.map((score) => {
      const mods = scoreMods(score);
      if (mods.length === 0) {
        return { ...score, star_rating_source: 'base' as const };
      }
      const key = starAttributeKey(score, mode);
      const rating = key ? ratings.get(key) : undefined;
      if (rating) {
        return {
          ...score,
          modded_star_rating: rating,
          star_rating_source: 'modded' as const,
        };
      }
      return {
        ...score,
        modded_star_rating: undefined,
        star_rating_source: 'unavailable' as const,
      };
    }),
    failed: failedKeys.size,
  };
}
