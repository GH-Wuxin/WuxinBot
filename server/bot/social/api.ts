import type { Express } from 'express';
import { readDb, updateDb } from '../../store.js';
import { activeOwnerDirectives, correctSocialPreferences, readSocialPerson, readSocialView, revertSocialTransition } from './state.js';

const validScope = (scope: unknown): scope is string => typeof scope === 'string' && /^(group|private):[\w-]{1,64}$/.test(scope);
/** Mounted only after the existing console authentication middleware. */
export function mountSocialApi(app: Express) {
  app.get('/api/social', (req, res) => {
    const db = readDb(), scope = String(req.query.scope || '');
    if (!validScope(scope)) return res.status(400).json({ ok: false, error: '请选择一个会话' });
    const selected = String(req.query.userId || ''), query = String(req.query.q || '').slice(0, 80).toLowerCase();
    const state = db.socialV2;
    const ids = [...new Set([String(db.settings.ownerQq || ''), ...Object.keys(state.people)])].filter(Boolean);
    const people = ids.map((userId) => {
      const member = db.users.find((u) => u.userId === userId && `group:${u.groupId}` === scope);
      const message = [...db.messages].reverse().find((m) => m.userId === userId && (m.type === 'group' ? `group:${m.groupId}` : `private:${m.userId}`) === scope);
      return { ...readSocialPerson(db, userId), nickname: member?.nickname || message?.nickname || userId,
        view: readSocialView(db, scope, userId) };
    }).filter((p) => !query || `${p.userId} ${p.nickname}`.toLowerCase().includes(query)).slice(0, 200);
    const decisions = state.decisions.filter((d) => d.scope === scope && (!selected || d.userId === selected)).slice(-80).reverse();
    const recent = state.decisions.filter((d) => d.scope === scope && Date.now() - Date.parse(d.createdAt) < 3600_000);
    res.json({ ok: true, revision: state.revision, people, decisions,
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
