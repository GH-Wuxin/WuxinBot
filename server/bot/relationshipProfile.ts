// @ts-nocheck -- legacy runtime module; new typed modules remain checked by tsc.
// Group member relationship profiles — pair-based, group-scoped.
// CRITICAL: No relationType enum. Only interactionStyle/tone/topics/botStrategy/boundaries.
// Sensitive real-world relationships (couple/family/etc.) are NEVER written as conclusions.
// They may only be recorded as boundaries ("避免起哄现实关系/避免调侃亲密关系").
import { readDb, updateDb, nowIso } from '../store.js';
import { completeChat } from './llm.js';
import { findRecentInteractionPairs } from './signals.js';
import { textWithoutControlPlaceholders } from './cleaning.js';

let autoUpdateLock = new Set();

const EMPTY_RELATION_PATTERNS = [
  /无明显/,
  /没有明显/,
  /暂无/,
  /信息不足/,
  /证据不足/,
  /样本不足/,
  /无法判断/,
  /不确定/,
  /未体现/,
  /看不出/,
  /无固定/,
  /无特定/,
  /无可总结/,
  /没有可观察/
];

const WEAK_RELATION_PATTERNS = [
  /单方面输出/,
  /单向输出/,
  /单方/,
  /用户[AＢB]未参与/,
  /未参与回应/,
  /偶尔简短/,
  /互动稀疏/,
  /互动密度低/,
  /仅为一次/,
  /只是路过/,
  /各说各的/,
  /缺少直接互动/,
  /没有直接互动/,
  /没有形成互动/,
  /不构成稳定互动/
];

function relationshipPendingKey(groupId, userA, userB) {
  const [a, b] = [String(userA), String(userB)].sort();
  return `${String(groupId)}:${a}:${b}`;
}

function parseRelationshipPendingKey(key) {
  const parts = String(key || '').split(':');
  if (parts.length !== 3) return null;
  return { groupId: parts[0], userA: parts[1], userB: parts[2] };
}

export function incrementPairPending(db, groupId, userId) {
  const pairs = findRecentInteractionPairs(db.messages || [], groupId, 30);
  for (const pair of pairs) {
    if (pair.userA === String(userId) || pair.userB === String(userId)) {
      const pairKey = relationshipPendingKey(groupId, pair.userA, pair.userB);
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
    const parsed = parseRelationshipPendingKey(pKey);
    if (!parsed) {
      updateDb((draft) => { if (draft.pendingPairCounts) delete draft.pendingPairCounts[pKey]; });
      continue;
    }
    if (count >= 25 && !autoUpdateLock.has(pKey)) {
      autoUpdateLock.add(pKey);
      void updateRelationshipProfile(updated, parsed.groupId, parsed.userA, parsed.userB).then((result) => {
        if (result.ok) {
          updateDb((draft) => { if (draft.pendingPairCounts) draft.pendingPairCounts[pKey] = 0; });
        }
        autoUpdateLock.delete(pKey);
      }).catch(() => { autoUpdateLock.delete(pKey); });
    }
  }
}

export function getRelationshipProfile(db, groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  const profile = (db.relationshipProfiles || []).find((p) => String(p.groupId) === String(groupId) && p.pairKey === pairKey);
  return isSubstantiveRelationshipProfile(profile) ? profile : null;
}

function mentionsUser(content, userId) {
  return new RegExp(`\\[CQ:at,qq=${String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).test(String(content || ''));
}

function messageTime(message) {
  const time = new Date(message?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function closeInTime(a, b, minutes = 5) {
  const ta = messageTime(a);
  const tb = messageTime(b);
  return Boolean(ta && tb && Math.abs(ta - tb) <= minutes * 60_000);
}

function cleanPairMessage(message) {
  const clean = textWithoutControlPlaceholders(message.content);
  if (!clean || clean.length < 3) return '';
  if (/^\//.test(clean)) return '';
  if (/^\[(图片|表情|表情包|视频|文件|语音)\]/.test(clean)) return '';
  return clean.slice(0, 200);
}

function collectPairSamples(db, groupId, userA, userB, limit = 40) {
  const a = String(userA), b = String(userB);
  const groupMessages = (db.messages || [])
    .filter((m) => String(m.groupId) === String(groupId) && m.role === 'user' && m.inContext !== false)
    .slice(-limit * 6);
  const samples = [];
  for (let i = 0; i < groupMessages.length; i++) {
    const message = groupMessages[i];
    const userId = String(message.userId);
    if (userId !== a && userId !== b) continue;
    const other = userId === a ? b : a;
    const clean = cleanPairMessage(message);
    if (!clean) continue;
    const prev = groupMessages[i - 1];
    const next = groupMessages[i + 1];
    const directlyMentionsOther = mentionsUser(message.content, other);
    const closePrevOther = prev && String(prev.userId) === other && closeInTime(prev, message);
    const closeNextOther = next && String(next.userId) === other && closeInTime(message, next);
    if (!directlyMentionsOther && !closePrevOther && !closeNextOther) continue;
    samples.push({
      userId,
      nickname: message.nickname || message.userId,
      content: clean,
      createdAt: message.createdAt,
      signal: directlyMentionsOther ? 'at' : 'nearby-turn'
    });
  }
  return samples.slice(-limit);
}

function cleanRelationshipField(val) {
  return String(val || '')
    .replace(/情侣|夫妻|男女朋友|男朋友|女朋友|老公|老婆|丈夫|妻子|父子|母子|父女|母女|兄弟|姐妹|兄妹|姐弟|暧昧|暗恋|喜欢他|喜欢她|CP|在一起/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function looksEmptyRelationText(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (value.length <= 2) return true;
  return EMPTY_RELATION_PATTERNS.some((pattern) => pattern.test(value));
}

function looksWeakRelationshipProfile(profile) {
  const combined = [
    profile?.interactionStyle,
    profile?.commonTopics,
    profile?.tone,
    profile?.botStrategy,
    profile?.boundaries
  ].map(cleanRelationshipField).join(' ');
  return WEAK_RELATION_PATTERNS.some((pattern) => pattern.test(combined));
}

export function isSubstantiveRelationshipProfile(profile) {
  if (!profile) return false;
  if (looksWeakRelationshipProfile(profile)) return false;
  const fields = [
    profile.interactionStyle,
    profile.commonTopics,
    profile.tone,
    profile.botStrategy,
    profile.boundaries
  ].map(cleanRelationshipField).filter(Boolean);
  if (!fields.length) return false;
  const strongFields = fields.filter((field) => !looksEmptyRelationText(field));
  const confidence = Number(profile.confidence || 0);
  const evidenceCount = Number(profile.evidenceCount || profile.signalCount || 0);
  return strongFields.length >= 2 && evidenceCount >= 6 && confidence >= 0.35;
}

export async function updateRelationshipProfile(db, groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  const samples = collectPairSamples(db, groupId, userA, userB, 40);
  if (!samples || samples.length < 6) {
    return { ok: true, skipped: true, reason: '两人真实互动太少，未保存关系画像', sampleCount: samples.length };
  }

  const sampleText = samples.map((s) => `[${new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${s.nickname}(${s.userId}) [${s.signal}]：${s.content}`).join('\n');
  const group = (db.groups || []).find((g) => String(g.groupId) === String(groupId));

  try {
    const response = await completeChat(db, {
      messages: [
        { role: 'system', content: `你是群友互动观察器。根据两人对话记录，描述他们的可观察互动模式。

输出纯JSON：
{"shouldSave":true或false,"reason":"保存或跳过原因","interactionStyle":"互相接话/熟人调侃/认真讨论/偶尔争执等","commonTopics":"共同参与的话题","tone":"轻松/嘴贫/认真/容易误会等","botStrategy":"机器人遇到两人互动时如何插话或避开","boundaries":"不要起哄/不要站队/不要放大冲突等","confidence":0到1}

硬性约束：
- 只描述可观察的群聊互动模式，不推断任何现实关系。
- 如果样本里看不出稳定互动模式，输出 shouldSave:false，并把其他字段留空。不要写"无明显关系/无明显模式/信息不足"来凑字段。
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

    const cleaned = {
      interactionStyle: cleanRelationshipField(profile.interactionStyle),
      commonTopics: cleanRelationshipField(profile.commonTopics),
      tone: cleanRelationshipField(profile.tone),
      botStrategy: cleanRelationshipField(profile.botStrategy),
      boundaries: cleanRelationshipField(profile.boundaries),
      confidence: Number.isFinite(profile.confidence) ? Math.round(Number(profile.confidence) * 100) / 100 : 0.4
    };
    const draftProfile = { ...cleaned, evidenceCount: samples.length, signalCount: samples.length };
    const shouldSave = profile.shouldSave !== false && isSubstantiveRelationshipProfile(draftProfile);

    if (!shouldSave) {
      return {
        ok: true,
        skipped: true,
        reason: cleanRelationshipField(profile.reason) || '没有稳定可观察互动模式，未保存关系画像',
        sampleCount: samples.length
      };
    }

    updateDb((draft) => {
      if (!draft.relationshipProfiles) draft.relationshipProfiles = [];
      const existing = draft.relationshipProfiles.findIndex((p) => String(p.groupId) === String(groupId) && p.pairKey === pairKey);
      const entry = {
        groupId: String(groupId), pairKey, userA: [String(userA), String(userB)].sort()[0], userB: [String(userA), String(userB)].sort()[1],
        enabled: existing >= 0 ? draft.relationshipProfiles[existing].enabled : true,
        interactionStyle: cleaned.interactionStyle,
        commonTopics: cleaned.commonTopics,
        tone: cleaned.tone,
        botStrategy: cleaned.botStrategy,
        boundaries: cleaned.boundaries,
        confidence: cleaned.confidence,
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

    return { ok: true, profile: cleaned.interactionStyle, sampleCount: samples.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function clearRelationshipProfile(groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  const pendingKey = `${String(groupId)}:${pairKey}`;
  updateDb((draft) => {
    // pendingPairCounts keys are `${groupId}:${userA}:${userB}` (same sorted
    // pair). Deleting the profile must also discard unconsumed pair evidence,
    // otherwise a count >= 25 left over from before the delete re-triggers
    // auto-rebuild on the next interaction.
    if (draft.pendingPairCounts) delete draft.pendingPairCounts[pendingKey];
    if (!draft.relationshipProfiles) return;
    draft.relationshipProfiles = draft.relationshipProfiles.filter((p) => !(String(p.groupId) === String(groupId) && p.pairKey === pairKey));
  });
  return { ok: true };
}

export function relationshipPromptBlock(db, event) {
  if (event.type !== 'group') return '';
  const atTargets = event.atTargets || [];
  const profiles = (db.relationshipProfiles || []).filter((p) => String(p.groupId) === String(event.groupId) && p.enabled !== false && isSubstantiveRelationshipProfile(p));
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
