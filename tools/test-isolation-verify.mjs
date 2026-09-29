// test-isolation-verify.mjs — focused contract tests for production isolation.
// This test uses a temporary directory as a synthetic production root.  It
// never writes to the real Wuxin data directory.

import fs from 'node:fs';
import path from 'node:path';
import {
  assertNotProduction,
  cleanupTestDir,
  classifyProductionSnapshot,
  createTestDataDir,
  getLiveServerProcessState,
  productionDbSnapshot,
} from './test-isolation.mjs';

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    console.log(`PASS [${message}]`);
    passed++;
  } else {
    console.error(`FAIL [${message}]`);
    failed++;
  }
}

function expectThrow(action, message) {
  try {
    action();
    check(false, message);
  } catch {
    check(true, message);
  }
}

const syntheticProductionDir = createTestDataDir('wuxin-isolation-contract');
try {
  fs.writeFileSync(path.join(syntheticProductionDir, 'db.json'), '{"settings":{}}\n');
  fs.writeFileSync(path.join(syntheticProductionDir, 'db-profiles.json'), '{"profiles":[]}\n');
  fs.writeFileSync(path.join(syntheticProductionDir, 'osu-console-profiles.json'), '{"profiles":[]}\n');
  fs.writeFileSync(path.join(syntheticProductionDir, 'db.json.tmp'), 'temporary\n');
  fs.mkdirSync(path.join(syntheticProductionDir, 'backups'));
  fs.writeFileSync(path.join(syntheticProductionDir, 'backups', 'fixture.json'), '{}\n');

  assertNotProduction(syntheticProductionDir);
  check(true, 'temporary test root is accepted');
  const actualProductionDir = path.join(
    process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
    'Wuxin',
  );
  expectThrow(() => assertNotProduction(actualProductionDir), 'production root is rejected');

  const before = productionDbSnapshot({ productionDir: syntheticProductionDir });
  const unchanged = productionDbSnapshot({ productionDir: syntheticProductionDir });
  check(Boolean(before?.scopeSha256), 'snapshot has protected scope digest');
  check(Boolean(before?.files['db-profiles.json']?.sha256), 'profile shard is content-hashed');
  check(Boolean(before?.files['osu-console-profiles.json']?.sha256), 'osu console profiles are protected');
  check(Boolean(before?.files['db.json.tmp']), 'temporary file is in the inventory');
  check(
    classifyProductionSnapshot(before, unchanged, 'not-running').status === 'PASS',
    'unchanged scope passes with no running writer',
  );

  fs.writeFileSync(path.join(syntheticProductionDir, 'db-profiles.json'), '{"profiles":[1]}\n');
  const changedShard = productionDbSnapshot({ productionDir: syntheticProductionDir });
  check(
    classifyProductionSnapshot(before, changedShard, 'not-running').status === 'FAIL',
    'changed shard fails with no running writer',
  );
  check(
    classifyProductionSnapshot(before, changedShard, 'live').status === 'INCONCLUSIVE',
    'changed scope is inconclusive with a running writer',
  );

  fs.writeFileSync(path.join(syntheticProductionDir, 'db-new.json'), '{}\n');
  const addedFile = productionDbSnapshot({ productionDir: syntheticProductionDir });
  check(
    classifyProductionSnapshot(before, addedFile, 'not-running').status === 'FAIL',
    'new production file fails the inventory check',
  );

  fs.unlinkSync(path.join(syntheticProductionDir, 'osu-console-profiles.json'));
  const deletedFile = productionDbSnapshot({ productionDir: syntheticProductionDir });
  check(
    classifyProductionSnapshot(before, deletedFile, 'not-running').status === 'FAIL',
    'deleted protected file fails the inventory check',
  );

  check(
    classifyProductionSnapshot(before, unchanged, 'live').status === 'INCONCLUSIVE',
    'running writer prevents a clean proof even without an observed diff',
  );
  check(
    classifyProductionSnapshot(before, unchanged, 'unknown').status === 'INCONCLUSIVE',
    'unknown writer probe never passes',
  );
  check(
    classifyProductionSnapshot(null, unchanged, 'not-running').status === 'INCONCLUSIVE',
    'missing baseline never passes',
  );

  const probe = getLiveServerProcessState();
  check(['live', 'not-running', 'unknown'].includes(probe.state), 'process probe returns a three-state result');
} finally {
  cleanupTestDir(syntheticProductionDir);
}

console.log(`\nTEST-ISOLATION-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
