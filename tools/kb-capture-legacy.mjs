// kb-capture-legacy.mjs — snapshot buildPrompt system prompts BEFORE the KB
// layer is wired in. kb-verify.mjs compares the KB-disabled output against
// these exact strings (A1 strict equivalence, no normalization).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tools', 'fixtures', 'kb-legacy-prompts.json');

const testDataDir = createTestDataDir('wuxin-kb-legacy');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { buildPrompt } = await import('../server/bot/prompt.ts');

ensureStore();
updateDb((db) => {
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
    { groupId: '900000007', name: 'KBTest', enabled: true, mode: 'natural', maxPerHour: 100, cooldownSec: 0 },
  ];
  db.messages = [];
  db.groupProfiles = [];
  db.relationshipProfiles = [];
  db.memories = [];
  db.skillStore = { records: [], updatedAt: '' };
  db.experience = {};
  db.users = [];
});

const scenario = (id, text, extra = {}) => ({
  id,
  event: {
    source: 'onebot',
    type: 'group',
    messageId: 'legacy-' + id,
    groupId: '900000007',
    userId: '10001',
    nickname: 'Tester',
    text,
    atTargets: [],
    images: [],
    raw: {},
    ...extra,
  },
});

const scenarios = [
  scenario('casual_osu_question', 'PP怎么算的？'),
  scenario('casual_wuxin_question', '怎么绑定osu账号'),
  scenario('casual_normal', '今天中午吃什么'),
  scenario('short_reaction', '666'),
  scenario('serious', '最近压力好大，有点想死'),
  scenario('command', '/w osu help'),
  scenario('analysis_command', '/w osu analyze mrekk'),
  scenario('dt_talk', '这把DT开得有点飘'),
];

const group = { groupId: '900000007', name: 'KBTest' };
const userPolicy = { policy: 'normal', attentionLevel: 3, allowCommands: true };

const captured = {};
for (const s of scenarios) {
  const messages = buildPrompt(readDb(), group, s.event, userPolicy);
  captured[s.id] = messages[0].content;
}

fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
fs.writeFileSync(fixturePath, JSON.stringify(captured, null, 2), 'utf8');
console.log('captured ' + Object.keys(captured).length + ' legacy prompts -> ' + fixturePath);

cleanupTestDir(testDataDir);
