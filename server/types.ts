// Core type definitions for the QQ AI ChatBot project.
// These describe the shapes that flow through processIncoming(),
// the database, and the LLM layer. Not exhaustive — only covers
// the high-traffic structures that have caused bugs when mis-assumed.
import type { KnowledgeBaseSettings } from './bot/knowledgeTypes.js';

// ── Incoming event (produced by oneBotToInternal) ──

export interface BotEvent {
  source: 'onebot' | 'gui';
  type: 'group' | 'private';
  messageId: string;
  groupId: string;
  userId: string;
  nickname: string;
  text: string;            // normalized by cleaning.ts
  atTargets: string[];
  images?: { type: 'image'; url?: string; file?: string }[];
  replyMessageId?: string;
  quotedMessage?: {
    messageId: string;
    text: string;
    images: { type: 'image'; url?: string; file?: string }[];
    userId?: string;
    nickname?: string;
  };
  senderRole?: 'owner' | 'admin' | 'member';
  raw?: Record<string, unknown>;
}

// ── Reply decision ──

export interface ReplyDecision {
  shouldReply: boolean;
  reason: string;
  inContext?: boolean;
  visualLimitation?: boolean;
}

// ── Database (data/db.json shape) ──

export interface DbSettings {
  globalPaused: boolean;
  onlyMentionMode: boolean;
  apiKey: string;
  apiBaseUrl: string;
  deepseekApiKey?: string;
  deepseekApiBaseUrl?: string;
  mimoApiKey?: string;
  mimoApiBaseUrl?: string;
  codexExecutable?: string;
  codexModel?: string;
  codexReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  codexTimeoutMs?: number;
  codexFallbackEnabled?: boolean;
  codexFallbackProvider?: 'deepseek' | 'openai-compatible';
  codexFallbackModel?: string;
  model: string;
  visionMode?: 'auto' | 'on' | 'off';
  visionImageTransport?: 'auto' | 'url' | 'data';
  visionMaxImages?: number;
  visionMaxImageBytes?: number;
  visionImageTimeoutMs?: number;
  visionMemoryEnabled?: boolean;
  visionMemoryPureImagePolicy?: 'off' | 'important' | 'all';
  temperature: number;
  maxTokens: number;
  contextLimit: number;
  ownerPrivateContextCharBudget: number;
  groupContextSearchEnabled?: boolean;
  groupContextSearchPoolSize?: number;
  groupContextSearchMaxExtra?: number;
  groupContextSearchCharBudget?: number;
  botNames: string;
  personalityPrompt: string;
  baselinePersonalityPrompt?: string;
  oneBotHttpUrl: string;
  oneBotWsUrl: string;
  oneBotAccessToken: string;
  ownerQq: string;
  selfQq: string;
  externalBotQqs?: string;
  adminPassword: string;
  enableWebSearch: boolean;
  webSearchMode: 'fast' | 'balanced' | 'deep';
  enableAutoModel: boolean;
  /** Agent Runtime V2 is default; set legacy or env PIPPI_AGENT_RUNTIME_MODE=legacy for rollback. */
  agentRuntimeMode?: 'legacy' | 'model_first';
  /** Phase 2 v1 master switch; env REASONING_ENABLED=false|0 is a hard veto. */
  reasoningEnabled: boolean;
  llmReplyGateMaxPerHour?: number;
  llmReplyGateNaturalThreshold?: number;
  llmReplyGateLightThreshold?: number;
  ignoreSystemFacts: boolean;
  memoryEnabled: boolean;
  memoryMinMessages: number;
  memoryUpdateEvery: number;
  memoryMaxChars: number;
  memorySampleRetain?: number;
  commandRoles: CommandRole[];
  commandPermissions: Record<string, string>;
  kb?: KnowledgeBaseSettings;
  [key: string]: unknown;   // permits customModel and future fields
}

export interface CommandRole {
  id: string;
  name: string;
  level: number;
  locked: boolean;
}

export interface Group {
  groupId: string;
  name: string;
  enabled: boolean;
  mode: 'silent' | 'mention' | 'light' | 'natural' | 'osu';
  maxPerHour: number;
  cooldownSec: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserEntry {
  id?: string;
  groupId: string;
  userId: string;
  nickname: string;
  policy: 'normal' | 'whitelist' | 'priority' | 'muted' | 'blocked' | 'admin';
  attentionLevel: number;
  allowCommands: boolean;
  commandRoleId?: string;
  note?: string;
  customPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemoryEntry {
  id: string;
  userId: string;
  nickname: string;
  enabled: boolean;
  importanceLevel: number;
  importanceLabel: string;
  messageCount: number;
  profileMessageCount: number;
  pendingCount: number;
  groupsSeen: string[];
  samples: MemorySample[];
  summary: string;
  traits: string;
  speechStyle: string;
  behavior: string;
  preferences: string;
  manualNotes: string;
  profilingRule: string;
  profileMeta: Record<string, { confidence: number; evidenceCount: number; updatedAt: string }>;
  recentDynamics: { topic: string; summary: string; evidenceCount: number; firstSeenAt: string; lastSeenAt: string; groups: string[]; confidence: number }[];
  lastProfileAttemptAt?: string;
  lastProfileStatus?: 'updated' | 'checked' | 'recent-only' | 'empty' | 'error';
  lastProfileError?: string;
  lastProfiledAt?: string;
  profileFailureCount?: number;
  profileRetryAfter?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySample {
  content: string;
  type: 'text' | 'card' | 'media' | 'image-summary' | 'command' | 'bot-output';
  media?: { images?: { type: 'image'; url?: string; file?: string }[] };
  usedForProfile: boolean;
  riskLevel: 'normal' | 'low-confidence' | 'high-risk';
  reason: string;
  createdAt: string;
  historical?: boolean;
  context?: {
    groupId: string;
    messageId: string;
    mentionedBot: boolean;
    atTargets: string[];
    speakerName: string;
    nearby: { role: string; userId: string; nickname: string; content: string; createdAt: string }[];
  };
  contextAnalysis?: {
    subject: 'self' | 'other' | 'bot' | 'topic' | 'unclear';
    addressee: 'bot' | 'owner' | 'group' | 'user' | 'unclear';
    observationType: 'preference' | 'speechStyle' | 'behavior' | 'temporaryMood' | 'oneOffQuestion' | 'banter' | 'quote' | 'relation' | 'highRisk' | 'unclear';
    profileUse: 'normal' | 'low-confidence' | 'high-risk' | 'no';
    reason: string;
    confidence: number;
  };
}

export interface MessageRecord {
  id: string;
  requestId?: string;
  sourceMessageId?: string;
  replyToMessageId?: string;
  replyToUserId?: string;
  replyToNickname?: string;
  role: 'user' | 'assistant';
  type: 'group' | 'private';
  groupId: string;
  userId: string;
  nickname: string;
  content: string;
  media?: { images?: { type: 'image'; url?: string; file?: string }[] };
  inContext: boolean;
  createdAt: string;
}

export interface DecisionRecord {
  id: string;
  requestId?: string;
  messageId: string;
  groupId: string;
  userId: string;
  shouldReply: boolean;
  reason: string;
  createdAt: string;
}

export interface CommandLogEntry {
  id: string;
  messageId: string;
  type: string;
  groupId: string;
  userId: string;
  nickname: string;
  command: string;
  subCommand: string;
  rawText: string;
  isWuxinCommand: boolean;
  userRoleId: string;
  userPolicy: string;
  status: 'ok' | 'denied' | 'error' | 'ignored' | 'invalid';
  reason: string;
  errorMessage?: string;
  errorName?: string;
  errorStack?: string;
  latencyMs?: number;
  createdAt: string;
}

export interface ToolCallLogEntry {
  id: string;
  createdAt: string;
  groupId: string;
  userId: string;
  nickname: string;
  messageId: string;
  toolCallId: string;
  capability: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string;
  contentLength: number;
  latencyMs: number;
}

export interface SkillProfilerRunEntry {
  id: string;
  beatmapId: number;
  groupId: string;
  userId: string;
  sourceMessageId: string;
  sourceLabel: string;
  analysis: Record<string, unknown>;
  createdAt: string;
}

export interface UsageEvent {
  id: string;
  groupId: string;
  userId: string;
  model: string;
  kind?: string;           // 'memory' for memory-update calls
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
}

export interface GroupProfile {
  groupId: string;
  enabled: boolean;
  atmosphere: string;
  topics: string;
  humorStyle: string;
  pace: string;
  boundaries: string;
  botStrategy: string;
  confidence: number;
  evidenceCount: number;
  pendingMessageCount: number;
  lastAutoUpdateAt: string;
  lastUpdateStatus?: 'success' | 'running' | 'failed';
  lastUpdateError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Db {
  settings: DbSettings;
  groups: Group[];
  users: UserEntry[];
  memories: MemoryEntry[];
  groupProfiles: GroupProfile[];
  relationshipProfiles: Record<string, unknown>[];
  pendingPairCounts: Record<string, number>;
  trustScores: Record<string, unknown>;
  messages: MessageRecord[];
  decisions: DecisionRecord[];
  commandLogs: CommandLogEntry[];
  toolCallLogs: ToolCallLogEntry[];
  adminActions: Record<string, unknown>[];
  usageEvents: UsageEvent[];
  usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    requests: number;
    replies: number;
    errors: number;
  };
  [key: string]: unknown;
}

// ── LLM layer ──

export type LlmProvider = 'deepseek' | 'openai-compatible' | 'codex-app-server';

export interface LlmCompletionOptions {
  overrideModel?: string | null;
  maxTokens?: number | null;
  timeoutMs?: number;
  searchMode?: string | null;
}

export interface LlmUsage {
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
}

// ── OneBot connection ──

export interface OneBotStatus {
  connected: boolean;
  lastError: string;
  lastEventAt: string;
}
