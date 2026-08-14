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
export async function runPpCalc(args: Record<string, unknown>): Promise<string> {
  const beatmapId = Number(args.beatmap_id);
  const mods = parseModsString(args.mods);
  const hasAccuracy = args.accuracy !== undefined && args.accuracy !== null && args.accuracy !== '';
  const accuracy = hasAccuracy ? Number(args.accuracy) : 100;
  const combo = args.combo !== undefined && args.combo !== null && args.combo !== '' ? Number(args.combo) : null;
  const misses = args.misses !== undefined && args.misses !== null && args.misses !== '' ? Number(args.misses) : 0;

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
