import type { OsuKnowledgeEntry } from './types.js';
import { formatKnowledgeBlock } from './types.js';
import { OSU_KNOWLEDGE_SOURCES, WIKI_SOURCE } from './sources.js';

export const OSU_CORE_ENTRIES: readonly OsuKnowledgeEntry[] = [
  {
    id: 'objects_score_beatmap', authority: 'official', tags: ['score', 'beatmap', 'mods'], source: WIKI_SOURCE.mods,
    fact: '谱面保存 BPM、长度和基础 AR/OD/CS/HP；Acc、Combo、Miss、pp 与启用的 Mods 属于一次成绩。Mod 后属性描述这次游玩条件，不能说谱面自带某个 Mod。',
  },
  {
    id: 'bp_pp_rank', authority: 'official', tags: ['bp', 'pp', 'rank'], source: WIKI_SOURCE.pp,
    fact: 'BP 是 Best Performance；总 pp 怎么算：由按名次衰减加权的高位成绩（BP）与 bonus pp 等组成，总 pp 不等于 BP 简单相加。rank 表示当前竞争位置，pp 表示当前规则与时代下的累计表现规模；评价玩家时两者都要看。',
  },
  {
    id: 'attributes', authority: 'official', tags: ['AR', 'OD', 'CS', 'HP', 'stars'], source: WIKI_SOURCE.ar,
    fact: 'AR 是什么：AR 控制物件提前出现时间，AR 越高反应时间越短；OD 影响判定窗口等，CS 控制圆圈大小，HP 影响掉血与回血。星数是综合难度估计，不能单独代表所有能力。',
  },
  {
    id: 'score_judgement', authority: 'official', tags: ['acc', 'combo', 'miss', 'fc', 'choke'], source: WIKI_SOURCE.grades,
    fact: 'Acc、Combo、Miss 和评级描述成绩结果；FC/choke、失误位置、实际操作原因需要更细的成绩或 replay 证据，不能仅凭 pp 或标题补故事。',
  },
  {
    id: 'mods_core', authority: 'official', tags: ['NM', 'HD', 'HR', 'DT', 'NC', 'EZ', 'FL'], source: WIKI_SOURCE.mods,
    fact: 'NM 表示没有启用 Mod，并非一个 Mod；HD 是 Hidden、HR 是 Hard Rock、DT 是 Double Time，NC 具有 DT 的提速效果。HDHR、HDDT、EZDT、NFSO 等是多个 Mod 的组合。面向玩家使用社区缩写。',
  },
  {
    id: 'modded_attributes', authority: 'official', tags: ['mods', 'stars', 'clock_rate'], source: OSU_KNOWLEDGE_SOURCES.api,
    fact: '带 Mod 成绩的星数应使用完整 Mod 组合计算后的官方 beatmap attributes；基础 difficulty_rating 不能冒充 Mod 后星数。',
  },
  {
    id: 'beatmap_status', authority: 'official', tags: ['ranked', 'loved', 'qualified'], source: WIKI_SOURCE.status,
    fact: 'Ranked/Approved、Qualified、Loved 等是谱面状态；Loved 有排行榜但通常不授予 pp，状态不能直接当作谱面质量或难度标签。',
  },
  {
    id: 'patterns', authority: 'community', tags: ['aim', 'jump', 'stream', 'alt', 'tech', 'reading'], source: OSU_KNOWLEDGE_SOURCES.wiki,
    fact: '跳图、串图、alt、tech、speed、reading 是社区对谱面或能力维度的描述。仅凭标题、星数或 Mod 不能确定图型；分类器结果也只是模型标签，不是官方属性。',
  },
  {
    id: 'client_versions', authority: 'official', tags: ['stable', 'lazer'], source: OSU_KNOWLEDGE_SOURCES.lazer,
    fact: 'stable 与 lazer 在 Mod、计分、成绩表示和兼容行为上存在差异；遇到 lazer 专属 Mod 或设置时不能直接套用 stable 时代的规则。',
  },
] as const;

export const PIPPI_OSU_CORE_KNOWLEDGE = [
  formatKnowledgeBlock('pippi 始终掌握的 osu! 核心知识', OSU_CORE_ENTRIES),
  '这些是常识背景，不要在无关聊天中主动背诵；一旦话题涉及 osu!，自然、准确地使用。玩家专属数字仍必须来自当前 API/工具，不能凭核心知识猜。',
].join('\n');
