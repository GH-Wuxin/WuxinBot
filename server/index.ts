import 'dotenv/config';
import crypto from 'node:crypto';
import net from 'node:net';
import express from 'express';
import { ensureStore, publicDb, readDb, updateDb, upsertBy, nowIso, saveConfigSnapshot, listConfigSnapshots, restoreConfigSnapshot } from './store.js';
import { createBackup, listBackups, restoreBackup, deleteBackup, pruneAutoBackups } from './backup.js';
import { connectOneBot, getOneBotStatus, handleOneBotEvent, sendOneBotMessage } from './onebot.js';
import { processIncoming, decideReply } from './bot.js';
import { getReplyQueueStats } from './bot/queue.js';
import { buildPrompt } from './bot/prompt.js';
import { callLLM } from './bot/llm.js';
import { getHealth, getRecalcProgress, startRecalc, tickRecalc, stopRecalc, finishRecalc } from './health.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile, hasGroupProfileContent } from './bot/groupProfile.js';
import { getRelationshipProfile, updateRelationshipProfile, clearRelationshipProfile, isSubstantiveRelationshipProfile } from './bot/relationshipProfile.js';
import { commitMemoryProfileResult, updateMemoryProfile } from './bot/memory.js';
import { evaluateTrustScores } from './bot/trust.js';
import { decayInactiveUsers } from './bot/experience.js';
import { queryProfileLogs, getProfileLogStats } from './bot/profileLog.js';
import { updateProviderSettings } from './modelConfig.js';
import { startRenderServer } from './bots/renderServer.js';

// Node 20.11.1 crashes with ERR_INTERNAL_ASSERTION in internalConnectMultiple
// when many outbound sockets race IPv4/IPv6 auto-selection (happy eyeballs).
// Disable the parallel family selection so concurrent API calls are safe.
try {
  (net as any).setDefaultAutoSelectFamily?.(false);
} catch {
  // Older/other runtimes simply keep the default.
}

ensureStore();

const app = express();
app.use(express.json({ limit: '2mb' }));

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_MODES = new Set(['silent', 'mention', 'light', 'natural']);
const USER_POLICIES = new Set(['normal', 'whitelist', 'priority', 'muted', 'blocked', 'admin', 'owner']);

function safeSecretEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The GUI remains open when no password is configured. Once ADMIN_PASSWORD or
// the GUI password field is set, every API call must authenticate.
app.use('/api', (req, res, next) => {
  const expected = String(readDb().settings.adminPassword || '');
  if (!expected) return next();
  const supplied = req.get('x-wuxin-admin-password') || '';
  if (!safeSecretEqual(supplied, expected)) {
    return res.status(401).json({ ok: false, error: '需要正确的管理密码' });
  }
  next();
});

function identifier(value, label, res) {
  const result = String(value || '').trim();
  if (!SAFE_ID.test(result)) {
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

function limitedText(value, max) {
  return String(value || '').trim().slice(0, max);
}

// Express is only the local GUI/API layer. QQ events enter through OneBot's
// WebSocket in onebot.ts; /api/onebot/event exists for manual testing or
// alternative webhook setups.
function ok(data = {}) {
  return { ok: true, ...data };
}

app.get('/api/state', (_req, res) => {
  res.json(ok({ db: publicDb(), oneBot: getOneBotStatus() }));
});

// ── Group bot config ──

app.get('/api/group-bot-config', (_req, res) => {
  const db = readDb();
  res.json(ok({ config: db.groupBotConfig || {}, groups: db.groups.map(g => ({ groupId: g.groupId, name: g.name })) }));
});

app.post('/api/group-bot-config', async (req, res) => {
  const { groupId, botId, enabled } = req.body || {};
  if (!groupId || !botId) return res.status(400).json({ ok: false, error: '缺少 groupId 或 botId' });
  const validBots = new Set(['yumu', 'kanon', 'hydrant', 'lazybot']);
  if (!validBots.has(botId)) return res.status(400).json({ ok: false, error: `无效的 botId: ${botId}，可选值: ${[...validBots].join(', ')}` });
  updateDb((db) => {
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig[groupId] = db.groupBotConfig[groupId] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    db.groupBotConfig[groupId][botId] = Boolean(enabled);
  });
  // Write shared config file that all bots read
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sharedConfigPath = 'REDACTED_BOTS_ROOT/configs/group-bot-config.json';
    const dir = path.dirname(sharedConfigPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let shared = {};
    try { shared = JSON.parse(fs.readFileSync(sharedConfigPath, 'utf8')); } catch {}
    shared[String(groupId)] = shared[String(groupId)] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    shared[String(groupId)][botId] = Boolean(enabled);
    fs.writeFileSync(sharedConfigPath, JSON.stringify(shared, null, 2), 'utf8');
    console.log('[group-bot-config] Written shared config:', sharedConfigPath);
  } catch (err) {
    console.error('[group-bot-config] Failed to write shared config:', err.message);
  }
  const db = readDb();
  res.json(ok({ config: db.groupBotConfig || {} }));
});

// ── osu! console API ──

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { try { socket.destroy(); } catch { /* noop */ } resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function osuBindingList(db = readDb()) {
  return Object.entries(db.osuBindings || {}).map(([qq, value]) => {
    const b: any = value && typeof value === 'object' ? value : { id: value };
    const id = Number(b.osuUserId ?? b.userId ?? b.id ?? 0);
    return {
      qq,
      id: Number.isFinite(id) && id > 0 ? id : 0,
      username: String(b.osuUsername ?? b.username ?? '').trim(),
    };
  }).sort((a, b) => a.qq.localeCompare(b.qq));
}

function osuQuickGroupList(db = readDb()) {
  return (db.groups || []).map((g) => ({
    groupId: g.groupId,
    name: g.name,
    enabled: Boolean(g.enabled),
    quick: Boolean(db.groupBotConfig?.[g.groupId]?.quick),
  }));
}

app.get('/api/osu/status', async (_req, res) => {
  const db = readDb();
  const health = getHealth();
  const botPorts = { yumu: 8388, kanon: 7700, hydrant: 8800, lazybot: 1145 };
  const bots = [];
  for (const [id, port] of Object.entries(botPorts)) {
    bots.push({ id, port, up: await tcpProbe(Number(port)) });
  }

  const logs = (db.commandLogs || []).filter((c) => String(c.command || '').startsWith('quick:'));
  const byCommand = {};
  const bySource = {};
  for (const log of logs) {
    const command = String(log.command || '').replace(/^quick:/, '');
    byCommand[command] = (byCommand[command] || 0) + 1;
    const source = String(log.source || 'other');
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const osuLogs = (db.commandLogs || []).filter((c) => String(c.command || '') === '/osu');
  const analyzeCount = osuLogs.filter((c) => String(c.subCommand || '') === 'analyze').length;
  const bindCount = osuLogs.filter((c) => String(c.subCommand || '') === 'bind').length;
  const recentQuick = [...logs].reverse().slice(0, 15).map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    groupId: c.groupId,
    userId: c.userId,
    nickname: c.nickname,
    command: String(c.command || '').replace(/^quick:/, ''),
    outcome: c.outcome,
    detail: c.detail,
  }));

  res.json(ok({
    health: { api429Count: health.osu.api429Count, renderFailures: health.osu.renderFailures },
    bots,
    quickRouterEnabled: Boolean(db.settings.quickRouterEnabled),
    groups: osuQuickGroupList(db),
    bindings: osuBindingList(db),
    stats: {
      quickTotal: logs.length,
      byCommand: Object.fromEntries(Object.entries(byCommand).sort((a, b) => Number(b[1]) - Number(a[1]))),
      bySource,
      analyzeCount,
      bindCount,
    },
    recentQuick,
  }));
});

app.post('/api/osu/bindings', async (req, res) => {
  const { action, qq, username } = req.body || {};
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ ok: false, error: 'action 必须是 add 或 remove' });
  }
  const qqStr = String(qq || '').trim();
  if (!/^\d{5,12}$/.test(qqStr)) {
    return res.status(400).json({ ok: false, error: 'QQ 号格式不正确' });
  }
  if (action === 'remove') {
    updateDb((db) => {
      if (db.osuBindings) delete db.osuBindings[qqStr];
    });
    return res.json(ok({ bindings: osuBindingList() }));
  }
  const name = String(username || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '缺少 osu 用户名' });
  try {
    const { getUser } = await import('./osu/api.js');
    const user = await getUser(name);
    if (!user?.id) throw new Error('用户不存在');
    updateDb((db) => {
      db.osuBindings = db.osuBindings || {};
      db.osuBindings[qqStr] = { id: user.id, username: String(user.username || name) };
    });
    res.json(ok({ bindings: osuBindingList() }));
  } catch {
    res.status(400).json({ ok: false, error: `osu! 用户 "${name}" 查不到。` });
  }
});

app.post('/api/osu/quick', (req, res) => {
  const { global, groupId, enabled } = req.body || {};
  if (global !== undefined) {
    updateDb((db) => {
      db.settings.quickRouterEnabled = Boolean(global);
    });
    return res.json(ok({ quickRouterEnabled: Boolean(global) }));
  }
  if (!groupId) return res.status(400).json({ ok: false, error: '缺少 groupId' });
  updateDb((db) => {
    db.groupBotConfig = db.groupBotConfig || {};
    db.groupBotConfig[String(groupId)] = db.groupBotConfig[String(groupId)] || { yumu: true, kanon: true, hydrant: true, lazybot: true };
    db.groupBotConfig[String(groupId)].quick = Boolean(enabled);
  });
  res.json(ok({ groups: osuQuickGroupList() }));
});

// ── osu! console player APIs ──

function osuIdParam(req, res) {
  const value = String(req.params.id || '').trim();
  if (!/^\d{1,12}$/.test(value)) {
    res.status(400).json({ ok: false, error: '玩家 ID 格式不正确' });
    return null;
  }
  return Number(value);
}

function scoreModAcronyms(score) {
  const rawMods = Array.isArray(score?.mods) ? score.mods : [];
  const acronyms = rawMods.map((mod) => {
    if (typeof mod === 'string') return mod;
    if (mod && typeof mod === 'object' && 'acronym' in mod) return String(mod.acronym || '');
    return '';
  }).map((mod) => mod.toUpperCase()).filter((mod) => mod && mod !== 'NM');
  return [...new Set(acronyms)];
}

function consoleScoreRow(score, rank = null) {
  const beatmap = score?.beatmap || {};
  const beatmapset = beatmap?.beatmapset || {};
  const accuracy = Number(score?.accuracy);
  return {
    bpRank: rank,
    id: Number(score?.id ?? score?.best_id ?? 0),
    mode: String(score?.mode || 'osu'),
    title: String(beatmapset?.title_unicode || beatmapset?.title || '未知谱面'),
    artist: String(beatmapset?.artist_unicode || beatmapset?.artist || ''),
    mapper: String(beatmapset?.creator || ''),
    version: String(beatmap?.version || ''),
    bid: Number(beatmap?.id || score?.beatmap_id || 0),
    sid: Number(beatmapset?.id || beatmap?.beatmapset_id || 0),
    stars: Number(score?.difficulty_rating ?? beatmap?.difficulty_rating ?? 0),
    mods: scoreModAcronyms(score),
    acc: Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 1 ? accuracy * 100 : accuracy,
    max_combo: Number(score?.max_combo || 0),
    max_combo_total: Number(beatmap?.max_combo || 0),
    pp: Number(score?.pp || 0),
    weighted_pp: Number(score?.weight?.pp ?? 0),
    rank: String(score?.rank || 'F'),
    score: Number(score?.score ?? score?.total_score ?? 0),
    date: score?.ended_at || score?.created_at || '',
    passed: score?.passed !== false,
  };
}

function playerView(user) {
  const stats = user?.statistics || {};
  const level = stats?.level || {};
  const grades = stats?.grade_counts || {};
  const badges = Array.isArray(user?.badges)
    ? user.badges.map((badge) => ({
        description: String(badge?.description || ''),
        image_url: String(badge?.image_url || ''),
        awarded_at: badge?.awarded_at || '',
      }))
    : [];
  const rankHistory = Array.isArray(user?.rank_history?.data)
    ? user.rank_history.data.slice(-90)
    : [];
  return {
    id: Number(user?.id || 0),
    username: String(user?.username || ''),
    avatar_url: String(user?.avatar_url || ''),
    country_code: String(user?.country?.code || user?.country_code || ''),
    country_name: String(user?.country?.name || ''),
    is_supporter: Boolean(user?.is_supporter),
    pp: Number(stats?.pp || 0),
    global_rank: Number(stats?.global_rank || stats?.rank || 0),
    country_rank: Number(stats?.country_rank || 0),
    accuracy: Number(stats?.hit_accuracy || 0),
    play_count: Number(stats?.play_count || 0),
    play_time: Number(stats?.play_time || 0),
    level: Number(level?.current || 0),
    level_progress: Number(level?.progress || 0),
    max_combo: Number(stats?.maximum_combo || 0),
    total_hits: Number(stats?.total_hits || 0),
    join_date: user?.join_date || '',
    grade_counts: {
      ssh: Number(grades?.ssh || 0),
      ss: Number(grades?.ss || 0),
      sh: Number(grades?.sh || 0),
      s: Number(grades?.s || 0),
      a: Number(grades?.a || 0),
    },
    badges,
    rank_history: rankHistory,
  };
}

async function loadPlayerSnapshot(osuId, force = false) {
  const { getUserById } = await import('./osu/api.js');
  const { getStoredProfile, setStoredProfile } = await import('./osu/profileStore.js');
  const stored = getStoredProfile(osuId);
  if (stored && !force) {
    return { fetchedAt: stored.fetchedAt, player: playerView(stored.user), stored: true };
  }
  const user = await getUserById(osuId, 'osu', { force });
  setStoredProfile(osuId, user);
  return { fetchedAt: getStoredProfile(osuId).fetchedAt, player: playerView(user), stored: false };
}

async function enrichScoreMetadata(rows) {
  const missing = rows.filter((row) => !row.title || row.title === '未知谱面');
  if (missing.length === 0) return;
  const { getBeatmap } = await import('./osu/api.js');
  await Promise.all(missing.map(async (row) => {
    if (!row.bid) return;
    try {
      const beatmap = await getBeatmap(row.bid);
      const beatmapset: any = (beatmap as any)?.beatmapset || {};
      row.title = String(beatmapset.title_unicode || beatmapset.title || row.title);
      row.artist = String(beatmapset.artist_unicode || beatmapset.artist || row.artist);
      row.mapper = String(beatmapset.creator || row.mapper);
      row.version = String(beatmap?.version || row.version);
      row.max_combo_total = Number(beatmap?.max_combo || row.max_combo_total);
    } catch { /* keep fallback values */ }
  }));
}

app.get('/api/osu/search', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '缺少玩家名' });
  try {
    const { getUser } = await import('./osu/api.js');
    const user = await getUser(name);
    res.json(ok({
      player: {
        id: Number(user?.id || 0),
        username: String(user?.username || ''),
        avatar_url: String(user?.avatar_url || ''),
      },
    }));
  } catch {
    res.status(404).json({ ok: false, error: `osu! 玩家 "${name}" 不存在` });
  }
});

app.get('/api/osu/player/:id', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    res.json(ok({ profile: await loadPlayerSnapshot(osuId) }));
  } catch (error) {
    res.status(404).json({ ok: false, error: `获取玩家失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

app.post('/api/osu/player/:id/refresh', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    res.json(ok({ profile: await loadPlayerSnapshot(osuId, true) }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `刷新失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

app.get('/api/osu/player/:id/bp', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  const start = Math.max(1, Math.min(100, Number(req.query.start) || 1));
  const end = Math.max(start, Math.min(100, Number(req.query.end) || Math.min(10, start + 9)));
  try {
    const { getUserBestScores } = await import('./osu/api.js');
    const { enrichScoreStarRatings } = await import('./osu/starRating.js');
    const raw = await getUserBestScores(osuId, 'osu', end);
    const enriched = (await enrichScoreStarRatings(raw, 'osu')).scores;
    const bp = enriched
      .slice(start - 1, end)
      .map((score, index) => consoleScoreRow(score, start + index));
    await enrichScoreMetadata(bp);
    res.json(ok({ bp, total: (raw || []).length, start, end }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `BP 获取失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

app.get('/api/osu/player/:id/recent', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
  try {
    const { getUserRecentScores } = await import('./osu/api.js');
    const { enrichScoreStarRatings } = await import('./osu/starRating.js');
    const raw = await getUserRecentScores(osuId, 'osu', limit);
    const enriched = (await enrichScoreStarRatings(raw, 'osu')).scores;
    const recent = enriched.map((score) => consoleScoreRow(score));
    await enrichScoreMetadata(recent);
    res.json(ok({ recent }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `最近成绩获取失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

app.get('/api/osu/player/:id/ppplus', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    const { getPlayerBars } = await import('./osu/pplus.js');
    const bars = await getPlayerBars(osuId);
    res.json(ok({ bars: bars || null }));
  } catch {
    res.json(ok({ bars: null }));
  }
});

app.get('/api/osu/player/:id/bptype', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    const { runBpTypeAnalysis } = await import('./bots/bpTypeAnalysis.js');
    const db = readDb();
    const stored = (await import('./osu/profileStore.js')).getStoredProfile(osuId);
    const username = stored?.user?.username || '';
    const text = await runBpTypeAnalysis(db, `console-${osuId}`, username);
    res.json(ok({ text }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `BP 类型分析失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

app.get('/api/osu/player/:id/skill', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  const db = readDb();
  const stored = (await import('./osu/profileStore.js')).getStoredProfile(osuId);
  const username = String(stored?.user?.username || '').toLowerCase();
  const record = (db.skillStore?.records || []).find(
    (r) => String(r.osuUsername || '').toLowerCase() === username,
  ) || null;
  res.json(ok({ record: record ? {
    osuUsername: record.osuUsername,
    pp: record.pp,
    rank: record.rank,
    accuracy: record.accuracy,
    playCount: record.playCount,
    hoursPlayed: record.hoursPlayed,
    ppPlus: record.ppPlus || null,
    topMods: record.topMods || [],
    summary: record.summary || '',
    recentSummary: record.recentSummary || '',
    lastAnalyzed: record.lastAnalyzed || '',
  } : null }));
});

app.get('/api/osu/player/:id/analyze', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  const { getStoredAnalysis } = await import('./osu/profileStore.js');
  res.json(ok({ analysis: getStoredAnalysis(osuId) }));
});

app.post('/api/osu/player/:id/analyze', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  const { getStoredAnalysis, setStoredAnalysis } = await import('./osu/profileStore.js');
  const existing = getStoredAnalysis(osuId);
  if (existing?.status === 'running') {
    return res.json(ok({ analysis: existing, started: false }));
  }

  let profile;
  try {
    profile = await loadPlayerSnapshot(osuId);
  } catch (error) {
    return res.status(404).json({ ok: false, error: `玩家获取失败：${String(error?.message || error).slice(0, 200)}` });
  }
  const username = profile.player.username;
  const entry = { status: 'running' as const, at: new Date().toISOString() };
  setStoredAnalysis(osuId, entry);

  // Console analyses bypass the QQ-side 4h cooldown; a per-player console id
  // only prevents double-starting the same player's analysis.
  void (async () => {
    try {
      const { handleOsuCommand } = await import('./osu/commands.js');
      const captured = [];
      const event = {
        userId: `console-${osuId}`,
        groupId: 'console',
        atTargets: [],
        text: `/w osu analyze ${username}`,
      };
      const result: any = await handleOsuCommand(
        event,
        async (_e, text) => { captured.push(String(text || '')); },
        { isOwner: true, isAdmin: true },
        'analyze',
        `analyze ${username}`,
        { bypassCooldown: true },
      );
      // Long reports go through a merge-forward card whose body bypasses the
      // text stub; handleOsuCommand still resolves with the full report text.
      const reportText = String(result?.text || '') || captured.join('\n\n');
      setStoredAnalysis(osuId, {
        status: 'done',
        at: entry.at,
        finishedAt: new Date().toISOString(),
        text: reportText,
      });
    } catch (error) {
      setStoredAnalysis(osuId, {
        status: 'error',
        at: entry.at,
        finishedAt: new Date().toISOString(),
        error: String(error?.message || error),
      });
    }
  })();

  res.json(ok({ analysis: { status: 'running', at: entry.at }, started: true }));
});

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
    settings: publicDb(db).settings,
    groups: db.groups,
    users: db.users,
    memories: db.memories,
    usage: db.usage,
    recentMessages: db.messages.slice(-120),
    recentDecisions: db.decisions.slice(-160),
    recentCommandLogs: (db.commandLogs || []).slice(-160),
    recentAdminActions: db.adminActions.slice(-80)
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="qq-ai-chatbot-diagnostics-${Date.now()}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

app.post('/api/settings', (req, res) => {
  updateDb((db) => {
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
    db.settings.oneBotAccessToken = keepSecret('oneBotAccessToken') ? previousOneBotToken : incoming.oneBotAccessToken;
    db.settings.adminPassword = keepSecret('adminPassword') ? previousAdminPassword : incoming.adminPassword;
    db.settings.osuClientSecret = keepSecret('osuClientSecret') ? previousOsuSecret : incoming.osuClientSecret;
    db.settings.pplusClientSecret = keepSecret('pplusClientSecret') ? previousPplusSecret : incoming.pplusClientSecret;
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
  res.json(ok({ db: publicDb() }));
});

app.post('/api/search/test-local', async (_req, res) => {
  const testUrl = 'http://127.0.0.1:8080/search?q=test&format=json';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch(testUrl, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || (!data.results && !data.query && data.results === undefined)) {
      throw new Error('响应格式不符合 SearXNG');
    }
    res.json(ok({ baseUrl: 'http://127.0.0.1:8080' }));
  } catch (e) {
    const reason = e.name === 'AbortError'
      ? '连接超时，本地搜索服务未响应'
      : `未检测到本地搜索服务（${e.message || String(e)}）`;
    res.json(ok({
      baseUrl: null,
      message: `${reason}。如果你没有安装本地搜索服务，聊天功能不受影响，只是无法联网搜索。`
    }));
  } finally {
    clearTimeout(timer);
  }
});

app.post('/api/groups', (req, res) => {
  const groupId = identifier(req.body?.groupId, '群号', res);
  if (!groupId) return;
  const mode = String(req.body?.mode || 'mention');
  if (!GROUP_MODES.has(mode)) return res.status(400).json({ ok: false, error: '无效的群回复模式' });
  const maxPerHour = rangedInteger(req.body?.maxPerHour, 20, 1, 200, '每小时回复上限', res);
  if (maxPerHour === null) return;
  const cooldownSec = rangedInteger(req.body?.cooldownSec, 30, 0, 600, '冷却秒数', res);
  if (cooldownSec === null) return;
  updateDb((db) => {
    upsertBy(db.groups, 'groupId', {
      groupId,
      name: limitedText(req.body?.name || groupId, 100),
      enabled: Boolean(req.body?.enabled),
      mode,
      maxPerHour,
      cooldownSec
    });
  });
  res.json(ok({ db: publicDb() }));
});

app.delete('/api/groups/:groupId', (req, res) => {
  updateDb((db) => {
    db.groups = db.groups.filter((group) => String(group.groupId) !== String(req.params.groupId));
  });
  res.json(ok({ db: publicDb() }));
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
  res.json(ok({ db: publicDb() }));
});

app.delete('/api/users/:groupId/:userId', (req, res) => {
  updateDb((db) => {
    db.users = db.users.filter(
      (user) => !(String(user.groupId) === String(req.params.groupId) && String(user.userId) === String(req.params.userId))
    );
  });
  res.json(ok({ db: publicDb() }));
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
  res.json(ok({ db: publicDb() }));
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
    const result = await updateMemoryProfile(db, memory);
    const outcome = commitMemoryProfileResult(userId, result, {
      model: db.settings.model,
      kind: 'memory-manual-recalc'
    });
    res.json(ok({ outcome, runId: result.runId, usage: result.usage || {}, db: publicDb() }));
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
    res.status(400).json({ ok: false, error: error.message || String(error), db: publicDb() });
  }
});

app.delete('/api/memories/:userId', (req, res) => {
  updateDb((db) => {
    db.memories = (db.memories || []).filter((memory) => String(memory.userId) !== String(req.params.userId));
  });
  res.json(ok({ db: publicDb() }));
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
  res.json(ok({ result, db: publicDb() }));
});

// Decision sandbox — reads DB, applies overrides, returns decision+context, never writes
app.post('/api/sandbox', async (req, res) => {
  const body = req.body || {};
  const db = readDb();
  const groupId = String(body.groupId || (db.groups[0]?.groupId) || '10001');
  const userId = String(body.userId || 'sandbox-user');
  const nickname = body.nickname || 'SandboxUser';
  const text = String(body.text || '你好');
  const atTargets = body.atTargets || [];

  // Build overrides
  const policyOverride = body.memberPolicy || null;
  const modeOverride = body.groupMode || null;
  const useMemory = body.useMemory !== false;
  const useGroupProfile = body.useGroupProfile !== false;
  const useRelationship = body.useRelationship !== false;
  const callLlm = body.callLlm === true;

  // Get real or overridden data
  const group = db.groups.find((g) => String(g.groupId) === groupId) || { groupId, name: `群 ${groupId}`, enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 };
  if (modeOverride) group.mode = modeOverride;
  let userPolicy = db.users.find((u) => String(u.groupId) === groupId && String(u.userId) === userId) || { policy: 'normal', attentionLevel: 3, allowCommands: false };
  if (policyOverride) userPolicy = { ...userPolicy, policy: policyOverride };
  if (String(userId) === String(db.settings.ownerQq)) userPolicy = { policy: 'owner', attentionLevel: 5, allowCommands: true };

  // Text mentions
  const botNames = String(db.settings.botNames || 'Wuxin').split(',');
  const selfQq = db.settings.selfQq || '';
  const mentioned = atTargets.includes(selfQq) || botNames.some((n) => text.includes(n)) || text.includes(`[CQ:at,qq=${selfQq}]`);

  // Decision
  const decision = await decideReply({ db, group, userPolicy, text, mentioned, userId });

  // Context preview
  const sandboxEvent = { type: 'group', groupId, userId, nickname, text, atTargets };
  const messages = buildPrompt(db, group, sandboxEvent, userPolicy);
  const promptPreview = messages.map((m) => `[${m.role}]\n${m.content.slice(0, 500)}`).join('\n\n---\n\n').slice(0, 3000);

  // Profile previews
  const memory = useMemory ? (db.memories || []).find((m) => String(m.userId) === userId) : null;
  const rawGroupProfile = useGroupProfile ? (db.groupProfiles || []).find((p) => String(p.groupId) === groupId) : null;
  const gp = rawGroupProfile && hasGroupProfileContent(rawGroupProfile) ? rawGroupProfile : null;
  const rels = useRelationship ? (db.relationshipProfiles || []).filter((p) => String(p.groupId) === groupId && (p.userA === userId || p.userB === userId)) : [];

  // Optional LLM call
  let replyPreview = '';
  let usage = null;
  if (callLlm && decision.shouldReply) {
    try {
      const ai = await callLLM(db, messages.slice(-10), db.settings.enableWebSearch ? (db.settings.webSearchMode || 'balanced') : null, { maxTokens: 300 });
      replyPreview = ai.text || '';
      usage = ai.usage || null;
    } catch (e) { replyPreview = `LLM 调用失败: ${e.message}`; }
  }

  res.json(ok({
    decision: { shouldReply: decision.shouldReply, reason: decision.reason },
    context: {
      group: `${group.name || groupId} (${group.mode})`,
      userPolicy: userPolicy.policy,
      memoryProfile: memory ? { summary: memory.summary?.slice(0, 80), traits: memory.traits?.slice(0, 60) } : null,
      groupProfile: gp ? { atmosphere: gp.atmosphere?.slice(0, 60), confidence: gp.confidence } : null,
      relationshipProfiles: rels.map((r) => ({ pair: `${r.userA}↔${r.userB}`, style: r.interactionStyle?.slice(0, 40) })),
    },
    promptPreview,
    replyPreview,
    usage,
  }));
});

app.post('/api/clear-context/:groupId', (req, res) => {
  updateDb((db) => {
    // Context cleanup only removes message memory and decision logs. It keeps
    // prompts, model settings, groups, members, and usage counters intact.
    db.messages = db.messages.filter((message) => String(message.groupId) !== String(req.params.groupId));
    db.decisions = db.decisions.filter((decision) => String(decision.groupId) !== String(req.params.groupId));
    db.commandLogs = (db.commandLogs || []).filter((log) => String(log.groupId) !== String(req.params.groupId));
  });
  res.json(ok({ db: publicDb() }));
});

app.post('/api/clear-context', (_req, res) => {
  updateDb((db) => {
    db.messages = [];
    db.decisions = [];
    db.commandLogs = [];
  });
  res.json(ok({ db: publicDb() }));
});

// Health
app.get('/api/health', (_req, res) => {
  const health: any = getHealth();
  health.replyQueues = getReplyQueueStats();
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

function displayNameForUser(db, groupId, userId) {
  const u = (db.users || []).find((x) => String(x.userId) === String(userId) && String(x.groupId) === String(groupId));
  if (u?.customName) return u.customName;
  if (u?.nickname) return u.nickname;
  const mem = (db.memories || []).find((m) => String(m.userId) === String(userId));
  if (mem?.nickname) return mem.nickname;
  const recent = [...(db.messages || [])].reverse().find((m) => String(m.userId) === String(userId) && m.nickname);
  if (recent?.nickname) return recent.nickname;
  return String(userId);
}

app.get('/api/relationship-profiles', (_req, res) => {
  const db = readDb();
  const profiles = (db.relationshipProfiles || [])
    .filter(isSubstantiveRelationshipProfile)
    .map((p) => ({
      ...p,
      groupName: db.groups?.find((g) => String(g.groupId) === String(p.groupId))?.name || p.groupId,
      userAName: displayNameForUser(db, p.groupId, p.userA),
      userBName: displayNameForUser(db, p.groupId, p.userB),
    }));
  const pendingPairCounts = db.pendingPairCounts || {};
  const candidates = Object.entries(pendingPairCounts)
    .map(([key, count]) => {
      const parts = String(key).split(':');
      if (parts.length !== 3 || Number(count) <= 0) return null;
      const [groupId, userA, userB] = parts;
      const pairKey = relationshipPairKey(userA, userB);
      if (profiles.some((p) => String(p.groupId) === groupId && p.pairKey === pairKey)) return null;
      return {
        groupId, userA, userB, pairKey, count: Number(count),
        groupName: db.groups?.find((g) => String(g.groupId) === groupId)?.name || groupId,
        userAName: displayNameForUser(db, groupId, userA),
        userBName: displayNameForUser(db, groupId, userB),
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
  res.json(ok({ logs, stats }));
});

// Backup routes
app.get('/api/backups', (_req, res) => {
  res.json(ok({ backups: listBackups() }));
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
  res.json(ok({ restored: result.name }));
});

app.delete('/api/backups/:name', (req, res) => {
  const result = deleteBackup(req.params.name);
  if (!result.ok) return res.status(404).json({ ok: false, error: result.error });
  res.json(ok({ deleted: req.params.name }));
});

// Auto-prune on startup, then auto-backup every 8 hours
pruneAutoBackups();
setInterval(() => { createBackup('auto'); pruneAutoBackups(); }, 8 * 60 * 60 * 1000);

// Auto-evaluate trust scores every 4 hours (legacy compat)
setInterval(() => { evaluateTrustScores(); }, 4 * 60 * 60 * 1000);
// Decay XP for inactive users every 6 hours
setInterval(() => { decayInactiveUsers(); }, 6 * 60 * 60 * 1000);

const port = Number(process.env.PORT || 8787);
// Recalc progress
app.get('/api/recalc-status', (_req, res) => { res.json(ok(getRecalcProgress())); });

app.post('/api/recalc', (_req, res) => {
  const state = getRecalcProgress();
  if (state.running) return res.json({ ok: false, error: '已经在重算中' });
  // Start in background
  void (async () => {
    const db = readDb();
    const mems = (db.memories || []).filter((m) => m.enabled && (m.samples || []).filter((s) => s.usedForProfile).length >= 3);
    const gps = (db.groups || []).filter((g) => g.enabled);
    const rels = (db.relationshipProfiles || []).filter((r) => r.enabled !== false);
    const total = mems.length + gps.length + rels.length;
    startRecalc(total, '正在重算全部画像');
    const { updateMemoryProfile } = await import('./bot/memory.js');
    const { updateGroupProfile } = await import('./bot/groupProfile.js');
    const { updateRelationshipProfile } = await import('./bot/relationshipProfile.js');
    for (const mem of mems) {
      if (getRecalcProgress().stopped) break;
      try {
        const latestDb = readDb();
        const result = await updateMemoryProfile(latestDb, mem);
        commitMemoryProfileResult(mem.userId, result, { model: latestDb.settings.model, kind: 'memory-recalc' });
      } catch { /* skip */ }
      tickRecalc();
    }
    for (const g of gps) {
      if (getRecalcProgress().stopped) break;
      try { await updateGroupProfile(readDb(), g.groupId); } catch { /* skip */ }
      tickRecalc();
    }
    for (const rp of rels) {
      if (getRecalcProgress().stopped) break;
      try { await updateRelationshipProfile(readDb(), rp.groupId, rp.userA, rp.userB); } catch { /* skip */ }
      tickRecalc();
    }
    finishRecalc(getRecalcProgress().stopped ? '已停止' : '全部重算完成');
  })();
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
  updateDb((db) => {
    if (!restoreConfigSnapshot(db, index)) return res.status(400).json({ ok: false, error: '无效的快照索引' });
    res.json(ok({ restored: true }));
  });
});

// JSON error handler — never return HTML error pages to the GUI
app.use((err, _req, res, _next) => {
  const message = err?.message || String(err || '未知错误');
  res.status(err?.status || err?.statusCode || 500).json({ ok: false, error: message });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`QQ AI ChatBot server running at http://127.0.0.1:${port}`);
  connectOneBot();
  // Start Wuxin's local yumu-image endpoint on 8389. The renderer keeps its
  // original 8388 connection and opens this second connection independently.
  startRenderServer(8389);
});
