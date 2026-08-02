import type { OsuKnowledgeEntry } from './types.js';
import { formatKnowledgeBlock } from './types.js';
import { OSU_KNOWLEDGE_SOURCES, WIKI_SOURCE } from './sources.js';

export const SPECIAL_MOD_ACRONYMS = new Set([
  'EZ', 'FL', 'TD', 'HT', 'DC', 'NF', 'SO', 'SD', 'PF', 'DA', 'CL', 'RX', 'RL', 'AP', 'AT',
]);

export const MOD_ANALYSIS_ENTRIES: Readonly<Record<string, OsuKnowledgeEntry>> = {
  EZ: {
    id: 'mod_ez', authority: 'official', tags: ['EZ', 'AR', 'OD', 'CS', 'HP'], source: `${WIKI_SOURCE.mods}/Easy/en.md`,
    fact: 'EZ 会降低 AR、OD、CS 和 HP。名字叫 Easy 不代表高水平 EZ 成绩可以简单评价成“把图变容易”；它会形成不同的阅读与判定条件。没有谱面细节或 replay 时，只能说 EZ 成绩很有辨识度，不能直接认证低 AR 阅读能力。',
  },
  FL: {
    id: 'mod_fl', authority: 'official', tags: ['FL', 'visibility'], source: `${WIKI_SOURCE.mods}/Flashlight/en.md`,
    fact: 'FL 会限制可见区域，效果会随 Combo 等条件变化。FL 出现在 BP 前排值得单独注意，但仅凭成绩不能断言它来自背图、阅读或重试次数。',
  },
  TD: {
    id: 'mod_td', authority: 'official', tags: ['TD', 'input'], source: WIKI_SOURCE.mods,
    fact: 'TD 表示触屏输入方式相关标记，不应当作普通难度 Mod 或独立能力加成评价。',
  },
  HT: {
    id: 'mod_ht', authority: 'official', tags: ['HT', 'clock_rate'], source: `${WIKI_SOURCE.mods}/Half_Time/en.md`,
    fact: 'HT 降低时钟速度，并连带改变 BPM、长度和有效难度属性；评价时必须使用 HT 后属性，不能只看基础星数。',
  },
  DC: {
    id: 'mod_dc', authority: 'official', tags: ['DC', 'clock_rate', 'lazer'], source: WIKI_SOURCE.mods,
    fact: 'DC 是 lazer 中的降速音频变体，具有 HT 类的降速语义；需要按 lazer 成绩设置理解。',
  },
  NF: {
    id: 'mod_nf', authority: 'official', tags: ['NF', 'fail'], source: `${WIKI_SOURCE.mods}/No_Fail/en.md`,
    fact: 'NF 避免血条归零导致失败，并会影响成绩乘数或 pp 计算。它首先描述提交成绩的游玩条件，不应自动变成能力或性格标签。',
  },
  SO: {
    id: 'mod_so', authority: 'official', tags: ['SO', 'spinner'], source: `${WIKI_SOURCE.mods}/Spun_Out/en.md`,
    fact: 'SO 自动完成 spinner，并可能影响分数或 pp；它不直接说明玩家除 spinner 外的能力。NFSO 要拆成 NF+SO 理解。',
  },
  SD: {
    id: 'mod_sd', authority: 'official', tags: ['SD', 'fail'], source: `${WIKI_SOURCE.mods}/Sudden_Death/en.md`,
    fact: 'SD 在 Miss 时令游玩失败。使用 SD 只说明该次成绩的失败条件，不能自动解释为完美主义或练习习惯。',
  },
  PF: {
    id: 'mod_pf', authority: 'official', tags: ['PF', 'fail'], source: `${WIKI_SOURCE.mods}/Perfect/en.md`,
    fact: 'PF 要求成绩保持 SS，否则游玩失败；它与 SD 有继承关系。不能仅凭 PF 推断玩家性格。',
  },
  DA: {
    id: 'mod_da', authority: 'official', tags: ['DA', 'lazer', 'attributes'], source: OSU_KNOWLEDGE_SOURCES.lazer,
    fact: 'DA 允许在 lazer 中调整部分难度属性。必须读取实际设置，单看 DA 缩写不足以知道 AR/OD/CS/HP 如何变化。',
  },
  CL: {
    id: 'mod_cl', authority: 'official', tags: ['CL', 'lazer', 'classic'], source: OSU_KNOWLEDGE_SOURCES.lazer,
    fact: 'CL 是 lazer 的 Classic Mod，用于恢复部分 stable 风格行为；其设置可能携带额外选项，不能只凭缩写推断全部效果。',
  },
  RX: {
    id: 'mod_rx', authority: 'official', tags: ['RX', 'unranked'], source: WIKI_SOURCE.mods,
    fact: 'RX/Relax 自动处理点击，通常不产生正常 ranked pp；不能与普通 BP 能力直接比较。',
  },
  RL: {
    id: 'mod_rl', authority: 'official', tags: ['RL', 'unranked'], source: WIKI_SOURCE.mods,
    fact: 'RL 是 Relax 的另一种 API/客户端缩写表示，应按 RX 语义理解。',
  },
  AP: {
    id: 'mod_ap', authority: 'official', tags: ['AP', 'unranked'], source: WIKI_SOURCE.mods,
    fact: 'AP/Autopilot 自动控制光标移动，不代表正常玩家成绩能力，也通常不属于 ranked pp 画像。',
  },
  AT: {
    id: 'mod_at', authority: 'official', tags: ['AT', 'Auto'], source: WIKI_SOURCE.mods,
    fact: 'AT/Auto 是自动游玩展示，不是玩家亲手完成的 ranked 成绩；本项目“pippi 在打 Auto”属于二创设定，不是官方机制说明。',
  },
};

export function buildModKnowledge(acronyms: Iterable<string>): string {
  const unique = [...new Set([...acronyms].map((value) => String(value).toUpperCase()))];
  const entries = unique.map((mod) => MOD_ANALYSIS_ENTRIES[mod]).filter(Boolean);
  return formatKnowledgeBlock('当前相关的特殊 Mod 知识', entries);
}
