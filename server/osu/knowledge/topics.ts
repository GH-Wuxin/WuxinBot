import type { OsuKnowledgeEntry } from './types.js';
import { formatKnowledgeBlock } from './types.js';
import { OSU_KNOWLEDGE_SOURCES, WIKI_SOURCE } from './sources.js';
import { buildModKnowledge, MOD_ANALYSIS_ENTRIES } from './mods.js';

export const TOPIC_ENTRIES: readonly OsuKnowledgeEntry[] = [
  {
    id: 'performance_detail', authority: 'official', tags: ['pp', 'rank', 'bp', 'weighted'], source: WIKI_SOURCE.pp,
    fact: '高位成绩按排名衰减加权进入总 pp，BP1 与 BP100 的贡献不同；bonus pp 等也会让总 pp 不等于 BP pp 简单相加。不同年代存在 pp 通胀和算法变化，因此跨时代比较优先参考当时排名与规则。',
  },
  {
    id: 'dt_ht_clock', authority: 'official', tags: ['DT', 'NC', 'HT', 'DC', 'BPM', 'clock_rate'], source: `${WIKI_SOURCE.mods}/Double_Time/en.md`,
    fact: 'DT/NC 提高时钟速度，HT/DC 降低时钟速度，连带改变实际 BPM、时长、AR/OD 时间窗口和星数。分析成绩应使用完整 Mod 设置后的官方 attributes。',
  },
  {
    id: 'ar_detail', authority: 'official', tags: ['AR', 'reading'], source: WIKI_SOURCE.ar,
    fact: 'AR 描述物件出现到击打时刻的提前时间。低 AR 与高 AR 带来不同视觉密度和反应窗口，但单凭 AR 不能概括全部 reading 能力。',
  },
  {
    id: 'od_detail', authority: 'official', tags: ['OD', 'acc', 'hit_window'], source: WIKI_SOURCE.od,
    fact: 'OD 影响 hit window 等判定条件；同样的 Acc 在不同 OD、速度和谱面结构下不能简单横向等价。',
  },
  {
    id: 'grade_detail', authority: 'official', tags: ['SS', 'SSH', 'S', 'SH', 'grade'], source: WIKI_SOURCE.grades,
    fact: 'SSH/SH 是在 HD 或 FL 条件下显示的银色 SS/S；它们不表示差一点得到更高评级，也不能定位失误。',
  },
  {
    id: 'pattern_detail', authority: 'community', tags: ['aim', 'jump', 'stream', 'flow', 'alt', 'tech', 'speed', 'reading'], source: OSU_KNOWLEDGE_SOURCES.wiki,
    fact: 'aim/jump 关注光标移动与跳跃，stream/flow 关注连续串与流动处理，alt 涉及交替节奏，tech 常包含复杂节奏或滑条结构，speed 关注高速点击，reading 关注视觉与节奏解读。这些会重叠，不是互斥职业分类。',
  },
  {
    id: 'analysis_evidence', authority: 'analysis_policy', tags: ['analysis', 'evidence'], source: 'Wuxin analysis policy',
    fact: '账号画像可以评价当前 BP 展示出的结构；能力原因、练习习惯、设备、身体状态和具体失误需要额外证据。明显标记的玩笑可以存在，但不能冒充机制结论。',
  },
];

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const TOPIC_MOD_ACRONYMS = [
  ...Object.keys(MOD_ANALYSIS_ENTRIES),
  'NM', 'HD', 'HR', 'DT', 'NC',
].sort((left, right) => right.length - left.length);

function splitMentionedModToken(token: string): string[] {
  const value = token.toUpperCase();
  const memo = new Map<number, string[] | null>();
  const visit = (index: number): string[] | null => {
    if (index === value.length) return [];
    if (memo.has(index)) return memo.get(index) || null;
    for (const mod of TOPIC_MOD_ACRONYMS) {
      if (!value.startsWith(mod, index)) continue;
      const tail = visit(index + mod.length);
      if (tail) {
        const result = [mod, ...tail];
        memo.set(index, result);
        return result;
      }
    }
    memo.set(index, null);
    return null;
  };
  return visit(0) || [];
}

function mentionedModAcronyms(value: string): Set<string> {
  const result = new Set<string>();
  for (const token of value.match(/\b[A-Z]{2,16}\b/g) || []) {
    for (const mod of splitMentionedModToken(token)) result.add(mod);
  }
  return result;
}

export function buildOsuTopicKnowledge(text: string): string {
  const value = String(text || '');
  const mentionedAcronyms = mentionedModAcronyms(value.toUpperCase());
  const entries: OsuKnowledgeEntry[] = [];
  const addById = (...ids: string[]) => {
    for (const id of ids) {
      const entry = TOPIC_ENTRIES.find((item) => item.id === id);
      if (entry && !entries.includes(entry)) entries.push(entry);
    }
  };

  if (includesAny(value, [/\bpp\b/i, /\bbp\d*\b/i, /rank|排名|表现分|加权/i])) addById('performance_detail');
  if (
    ['DT', 'NC', 'HT', 'DC'].some((mod) => mentionedAcronyms.has(mod))
    || includesAny(value, [/星数|BPM|倍速|时钟|clock/i])
  ) addById('dt_ht_clock');
  if (includesAny(value, [/\bAR\b/i, /低\s*AR|高\s*AR|读图|reading/i])) addById('ar_detail');
  if (includesAny(value, [/\bOD\b/i, /判定窗|hit\s*window|准确率|\bAcc\b/i])) addById('od_detail');
  if (includesAny(value, [/\b(?:SS|SSH|SH)\b/i, /银S|银色评级|评级/i])) addById('grade_detail');
  if (includesAny(value, [/aim|jump|stream|flow|alt|tech|speed|reading|跳图|串图|切换|读图|串批|跳批/i])) addById('pattern_detail');
  if (includesAny(value, [/分析|画像|评价|为什么|能力|偏科/i])) addById('analysis_evidence');

  const mentionedMods = Object.keys(MOD_ANALYSIS_ENTRIES).filter((mod) => mentionedAcronyms.has(mod));
  const modKnowledge = buildModKnowledge(mentionedMods);
  const topicKnowledge = formatKnowledgeBlock('当前话题调用的 osu! 专业知识', entries);
  return [topicKnowledge, modKnowledge].filter(Boolean).join('\n\n');
}
