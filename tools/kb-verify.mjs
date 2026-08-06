// kb-verify.mjs — knowledge base v4.1 acceptance suite.
//
// Covers the ten hard gates from the implementation plan plus:
// - TS-vs-Python golden BM25 comparison (tokenizer/df/idf/score/tie-break)
// - 62 deterministic route scenarios (Calibration/Holdout/Adversarial/Manual)
// - A1 strict legacy-prompt equivalence (byte-for-byte)
// - CommandVerifier freshness for every wuxin_self commandExample
// - A8 query-builder invariants, A6 prompt-budget invariants, A9 quote guard
//
// Exit 0 on all pass, non-zero on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDataDir = createTestDataDir('wuxin-kb');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

// ── 1. Build the knowledge base into the isolated data dir ──

const build = spawnSync('npx.cmd', ['tsx', 'tools/kb-build.mjs', '--data-dir', testDataDir], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
});
if (build.status !== 0) {
  console.error(build.stdout || '');
  console.error(build.stderr || '');
  throw new Error('kb-build failed during verify');
}
const buildReport = JSON.parse(build.stdout.slice(build.stdout.indexOf('{')));
console.log(`[kb] built ${buildReport.docCounts.wuxin_self}/${buildReport.docCounts.osu_domain}/${buildReport.docCounts.community_style} docs, sha=${buildReport.contentSha.slice(0, 12)}`);

// ── 2. Import runtime after DATA_DIR is fixed ──

const {
  resetKbForTests,
  retrieveKnowledgeForPrompt,
  decideKbEnabled,
  buildKbQueryText,
  kbTokenize,
  kbRawSearch,
  getKbHealth,
  kbSentinelPathForTests,
  kbKnowledgeDirForTests,
} = await import('../server/bot/knowledgeBase.ts');
const { toPromptBlocks, formatPromptKnowledgeBlocks, routeCollections, KB_TOTAL_TEXT_BUDGET } = await import('../server/bot/kbPrompt.ts');
const { flagCommunityQuotes } = await import('../server/bot/kbQuoteGuard.ts');
const { routeForText } = await import('../server/bot/kbRoute.ts');
const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { matchQuickCommand } = await import('../server/bot/quickRouter.ts');
const {
  getAllCommandHelpEntries,
  commandDocumentId,
  entryAddress,
  buildCapabilitySummaryDocs,
  canViewCommand,
  canListCommand,
  resolveSummaryAudience,
} = await import('../server/bot/commands/index.ts');
const { parseOsuCommandText, OSU_SUBCOMMANDS, OSU_CLEAR_ACTIONS_META } = await import('../server/bot/commands/osu.meta.ts');
const { parseOwnerCommandText, OWNER_COMMANDS } = await import('../server/bot/commands/owner.meta.ts');
const { resolveQuickCommand, QUICK_DEFS, finalizeQuickDef } = await import('../server/bot/commands/quick.meta.ts');
const { ANALYSIS_COOLDOWN, RECENT_COOLDOWN, RECOMMEND_COOLDOWN } = await import('../server/bot/commands/commandConstants.ts');
const { quickCollisionKey } = await import('../server/bot/commands/alias.ts');

ensureStore();

let passed = 0;
const failures = [];

function check(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS [${label}]`);
  } else {
    failures.push(label);
    console.error(`FAIL [${label}]${detail ? ': ' + detail : ''}`);
  }
}

const enabledSettings = {
  enabled: true,
  collections: { wuxinSelf: true, osuDomain: true, communityStyle: true },
  rollout: { mode: 'all', groupIds: [], privateMessagesEnabled: true },
};

const fixtureDbSetup = (db) => {
  db.settings.ownerQq = 'REDACTED_QQ_001';
  db.settings.selfQq = 'REDACTED_QQ_002';
  db.settings.llmProvider = 'fixture';
  db.settings.apiKey = 'fixture-key';
  db.settings.visionMode = 'off';
  db.settings.memoryEnabled = false;
  db.settings.contextLimit = 30;
  db.settings.enableAutoModel = false;
  db.settings.thinkingNoticeMode = 'off';
  db.groups = [
    { groupId: '770001', name: 'KBTest', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
  ];
  db.messages = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
  db.memories = [];
  db.skillStore = { records: [], updatedAt: '' };
  db.experience = {};
  db.users = [];
};

const fixtureEvent = (id, text, extra = {}) => ({
  source: 'onebot',
  type: 'group',
  messageId: 'kb-' + id,
  groupId: '770001',
  userId: '10001',
  nickname: 'Tester',
  text,
  atTargets: [],
  images: [],
  raw: {},
  ...extra,
});

// ── Gate 1: osu_analysis zero load / zero injection ──

resetKbForTests();
{
  const before = JSON.stringify(getKbHealth().collections);
  const result = retrieveKnowledgeForPrompt({
    scene: 'osu_analysis',
    text: '/w osu analyze mrekk',
    groupId: '770001',
    messageType: 'group',
    settings: enabledSettings,
  });
  const after = JSON.stringify(getKbHealth().collections);
  check(result.blocks.length === 0 && result.route.kind === 'none', 'g2 osu_analysis zero injection');
  check(before === after, 'g2 osu_analysis zero load (statuses unchanged)', `before=${before} after=${after}`);
}

// ── Gate 2: A1 strict legacy equivalence (KB disabled) ──

updateDb(fixtureDbSetup);
{
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'fixtures', 'kb-legacy-prompts.json'), 'utf8'));
  const scenarios = [
    ['casual_osu_question', 'PP怎么算的？'],
    ['casual_wuxin_question', '怎么绑定osu账号'],
    ['casual_normal', '今天中午吃什么'],
    ['short_reaction', '666'],
    ['serious', '最近压力好大，有点想死'],
    ['command', '/w osu help'],
    ['analysis_command', '/w osu analyze mrekk'],
    ['dt_talk', '这把DT开得有点飘'],
  ];
  const group = { groupId: '770001', name: 'KBTest' };
  const policy = { policy: 'normal', attentionLevel: 3, allowCommands: true };
  let ok = true;
  for (const [id, text] of scenarios) {
    const messages = buildPrompt(readDb(), group, fixtureEvent(id, text), policy);
    if (messages[0].content !== fixture[id]) {
      ok = false;
      console.error(`  A1 mismatch: ${id}`);
    }
  }
  check(ok, 'g1 KB disabled prompt byte-identical to legacy fixture');
}

// ── Gate 3: deterministic routing (scenario set) ──

{
  const scenarios = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'kb-scenarios.json'), 'utf8'));
  const closed = new Set(['none', 'wuxin_self', 'osu_domain', 'community_style', 'self_and_domain', 'osu_casual_with_domain', 'capability_summary']);
  let ok = true;
  for (const scenario of scenarios) {
    const got = routeForText(scenario.scene, scenario.text).kind;
    if (!closed.has(got)) {
      ok = false;
      console.error(`  route ${scenario.id} returned non-closed kind ${got}`);
    }
    if (got !== scenario.expected) {
      ok = false;
      console.error(`  route ${scenario.id} expected ${scenario.expected} got ${got}: ${scenario.text}`);
    }
  }
  check(ok, 'g3 routing scenarios + closed enum', `total=${scenarios.length}`);
}

// ── Gate 4: golden TS vs Python BM25 ──

{
  const queries = [
    { id: 'q1', collection: 'wuxin_self', query: '怎么绑定osu账号' },
    { id: 'q2', collection: 'wuxin_self', query: '推图怎么用' },
    { id: 'q3', collection: 'wuxin_self', query: '等级经验有什么用' },
    { id: 'q4', collection: 'osu_domain', query: '加权pp怎么算' },
    { id: 'q5', collection: 'osu_domain', query: 'mods基础' },
    { id: 'q6', collection: 'osu_domain', query: 'ranked和loved的区别' },
    { id: 'q7', collection: 'community_style', query: 'aim比我强好多' },
    { id: 'q8', collection: 'community_style', query: '单戳练读图，会读了就能打' },
    { id: 'q9', collection: 'community_style', query: 'hd到底怎么玩' },
    { id: 'q10', collection: 'community_style', query: '我们S1大人已经10k了' },
    { id: 'q11', collection: 'osu_domain', query: 'DT提升多少BPM' },
    { id: 'q12', collection: 'wuxin_self', query: '清除推图历史怎么弄' },
  ];
  const queriesPath = path.join(testDataDir, 'kb-golden-queries.json');
  const outputPath = path.join(testDataDir, 'kb-golden-output.json');
  fs.writeFileSync(queriesPath, JSON.stringify(queries), 'utf8');
  const knowledgeRoot = kbKnowledgeDirForTests();
  const pythonCmd = (() => {
    const probe = spawnSync('python', ['--version'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    return probe.status === 0 ? 'python' : 'py';
  })();
  const golden = spawnSync(pythonCmd, ['tools/kb-golden-ref.py', '--knowledge-root', knowledgeRoot, '--queries', queriesPath, '--output', outputPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  check(golden.status === 0, 'g4 python golden reference runs', golden.stderr || golden.stdout);
  if (golden.status === 0) {
    const expected = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    let ok = true;
    for (const item of expected) {
      const actual = kbRawSearch(item.collection, item.query, 10);
      const same = actual.length === item.top.length && actual.every((row, i) => {
        const other = item.top[i];
        return row.documentId === other.documentId && Math.abs(row.score - other.score) < 0.00011;
      });
      if (!same) {
        ok = false;
        console.error(`  golden mismatch ${item.id} (${item.collection}): ${item.query}`);
        console.error('    expected', JSON.stringify(item.top));
        console.error('    actual  ', JSON.stringify(actual));
      }
    }
    check(ok, 'g4 TS BM25 matches Python golden (tokens/df/idf/score/tie-break)');
  }
}

// ── Gate 5: enabled retrieval sanity + community topK cap ──

resetKbForTests();
{
  const result = retrieveKnowledgeForPrompt({
    scene: 'casual',
    text: '怎么绑定osu账号',
    groupId: '770001',
    messageType: 'group',
    settings: enabledSettings,
  });
  const bindIds = result.blocks.map((b) => b.documentId);
  check(
    result.route.kind === 'wuxin_self'
    && bindIds.includes('cmd:wuxin_osu:bind')
    && bindIds.includes('bind_osu')
    && !bindIds.includes('cmd:wuxin_osu:clear.bind'),
    'g5 wuxin_self bind query hits canonical + manual bind docs, never clear.bind',
    JSON.stringify(bindIds),
  );

  const communityQueries = ['aim比我强好多', '单戳练读图，会读了就能打', 'hd到底怎么玩', '我们S1大人已经10k了', '今天aim手感炸了'];
  let capOk = true;
  for (const text of communityQueries) {
    const r = retrieveKnowledgeForPrompt({ scene: 'casual', text, groupId: '770001', messageType: 'group', settings: enabledSettings });
    const communityBlocks = r.blocks.filter((b) => b.collection === 'community_style');
    if (communityBlocks.length > 1) {
      capOk = false;
      console.error(`  community topK over cap for: ${text} (${communityBlocks.length})`);
    }
  }
  check(capOk, 'g5 community_style ≤1 block per query');

  const combined = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'PP+怎么用', groupId: '770001', messageType: 'group', settings: enabledSettings });
  check(combined.route.kind === 'self_and_domain', 'g5 combined route explicit self_and_domain');

  const ar = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'AR是什么', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const arIds = ar.blocks.filter((b) => b.collection === 'osu_domain').map((b) => b.documentId);
  check(arIds.includes('attributes') && arIds.includes('ar_detail'), 'g5 tag anchors keep AR docs above minScore', JSON.stringify(arIds));

  const hdhr = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'HD和HR有什么区别', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const hdhrIds = hdhr.blocks.map((b) => b.documentId);
  check(
    hdhrIds.includes('mods_core') && !hdhrIds.includes('mod_ht') && !hdhrIds.includes('grade_detail'),
    'g5 tag anchors drop one-token noise docs for HD/HR',
    JSON.stringify(hdhrIds),
  );

  const bonus = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'bonus pp是什么', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const bonusIds = bonus.blocks.filter((b) => b.collection === 'osu_domain').map((b) => b.documentId);
  check(bonusIds.includes('performance_detail') && bonusIds.includes('bp_pp_rank'), 'g5 bonus pp ranks real pp docs first', JSON.stringify(bonusIds));

  const ppp = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'PP+怎么用', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const pppIds = ppp.blocks.map((b) => `${b.collection}:${b.documentId}`);
  check(pppIds.includes('wuxin_self:quick_score_commands') && pppIds.includes('osu_domain:bp_pp_rank'), 'g5 PP+ usage hits quick command + pp docs', JSON.stringify(pppIds));

  const bindShort = retrieveKnowledgeForPrompt({ scene: 'casual', text: '绑定怎么弄', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const bindShortIds = bindShort.blocks.map((b) => b.documentId);
  check(bindShortIds.includes('bind_osu') && !bindShortIds.includes('quick_score_commands'), 'g5 short bind query selects bind_osu via tags', JSON.stringify(bindShortIds));

  const capPublic = retrieveKnowledgeForPrompt({
    scene: 'casual',
    text: '你能做什么',
    groupId: '770001',
    messageType: 'group',
    settings: enabledSettings,
    permissions: { isOwner: false, isAdmin: false },
  });
  check(
    capPublic.route.kind === 'capability_summary'
    && capPublic.blocks.length === 1
    && capPublic.blocks[0].documentId === 'summary:all:public',
    'g5 capability overview returns exactly one public summary doc',
    JSON.stringify(capPublic.blocks.map((b) => b.documentId)),
  );
  const capAdmin = retrieveKnowledgeForPrompt({
    scene: 'casual',
    text: '你能做什么',
    groupId: '770001',
    messageType: 'group',
    settings: enabledSettings,
    permissions: { isOwner: false, isAdmin: true },
  });
  check(
    capAdmin.blocks.length === 1 && capAdmin.blocks[0].documentId === 'summary:all:group_admin',
    'g5 capability overview uses admin audience summary',
    JSON.stringify(capAdmin.blocks.map((b) => b.documentId)),
  );
  const capOwner = retrieveKnowledgeForPrompt({
    scene: 'casual',
    text: '你能做什么',
    groupId: '770001',
    messageType: 'group',
    settings: enabledSettings,
    permissions: { isOwner: true, isAdmin: true },
  });
  check(
    capOwner.blocks.length === 1 && capOwner.blocks[0].documentId === 'summary:all:owner',
    'g5 capability overview uses owner audience summary',
    JSON.stringify(capOwner.blocks.map((b) => b.documentId)),
  );
}

// ── Gate 6: rollout allowlist switches without restart ──

{
  const allow = { ...enabledSettings, rollout: { mode: 'allowlist', groupIds: ['770001'], privateMessagesEnabled: true } };
  const denied = { ...enabledSettings, rollout: { mode: 'allowlist', groupIds: ['999999'], privateMessagesEnabled: false } };
  const first = decideKbEnabled({ settings: allow, groupId: '770001', messageType: 'group' });
  const second = decideKbEnabled({ settings: denied, groupId: '770001', messageType: 'group' });
  const third = decideKbEnabled({ settings: allow, groupId: '770001', messageType: 'group' });
  check(first.enabled && second.enabled === false && third.enabled, 'g6 allowlist switches without restart');
  const privateAllowed = decideKbEnabled({ settings: { ...enabledSettings, rollout: { mode: 'allowlist', groupIds: [], privateMessagesEnabled: true } }, messageType: 'private' });
  check(privateAllowed.enabled, 'g6 private messages rollout flag');
}

// ── Gate 7: fail closed (sentinel + db unavailable + env hard disable) ──

{
  resetKbForTests();
  fs.mkdirSync(path.dirname(kbSentinelPathForTests()), { recursive: true });
  fs.writeFileSync(kbSentinelPathForTests(), '1', 'utf8');
  const sentinel = decideKbEnabled({ settings: enabledSettings, groupId: '770001', messageType: 'group' });
  check(sentinel.enabled === false && sentinel.source === 'sentinel', 'g7 sentinel fails closed');
  resetKbForTests();
  fs.rmSync(kbSentinelPathForTests(), { force: true });

  const corruptDir = createTestDataDir('wuxin-kb-corrupt');
  process.env.DATA_DIR = testDataDir;
  fs.writeFileSync(path.join(corruptDir, 'db.json'), '{not-json', 'utf8');
  const sub = spawnSync('npx.cmd', ['tsx', '-e',
    `(async () => { process.env.DATA_DIR = ${JSON.stringify(corruptDir)}; const m = await import('./server/bot/knowledgeBase.ts'); console.log(JSON.stringify(m.decideKbEnabled({}))); })()`,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  let dbDecision = null;
  try { dbDecision = JSON.parse((sub.stdout || '').trim().split('\n').pop()); } catch { /* keep null */ }
  check(
    sub.status === 0 && dbDecision && dbDecision.enabled === false && dbDecision.source === 'db_unavailable',
    'g7 db read failure fails closed',
    `status=${sub.status} out=${sub.stdout} err=${sub.stderr}`,
  );
  cleanupTestDir(corruptDir);

  const envSub = spawnSync('npx.cmd', ['tsx', '-e',
    `(async () => { process.env.KB_ENABLED = 'false'; process.env.DATA_DIR = ${JSON.stringify(testDataDir)}; const m = await import('./server/bot/knowledgeBase.ts'); console.log(JSON.stringify(m.decideKbEnabled({settings: ${JSON.stringify(enabledSettings)}, groupId: '770001', messageType: 'group'}))); })()`,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  let envDecision = null;
  try { envDecision = JSON.parse((envSub.stdout || '').trim().split('\n').pop()); } catch { /* keep null */ }
  check(
    envSub.status === 0 && envDecision && envDecision.enabled === false && envDecision.source === 'env',
    'g7 KB_ENABLED=false startup hard veto',
    `status=${envSub.status} out=${envSub.stdout} err=${envSub.stderr}`,
  );
}

// ── Gate 8: manifest reproducibility ──

{
  const dirA = createTestDataDir('wuxin-kb-repro-a');
  const dirB = createTestDataDir('wuxin-kb-repro-b');
  process.env.DATA_DIR = testDataDir;
  for (const dir of [dirA, dirB]) {
    const b = spawnSync('npx.cmd', ['tsx', 'tools/kb-build.mjs', '--data-dir', dir], { cwd: root, encoding: 'utf8', timeout: 120_000 });
    if (b.status !== 0) throw new Error('repro build failed: ' + (b.stderr || b.stdout));
  }
  const readManifest = (dir) => {
    const sha = fs.readFileSync(path.join(dir, 'knowledge', 'CURRENT'), 'utf8').trim();
    return JSON.parse(fs.readFileSync(path.join(dir, 'knowledge', 'builds', sha, 'manifest.json'), 'utf8'));
  };
  const m1 = readManifest(dirA);
  const m2 = readManifest(dirB);
  check(JSON.stringify(m1.content) === JSON.stringify(m2.content), 'g8 manifest content reproducible');
  check(m1.build.generatedAt !== m2.build.generatedAt, 'g8 build metadata volatile (generatedAt differs)');
  cleanupTestDir(dirA);
  cleanupTestDir(dirB);
}

// ── Gate 9: hash quarantine (tampered file must not load) ──

{
  resetKbForTests();
  const osuPath = path.join(knowledgeRootFor(kbKnowledgeDirForTests()), 'osu_domain.json');
  const original = fs.readFileSync(osuPath, 'utf8');
  fs.writeFileSync(osuPath, original + '\n//tampered', 'utf8');
  const result = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'AR是什么', groupId: '770001', messageType: 'group', settings: enabledSettings });
  const health = getKbHealth();
  check(
    result.blocks.length === 0
    && health.collections.osu_domain.status === 'failed'
    && String(health.collections.osu_domain.errorCode || '').includes('KB_COLLECTION_HASH_MISMATCH'),
    'g9 tampered collection fails hash quarantine',
    JSON.stringify(health.collections.osu_domain),
  );
  fs.writeFileSync(osuPath, original, 'utf8');
  resetKbForTests();
  const recovered = retrieveKnowledgeForPrompt({ scene: 'casual', text: 'AR是什么', groupId: '770001', messageType: 'group', settings: enabledSettings });
  check(getKbHealth().collections.osu_domain.status === 'ready' && recovered.blocks.length >= 0, 'g9 restore after quarantine reloads');
}

function knowledgeRootFor(knowledgeDirPath) {
  const sha = fs.readFileSync(path.join(knowledgeDirPath, 'CURRENT'), 'utf8').trim();
  return path.join(knowledgeDirPath, 'builds', sha);
}

// ── Gate 10: commandExamples verified via pure resolvers + runtime matcher ──

{
  const wuxinSelf = JSON.parse(fs.readFileSync(path.join(knowledgeRootFor(kbKnowledgeDirForTests()), 'wuxin_self.json'), 'utf8'));
  const entries = getAllCommandHelpEntries();
  const entryByDocId = new Map(entries.map((e) => [commandDocumentId(entryAddress(e)), e]));
  const ownerMetaById = new Map(OWNER_COMMANDS.map((m) => [m.id, m]));
  let ok = true;
  let verified = 0;
  const fail = (message) => {
    ok = false;
    console.error('  ' + message);
  };
  for (const entry of wuxinSelf) {
    for (const example of entry.commandExamples || []) {
      verified += 1;
      const command = String(example.command || '');
      if (example.verifier === 'quick') {
        const pure = resolveQuickCommand(command);
        const runtime = matchQuickCommand({ text: command, atTargets: [] });
        if (!pure || !runtime) {
          fail(`stale quick example: ${command}`);
          continue;
        }
        const pureDef = finalizeQuickDef(pure.def);
        const runtimeDef = finalizeQuickDef(runtime.def);
        if (pureDef.id !== runtimeDef.id || pureDef.source !== runtimeDef.source) {
          fail(`quick resolver drift: ${command} pure=${pureDef.id}/${pureDef.source} runtime=${runtimeDef.id}/${runtimeDef.source}`);
          continue;
        }
        if (pureDef.status !== 'active' || pureDef.execution.kind === 'documentation_only') {
          fail(`quick example not executable: ${command}`);
          continue;
        }
        if (entry.id.startsWith('cmd:quick:')) {
          const expected = entryByDocId.get(entry.id);
          if (!expected) {
            fail(`no descriptor for doc ${entry.id}`);
            continue;
          }
          if (pureDef.id !== expected.id || (expected.source && pureDef.source !== expected.source)) {
            fail(`quick example mis-hits another command: ${command} -> ${pureDef.id}/${pureDef.source}, expected ${expected.id}/${expected.source}`);
            continue;
          }
        }
      } else if (example.verifier === 'wuxin') {
        if (/^\/w(?:uxin)?\s+osu(?:\s|$)/i.test(command)) {
          const parsed = parseOsuCommandText(command);
          if (!parsed) {
            fail(`stale wuxin osu example: ${command}`);
            continue;
          }
          if (entry.id.startsWith('cmd:wuxin_osu:')) {
            const path = entry.id.slice('cmd:wuxin_osu:'.length).split('.');
            const expectedCmd = path[0];
            const expectedAction = path[1];
            if (parsed.commandId !== expectedCmd || (expectedAction && parsed.actionId !== expectedAction)) {
              fail(`wuxin osu example mis-hits: ${command} -> ${JSON.stringify(parsed)}, expected ${expectedCmd}${expectedAction ? '.' + expectedAction : ''}`);
              continue;
            }
          } else if (!entry.id.startsWith('cmd:')) {
            const meta = parsed.commandId === 'clear' ? OSU_CLEAR_ACTIONS_META[parsed.actionId] : OSU_SUBCOMMANDS[parsed.commandId];
            if (!meta || meta.status !== 'active') {
              fail(`manual osu example points at inactive command: ${command}`);
              continue;
            }
          }
        } else {
          const parsed = parseOwnerCommandText(command);
          if (!parsed) {
            fail(`stale wuxin example: ${command}`);
            continue;
          }
          if (entry.id.startsWith('cmd:wuxin:')) {
            const expectedId = entry.id.slice('cmd:wuxin:'.length);
            if (parsed.id.toLowerCase() !== expectedId) {
              fail(`wuxin example mis-hits: ${command} -> ${parsed.id}, expected ${expectedId}`);
              continue;
            }
          } else if (!entry.id.startsWith('cmd:')) {
            const meta = ownerMetaById.get(parsed.id);
            if (!meta || meta.status !== 'active') {
              fail(`manual wuxin example points at inactive command: ${command}`);
              continue;
            }
          }
        }
      } else {
        fail(`unknown verifier: ${example.verifier} (${command})`);
      }
    }
  }
  check(ok, 'g10 commandExamples verified via pure resolvers + runtime matcher', `verified=${verified}`);
}

// ── Gate 11: descriptor/doc-id uniqueness + quick alias sanity ──

{
  const entries = getAllCommandHelpEntries();
  const docIds = new Map();
  let duplicate = null;
  for (const entry of entries) {
    const id = commandDocumentId(entryAddress(entry));
    if (docIds.has(id)) {
      duplicate = `${id} (${docIds.get(id)} vs ${entry.id})`;
      break;
    }
    docIds.set(id, entry.id);
  }
  check(!duplicate, 'g11 command document ids unique', duplicate || `entries=${entries.length}`);
  const emptyAlias = entries.filter((e) => e.namespace === 'quick' && e.aliases.length === 0).map((e) => e.id);
  check(emptyAlias.length === 0, 'g11 every quick entry has at least one alias', JSON.stringify(emptyAlias));
}

// ── Gate 12: status × execution combination table ──

{
  const entries = getAllCommandHelpEntries();
  let ok = true;
  for (const entry of entries) {
    const why = `${entry.namespace}:${entry.id}`;
    if (entry.status === 'active') {
      if (entry.execution.kind === 'local' && !entry.execution.handlerKey) {
        ok = false;
        console.error(`  active local missing handlerKey: ${why}`);
      }
      if (entry.execution.kind === 'proxy' && (!entry.execution.capability || !entry.execution.targetBot)) {
        ok = false;
        console.error(`  active proxy missing capability/targetBot: ${why}`);
      }
      if (entry.execution.kind === 'documentation_only' && !entry.execution.reason) {
        ok = false;
        console.error(`  active documentation_only missing reason: ${why}`);
      }
    }
    if (entry.status === 'deprecated' && !entry.deprecation) {
      ok = false;
      console.error(`  deprecated without replacement/termination note: ${why}`);
    }
  }
  check(ok, 'g12 status×execution combination table (active local/proxy/documentation_only, deprecated metadata)');
  const hiddenDocs = JSON.parse(fs.readFileSync(path.join(knowledgeRootFor(kbKnowledgeDirForTests()), 'wuxin_self.json'), 'utf8'))
    .filter((doc) => doc.id.startsWith('cmd:') && doc.visibility === 'hidden');
  check(hiddenDocs.length === 0, 'g12 hidden/disabled commands never enter public KB docs', JSON.stringify(hiddenDocs.map((d) => d.id)));
}

// ── Gate 13: cooldown single-source identity ──

{
  let ok = true;
  if (OSU_SUBCOMMANDS.analyze.cooldown !== ANALYSIS_COOLDOWN) {
    ok = false;
    console.error('  analyze cooldown is not the shared ANALYSIS_COOLDOWN object');
  }
  if (OSU_SUBCOMMANDS.recent.cooldown !== RECENT_COOLDOWN) {
    ok = false;
    console.error('  recent cooldown is not the shared RECENT_COOLDOWN object');
  }
  for (const def of QUICK_DEFS) {
    if ((def.id === 'recommend' || def.id === 'rd') && def.cooldown !== RECOMMEND_COOLDOWN) {
      ok = false;
      console.error(`  quick ${def.id} cooldown is not RECOMMEND_COOLDOWN`);
    }
  }
  check(ok, 'g13 cooldown ms/scope/resettableBy single-sourced from commandConstants');
}

// ── Gate 14: meta purity (static whitelist + isolated import) ──

{
  const dir = path.join(root, 'server', 'bot', 'commands');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  let ok = true;
  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('./')) {
        ok = false;
        console.error(`  ${file} imports non-relative specifier: ${specifier}`);
        continue;
      }
      const resolved = path.resolve(dir, specifier);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        ok = false;
        console.error(`  ${file} imports outside commands dir: ${specifier}`);
      }
    }
  }
  check(ok, 'g14 meta static dependency whitelist (only ./ within server/bot/commands)');
  const isolatedDir = createTestDataDir('wuxin-kb-meta-import');
  const sub = spawnSync('npx.cmd', ['tsx', '-e',
    `(async () => { process.env.DATA_DIR = ${JSON.stringify(isolatedDir)}; await import('./server/bot/commands/index.ts'); console.log('META_OK'); })()`,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  process.env.DATA_DIR = testDataDir;
  const wroteDb = fs.existsSync(path.join(isolatedDir, 'db.json'));
  check(
    sub.status === 0 && /META_OK/.test(sub.stdout || '') && !wroteDb,
    'g14 meta modules import without db/fs side effects',
    `status=${sub.status} out=${sub.stdout} err=${sub.stderr} wroteDb=${wroteDb}`,
  );
  cleanupTestDir(isolatedDir);
}

// ── Gate 15: visibility/listing consistency between help and KB ──

{
  const docs = JSON.parse(fs.readFileSync(path.join(knowledgeRootFor(kbKnowledgeDirForTests()), 'wuxin_self.json'), 'utf8'));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const entries = getAllCommandHelpEntries();
  const audiences = [
    ['public', { isOwner: false, isAdmin: false }],
    ['group_admin', { isOwner: false, isAdmin: true }],
    ['owner', { isOwner: true, isAdmin: true }],
  ];
  const isWuxinOsuHelp = (entry) => entry.namespace === 'wuxin' && entry.family === 'osu';
  const canonicalSubById = { osuBind: 'bind', osuAnalyze: 'analyze', osuRecent: 'recent', osuHelp: 'help' };
  let ok = true;
  for (const [label, perms] of audiences) {
    for (const entry of entries) {
      if (isWuxinOsuHelp(entry)) continue;
      const docId = commandDocumentId(entryAddress(entry));
      const doc = docById.get(docId);
      const viewable = canViewCommand(entry.visibility, perms);
      if (viewable && !doc) {
        ok = false;
        console.error(`  ${label}: no KB doc for viewable entry ${docId}`);
      }
      if (doc && doc.visibility !== entry.visibility) {
        ok = false;
        console.error(`  ${label}: doc visibility mismatch ${docId}: ${doc.visibility} vs meta ${entry.visibility}`);
      }
      if (canListCommand(entry.visibility, entry.discoverability, entry.permission, perms) && !doc) {
        ok = false;
        console.error(`  ${label}: listed entry has no KB doc ${docId}`);
      }
    }
  }
  for (const entry of entries.filter(isWuxinOsuHelp)) {
    const canonical = entries.find((e) => e.namespace === 'wuxin_osu' && e.id === canonicalSubById[entry.id]);
    if (!canonical) {
      ok = false;
      console.error(`  help entry ${entry.id} has no canonical wuxin_osu KB doc`);
    }
  }
  const ownerTargets = ['清除缓存怎么弄', '/w exp 怎么用', 'clear cooldown 是什么'];
  for (const text of ownerTargets) {
    const r = retrieveKnowledgeForPrompt({
      scene: 'casual',
      text,
      groupId: '770001',
      messageType: 'group',
      settings: enabledSettings,
      permissions: { isOwner: false, isAdmin: false },
    });
    for (const block of r.blocks) {
      if (block.collection !== 'wuxin_self') continue;
      const doc = docById.get(block.documentId);
      if (doc && (doc.visibility === 'owner' || doc.visibility === 'group_admin')) {
        ok = false;
        console.error(`  normal-user retrieval leaked ${doc.visibility} doc: ${block.documentId} for "${text}"`);
      }
    }
  }
  check(ok, 'g15 canView/canList consistent across help + KB, owner docs invisible to normal users');
}

// ── Gate 16: capability summaries per-audience, cumulative, single-select ──

{
  const summaries = buildCapabilitySummaryDocs();
  const ids = summaries.map((s) => s.id);
  check(
    ids.length === new Set(ids).size && summaries.every((s) => /^summary:[a-z_]+:(public|group_admin|owner)$/.test(s.id)),
    'g16 summary doc ids unique and audience-tagged',
    `count=${summaries.length}`,
  );
  const allPublic = summaries.find((s) => s.id === 'summary:all:public');
  const allAdmin = summaries.find((s) => s.id === 'summary:all:group_admin');
  const allOwner = summaries.find((s) => s.id === 'summary:all:owner');
  const osuPublic = summaries.find((s) => s.id === 'summary:osu:public');
  const has = (doc, token) => doc && doc.content.includes(token);
  check(
    allPublic && allAdmin && allOwner
    && !has(allPublic, '/w exp')
    && !has(allPublic, '/w status')
    && has(allAdmin, '/w status')
    && !has(allAdmin, '/w exp')
    && has(allOwner, '/w exp'),
    'g16 summaries cumulative per audience (public ⊂ group_admin ⊂ owner)',
    `public=${allPublic ? allPublic.content.length : 0} admin=${allAdmin ? allAdmin.content.length : 0} owner=${allOwner ? allOwner.content.length : 0}`,
  );
  check(
    osuPublic && has(osuPublic, '/w osu bind'),
    'g16 osu summary keeps canonical osu commands',
    `osuPublic=${osuPublic ? osuPublic.content.length : 0}`,
  );
  check(
    resolveSummaryAudience({ isOwner: false, isAdmin: false }) === 'public'
    && resolveSummaryAudience({ isOwner: false, isAdmin: true }) === 'group_admin'
    && resolveSummaryAudience({ isOwner: true, isAdmin: true }) === 'owner',
    'g16 resolveSummaryAudience picks exactly one level',
  );
}

// ── Gate 17: /w osu clear strict parse fixtures ──

{
  const bare = parseOsuCommandText('/w osu clear');
  const caches = parseOsuCommandText('/w osu clear caches');
  const cache = parseOsuCommandText('/w osu clear cache');
  const cacheExtra = parseOsuCommandText('/w osu clear cache xxx');
  check(
    bare === null
    && caches === null
    && cache && cache.commandId === 'clear' && cache.actionId === 'cache' && cache.args === ''
    && cacheExtra && cacheExtra.commandId === 'clear' && cacheExtra.actionId === 'cache' && cacheExtra.args === 'xxx',
    'g17 clear parse fixtures (bare/unknown no-execute, cache exact, extra args captured for rejection)',
    `bare=${JSON.stringify(bare)} caches=${JSON.stringify(caches)} cache=${JSON.stringify(cache)} extra=${JSON.stringify(cacheExtra)}`,
  );
}

// ── Gate 18: build output sorted by id ──

{
  const docs = JSON.parse(fs.readFileSync(path.join(knowledgeRootFor(kbKnowledgeDirForTests()), 'wuxin_self.json'), 'utf8'));
  const ids = docs.map((d) => d.id);
  const sorted = [...ids].sort((a, b) => a.localeCompare(b));
  check(JSON.stringify(ids) === JSON.stringify(sorted), 'g18 wuxin_self docs serialized in stable id order');
  check(ids.length === new Set(ids).size, 'g18 no duplicate doc ids', `count=${ids.length}`);
}

// ── A8 query builder invariants ──

{
  const context = [
    { role: 'user', userId: 'bot', content: '这是一条 bot 输出，应该被排除' },
    { role: 'user', userId: '10002', content: '今天aim手感炸了' },
    { role: 'assistant', userId: 'bot', content: 'bot 回复' },
    { role: 'user', userId: '10003', content: '!bp 1-100' },
    { role: 'user', userId: '10004', content: 'QQ号 12345678 也要被去掉' },
    { role: 'user', userId: '10005', content: '串图怎么练' },
  ];
  const text = buildKbQueryText('怎么绑定osu账号', context);
  const parts = text.split('\n---\n');
  check(parts[parts.length - 1] === '怎么绑定osu账号', 'a8 current message last');
  check(!text.includes('bot 输出') && !text.includes('!bp') && !text.includes('12345678'), 'a8 bot/commands/qq stripped', text);
  check(parts.length <= 6, 'a8 max 5 context messages + current');
  check(parts.includes('今天aim手感炸了') && parts.includes('串图怎么练'), 'a8 keeps real human text in time order');

  const longContext = Array.from({ length: 20 }, (_, i) => ({ role: 'user', userId: String(10000 + i), content: '这是一个很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的上下文消息用于测试长度截断行为' }));
  const longText = buildKbQueryText('当前消息', longContext);
  check(longText.length <= 500 + 40, 'a8 500-char cap', `len=${longText.length}`);
}

// ── A6 prompt budget invariants ──

{
  const route = { kind: 'self_and_domain', reason: 'test' };
  const plans = routeCollections(route);
  check(plans.some((p) => p.collection === 'wuxin_self') && plans.some((p) => p.collection === 'osu_domain'), 'a6 combined route has explicit plans');
  const fake = [
    { collection: 'wuxin_self', documentId: 'x1', title: 'T', text: '命令：/w osu bind <用户名>\n' + '填充'.repeat(2000), score: 9 },
    { collection: 'osu_domain', documentId: 'x2', title: 'T2', text: '加权'.repeat(1500), score: 8 },
  ];
  const blocks = toPromptBlocks(fake, route);
  const total = blocks.reduce((sum, b) => sum + b.text.length, 0);
  check(total <= KB_TOTAL_TEXT_BUDGET, 'a6 total text budget ≤1500', `total=${total}`);
  check(blocks.find((b) => b.sourceClass === '功能说明')?.text.startsWith('命令：/w osu bind'), 'a6 canonical command line intact');
  const formatted = formatPromptKnowledgeBlocks(blocks);
  check(
    formatted.includes('【知识库参考】')
    && formatted.includes('【功能说明')
    && formatted.includes('【osu! 领域知识'),
    'a6 formatter renders combined blocks',
  );
}

// ── A9 quote guard ──

{
  const corpus = [
    { id: 'W000001', content: 'S1 最后的转盘单点是哪个呆逼摆的\nS2 94掉到92.7' },
    { id: 'W000002', content: 'S1 我跪了' },
  ];
  const flagged = flagCommunityQuotes('最后的转盘单点是哪个呆逼摆的，你说是不是', corpus);
  check(flagged.length >= 1 && flagged[0].sourceId === 'W000001', 'a9 long verbatim chunk flagged for review');
  const generic = flagCommunityQuotes('我跪了', corpus);
  check(generic.length === 0, 'a9 generic short phrase ignored');
  const clean = flagCommunityQuotes('今天天气不错，随便聊两句', corpus);
  check(clean.length === 0, 'a9 unrelated output not flagged');
}

// ── Tokenizer sanity ──

{
  const tokens = kbTokenize('99ACC吗 这图aim 666 PP AR HD');
  check(
    tokens.has('acc') && tokens.has('aim') && tokens.has('pp') && tokens.has('ar') && tokens.has('hd')
    && tokens.has('99') === false && tokens.has('666') === false
    && tokens.has('这图') && tokens.has('图a') === false,
    'a-tokenize python-compatible (v3: 2-letter osu acronyms indexed)',
    JSON.stringify([...tokens]),
  );

  const stopTokens = kbTokenize('HD和HR有什么区别？PP怎么算的？');
  check(
    stopTokens.has('hd') && stopTokens.has('hr') && stopTokens.has('pp')
    && stopTokens.has('和有') === false
    && stopTokens.has('怎么') === false
    && stopTokens.has('什么') === false,
    'a-tokenize v3: generic question/connective bigrams dropped as stopwords',
    JSON.stringify([...stopTokens]),
  );
}

// ── Final: production db untouched ──

verifyProductionDbUnchanged(prodBefore);
console.log(`\n[kb-verify] ${passed} checks passed, ${failures.length} failed`);
if (failures.length) {
  console.error('Failures:\n  ' + failures.join('\n  '));
  cleanupTestDir(testDataDir);
  process.exit(1);
}
cleanupTestDir(testDataDir);
console.log('[kb-verify] ALL PASS');
