// osu! console API routes and their read-only view helpers. Extracted from server/index.ts.
import net from 'node:net';
import type { Express } from 'express';
import { readDb, updateDb } from '../store.js';
import { getHealth } from '../health.js';
import { getRenderServer } from '../bots/renderServer.js';
import { removeLazybotBinding, syncLazybotBinding } from '../bots/bindingSync.js';
import { ok } from './helpers.js';

export function mountOsuRoutes(app: Express) {function tcpProbe(port, host = '127.0.0.1', timeoutMs = 800) {
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

app.get('/api/osu/status', async (_req, res) => {
  const db = readDb();
  const health = getHealth();
  const botPorts = { yumu: 8388, kanon: 7700, hydrant: 8800, lazybot: 1145 };
  const bots = [];
  for (const [id, port] of Object.entries(botPorts)) {
    bots.push({ id, port, up: await tcpProbe(Number(port)) });
  }

  const osuLogs = (db.commandLogs || []).filter((c) => String(c.command || '') === '/osu');
  const bindCount = osuLogs.filter((c) => String(c.subCommand || '') === 'bind').length;

  res.json(ok({
    health: { api429Count: health.osu.api429Count, renderFailures: health.osu.renderFailures },
    bots,
    renderer: {
      listeningPort: getRenderServer().getListeningPort(),
      hasClients: getRenderServer().hasClients(),
    },
    bindings: osuBindingList(db),
    stats: {
      bindCount,
    },
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
    const syncResult = await removeLazybotBinding(qqStr);
    if (!syncResult.ok && !syncResult.skipped) {
      console.error(`[bind] GUI LazyBot 解绑同步失败: ${syncResult.error || '未知错误'}`);
    }
    return res.json(ok({ bindings: osuBindingList() }));
  }
  const name = String(username || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '缺少 osu 用户名' });
  try {
    const { getUser } = await import('../osu/api.js');
    const user = await getUser(name);
    if (!user?.id) throw new Error('用户不存在');
    updateDb((db) => {
      db.osuBindings = db.osuBindings || {};
      db.osuBindings[qqStr] = { id: user.id, username: String(user.username || name) };
    });
    const syncResult = await syncLazybotBinding(qqStr, {
      id: user.id,
      username: String(user.username || name),
    });
    if (!syncResult.ok && !syncResult.skipped) {
      console.error(`[bind] GUI LazyBot 绑定同步失败: ${syncResult.error || '未知错误'}`);
    }
    res.json(ok({ bindings: osuBindingList() }));
  } catch {
    res.status(400).json({ ok: false, error: `osu! 用户 "${name}" 查不到。` });
  }
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
  const { getUserById } = await import('../osu/api.js');
  const { getStoredProfile, setStoredProfile } = await import('../osu/profileStore.js');
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
  const { getBeatmap } = await import('../osu/api.js');
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
    const { getUser } = await import('../osu/api.js');
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
    const { getUserBestScores } = await import('../osu/api.js');
    const { enrichScoreStarRatings } = await import('../osu/starRating.js');
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
    const { getUserRecentScores } = await import('../osu/api.js');
    const { enrichScoreStarRatings } = await import('../osu/starRating.js');
    const raw = await getUserRecentScores(osuId, 'osu', limit);
    const enriched = (await enrichScoreStarRatings(raw, 'osu')).scores;
    const recent = enriched.map((score) => consoleScoreRow(score));
    await enrichScoreMetadata(recent);
    res.json(ok({ recent }));
  } catch (error) {
    res.status(502).json({ ok: false, error: `最近成绩获取失败：${String(error?.message || error).slice(0, 200)}` });
  }
});

// `/pplus` is the canonical spelling used by the GUI and documentation.
// Keep the accidentally shipped `/ppplus` path as a compatibility alias.
app.get(['/api/osu/player/:id/pplus', '/api/osu/player/:id/ppplus'], async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    const { getPlayerBars } = await import('../osu/pplus.js');
    const bars = await getPlayerBars(osuId);
    res.json(ok({ bars: bars || null, status: bars ? 'completed' : 'no_scores' }));
  } catch (error) {
    res.status(502).json({ ok: false, code: error?.code || 'UNAVAILABLE', error: String(error?.message || 'PP+ 获取失败') });
  }
});

app.get('/api/osu/player/:id/bptype', async (req, res) => {
  const osuId = osuIdParam(req, res);
  if (osuId === null) return;
  try {
    const { runBpTypeAnalysis } = await import('../bots/bpTypeAnalysis.js');
    const db = readDb();
    const stored = (await import('../osu/profileStore.js')).getStoredProfile(osuId);
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
  const stored = (await import('../osu/profileStore.js')).getStoredProfile(osuId);
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

}
