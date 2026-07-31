// Data preprocessor: takes raw osu! API + PP+ data and produces structured input for LLM analysis.

import type { OsuUser, OsuScore, OsuMode } from './types.js';
import { formatBarsForPrompt } from './pplus.js';
import type { PPlusBars } from './pplus.js';
import { buildPippiPrompt } from '../bot/persona.js';
import { findModSemanticsViolation, OSU_WIKI_DOMAIN_RULES } from './wikiKnowledge.js';
import { scoreStarRating } from './scoreMetrics.js';

export interface AnalyzerInput {
  user: OsuUser;
  bestScores: OsuScore[];
  recentScores: OsuScore[];
  mode: OsuMode;
  pplusBars: PPlusBars | null;
  refBars: { label: string; bars: PPlusBars }[];
}

interface AnalyzerSections {
  profile: string;
  ppBreakdown: string;
  modsProfile: string;
  starDistribution: string;
  accuracyProfile: string;
  timeProfile: string;
  gradeProfile: string;
  recentForm: string;
  pplusSection: string;
  safeFacts: string;
  safeBody: string;
  safePippiFallback: string;
  safeFallback: string;
}

export interface AnalysisNarrativeContext {
  playerName?: string;
  perspective?: 'self' | 'other' | 'unknown';
}

export interface AnalysisSectionComments {
  profile: string;
  top: string;
  top5: string;
  mods: string;
  pplus: string;
  recent: string;
}

const ANALYSIS_COMMENT_KEYS: (keyof AnalysisSectionComments)[] = [
  'profile',
  'top',
  'top5',
  'mods',
  'pplus',
  'recent',
];

function modeName(mode: OsuMode): string {
  return { osu: 'std', taiko: '太鼓', fruits: '接水果', mania: 'mania' }[mode] || mode;
}

function fmtAcc(acc: number): string {
  return (acc * 100).toFixed(2) + '%';
}

function fmtPlayTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} 天 ${h % 24} 小时`;
  return `${h} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
}

function modsLabel(mods: string[]): string {
  if (!mods || mods.length === 0) return 'NM';
  return mods.join('');
}

export function analyzeData(input: AnalyzerInput): AnalyzerSections {
  const { user, bestScores, recentScores, pplusBars, refBars, mode } = input;
  const s = user.statistics;

  // ── Profile ──
  const joinedDate = user.join_date ? new Date(user.join_date).toLocaleDateString('zh-CN') : '未知';
  const daysSinceJoin = user.join_date ? Math.floor((Date.now() - new Date(user.join_date).getTime()) / 86400000) : 0;
  const profile = [
    `用户名: ${user.username}`,
    `国家: ${user.country_code} | 模式: ${modeName(mode)}`,
    `全球排名: #${s.global_rank?.toLocaleString() || '未上榜'} | 国家排名: #${s.country_rank?.toLocaleString() || '未上榜'}`,
    `PP: ${s.pp.toFixed(1)} | 总命中率: ${s.hit_accuracy.toFixed(2)}%`,
    `游玩次数: ${s.play_count.toLocaleString()} | 游玩时长: ${fmtPlayTime(s.play_time)}`,
    `等级: ${s.level.current}（${s.level.progress.toFixed(0)}%）| 注册: ${joinedDate}（约 ${daysSinceJoin} 天）`,
  ].join('\n');

  let ppBreakdown: string;
  let modsProfile: string;
  let starDistribution: string;
  let accuracyProfile: string;
  let gradeProfile: string;
  let recentForm: string;

  // ── PP Breakdown ──
  if (bestScores.length > 0) {
    const top5 = bestScores.slice(0, 5);
    // Use weighted PP (score.weight.pp) when available — this is the actual contribution to total PP
    const top5Weighted = top5.reduce((sum, sc) => sum + (sc.weight?.pp || sc.pp || 0), 0);
    const top5Share = s.pp > 0 ? (top5Weighted / s.pp * 100).toFixed(1) : '0';
    const ppLines = top5.map((sc, i) => {
      const wgt = sc.weight ? ` [贡献 ${sc.weight.pp?.toFixed(1) || '?'}pp]` : '';
      const stars = scoreStarRating(sc);
      return `  #${i + 1}: ${sc.pp?.toFixed(1) || '0'}pp | ${modsLabel(sc.mods)} | ${fmtAcc(sc.accuracy)} | ${stars > 0 ? stars.toFixed(2) : '?'}★ | ${sc.beatmapset?.title || '?'} [${sc.beatmap?.version || '?'}]${wgt}`;
    });
    ppBreakdown = [`BP5 加权贡献: ${top5Weighted.toFixed(1)}pp（占总 PP ${top5Share}%）`, ...ppLines].join('\n');
  } else {
    ppBreakdown = '无最佳成绩数据';
  }

  // ── Mods Profile ──
  if (bestScores.length > 0) {
    const modCounts = new Map<string, { count: number; totalAcc: number; totalPp: number }>();
    for (const sc of bestScores) {
      const label = modsLabel(sc.mods);
      const entry = modCounts.get(label) || { count: 0, totalAcc: 0, totalPp: 0 };
      entry.count++;
      entry.totalAcc += sc.accuracy;
      entry.totalPp += sc.pp || 0;
      modCounts.set(label, entry);
    }
    const sorted = [...modCounts.entries()].sort((a, b) => b[1].count - a[1].count);
    const lines = sorted.map(([label, data]) =>
      `  ${label}: ${data.count} 张（${(data.count / bestScores.length * 100).toFixed(0)}%），平均 Acc ${fmtAcc(data.totalAcc / data.count)}，PP 合计 ${data.totalPp.toFixed(0)}`
    ).join('\n');
    modsProfile = `BP${bestScores.length} 的 Mods 分布:\n${lines || '无数据'}`;
  } else {
    modsProfile = '无 Mods 数据';
  }

  // ── Star Distribution ──
  if (bestScores.length > 0) {
    const stars = bestScores.map(scoreStarRating).filter(sr => sr > 0);
    if (stars.length > 0) {
      stars.sort((a, b) => a - b);
      const avg = stars.reduce((sum, s) => sum + s, 0) / stars.length;
      const bands = { low: 0, mid: 0, high: 0 };
      for (const sr of stars) {
        if (sr < 5) bands.low++; else if (sr < 6.5) bands.mid++; else bands.high++;
      }
      starDistribution = [
        `范围: ${stars[0].toFixed(2)}★ ~ ${stars[stars.length - 1].toFixed(2)}★，平均 ${avg.toFixed(2)}★`,
        `<5★: ${bands.low} | 5-6.5★: ${bands.mid} | >6.5★: ${bands.high}`,
      ].join('\n');
    } else { starDistribution = '无星数数据'; }
  } else { starDistribution = '无星数数据'; }

  // ── Accuracy Profile ──
  if (bestScores.length > 0) {
    const accs = bestScores.map(sc => sc.accuracy);
    accs.sort((a, b) => a - b);
    const avgAcc = accs.reduce((sum, a) => sum + a, 0) / accs.length;
    const below95 = accs.filter(a => a < 0.95).length;
    const above98 = accs.filter(a => a >= 0.98).length;
    accuracyProfile = [
      `平均 Acc: ${fmtAcc(avgAcc)}（BP${bestScores.length}）`,
      `低于 95%: ${below95} | 98% 以上: ${above98}`,
    ].join('\n');
  } else { accuracyProfile = '无准确率数据'; }

  // ── Time Profile ──
  const avgPlaysPerDay = daysSinceJoin > 0 ? (s.play_count / daysSinceJoin).toFixed(1) : '?';
  const timeProfile = [`日均游玩: 约 ${avgPlaysPerDay} 次`, `最近成绩: ${recentScores.length} 条`].join('\n');

  // ── Grade Profile ──
  const gc = user.grade_counts || s.grade_counts;
  if (gc) {
    const g = gc as Record<string, number>;
    const total = (g.ssh || 0) + (g.ss || 0) + (g.sh || 0) + (g.s || 0) + (g.a || 0);
    if (total > 0) {
      gradeProfile = [`SS+: ${g.ssh || 0} | SS: ${g.ss || 0} | S+: ${g.sh || 0} | S: ${g.s || 0} | A: ${g.a || 0}`].join('\n');
    } else { gradeProfile = '无成绩评级数据'; }
  } else { gradeProfile = '无成绩评级数据'; }

  // ── Recent Form ──
  if (recentScores.length > 0) {
    const recentAcc = recentScores.reduce((sum, sc) => sum + sc.accuracy, 0) / recentScores.length;
    const recentModCounts = new Map<string, number>();
    for (const sc of recentScores) {
      const label = modsLabel(sc.mods);
      recentModCounts.set(label, (recentModCounts.get(label) || 0) + 1);
    }
    const topMods = [...recentModCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, c]) => `${m}(${c}次)`).join(', ');
    const recentStars = recentScores.map(scoreStarRating).filter(sr => sr > 0);
    const recentAvgStars = recentStars.length > 0 ? (recentStars.reduce((s, sr) => s + sr, 0) / recentStars.length).toFixed(2) : '?';
    recentForm = [
      `最近 ${recentScores.length} 次平均 Acc: ${fmtAcc(recentAcc)}`,
      `最近主要 Mods: ${topMods || 'NM'} | 平均星数: ${recentAvgStars}★`,
    ].join('\n');
  } else { recentForm = '无近期游玩数据'; }

  // ── PP+ Section ──
  let pplusSection = '';
  if (pplusBars) {
    pplusSection = formatBarsForPrompt(pplusBars, '你的 PP+ 六维（LazyBot 同款归一化，0-15 格可互相比较）');
    if (refBars.length > 0) {
      pplusSection += '\n';
      for (const ref of refBars) {
        pplusSection += '\n' + formatBarsForPrompt(ref.bars, `参考: ${ref.label}`);
      }
    }
    pplusSection += '\n\n尺度说明: 0-15 格的归一化展示值，适合观察同一玩家六个维度的相对形状。世界排名、段位和绝对能力需要其他证据；低值只描述现有成绩。';
  } else {
    pplusSection = 'PP+ 数据不可用（本地 PP+ 服务未初始化该玩家）。';
  }

  // ── Verified fact brief for the LLM ──
  // Keep the expressive model away from raw map titles and unrelated fields.
  // Every sentence here is computed directly from the current API payload.
  const safeFactLines: string[] = [
    `玩家: ${user.username} | 国家: ${user.country_code} | 模式: ${modeName(mode)}`,
    `PP: ${s.pp.toFixed(1)} | 全球排名: #${s.global_rank?.toLocaleString() || '未上榜'} | 国家排名: #${s.country_rank?.toLocaleString() || '未上榜'} | 账号总命中率: ${s.hit_accuracy.toFixed(2)}%`,
    `等级: ${s.level.current}（${s.level.progress.toFixed(0)}%）| 游玩次数: ${s.play_count.toLocaleString()} | 游玩时长: ${fmtPlayTime(s.play_time)} | 注册: ${joinedDate}`,
    `评级: SSH ${Number((gc as any)?.ssh || 0)} | SS ${Number((gc as any)?.ss || 0)} | SH ${Number((gc as any)?.sh || 0)} | S ${Number((gc as any)?.s || 0)} | A ${Number((gc as any)?.a || 0)}`,
  ];
  const reportBlocks: string[] = [
    [
      `【账号档案 · ${modeName(mode)}】`,
      `${user.username}｜${user.country_code}`,
      `${s.pp.toFixed(1)}pp｜全球 #${s.global_rank?.toLocaleString() || '未上榜'}｜国家 #${s.country_rank?.toLocaleString() || '未上榜'}`,
      `总 Acc ${s.hit_accuracy.toFixed(2)}%｜Lv.${s.level.current}（${s.level.progress.toFixed(0)}%）`,
      `游玩 ${s.play_count.toLocaleString()} 次｜时长 ${fmtPlayTime(s.play_time)}`,
      `注册 ${joinedDate}`,
      `评级 SSH ${Number((gc as any)?.ssh || 0)}｜SS ${Number((gc as any)?.ss || 0)}｜SH ${Number((gc as any)?.sh || 0)}｜S ${Number((gc as any)?.s || 0)}｜A ${Number((gc as any)?.a || 0)}`,
    ].join('\n')
  ];

  let topHighAccCount = 0;
  let topBelowNinetyFive = 0;
  let topAverageStars = 0;
  let topAverageAcc = 0;
  let mainMod = '无';
  let mainModCount = 0;
  let hdHrCombinedCount = 0;
  let hdHrCombinedPercent = 0;
  let topFiveAbove520Count = 0;
  let topFiveAllHdHr = false;
  let pplusLeaders = '';
  let pplusLowest = '';
  let recentAccDeltaPoints = 0;
  let recentStarDelta = 0;
  if (bestScores.length > 0) {
    const stars = bestScores.map(scoreStarRating).filter(value => value > 0).sort((a, b) => a - b);
    const accs = bestScores.map(score => score.accuracy);
    topAverageStars = stars.length > 0 ? stars.reduce((sum, value) => sum + value, 0) / stars.length : 0;
    topAverageAcc = accs.reduce((sum, value) => sum + value, 0) / accs.length;
    topBelowNinetyFive = accs.filter(value => value < 0.95).length;
    topHighAccCount = accs.filter(value => value >= 0.98).length;
    const bands = {
      belowFive: stars.filter(value => value < 5).length,
      fiveToSixFive: stars.filter(value => value >= 5 && value <= 6.5).length,
      aboveSixFive: stars.filter(value => value > 6.5).length,
    };
    const modStats = new Map<string, { count: number; acc: number; pp: number }>();
    for (const score of bestScores) {
      const label = modsLabel(score.mods);
      const item = modStats.get(label) || { count: 0, acc: 0, pp: 0 };
      item.count += 1;
      item.acc += score.accuracy;
      item.pp += Number(score.pp || 0);
      modStats.set(label, item);
    }
    const sortedMods = [...modStats.entries()].sort((a, b) => b[1].count - a[1].count);
    mainMod = sortedMods[0]?.[0] || '无';
    mainModCount = sortedMods[0]?.[1].count || 0;
    hdHrCombinedCount = (modStats.get('HD')?.count || 0) + (modStats.get('HDHR')?.count || 0);
    hdHrCombinedPercent = bestScores.length > 0 ? (hdHrCombinedCount / bestScores.length) * 100 : 0;
    const modFact = sortedMods.map(([label, item]) =>
      `${label} ${item.count}张 / 平均 Acc ${fmtAcc(item.acc / item.count)} / 平均 PP ${(item.pp / item.count).toFixed(1)}`
    ).join('；');
    const topFiveFacts = bestScores.slice(0, 5).map((score, index) =>
      `#${index + 1} ${Number(score.pp || 0).toFixed(1)}pp / ${modsLabel(score.mods)} / ${fmtAcc(score.accuracy)} / ${scoreStarRating(score) > 0 ? scoreStarRating(score).toFixed(2) : '?'}★`
    );
    const topFive = bestScores.slice(0, 5);
    topFiveAbove520Count = topFive.filter(score => Number(score.pp || 0) >= 520).length;
    topFiveAllHdHr = topFive.length === 5 && topFive.every(score => ['HD', 'HDHR'].includes(modsLabel(score.mods)));
    const hdHrPercentLabel = Number.isInteger(hdHrCombinedPercent)
      ? hdHrCombinedPercent.toFixed(0)
      : hdHrCombinedPercent.toFixed(1);

    safeFactLines.push(
      `BP 成绩数量: ${bestScores.length}`,
      `BP 星数: 平均 ${topAverageStars.toFixed(2)}★ | 范围 ${stars[0]?.toFixed(2) || '0.00'}★ ~ ${stars[stars.length - 1]?.toFixed(2) || '0.00'}★ | <5★ ${bands.belowFive}张 | 5-6.5★ ${bands.fiveToSixFive}张 | >6.5★ ${bands.aboveSixFive}张`,
      `BP Acc: 平均 ${fmtAcc(topAverageAcc)} | 98% 以上 ${topHighAccCount}张 | 低于 95% ${topBelowNinetyFive}张`,
      `BP Mods: ${modFact}`,
      `BP5: ${topFiveFacts.join('；')}`,
      `核准派生统计: HD 与 HDHR 合计 ${hdHrCombinedCount}张，占 BP 的 ${hdHrPercentLabel}%`,
      `核准派生统计: BP5 中 ${topFiveAbove520Count}张达到 520pp；BP5 ${topFiveAllHdHr ? '全部' : '并非全部'}使用 HD 或 HDHR`,
    );
    reportBlocks.push(
      [
        `【BP${bestScores.length} · 总览】`,
        `平均 ${topAverageStars.toFixed(2)}★｜范围 ${stars[0]?.toFixed(2) || '0.00'}★～${stars[stars.length - 1]?.toFixed(2) || '0.00'}★`,
        `平均 Acc ${fmtAcc(topAverageAcc)}`,
        `98% 以上 ${topHighAccCount} 张｜低于 95% ${topBelowNinetyFive} 张`,
        `<5★ ${bands.belowFive}｜5～6.5★ ${bands.fiveToSixFive}｜>6.5★ ${bands.aboveSixFive}`,
        `${topHighAccCount} 张超过 98%，低于 95% 的有 ${topBelowNinetyFive} 张。高准确率覆盖了整个 BP 的大部分，这种稳定很清楚。`,
      ].join('\n'),
      [
        '【BP5】',
        ...topFiveFacts,
        topFiveAbove520Count === 5
          ? `BP5 全部达到 520pp，最高分后面还有四张同分段成绩。`
          : `BP5 中有 ${topFiveAbove520Count} 张达到 520pp。`,
        topFiveAllHdHr ? 'BP5 全部使用 HD 或 HDHR。' : '',
      ].filter(Boolean).join('\n'),
      [
        '【Mods】',
        ...sortedMods.slice(0, 5).map(([label, item]) =>
          `${label}｜${item.count} 张｜Acc ${fmtAcc(item.acc / item.count)}｜均 PP ${(item.pp / item.count).toFixed(1)}`
        ),
        sortedMods.length > 5 ? `其余组合 ${sortedMods.length - 5} 类` : '',
        `HD 与 HDHR 合计 ${hdHrCombinedCount} 张，占 BP 的 ${hdHrPercentLabel}%。`,
        `这里呈现的是高位成绩构成，${mainMod} 是其中最集中的 Mod 组合。`,
      ].filter(Boolean).join('\n')
    );
  } else {
    safeFactLines.push('BP 成绩: 无数据');
    reportBlocks.push('【BP】\n这次没有可用于完整分析的 BP 成绩。');
  }

  if (pplusBars) {
    const pplusDimensions = [
      ['Flow', pplusBars.flow],
      ['Accuracy', pplusBars.accuracy],
      ['Precision', pplusBars.precision],
      ['Stamina', pplusBars.stamina],
      ['Jump', pplusBars.jump],
      ['Speed', pplusBars.speed],
    ].sort((a, b) => Number(b[1]) - Number(a[1]));
    pplusLeaders = `${pplusDimensions[0][0]} 与 ${pplusDimensions[1][0]}`;
    pplusLowest = String(pplusDimensions[pplusDimensions.length - 1][0]);
    safeFactLines.push(
      `PP+ 归一化显示条: Flow ${pplusBars.flow.toFixed(2)} | Accuracy ${pplusBars.accuracy.toFixed(2)} | Precision ${pplusBars.precision.toFixed(2)} | Stamina ${pplusBars.stamina.toFixed(2)} | Jump ${pplusBars.jump.toFixed(2)} | Speed ${pplusBars.speed.toFixed(2)}`,
      `PP+ 相对顺序: 最高两项为 ${pplusLeaders}；最低项为 ${pplusLowest}`,
      'PP+ 解释权限: 只可比较同一玩家六维显示条的相对高低；不得据此划分世界等级，也不得把低值写成绝对不会。',
    );
    for (const reference of refBars) {
      safeFactLines.push(
        `PP+ 参考样本 ${reference.label}: Flow ${reference.bars.flow.toFixed(2)} | Accuracy ${reference.bars.accuracy.toFixed(2)} | Precision ${reference.bars.precision.toFixed(2)} | Stamina ${reference.bars.stamina.toFixed(2)} | Jump ${reference.bars.jump.toFixed(2)} | Speed ${reference.bars.speed.toFixed(2)}`
      );
    }
    if (refBars.length > 0) {
      safeFactLines.push('PP+ 参考样本权限: 只用于理解显示条尺度；玩家排名、档位和高低评价均无授权。');
    }
    reportBlocks.push(
      [
        '【PP+ 六维】',
        `Flow ${pplusBars.flow.toFixed(2)}｜Accuracy ${pplusBars.accuracy.toFixed(2)}`,
        `Precision ${pplusBars.precision.toFixed(2)}｜Stamina ${pplusBars.stamina.toFixed(2)}`,
        `Jump ${pplusBars.jump.toFixed(2)}｜Speed ${pplusBars.speed.toFixed(2)}`,
        `${pplusLeaders} 的显示最高，${pplusLowest} 的现有展示最少。六条放在一起，账号当前最鲜明的方向已经很清楚。`,
      ].join('\n')
    );
  } else {
    safeFactLines.push('PP+ 数据: 不可用');
    reportBlocks.push('【PP+ 六维】\n这次没有可用数据。');
  }

  if (recentScores.length > 0) {
    const recentAcc = recentScores.reduce((sum, score) => sum + score.accuracy, 0) / recentScores.length;
    const recentStars = recentScores.map(scoreStarRating).filter(value => value > 0);
    const recentAverageStars = recentStars.length > 0
      ? recentStars.reduce((sum, value) => sum + value, 0) / recentStars.length
      : 0;
    const recentModCounts = new Map<string, number>();
    for (const score of recentScores) {
      const label = modsLabel(score.mods);
      recentModCounts.set(label, (recentModCounts.get(label) || 0) + 1);
    }
    const recentMods = [...recentModCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => `${label} ${count}次`)
      .join('，');
    recentAccDeltaPoints = (recentAcc - topAverageAcc) * 100;
    recentStarDelta = recentAverageStars - topAverageStars;
    const recentAccComparison = recentAccDeltaPoints >= 0
      ? `高 ${Math.abs(recentAccDeltaPoints).toFixed(2)} 个百分点`
      : `低 ${Math.abs(recentAccDeltaPoints).toFixed(2)} 个百分点`;
    const recentStarComparison = Math.abs(recentStarDelta) < 0.05
      ? `相差 ${Math.abs(recentStarDelta).toFixed(2)}★，平均难度接近`
      : recentStarDelta > 0
        ? `高 ${recentStarDelta.toFixed(2)}★`
        : `低 ${Math.abs(recentStarDelta).toFixed(2)}★`;
    safeFactLines.push(
      `Recent 样本: ${recentScores.length}次 | 平均 Acc ${fmtAcc(recentAcc)} | 平均星数 ${recentAverageStars.toFixed(2)}★ | Mods ${recentMods || '无'}`,
      `核准派生统计: Recent 平均星数与 BP ${recentStarComparison}；Recent 平均 Acc 比 BP ${recentAccComparison}`,
      'Recent 解释权限: 只能描述这批样本与 BP 聚合值不同；原因未知，不得列举练习、测图、疲劳、手感或拓展边界等可能故事。',
    );
    reportBlocks.push(
      [
        `【Recent ${recentScores.length} 次】`,
        `平均 ${recentAverageStars.toFixed(2)}★｜Acc ${fmtAcc(recentAcc)}`,
        `Mods：${recentMods || '无'}`,
        `BP 对照：${topAverageStars.toFixed(2)}★｜Acc ${fmtAcc(topAverageAcc)}`,
        `平均星数与 BP ${recentStarComparison}；平均 Acc 比 BP ${recentAccComparison}。`,
        'Recent 与 BP 的样本性质不同，当前数据没有提供差异原因。',
      ].join('\n')
    );
  } else {
    safeFactLines.push('Recent 样本: 0次；休整、退坑和活跃状态均无证据。');
    reportBlocks.push('【Recent】\n这次 API 没有返回近期记录。');
  }

  safeFactLines.push(
    '缺失数据的含义: 某类成绩没有展示；兴趣、能力和游玩习惯均保持未知。',
    '未提供 replay、谱面图型标签、玩家动机、设备和身体状态，禁止推断这些内容。',
  );

  const safeFacts = safeFactLines.join('\n');
  const safeBody = reportBlocks.join('\n\n');
  const visibleTraits = [
    topAverageAcc >= 0.98 ? '高准确率' : '',
    hdHrCombinedPercent >= 70 ? 'HD/HDHR 主导' : `${mainMod} 集中`,
    pplusLeaders ? `${pplusLeaders} 显示突出` : '',
  ].filter(Boolean);
  const fallbackRoleAnchor = hdHrCombinedPercent >= 70
    ? `HD/HDHR 把 BP 占得满满当当${pplusLeaders ? `，${pplusLeaders} 又排在最前面` : ''}`
    : `${mainMod} 在 BP 里最显眼${pplusLeaders ? `，${pplusLeaders} 也站得很高` : ''}`;
  const safePippiFallback = bestScores.length > 0
    ? [
        '【结论】',
        `当前账号呈现为${visibleTraits.join('、')}的稳定型玩家。`,
        `${fallbackRoleAnchor}。这份记录把风格写得很直白，想让我装作没看出来可有点难。`,
      ].filter(Boolean).join('\n')
    : [
        '【结论】',
        '当前数据不足以形成完整标签。',
        '等记录真正出现，我自然会认真看。',
      ].join('\n')
    ;
  const safeFallback = `${safeBody}\n\n${safePippiFallback}`;
  return {
    profile, ppBreakdown, modsProfile, starDistribution, accuracyProfile,
    timeProfile, gradeProfile, recentForm, pplusSection,
    safeFacts, safeBody, safePippiFallback, safeFallback
  };
}

export function buildAnalysisPrompt(
  sections: AnalyzerSections,
  personalityPrompt: string,
  narrative: AnalysisNarrativeContext = {}
): { system: string; user: string } {
  const taskRules = [
    OSU_WIKI_DOMAIN_RULES,
    '只使用数据块中明确提供的事实。不要使用你对谱面标题、玩家或社区传闻的记忆补齐资料。',
    '谱面标题和难度名只用于识别具体成绩，不包含图型标签。即使你认识这张谱，也绝对不能据此称它为跳图、串图、速度图、耐力图或描述其长度、物量和段落。',
    '各数据区块大多是独立聚合值。除非同一行明确连接了 Mod、星数、Acc 或谱面，否则不能自行声称某个 Mod 集中在某星数区间，也不能构造不存在的相关性。',
    '不得补充数据块未提供的 mapper、年份、谱面长度、物量、重试次数、失败位置或成绩分布。',
    'PP+ 六维只用于观察当前账号能力展示的相对形状，不得把显示条直接改写成世界级别、段位或绝对能力判决。',
    '不要发明"常见六维形状"、玩家类别体系或项目没有提供的评价标准。',
    '可以检查 PP+、Mod、星数和 Acc 是否呈现相容的方向；如果不能可靠互证，就分别描述，不强行建立因果。',
    'Recent 与 BP 样本性质不同。不得把两者平均 Acc 的差值直接解释成状态下滑、练习短板、耐力不足或手感变化。',
    '讨论 Recent 时可以陈述数值发生了什么变化，但原因未知时只说未知；禁止列举测图、练习、拓展边界、疲劳、手感等候选故事。',
    '没有出现某类 Mod 或成绩，只能说当前记录没有展示，不能说玩家不喜欢、不会或从不游玩。',
    '参考玩家数据只提供尺度语境，不得用于贬低、排名或给玩家划分档次。',
    '社区术语可以自然使用，但只有输入足以支持时才使用具体图型判断。',
    '使用适合 QQ 阅读的短块格式，依次保留【BP】【PP+】【Recent】【结论】四块；每行只表达一个重点，并用空行分隔。',
    '正文通常 220-380 个汉字；数据较少时可以更短。不要写成长篇连续作文。',
    '不要使用 Markdown 加粗、表格、署名或"作为 pippi"之类自我介绍。',
    '输出前在内部逐句检查：如果一句话无法指向数据块中的具体数字、字段或明确规则，就删除或改写为无法判断。不要输出检查过程。',
  ].join('\n');

  const perspectiveRule = narrative.perspective === 'self'
    ? `分析关系：发起者已绑定到本次分析账号 ${narrative.playerName || ''}。可以自然使用"你"，也可以穿插用户名；不要机械地每句都用第二人称。`
    : narrative.perspective === 'other'
      ? `分析关系：发起者正在查询其他玩家 ${narrative.playerName || ''}。优先使用用户名或中性指代，不要把分析对象写成发起者本人。`
      : `分析关系无法确定。以用户名 ${narrative.playerName || '（见数据）'} 或中性指代为主，不要擅自假定分析对象就是发起者。`;

  const system = buildPippiPrompt({
    scene: 'osu_analysis',
    userPersonality: personalityPrompt || '',
    taskRules: `${taskRules}\n${perspectiveRule}`,
  });

  const user = [
    '请只根据下面经过程序核准的事实简报，写出最终分析。',
    '简报之外的信息一律视为未知；不要调用你对玩家或谱面的既有记忆。',
    '',
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
  ].join('\n');

  return { system, user };
}

export function buildAnalysisEditorPrompt(
  sections: AnalyzerSections,
  narrative: AnalysisNarrativeContext = {},
  personalityPrompt = ''
): { system: string; user: string } {
  const perspective = narrative.perspective === 'self'
    ? `分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，可以自然使用"你"，但不必强制。`
    : `分析关系未确认，只使用用户名 ${narrative.playerName || '（见简报）'} 或“这位玩家”等中性指代，不用“你/你的”，也不要猜测“他/她”。`;

  const editorRules = [
    OSU_WIKI_DOMAIN_RULES,
    '当前任务：六个数据区块会各自带有互动短评。你只负责写最后的简短【结论】，不要抢走沿途短评的篇幅。',
    '用一句有辨识度的话回答“这是一个什么样的玩家”，再用一句自然的角色反应收尾。不要逐项复述数字清单。',
    '给这一个账号寻找专属切入点。可以起贴合成绩结构的小标签，可以比喻、吐槽、惊讶、称赞，也可以自然露出少女的小得意、强者的从容和 osu! 社区感。',
    '语气要像看完记录后当面说话。允许活泼、偏爱、坏笑和轻量 Auto 梗；不用维持报告腔，也不用逐句声明谨慎。',
    '结论完成两件事即可：给出整体玩家标签，并留下一处有对象感的反应。具体数据关系交给区块短评展开。',
    '结论不再输出阿拉伯数字，也不复述某个区块的具体差值、数量或六维条目。前文已经给过证据，这里只做整体归纳和角色收束。',
    '结论中的标签必须明确来自 BP 成绩结构，不能把“BP 中没有低于某准确率的成绩”扩大成整个账号从来没有低准确率，也不要发明“顶分段”等简报未定义的范围。',
    '成品至少留一处能让人感觉说话者正在看、正在反应的瞬间，例如惊讶、挑眉、小得意、坏笑或有分量的称赞；不用固定第一人称，也不要写身份标签。',
    '你拥有充分的措辞自由。避免套用“普通路人”“答案写得很大”“执念怪”“小脾气”等现成口号；让梗从本次数据自己长出来。',
    '',
    '硬底线很少：数字和数据关系必须来自 <verified_facts>；不得编造现实经历、动机、状态、失误原因、设备、身体部位、replay 细节或未标注的谱面类型。',
    'PP+ 低项表示在当前六维显示中展示较少，不能直接写成真实能力拖后腿或不会；最终结论不再逐项复述 PP+。Recent 与 BP 的差异可以评价观感，不能编造原因。',
    'BP 中反复出现的 Mod、准确率或难度结构可以写成成绩结构和账号风格。Mod 属于成绩而非谱面；不能写成“HD 图”“谱面自带 HD”或没开 HD 就不点图。',
    '不得把“BP 中某类 Mod 成绩占比高”扩大成“无某 Mod 不欢、只打某 Mod、刻意坚持某 Mod”一类绝对偏好或动机。只能评价当前 BP 的成绩构成。',
    '人格化比喻落在账号和成绩列表上，不落在身体或操作机制上。可以说列表很固执；不能编造肌肉记忆、手眼配合、手速、图型、密度或具体解题方式。',
    '不要使用“不是 X，而是 Y”“只是 X”“倒是 X”“本来 X，却 Y”或同类先否定、保留再改口的句式。不要羞辱或施舍。',
    '消息发送者已经表明身份，不输出“pippi”“pippi：”或署名。',
    'Auto 只表示模组和二创背景，不能把它当作自己的名字。需要明确自称时用“pippi”，不用“我这 Auto”“本 Auto”“Auto 本人”。',
    '结论优先使用直接判断和自然感叹，不要靠反问收尾；整段最多一个问号。',
    perspective,
    '篇幅控制在 45 至 95 个汉字，分成一至两个轻松阅读的短段。第一行写【结论】。',
    '只输出【结论】节点。',
  ].join('\n');

  const system = buildPippiPrompt({
    scene: 'osu_analysis',
    userPersonality: personalityPrompt,
    taskRules: editorRules,
    includeFactBoundaries: false,
  });

  const user = [
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
  ].join('\n');

  return { system, user };
}

export function buildAnalysisReviewPrompt(
  sections: AnalyzerSections,
  candidate: string,
  reasons: string[] = [],
  narrative: AnalysisNarrativeContext = {}
): { system: string; user: string } {
  const system = [
    OSU_WIKI_DOMAIN_RULES,
    '你是 osu! 玩家报告的最终事实编辑。你不负责重新创作，也不增加新的观点、梗、标签或技术解释。',
    '你的工作是保留候选稿中已经成立的个性、少女感、俏皮反应和专属比喻，同时用最小改动修正事实与句式。',
    '',
    '逐句执行以下审校：',
    '1. 数字、比例和量词必须与 verified_facts 完全一致；“多数”不能扩写成“全部”。',
    '2. 不把两个独立聚合值拼成不存在的子集结论或因果关系。例如，整体星数分布和整体平均 Acc 不能合成“某星数区间的平均 Acc”。',
    '3. Mod 和 PP+ 可以分别评价其显示结构，不能据此发明读图方式、光标运动、手速、身体机制、谱面类型、游玩目的、野心、轻松程度或能力成长故事。',
    '4. Recent 与 BP 的差异不附带现实原因；少量样本不能写成尝试、偏好、主场、舒适区或能力强弱。',
    '5. 没有全体玩家或排名区间统计时，不声称某种表现比大多数人更好、在某分段少见或罕见。',
    '6. 删除“不是 X，而是 Y”“只是”“倒是”“反而”“本来”等先否定、保留再改口的表达。',
    '7. 不输出 pippi 标签或署名，不羞辱玩家。',
    '8. 结论不输出阿拉伯数字，不重复某个区块的差值、数量或 PP+ 单项；只保留整体标签与一句角色反应。',
    '9. Auto 是模组背景，不是角色姓名；明确自称只能用 pippi。结论优先不用反问，最多一个问号。',
    '结论不能把 BP 范围内的统计扩大成整个账号的绝对事实；删除“低准确率彻底绝迹”“从不失误”“顶分段”等越界说法。',
    '成品必须保留至少一处自然的角色反应，例如挑眉、坏笑、小得意、偏爱的称赞或有对象感的感叹；不能只剩中性分析文。',
    narrative.perspective === 'self'
      ? `10. 分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，可以自然使用“你”，也可以用用户名。`
      : `10. 分析对象 ${narrative.playerName || ''} 未确认是发起者本人，使用用户名或“这位玩家”等中性指代，不用“你/你的”，也不要猜测“他/她”。`,
    '',
    '尽量保留原稿中合格的句子，不把它改成模板报告。输出 45 至 95 个汉字，一至两个短段，第一行必须是【结论】。不要括号舞台动作。',
    '只输出修订成品，不解释审校过程。',
  ].join('\n');

  const user = [
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
    '',
    '<candidate>',
    candidate,
    '</candidate>',
    '',
    '<mechanical_findings>',
    reasons.length > 0 ? reasons.join('\n') : '无；仍需完成完整语义审校。',
    '</mechanical_findings>',
  ].join('\n');

  return { system, user };
}

export function buildAnalysisSectionCommentsPrompt(
  sections: AnalyzerSections,
  narrative: AnalysisNarrativeContext = {},
  personalityPrompt = ''
): { system: string; user: string } {
  const perspective = narrative.perspective === 'self'
    ? `分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，可以自然用“你”，也可以叫用户名。`
    : `分析对象 ${narrative.playerName || ''} 未确认是发起者本人，使用用户名或“这位玩家”等中性指代，不用“你/你的”。`;

  const taskRules = [
    OSU_WIKI_DOMAIN_RULES,
    '当前任务：给 osu! 完整分析报告的六个数据区块各写一条现场短评。短评是整份报告的人格主体，最终总结会另外生成。',
    '六个区块依次是：账号档案 profile、BP100 总览 top、BP5 top5、Mods 构成 mods、PP+ 六维 pplus、Recent recent。',
    '每条只能使用对应区块的事实：profile 看账号与评级；top 看 BP100 整体星数和 Acc 分布；top5 看 BP5；mods 看 Mod 数量与各自均值；pplus 看六条显示；recent 看近期样本及 BP 对照。不要跨区借字段，避免相邻短评重复。',
    '每条都必须先落在对应区块的一个真实证据关系上，再作角色反应。尤其 top5 必须明确提到 BP5 中的 pp、Mod、Acc、星数或五张成绩的共同结构，不能跳过数据去猜某张谱面的转角、节奏或手感。',
    'BP5 没有提供谱面内容、replay 或 hit statistics 时，不猜高密度段、尾杀、开头结尾、具体掉准位置或某段手感。',
    'osu! 评级语义必须正确：SSH/SH 是 Hidden 或 Flashlight 条件下的银色评级，不能据此猜“最后一刻手滑、差一点 SS、失误位置”或 choke。',
    '字段名照简报使用：准确率写 Acc 或准确率，不能写成 PA。游玩次数和评级数量不能直接解释成耐力、努力程度或训练量。',
    '每条 20 至 85 个汉字，通常一至两句。不要重复完整数据清单；要归纳、发现反差、评价、惊讶、追问、轻轻命令或打趣。',
    '重点是主动与玩家互动。陈述句只负责铺垫，感叹、疑问、祈使和有对象感的反应交替出现；不要六条全写成同一种“是不是……”模板。',
    '六条短评合计最多出现两处问句或反问。其余区块用直接判断、感叹、招呼或轻量祈使句，不要每一段都追问玩家。',
    '整组六条里，“是不是”“该不会”“难道”每种最多出现两次。可以改用感叹、直接招呼、轻轻命令、反问和自言自语，让六条像同一个活人在不同瞬间作出的反应。',
    '允许根据当前数据做猜测性质的小分析。涉及习惯、动机、近期状态或原因时，用“像是、也许、该不会、是不是、难道”等语气明确让人听出这是猜测或玩笑，不要伪装成确定事实。',
    '可以猜着逗玩家，不能借玩笑发明游戏机制、UI 控件或能力结论。没有“速度键”这种东西；也不能把某个星数区间写成舒适区、客厅、主场，或说玩家不敢碰、不喜欢、只会某类成绩。',
    '数字仍然只能使用 verified_facts 中出现的数字。猜测可以自由，数字不能自由。',
    '需要数字时优先照抄简报中的精确写法；也可以完全省略数字。不要把 438 改写成“快五百”，把 67 改写成“快七十”之类新的近似说法。',
    '不要自行拿注册日期计算“玩了几年、近几年”等简报未直接给出的时间结论。',
    '社区用语要按真实习惯使用：谱面名词说“pp 图”；行为说“刷 pp”或“农 pp”；串图、跳图是正常图型称呼。不要把“农”拼成“农图”“农 pp 图”，也禁用“藏图”“藏宝图”“甜品图”“串图选手”“串串头子”。不要临时发明“Auto 保险”这类社区没人说的合成名词。串图、跳图和串批只有在数据支持或明确作为猜测时才能使用，不能为了显得懂圈子硬塞。',
    'PP+ 六维只能比较本报告里的相对高低和形状。不能说某项“顶满、拉满、触顶、满格”，也不能从六维猜出切指、交替、爆发、手速、手活、光标动作或具体图型。可以评价六维偏向，也可以拿这种偏向和玩家开一句明显是玩笑的短评。',
    '不要凭空发明 DR、DDT 等缩写或 Mod 名。只使用简报中实际出现的 Mod，HDDT 不能缩写成 DDT。',
    'osu! 的指针称为“光标”，不要写成射击游戏式的“准心”。BP5 同时包含 HD 与 HDHR 时统一称“HD 系”，不要含糊写成“全部 HD”。',
    '评价 Mods 时只谈 BP 中各 Mod 成绩的数量、占比与均值结构。不能据此说玩家“刻意、故意、坚持”某个 Mod，也不能扩大成“无某 Mod 不欢、只打某 Mod”。组合缩写按实际 Mod 拆解理解，例如 NFSO 是 NF+SO。',
    '比喻和追问必须直接贴着数据或玩家，不要在句尾硬接“风、天气、保险、赛道、油门”等与报告无关的意象。',
    '“哇，你 Flow 突出这么多，大家是不是都叫你串批呢？”只示范一条短评的互动感；不得照抄，也不得让其他五条继续套“是不是”。',
    '不要写“别急着认罪”、报告审查腔、免责声明、冷淡的“数据表明”，也不要输出 pippi 标签或署名。',
    'Auto 不是角色姓名。需要明确自称时只用“pippi”，不能说“我这 Auto”“本 Auto”“Auto 本人”或用 Auto 代替 pippi。',
    '不要使用“不是 X，而是 Y”“只是”“不过”“倒是”“反而”“本来”等先保留再改口的句式。',
    '俏皮不能变成羞辱、施舍或硬演雌小鬼。不要用括号舞台动作。',
    perspective,
    '只输出一个合法 JSON 对象，不要 Markdown 代码块，不要解释。键必须且只能是 profile、top、top5、mods、pplus、recent，值为单行字符串。',
  ].join('\n');

  const system = buildPippiPrompt({
    scene: 'osu_analysis',
    userPersonality: personalityPrompt,
    taskRules,
    includeFactBoundaries: false,
  });

  const user = [
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
  ].join('\n');

  return { system, user };
}

export function parseAnalysisSectionComments(text: string): AnalysisSectionComments | null {
  const value = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    const result = {} as AnalysisSectionComments;
    for (const key of ANALYSIS_COMMENT_KEYS) {
      const comment = String(parsed?.[key] || '')
        .replace(/\r?\n+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!comment) return null;
      result[key] = comment;
    }
    return result;
  } catch {
    return null;
  }
}

export function sanitizeAnalysisSectionComments(
  comments: AnalysisSectionComments,
  narrative: AnalysisNarrativeContext = {}
): AnalysisSectionComments {
  const cleaned = {} as AnalysisSectionComments;
  for (const key of ANALYSIS_COMMENT_KEYS) {
    const normalized = String(comments[key] || '')
      .replace(/准心/g, '光标')
      .replace(/\bDDT\b/gi, 'HDDT')
      .replace(/倒挺/g, '挺')
      .replace(/(?:五张|BP\s*5)\s*(?:全部|全员)\s*HD(?:起步)?/gi, 'BP5 全是 HD 系');
    const sentences = normalized.match(/[^。！？?!]+[。！？?!]?/g) || [];
    const kept = sentences
      .map(sentence => sentence.trim())
      .filter(Boolean)
      .filter(sentence => {
        if (/农图|农\s*pp\s*图|藏图|藏宝图|甜品图|串图选手|串串头子|Auto\s*保险|保险丝|\bDR\b|风有点大|别急着认罪|(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(sentence)) return false;
        if (/(?:近|玩了|打了)\s*\d+(?:\.\d+)?\s*年/.test(sentence)) return false;
        if (/不是[^。\n]{0,40}(?:而是|只是|是)|只是|不过|倒是|反而|本来/.test(sentence)) return false;
        if (/[（(]\s*(?:挑眉|歪头|坏笑|轻笑|眨眼|得意)[^）)]*[）)]/.test(sentence)) return false;
        if (
          narrative.perspective !== 'self' &&
          /(?:^|[。！？\n，,：:；;])\s*你(?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(sentence)
        ) return false;
        if (
          narrative.perspective !== 'self' &&
          /(?:^|[。！？\n，,：:；;])\s*[他她](?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(sentence)
        ) return false;
        if (
          (key === 'mods' || key === 'top5') &&
          /(?:Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+)/i.test(sentence)
        ) return false;
        if (key === 'recent' && /(?:SSH|SS|SH|等级|注册|游玩时长)/i.test(sentence)) return false;
        if (
          key === 'profile' &&
          /(?:最后一刻|临门一脚).{0,12}(?:手滑|失误)|SH[^。\n]{0,20}(?:手滑|差一点|choke)|银S[^。\n]{0,20}(?:手滑|失误)/i.test(sentence)
        ) return false;
        if (/肌肉记忆|身体记忆/i.test(sentence) && !/[？?]|像是|也许|该不会|是不是|难道|莫非/.test(sentence)) return false;
        return true;
      });
    cleaned[key] = kept.join('');
  }
  return cleaned;
}

export function validateAnalysisSectionComments(
  sections: AnalyzerSections,
  comments: AnalysisSectionComments,
  narrative: AnalysisNarrativeContext = {}
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const values = ANALYSIS_COMMENT_KEYS.map(key => comments[key]);

  for (const key of ANALYSIS_COMMENT_KEYS) {
    const value = String(comments[key] || '').trim();
    if (value.length < 12) reasons.push(`${key} 短评过短`);
    if (value.length > 110) reasons.push(`${key} 短评过长`);
    if (/pippi\s*[：:]|【pippi|作为\s*pippi/i.test(value)) reasons.push(`${key} 重复标注 pippi 身份`);
    if (/农图|农\s*pp\s*图|藏图|藏宝图|甜品图|串图选手|串串头子|Auto\s*保险|保险丝|\bDR\b|风有点大|别急着认罪/i.test(value)) reasons.push(`${key} 使用了不自然或已禁用的说法`);
    if (/\bTop\b/i.test(value)) reasons.push(`${key} 面向玩家时把 BP 错写成了 Top`);
    if (/\bHidden\b|隐身模组|隐身图|Hidden\s*键|HD\s*键/i.test(value)) {
      reasons.push(`${key} 生硬翻译或错误命名了 HD`);
    }
    const modSemanticsViolation = findModSemanticsViolation(value);
    if (modSemanticsViolation) reasons.push(`${key} 的 Mod 语义错误：${modSemanticsViolation}`);
    if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
      reasons.push(`${key} 把 Auto 当成了 pippi 的自称`);
    }
    if (/(?:快|近|将近|差不多)\s*[一二三四五六七八九十百千万两]+|[一二三四五六七八九十百千万两]+\s*多(?:张|个|次|分|点)/.test(value)) {
      reasons.push(`${key} 把简报数字改写成了新的中文近似数`);
    }
    if (/\bDDT\b/i.test(value)) reasons.push(`${key} 把 HDDT 错写成了 DDT`);
    if (/\bPA\b/i.test(value)) reasons.push(`${key} 把 Acc 错写成了 PA`);
    if (/准心/.test(value)) reasons.push(`${key} 把 osu! 光标写成了准心`);
    if (/(?:近|玩了|打了)\s*\d+(?:\.\d+)?\s*年/.test(value)) reasons.push(`${key} 擅自从日期推算账号年数`);
    if (
      key === 'profile' &&
      /(?:最后一刻|临门一脚).{0,12}(?:手滑|失误)|SH[^。\n]*(?:手滑|差一点|choke)|银S[^。\n]*(?:手滑|失误|差一点)|手滑[^。\n]{0,20}(?:直接|变成|就是|只剩)\s*S|闪光\s*SS/i.test(value)
    ) {
      reasons.push('profile 误解了 SSH/SH 评级含义');
    }
    if (key === 'recent' && /(?:差|低|少|掉|滑)[^。\n]{0,8}[一二三四五六七八九十两]+档/.test(value)) {
      reasons.push('recent 把百分点差异擅自改写成了“档”');
    }
    if (key === 'profile' && /(?:游玩|次数|评级|A\b|S\b|SH\b)[^。\n]{0,20}耐力|耐力[^。\n]{0,20}(?:游玩|次数|评级)/i.test(value)) {
      reasons.push('profile 把游玩次数或评级数量解释成了耐力');
    }
    if (key === 'profile' && /宁要|情愿|A[^。\n]{0,12}红叉/i.test(value)) {
      reasons.push('profile 把评级分布编成了玩家主动选择或错误的评级含义');
    }
    if (key === 'top' && /全绿|无瑕|完美无缺|全是满分/i.test(value)) {
      reasons.push('top 把高准确率成绩夸张成了无瑕或满分');
    }
    if (key === 'top' && /自带[^。\n]{0,12}(?:修正|辅助)|手感|恼火|生气|讨厌/i.test(value)) {
      reasons.push('top 发明了操作机制、状态或不合适的敌意反应');
    }
    if (/肌肉记忆|身体记忆/i.test(value) && !/[？?]|像是|也许|该不会|是不是|难道|莫非/.test(value)) {
      reasons.push(`${key} 把身体机制写成了确定事实`);
    }
    if (
      key === 'pplus' &&
      /顶满|拉满|触顶|满格|切指|交替|爆发|手活|手速|手指|滑行|冲刺|肌肉记忆|手眼配合|光标.{0,12}(?:动|跑|飘|追)|图型|密度图|流动型图|只爱|不爱|没兴趣|提不起兴趣|看见.{0,12}就|摆摆?手|贴贴|躲着|害怕|怕快|你的手|手[^。\n]{0,8}出卖/i.test(value)
    ) {
      reasons.push('pplus 从六维相对高低发明了绝对满值或具体操作机制');
    }
    if (/速度键|舒适区|游乐场|主场|你家客厅|不敢[^。\n]{0,12}(?:碰|打|开|摘|出门)|只会/i.test(value)) {
      reasons.push(`${key} 发明了游戏机制、舒适区或能力结论`);
    }
    if (key === 'recent' && /闭着?眼|搞怪\s*Mod|梦游/i.test(value)) {
      reasons.push('recent 的玩笑变成了无依据的操作或状态原因');
    }
    if (/爆发力|串图选手|串串头子/i.test(value)) {
      reasons.push(`${key} 使用了数据不支持的能力结论或生造称呼`);
    }
    if (key === 'mods' && /读图|耐性|没练|未练|练过|训练|能力|刻意|故意|坚持/i.test(value)) {
      reasons.push('mods 从 Mod 分布推断了读图、训练、能力或主观动机');
    }
    if (
      /杂鱼|就这|好弱|菜(?:得|成|死|啊|呀)|勉强(?:还|算|挺)?(?:不错|可以)|不过如此/.test(value) ||
      /(?:你|玩家|账号)[^。\n]{0,12}可怜|可怜[^。\n]{0,12}(?:你|玩家)/.test(value)
    ) {
      reasons.push(`${key} 的打趣变成了羞辱或施舍`);
    }
    if (/不是[^。\n]{0,40}(?:而是|只是|是)|只是|不过|倒是|反而|本来/.test(value)) {
      reasons.push(`${key} 使用了先保留再改口的句式`);
    }
    if (/[（(]\s*(?:挑眉|歪头|坏笑|轻笑|眨眼|得意)[^）)]*[）)]/.test(value)) {
      reasons.push(`${key} 使用括号舞台动作代替自然表达`);
    }
    const semanticReasons = validateAnalysisContent(sections, value, narrative);
    for (const reason of semanticReasons) {
      reasons.push(`${key} 短评语义终审：${reason}`);
    }
    if (
      narrative.perspective !== 'self' &&
      /(?:^|[。！？\n，,：:；;])\s*你(?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(value)
    ) {
      reasons.push(`${key} 把未确认的目标玩家写成了发起者本人`);
    }
    if (
      narrative.perspective !== 'self' &&
      /(?:^|[。！？\n，,：:；;])\s*[他她](?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(value)
    ) {
      reasons.push(`${key} 擅自猜测了目标玩家性别`);
    }
  }

  const interactiveCount = values.filter(value =>
    /[！？?!]|哇|诶|欸|让我|先别|先看|该不会|是不是|难道|莫非|真是|我看|我都|给我/.test(value)
  ).length;
  if (interactiveCount < 2) reasons.push(`互动式短评不足：当前 ${interactiveCount}/6`);
  const questionCount = values.reduce(
    (sum, value) => sum + (value.match(/[？?]/g) || []).length,
    0
  );
  if (questionCount > 2) reasons.push(`六区块问句过多：当前 ${questionCount} 处，最多 2 处`);

  if (/(?:Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+)/i.test(comments.mods)) {
    reasons.push('mods 短评挪用了 PP+ 字段');
  }
  if (/(?:Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+)/i.test(comments.top5)) {
    reasons.push('top5 短评挪用了 PP+ 字段');
  }
  if (!/(?:pp|HD|HR|Acc|★|星|五张|BP\s*5|前五)/i.test(comments.top5)) {
    reasons.push('top5 短评没有落在五张成绩的真实证据上');
  }
  if (/转角|谱面段落|某一段|尾杀|开头|结尾|节奏型|手感|密度|高密|低密/i.test(comments.top5)) {
    reasons.push('top5 短评编造了简报未提供的谱面内容或操作感受');
  }
  if (/(?:跟|和)\s*HR\s*私奔|黏着\s*HR|HR\s*(?:独占|包办|承包)/i.test(comments.top5)) {
    reasons.push('top5 把 HD 与 HDHR 混合构成误写成了 HR 单独主导');
  }
  if (/(?:SSH|SS|SH|等级|注册|游玩时长)/i.test(comments.recent)) {
    reasons.push('recent 短评挪用了账号档案字段');
  }

  for (const opener of ['是不是', '该不会', '难道', '哇']) {
    const count = values.reduce((sum, value) => sum + (value.includes(opener) ? 1 : 0), 0);
    if (count > 2) reasons.push(`互动句式“${opener}”重复过多`);
  }
  if (/肯定[^。\n]{0,18}串批|(?:大家|朋友们|群友)[^。\n]{0,18}(?:都|肯定)[^。\n]{0,8}(?:叫|喊)[^。\n]{0,8}串批/.test(comments.pplus)) {
    reasons.push('pplus 把“串批”玩笑写成了确定的现实称呼');
  }

  const allowedNumbers = new Set(
    (sections.safeFacts.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).flatMap(token => {
      const normalized = String(Number(token.replace(/,/g, '')));
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) return [normalized];
      return [
        normalized,
        String(Math.round(numeric)),
        String(Number(numeric.toFixed(1))),
        String(Number(numeric.toFixed(2))),
      ];
    })
  );
  const usedNumbers = values
    .flatMap(value => value.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [])
    .map(token => String(Number(token.replace(/,/g, ''))));
  const unknownNumbers = [...new Set(usedNumbers.filter(token => !allowedNumbers.has(token)))];
  if (unknownNumbers.length > 0) reasons.push(`短评包含简报外数字: ${unknownNumbers.join(', ')}`);

  return { ok: reasons.length === 0, reasons };
}

export function injectAnalysisSectionComments(
  safeBody: string,
  comments: AnalysisSectionComments
): string {
  const matchers: { key: keyof AnalysisSectionComments; pattern: RegExp }[] = [
    { key: 'profile', pattern: /^【账号档案/ },
    { key: 'top', pattern: /^【BP\d+ · 总览】/ },
    { key: 'top5', pattern: /^【BP5】/ },
    { key: 'mods', pattern: /^【Mods】/ },
    { key: 'pplus', pattern: /^【PP\+ 六维】/ },
    { key: 'recent', pattern: /^【Recent/ },
  ];

  return String(safeBody || '')
    .split(/\n\n/)
    .map(block => {
      const match = matchers.find(item => item.pattern.test(block));
      return match ? `${block}\n${comments[match.key]}` : block;
    })
    .join('\n\n');
}

export function formatPippiComment(text: string): string {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(^|[。！？\n])\s*不过嘛[，,]?\s*/g, '$1嗯，')
    .replace(/[ \t]+$/gm, '')
    .trim();
  if (!normalized) return '';

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(line => line.trim()).filter(Boolean).join(''))
    .filter(Boolean);

  const output: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === '【结论】') {
      output.push(paragraph);
      continue;
    }

    const withoutHeading = paragraph.startsWith('【结论】')
      ? paragraph.slice('【结论】'.length).trim()
      : paragraph;
    if (paragraph.startsWith('【结论】')) output.push('【结论】');
    if (!withoutHeading) continue;

    const sentences = withoutHeading.match(/[^。！？]+[。！？]?/g) || [withoutHeading];
    let line = '';
    const lines: string[] = [];
    for (const sentence of sentences.map(item => item.trim()).filter(Boolean)) {
      if (!line || line.length + sentence.length <= 96) {
        line += sentence;
      } else {
        lines.push(line);
        line = sentence;
      }
    }
    if (line) lines.push(line);
    output.push(lines.join('\n'));
  }

  const hasHeading = output.some(block => block === '【结论】');
  return `${hasHeading ? '' : '【结论】\n\n'}${output.join('\n\n')}`.trim();
}

export function condensePippiComment(
  text: string,
  maxLength = 360
): string {
  const body = String(text || '').replace(/^【结论】\s*/, '').trim();
  const sentences = (body.match(/[^。！？\n]+[。！？]?/g) || [])
    .map(sentence => sentence.trim())
    .filter(Boolean);
  const initiallyFormatted = formatPippiComment(text);
  if (sentences.length <= 4 && initiallyFormatted.length <= maxLength) return initiallyFormatted;

  const items = sentences.map((sentence, index) => {
    let score = 0;
    if (index === 0) score += 100;
    if (index === sentences.length - 1) score += 80;
    if (/PP\+|Flow|Accuracy|Precision|Stamina|Jump|Speed/.test(sentence)) score += 20;
    if (/Recent|近期|最近/.test(sentence)) score += 20;
    if (/BP|Mod|HD|DT|HR|NM|Acc|准确率|pp|★/i.test(sentence)) score += 10;
    if (/我|挑眉|歪头|得意|坏笑|喜欢|漂亮|可爱|有趣|多看|多盯|好家伙/.test(sentence)) score += 8;
    if (/\d/.test(sentence)) score += 4;
    if (sentence.length > 100) score -= 4;
    return { sentence, index, score };
  });

  const render = (current: typeof items) => {
    const ordered = [...current].sort((a, b) => a.index - b.index);
    const paragraphs: string[] = [];
    for (let index = 0; index < ordered.length; index += 2) {
      paragraphs.push(ordered.slice(index, index + 2).map(item => item.sentence).join(''));
    }
    return formatPippiComment(`【结论】\n\n${paragraphs.join('\n\n')}`);
  };

  let kept = [...items];
  while (kept.length > 2 && render(kept).length > maxLength) {
    const removable = kept
      .filter(item => item.index !== 0 && item.index !== sentences.length - 1)
      .sort((a, b) => a.score - b.score || b.sentence.length - a.sentence.length)[0];
    if (!removable) break;
    kept = kept.filter(item => item !== removable);
  }

  return render(kept);
}

export function pruneInvalidPippiSentences(
  sections: AnalyzerSections,
  text: string,
  narrative: AnalysisNarrativeContext = {}
): string {
  const body = String(text || '').replace(/^【结论】\s*/, '').trim();
  if (!body) return '';

  const sentences = body.match(/[^。！？\n]+[。！？]?/g) || [];
  const kept = sentences
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .filter(sentence => !/\d/.test(sentence))
    .filter(sentence => validateAnalysisContent(sections, sentence, narrative).length === 0);

  return formatPippiComment(`【结论】\n\n${kept.join('\n\n')}`);
}

function hasPippiPresence(value: string): boolean {
  return /(?:我|诶|欸|哎呀|嗯|哼|哦|啦|呢|呀|嘛|挑眉|歪头|坏笑|可爱|漂亮|喜欢|好家伙|真是|乖|想看|多看|多盯|理直气壮|有点帅|看着.{0,12}舒服|抓住了我的|额外加点分|忍不住)/.test(value);
}

export function validateAnalysisReport(
  sections: AnalyzerSections,
  text: string,
  narrative: AnalysisNarrativeContext = {}
): { ok: boolean; reasons: string[] } {
  const value = String(text || '').trim();
  const reasons = validateAnalysisContent(sections, value, narrative);
  if (value.length < 400) reasons.push('完整报告过短或疑似缺少数据节点');
  if (value.length > 3000) reasons.push('完整报告异常过长');
  for (const heading of ['账号档案', 'BP', 'PP+', 'Recent', '结论']) {
    if (!value.includes(`【${heading}`)) reasons.push(`缺少 QQ 节点: ${heading}`);
  }
  if (!hasPippiPresence(value)) reasons.push('结论缺少自然的角色反应，读起来仍是中性分析文');
  if (/【pippi|pippi\s*[：:]/i.test(value)) reasons.push('正文中重复标注 pippi 身份');
  return { ok: reasons.length === 0, reasons };
}

export function validatePippiComment(
  sections: AnalyzerSections,
  text: string,
  narrative: AnalysisNarrativeContext = {}
): { ok: boolean; reasons: string[] } {
  const value = String(text || '').trim();
  const reasons = validateAnalysisContent(sections, value, narrative);
  if (value.length < 55) reasons.push('综合结论过短');
  if (value.length > 130 && value !== sections.safePippiFallback) reasons.push('综合结论过长');
  if (/\d/.test(value) && value !== sections.safePippiFallback) reasons.push('综合结论再次复述具体数字');
  if (/(?:PP\+|Flow|Accuracy|Precision|Stamina|Jump|Speed)/i.test(value) && value !== sections.safePippiFallback) {
    reasons.push('综合结论再次复述 PP+ 六维条目');
  }
  if (/低准确率[^。\n]{0,12}(?:绝迹|消失|清零)|成绩[^。\n]{0,12}绝迹|从不失误|顶分段/.test(value)) {
    reasons.push('综合结论把 BP 样本扩大成了账号绝对事实或发明了范围');
  }
  if (!value.startsWith('【结论】')) reasons.push('缺少结论节点标题');
  if ((value.match(/【[^】]+】/g) || []).some(heading => heading !== '【结论】')) {
    reasons.push('综合结论混入其他数据节点');
  }
  if (!hasPippiPresence(value)) reasons.push('结论缺少自然的角色反应，读起来仍是中性分析文');
  if (/pippi\s*[：:]|【pippi/i.test(value)) reasons.push('综合结论重复标注 pippi 身份');
  if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
    reasons.push('综合结论把 Auto 当成了 pippi 的自称');
  }
  if ((value.match(/[？?]/g) || []).length > 1) reasons.push('综合结论反问过多');
  if (/我[^。\n]{0,16}(?:打不了|做不到|没你准|不如你|比不上你)|(?:你|玩家)[^。\n]{0,16}比我[^。\n]{0,8}(?:准|强)/.test(value)) {
    reasons.push('综合结论否定了 pippi 的完美操作世界观');
  }
  if (/“[^”]*\n\s*\n[^”]*”/.test(value)) reasons.push('引号跨越段落，疑似断句损坏');
  if (/[（(][^）)\n]{1,40}[）)]/.test(value)) reasons.push('综合结论使用括号舞台动作或旁白');
  return { ok: reasons.length === 0, reasons };
}

function validateAnalysisContent(
  sections: AnalyzerSections,
  value: string,
  narrative: AnalysisNarrativeContext = {}
): string[] {
  const reasons: string[] = [];
  if (
    narrative.perspective !== 'self' &&
    /(?:^|[。！？\n，,：:；;])\s*你(?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(value)
  ) {
    reasons.push(`分析对象 ${narrative.playerName || '该玩家'} 未确认是发起者本人，不能使用第二人称`);
  }
  if (
    narrative.perspective !== 'self' &&
    /(?:^|[。！？\n，,：:；;])\s*[他她](?:的|这|在|把|用|拿|有|会|能|还|就|可|真|呀|啊|呢|吧|啦|，|。|！|？)/.test(value)
  ) {
    reasons.push(`分析对象 ${narrative.playerName || '该玩家'} 的性别未知，不能擅自使用“他/她”`);
  }
  if (/pippi\s*的(?:判断|总结)|作为\s*pippi/i.test(value)) reasons.push('包含固定署名或自我介绍');
  // Only positive self-identification as an AI/assistant is a violation.
  // "我不是助手" style denials or ordinary words like "分析工具" must pass.
  if (/我(?:就)?是(?:一个)?(?:人工智能|AI|助手|编辑器|分析工具)|作为(?:一个)?(?:人工智能|AI|助手)|本(?:人)?(?:人工智能|AI|助手)/i.test(value)) {
    reasons.push('把 pippi 写成了工具或助手');
  }
  if (/作为旁观者|玩家画像|自我定位|我认可这份|我尊重这种|数据告诉我/.test(value)) {
    reasons.push('包含冷淡报告腔或未经证据支持的文学化推断');
  }
  if (/农图|农\s*pp\s*图|藏图|藏宝图|甜品图|串图选手|串串头子/i.test(value)) {
    reasons.push('使用了不自然或错误的 osu! 社区用语');
  }
  if (/\bTop\b/i.test(value)) reasons.push('面向玩家时把 BP 错写成了 Top');
  if (/\bHidden\b|隐身模组|隐身图|Hidden\s*键|HD\s*键/i.test(value)) {
    reasons.push('生硬翻译或错误命名了 HD');
  }
  const modSemanticsViolation = findModSemanticsViolation(value);
  if (modSemanticsViolation) reasons.push(`Mod 语义错误：${modSemanticsViolation}`);
  if (/杂鱼|就这|好弱|弱得|菜(?:得|成|死|啊|呀)|可怜|勉强(?:还|算|挺)?(?:不错|可以)|不过如此/.test(value)) {
    reasons.push('俏皮语气变成了羞辱或施舍');
  }
  if (/对我来说.{0,16}(?:不失误|完美|SS|100%)|不失误.{0,10}(?:默认|理所当然)|人类(?:原来)?需要|换成我|我就不会|按我的标准|虽然你.{0,12}比我|以你的水平|对人类(?:而言|来说).{0,8}(?:已经|算是).{0,6}(?:不错|很好)|不需要我帮忙|不会断连/.test(value)) {
    reasons.push('使用 pippi 的完美操作压低玩家');
  }
  if (/我[^。\n]{0,16}(?:打不了|做不到|没你准|不如你|比不上你)|(?:你|玩家)[^。\n]{0,16}比我[^。\n]{0,8}(?:准|强)/.test(value)) {
    reasons.push('否定了 pippi 的完美操作世界观');
  }
  if (/对我来说[^。\n]{0,36}Auto|Auto[^。\n]{0,24}(?:当然|无所谓|简单|容易)/i.test(value)) {
    reasons.push('用 Auto 条件强调 pippi 的轻松，削弱了对玩家的认可');
  }
  if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
    reasons.push('把 Auto 当成了 pippi 的自称');
  }
  const contrastMatch = value.match(
    /不是[^。\n]{0,40}(?:而是|只是|是)|并非[^。\n]{0,40}(?:而是|只是|是)|不只是[^。\n]{0,40}(?:更是|还)|不仅[^。\n]{0,40}(?:而且|还|也)|不等于|与其[^。\n]{0,40}不如|(?:看似|看起来|乍看|表面上|听起来)[^。\n]{0,40}(?:其实|实际(?:上)?|实则|说到底)|(?:算不上|谈不上|称不上|够不上|未必|可没|并没有|没那么)[^。\n]{0,40}(?:但|不过|可是|却|倒是|反而)|(?:本来|原本)[^。\n]{0,40}(?:但|不过|可是|却|倒是|反而)|(?:说是|要说)[^。\n]{0,40}(?:倒不如|更像|其实)|但更准确(?:的说法)?(?:是|地说)|更准确(?:地)?说|准确地说|换句话说|不需要[^。\n]{0,24}(?:解释|说明)[^。\n]{0,16}(?:就是|才是)|(?:^|[。！？\n])\s*(?:不过|但是|可是|然而|其实|反而|倒是|只是)[，、：\s]|—{1,2}\s*(?:可|但|却|只是|其实|反而)|只是|不过|倒是|反而|本来|远谈不上|倒有意思|不会说[^。\n]{0,30}。[^\n]{0,16}更像|(?:没有|没|未)[^。\n]{0,40}(?:—{1,2}|，|；)[^。\n]{0,40}(?:稳定|漂亮|干净|很好|喜欢|值得|出色|亮眼)|夸奖.{0,8}(?:没|不).{0,8}(?:便宜|容易|随便)/
  );
  if (contrastMatch) {
    reasons.push(`使用先否定或保留、再转折改口的句式：${contrastMatch[0]}`);
  }
  const unsupportedMatch = value.match(/练图|练习|训练|测图|手感|疲劳|退坑|休整|休息|去了别处|状态(?:上升|下滑|崩)|主动选择|刻意|故意|坚持|裸打|手腕|身体的一部分|复杂排布|随手(?:打|摸|试)|凑数图|偏科(?:痕迹|严重)?|弱侧|全满|坐在.{0,8}边界|高速带模|潜能|潜力|天赋|能力上限|爆发力|阅读和稳定性|底盘|轻巧|别人.{0,30}(?:你|到你)|(?:Acc|准确率).{0,12}(?:掉|跌|降)|(?:没|不)?怕难|自我约定|拖(?:了)?后腿|没找到平衡点|还没找到平衡点|搏斗|远没到收手|还没到收手|野心|没掉队过|遛弯|松弛感|轻松拿|随便拿|随便逛|习惯练到|练到这个程度|好久没见|嫌多余/i);
  if (unsupportedMatch) {
    reasons.push(`包含未经证据支持的动机或状态词：${unsupportedMatch[0]}`);
  }

  const topCount = Number(sections.safeFacts.match(/BP 成绩数量: (\d+)/)?.[1] || 0);
  const topHighAccCount = Number(sections.safeFacts.match(/98% 以上 (\d+)张/)?.[1] || 0);
  const topBelowNinetyFive = Number(sections.safeFacts.match(/低于 95% (\d+)张/)?.[1] || 0);
  const topFiveAbove520Count = Number(sections.safeFacts.match(/BP5 中 (\d+)张达到 520pp/)?.[1] || 0);

  if (
    topCount > 0 &&
    topHighAccCount < topCount &&
    /(?:Acc|准确率)[^。\n]{0,20}(?:全线|全部|全都|清一色)[^。\n]{0,20}(?:98%|98％|高于|超过|往上)|(?:全线|全部|全都|清一色)[^。\n]{0,20}(?:Acc|准确率)[^。\n]{0,20}(?:98%|98％|高于|超过|往上)/i.test(value)
  ) {
    reasons.push(`把 ${topHighAccCount}/${topCount} 张达到 98% 以上夸写成了全体成绩`);
  }

  const topModsLine = sections.safeFacts.match(/BP Mods: ([^\n]+)/)?.[1] || '';
  const topModCounts = new Map<string, number>(
    [...topModsLine.matchAll(/([A-Z]+) (\d+)张/g)].map(match => [match[1], Number(match[2] || 0)])
  );
  const dtScoreCount = [...topModsLine.matchAll(/([A-Z]+) (\d+)张/g)]
    .filter(match => match[1].includes('DT'))
    .reduce((sum, match) => sum + Number(match[2] || 0), 0);
  if (
    topCount > 0 &&
    dtScoreCount < topCount &&
    /(?:全是|全部|清一色)(?:[^。\n]{0,12})带?\s*(?:HD)?DT|几乎每(?:一)?(?:张|次)[^。\n]{0,20}(?:DT|加速|速度)/i.test(value)
  ) {
    reasons.push(`把 ${dtScoreCount}/${topCount} 张带 DT 的成绩夸写成了全部或几乎每张`);
  }

  for (const mod of ['HDHRDT', 'HDHR', 'HDDT', 'HD', 'HR', 'DT', 'NM']) {
    const count = Number(topModCounts.get(mod) || 0);
    if (
      count > 0 &&
      new RegExp(`(?:一张|完全|根本|压根)[^。\\n]{0,20}${mod}[^。\\n]{0,12}(?:都)?没有|${mod}[^。\\n]{0,20}(?:一张都没有|完全没有|为零|0\\s*张)`, 'i').test(value)
    ) {
      reasons.push(`声称 BP 中没有 ${mod}，但核准数据实际有 ${count} 张`);
    }
  }

  if (
    /(?:7(?:\.0)?\s*[★星](?:以上|往上)[^。\n]{0,20}\d+\s*张|\d+\s*张[^。\n]{0,20}7(?:\.0)?\s*[★星](?:以上|往上))/i.test(value) &&
    !/BP 星数:[^\n]*7(?:\.0)?★[^|]*\d+张/.test(sections.safeFacts)
  ) {
    reasons.push('把程序统计的 >6.5★ 分布擅自改成了 7★ 以上分布');
  }

  if (
    topFiveAbove520Count > 0 &&
    topFiveAbove520Count < 5 &&
    /BP\s*5[^。\n]{0,35}(?:齐刷刷|全部|全都|五张)[^。\n]{0,25}(?:520|越过|超过|达到)/i.test(value)
  ) {
    reasons.push(`把 BP5 中 ${topFiveAbove520Count} 张达到 520pp 夸写成了全部五张`);
  }

  if (
    topBelowNinetyFive > 0 &&
    /(?:没有|一张都没有|全都)[^。\n]{0,16}(?:低于|跌破)\s*95|(?:低于|跌破)\s*95[^。\n]{0,16}(?:没有|为零|0\s*张)/i.test(value)
  ) {
    reasons.push(`忽略了 ${topBelowNinetyFive} 张低于 95% 的 BP 成绩`);
  }

  if (/平均\s*(?:Acc|准确率)[^。\n]{0,32}(?:待在|落在|保持在|覆盖|达到|有|共)[^。\n]{0,12}(?:\d+|[一二三四五六七八九十百]+)\s*张(?:以上)?/i.test(value)) {
    reasons.push('把整体平均准确率与高准确率成绩数量拼成了同一个统计量');
  }

  const inventedMechanism = value.match(/最舒服(?:的)?(?:区间|范围|难度|游乐场)?|舒适区|复杂曲线|(?:没|没有|不).{0,8}往.{0,12}(?:堆|发展|练)|解题方式|肌肉记忆|条件反射|本能|手眼配合|手速|节奏串|流动型图|密度图|高密(?:度)?|低密(?:度)?|图型|光标.{0,16}(?:等|追)|拆解结构|靠.{0,16}读图|读的从来/i);
  if (inventedMechanism) {
    reasons.push(`把成绩分布写成了未经提供的感受、意图或操作机制：${inventedMechanism[0]}`);
  }

  const unsupportedComparison = value.match(/大多数人|同段位(?:玩家|里|中|水平)|同分段(?:玩家|里|中|水平)|(?:这个|该|排名)分段.{0,12}(?:少见|不多见|罕见)|分段.{0,8}(?:少见|不多见|罕见)|比别人|超过绝大多数|罕见/i);
  if (unsupportedComparison) {
    reasons.push(`使用了简报未提供的玩家群体比较：${unsupportedComparison[0]}`);
  }

  const unsupportedScale = value.match(/(?=[^。\n]*(?:PP\+|六维|六条))[^。\n]{0,120}(?:顶满|拉满|触顶|满格)|(?:Flow|Accuracy|Precision|Stamina|Jump|Speed)[^。\n]{0,30}(?:顶满|拉满|触顶|满格)/i);
  if (unsupportedScale) {
    reasons.push(`把只能相对比较的 PP+ 显示条写成了绝对满值：${unsupportedScale[0]}`);
  }

  const trivialRestatement = value.match(/(?:Flow|Accuracy|Precision|Stamina|Jump|Speed)\s*(?:显示条)?(?:这么|很|相当)?(?:高|低)[^。\n]{0,20}(?:显眼|明显|突出)/i);
  if (trivialRestatement) {
    reasons.push(`角色发言只复述了字段高低，没有形成新判断：${trivialRestatement[0]}`);
  }

  const unsupportedHighAccPlural = value.match(/好几张[^。\n]{0,20}(?:逼近|接近|达到)\s*99(?:\.7|\.?%)/i);
  if (unsupportedHighAccPlural) {
    reasons.push(`使用了核准简报没有统计的高准确率复数量词：${unsupportedHighAccPlural[0]}`);
  }

  if (/[（(]\s*(?:挑眉|歪头|坏笑|轻笑|眨眼|得意)[^）)]*[）)]/.test(value)) {
    reasons.push('使用括号舞台动作代替自然的角色表达');
  }

  const normalizeNumber = (token: string) => {
    const numeric = Number(token.replace(/,/g, ''));
    return Number.isFinite(numeric) ? String(numeric) : token;
  };
  const allowedNumbers = new Set(
    (sections.safeFacts.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).flatMap((token) => {
      const normalized = normalizeNumber(token);
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) return [normalized];
      return [
        normalized,
        String(Math.round(numeric)),
        String(Number(numeric.toFixed(1))),
        String(Number(numeric.toFixed(2))),
      ];
    })
  );
  const reportNumbers = (value.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).map(normalizeNumber);
  const unknownNumbers = [...new Set(reportNumbers.filter(token => !allowedNumbers.has(token)))];
  if (unknownNumbers.length > 0) reasons.push(`包含简报外数字: ${unknownNumbers.join(', ')}`);
  return reasons;
}
