import type { Express } from 'express';
import { readDb, updateDb } from '../../store.js';
import { activeOwnerDirectives, correctSocialPreferences, readSocialPerson, readSocialView, revertSocialTransition } from './state.js';
import { readAffinityRanking, socialMemberNames } from './ranking.js';
import { participationStatus } from './policy.js';
import { correctSelfExperience, finishSelfFocus, readPippiSelf, selfScopeVisible } from './self.js';
import { pippiActivityStatus } from '../activity.js';

const validScope = (scope: unknown): scope is string => typeof scope === 'string' && /^(group|private):[\w-]{1,64}$/.test(scope);
/** Mounted only after the existing console authentication middleware. */
export function mountSocialApi(app: Express) {
  app.get('/api/social/self', (req, res) => {
    const scope = String(req.query.scope || 'public');
    if (scope !== 'public' && !validScope(scope)) return res.status(400).json({ ok: false, error: '经历范围无效' });
    const db = readDb(), self = readPippiSelf(db);
    const all = self.experiences.filter(e => selfScopeVisible(e.scope, scope)).slice().reverse();
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    res.json({ ok: true, self: { revision: self.revision, mood: self.mood, focus: self.focus, updatedAt: self.updatedAt },
      experiences: all.slice(offset, offset + 30), total: all.length, activity: pippiActivityStatus(db) });
  });
  const editExperience = (req, res) => {
    if (!Number.isSafeInteger(req.body?.revision)) return res.status(400).json({ ok: false, error: '缺少经历版本' });
    try {
      updateDb(db => correctSelfExperience(db, String(req.params.id), req.body.revision,
        req.method === 'DELETE' ? { remove: true } : { fact: req.body.fact, impression: req.body.impression }));
      res.json({ ok: true });
    } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  };
  app.patch('/api/social/self/experiences/:id', editExperience);
  app.delete('/api/social/self/experiences/:id', editExperience);
  app.post('/api/social/self/focus/:id/end', (req, res) => {
    if (!Number.isSafeInteger(req.body?.revision)) return res.status(400).json({ ok: false, error: '缺少近况版本' });
    try { updateDb(db => finishSelfFocus(db, String(req.params.id), req.body.revision)); res.json({ ok: true }); }
    catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.get('/api/social', (req, res) => {
    const db = readDb(), scope = String(req.query.scope || '');
    if (!validScope(scope)) return res.status(400).json({ ok: false, error: '请选择一个会话' });
    const rankScope = String(req.query.rankScope || 'conversation');
    if (!['conversation', 'global'].includes(rankScope)) return res.status(400).json({ ok: false, error: '排名范围不正确' });
    const selected = String(req.query.userId || ''), query = String(req.query.q || '').slice(0, 80).toLowerCase();
    const state = db.socialV2;
    const ids = [...new Set([String(db.settings.ownerQq || ''), ...Object.keys(state.people)])].filter(Boolean);
    const names = socialMemberNames(db, scope);
    const people = ids.map((userId) => {
      return { ...readSocialPerson(db, userId), nickname: names.get(userId) || userId,
        view: readSocialView(db, scope, userId) };
    }).filter((p) => !query || `${p.userId} ${p.nickname}`.toLowerCase().includes(query));
    const selectedPerson = people.find((p) => p.userId === selected);
    const visiblePeople = people.slice(0, 200);
    if (selectedPerson && !visiblePeople.includes(selectedPerson)) visiblePeople.push(selectedPerson);
    const decisions = state.decisions.filter((d) => d.scope === scope && (!selected || d.userId === selected)).slice(-80).reverse();
    const recent = state.decisions.filter((d) => d.scope === scope && Date.now() - Date.parse(d.createdAt) < 3600_000);
    const ambient = state.decisions.filter((d) => d.scope === scope && d.engagement === 'ambient');
    const group = db.groups.find((g) => `group:${g.groupId}` === scope);
    res.json({ ok: true, revision: state.revision, people: visiblePeople, decisions,
      participation: group ? participationStatus(db, group) : { mode: db.settings.globalPaused ? 'silent' : 'private', reason: db.settings.globalPaused ? '全局暂停中' : '' },
      activity: { lastAssessmentAt: ambient.filter((d) => d.stage === 'assessment').at(-1)?.createdAt || null,
        lastReplyAt: ambient.filter((d) => d.stage === 'delivery' && d.action !== 'pass').at(-1)?.createdAt || null,
        reasons: Object.entries(recent.reduce((out, d) => { const key = d.stage === 'guard' ? d.reason : `${d.stage}:${d.action}`;
          out[key] = (out[key] || 0) + 1; return out; }, {} as Record<string, number>)).map(([reason, count]) => ({ reason, count })) },
      ranking: readAffinityRanking(db, rankScope === 'global' ? null : scope, 200),
      transitions: state.transitions.filter((t) => t.scope === scope && (!selected || t.userId === selected)).slice(-60).reverse(),
      feedback: state.feedback.filter((f) => decisions.some((d) => d.id === f.decisionId)),
      directives: activeOwnerDirectives(db, scope),
      usage: { calls: recent.filter((d) => d.stage === 'assessment' || d.stage === 'revalidation' || d.stage === 'failure').length,
        tokens: recent.reduce((sum, d) => sum + d.totalTokens, 0) } });
  });

  app.post('/api/social/feedback', (req, res) => {
    const { decisionId, verdict, note = '' } = req.body || {};
    if (!['should-reply', 'should-pass'].includes(verdict) || typeof decisionId !== 'string' || typeof note !== 'string' || note.length > 300) return res.status(400).json({ ok: false, error: '反馈格式不正确' });
    if (!readDb().socialV2.decisions.some((d) => d.id === decisionId)) return res.status(404).json({ ok: false, error: '决策记录已过期' });
    updateDb((db) => {
      db.socialV2.feedback = [...db.socialV2.feedback.filter((f) => f.decisionId !== decisionId),
        { id: crypto.randomUUID(), decisionId, verdict, note, createdAt: new Date().toISOString() }].slice(-1000);
      db.socialV2.revision++;
    });
    res.json({ ok: true });
  });

  app.post('/api/social/revert', (req, res) => {
    try {
      if (typeof req.body?.transitionId !== 'string') throw new Error('缺少变化记录');
      updateDb((db) => revertSocialTransition(db, req.body.transitionId));
      res.json({ ok: true });
    } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
  app.patch('/api/social/preferences', (req, res) => {
    const { userId, scope, preferredNames, style, revision } = req.body || {};
    if (typeof userId !== 'string' || !/^[\w-]{1,64}$/.test(userId) || !validScope(scope) || !Number.isSafeInteger(revision)) return res.status(400).json({ ok: false, error: '缺少成员、会话或版本信息' });
    try {
      updateDb((db) => correctSocialPreferences(db, userId, scope, preferredNames, style, revision));
      res.json({ ok: true });
    } catch (error) { res.status(409).json({ ok: false, error: error.message }); }
  });
}
