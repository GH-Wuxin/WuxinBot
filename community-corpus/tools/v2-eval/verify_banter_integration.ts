// Verify the banter bank is injected only into the casual scene.

import { readDb } from '../../../server/store.js';
import { buildPrompt } from '../../../server/bot/prompt.js';

const db = readDb();
const group = { groupId: 'verify', name: '验证群' };

function promptFor(text: string) {
  const event = {
    type: 'group',
    groupId: 'verify',
    userId: 'u1',
    nickname: '群友',
    text,
    atTargets: [],
  };
  return buildPrompt({ ...db, messages: [] }, group, event, { policy: 'normal' })[0].content;
}

const casual = promptFor('666');
const analyze = promptFor('/w osu analyze mrekk');
const command = promptFor('/w osu recent');
const serious = promptFor('想死');

const checks = [
  ['casual contains banter', casual.includes('【群聊高频反应】'), true],
  ['analyze excludes banter', analyze.includes('【群聊高频反应】'), false],
  ['command excludes banter', command.includes('【群聊高频反应】'), false],
  ['serious excludes banter', serious.includes('【群聊高频反应】'), false],
  ['casual mentions guardrail', casual.includes('不要只回一个词或一个符号'), true],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
process.exitCode = failed ? 1 : 0;
