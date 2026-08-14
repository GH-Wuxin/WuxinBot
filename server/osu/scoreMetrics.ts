import type { OsuScore } from './types.js';

export function normalizedScoreMods(score: Pick<OsuScore, 'mods'>): string[] {
  return [...new Set((score.mods || []).map(mod => String(mod).toUpperCase()))]
    .filter(mod => mod && mod !== 'NM')
    .sort();
}

/**
 * score.beatmap.difficulty_rating is the beatmap's base star rating.
 * Live scores are enriched from /beatmaps/{id}/attributes before analysis.
 */
export function scoreStarRating(score: OsuScore): number {
  const verified = Number(score.modded_star_rating || 0);
  if (score.star_rating_source === 'modded' && verified > 0) return verified;
  if (score.star_rating_source === 'unavailable') return 0;
  return Number(score.beatmap?.difficulty_rating || 0);
}
