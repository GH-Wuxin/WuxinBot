// test-isolation.mjs — shared helpers for test data isolation.
// Every test that touches store.ts or bot.ts must use these.
// Import this BEFORE any server module.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const PRODUCTION_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'),
  'Wuxin'
);

// The production data directory also contains large, intentionally volatile
// caches and runtime logs.  A test must still protect the persisted stores,
// their temporary/backup siblings, and the small state directories that can
// be changed by a business operation.  Cache contents are deliberately not
// part of this scope: a cache miss must not turn an otherwise isolated test
// into a false failure.
const PERSISTED_FILE_RE = /^(?:db\.json|db-[^/\\]+\.json|osu-console-profiles\.json)$/i;
const PERSISTED_SUBTREES = new Set(['backups', 'knowledge']);

let lastIsolationResult = null;
let exitHookInstalled = false;

function installIsolationExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', (code) => {
    // A number of legacy verifiers call process.exit(0) after their checks.
    // Do not allow that explicit exit to turn an INCONCLUSIVE isolation
    // result into a green result.  Preserve a real test failure (exit 1).
    if (lastIsolationResult?.status === 'INCONCLUSIVE' && code === 0) {
      process.exitCode = 2;
    }
  });
}

installIsolationExitHook();

function normalizePathForCompare(input) {
  const absolute = path.resolve(String(input || ''));
  let cursor = absolute;
  const suffix = [];

  // realpathSync also resolves junctions/symlinks.  For a not-yet-created
  // child, resolve the nearest existing ancestor and append the missing tail.
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    cursor = fs.realpathSync.native(cursor);
  } catch {
    // The literal absolute path is still useful for a missing root.
  }

  const result = path.normalize(path.join(cursor, ...suffix));
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function isPathInside(candidate, root) {
  const candidatePath = normalizePathForCompare(candidate);
  const rootPath = normalizePathForCompare(root);
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function addScopedEntry(entries, root, filePath, { hash = false } = {}) {
  const relativePath = path.relative(root, filePath).split(path.sep).join('/');
  const stat = fs.statSync(filePath);
  const entry = {
    type: 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  if (hash) entry.sha256 = sha256File(filePath);
  entries[relativePath] = entry;
}

function collectScopedEntries(root) {
  const entries = {};

  const walk = (current, relativeDirectory, includeHashes) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, item.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (item.isDirectory()) {
        if (relativeDirectory === '' && PERSISTED_SUBTREES.has(item.name)) {
          entries[relativePath] = { type: 'directory' };
          walk(fullPath, relativePath, false);
        } else if (includeHashes) {
          // There are no persisted subdirectories under the top-level scope
          // today; keep the branch explicit so future additions are visible
          // rather than silently ignored.
          entries[relativePath] = { type: 'directory' };
        }
        continue;
      }
      if (!item.isFile()) continue;

      // Include every top-level file in the inventory so a temp/backup file
      // created or deleted by an accidental production write is observable.
      // Only the canonical stores are content-hashed; inventory-only files
      // still detect creation, deletion, size, or timestamp changes.
      const shouldHash = relativeDirectory === '' && PERSISTED_FILE_RE.test(item.name);
      addScopedEntry(entries, root, fullPath, { hash: shouldHash });
    }
  };

  walk(root, '', true);
  return entries;
}

function scopeDigest(entries) {
  const manifest = Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => [name, entry]);
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function snapshotError(root, error) {
  return {
    root,
    path: path.join(root, 'db.json'),
    error: error instanceof Error ? error.message : String(error),
    files: null,
    scopeSha256: null,
    sha256: null,
  };
}

export function createTestDataDir(label = 'wuxin-test') {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'wuxin-test';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), safeLabel + '-'));
  process.env.DATA_DIR = dir;
  console.log('[isolation] DATA_DIR=' + dir);
  return dir;
}

export function assertNotProduction(testDataDir) {
  const resolved = normalizePathForCompare(testDataDir || process.env.DATA_DIR || '');
  const prodResolved = normalizePathForCompare(PRODUCTION_DIR);
  if (isPathInside(resolved, prodResolved)) {
    throw new Error(
      `FATAL: test DATA_DIR resolves to production path!\n` +
      `  test:    ${resolved}\n` +
      `  prod:    ${prodResolved}\n` +
      `  Refusing to continue.`
    );
  }
}

export function productionDbSnapshot({ productionDir = PRODUCTION_DIR } = {}) {
  const root = path.resolve(productionDir);
  if (!fs.existsSync(root)) return null;
  try {
    const files = collectScopedEntries(root);
    const core = files['db.json'];
    return {
      root,
      path: path.join(root, 'db.json'),
      size: core?.size ?? null,
      mtimeMs: core?.mtimeMs ?? null,
      mtime: core ? new Date(core.mtimeMs).toISOString() : null,
      // Keep the old field for existing verifier diagnostics.  scopeSha256 is
      // the actual comparison key and includes all protected inventory.
      sha256: core?.sha256 ?? null,
      scopeSha256: scopeDigest(files),
      files,
    };
  } catch (error) {
    return snapshotError(root, error);
  }
}

function normalizeLiveState(value) {
  if (value === true) return 'live';
  if (value === false) return 'not-running';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.state === 'string') return value.state;
  return 'unknown';
}

export function classifyProductionSnapshot(before, after, liveState) {
  if (!before || !after || before.error || after.error) {
    return {
      status: 'INCONCLUSIVE',
      reason: 'production snapshot is missing or could not be read',
    };
  }

  const changed = before.scopeSha256 !== after.scopeSha256;
  const state = normalizeLiveState(liveState);
  if (state === 'live') {
    return {
      status: 'INCONCLUSIVE',
      reason: changed
        ? 'protected production scope changed while server/index.ts was running'
        : 'server/index.ts is still running; a clean no-writer proof is unavailable',
      changed,
    };
  }
  if (state !== 'not-running') {
    return {
      status: 'INCONCLUSIVE',
      reason: 'the production process probe was not conclusive',
      changed,
    };
  }
  if (changed) {
    return {
      status: 'FAIL',
      reason: 'protected production scope changed during the test',
      changed: true,
    };
  }
  return { status: 'PASS', reason: 'protected production scope is unchanged', changed: false };
}

function recordIsolationResult(result) {
  lastIsolationResult = result;
  console.log(`[isolation] RESULT=${result.status}: ${result.reason}`);
  if (result.status === 'FAIL') {
    if (!process.exitCode || process.exitCode === 0) process.exitCode = 1;
  } else if (result.status === 'INCONCLUSIVE') {
    if (!process.exitCode || process.exitCode === 0) process.exitCode = 2;
  }
  return result;
}

export function getLastProductionIsolationResult() {
  return lastIsolationResult;
}

export function verifyProductionDbUnchanged(before, options = {}) {
  const productionDir = options.productionDir || before?.root || PRODUCTION_DIR;
  const after = options.after || productionDbSnapshot({ productionDir });
  const liveState = options.serverState ?? getLiveServerProcessState();
  const result = classifyProductionSnapshot(before, after, liveState);
  recordIsolationResult(result);
  if (result.status === 'FAIL' || result.status === 'INCONCLUSIVE') {
    console.error('[isolation] protected production scope was not proven clean.');
    if (before?.scopeSha256) console.error('  before scope sha256:', before.scopeSha256);
    if (after?.scopeSha256) console.error('  after  scope sha256:', after.scopeSha256);
  }
  return result.status === 'PASS';
}

/** Return a three-state probe result for a Wuxin server (`server/index.ts`). */
export function getLiveServerProcessState() {
  if (process.platform !== 'win32') return { state: 'not-running', method: 'non-windows' };

  const probeScript = [
    `$self = ${process.pid};`,
    `$p = @(Get-CimInstance Win32_Process -ErrorAction Stop |`,
    `Where-Object { $_.Name -eq 'node.exe' -and $_.ProcessId -ne $self });`,
    `if ($p) { $p | ForEach-Object { Write-Output $_.CommandLine } }`,
  ].join(' ');

  try {
    const cimProbe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command', probeScript,
      ],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    const output = cimProbe.stdout || '';
    if (cimProbe.status === 0 && /server.*index\.(ts|js)/i.test(output)) {
      return { state: 'live', method: 'Win32_Process' };
    }
    if (cimProbe.status === 0) {
      return { state: 'not-running', method: 'Win32_Process' };
    }
  } catch {
    // A failed process probe is intentionally not treated as "not running".
  }
  return { state: 'unknown', method: 'Win32_Process' };
}

/** True only when the three-state probe positively finds a live server. */
export function isLiveServerProcessRunning() {
  return getLiveServerProcessState().state === 'live';
}

export function cleanupTestDir(dir) {
  if (!dir) return;
  if (!isPathInside(dir, os.tmpdir()) || normalizePathForCompare(dir) === normalizePathForCompare(os.tmpdir())) {
    throw new Error(`Refusing to remove non-temporary test directory: ${dir}`);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
