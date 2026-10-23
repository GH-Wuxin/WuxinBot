// Data preprocessor: takes raw osu! API + PP+ data and produces structured input for LLM analysis.

import type { OsuUser, OsuScore, OsuMode } from './types.js';
import { formatBarsForPrompt } from './pplus.js';
import type { PPlusBars } from './pplus.js';
import { buildPippiPrompt } from '../bot/persona.js';
import { OSU_WIKI_DOMAIN_RULES } from './wikiKnowledge.js';
import { normalizedScoreMods, scoreStarRating } from './scoreMetrics.js';
import { buildModKnowledge, SPECIAL_MOD_ACRONYMS } from './knowledge/index.js';

export interface AnalyzerInput {
  user: OsuUser;
  bestScores: OsuScore[];
  recentScores: OsuScore[];
  mode: OsuMode;
  pplusBars: PPlusBars | null;
  refBars: { label: string; bars: PPlusBars }[];
  classification?: {
    distribution: Record<string, number>;
    details?: Record<string, Record<string, number>>;
  } | null;
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
  knowledgeContext: string;
  safeFacts: string;
  safeBody: string;
  safeSectionFallbacks: AnalysisSectionComments;
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
  classification: string;
}

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
  const { user, bestScores, recentScores, pplusBars, refBars, mode, classification } = input;
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
    pplusSection = formatBarsForPrompt(pplusBars, '你的 PP+ 六维（LazyBot 同款归一化，15 = expertPlus 基准线，可超出）');
    if (refBars.length > 0) {
      pplusSection += '\n';
      for (const ref of refBars) {
        pplusSection += '\n' + formatBarsForPrompt(ref.bars, `参考: ${ref.label}`);
      }
    }
    pplusSection += '\n\n尺度说明: 以 15 为 expertPlus 基准线的归一化展示值，适合观察同一玩家六个维度的相对形状；超过 15 表示该维度 raw 值已超过基准上限。世界排名、段位和绝对能力需要其他证据；低值只描述现有成绩。';
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
    `账号年龄: 距注册约 ${daysSinceJoin.toLocaleString()} 天；这是程序按当前日期计算的经过时间。可以据此换算成年/月，但写出的数字必须与这个天数一致。`,
    `评级: SSH ${Number((gc as any)?.ssh || 0)} | SS ${Number((gc as any)?.ss || 0)} | SH ${Number((gc as any)?.sh || 0)} | S ${Number((gc as any)?.s || 0)} | A ${Number((gc as any)?.a || 0)}`,
    '评级解释权限: 评级数量只是累计分布；A 多于 S、S 多于 SS 不能直接解释为账号更厚、更努力、发挥更差或更好。',
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
  let hdContainsCount = 0;
  let hrContainsCount = 0;
  let dtContainsCount = 0;
  let nmPureCount = 0;
  let topFivePpMin = 0;
  let topFivePpMax = 0;
  let topFivePpAvg = 0;
  let topFivePpSpan = 0;
  let pplusLeaders = '';
  let pplusLowest = '';
  let pplusAboveBenchmark: string[] = [];
  let recentAccDeltaPoints = 0;
  let recentStarDelta = 0;
  let topFiveLargestGapSummary = '';
  let topFiveCommonModSummary = '';
  let classificationFallback = '这次没有可用的谱面分类数据。';
  let topFocus = '没有 BP 数据，只能明确缺失。';
  let topFiveFocus = '没有 BP5 数据，不能比较头部结构。';
  let modsFocus = '没有 BP Mod 数据，不能判断构成。';
  let pplusFocus = 'PP+ 缺失，六维保持未知。';
  let recentFocus = 'Recent 为空，只说明没有返回记录，不猜玩家状态，也不催促补数据。';
  let classificationFocus = '分类缺失，只说明不可用。';
  const presentModAcronyms = new Set<string>();
  const specialModCounts = new Map<string, {
    count: number;
    topFiveCount: number;
    accuracySum: number;
    starSum: number;
    starCount: number;
  }>();
  let notableModSummary = '';
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
    for (const [scoreIndex, score] of bestScores.entries()) {
      const label = modsLabel(score.mods);
      const item = modStats.get(label) || { count: 0, acc: 0, pp: 0 };
      item.count += 1;
      item.acc += score.accuracy;
      item.pp += Number(score.pp || 0);
      modStats.set(label, item);
      if (label.includes('HD')) hdContainsCount += 1;
      if (label.includes('HR')) hrContainsCount += 1;
      if (label.includes('DT') || label.includes('NC')) dtContainsCount += 1;
      if (label === 'NM') nmPureCount += 1;
      for (const mod of normalizedScoreMods(score)) {
        presentModAcronyms.add(mod);
        if (!SPECIAL_MOD_ACRONYMS.has(mod)) continue;
        const current = specialModCounts.get(mod) || {
          count: 0,
          topFiveCount: 0,
          accuracySum: 0,
          starSum: 0,
          starCount: 0,
        };
        current.count += 1;
        if (scoreIndex < 5) current.topFiveCount += 1;
        current.accuracySum += Number(score.accuracy || 0);
        const moddedStars = scoreStarRating(score);
        if (moddedStars > 0) {
          current.starSum += moddedStars;
          current.starCount += 1;
        }
        specialModCounts.set(mod, current);
      }
    }
    const sortedMods = [...modStats.entries()].sort((a, b) => b[1].count - a[1].count);
    mainMod = sortedMods[0]?.[0] || '无';
    mainModCount = sortedMods[0]?.[1].count || 0;
    const topTwoModCount = sortedMods.slice(0, 2).reduce((sum, [, item]) => sum + item.count, 0);
    const topTwoModSummary = sortedMods.length >= 2
      ? `${sortedMods[0][0]} 与 ${sortedMods[1][0]} 合计 ${topTwoModCount}张（占 BP ${(topTwoModCount / bestScores.length * 100).toFixed(0)}%）`
      : `${mainMod} ${mainModCount}张（占 BP ${(mainModCount / bestScores.length * 100).toFixed(0)}%）`;
    const modFact = sortedMods.map(([label, item]) =>
      `${label} ${item.count}张 / 平均 Acc ${fmtAcc(item.acc / item.count)} / 平均 PP ${(item.pp / item.count).toFixed(1)}`
    ).join('；');
    const topFiveFacts = bestScores.slice(0, 5).map((score, index) =>
      `#${index + 1} ${Number(score.pp || 0).toFixed(1)}pp / ${modsLabel(score.mods)} / ${fmtAcc(score.accuracy)} / ${scoreStarRating(score) > 0 ? scoreStarRating(score).toFixed(2) : '?'}★`
    );
    const topFive = bestScores.slice(0, 5);
    const topFivePpValues = topFive
      .map(score => Number(score.pp || 0))
      .filter(value => value > 0);
    if (topFivePpValues.length > 0) {
      topFivePpMin = Math.min(...topFivePpValues);
      topFivePpMax = Math.max(...topFivePpValues);
      topFivePpAvg = topFivePpValues.reduce((sum, value) => sum + value, 0) / topFivePpValues.length;
      topFivePpSpan = topFivePpMax - topFivePpMin;
    }
    const topFiveAdjacentGaps = topFivePpValues.slice(0, -1).map((value, index) => ({
      upperRank: index + 1,
      lowerRank: index + 2,
      gap: value - topFivePpValues[index + 1],
    }));
    const largestTopFiveGap = [...topFiveAdjacentGaps].sort((a, b) => b.gap - a.gap)[0];
    if (largestTopFiveGap) {
      topFiveLargestGapSummary = `最大相邻差在 #${largestTopFiveGap.upperRank} 与 #${largestTopFiveGap.lowerRank} 之间，为 ${largestTopFiveGap.gap.toFixed(1)}pp`;
    }
    const topFiveLabels = topFive.map(score => modsLabel(score.mods));
    const commonTopFiveMods: string[] = [];
    if (topFiveLabels.length > 0 && topFiveLabels.every(label => label === 'NM')) {
      topFiveCommonModSummary = 'BP5 共同 Mod：五张均为 NM。';
    } else if (topFiveLabels.length > 0) {
      if (topFiveLabels.every(label => label.includes('HD'))) commonTopFiveMods.push('HD');
      if (topFiveLabels.every(label => label.includes('HR'))) commonTopFiveMods.push('HR');
      if (topFiveLabels.every(label => label.includes('DT') || label.includes('NC'))) commonTopFiveMods.push('DT/NC');
      if (commonTopFiveMods.length > 0) {
        topFiveCommonModSummary = `BP5 共同 Mod：五张全部含 ${commonTopFiveMods.join('、')}。`;
      }
    }
    notableModSummary = [...specialModCounts.entries()]
      .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
      .map(([mod, item]) => [
        `${mod} ${item.count}张`,
        item.topFiveCount > 0 ? `BP5 中 ${item.topFiveCount}张` : '',
        item.starCount > 0 ? `平均 ${(item.starSum / item.starCount).toFixed(2)}★` : '',
        `平均 Acc ${fmtAcc(item.accuracySum / item.count)}`,
      ].filter(Boolean).join('｜'))
      .join('；');

    topFocus = topBelowNinetyFive > bestScores.length / 2
      ? `先指出 ${topBelowNinetyFive}/${bestScores.length} 张低于 95%，整体结果尚未收稳；再看难度是否已经向上展开。`
      : topHighAccCount >= bestScores.length * 0.7
        ? `先判断 ${topHighAccCount}/${bestScores.length} 张达到 98% 所形成的高 Acc 覆盖，再结合实际星数区间评价分量。`
        : `同时呈现 ${topHighAccCount} 张 98% 以上与 ${topBelowNinetyFive} 张低于 95%，不要把混合分布说成全线稳定。`;
    topFiveFocus = topFiveLargestGapSummary
      ? `优先判断 ${topFiveLargestGapSummary}；同时查看 BP1 的 Acc、星数、Mod 是否与其余四张形成局部对照。`
      : '按 BP5 的真实跨度与每张 Acc、星数、Mod 做局部对照。';
    modsFocus = notableModSummary
      ? `先说明主体组合 ${mainMod} ${mainModCount} 张，再认真观察特殊 Mod：${notableModSummary}；存在不等于偏好，缺失不等于不敢或不会。`
      : `先说明主体组合 ${mainMod} ${mainModCount} 张及包含统计，再判断是单一主体还是多方向并存；只描述当前 BP。`;

    safeFactLines.push(
      `BP 成绩数量: ${bestScores.length}`,
      `BP 星数: 平均 ${topAverageStars.toFixed(2)}★ | 范围 ${stars[0]?.toFixed(2) || '0.00'}★ ~ ${stars[stars.length - 1]?.toFixed(2) || '0.00'}★ | <5★ ${bands.belowFive}张 | 5-6.5★ ${bands.fiveToSixFive}张 | >6.5★ ${bands.aboveSixFive}张`,
      `BP Acc: 平均 ${fmtAcc(topAverageAcc)} | 98% 以上 ${topHighAccCount}张 | 低于 95% ${topBelowNinetyFive}张`,
      `BP Acc 覆盖率: 98% 以上占 ${(topHighAccCount / bestScores.length * 100).toFixed(0)}% | 低于 95% 占 ${(topBelowNinetyFive / bestScores.length * 100).toFixed(0)}%`,
      topBelowNinetyFive > bestScores.length / 2
        ? 'BP 准确率判读: 超过一半成绩低于 95%，当前 BP 整体不得评价为稳定、扎实、干净或已经收稳。'
        : topHighAccCount >= bestScores.length * 0.7
          ? 'BP 准确率判读: 至少七成成绩达到 98%，可以评价当前 BP 的高 Acc 覆盖；仍不得扩大成玩家永不失误。'
          : 'BP 准确率判读: 高低 Acc 均有可见数量，必须描述分布，不把整体夸成全线稳定。',
      bestScores.length < 50
        ? `BP 样本成熟度: 当前只有 ${bestScores.length} 张 BP，属于稀疏早期样本；不得宣布成熟风格、明确主场、能力定型或稳定底子。`
        : `BP 样本成熟度: 当前收录 BP${bestScores.length}；仍只代表进入 BP 的成绩，不等于完整能力或永久偏好。`,
      `BP Mods: ${modFact}`,
      `BP 前两类精确组合合计: ${topTwoModSummary}`,
      `BP Mod 包含统计: 含 HD ${hdContainsCount}张 | 含 HR ${hrContainsCount}张 | 含 DT/NC ${dtContainsCount}张 | 纯 NM ${nmPureCount}张`,
      notableModSummary
        ? `BP 特殊 Mod 信号: ${notableModSummary}`
        : 'BP 特殊 Mod 信号: 未出现 EZ、FL、TD、HT/DC、NF/SO、SD/PF、DA/CL 等需要单独解释的 Mod',
      `BP5: ${topFiveFacts.join('；')}`,
      `BP5 PP: 最低 ${topFivePpMin.toFixed(1)} | 最高 ${topFivePpMax.toFixed(1)} | 平均 ${topFivePpAvg.toFixed(1)} | 跨度 ${topFivePpSpan.toFixed(1)}`,
      largestTopFiveGap
        ? `BP5 相邻结构: 最大相邻差位于 #${largestTopFiveGap.upperRank} 与 #${largestTopFiveGap.lowerRank}，相差 ${largestTopFiveGap.gap.toFixed(1)}pp；用于判断孤峰或分层，不得套固定 pp 门槛。`
        : 'BP5 相邻结构: 数据不足',
      topFiveAdjacentGaps.length > 0
        ? `BP5 所有相邻差: ${topFiveAdjacentGaps.map(item => `#${item.upperRank}-#${item.lowerRank} ${item.gap.toFixed(1)}pp`).join(' | ')}`
        : 'BP5 所有相邻差: 数据不足',
      topFiveCommonModSummary || 'BP5 共同 Mod: 五张没有共同的 HD、HR、DT/NC 或纯 NM 口径',
    );
    reportBlocks.push(
      [
        `【BP${bestScores.length} · 总览】`,
        `平均 ${topAverageStars.toFixed(2)}★｜范围 ${stars[0]?.toFixed(2) || '0.00'}★～${stars[stars.length - 1]?.toFixed(2) || '0.00'}★`,
        `平均 Acc ${fmtAcc(topAverageAcc)}`,
        `98% 以上 ${topHighAccCount} 张｜低于 95% ${topBelowNinetyFive} 张`,
        `<5★ ${bands.belowFive}｜5～6.5★ ${bands.fiveToSixFive}｜>6.5★ ${bands.aboveSixFive}`,
        stars.length < bestScores.length ? `星数不可用 ${bestScores.length - stars.length} 张` : '',
      ].filter(Boolean).join('\n'),
      [
        '【BP5】',
        ...topFiveFacts,
        topFivePpValues.length > 0
          ? `PP 统计：最低 ${topFivePpMin.toFixed(1)}｜最高 ${topFivePpMax.toFixed(1)}｜平均 ${topFivePpAvg.toFixed(1)}｜跨度 ${topFivePpSpan.toFixed(1)}`
          : '',
        topFiveCommonModSummary,
      ].filter(Boolean).join('\n'),
      [
        '【Mods】',
        ...sortedMods.slice(0, 5).map(([label, item]) =>
          `${label}｜${item.count} 张｜Acc ${fmtAcc(item.acc / item.count)}｜均 PP ${(item.pp / item.count).toFixed(1)}`
        ),
        sortedMods.length > 5 ? `其余组合 ${sortedMods.length - 5} 类` : '',
        `包含统计：含 HD ${hdContainsCount} 张｜含 HR ${hrContainsCount} 张｜含 DT/NC ${dtContainsCount} 张｜纯 NM ${nmPureCount} 张`,
        notableModSummary ? `特殊 Mod：${notableModSummary}` : '',
        `BP 中出现最多的精确组合：${mainMod}（${mainModCount} 张）`,
      ].filter(Boolean).join('\n')
    );
  } else {
    safeFactLines.push('BP 成绩: 无数据');
    reportBlocks.push(
      '【BP】\n这次没有可用于完整分析的 BP 成绩。',
      '【BP5】\n这次没有可用于比较的 BP5 成绩。',
      '【Mods】\n这次没有可用于统计 Mod 构成的 BP 成绩。',
    );
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
    pplusAboveBenchmark = pplusDimensions
      .filter(([, value]) => Number(value) > 15)
      .map(([name, value]) => `${name} ${Number(value).toFixed(2)}（超出 ${(Number(value) - 15).toFixed(2)}）`);
    const pplusLeadGap = Number(pplusDimensions[0][1]) - Number(pplusDimensions[1][1]);
    pplusFocus = bestScores.length < 50
      ? `BP 只有 ${bestScores.length} 张，六维属于早期显示；只说 ${pplusLeaders} 相对较高、${pplusLowest} 最低，不宣布强项、路线或成熟形状。`
      : pplusLeadGap >= 3
        ? `先观察第一项 ${pplusDimensions[0][0]} 与第二项 ${pplusDimensions[1][0]} 相差 ${pplusLeadGap.toFixed(2)} 的断层；只描述显示结构，不翻译成具体操作能力。`
        : `先观察最高两项 ${pplusLeaders} 是否接近及其与其余项目的相对距离；只描述显示结构，不翻译成具体操作能力。`;
    safeFactLines.push(
      `PP+ 归一化显示条: Flow ${pplusBars.flow.toFixed(2)} | Accuracy ${pplusBars.accuracy.toFixed(2)} | Precision ${pplusBars.precision.toFixed(2)} | Stamina ${pplusBars.stamina.toFixed(2)} | Jump ${pplusBars.jump.toFixed(2)} | Speed ${pplusBars.speed.toFixed(2)}`,
      `PP+ 基准线: 15 = LazyBot expertPlus 基准（原显示上限，纯数据流不截断）；超过 15 表示该维度 raw 值已超过基准上限`,
      pplusAboveBenchmark.length > 0
        ? `PP+ 超出基准线: ${pplusAboveBenchmark.join('；')}`
        : 'PP+ 超出基准线: 无维度超过 15',
      `PP+ 相对顺序: 最高两项为 ${pplusLeaders}；最低项为 ${pplusLowest}`,
      'PP+ 解释权限: 只可比较同一玩家六维显示条的相对高低；不得据此划分世界等级，也不得把低值写成绝对不会。',
    );
    recentFocus = recentScores.length === 1
      ? 'Recent 只有 1 条，只能指出这条与 BP 聚合值的差异；可以轻提状态，不能当成完整判断。'
      : recentStarDelta >= 0.25 && recentAccDeltaPoints <= -5
        ? `当前 Recent 平均星数比 BP 高 ${recentStarDelta.toFixed(2)}★、Acc 低 ${Math.abs(recentAccDeltaPoints).toFixed(2)} 个百分点，可以概括为“这批记录往更高难度伸手但结果尚未收稳”。`
        : Math.abs(recentStarDelta) <= 0.15 && recentAccDeltaPoints <= -3
          ? `当前 Recent 与 BP 难度接近，但 Acc 低 ${Math.abs(recentAccDeltaPoints).toFixed(2)} 个百分点；可以轻提“状态不在线”这类贴数据的推断，不要编具体故事。`
          : '按样本量陈述 Recent 与 BP 的两项差值；允许贴数据的轻推断（如“最近没怎么玩”），不要编具体故事。';
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
        `最高两项：${pplusLeaders}｜最低项：${pplusLowest}`,
        pplusAboveBenchmark.length > 0 ? `超出 15 基准线：${pplusAboveBenchmark.join('；')}` : '六维均在 15 基准线以内',
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
      'Recent 解释权限: 这批样本与 BP 聚合值的差异是可见事实；可以据此做贴数据的轻推断（如“最近没怎么玩”“状态不在线”），不要编造具体经历故事。',
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
    safeFactLines.push('Recent 样本: 0次；没有近期记录本身是事实，可以据此轻提“最近没怎么玩”，但不要编造具体经历。');
    reportBlocks.push('【Recent】\n这次 API 没有返回近期记录。');
  }

  if (classification?.distribution && Object.keys(classification.distribution).length > 0) {
    const entries = Object.entries(classification.distribution)
      .filter(([, count]) => Number(count) > 0)
      .sort((left, right) => Number(right[1]) - Number(left[1]));
    const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
    const classificationLines = entries.map(([label, count]) => {
      const share = total > 0 ? Number(count) / total * 100 : 0;
      return `${label} ${Number(count)}张（${share.toFixed(0)}%）`;
    });
    const first = entries[0];
    const second = entries[1];
    if (first) {
      classificationFallback = `当前 BP${total} 中，${first[0]} 为 ${Number(first[1])} 张${second ? `，${second[0]} 为 ${Number(second[1])} 张，两者相差 ${Number(first[1]) - Number(second[1])} 张` : ''}；这里只描述当前样本。`;
      const firstShare = total > 0 ? Number(first[1]) / total * 100 : 0;
      classificationFocus = total < 50
        ? `当前只有 BP${total}，即使 ${first[0]} 占 ${firstShare.toFixed(0)}% 也只算最早一批成绩的构成；禁止称为偏科、主场或既定路线。`
        : firstShare >= 70
          ? `${first[0]} ${Number(first[1])} 张是当前 BP 的压倒性主体；仍表述为当前构成，不扩大成完整能力或永久偏好。`
          : second
            ? `${first[0]} ${Number(first[1])} 张领先，但第二类 ${second[0]} ${Number(second[1])} 张也有分量；不要把第一类写成一边倒。`
            : `只描述当前 ${first[0]} ${Number(first[1])} 张。`;
    }
    safeFactLines.push(
      `谱面类型样本: BP${total}；${classificationLines.join(' | ')}`,
      first
        ? `谱面类型结构: 第一类 ${first[0]} ${Number(first[1])}张${second ? `；第二类 ${second[0]} ${Number(second[1])}张；两者相差 ${Number(first[1]) - Number(second[1])}张` : ''}`
        : '谱面类型结构: 无可用分类',
      '谱面类型解释权限: 分类描述当前 BP 样本，不等于永久风格；样本稀疏时不得提前定型。可以和 PP+、Mods、Acc 观察是否方向相容，但不得写成因果。',
    );
    reportBlocks.push([
      '【谱面类型分布】',
      `BP${total} 分类统计（osu!oracle）：`,
      ...classificationLines.map((line) => `  ${line}`),
    ].join('\n'));
  } else {
    safeFactLines.push('谱面类型样本: 不可用；不得猜测分类或永久风格。');
    reportBlocks.push('【谱面类型分布】\n这次没有可用的谱面分类数据。');
  }

  safeFactLines.push(
    '【本账号写作焦点（程序按本次事实选择；不是成品句子）】',
    Number(s.global_rank || 0) <= 2 && Number(s.global_rank || 0) > 0
      ? `profile: 全球 #${Number(s.global_rank)} 与 ${s.pp.toFixed(1)}pp 是第一反应重点，必须体现塔尖位置的独立分量；不能归因于运气、长期训练或天赋。`
      : bestScores.length < 50 || Number(s.play_count || 0) < 500
        ? `profile: 账号只有 ${s.play_count.toLocaleString()} 次游玩、BP${bestScores.length}，先承认纯萌新/稀疏体量；不要冷评排名、比较成长速度、声称手稳或提前定型。`
        : `profile: 用全球 #${s.global_rank?.toLocaleString() || '未上榜'} 与 ${s.pp.toFixed(1)}pp 判断账号分量，再从总 Acc 或账号体量选一个真正有辨识度的补充；不评价努力、效率或心态。`,
    `top: ${topFocus}`,
    `top5: ${topFiveFocus}`,
    `mods: ${modsFocus}`,
    `pplus: ${pplusFocus}`,
    `recent: ${recentFocus}`,
    `classification: ${classificationFocus}`,
    bestScores.length < 50
      ? 'conclusion: 纯萌新结论不强调低排名；优先认真看 BP5 中最干净的一张局部亮点，同时明确样本尚未定型，不安排训练目标。'
      : 'conclusion: 必须使用核准的全球 rank 或账号总 pp 判断分量，再综合至少两个栏目形成只属于本账号的整体印象；不得只列事实清单。',
    '缺失数据的含义: 某类成绩没有展示；兴趣、能力和游玩习惯均保持未知。',
    '未提供 replay、谱面图型标签、玩家动机、设备和身体状态，禁止推断这些内容。',
  );

  const safeFacts = safeFactLines.join('\n');
  const knowledgeContext = buildModKnowledge(presentModAcronyms);
  const safeBody = reportBlocks.join('\n\n');
  const safeSectionFallbacks: AnalysisSectionComments = {
    profile: Number(s.global_rank || 0) > 0
      ? `当前可确认的是全球 #${Number(s.global_rank).toLocaleString()}、${s.pp.toFixed(1)}pp 与总 Acc ${s.hit_accuracy.toFixed(2)}%；累计游玩时长为 ${fmtPlayTime(s.play_time)}。`
      : `当前账号为 ${s.pp.toFixed(1)}pp、总 Acc ${s.hit_accuracy.toFixed(2)}%；全球排名暂未提供。`,
    top: bestScores.length > 0
      ? `BP${bestScores.length} 的难度范围为 ${topAverageStars > 0 ? `${Math.min(...bestScores.map(scoreStarRating).filter(value => value > 0)).toFixed(2)}★～${Math.max(...bestScores.map(scoreStarRating).filter(value => value > 0)).toFixed(2)}★` : '星数不可用'}；其中 ${topHighAccCount} 张达到 98% 以上，${topBelowNinetyFive} 张低于 95%。`
      : '这次没有可用于形成 BP 观察的成绩。',
    top5: bestScores.length > 0
      ? `BP1 为 ${topFivePpMax.toFixed(1)}pp，BP5 跨度为 ${topFivePpSpan.toFixed(1)}pp${topFiveLargestGapSummary ? `；${topFiveLargestGapSummary}` : ''}。`
      : '这次没有可用于比较 BP5 的成绩。',
    mods: bestScores.length > 0
      ? `当前 BP 中最多的精确组合是 ${mainMod}（${mainModCount} 张）；含 HD ${hdContainsCount} 张、含 HR ${hrContainsCount} 张、含 DT/NC ${dtContainsCount} 张、纯 NM ${nmPureCount} 张。`
      : '这次没有可用于判断 Mod 构成的 BP 成绩。',
    pplus: pplusBars
      ? `当前 PP+ 六维最高两项为 ${pplusLeaders}，最低项为 ${pplusLowest}；这里只比较同一账号六维的相对形状。`
      : '这次没有可用的 PP+ 数据，六维形状保持未知。',
    recent: recentScores.length > 0
      ? `这 ${recentScores.length} 条 Recent 与 BP 的平均星数、Acc 存在可见差异，具体原因没有数据支持。`
      : '这次 API 没有返回 Recent 记录，近期状态保持未知。',
    classification: classificationFallback,
  };
  // Deterministic fallback: plain, fact-accurate sentences built from the most
  // salient verified facts (rank, BP structure, Mod containment, PP+ benchmark
  // excess). No judgement words, no persona flourishes.
  const fallbackLines: string[] = ['【结论】'];
  const globalRank = Number(s?.global_rank || 0);
  if (globalRank > 0) {
    fallbackLines.push(globalRank === 1 ? '全球排名第 1。' : `全球排名 #${globalRank.toLocaleString()}。`);
  }
  if (bestScores.length > 0) {
    fallbackLines.push(`BP${bestScores.length} 平均 ${topAverageStars.toFixed(2)}★，最高 ${topFivePpMax.toFixed(1)}pp，${mainMod} 组合 ${mainModCount} 张。`);
    fallbackLines.push(`Mod 包含统计：含 HD ${hdContainsCount} 张，含 HR ${hrContainsCount} 张，含 DT/NC ${dtContainsCount} 张，纯 NM ${nmPureCount} 张。`);
  }
  if (pplusBars) {
    fallbackLines.push(
      pplusAboveBenchmark.length > 0
        ? `PP+ 超出 15 基准线：${pplusAboveBenchmark.join('；')}。`
        : 'PP+ 六维均在 15 基准线以内。'
    );
  }
  const safePippiFallback = fallbackLines.length > 1
    ? fallbackLines.join('\n')
    : [
        '【结论】',
        '当前数据不足以形成完整标签。',
      ].join('\n');
  const safeFallback = `${safeBody}\n\n${safePippiFallback}`;
  return {
    profile, ppBreakdown, modsProfile, starDistribution, accuracyProfile,
    timeProfile, gradeProfile, recentForm, pplusSection, knowledgeContext,
    safeFacts, safeBody, safeSectionFallbacks, safePippiFallback, safeFallback
  };
}

export function buildAnalysisPrompt(
  sections: AnalyzerSections,
  personalityPrompt: string,
  narrative: AnalysisNarrativeContext = {},
  promptSections: Record<string, string> = {},
): { system: string; user: string } {
  const taskRules = [
    OSU_WIKI_DOMAIN_RULES,
    sections.knowledgeContext,
    '只使用数据块中明确提供的事实。不要使用你对谱面标题、玩家或社区传闻的记忆补齐资料。',
    '谱面标题和难度名只用于识别具体成绩，不包含图型标签。即使你认识这张谱，也绝对不能据此称它为跳图、串图、速度图、耐力图或描述其长度、物量和段落。',
    '各数据区块大多是独立聚合值。除非同一行明确连接了 Mod、星数、Acc 或谱面，否则不能自行声称某个 Mod 集中在某星数区间，也不能构造不存在的相关性。',
    '不得补充数据块未提供的 mapper、年份、谱面长度、物量、重试次数、失败位置或成绩分布。',
    'PP+ 六维只用于观察当前账号能力展示的相对形状，不得把显示条直接改写成世界级别、段位或绝对能力判决。',
    '不要发明"常见六维形状"、玩家类别体系或项目没有提供的评价标准。',
    '可以检查 PP+、Mod、星数和 Acc 是否呈现相容的方向；如果不能可靠互证，就分别描述，不强行建立因果。',
    'Recent 与 BP 样本性质不同。可以指出两者可见差异，并做贴数据的轻推断（如“最近没怎么玩”“状态不在线”）；不要编造具体经历故事。',
    '讨论 Recent 时可以陈述数值变化并做贴数据的轻推断；不要编造测图、练习、疲劳等具体经历故事。',
    '没有出现某类 Mod 或成绩，只能说当前记录没有展示，不能说玩家不喜欢、不会或从不游玩。',
    '参考玩家数据只提供尺度语境，不得用于贬低、排名或给玩家划分档次。',
    '社区术语可以自然使用，但只有输入足以支持时才使用具体图型判断。',
    '使用适合 QQ 阅读的短块格式，依次保留【BP】【PP+】【Recent】【结论】四块；每行只表达一个重点，并用空行分隔。',
    '正文通常 260-520 个汉字；数据较少时可以更短。不要写成长篇连续作文。',
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
    compactAnalysisPersona: true,
    userPersonality: personalityPrompt || '',
    promptSections,
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

export function validateAnalysisReport(text: string): { ok: boolean; reasons: string[] } {
  const value = String(text || '').trim();
  // Check report structure; the model interprets the supplied evidence.
  const reasons: string[] = [];
  if (value.length < 600) reasons.push('完整报告过短或疑似缺少数据节点');
  if (value.length > 6000) reasons.push('完整报告异常过长');
  const requiredHeadings: [string, RegExp][] = [
    ['账号档案', /【账号档案/],
    ['BP 总览', /【BP(?:\d+ · 总览)?】/],
    ['BP5', /【BP5】/],
    ['Mods', /【Mods】/],
    ['PP+', /【PP\+ 六维】/],
    ['Recent', /【Recent/],
    ['谱面类型分布', /【谱面类型分布】/],
    ['结论', /【结论】/],
  ];
  for (const [heading, pattern] of requiredHeadings) {
    if (!pattern.test(value)) reasons.push(`缺少 QQ 节点: ${heading}`);
  }
  if (/【pippi|pippi\s*[：:]/i.test(value)) reasons.push('正文中重复标注 pippi 身份');
  return { ok: reasons.length === 0, reasons };
}
