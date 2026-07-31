// Compact osu! Wiki grounding used by analysis prompts and mechanical validation.
// This is intentionally structured as domain knowledge instead of one-off HD wording fixes.
// Sources:
// - https://osu.ppy.sh/wiki/en/Gameplay/Game_modifier
// - https://osu.ppy.sh/wiki/en/Gameplay/Game_modifier_(lazer)
// - https://osu.ppy.sh/wiki/en/Gameplay/Game_modifier/Summary
// - https://osu.ppy.sh/wiki/en/Performance_points

export interface OsuModKnowledge {
  acronym: string;
  name: string;
  summary?: string;
}

export const OSU_MOD_KNOWLEDGE: readonly OsuModKnowledge[] = [
  { acronym: 'EZ', name: 'Easy', summary: '降低多项难度设置' },
  { acronym: 'NF', name: 'No Fail', summary: '避免因血条归零而失败' },
  { acronym: 'HT', name: 'Half Time', summary: '降低游玩速度' },
  { acronym: 'DC', name: 'Daycore', summary: 'lazer 中降低游玩速度并调整音频' },
  { acronym: 'HR', name: 'Hard Rock', summary: '提高多项难度设置；osu!std 中还会垂直翻转谱面' },
  { acronym: 'SD', name: 'Sudden Death', summary: 'Miss 时失败' },
  { acronym: 'PF', name: 'Perfect', summary: '成绩不能保持 SS 时失败' },
  { acronym: 'DT', name: 'Double Time', summary: '提高游玩速度' },
  { acronym: 'NC', name: 'Nightcore', summary: '具有 DT 的提速效果并改变音频表现' },
  { acronym: 'HD', name: 'Hidden', summary: 'osu!std 中移除 approach circle，并让物件出现后淡出' },
  { acronym: 'FI', name: 'Fade In' },
  { acronym: 'FL', name: 'Flashlight', summary: '限制可见区域' },
  { acronym: 'RX', name: 'Relax' },
  { acronym: 'RL', name: 'Relax' },
  { acronym: 'AP', name: 'Autopilot' },
  { acronym: 'SO', name: 'Spun Out', summary: '自动完成 spinner' },
  { acronym: 'AT', name: 'Auto / Autoplay' },
  { acronym: 'CM', name: 'Cinema (stable)' },
  { acronym: 'CN', name: 'Cinema (lazer)' },
  { acronym: 'TP', name: 'Target Practice' },
  { acronym: 'SV2', name: 'ScoreV2' },
  { acronym: 'TD', name: 'Touch Device' },
  { acronym: 'DA', name: 'Difficulty Adjust' },
  { acronym: 'CL', name: 'Classic' },
  { acronym: 'RD', name: 'Random' },
  { acronym: 'MR', name: 'Mirror' },
  { acronym: 'CP', name: 'Co-op' },
  { acronym: 'BL', name: 'Blinds' },
  { acronym: 'ST', name: 'Strict Tracking' },
  { acronym: 'AC', name: 'Accuracy Challenge' },
  { acronym: 'TC', name: 'Traceable' },
  { acronym: 'AL', name: 'Alternate' },
  { acronym: 'SG', name: 'Single Tap' },
  { acronym: 'TR', name: 'Transform' },
  { acronym: 'WG', name: 'Wiggle' },
  { acronym: 'SI', name: 'Spin In' },
  { acronym: 'GR', name: 'Grow' },
  { acronym: 'DF', name: 'Deflate' },
  { acronym: 'WU', name: 'Wind Up' },
  { acronym: 'WD', name: 'Wind Down' },
  { acronym: 'BR', name: 'Barrel Roll' },
  { acronym: 'AD', name: 'Approach Different' },
  { acronym: 'MU', name: 'Muted' },
  { acronym: 'NS', name: 'No Scope' },
  { acronym: 'MG', name: 'Magnetised' },
  { acronym: 'RP', name: 'Repel' },
  { acronym: 'AS', name: 'Adaptive Speed' },
  { acronym: 'FR', name: 'Freeze Frame' },
  { acronym: 'BU', name: 'Bubbles' },
  { acronym: 'SY', name: 'Synesthesia' },
  { acronym: 'DP', name: 'Depth' },
  { acronym: 'BM', name: 'Bloom' },
  ...Array.from({ length: 10 }, (_, index) => ({
    acronym: `${index + 1}K`,
    name: `${index + 1}K`,
  })),
] as const;

const MOD_BY_ACRONYM = new Map(OSU_MOD_KNOWLEDGE.map(mod => [mod.acronym, mod]));
const MOD_ACRONYMS_LONGEST_FIRST = [...MOD_BY_ACRONYM.keys()].sort(
  (left, right) => right.length - left.length
);

/**
 * Split the compact community/API label into real mod acronyms.
 * Example: NFSO -> [NF, SO], HDHR -> [HD, HR].
 * NM is a report label meaning no mods, not a mod itself.
 */
export function splitModCombination(label: string): string[] | null {
  const normalized = label.trim().toUpperCase();
  if (normalized === 'NM') return [];
  if (!normalized) return null;

  const memo = new Map<number, string[] | null>();
  const visit = (offset: number): string[] | null => {
    if (offset === normalized.length) return [];
    if (memo.has(offset)) return memo.get(offset) ?? null;

    for (const acronym of MOD_ACRONYMS_LONGEST_FIRST) {
      if (!normalized.startsWith(acronym, offset)) continue;
      const tail = visit(offset + acronym.length);
      if (tail) {
        const result = [acronym, ...tail];
        memo.set(offset, result);
        return result;
      }
    }
    memo.set(offset, null);
    return null;
  };

  return visit(0);
}

function isKnownModLabel(label: string): boolean {
  return splitModCombination(label) !== null && label.toUpperCase() !== 'NM';
}

/**
 * Detect wording that assigns a score modifier to the beatmap itself or turns a
 * score sample into an absolute preference. This is generic across HR, NFSO,
 * lazer mods, and future combinations composed from known acronyms.
 */
export function findModSemanticsViolation(value: string): string | null {
  const candidates: { regex: RegExp; tokenIndex: number; reason: string }[] = [
    {
      regex: /([A-Z0-9]{2,12})\s*(?:图|谱面)/g,
      tokenIndex: 1,
      reason: '把成绩上的 Mod 写成了谱面类型',
    },
    {
      regex: /(?:谱面|图)[^。\n]{0,10}(?:自带|带着|挂着|戴着)\s*([A-Z0-9]{2,12})/g,
      tokenIndex: 1,
      reason: '把 Mod 写成了谱面自带属性',
    },
    {
      regex: /(?:没|没有|不带|无)\s*([A-Z0-9]{2,12})\s*(?:的)?(?:图|谱面)/g,
      tokenIndex: 1,
      reason: '把是否启用 Mod 写成了谱面分类',
    },
    {
      regex: /无\s*([A-Z0-9]{2,12})\s*不(?:欢|玩|打|点)/g,
      tokenIndex: 1,
      reason: '把 BP 的 Mod 构成扩大成了绝对偏好',
    },
    {
      regex: /没开\s*([A-Z0-9]{2,12})[^。\n]{0,16}(?:不|没)(?:点|玩|打)/g,
      tokenIndex: 1,
      reason: '把 BP 的 Mod 构成扩大成了绝对偏好',
    },
  ];

  for (const candidate of candidates) {
    for (const match of value.matchAll(candidate.regex)) {
      const token = match[candidate.tokenIndex] || '';
      if (isKnownModLabel(token)) return `${candidate.reason}：${match[0]}`;
    }
  }
  return null;
}

const stableModList = 'EZ、NF、HT、HR、SD、PF、DT、NC、HD、FL、RX/RL、AP、SO、AT、TP、SV2 等';
const lazerModList = 'DA、CL、AC、TC、WU、WD 等';
const compactExamples = OSU_MOD_KNOWLEDGE
  .filter(mod => mod.summary)
  .map(mod => `${mod.acronym}=${mod.summary}`)
  .join('；');

export const OSU_WIKI_DOMAIN_RULES = [
  'osu! Wiki 领域规则：',
  '1. 谱面（beatmap）和成绩（score）是不同对象。BPM、长度及基础难度设置来自谱面；Acc、Combo、Miss、pp 和实际启用的 Mods 属于某次成绩。Mod 后星数或难度设置是“以该组 Mods 游玩时”的属性，不能反过来说谱面自带这些 Mods。',
  '2. Game modifier（Mod）通常由玩家为一次游玩启用，并记录在成绩上。出现某个 Mod 只能证明这次成绩使用了它；从 BP 分布可以评价“高位成绩的 Mod 构成”，不能直接断言长期偏好、动机、只玩什么或拒绝什么。',
  `3. 常见 stable Mod 缩写包括 ${stableModList}；lazer 还存在 ${lazerModList}。面向玩家保留社区缩写，不生硬翻译成“隐身模组”等中文名。`,
  '4. 连写标签表示 Mod 组合，不是新的单个 Mod。例如 HDHR=HD+HR，HDDT=HD+DT，NFSO=NF+SO。NM 仅表示该成绩没有启用 Mod，不是一个名为 NM 的 Mod。',
  '5. API/客户端表示存在兼容细节：NC 具有 DT 的提速效果，PF 与 SD 有继承关系，TD 与输入方式相关。不要仅凭缩写声称每一项都体现了玩家独立、刻意的选择。',
  `6. 只在确实需要解释 Mod 效果时使用这些 Wiki 摘要，并注意游戏模式差异：${compactExamples}。报告的重点仍是数据关系，不逐项科普。`,
  '7. Best Performance 是玩家高位成绩的排序，社区简称 BP；前一百张称 BP100，前五张称 BP5。各张成绩按排名加权，越靠后计入总 pp 的权重越低。',
  '8. S/SS 在 HD 或 FL 条件下显示为银色 SH/SSH。银色评级说明成绩使用了 HD 或 FL，不代表“差一点 SS”、choke 或某处失误。',
  '9. 成绩使用 Mod 时，报告中的星数必须采用官方 /beatmaps/{id}/attributes 按完整 Mod 组合返回的 star_rating；score.beatmap.difficulty_rating 是基础谱面星数，不能直接当作该成绩的 Mod 后星数。',
].join('\n');
