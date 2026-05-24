import 'dotenv/config';
import express from 'express';
import { ensureStore, publicDb, readDb, updateDb, upsertBy, nowIso, saveConfigSnapshot, listConfigSnapshots, restoreConfigSnapshot } from './store.js';
import { createBackup, listBackups, restoreBackup, deleteBackup, pruneAutoBackups } from './backup.js';
import { connectOneBot, getOneBotStatus, sendOneBotMessage } from './onebot.js';
import { oneBotToInternal, processIncoming, decideReply } from './bot.js';
import { buildPrompt } from './bot/prompt.js';
import { callLLM } from './bot/llm.js';
import { getHealth, getRecalcProgress, startRecalc, tickRecalc, stopRecalc, finishRecalc } from './health.js';
import { getGroupProfile, updateGroupProfile, clearGroupProfile } from './bot/groupProfile.js';
import { evaluateTrustScores } from './bot/trust.js';

ensureStore();

const app = express();
app.use(express.json({ limit: '2mb' }));

// Express is only the local GUI/API layer. QQ events enter through OneBot's
// WebSocket in onebot.ts; /api/onebot/event exists for manual testing or
// alternative webhook setups.
function ok(data = {}) {
  return { ok: true, ...data };
}

app.get('/api/state', (_req, res) => {
  res.json(ok({ db: publicDb(), oneBot: getOneBotStatus() }));
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
  updateDb((db) => { saveConfigSnapshot(db); }); // Snapshot before change
  updateDb((db) => {
    const incoming = req.body || {};
    // Empty/placeholder secret fields mean "keep the current value". Without
    // this, opening the GUI and saving a page would wipe API keys/tokens.
    const keepSecret = (field) => incoming[field] === undefined || incoming[field] === '' || incoming[field] === '已填写' || incoming[field] === '已设置';
    db.settings = {
      ...db.settings,
      ...incoming,
      apiKey: keepSecret('apiKey') ? db.settings.apiKey : incoming.apiKey,
      oneBotAccessToken: keepSecret('oneBotAccessToken') ? db.settings.oneBotAccessToken : incoming.oneBotAccessToken,
      adminPassword: keepSecret('adminPassword') ? db.settings.adminPassword : incoming.adminPassword
    };
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
  updateDb((db) => {
    upsertBy(db.groups, 'groupId', {
      groupId: String(req.body.groupId || '').trim(),
      name: req.body.name || req.body.groupId,
      enabled: Boolean(req.body.enabled),
      mode: req.body.mode || 'mention',
      maxPerHour: Number(req.body.maxPerHour || 20),
      cooldownSec: Number(req.body.cooldownSec || 30)
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
  updateDb((db) => {
    const existingIndex = db.users.findIndex(
      (user) => String(user.groupId) === String(req.body.groupId) && String(user.userId) === String(req.body.userId)
    );
    const entry = {
      groupId: String(req.body.groupId || '').trim(),
      userId: String(req.body.userId || '').trim(),
      nickname: req.body.nickname || req.body.userId,
      policy: req.body.policy || 'normal',
      attentionLevel: Number(req.body.attentionLevel || 3),
      allowCommands: Boolean(req.body.allowCommands),
      commandRoleId: req.body.commandRoleId || '',
      note: req.body.note || '',
      customPrompt: req.body.customPrompt || '',
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
  updateDb((db) => {
    if (!db.memories) db.memories = [];
    const userId = String(req.params.userId || '').trim();
    const existingIndex = db.memories.findIndex((memory) => String(memory.userId) === userId);
    const incoming = req.body || {};
    const entry = {
      userId,
      nickname: incoming.nickname || userId,
      enabled: incoming.enabled !== false,
      importanceLevel: Number(incoming.importanceLevel || 2),
      importanceLabel: incoming.importanceLabel || '',
      summary: incoming.summary || '',
      traits: incoming.traits || '',
      speechStyle: incoming.speechStyle || '',
      behavior: incoming.behavior || '',
      preferences: incoming.preferences || '',
      manualNotes: incoming.manualNotes || '',
      updatedAt: nowIso()
    };
    if (existingIndex >= 0) db.memories[existingIndex] = { ...db.memories[existingIndex], ...entry };
    else db.memories.push({ ...entry, id: crypto.randomUUID(), messageCount: 0, pendingCount: 0, groupsSeen: [], samples: [], createdAt: nowIso() });
  });
  res.json(ok({ db: publicDb() }));
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
  const result = await processIncoming(oneBotToInternal(req.body), sendOneBotMessage);
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
  const decision = decideReply({ db, group, userPolicy, text, mentioned, userId });

  // Context preview
  const sandboxEvent = { type: 'group', groupId, userId, nickname, text, atTargets };
  const messages = buildPrompt(db, group, sandboxEvent, userPolicy);
  const promptPreview = messages.map((m) => `[${m.role}]\n${m.content.slice(0, 500)}`).join('\n\n---\n\n').slice(0, 3000);

  // Profile previews
  const memory = useMemory ? (db.memories || []).find((m) => String(m.userId) === userId) : null;
  const gp = useGroupProfile ? (db.groupProfiles || []).find((p) => String(p.groupId) === groupId) : null;
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
  res.json(getHealth());
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

// Backup routes
app.get('/api/backups', (_req, res) => {
  res.json(ok({ backups: listBackups() }));
});

app.post('/api/backups', (req, res) => {
  const type = req.body?.type || 'manual';
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

// Auto-evaluate trust scores every 4 hours
setInterval(() => { evaluateTrustScores(); }, 4 * 60 * 60 * 1000);

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
      try { await updateMemoryProfile(db, mem); } catch { /* skip */ }
      tickRecalc();
    }
    for (const g of gps) {
      if (getRecalcProgress().stopped) break;
      try { const r = await updateGroupProfile(readDb(), g.groupId); if (!r.ok) tickRecalc(); } catch { /* skip */ }
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
});
