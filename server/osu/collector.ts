// Full player data collector. Parallelizes osu! API + PP+ aggregate calls.

import { getUser, getUserById, getUserBestScores, getUserRecentScores } from './api.js';
import { getPlayerBars, formatBarsForPrompt } from './pplus.js';
import { readDb } from '../store.js';
import type { OsuUser, OsuScore, OsuMode, OsuFixture } from './types.js';
import type { PPlusBars } from './pplus.js';
import { enrichScoreStarRatings } from './starRating.js';

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

  // ── PP+ pre-check ──
  // GET /player/info initializes an unseen player itself. Do not follow a slow
  // or failed first initialization with /player/update: update only consumes
  // recent scores and fails for perfectly valid players who have no recent
  // passes. getPlayerBars already grants first-time initialization a long
  // timeout.
  if (usePPlus) {
    const { getPlayerBars } = await import('./pplus.js');
    const bars = await getPlayerBars(userId);
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
      const { getPlayerBars } = await import('./pplus.js');
      pplusBars = await getPlayerBars(user.id);
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
  lines.push('尺度说明：15 = LazyBot expertPlus 基准线（原版显示上限，纯数据流不截断）。低于 15 时：>12 接近基准，10-12 精英，5-10 强，<5 低于专家基准；超过 15 表示该维度 raw 值已超过基准上限。');
  lines.push('不同维度可互相比较——已经是归一化后的值。');
  return lines.join('\n');
}
