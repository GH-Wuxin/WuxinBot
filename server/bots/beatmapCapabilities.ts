// Beatmap-centric capabilities for the LLM tool surface (Phase B).
// All three return deterministic, real data — the LLM only decides WHEN to
// call them and must quote the returned numbers verbatim.
import type { OsuBeatmap, OsuScore } from '../osu/types.js';

const YUMU_BASE = process.env.YUMU_HTTP_BASE || 'http://127.0.0.1:8388';

export function parseModsString(value: unknown): string[] {
  const raw = String(value || '');
  const tokens = raw.toUpperCase().match(/[A-Z]{2}/g) || [];
  const mods = [...new Set(tokens)].filter((mod) => mod !== 'NM').sort();
  return mods;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function beatmapFacts(beatmap: OsuBeatmap): string {
  const set = beatmap.beatmapset;
  const title = [set?.artist, set?.title].filter(Boolean).join(' - ');
  return [
    `【谱面信息】${title} [${beatmap.version}]（BID ${beatmap.id}）`,
    `mapper: ${set?.creator || '未知'} | 状态: ${beatmap.status} | 模式: ${beatmap.mode}`,
    `基础星数 ${Number(beatmap.difficulty_rating).toFixed(2)}★ | BPM ${beatmap.bpm} | 时长 ${formatDuration(beatmap.total_length)} | 物件 ${beatmap.count_circles + beatmap.count_sliders + beatmap.count_spinners}（圈 ${beatmap.count_circles} / 滑 ${beatmap.count_sliders} / 转 ${beatmap.count_spinners}）`,
    `AR ${beatmap.ar} | OD ${beatmap.accuracy} | CS ${beatmap.cs} | HP ${beatmap.drain} | max combo ${beatmap.max_combo || '未知'}`,
    `链接: https://osu.ppy.sh/b/${beatmap.id}`,
  ].join('\n');
}

export interface BeatmapToolContext {
  sendMessage?: (event: any, text: string, extra?: any) => Promise<any>;
}

/** capability=beatmap_lookup：谱面事实 + 可选带 mod 官方属性。 */
export async function runBeatmapLookup(args: Record<string, unknown>): Promise<string> {
  const { getBeatmap, getBeatmapAttributes } = await import('../osu/api.js');
  const beatmapId = Number(args.beatmap_id);
  const mods = parseModsString(args.mods);

  const beatmap = await getBeatmap(beatmapId);
  const lines = [beatmapFacts(beatmap)];
  if (mods.length > 0) {
    try {
      const { attributes } = await getBeatmapAttributes(beatmapId, 'osu', mods);
      const star = Number(attributes?.star_rating || 0);
      if (star > 0) {
        lines.push(
          `带 mod（${mods.join('')}）官方属性: 星数 ${star.toFixed(2)}★${attributes.max_combo ? ` | max combo ${attributes.max_combo}` : ''}`,
          '（带 mod 的 AR/OD/CS/HP 与估算 pp 用 capability=pp_calc 查询）',
        );
      }
    } catch {
      lines.push(`带 mod（${mods.join('')}）星数暂时查不到（osu! attributes 请求失败）。`);
    }
  }
  return lines.join('\n');
}

/** capability=pp_calc：rosu 估算 pp（雨沐 /pub/map/calculate）。 */
export async function fetchPpCalcJson(
  beatmapId: number,
  mods: string[],
  accuracy: number,
  combo: number | null = null,
  misses: number = 0,
): Promise<any> {
  const query = new URLSearchParams({ bid: String(beatmapId), mode: 'osu' });
  query.set('accuracy', String(accuracy));
  if (combo !== null) query.set('combo', String(combo));
  query.set('miss', String(misses));
  if (mods.length > 0) query.set('mods', mods.join(''));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${YUMU_BASE}/pub/map/calculate?${query.toString()}`, { signal: ctrl.signal });
  } catch (error: any) {
    throw new Error(`pp 计算服务暂不可用（${error?.name === 'AbortError' ? '超时' : error?.message || '网络错误'}），稍后再试。`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`pp 计算失败（HTTP ${response.status}），稍后再试。`);
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error('pp 计算返回了无效数据，稍后再试。');
  }
  if (body?.unavailable || !body?.calculation) {
    throw new Error('这张图暂时算不了 pp（可能是未上架/模式不支持）。');
  }
  return body;
}

export async function runPpCalc(args: Record<string, unknown>): Promise<string> {
  const beatmapId = Number(args.beatmap_id);
  const mods = parseModsString(args.mods);
  const hasAccuracy = args.accuracy !== undefined && args.accuracy !== null && args.accuracy !== '';
  const accuracy = hasAccuracy ? Number(args.accuracy) : 100;
  const combo = args.combo !== undefined && args.combo !== null && args.combo !== '' ? Number(args.combo) : null;
  const misses = args.misses !== undefined && args.misses !== null && args.misses !== '' ? Number(args.misses) : 0;

  const body = await fetchPpCalcJson(beatmapId, mods, accuracy, combo, misses);

  const calc = body.calculation;
  const beatmap = body.beatmap;
  const ladder = Object.entries(calc.fc_ladder || {})
    .map(([acc, pp]) => `${acc.replace(/^0\./, '').replace(/^1\.00$/, '100')}% ${(pp as number).toFixed(1)}`)
    .join(' / ');
  const comboText = combo === null ? 'FC（max combo）' : `${combo}x combo`;
  const breakdown = [
    calc.pp_aim != null ? `aim ${calc.pp_aim.toFixed(2)}` : null,
    calc.pp_speed != null ? `speed ${calc.pp_speed.toFixed(2)}` : null,
    calc.pp_accuracy != null ? `acc ${calc.pp_accuracy.toFixed(2)}` : null,
    calc.pp_reading != null ? `reading ${calc.pp_reading.toFixed(2)}` : null,
  ].filter(Boolean).join(' / ');

  return [
    `【pp 估算】${beatmap.artist} - ${beatmap.title} [${beatmap.version}]${mods.length ? ` +${mods.join('')}` : ''}（BID ${beatmap.id}）`,
    `${accuracy}% acc / ${comboText} / ${misses} miss → 估算约 ${calc.estimated_pp.toFixed(2)}pp`,
    '（rosu 估算值，不是官方精确 pp；仅 osu!std，lazer 语义与正式成绩可能有差异）',
    breakdown ? `构成: ${breakdown}` : '',
    `带 mod 星数 ${calc.stars.toFixed(2)}★ | AR ${calc.ar != null ? calc.ar.toFixed(2) : '?'} | OD ${calc.od != null ? calc.od.toFixed(2) : '?'} | HP ${calc.hp != null ? calc.hp.toFixed(2) : '?'} | max combo ${calc.max_combo}`,
    ladder ? `FC acc 阶梯: ${ladder}` : '',
  ].filter(Boolean).join('\n');
}

/** 物件密度：物件数 / 有效游玩时长（秒）。 */
export function beatmapDensity(beatmap: {
  count_circles: number;
  count_sliders: number;
  count_spinners: number;
  hit_length: number;
}): number | null {
  const objects = Number(beatmap.count_circles || 0) + Number(beatmap.count_sliders || 0) + Number(beatmap.count_spinners || 0);
  const seconds = Number(beatmap.hit_length || 0);
  if (objects <= 0 || seconds <= 0) return null;
  return objects / seconds;
}

const BP_SS_ENRICH_CONCURRENCY = 4;

export interface BpScoreEnrichment {
  /** SS（100% acc、FC、0 miss）rosu 估算 pp；失败时 null。 */
  ssPp: number | null;
  /** 本成绩的 pp 构成（aim/speed/acc，1 位小数）；失败时 null。 */
  breakdown: string | null;
  /** yumu 26 段物件密度数组（面板密度折线用）；失败时 null。 */
  density26: number[] | null;
  /** 面板 E5/E7 需要的 pp 分解属性（含 full_pp/perfect_pp）；失败时 null。 */
  attributes: Record<string, number> | null;
}

interface BpEnrichInput {
  beatmapId: number;
  mods: string[];
  /** 0-100；缺省 100（即按 SS 拉取）。 */
  accuracy?: number;
  /** null = FC；缺省 null。 */
  combo?: number | null;
  /** 缺省 0。 */
  misses?: number;
}

const ACC_LADDER_KEYS = ['1.00', '0.99', '0.98', '0.96', '0.94', '0.92'];

/**
 * 批量拉取每张 BP 的 SS 估算、本成绩 pp 构成与密度（雨沐 rosu，有界并发）。
 * 每张谱面只请求一次：请求参数是本成绩的 acc/combo/misses，SS 值取
 * fc_ladder["1.00"]（雨沐阶梯固定按 FC/0 miss 计算）。
 */
export async function enrichBpScoresWithSs(
  scores: BpEnrichInput[],
  concurrency: number = BP_SS_ENRICH_CONCURRENCY,
): Promise<Array<BpScoreEnrichment | null>> {
  const results: Array<BpScoreEnrichment | null> = new Array(scores.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < scores.length) {
      const index = cursor++;
      const { beatmapId, mods, accuracy, combo, misses } = scores[index];
      try {
        const body = await fetchPpCalcJson(
          beatmapId,
          mods,
          accuracy ?? 100,
          combo ?? null,
          misses ?? 0,
        );
        const calc = body.calculation;
        const ladder: Record<string, number> = calc.fc_ladder || {};
        const ssPp = Number(ladder['1.00']);
        const accKeys = ACC_LADDER_KEYS.filter((key) => Number.isFinite(Number(ladder[key])));
        const requestAcc = (accuracy ?? 100) / 100;
        const closest = accKeys.length
          ? accKeys.reduce((best, key) =>
              Math.abs(Number(key) - requestAcc) < Math.abs(Number(best) - requestAcc) ? key : best,
            )
          : null;
        const fullPp = closest ? Number(ladder[closest]) : null;
        const attributes: Record<string, number> = {};
        if (Number.isFinite(Number(calc.estimated_pp))) attributes.pp = Number(calc.estimated_pp);
        for (const [key, value] of Object.entries({
          pp_aim: calc.pp_aim,
          pp_speed: calc.pp_speed,
          pp_accuracy: calc.pp_accuracy,
          pp_reading: calc.pp_reading,
          pp_flashlight: calc.pp_flashlight,
          effective_miss_count: calc.effective_miss_count,
          stars: calc.stars,
        })) {
          if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
            attributes[key] = Number(value);
          }
        }
        if (fullPp !== null) attributes.full_pp = fullPp;
        if (Number.isFinite(ssPp)) attributes.perfect_pp = ssPp;
        const parts = [
          calc.pp_aim != null ? `aim ${Number(calc.pp_aim).toFixed(1)}` : null,
          calc.pp_speed != null ? `speed ${Number(calc.pp_speed).toFixed(1)}` : null,
          calc.pp_accuracy != null ? `acc ${Number(calc.pp_accuracy).toFixed(1)}` : null,
        ].filter(Boolean);
        const density26 = Array.isArray(body.density_26)
          ? body.density_26.map((value: unknown) => Number(value)).filter((value: number) => Number.isFinite(value))
          : null;
        results[index] = {
          ssPp: Number.isFinite(ssPp) ? ssPp : null,
          breakdown: parts.length ? parts.join('/') : null,
          density26: density26 && density26.length ? density26 : null,
          attributes: Object.keys(attributes).length ? attributes : null,
        };
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), scores.length) }, () => worker()));
  return results;
}

/** 附加到 BP 行尾的富信息：SS 估算 + 本成绩 pp 构成 + 密度。 */
export function formatBpEnrichmentSuffix(
  ssPp: number | null,
  breakdown: string | null,
  density: number | null,
): string {
  const parts: string[] = [];
  if (ssPp !== null) parts.push(`SS≈${ssPp.toFixed(1)}pp`);
  if (breakdown) parts.push(`构成 ${breakdown}`);
  if (density !== null) parts.push(`密度 ${density.toFixed(1)}/s`);
  return parts.length ? ` | ${parts.join(' | ')}` : '';
}

/** capability=leaderboard：官方全球榜前 N。 */
export async function runLeaderboard(args: Record<string, unknown>): Promise<string> {
  const { getBeatmap, getBeatmapScores } = await import('../osu/api.js');
  const beatmapId = Number(args.beatmap_id);
  const mods = parseModsString(args.mods);
  const limit = Math.max(1, Math.min(50, args.limit !== undefined && args.limit !== null && args.limit !== '' ? Number(args.limit) : 10));

  const beatmap = await getBeatmap(beatmapId);
  const scores: OsuScore[] = await getBeatmapScores(beatmapId, 'osu', mods);
  const set = beatmap.beatmapset;
  const title = [set?.artist, set?.title].filter(Boolean).join(' - ');
  const header = `【榜单】${title} [${beatmap.version}]${mods.length ? ` +${mods.join('')}` : ''}（BID ${beatmap.id}）`;
  if (scores.length === 0) {
    return `${header}\n该 mod 组合下暂时没有榜单成绩。`;
  }
  const rows = scores.slice(0, limit).map((score, index) => {
    const user = (score as any).user?.username || `#${score.user_id}`;
    const scoreMods = (score.mods || []).filter((mod) => mod !== 'NM').join('');
    const modText = scoreMods ? ` +${scoreMods}` : '';
    return `#${index + 1} ${user}  ${Number(score.pp).toFixed(1)}pp  ${(score.accuracy * 100).toFixed(2)}%  ${score.max_combo}x${modText}`;
  });
  return `${header}\n${rows.join('\n')}\n（osu! API 全球榜，前 ${Math.min(limit, scores.length)} 条）`;
}
