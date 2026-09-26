import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.DATA_DIR = path.join(process.env.APPDATA || '', 'Wuxin');
const { buildPrompt } = await import(pathToFileURL(path.join(root, 'server', 'bot', 'prompt.ts')).href);
const { buildPippiPrompt, detectScene } = await import(pathToFileURL(path.join(root, 'server', 'bot', 'persona.ts')).href);
const { buildOsuTopicKnowledge } = await import(pathToFileURL(path.join(root, 'server', 'osu', 'knowledge', 'index.ts')).href);
const { buildBotToolSchemas } = await import(pathToFileURL(path.join(root, 'server', 'bots', 'registry.ts')).href);
const { buildQueryOsuDescription } = await import(pathToFileURL(path.join(root, 'server', 'bots', 'agentCapabilities.ts')).href);
const { getAllCommandHelpEntries, buildCapabilitySummaryDocs, commandKnowledgeText } = await import(pathToFileURL(path.join(root, 'server', 'bot', 'commands', 'index.ts')).href);
const { buildAnalysisReviewerPrompt } = await import(pathToFileURL(path.join(root, 'server', 'osu', 'analyzer.ts')).href);
const baseSettings = {
  ownerQq: 'REDACTED_QQ_OWNER', selfQq: 'REDACTED_QQ_SELF', llmProvider: 'deepseek', model: 'deepseek-v4-flash',
  visionMode: 'off', memoryEnabled: false, contextLimit: 30, ownerPrivateContextCharBudget: 24000, enableAutoModel: false,
  enableWebSearch: true, webSearchMode: 'balanced', ignoreSystemFacts: false, thinkingNoticeMode: 'off', levelUpNotifyEnabled: false,
  groupProfileAutoUpdate: false, personalityPrompt: '', botNames: 'pippi',
  kb: { enabled: false, collections: { wuxinSelf: true, osuDomain: true, communityStyle: true }, rollout: { mode: 'off', groupIds: [], privateMessagesEnabled: false } },
  commandRoles: [ { id: 'guest', name: 'normal', level: 0, locked: true }, { id: 'admin', name: 'admin', level: 60, locked: true }, { id: 'owner', name: 'owner', level: 100, locked: true } ],
  commandPermissions: { osuAnalyze: 'guest', osuHelp: 'guest' }
};
function makeDb(kbEnabled = false) {
  return {
    settings: { ...baseSettings, kb: { ...baseSettings.kb, enabled: kbEnabled, rollout: { mode: kbEnabled ? 'all' : 'off', groupIds: [], privateMessagesEnabled: false } } },
    groups: [{ groupId: '770001', name: 'AUDIT_GROUP', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 }],
    messages: [
      { id: 'h1', role: 'user', type: 'group', groupId: '770001', userId: 'U0001', nickname: 'RedactedUser', content: 'hello', inContext: true, createdAt: '2026-08-17T10:00:00+08:00' },
      { id: 'h2', role: 'assistant', type: 'group', groupId: '770001', userId: 'bot', nickname: 'robot', content: 'hi', inContext: true, createdAt: '2026-08-17T10:00:10+08:00' }
    ],
    groupProfiles: [], relationshipProfiles: [], memories: [], users: [], osuBindings: {},
    skillStore: { records: [], updatedAt: '' }, experience: {}, pendingLevelUps: {}
  };
}
const group = { groupId: '770001', name: 'AUDIT_GROUP' };
function event(text, extra = {}) { return { source: 'onebot', type: 'group', messageId: 'audit-1', groupId: '770001', userId: 'U0001', nickname: 'RedactedUser', text, atTargets: [], images: [], raw: {}, senderRole: 'member', ...extra }; }
const normalPolicy = { policy: 'normal', attentionLevel: 3, allowCommands: false, customPrompt: '' };
const ownerPolicy = { policy: 'owner', attentionLevel: 5, allowCommands: true, customPrompt: '' };
const cases = {
  A_normal_chat: event('\u4eca\u5929\u4e2d\u5348\u5403\u4ec0\u4e48'),
  B_osu_question_no_tool: event('PP\u600e\u4e48\u7b97\u7684\uff1f'),
  C_natural_tool_trigger: event('\u5e2e\u6211\u67e5\u4e00\u4e0b\u6211\u7684bp'),
  D_slash_command: event('/w osu analyze mrekk'),
  E_kb_hit: event('\u600e\u4e48\u7ed1\u5b9a osu \u8d26\u53f7'),
  F_serious: event('\u6700\u8fd1\u538b\u529b\u597d\u5927\uff0c\u6709\u70b9\u60f3\u6b7b'),
  G_owner: event('please review the group incident again', { userId: 'OWNER', nickname: 'OwnerUser' })
};
const result = { generated_at: new Date().toISOString(), cases: {}, static_components: {} };
for (const [id, ev] of Object.entries(cases)) {
  const kbEnabled = id === 'E_kb_hit';
  const db = makeDb(kbEnabled);
  const policy = id === 'G_owner' ? ownerPolicy : normalPolicy;
  const messages = buildPrompt(db, group, ev, policy);
  const sys = messages[0]?.content || '';
  const user = messages[messages.length - 1]?.content || '';
  const history = messages.slice(1, -1).map(m => ({ role: m.role, content: m.content }));
  const scene = detectScene(ev);
  const corePrompt = buildPippiPrompt({ scene, userPersonality: '', relationshipContext: undefined, topicKnowledge: undefined, factualContext: undefined });
  const topicKnowledge = buildOsuTopicKnowledge(ev.text) || '';
  result.cases[id] = {
    scene, kb_enabled: kbEnabled,
    messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: user }],
    sizes: { system_chars: sys.length, system_bytes: Buffer.byteLength(sys, 'utf8'), user_chars: user.length, user_bytes: Buffer.byteLength(user, 'utf8'), history_chars: history.reduce((n, h) => n + h.content.length, 0), history_messages: history.length, core_persona_scene_chars: corePrompt.length, topic_knowledge_chars: topicKnowledge.length }
  };
}
const registry = { bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] };
const tools = buildBotToolSchemas(registry);
const queryDesc = buildQueryOsuDescription();
const commandEntries = getAllCommandHelpEntries();
const commandSummaryDocs = buildCapabilitySummaryDocs();
const botSource = fs.readFileSync(path.join(root, 'server', 'bot.ts'), 'utf8');
const toolNoteMatch = botSource.match(/\u3010\u53ef\u7528\u5de5\u5177\u3011[\s\S]*?';/);
const rewriteSource = fs.readFileSync(path.join(root, 'server', 'bot', 'reply.ts'), 'utf8');
const rewriteSystemMatch = rewriteSource.match(/content: `\u628a\u4e0b\u9762\u8fd9\u53e5 QQ \u7fa4\u804a\u56de\u590d\u6539\u5199\u6210\u6b63\u5e38\u3001\u514b\u5236\u3001\u81ea\u7136\u7684\u7fa4\u53cb\u8bed\u6c14\u3002[\s\S]*?`/);
const reviewerMinimal = buildAnalysisReviewerPrompt({ knowledgeContext: 'AUDIT_PLACEHOLDER_KNOWLEDGE_CONTEXT', safeFacts: 'player: test\nPP: 1234\n' }, 'AUDIT PLACEHOLDER REPORT', { playerName: 'AuditPlayer', perspective: 'unknown' });
result.static_components = {
  tool_schema: tools,
  query_osu_description_chars: queryDesc.length,
  query_osu_description_bytes: Buffer.byteLength(queryDesc, 'utf8'),
  tool_note_chars: toolNoteMatch ? toolNoteMatch[0].length : null,
  tool_note_text: toolNoteMatch ? toolNoteMatch[0].slice(0, 200) : null,
  rewrite_system_chars: rewriteSystemMatch ? rewriteSystemMatch[0].length : null,
  rewrite_system_text: rewriteSystemMatch ? rewriteSystemMatch[0] : null,
  reviewer_system_chars: reviewerMinimal.system.length,
  reviewer_user_chars: reviewerMinimal.user.length,
  reviewer_system_text: reviewerMinimal.system,
  reviewer_user_text: reviewerMinimal.user,
  command_catalog_count: commandEntries.length,
  capability_summary_doc_count: commandSummaryDocs.length,
  capability_summary_chars: commandSummaryDocs.reduce((n, d) => n + d.content.length, 0),
  command_knowledge_sample: commandEntries.slice(0, 3).map(commandKnowledgeText),
};
const outDir = path.join(root, 'tmp', 'prompt_review_audit_v01');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'prompt_reconstruction.json'), JSON.stringify(result, null, 2), 'utf8');
console.log('WROTE prompt_reconstruction.json');
for (const [id, c] of Object.entries(result.cases)) console.log(id, JSON.stringify(c.sizes));
console.log('static', { queryDescChars: result.static_components.query_osu_description_chars, toolNoteChars: result.static_components.tool_note_chars, rewriteSystemChars: result.static_components.rewrite_system_chars, reviewerSystemChars: result.static_components.reviewer_system_chars, reviewerUserChars: result.static_components.reviewer_user_chars, commandCatalogCount: result.static_components.command_catalog_count, capabilitySummaryChars: result.static_components.capability_summary_chars });
