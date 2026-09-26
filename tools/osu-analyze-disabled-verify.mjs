import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-analyze-disabled-'));

const { handleOsuCommand } = await import('../server/osu/commands.ts');
const replies = [];
const result = await handleOsuCommand(
  { userId: 'fixture-user', groupId: 'fixture-group', type: 'group', atTargets: [] },
  async (_event, text) => replies.push(String(text || '')),
  { isOwner: false, isAdmin: false },
  'analyze',
  'analyze mrekk',
);

assert.equal(result.reason, 'osu analyze 已停用');
assert.match(result.text, /已停用/);
assert.match(replies.join('\n'), /Skill 画像/);
console.log('osu analyze disabled verify: ok');
