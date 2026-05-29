// Auto trust scoring — now backed by the experience level system.
// Scores are computed from XP/level instead of the old trustScores mechanism.
import { readDb, updateDb, nowIso } from '../store.js';
import { getXpBonus, getExperience } from './experience.js';
import { extractSignals, computeInteractionDiversity, countRecentNegativeSignals } from './signals.js';

// Legacy compat: getTrustMeta returns experience data in old shape
export function getTrustMeta(db, userId) {
  const exp = getExperience(db, userId);
  return {
    score: exp.xp,
    level: exp.level >= 3 ? 'trusted' : exp.level >= 2 ? 'candidate' : 'normal',
    activeDays: exp.activeDays,
    realTextCount: 0,
    interactionDiversity: 0,
    positiveSignals: [],
    negativeSignals: [],
    lastEvaluatedAt: '',
    promotedAt: exp.lastLevelUpAt || '',
  };
}

// processTrustSignal is now handled by processXpGain in experience.ts.
// This stub is kept for backward compatibility but does nothing.
export function processTrustSignal(_event, _db) {
  // No-op: XP is processed by experience.processXpGain
}

// evaluateTrustScores is now handled by decayInactiveUsers in experience.ts.
// This stub is kept for backward compatibility.
export function evaluateTrustScores() {
  // No-op: decay is handled by experience.decayInactiveUsers
}

export function isTrustedMember(db, userId) {
  const exp = getExperience(db, userId);
  return exp.level >= 3;
}

export function trustInteractionBonus(db, userId) {
  return getXpBonus(db, userId);
}
