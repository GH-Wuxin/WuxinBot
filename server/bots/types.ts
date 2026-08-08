// Bot harness type definitions — bot registry, tool calls, skill memory, security.

// ── Bot definition ──

export interface BotCommandParam {
  name: string;
  type: 'string' | 'number';
  required: boolean;
  description: string;
}

export interface BotCommand {
  name: string;
  trigger: string;
  description: string;
  params: BotCommandParam[];
  returns: 'image' | 'text' | 'both';
}

export type BotChannel = 'qq_private' | 'qq_group' | 'internal';

export interface BotDefinition {
  id: string;
  name: string;
  description: string;
  qq: string;
  channel: BotChannel;
  groupId?: string; // for qq_group channel: which group to post commands in
  enabled: boolean;
  commands: BotCommand[];
}

export interface BotRegistry {
  bots: BotDefinition[];
  updatedAt: string;
}

// ── LLM tool definitions (OpenAI function-calling schema) ──

export interface LlmToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmTool {
  type: 'function';
  function: LlmToolFunction;
}

// ── Tool call from LLM ──

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// ── Tool execution result ──

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string;      // text to feed back to LLM
  images?: string[];    // image URLs or data URIs
  /**
   * Terminal deterministic reply. When true the caller must deliver
   * directContent (or content) verbatim and must NOT ask the LLM to write a
   * lead, comment, or evaluate the result. Only explicit terminal states set
   * this flag (currently recommendation cooldown); it is not implied by
   * directContent alone.
   */
  final?: boolean;
  /**
   * Trusted, structured text that must reach QQ verbatim. The LLM may inspect
   * it to write a short lead, but it is never responsible for reproducing it.
   */
  directContent?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

// ── Bot invocation request ──

export interface BotInvocation {
  botId: string;
  command: string;
  args: Record<string, string>;
  requestedBy: string;   // QQ of the player who asked
  correlationId: string; // for matching async responses
}

// ── Bot response (received via QQ) ──

export interface BotResponse {
  correlationId: string;
  botId: string;
  ok: boolean;
  text: string;
  images: string[];     // CQ image URLs
  rawMessageId: string;
  error?: string;
}

// ── Player skill memory ──

export interface PlayerSkillRecord {
  /** Stable identity for one osu! account in one ruleset. Legacy records may omit it. */
  recordKey?: string;
  /** Bound QQ when known. Empty means the osu! account has no known QQ binding. */
  userId: string;
  osuUsername: string;
  osuUserId: number;
  mode: string;
  pp: number;
  rank: number;
  countryRank?: number;
  accuracy: number;
  playCount: number;
  hoursPlayed: number;
  level: number;
  ppPlus?: Record<string, number>;
  /** BP Mod-combination counts, for example { HDHR: 41, HD: 55 }. */
  modComposition?: Record<string, number>;
  topMods?: string[];
  gradeCounts?: Record<string, number>;
  ppSpread?: { rank?: number; count?: number }[];
  summary: string;
  recentSummary?: string;
  lastRecentAnalyzed?: string;
  lastAnalyzed: string;
  version: number;
}

export interface SkillStore {
  records: PlayerSkillRecord[];
  updatedAt: string;
}

// ── Security ──

export type AllowedOperationType =
  | 'query_osu'
  | 'query_external_bot'
  | 'query_bot'
  | 'get_player_skill'
  | 'list_bots'
  | 'get_recent_score';

export interface AllowedOperation {
  type: AllowedOperationType;
  params: Record<string, unknown>;
}

// ── Tool call context (passed to executor) ──

export interface ToolCallContext {
  db: unknown; // Db type — avoid circular import
  event: unknown; // BotEvent type
  sendMessage?: (event: unknown, text: string, extra?: unknown) => Promise<unknown>;
  userId: string;
  groupId?: string;
  pendingResponses: Map<string, BotResponse>;
}
