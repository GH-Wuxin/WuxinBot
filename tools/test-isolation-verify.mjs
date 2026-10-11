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
  getLastProductionIsolationResult,
  getLiveServerProcessState,
  productionDbSnapshot,
  verifyProductionDbUnchanged,
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

  const missingProductionDir = path.join(syntheticProductionDir, 'missing-production-root');
  const missingBefore = productionDbSnapshot({ productionDir: missingProductionDir });
  const missingAfter = productionDbSnapshot({ productionDir: missingProductionDir });
  check(missingBefore?.missing === true, 'absent production root is represented explicitly');
  check(
    classifyProductionSnapshot(missingBefore, missingAfter, 'not-running').status === 'PASS',
    'absent production root passes with no running writer',
  );
  fs.mkdirSync(missingProductionDir);
  const createdProductionRoot = productionDbSnapshot({ productionDir: missingProductionDir });
  check(
    classifyProductionSnapshot(missingBefore, createdProductionRoot, 'not-running').status === 'FAIL',
    'production root created during the test fails the inventory check',
  );
  fs.rmSync(missingProductionDir, { recursive: true, force: true });
  const deletedProductionRoot = productionDbSnapshot({ productionDir: missingProductionDir });
  check(
    classifyProductionSnapshot(createdProductionRoot, deletedProductionRoot, 'not-running').status === 'FAIL',
    'production root deleted during the test fails the inventory check',
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

  // ── Contract: verifyProductionDbUnchanged must not collapse the three states ──
  // Regression: it used to return `status === 'PASS'`, so every one of the ~15
  // callers reported "production db changed" whenever a Wuxin server happened to
  // be running — the normal state on a developer machine — even when the
  // before/after digests were byte-identical. That turned the whole gate into
  // noise. Only a PROVEN modification may be reported as a failure.
  const inconclusive = verifyProductionDbUnchanged(before, {
    after: unchanged, serverState: 'live', productionDir: syntheticProductionDir,
  });
  check(inconclusive === true, 'an unprovable isolation run is not reported as a modification');
  check(
    getLastProductionIsolationResult()?.status === 'INCONCLUSIVE',
    'an unprovable isolation run keeps its own status for the caller',
  );

  const modified = verifyProductionDbUnchanged(before, {
    after: changedShard, serverState: 'not-running', productionDir: syntheticProductionDir,
  });
  check(modified === false, 'a proven production modification is still a failure');
  check(getLastProductionIsolationResult()?.status === 'FAIL', 'a proven modification reports FAIL');

  const provenClean = verifyProductionDbUnchanged(before, {
    after: unchanged, serverState: 'not-running', productionDir: syntheticProductionDir,
  });
  check(provenClean === true, 'a proven-clean run passes');

  const probe = getLiveServerProcessState();
  check(['live', 'not-running', 'unknown'].includes(probe.state), 'process probe returns a three-state result');
} finally {
  cleanupTestDir(syntheticProductionDir);
}

console.log(`\nTEST-ISOLATION-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
