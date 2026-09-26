// P1B exposure-aware single-source tool guidance.
//
// The capability names, external bot names and recent selector ids are derived
// from capabilityCatalog / registry metadata. The remaining text is a compact,
// single handwritten policy block for facts that deterministic metadata does
// not (and should not) express: no fabrication, tool-failure honesty,
// attribution, BID delivery, bp_type/recommend/pp_calc/recent route facts and
// no-markup output rules.
//
// Exposure contract:
//   buildToolGuidance()                       -> full canonical guidance
//   buildToolGuidance({ exposedCapabilities }) -> subset guidance
//   empty exposedCapabilities                 -> ''
//   any unknown/ambiguous capability id       -> fail closed to full
//
// This module has no DB, network or LLM dependency and is deterministic.
import { AGENT_CAPABILITY_META } from './agentCapabilities.js';
import { RECENT_BOT_SELECTOR_IDS } from './capabilityCatalog.js';
import { DEFAULT_BOTS } from './registry.js';

export interface ToolGuidanceMetadata {
  /** Canonical callable capability names, in catalog order. */
  capabilities: readonly string[];
  /** Canonical internal bot display names, in registry order. */
  externalBotNames: readonly string[];
  /** Canonical bot ids supported as a recent selector. */
  recentSelectorIds: readonly string[];
}

export type ToolGuidanceExposure = { exposedCapabilities: readonly string[] };

export const TOOL_GUIDANCE_VERSION = 'p1b-v1';

export interface ToolPolicy {
  id: string;
  scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED' | 'CAPABILITY_SCOPED';
  requiredCapabilities?: readonly string[];
  text: string;
}

const POLICIES: readonly ToolPolicy[] = [
  {
    id: 'P_GLOBAL_NO_FABRICATE',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '你必须通过 query_osu 获取真实 osu! 数据；数据来源是 osu! API v2、PP+ 和 osu!oracle，不是你自己的记忆。',
  },
  {
    id: 'P_GLOBAL_NO_NUMBERS_WITHOUT_TOOL',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '任何 pp/星数/acc/排名数字都必须来自工具返回。工具没调用过或调用失败时禁止报数（哪怕标注“大概”），只能说明还没算出来或服务暂时不可用。',
  },
  {
    id: 'P_GLOBAL_ROUTE_FACTS',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '日常闲聊不需要工具；分析/判断类问题也要先查数据再分析。玩家问“我是谁”等身份问题时必须查绑定，不用上下文猜。',
  },
  {
    id: 'P_BP_TYPE_SCOPED',
    scope: 'CAPABILITY_SCOPED',
    requiredCapabilities: ['bp_type'],
    text: '涉及 BP 类型/占比/串图/跳图/aim/alt/tech/stream 时，必须调用 capability=bp_type；未调用工具前不得给出任何比例，也禁止用旧上下文猜测。',
  },
  {
    id: 'P_RECOMMEND_SCOPED',
    scope: 'CAPABILITY_SCOPED',
    requiredCapabilities: ['recommend'],
    text: '玩家要求推图/推荐谱面/打什么图时，必须调用 capability=recommend；推荐对象可以是任意 osu! 用户名，不需要绑定。最终回复文本必须包含工具返回的完整标题和 BID；工具失败或无候选时只能如实说明原因，禁止编造谱面名、难度或 BID，也不得无视用户筛选条件。',
  },
  {
    id: 'P_PP_CALC_SCOPED',
    scope: 'CAPABILITY_SCOPED',
    requiredCapabilities: ['pp_calc'],
    text: 'pp 计算必须调用 capability=pp_calc，回复时必须说明是 rosu 估算。玩家确认“算一下”时也要真的再次调用工具，不能只查一次就说“算好了”。',
  },
  {
    id: 'P_RECENT_SCOPED',
    scope: 'CAPABILITY_SCOPED',
    requiredCapabilities: ['recent'],
    text: 'profile/info/skill 等结果不含 recent。询问最近成绩/最近状态时必须调用 capability=recent 实时查询；工具没返回 recent 字段不等于玩家没有最近成绩。',
  },
  {
    id: 'P_GLOBAL_ATTRIBUTION',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '引用任何查询结果时必须先说玩家名，禁止把某位玩家的数据说成另一位玩家的；不确定归属就如实说不知道。',
  },
  {
    id: 'P_GLOBAL_STD_ONLY',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '本 bot 只支持 osu!std；taiko/catch/mania 暂不支持，禁止拿 std 数据冒充。',
  },
  {
    id: 'P_GLOBAL_NO_MARKUP',
    scope: 'GLOBAL_WHEN_ANY_TOOL_EXPOSED',
    text: '回复正文永远不要输出 XML/DSML/tool_calls/invoke/parameter 之类工具调用标记；工具调用由系统结构化执行。',
  },
];

/**
 * Pure generated assembly. Metadata mutation automatically changes this text;
 * there is no second handwritten copy of the metadata facts.
 */
export function buildToolGuidanceFromMetadata(
  meta: ToolGuidanceMetadata,
  exposure?: ToolGuidanceExposure,
  policies: readonly ToolPolicy[] = POLICIES,
): string {
  const canonical = [...new Set(meta.capabilities.map((name) => String(name).trim()).filter(Boolean))];
  let selected = canonical;
  if (exposure) {
    const requested = [...new Set(exposure.exposedCapabilities.map((name) => String(name).trim()).filter(Boolean))];
    if (requested.length === 0) return '';
    const valid = requested.filter((name) => canonical.includes(name));
    // Unknown/ambiguous exposure fails closed to full guidance.
    selected = valid.length === requested.length && valid.length > 0 ? valid : canonical;
  }
  if (selected.length === 0) return '';

  const capabilityList = selected.join('、');
  const botNames = [...new Set(meta.externalBotNames.map((name) => String(name).trim()).filter(Boolean))].join('、');
  const selectorNames = [...new Set(meta.recentSelectorIds.map((id) => String(id).trim()).filter(Boolean))].join('/');
  const parts: string[] = [
    '【可用工具】你可以调用 query_osu 获取真实 osu! 数据。',
    `可用查询类型：${capabilityList}。各查询的参数、约束和详细含义以 query_osu 的 tool schema 为准，不要自行扩展 capability。`,
  ];
  if (selected.includes('recent') && botNames && selectorNames) {
    parts.push(`${botNames} 是 QQ 群里的独立机器人，不是你可以调用的工具。只有最近成绩查询（capability=recent）可以填 bot 参数，且仅支持 ${selectorNames}；其他查询类型不要填 bot。`);
  }
  for (const policy of policies) {
    if (policy.scope === 'CAPABILITY_SCOPED') {
      if (policy.requiredCapabilities?.some((name) => selected.includes(name))) {
        parts.push(policy.text);
      }
    } else {
      parts.push(policy.text);
    }
  }
  return parts.join('\n');
}

/** Production entry: derives generated facts from the canonical catalogs. */
export function buildToolGuidance(exposure?: ToolGuidanceExposure): string {
  const canonicalCapabilities = AGENT_CAPABILITY_META
    .filter((entry) => entry.callable)
    .map((entry) => entry.capability);
  return buildToolGuidanceFromMetadata(
    {
      capabilities: canonicalCapabilities,
      externalBotNames: DEFAULT_BOTS.map((bot) => bot.name),
      recentSelectorIds: RECENT_BOT_SELECTOR_IDS,
    },
    exposure,
  );
}
