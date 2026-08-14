// Phase A — capability → agent-tool exposure metadata.
//
// This is the SINGLE source for which query_osu capabilities the LLM may call
// and how they are described. buildBotToolSchemas derives the query_osu tool
// description and capability enum from this table; INTERNAL_CAPABILITIES stays
// the executor-side registry. The audit function is the consistency gate:
// every callable capability must have an executor-side entry and vice versa.
import { INTERNAL_CAPABILITIES } from './registry.js';

export interface AgentCapabilityMeta {
  capability: string;
  callable: boolean;
  description: string;
  /** Every capability here is a readonly data query; writes stay command-only. */
  sideEffects: 'readonly';
  /** Deployment rollout. owner_canary = only the owner's turns may trigger it. */
  rollout: 'all' | 'owner_canary';
}

export const AGENT_CAPABILITY_META: readonly AgentCapabilityMeta[] = [
  { capability: 'bp', callable: true, sideEffects: 'readonly', rollout: 'all', description: '最佳成绩（单张 #N 或范围 N-M，最多 100 张，一张图）' },
  { capability: 'bp_type', callable: true, sideEffects: 'readonly', rollout: 'all', description: 'BP 谱面类型分析（用户问 BP 类型/占比/结构/构成/串图/跳图/aim/alt/tech/stream 时调用；osu!oracle 对 Top100 分类，仅 osu!std，训练范围约 5★-9★，结果按真实分布回复，禁止编造）' },
  { capability: 'recent', callable: true, sideEffects: 'readonly', rollout: 'all', description: '最近一次 osu! 成绩（含图片）' },
  { capability: 'info', callable: true, sideEffects: 'readonly', rollout: 'all', description: '玩家信息卡（含图片）' },
  { capability: 'profile', callable: true, sideEffects: 'readonly', rollout: 'all', description: '玩家资料文本' },
  { capability: 'ppplus', callable: true, sideEffects: 'readonly', rollout: 'all', description: 'PP+ 维度分析' },
  { capability: 'skill', callable: true, sideEffects: 'readonly', rollout: 'all', description: '玩家技能雷达' },
  { capability: 'recommend', callable: true, sideEffects: 'readonly', rollout: 'all', description: '谱面推荐（协同过滤：与你同分段的玩家在打的图；玩家要求推图/推荐谱面/打什么图/有没有适合我的图时调用，数据来自 osu! API v2）' },
  { capability: 'match', callable: true, sideEffects: 'readonly', rollout: 'all', description: 'osu! 多人比赛观战（!ml <matchID> 开始监听对局并推送开局/回合成绩；玩家说“观战/比赛直播/!ml”时引导使用快捷指令）' },
  { capability: 'beatmap_lookup', callable: true, sideEffects: 'readonly', rollout: 'all', description: '谱面信息与星数（玩家问“这图多少星/多少 AR/多久/谁做的”时调用；beatmap_id 必填；可选 mods 返回官方带 mod 星数）' },
  { capability: 'pp_calc', callable: true, sideEffects: 'readonly', rollout: 'all', description: '估算某张图给定 acc/combo/miss 的 pp（rosu 估算，不是官方精确值；beatmap_id 必填，可选 mods/accuracy(0-100)/combo/misses；回复时必须说明是估算值）。SS/FC 估算就是 accuracy=100、misses=0、combo=max_combo。用户说“我bp1/我bp几”时没有 beatmap_id：先调 capability=bp 取该 BP 的谱面（beatmap_id 与 mods），再调本 capability；玩家问“如果我bp1 SS 了能有多少 pp”这类假设题必须走这条链实际计算，禁止直接编数字' },
  { capability: 'leaderboard', callable: true, sideEffects: 'readonly', rollout: 'all', description: '谱面全球榜单（玩家问“榜一多少/前几是谁”时调用；beatmap_id 必填，可选 mods/limit(1-50)）' },
] as const;

export function agentCapabilityMeta(capability: string): AgentCapabilityMeta | undefined {
  return AGENT_CAPABILITY_META.find((entry) => entry.capability === capability);
}

export function callableCapabilities(): string[] {
  return AGENT_CAPABILITY_META.filter((entry) => entry.callable).map((entry) => entry.capability);
}

export function buildQueryOsuDescription(): string {
  const capList = AGENT_CAPABILITY_META
    .filter((entry) => entry.callable)
    .map((entry) => `${entry.capability}（${entry.description}）`)
    .join('；');
  return `查询 osu! 数据（Wuxin 内部：osu! API v2、PP+、skill store、rosu pp 估算；图片由 yumu-image 渲染）。可用查询：${capList}。玩家要求推图/推荐谱面/打什么图时使用 capability=recommend，username 可填任意 osu! 用户名（不需要提问者已绑定）。数据来自真实 API，不是你凭记忆编的。pp_calc 返回的是 rosu 估算值，引用时说明是估算。没有 capability 枚举之外的查询类型，禁止编造参数。回答中出现的任何 pp/星数/acc/排名数字都必须来自工具返回：玩家要精确计算而你还没调用对应工具时，必须先调用工具再答；工具没返回或失败时禁止报数（哪怕标注“大概”），只能说明还没算出来或服务不可用。玩家上轮说“要/好/算/帮我算”确认时，先真的调用工具计算再回复，不能只查一次成绩就说“算好了”。不要在你的回复正文里输出任何 XML/DSML/tool_calls 格式的调用文本，工具调用只通过结构化 tool_calls 执行。`;
}

export interface CapabilityAuditViolation {
  code: string;
  message: string;
}

/** Consistency gate: meta table and executor registry must agree. */
export function auditAgentCapabilityRegistry(): CapabilityAuditViolation[] {
  const violations: CapabilityAuditViolation[] = [];
  const metaNames = AGENT_CAPABILITY_META.map((entry) => entry.capability);
  const executorNames: readonly string[] = INTERNAL_CAPABILITIES.map((entry) => entry.name);

  for (const entry of AGENT_CAPABILITY_META) {
    if (!executorNames.includes(entry.capability)) {
      violations.push({ code: 'META_WITHOUT_EXECUTOR', message: `agent meta capability "${entry.capability}" has no INTERNAL_CAPABILITIES executor entry` });
    }
    if (entry.callable && entry.rollout !== 'all' && entry.rollout !== 'owner_canary') {
      violations.push({ code: 'INVALID_ROLLOUT', message: `capability "${entry.capability}" has invalid rollout "${entry.rollout}"` });
    }
    if (entry.sideEffects !== 'readonly') {
      violations.push({ code: 'NON_READONLY_AGENT_CAPABILITY', message: `capability "${entry.capability}" must stay readonly for agent exposure` });
    }
  }
  for (const name of executorNames) {
    if (!metaNames.includes(name)) {
      violations.push({ code: 'EXECUTOR_WITHOUT_META', message: `INTERNAL_CAPABILITIES entry "${name}" has no agent meta (add callable:false if it must stay command-only)` });
    }
  }
  const dupes = metaNames.filter((name, index) => metaNames.indexOf(name) !== index);
  if (dupes.length > 0) {
    violations.push({ code: 'DUPLICATE_CAPABILITY', message: `duplicate capability meta: ${[...new Set(dupes)].join(', ')}` });
  }
  return violations;
}
