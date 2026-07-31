// Full player data collector. Parallelizes osu! API + PP+ aggregate calls.

import { getBeatmapAttributes, getUser, getUserById, getUserBestScores, getUserRecentScores } from './api.js';
import { getPlayerBars, formatBarsForPrompt } from './pplus.js';
import { readDb } from '../store.js';
import type { OsuUser, OsuScore, OsuMode, OsuFixture } from './types.js';
import type { PPlusBars } from './pplus.js';
import { normalizedScoreMods } from './scoreMetrics.js';

export interface CollectorResult {
  user: OsuUser;
  bestScores: OsuScore[];
  recentScores: OsuScore[];
  pplusBars: PPlusBars | null;
  refBars: { label: string; bars: PPlusBars }[];
  classification: { distribution: Record<string, number>; details: Record<string, Record<string, number>> } | null;
  errors: string[];
}

export interface RecentCollectorResult {
  user: OsuUser;
  recentScores: OsuScore[];
  pplusBars: PPlusBars | null;
  errors: string[];
}

const STAR_ATTRIBUTE_CONCURRENCY = 8;

interface StarAttributeTask {
  key: string;
  beatmapId: number;
  mods: string[];
}

function starAttributeKey(score: OsuScore, mode: OsuMode): string | null {
  const beatmapId = Number(score.beatmap?.id || 0);
  if (beatmapId <= 0) return null;
  return `${beatmapId}:${mode}:${normalizedScoreMods(score).join(',')}`;
}

async function enrichScoreStarRatings(
  scores: OsuScore[],
  mode: OsuMode
): Promise<{ scores: OsuScore[]; failed: number }> {
  const tasks = new Map<string, StarAttributeTask>();
  for (const score of scores) {
    const mods = normalizedScoreMods(score);
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
        const result = await getBeatmapAttributes(task.beatmapId, mode, task.mods);
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
      () => worker()
    )
  );

  return {
    scores: scores.map(score => {
      const mods = normalizedScoreMods(score);
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

export async function collectPlayerData(identifier: string | number, mode: OsuMode = 'osu'): Promise<CollectorResult> {
  const errors: string[] = [];
  let user: OsuUser | null = null;
  let bestScores: OsuScore[] = [];
  let recentScores: OsuScore[] = [];
  let pplusBars: PPlusBars | null = null;
  const refBars: { label: string; bars: PPlusBars }[] = [];

  // Accept both username (string) and user ID (number)
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier));
  try {
    user = isNumeric ? await getUserById(Number(identifier), mode) : await getUser(String(identifier), mode);
  } catch (e) { errors.push(`玩家信息获取失败: ${e.message}`); }
  const displayName = user?.username || String(identifier);
  if (!user) throw new Error(`无法获取玩家 ${displayName} 的信息。${errors.join('; ')}`);

  const userId = user.id;

  // PP+ only for std — ensure data exists BEFORE building the analysis
  const usePPlus = mode === 'osu';

  // ── PP+ pre-check: trigger update if missing or stale ──
  if (usePPlus) {
    const { getPlayerBars, refreshPlayerPPlus: doRefresh } = await import('./pplus.js');
    let bars = await getPlayerBars(userId);
    if (!bars) {
      // Player not in PP+ yet — trigger full update and wait
      try {
        await doRefresh(userId);
        bars = await getPlayerBars(userId);
      } catch { /* update might fail or timeout — proceed without PP+ */ }
    }
    if (bars) {
      pplusBars = bars;
    } else {
      errors.push('PP+ 未收录此玩家数据（本地 PP+ 数据库尚无记录）');
    }
  }

  // Parallel: osu! scores (PP+ is already resolved above)
  const [bestResult, recentResult] = await Promise.allSettled([
    getUserBestScores(userId, mode, 100),
    getUserRecentScores(userId, mode, 50)
  ]);

  if (bestResult.status === 'fulfilled') { bestScores = bestResult.value; }
  else { errors.push(`最佳成绩获取失败: ${bestResult.reason?.message || bestResult.reason}`); }

  if (recentResult.status === 'fulfilled') { recentScores = recentResult.value; }
  else { errors.push(`最近成绩获取失败: ${recentResult.reason?.message || recentResult.reason}`); }

  const bestCount = bestScores.length;
  const enriched = await enrichScoreStarRatings([...bestScores, ...recentScores], mode);
  bestScores = enriched.scores.slice(0, bestCount);
  recentScores = enriched.scores.slice(bestCount);
  if (enriched.failed > 0) {
    errors.push(`Mod 后星数获取失败: ${enriched.failed} 组谱面/Mod 组合；这些成绩不参与星数统计`);
  }

  // Fetch reference players (from DB config) — fire and forget, non-blocking
  const db = readDb();
  const settings = db.settings as Record<string, unknown>;
  const refIds: (string | number)[] = (settings.pplusReferences as (string | number)[]) || [];
  if (refIds.length > 0 && pplusBars) {
    const refResults = await Promise.allSettled(
      refIds.map(async (id) => {
        const bars = await getPlayerBars(id);
        return bars ? { label: String(id), bars } : null;
      })
    );
    for (const r of refResults) {
      if (r.status === 'fulfilled' && r.value) refBars.push(r.value);
    }
  }

  // Beatmap classification (osu!oracle) — fire parallel to PP+/ref work
  let classification: CollectorResult['classification'] = null;
  const beatmapIds = bestScores.map((s: any) => s.beatmap?.id || s.beatmap_id).filter(Boolean);
  if (beatmapIds.length > 0) {
    try {
      const { classifyBeatmaps } = await import('./classifier.js');
      classification = await classifyBeatmaps(beatmapIds);
    } catch (e) { errors.push(`谱面分类失败: ${(e as Error).message}`); }
  }

  return { user, bestScores, recentScores, pplusBars, refBars, classification, errors };
}

export async function collectRecentPlayerData(
  identifier: string | number,
  mode: OsuMode = 'osu'
): Promise<RecentCollectorResult> {
  const errors: string[] = [];
  const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier));
  let user: OsuUser;
  try {
    user = isNumeric
      ? await getUserById(Number(identifier), mode)
      : await getUser(String(identifier), mode);
  } catch (error) {
    throw new Error(`无法获取玩家 ${String(identifier)} 的信息：${error?.message || error}`);
  }

  let recentScores: OsuScore[] = [];
  try {
    recentScores = await getUserRecentScores(user.id, mode, 50);
  } catch (error) {
    errors.push(`最近成绩获取失败: ${error?.message || error}`);
  }
  const enriched = await enrichScoreStarRatings(recentScores, mode);
  recentScores = enriched.scores;
  if (enriched.failed > 0) {
    errors.push(`Mod 后星数获取失败: ${enriched.failed} 组谱面/Mod 组合；这些成绩不参与星数统计`);
  }

  // PP+ data — only for std
  let pplusBars: PPlusBars | null = null;
  if (mode === 'osu') {
    try {
      const { getPlayerBars, refreshPlayerPPlus } = await import('./pplus.js');
      pplusBars = await getPlayerBars(user.id);
      if (!pplusBars) {
        try { await refreshPlayerPPlus(user.id); pplusBars = await getPlayerBars(user.id); } catch {}
      }
    } catch (e) { errors.push(`PP+ 数据获取失败: ${(e as Error).message}`); }
  }

  return { user, recentScores, pplusBars, errors };
}

export function resultToFixture(result: CollectorResult): OsuFixture {
  return {
    user: result.user,
    bestScores: result.bestScores,
    recentScores: result.recentScores
  };
}

export function formatPPlusForPrompt(pplusBars: PPlusBars | null, refBars: { label: string; bars: PPlusBars }[]): string {
  if (!pplusBars) return 'PP+ 数据不可用。\n';
  const lines = [formatBarsForPrompt(pplusBars, '你的 PP+ 六维（LazyBot 同款归一化）')];
  if (refBars.length > 0) {
    lines.push('');
    lines.push('参考数据（非标准，仅为感受尺度）：');
    for (const ref of refBars) {
      lines.push(formatBarsForPrompt(ref.bars, ref.label));
    }
  }
  lines.push('');
  lines.push('尺度说明：0-15 格，15 = 基于世界精英基准。>12 接近天花板，10-12 精英，5-10 强，<5 低于专家基准。');
  lines.push('不同维度可互相比较——已经是归一化后的值。');
  return lines.join('\n');
}
