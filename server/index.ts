import { queryLogEntries } from './logRecords.js';
import { ownMessageArchiveStatus, startOwnMessageArchive, stopOwnMessageArchive } from './messageFacts.js';
import { clearOwnArchive } from './messageArchiveStorage.js';
import { getDataDir } from './store.js';
import 'dotenv/config';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { limitedText, ok } from './api/helpers.js';
import { openStore, currentStorageRevision, getStoreLockStats, getStoreWriteStats, publicDb, publicMemory, readDb, updateDb, upsertBy, nowIso, saveConfigSnapshot, listConfigSnapshots, restoreConfigSnapshot } from './store.js';
import { backupRetention, createBackup, listBackups, restoreBackup, deleteBackup, pruneAutoBackups, pruneBackups } from './backup.js';
import { connectOneBot, getOneBotStatus, handleOneBotEvent, sendOneBotMessage, shutdownOneBot } from './onebot.js';
import { processIncoming } from './bot.js';
import { mountSocialApi } from './bot/social/api.js';
import { startPippiActivity, stopPippiActivity } from './bot/activity.js';
import { startSocialReflections, stopSocialReflections, getSocialReflectionQueueStats } from './bot/social/reflection.js';
import { participationStatus } from './bot/social/policy.js';
import { runSandboxPreview } from './sandboxPreview.js';
import { getReplyQueueStats } from './bot/queue.js';
import { abortReplyProcess, listReplyProcesses } from './bot/replyProcesses.js';
import { getHealth, getRecalcProgress, startRecalc, tickRecalc, stopRecalc, finishRecalc, setBotPaused } from './health.js';
import { getBackgroundTaskStats, runBackgroundTask, waitForBackgroundTasks } from './backgroundTasks.js';
import { getInboundAdmissionStats, stopInboundAdmission, waitForInboundTasks } from './bot/inboundGate.js';
import { getLlmAdmissionStats } from './llmPolicy.js';
import { getKbHealth } from './bot/knowledgeBase.js';
import { presenceSnapshot } from './bot/presence.js';
import { buildPippiOverview } from './bot/pippiOverview.js';
import { recoverInterruptedCommandLogs } from './bot/commands.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, isSubstantiveRelationshipProfile } from './bot/relationshipProfile.js';
import { getMemoryProfileQueueStatus, maybeUpdateMemoryProfile } from './bot/memory.js';
import { evaluateTrustScores } from './bot/trust.js';
import { decayInactiveUsers } from './bot/experience.js';
import { queryProfileLogs, getProfileLogStats } from './bot/profileLog.js';
import { updateProviderSettings } from './modelConfig.js';
import { startRenderServer, stopRenderServer } from './bots/renderServer.js';
import { sharedGroupBotConfigPath } from './bots/externalPaths.js';
import { acquireInstanceLock } from './instanceLock.js';
import { listRequestTraces, subscribeRequestTraces } from './requestTrace.js';
import { validateStickerCatalog } from './bot/stickers/index.js';
import { mountStickerRoutes } from './api/stickerRoutes.js';
import { mountOsuRoutes } from './api/osuRoutes.js';
import { getPippiPromptSectionCatalog } from './bot/persona.js';
import { getPersonaStudioCatalog, listPromptCalls } from './promptStudio.js';
import {
  getCodexAccountStatus,
  getCodexRateLimits,
  listCodexModels,
  logoutCodexAccount,
  shutdownCodexAppServer,
  startCodexChatGptLogin,
} from './codexAppServer.js';

const port = Number(process.env.PORT || 8787);
let releaseInstanceLock = () => {};
let httpServer: any = null;
let shutdownPromise: Promise<void> | null = null;
let shutdownExitScheduled = false;
let crashCleanupPromise: Promise<void> | null = null;
let crashExitScheduled = false;

function releaseServerInstanceLock() {
  try { releaseInstanceLock(); } catch { /* best-effort process cleanup */ }
}

// ── Process guards (P0-A) ──
// These exist to leave a stack + exit reason behind, NOT to swallow errors
// and keep running. uncaughtException / unhandledRejection still terminate
// the process. Before exiting they run the same bounded resource cleanup as a
// normal shutdown, but always retain a hard exit deadline.
function writeCrashLog(kind, error) {
  try {
    const dir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const filename = path.join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    const stack = error?.stack || String(error);
    fs.writeFileSync(filename, `[${kind}] ${new Date().toISOString()}\n${stack}\n`, 'utf8');
    console.error(`[crash] ${kind} logged to ${filename}`);
  } catch (writeError) {
    console.error('[crash] failed to write crash log:', String(writeError?.message || writeError));
  }
}

process.on('uncaughtException', (error) => {
  handleFatalProcessError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  handleFatalProcessError('unhandledRejection', error);
});

function closeHttpServer(): Promise<void> {
  const current = httpServer;
  httpServer = null;
  if (!current) return Promise.resolve();
  try { current.closeAllConnections?.(); } catch { /* best effort */ }
  return new Promise((resolve) => {
    try { current.close(() => resolve()); } catch { resolve(); }
  });
}

async function stopMatchManager(): Promise<void> {
  const { shutdownMatchManager } = await import('./osu/match.js');
  await shutdownMatchManager();
}

function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function emergencyShutdown(): Promise<void> {
  if (crashCleanupPromise) return crashCleanupPromise;
  crashCleanupPromise = (async () => {
    stopInboundAdmission();
    stopPippiActivity();
    stopSocialReflections();
    stopOwnMessageArchive();
    try { shutdownOneBot(); } catch (error) {
      console.error('[crash] shutdownOneBot failed:', String(error?.message || error));
    }
    try { shutdownCodexAppServer(); } catch (error) {
      console.error('[crash] shutdownCodexAppServer failed:', String(error?.message || error));
    }
    try {
      await Promise.race([stopMatchManager(), boundedDelay(500)]);
    } catch (error) {
      console.error('[crash] shutdownMatchManager failed:', String(error?.message || error));
    }
    try {
      await Promise.race([closeHttpServer(), boundedDelay(500)]);
    } catch (error) {
      console.error('[crash] closeHttpServer failed:', String(error?.message || error));
    }
    try {
      const renderStop = stopRenderServer().catch((error) => {
        console.error('[crash] stopRenderServer failed:', String(error?.message || error));
      });
      await Promise.race([renderStop, boundedDelay(500)]);
    } catch (error) {
      console.error('[crash] render cleanup failed:', String(error?.message || error));
    }
    try { await waitForInboundTasks(500); } catch { /* process is already failing */ }
    try { await waitForBackgroundTasks(500); } catch { /* process is already failing */ }
    releaseServerInstanceLock();
  })();
  return crashCleanupPromise;
}

function handleFatalProcessError(kind: string, error: any): void {
  console.error(`[crash] ${kind}:`, error);
  writeCrashLog(kind, error);
  if (crashExitScheduled) return;
  crashExitScheduled = true;

  // A broken process must never remain alive indefinitely because cleanup got
  // stuck on a socket or renderer. The timer is intentionally referenced.
  const hardExit = setTimeout(() => process.exit(1), 2_000);
  void emergencyShutdown()
    .catch((cleanupError) => {
      console.error('[crash] emergency cleanup failed:', String(cleanupError?.message || cleanupError));
    })
    .finally(() => {
      clearTimeout(hardExit);
      process.exit(1);
    });
}

async function gracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[shutdown] ${signal} received, stopping ingress and draining background work`);
    stopInboundAdmission();
    stopPippiActivity();
    stopSocialReflections();
    try {
      // Stop new QQ events/reconnects before closing the local HTTP and render
      // endpoints. The instance lock stays held until all bounded cleanup is
      // finished, so a replacement process cannot overlap this one.
      shutdownOneBot();
    } catch (error) {
      console.error('[shutdown] shutdownOneBot failed:', String(error?.message || error));
    }
    try { shutdownCodexAppServer(); } catch (error) {
      console.error('[shutdown] shutdownCodexAppServer failed:', String(error?.message || error));
    }

    try {
      await Promise.race([stopMatchManager(), boundedDelay(500)]);
    } catch (error) {
      console.error('[shutdown] shutdownMatchManager failed:', String(error?.message || error));
    }

    await Promise.race([closeHttpServer(), boundedDelay(500)]);
    const renderStop = stopRenderServer().catch((error) => {
      console.error('[shutdown] stopRenderServer failed:', String(error?.message || error));
    });
    await Promise.race([renderStop, boundedDelay(500)]);

    const inbound = await waitForInboundTasks(1_200);
    if (!inbound.drained) {
      console.warn(`[shutdown] ${inbound.active} inbound task(s) did not finish before timeout`);
    }
    const drained = await waitForBackgroundTasks(1_200);
    if (!drained.drained) {
      console.warn(`[shutdown] ${drained.active} background task(s) did not finish before timeout`);
    }
    releaseServerInstanceLock();
  })();

  try {
    await shutdownPromise;
  } finally {
    // The bounded cleanup above is intentionally followed by a short grace
    // period for socket close callbacks; it must never hold the desktop open.
    if (!shutdownExitScheduled) {
      shutdownExitScheduled = true;
      setTimeout(() => process.exit(0), 200).unref?.();
    }
  }
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('exit', releaseServerInstanceLock);

// Node 20.11.1 crashes with ERR_INTERNAL_ASSERTION in internalConnectMultiple
// when many outbound sockets race IPv4/IPv6 auto-selection (happy eyeballs).
// Disable the parallel family selection so concurrent API calls are safe.
try {
  (net as any).setDefaultAutoSelectFamily?.(false);
} catch {
  // Older/other runtimes simply keep the default.
}

// A duplicate instance is an expected operator situation (a leftover server, a
// second desktop start, a stale lock). Refuse it with one clear line and a
// non-zero exit instead of letting it reach the crash log as an
// uncaughtException, which buried the real cause under a source-mapped stack.
try {
  releaseInstanceLock = acquireInstanceLock(port);
} catch (error) {
  console.error('[instance] 启动失败：', String((error as Error)?.message || error));
  process.exit(1);
}
// Fail closed: if storage cannot be opened or recovered, no business starts.
// Damage must never be answered by silently creating an empty database.
try {
  openStore();
  recoverInterruptedCommandLogs();
  // Restore the persisted pause state before OneBot can deliver new events.
  // This keeps the health snapshot and admission behavior consistent across
  // restarts while the operator is investigating a production incident.
  setBotPaused(Boolean(readDb().settings.globalPaused));
} catch (error) {
  console.error('[store] 启动失败：存储无法打开，服务未启动。', String((error as Error)?.message || error));
  process.exit(1);
}

// The sticker selector has one strict data boundary. If the generated asset
// list and the manually audited visual annotations diverge, stop here with a
// precise report instead of letting the model operate on partial metadata.
try {
  const stickerCatalog = validateStickerCatalog();
  if (!stickerCatalog.ok) {
    console.error('[stickers] 启动失败：清单与视觉标注不一致。', JSON.stringify(stickerCatalog));
    process.exit(1);
  }
} catch (error) {
  console.error('[stickers] 启动失败：清单或视觉标注无法读取。', String((error as Error)?.message || error));
  process.exit(1);
}

// Authentication is consulted on every API request. Keep this one scalar in
// memory instead of synchronously parsing the entire (currently ~34 MB) JSON
// store for health/state polling. Mutating restore/settings routes refresh it.
let cachedAdminPassword = String(readDb().settings.adminPassword || '');
function refreshCachedAdminPassword(db = readDb()) {
  cachedAdminPassword = String(db?.settings?.adminPassword || '');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GROUP_MODES = new Set(['silent', 'mention', 'light', 'natural', 'osu']);
const USER_POLICIES = new Set(['normal', 'whitelist', 'priority', 'muted', 'blocked', 'admin', 'owner']);

function safeSecretEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The GUI remains open when no password is configured. Once ADMIN_PASSWORD or
// the GUI password field is set, every API call must authenticate.
app.use('/api', (req, res, next) => {
  const expected = cachedAdminPassword;
  if (!expected) return next();
  const supplied = req.get('x-wuxin-admin-password') || '';
  if (!safeSecretEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: '需要正确的管理密码' });
  }
  next();
});

function identifier(value, label, res) {
  const result = String(value || '').trim();
  if (!SAFE_ID.test(result) || UNSAFE_OBJECT_KEYS.has(result)) {
    res.status(400).json({ ok: false, error: `${label} 必须为 1-64 位字母、数字、下划线或连字符` });
    return null;
  }
  return result;
}

function rangedInteger(value, fallback, min, max, label, res) {
  const result = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    res.status(400).json({ ok: false, error: `${label} 必须是 ${min}-${max} 之间的整数` });
    return null;
  }
  return result;
}

// Express is only the local GUI/API layer. QQ events enter through OneBot's
// WebSocket in onebot.ts; /api/onebot/event exists for manual testing or
// alternative webhook setups.

// Mutations should not echo the entire database back to the browser. The
// console can refresh through /api/state, while memory samples are loaded only
// by the memory detail endpoint. Keeping this response contract compact also
// prevents a settings save or context cleanup from blocking the UI on a
// multi-megabyte JSON parse.
function publicStateRevision() {
  // Time-window statistics must roll forward even when the database is idle.
  return `${currentStorageRevision()}:${Math.floor(Date.now() / 60_000)}`;
}

function compactDbResponse(db = readDb()) {
  const exposed = publicDb(db, { includeMemorySamples: false });
  exposed.groups = exposed.groups.map((group) => ({ ...group, participation: participationStatus(db, group) }));
  return {
    revision: publicStateRevision(),
    db: exposed,
  };
}

mountSocialApi(app);

app.get('/api/presence', (_req, res) => {
  res.json(ok(presenceSnapshot(readDb())));
});

app.get('/api/pippi/overview', (req, res) => {
  res.json(ok(buildPippiOverview(readDb(), {
    groupId: String(req.query.groupId || ''),
    userId: String(req.query.userId || ''),
  })));
});

app.get('/api/state', (_req, res) => {
  // Samples are only needed after opening a specific memory in the console.
  // Keeping them out of the global heartbeat avoids sending megabytes every
  // ten seconds to every open console tab.
  res.json(ok({ ...compactDbResponse(), oneBot: getOneBotStatus() }));
});

app.get('/api/state/revision', (_req, res) => {
  res.json(ok({ revision: publicStateRevision() }));
});

app.get('/api/codex/status', async (_req, res) => {
  const status = await getCodexAccountStatus(readDb().settings);
  res.json(ok({ status }));
});

// 模型列表从上游拿：Codex 走它自己的账号接口，其余走 OpenAI 兼容的 /models。
// 前端不再维护硬编码的模型清单 —— 上游加模型、下架模型都自动反映。
app.get('/api/models', async (req, res) => {
  const db = readDb();
  const provider = String(req.query.provider || db.settings.llmProvider || 'deepseek');
  const overrideBase = String(req.query.apiBaseUrl || '').trim();
  try {
    if (provider === 'codex-app-server') {
      const models = await listCodexModels(db.settings);
      return res.json(ok({
        provider,
        models: (models || []).map((model) => ({
          id: String(model.model || model.id || ''),
          label: String(model.displayName || model.model || model.id || ''),
        })).filter((model) => model.id),
      }));
    }
    const base = (overrideBase || String(db.settings.apiBaseUrl || '')
      || (provider === 'deepseek' ? 'https://api.deepseek.com' : '')).replace(/\/$/, '');
    if (!base) return res.json(ok({ provider, models: [], error: '没有可用的接口地址' }));
    const key = provider === 'deepseek'
      ? String(db.settings.deepseekApiKey || db.settings.apiKey || '')
      : String(db.settings.apiKey || '');
    const response = await fetch(base + '/models', {
      headers: key ? { authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return res.json(ok({ provider, models: [], error: '上游返回 ' + response.status }));
    const data = await response.json();
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    res.json(ok({
      provider,
      models: list.map((item) => ({
        id: String(item.id || item.model || ''),
        label: String(item.displayName || item.id || item.model || ''),
      })).filter((model) => model.id),
    }));
  } catch (error) {
    res.json(ok({ provider, models: [], error: (error && error.message) || String(error) }));
  }
});

app.get('/api/codex/models', async (_req, res) => {
  try {
    res.json(ok({ models: await listCodexModels(readDb().settings) }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `Codex 模型列表读取失败：${String(error?.message || error).slice(0, 300)}` });
  }
});

app.get('/api/codex/rate-limits', async (_req, res) => {
  try {
    res.json(ok({ limits: await getCodexRateLimits(readDb().settings) }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `Codex 额度读取失败：${String(error?.message || error).slice(0, 300)}` });
  }
});

app.post('/api/codex/login', async (_req, res) => {
  try {
    const login = await startCodexChatGptLogin(readDb().settings);
    res.json(ok({ login }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `ChatGPT 登录启动失败：${String(error?.message || error).slice(0, 300)}` });
  }
});

app.post('/api/codex/logout', async (_req, res) => {
  try {
    res.json(ok({ status: await logoutCodexAccount(readDb().settings) }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `ChatGPT 退出登录失败：${String(error?.message || error).slice(0, 300)}` });
  }
});

app.get('/api/logs', (req, res) => {
  try { res.json(ok(queryLogEntries(readDb(), listRequestTraces(160), req.query))); }
  catch (error) { res.status(400).json({ ok:false, error:String(error.message || error) }); }
});

app.get('/api/request-traces', (req, res) => {
  res.json(ok({ traces: listRequestTraces(Number(req.query.limit || 80)) }));
});

mountStickerRoutes(app);


app.get('/api/persona/studio', (_req, res) => {
  const settings = readDb().settings;
  res.json(ok({
    modules: getPersonaStudioCatalog(settings),
    sections: getPippiPromptSectionCatalog(settings.personaPromptSections || {}),
  }));
});

app.get('/api/persona/prompt-calls', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(ok({ promptCalls: listPromptCalls(Number(req.query.limit || 24)) }));
});

app.get('/api/request-traces/stream', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (payload) => {
    try {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // Connection cleanup below handles disconnected console clients.
    }
  };
  const sendBatch = (payloads) => {
    if (!payloads.length || res.writableEnded) return;
    try {
      res.write(payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(''));
    } catch {
      // Connection cleanup below handles disconnected console clients.
    }
  };
  send({ type: 'snapshot', traces: listRequestTraces(Number(req.query.limit || 80)) });
  const pendingTraces = new Map();
  let traceFlushTimer = null;
  const flushTraces = () => {
    traceFlushTimer = null;
    if (!pendingTraces.size) return;
    const payloads = [...pendingTraces.values()].map((trace) => ({ type: 'upsert', trace }));
    pendingTraces.clear();
    sendBatch(payloads);
  };
  const unsubscribe = subscribeRequestTraces((trace) => {
    const traceId = String((trace as any)?.id || '');
    if (!traceId) return;
    pendingTraces.set(traceId, trace);
    if (!traceFlushTimer) traceFlushTimer = setTimeout(flushTraces, 100);
  });
  if (!unsubscribe) {
    send({ type: 'error', error: 'trace_stream_capacity' });
    res.end();
    return;
  }
  const heartbeat = setInterval(() => {
    try { if (!res.writableEnded) res.write(': heartbeat\n\n'); } catch { /* close handler cleans up */ }
  }, 15_000);
  heartbeat.unref?.();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    if (traceFlushTimer) clearTimeout(traceFlushTimer);
    pendingTraces.clear();
    unsubscribe();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
});

// KB v4.1 status — admin-only via the global /api password guard. Exposes
// collection status/doc counts/content SHA/build time/error codes only.
// Never exposes raw query text, community content, absolute paths or stacks.
app.get('/api/kb/status', (_req, res) => {
  res.json(ok({ kb: getKbHealth() }));
});

// ── Group bot config ──

app.get('/api/group-bot-config', (_req, res) => {
  const db = readDb();
  res.json(ok({ config: db.groupBotConfig || {}, groups: db.groups.map(g => ({ groupId: g.groupId, name: g.name })) }));
});

type SharedBotConfig = Record<string, Record<string, boolean>>;

function readSharedBotConfig(): { config: SharedBotConfig; exists: boolean } {
  const filePath = sharedGroupBotConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { config: {}, exists: false };
    throw new Error(`共享配置读取失败：${String(error?.message || error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`共享配置 JSON 损坏，已拒绝覆盖：${String((error as Error)?.message || error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('共享配置必须是群 ID 到配置对象的映射');
  }
  for (const [groupId, value] of Object.entries(parsed)) {
    if (UNSAFE_OBJECT_KEYS.has(groupId)) {
      throw new Error(`共享配置包含不允许的群键: ${groupId}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`群 ${groupId} 的共享配置不是对象`);
    }
  }
  return { config: parsed as SharedBotConfig, exists: true };
}

function writeSharedBotConfig(config: SharedBotConfig): void {
  const filePath = sharedGroupBotConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
}

app.post('/api/group-bot-config', async (req, res) => {
  const { groupId, botId, enabled } = req.body || {};
  if (!groupId || !botId) return res.status(400).json({ ok: false, error: '缺少 groupId 或 botId' });
  if (UNSAFE_OBJECT_KEYS.has(String(groupId))) {
    return res.status(400).json({ ok: false, error: `无效的 groupId: ${groupId}` });
  }
  const validBots = new Set(['yumu', 'kanon', 'hydrant', 'lazybot']);
  if (!validBots.has(botId)) return res.status(400).json({ ok: false, error: `无效的 botId: ${botId}，可选值: ${[...validBots].join(', ')}` });
  let shared: SharedBotConfig;
  try {
    const loaded = readSharedBotConfig();
    shared = loaded.exists ? loaded.config : { ...(readDb().groupBotConfig || {}) };
  } catch (error: any) {
    console.error('[group-bot-config] Failed to read shared config:', error?.message || error);
    return res.status(500).json({
      ok: false,
      error: `共享配置读取失败，未写入任何配置：${String(error?.message || error).slice(0, 300)}`,
    });
  }

  updateDb((db) => {
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig[groupId] = db.groupBotConfig[groupId] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    db.groupBotConfig[groupId][botId] = Boolean(enabled);
  });

  try {
    shared[String(groupId)] = shared[String(groupId)] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    shared[String(groupId)][botId] = Boolean(enabled);
    writeSharedBotConfig(shared);
    console.log('[group-bot-config] Written shared config:', sharedGroupBotConfigPath());
  } catch (error: any) {
    console.error('[group-bot-config] Failed to write shared config:', error?.message || error);
    return res.status(500).json({
      ok: false,
      error: `共享配置写入失败：${String(error?.message || error).slice(0, 300)}`,
    });
  }
  const db = readDb();
  res.json(ok({ config: db.groupBotConfig || {} }));
});

mountOsuRoutes(app);

app.get('/api/diagnostics', (_req, res) => {
  const db = readDb();
  const report = {
    generatedAt: nowIso(),
    app: {
      name: 'QQ AI ChatBot',
      node: process.version,
      platform: process.platform
    },
    oneBot: getOneBotStatus(),
    kb: getKbHealth(),
    settings: publicDb(db).settings,
    groups: db.groups,
    users: db.users,
    memories: db.memories,
    usage: db.usage,
    storeWrites: getStoreWriteStats(),
    storeLocks: getStoreLockStats(),
    backgroundTasks: getBackgroundTaskStats(),
    inboundAdmission: getInboundAdmissionStats(),
    llmAdmission: getLlmAdmissionStats(),
    recentMessages: db.messages.slice(-120),
    recentDecisions: db.decisions.slice(-160),
    recentCommandLogs: (db.commandLogs || []).slice(-160),
    recentAdminActions: db.adminActions.slice(-80)
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qq-ai-chatbot-diagnostics-${Date.now()}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

app.post('/api/settings', async (req, res) => {
  if (req.body?.tokenSavingMode !== undefined && typeof req.body.tokenSavingMode !== 'boolean') return res.status(400).json({ ok: false, error: '节能模式必须为布尔值' });
  for (const key of ['pippiActivityEnabled']) if (req.body?.[key] !== undefined && typeof req.body[key] !== 'boolean') return res.status(400).json({ ok: false, error: '自主活动开关必须为布尔值' });
  if (req.body?.pippiActivityDailyTokens !== undefined && (!Number.isSafeInteger(req.body.pippiActivityDailyTokens) || req.body.pippiActivityDailyTokens < 1000 || req.body.pippiActivityDailyTokens > 2000000)) return res.status(400).json({ ok: false, error: '后台每日额度应为 1000–2000000 Token' });
  if (req.body?.pippiActivityMaxWakes !== undefined && (!Number.isSafeInteger(req.body.pippiActivityMaxWakes) || req.body.pippiActivityMaxWakes < 1 || req.body.pippiActivityMaxWakes > 144)) return res.status(400).json({ ok: false, error: '每日自主唤醒次数应为 1–144' });
  if (req.body?.pippiActivityForumIds !== undefined && (!Array.isArray(req.body.pippiActivityForumIds) || req.body.pippiActivityForumIds.length > 3 || req.body.pippiActivityForumIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 1000000))) return res.status(400).json({ ok: false, error: '最多配置三个公开论坛板块 ID' });
  const settingsBefore = readDb().settings;
  const requested = req.body || {};
  if ('socialV2Enabled' in requested && typeof requested.socialV2Enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'V2 开关必须为布尔值' });
  if ('socialMaxAssessmentsPerHour' in requested && (!Number.isInteger(requested.socialMaxAssessmentsPerHour) || requested.socialMaxAssessmentsPerHour < 1 || requested.socialMaxAssessmentsPerHour > 300)) return res.status(400).json({ ok: false, error: '社交评估小时预算必须为 1–300' });
  const preservePplusSecret = requested.pplusClientSecret === undefined ||
    ['', '已填写', '已设置'].includes(requested.pplusClientSecret);
  const pplusPatch = {
    pplusClientId: requested.pplusClientId ?? settingsBefore.pplusClientId,
    pplusClientSecret: preservePplusSecret ? settingsBefore.pplusClientSecret : requested.pplusClientSecret,
    pplusBaseUrl: requested.pplusBaseUrl ?? settingsBefore.pplusBaseUrl,
  };
  const pplusChanged = Object.entries(pplusPatch).some(([key, value]) => value !== settingsBefore[key]);
  if (pplusChanged && pplusPatch.pplusClientId) {
    try {
      const { validatePPlusCredentials } = await import('./osu/pplus.js');
      await validatePPlusCredentials(pplusPatch);
    } catch (error) {
      return res.status(400).json({ ok: false, error: String(error?.message || 'PP+ 凭据验证失败'), code: error?.code || 'UNAVAILABLE' });
    }
  }
  const updatedDb = updateDb((db) => {
    saveConfigSnapshot(db);
    const incoming = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => Object.prototype.hasOwnProperty.call(db.settings, key))
    );
    // Empty/placeholder secret fields mean "keep the current value". Without
    // this, opening the GUI and saving a page would wipe API keys/tokens.
    const keepSecret = (field) => incoming[field] === undefined || incoming[field] === '' || incoming[field] === '已填写' || incoming[field] === '已设置';
    const previousOneBotToken = db.settings.oneBotAccessToken;
    const previousAdminPassword = db.settings.adminPassword;
    const previousOsuSecret = db.settings.osuClientSecret;
    const previousPplusSecret = db.settings.pplusClientSecret;
    db.settings = updateProviderSettings(db.settings, incoming);
    // Keep the in-memory health snapshot aligned with GUI/API settings writes.
    // The persisted setting is the source of truth for message admission, but
    // a stale health flag makes an active pause look ineffective in the UI.
    setBotPaused(Boolean(db.settings.globalPaused));
    db.settings.oneBotAccessToken = keepSecret('oneBotAccessToken') ? previousOneBotToken : incoming.oneBotAccessToken;
    db.settings.adminPassword = keepSecret('adminPassword') ? previousAdminPassword : incoming.adminPassword;
    db.settings.osuClientSecret = keepSecret('osuClientSecret') ? previousOsuSecret : incoming.osuClientSecret;
    db.settings.pplusClientSecret = keepSecret('pplusClientSecret') ? previousPplusSecret : incoming.pplusClientSecret;
    if (pplusChanged) Object.assign(db.settings, pplusPatch);
    if (Array.isArray(db.settings.commandRoles)) {
      const validRoleIds = new Set(db.settings.commandRoles.map((role) => String(role.id)));
      db.settings.commandPermissions = Object.fromEntries(
        Object.entries(db.settings.commandPermissions || {}).map(([key, value]) => [key, validRoleIds.has(String(value)) ? value : 'guest'])
      );
      db.users = db.users.map((user) => (
        user.commandRoleId && !validRoleIds.has(String(user.commandRoleId))
          ? { ...user, commandRoleId: '', updatedAt: nowIso() }
          : user
      ));
    }
  });
  refreshCachedAdminPassword(updatedDb);
  res.json(ok(compactDbResponse(updatedDb)));
});

app.post('/api/groups', (req, res) => {
  const groupId = identifier(req.body?.groupId, '群号', res);
  if (!groupId) return;
  const mode = String(req.body?.mode || 'mention');
  if (!GROUP_MODES.has(mode)) return res.status(400).json({ ok: false, error: '无效的群回复模式' });
  const hasRandomImageRate = Object.prototype.hasOwnProperty.call(req.body || {}, 'randomImageRate');
  const randomImageRate = String(req.body?.randomImageRate || 'standard');
  if (hasRandomImageRate && !['low', 'standard'].includes(randomImageRate)) {
    return res.status(400).json({ ok: false, error: '无效的随机发图频率' });
  }
  const hasRandomImageEnabled = Object.prototype.hasOwnProperty.call(req.body || {}, 'randomImageEnabled');
  const maxPerHour = rangedInteger(req.body?.maxPerHour, 20, 1, 200, '每小时回复上限', res);
  if (maxPerHour === null) return;
  const cooldownSec = rangedInteger(req.body?.cooldownSec, 30, 0, 600, '冷却秒数', res);
  if (cooldownSec === null) return;
  updateDb((db) => {
    const existing = db.groups.find((group) => String(group.groupId) === String(groupId));
    const migratedEnabled = existing?.randomImageEnabled ?? (mode === 'natural' || mode === 'light');
    const migratedRate = existing?.randomImageRate || (mode === 'light' ? 'low' : 'standard');
    upsertBy(db.groups, 'groupId', {
      groupId,
      name: limitedText(req.body?.name || groupId, 100),
      enabled: Boolean(req.body?.enabled),
      mode,
      maxPerHour,
      cooldownSec,
      randomImageEnabled: hasRandomImageEnabled ? Boolean(req.body?.randomImageEnabled) : Boolean(migratedEnabled),
      randomImageRate: hasRandomImageRate ? randomImageRate : migratedRate,
    });
  });
  res.json(ok(compactDbResponse()));
});

app.delete('/api/groups/:groupId', (req, res) => {
  const groupId = String(req.params.groupId || '');
  clearOwnArchive(getDataDir(), `group:${groupId}`);
  updateDb((db) => {
    db.groups = db.groups.filter((group) => String(group.groupId) !== groupId);
    db.users = (db.users || []).filter((user) => String(user.groupId) !== groupId);
    db.messages = (db.messages || []).filter((message) => String(message.groupId) !== groupId);
    db.decisions = (db.decisions || []).filter((decision) => String(decision.groupId) !== groupId);
    db.commandLogs = (db.commandLogs || []).filter((log) => String(log.groupId) !== groupId);
    db.groupProfiles = (db.groupProfiles || []).filter((profile) => String(profile.groupId) !== groupId);
    db.relationshipProfiles = (db.relationshipProfiles || []).filter((profile) => String(profile.groupId) !== groupId);
    if (db.groupBotConfig) delete db.groupBotConfig[groupId];
    for (const key of Object.keys(db.pendingPairCounts || {})) {
      if (key.startsWith(groupId + ':')) delete db.pendingPairCounts[key];
    }
    for (const key of Object.keys(db.groupExperience || {})) {
      if (key.startsWith(groupId + ':')) delete db.groupExperience[key];
    }
  });
  res.json(ok(compactDbResponse()));
});

app.post('/api/users', (req, res) => {
  const groupId = identifier(req.body?.groupId, '群号', res);
  if (!groupId) return;
  const userId = identifier(req.body?.userId, '用户号', res);
  if (!userId) return;
  const policy = String(req.body?.policy || 'normal');
  if (!USER_POLICIES.has(policy)) return res.status(400).json({ ok: false, error: '无效的成员策略' });
  const attentionLevel = rangedInteger(req.body?.attentionLevel, 3, 1, 5, '注意力等级', res);
  if (attentionLevel === null) return;
  updateDb((db) => {
    const existingIndex = db.users.findIndex(
      (user) => String(user.groupId) === groupId && String(user.userId) === userId
    );
    const entry = {
      groupId,
      userId,
      nickname: limitedText(req.body?.nickname || userId, 100),
      policy,
      attentionLevel,
      allowCommands: Boolean(req.body.allowCommands),
      commandRoleId: limitedText(req.body?.commandRoleId, 64),
      note: limitedText(req.body?.note, 500),
      customPrompt: limitedText(req.body?.customPrompt, 2000),
      updatedAt: nowIso()
    };
    if (existingIndex >= 0) db.users[existingIndex] = { ...db.users[existingIndex], ...entry };
    else db.users.push({ ...entry, id: crypto.randomUUID(), createdAt: nowIso() });
    db.adminActions.push({
      id: crypto.randomUUID(),
      operatorUserId: 'GUI',
      action: '更新成员策略',
      targetUserId: entry.userId,
      groupId: entry.groupId,
      detail: `${entry.policy} / 注意力 ${entry.attentionLevel}`,
      createdAt: nowIso()
    });
  });
  res.json(ok(compactDbResponse()));
});

app.delete('/api/users/:groupId/:userId', (req, res) => {
  updateDb((db) => {
    db.users = db.users.filter(
      (user) => !(String(user.groupId) === String(req.params.groupId) && String(user.userId) === String(req.params.userId))
    );
  });
  res.json(ok(compactDbResponse()));
});

app.post('/api/memories/:userId', (req, res) => {
  const userId = identifier(req.params.userId, '用户号', res);
  if (!userId) return;
  const importanceLevel = rangedInteger(req.body?.importanceLevel, 2, 1, 5, '重要程度', res);
  if (importanceLevel === null) return;
  updateDb((db) => {
    if (!db.memories) db.memories = [];
    const existingIndex = db.memories.findIndex((memory) => String(memory.userId) === userId);
    const incoming = req.body || {};
    const entry = {
      userId,
      nickname: limitedText(incoming.nickname || userId, 100),
      enabled: incoming.enabled !== false,
      importanceLevel,
      importanceLabel: limitedText(incoming.importanceLabel, 100),
      summary: limitedText(incoming.summary, 2000),
      traits: limitedText(incoming.traits, 1000),
      speechStyle: limitedText(incoming.speechStyle, 1000),
      behavior: limitedText(incoming.behavior, 1000),
      preferences: limitedText(incoming.preferences, 1000),
      manualNotes: limitedText(incoming.manualNotes, 2000),
      updatedAt: nowIso()
    };
    if (existingIndex >= 0) db.memories[existingIndex] = { ...db.memories[existingIndex], ...entry };
    else db.memories.push({ ...entry, id: crypto.randomUUID(), messageCount: 0, pendingCount: 0, groupsSeen: [], samples: [], createdAt: nowIso() });
  });
  res.json(ok(compactDbResponse()));
});

app.post('/api/memories/:userId/recalculate', async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  const db = readDb();
  const memory = (db.memories || []).find((entry) => String(entry.userId) === userId);
  if (!memory) return res.status(404).json({ ok: false, error: '没有找到这个用户的长期记忆' });
  const storedUsableSamples = (memory.samples || []).filter((sample) => sample?.usedForProfile && sample?.content).length;
  const historicalMessages = (db.messages || []).filter((message) => message.role === 'user' && String(message.userId) === userId).length;
  if (storedUsableSamples < 3 && historicalMessages < 3) {
    return res.status(400).json({ ok: false, error: `可用画像样本不足：样本 ${storedUsableSamples} 条，历史消息 ${historicalMessages} 条` });
  }
  try {
    const outcome = await maybeUpdateMemoryProfile({
      type: 'private', groupId: '', userId, nickname: memory.nickname || userId,
      messageId: `memory-manual-recalc:${userId}:${Date.now()}`
    }, {
      force: true,
      bypassCircuit: true,
      kind: 'memory-manual-recalc',
    });
    if (!outcome.ok) return res.status(400).json({ ok: false, error: outcome.reason || outcome.error || '画像更新失败', ...compactDbResponse() });
    res.json(ok({ ...compactDbResponse(), outcome, runId: outcome.runId, usage: outcome.usage || {} }));
  } catch (error) {
    updateDb((draft) => {
      const target = (draft.memories || []).find((entry) => String(entry.userId) === userId);
      if (target) {
        target.lastProfileAttemptAt = nowIso();
        target.lastProfileStatus = 'error';
        target.lastProfileError = error.message || String(error);
        target.updatedAt = nowIso();
      }
      if (!draft.usage) draft.usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, requests: 0, replies: 0, errors: 0 };
      draft.usage.errors = Number(draft.usage.errors || 0) + 1;
    });
    res.status(400).json({ ok: false, error: error.message || String(error), ...compactDbResponse() });
  }
});

app.delete('/api/memories/:userId', (req, res) => {
  updateDb((db) => {
    db.memories = (db.memories || []).filter((memory) => String(memory.userId) !== String(req.params.userId));
  });
  res.json(ok(compactDbResponse()));
});

app.post('/api/onebot/connect', (_req, res) => {
  connectOneBot();
  res.json(ok({ oneBot: getOneBotStatus() }));
});

app.get('/api/onebot/autodetect', async (_req, res) => {
  const ports = [3000, 3001, 4000, 8080, 5700, 5701];
  const results = [];
  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
      clearTimeout(timeout);
      const text = await resp.text().catch(() => '');
      results.push({
        port,
        reachable: true,
        looksLikeOneBot: text.includes('OneBot') || text.includes('go-cqhttp') || text.includes('NapCat') || text.includes('Lagrange'),
        snippet: text.slice(0, 120)
      });
    } catch {
      results.push({ port, reachable: false });
    }
  }
  const detected = results.filter((r) => r.reachable);
  const oneBotCandidates = detected.filter((r) => r.looksLikeOneBot);
  const best = oneBotCandidates.length > 0 ? oneBotCandidates[0].port : (detected.length > 0 ? detected[0].port : null);
  res.json(ok({
    results,
    detected: best ? {
      httpUrl: `http://127.0.0.1:${best}`,
      wsUrl: `ws://127.0.0.1:${best + 1}`,
      bestPort: best
    } : null
  }));
});

app.post('/api/onebot/event', async (req, res) => {
  const result = await handleOneBotEvent(req.body, sendOneBotMessage);
  res.json(ok({ result }));
});

app.post('/api/simulate', async (req, res) => {
  const result = await processIncoming({
    source: 'gui',
    type: 'group',
    messageId: crypto.randomUUID(),
    groupId: String(req.body.groupId || '10001'),
    userId: String(req.body.userId || 'demo-user'),
    nickname: req.body.nickname || '测试群友',
    text: req.body.text || ''
  });
  res.json(ok({ result, ...compactDbResponse() }));
});

// Decision sandbox — reads DB, applies overrides, returns decision+context, never writes
app.post('/api/sandbox', async (req, res) => {
  // Sandbox previews run in a dedicated module that copies store data before
  // applying overrides; the route body must stay free of direct db mutation.
  res.json(await runSandboxPreview(req.body));
});

app.post('/api/clear-context/:groupId', (req, res) => {
  if (String(req.params.groupId) === 'private') clearOwnArchive(getDataDir(), 'private:*');
  else clearOwnArchive(getDataDir(), `group:${String(req.params.groupId)}`);
  updateDb((db) => {
    // Context cleanup only removes message memory and decision logs. It keeps
    // prompts, model settings, groups, members, and usage counters intact.
    db.messages = db.messages.filter((message) => String(message.groupId) !== String(req.params.groupId));
    db.decisions = db.decisions.filter((decision) => String(decision.groupId) !== String(req.params.groupId));
    db.commandLogs = (db.commandLogs || []).filter((log) => String(log.groupId) !== String(req.params.groupId));
  });
  res.json(ok(compactDbResponse()));
});

app.post('/api/clear-context', (_req, res) => {
  clearOwnArchive(getDataDir());
  updateDb((db) => {
    db.messages = [];
    db.decisions = [];
    db.commandLogs = [];
  });
  res.json(ok(compactDbResponse()));
});

// Health
// 正在进行的回复进程：控制台据此列出"她正在给谁回"，并可以掐断其中一轮。
app.get('/api/reply-processes', (_req, res) => {
  res.json(ok({ processes: listReplyProcesses() }));
});

app.post('/api/reply-processes/:id/abort', (req, res) => {
  const result = abortReplyProcess(String(req.params.id || ''));
  if (!result.ok) return res.status(404).json({ ok: false, error: result.reason });
  res.json(ok({ id: result.id }));
});

app.get('/api/health', (_req, res) => {
  const health: any = getHealth();
  health.replyQueues = getReplyQueueStats();
  health.storeWrites = getStoreWriteStats();
  health.storeLocks = getStoreLockStats();
  health.backgroundTasks = getBackgroundTaskStats();
  health.socialReflectionQueue = getSocialReflectionQueueStats();
  health.ownMessageArchive = ownMessageArchiveStatus();
  health.inboundAdmission = getInboundAdmissionStats();
  health.llmAdmission = getLlmAdmissionStats();
  res.json(health);
});

// Group profiles
app.get('/api/group-profiles/:groupId', (req, res) => {
  const db = readDb();
  const profile = getGroupProfile(db, req.params.groupId);
  res.json(ok({ profile: profile || null }));
});

app.post('/api/group-profiles/:groupId/update', async (req, res) => {
  const db = readDb();
  const result = await updateGroupProfile(db, req.params.groupId);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  res.json(ok({ profile: getGroupProfile(readDb(), req.params.groupId), sampleCount: result.sampleCount }));
});

app.patch('/api/group-profiles/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  updateDb((draft) => {
    if (!draft.groupProfiles) draft.groupProfiles = [];
    const existing = draft.groupProfiles.find((p) => String(p.groupId) === String(groupId));
    const body = req.body || {};
    if (existing) {
      if (body.enabled !== undefined) existing.enabled = Boolean(body.enabled);
      if (body.atmosphere !== undefined) existing.atmosphere = String(body.atmosphere).slice(0, 300);
      if (body.topics !== undefined) existing.topics = String(body.topics).slice(0, 300);
      if (body.humorStyle !== undefined) existing.humorStyle = String(body.humorStyle).slice(0, 300);
      if (body.pace !== undefined) existing.pace = String(body.pace).slice(0, 200);
      if (body.botStrategy !== undefined) existing.botStrategy = String(body.botStrategy).slice(0, 400);
      if (body.boundaries !== undefined) existing.boundaries = String(body.boundaries).slice(0, 300);
      existing.updatedAt = nowIso();
    }
  });
  res.json(ok({ profile: getGroupProfile(readDb(), groupId) }));
});

app.delete('/api/group-profiles/:groupId', (req, res) => {
  const result = clearGroupProfile(req.params.groupId);
  res.json(ok({ deleted: result.ok }));
});

// Relationship profile routes
function relationshipPairKey(userA, userB) {
  return [String(userA), String(userB)].sort().join(':');
}

function createDisplayNameResolver(db) {
  const userNames = new Map();
  for (const user of db.users || []) {
    const key = `${String(user.groupId)}:${String(user.userId)}`;
    const name = user.customName || user.nickname;
    if (name && !userNames.has(key)) userNames.set(key, String(name));
  }

  const memoryNames = new Map();
  for (const memory of db.memories || []) {
    const userId = String(memory.userId);
    if (memory.nickname && !memoryNames.has(userId)) memoryNames.set(userId, String(memory.nickname));
  }

  // The old resolver searched the message history backwards for every name.
  // Build that same latest-name lookup once per response instead of repeating
  // an O(profileCount * messageCount) scan.
  const recentNames = new Map();
  const messages = db.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const userId = String(message.userId || '');
    if (message.nickname && userId && !recentNames.has(userId)) {
      recentNames.set(userId, String(message.nickname));
    }
  }

  return (groupId, userId) => {
    const normalizedGroupId = String(groupId);
    const normalizedUserId = String(userId);
    return userNames.get(`${normalizedGroupId}:${normalizedUserId}`)
      || memoryNames.get(normalizedUserId)
      || recentNames.get(normalizedUserId)
      || normalizedUserId;
  };
}

app.get('/api/relationship-profiles', (_req, res) => {
  const db = readDb();
  const displayNameForUser = createDisplayNameResolver(db);
  const groupNames = new Map((db.groups || []).map((group) => [String(group.groupId), group.name || String(group.groupId)]));
  const substantiveProfiles = (db.relationshipProfiles || []).filter(isSubstantiveRelationshipProfile);
  const profileKeys = new Set(substantiveProfiles.map((profile) => `${String(profile.groupId)}:${profile.pairKey}`));
  const profiles = substantiveProfiles
    .map((p) => ({
      ...p,
      groupName: groupNames.get(String(p.groupId)) || p.groupId,
      userAName: displayNameForUser(p.groupId, p.userA),
      userBName: displayNameForUser(p.groupId, p.userB),
    }));
  const pendingPairCounts = db.pendingPairCounts || {};
  const candidates = Object.entries(pendingPairCounts)
    .map(([key, count]) => {
      const parts = String(key).split(':');
      if (parts.length !== 3 || Number(count) <= 0) return null;
      const [groupId, userA, userB] = parts;
      const pairKey = relationshipPairKey(userA, userB);
      if (profileKeys.has(`${groupId}:${pairKey}`)) return null;
      return {
        groupId, userA, userB, pairKey, count: Number(count),
        groupName: groupNames.get(groupId) || groupId,
        userAName: displayNameForUser(groupId, userA),
        userBName: displayNameForUser(groupId, userB),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count);
  res.json(ok({ profiles, candidates }));
});

app.post('/api/relationship-profiles/update', async (req, res) => {
  const { groupId, userA, userB } = req.body || {};
  if (!groupId || !userA || !userB) return res.status(400).json({ ok: false, error: '缺少 groupId/userA/userB' });
  const result = await updateRelationshipProfile(readDb(), groupId, userA, userB);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  if (result.skipped) return res.json(ok({ skipped: true, reason: result.reason, sampleCount: result.sampleCount }));
  const profile = getRelationshipProfile(readDb(), groupId, userA, userB);
  res.json(ok({ profile, sampleCount: result.sampleCount }));
});

app.patch('/api/relationship-profiles/:groupId/:userA/:userB', (req, res) => {
  const { groupId, userA, userB } = req.params;
  const pairKey = relationshipPairKey(userA, userB);
  const body = req.body || {};
  const allowed = ['enabled', 'interactionStyle', 'commonTopics', 'tone', 'botStrategy', 'boundaries'];
  updateDb((draft) => {
    if (!draft.relationshipProfiles) return;
    const existing = draft.relationshipProfiles.find((p) => String(p.groupId) === String(groupId) && p.pairKey === pairKey);
    if (!existing) return;
    for (const key of allowed) {
      if (body[key] !== undefined) {
        existing[key] = key === 'enabled' ? Boolean(body[key]) : String(body[key]).slice(0, 400);
      }
    }
    existing.updatedAt = nowIso();
  });
  const profile = getRelationshipProfile(readDb(), groupId, userA, userB);
  if (!profile) return res.status(404).json({ ok: false, error: '未找到关系画像' });
  res.json(ok({ profile }));
});

app.delete('/api/relationship-profiles/:groupId/:userA/:userB', (req, res) => {
  const { groupId, userA, userB } = req.params;
  const result = clearRelationshipProfile(groupId, userA, userB);
  res.json(ok({ deleted: result.ok }));
});

app.get('/api/memories/:userId', (req, res) => {
  const userId = String(req.params.userId || '').trim();
  const memory = (readDb().memories || []).find((entry) => String(entry.userId) === userId);
  if (!memory) return res.status(404).json({ ok: false, error: '没有找到这个用户的长期记忆' });
  res.json(ok({ memory: publicMemory(memory, true) }));
});

// Profile log routes
app.get('/api/profile-logs', (req, res) => {
  const { userId, runId, event, limit, offset } = req.query;
  const logs = queryProfileLogs({
    userId: userId ? String(userId) : undefined,
    runId: runId ? String(runId) : undefined,
    event: event ? String(event) as any : undefined,
    limit: limit ? Number(limit) : 100,
    offset: offset ? Number(offset) : 0,
  });
  const stats = getProfileLogStats();
  res.json(ok({ logs, stats: { ...stats, queue: getMemoryProfileQueueStatus() } }));
});

// Backup routes
app.get('/api/backups', (_req, res) => {
  res.json(ok({ backups: listBackups(), retention: backupRetention(readDb()) }));
});

app.post('/api/backups', (req, res) => {
  const type = String(req.body?.type || 'manual');
  if (!['manual', 'auto', 'pre-restore'].includes(type)) {
    return res.status(400).json({ ok: false, error: '无效的备份类型' });
  }
  const result = createBackup(type);
  res.json(ok({ backup: result }));
});

app.post('/api/backups/:name/restore', (req, res) => {
  const result = restoreBackup(req.params.name);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  refreshCachedAdminPassword();
  res.json(ok({ restored: result.name }));
});

app.delete('/api/backups/:name', (req, res) => {
  const result = deleteBackup(req.params.name);
  if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
  res.json(ok({ deleted: req.params.name }));
});

app.post('/api/backups/prune', (req, res) => {
  const olderThanDays = Number(req.body?.olderThanDays);
  const result = pruneBackups({ olderThanDays });
  res.json(ok(result));
});

app.post('/api/backups/retention', (req, res) => {
  const body = req.body || {};
  const read = (value, fallback, max) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return null;
    return parsed;
  };
  const current = backupRetention(readDb());
  const auto = read(body.auto, current.auto, 200);
  const preRestore = read(body.preRestore, current.preRestore, 200);
  const manual = read(body.manual, current.manual, 500);
  if ([auto, preRestore, manual].some((value) => value === null)) {
    res.status(400).json({ ok: false, error: '保留份数必须是 0-500 的整数（0 表示不限）' });
    return;
  }
  updateDb((db) => {
    db.settings.backupRetention = { auto, preRestore, manual };
  });
  const pruned = pruneBackups();
  res.json(ok({ retention: { auto, preRestore, manual }, ...pruned }));
});

// Recovery snapshots are created by store.ts at five-minute intervals.
// Use the same policy at startup; a second timer would duplicate snapshots.
pruneAutoBackups();

// Auto-evaluate trust scores every 4 hours (legacy compat)
setInterval(() => { evaluateTrustScores(); }, 4 * 60 * 60 * 1000);
// Decay XP for inactive users every 6 hours
setInterval(() => { decayInactiveUsers(); }, 6 * 60 * 60 * 1000);

// Recalc progress
app.get('/api/recalc-status', (_req, res) => { res.json(ok(getRecalcProgress())); });

app.post('/api/recalc', (_req, res) => {
  const state = getRecalcProgress();
  if (state.running) return res.json({ ok: false, error: '已经在重算中' });
  // Start in background
  void runBackgroundTask('recalc.api', async () => {
    let started = false;
    try {
      const db = readDb();
      const mems = (db.memories || []).filter((m) => m.enabled && (m.samples || []).filter((s) => s.usedForProfile).length >= 3);
      const gps = (db.groups || []).filter((g) => g.enabled);
      const rels = (db.relationshipProfiles || []).filter((r) => r.enabled !== false);
      const total = mems.length + gps.length + rels.length;
      startRecalc(total, '正在重算全部画像');
      started = true;
      const { maybeUpdateMemoryProfile } = await import('./bot/memory.js');
      const { updateGroupProfile } = await import('./bot/groupProfile.js');
      const { updateRelationshipProfile } = await import('./bot/relationshipProfile.js');
      let memoryFailed = 0, groupFailed = 0, relationshipFailed = 0;
      for (const mem of mems) {
        if (getRecalcProgress().stopped) break;
        try {
          await maybeUpdateMemoryProfile({
            type: 'private', groupId: '', userId: String(mem.userId), nickname: mem.nickname || String(mem.userId),
            messageId: `memory-recalc:${mem.userId}:${Date.now()}`
          }, { force: true, kind: 'memory-recalc' });
        } catch (error) {
          memoryFailed += 1;
          console.error('[recalc] memory profile failed:', mem.userId, String(error?.message || error).slice(0, 200));
        }
        tickRecalc();
      }
      for (const g of gps) {
        if (getRecalcProgress().stopped) break;
        try {
          await updateGroupProfile(readDb(), g.groupId);
        } catch (error) {
          groupFailed += 1;
          console.error('[recalc] group profile failed:', g.groupId, String(error?.message || error).slice(0, 200));
        }
        tickRecalc();
      }
      for (const rp of rels) {
        if (getRecalcProgress().stopped) break;
        try {
          await updateRelationshipProfile(readDb(), rp.groupId, rp.userA, rp.userB);
        } catch (error) {
          relationshipFailed += 1;
          console.error('[recalc] relationship profile failed:', rp.groupId, String(error?.message || error).slice(0, 200));
        }
        tickRecalc();
      }
      const failed = memoryFailed + groupFailed + relationshipFailed;
      finishRecalc(getRecalcProgress().stopped ? '已停止' : (failed ? `重算完成：成功 ${total - failed}/${total}，失败 ${failed}` : '全部重算完成'));
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      console.error('[recalc] 后台重算异常结束:', message);
      if (started && getRecalcProgress().running) {
        finishRecalc(getRecalcProgress().stopped ? '已停止' : `重算失败：${message}`);
      }
    } finally {
      // No background job may leave the GUI's singleton progress marker stuck
      // at running after an unexpected exception or module-load failure.
      if (started && getRecalcProgress().running) {
        finishRecalc(getRecalcProgress().stopped ? '已停止' : '重算异常结束');
      }
    }
  });
  res.json({ ok: true });
});

app.post('/api/recalc/stop', (_req, res) => {
  stopRecalc();
  res.json({ ok: true });
});

app.post('/api/stop-all', (_req, res) => {
  stopRecalc();
  res.json({ ok: true });
});

// Config snapshots
app.get('/api/config-snapshots', (_req, res) => {
  const db = readDb();
  res.json(ok({ snapshots: listConfigSnapshots(db) }));
});

app.post('/api/config-snapshots/:index/restore', (req, res) => {
  const index = parseInt(req.params.index, 10);
  let restored = false;
  const updatedDb = updateDb((db) => {
    restored = restoreConfigSnapshot(db, index);
  });
  if (!restored) return res.status(400).json({ ok: false, error: '无效的快照索引' });
  refreshCachedAdminPassword(updatedDb);
  res.json(ok({ restored: true }));
});

// Serve the same built React console used by Desktop. Keep the historical
// console as a development fallback when no build exists.
{
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const consoleDirs = [
    path.join(serverDir, '..', 'dist'),
    path.join(process.cwd(), 'dist'),
    path.join(process.cwd(), 'console'),
    path.join(serverDir, '..', 'console'),
  ];
  const consoleDir = consoleDirs.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
  if (consoleDir) {
    app.use(express.static(consoleDir, { index: 'index.html', extensions: ['html'], maxAge: 0 }));
    app.get('/', (_req, res) => res.sendFile(path.join(consoleDir, 'index.html')));
    console.log('[console] serving', consoleDir);
  }
}

// JSON error handler — never return HTML error pages to the GUI
app.use((err, _req, res, _next) => {
  const message = err?.message || String(err || '未知错误');
  res.status(err?.status || err?.statusCode || 500).json({ ok: false, error: message });
});

httpServer = app.listen(port, '127.0.0.1', async () => {
  const { setMatchSender, matchManager } = await import('./osu/match.js');
  const { sendOneBotMessage } = await import('./onebot.js');
  const { migrateLegacyLevels } = await import('./bot/experience.js');
  setMatchSender(sendOneBotMessage);
  try {
    const migrated = migrateLegacyLevels();
    if (migrated > 0) console.log(`[experience] 已迁移 ${migrated} 条旧等级数据`);
  } catch (error) {
    console.error('[experience] 等级迁移失败:', String(error?.message || error));
  }
  try {
    void matchManager.restore(readDb()).catch((error) => {
      console.error('[match] 恢复监听失败:', String(error?.message || error));
    });
  } catch (error) {
    console.error('[match] 恢复监听失败:', String(error?.message || error));
  }
  console.log(`QQ AI ChatBot server running at http://127.0.0.1:${port}`);
  connectOneBot();
  startPippiActivity(sendOneBotMessage);
  startSocialReflections();
  startOwnMessageArchive();
  // Start Wuxin's local yumu-image endpoint on 8389. The renderer keeps its
  // original 8388 connection and opens this second connection independently.
  startRenderServer(Number(process.env.WUXIN_RENDER_PORT || 8389));
});
