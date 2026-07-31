// test-isolation.mjs — shared helpers for test data isolation.
// Every test that touches store.ts or bot.ts must use these.
// Import this BEFORE any server module.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PRODUCTION_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
  'Wuxin'
);
const PRODUCTION_DB = path.join(PRODUCTION_DIR, 'db.json');

export function createTestDataDir(label = 'wuxin-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label + '-'));
  process.env.DATA_DIR = dir;
  console.log('[isolation] DATA_DIR=' + dir);
  return dir;
}

export function assertNotProduction(testDataDir) {
  const resolved = path.resolve(testDataDir || process.env.DATA_DIR || '');
  const prodResolved = path.resolve(PRODUCTION_DIR);
  if (resolved === prodResolved || resolved.startsWith(prodResolved + path.sep)) {
    throw new Error(
      `FATAL: test DATA_DIR resolves to production path!\n` +
      `  test:    ${resolved}\n` +
      `  prod:    ${prodResolved}\n` +
      `  Refusing to continue.`
    );
  }
}

export function productionDbSnapshot() {
  if (!fs.existsSync(PRODUCTION_DB)) return null;
  const stat = fs.statSync(PRODUCTION_DB);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(PRODUCTION_DB)).digest('hex');
  return {
    path: PRODUCTION_DB,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString(),
    sha256: hash,
  };
}

export function verifyProductionDbUnchanged(before) {
  if (!before) return true;
  const after = productionDbSnapshot();
  if (!after) return !before;
  const ok = before.sha256 === after.sha256 &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs;
  if (!ok) {
    console.error('[isolation] PRODUCTION DB MODIFIED DURING TEST!');
    console.error('  before sha256:', before.sha256);
    console.error('  after  sha256:', after.sha256);
    console.error('  before size:', before.size, 'after size:', after.size);
  }
  return ok;
}

export function cleanupTestDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
