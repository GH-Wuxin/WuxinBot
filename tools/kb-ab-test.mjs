// kb-ab-test.mjs — LLM A/B test for the v4.1 knowledge base.
//
// For each selected scenario it builds two prompts from the exact same event
// and context: Baseline (kb disabled) and KB (kb enabled), then calls the
// configured LLM with the same model/temperature/maxTokens and saves a report.
//
// Usage:
//   npx tsx tools/kb-ab-test.mjs                      # curated scenario set
//   npx tsx tools/kb-ab-test.mjs --scenarios s015,s025 # explicit ids
//   npx tsx tools/kb-ab-test.mjs --dry                 # prompts only, no LLM
//
// The report is written to artifacts/kb-ab/report-<timestamp>.{json,md}.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { scenarios: null, dry: false, maxTokens: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--scenarios') {
      args.scenarios = String(argv[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (key === '--max-tokens') {
      args.maxTokens = Number(argv[i + 1] || 0);
      i += 1;
    } else if (key === '--dry') {
      args.dry = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Default curated set covers every route family + adversarial + none regressions.
const CURATED = [
  's001', 's012', 's014',           // none: command / serious
  's015', 's017', 's018', 's023',   // wuxin_self
  's025', 's026', 's027', 's028', 's031', // osu_domain
  's033', 's035',                   // osu_casual_with_domain
  's039', 's040', 's041',           // self_and_domain
  's043', 's044', 's048', 's054', 's055', // community_style
  's057', 's058', 's060',           // adversarial
];

function prodDbPath() {
  return path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
    'Wuxin',
    'db.json',
  );
}

function readProductionLlmSettings() {
  const file = prodDbPath();
  if (!fs.existsSync(file)) return {};
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = db.settings || {};
  return {
    llmProvider: s.llmProvider || 'deepseek',
    apiKey: s.apiKey || '',
    apiBaseUrl: s.apiBaseUrl || '',
    deepseekApiKey: s.deepseekApiKey || '',
    deepseekApiBaseUrl: s.deepseekApiBaseUrl || '',
    mimoApiKey: s.mimoApiKey || '',
    mimoApiBaseUrl: s.mimoApiBaseUrl || '',
    model: s.model || 'deepseek-v4-flash',
    temperature: Number(s.temperature || 0.4),
    maxTokens: Number(s.maxTokens || 300),
  };
}

const llmSettings = readProductionLlmSettings();

const testDataDir = createTestDataDir('wuxin-kb-ab');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const build = spawnSync('npx.cmd', ['tsx', 'tools/kb-build.mjs', '--data-dir', testDataDir], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
});
if (build.status !== 0) {
  console.error(build.stdout || '');
  console.error(build.stderr || '');
  cleanupTestDir(testDataDir);
  throw new Error('kb-build failed during ab-test');
}
const buildReport = JSON.parse(build.stdout.slice(build.stdout.indexOf('{')));
console.log(`[kb-ab] built ${buildReport.docCounts.wuxin_self}/${buildReport.docCounts.osu_domain}/${buildReport.docCounts.community_style} docs, sha=${buildReport.contentSha.slice(0, 12)}`);

const {
  resetKbForTests,
  retrieveKnowledgeForPrompt,
} = await import('../server/bot/knowledgeBase.ts');
const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');
const { detectScene } = await import('../server/bot/persona.ts');
const { completeChat } = await import('../server/bot/llm.ts');

ensureStore();

const kbEnabledSettings = {
  enabled: true,
  collections: { wuxinSelf: true, osuDomain: true, communityStyle: true },
  rollout: { mode: 'all', groupIds: [], privateMessagesEnabled: true },
};
const kbDisabledSettings = {
  enabled: false,
  collections: { wuxinSelf: true, osuDomain: true, communityStyle: true },
  rollout: { mode: 'off', groupIds: [], privateMessagesEnabled: false },
};

updateDb((db) => {
  db.settings.ownerQq = 'REDACTED_QQ_001';
  db.settings.selfQq = 'REDACTED_QQ_002';
  db.settings.visionMode = 'off';
  db.settings.memoryEnabled = false;
  db.settings.contextLimit = 30;
  db.settings.enableAutoModel = false;
  db.settings.enableWebSearch = false;
  db.settings.thinkingNoticeMode = 'off';
  db.settings.kb = JSON.parse(JSON.stringify(kbDisabledSettings));
  Object.assign(db.settings, llmSettings);
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
});

const scenarios = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'kb-scenarios.json'), 'utf8'));
const selected = (args.scenarios || CURATED).map((id) => scenarios.find((s) => s.id === id)).filter(Boolean);
if (selected.length === 0) {
  console.error('no scenarios matched');
  cleanupTestDir(testDataDir);
  process.exit(1);
}

const group = { groupId: '770001', name: 'KBTest' };
const policy = { policy: 'normal', attentionLevel: 3, allowCommands: true };
const eventFor = (id, text) => ({
  source: 'onebot',
  type: 'group',
  messageId: 'kb-ab-' + id,
  groupId: '770001',
  userId: '10001',
  nickname: 'Tester',
  text,
  atTargets: [],
  images: [],
  raw: {},
});

function withKb(db, settings) {
  return { ...db, settings: { ...db.settings, kb: settings } };
}

async function callOnce(db, messages, label) {
  const started = Date.now();
  try {
    const result = await completeChat(db, {
      messages,
      model: llmSettings.model,
      temperature: llmSettings.temperature,
      maxTokens: args.maxTokens || llmSettings.maxTokens || 300,
      label,
    });
    return {
      ok: true,
      text: result.text,
      latencyMs: result.latencyMs,
      promptTokens: result.usage?.prompt_tokens || 0,
      completionTokens: result.usage?.completion_tokens || 0,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      latencyMs: Date.now() - started,
    };
  }
}

resetKbForTests();
const results = [];

for (const scenario of selected) {
  const event = eventFor(scenario.id, scenario.text);
  const scene = detectScene(event);
  const meta = retrieveKnowledgeForPrompt({
    scene,
    text: scenario.text,
    groupId: event.groupId,
    messageType: 'group',
    settings: kbEnabledSettings,
  });

  const baseDb = withKb(readDb(), kbDisabledSettings);
  const kbDb = withKb(readDb(), kbEnabledSettings);
  const baselineMessages = buildPrompt(baseDb, group, event, policy);
  const kbMessages = buildPrompt(kbDb, group, event, policy);

  const entry = {
    id: scenario.id,
    split: scenario.split,
    scene: scenario.scene,
    text: scenario.text,
    expectedRoute: scenario.expected,
    actualRoute: meta.route.kind,
    routeReason: meta.route.reason,
    blocks: meta.blocks.map((b) => ({
      collection: b.collection,
      documentId: b.documentId,
      title: b.title,
      score: Math.round(b.score * 10000) / 10000,
      chars: b.text.length,
    })),
    injectedChars: meta.blocks.reduce((sum, b) => sum + b.text.length, 0),
    baselinePromptChars: baselineMessages[0].content.length,
    kbPromptChars: kbMessages[0].content.length,
  };

  if (args.dry) {
    results.push({ ...entry, baseline: { ok: true, text: '(dry)' }, kb: { ok: true, text: '(dry)' } });
    continue;
  }

  const baseline = await callOnce(baseDb, baselineMessages, `kb-ab:${scenario.id}:baseline`);
  const kb = await callOnce(kbDb, kbMessages, `kb-ab:${scenario.id}:kb`);
  entry.baseline = baseline;
  entry.kb = kb;
  results.push(entry);
  console.log(
    `[kb-ab] ${scenario.id} route=${entry.actualRoute} blocks=${entry.blocks.length} `
    + `chars+${entry.injectedChars} baseline=${baseline.ok ? baseline.latencyMs + 'ms' : 'ERR'} `
    + `kb=${kb.ok ? kb.latencyMs + 'ms' : 'ERR'}`,
  );
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'artifacts', 'kb-ab');
fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, `report-${timestamp}.json`);
const mdPath = path.join(outDir, `report-${timestamp}.md`);

fs.writeFileSync(jsonPath, JSON.stringify({
  generatedAt: timestamp,
  model: llmSettings.model,
  temperature: llmSettings.temperature,
  dry: args.dry,
  knowledgeSha: buildReport.contentSha,
  results,
}, null, 2), 'utf8');

const md = [];
md.push(`# KB A/B Report — ${timestamp}`);
md.push('');
md.push(`model=${llmSettings.model} temperature=${llmSettings.temperature} dry=${args.dry} sha=${buildReport.contentSha}`);
md.push('');
for (const r of results) {
  md.push(`## ${r.id} [${r.split}] ${r.text}`);
  md.push('');
  md.push(`expected=${r.expectedRoute} actual=${r.actualRoute} blocks=${r.blocks.map((b) => `${b.collection}:${b.documentId}(${b.score})`).join(', ') || '—'} injectedChars=${r.injectedChars}`);
  md.push('');
  md.push('### Baseline');
  md.push('');
  md.push('```');
  md.push(r.baseline?.ok ? r.baseline.text : `ERR: ${r.baseline?.error}`);
  md.push('```');
  md.push('');
  md.push('### KB');
  md.push('');
  md.push('```');
  md.push(r.kb?.ok ? r.kb.text : `ERR: ${r.kb?.error}`);
  md.push('```');
  md.push('');
}
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log(`\n[kb-ab] report: ${jsonPath}`);
console.log(`[kb-ab] markdown: ${mdPath}`);

const okCount = results.filter((r) => r.baseline?.ok && r.kb?.ok).length;
console.log(`[kb-ab] ${okCount}/${results.length} scenarios completed both calls`);

cleanupTestDir(testDataDir);
