// Experience / level system — rules-based, no LLM.
// XP is global per QQ number. Levels unlock features and affect reply behavior.
import { readDb, updateDb, nowIso } from '../store.js';
import { extractSignals } from './signals.js';

export const LEVELS = [
  { level: 0, title: '新人', emoji: '🌱', xp: 0 },
  { level: 1, title: '群友', emoji: '💬', xp: 50 },
  { level: 2, title: '活跃群友', emoji: '🎯', xp: 150 },
  { level: 3, title: '老熟人', emoji: '⭐', xp: 350 },
  { level: 4, title: '核心群友', emoji: '👑', xp: 700 },
];

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
  return LEVELS.find((l) => l.level === level) || LEVELS[0];
}

export function getNextLevelInfo(level) {
  return LEVELS.find((l) => l.level === level + 1) || null;
}

export function xpForLevel(level) {
  const info = LEVELS.find((l) => l.level === level);
  return info ? info.xp : 0;
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
  const info = getLevelInfo(exp.level);
  const bonuses = {
    weightBonus: 0,
    conversationWindowSec: 120,
    memoryThresholdMul: 1.0,
    level: exp.level,
    title: info.title,
    emoji: info.emoji,
  };
  if (exp.level >= 1) bonuses.weightBonus = 10;
  if (exp.level >= 2) { bonuses.weightBonus = 15; bonuses.memoryThresholdMul = 0.8; }
  if (exp.level >= 3) { bonuses.weightBonus = 20; bonuses.conversationWindowSec = 180; }
  if (exp.level >= 4) { bonuses.weightBonus = 25; bonuses.memoryThresholdMul = 0.6; bonuses.conversationWindowSec = 300; }
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

    // Level evaluation
    oldLevel = exp.level;
    let newLevel = 0;
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      if (exp.xp >= LEVELS[i].xp) { newLevel = LEVELS[i].level; break; }
    }
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

      // Re-evaluate level
      let newLevel = 0;
      for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (exp.xp >= LEVELS[i].xp) { newLevel = LEVELS[i].level; break; }
      }
      exp.level = newLevel;
    }
  });
}

// Format XP progress bar
export function formatXpBar(exp) {
  const current = LEVELS.find((l) => l.level === exp.level) || LEVELS[0];
  const next = LEVELS.find((l) => l.level === exp.level + 1);
  if (!next) {
    // Max level
    return `${current.emoji} ${current.title} (Lv.${current.level})\nXP: ${exp.xp} (已满级)`;
  }
  const progress = exp.xp - current.xp;
  const needed = next.xp - current.xp;
  const pct = Math.min(100, Math.round((progress / needed) * 100));
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const streakMul = getStreakMultiplier(exp.streakDays);
  const mulText = streakMul > 1 ? ` ×${streakMul}` : '';

  const lines = [
    `${current.emoji} ${current.title} (Lv.${current.level})`,
    `XP: ${exp.xp}/${next.xp} ${bar} ${pct}%`,
    `今日: +${Math.round(exp.dailyXp)}/${DAILY_XP_CAP}${mulText}  连续: ${exp.streakDays}天`,
  ];
  return lines.join('\n');
}

// Get unlocked features description
export function getUnlockedFeatures(level) {
  const features = [];
  if (level >= 1) features.push('回复权重+10');
  if (level >= 2) features.push('权重+15 · 记忆×0.8 · 自定义称呼');
  if (level >= 3) features.push('权重+20 · 对话3min · 查看画像 · 个人风格');
  if (level >= 4) features.push('权重+25 · 记忆×0.6 · 对话5min · 画像导出');
  return features;
}
