// Skill 家族工具的纯文本输出。
//
// 这些能力和 /w skill、/w info 共用同一份 payload builder（buildPlayerSkillProfilePayload、
// buildPlayerRecentSkillProfilePayload、requestSkillProfilerAnalysis），只是把卡片换成
// 文本给模型读。命令仍然走渲染，工具走这里，两边不会算出两套结果。
import { getUserBestScores } from '../osu/api.js';
import {
  buildPlayerSkillProfilePayload,
  PLAYER_SKILL_AXIS_LABELS,
} from './playerSkillProfile.js';
import { buildPlayerRecentSkillProfilePayload } from './playerRecentSkillProfile.js';
import {
  formatSkillProfilerAnalysis,
  requestSkillProfilerAnalysisWithFetch,
} from './skillProfiler.js';

type AxisRow = { key?: string; label?: string; ceiling?: number; median?: number; value?: number };

function axisLabel(axis: AxisRow): string {
  if (axis?.label) return String(axis.label);
  const key = String(axis?.key || '');
  return (PLAYER_SKILL_AXIS_LABELS as Record<string, string>)[key] || key || '未知维度';
}

function axisPrimary(axis: AxisRow): number | null {
  const raw = axis?.ceiling ?? axis?.value ?? axis?.median;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function axisMedian(axis: AxisRow): number | null {
  const value = Number(axis?.median);
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function fixed(value: unknown, digits = 2): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '—';
}

function int(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '—';
}

function axisLines(axes: unknown): string[] {
  if (!Array.isArray(axes) || axes.length === 0) return ['  无可用维度数据'];
  return axes.map((axis: AxisRow) => {
    const primary = axisPrimary(axis);
    const median = axisMedian(axis);
    if (primary === null) return '  ' + axisLabel(axis) + '：无样本';
    const spread = median === null ? '' : '，中位 ' + median;
    return '  ' + axisLabel(axis) + '：' + primary + spread;
  });
}

/** 玩家 BP50 技能画像（与 /w info 同一份 payload）。 */
export function formatPlayerSkillText(payload: any): string {
  const player = payload?.player || {};
  const sample = payload?.sample || {};
  const profile = payload?.profile || {};
  const mods = Array.isArray(sample.modCounts)
    ? sample.modCounts.slice(0, 4).map((entry: any) => entry.mods + '×' + entry.count).join('、')
    : '';
  return [
    '玩家 ' + (player.username || '未知') + '：PP ' + int(player.pp)
      + ' · 全球 #' + int(player.globalRank) + ' · 国家 #' + int(player.countryRank)
      + ' · 准确率 ' + fixed(player.accuracy) + '%',
    '画像：' + String(profile.profileTier || '未定级') + ' · ' + String(profile.profileTitle || profile.profileType || '')
      + (Array.isArray(profile.primaryAxes) && profile.primaryAxes.length ? '｜主要维度：' + profile.primaryAxes.join('、') : ''),
    '样本：有效 ' + int(sample.valid) + '/' + int(sample.requested)
      + '，失败 ' + int(sample.failed)
      + '，质量均值 ' + fixed(sample.averageScoreQuality, 3)
      + (mods ? '，mods ' + mods : ''),
    '九维能力（BP50 加权，10 为参考线，前一个数是高分位、后一个是中位）：',
    ...axisLines(profile.axes),
  ].join('\n');
}

/** 近期表现（最近若干天，最近 50 条起步），与 /w skill recent 同一份 payload。 */
export function formatRecentSkillText(payload: any): string {
  const player = payload?.player || {};
  const sample = payload?.sample || {};
  const profile = payload?.profile || {};
  return [
    '玩家 ' + (player.username || '未知') + ' 的近期表现（最近 ' + int(sample.days || 5) + ' 天）：'
      + '成绩 ' + int(sample.fetched) + ' 条，窗口内 ' + int(sample.inWindow) + ' 条，'
      + '图 ' + int(sample.groups) + ' 张，完成 ' + int(sample.completed) + '，跳过 ' + int(sample.skipped),
    '近期需求（按近期成绩加权，和 BP50 能力值不是同一套口径）：',
    ...axisLines(profile.axes),
  ].join('\n');
}

/** 两人对比：逐维差值 + 结论。 */
export function formatSkillCompareText(left: any, right: any): string {
  const leftName = left?.player?.username || 'A';
  const rightName = right?.player?.username || 'B';
  const leftAxes = new Map<string, number>();
  const rightAxes = new Map<string, number>();
  for (const axis of Array.isArray(left?.profile?.axes) ? left.profile.axes : []) {
    const value = axisPrimary(axis);
    if (value !== null) leftAxes.set(axisLabel(axis), value);
  }
  for (const axis of Array.isArray(right?.profile?.axes) ? right.profile.axes : []) {
    const value = axisPrimary(axis);
    if (value !== null) rightAxes.set(axisLabel(axis), value);
  }
  const labels = [...new Set([...leftAxes.keys(), ...rightAxes.keys()])];
  const rows = labels.map((label) => {
    const a = leftAxes.get(label);
    const b = rightAxes.get(label);
    const diff = a !== undefined && b !== undefined ? a - b : null;
    return {
      label,
      a,
      b,
      diff,
      text: '  ' + label.padEnd(6, '　') + ' ' + (a ?? '—') + ' vs ' + (b ?? '—')
        + (diff === null ? '' : '（' + (diff >= 0 ? '+' : '') + Math.round(diff * 10) / 10 + '）'),
    };
  });
  const scored = rows.filter((row) => row.diff !== null);
  const leftWins = scored.filter((row) => Number(row.diff) > 0.3).sort((x, y) => Number(y.diff) - Number(x.diff)).slice(0, 2);
  const rightWins = scored.filter((row) => Number(row.diff) < -0.3).sort((x, y) => Number(x.diff) - Number(y.diff)).slice(0, 2);
  const conclusion = leftWins.length === 0 && rightWins.length === 0
    ? '两人在各个维度上接近，没有明显强弱差。'
    : [
      leftWins.length ? leftName + ' 更强：' + leftWins.map((row) => row.label).join('、') : '',
      rightWins.length ? rightName + ' 更强：' + rightWins.map((row) => row.label).join('、') : '',
    ].filter(Boolean).join('；');
  return [
    leftName + ' vs ' + rightName + '（BP50 加权，正数表示前者更高）：',
    ...rows.map((row) => row.text),
    '结论：' + conclusion,
  ].join('\n');
}

/** 谱面九维需求（与 /w skill <BID> 同一份分析，只是不渲染卡片）。 */
export function formatBeatmapSkillText(analysis: any): string {
  return formatSkillProfilerAnalysis(analysis);
}

export async function runBeatmapSkillAnalysis(input: {
  beatmapId?: number;
  bpRank?: number;
  playerOsuId?: number;
  playerUsername?: string;
  mods?: string[];
}): Promise<{ ok: boolean; text?: string; error?: string }> {
  let beatmapId = Number(input.beatmapId || 0);
  let mods = Array.isArray(input.mods) ? input.mods.map((mod) => String(mod).toUpperCase()) : [];
  if (!beatmapId && input.bpRank) {
    if (!input.playerOsuId) return { ok: false, error: '需要先指定玩家才能按 BP 名次分析' };
    const scores = await getUserBestScores(input.playerOsuId, 'osu', Math.max(1, Number(input.bpRank)));
    const entry = Array.isArray(scores) ? scores[Math.max(0, Number(input.bpRank) - 1)] : null;
    if (!entry?.beatmap?.id) return { ok: false, error: '没有找到这个名次的 BP' };
    beatmapId = Number(entry.beatmap.id);
    if (!mods.length) {
      mods = Array.isArray(entry.mods) ? entry.mods.map((mod: string) => String(mod).toUpperCase()) : [];
    }
  }
  if (!beatmapId) return { ok: false, error: '需要 beatmap_id 或 bp_rank' };
  try {
    const analysis = await requestSkillProfilerAnalysisWithFetch(beatmapId, mods);
    return { ok: true, text: formatBeatmapSkillText(analysis) + '\n（BID ' + beatmapId + (mods.length ? ' · ' + mods.join('') : '') + '）' };
  } catch (error: any) {
    const message = String(error?.message || error);
    if (message.includes('OSU_FILE_MISSING') || message.includes('BID_NOT_FOUND')) {
      return { ok: false, error: '这张谱面本地还没有，分析需要先下载；可以先用 osu_get_beatmap 看星数，或让用户稍后再试。' };
    }
    return { ok: false, error: '谱面分析失败：' + message.slice(0, 160) };
  }
}

export async function runPlayerSkillText(osuId: number): Promise<string> {
  const payload = await buildPlayerSkillProfilePayload(osuId);
  return formatPlayerSkillText(payload);
}

export async function runRecentSkillText(osuId: number): Promise<string> {
  const payload = await buildPlayerRecentSkillProfilePayload(osuId);
  return formatRecentSkillText(payload);
}

export async function runSkillCompareText(leftOsuId: number, rightOsuId: number): Promise<string> {
  const [left, right] = await Promise.all([
    buildPlayerSkillProfilePayload(leftOsuId),
    buildPlayerSkillProfilePayload(rightOsuId),
  ]);
  return formatSkillCompareText(left, right);
}
