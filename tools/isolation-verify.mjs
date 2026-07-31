// isolation-verify.mjs — verifies that test data isolation actually works.
// Sets up a temp DATA_DIR, writes fixture data, and confirms production db is untouched.
// Exit 0 on all pass, non-zero on any failure.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

// Record production state BEFORE loading any server modules
const prodBefore = productionDbSnapshot();
if (!prodBefore) {
  console.error('FATAL: could not snapshot production db');
  process.exit(1);
}
console.log('[isolation] production db BEFORE:');
console.log('  path:  ' + prodBefore.path);
console.log('  size:  ' + prodBefore.size);
console.log('  mtime: ' + prodBefore.mtime);
console.log('  sha256:' + prodBefore.sha256.slice(0, 16) + '...');

// Create temp data directory (BEFORE any server module import)
const testDataDir = createTestDataDir('wuxin-isolation');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

// Dynamically import store (AFTER DATA_DIR is set)
const { ensureStore, readDb, updateDb } = await import('../server/store.ts');

ensureStore();

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(label) { console.log('PASS [' + label + ']'); passed++; }
function fail(label, msg) { console.error('FAIL [' + label + ']: ' + msg); failed++; }

// ── Test 1: Verify temp db path ──
{
  const db = readDb();
  const tempDbPath = path.join(testDataDir, 'db.json');
  const exists = fs.existsSync(tempDbPath);
  if (!exists) {
    fail('temp-db-exists', 'temp db.json was not created at: ' + tempDbPath);
  } else {
    pass('temp-db-exists');
  }
}

// ── Test 2: Write fixture data ──
{
  const fixtureUrl = 'http://127.0.0.1:19999/v1';
  updateDb(db => {
    db.settings.apiBaseUrl = fixtureUrl;
    db.settings.deepseekApiBaseUrl = fixtureUrl;
    db.settings.enableAutoModel = false;
    db.settings.botRegistry = {
      updatedAt: new Date().toISOString(),
      bots: [{ id: 'test-bot', name: 'Test Bot', enabled: true, channel: 'internal', qq: '', commands: [] }]
    };
  });

  const verify = readDb();
  assert(verify.settings.apiBaseUrl === fixtureUrl, 'fixture URL must be written to temp db');
  // normalizeDb merges with defaults — test-bot should be present alongside defaults
  const hasTestBot = (verify.settings.botRegistry?.bots || []).some(b => b.id === 'test-bot');
  assert(hasTestBot, 'test bot must be in temp registry');
  pass('write-fixture-to-temp');
}

// ── Test 3: Production db unchanged (SHA-256 + mtime) ──
{
  const prodOk = verifyProductionDbUnchanged(prodBefore);
  if (!prodOk) {
    fail('prod-unchanged', 'production db was modified!');
  } else {
    pass('prod-unchanged');
  }
}

// ── Test 4: Production db not containing fixture data ──
{
  if (fs.existsSync(prodBefore.path)) {
    const prodRaw = fs.readFileSync(prodBefore.path, 'utf8');
    if (prodRaw.includes('127.0.0.1:19999')) {
      fail('prod-no-fixture', 'production db contains fixture URL!');
    } else {
      pass('prod-no-fixture');
    }
    if (prodRaw.includes('test-bot')) {
      fail('prod-no-test-bot', 'production db contains test bot!');
    } else {
      pass('prod-no-test-bot');
    }
  }
}

// ── Cleanup ──
cleanupTestDir(testDataDir);
console.log('[isolation] temp dir cleaned: ' + !fs.existsSync(testDataDir));

console.log(`\n${'='.repeat(40)}`);
console.log('Passed: ' + passed + ', Failed: ' + failed);

if (failed > 0) {
  console.error('ISOLATION-VERIFY FAILED');
  process.exit(1);
}
console.log('ISOLATION-VERIFY PASSED');
process.exit(0);
