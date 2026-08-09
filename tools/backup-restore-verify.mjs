// backup-restore-verify.mjs — round-trip drill: create backup, mutate db,
// restore, assert the original state comes back. Runs in an isolated DATA_DIR.
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-backup');
process.env.DATA_DIR = testDataDir;

const { ensureStore, updateDb, readDb } = await import('../server/store.ts');
const { createBackup, listBackups, restoreBackup, deleteBackup } = await import('../server/backup.ts');

let failed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

ensureStore();
updateDb((db) => {
  db.settings.ownerQq = 'fixture-owner';
  db.messages = [{ id: 'm1', role: 'user', content: 'hi', groupId: 'g1', userId: 'u1', createdAt: new Date().toISOString() }];
});

const meta = createBackup('manual');
assert(meta && meta.name, 'manual backup must be created');

updateDb((db) => {
  db.settings.ownerQq = 'mutated-owner';
  db.messages.push({ id: 'm2', role: 'user', content: 'after', groupId: 'g1', userId: 'u1', createdAt: new Date().toISOString() });
  db.marker = 'dirty';
});

const restored = restoreBackup(meta.name);
assert(restored.ok, `restore must succeed: ${JSON.stringify(restored)}`);

const db = readDb();
assert(db.settings.ownerQq === 'fixture-owner', 'restored ownerQq must match backup');
assert(db.messages.length === 1, 'restored messages must match backup exactly');
assert(db.marker === undefined, 'post-backup mutation must be gone after restore');
assert(listBackups().some((b) => b.type === 'pre-restore'), 'restore must auto-create a pre-restore backup');
assert(deleteBackup(meta.name).ok, 'manual backup must be deletable');

cleanupTestDir(testDataDir);

if (failed > 0) {
  console.error('BACKUP-RESTORE-VERIFY FAILED');
  process.exit(1);
}
console.log('backup/restore drill passed');
process.exit(0);
