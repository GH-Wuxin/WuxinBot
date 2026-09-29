// store-recovery-failure-verify.mjs — S02 failure-injection checks.
// All storage roots are temporary. fs faults are restored immediately after
// the synchronous recovery call returns.

import fs from 'node:fs';
import path from 'node:path';
import { assertNotProduction, cleanupTestDir, createTestDataDir } from './test-isolation.mjs';

let passed = 0;
let failed = 0;
const dirs = [];

function check(condition, label, detail = '') {
  if (condition) {
    console.log(`PASS [${label}]`);
    passed++;
  }
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

function freshDir(label) {
  const dir = createTestDataDir(`wuxin-store-failure-${label}`);
  dirs.push(dir);
  assertNotProduction(dir);
  return dir;
}

function dbPath(dir) { return path.join(dir, 'db.json'); }
function shardPaths(dir) {
  return ['db-profiles.json', 'db-messages.json', 'db-decisions.json', 'db-telemetry.json', 'db-osu.json']
    .map((name) => path.join(dir, name));
}
function snapshotFiles(files) {
  return files.map((file) => [file, fs.readFileSync(file).toString('base64')]);
}
function unchanged(snapshot) {
  return snapshot.every(([file, value]) => fs.readFileSync(file).toString('base64') === value);
}

const store = await import('../server/store.ts');
const backup = await import('../server/backup.ts');

try {
  // A copy/evidence failure must stop before any restore write and leave all
  // authoritative files byte-for-byte unchanged.
  {
    const dir = freshDir('copy-failure');
    store.updateDb((db) => { db.settings.ownerQq = 'copy-failure-original'; });
    backup.createBackup('manual');
    const authoritative = [dbPath(dir), ...shardPaths(dir)];
    const before = snapshotFiles(authoritative);
    fs.writeFileSync(dbPath(dir), '{broken', 'utf8');
    const originalCopy = fs.copyFileSync;
    let error = null;
    try {
      fs.copyFileSync = () => { const fault = new Error('injected evidence EIO'); fault.code = 'EIO'; throw fault; };
      store.openStore();
    } catch (caught) {
      error = caught;
    } finally {
      fs.copyFileSync = originalCopy;
    }
    check(error?.reason === 'access' && /无法保全权威文件/.test(String(error?.message)), 'copy failure is classified and aborts', String(error?.message || error));
    check(fs.readFileSync(dbPath(dir), 'utf8') === '{broken', 'copy failure does not restore core');
    check(unchanged(before.slice(1)), 'copy failure does not rewrite healthy shards');
  }

  // A valid candidate whose destination write fails must stop at that
  // candidate; it must not fall through to an older valid snapshot.
  {
    const dir = freshDir('write-failure');
    store.updateDb((db) => { db.settings.ownerQq = 'older-candidate'; });
    const older = JSON.parse(JSON.stringify(store.readDb()));
    store.updateDb((db) => { db.settings.ownerQq = 'newer-candidate'; });
    const newer = JSON.parse(JSON.stringify(store.readDb()));
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const olderPath = path.join(backupDir, 'older.json');
    const newerPath = path.join(backupDir, 'newer.json');
    fs.writeFileSync(olderPath, JSON.stringify(older), 'utf8');
    fs.writeFileSync(newerPath, JSON.stringify(newer), 'utf8');
    fs.utimesSync(olderPath, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    fs.utimesSync(newerPath, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
    fs.writeFileSync(dbPath(dir), '{broken', 'utf8');

    const originalRename = fs.renameSync;
    let renameAttempts = 0;
    let error = null;
    try {
      fs.renameSync = (...args) => {
        renameAttempts++;
        const fault = new Error('injected restore EIO');
        fault.code = 'EIO';
        throw fault;
      };
      store.openStore();
    } catch (caught) {
      error = caught;
    } finally {
      fs.renameSync = originalRename;
    }
    check(error?.reason === 'anomaly' && /恢复写入失败/.test(String(error?.message)), 'valid write failure aborts recovery', String(error?.message || error));
    check(renameAttempts === 1, 'valid write failure does not try an older candidate', `attempts=${renameAttempts}`);
    check(fs.readFileSync(dbPath(dir), 'utf8') === '{broken', 'write failure does not commit a core marker');
  }

  // Invalid candidates remain skippable; a later valid candidate is still
  // eligible for recovery.
  {
    const dir = freshDir('bad-then-good');
    store.updateDb((db) => { db.settings.ownerQq = 'good-candidate'; });
    const good = JSON.parse(JSON.stringify(store.readDb()));
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'good.json'), JSON.stringify(good), 'utf8');
    fs.writeFileSync(path.join(backupDir, 'bad-newer.json'), '{not-json', 'utf8');
    fs.utimesSync(path.join(backupDir, 'good.json'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    fs.utimesSync(path.join(backupDir, 'bad-newer.json'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
    fs.writeFileSync(dbPath(dir), '{broken', 'utf8');
    store.openStore();
    check(store.readDb().settings.ownerQq === 'good-candidate', 'invalid candidate is skipped before valid candidate');
  }

  // A shard that exists but cannot be read is an access error, not a missing
  // shard/corruption candidate that may trigger destructive recovery.
  {
    const dir = freshDir('shard-access');
    store.ensureStore();
    const shard = path.join(dir, 'db-profiles.json');
    fs.rmSync(shard, { force: true });
    fs.mkdirSync(shard);
    // Bump the core signature so the real disk-read path cannot reuse the
    // process-local cache created by ensureStore() above.
    const now = new Date();
    fs.utimesSync(dbPath(dir), now, now);
    let error = null;
    try { store.openStore(); } catch (caught) { error = caught; }
    check(error?.reason === 'access' && /db-profiles\.json/.test(String(error?.message)), 'unreadable shard is classified as access', String(error?.message || error));
    check(fs.statSync(shard).isDirectory(), 'unreadable shard is not replaced');
    check(!fs.readdirSync(dir).some((name) => name.includes('.corrupt-')), 'shard access does not start recovery');
  }
} finally {
  for (const dir of dirs) cleanupTestDir(dir);
}

console.log(`\nSTORE-RECOVERY-FAILURE-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
