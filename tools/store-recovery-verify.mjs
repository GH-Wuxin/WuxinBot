// store-recovery-verify.mjs — storage startup classification and recovery
// contract (findings F01/F03). Runs the real store module against isolated
// DATA_DIRs; never touches production data.
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

const dirs = [];
function freshDir(label) {
  const dir = createTestDataDir(`wuxin-store-recovery-${label}`);
  dirs.push(dir);
  assertNotProduction(dir);
  return dir;
}
const store = await import('../server/store.ts');
const backupModule = await import('../server/backup.ts');

function dbPath(dir) { return path.join(dir, 'db.json'); }
function shardFiles(dir) {
  return ['db-profiles.json', 'db-messages.json', 'db-decisions.json', 'db-telemetry.json', 'db-osu.json']
    .map((file) => path.join(dir, file));
}

async function withDir(label, run) {
  const dir = freshDir(label);
  try { await run(dir); } catch (error) {
    assert(false, label, `${error?.stack || error}`);
  }
}

try {
  // 1. A genuinely empty directory is a first run: openStore initializes it.
  await withDir('fresh', async (dir) => {
    store.openStore();
    assert(store.readDb().settings && Array.isArray(store.readDb().groups), 'fresh:initialized');
  });

  // 2. Corrupt core + valid auto backup: recovery restores the snapshot and
  //    keeps the damaged original as evidence.
  await withDir('corrupt-auto', async (dir) => {
    store.updateDb((db) => { db.settings.ownerQq = 'seed-owner'; });
    const meta = backupModule.createBackup('auto');
    assert(Boolean(meta), 'corrupt-auto:backup-created');
    fs.writeFileSync(dbPath(dir), '{broken json', 'utf8');
    store.openStore();
    assert(store.readDb().settings.ownerQq === 'seed-owner', 'corrupt-auto:restored');
    const evidence = fs.readdirSync(dir).filter((name) => name.startsWith('db.json.corrupt-'));
    assert(evidence.length === 1, 'corrupt-auto:evidence-kept', JSON.stringify(evidence));
  });

  // 3. Corrupt core + manual + pre-shard backups (no auto): both are valid
  //    candidates; the newest by modification time wins.
  await withDir('corrupt-manual', async (dir) => {
    store.updateDb((db) => { db.settings.ownerQq = 'legacy-marker'; });
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const preshard = {
      settings: { ownerQq: 'preshard-marker' },
      groups: [], users: [], memories: [], messages: [], decisions: [],
    };
    fs.writeFileSync(path.join(backupDir, 'pre-shard-2020-01-01T00-00-00.json'), JSON.stringify(preshard), 'utf8');
    // Newer manual snapshot with different data.
    store.updateDb((db) => { db.settings.ownerQq = 'manual-marker'; });
    backupModule.createBackup('manual');
    fs.writeFileSync(dbPath(dir), '{broken', 'utf8');
    store.openStore();
    assert(store.readDb().settings.ownerQq === 'manual-marker', 'corrupt-manual:restored-newest', store.readDb().settings.ownerQq);
  });

  // 4. Corrupt core + only junk candidates: fail closed. No empty database is
  //    written, the damaged file is untouched, and plain reads keep erroring.
  await withDir('corrupt-no-valid', async (dir) => {
    store.updateDb((db) => { db.settings.ownerQq = 'precious'; });
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'junk-object.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(backupDir, 'junk-array.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(backupDir, 'junk-fragment.json'), '{"messages":[]}', 'utf8');
    fs.writeFileSync(path.join(backupDir, 'notes.json.meta.json'), '{"type":"meta"}', 'utf8');
    const broken = '{broken';
    const shardHashesBefore = Object.fromEntries(shardFiles(dir).map((file) => [file, fs.readFileSync(file).toString('base64')]));
    fs.writeFileSync(dbPath(dir), broken, 'utf8');
    let openError = null;
    try { store.openStore(); } catch (error) { openError = error; }
    assert(openError && /没有可用的有效备份/.test(String(openError.message)), 'corrupt-no-valid:fail-closed', String(openError?.message || openError));
    assert(fs.readFileSync(dbPath(dir), 'utf8') === broken, 'corrupt-no-valid:damage-untouched');
    const shardsReset = shardFiles(dir).filter((file) => fs.existsSync(file)
      && fs.readFileSync(file).toString('base64') !== shardHashesBefore[file]);
    assert(shardsReset.length === 0, 'corrupt-no-valid:healthy-shards-not-overwritten', JSON.stringify(shardsReset));
    let readError = null;
    try { store.readDb(); } catch (error) { readError = error; }
    assert(readError && /损坏/.test(String(readError.message)), 'corrupt-no-valid:plain-read-still-fails', String(readError?.message || readError));
  });

  // 5. Missing core with surviving shards is an anomaly, not a first run:
  //    restore from a valid backup instead of resetting to defaults.
  await withDir('missing-core', async (dir) => {
    store.updateDb((db) => {
      db.messages.push({ id: 'm-precious', groupId: 'g1', role: 'user', content: 'precious', createdAt: '2026-01-01T00:00:00.000Z' });
    });
    backupModule.createBackup('manual');
    fs.unlinkSync(dbPath(dir));
    store.openStore();
    assert(store.readDb().messages.some((message) => message.id === 'm-precious'), 'missing-core:restored-from-backup');
    const evidence = fs.readdirSync(dir).filter((name) => name.startsWith('db-messages.json.corrupt-'));
    assert(evidence.length >= 1, 'missing-core:shard-evidence-kept', JSON.stringify(evidence));
  });

  // 6. Access failures are not corruption: no recovery attempt, no rewrites.
  await withDir('access-error', async (dir) => {
    fs.rmSync(dbPath(dir), { force: true });
    fs.mkdirSync(dbPath(dir)); // a directory where the core file belongs
    let openError = null;
    try { store.openStore(); } catch (error) { openError = error; }
    assert(openError && /不可访问/.test(String(openError.message)), 'access-error:classified', String(openError?.message || openError));
    const evidence = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert(evidence.length === 0, 'access-error:no-recovery-attempt', JSON.stringify(evidence));
    assert(fs.statSync(dbPath(dir)).isDirectory(), 'access-error:filesystem-untouched');
  });

  // 7. A storage format from the future stops everything; it is never silently
  //    downgraded or "restored" to an older snapshot.
  await withDir('future-version', async (dir) => {
    store.updateDb((db) => { db.settings.ownerQq = 'newer-program'; });
    const core = JSON.parse(fs.readFileSync(dbPath(dir), 'utf8'));
    core._storage.version = 2;
    fs.writeFileSync(dbPath(dir), JSON.stringify(core, null, 2), 'utf8');
    let openError = null;
    try { store.openStore(); } catch (error) { openError = error; }
    assert(openError && /高于当前支持的版本/.test(String(openError.message)), 'future-version:refused', String(openError?.message || openError));
  });

  // 8. restoreBackup rejects fragments instead of normalizing them into a
  //    plausible empty store.
  await withDir('restore-validation', async (dir) => {
    store.updateDb((db) => { db.settings.ownerQq = 'keep-me'; });
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'fragment.json'), '{"messages":[]}', 'utf8');
    const result = backupModule.restoreBackup('fragment.json');
    assert(result.ok === false && /核心数据结构/.test(String(result.error)), 'restore-validation:fragment-rejected', JSON.stringify(result));
    assert(store.readDb().settings.ownerQq === 'keep-me', 'restore-validation:data-untouched');
  });
} finally {
  for (const dir of dirs) cleanupTestDir(dir);
}

if (failed > 0) {
  console.error(`STORE-RECOVERY-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('store recovery and classification checks passed');
