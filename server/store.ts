import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activateModelProfile, DEEPSEEK_BASE_URL, looksLikeMimoEndpoint, MIMO_BASE_URL, recoverProviderProfiles } from './modelConfig.js';
import { DEFAULT_BOTS } from './bots/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
const dbPath = path.join(dataDir, 'db.json');
const dbLockPath = path.join(dataDir, 'db.lock');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerIsAlive() {
  try {
    const pid = Number(fs.readFileSync(dbLockPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withDbLock(callback) {
  fs.mkdirSync(dataDir, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = fs.openSync(dbLockPath, 'wx');
      fs.writeFileSync(handle, String(process.pid), 'utf8');
      break;
    } catch (error) {
      const lockExists = fs.existsSync(dbLockPath);
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      if (!lockExists) {
        sleepSync(10);
        continue;
      }
      let stale = false;
      try {
        const ageMs = Date.now() - fs.statSync(dbLockPath).mtimeMs;
        stale = ageMs > 30_000 || (ageMs > 2_000 && !lockOwnerIsAlive());
      } catch {
        stale = false;
      }
      if (stale) {
        try { fs.unlinkSync(dbLockPath); } catch { /* another process may own cleanup */ }
      } else {
        sleepSync(25);
      }
    }
  }
  if (handle === undefined) throw new Error('数据库写入锁等待超时，请检查是否重复启动了多个 Wuxin 后端。');
  try {
    return callback();
  } finally {
    try { fs.closeSync(handle); } catch { /* ignore close failure */ }
    try { fs.unlinkSync(dbLockPath); } catch { /* ignore cleanup race */ }
  }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tempPath, payload, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 20) throw error;
        sleepSync(25 * (attempt + 1));
      }
    }
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

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
  usage: 'admin',
  status: 'admin',
  rate: 'admin',
  cooldown: 'admin',
  mode: 'admin',
  modelShow: 'admin',
  modelSet: 'admin',
  pause: 'admin',
  search: 'admin',
  thinking: 'admin',
  promptShow: 'admin',
  promptEdit: 'admin',
  promptSavebase: 'owner',
  note: 'owner',
  groupProfileShow: 'admin',
  groupProfileEdit: 'admin',
  relationshipShow: 'admin',
  relationshipEdit: 'admin',
  preset: 'admin',
  profileRetry: 'admin',
  recalc: 'guest',
  groupAdd: 'owner',
  memberPolicy: 'owner',
  exp: 'owner',
  osuBind: 'guest',
  osuAnalyze: 'guest',
  osuRecent: 'guest',
  osuClearCache: 'admin',
  osuHelp: 'guest'
};

const initialDb = {
  settings: {
    globalPaused: false,
    onlyMentionMode: false,
    llmProvider: process.env.LLM_PROVIDER || 'deepseek',
    apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    apiBaseUrl: process.env.LLM_API_BASE_URL || DEEPSEEK_BASE_URL,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    deepseekApiBaseUrl: DEEPSEEK_BASE_URL,
    mimoApiKey: process.env.MIMO_API_KEY || '',
    mimoApiBaseUrl: process.env.MIMO_API_BASE_URL || MIMO_BASE_URL,
    model: process.env.LLM_MODEL || (
      looksLikeMimoEndpoint(process.env.LLM_API_BASE_URL) || process.env.LLM_PROVIDER === 'openai-compatible'
        ? 'mimo-v2.5'
        : 'deepseek-v4-flash'
    ),
    visionMode: 'auto',
    visionImageTransport: 'auto',
    visionMaxImages: 3,
    visionMaxImageBytes: 6000000,
    visionImageTimeoutMs: 8000,
    visionMemoryEnabled: true,
    visionMemoryPureImagePolicy: 'important',
    temperature: 0.4,
    maxTokens: 300,
    contextLimit: 30,
    ownerPrivateContextCharBudget: 24000,
        botNames: '小深,机器人,bot,pippi',
    personalityPrompt: defaultPrompt,
    oneBotHttpUrl: 'http://127.0.0.1:3000',
    oneBotWsUrl: 'ws://127.0.0.1:3001',
    oneBotAccessToken: '',
    ownerQq: '',
    selfQq: '',
    externalBotQqs: '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    enableWebSearch: true,
    webSearchMode: 'balanced',
    searchProvider: 'disabled',
    searchBaseUrl: '',
    searchMaxResults: 5,
    searchTimeoutMs: 8000,
    enableAutoModel: true,
    llmReplyGateMaxPerHour: 0,
    llmReplyGateNaturalThreshold: 45,
    llmReplyGateLightThreshold: 70,
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
    pplusReferences: [] as (string | number)[],
    commandRoles: defaultCommandRoles,
    commandPermissions: defaultCommandPermissions,
    botRegistry: undefined // populated by normalizeDb from defaults
  },
  botRegistry: undefined,
  skillStore: { records: [], updatedAt: '' },
  groupBotConfig: {}, // { groupId: { yumu: true, kanon: true, hydrant: true, lazybot: true } }
  groups: [],
  users: [],
  memories: [],
  groupProfiles: [],
  relationshipProfiles: [],
  pendingPairCounts: {},
  trustScores: {},
  experience: {},
  groupExperience: {},
  profileLogs: [],
  profileV3: {},
  messages: [],
  decisions: [],
  commandLogs: [],
  adminActions: [],
  usageEvents: [],
  usage: {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requests: 0,
    replies: 0,
    errors: 0
  }
};

function normalizeDb(db) {
  const settings = db.settings || {};
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

  db.settings = activateModelProfile({
    ...initialDb.settings,
    ...settings,
    commandRoles: [...roleMap.values()].sort((a, b) => a.level - b.level),
    commandPermissions: {
      ...defaultCommandPermissions,
      ...(settings.commandPermissions || {})
    }
  }, settings.model || initialDb.settings.model);
  db.settings = recoverProviderProfiles(db.settings, db.configSnapshots || []);

  db.groups ||= [];
  db.users ||= [];
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
  db.trustScores ||= {};
  db.experience ||= {};
  db.groupExperience ||= {};
  db.profileLogs ||= [];
  db.profileV3 ||= {};
  db.messages ||= [];
  db.decisions ||= [];
  db.commandLogs ||= [];
  db.adminActions ||= [];
  db.usageEvents ||= [];
  db.usage = {
    ...initialDb.usage,
    ...(db.usage || {})
  };

  return db;
}

// The app uses a small JSON store instead of SQLite so the user can back up,
// inspect, and hand-edit state easily. Keep writes atomic at the object level:
// readDb -> mutate -> writeDb.
export function ensureStore() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    withDbLock(() => {
      if (!fs.existsSync(dbPath)) writeJsonAtomic(dbPath, initialDb);
    });
  }
}

function readDbUnlocked() {
  const raw = fs.readFileSync(dbPath, 'utf8').replace(/^﻿/, '');
  return normalizeDb(JSON.parse(raw));
}

export function readDb() {
  ensureStore();
  return readDbUnlocked();
}

export function writeDb(db) {
  ensureStore();
  return withDbLock(() => writeJsonAtomic(dbPath, db));
}

export function updateDb(mutator) {
  ensureStore();
  return withDbLock(() => {
    const db = readDbUnlocked();
    const result = mutator(db);
    writeJsonAtomic(dbPath, db);
    return result ?? db;
  });
}

export function publicDb(db = readDb()) {
  const now = new Date();
  const localDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const currentHourStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
  const hourlyUsage = Array.from({ length: 24 }, (_, index) => {
    const start = currentHourStart - (23 - index) * 60 * 60 * 1000;
    const date = new Date(start);
    return {
      start,
      label: `${String(date.getHours()).padStart(2, '0')}:00`,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requests: 0
    };
  });
  const dailyUsage = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - index));
    return {
      start: date.getTime(),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      requests: 0
    };
  });
  const hourlyByStart = new Map(hourlyUsage.map((bucket) => [bucket.start, bucket]));
  const dailyByStart = new Map(dailyUsage.map((bucket) => [bucket.start, bucket]));
  const todayUsage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0 };
  for (const event of db.usageEvents || []) {
    const time = new Date(event.createdAt || 0);
    const timestamp = time.getTime();
    if (!Number.isFinite(timestamp)) continue;
    const values = {
      totalTokens: Number(event.totalTokens || 0),
      promptTokens: Number(event.promptTokens || 0),
      completionTokens: Number(event.completionTokens || 0)
    };
    const add = (bucket) => {
      if (!bucket) return;
      bucket.totalTokens += values.totalTokens;
      bucket.promptTokens += values.promptTokens;
      bucket.completionTokens += values.completionTokens;
      bucket.requests += 1;
    };
    if (timestamp >= localDayStart) add(todayUsage);
    const hourStart = new Date(time.getFullYear(), time.getMonth(), time.getDate(), time.getHours()).getTime();
    const dayStart = new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
    add(hourlyByStart.get(hourStart));
    add(dailyByStart.get(dayStart));
  }
  const messages = (db.messages || []).slice(-500);
  const decisions = (db.decisions || []).slice(-300);
  const commandLogs = (db.commandLogs || []).slice(-300);
  const memories = (db.memories || []).map((memory) => ({
    ...memory,
    samples: (memory.samples || []).slice(-10).map((sample) => ({
      ...sample,
      context: sample.context
        ? { ...sample.context, nearby: (sample.context.nearby || []).slice(-2) }
        : sample.context
    }))
  }));

  return {
    settings: {
      ...db.settings,
      // Never send secrets back to the browser in plaintext. The GUI uses these
      // placeholders to show that a secret is present without exposing it.
      apiKey: db.settings.apiKey ? '已填写' : '',
      deepseekApiKey: db.settings.deepseekApiKey ? '已填写' : '',
      mimoApiKey: db.settings.mimoApiKey ? '已填写' : '',
      oneBotAccessToken: db.settings.oneBotAccessToken ? '已填写' : '',
      adminPassword: db.settings.adminPassword ? '已设置' : '',
      osuClientSecret: db.settings.osuClientSecret ? '已填写' : '',
      pplusClientSecret: db.settings.pplusClientSecret ? '已填写' : ''
    },
    groups: db.groups || [],
    users: db.users || [],
    memories,
    groupProfiles: db.groupProfiles || [],
    relationshipProfiles: db.relationshipProfiles || [],
    botRegistry: db.botRegistry || db.settings?.botRegistry || { bots: [], updatedAt: '' },
    skillStore: db.skillStore || { records: [], updatedAt: '' },
    groupBotConfig: db.groupBotConfig || {},
    pendingPairCounts: db.pendingPairCounts || {},
    trustScores: db.trustScores || {},
    experience: db.experience || {},
    groupExperience: db.groupExperience || {},
    messages,
    decisions,
    commandLogs,
    usage: db.usage || initialDb.usage,
    usageStats: {
      today: todayUsage,
      hourly24: hourlyUsage,
      daily7: dailyUsage
    },
    stateStats: {
      totalMessages: (db.messages || []).length,
      todayMessages: (db.messages || []).filter((message) => {
        const time = new Date(message.createdAt || 0).getTime();
        return Number.isFinite(time) && time >= localDayStart;
      }).length,
      returnedMessages: messages.length,
      returnedDecisions: decisions.length,
      returnedCommandLogs: commandLogs.length
    }
  };
}

export function upsertBy(list, key, item) {
  const index = list.findIndex((entry) => String(entry[key]) === String(item[key]));
  if (index >= 0) list[index] = { ...list[index], ...item, updatedAt: new Date().toISOString() };
  else list.push({ ...item, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

export function nowIso() {
  return new Date().toISOString();
}

// Config snapshots: save before each settings change, keep last 10
export function saveConfigSnapshot(db) {
  if (!db.configSnapshots) db.configSnapshots = [];
  db.configSnapshots.push({
    at: nowIso(),
    settings: JSON.parse(JSON.stringify(db.settings)),
  });
  db.configSnapshots = db.configSnapshots.slice(-10);
}

export function listConfigSnapshots(db) {
  return (db.configSnapshots || []).map((s, i) => ({ index: i, at: s.at }));
}

export function restoreConfigSnapshot(db, index) {
  const snapshots = db.configSnapshots || [];
  if (index < 0 || index >= snapshots.length) return false;
  db.settings = { ...db.settings, ...snapshots[index].settings };
  return true;
}
