import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const raw = { post_type: 'message', message_type: 'private', message_id: 12345, self_id: 90001, user_id: 70001,
  raw_message: '/w exp 80001 add 10', message: '/w exp 80001 add 10', sender: { nickname: 'fixture-owner' } };
if (process.argv[2] === 'deliver') {
  const { handleOneBotEvent } = await import('../server/onebot.ts');
  const send = async () => ({ kind: 'ok', outcome: 'confirmed_success', messageId: 'fixture' });
  const result = await handleOneBotEvent(raw, send);
  assert.equal((await handleOneBotEvent(raw, send)).result.duplicate, true);
  console.log('delivery=' + (result.result.duplicate ? 'duplicate' : 'executed'));
} else {
  const dir = createTestDataDir('wuxin-inbound-redelivery');
  try {
    const { readDb, updateDb } = await import('../server/store.ts');
    updateDb(db => Object.assign(db.settings, { ownerQq: '70001', selfQq: '90001', oneBotWsUrl: '', oneBotHttpUrl: '' }));
    async function deliver() {
      const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'deliver'],
        { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
      return output.match(/^delivery=(.+)$/m)?.[1];
    }
    assert.deepEqual((await Promise.all([deliver(), deliver()])).sort(), ['duplicate', 'executed']);
    assert.equal(await deliver(), 'duplicate');
    assert.equal(readDb().experience['80001'].xp, 10);
    assert.equal(readDb().commandLogs.length, 1);

    const { beginCommandLog, completeCommandLog } = await import('../server/bot/commands.ts');
    const base = { messageId: '12345', type: 'private', groupId: 'private', userId: '70001', raw: { self_id: 90001 } };
    for (const event of [{ ...base, raw: { self_id: 90002 } }, { ...base, userId: '70002' },
      { ...base, type: 'group', groupId: '1' }, { ...base, type: 'group', groupId: '2' }]) {
      assert.ok(beginCommandLog(event, { command: 'fixture' }));
      completeCommandLog(event);
      assert.equal(beginCommandLog(event, {}), false);
    }
    const { processXpGain } = await import('../server/bot/experience.ts');
    const event = { userId: '70002', type: 'group', groupId: '80002', atTargets: [], text: '这是本群第一条普通聊天消息' };
    const gain = () => processXpGain(event, readDb()).gained;
    assert.equal(gain(), 1);
    assert.equal(readDb().experience[event.userId].xp, 1);
    assert.equal(readDb().groupExperience['80002:70002'].xpInGroup, 1);
    updateDb(db => Object.assign(db.experience[event.userId], { activeDays: 2, streakDays: 2,
      dailyDate: '2000-01-01', lastMsgDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) }));
    assert.equal(gain(), 6.2);
    assert.equal(gain(), 1.2);
    assert.equal(readDb().groupExperience['80002:70002'].msgCount, 3);
    console.log('PASS concurrent and restarted command delivery, account/conversation scope, first XP and once-per-day milestones');
  } finally { cleanupTestDir(dir); }
}
