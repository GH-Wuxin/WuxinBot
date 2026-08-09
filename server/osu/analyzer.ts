// Data preprocessor: takes raw osu! API + PP+ data and produces structured input for LLM analysis.

import type { OsuUser, OsuScore, OsuMode } from './types.js';
import { formatBarsForPrompt } from './pplus.js';
import type { PPlusBars } from './pplus.js';
import { buildPippiPrompt } from '../bot/persona.js';
import { findModSemanticsViolation, OSU_WIKI_DOMAIN_RULES } from './wikiKnowledge.js';
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

export interface AnalysisStyleAvoidance {
  /** Recent final sentences shown to users, newest first. */
  recentExpressions: string[];
  /** Short fragments that have already become visible templates. */
  blockedFragments: string[];
}

function normalizeStyleText(value: unknown): string {
  return String(value || '')
    .replace(/【[^】]+】/g, '')
    .replace(/[\d０-９]+(?:[.,，．]\d+)?/g, '#')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase();
}

function styleNgrams(value: string, size = 3): Set<string> {
  const result = new Set<string>();
  if (value.length < size) return result;
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function styleSimilarity(left: string, right: string): number {
  const a = styleNgrams(normalizeStyleText(left));
  const b = styleNgrams(normalizeStyleText(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

/**
 * Detect only obvious expression reuse. This is deliberately narrower than a
 * prose-quality gate: the LLM remains free to use similar facts or tone, but
 * cannot ship a recently used sentence skeleton or a known canned fragment.
 */
export function findAnalysisStyleReuse(
  value: unknown,
  avoidance?: AnalysisStyleAvoidance,
): string[] {
  if (!avoidance) return [];
  const text = String(value || '').trim();
  if (!text) return [];
  const reasons: string[] = [];
  const blocked = [...(avoidance.blockedFragments || [])];
  for (const fragment of new Set(blocked.map((item) => String(item || '').trim()).filter(Boolean))) {
    if (text.includes(fragment)) reasons.push(`复用了冷却表达“${fragment}”`);
  }
  for (const previous of avoidance.recentExpressions || []) {
    const oldText = String(previous || '').trim();
    if (oldText.length < 10) continue;
    const normalizedText = normalizeStyleText(text);
    const normalizedOld = normalizeStyleText(oldText);
    const contained = normalizedText.length >= 10 && normalizedOld.length >= 10
      && (normalizedText.includes(normalizedOld) || normalizedOld.includes(normalizedText));
    if (contained || styleSimilarity(text, oldText) >= 0.72) {
      reasons.push('与近期成品表达过于相似，请更换观察角度和句法骨架');
      break;
    }
    const currentSentences = text.split(/[。！？?!]+/).map((item) => item.trim()).filter(Boolean);
    const previousSentences = oldText.split(/[。！？?!]+/).map((item) => item.trim()).filter(Boolean);
    const repeatedSentence = currentSentences.some((current) =>
      normalizeStyleText(current).length >= 12
      && previousSentences.some((old) =>
        normalizeStyleText(old).length >= 12 && styleSimilarity(current, old) >= 0.72
      )
    );
    if (repeatedSentence) {
      reasons.push('复用了近期成品的句子骨架，请从零改写');
      break;
    }
  }
  return [...new Set(reasons)];
}

function conclusionSentences(value: unknown): string[] {
  return String(value || '')
    .replace(/【结论】/g, '')
    .split(/[。！？?!\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0;
  const previous = new Uint16Array(right.length + 1);
  let longest = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = previous[rightIndex];
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        previous[rightIndex] = diagonal + 1;
        if (previous[rightIndex] > longest) longest = previous[rightIndex];
      } else {
        previous[rightIndex] = 0;
      }
      diagonal = old;
    }
  }
  return longest;
}

/**
 * Detect conclusion sentences copied from this same report's seven comments.
 * Reusing short factual phrases is expected; copying a whole observation or a
 * long sentence skeleton is not. This check is deliberately report-local and
 * never receives another player's output.
 */
export function findConclusionSectionReuse(
  conclusion: unknown,
  comments?: AnalysisSectionComments | null,
): string[] {
  if (!comments) return [];
  const conclusionParts = conclusionSentences(conclusion);
  const sectionParts = Object.entries(comments).flatMap(([section, comment]) =>
    conclusionSentences(comment).map((sentence) => ({ section, sentence }))
  );
  for (const conclusionPart of conclusionParts) {
    const normalizedConclusion = normalizeStyleText(conclusionPart);
    if (normalizedConclusion.length < 18) continue;
    for (const sectionPart of sectionParts) {
      const normalizedSection = normalizeStyleText(sectionPart.sentence);
      const shorter = Math.min(normalizedConclusion.length, normalizedSection.length);
      if (shorter < 18) continue;
      const commonLength = longestCommonSubstringLength(normalizedConclusion, normalizedSection);
      const copiedWholeSentence = normalizedConclusion === normalizedSection && shorter >= 18;
      const copiedLongSkeleton = commonLength >= 24 && commonLength / shorter >= 0.84;
      if (copiedWholeSentence || copiedLongSkeleton) {
        return [`结论复用了 ${sectionPart.section} 短评的完整句子或长句骨架`];
      }
    }
  }
  return [];
}

const ANALYSIS_COMMENT_KEYS: (keyof AnalysisSectionComments)[] = [
  'profile',
  'top',
  'top5',
  'mods',
  'pplus',
  'recent',
  'classification',
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
  narrative: AnalysisNarrativeContext = {}
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

function factsForGeneration(sections: AnalyzerSections): string {
  return sections.safeFacts
    .split('\n')
    .filter((line) => !(
      /^【本账号写作焦点/.test(line)
      || /^(?:profile|top|top5|mods|pplus|recent|classification|conclusion):/.test(line)
    ))
    .map((line) => line.replace(/^(账号年龄: 距注册约 [^；]+)；.*$/, '$1'))
    .join('\n');
}

export function buildAnalysisEditorPrompt(
  sections: AnalyzerSections,
  narrative: AnalysisNarrativeContext = {},
  personalityPrompt = '',
  styleAvoidance?: AnalysisStyleAvoidance,
): { system: string; user: string } {
  const sparseSample = /BP 样本成熟度:[^\n]*稀疏早期样本/.test(sections.safeFacts);
  const perspective = narrative.perspective === 'self'
    ? `分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，可以自然使用"你"，但不必强制。`
    : `分析关系未确认，只使用用户名 ${narrative.playerName || '（见简报）'} 或“这位玩家”等中性指代，不用“你/你的”，也不要猜测“他/她”。`;

  const editorRules = [
    sections.knowledgeContext,
    '任务：只写报告末尾的【结论】。先形成一句只属于这个账号的中心判断，再用至少两个不同栏目的事实说明它为什么成立；第三类证据只有真正改变整体印象时才写。不要按七栏顺序重新报数。',
    sparseSample
      ? '这是 BP 不满 50 张的稀疏萌新账号。用总 pp 交代体量，不评价很后的全球排名；认真看当前局部亮点，同时明确尚未定型。比例只能照抄简报原文（如 67%、22/33），不用“一半、多数、大部分”；不预测未来、不给建议、不安排训练。'
      : 'rank 与 pp 决定评价分量，结论至少自然落入其中一个精确锚点。全球 #1/#2 必须明显特殊；普通账号不拔高。',
    '结论要回答“这份账号为什么像它自己”。不要套成“高 Acc、某 Mod 主导、两根 PP+ 突出、稳定型玩家”，也不要把程序事实排成清单。',
    '说话者是 pippi：懂 osu!、自信、活泼、有少女感，偶尔有一点最强者的小得意。称赞有依据，打趣贴着当前账号；不追星、不羞辱、不哄骗、不施舍。',
    '事实契约：只使用 verified_facts。BP 构成不是永久偏好；Recent 差异可以基于数据做轻推断（如“最近没怎么玩”“状态不在线”），但不要编造具体经历；PP+ 只能描述英文维度显示条的相对形状，不能改名或翻译为具体操作机制；aim、stream、alt、tech 也只是当前分类标签，不能翻成跳跃、耐力、手法或玩家类型。独立聚合值不能拼成不存在的因果或子集。允许把多个现象写成并列、呼应或方向相容。',
    '数字不必写满。需要数字时原样复制简报，不取整、不凑阈值、不另算新比例；账号年龄可以换算成年/天，但写出的数字必须与简报核准的天数一致。',
    '术语保留 BP、HD、HR、DT/NC、NM、aim、stream、alt、tech。不要编历史、动机、未来目标、人口百分位、设备、身体、replay 或谱面内容。',
    '不要输出 pippi 标签、署名或动作描写。',
    perspective,
    '即使能看出分析对象的性别，未确认关系时也不用“他/她”指代，只用用户名或“这位玩家/这个账号”；注册时间可以换算成“几年/多少天”，但必须与简报核准的账号年龄一致；时长按简报叫“游玩时长”，不叫“在线时长”。',
    '结论是全报告最长的段落：必须长于账号档案栏（通常 220-420 个汉字，二至四个短段）；信息稀疏可以更短。第一行写【结论】，只输出【结论】节点。',
  ].join('\n');

  const system = buildPippiPrompt({
    scene: 'osu_analysis',
    compactAnalysisPersona: true,
    userPersonality: personalityPrompt,
    taskRules: editorRules,
    includeFactBoundaries: false,
  });

  const verifiedRank = sparseSample ? '' : (sections.safeFacts.match(/全球排名:\s*(#?[\d,]+)/)?.[1] || '');
  const verifiedPp = sections.safeFacts.match(/^PP:\s*(\d+(?:\.\d+)?)/m)?.[1] || '';

  const user = [
    '<required_weight_anchor>',
    [verifiedRank && `全球排名 ${verifiedRank}`, verifiedPp && `账号总 PP ${verifiedPp}pp`].filter(Boolean).join('；'),
    '结论必须原样复制其中至少一个精确锚点，不写中文约数。',
    '</required_weight_anchor>',
    '',
    '<verified_facts>',
    factsForGeneration(sections),
    '</verified_facts>',
  ].join('\n');

  return { system, user };
}

// ── Independent reviewer (completely separated from pippi's persona) ──
// The reviewer is NOT another pippi: no name, no tone, no rewriting. It
// receives the full assembled report plus verified facts, and returns a
// per-section verdict JSON. REJECT must carry a short, loggable reason.
export interface ReviewerVerdict {
  section: string;
  result: 'PASS' | 'REJECT';
  kind?: 'hard' | 'quality';
  reason: string;
}

export function buildAnalysisReviewerPrompt(
  sections: AnalyzerSections,
  report: string,
  narrative: AnalysisNarrativeContext = {}
): { system: string; user: string } {
  const system = [
    sections.knowledgeContext,
    '你是 osu! 报告的事实质检员，只查可证明的基本事实错误；不查文风、字数、语气、比喻或推断是否“够稳重”。',
    '逐段检查 profile、top、top5、mods、pplus、recent、classification、conclusion。八段各返回一条判决。',
    '只在以下情况 REJECT，并统一写 kind=hard：',
    '1. 数字、数量关系或范围与 verified_facts 不符，或使用简报外事实。修辞中的非数字夸张不算新事实。',
    '2. 混淆精确 Mod 组合与“包含”统计；把 Mod 当成谱面自带属性；误解 HD、HR、DT/NC、EZ、FL、NF、SO、PF；把 alt 翻成跳图。',
    '3. 把独立聚合值拼成不存在的子集、因果或机制；把 PP+ 直接翻译成未提供的具体操作能力。现象之间写“并列、呼应、方向相容”可以放行。',
    '4. 与 rank、pp、BP、PP+ 或分类简报直接矛盾；混入其他玩家；猜测性别；把未确认的第三方当成发起者。',
    '5. 泄漏内部 JSON、出现断裂句或错误字段名，或整份报告缺少既定节点。区块评价是否存在已由程序保证，不要自行要求某段再覆盖特定亮点。',
    '基于数据的常识推断（例如“最近没怎么玩”“状态不在线”“像是在试别的”）不构成事实错误，不得 REJECT；只有把推断写成亲眼见过的具体故事，或与简报数字直接冲突时，才按第 1/4 条处理。',
    '“这位玩家”“该玩家”“这名玩家”“这个账号”等中性指代不属于性别代词；只有实际使用“他/她”才构成猜测性别。Auto 属于 pippi 的世界观背景，报告中拿 Auto 做对比、调侃或表达落差不算简报外事实，但不得把 Auto 的成绩写成玩家本人的事实。',
    '结论允许只选择最能支撑中心判断的栏目，不要求覆盖 BP5、Mods、PP+、Recent 或分类中的每一项；遗漏某个亮点、只写得普通或不够有趣都不是事实错误。',
    'REJECT 必须指向报告中实际写出的错误句子或错误关系；不能因为“缺少某个亮点、没有覆盖某栏目、写作焦点不符、像是复读”而拒绝。缺什么永远不是事实错误。',
    '不要因为句子太冷、太短、太长、比喻不好、没有卖萌、没有问号或像数据清单而 REJECT。不要重写正文。',
    '只输出合法 JSON：{"verdicts":[{"section":"profile","result":"PASS"},...,{"section":"conclusion","result":"REJECT","kind":"hard","reason":"具体事实错误"}]}。REJECT 原因必须具体且不超过一句。',
  ].join('\n');

  const user = [
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
    '',
    '<report>',
    report,
    '</report>',
    '',
    narrative.perspective === 'self'
      ? `发起者已绑定该账号 ${narrative.playerName || ''}，第二人称允许。`
      : `分析对象 ${narrative.playerName || ''} 未确认是发起者本人，不允许第二人称或性别代词。`,
  ].join('\n');

  return { system, user };
}

export function parseReviewerVerdicts(text: string): ReviewerVerdict[] | null {
  const value = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    const rawList = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    if (rawList.length === 0) return null;
    const verdicts: ReviewerVerdict[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const section = String(item.section || '').trim().toLowerCase();
      if (!section) continue;
      const result = String(item.result || '').trim().toUpperCase() === 'REJECT' ? 'REJECT' : 'PASS';
      verdicts.push({
        section,
        result,
        kind: result === 'REJECT' && String(item.kind || '').trim().toLowerCase() === 'quality'
          ? 'quality'
          : (result === 'REJECT' ? 'hard' : undefined),
        reason: result === 'REJECT' ? String(item.reason || '').trim().slice(0, 120) : '',
      });
    }
    const expected = ['profile', 'top', 'top5', 'mods', 'pplus', 'recent', 'classification', 'conclusion'];
    const uniqueSections = new Set(verdicts.map(item => item.section));
    if (verdicts.length !== expected.length || expected.some(section => !uniqueSections.has(section))) return null;
    return verdicts;
  } catch {
    return null;
  }
}

/**
 * Surgical hard-error repair, completely separated from pippi's persona.
 * The repairer receives the failing text plus the exact mechanical reasons
 * and the verified facts, and must make the smallest possible change; the
 * result is re-validated mechanically before it can be accepted.
 */
export function buildAnalysisRepairPrompt(
  sections: AnalyzerSections,
  target: keyof AnalysisSectionComments | 'conclusion',
  text: string,
  reasons: string[],
  narrative: AnalysisNarrativeContext = {}
): { system: string; user: string } {
  const system = [
    '你是 osu! 分析报告的硬错误修复员，只负责修正 <errors> 中列出的具体错误，不负责润色、扩写或重写风格。',
    '规则：',
    '1. 只处理 <errors> 中列出的问题；没有列出的内容一律不改。',
    '2. 数字、数量、Mod、术语必须与 <verified_facts> 中的核准值一致。',
    '3. 尽量做最小改动：替换错误的数字或词语即可，保留原句结构、语气和其余文字一字不改。',
    '4. 只有错误本身在句子里无法局部修正时，才允许改写这一句；其他句子保持原样。',
    '5. 不要新增任何事实、推断或评价，不要解释修改过程。',
    '6. 直接输出修正后的完整段落，不要 JSON、不要代码块、不要前缀。',
  ].join('\n');
  const user = [
    '<verified_facts>',
    sections.safeFacts,
    '</verified_facts>',
    '',
    `<target>${target}</target>`,
    '',
    '<errors>',
    reasons.join('\n'),
    '</errors>',
    '',
    '<text>',
    text,
    '</text>',
    '',
    narrative.perspective === 'self'
      ? `分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，第二人称允许。`
      : `分析对象 ${narrative.playerName || ''} 未确认是发起者本人，不能使用“你/他/她”。`,
  ].join('\n');
  return { system, user };
}

export function buildAnalysisSectionCommentsPrompt(
  sections: AnalyzerSections,
  narrative: AnalysisNarrativeContext = {},
  personalityPrompt = '',
  styleAvoidance?: AnalysisStyleAvoidance,
  requestedKeys: readonly (keyof AnalysisSectionComments)[] = ANALYSIS_COMMENT_KEYS,
): { system: string; user: string } {
  void styleAvoidance;
  const targetKeys = requestedKeys.length > 0 ? requestedKeys : ANALYSIS_COMMENT_KEYS;
  const perspective = narrative.perspective === 'self'
    ? `分析对象是发起者本人绑定的账号 ${narrative.playerName || ''}，可以自然用“你”，也可以叫用户名。`
    : `分析对象 ${narrative.playerName || ''} 未确认是发起者本人，使用用户名或“这位玩家”等中性指代，不用“你/你的”。`;

  const focusByKey: Record<keyof AnalysisSectionComments, string> = {
    profile: '账号档案：这是全报告最长的一栏，展开写 rank、pp、总 Acc、游玩体量、评级或等级里真正有辨识度的点，串成有层次的一段（通常 140-240 字）；不把游玩次数写成努力或成长过程。',
    top: 'BP 总览：判断整份 BP 的星数区间与 Acc 覆盖，尤其注意稳定与不稳定是否真的由比例支持。不要写 BP5 或前五的具体结构（头名 pp、孤峰、相邻差），那是 top5 栏的内容。',
    top5: 'BP5：观察孤峰、相邻差、Acc/星数/Mod 的内部对照；不能凭聚合值编谱面内容或成绩原因。',
    mods: 'Mods：区分精确组合与包含统计，只评价当前 BP 构成，不写偏好、依赖、胆量或适应程度。',
    pplus: 'PP+：只评价六个英文标签显示条的相对形状、领先与断层；不要为维度改名，也不要写成爆发、容错、点圈、长串、读图等具体操作能力。稀疏萌新的近零显示条不承担能力诊断。',
    recent: 'Recent：比较当前样本与 BP 的可见差值；可以基于差值做贴数据的轻推断（如“最近没怎么玩”“状态不在线”），不要编造具体经历或故事。没有记录时可以说 API 没返回记录，也可以轻提“最近没留下新成绩”。',
    classification: '谱面分类：同时看第一、第二类与样本量，只描述当前 BP 分类构成。保留 aim、stream、alt、tech 原标签；不得翻成跳跃、耐力、流线、主攻方向、口味或某类玩家。',
  };
  const taskRules = [
    sections.knowledgeContext,
    `任务：只为 ${targetKeys.join('、')} ${targetKeys.length === 1 ? '区块' : '这些区块'}写现场短评。短评要像 pippi 看完这一栏后当面说的话，不是数据图注。`,
    '先选本栏最值得说的一件事，再完成归纳、内部比较、异常观察、分量判断或自然反应中的至少一种。数字可以少写；需要数字时原样复制简报，不取整、不另算比例；账号年龄可以换算成年/天，但必须与简报核准的天数一致。只换种说法重复程序行不算短评。',
    '账号档案是全报告字数最多的一栏：必须比其他六栏都长（通常 150-300 个汉字、三至五句），把 rank、pp、总 Acc、游玩体量、评级等真正有分量的信息串起来展开说；其余栏目保持紧凑，按信息量自然排列。',
    '反应强度跟当前账号自己的 rank、pp、BP 体量和成绩结构走。全球 #1/#2 必须明显特殊；普通账号不拔高；稀疏萌新认真看小亮点，不嘲讽、不哄骗、不提前定型。',
    ...targetKeys.map((key) => focusByKey[key]),
    '事实契约：所有数字与关系只来自 verified_facts。当前 BP 构成不是永久偏好；Recent 差异可以基于数据做轻推断（如“最近没怎么玩”），但不要编具体经历；PP+ 是显示条相对形状，不是 replay 或具体操作能力；Mod 属于成绩；缺失数据保持缺失。',
    '术语按 osu! 社区原名写：BP、HD、HR、DT/NC、NM、aim、stream、alt、tech。不要把 HD 写成隐身、把 alt 写成跳图、把 NM 写成真实实力，也不要拼出输入中不存在的 Mod 组合。',
    'pippi 自信、活泼、有少女感，偶尔露出一点最强者的小得意。人格来自选择和反应，不来自署名、固定口癖、动作描写或逐栏免责声明。句式和情绪自然变化，不强行反问或比喻。',
    '不要给玩家安排训练、下一目标或未来故事。',
    '分析对象未确认为发起者本人时，指代只能用用户名或“这位玩家/这个账号”，即使能看出性别也不用“他/她”；注册时间可以换算成“几年/多少天”，但必须与简报核准的账号年龄一致；时长按简报叫“游玩时长”，不叫“在线时长”。',
    perspective,
    `账号档案通常 150-300 个汉字（三至五句），其余栏目通常 60-180 个汉字（二至四句）；信息少可以更短。只输出合法 JSON 对象，键必须且只能是 ${targetKeys.join('、')}，每个值直接是一条字符串，不要代码块或解释。`,
  ].join('\n');

  const system = buildPippiPrompt({
    scene: 'osu_analysis',
    compactAnalysisPersona: true,
    userPersonality: personalityPrompt,
    taskRules,
    includeFactBoundaries: false,
  });

  const factPatterns: Record<keyof AnalysisSectionComments, RegExp> = {
    profile: /^(?:玩家:|PP:|等级:|账号年龄:|评级:|评级解释权限:|BP 样本成熟度:|缺失数据的含义:)/,
    top: /^(?:玩家:|PP:|BP 成绩数量:|BP 星数:|BP Acc:|BP Acc 覆盖率:|BP 准确率判读:|BP 样本成熟度:)/,
    top5: /^(?:玩家:|PP:|BP 成绩数量:|BP5:|BP5 PP:|BP5 相邻结构:|BP5 所有相邻差:|BP5 共同 Mod:)/,
    mods: /^(?:玩家:|PP:|BP 成绩数量:|BP Mods:|BP 前两类精确组合合计:|BP Mod 包含统计:|BP 特殊 Mod 信号:|BP 样本成熟度:|缺失数据的含义:)/,
    pplus: /^(?:玩家:|PP:|PP\+ |BP 样本成熟度:|缺失数据的含义:)/,
    recent: /^(?:玩家:|PP:|Recent 样本:|Recent 解释权限:|核准派生统计:|BP 样本成熟度:|缺失数据的含义:)/,
    classification: /^(?:玩家:|PP:|BP 成绩数量:|谱面类型样本:|谱面类型结构:|谱面类型解释权限:|BP 样本成熟度:|缺失数据的含义:)/,
  };
  const targetedFacts = sections.safeFacts
    .split('\n')
    .filter((line) => targetKeys.some((key) => factPatterns[key].test(line)) || /^未提供 replay/.test(line))
    .join('\n');
  const user = [
    '<verified_facts>',
    targetedFacts,
    '</verified_facts>',
  ].join('\n');

  return { system, user };
}

function parseSectionCommentJson(text: string): Record<string, unknown> | null {
  const value = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function extractSectionCommentValue(rawValue: unknown): string {
  if (rawValue && typeof rawValue === 'object') {
    return String((rawValue as Record<string, unknown>).comment || '');
  }
  const value = String(rawValue || '').trim();
  // Flash occasionally double-encodes one structured value as a JSON string.
  // Unwrap it here so internal evidence/judgment fields can never leak into
  // the user-visible report.
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const nested = JSON.parse(value);
      if (nested && typeof nested === 'object' && typeof nested.comment === 'string') {
        return nested.comment;
      }
    } catch {
      // Leave malformed strings to the normal parser/validator path.
    }
  }
  return value;
}

function chineseCardinalToNumber(value: string): number | null {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const smallUnits: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const char of value) {
    if (char in digits) {
      digit = digits[char];
      continue;
    }
    if (char in smallUnits) {
      section += (digit ?? 1) * smallUnits[char];
      digit = null;
      continue;
    }
    if (char === '万') {
      // "万" preceded by an Arabic digit ("3 万") or standing alone is not a
      // parsable Chinese cardinal; converting it yields 0 and corrupts text.
      if (digit === null && section === 0) return null;
      section += digit ?? 0;
      total += section * 10000;
      section = 0;
      digit = null;
      continue;
    }
    return null;
  }
  return total + section + (digit ?? 0);
}

function normalizeChineseQuantities(value: string): string {
  const protectedText = String(value || '')
    .replace(/一张(?=(?:都)?没有)/g, '\uE000');
  return protectedText.replace(
    /(?!零星)[零〇一二两三四五六七八九十百千万]+(?=\s*(?:多|余)?(?:张|次|把|天|年|个月|月|周|名|pp|PP|★|星|%|％))/g,
    (token) => {
      const parsed = chineseCardinalToNumber(token);
      return parsed === null ? token : String(parsed);
    },
  )
    .replace(/0星(?=点缀|几|分布)/g, '零星')
    .replace(/1张(?=牌|答卷|名片)/g, '一张')
    .replace(/\uE000/g, '一张');
}

export function parseAnalysisSectionComments(text: string): AnalysisSectionComments | null {
  const parsed = parseSectionCommentJson(text);
  if (!parsed) return null;
  const result = {} as AnalysisSectionComments;
  for (const key of ANALYSIS_COMMENT_KEYS) {
    const rawValue = parsed?.[key];
    const comment = extractSectionCommentValue(rawValue)
      .replace(/\r?\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!comment) return null;
    result[key] = comment;
  }
  return result;
}

export function parsePartialAnalysisSectionComments(
  text: string,
  requiredKeys: readonly (keyof AnalysisSectionComments)[],
): Partial<AnalysisSectionComments> | null {
  const parsed = parseSectionCommentJson(text);
  if (!parsed) return null;
  const result: Partial<AnalysisSectionComments> = {};
  for (const key of requiredKeys) {
    const rawValue = parsed?.[key];
    const comment = extractSectionCommentValue(rawValue)
      .replace(/\r?\n+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!comment) return null;
    result[key] = comment;
  }
  return result;
}

export function sanitizeAnalysisSectionComments(
  comments: AnalysisSectionComments,
  narrative: AnalysisNarrativeContext = {},
  sections?: AnalyzerSections,
): AnalysisSectionComments {
  const cleaned = {} as AnalysisSectionComments;
  for (const key of ANALYSIS_COMMENT_KEYS) {
    const normalized = normalizeChineseQuantities(String(comments[key] || ''))
      .replace(/准心/g, '光标')
      .replace(/\bDDT\b/gi, 'HDDT')
      .replace(/倒挺/g, '挺')
      .replace(/(?:五张|BP\s*5)\s*(?:全部|全员)\s*HD(?:起步)?/gi, 'BP5 五张全部含 HD')
      .replace(/["“”]+\s*$/g, '');
    // Sanitizing may normalize transport/typography, but must not silently
    // delete semantic sentences. Rejected prose is regenerated as a whole so
    // traces and source labels remain truthful.
    void narrative;
    void sections;
    cleaned[key] = normalized.trim();
  }
  return cleaned;
}

/**
 * Build the verified-number whitelist for a report. Direct numbers from the
 * fact sheet are allowed, together with their rounded variants, plus exact
 * sums of 2-4 distinct verified integers. The sum allowance keeps natural
 * derived arithmetic (e.g. "其他三类加起来才 21 张" = 10+7+4) from being
 * mistaken for a hallucinated number.
 */
function buildVerifiedNumberSet(safeFacts: string): Set<string> {
  const allowed = new Set<string>();
  const integers: number[] = [];
  const values: number[] = [];
  for (const token of String(safeFacts || '').match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []) {
    const numeric = Number(token.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;
    allowed.add(String(numeric));
    allowed.add(String(Number(numeric.toFixed(1))));
    allowed.add(String(Number(numeric.toFixed(2))));
    allowed.add(String(Math.floor(numeric)));
    allowed.add(String(Math.round(numeric)));
    values.push(numeric);
    if (Number.isInteger(numeric)) integers.push(numeric);
  }
  const unique = [...new Set(integers)];
  const n = unique.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const pair = unique[i] + unique[j];
      allowed.add(String(pair));
      for (let k = j + 1; k < n; k += 1) {
        const triple = pair + unique[k];
        allowed.add(String(triple));
        for (let l = k + 1; l < n; l += 1) {
          allowed.add(String(triple + unique[l]));
        }
      }
    }
  }
  // Exact differences of any two verified numbers (e.g. "DT 和 NM 平均 Acc
  // 就差 0.21 个百分点" = 97.77-97.56). Float precision is normalized via
  // toFixed(1)/toFixed(2) variants.
  const uniqueValues = [...new Set(values)];
  const m = uniqueValues.length;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      const diff = Math.abs(uniqueValues[i] - uniqueValues[j]);
      allowed.add(String(diff));
      allowed.add(String(Number(diff.toFixed(1))));
      allowed.add(String(Number(diff.toFixed(2))));
      allowed.add(String(Math.floor(diff)));
      allowed.add(String(Math.round(diff)));
    }
  }
  return allowed;
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
    const emptyRecent = key === 'recent' && /Recent 样本: 0次/.test(sections.safeFacts);
    const minimumLength = emptyRecent ? 8 : 14;
    if (value.length < minimumLength) reasons.push(`${key} 短评过短`);
    const lengthCap = key === 'profile' ? 340 : 280;
    if (value.length > lengthCap) reasons.push(`${key} 短评过长`);
    if (/^\s*\{\s*"(?:evidence|judgment|comment)"\s*:/.test(value)) {
      reasons.push(`${key} 泄漏了内部结构化 JSON`);
    }
    if (/pippi\s*[：:]|【pippi|作为\s*pippi/i.test(value)) reasons.push(`${key} 重复标注 pippi 身份`);
    if (/\bTop\b/i.test(value)) reasons.push(`${key} 面向玩家时把 BP 错写成了 Top`);
    if (/\bHidden\b|隐身模组|隐身图|Hidden\s*键|HD\s*键/i.test(value)) {
      reasons.push(`${key} 生硬翻译或错误命名了 HD`);
    }
    const modSemanticsViolation = findModSemanticsViolation(value);
    if (modSemanticsViolation) reasons.push(`${key} 的 Mod 语义错误：${modSemanticsViolation}`);
    if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
      reasons.push(`${key} 把 Auto 当成了 pippi 的自称`);
    }
    if (/\bDDT\b/i.test(value)) reasons.push(`${key} 把 HDDT 错写成了 DDT`);
    if (/\bPA\b/i.test(value)) reasons.push(`${key} 把 Acc 错写成了 PA`);
    if (/准心/.test(value)) reasons.push(`${key} 把 osu! 光标写成了准心`);
    const registeredYear = Number(sections.safeFacts.match(/注册:\s*(\d{4})\//)?.[1] || 0);
    if (/今年/.test(value) && registeredYear > 0 && registeredYear !== new Date().getFullYear()) {
      reasons.push(`${key} 把 ${registeredYear} 年注册错写成了今年`);
    }
    if (
      key === 'profile' &&
      /(?:最后一刻|临门一脚).{0,12}(?:手滑|失误)|SH[^。\n]*(?:手滑|差一点|choke)|银S[^。\n]*(?:手滑|失误|差一点)|手滑[^。\n]{0,20}(?:直接|变成|就是|只剩)\s*S|闪光\s*SS/i.test(value)
    ) {
      reasons.push('profile 误解了 SSH/SH 评级含义');
    }
    if (key === 'recent' && /(?:差|低|少|掉|滑)[^。\n]{0,8}[一二三四五六七八九十两]+档/.test(value)) {
      reasons.push('recent 把百分点差异擅自改写成了“档”');
    }
    const semanticReasons = validateAnalysisContent(sections, value, narrative, key);
    for (const reason of semanticReasons) {
      reasons.push(`${key} 短评语义终审：${reason}`);
    }
    if (
      narrative.perspective !== 'self' &&
      /你/.test(value)
    ) {
      reasons.push(`${key} 把未确认的目标玩家写成了发起者本人`);
    }
    if (
      narrative.perspective !== 'self' &&
      /(?<!其)[他她]/.test(value)
    ) {
      reasons.push(`${key} 擅自猜测了目标玩家性别`);
    }
  }

  if (/(?:Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+)/i.test(comments.mods)) {
    reasons.push('mods 短评挪用了 PP+ 字段');
  }
  if (/(?:Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+)/i.test(comments.top5)) {
    reasons.push('top5 短评挪用了 PP+ 字段');
  }
  if (!/(?:pp|HD|HR|Acc|★|星|五张|BP\s*5|前五)/i.test(comments.top5)) {
    reasons.push('top5 短评没有落在五张成绩的真实证据上');
  }
  if (/转角|谱面段落|某一段|尾杀|开头|结尾|节奏型|密度|高密|低密/i.test(comments.top5)) {
    reasons.push('top5 短评编造了简报未提供的谱面内容或操作感受');
  }
  if (/(?:SSH|SS|SH|等级|注册|游玩时长)/i.test(comments.recent)) {
    reasons.push('recent 短评挪用了账号档案字段');
  }

  const allowedNumbers = buildVerifiedNumberSet(sections.safeFacts);
  for (const key of ANALYSIS_COMMENT_KEYS) {
    const usedNumbers = String(comments[key] || '')
      .match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
    const normalizedUsed = usedNumbers.map(token => String(Number(token.replace(/,/g, ''))));
    const unknownNumbers = [...new Set(normalizedUsed.filter(token => !allowedNumbers.has(token)))];
    if (unknownNumbers.length > 0) reasons.push(`${key} 短评包含简报外数字: ${unknownNumbers.join(', ')}`);
  }

  return { ok: reasons.length === 0, reasons };
}

export function injectAnalysisSectionComments(
  safeBody: string,
  comments: AnalysisSectionComments
): string {
  const matchers: { key: keyof AnalysisSectionComments; pattern: RegExp }[] = [
    { key: 'profile', pattern: /^【账号档案/ },
    { key: 'top', pattern: /^【BP(?:\d+ · 总览)?】/ },
    { key: 'top5', pattern: /^【BP5】/ },
    { key: 'mods', pattern: /^【Mods】/ },
    { key: 'pplus', pattern: /^【PP\+ 六维】/ },
    { key: 'recent', pattern: /^【Recent/ },
    { key: 'classification', pattern: /^【谱面类型分布】/ },
  ];

  return String(safeBody || '')
    .split(/\n\n/)
    .map(block => {
      const match = matchers.find(item => item.pattern.test(block));
      if (!match) return block;
      const comment = String(comments[match.key] || '').trim();
      return comment ? `${block}\n${comment}` : block;
    })
    .join('\n\n');
}

export function formatPippiComment(text: string): string {
  const normalized = normalizeChineseQuantities(String(text || ''))
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
  while (kept.length > 1 && render(kept).length > maxLength) {
    const removable = kept
      .filter(item => item.index !== 0 && item.index !== sentences.length - 1)
      .sort((a, b) => a.score - b.score || b.sentence.length - a.sentence.length)[0];
    if (!removable) break;
    kept = kept.filter(item => item !== removable);
  }

  let condensed = render(kept);
  if (condensed.length > maxLength && kept.length > 1) {
    // Still over budget: drop the closing sentence, keep the opener.
    const opener = kept.find(item => item.index === 0) || kept[0];
    kept = [opener];
    condensed = render(kept);
  }
  if (condensed.length > maxLength) {
    // Hard clip the opener so the conclusion can never exceed the validator's
    // structural length limit.
    const body = condensed.replace(/^【结论】\s*/, '').trim();
    const clipped = body.slice(0, Math.max(20, maxLength - 8)) + '……';
    condensed = formatPippiComment(`【结论】\n\n${clipped}`);
  }
  return condensed;
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
    .filter(sentence => validateAnalysisContent(sections, sentence, narrative, 'conclusion').length === 0);

  return formatPippiComment(`【结论】\n\n${kept.join('\n\n')}`);
}

export function validateAnalysisReport(
  sections: AnalyzerSections,
  text: string,
  narrative: AnalysisNarrativeContext = {}
): { ok: boolean; reasons: string[] } {
  const value = String(text || '').trim();
  // Every generated component is already semantically validated in its own
  // scope before assembly. Re-running sentence-level semantic regexes across
  // the whole report creates false cross-section relations (for example a
  // PP+ label in one block plus "stream" in another). The assembly gate is
  // intentionally structural only; the independent reviewer still receives
  // the complete report for true cross-section factual review.
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

export function validatePippiComment(
  sections: AnalyzerSections,
  text: string,
  narrative: AnalysisNarrativeContext = {}
): { ok: boolean; reasons: string[] } {
  const value = String(text || '').trim();
  const reasons = validateAnalysisContent(sections, value, narrative, 'conclusion');
  if (value.length < 55) reasons.push('综合结论过短');
  if (value.length > 600 && value !== sections.safePippiFallback) reasons.push('综合结论过长');
  if (/低准确率[^。\n]{0,12}(?:绝迹|消失|清零)|成绩[^。\n]{0,12}绝迹|从不失误|顶分段/.test(value)) {
    reasons.push('综合结论把 BP 样本扩大成了账号绝对事实或发明了范围');
  }
  if (!value.startsWith('【结论】')) reasons.push('缺少结论节点标题');
  if (
    value !== sections.safePippiFallback &&
    (() => {
      const normalizedValue = value.replace(/,/g, '');
      const rank = Number(sections.safeFacts.match(/全球排名:\s*#?([\d,]+)/)?.[1]?.replace(/,/g, '') || 0);
      const accountPp = Number(sections.safeFacts.match(/^PP:\s*(\d+(?:\.\d+)?)/m)?.[1] || 0);
      const chineseRank = rank === 1 ? '一' : rank === 2 ? '二' : '';
      const hasRank = rank > 0 && (
        new RegExp(`(?:全球(?:排名|第)?|排名|#)\\s*#?\\s*${rank}(?!\\d)`, 'i').test(normalizedValue)
        || Boolean(chineseRank && new RegExp(`全球第${chineseRank}(?![十百千万])`).test(normalizedValue))
      );
      const ppForms = accountPp > 0
        ? [...new Set([accountPp.toFixed(1), String(accountPp), String(Math.floor(accountPp))])]
        : [];
      const hasAccountPp = ppForms.some((token) => new RegExp(`(?:^|[^\\d.])${token.replace('.', '\\.')}(?:\\s*)pp`, 'i').test(normalizedValue));
      return !hasRank && !hasAccountPp;
    })()
  ) {
    reasons.push('综合结论没有使用核准的全球 rank 或账号总 pp 判断分量');
  }
  if (value !== sections.safePippiFallback) {
    const body = value.replace(/^【结论】\s*/, '');
    const sectionSignals = [
      /BP(?:100|\d+)?\s*(?:里|中|的|平均|整体)|(?:平均|整体)\s*Acc|低于\s*95%|98%\s*以上/i.test(body),
      /BP\s*1|BP\s*5|#1|头名|孤峰|相邻差/i.test(body),
      /\b(?:NM|HD|HR|DT|NC|EZ|FL|HT|NF|SO|PF|SD|TD)(?:[A-Z]*)\b/i.test(body),
      /Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+|六维|显示条|柱子?/i.test(body),
      /Recent|recent|近期|最近/i.test(body),
      /\b(?:aim|stream|alt|tech)\b/i.test(body),
    ].filter(Boolean).length;
    if (sectionSignals < 2) {
      reasons.push(`综合结论只覆盖 ${sectionSignals} 类非档案栏目，至少需要两类证据形成跨栏判断`);
    }
  }
  if ((value.match(/【[^】]+】/g) || []).some(heading => heading !== '【结论】')) {
    reasons.push('综合结论混入其他数据节点');
  }
  if (/pippi\s*[：:]|【pippi/i.test(value)) reasons.push('综合结论重复标注 pippi 身份');
  if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
    reasons.push('综合结论把 Auto 当成了 pippi 的自称');
  }
  if (/“[^”]*\n\s*\n[^”]*”/.test(value)) reasons.push('引号跨越段落，疑似断句损坏');
  return { ok: reasons.length === 0, reasons };
}

function chineseNumberToInt(token: string): number | null {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (!/^[一二两三四五六七八九十]{1,3}$/.test(token)) return null;
  if (token === '十') return 10;
  if (token.includes('十')) {
    const [head, tail] = token.split('十');
    const tens = head ? (digits[head] ?? 1) * 10 : 10;
    const ones = tail ? (digits[tail] ?? 0) : 0;
    return tens + ones;
  }
  return digits[token] ?? null;
}

/**
 * 注册时间换算的正确性校验：事实简报里程序已给出核准的账号年龄（天），
 * 模型可以换算成年/天，但结果必须与核准值一致；只拦明显算错的，不再一刀切禁止。
 */
function findRegistrationAgeViolations(safeFacts: string, value: string): string[] {
  const violations: string[] = [];
  const factDaysMatch = String(safeFacts || '').match(/账号年龄: 距注册约\s*([\d,]+)\s*天/);
  if (!factDaysMatch) return violations;
  const factDays = Number(factDaysMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(factDays) || factDays <= 0) return violations;
  const factYears = factDays / 365.25;

  // 天数换算：只在“注册/账号年龄/至今”语境里匹配，避免撞上游玩时长“X 天 Y 小时”。
  const dayPattern = /(?:注册|账号年龄|距注册|注册至今|到现在|至今|成立)\s*(?:约|大概|差不多|快|已|已经)?\s*(\d{1,3}(?:,\d{3}){0,2})(?:多)?天/g;
  for (const match of value.matchAll(dayPattern)) {
    const claimed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(claimed) && Math.abs(claimed - factDays) > 3) {
      violations.push(`账号年龄核准为约 ${factDays.toLocaleString()} 天，不是 ${claimed.toLocaleString()} 天`);
    }
  }

  // 年数换算：支持阿拉伯数字和常见中文数词，带 快/约/不到/多/半/左右 等修饰。
  const yearPattern = /(快|约|大概|差不多|接近|不到|不满|才|已经|刚满|刚)?\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*年(多|半|左右|出头|整|有余)?/g;
  for (const match of value.matchAll(yearPattern)) {
    const prefix = match[1] || '';
    const suffix = match[3] || '';
    const n = /^\d+$/.test(match[2]) ? Number(match[2]) : chineseNumberToInt(match[2]);
    if (!n || n < 1 || n > 100) continue;
    let lo = n - 2;
    let hi = n + 2;
    if (suffix === '多' || suffix === '出头' || suffix === '有余') { lo = n; hi = n + 2; }
    else if (suffix === '半') { lo = n; hi = n + 1; }
    if (prefix === '快' || prefix === '不到' || prefix === '不满') { lo = Math.max(lo, n - 1); hi = Math.min(hi, n + 0.5); }
    else if (prefix === '约' || prefix === '大概' || prefix === '差不多' || prefix === '接近' || suffix === '左右') { lo = n - 2; hi = n + 2; }
    if (factYears < lo || factYears > hi) {
      violations.push(`账号年龄核准为约 ${factYears.toFixed(1)} 年，与“${match[0]}”不符`);
    }
  }
  return violations;
}

function validateAnalysisContent(
  sections: AnalyzerSections,
  value: string,
  narrative: AnalysisNarrativeContext = {},
  scope?: keyof AnalysisSectionComments | 'conclusion' | 'report',
): string[] {
  const reasons: string[] = [];
  if (
    narrative.perspective !== 'self' &&
    /你/.test(value)
  ) {
    reasons.push(`分析对象 ${narrative.playerName || '该玩家'} 未确认是发起者本人，不能使用第二人称`);
  }
  if (
    narrative.perspective !== 'self' &&
    /(?<!其)[他她]/.test(value)
  ) {
    reasons.push(`分析对象 ${narrative.playerName || '该玩家'} 的性别未知，不能擅自使用“他/她”`);
  }
  if (/pippi\s*的(?:判断|总结)|作为\s*pippi/i.test(value)) reasons.push('包含固定署名或自我介绍');
  if (/(?:世界|全球)第[一二三四五六七八九十\d]+[。！？](?:里|中|上|下)[^。！？\n]{2,}|(?:^|[。！？\n])(?:里|中|上|下)[^。！？\n]{0,3}(?:已经|就是|是个|有着)/i.test(value)) {
    reasons.push('包含断裂或缺少主语的残句');
  }
  if (/在线时长|在线时间/.test(value)) reasons.push('把 osu! API 的累计游玩时长误写成了在线时长');
  // 注册时间换算不再一刀切禁止：只要换算结果与程序核准的账号年龄一致就放行。
  const ageViolations = findRegistrationAgeViolations(sections.safeFacts, value);
  for (const violation of ageViolations) reasons.push(violation);
  if (/[一二三四五六七八九十百千万两]+(?:十|百|千|万)[^。！？\n]{0,4}(?:多|余)?(?:万|千)?(?:次|把)/.test(value)) {
    reasons.push('把核准游玩次数改写成了不可核验的中文约数');
  }
  if (/\d+(?:\.\d+)?\s*(?:万|千)(?:多|余)?\s*次/.test(value)) {
    reasons.push('把核准游玩次数压缩成了“万/千次”约数');
  }
  if (/一半/.test(value) && !/超过一半|接近一半|将近一半|近一半|一半以上|一半多/.test(value)) {
    reasons.push('把核准数量改写成了无法核验的“一半”比例');
  }
  // Only positive self-identification as an AI/assistant is a violation.
  // "我不是助手" style denials or ordinary words like "分析工具" must pass.
  if (/我(?:就)?是(?:一个)?(?:人工智能|AI|助手|编辑器|分析工具)|作为(?:一个)?(?:人工智能|AI|助手)|本(?:人)?(?:人工智能|AI|助手)/i.test(value)) {
    reasons.push('把 pippi 写成了工具或助手');
  }
  if (/\bTop\b/i.test(value)) reasons.push('面向玩家时把 BP 错写成了 Top');
  if (/\bHidden\b|隐身|Hidden\s*键|HD\s*键/i.test(value)) {
    reasons.push('生硬翻译或错误命名了 HD');
  }
  const modSemanticsViolation = findModSemanticsViolation(value);
  if (modSemanticsViolation) reasons.push(`Mod 语义错误：${modSemanticsViolation}`);
  if (/(?:我(?:这|是|这个)?|本)\s*Auto|Auto\s*(?:本人|的我)/i.test(value)) {
    reasons.push('把 Auto 当成了 pippi 的自称');
  }
  // Hard factual gates distinguish an asserted cause from a clearly reserved
  // question. A light "is it X or Y? current records cannot tell" is allowed;
  // equipment/body/replay mechanisms remain forbidden even as speculation.
  const hardMechanism = value.match(/设备|键盘|鼠标|数位板|手腕|身体的一部分|肌肉记忆|身体记忆|手眼配合|手不抖|手(?:是|很|挺|够|相当)?稳|手[^。！？\n]{0,12}(?:先迈|没跟上)|眼不花|眼准|replay|回放细节|失误位置|尾杀|复杂排布/i);
  if (hardMechanism) reasons.push(`包含未经输入提供的设备、身体或 replay 机制：${hardMechanism[0]}`);
  if (
    /Recent 样本: [1-9]\d*次/.test(sections.safeFacts) &&
    (scope === 'recent' || scope === 'conclusion') &&
    /(?:同样|相同|一样)(?:的)?(?:难度|星数)(?:区间)?[^。！？\n]{0,20}(?:图|谱面|最近|结果)|(?:同样|相同|一样)(?:难度|星数)(?:的)?(?:图|谱面)/i.test(value)
  ) {
    reasons.push('把两批样本平均星数接近误写成了同一难度的谱面或单图关系');
  }
  if (
    /Recent 样本: [1-9]\d*次/.test(sections.safeFacts) &&
    (scope === 'recent' || scope === 'conclusion') &&
    /同一批(?:难度|星数)(?:区间)?|同一个(?:难度|星数)(?:区间)?/i.test(value)
  ) {
    reasons.push('把两批聚合均值接近误写成了同一批难度区间');
  }
  const hasPplusReference = scope === 'pplus' || /Flow|Accuracy|Precision|Stamina|Jump|Speed|PP\+|六维/i.test(value);
  const pplusFactLine = sections.safeFacts.match(/PP\+ 归一化显示条: ([^\n]+)/)?.[1] || '';
  const pplusValues = new Map(
    [...pplusFactLine.matchAll(/(Flow|Accuracy|Precision|Stamina|Jump|Speed)\s+(\d+(?:\.\d+)?)/g)]
      .map((match) => [match[1], Number(match[2])] as const)
  );
  if (hasPplusReference && /(?:Flow|Accuracy|Precision|Stamina|Jump|Speed)[^。！？\n]{0,8}[零一二三四五六七八九十百]+点[零一二三四五六七八九十百]+/i.test(value)) {
    reasons.push('把 PP+ 精确显示值改写成了不可机械核验的中文小数');
  }
  if (
    hasPplusReference &&
    /(?:PP\+|六维|15|基准线)[^。！？\n]{0,18}(?:极限|上限|满值)|(?:极限|上限|满值)[^。！？\n]{0,18}(?:PP\+|六维|15|基准线)|(?:Flow|Accuracy|Precision|Stamina|Jump|Speed)[^。！？\n]{0,10}(?:达到|碰到|就是|已是)?(?:极限|上限|满值)/i.test(value)
  ) {
    reasons.push('把 PP+ 的 15 基准线误写成极限、上限或满值');
  }
  for (const [dimension, dimensionValue] of pplusValues) {
    for (const match of value.matchAll(new RegExp(`\\b${dimension}\\b\\s*(?:(?:为|是|达到|冲到|升到|降到|落在|垫在|一柱擎天到)\\s*)?(?<!\\d)(\\d+(?:\\.\\d+)?)(?!\\d)`, 'gi'))) {
      const statedValue = Number(match[1]);
      if (Number.isFinite(statedValue) && Math.abs(statedValue - dimensionValue) > 0.011) {
        reasons.push(`${dimension} 的核准显示值为 ${dimensionValue.toFixed(2)}，不是 ${statedValue}`);
        break;
      }
    }
    const claimsAboveBaseline = new RegExp(`${dimension}[^。！？\\n]{0,24}(?<!没)(?<!没有)(?<!都未)(?<!从未)(?<!并未)(?<!不会)(?:超过|超出|越过|过了|顶穿)[^。！？\\n]{0,8}(?:15|基准线)|(?:15|基准线)[^。！？\\n]{0,8}(?:以下都|最低(?:的)?)[^。！？\\n]{0,20}${dimension}`, 'i').test(value);
    if (claimsAboveBaseline && dimensionValue <= 15) {
      reasons.push(`${dimension} 为 ${dimensionValue.toFixed(2)}，没有超过 PP+ 的 15 基准线`);
      break;
    }
  }
  if (/\d+(?:\.\d+)?\s*倍/.test(value)) {
    reasons.push('自行计算了简报未提供的倍数关系');
  }
  const topCount = Number(sections.safeFacts.match(/BP 成绩数量: (\d+)/)?.[1] || 0);
  const topHighAccCount = Number(sections.safeFacts.match(/98% 以上 (\d+)张/)?.[1] || 0);
  const topBelowNinetyFive = Number(sections.safeFacts.match(/低于 95% (\d+)张/)?.[1] || 0);
  const topFiveAbove520Count = Number(sections.safeFacts.match(/BP5 中 (\d+)张达到 520pp/)?.[1] || 0);
  const starRange = sections.safeFacts.match(/BP 星数: 平均 [^|]+\| 范围 (\d+(?:\.\d+)?)★ ~ (\d+(?:\.\d+)?)★/);
  const minimumStars = Number(starRange?.[1] || 0);
  const maximumStars = Number(starRange?.[2] || 0);
  const starBands = sections.safeFacts.match(/<5★ (\d+)张 \| 5-6\.5★ (\d+)张 \| >6\.5★ (\d+)张/);
  const belowFiveCount = Number(starBands?.[1] || 0);
  const aboveSixFiveCount = Number(starBands?.[3] || 0);
  const topFiveLine = sections.safeFacts.match(/^BP5: ([^\n]+)/m)?.[1] || '';
  const topFiveModLabels = [...topFiveLine.matchAll(/pp\s*\/\s*([A-Z]+)\s*\//g)]
    .map(match => String(match[1] || '').toUpperCase());
  const topFiveAccuracies = [...topFiveLine.matchAll(/\/\s*(\d+(?:\.\d+)?)%\s*\//g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const topFiveAllAbove98 = topFiveAccuracies.length > 0
    && topFiveAccuracies.every((accuracy) => accuracy >= 98);

  if (scope === 'mods' && topCount > 0) {
    const mainExactMod = sections.safeFacts.match(/BP Mods:\s*([A-Z]+)\s+(\d+)张/i);
    const mainExactCount = Number(mainExactMod?.[2] || 0);
    if (mainExactCount > 0 && mainExactCount <= topCount / 2 && /绝对(?:主体|主力|主轴)|压倒性(?:主体|主力|主轴)/.test(value)) {
      reasons.push(`最多的精确 Mod 组合只有 ${mainExactCount}/${topCount} 张，不能称为绝对或压倒性主体`);
    }
  }

  if (scope === 'top5' && topFiveModLabels.length > 0) {
    const parseSmallCount = (token: string): number => {
      const normalized = token === '两' ? '二' : token;
      const chinese: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
      return /^\d+$/.test(normalized) ? Number(normalized) : Number(chinese[normalized] || 0);
    };
    for (const match of value.matchAll(/(?<!第)(?<!第\s)([一二三四五两]|\d+)\s*(?:张|笔)\s*(?:(?:全部|全都|都是|均为|均|为|是|含|带|都带|使用|用了)\s*)?\b([A-Z]{2,8}(?:\/NC)?)\b/g)) {
      const stated = parseSmallCount(match[1]);
      const mod = String(match[2] || '').toUpperCase();
      const exactCount = topFiveModLabels.filter(label => label === mod).length;
      const containsCount = mod === 'DT' || mod === 'NC'
        ? topFiveModLabels.filter(label => label.includes('DT') || label.includes('NC')).length
        : mod === 'HD' || mod === 'HR'
          ? topFiveModLabels.filter(label => label.includes(mod)).length
          : exactCount;
      // "四张 HD 夹着一张 HDDT" 里的 HD 是精确组合语义，"五张含 HD" 是包含语义；
      // 两种口径任一吻合就放行，只有都对不上才拒绝。
      const plausible = mod === 'NM' || mod === 'DT' || mod === 'NC' || mod === 'HD' || mod === 'HR'
        ? [exactCount, containsCount]
        : [exactCount];
      if (stated > 0 && !plausible.includes(stated)) {
        const label = mod === 'DT' || mod === 'NC' || mod === 'DT/NC'
          ? '含 DT/NC'
          : mod === 'HD' || mod === 'HR'
            ? `含 ${mod}`
            : `精确组合 ${mod}`;
        reasons.push(`BP5 中${label}的核准数量为 ${plausible.join(' 或 ')} 张，不是 ${stated} 张`);
        break;
      }
    }
  }

  if (
    (scope === 'top5' || scope === 'conclusion') &&
    /BP\s*5[^。！？\n]{0,16}(?:里|中|内)[^。！？\n]{0,10}\d{1,3}\s*张/.test(value)
  ) {
    const claimedCount = Number(value.match(/BP\s*5[^。！？\n]{0,16}(?:里|中|内)[^。！？\n]{0,10}(\d{1,3})\s*张/)?.[1] || 0);
    if (claimedCount > 5) {
      reasons.push(`BP5 只有 5 张成绩，不能写“BP5 里 ${claimedCount} 张”`);
    }
  }

  if (
    scope !== 'report' &&
    !(scope === 'top5' && topFiveAllAbove98) &&
    topCount > 0 &&
    topHighAccCount < topCount &&
    /(?:Acc|准确率)[^。！？\n，,、；;：:]{0,20}(?:全线|全部|全都|清一色)[^。！？\n，,、；;：:]{0,20}(?:98%|98％|高于|超过|往上)|(?:全线|全部|全都|清一色)[^。！？\n，,、；;：:]{0,20}(?:Acc|准确率)[^。！？\n，,、；;：:]{0,20}(?:98%|98％|高于|超过|往上)/i.test(value)
  ) {
    reasons.push(`把 ${topHighAccCount}/${topCount} 张达到 98% 以上夸写成了全体成绩`);
  }
  if (
    scope !== 'report' &&
    (belowFiveCount > 0 || aboveSixFiveCount > 0) &&
    /(?:全部|全都|全挤|清一色)[^。\n]{0,28}(?:5(?:\.0)?\s*(?:到|～|~|至|-)\s*6\.5|5\s*[-～~]\s*6\.5)\s*[★星]/i.test(value)
  ) {
    reasons.push(`把星数带外的 ${belowFiveCount + aboveSixFiveCount} 张成绩遗漏后夸写成了全部`);
  }
  if (
    scope !== 'report' &&
    minimumStars > 0 && minimumStars < 8 &&
    /BP[^。\n]{0,24}(?:一片|全是|全部|清一色)[^。\n]{0,20}8\s*[★星]\s*(?:以上|往上)/i.test(value)
  ) {
    reasons.push(`BP 最低 ${minimumStars.toFixed(2)}★，不能写成整片 8★ 以上`);
  }
  if (
    scope !== 'report' &&
    maximumStars >= 6 &&
    /(?:6|六)\s*[★星](?:以上|往上)[^。\n]{0,12}(?:一张|1\s*张)?(?:都)?(?:没有|为零)|(?:没有|零)\s*(?:一张)?[^。\n]{0,12}(?:6|六)\s*[★星](?:以上|往上)/i.test(value)
  ) {
    reasons.push(`BP 最高达到 ${maximumStars.toFixed(2)}★，不能声称没有 6★ 以上成绩`);
  }
  if (scope === 'conclusion' && /别人[^。！？\n]{0,16}一辈子[^。！？\n]{0,16}(?:够不到|打不到)|排在后面[^。！？\n]{0,20}(?:只能|都得)[^。！？\n]{0,10}(?:仰望|看着)/.test(value)) {
    reasons.push('结论通过贬低其他玩家来抬高分析对象');
  }
  if (scope === 'top5' && /(?:最大)?相邻差[^。！？\n]{0,20}(?:大于|超过|比)[^。！？\n]{0,12}(?:首尾|头尾)(?:差|跨度)|(?:首尾|头尾)(?:差|跨度)[^。！？\n]{0,20}(?:小于|不如)[^。！？\n]{0,12}(?:最大)?相邻差/i.test(value)) {
    reasons.push('BP5 相邻差不可能大于首尾总跨度');
  }
  const topOneAccuracy = Number(topFiveAccuracies[0] || 0);
  if (
    (scope === 'top5' || scope === 'conclusion') && topOneAccuracy > 0 && topOneAccuracy < 99.995 &&
    /(?:BP\s*1|#1|头名|第一张|那张)[^。！？\n]{0,45}(?:打满|满准|满\s*Acc)|(?:打满|满准|满\s*Acc)[^。！？\n]{0,45}(?:BP\s*1|#1|头名|第一张|那张)/i.test(value)
  ) {
    reasons.push(`BP1 Acc 为 ${topOneAccuracy.toFixed(2)}%，不能写成打满或满准确率`);
  }
  if (scope === 'top' && /(?:高|更高)难度[^。！？\n]{0,20}(?:Acc|准确率)[^。！？\n]{0,12}(?:掉|低|下降)|(?:Acc|准确率)[^。！？\n]{0,12}(?:随|随着)[^。！？\n]{0,10}(?:星数|难度)[^。！？\n]{0,8}(?:掉|下降)/i.test(value)) {
    reasons.push('把整体星数分布与整体 Acc 拼成了未经核准的分段相关性');
  }
  if (/\balt\b[^。！？\n]{0,20}(?:跳图|跳为主|跳跃图)|(?:跳图|跳为主|跳跃图)[^。！？\n]{0,20}\balt\b/i.test(value)) {
    reasons.push('把 osu!oracle 的 alt 分类误写成了跳图');
  }
  // Mod containment uses the semantic containment statistics (a play carrying
  // HDDT counts for both HD and DT), never exact combo-string matches.
  const containsCounts = new Map<string, number>();
  const containsLine = sections.safeFacts.match(/BP Mod 包含统计: ([^\n]+)/)?.[1] || '';
  const containsMatch = containsLine.match(/含 HD (\d+)张 \| 含 HR (\d+)张 \| 含 DT\/NC (\d+)张 \| 纯 NM (\d+)张/);
  if (containsMatch) {
    containsCounts.set('HD', Number(containsMatch[1] || 0));
    containsCounts.set('HR', Number(containsMatch[2] || 0));
    containsCounts.set('DT', Number(containsMatch[3] || 0));
    containsCounts.set('NM', Number(containsMatch[4] || 0));
  }
  const exactModCounts = new Map<string, number>();
  const exactModsLine = sections.safeFacts.match(/BP Mods: ([^\n]+)/)?.[1] || '';
  for (const match of exactModsLine.matchAll(/\b([A-Z]+)\s+(\d+)张/g)) {
    exactModCounts.set(String(match[1] || '').toUpperCase(), Number(match[2] || 0));
  }
  const specialRelationshipMods = ['NF', 'SO', 'PF', 'SD', 'HT', 'EZ', 'FL'];
  const hasExactCombinationWith = (left: string, right: string): boolean =>
    [...exactModCounts.entries()].some(([label, count]) => count > 0 && label.includes(left) && label.includes(right));
  for (const sentence of value.split(/[。！？!?\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const mentioned = specialRelationshipMods.filter((mod) => new RegExp(`\\b${mod}\\b`, 'i').test(sentence));
    if (mentioned.length < 2) continue;
    const assertsSameScore = /(?:同一|同)?张|那张|这张|一张|同(?:一)?(?:个)?成绩|组合在一起|同时(?:开|带|出现)/i.test(sentence);
    if (!assertsSameScore) continue;
    for (let leftIndex = 0; leftIndex < mentioned.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < mentioned.length; rightIndex += 1) {
        const left = mentioned[leftIndex];
        const right = mentioned[rightIndex];
        if (!hasExactCombinationWith(left, right)) {
          reasons.push(`没有核准的精确 Mod 组合同时包含 ${left} 与 ${right}，不能把它们写成同一张成绩`);
        }
      }
    }
  }
  const dtScoreCount = containsCounts.get('DT') || 0;
  const topFiveDtCount = topFiveModLabels.filter(label => label.includes('DT') || label.includes('NC')).length;
  const explicitlyTopFiveAllDt = topFiveDtCount === topFiveModLabels.length && topFiveDtCount > 0
    && /(?:BP\s*5|五张)[^。\n]{0,24}(?:全部|全都|均)[^。\n]{0,12}(?:含|带)?\s*(?:HD)?(?:DT|NC|DT\/NC)/i.test(value);
  if (
    scope !== 'report' &&
    topCount > 0 &&
    dtScoreCount < topCount &&
    !explicitlyTopFiveAllDt &&
    /(?:全是|清一色(?:都是)?)\s*(?:HD)?DT|全部(?:都|成绩都|BP都)?(?:带|含|使用)\s*(?:HD)?DT|几乎每(?:一)?(?:张|次)[^。\n]{0,20}(?:DT|加速|速度)/i.test(value)
  ) {
    reasons.push(`把 ${dtScoreCount}/${topCount} 张带 DT 的成绩夸写成了全部或几乎每张`);
  }
  for (const [modLabel, actualCount] of exactModCounts) {
    for (const match of value.matchAll(new RegExp(`(?:精确(?:组合|口径)[^。！？\\n]{0,12}\\b${modLabel}\\b[^。！？\\n]{0,10}(?<!\\d)(\\d+)(?!\\d)\\s*张)|(?:精确(?:组合|口径)[^。！？\\n]{0,12}(?<!\\d)(\\d+)(?!\\d)\\s*张[^。！？\\n]{0,10}\\b${modLabel}\\b)`, 'gi'))) {
      const statedCount = Number(match[1] || match[2] || 0);
      if (statedCount !== actualCount) {
        reasons.push(`精确 Mod 组合 ${modLabel} 的核准数量为 ${actualCount} 张，不是 ${statedCount} 张`);
        break;
      }
    }
  }
  if (
    scope === 'mods' && dtScoreCount > 0 &&
    /\bHDDT\b[^。！？\n]{0,18}(?:唯一|仅有)[^。！？\n]{0,10}(?:提速|加速)|(?:唯一|仅有)[^。！？\n]{0,10}(?:提速|加速)[^。！？\n]{0,18}\bHDDT\b/i.test(value) &&
    Number(exactModCounts.get('HDDT') || 0) < dtScoreCount
  ) {
    reasons.push(`带 DT/NC 的成绩共有 ${dtScoreCount} 张，HDDT 不能写成唯一提速组合`);
  }

  for (const mod of ['HD', 'HR', 'DT', 'NM']) {
    const count = Number(containsCounts.get(mod) || 0);
    if (
      count > 0 &&
      new RegExp(`(?:没有|无)\\s*(?:任何|一张)?\\s*${mod}(?:/NC)?(?:成绩|组合)?|(?:一张\\s*)?${mod}(?:/NC)?(?:成绩|组合)?\\s*(?:一张)?(?:都)?没有|${mod}(?:/NC)?[^。\\n]{0,6}(?:完全没有|为零)`, 'i').test(value)
    ) {
      reasons.push(`声称 BP 中没有 ${mod}，但核准数据实际有 ${count} 张`);
    }
  }
  if (scope === 'mods' && /(?:NF|SO)[^。！？\n]{0,20}(?:推高|提高|抬高|增加)[^。！？\n]{0,8}(?:星数|难度)|(?:开|带)(?:了)?\s*(?:NF|SO)[^。！？\n]{0,20}(?:更难|难度更高)/i.test(value)) {
    reasons.push('NF/SO 不会提高谱面星数或难度，不能把该 Mod 写成难度变化原因');
  }
  if (
    scope === 'mods' && topCount > 0 && (containsCounts.get('HD') || 0) < topCount &&
    /(?:全部|全都|五种|每种|所有)[^。！？\n]{0,20}(?:组合|成绩)?[^。！？\n]{0,10}(?:带|含|挂着)\s*HD|(?:五种|所有)组合[^。！？\n]{0,12}HD/i.test(value)
  ) {
    reasons.push(`含 HD 的成绩为 ${containsCounts.get('HD') || 0}/${topCount}，不能声称所有组合或成绩都带 HD`);
  }
  if ((scope === 'mods' || scope === 'conclusion') && exactModCounts.size > 0) {
    for (const [modLabel, actualCount] of exactModCounts) {
      if (actualCount >= topCount) continue;
      if (new RegExp(`\\b${modLabel}\\b[^。！？\\n]{0,24}(?:覆盖|占了|包下|撑起|占据)[^。！？\\n]{0,12}(?:全部|所有|整个|整份|每一张)|(?:全部|所有|整个|整份|每一张)BP[^。！？\\n]{0,22}\\b${modLabel}\\b`, 'i').test(value)) {
        reasons.push(`精确组合 ${modLabel} 只有 ${actualCount}/${topCount} 张，不能声称它覆盖全部 BP`);
        break;
      }
    }
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
  if (
    topHighAccCount > 0 &&
    /(?:没有|一张都没有|(?<!\d)0张|零张)[^。！？\n]{0,6}(?:98%|98％)(?:以上)?|(?:98%|98％)(?:以上)?[^。！？\n]{0,18}(?:都没有|都没|都没达到|都没撑住|没出现|为零|(?<!\d)0\s*张)/i.test(value)
  ) {
    reasons.push(`声称 BP 中没有 98% 以上成绩，但核准数据实际有 ${topHighAccCount} 张`);
  }

  if (/平均\s*(?:Acc|准确率)\s*(?:达到|有|共)\s*(?:\d+|[一二三四五六七八九十百]+)\s*张/i.test(value)) {
    reasons.push('把整体平均准确率与高准确率成绩数量拼成了同一个统计量');
  }

  const classificationFactLine = sections.safeFacts.match(/谱面类型样本: BP\d+；([^\n]+)/)?.[1] || '';
  const classificationEntries = [...classificationFactLine.matchAll(/([a-z]+)\s+(\d+)张（(\d+)%）/gi)]
    .map(match => ({ label: String(match[1] || '').toLowerCase(), count: Number(match[2] || 0), share: Number(match[3] || 0) }));
  if (classificationEntries.length > 0) {
    const [first, second] = classificationEntries;
    if (
      first.share < 50 &&
      /压倒性|一面倒|完全占住|绝对(?:主导|主体|主场)/.test(value)
    ) {
      reasons.push(`${first.label} 只占 ${first.share}%，尚未过半，不能写成压倒性或绝对主导`);
    }
    if (
      second &&
      new RegExp(`${first.label}[^。！？\\n]{0,12}(?:和|与|、)[^。！？\\n]{0,12}${second.label}[^。！？\\n]{0,12}各(?:占)?(?:一半|半数)`, 'i').test(value) &&
      (first.share < 45 || second.share < 45)
    ) {
      reasons.push(`${first.label} 为 ${first.share}%、${second.label} 为 ${second.share}%，不能写成两者各占一半`);
    }
    for (const entry of classificationEntries) {
      for (const match of value.matchAll(new RegExp(`(?:\\b${entry.label}\\b(?:类型|分类)?\\s*(?:为|有|占|共|达到|出现)?\\s*(?<!\\d)(\\d+)(?!\\d)\\s*张)|(?:(?<!\\d)(\\d+)(?!\\d)\\s*张\\s*(?:的)?\\b${entry.label}\\b)`, 'gi'))) {
        const statedCount = Number(match[1] || match[2] || 0);
        if (statedCount !== entry.count) {
          reasons.push(`${entry.label} 的核准数量为 ${entry.count} 张，不是 ${statedCount} 张`);
          break;
        }
      }
      if (
        entry.count < topCount &&
        new RegExp(`(?:BP[^。！？\\n]{0,20}(?:全是|全部是|清一色)[^。！？\\n]{0,10}${entry.label})|(?:一条\\s*${entry.label}[^。！？\\n]{0,10}走到底)|(?:${entry.label}[^。！？\\n]{0,8}(?:的天下|包办全部))`, 'i').test(value)
      ) {
        reasons.push(`${entry.label} 只有 ${entry.count}/${topCount} 张，不能写成 BP 全部或清一色都是该类型`);
      }
    }
    for (const match of value.matchAll(/((?:aim|stream|alt|tech)(?:[、,，和与](?:aim|stream|alt|tech))+)[^。！？\n]{0,8}各(?:占|有)?\s*(\d+)\s*张(?:[、,，和与]\s*(\d+)\s*张)?/gi)) {
      const labels = String(match[1] || '').toLowerCase().split(/[、,，和与]/).filter(Boolean);
      const firstCount = Number(match[2] || 0);
      const secondCount = match[3] ? Number(match[3]) : null;
      const mismatches = labels.filter((label, index) => {
        const actual = classificationEntries.find(entry => entry.label === label)?.count;
        const stated = index === 0 ? firstCount : secondCount;
        return stated === null || actual !== stated;
      });
      if (mismatches.length > 0) {
        reasons.push(`“各 ${firstCount} 张”与 ${mismatches.join('、')} 的核准分类数量不符`);
      }
    }
  }

  // B-class generic rule: an explicit, unsourced population comparison that
  // no verified fact can support (e.g. "超过绝大多数活跃玩家", "全球前 5%").
  const unsupportedComparison = value.match(/(?:超过|领先)[^。！？\n]{0,12}(?:绝大多数|大多数)(?:活跃)?(?:玩家|人)|全球前\s*\d+(?:\.\d+)?%|前百分之[一二三四五六七八九十百\d]+|全世界只有[^。！？\n]{0,20}(?:Jump|Flow|Accuracy|Precision|Stamina|Speed|PP\+)/i);
  if (unsupportedComparison) {
    reasons.push(`使用了简报未提供的玩家群体比较：${unsupportedComparison[0]}`);
  }
  if (/低\s*AR[^。！？\n]{0,10}(?:里|下|条件)[^。！？\n]{0,14}(?:stream|串图|流水)|(?:EZ|低\s*AR)\s*(?:串图|stream)\s*(?:成绩|BP|占比|平均)/i.test(value)) {
    reasons.push('把独立的 EZ 统计与谱面分类拼成了未经提供的 EZ/stream 子集');
  }

  const unsupportedHighAccPlural = value.match(/好几张[^。\n]{0,20}(?:逼近|接近|达到)\s*99(?:\.7|\.?%)/i);
  if (unsupportedHighAccPlural) {
    reasons.push(`使用了核准简报没有统计的高准确率复数量词：${unsupportedHighAccPlural[0]}`);
  }

  const normalizeNumber = (token: string) => {
    const numeric = Number(token.replace(/,/g, ''));
    return Number.isFinite(numeric) ? String(numeric) : token;
  };
  const allowedNumbers = buildVerifiedNumberSet(sections.safeFacts);
  const reportNumbers = (value.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) || []).map(normalizeNumber);
  const unknownNumbers = [...new Set(reportNumbers.filter(token => !allowedNumbers.has(token)))];
  if (unknownNumbers.length > 0) reasons.push(`包含简报外数字: ${unknownNumbers.join(', ')}`);
  return reasons;
}
