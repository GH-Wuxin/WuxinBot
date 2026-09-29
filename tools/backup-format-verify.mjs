// backup-format-verify.mjs — S01 format recognition and restore gate checks.
// All files are created under a temporary DATA_DIR.

import fs from 'node:fs';
import path from 'node:path';
import {
  assertNotProduction,
  cleanupTestDir,
  createTestDataDir,
} from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-backup-format');
assertNotProduction(dataDir);
let passed = 0;
let failed = 0;

function check(condition, message, detail = '') {
  if (condition) {
    console.log(`PASS [${message}]`);
    passed++;
  } else {
    console.error(`FAIL [${message}] ${detail}`);
    failed++;
  }
}

const store = await import('../server/store.ts');
const backup = await import('../server/backup.ts');

try {
  store.ensureStore();
  const emptyLogicalDb = {
    settings: {},
    users: [],
    groups: [],
    memories: [],
    messages: [],
    decisions: [],
  };
  const currentLogicalDb = store.readDb();
  const validMarker = {
    format: 'wuxin-sharded-v1',
    version: 1,
    revision: 'fixture-revision',
    shards: { profiles: 'db-profiles.json' },
  };

  check(store.isValidLogicalDbShape(emptyLogicalDb), 'legal empty logical database is valid');
  check(store.isValidLogicalDbShape(currentLogicalDb), 'current exporter shape is valid');
  check(store.isValidLogicalDbShape({ ...emptyLogicalDb, _storage: validMarker }), 'recognized storage marker is valid');
  check(!store.isValidLogicalDbShape({ settings: {}, users: [], groups: [], memories: [] }), 'partial core fragment is rejected');
  check(!store.isValidLogicalDbShape({}), 'empty object is rejected');
  check(!store.isValidLogicalDbShape([]), 'array root is rejected');
  check(!store.isValidLogicalDbShape(null), 'null root is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, settings: [] }), 'settings type error is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, users: {} }), 'collection type error is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, commandLogs: {} }), 'optional collection type error is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, _storage: { format: 'unknown', version: 1 } }), 'unknown storage format is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, _storage: { format: 'wuxin-sharded-v1', version: 2, shards: {} } }), 'future storage version is rejected');
  check(!store.isValidLogicalDbShape({ ...emptyLogicalDb, _storage: { format: 'wuxin-sharded-v1', version: 1 } }), 'incomplete storage marker is rejected');

  store.updateDb((db) => {
    store.saveConfigSnapshot(db);
    db.settings.ownerQq = 'snapshot-round-trip';
  });
  const created = backup.createBackup('manual');
  check(Boolean(created?.name), 'current backup is created');
  const createdPayload = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', created.name), 'utf8'));
  check(store.isValidLogicalDbShape(createdPayload), 'current backup payload is recognized');
  check(Array.isArray(createdPayload.configSnapshots), 'exported config snapshots keep their array shape');

  store.updateDb((db) => { db.settings.ownerQq = 'before-snapshot-restore'; });
  const snapshotRestore = backup.restoreBackup(created.name);
  check(snapshotRestore.ok, 'backup with config snapshots restores successfully');
  check(store.readDb().settings.ownerQq === 'snapshot-round-trip', 'snapshot backup restores settings');

  store.updateDb((db) => { db.settings.ownerQq = 'keep-before-invalid-restore'; });
  const backupDir = path.join(dataDir, 'backups');
  fs.writeFileSync(path.join(backupDir, 'fragment.json'), JSON.stringify({
    settings: {}, users: [], groups: [], memories: [],
  }), 'utf8');
  const fragmentRestore = backup.restoreBackup('fragment.json');
  check(!fragmentRestore.ok, 'fragment restore is rejected');
  check(store.readDb().settings.ownerQq === 'keep-before-invalid-restore', 'fragment restore does not rewrite data');

  fs.writeFileSync(path.join(backupDir, 'future.json'), JSON.stringify({
    ...emptyLogicalDb,
    _storage: { format: 'wuxin-sharded-v1', version: 2, shards: {} },
  }), 'utf8');
  const futureRestore = backup.restoreBackup('future.json');
  check(!futureRestore.ok, 'future-format restore is rejected');
  check(store.readDb().settings.ownerQq === 'keep-before-invalid-restore', 'future-format restore does not rewrite data');

  fs.writeFileSync(path.join(backupDir, 'fixture.json.meta.json'), JSON.stringify(createdPayload), 'utf8');
  const metaRestore = backup.restoreBackup('fixture.json.meta.json');
  check(!metaRestore.ok, 'meta sidecar is not restorable as a backup');

  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    settings: {},
    _storage: { format: 'wuxin-sharded-v2', version: 2, shards: {} },
  }), 'utf8');
  let unknownMarkerRejected = false;
  try {
    store.ensureStore();
  } catch (error) {
    unknownMarkerRejected = /存储标记不受支持/.test(String(error?.message || error));
  }
  check(unknownMarkerRejected, 'unknown storage marker stops startup migration');
} finally {
  cleanupTestDir(dataDir);
}

console.log(`\nBACKUP-FORMAT-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
