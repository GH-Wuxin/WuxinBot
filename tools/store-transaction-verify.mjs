import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';
import { MAX_MESSAGES } from '../server/store/limits.ts';

const file = fileURLToPath(import.meta.url);
const [mode, index] = process.argv.slice(2);

if (mode === 'interrupt') {
  const { updateDb } = await import('../server/store.ts');
  const rename = fs.renameSync;
  let count = 0;
  fs.renameSync = (source, destination) => {
    rename(source, destination);
    if (++count === Number(index)) process.exit(71);
  };
  updateDb(db => {
    db.messages.push({ id: 'm' });
    db.decisions.push({ id: 'd' });
  });
  throw new Error('The requested commit boundary was not exercised');
} else if (mode === 'read') {
  const { readDb } = await import('../server/store.ts');
  const db = readDb();
  process.stdout.write(JSON.stringify([db.messages.map(m => m.id), db.decisions.map(d => d.id)]));
} else {
  const { openStore, readDb, writeDb, updateDb, currentStorageRevision } = await import('../server/store.ts');
  function runChild(dir, ...args) {
    return spawnSync(process.execPath, ['--import', 'tsx', file, ...args], {
      env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 20000,
    });
  }
  function coldState(dir) {
    const result = runChild(dir, 'read');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  for (const boundary of [1, 2, 3]) {
    const dir = createTestDataDir('wuxin-shard-crash');
    try {
      openStore();
      const revision = currentStorageRevision();
      assert.equal(runChild(dir, 'interrupt', String(boundary)).status, 71);
      assert.deepEqual(coldState(dir), boundary < 3 ? [[], []] : [['m'], ['d']]);
      assert.equal(currentStorageRevision() === revision, boundary < 3);
    } finally { cleanupTestDir(dir); }
  }
  const dir = createTestDataDir('wuxin-shard-transactions');
  const corePath = path.join(dir, 'db.json');
  const readCore = () => JSON.parse(fs.readFileSync(corePath, 'utf8'));
  try {
    openStore();
    const revision = currentStorageRevision();
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (path.basename(destination).startsWith('db-decisions.')) throw Object.assign(new Error('fixture'), { code: 'EIO' });
      return rename(source, destination);
    };
    try {
      for (const method of ['dirty', 'full']) {
        const change = db => { db.messages.push({ id: method }); db.decisions.push({ id: method }); };
        assert.throws(() => {
          if (method === 'dirty') updateDb(change);
          else { const copy = structuredClone(readDb()); change(copy); writeDb(copy); }
        }, { code: 'EIO' });
        assert.deepEqual(coldState(dir), [[], []]);
        assert.equal(currentStorageRevision(), revision);
      }
    } finally { fs.renameSync = rename; }

    // Replay both v1 layouts. A full migration publishes v2 only after every shard exists.
    for (const bucketed of [false, true]) {
      const db = structuredClone(readDb());
      db.memories = [{ userId: 'legacy-user' }];
      writeDb(db);
      const core = readCore();
      const shards = {};
      for (const [name, current] of Object.entries(core._storage.shards)) {
        if (!bucketed && name.startsWith('memories-')) continue;
        shards[name] = 'db-' + name + '.json';
        const value = JSON.parse(fs.readFileSync(path.join(dir, current), 'utf8'));
        if (!bucketed && name === 'profiles') value.memories = db.memories;
        fs.writeFileSync(path.join(dir, shards[name]), JSON.stringify(value));
      }
      core.settings.nickname = bucketed ? 'bucketed-v1' : 'original-v1';
      core._storage = { format: 'wuxin-sharded-v1', version: 1, revision: 'v1', shards };
      fs.writeFileSync(corePath, JSON.stringify(core));
      assert.equal(readDb().memories[0].userId, 'legacy-user');
      const backupDir = path.join(dir, 'backups');
      const backups = () => fs.readdirSync(backupDir).filter(name => name.startsWith('pre-shard-v1-') && name.endsWith('.json') && !name.endsWith('.meta.json'));
      const previousBackups = new Set(backups());
      fs.renameSync = (source, destination) => {
        if (path.dirname(destination) === backupDir) throw Object.assign(new Error('fixture'), { code: 'EIO' });
        return rename(source, destination);
      };
      try {
        assert.throws(() => updateDb(db => { db.settings.nickname = 'lost'; }), { code: 'EIO' });
        assert.equal(readCore()._storage.version, 1);
        assert.equal(readDb().settings.nickname, core.settings.nickname);
      } finally { fs.renameSync = rename; }
      if (bucketed) updateDb(db => { db.settings.nickname = 'updated'; });
      else {
        const next = structuredClone(readDb());
        next.settings.nickname = 'updated';
        writeDb(next);
      }
      assert.equal(readCore()._storage.version, 2);
      const created = backups().filter(name => !previousBackups.has(name));
      assert.equal(created.length, 1);
      const snapshot = JSON.parse(fs.readFileSync(path.join(backupDir, created[0]), 'utf8'));
      assert.equal(snapshot.settings.nickname, core.settings.nickname);
      assert.deepEqual(snapshot.memories, db.memories);
      assert.ok(!Object.hasOwn(snapshot, '_storage'));
      openStore();
      assert.equal(readDb().memories[0].userId, 'legacy-user');
      assert.ok(!fs.existsSync(path.join(dir, 'db-profiles.json')));
    }

    updateDb(db => { db.memories[0] = { userId: 'replacement-user' }; });
    openStore();
    assert.deepEqual(readDb().memories.map(m => m.userId), ['replacement-user']);
    updateDb(db => { db.memories.push({ userId: 'another' }); db.memories.length = 0; });
    openStore();
    assert.deepEqual(readDb().memories, []);

    updateDb(db => { db.messages = Array.from({ length: MAX_MESSAGES }, (_, i) => ({ id: i })); });
    for (let i = 0; i < 90; i++) updateDb(db => { db.messages.push({ id: MAX_MESSAGES + i }); });
    let ids = coldState(dir)[0];
    assert.equal(ids.length, MAX_MESSAGES);
    assert.equal(ids[0], 90);
    assert.equal(ids.at(-1), MAX_MESSAGES + 89);
    updateDb(db => {
      db.messages[0].id = 'edited';
      db.messages.pop();
      db.messages.push({ id: 'last' });
    });
    ids = coldState(dir)[0];
    assert.equal(ids[0], 'edited');
    assert.equal(ids.at(-1), 'last');
    const marker = readCore()._storage;
    const live = [...Object.values(marker.shards), ...marker.history.messages, ...marker.history.decisions].sort();
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('db-')).sort(), live);
    console.log('PASS shard transactions, cross-process crash boundaries, both legacy layouts, retention and compaction');
  } finally { cleanupTestDir(dir); }
}
