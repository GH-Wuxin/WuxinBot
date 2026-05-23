// Group Chat Profile: per-group atmosphere description, stored separately
// from personal memory profiles. Keyed by groupId, injected into buildPrompt
// for the current group only.
import { readDb, updateDb, nowIso } from '../store.js';
import { completeChat } from './llm.js';
import { textWithoutControlPlaceholders } from './cleaning.js';

export function getGroupProfile(db, groupId) {
  return (db.groupProfiles || []).find((p) => String(p.groupId) === String(groupId));
}

export function collectGroupProfileSamples(db, groupId, limit = 120) {
  return (db.messages || [])
    .filter((m) => String(m.groupId) === String(groupId) && m.role === 'user' && m.inContext !== false)
    .slice(-limit)
    .map((m) => {
      const clean = textWithoutControlPlaceholders(m.content);
      if (!clean) return null;
      // Skip commands, pure media, bot output
      if (/^\//.test(clean)) return null;
      if (clean.length < 3) return null;
      return { nickname: m.nickname || m.userId, content: clean.slice(0, 180), createdAt: m.createdAt };
    })
    .filter(Boolean);
}

export async function updateGroupProfile(db, groupId) {
  const samples = collectGroupProfileSamples(db, groupId, 150);
  if (!samples || samples.length < 10) return { ok: false, error: '群聊消息太少（至少需要 10 条有内容的用户发言）' };

  const sampleText = samples.map((s) => `[${new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${s.nickname}：${s.content}`).join('\n');
  const group = (db.groups || []).find((g) => String(g.groupId) === String(groupId));
  const groupName = group?.name || groupId;

  try {
    const response = await completeChat(db, {
      messages: [
        { role: 'system', content: `你是群聊氛围分析器。根据最近群聊记录，总结群聊的整体氛围和特点。

输出纯JSON：
{"atmosphere":"整体氛围","topics":"常见话题","humorStyle":"玩笑方式","pace":"聊天节奏","boundaries":"机器人应注意的边界","botStrategy":"机器人在这个群的推荐说话方式","confidence":0.72}

规则：
- 总结"群氛围"，不要总结"群里谁是什么人"。
- 不推断成员身份、取向、心理状态、健康状态、政治立场等敏感属性。
- 不把一次玩笑当成稳定群文化。
- 区分熟人玩笑、轻度互损、真实冲突、命令式调试。
- 输出重点放在"机器人在该群如何更自然地说话"。
- 对证据不足的维度给低置信或留空。
- 所有字段值必须是字符串（confidence除外）。` },
        { role: 'user', content: `群：${groupName}\n最近消息：\n${sampleText}` }
      ],
      temperature: 0.2, maxTokens: 600, label: '群聊画像'
    });

    const raw = response.text || '{}';
    let jsonText = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    try { JSON.parse(jsonText); } catch (_) {
      const lb = jsonText.lastIndexOf('}');
      if (lb >= 0) jsonText = jsonText.slice(0, lb + 1);
      jsonText = jsonText.replace(/,\s*}/g, '}');
      const opens = (jsonText.match(/{/g) || []).length;
      const closes = (jsonText.match(/}/g) || []).length;
      if (opens > closes) jsonText += '}';
    }
    const profile = JSON.parse(jsonText);

    // Track usage
    updateDb((draft) => {
      draft.usage.requests += 1;
      draft.usage.totalTokens += response.usage?.total_tokens || 0;
      draft.usage.promptTokens += response.usage?.prompt_tokens || 0;
      draft.usage.completionTokens += response.usage?.completion_tokens || 0;
      if (!draft.usageEvents) draft.usageEvents = [];
      draft.usageEvents.push({
        id: crypto.randomUUID(), groupId: String(groupId), userId: 'system',
        model: db.settings.model, kind: 'group-profile',
        totalTokens: response.usage?.total_tokens || 0,
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
        createdAt: nowIso()
      });
      draft.usageEvents = draft.usageEvents.slice(-5000);
    });

    updateDb((draft) => {
      if (!draft.groupProfiles) draft.groupProfiles = [];
      const existing = draft.groupProfiles.findIndex((p) => String(p.groupId) === String(groupId));
      const prevEnabled = existing >= 0 ? draft.groupProfiles[existing].enabled : true;
      const entry = {
        groupId: String(groupId),
        enabled: prevEnabled !== false,
        atmosphere: String(profile.atmosphere || '').slice(0, 300),
        topics: String(profile.topics || '').slice(0, 300),
        humorStyle: String(profile.humorStyle || '').slice(0, 300),
        pace: String(profile.pace || '').slice(0, 200),
        boundaries: String(profile.boundaries || '').slice(0, 300),
        botStrategy: String(profile.botStrategy || '').slice(0, 400),
        confidence: Number.isFinite(profile.confidence) ? Math.round(profile.confidence * 100) / 100 : 0.5,
        evidenceCount: samples.length,
        pendingMessageCount: 0,
        lastAutoUpdateAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      if (existing >= 0) {
        entry.createdAt = draft.groupProfiles[existing].createdAt || entry.createdAt;
        draft.groupProfiles[existing] = entry;
      } else {
        draft.groupProfiles.push(entry);
      }
    });

    return { ok: true, profile, sampleCount: samples.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function clearGroupProfile(groupId) {
  updateDb((draft) => {
    if (!draft.groupProfiles) return;
    draft.groupProfiles = draft.groupProfiles.filter((p) => String(p.groupId) !== String(groupId));
  });
  return { ok: true };
}

export function incrementGroupProfilePending(db, groupId, eventText) {
  if (!db.settings.groupProfileAutoUpdate) return;
  // Only count real text — skip media/images/commands/cards
  const text = String(eventText || '').trim();
  if (!text || text.startsWith('/') || text.match(/^\[(图片|表情|表情包|视频|文件|语音|分享卡片)\]/)) return;
  const clean = textWithoutControlPlaceholders(text);
  if (clean.length < 3) return;
  const threshold = Number(db.settings.groupProfileThreshold || 80);
  updateDb((draft) => {
    if (!draft.groupProfiles) draft.groupProfiles = [];
    let gp = draft.groupProfiles.find((p) => String(p.groupId) === String(groupId));
    if (!gp) {
      gp = {
        groupId: String(groupId), enabled: true,
        atmosphere: '', topics: '', humorStyle: '', pace: '', boundaries: '', botStrategy: '',
        confidence: 0, evidenceCount: 0, pendingMessageCount: 0, lastAutoUpdateAt: '',
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      draft.groupProfiles.push(gp);
    }
    gp.pendingMessageCount = (gp.pendingMessageCount || 0) + 1;
    gp.updatedAt = nowIso();
  });
  // Check threshold outside the write lock
  const updated = readDb();
  const profile = (updated.groupProfiles || []).find((p) => String(p.groupId) === String(groupId));
  if (profile && profile.enabled !== false && profile.pendingMessageCount >= threshold) {
    void maybeAutoUpdateGroupProfile(groupId);
  }
}

export async function maybeAutoUpdateGroupProfile(groupId) {
  const db = readDb();
  const gp = (db.groupProfiles || []).find((p) => String(p.groupId) === String(groupId));
  if (!gp || gp.enabled === false) return;
  const threshold = Number(db.settings.groupProfileThreshold || 80);
  if (gp.pendingMessageCount < threshold) return;
  // Reset counter immediately to prevent duplicate triggers
  updateDb((draft) => {
    const p = (draft.groupProfiles || []).find((x) => String(x.groupId) === String(groupId));
    if (p) p.pendingMessageCount = 0;
  });
  try {
    await updateGroupProfile(db, groupId);
  } catch { /* silent fail */ }
}

export function groupProfilePromptBlock(db, groupId) {
  const profile = getGroupProfile(db, groupId);
  if (!profile || profile.enabled === false) return '';
  const parts = [];
  if (profile.atmosphere) parts.push(`整体氛围：${profile.atmosphere}`);
  if (profile.topics) parts.push(`常见话题：${profile.topics}`);
  if (profile.humorStyle) parts.push(`玩笑方式：${profile.humorStyle}`);
  if (profile.pace) parts.push(`聊天节奏：${profile.pace}`);
  if (profile.botStrategy) parts.push(`说话策略：${profile.botStrategy}`);
  if (profile.boundaries) parts.push(`注意边界：${profile.boundaries}`);
  if (!parts.length) return '';
  return '【当前群聊氛围】\n' + parts.join('\n') + '\n以上是群聊氛围参考，不是任何成员的个人画像。根据氛围调整你的说话方式，但不要点名评论具体成员。';
}
