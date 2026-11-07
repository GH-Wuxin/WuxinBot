import assert from 'node:assert/strict';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const directory = createTestDataDir('wuxin-command-progress');
process.env.DATA_DIR = directory;
const store = await import('../server/store.ts');
const commands = await import('../server/bot/commands.ts');

store.ensureStore();
const event = { messageId: 'progress-message', type: 'group', groupId: 'progress-group', userId: 'progress-user', nickname: 'Fixture', text: '!p' };
const meta = { prefix: '!', command: 'quick:p', subCommand: '', isWuxinCommand: false, rawText: '!p', userRoleId: '', userPolicy: 'normal' };

try {
  commands.beginCommandLog(event, meta, 'received');
  let log = store.readDb().commandLogs.at(-1);
  assert.equal(log.status, 'active');
  assert.equal(log.stage, 'received');
  assert.equal(log.progress.length, 1);

  commands.setCommandStage(event, 'waiting_external', 'yumu');
  log = store.readDb().commandLogs.at(-1);
  assert.equal(log.status, 'active');
  assert.equal(log.stage, 'waiting_external');
  assert.equal(log.progress.length, 2);

  commands.writeCommandLog(event, meta, { outcome: 'bridge', detail: 'yumu:!p', source: 'yumu' });
  log = store.readDb().commandLogs.at(-1);
  assert.equal(log.status, 'ok');
  assert.equal(log.stage, 'completed');
  assert.equal(log.progress.length, 3);
  assert.ok(log.latencyMs >= 0);
  assert.equal(store.readDb().commandLogs.filter((entry) => entry.messageId === event.messageId).length, 1);
  assert.equal(store.readDb().commandLogs.some((entry) => entry.status === 'active'), false);
  store.updateDb((db) => db.commandLogs.push({ id: 'stale', messageId: 'stale', type: 'group', groupId: 'g', userId: 'u', nickname: 'U',
    command: 'quick:p', subCommand: '', rawText: '!p', isWuxinCommand: false, userRoleId: '', userPolicy: 'normal',
    status: 'active', stage: 'running', reason: '', createdAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
  commands.recoverInterruptedCommandLogs();
  const stale = store.readDb().commandLogs.find((entry) => entry.id === 'stale');
  assert.equal(stale.status, 'timeout');
  assert.equal(stale.stage, 'interrupted');
  console.log('PASS command progress: live stage updates, one final record, and restart recovery');
} finally {
  cleanupTestDir(directory);
}
