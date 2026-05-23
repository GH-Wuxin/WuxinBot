// Group member relationship profiles — pair-based, group-scoped.
// CRITICAL: No relationType enum. Only interactionStyle/tone/topics/botStrategy/boundaries.
// Sensitive real-world relationships (couple/family/etc.) are NEVER written as conclusions.
// They may only be recorded as boundaries ("避免起哄现实关系/避免调侃亲密关系").
import { readDb, updateDb, nowIso } from '../store.js';
import { completeChat } from './llm.js';
import { findRecentInteractionPairs } from './signals.js';
import { textWithoutControlPlaceholders } from './cleaning.js';

let autoUpdateLock = new Set();

export function incrementPairPending(db, groupId, userId) {
  const pairs = findRecentInteractionPairs(db.messages || [], groupId, 30);
  for (const pair of pairs) {
    if (pair.userA === String(userId) || pair.userB === String(userId)) {
      const pairKey = [pair.userA, pair.userB].sort().join(':');
      updateDb((draft) => {
        if (!draft.pendingPairCounts) draft.pendingPairCounts = {};
        draft.pendingPairCounts[pairKey] = (draft.pendingPairCounts[pairKey] || 0) + 1;
      });
    }
  }
  // Check thresholds
  const updated = readDb();
  const counts = updated.pendingPairCounts || {};
  for (const [pKey, count] of Object.entries(counts)) {
    if (count >= 25 && !autoUpdateLock.has(pKey)) {
      autoUpdateLock.add(pKey);
      const [a, b] = pKey.split(':');
      void updateRelationshipProfile(updated, groupId, a, b).then(() => {
        updateDb((draft) => { if (draft.pendingPairCounts) draft.pendingPairCounts[pKey] = 0; });
        autoUpdateLock.delete(pKey);
      }).catch(() => { autoUpdateLock.delete(pKey); });
    }
  }
}

export function getRelationshipProfile(db, groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  return (db.relationshipProfiles || []).find((p) => String(p.groupId) === String(groupId) && p.pairKey === pairKey);
}

function collectPairSamples(db, groupId, userA, userB, limit = 40) {
  const a = String(userA), b = String(userB);
  return (db.messages || [])
    .filter((m) => String(m.groupId) === String(groupId) && m.role === 'user' && m.inContext !== false && (String(m.userId) === a || String(m.userId) === b))
    .slice(-limit * 2)
    .map((m) => {
      const clean = textWithoutControlPlaceholders(m.content);
      if (!clean || clean.length < 3) return null;
      if (/^\//.test(clean)) return null;
      return { userId: String(m.userId), nickname: m.nickname || m.userId, content: clean.slice(0, 200), createdAt: m.createdAt };
    })
    .filter(Boolean);
}

export async function updateRelationshipProfile(db, groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  const samples = collectPairSamples(db, groupId, userA, userB, 40);
  if (!samples || samples.length < 6) return { ok: false, error: '两人互动太少（至少需要 6 条往来消息）' };

  const sampleText = samples.map((s) => `[${new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${s.nickname}(${s.userId})：${s.content}`).join('\n');
  const group = (db.groups || []).find((g) => String(g.groupId) === String(groupId));

  try {
    const response = await completeChat(db, {
      messages: [
        { role: 'system', content: `你是群友互动观察器。根据两人对话记录，描述他们的可观察互动模式。

输出纯JSON：
{"interactionStyle":"互相接话/熟人调侃/认真讨论/偶尔争执等","commonTopics":"共同参与的话题","tone":"轻松/嘴贫/认真/容易误会等","botStrategy":"机器人遇到两人互动时如何插话或避开","boundaries":"不要起哄/不要站队/不要放大冲突等"}

硬性约束：
- 只描述可观察的群聊互动模式，不推断任何现实关系。
- 禁止写入：情侣/夫妻/父子/母子/兄弟/姐妹 等任何现实亲密或血缘关系。
- 即使样本中出现亲密称呼，也只能写成"避免起哄现实关系/避免调侃亲密关系"等边界，不能写成关系结论。
- 不要把调侃性称呼（"叫爸爸""你是我儿子"）当真。
- 除非群成员长期、明确、反复自述某关系，且互动与之匹配，否则默认忽略关系标签。
- 不推断"喜欢/讨厌/暗恋/CP"等主观情感。
- botStrategy 和 boundaries 必须是可操作的建议，不要写敏感关系结论。` },
        { role: 'user', content: `群：${group?.name || groupId}\n用户A：${userA}\n用户B：${userB}\n\n互动记录：\n${sampleText}` }
      ],
      temperature: 0.15, maxTokens: 500, label: '关系画像'
    });

    const raw = response.text || '{}';
    let jsonText = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    try { JSON.parse(jsonText); } catch (_) {
      const lb = jsonText.lastIndexOf('}'); if (lb >= 0) jsonText = jsonText.slice(0, lb + 1);
      jsonText = jsonText.replace(/,\s*}/g, '}');
      if ((jsonText.match(/{/g) || []).length > (jsonText.match(/}/g) || []).length) jsonText += '}';
    }
    const profile = JSON.parse(jsonText);

    // Post-process: strip any accidental relation conclusions
    const cleanField = (val) => String(val || '').replace(/情侣|夫妻|男女朋友|男朋友|女朋友|老公|老婆|丈夫|妻子|父子|母子|父女|母女|兄弟|姐妹|兄妹|姐弟|暧昧|暗恋|喜欢他|喜欢她|CP|在一起/gi, '').replace(/\s+/g, ' ').trim().slice(0, 300);

    updateDb((draft) => {
      if (!draft.relationshipProfiles) draft.relationshipProfiles = [];
      const existing = draft.relationshipProfiles.findIndex((p) => String(p.groupId) === String(groupId) && p.pairKey === pairKey);
      const entry = {
        groupId: String(groupId), pairKey, userA: [String(userA), String(userB)].sort()[0], userB: [String(userA), String(userB)].sort()[1],
        enabled: existing >= 0 ? draft.relationshipProfiles[existing].enabled : true,
        interactionStyle: cleanField(profile.interactionStyle) || '无明显模式',
        commonTopics: cleanField(profile.commonTopics) || '',
        tone: cleanField(profile.tone) || '',
        botStrategy: cleanField(profile.botStrategy) || '',
        boundaries: cleanField(profile.boundaries) || '',
        confidence: Number.isFinite(profile.confidence) ? Math.round(profile.confidence * 100) / 100 : 0.4,
        evidenceCount: samples.length,
        signalCount: samples.length,
        lastInteractionAt: samples[samples.length - 1]?.createdAt || nowIso(),
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      if (existing >= 0) draft.relationshipProfiles[existing] = entry;
      else draft.relationshipProfiles.push(entry);

      // Track usage
      draft.usage.requests += 1;
      draft.usage.totalTokens += response.usage?.total_tokens || 0;
      draft.usage.promptTokens += response.usage?.prompt_tokens || 0;
      draft.usage.completionTokens += response.usage?.completion_tokens || 0;
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({ id: crypto.randomUUID(), groupId: String(groupId), userId: 'system', model: db.settings.model, kind: 'relationship', totalTokens: response.usage?.total_tokens || 0, promptTokens: response.usage?.prompt_tokens || 0, completionTokens: response.usage?.completion_tokens || 0, createdAt: nowIso() });
      draft.usageEvents = draft.usageEvents.slice(-5000);
    });

    return { ok: true, profile: cleanField(profile.interactionStyle), sampleCount: samples.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function clearRelationshipProfile(groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  updateDb((draft) => {
    if (!draft.relationshipProfiles) return;
    draft.relationshipProfiles = draft.relationshipProfiles.filter((p) => !(String(p.groupId) === String(groupId) && p.pairKey === pairKey));
  });
  return { ok: true };
}

export function relationshipPromptBlock(db, event) {
  if (event.type !== 'group') return '';
  const atTargets = event.atTargets || [];
  const profiles = (db.relationshipProfiles || []).filter((p) => String(p.groupId) === String(event.groupId) && p.enabled !== false);
  if (!profiles.length) return '';
  // Only inject pairs where current message directly involves the other person
  const relevant = profiles.filter((p) => {
    if (String(event.userId) !== p.userA && String(event.userId) !== p.userB) return false;
    const other = String(event.userId) === p.userA ? p.userB : p.userA;
    return atTargets.includes(other);
  });
  if (!relevant.length) return '';
  // Max 2 most confident pairs
  const top = relevant.sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 2);
  const parts = top.map((p) => {
    const other = String(event.userId) === p.userA ? p.userB : p.userA;
    return `与 ${other} 的互动：${p.interactionStyle}。${p.botStrategy ? '建议：' + p.botStrategy : ''}`;
  });
  return '【相关群友互动】\n' + parts.join('\n') + '\n以上仅为群内可观察互动参考，不是现实关系判断。不点名、不八卦、不起哄。';
}
