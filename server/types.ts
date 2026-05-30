// Core type definitions for the QQ AI ChatBot project.
// These describe the shapes that flow through processIncoming(),
// the database, and the LLM layer. Not exhaustive — only covers
// the high-traffic structures that have caused bugs when mis-assumed.

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
  botNames: string;
  personalityPrompt: string;
  baselinePersonalityPrompt?: string;
  oneBotHttpUrl: string;
  oneBotWsUrl: string;
  oneBotAccessToken: string;
  ownerQq: string;
  selfQq: string;
  adminPassword: string;
  enableWebSearch: boolean;
  webSearchMode: 'fast' | 'balanced' | 'deep';
  enableAutoModel: boolean;
  ignoreSystemFacts: boolean;
  memoryEnabled: boolean;
  memoryMinMessages: number;
  memoryUpdateEvery: number;
  memoryMaxChars: number;
  memorySampleRetain?: number;
  commandRoles: CommandRole[];
  commandPermissions: Record<string, string>;
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
  mode: 'silent' | 'mention' | 'light' | 'natural';
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

export type LlmProvider = 'deepseek' | 'openai-compatible';

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
