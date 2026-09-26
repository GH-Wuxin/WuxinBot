import type { OsuMode, OsuScore, OsuUser } from './types.js';
import { normalizedScoreMods, scoreStarRating } from './scoreMetrics.js';

export type RoastSignalKind =
  | 'mod_dependency'
  | 'accuracy_low'
  | 'accuracy_high'
  | 'bp_cliff'
  | 'recent_drop'
  | 'recent_rise'
  | 'balanced';

export type PlayerRankTier =
  | 'world_title_contender'
  | 'world_elite'
  | 'top_100'
  | 'elite_three_digit'
  | 'three_digit'
  | 'top_four_digit'
  | 'four_digit'
  | 'upper_five_digit'
  | 'five_digit'
  | 'upper_six_digit'
  | 'six_digit'
  | 'entry_level'
  | 'unranked';

export interface OneLineReviewFacts {
  username: string;
  mode: OsuMode;
  pp: number;
  globalRank: number | null;
  rankTier: PlayerRankTier;
  rankLabel: string;
  rankCalibration: string;
  accountAccuracy: number;
  bpCount: number;
  bpAveragePp: number | null;
  topScorePp: number | null;
  bpAverageStars: number | null;
  bpMinimumStars: number | null;
  bpMaximumStars: number | null;
  bpAverageAccuracy: number | null;
  topFiveAveragePp: number | null;
  restAveragePp: number | null;
  modCounts: { label: string; count: number; share: number }[];
  recentCount: number;
  recentAverageStars: number | null;
  recentAverageAccuracy: number | null;
  primarySignal: RoastSignalKind;
  primarySignalReason: string;
}

export function classifyGlobalRank(globalRank: number | null): Pick<
  OneLineReviewFacts,
  'rankTier' | 'rankLabel' | 'rankCalibration'
> {
  const rank = Number(globalRank || 0);
  if (!Number.isFinite(rank) || rank <= 0) {
    return { rankTier: 'unranked', rankLabel: '未排名', rankCalibration: '不能判断绝对水平，只谈成绩结构。' };
  }
  if (rank <= 10) return { rankTier: 'world_title_contender', rankLabel: `世界前十（#${rank}）`, rankCalibration: '按争夺世界第一的标准读数据；常人意义上的高星和高 PP 在这里不算卖点。' };
  if (rank <= 50) return { rankTier: 'world_elite', rankLabel: `世界顶尖（#${rank}）`, rankCalibration: '按世界顶尖玩家标准读数据，只能抓顶级成绩内部的偏科或代价。' };
  if (rank <= 100) return { rankTier: 'top_100', rankLabel: `Top 100（#${rank}）`, rankCalibration: '明确这是全球 Top 100，禁止拿普通高水平玩家的标尺贬低。' };
  if (rank <= 500) return { rankTier: 'elite_three_digit', rankLabel: `顶尖三位数（#${rank}）`, rankCalibration: '属于世界级三位数，锐评应比较成绩结构而非质疑基本实力。' };
  if (rank <= 999) return { rankTier: 'three_digit', rankLabel: `三位数（#${rank}）`, rankCalibration: '属于极高水平玩家，PP 和星数要按三位数语境解释。' };
  if (rank <= 2999) return { rankTier: 'top_four_digit', rankLabel: `头部四位数（#${rank}）`, rankCalibration: '属于四位数上层，和普通四位数明确区分。' };
  if (rank <= 9999) return { rankTier: 'four_digit', rankLabel: `四位数（#${rank}）`, rankCalibration: '属于稳定高水平玩家，但与世界顶尖、三位数仍有清楚差距。' };
  if (rank <= 49999) return { rankTier: 'upper_five_digit', rankLabel: `五位数上游（#${rank}）`, rankCalibration: '属于进阶玩家，评价成绩是否匹配五位数上游，而非用顶尖玩家阈值硬压。' };
  if (rank <= 99999) return { rankTier: 'five_digit', rankLabel: `五位数（#${rank}）`, rankCalibration: '属于有一定实力的活跃玩家，区分稳定度、偏科与冲分方式。' };
  if (rank <= 299999) return { rankTier: 'upper_six_digit', rankLabel: `六位数上游（#${rank}）`, rankCalibration: '按成长中的中级玩家看待，不能因为绝对 PP 低就当作笑点。' };
  if (rank <= 999999) return { rankTier: 'six_digit', rankLabel: `六位数（#${rank}）`, rankCalibration: '按普通成长阶段评价成绩结构，不与四位数直接比绝对数值。' };
  return { rankTier: 'entry_level', rankLabel: `百万名以后（#${rank}）`, rankCalibration: '按入门阶段评价，攻击选图和成绩结构，不羞辱水平本身。' };
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function modLabel(score: OsuScore): string {
  const mods = normalizedScoreMods(score);
  return mods.length ? mods.join('') : 'NM';
}

function rounded(value: number | null, digits = 2): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function pickPrimarySignal(facts: Omit<OneLineReviewFacts, 'primarySignal' | 'primarySignalReason'>): {
  primarySignal: RoastSignalKind;
  primarySignalReason: string;
} {
  const dominantMod = facts.modCounts[0];
  if (dominantMod && dominantMod.label !== 'NM' && dominantMod.count >= 12 && dominantMod.share >= 0.45) {
    return {
      primarySignal: 'mod_dependency',
      primarySignalReason: `${dominantMod.label} 占 BP${facts.bpCount} 的 ${(dominantMod.share * 100).toFixed(0)}%`,
    };
  }
  if (
    facts.recentCount >= 5
    && facts.bpAverageStars !== null
    && facts.recentAverageStars !== null
    && facts.recentAverageStars <= facts.bpAverageStars - 0.75
  ) {
    return {
      primarySignal: 'recent_drop',
      primarySignalReason: `Recent 平均星数比 BP 平均低 ${(facts.bpAverageStars - facts.recentAverageStars).toFixed(2)}★`,
    };
  }
  if (
    facts.recentCount >= 5
    && facts.bpAverageStars !== null
    && facts.recentAverageStars !== null
    && facts.recentAverageStars >= facts.bpAverageStars + 0.75
  ) {
    return {
      primarySignal: 'recent_rise',
      primarySignalReason: `Recent 平均星数比 BP 平均高 ${(facts.recentAverageStars - facts.bpAverageStars).toFixed(2)}★`,
    };
  }
  if (
    facts.topFiveAveragePp !== null
    && facts.restAveragePp !== null
    && facts.restAveragePp > 0
    && facts.topFiveAveragePp / facts.restAveragePp >= 1.45
  ) {
    return {
      primarySignal: 'bp_cliff',
      primarySignalReason: `BP5 平均 PP 是其余 BP 的 ${(facts.topFiveAveragePp / facts.restAveragePp).toFixed(2)} 倍`,
    };
  }
  if (facts.bpAverageAccuracy !== null && facts.bpAverageAccuracy < 0.955) {
    return {
      primarySignal: 'accuracy_low',
      primarySignalReason: `BP 平均 Acc ${(facts.bpAverageAccuracy * 100).toFixed(2)}%`,
    };
  }
  if (facts.bpCount >= 20 && facts.bpAverageAccuracy !== null && facts.bpAverageAccuracy >= 0.99) {
    return {
      primarySignal: 'accuracy_high',
      primarySignalReason: `BP 平均 Acc ${(facts.bpAverageAccuracy * 100).toFixed(2)}%`,
    };
  }
  return {
    primarySignal: 'balanced',
    primarySignalReason: '当前 BP 没有达到阈值的 Mod 依赖、准度极端或头部断层',
  };
}

export function buildOneLineReviewFacts(input: {
  user: OsuUser;
  bestScores: OsuScore[];
  recentScores: OsuScore[];
  mode: OsuMode;
}): OneLineReviewFacts {
  const bpStars = input.bestScores.map(scoreStarRating).filter((value) => value > 0);
  const bpAccuracies = input.bestScores.map((score) => Number(score.accuracy)).filter(Number.isFinite);
  const bpPp = input.bestScores.map((score) => finitePositive(score.pp)).filter((value): value is number => value !== null);
  const recentStars = input.recentScores.map(scoreStarRating).filter((value) => value > 0);
  const recentAccuracies = input.recentScores.map((score) => Number(score.accuracy)).filter(Number.isFinite);
  const topFivePp = input.bestScores.slice(0, 5).map((score) => finitePositive(score.pp)).filter((value): value is number => value !== null);
  const restPp = input.bestScores.slice(5).map((score) => finitePositive(score.pp)).filter((value): value is number => value !== null);
  const modCounter = new Map<string, number>();
  for (const score of input.bestScores) {
    const label = modLabel(score);
    modCounter.set(label, (modCounter.get(label) || 0) + 1);
  }
  const modCounts = [...modCounter.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([label, count]) => ({
      label,
      count,
      share: input.bestScores.length ? Number((count / input.bestScores.length).toFixed(4)) : 0,
    }));
  const base = {
    username: String(input.user.username || ''),
    mode: input.mode,
    pp: Number(input.user.statistics?.pp || 0),
    globalRank: finitePositive(input.user.statistics?.global_rank),
    accountAccuracy: Number(input.user.statistics?.hit_accuracy || 0),
    bpCount: input.bestScores.length,
    bpAveragePp: rounded(average(bpPp)),
    topScorePp: rounded(bpPp[0] ?? null),
    bpAverageStars: rounded(average(bpStars)),
    bpMinimumStars: bpStars.length ? rounded(Math.min(...bpStars)) : null,
    bpMaximumStars: bpStars.length ? rounded(Math.max(...bpStars)) : null,
    bpAverageAccuracy: rounded(average(bpAccuracies), 4),
    topFiveAveragePp: rounded(average(topFivePp)),
    restAveragePp: rounded(average(restPp)),
    modCounts,
    recentCount: input.recentScores.length,
    recentAverageStars: rounded(average(recentStars)),
    recentAverageAccuracy: rounded(average(recentAccuracies), 4),
  };
  const rankedBase = { ...base, ...classifyGlobalRank(base.globalRank) };
  return { ...rankedBase, ...pickPrimarySignal(rankedBase) };
}

const SIGNAL_QUERY_TERMS: Record<RoastSignalKind, string> = {
  mod_dependency: 'mod 戴 HD HR DT BP 偏科 一直只打',
  accuracy_low: 'acc 准度 掉精度 打不准 BP',
  accuracy_high: 'acc 准度 太准 99acc BP',
  bp_cliff: 'BP 前几张 后面 断层 撑着',
  recent_drop: 'recent 最近 状态 掉了 打不动',
  recent_rise: 'recent 最近 状态 变强 上升',
  balanced: 'BP 平均 平衡 没特点 评价',
};

export function buildOneLineReviewStyleQuery(facts: OneLineReviewFacts): string {
  const dominantMod = facts.modCounts[0]?.label || 'NM';
  return `osu 玩家 锐评 ${SIGNAL_QUERY_TERMS[facts.primarySignal]} ${dominantMod}`;
}

function cleanStyleExcerpt(value: unknown): string {
  return String(value || '')
    .replace(/^S\d+\s*/gm, '')
    .replace(/\s*\n\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export function buildOneLineReviewPrompt(
  facts: OneLineReviewFacts,
  styleExcerpts: string[],
): { system: string; user: string } {
  const references = styleExcerpts.map(cleanStyleExcerpt).filter(Boolean).slice(0, 5);
  return {
    system: [
      '你是 pippi，在 osu! 群里根据成绩数据锐评玩家。',
      '只输出一行，20 到 72 个中文字符，最多两个很短的句子；不要标题、列表、引号、表情或解释。',
      '攻击性为 3 到 4/5：可以嘲讽选图、偏科、Mod 依赖、PP 含金量、星数、Acc、BP 断层和近期状态；不要辱骂现实人格、智力、身体、身份或家人。',
      '挑最疼、最有辨识度的一点说，不负责安慰，也不要为了像金句而硬造比喻、反转或“不是……而是……”句式。',
      '必须引用或明确比较至少两类成绩证据。优先组合 PP、星数与 Acc；Mod 比例只能作为原因或补刀，禁止只数 Mod 数量就结束。',
      '如果一个指标极强，不要硬喷它弱；可以嘲讽强得离谱、成绩结构怪，或转而攻击另一项真实短板。',
      '玩家绝对水平只能按 globalRank、rankTier 和 rankCalibration 判断，禁止按固定 PP 阈值划分强弱。',
      'PP 可以自然地用于说明这个排名的成绩规模和 BP 含金量，但不要解释你的判级规则，也不要像念档案一样生硬复述“某某段位”。',
      '世界顶尖、Top 100、三位数、头部四位数与普通四位数必须使用不同预期；同一星数或 Acc 在不同排名语境下可以有完全不同的评价。',
      '事实只能来自本轮 JSON。BP 构成只能称为偏好或成绩结构，不能擅自升级成绝对能力。',
      '社区语料只用于学习自然程度、用词和攻击节奏；不得继承其中事实、名字，不得照抄连续八个字。',
    ].join('\n'),
    user: [
      '当前玩家事实：',
      JSON.stringify(facts),
      '',
      '社区表达参考（仅模仿说话方式）：',
      references.length ? references.map((text, index) => `${index + 1}. ${text}`).join('\n') : '无可用语料，直接、简短地说。',
      '',
      '现在只输出一句锐评。',
    ].join('\n'),
  };
}

export function normalizeOneLineReview(value: unknown, maxLength = 88): string {
  let text = String(value || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(?:锐评|评价|短评|pippi)\s*[：:]\s*/i, '')
    .replace(/^[-*•\d.、\s]+/, '')
    .replace(/[“”"]/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([。！？!?])\s+/g, '$1')
    .trim();
  if (!text) return '';
  const sentenceMatches = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  text = sentenceMatches.slice(0, 2).join('').trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  return text;
}

export function reviewEvidenceKinds(value: unknown, facts?: OneLineReviewFacts): string[] {
  const text = String(value || '');
  const kinds: string[] = [];
  if (/(?:\d+(?:\.\d+)?\s*pp\b|\bPP\d*\b)/iu.test(text)) kinds.push('pp');
  if (/\d+(?:\.\d+)?\s*(?:★|星)/u.test(text)) kinds.push('stars');
  if (/(?:\d+(?:\.\d+)?\s*%|\bAcc\b)/iu.test(text)) kinds.push('accuracy');
  const modLabels = facts?.modCounts.map((item) => item.label).filter((label) => label !== 'NM') || [];
  if (/(?:\bHD\b|\bHR\b|\bDT\b|\bNC\b|\bEZ\b|\bFL\b|\bHT\b)/iu.test(text)
    || modLabels.some((label) => text.toLocaleUpperCase().includes(label.toLocaleUpperCase()))) {
    kinds.push('mods');
  }
  return [...new Set(kinds)];
}

export function validateOneLineReview(value: unknown, facts?: OneLineReviewFacts): string[] {
  const text = String(value || '').trim();
  const reasons: string[] = [];
  if (!text) reasons.push('empty');
  if (text.includes('\n')) reasons.push('multiline');
  if (text.length < 8) reasons.push('too_short');
  if (text.length > 88) reasons.push('too_long');
  if (/【|】|```|^[-*•]/.test(text)) reasons.push('formatted');
  if (/(?:作为(?:一个)?AI|语言模型|无法评价|仅供娱乐)/i.test(text)) reasons.push('meta_disclaimer');
  if (facts && reviewEvidenceKinds(text, facts).length < 2) reasons.push('insufficient_evidence_kinds');
  return reasons;
}

function comparableStyleText(value: unknown): string {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Community windows are examples of cadence, never a phrase bank. Reject a
 * draft when it carries an eight-character run from a retrieved excerpt.
 */
export function findCopiedStyleFragment(
  review: unknown,
  styleExcerpts: string[],
  minimumLength = 8,
): string | null {
  const output = comparableStyleText(review);
  if (output.length < minimumLength) return null;
  for (const excerpt of styleExcerpts) {
    const source = comparableStyleText(cleanStyleExcerpt(excerpt));
    for (let index = 0; index + minimumLength <= output.length; index += 1) {
      const fragment = output.slice(index, index + minimumLength);
      if (source.includes(fragment)) return fragment;
    }
  }
  return null;
}

export function fallbackOneLineReview(facts: OneLineReviewFacts): string {
  const name = facts.username || '这人';
  const dominant = facts.modCounts[0];
  const standing = facts.globalRank ? `全球#${facts.globalRank}、${facts.pp.toFixed(0)}pp` : `${facts.pp.toFixed(0)}pp`;
  switch (facts.primarySignal) {
    case 'mod_dependency':
      return `${name} ${standing}，${dominant?.count || 0} 张 ${dominant?.label || '同一 Mod'} 撑着 ${facts.bpAverageStars?.toFixed(2) || '未知'}★、${((facts.bpAverageAccuracy || 0) * 100).toFixed(2)}% Acc，偏科连遮羞布都省了。`;
    case 'accuracy_low':
      return `${name} ${standing}，BP 平均 ${facts.bpAverageStars?.toFixed(2) || '未知'}★却只剩 ${((facts.bpAverageAccuracy || 0) * 100).toFixed(2)}% Acc，星数敢点，准度敢扔。`;
    case 'accuracy_high':
      return `${name} ${standing}，BP 平均 ${facts.bpAverageStars?.toFixed(2) || '未知'}★还能守住 ${((facts.bpAverageAccuracy || 0) * 100).toFixed(2)}% Acc，判定抠得比 PP 还值钱。`;
    case 'bp_cliff':
      return `${name} ${facts.rankLabel}，BP5 均分 ${facts.topFiveAveragePp?.toFixed(1) || '未知'}pp，后面只剩 ${facts.restAveragePp?.toFixed(1) || '未知'}pp，门面拆完就露馅。`;
    case 'recent_drop':
      return `${name} ${facts.rankLabel}，最近只打到 ${facts.recentAverageStars?.toFixed(2) || '未知'}★、${((facts.recentAverageAccuracy || 0) * 100).toFixed(2)}% Acc，状态已经替本人请假。`;
    case 'recent_rise':
      return `${name} ${facts.rankLabel}，最近冲到 ${facts.recentAverageStars?.toFixed(2) || '未知'}★、${((facts.recentAverageAccuracy || 0) * 100).toFixed(2)}% Acc，旧 BP 已经配不上排名。`;
    default:
      return `${name} ${standing}，BP 平均 ${facts.bpAverageStars?.toFixed(2) || '未知'}★、${((facts.bpAverageAccuracy || 0) * 100).toFixed(2)}% Acc，均衡得像没挑出主菜。`;
  }
}
