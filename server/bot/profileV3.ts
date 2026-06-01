// Personal profile V3 — "Evidence Ledger" approach.
// Instead of letting LLM infer personality from raw context, we:
// 1. Classify samples into typed evidence claims
// 2. Store evidence with provenance (who said what, when, where)
// 3. Aggregate evidence into profile patches (LLM summarizes evidence, not raw messages)
// 4. Only patch changed fields, never wholesale overwrite

import { readDb, updateDb, nowIso } from '../store.js';
import { writeProfileLog, newRunId } from './profileLog.js';
import { textWithoutControlPlaceholders } from './cleaning.js';

// ── Evidence types ──

export type EvidenceSource = 'self-disclosure' | 'observed-behavior' | 'speech-style' | 'stated-preference' | 'interaction-pattern';
export type EvidenceStrength = 'strong' | 'moderate' | 'weak' | 'background';

export interface ProfileEvidence {
  id: string;
  userId: string;
  source: EvidenceSource;
  strength: EvidenceStrength;
  claim: string;           // The conservative claim, e.g. "用户多次提到喜欢猫"
  rawSamples: string[];    // Sample IDs supporting this claim
  groups: string[];        // Groups where evidence was observed
  days: string[];          // Unique dates (YYYY-MM-DD)
  crossGroup: boolean;     // Evidence spans multiple groups
  crossDay: boolean;       // Evidence spans multiple days
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;   // If replaced by a newer/stronger evidence
}

export interface ProfileV3Data {
  userId: string;
  nickname: string;
  evidence: ProfileEvidence[];
  legacySummary?: string;   // Old V2 profile preserved for reference
  lastEvidenceAt?: string;
  lastAggregationAt?: string;
  aggregationCount: number;
}

// ── Evidence extraction heuristics (no LLM, pure rules) ──

const SELF_DISCLOSURE_PATTERNS = [
  { pattern: /我(喜欢|爱|讨厌|不喜欢|讨厌|受不了|偏好|习惯|经常|总是|一般|通常|不喜欢)/, source: 'stated-preference' as EvidenceSource, strength: 'strong' as EvidenceStrength },
  { pattern: /我是|我的|我叫|我今年|我在|我住/, source: 'self-disclosure' as EvidenceSource, strength: 'moderate' as EvidenceStrength },
  { pattern: /我觉得|我认为|我以为|我感觉/, source: 'self-disclosure' as EvidenceSource, strength: 'weak' as EvidenceStrength },
];

const BEHAVIOR_PATTERNS = [
  { pattern: /(经常|总是|一般|通常|每天|每周).{0,20}(聊|说|发|玩|看|打|做)/, source: 'observed-behavior' as EvidenceSource, strength: 'moderate' as EvidenceStrength },
  { pattern: /(昨天|今天|刚才|上周|前天).{0,30}(打了|看了|玩了|做了|去了)/, source: 'observed-behavior' as EvidenceSource, strength: 'weak' as EvidenceStrength },
];

const STYLE_PATTERNS = [
  { pattern: /^.{0,5}(哈哈|233|666|草|绝了|笑死|绷)/, source: 'speech-style' as EvidenceSource, strength: 'weak' as EvidenceStrength },
  { pattern: /(嗯|哦|啊|吧|呢|嘛|哈|啦|噢|喔){2,}/, source: 'speech-style' as EvidenceSource, strength: 'weak' as EvidenceStrength },
];

// Extract potential evidence claims from a single sample
export function extractEvidenceFromSample(
  content: string,
  userId: string,
  groupId: string,
  messageId: string,
  isSelf: boolean,
): { source: EvidenceSource; strength: EvidenceStrength; claim: string } | null {
  const clean = textWithoutControlPlaceholders(content);
  if (!clean || clean.length < 5) return null;
  if (/^\//.test(clean)) return null; // Skip commands

  // Only the user themselves can make self-disclosures
  if (isSelf) {
    for (const { pattern, source, strength } of SELF_DISCLOSURE_PATTERNS) {
      const match = clean.match(pattern);
      if (match) {
        return {
          source,
          strength,
          claim: `用户说：${clean.slice(0, 100)}`,
        };
      }
    }
  }

  // Behavior patterns can be observed by anyone
  for (const { pattern, source, strength } of BEHAVIOR_PATTERNS) {
    if (pattern.test(clean)) {
      return {
        source,
        strength,
        claim: `观察到：${clean.slice(0, 100)}`,
      };
    }
  }

  // Style patterns
  for (const { pattern, source, strength } of STYLE_PATTERNS) {
    if (pattern.test(clean)) {
      return {
        source: 'speech-style' as EvidenceSource,
        strength: 'weak' as EvidenceStrength,
        claim: `说话风格：${clean.slice(0, 60)}`,
      };
    }
  }

  return null;
}

// ── Evidence aggregation ──

// Merge new evidence into existing evidence list
export function addEvidence(
  userId: string,
  newClaim: { source: EvidenceSource; strength: EvidenceStrength; claim: string },
  groupId: string,
  sampleId: string,
  day: string,
): void {
  let shouldLog = false;
  updateDb((draft) => {
    if (!draft.profileV3) draft.profileV3 = {};
    let profile = draft.profileV3[userId];
    if (!profile) {
      profile = { userId, nickname: '', evidence: [], aggregationCount: 0 };
      draft.profileV3[userId] = profile;
    }

    // Find existing evidence that matches the claim (same source type, similar claim)
    const existing = profile.evidence.find((e) =>
      !e.supersededBy &&
      e.source === newClaim.source &&
      e.claim.slice(0, 40) === newClaim.claim.slice(0, 40) &&
      new Date(e.updatedAt).getTime() > Date.now() - 30 * 86400000 // Within 30 days
    );

    if (existing) {
      // Strengthen existing evidence
      if (!existing.rawSamples.includes(sampleId)) existing.rawSamples.push(sampleId);
      if (!existing.groups.includes(groupId)) existing.groups.push(groupId);
      if (!existing.days.includes(day)) existing.days.push(day);
      existing.crossGroup = existing.groups.length >= 2;
      existing.crossDay = existing.days.length >= 2;
      existing.updatedAt = nowIso();
      // Upgrade strength if cross-session
      if (existing.crossDay && existing.strength === 'weak') existing.strength = 'moderate';
      if (existing.crossDay && existing.crossGroup && existing.strength === 'moderate') existing.strength = 'strong';
    } else {
      // Create new evidence
      profile.evidence.push({
        id: crypto.randomUUID(),
        userId,
        source: newClaim.source,
        strength: newClaim.strength,
        claim: newClaim.claim,
        rawSamples: [sampleId],
        groups: [groupId],
        days: [day],
        crossGroup: false,
        crossDay: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }

    profile.lastEvidenceAt = nowIso();
    shouldLog = true;
  });
  if (shouldLog) {
    writeProfileLog({
      runId: '',
      event: 'evidence.created',
      userId,
      groupId,
      detail: `[${newClaim.source}/${newClaim.strength}] ${newClaim.claim.slice(0, 80)}`,
      meta: { source: newClaim.source, strength: newClaim.strength },
    });
  }
}

// Get strong/moderate evidence for aggregation
export function getAggregatableEvidence(userId: string): ProfileEvidence[] {
  const db = readDb();
  const profile = (db.profileV3 || {})[userId];
  if (!profile) return [];
  return profile.evidence.filter((e) =>
    !e.supersededBy &&
    (e.strength === 'strong' || e.strength === 'moderate') &&
    e.crossDay // Only cross-day evidence goes into aggregation
  );
}

// Get V3 profile data
export function getProfileV3(db: any, userId: string): ProfileV3Data | null {
  return (db.profileV3 || {})[userId] || null;
}

// Count evidence by category
export function evidenceSummary(userId: string): {
  total: number;
  strong: number;
  moderate: number;
  weak: number;
  crossGroup: number;
  crossDay: number;
  bySource: Record<string, number>;
} {
  const db = readDb();
  const profile = (db.profileV3 || {})[userId];
  if (!profile) return { total: 0, strong: 0, moderate: 0, weak: 0, crossGroup: 0, crossDay: 0, bySource: {} };
  const evidence = profile.evidence.filter((e) => !e.supersededBy);
  const bySource: Record<string, number> = {};
  for (const e of evidence) bySource[e.source] = (bySource[e.source] || 0) + 1;
  return {
    total: evidence.length,
    strong: evidence.filter((e) => e.strength === 'strong').length,
    moderate: evidence.filter((e) => e.strength === 'moderate').length,
    weak: evidence.filter((e) => e.strength === 'weak').length,
    crossGroup: evidence.filter((e) => e.crossGroup).length,
    crossDay: evidence.filter((e) => e.crossDay).length,
    bySource,
  };
}
