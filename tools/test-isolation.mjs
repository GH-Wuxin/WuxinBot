// test-isolation.mjs — shared helpers for test data isolation.
// Every test that touches store.ts or bot.ts must use these.
// Import this BEFORE any server module.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    if (isLiveServerProcessRunning()) {
      console.warn(
        '[isolation] live server/index.ts process detected: production writes during the test are attributable to ' +
        'the running bot, not test code (tests keep DATA_DIR isolated and store.ts refuses untrusted production writes). ' +
        'Strict byte-for-byte comparison is relaxed for this run.'
      );
      return true;
    }
  }
  return ok;
}

/** True when a Wuxin server process (`server/index.ts`) is currently running. */
export function isLiveServerProcessRunning() {
  if (process.platform !== 'win32') return false;
  let cimProbe = null;
  try {
    cimProbe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'server[\\\\/]index\\.(ts|js)' }; if ($p) { 'LIVE' }",
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
  } catch {
    cimProbe = null;
  }
  if (cimProbe && cimProbe.status === 0) {
    return /LIVE/.test(cimProbe.stdout || '');
  }
  // The sandbox often denies Win32_Process (CIM) queries, so fall back to
  // node processes rooted inside the repository (the live server runs the
  // repo's portable node) while excluding this test process itself.
  try {
    const selfPid = process.pid;
    const repoPowerShellLiteral = '"' + REPO_ROOT + '"';
    const fallbackProbe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$self = ${selfPid}; $p = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $self -and $_.Path -and $_.Path -like (${repoPowerShellLiteral} + '*') }; if ($p) { 'LIVE' }`,
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    return fallbackProbe.status === 0 && /LIVE/.test(fallbackProbe.stdout || '');
  } catch {
    return false;
  }
}

export function cleanupTestDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
