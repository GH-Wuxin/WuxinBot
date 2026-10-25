// Opt-in real-model expression review. Synthetic conversations only; no QQ transport.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const args = process.argv.slice(2);
const arg = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : '';
const output = arg('--output'), settingsFile = arg('--settings-source'), baselineRoot = arg('--baseline-root');
const chosen = arg('--cases').split(',').filter(Boolean);
if (!output || !settingsFile) throw new Error('Requires --settings-source <db.json> --output <report.json>; optional --baseline-root <older installed code>.');
const source = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')).settings;
const keys = ['llmProvider', 'model', 'apiKey', 'apiBaseUrl', 'deepseekApiKey', 'deepseekApiBaseUrl', 'codexExecutable',
  'codexModel', 'codexReasoningEffort', 'codexTimeoutMs', 'codexFallbackEnabled', 'codexFallbackProvider', 'codexFallbackModel'];
const directory = createTestDataDir('wuxin-social-style');
process.env.DATA_DIR = directory; process.env.NODE_ENV = 'test'; assertNotProduction(directory);
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { completeChat } = await import('../server/bot/llm.ts');
const { emptySocialState } = await import('../server/bot/social/state.ts');
const { buildAgentAutonomyGuidance, rewriteLegacyToolReferencesForV2 } = await import('../server/bots/agentToolContracts.ts');
const baseline = baselineRoot ? (await import(pathToFileURL(path.join(baselineRoot, 'server/bot/prompt.ts')).href)).buildPrompt : null;
ensureStore();
updateDb((db) => {
  Object.assign(db.settings, Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])), {
    ownerQq: '10001', selfQq: '10002', socialV2Enabled: true, enableAutoModel: false, memoryEnabled: false,
    osuSearchEnabled: false, oneBotHttpUrl: 'http://127.0.0.1:1', oneBotWsUrl: '', oneBotAccessToken: '', thinkingNoticeMode: 'off',
  });
  db.groups = [{ groupId: '20001', name: '合成测试群', enabled: true, mode: 'natural' }];
  db.users = []; db.memories = []; db.groupProfiles = []; db.relationshipProfiles = []; db.ownerDirectives = [];
});
const cases = [
  { id: 'return', text: '我回来了', scores: [0, 50, 100] },
  { id: 'success', text: '过了过了，终于过了！', scores: [0, 50, 100] },
  { id: 'tired', text: '今天好累，想歇会儿', scores: [0, 50, 100] },
  { id: 'banter', text: '你又在嘴硬', history: '我才没在这张图上翻车呢' },
  { id: 'old-prose', text: '你写的结尾也太坏了', history: '你们一个两个记得这么牢，说明我写对了嘛。坏结局才留得住人。下次要甜要虐，你们先表态，我再决定要不要心软。' },
  { id: 'affection', text: '我喜欢你' },
  { id: 'reported-score', text: '他们说我有99分，那你呢' },
  { id: 'at-only', text: '[CQ:at,qq=10002]' },
  { id: 'at-greeting', text: '[CQ:at,qq=10002] 晚上好啊', mode: 'mention' },
  { id: 'at-simple-question', text: '[CQ:at,qq=10002] 你在干嘛呢？', mode: 'mention' },
  { id: 'at-simple-fact', text: '[CQ:at,qq=10002] 7 加 8 等于多少？' },
  { id: 'name-call', text: 'Pippi！', atTargets: [] },
  { id: 'name-simple-question', text: 'pippi 你喜欢下雨天吗？', atTargets: [], mode: 'mention' },
  { id: 'ambient-simple-question', text: '你觉得呢？', atTargets: [], direct: false, history: '晚上一起玩一会儿吧' },
  { id: 'owner-private', text: '你今天想我了吗？', private: true, atTargets: [] },
  { id: 'explanation', text: 'AR 和 OD 有什么区别？各举一个具体例子', task: true },
  { id: 'writing', text: '写一段大约200字的小故事，讲一只猫偷偷搭上末班车，要有结尾', task: true },
];
const report = { at: new Date().toISOString(), provider: source.llmProvider, model: source.model, syntheticOnly: true, cases: [] };
const save = () => { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
try {
  for (const scenario of cases.filter((s) => !chosen.length || chosen.includes(s.id))) for (const score of scenario.scores || [50]) {
    const event = { source: 'onebot', type: scenario.private ? 'private' : 'group', groupId: scenario.private ? 'private' : '20001',
      userId: scenario.private ? '10001' : '10003', nickname: '小甲', messageId: crypto.randomUUID(),
      text: scenario.text, atTargets: scenario.atTargets ?? ['10002'], socialAction: 'reply', socialDirect: scenario.direct ?? true };
    updateDb((db) => {
      db.groups[0].mode = scenario.mode || 'natural';
      db.socialV2 = emptySocialState();
      db.socialV2.people[event.userId] = { userId: event.userId, affinity: { kind: 'ordinary', score }, familiarity: 50, revision: 1, updatedAt: new Date().toISOString() };
      db.messages = scenario.history ? [{ id: 'old', role: 'assistant', type: 'group', groupId: event.groupId, userId: 'bot',
        nickname: 'Pippi', content: scenario.history, inContext: true, createdAt: new Date(Date.now() - 30_000).toISOString() }] : [];
    });
    const row = { id: scenario.id, input: scenario.text, score, task: Boolean(scenario.task), results: [] };
    for (const [label, assemble] of [...(baseline ? [['before', baseline]] : []), ['after', buildPrompt]]) {
      const db = readDb();
      const messages = assemble(db, db.groups[0], event, { policy: 'normal', attentionLevel: 3 }, { includeSkill: false });
      // Same conversational system-layer transformation as the model-first tool loop.
      messages[0].content = rewriteLegacyToolReferencesForV2(messages[0].content) + '\n\n' + buildAgentAutonomyGuidance({ searchEnabled: false });
      const started = Date.now();
      const result = await completeChat(db, { messages, temperature: 0.8, maxTokens: 800, timeoutMs: 30_000,
        thinking: { type: 'disabled' }, tracePurpose: 'conversation_reply', label: 'V2 口语表达回放' });
      row.results.push({ label, text: result.text, chars: result.text.length, durationMs: Date.now() - started, tokens: result.usage?.total_tokens || 0 });
    }
    report.cases.push(row); save(); console.log(`${scenario.id} score=${score}: ${row.results.map((r) => `${r.label} ${r.chars} chars`).join(', ')}`);
  }
} finally { save(); cleanupTestDir(directory); }
