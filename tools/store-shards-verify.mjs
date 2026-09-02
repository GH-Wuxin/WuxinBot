// store-shards-verify.mjs — migration, selective persistence and cache checks.
// Fully offline and isolated from the production database.
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-store-shards');
assertNotProduction(dataDir);

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

function hash(file) {
  return fs.readFileSync(file).toString('base64');
}

try {
  const legacy = {
    settings: { ownerQq: 'fixture-owner', memorySampleRetain: 120 },
    groups: [{ groupId: 'g1', name: 'Fixture', enabled: true }],
    memories: [{ userId: 'u1', nickname: 'Fixture', samples: [{ content: 'sample-a' }] }],
    messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' }],
    decisions: [{ id: 'd1', shouldReply: true, reason: 'fixture', createdAt: '2026-01-01T00:00:00.000Z' }],
    commandLogs: [{ id: 'c1', command: '/w ping', createdAt: '2026-01-01T00:00:00.000Z' }],
    usageEvents: [
      { id: 'e1', totalTokens: 5, promptTokens: 3, completionTokens: 2, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'e2', totalTokens: 5, promptTokens: 4, cachedTokens: 2, cacheWriteTokens: 0, completionTokens: 1, createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    osuBindings: { u1: { id: 123, username: 'Fixture' } },
    skillProfilerRuns: [{ id: 's1', beatmapId: 456 }],
    futureField: { preserved: true }
  };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const store = await import('../server/store.ts');
  store.ensureStore();

  const expectedFiles = ['db.json', 'db-profiles.json', 'db-messages.json', 'db-decisions.json', 'db-telemetry.json', 'db-osu.json'];
  for (const file of expectedFiles) assert(fs.existsSync(path.join(dataDir, file)), `created:${file}`);

  const core = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert(core._storage?.format === 'wuxin-sharded-v1', 'core:marker');
  assert(!('messages' in core) && !('memories' in core) && !('osuBindings' in core), 'core:large-collections-removed');
  assert(core.futureField?.preserved === true, 'core:unknown-key-preserved');
  assert(fs.readdirSync(path.join(dataDir, 'backups')).some((name) => name.startsWith('pre-shard-')), 'migration:legacy-backup');

  const first = store.readDb();
  assert(first.memories?.[0]?.samples?.[0]?.content === 'sample-a', 'read:profiles-merged');
  assert(first.messages?.[0]?.id === 'm1', 'read:messages-merged');
  assert(first.decisions?.[0]?.id === 'd1', 'read:decisions-merged');
  assert(first.commandLogs?.[0]?.id === 'c1', 'read:telemetry-merged');
  assert(first.osuBindings?.u1?.id === 123, 'read:osu-merged');

  const before = Object.fromEntries(expectedFiles.map((file) => [file, hash(path.join(dataDir, file))]));
  store.updateDb((db) => {
    db.messages.push({ id: 'm2', role: 'assistant', content: 'world', createdAt: '2026-01-01T00:00:01.000Z' });
  });
  const after = Object.fromEntries(expectedFiles.map((file) => [file, hash(path.join(dataDir, file))]));
  assert(before['db-messages.json'] !== after['db-messages.json'], 'selective-write:messages-changed');
  assert(before['db.json'] !== after['db.json'], 'selective-write:core-revision-changed');
  for (const file of expectedFiles.filter((name) => !['db.json', 'db-messages.json'].includes(name))) {
    assert(before[file] === after[file], `selective-write:${file}-unchanged`);
  }

  const publicA = store.publicDb();
  const publicB = store.publicDb();
  assert(publicA === publicB, 'public-state:cached');
  assert(publicA.usageStats?.cacheMeasuredAll?.promptTokens === 4, 'public-state:cache-denominator-excludes-legacy-input');
  assert(publicA.usageStats?.cacheMeasuredAll?.cachedTokens === 2, 'public-state:cache-summary-preserves-hits');
  store.updateDb((db) => { db.usage.replies = Number(db.usage.replies || 0) + 1; });
  const publicC = store.publicDb();
  assert(publicC !== publicB && publicC.usage.replies === 1, 'public-state:invalidated-after-write');

  store.updateDb((db) => {
    // Array methods invoked through the tracking proxy return proxy-wrapped
    // existing elements. Reassignment must unwrap them before they enter the
    // authoritative cache, otherwise later JSON serialization becomes costly.
    db.memories = db.memories.filter(Boolean);
  });
  let cacheCloneable = true;
  try { structuredClone(store.readDb()); } catch { cacheCloneable = false; }
  assert(cacheCloneable, 'tracked-write:cache-has-no-proxy-values');

  const committedCount = store.readDb().messages.length;
  try {
    store.updateDb((db) => {
      db.messages.push({ id: 'must-rollback' });
      throw new Error('fixture failure');
    });
  } catch { /* expected */ }
  assert(store.readDb().messages.length === committedCount, 'failed-mutator:cache-rolled-back');

  const backup = await import('../server/backup.ts');
  const meta = backup.createBackup('manual');
  const snapshot = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', meta.name), 'utf8'));
  assert(snapshot.messages?.some((item) => item.id === 'm2'), 'backup:contains-messages-shard');
  assert(snapshot.memories?.[0]?.samples?.[0]?.content === 'sample-a', 'backup:contains-profiles-shard');
  assert(snapshot.osuBindings?.u1?.id === 123, 'backup:contains-osu-shard');
} finally {
  cleanupTestDir(dataDir);
}

if (failed > 0) {
  console.error(`STORE-SHARDS-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('store shards migration/cache/selective-write checks passed');
