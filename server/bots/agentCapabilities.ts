// Phase A — capability → agent-tool exposure metadata.
//
// This is a derived view of server/bots/capabilityCatalog.ts. The catalog is
// the SINGLE source for which query_osu capabilities the LLM may call, their
// long descriptions, aliases and parameter applicability. Nothing here may
// duplicate a capability name or description by hand.
import {
  callableCapabilityNames,
  capabilityDescription,
  capabilityNames,
  findCapability,
  type CapabilityName,
} from './capabilityCatalog.js';

export interface AgentCapabilityMeta {
  capability: string;
  callable: boolean;
  description: string;
  /**
   * Agent-callable capabilities must be readonly data queries; command-only
   * entries may be stateful (match listens/polls/pushes).
   */
  sideEffects: 'readonly' | 'stateful';
  /** Deployment rollout. owner_canary = only the owner's turns may trigger it. */
  rollout: 'all' | 'owner_canary';
}

// Meta covers EVERY catalog capability (callable and command-only) so the
// consistency audit can enforce both directions. callable/rollout/sideEffects
// are derived from the catalog; nothing is duplicated by hand.
export const AGENT_CAPABILITY_META: readonly AgentCapabilityMeta[] = capabilityNames().map(
  (name: CapabilityName) => {
    const capability = findCapability(name);
    return {
      capability: name,
      callable: Boolean(capability?.callable),
      description: capabilityDescription(name),
      sideEffects: (capability?.sideEffects || 'readonly') as 'readonly' | 'stateful',
      rollout: (capability?.rollout || 'all') as 'all' | 'owner_canary',
    };
  },
);

export function agentCapabilityMeta(capability: string): AgentCapabilityMeta | undefined {
  return AGENT_CAPABILITY_META.find((entry) => entry.capability === capability);
}

export function callableCapabilities(): string[] {
  return [...callableCapabilityNames()];
}

export function buildQueryOsuDescriptionFromMeta(meta: readonly AgentCapabilityMeta[]): string {
  const capList = meta
    .filter((entry) => entry.callable)
    .map((entry) => `${entry.capability}（${entry.description}）`)
    .join('；');
  return `查询 osu! 数据（Wuxin 内部：osu! API v2、PP+、skill store、rosu pp 估算；图片由 yumu-image 渲染）。可用查询：${capList}。玩家要求推图/推荐谱面/打什么图时使用 capability=recommend，username 可填任意 osu! 用户名（不需要提问者已绑定）。数据来自真实 API，不是你凭记忆编的。pp_calc 返回的是 rosu 估算值，引用时说明是估算。没有 capability 枚举之外的查询类型，禁止编造参数。回答中出现的任何 pp/星数/acc/排名数字都必须来自工具返回：玩家要精确计算而你还没调用对应工具时，必须先调用工具再答；工具没返回或失败时禁止报数（哪怕标注“大概”），只能说明还没算出来或服务不可用。玩家上轮说“要/好/算/帮我算”确认时，先真的调用工具计算再回复，不能只查一次成绩就说“算好了”。不要在你的回复正文里输出任何 XML/DSML/tool_calls 格式的调用文本，工具调用只通过结构化 tool_calls 执行。`;
}

export function buildQueryOsuDescription(): string {
  return buildQueryOsuDescriptionFromMeta(AGENT_CAPABILITY_META);
}

export interface CapabilityAuditViolation {
  code: string;
  message: string;
}

/** Consistency gate: meta table and executor-side catalog must agree. */
export function auditAgentCapabilityRegistry(): CapabilityAuditViolation[] {
  const violations: CapabilityAuditViolation[] = [];
  const metaNames = AGENT_CAPABILITY_META.map((entry) => entry.capability);
  const executorNames: readonly string[] = capabilityNames();

  for (const entry of AGENT_CAPABILITY_META) {
    if (!executorNames.includes(entry.capability)) {
      violations.push({ code: 'META_WITHOUT_EXECUTOR', message: `agent meta capability "${entry.capability}" has no INTERNAL_CAPABILITIES executor entry` });
    }
    if (entry.callable && entry.rollout !== 'all' && entry.rollout !== 'owner_canary') {
      violations.push({ code: 'INVALID_ROLLOUT', message: `capability "${entry.capability}" has invalid rollout "${entry.rollout}"` });
    }
    // Rollout is currently metadata/documentation, not a runtime security
    // boundary. Until enforcement exists, no LLM-callable capability may use
    // owner_canary because a model would otherwise be able to trigger it.
    if (entry.callable && entry.rollout === 'owner_canary') {
      violations.push({ code: 'OWNER_CANARY_WITHOUT_ENFORCEMENT', message: `callable capability "${entry.capability}" uses owner_canary but rollout is not runtime-enforced` });
    }
    if (entry.callable && entry.sideEffects !== 'readonly') {
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
