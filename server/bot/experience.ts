// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
// Experience / level system — rules-based, no LLM.
// Levels are unbounded and named by pp value: level N = N*100pp, reached when
// total XP >= N*100. XP is global per QQ number. Levels unlock features and
// affect reply behavior.
import { readDb, updateDb, nowIso } from '../store.js';
import { extractSignals } from './signals.js';

export function levelToPp(level) {
  return Math.max(0, Math.floor(Number(level) || 0)) * 100;
}

export function xpForLevel(level) {
  return levelToPp(level);
}

export function levelFromXp(xp) {
  return Math.max(0, Math.floor(Number(xp) / 100));
}

export function roundDisplayedXp(xp) {
  return Math.max(0, Math.round(Number(xp) || 0));
}

// One-time migration for records created under the legacy 5-level system:
// recompute every stored level from total XP (level N = N*100 XP).
export function migrateLegacyLevels() {
  let migrated = 0;
  updateDb((draft) => {
    if (!draft.experience) return;
    for (const [userId, exp] of Object.entries(draft.experience)) {
      const correct = levelFromXp(exp.xp);
      if (Number(exp.level) !== correct) {
        exp.level = correct;
        migrated++;
      }
    }
  });
  return migrated;
}

const DAILY_XP_CAP = 30;
const MSG_XP = 1;
const MSG_DAILY_CAP = 15;
const MENTION_XP = 2;
const MENTION_DAILY_CAP = 6;
const DIVERSITY_XP = 3;
const MILESTONE_XP = 5;
const MILESTONE_EVERY_DAYS = 3;
const DECAY_INACTIVE_DAYS = 30;
const DECAY_INTERVAL_DAYS = 7;
const DECAY_RATE = 0.10;

export function getLevelInfo(level) {
  const lv = Math.max(0, Math.floor(Number(level) || 0));
  return { level: lv, title: `${levelToPp(lv)}pp`, emoji: '', xp: xpForLevel(lv) };
}

export function getNextLevelInfo(level) {
  return { level: level + 1, title: `${levelToPp(level + 1)}pp`, emoji: '', xp: xpForLevel(level + 1) };
}

export function getStreakMultiplier(streakDays) {
  if (streakDays >= 14) return 2.0;
  if (streakDays >= 7) return 1.5;
  if (streakDays >= 3) return 1.2;
  return 1.0;
}

export function getExperience(db, userId) {
  const key = String(userId);
  return db.experience?.[key] || {
    xp: 0, level: 0, dailyXp: 0, dailyDate: '',
    activeDays: 0, streakDays: 0, lastMsgDate: '',
    lastLevelUpAt: '', lastDecayCheck: '',
  };
}

export function getGroupExperience(db, groupId, userId) {
  const key = `${groupId}:${userId}`;
  return db.groupExperience?.[key] || {
    groupId, userId: String(userId), msgCount: 0, xpInGroup: 0, lastActiveAt: '',
  };
}

export function getXpBonus(db, userId) {
  const exp = getExperience(db, userId);
  const xp = Number(exp.xp || 0);
  const bonuses = {
    weightBonus: 0,
    conversationWindowSec: 120,
    memoryThresholdMul: 1.0,
    level: exp.level,
    title: `${levelToPp(exp.level)}pp`,
    emoji: '',
  };
  if (xp >= 50) bonuses.weightBonus = 10;
  if (xp >= 150) { bonuses.weightBonus = 15; bonuses.memoryThresholdMul = 0.8; }
  if (xp >= 350) { bonuses.weightBonus = 20; bonuses.conversationWindowSec = 180; }
  if (xp >= 700) { bonuses.weightBonus = 25; bonuses.memoryThresholdMul = 0.6; bonuses.conversationWindowSec = 300; }
  return bonuses;
}

// Process XP gain for a message event. Returns { gained, levelUp, oldLevel, newLevel }.
export function processXpGain(event, db) {
  const userId = String(event.userId);
  if (!userId || userId === String(db.settings.selfQq)) return { gained: 0 };
  if (userId === String(db.settings.ownerQq)) return { gained: 0 }; // Owner doesn't need XP

  const signals = extractSignals(event, db);
  if (!signals.isRealText) return { gained: 0 };

  const today = new Date().toISOString().slice(0, 10);
  let gained = 0;
  let levelUp = false;
  let oldLevel = 0;

  updateDb((draft) => {
    if (!draft.experience) draft.experience = {};
    if (!draft.groupExperience) draft.groupExperience = {};

    const key = userId;
    let exp = draft.experience[key];
    if (!exp) {
      exp = { xp: 0, level: 0, dailyXp: 0, dailyDate: '', activeDays: 0, streakDays: 0, lastMsgDate: '', lastLevelUpAt: '', lastDecayCheck: '' };
      draft.experience[key] = exp;
    }

    // Daily reset
    if (exp.dailyDate !== today) {
      // Streak: if last message was yesterday, increment; otherwise reset
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      if (exp.lastMsgDate === yesterday) {
        exp.streakDays = (exp.streakDays || 0) + 1;
      } else if (exp.lastMsgDate !== today) {
        exp.streakDays = 1;
      }
      exp.dailyXp = 0;
      exp.dailyDate = today;

      // Active days
      const lastDay = exp.lastMsgDate || '';
      if (lastDay !== today) {
        exp.activeDays = (exp.activeDays || 0) + 1;
      }
    }

    if (exp.dailyXp >= DAILY_XP_CAP) {
      // Still update group experience and lastMsgDate
      exp.lastMsgDate = today;
      const gKey = `${event.groupId}:${userId}`;
      let gExp = draft.groupExperience[gKey];
      if (!gExp) {
        gExp = { groupId: String(event.groupId), userId, msgCount: 0, xpInGroup: 0, lastActiveAt: '' };
        draft.groupExperience[gKey] = gExp;
      }
      gExp.msgCount += 1;
      gExp.lastActiveAt = nowIso();
      return; // Daily cap reached
    }

    const multiplier = getStreakMultiplier(exp.streakDays);

    // Message XP
    const msgGain = Math.min(MSG_XP, DAILY_XP_CAP - exp.dailyXp, MSG_DAILY_CAP - Math.min(exp.dailyXp, MSG_DAILY_CAP));
    if (msgGain > 0) {
      const actual = Math.round(msgGain * multiplier * 10) / 10;
      gained += actual;
      exp.dailyXp += actual;
      exp.xp += actual;
    }

    // Mention XP
    if (signals.mentionsCount > 0 && !signals.hasPromptInjection) {
      const room = Math.min(MENTION_DAILY_CAP, DAILY_XP_CAP) - exp.dailyXp;
      if (room > 0) {
        const mentionGain = Math.min(MENTION_XP * signals.mentionsCount, room);
        const actual = Math.round(mentionGain * multiplier * 10) / 10;
        gained += actual;
        exp.dailyXp += actual;
        exp.xp += actual;
      }
    }

    // Milestone XP (every N active days)
    if (exp.activeDays > 0 && exp.activeDays % MILESTONE_EVERY_DAYS === 0) {
      const room = DAILY_XP_CAP - exp.dailyXp;
      if (room > 0) {
        const actual = Math.min(MILESTONE_XP, room);
        gained += actual;
        exp.dailyXp += actual;
        exp.xp += actual;
      }
    }

    exp.lastMsgDate = today;

    // Group experience
    const gKey = `${event.groupId}:${userId}`;
    let gExp = draft.groupExperience[gKey];
    if (!gExp) {
      gExp = { groupId: String(event.groupId), userId, msgCount: 0, xpInGroup: 0, lastActiveAt: '' };
      draft.groupExperience[gKey] = gExp;
    }
    gExp.msgCount += 1;
    gExp.xpInGroup += gained;
    gExp.lastActiveAt = nowIso();

    // Level evaluation: level N requires N*100 total XP (unbounded).
    oldLevel = exp.level;
    const newLevel = levelFromXp(exp.xp);
    if (newLevel > oldLevel) {
      exp.level = newLevel;
      exp.lastLevelUpAt = nowIso();
      levelUp = true;
    }
  });

  return { gained, levelUp, oldLevel, newLevel: levelUp ? getExperience(readDb(), userId).level : oldLevel };
}

// Decay XP for inactive users. Called periodically (e.g., every 6 hours).
export function decayInactiveUsers() {
  const db = readDb();
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  updateDb((draft) => {
    if (!draft.experience) return;
    for (const [userId, exp] of Object.entries(draft.experience)) {
      if (exp.level <= 0) continue;
      const lastMsg = exp.lastMsgDate || '';
      if (!lastMsg) continue;
      const daysSinceMsg = Math.floor((now - new Date(lastMsg).getTime()) / 86400000);
      if (daysSinceMsg < DECAY_INACTIVE_DAYS) continue;

      // Check decay interval
      const lastDecay = exp.lastDecayCheck || '';
      const daysSinceDecay = lastDecay ? Math.floor((now - new Date(lastDecay).getTime()) / 86400000) : DECAY_INTERVAL_DAYS;
      if (daysSinceDecay < DECAY_INTERVAL_DAYS) continue;

      // Apply decay
      const decayAmount = Math.max(1, Math.floor(exp.xp * DECAY_RATE));
      exp.xp = Math.max(0, exp.xp - decayAmount);
      exp.lastDecayCheck = today;

      // Re-evaluate level (unbounded pp naming).
      exp.level = levelFromXp(exp.xp);
    }
  });
}

// Format XP progress bar
export function formatXpBar(exp) {
  const level = levelFromXp(exp.xp); // defensive: trust XP, not the stored field
  const currentPp = levelToPp(level);
  const nextPp = levelToPp(level + 1);
  const progress = exp.xp - currentPp;
  const needed = nextPp - currentPp;
  const pct = Math.min(100, Math.round((progress / needed) * 100));
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const streakMul = getStreakMultiplier(exp.streakDays);
  const mulText = streakMul > 1 ? ` ×${streakMul}` : '';
  const displayedXp = roundDisplayedXp(exp.xp);

  const lines = [
    `当前等级：${currentPp}pp（下一级 ${nextPp}pp）`,
    `XP: ${displayedXp}/${nextPp} ${bar} ${pct}%`,
    `今日: +${Math.round(exp.dailyXp)}/${DAILY_XP_CAP}${mulText}  连续: ${exp.streakDays}天`,
  ];
  return lines.join('\n');
}

// Get unlocked features description
export function getUnlockedFeatures(level) {
  // Thresholds follow total XP (50/150/350/700); level N means N*100 XP.
  const xp = xpForLevel(level);
  const features = [];
  if (xp >= 50) features.push('回复权重+10');
  if (xp >= 150) features.push('权重+15 · 记忆×0.8 · 自定义称呼');
  if (xp >= 350) features.push('权重+20 · 对话3min · 查看画像 · 个人风格');
  if (xp >= 700) features.push('权重+25 · 记忆×0.6 · 对话5min · 画像导出');
  return features;
}
