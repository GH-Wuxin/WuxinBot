// Auto trust scoring — rules-based, no LLM.
// Scores are computed from message signals and memory sample quality.
import { readDb, updateDb, nowIso } from '../store.js';
import { extractSignals, computeInteractionDiversity, countRecentNegativeSignals } from './signals.js';

export function getTrustMeta(db, userId) {
  if (!db.trustScores) db.trustScores = {};
  return db.trustScores[String(userId)] || {
    score: 0, level: 'normal', activeDays: 0, realTextCount: 0,
    interactionDiversity: 0, positiveSignals: [], negativeSignals: [],
    lastEvaluatedAt: '', promotedAt: '',
  };
}

export function processTrustSignal(event, db) {
  const userId = String(event.userId);
  // Owner and admin are never auto-scored
  if (userId === String(db.settings.ownerQq)) return;
  const user = (db.users || []).find((u) => String(u.groupId) === String(event.groupId) && String(u.userId) === userId);
  if (user && (user.policy === 'admin' || user.policy === 'blocked' || user.policy === 'muted')) return;

  const signals = extractSignals(event, db);
  if (!signals.isRealText) return; // Only real text counts

  updateDb((draft) => {
    if (!draft.trustScores) draft.trustScores = {};
    const key = String(userId);
    let meta = draft.trustScores[key];
    if (!meta) {
      meta = {
        score: 0, level: 'normal', activeDays: 0, realTextCount: 0,
        interactionDiversity: 0, positiveSignals: [], negativeSignals: [],
        lastEvaluatedAt: '', promotedAt: '',
      };
      draft.trustScores[key] = meta;
    }

    meta.realTextCount = (meta.realTextCount || 0) + 1;

    // Negative signals
    if (signals.hasPromptInjection) {
      meta.score = Math.max(0, (meta.score || 0) - 15);
      meta.negativeSignals = [...(meta.negativeSignals || []), 'prompt-injection'].slice(-5);
    }
    if (signals.isAdversarial) {
      meta.score = Math.max(0, (meta.score || 0) - 10);
      meta.negativeSignals = [...(meta.negativeSignals || []), 'adversarial-test'].slice(-5);
    }

    // Positive signals: @ing others (social interaction)
    if (signals.mentionsCount > 0 && !signals.hasPromptInjection) {
      meta.score = Math.min(100, (meta.score || 0) + 2);
    }
  });
}

export function evaluateTrustScores(groupId) {
  const db = readDb();
  const messages = db.messages || [];
  const memories = db.memories || [];
  const now = Date.now();

  updateDb((draft) => {
    if (!draft.trustScores) draft.trustScores = {};

    for (const [userId, meta] of Object.entries(draft.trustScores)) {
      if (String(userId) === String(db.settings.ownerQq)) continue;
      const user = (db.users || []).find((u) => String(u.userId) === userId);
      if (user && (user.policy === 'admin' || user.policy === 'blocked' || user.policy === 'muted')) {
        meta.score = 0; meta.level = 'normal'; continue;
      }

      // Active days
      const userMsgs = messages.filter((m) => String(m.userId) === userId && m.role === 'user');
      const uniqueDays = new Set(userMsgs.map((m) => (m.createdAt || '').slice(0, 10)));
      meta.activeDays = uniqueDays.size;

      // Interaction diversity
      meta.interactionDiversity = computeInteractionDiversity(messages, userId);

      // Negative signals from memory
      const mem = memories.find((m) => String(m.userId) === userId);
      const negativeCount = mem ? countRecentNegativeSignals(mem.samples, 7) : 0;

      // Compute score
      let score = 0;
      score += Math.min(30, meta.activeDays * 5);
      score += Math.min(20, Math.floor((meta.realTextCount || 0) / 5));
      score += Math.min(24, meta.interactionDiversity * 6);
      score -= negativeCount * 10;
      meta.score = Math.max(0, Math.min(100, score));

      // Level determination
      if (meta.score >= 70 && meta.activeDays >= 3 && meta.realTextCount >= 30 && meta.interactionDiversity >= 3 && negativeCount === 0) {
        if (meta.level !== 'trusted') { meta.level = 'trusted'; meta.promotedAt = nowIso(); }
      } else if (meta.score >= 50 && meta.activeDays >= 2) {
        meta.level = meta.level === 'trusted' ? 'trusted' : 'candidate';
      } else if (meta.score < 45) {
        meta.level = 'normal';
      }

      meta.lastEvaluatedAt = nowIso();
    }
  });
}

export function isTrustedMember(db, userId) {
  const meta = getTrustMeta(db, userId);
  return meta.level === 'trusted';
}

export function trustInteractionBonus(db, userId) {
  if (isTrustedMember(db, userId)) {
    return { weightBonus: 25, conversationWindowSec: 300, memoryThresholdMul: 0.6 };
  }
  return { weightBonus: 0, conversationWindowSec: 120, memoryThresholdMul: 1.0 };
}
