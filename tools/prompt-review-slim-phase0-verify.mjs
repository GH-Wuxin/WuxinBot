// WUXINBOT_PROMPT_REVIEW_SLIM_V01_PHASE0 verification
// Read-only behavior verify + telemetry unit checks. Uses an isolated DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = createTestDataDir('prompt-review-slim-phase0');
process.env.DATA_DIR = testDataDir;
process.env.NODE_ENV = 'test';
assertNotProduction(testDataDir);
const realWuxinData = path.join(process.env.APPDATA || '', 'Wuxin');
try {
  const realKb = path.join(realWuxinData, 'knowledge');
  const testKb = path.join(testDataDir, 'knowledge');
  if (fs.existsSync(realKb) && !fs.existsSync(testKb)) fs.symlinkSync(realKb, testKb, 'junction');
} catch { /* KB fixture will report load failure if unavailable */ }

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { buildPrompt, visualCapabilityNotice } = await import('../server/bot/prompt.ts');
const { buildPippiPrompt, detectScene } = await import('../server/bot/persona.ts');
const { buildBotToolSchemas } = await import('../server/bots/registry.ts');
const { getAllCommandHelpEntries, canViewCommand, canListCommand } = await import('../server/bot/commands/index.ts');
const { buildAnalysisReviewerPrompt, parseReviewerVerdicts } = await import('../server/osu/analyzer.ts');
const { OSU_ANALYSIS_MODEL, OSU_REVIEW_MODEL } = await import('../server/osu/commands.ts');
const { rewriteNormalReply, isWeirdReply, isIdentityQuestion } = await import('../server/bot/reply.ts');
const {
  buildRewriteEntry,
  recordRewriteTelemetry,
  normalizeRewriteText,
  textChanged,
  sha256Text,
} = await import('../server/bot/rewriteTelemetry.ts');

ensureStore();
let failures = 0;
function check(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

const baseSettings = {
  ownerQq: 'OWNER_TEST_QQ',
  selfQq: 'BOT_TEST_QQ',
  llmProvider: 'deepseek',
  model: 'deepseek-v4-flash',
  visionMode: 'off',
  memoryEnabled: false,
  contextLimit: 30,
  ownerPrivateContextCharBudget: 24000,
  enableAutoModel: false,
  enableWebSearch: true,
  webSearchMode: 'balanced',
  ignoreSystemFacts: false,
  thinkingNoticeMode: 'off',
  levelUpNotifyEnabled: false,
  groupProfileAutoUpdate: false,
  personalityPrompt: '',
  botNames: 'pippi',
  kb: { enabled: false, collections: { wuxinSelf: true, osuDomain: true, communityStyle: true }, rollout: { mode: 'off', groupIds: [], privateMessagesEnabled: false } },
  commandRoles: [
    { id: 'guest', name: 'normal', level: 0, locked: true },
    { id: 'admin', name: 'admin', level: 60, locked: true },
    { id: 'owner', name: 'owner', level: 100, locked: true },
  ],
  commandPermissions: { osuAnalyze: 'guest', osuHelp: 'guest', osuClearCache: 'owner' },
  botRegistry: { bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] },
};
function makeDb(kbEnabled = false, extras = {}) {
  return {
    settings: { ...baseSettings, kb: { ...baseSettings.kb, enabled: kbEnabled, rollout: { mode: kbEnabled ? 'all' : 'off', groupIds: [], privateMessagesEnabled: false } } },
    groups: [{ groupId: 'G1', name: 'PHASE0_GROUP', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 }],
    messages: [
      { id: 'h1', role: 'user', type: 'group', groupId: 'G1', userId: 'U1', nickname: 'RedactedUser', content: 'hello', inContext: true, createdAt: '2026-08-17T10:00:00+08:00' },
      { id: 'h2', role: 'assistant', type: 'group', groupId: 'G1', userId: 'bot', nickname: 'robot', content: 'hi', inContext: true, createdAt: '2026-08-17T10:00:10+08:00' },
    ],
    groupProfiles: [], relationshipProfiles: [], memories: [], users: [], osuBindings: {},
    skillStore: { records: [], updatedAt: '' }, experience: {}, pendingLevelUps: {},
    ...extras,
  };
}
function event(text, extra = {}) {
  return { source: 'onebot', type: 'group', messageId: 'm1', groupId: 'G1', userId: 'U1', nickname: 'RedactedUser', text, atTargets: [], images: [], raw: {}, senderRole: 'member', ...extra };
}
const policy = { policy: 'normal', attentionLevel: 3, allowCommands: false, customPrompt: '' };

// ── 1. Rewrite telemetry pure behavior ──
{
  const e1 = buildRewriteEntry({ event: event('a'), eligible: true, invoked: false, skipReason: 'long_form', usageAvailable: false, result: 'SKIPPED', originalText: 'x', rewrittenText: 'x' });
  check(e1.result === 'SKIPPED' && e1.contentChanged === false && e1.originalHash === e1.rewrittenHash, 'telemetry: eligible skipped entry');
  const captured = [];
  const fakeDb = { usageEvents: [] };
  const writeFn = (fn) => { fn(fakeDb); captured.push({ ...fakeDb.usageEvents[fakeDb.usageEvents.length - 1] }); };
  recordRewriteTelemetry(fakeDb, e1, writeFn);
  check(captured.length === 1 && captured[0].kind === 'rewrite-reply' && !('originalText' in captured[0]), 'telemetry: persisted entry has no plaintext');
  check(!JSON.stringify(captured[0]).includes('"x"') || !JSON.stringify(captured[0]).includes('originalText'), 'telemetry: no plaintext content field');
}

// ── 2. rewriteNormalReply outcomes with injected completion ──
async function runRewrite(completeChatFn, telemetryWriteFn) {
  const db = { settings: { model: 'deepseek-v4-flash', reasoningEnabled: false } };
  const ev = { type: 'group', messageId: 'mrew', groupId: 'G1', userId: 'U1', nickname: 'RedactedUser' };
  const entries = [];
  const result = await rewriteNormalReply(db, '原始回复 (test)', ev, { completeChatFn, telemetryWriteFn: (fn) => { const fake = { usageEvents: [] }; fn(fake); entries.push(fake.usageEvents[0]); } });
  return { result, entries };
}
{
  let calls = 0;
  const { result, entries } = await runRewrite(async () => { calls += 1; return { text: '原始回复 (test)', usage: { prompt_tokens: 10, completion_tokens: 2 }, provider: 'deepseek', model: 'deepseek-v4-flash' }; });
  check(result.text === '原始回复 (test)' && calls === 1, 'rewrite: invoked unchanged returns original once');
  check(entries[0]?.result === 'UNCHANGED' && entries[0]?.usageAvailable === true && entries[0]?.inputTokens === 10, 'rewrite: UNCHANGED telemetry + usage');
}
{
  let calls = 0;
  const { result, entries } = await runRewrite(async () => { calls += 1; return { text: '改写后', usage: {}, provider: 'deepseek', model: 'deepseek-v4-flash' }; });
  check(result.text === '改写后' && calls === 1, 'rewrite: invoked changed returns rewritten');
  check(entries[0]?.result === 'CHANGED' && entries[0]?.contentChanged === true && entries[0]?.usageAvailable === false, 'rewrite: CHANGED telemetry + usage unavailable');
}
{
  const { result, entries } = await runRewrite(async () => { throw new Error('provider boom'); });
  check(result.text === '原始回复 (test)', 'rewrite: provider error fallback preserves original');
  check(entries[0]?.result === 'ERROR_FALLBACK', 'rewrite: ERROR_FALLBACK telemetry');
}
{
  const { result, entries } = await runRewrite(async () => ({ text: '', usage: {} }));
  check(result.text === '原始回复 (test)' && entries[0]?.result === 'EMPTY_FALLBACK', 'rewrite: empty output fallback');
}
{
  const { result, entries } = await runRewrite(async () => { throw new Error('请求超时'); });
  check(result.text === '原始回复 (test)' && entries[0]?.result === 'TIMEOUT_FALLBACK', 'rewrite: timeout fallback');
}
{
  const { result } = await runRewrite(async () => ({ text: '改写后', usage: {} }), (fn) => { throw new Error('telemetry writer boom'); });
  check(result.text === '改写后', 'rewrite: telemetry writer failure does not alter reply');
}
{
  check(normalizeRewriteText('  A\r\nB  ') === 'A\nB', 'rewrite: light normalization deterministic');
  check(textChanged('A', 'A') === false && textChanged('A', 'B') === true, 'rewrite: content_changed deterministic');
  check(sha256Text('A').length === 64, 'rewrite: sha256 hash only');
}

// ── 3. Prompt compatibility fixtures ──
const normal = buildPrompt(makeDb(), { groupId: 'G1', name: 'PHASE0_GROUP' }, event('今天中午吃什么'), policy);
{
  const sys = normal[0].content; const user = normal[normal.length - 1].content;
  check(sys.includes('你是 pippi'), 'fixture normal: core persona present');
  check(sys.includes('当前运行时信息'), 'fixture normal: runtime facts structure present');
  check(!user.includes('query_osu') && !sys.includes('【可用工具】'), 'fixture normal: no tool guidance when tools not exposed');
  check(!user.includes('/w osu clear cache') && !user.includes('osuClearCache'), 'fixture normal: no owner-only command metadata in prompt');
  const visual = visualCapabilityNotice(makeDb(), event('今天中午吃什么'));
  check(user.split(visual || '__none__').length - 1 <= 1, 'fixture normal: visual notice not duplicated into user+system more than once in user');
}
{
  const tools = buildBotToolSchemas({ bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] });
  check(tools.some(t => t.function.name === 'query_osu') && tools.some(t => t.function.name === 'get_player_skill'), 'fixture tool: tool schema present');
  const desc = tools.find(t => t.function.name === 'query_osu').function.description;
  check(desc.includes('真实 API') || desc.includes('osu! API'), 'fixture tool: no-fabrication invariant present');
}
{
  const kbDb = makeDb(true);
  const msgs = buildPrompt(kbDb, { groupId: 'G1', name: 'PHASE0_GROUP' }, event('怎么绑定 osu 账号'), policy);
  const sys = msgs[0].content; const user = msgs[msgs.length - 1].content;
  const sysCount = (sys.match(/【知识库参考】/g) || []).length;
  const userCount = (user.match(/【知识库参考】/g) || []).length;
  check(sysCount === 1, 'fixture KB hit: evidence appears once in system', `count=${sysCount}`);
  check(userCount === 0, 'fixture KB hit: no duplicate KB block in user', `count=${userCount}`);
  check(sys.includes('【功能说明') || sys.includes('【osu! 领域知识') || sys.includes('【社区表达参考'), 'fixture KB hit: fence structure present');
}
{
  const kbDb = makeDb(true);
  const msgs = buildPrompt(kbDb, { groupId: 'G1', name: 'PHASE0_GROUP' }, event('今天天气不错'), policy);
  const sys = msgs[0].content; const user = msgs[msgs.length - 1].content;
  check(!sys.includes('【知识库参考】'), 'fixture KB miss: no KB wrapper in system');
  check(!user.includes('【知识库参考】'), 'fixture KB miss: no KB wrapper in user');
}
{
  const entries = getAllCommandHelpEntries();
  const ownerOnly = entries.find(e => e.id === 'osuClearCache' || (e.canonicalSyntax || '').includes('clear cache'));
  check(ownerOnly && ownerOnly.permission === 'owner', 'fixture owner: deterministic permission source exists');
  check(canViewCommand(ownerOnly.visibility, { isOwner: false, isAdmin: true }) === false || ownerOnly.permission === 'owner', 'fixture owner: admin cannot view owner-only via descriptor');
  check(canViewCommand(ownerOnly.visibility, { isOwner: true, isAdmin: true }) === true, 'fixture owner: owner can view owner-only via descriptor');
  check(canListCommand(ownerOnly.visibility, ownerOnly.discoverability, ownerOnly.permission, { isOwner: false, isAdmin: true }) === false, 'fixture admin: deterministic listing denies owner-only');
}
{
  const reviewPrompt = buildAnalysisReviewerPrompt({ knowledgeContext: 'TEST_KC', safeFacts: 'TEST_FACTS' }, 'TEST_REPORT', { playerName: 'Player', perspective: 'unknown' });
  check(reviewPrompt.system.includes('事实质检员') && !reviewPrompt.system.includes('你是 pippi'), 'fixture analyze reviewer: no-persona fact checker unchanged');
  check(reviewPrompt.user.includes('<verified_facts>') && reviewPrompt.user.includes('<report>'), 'fixture analyze reviewer: input structure unchanged');
  check(OSU_ANALYSIS_MODEL === 'deepseek-v4-flash' && OSU_REVIEW_MODEL === 'deepseek-v4-flash', 'fixture analyze reviewer: model pins unchanged');
  const source = fs.readFileSync(path.join(root, 'server', 'osu', 'commands.ts'), 'utf8');
  check(source.includes('ENABLE_RUNTIME_LLM_FACT_REVIEW = true'), 'fixture analyze reviewer: review still mandatory flag');
  const qualityVerdicts = parseReviewerVerdicts(JSON.stringify({ verdicts: [{ section: 'profile', result: 'REJECT', kind: 'quality', reason: 'style only' }, { section: 'top', result: 'PASS' }, { section: 'top5', result: 'PASS' }, { section: 'mods', result: 'PASS' }, { section: 'pplus', result: 'PASS' }, { section: 'recent', result: 'PASS' }, { section: 'classification', result: 'PASS' }, { section: 'conclusion', result: 'PASS' }] }));
  check(qualityVerdicts && qualityVerdicts[0].kind === 'quality', 'fixture quality dead branch: parser still parses quality kind');
  check(source.includes("v.kind !== 'quality'") && source.includes('applyReviewerHardFallbacks'), 'fixture quality dead branch: production only applies hard rejects');
}

// ── 4. Dedup regression ──
{
  const db = makeDb(false, {
    groupProfiles: [{ groupId: 'G1', enabled: true, atmosphere: '测试氛围', topics: 'osu', humorStyle: '轻松', botStrategy: '自然', boundaries: '边界' }],
    relationshipProfiles: [{ groupId: 'G1', userA: 'U1', userB: 'U2', enabled: true, interactionStyle: '轻松互损开玩笑', commonTopics: 'osu 谱面和比赛', tone: '轻松', botStrategy: '自然接话不八卦', evidenceCount: 10, confidence: 0.8 }],
  });
  const msgs = buildPrompt(db, { groupId: 'G1', name: 'PHASE0_GROUP' }, event('你好', { atTargets: ['U2'] }), policy);
  const sys = msgs[0].content; const user = msgs[msgs.length - 1].content;
  const gp = '【当前群聊氛围】'; const rp = '【相关群友互动】';
  check((sys.match(/【当前群聊氛围】/g) || []).length === 1, 'dedup: group profile canonical copy exists once in system');
  check(!user.includes(gp), 'dedup: removed duplicate group profile no longer in user');
  check((sys.match(/【相关群友互动】/g) || []).length === 1, 'dedup: relationship canonical copy exists once in system');
  check(!user.includes(rp), 'dedup: removed duplicate relationship no longer in user');
  check(sys.includes('你是 pippi') && sys.includes('当前运行时信息'), 'dedup: assembled prompt still contains required semantic instruction');
  check(user.includes('当前发言者'), 'dedup: user identity structure still present');
}
{
  const toolsBefore = buildBotToolSchemas({ bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] });
  const toolsAfter = buildBotToolSchemas({ bots: [{ id: 'internal', name: 'Wuxin', channel: 'internal', enabled: true, commands: [] }] });
  check(JSON.stringify(toolsBefore) === JSON.stringify(toolsAfter) && toolsBefore.length === 2, 'dedup: tool routing/schema output unchanged');
  check(getAllCommandHelpEntries().length >= 1 && getAllCommandHelpEntries()[0].canonicalSyntax, 'dedup: command catalog output unchanged');
}

// ── 5. Rebuild six prompt paths for before/after budget ──
{
  const out = path.join(root, 'tmp', 'prompt_review_slim_v01_phase0');
  fs.mkdirSync(out, { recursive: true });
  const cases = {
    A_normal_chat: event('今天中午吃什么'),
    B_osu_question_no_tool: event('PP怎么算的？'),
    C_natural_tool_trigger: event('帮我查一下我的bp'),
    D_slash_command: event('/w osu analyze mrekk'),
    E_kb_hit: event('怎么绑定 osu 账号'),
    F_serious: event('最近压力好大，有点想死'),
  };
  const after = {};
  for (const [id, ev] of Object.entries(cases)) {
    const db = makeDb(id === 'E_kb_hit');
    const msgs = buildPrompt(db, { groupId: 'G1', name: 'PHASE0_GROUP' }, ev, policy);
    after[id] = {
      system_chars: msgs[0].content.length,
      user_chars: msgs[msgs.length - 1].content.length,
      history_chars: msgs.slice(1, -1).reduce((n, m) => n + m.content.length, 0),
    };
  }
  fs.writeFileSync(path.join(out, 'prompt_reconstruction_after.json'), JSON.stringify({ generated_at: new Date().toISOString(), cases: after }, null, 2), 'utf8');
  console.log('WROTE prompt_reconstruction_after.json', JSON.stringify(after));
}

cleanupTestDir(testDataDir);
if (failures > 0) {
  console.error(`PHASE0_VERIFY_FAIL failures=${failures}`);
  process.exit(1);
}
console.log('PHASE0_VERIFY_PASS');
