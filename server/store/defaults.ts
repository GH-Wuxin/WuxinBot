// Factory defaults, schema normalization and retention for the logical DB.
import { DEEPSEEK_BASE_URL, activateModelProfile, recoverProviderProfiles } from '../modelConfig.js';
import { DEFAULT_BOTS } from '../bots/registry.js';
import { DEFAULT_KB_SETTINGS } from '../bot/knowledgeTypes.js';
import { cacheUsageSummary, initializeOpenAIUsage, initializeUsageHistory } from '../usage.js';
import { emptySocialState, normalizeSocialState } from '../bot/social/state.js';
import { MAX_ADMIN_ACTIONS, MAX_COMMAND_LOGS, MAX_DECISIONS, MAX_MESSAGES, MAX_TOOL_LOGS, MAX_UNMET_LOGS } from './limits.js';

// This is only the factory-default prompt used when data/db.json does not exist,
// or when no saved reset baseline exists. The real live prompt is stored in
// db.settings.personalityPrompt and can be changed from the GUI or /w prompt.
export const defaultPrompt = `日常交流保持自然、简短、有分寸，像熟悉的群友，不使用客服、主持人、管家或刻意的二次元表演语气。
普通闲聊通常一到两句；对方明确要求解释、方案、总结或长文时再完整展开。
可以幽默，但不要用力搞笑、阴阳怪气、括号表演或编造关系。
不要无条件安慰、教育、总结或给建议。被指出错误时直接承认，不狡辩。
不要使用古怪敬语，也不要因为对方是管理者就谄媚；保持自然、认真和不卑不亢。`;

export const defaultCommandRoles = [
  { id: 'guest', name: '普通群员', level: 0, locked: true },
  { id: 'trusted', name: '信任成员', level: 20, locked: false },
  { id: 'admin', name: '管理员', level: 60, locked: true },
  { id: 'owner', name: '所有者', level: 100, locked: true }
];

export const defaultCommandPermissions = {
  help: 'guest',
  my: 'guest',
  ping: 'guest',
  why: 'guest',
  lv: 'guest',
  top: 'guest',
  me: 'trusted',
  nick: 'trusted',
  style: 'trusted',
  profile: 'admin',
  summarize: 'guest',
  summarizeLarge: 'admin',
  status: 'admin',
  rate: 'admin',
  cooldown: 'admin',
  mode: 'admin',
  modelShow: 'admin',
  modelSet: 'admin',
  pause: 'owner',
  sysfacts: 'admin',
  thinking: 'admin',
  promptShow: 'admin',
  promptEdit: 'admin',
  promptSavebase: 'owner',
  note: 'owner',
  groupProfileShow: 'admin',
  groupProfileEdit: 'admin',
  relationshipShow: 'admin',
  relationshipEdit: 'admin',
  preset: 'owner',
  profileRetry: 'admin',
  recalc: 'guest',
  groupAdd: 'owner',
  memberPolicy: 'owner',
  exp: 'owner',
  osuBind: 'guest',
  osuClearBind: 'guest',
  osuClearCache: 'owner',
  osuClearCooldown: 'owner',
  osuClearRecommend: 'owner',
  osuHelp: 'guest',
  skill: 'guest',
  skillFeedback: 'guest'
};

export const initialDb = {
  settings: {
    globalPaused: false,
    socialV2Enabled: false,
    tokenSavingMode: false,
    presenceEnabled: false,
    socialMaxAssessmentsPerHour: 60,
    llmProvider: process.env.LLM_PROVIDER || 'deepseek',
    apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    apiBaseUrl: process.env.LLM_API_BASE_URL || DEEPSEEK_BASE_URL,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    deepseekApiBaseUrl: DEEPSEEK_BASE_URL,
    codexExecutable: process.env.CODEX_EXECUTABLE || 'codex',
    codexModel: process.env.CODEX_MODEL || 'gpt-5.6-luna',
    codexReasoningEffort: process.env.CODEX_REASONING_EFFORT || 'low',
    codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 90000),
    codexFallbackEnabled: true,
    codexFallbackProvider: 'deepseek',
    codexFallbackModel: 'deepseek-v4-flash',
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
    visionMode: 'auto',
    visionImageTransport: 'auto',
    visionMaxImages: 3,
    visionMaxImageBytes: 6000000,
    visionImageTimeoutMs: 8000,
    visionMemoryEnabled: true,
    visionMemoryPureImagePolicy: 'important',
    temperature: 0.4,
    // '' means "no explicit cap": llm.ts resolves it to its own 420 fallback.
    // It used to default to 300 here, so any path that let this key fall back
    // to initialDb silently lowered the reply cap (observed during testing as a
    // drift 300 that had not been set by the operator).
    maxTokens: '',
    contextLimit: 30,
    ownerPrivateContextCharBudget: 24000,
    groupContextSearchEnabled: true,
    groupContextSearchPoolSize: 400,
    groupContextSearchMaxExtra: 24,
    groupContextSearchCharBudget: 12000,
        botNames: '小深,机器人,bot,pippi',
    personalityPrompt: defaultPrompt,
    personaPromptSections: {},
    personaModulePrompts: {},
    // Sticker delivery is closed by default. A gray/test rollout must opt in
    // through the protected configuration path or an explicit test override.
    stickerPolicy: {
      mode: 'off',
      allGroups: false,
      groupIds: [],
      groupCooldownSec: 600,
      userCooldownSec: 1200,
      hourlyLimit: 3,
      dailyLimit: 16,
      userDailyLimit: 4,
      duplicateStickerCooldownSec: 7200,
    },
    // 随机甩图模块。数值必须与 server/bot/randomImages.ts 的 DEFAULTS 一致 ——
    // low / standard 是模块自己的频率档位，不再引用群聊回复模式。
    randomImage: {
      enabled: true,
      standard: { base: 0.005, step: 0.0005 },
      low: { base: 0.001, step: 0.0002 },
      recentWindow: 8,
      recentDecay: 0.35,
    },
    oneBotHttpUrl: 'http://127.0.0.1:3000',
    oneBotWsUrl: 'ws://127.0.0.1:3001',
    oneBotAccessToken: '',
    ownerQq: '',
    selfQq: '',
    externalBotQqs: '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    osuSearchEnabled: false,
    pippiActivityEnabled: false,
    pippiActivityDailyTokens: 30000,
    pippiActivityMaxWakes: 3,
    pippiActivityForumIds: [2, 13],
    enableAutoModel: true,
    agentRuntimeMode: 'model_first',
    reasoningEnabled: false,
    ignoreSystemFacts: false,
    memoryEnabled: true,
    memoryMinMessages: 5,
    memoryUpdateEvery: 5,
    profileAntiRecencyV2: false,
    thinkingNoticeMode: 'slow',
    thinkingNoticeDelayMs: 3000,
    groupProfileAutoUpdate: true,
    groupProfileThreshold: 80,
    memoryMaxChars: 900,
    memorySampleRetain: 120,
    levelUpNotifyEnabled: true,
    osuClientId: process.env.OSU_CLIENT_ID || '',
    osuClientSecret: process.env.OSU_CLIENT_SECRET || '',
    pplusClientId: 0,
    pplusClientSecret: '',
    pplusBaseUrl: 'http://127.0.0.1:9001',
    commandRoles: defaultCommandRoles,
    commandPermissions: defaultCommandPermissions,
    botRegistry: undefined, // populated by normalizeDb from defaults
    kb: {
      ...DEFAULT_KB_SETTINGS,
      collections: { ...DEFAULT_KB_SETTINGS.collections },
      rollout: { ...DEFAULT_KB_SETTINGS.rollout, groupIds: [] }
    }
  },
  botRegistry: undefined,
  skillStore: { records: [], updatedAt: '' },
  groupBotConfig: {}, // { groupId: { yumu: true, kanon: true, hydrant: true, lazybot: true } }
  groups: [],
  users: [],
  memories: [],
  groupProfiles: [],
  relationshipProfiles: [],
  socialV2: emptySocialState(),
  ownerDirectives: [],
  pendingPairCounts: {},
  profileAutoAttempts: {},
  trustScores: {},
  experience: {},
  groupExperience: {},
  profileLogs: [],
  profileV3: {},
  messages: [],
  decisions: [],
  commandLogs: [],
  toolCallLogs: [],
  skillProfilerRuns: [],
  unmetCapabilities: [],
  adminActions: [],
  usageEvents: [],
  usage: {
    totalTokens: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheMeasuredPromptTokens: 0,
    cacheMeasuredRequests: 0,
    cacheMetricsStartedAt: '',
    requests: 0,
    replies: 0,
    errors: 0
  }
};

export function normalizeDb(db) {
  const settings = db.settings || {};
  // Preserve the old effective restriction as an explicit group mode. The
  // retired hidden global override must never silently reopen another group.
  const legacyMentionOnly = settings.onlyMentionMode === true;
  delete settings.onlyMentionMode;
  delete settings.pplusReferences;
  delete settings.commandPermissions?.osuAnalyze;
  delete settings.commandPermissions?.osuClearHistory;
  delete settings.personaModulePrompts?.osu_analyzer;
  for (const key of ['enableWebSearch', 'webSearchMode', 'searchProvider', 'searchBaseUrl', 'searchMaxResults', 'searchTimeoutMs']) delete settings[key];
  if (settings.commandPermissions?.search) {
    settings.commandPermissions.sysfacts ??= settings.commandPermissions.search;
    delete settings.commandPermissions.search;
  }
  delete settings.replyGateNaturalThreshold;
  delete settings.replyGateLightThreshold;
  delete settings.llmReplyGateMaxPerHour;
  delete settings.llmReplyGateNaturalThreshold;
  delete settings.llmReplyGateLightThreshold;
  // Shortcut commands are always available subject to the normal group/bot
  // controls; discard the retired extra activation switches.
  delete settings.quickRouterEnabled;
  const roleMap = new Map();
  for (const role of defaultCommandRoles) roleMap.set(role.id, { ...role });
  for (const role of settings.commandRoles || []) {
    const id = String(role.id || role.name || '').trim();
    if (!id) continue;
    roleMap.set(id, {
      id,
      name: String(role.name || id).trim() || id,
      level: Number.isFinite(Number(role.level)) ? Number(role.level) : 0,
      locked: Boolean(role.locked || defaultCommandRoles.some((item) => item.id === id && item.locked))
    });
  }

  // Global cache wipe (osu clear cache) is enforced owner-only inside
  // handleClearCache; the gate must never be configured lower than owner,
  // otherwise admins pass the gate here and get rejected later with a
  // misleading message.
  const mergedCommandPermissions = {
    ...defaultCommandPermissions,
    ...(settings.commandPermissions || {}),
    osuClearCache: 'owner'
  };

  db.settings = activateModelProfile({
    ...initialDb.settings,
    ...settings,
    commandRoles: [...roleMap.values()].sort((a, b) => a.level - b.level),
    commandPermissions: mergedCommandPermissions
  }, settings.model || initialDb.settings.model);
  db.settings = recoverProviderProfiles(db.settings, db.configSnapshots || []);

  db.groups ||= [];
  db.users ||= [];
  // Random images have their own participation switch now. Existing records
  // did not have that field, so migrate the old mode-derived behavior once in
  // memory; the next group save persists the independent values.
  for (const group of db.groups) {
    if (!group || typeof group !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(group, 'randomImageEnabled')) {
      group.randomImageEnabled = group.mode === 'natural' || group.mode === 'light';
    }
    if (!Object.prototype.hasOwnProperty.call(group, 'randomImageRate')) {
      group.randomImageRate = group.mode === 'light' ? 'low' : 'standard';
    }
    if (legacyMentionOnly && ['natural', 'light'].includes(group.mode)) group.mode = 'mention';
  }
  // Bot registry: merge saved bots with defaults (add new default bots, keep user changes)
  if (!db.settings.botRegistry) {
    db.settings.botRegistry = { bots: DEFAULT_BOTS, updatedAt: new Date().toISOString() };
  } else {
    const saved = db.settings.botRegistry || { bots: [] };
    const merged = DEFAULT_BOTS.map((def) => {
      const existing = (saved.bots || []).find((b) => b.id === def.id);
      return existing ? { ...def, ...existing, commands: existing.commands?.length ? existing.commands : def.commands } : def;
    });
    // Add any user-created bots not in defaults
    for (const b of saved.bots || []) {
      if (!merged.find((m) => m.id === b.id)) merged.push(b);
    }
    db.settings.botRegistry = { bots: merged, updatedAt: saved.updatedAt || new Date().toISOString() };
  }
  db.botRegistry = db.settings.botRegistry;
  db.skillStore ||= { records: [], updatedAt: '' };
  db.groupBotConfig ||= {};
  for (const config of Object.values(db.groupBotConfig)) {
    if (config && typeof config === 'object') delete (config as Record<string, unknown>).quick;
  }
  // Ensure all known groups have a default bot config entry
  for (const group of db.groups || []) {
    if (!db.groupBotConfig[group.groupId]) {
      db.groupBotConfig[group.groupId] = { yumu: true, kanon: true, hydrant: true, lazybot: true };
    }
  }
  db.memories ||= [];
  db.groupProfiles ||= [];
  db.relationshipProfiles ||= [];
  db.pendingPairCounts ||= {};
  db.profileAutoAttempts ||= {};
  db.trustScores ||= {};
  db.experience ||= {};
  db.groupExperience ||= {};
  db.profileLogs ||= [];
  db.profileV3 ||= {};
  normalizeSocialState(db);
  db.messages ||= [];
  db.decisions ||= [];
  db.commandLogs ||= [];
  db.toolCallLogs ||= [];
  db.skillProfilerRuns ||= [];
  if (db.skillProfilerRuns.length > 500) db.skillProfilerRuns = db.skillProfilerRuns.slice(-500);
  db.unmetCapabilities ||= [];
  db.adminActions ||= [];
  db.usageEvents ||= [];
  const storedUsage = db.usage || {};
  const needsCacheMetricsBackfill = !Object.prototype.hasOwnProperty.call(storedUsage, 'cacheMeasuredPromptTokens');
  db.usage = {
    ...initialDb.usage,
    ...storedUsage
  };
  if (needsCacheMetricsBackfill) {
    const measured = cacheUsageSummary(db.usageEvents || []);
    db.usage.cacheMeasuredPromptTokens = measured.promptTokens;
    db.usage.cacheMeasuredRequests = measured.requests;
    db.usage.cacheMetricsStartedAt = measured.startedAt;
    if (!Object.prototype.hasOwnProperty.call(storedUsage, 'cachedTokens')) {
      db.usage.cachedTokens = measured.cachedTokens;
    }
    if (!Object.prototype.hasOwnProperty.call(storedUsage, 'cacheWriteTokens')) {
      db.usage.cacheWriteTokens = measured.cacheWriteTokens;
    }
  }

  db.usage.history = initializeUsageHistory(db.usage, db.usageEvents);
  db.usage.openai = initializeOpenAIUsage(storedUsage.openai, db.usageEvents, db.settings || {}, Date.now());
  return applyRetention(db);
}

// Bounded collections keep the newest entries. This is storage policy, not a
// transaction boundary; each collection remains independently persisted.
export function applyRetention(db) {
  if ((db.messages || []).length > MAX_MESSAGES) db.messages = db.messages.slice(-MAX_MESSAGES);
  if ((db.decisions || []).length > MAX_DECISIONS) db.decisions = db.decisions.slice(-MAX_DECISIONS);
  if ((db.commandLogs || []).length > MAX_COMMAND_LOGS) db.commandLogs = db.commandLogs.slice(-MAX_COMMAND_LOGS);
  if ((db.toolCallLogs || []).length > MAX_TOOL_LOGS) db.toolCallLogs = db.toolCallLogs.slice(-MAX_TOOL_LOGS);
  if ((db.unmetCapabilities || []).length > MAX_UNMET_LOGS) db.unmetCapabilities = db.unmetCapabilities.slice(-MAX_UNMET_LOGS);
  if ((db.adminActions || []).length > MAX_ADMIN_ACTIONS) db.adminActions = db.adminActions.slice(-MAX_ADMIN_ACTIONS);
  return db;
}
