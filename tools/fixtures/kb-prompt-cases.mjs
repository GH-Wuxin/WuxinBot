import { createHash } from 'node:crypto';
import { ensureStore, readDb, updateDb } from '../../server/store.ts';
import { buildPrompt } from '../../server/bot/prompt.ts';

function seedPromptFixture(db) {
  db.settings.ownerQq = 'REDACTED_QQ_001';
  db.settings.selfQq = 'REDACTED_QQ_002';
  db.settings.llmProvider = 'fixture';
  db.settings.apiKey = 'fixture-key';
  db.settings.visionMode = 'off';
  db.settings.memoryEnabled = false;
  db.settings.kb = { ...db.settings.kb, enabled: false };
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
}

const scenarios = [
  ['casual_osu_question', 'PP怎么算的？'],
  ['casual_wuxin_question', '怎么绑定osu账号'],
  ['casual_normal', '今天中午吃什么'],
  ['short_reaction', '666'],
  ['serious', '最近压力好大，有点想死'],
  ['command', '/w osu help'],
  ['analysis_command', '/w skill 123'],
  ['dt_talk', '这把DT开得有点飘'],
];

export function captureDisabledPromptHashes() {
  ensureStore();
  updateDb(seedPromptFixture);
  const db = readDb();
  const group = { groupId: '770001', name: 'KBTest' };
  const policy = { policy: 'normal', attentionLevel: 3, allowCommands: true };
  const result = {};
  for (const [id, text] of scenarios) {
    const event = {
      source: 'onebot', type: 'group', messageId: 'kb-' + id, groupId: group.groupId,
      userId: '10001', nickname: 'Tester', text, atTargets: [], images: [], raw: {},
    };
    const [system] = buildPrompt(db, group, event, policy);
    result[id] = createHash('sha256').update(system.content, 'utf8').digest('hex');
  }
  return result;
}
