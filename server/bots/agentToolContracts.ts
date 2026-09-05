// Agent Runtime V2 model-facing osu! tool contracts.
//
// The production executor remains the trusted `query_osu` operation. This
// module gives the model one semantically precise function per capability and
// translates those calls back to the existing validated operation. Keeping
// exposure separate from execution lets us improve model autonomy without
// duplicating API clients, permission checks or rendering code.
import type { LlmTool, LlmToolCall, ToolResult } from './types.js';
import {
  CAPABILITY_CATALOG,
  QUERY_OSU_PARAMS,
  queryOsuParamAllowed,
  queryOsuParamJsonSchema,
  queryOsuParamRequiredFor,
  type CapabilityName,
} from './capabilityCatalog.js';

export type AgentToolSurface = 'legacy' | 'v2';

export type AgentRuntimeMode = 'legacy' | 'model_first';

export function agentRuntimeModeFor(db: any): AgentRuntimeMode {
  const envMode = String(process.env.PIPPI_AGENT_RUNTIME_MODE || '').trim().toLowerCase();
  if (envMode === 'legacy') return 'legacy';
  if (envMode === 'model_first' || envMode === 'v2') return 'model_first';
  return db?.settings?.agentRuntimeMode === 'legacy' ? 'legacy' : 'model_first';
}

/**
 * A short autonomy contract for the model-first runtime. Capability-specific
 * routing belongs in each function schema; the system prompt only states
 * cross-tool evidence, persistence and safety invariants.
 */
export function buildAgentAutonomyGuidance(options: {
  searchEnabled?: boolean;
  maxSearchCalls?: number;
} = {}): string {
  const searchLine = options.searchEnabled
    ? `网页信息可能过期或本地工具没有答案时，可调用 search_web；本轮最多 ${options.maxSearchCalls || 1} 次。`
    : '本轮没有可用的网页搜索工具，不得声称已经联网搜索。';
  return [
    '【Agent 行动约定】',
    '你可以自行决定直接回答或调用一个、多个工具。需要实时、精确、外部或玩家私有数据时先取证；普通闲聊和仅凭当前上下文即可回答的问题不要调用工具。',
    '每次收到工具结果后重新判断目标是否完成：证据不足就继续调用合适工具，工具失败可修正参数、换工具或如实说明，不要把一次调用自动当作任务结束。',
    '任何 pp、星数、acc、排名、BID、玩家成绩及谱面属性必须来自本轮工具证据；没有证据不得编造，也不得声称“已经查询”。',
    '严格按工具返回的玩家名、QQ、谱面和来源归属事实；无法确认归属时主动澄清。',
    searchLine,
    '只通过结构化 tool_calls 调用工具，回复正文不要输出 XML、DSML 或调用标记。',
  ].join('\n');
}

const V2_TOOL_REFERENCE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/query_osu\s+的\s+beatmap_lookup\s*\/\s*pp_calc\s*\/\s*leaderboard/g, 'osu_get_beatmap / osu_calculate_pp / osu_get_leaderboard'],
  [/query_osu\s+capability=recommend/g, 'osu_recommend_beatmaps'],
  [/query_osu\s+capability=pp_calc/g, 'osu_calculate_pp'],
  [/capability=recommend/g, 'osu_recommend_beatmaps'],
  [/capability=beatmap_lookup/g, 'osu_get_beatmap'],
  [/capability=leaderboard/g, 'osu_get_leaderboard'],
  [/capability=pp_calc/g, 'osu_calculate_pp'],
  [/capability=bp_type/g, 'osu_analyze_best_score_types'],
  [/capability=recent/g, 'osu_get_recent_score'],
  [/capability=bp/g, 'osu_get_best_scores'],
  [/beatmap_lookup\s*\/\s*pp_calc\s*\/\s*leaderboard/g, 'osu_get_beatmap / osu_calculate_pp / osu_get_leaderboard'],
  [/\bbeatmap_lookup\b/g, 'osu_get_beatmap'],
  [/\bleaderboard\b/g, 'osu_get_leaderboard'],
  [/\bpp_calc\b/g, 'osu_calculate_pp'],
  [/本\s*capability/g, '本工具'],
  [/query_osu\s+实时查询/g, '当前可见的实时玩家数据工具'],
  [/query_osu/g, '当前可见的对应工具'],
];

/** Rewrite historical prompt text only at the V2 request boundary. */
export function rewriteLegacyToolReferencesForV2(content: string): string {
  return V2_TOOL_REFERENCE_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    String(content || ''),
  );
}

function v2SchemaFragment(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.description !== 'string') return schema;
  return {
    ...schema,
    description: rewriteLegacyToolReferencesForV2(schema.description),
  };
}

const CAPABILITY_TOOL_NAMES: Readonly<Record<CapabilityName, string>> = {
  bp: 'osu_get_best_scores',
  bp_type: 'osu_analyze_best_score_types',
  recent: 'osu_get_recent_score',
  info: 'osu_get_player_card',
  profile: 'osu_get_player_profile',
  ppplus: 'osu_get_pp_plus',
  skill: 'osu_get_skill_radar',
  recommend: 'osu_recommend_beatmaps',
  match: 'osu_watch_match',
  beatmap_lookup: 'osu_get_beatmap',
  pp_calc: 'osu_calculate_pp',
  leaderboard: 'osu_get_leaderboard',
};

const TOOL_NAME_TO_CAPABILITY = new Map<string, CapabilityName>(
  Object.entries(CAPABILITY_TOOL_NAMES).map(([capability, toolName]) => [
    toolName,
    capability as CapabilityName,
  ]),
);

export function agentToolNameForCapability(capability: CapabilityName): string {
  return CAPABILITY_TOOL_NAMES[capability];
}

export function capabilityForAgentToolName(toolName: string): CapabilityName | undefined {
  return TOOL_NAME_TO_CAPABILITY.get(String(toolName || '').trim());
}

export function isV2OsuAgentToolName(toolName: string): boolean {
  return Boolean(capabilityForAgentToolName(toolName));
}

/**
 * Build small, action-specific schemas for the model. Only parameters valid
 * for that capability are exposed; the model no longer has to select a
 * `capability` enum inside a mega-tool or reason over unrelated parameters.
 */
export function buildV2OsuAgentToolSchemas(): LlmTool[] {
  return CAPABILITY_CATALOG
    .filter((capability) => capability.callable)
    .map((capability) => {
      const applicableParams = QUERY_OSU_PARAMS.filter(
        (param) => param.exposed && queryOsuParamAllowed(param, capability.name),
      );
      const required = applicableParams
        .filter((param) => queryOsuParamRequiredFor(param, capability.name))
        .map((param) => param.name);

      return {
        type: 'function' as const,
        function: {
          name: agentToolNameForCapability(capability.name),
          description:
            `${rewriteLegacyToolReferencesForV2(capability.description)}。只读工具；需要实时或精确数据时调用。` +
            '成功时返回带明确对象归属的真实查询结果，失败时返回可供你重试、改换工具或向用户说明的错误。',
          parameters: {
            type: 'object' as const,
            properties: Object.fromEntries(
              applicableParams.map((param) => [param.name, v2SchemaFragment(queryOsuParamJsonSchema(param))]),
            ),
            ...(required.length > 0 ? { required } : {}),
          },
        },
      };
    });
}

/** Resolve both legacy and V2 calls to their canonical osu! capability. */
export function osuCapabilityForToolCall(toolCall: LlmToolCall): CapabilityName | undefined {
  const toolName = String(toolCall.function?.name || '');
  const v2Capability = capabilityForAgentToolName(toolName);
  if (v2Capability) return v2Capability;
  if (toolName !== 'query_osu') return undefined;
  try {
    const args = JSON.parse(toolCall.function.arguments || '{}');
    const capability = String(args?.capability || '') as CapabilityName;
    return CAPABILITY_CATALOG.some((entry) => entry.name === capability)
      ? capability
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Translate a V2 model call into the existing trusted query_osu operation.
 * The call id is preserved so assistant/tool protocol pairing remains exact.
 */
export function normalizeAgentToolCall(toolCall: LlmToolCall): LlmToolCall {
  const capability = capabilityForAgentToolName(toolCall.function?.name || '');
  if (!capability) return toolCall;

  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return toolCall;
    args = parsed;
  } catch {
    // Do not turn broken arguments into a valid default capability query.
    return toolCall;
  }

  return {
    ...toolCall,
    function: {
      name: 'query_osu',
      arguments: JSON.stringify({ capability, ...args }),
    },
  };
}

export interface V2ModelToolResultOptions {
  safeContent: string;
  imageCount: number;
  directContentAttached: boolean;
  nextStepHint?: string;
}

/**
 * Produce a stable evidence envelope for the model. QQ/CQ artifacts stay in
 * the host-owned delivery fields and are never embedded into model evidence.
 */
export function buildV2ModelToolResult(
  toolCall: LlmToolCall,
  result: ToolResult,
  options: V2ModelToolResultOptions,
): string {
  const metadata = result.metadata || {};
  const selectedMetadata = Object.fromEntries(
    [
      'requestedCapability',
      'actualExecutor',
      'dataSource',
      'renderer',
      'command',
      'success',
      'terminal',
    ]
      .filter((key) => metadata[key] !== undefined)
      .map((key) => [key, metadata[key]]),
  );
  return JSON.stringify({
    schemaVersion: 1,
    status: result.ok ? 'success' : 'error',
    tool: {
      name: String(toolCall.function?.name || ''),
      capability: osuCapabilityForToolCall(toolCall) || null,
    },
    evidence: {
      text: options.safeContent,
      metadata: selectedMetadata,
    },
    delivery: {
      imageCount: Math.max(0, Number(options.imageCount) || 0),
      imagesAttachedByHost: options.imageCount > 0,
      directContentAttachedByHost: Boolean(options.directContentAttached),
    },
    error: result.error ? String(result.error).slice(0, 300) : null,
    nextStepHint: options.nextStepHint || '根据证据判断目标是否完成；不足则继续调用其他工具，足够则回答。',
  });
}
