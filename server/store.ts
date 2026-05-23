import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
const dbPath = path.join(dataDir, 'db.json');

// This is only the factory-default prompt used when data/db.json does not exist,
// or when no saved reset baseline exists. The real live prompt is stored in
// db.settings.personalityPrompt and can be changed from the GUI or /w prompt.
export const defaultPrompt = `你是 Wuxin，一个只在内部 QQ 小群里聊天的 AI 群友。
你不是客服，不是群管，也不是工作助手。
你的目标是像群友一样自然接话：简短、轻松、有分寸。
除非别人认真问问题，否则不要长篇大论。
不要每次强调自己是 AI。
不要刷屏，不要连续抢话。
如果群里大家正在快速聊天，你可以少说一点。
管理员策略必须服从：黑名单不回应，重点关注的人更优先回应。`;

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
  memberPolicy: 'owner'
};

const initialDb = {
  settings: {
    globalPaused: false,
    onlyMentionMode: false,
    llmProvider: process.env.LLM_PROVIDER || 'deepseek',
    apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    apiBaseUrl: process.env.LLM_API_BASE_URL || 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.4,
    maxTokens: 300,
    contextLimit: 30,
    ownerPrivateContextCharBudget: 24000,
    botNames: '小深,机器人,bot',
    personalityPrompt: defaultPrompt,
    oneBotHttpUrl: 'http://127.0.0.1:3000',
    oneBotWsUrl: 'ws://127.0.0.1:3001',
    oneBotAccessToken: '',
    ownerQq: '',
    selfQq: '',
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
    enableWebSearch: true,
    webSearchMode: 'balanced',
    enableAutoModel: true,
    ignoreSystemFacts: false,
    memoryEnabled: true,
    memoryMinMessages: 5,
    memoryUpdateEvery: 5,
    groupProfileAutoUpdate: true,
    groupProfileThreshold: 80,
    memoryMaxChars: 900,
    commandRoles: defaultCommandRoles,
    commandPermissions: defaultCommandPermissions
  },
  groups: [],
  users: [],
  memories: [],
  groupProfiles: [],
  relationshipProfiles: [],
  trustScores: {},
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

  db.settings = {
    ...initialDb.settings,
    ...settings,
    commandRoles: [...roleMap.values()].sort((a, b) => a.level - b.level),
    commandPermissions: {
      ...defaultCommandPermissions,
      ...(settings.commandPermissions || {})
    }
  };

  db.groups ||= [];
  db.users ||= [];
  db.memories ||= [];
  db.groupProfiles ||= [];
  db.relationshipProfiles ||= [];
  db.trustScores ||= {};
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
    fs.writeFileSync(dbPath, JSON.stringify(initialDb, null, 2), 'utf8');
  }
}

export function readDb() {
  ensureStore();
  const raw = fs.readFileSync(dbPath, 'utf8').replace(/^﻿/, '');
  return normalizeDb(JSON.parse(raw));
}

export function writeDb(db) {
  ensureStore();
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

export function updateDb(mutator) {
  const db = readDb();
  const result = mutator(db);
  writeDb(db);
  return result ?? db;
}

export function publicDb(db = readDb()) {
  return {
    ...db,
    settings: {
      ...db.settings,
      // Never send secrets back to the browser in plaintext. The GUI uses these
      // placeholders to show that a secret is present without exposing it.
      apiKey: db.settings.apiKey ? '已填写' : '',
      oneBotAccessToken: db.settings.oneBotAccessToken ? '已填写' : '',
      adminPassword: db.settings.adminPassword ? '已设置' : ''
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
