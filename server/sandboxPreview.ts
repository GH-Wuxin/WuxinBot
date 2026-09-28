// Sandbox preview: pure gate/prompt computation for the console.
// Preview inputs must never reach the authoritative store: readDb() returns the
// process-wide cached object, so any field mutated here would leak into later
// unrelated commits (finding F06). Everything taken from the store that the
// preview overrides or passes to downstream helpers is copied first.
import { readDb } from './store.js';
import { decideReply } from './bot.js';
import { buildPrompt } from './bot/prompt.js';
import { callLLM } from './bot/llm.js';
import { hasGroupProfileContent } from './bot/groupProfile.js';

function ok(data = {}) {
  return { ok: true, ...data };
}

function cloneGroup(group: any): any {
  return structuredClone(group);
}

export async function runSandboxPreview(body: any = {}) {
  const db = readDb();
  const groupId = String(body.groupId || (db.groups[0]?.groupId) || '10001');
  const userId = String(body.userId || 'sandbox-user');
  const nickname = body.nickname || 'SandboxUser';
  const text = String(body.text || '你好');
  const atTargets = body.atTargets || [];

  // Build overrides
  const policyOverride = body.memberPolicy || null;
  const modeOverride = body.groupMode || null;
  const useMemory = body.useMemory !== false;
  const useGroupProfile = body.useGroupProfile !== false;
  const useRelationship = body.useRelationship !== false;
  const useSkill = body.useSkill !== false;
  const callLlm = body.callLlm === true;

  // Get real or overridden data. The group is deep-copied before the override
  // so the preview cannot flip the live group mode in the authoritative cache.
  const foundGroup = db.groups.find((g) => String(g.groupId) === groupId);
  const group = foundGroup ? cloneGroup(foundGroup) : { groupId, name: `群 ${groupId}`, enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 };
  if (modeOverride) group.mode = modeOverride;
  let userPolicy = db.users.find((u) => String(u.groupId) === groupId && String(u.userId) === userId) || { policy: 'normal', attentionLevel: 3, allowCommands: false };
  if (policyOverride) userPolicy = { ...userPolicy, policy: policyOverride };
  if (String(userId) === String(db.settings.ownerQq)) userPolicy = { policy: 'owner', attentionLevel: 5, allowCommands: true };

  // Text mentions
  const botNames = String(db.settings.botNames || 'Wuxin').split(',');
  const selfQq = db.settings.selfQq || '';
  const mentioned = atTargets.includes(selfQq) || botNames.some((n) => text.includes(n)) || text.includes(`[CQ:at,qq=${selfQq}]`);

  // Decision
  const decision = await decideReply({ db, group, userPolicy, text, mentioned, userId });

  // Context preview
  const sandboxEvent = { type: 'group', groupId, userId, nickname, text, atTargets };
  const messages = buildPrompt(db, group, sandboxEvent, userPolicy, {
    includeSkill: useSkill,
    includeMemory: useMemory,
    includeGroupProfile: useGroupProfile,
    includeRelationship: useRelationship,
  });
  const promptPreview = messages.map((m) => `[${m.role}]\n${m.content.slice(0, 500)}`).join('\n\n---\n\n').slice(0, 3000);

  // Profile previews
  const memory = useMemory ? (db.memories || []).find((m) => String(m.userId) === userId) : null;
  const rawGroupProfile = useGroupProfile ? (db.groupProfiles || []).find((p) => String(p.groupId) === groupId) : null;
  const gp = rawGroupProfile && hasGroupProfileContent(rawGroupProfile) ? rawGroupProfile : null;
  const rels = useRelationship ? (db.relationshipProfiles || []).filter((p) => String(p.groupId) === groupId && (p.userA === userId || p.userB === userId)) : [];

  // Optional LLM call
  let replyPreview = '';
  let usage = null;
  if (callLlm && decision.shouldReply) {
    try {
      // Keep the system prompt (persona) at all costs; only the recent history
      // is trimmed when the context is longer than the sandbox budget.
      const llmMessages = messages.length > 10
        ? [messages[0], ...messages.slice(-9)]
        : messages;
      const ai = await callLLM(db, llmMessages, db.settings.enableWebSearch ? (db.settings.webSearchMode || 'balanced') : null, { maxTokens: 300 });
      replyPreview = ai.text || '';
      usage = ai.usage || null;
    } catch (e: any) { replyPreview = `LLM 调用失败: ${e.message}`; }
  }

  return ok({
    decision: { shouldReply: decision.shouldReply, reason: decision.reason },
    context: {
      group: `${group.name || groupId} (${group.mode})`,
      userPolicy: userPolicy.policy,
      memoryProfile: memory ? { summary: memory.summary?.slice(0, 80), traits: memory.traits?.slice(0, 60) } : null,
      groupProfile: gp ? { atmosphere: gp.atmosphere?.slice(0, 60), confidence: gp.confidence } : null,
      relationshipProfiles: rels.map((r) => ({ pair: `${r.userA}↔${r.userB}`, style: r.interactionStyle?.slice(0, 40) })),
    },
    promptPreview,
    replyPreview,
    usage,
  });
}
