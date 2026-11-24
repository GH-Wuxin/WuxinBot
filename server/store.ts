import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeModelName } from './modelConfig.js';
import { buildOpenAIUsageStats, buildUsageStats, usageDayStart } from './usage.js';
import { validSocialState } from './bot/social/state.js';
import { pruneBackupFiles, resolveBackupRetention } from './backupFiles.js';
import { OWN_ARCHIVE_FILE, snapshotOwnArchive, recoverOwnArchive } from './messageArchiveStorage.js';

import { generationFile, HISTORY_LIMITS, HISTORY_NAMES, isGenerationFile, manifestFiles, MAX_HISTORY_DELTAS, newManifest, validateManifest } from './store/manifest.js';
import type { Manifest, HistoryName } from './store/manifest.js';
import { applyRetention, initialDb, normalizeDb } from './store/defaults.js';
export { applyRetention, defaultCommandPermissions, defaultCommandRoles, defaultPrompt, normalizeDb } from './store/defaults.js';
export { MAX_TOOL_LOGS, MAX_UNMET_LOGS } from './store/limits.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
}

/** The production data directory, computed from environment at call time. */
export function productionDataDir(): string {
  return path.resolve(process.env.WUXIN_PRODUCTION_DATA_DIR || defaultDataDir());
}

/** Resolve the active data directory. Reads DATA_DIR on every call so a
 *  forgotten/empty env var cannot silently keep pointing at production. */
export function getDataDir(): string {
  return path.resolve(process.env.DATA_DIR || productionDataDir());
}

function getDbPath() {
  return path.join(getDataDir(), 'db.json');
}

function getDbLockPath() {
  return path.join(getDataDir(), 'db.lock');
}

function comparableDataPath(input: string): string {
  let cursor = path.resolve(input);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  try { cursor = fs.realpathSync.native(cursor); } catch { /* Preserve the literal path if inaccessible. */ }
  const resolved = path.normalize(path.join(cursor, ...suffix));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isProductionDb(): boolean {
  const current = comparableDataPath(getDataDir());
  // Keep protecting the legacy location during migration as well as the
  // configured production root, including aliases through directory junctions.
  return [productionDataDir(), defaultDataDir()]
    .some((directory) => comparableDataPath(directory) === current);
}

function isTrustedServerEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const resolved = path.resolve(entry);
  const serverIndex = path.join(rootDir, 'server', 'index.ts');
  if (process.platform === 'win32') return resolved.toLowerCase() === serverIndex.toLowerCase();
  return resolved === serverIndex;
}

export function assertWriteTargetSafe() {
  if (!isProductionDb()) return;
  if (process.env.NODE_ENV === 'test') {
    throw new Error(
      '安全防护：检测到 NODE_ENV=test 试图写入生产数据库（%APPDATA%\\Wuxin\\db.json）。' +
      '请显式设置 DATA_DIR 指向测试目录。'
    );
  }
  if (process.env.ALLOW_PRODUCTION_WRITE === '1') return;
  if (!isTrustedServerEntry()) {
    throw new Error(
      '安全防护：拒绝向生产数据库（%APPDATA%\\Wuxin\\db.json）写入——当前入口不是 server/index.ts' +
      `（${process.argv[1] || 'unknown'}）。如确为有意操作，请显式设置 ALLOW_PRODUCTION_WRITE=1；` +
      '测试/脚本请设置 DATA_DIR 指向临时目录。'
    );
  }
}

// Auto backup: snapshot db.json every few minutes so a corrupted write or
// external damage never costs more than the snapshot interval. Kept under the
// dedicated backups/ directory, pruned to the newest N snapshots.
const AUTO_BACKUP_INTERVAL_MS = 5 * 60_000;
let lastAutoBackupAt = 0;
let lastDbReadFailureAt = 0;

const SHARDED_STORAGE_FORMAT = 'wuxin-sharded-v1';
const MEMORY_BUCKET_COUNT = 16;
const SHARD_SPECS = [
  {
    name: 'profiles',
    file: 'db-profiles.json',
    keys: new Set(['groupProfiles', 'relationshipProfiles', 'pendingPairCounts', 'profileAutoAttempts', 'profileLogs', 'profileV3', 'socialV2'])
  },
  { name: 'messages', file: 'db-messages.json', keys: new Set(['messages']) },
  { name: 'decisions', file: 'db-decisions.json', keys: new Set(['decisions']) },
  {
    name: 'telemetry',
    file: 'db-telemetry.json',
    keys: new Set(['commandLogs', 'toolCallLogs', 'unmetCapabilities', 'adminActions', 'usageEvents', 'configSnapshots', 'searchLogs'])
  },
  { name: 'osu', file: 'db-osu.json', keys: new Set(['skillProfilerRuns']) }
];
const MEMORY_BUCKET_SPECS = Array.from({ length: MEMORY_BUCKET_COUNT }, (_, index) => {
  const suffix = index.toString(16).padStart(2, '0');
  return { name: `memories-${suffix}`, file: `db-memories-${suffix}.json`, keys: new Set<string>() };
});
const ALL_SHARD_SPECS = [...SHARD_SPECS, ...MEMORY_BUCKET_SPECS];
let cachedStore: { dataDir: string; db: any; coreSignature: string } | null = null;
let cachedPublicDb: { db: any; minute: number; includeMemorySamples: boolean; value: any } | null = null;
let storageRevision = '';
let committedManifest: Manifest | undefined;
const STORE_SLOW_WRITE_MS = 500;
const storeWriteStats = {
  since: new Date().toISOString(),
  count: 0,
  fullWrites: 0,
  dirtyWrites: 0,
  slowWrites: 0,
  totalDurationMs: 0,
  totalDataBytes: 0,
  maxDurationMs: 0,
  lastAt: '',
  lastOperation: '',
  lastDurationMs: 0,
  lastDataBytes: 0,
  lastShards: [] as Array<{ name: string; bytes: number }>
};
const storeLockStats = {
  since: new Date().toISOString(),
  acquisitions: 0,
  contended: 0,
  timeoutCount: 0,
  totalWaitMs: 0,
  maxWaitMs: 0,
  lastWaitMs: 0,
  lastOwnerPid: 0,
  lastContentionAt: '',
  lastTimeoutAt: ''
};

function recordStoreWrite(operation: 'full' | 'dirty', startedAtMs: number, shards: Array<{ name: string; bytes: number }>) {
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  const dataBytes = shards.reduce((total, shard) => total + shard.bytes, 0);
  storeWriteStats.count += 1;
  if (operation === 'full') storeWriteStats.fullWrites += 1;
  else storeWriteStats.dirtyWrites += 1;
  if (durationMs >= STORE_SLOW_WRITE_MS) storeWriteStats.slowWrites += 1;
  storeWriteStats.totalDurationMs += durationMs;
  storeWriteStats.totalDataBytes += dataBytes;
  storeWriteStats.maxDurationMs = Math.max(storeWriteStats.maxDurationMs, durationMs);
  storeWriteStats.lastAt = new Date().toISOString();
  storeWriteStats.lastOperation = operation;
  storeWriteStats.lastDurationMs = durationMs;
  storeWriteStats.lastDataBytes = dataBytes;
  storeWriteStats.lastShards = shards.map((shard) => ({ ...shard }));
}

/** In-process write telemetry for health/diagnostic views; counters reset on restart. */
export function getStoreWriteStats() {
  return {
    ...storeWriteStats,
    lastShards: storeWriteStats.lastShards.map((shard) => ({ ...shard }))
  };
}

function recordStoreLock(waitMs: number, ownerPid = 0, timedOut = false) {
  const elapsed = Math.max(0, Math.round(waitMs));
  storeLockStats.acquisitions += 1;
  storeLockStats.totalWaitMs += elapsed;
  storeLockStats.maxWaitMs = Math.max(storeLockStats.maxWaitMs, elapsed);
  storeLockStats.lastWaitMs = elapsed;
  storeLockStats.lastOwnerPid = Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : 0;
  if (elapsed > 0) {
    storeLockStats.contended += 1;
    storeLockStats.lastContentionAt = new Date().toISOString();
  }
  if (timedOut) storeLockStats.timeoutCount += 1;
  if (timedOut) storeLockStats.lastTimeoutAt = new Date().toISOString();
}

/** In-process lock telemetry for diagnosing duplicate writers and event-loop stalls. */
export function getStoreLockStats() {
  return { ...storeLockStats };
}

function memoryBucketName(userId: unknown): string {
  const value = String(userId ?? '');
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return MEMORY_BUCKET_SPECS[(hash >>> 0) % MEMORY_BUCKET_COUNT].name;
}

function hasMemoryBucketMarker(marker: any): boolean {
  return MEMORY_BUCKET_SPECS.every((spec) => marker?.shards?.[spec.name] === spec.file);
}

function shardNameForKey(key: string) {
  for (const spec of SHARD_SPECS) if (spec.keys.has(key)) return spec.name;
  if (key.startsWith('osu')) return 'osu';
  return 'core';
}

function isShardedCore(value) {
  return value?._storage?.format === SHARDED_STORAGE_FORMAT || value?._storage?.format === 'wuxin-sharded-v2';
}

function validateCore(core: any) {
  if (!hasStorageMarker(core)) {
    // Early single-file releases did not include a users collection.
    if (!isLegacyDb(core)) {
      throw new StoreUnreadableError('旧格式数据库核心数据结构不完整，已拒绝迁移。', 'anomaly');
    }
    return;
  }
  const marker = core._storage;
  if (!isShardedCore(core)) throw unsupportedStorageMarker(core);
  const version = marker.format === SHARDED_STORAGE_FORMAT ? 1 : 2;
  if (marker.version !== version) {
    throw new StoreUnreadableError(`数据库存储版本 ${marker.version} 高于当前支持的版本或与格式不符。`, 'future-version');
  }
  if (version === 2) {
    try { validateManifest(marker, ALL_SHARD_SPECS); }
    catch (error) { throw new StoreUnreadableError(errorMessage(error), 'corrupt'); }
  } else {
    const memoryEntries = MEMORY_BUCKET_SPECS.filter(spec => Object.hasOwn(marker.shards || {}, spec.name));
    if (SHARD_SPECS.some(spec => marker.shards?.[spec.name] !== spec.file)
      || (memoryEntries.length && !hasMemoryBucketMarker(marker))) throw new StoreUnreadableError('数据库分片清单损坏', 'corrupt');
  }
}

function hasStorageMarker(value) {
  return Boolean(value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, '_storage'));
}

function unsupportedStorageMarker(value) {
  const marker = value?._storage;
  const format = marker && typeof marker === 'object' ? marker.format : undefined;
  const version = marker && typeof marker === 'object' ? marker.version : undefined;
  return new StoreUnreadableError(
    `数据库存储标记不受支持（format=${String(format ?? '<missing>')}，version=${String(version ?? '<missing>')}），已拒绝按旧格式迁移。`,
    'future-version',
  );
}

function invalidateStoreCaches() {
  cachedPublicDb = null;
}

function coreFileSignature() {
  try {
    const stat = fs.statSync(getDbPath(), { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (isMissingFileError(error)) return '';
    throw storageAccessError('核心数据库文件', error);
  }
}

/** Milliseconds since epoch of the most recent corrupt-db recovery (0 = none). */
export function lastDbReadFailureAtMs(): number {
  return lastDbReadFailureAt;
}

function autoBackupIfDue(db) {
  const now = Date.now();
  if (now - lastAutoBackupAt < AUTO_BACKUP_INTERVAL_MS) return;
  try {
    const backupDir = path.join(getDataDir(), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupDir, `auto-${stamp}.json`);
    if (!fs.existsSync(dest)) {
      const ownMessageArchive = snapshotOwnArchive(getDataDir(), dest);
      writeJsonAtomic(dest, db, false);
      writeJsonAtomic(dest + '.meta.json', {type:'auto',ownMessageArchive}, false);
    }
    const result = pruneBackupFiles(backupDir, resolveBackupRetention(db), { types: ['auto'] });
    if (result.failed.length) console.error('[store] auto backup cleanup failed:', result.failed);
    lastAutoBackupAt = now;
  } catch (error) {
    console.error('[store] auto backup failed:', String(error?.message || error));
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockOwnerIsAlive() {
  try {
    const pid = Number(fs.readFileSync(getDbLockPath(), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withDbLock(callback) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const waitStartedAtMs = Date.now();
  let lastOwnerPid = 0;
  let handle;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = fs.openSync(getDbLockPath(), 'wx');
      fs.writeFileSync(handle, String(process.pid), 'utf8');
      break;
    } catch (error) {
      const lockExists = fs.existsSync(getDbLockPath());
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      try {
        const ownerPid = Number(fs.readFileSync(getDbLockPath(), 'utf8').trim());
        if (Number.isInteger(ownerPid) && ownerPid > 0) lastOwnerPid = ownerPid;
      } catch { /* the lock may be between create and pid write */ }
      if (!lockExists) {
        sleepSync(10);
        continue;
      }
      let stale = false;
      try {
        const ageMs = Date.now() - fs.statSync(getDbLockPath()).mtimeMs;
        // Never steal a lock merely because a legitimate write is slow. A
        // live owner may be serializing a large shard or waiting on Windows
        // filesystem latency; deleting its lock would permit concurrent writes
        // and defeat the whole cross-process consistency boundary.
        stale = ageMs > 2_000 && !lockOwnerIsAlive();
      } catch {
        stale = false;
      }
      if (stale) {
        try { fs.unlinkSync(getDbLockPath()); } catch { /* another process may own cleanup */ }
      } else {
        sleepSync(25);
      }
    }
  }
  const waitMs = Date.now() - waitStartedAtMs;
  if (handle === undefined) {
    recordStoreLock(waitMs, lastOwnerPid, true);
    throw new Error(`数据库写入锁等待超时（已等待 ${waitMs}ms，持有者 PID ${lastOwnerPid || '未知'}），请检查是否重复启动了多个 Wuxin 后端。`);
  }
  recordStoreLock(waitMs, lastOwnerPid, false);
  if (waitMs >= STORE_SLOW_WRITE_MS) {
    console.warn(`[store] 数据库写入锁竞争：等待 ${waitMs}ms，持有者 PID ${lastOwnerPid || '未知'}`);
  }
  try {
    return callback();
  } finally {
    try { fs.closeSync(handle); } catch { /* ignore close failure */ }
    try { fs.unlinkSync(getDbLockPath()); } catch { /* ignore cleanup race */ }
  }
}

function writeJsonAtomic(filePath, value, pretty = true) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  try {
    fs.writeFileSync(tempPath, payload, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 20) throw error;
        sleepSync(25 * (attempt + 1));
      }
    }
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw error;
  }
  return Buffer.byteLength(payload, 'utf8');
}


function splitDb(db, requestedNames?: Set<string>) {
  const names = requestedNames || new Set(['core', ...ALL_SHARD_SPECS.map((spec) => spec.name)]);
  const buckets = new Map<string, Record<string, any>>([
    ...Array.from(names).map((name) => [name, {}] as [string, Record<string, any>])
  ]);
  for (const [key, value] of Object.entries(db || {})) {
    if (key === '_storage') continue;
    if (key === 'memories') {
      const requestedMemoryBuckets = MEMORY_BUCKET_SPECS.some((spec) => names.has(spec.name));
      if (!requestedMemoryBuckets) continue;
      for (const memory of Array.isArray(value) ? value : []) {
        const name = memoryBucketName(memory?.userId);
        if (!names.has(name)) continue;
        const bucket = buckets.get(name);
        if (!bucket) continue;
        if (!Array.isArray(bucket.memories)) bucket.memories = [];
        bucket.memories.push(memory);
      }
      continue;
    }
    const name = shardNameForKey(key);
    if (names.has(name)) (buckets.get(name) || buckets.get('core'))![key] = value;
  }
  return buckets;
}

// Each snapshot and delta is immutable. Replacing db.json publishes the whole
// transaction. A process that dies earlier leaves only unreferenced files.
function removeRetiredFiles(files: Iterable<string>, live: Set<string>) {
  for (const file of files) {
    if (live.has(file)) continue;
    try { fs.unlinkSync(path.join(getDataDir(), file)); }
    catch (error) { if (!isMissingFileError(error)) console.warn('[store] 分片清理失败:', file, errorMessage(error)); }
  }
}

function ownedShardFiles(): string[] {
  return fs.readdirSync(getDataDir()).filter(file => {
    const destination = file.replace(/\.\d+\.\d+\.tmp$/, '');
    return (destination === 'db.json' && destination !== file) || ALL_SHARD_SPECS.some(spec =>
      destination === spec.file || isGenerationFile(destination, spec.name));
  });
}

function cleanupUnreferencedShards(marker: Manifest) {
  try { removeRetiredFiles(ownedShardFiles(), manifestFiles(marker)); }
  catch (error) { console.warn('[store] 无法清理历史分片:', errorMessage(error)); }
}

function commitShards(db, names: Set<string>, previous?: Manifest, appends: Partial<Record<HistoryName, any[]>> = {}) {
  const started = Date.now();
  const marker = newManifest(previous);
  const buckets = splitDb(db, new Set([...names, 'core']));
  const written = [];
  const staged: string[] = [];
  try {
    for (const name of names) {
      if (name === 'core') continue;
      const file = generationFile(name, marker.revision);
      const history = name as HistoryName;
      let value = buckets.get(name);
      if (previous && appends[history] && marker.history[history].length < MAX_HISTORY_DELTAS) {
        value = { [name]: appends[history] };
        marker.history[history].push(file);
      } else {
        marker.shards[name] = file;
        if (Object.hasOwn(HISTORY_LIMITS, name)) marker.history[history] = [];
      }
      staged.push(file);
      written.push({ name, bytes: writeJsonAtomic(path.join(getDataDir(), file), value, false) });
    }
    const core = { ...buckets.get('core'), _storage: marker };
    written.push({ name: 'core', bytes: writeJsonAtomic(getDbPath(), core) });
  } catch (error) {
    removeRetiredFiles(staged, new Set());
    throw error;
  }
  committedManifest = marker;
  storageRevision = marker.revision;
  cachedStore = { dataDir: getDataDir(), db, coreSignature: coreFileSignature() };
  invalidateStoreCaches();
  recordStoreWrite(previous ? 'dirty' : 'full', started, written);
  if (previous) removeRetiredFiles(manifestFiles(previous), manifestFiles(marker));
  else cleanupUnreferencedShards(marker);
  return db;
}

function writeAllShards(db) {
  return commitShards(applyRetention(db), new Set(ALL_SHARD_SPECS.map(spec => spec.name)));
}

function writeDirtyShards(db, dirtyKeys: Set<string>, dirtyMemoryBuckets: Set<string>, appends: Partial<Record<HistoryName, any[]>>) {
  if (!committedManifest) return writeAllShards(db);
  const names = new Set<string>();
  for (const key of dirtyKeys) {
    if (key !== 'memories') names.add(shardNameForKey(key));
    else if (dirtyMemoryBuckets.has('*') || !dirtyMemoryBuckets.size) {
      for (const spec of MEMORY_BUCKET_SPECS) names.add(spec.name);
    } else {
      for (const name of dirtyMemoryBuckets) names.add(name);
    }
  }
  return commitShards(db, names, committedManifest, appends);
}

function parseJsonFile(filePath: string, label = '数据库文件') {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) throw new StoreUnreadableError(`${label}缺失`, 'anomaly');
    throw storageAccessError(label, error);
  }
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (error) { throw new StoreUnreadableError(`${label}损坏: ${errorMessage(error)}`, 'corrupt'); }
}

function readLogicalDbFromDisk() {
  const core = parseJsonFile(getDbPath());
  validateCore(core);
  committedManifest = undefined;
  if (!isShardedCore(core)) return normalizeDb(core);
  const marker = core._storage;
  const versioned = marker.version === 2;
  const merged = { ...core };
  delete merged._storage;
  const buckets = versioned || hasMemoryBucketMarker(marker);
  if (buckets) merged.memories = [];
  for (const spec of buckets ? ALL_SHARD_SPECS : SHARD_SPECS) {
    const file = marker.shards[spec.name];
    const data = parseJsonFile(path.join(getDataDir(), file), `数据库分片 ${file}`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new StoreUnreadableError(`数据库分片 ${file} 损坏`, 'corrupt');
    if (spec.name.startsWith('memories-')) {
      if ('memories' in data) {
        if (!Array.isArray(data.memories)) throw new StoreUnreadableError(`数据库分片 ${file} 中的 memories 不是数组`, 'corrupt');
        for (const item of data.memories) merged.memories.push(item);
      }
    } else {
      Object.assign(merged, data);
    }
  }
  if (versioned) {
    for (const name of HISTORY_NAMES) {
      if (!Array.isArray(merged[name])) throw new StoreUnreadableError('数据库历史分片损坏: ' + name, 'corrupt');
      for (const file of marker.history[name]) {
        const delta = parseJsonFile(path.join(getDataDir(), file), file);
        if (!Array.isArray(delta?.[name])) throw new StoreUnreadableError('数据库历史增量损坏: ' + file, 'corrupt');
        merged[name] = merged[name].concat(delta[name]).slice(-HISTORY_LIMITS[name]);
      }
    }
    committedManifest = marker;
  }
  if (!isLegacyDb(merged)) throw new StoreUnreadableError('数据库分片不完整，无法组装逻辑数据库。', 'corrupt');
  storageRevision = marker.revision;
  return normalizeDb(merged);
}

function preserveLegacyDb() {
  const backupDir = path.join(getDataDir(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(backupDir, `pre-shard-${stamp}.json`);
  fs.copyFileSync(getDbPath(), destination);
  return destination;
}

// db.json is now the small core shard. Large independent collections live in
// sibling files and are assembled once into the process-local authoritative
// object. Existing single-file databases migrate automatically and are fully
// preserved under backups/pre-shard-*.json before the marker is committed.
//
// ensureStore is the PLAIN entry: it initializes a genuinely empty data
// directory, migrates a legacy database, and reports unreadable storage as a
// classified error. It never deletes data and never performs recovery — that
// is openStore(), which only the trusted server entry runs at boot (findings
// F01/F03: a corrupt core used to bypass recovery entirely, and recovery used
// to fall back to an empty default database).

export class StoreUnreadableError extends Error {
  reason: 'corrupt' | 'access' | 'anomaly' | 'future-version';
  constructor(message: string, reason: StoreUnreadableError['reason']) {
    super(message);
    this.name = 'StoreUnreadableError';
    this.reason = reason;
  }
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error);
}

function isMissingFileError(error: any): boolean {
  return error?.code === 'ENOENT';
}

function storageAccessError(label: string, error: unknown): StoreUnreadableError {
  return new StoreUnreadableError(`${label}不可访问：${errorMessage(error)}`, 'access');
}

function statIfPresent(filePath: string, label: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw storageAccessError(label, error);
  }
}

type CoreRead =
  | { kind: 'missing' }
  | { kind: 'parsed'; value: any }
  | { kind: 'unreadable'; reason: 'corrupt' | 'access'; error: unknown };

function readCoreFile(): CoreRead {
  let raw: string;
  try {
    raw = fs.readFileSync(getDbPath(), 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    // Permission problems, locked files, directories in place — none of these
    // mean the data is damaged, so they must not enter the corruption path.
    return { kind: 'unreadable', reason: 'access', error };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(raw.replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { kind: 'unreadable', reason: 'corrupt', error };
  }
}

// A missing core file alongside shards, backups, or earlier corrupt evidence is
// NOT a first run: creating a fresh database here would silently discard the
// surviving data (finding F03).
function hasSideData(): boolean {
  const dataDir = getDataDir();
  if (statIfPresent(path.join(dataDir, OWN_ARCHIVE_FILE), '自发消息档案')) return true;
  const backupDir = path.join(dataDir, 'backups');
  if (statIfPresent(backupDir, '数据库备份目录')) {
    let names;
    try {
      names = fs.readdirSync(backupDir);
    } catch (error) {
      throw storageAccessError('数据库备份目录', error);
    }
    if (names.some((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))) return true;
  }
  try {
    if (ownedShardFiles().length || fs.readdirSync(dataDir).some((name) => name.includes('.corrupt-'))) return true;
  } catch (error) {
    throw storageAccessError('数据库目录', error);
  }
  return false;
}

export function ensureStore() {
  if (cachedStore?.dataDir === getDataDir() && cachedStore.coreSignature === coreFileSignature()) return;
  fs.mkdirSync(getDataDir(), { recursive: true });
  const core = readCoreFile();
  if (core.kind === 'missing') {
    withDbLock(() => {
      if (fs.existsSync(getDbPath())) return;
      if (hasSideData()) throw new StoreUnreadableError('核心数据库文件缺失，但数据目录仍存在分片或备份。', 'anomaly');
      assertWriteTargetSafe();
      // A crash before the first manifest still leaves a complete logical DB.
      writeJsonAtomic(getDbPath(), initialDb);
      writeAllShards(normalizeDb(JSON.parse(JSON.stringify(initialDb))));
    });
    return;
  }
  if (core.kind === 'unreadable') {
    throw new StoreUnreadableError(
      core.reason === 'access'
        ? `数据库文件不可访问：${errorMessage(core.error)}`
        : `核心数据库文件损坏，无法解析：${errorMessage(core.error)}`,
      core.reason,
    );
  }
  validateCore(core.value);
  if (isShardedCore(core.value)) return;
  try {
    assertWriteTargetSafe();
    withDbLock(() => {
      const locked = readCoreFile();
      if (locked.kind !== 'parsed') return;
      validateCore(locked.value);
      if (isShardedCore(locked.value)) return;
      const legacy = normalizeDb(locked.value);
      const backup = preserveLegacyDb();
      writeAllShards(legacy);
      console.log(`[store] migrated legacy db.json to sharded storage; backup=${path.basename(backup)}`);
    });
  } catch (error) {
    // Read-only tools are allowed to inspect a legacy production DB. The trusted
    // server entry will perform migration on its next start.
    if (errorMessage(error).includes('安全防护')) return;
    throw error;
  }
}

function listBackupCandidates(): string[] {
  const backupDir = path.join(getDataDir(), 'backups');
  const backupStat = statIfPresent(backupDir, '数据库备份目录');
  if (!backupStat) return [];
  let names;
  try {
    names = fs.readdirSync(backupDir);
  } catch (error) {
    throw storageAccessError('数据库备份目录', error);
  }
  // Newest first by modification time: names mix types (auto/manual/pre-shard),
  // so lexicographic order would not reflect which snapshot is freshest.
  return names
    .filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
    .map((name) => {
      const stat = statIfPresent(path.join(backupDir, name), `备份 ${name}`);
      return stat ? { name, mtime: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime - left.mtime)
    .map((item) => path.join(backupDir, item.name));
}

// A restore candidate must prove it is a complete logical database, not merely
// parseable JSON. createBackup() always dumps the full logical shape, while
// older supported exports may omit newer optional collections. The five
// historical core collections are therefore required; optional fields are
// type-checked when present instead of being silently normalized.
const REQUIRED_BACKUP_ARRAY_KEYS = ['users', 'groups', 'messages', 'decisions', 'memories'];
const OPTIONAL_BACKUP_ARRAY_KEYS = [
  'ownerDirectives',
  'commandLogs',
  'groupProfiles',
  'relationshipProfiles',
  'profileLogs',
  'toolCallLogs',
  'skillProfilerRuns',
  'unmetCapabilities',
  'adminActions',
  'usageEvents',
  'configSnapshots',
];
const OPTIONAL_BACKUP_OBJECT_KEYS = [
  'socialV2',
  'botRegistry',
  'skillStore',
  'groupBotConfig',
  'pendingPairCounts',
  'profileAutoAttempts',
  'trustScores',
  'experience',
  'groupExperience',
  'profileV3',
  'usage',
];

function isLegacyDb(value: any): boolean {
  return value && !hasStorageMarker(value) && isValidLogicalDbShape({ users: [], ...value });
}

export function isValidLogicalDbShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, any>;
  if ('socialV2' in record && !validSocialState(record.socialV2)) return false;
  if (typeof record.settings !== 'object' || record.settings === null || Array.isArray(record.settings)) return false;

  if (Object.prototype.hasOwnProperty.call(record, '_storage')) {
    const marker = record._storage;
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)
      || marker.format !== SHARDED_STORAGE_FORMAT
      || marker.version !== 1
      || !marker.shards || typeof marker.shards !== 'object' || Array.isArray(marker.shards)) {
      return false;
    }
  }

  if (REQUIRED_BACKUP_ARRAY_KEYS.some((key) => !Array.isArray(record[key]))) return false;
  if (OPTIONAL_BACKUP_ARRAY_KEYS.some((key) => key in record && !Array.isArray(record[key]))) return false;
  if (OPTIONAL_BACKUP_OBJECT_KEYS.some((key) => key in record
    && (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key])))) return false;
  return true;
}

function authoritativeStoreFiles(): string[] {
  return [getDbPath(), ...ownedShardFiles().map(file => path.join(getDataDir(), file))];
}

function preserveAuthoritativeFiles(): { preserved: string[]; missing: string[] } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preserved: string[] = [];
  const missing: string[] = [];
  for (const file of authoritativeStoreFiles()) {
    const name = path.basename(file);
    const stat = statIfPresent(file, `权威文件 ${name}`);
    if (!stat) {
      missing.push(name);
      continue;
    }
    if (!stat.isFile()) {
      throw new StoreUnreadableError(`权威文件 ${name} 不是普通文件，无法保全现场。`, 'access');
    }

    const evidenceName = `${name}.corrupt-${stamp}`;
    const evidencePath = path.join(getDataDir(), evidenceName);
    try {
      fs.copyFileSync(file, evidencePath);
      const sourceBytes = fs.readFileSync(file);
      const evidenceBytes = fs.readFileSync(evidencePath);
      if (!sourceBytes.equals(evidenceBytes)) {
        throw new Error('保全副本字节校验不一致');
      }
    } catch (copyError) {
      throw new StoreUnreadableError(
        `无法保全权威文件 ${name}：${errorMessage(copyError)}`,
        'access',
      );
    }
    preserved.push(evidenceName);
  }
  return { preserved, missing };
}

function recoverStorageFromBackups(reasonError: unknown): any {
  lastDbReadFailureAt = Date.now();
  const reasonText = errorMessage(reasonError).slice(0, 300);
  let canWrite = true;
  try {
    assertWriteTargetSafe();
  } catch (assertError) {
    canWrite = false;
    console.error('[store] recovery skipped (untrusted entry):', errorMessage(assertError));
  }

  const recover = () => {
    // The recovery lock covers evidence capture, candidate selection and the
    // eventual write. No older writer can change the files between those
    // phases, and no nested writeDb()/withDbLock call is needed.
    // A different opener may have recovered this store while we waited for the lock.
    if (canWrite) {
      try { return readDbUnlocked(); }
      catch (error) {
        if (!(error instanceof StoreUnreadableError) || !['anomaly', 'corrupt'].includes(error.reason)) throw error;
      }
    }
    const evidence = canWrite ? preserveAuthoritativeFiles() : { preserved: [], missing: [] };
    const candidates = listBackupCandidates();
    let inspected = 0;
    for (const candidate of candidates) {
      inspected += 1;
      let raw;
      try {
        raw = fs.readFileSync(candidate, 'utf8');
      } catch (readError) {
        if (isMissingFileError(readError)) continue;
        throw storageAccessError(`备份 ${path.basename(candidate)}`, readError);
      }

      let parsed: any = null;
      try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch { /* malformed candidate; continue to an older candidate */ }
      if (!isValidLogicalDbShape(parsed) && !(path.basename(candidate).startsWith('pre-shard-') && isLegacyDb(parsed))) {
        console.error(`[store] backup ${path.basename(candidate)} is not a complete logical database, skipping`);
        continue;
      }
      const restoredName = path.basename(candidate);
      if (!canWrite) {
        throw new StoreUnreadableError(
          `存储异常（${reasonText}），已在 ${restoredName} 找到有效备份，但当前入口没有写入权限，无法执行恢复。`,
          'anomaly',
        );
      }
      try {
        recoverOwnArchive(getDataDir(), candidate);
        writeAllShards(normalizeDb(parsed));
      } catch (writeError) {
        // A valid candidate that cannot be written is not an invalid
        // candidate. Trying an older backup would hide a write failure and
        // could overwrite a different state, so stop immediately.
        throw new StoreUnreadableError(
          `有效备份 ${restoredName} 的恢复写入失败，已停止，不继续尝试更旧备份：${errorMessage(writeError)}`,
          'anomaly',
        );
      }
      console.error(`[store] storage was unreadable (${reasonText}); restored from ${restoredName}`
        + (evidence.preserved.length ? `; previous files kept as ${evidence.preserved.join(', ')}` : '')
        + (evidence.missing.length ? `; missing before recovery: ${evidence.missing.join(', ')}` : '')
        + '; data written after that backup may be lost');
      return readDbUnlocked();
    }
    throw new StoreUnreadableError(
      `存储处于异常状态且没有可用的有效备份（${reasonText}；已检查 ${inspected} 个候选）`
      + (evidence.preserved.length ? `；原文件保留为 ${evidence.preserved.join(', ')}` : '')
      + (evidence.missing.length ? `；恢复前缺失 ${evidence.missing.join(', ')}` : '')
      + '。拒绝创建空数据库覆盖现场。',
      'anomaly',
    );
  };

  return canWrite ? withDbLock(recover) : recover();
}

// Trusted startup entry: classify the storage, and on damage attempt a
// validated backup restore once. Ordinary readDb()/updateDb() callers never
// trigger recovery — an unreadable store surfaces as a clear error instead of
// an implicit database reset (findings F01/F03).
export function openStore(): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  cachedStore = null;
  try {
    ensureStore();
    readDb();
  } catch (error) {
    if (!(error instanceof StoreUnreadableError) || !['anomaly', 'corrupt'].includes(error.reason)) throw error;
    recoverStorageFromBackups(error);
  }
  if (committedManifest && (!isProductionDb() || isTrustedServerEntry())) {
    withDbLock(() => {
      readDbUnlocked();
      if (committedManifest) cleanupUnreferencedShards(committedManifest);
    });
  }
}

function readDbUnlocked() {
  const dataDir = getDataDir();
  const signature = coreFileSignature();
  if (cachedStore?.dataDir === dataDir && cachedStore.coreSignature === signature) return cachedStore.db;
  // A writer may retire files from an older manifest during an unlocked
  // cold read. Retry against its new manifest before reporting corruption.
  let before = signature;
  for (let attempt = 0; ; attempt++) {
    try {
      const db = readLogicalDbFromDisk();
      if (before === coreFileSignature()) {
        cachedStore = { dataDir, db, coreSignature: before };
        invalidateStoreCaches();
        return db;
      }
    } catch (error) {
      if (before === coreFileSignature()) throw error;
    }
    if (attempt >= 3) return withDbLock(readDbUnlocked);
    before = coreFileSignature();
  }
}

export function readDb() {
  if (cachedStore?.dataDir === getDataDir() && cachedStore.coreSignature === coreFileSignature()) return cachedStore.db;
  ensureStore();
  return readDbUnlocked();
}

export function currentStorageRevision() {
  readDb();
  return storageRevision;
}

export function writeDb(db) {
  assertWriteTargetSafe();
  ensureStore();
  return withDbLock(() => {
    const result = writeAllShards(normalizeDb(db));
    autoBackupIfDue(result);
    return result;
  });
}

function unwrapTrackedValue(value, rawTargets: WeakMap<object, object>, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  const raw = rawTargets.get(value) || value;
  if (seen.has(raw)) return seen.get(raw);
  if (Array.isArray(raw)) {
    const result: any[] = [];
    seen.set(raw, result);
    for (const item of raw) result.push(unwrapTrackedValue(item, rawTargets, seen));
    return result;
  }
  const result = {};
  seen.set(raw, result);
  for (const [key, item] of Object.entries(raw)) result[key] = unwrapTrackedValue(item, rawTargets, seen);
  return result;
}

function isArrayIndexProperty(property: PropertyKey): boolean {
  return typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property);
}

function markMemoryBucketMutation(
  dirtyMemoryBuckets: Set<string> | undefined,
  rootKey: string,
  memoryBucket: string,
  object: any,
  property: PropertyKey,
  value: any
) {
  if (!dirtyMemoryBuckets) return;
  if (!rootKey && property === 'memories') {
    dirtyMemoryBuckets.add('*');
    return;
  }
  if (rootKey !== 'memories') return;

  // Once a memory entry has been resolved, all nested mutations belong to
  // that entry's bucket. A userId edit also touches the destination bucket.
  if (memoryBucket) {
    dirtyMemoryBuckets.add(memoryBucket);
    if (property === 'userId') {
      dirtyMemoryBuckets.add(memoryBucketName(value));
    }
    return;
  }

  // This is the top-level memories array. Array length changes do not identify
  // a bucket; index writes/deletes do, based on the old or new entry.
  if (Array.isArray(object)) {
    if (property === 'length') {
      if (Number(value) < object.length) dirtyMemoryBuckets.add('*');
      return;
    }
    if (isArrayIndexProperty(property)) {
      const old = object[property as any];
      if (old) dirtyMemoryBuckets.add(memoryBucketName(old.userId));
      if (value !== undefined) dirtyMemoryBuckets.add(memoryBucketName(value?.userId));
      return;
    }
  }

  // Replacing the complete memories collection, or mutating an unresolvable
  // shape, is rare but must remain correct rather than silently missing a
  // bucket.
  dirtyMemoryBuckets.add('*');
}

function trackedMutationProxy(
  target,
  dirtyKeys: Set<string>,
  rootKey = '',
  proxies = new WeakMap(),
  rawTargets = new WeakMap<object, object>(),
  dirtyMemoryBuckets?: Set<string>,
  memoryBucket = '',
  trackHistory?: (key: string, target: any, property: PropertyKey, value: any, deleted: boolean) => void
) {
  if (!target || typeof target !== 'object') return target;
  if (proxies.has(target)) return proxies.get(target);
  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      const nextRoot = rootKey || (typeof property === 'string' ? property : '');
      let nextMemoryBucket = memoryBucket;
      if (rootKey === 'memories' && Array.isArray(object) && isArrayIndexProperty(property)) {
        const rawValue = rawTargets.get(value) || value;
        nextMemoryBucket = memoryBucketName(rawValue?.userId);
      }
      return trackedMutationProxy(
        value,
        dirtyKeys,
        nextRoot,
        proxies,
        rawTargets,
        dirtyMemoryBuckets,
        nextMemoryBucket,
        trackHistory
      );
    },
    set(object, property, value, receiver) {
      const key = rootKey || (typeof property === 'string' ? property : '');
      if (key) dirtyKeys.add(key);
      trackHistory?.(key, object, property, value, false);
      markMemoryBucketMutation(dirtyMemoryBuckets, rootKey, memoryBucket, object, property, value);
      return Reflect.set(object, property, unwrapTrackedValue(value, rawTargets), receiver);
    },
    deleteProperty(object, property) {
      const key = rootKey || (typeof property === 'string' ? property : '');
      if (key) dirtyKeys.add(key);
      trackHistory?.(key, object, property, undefined, true);
      markMemoryBucketMutation(dirtyMemoryBuckets, rootKey, memoryBucket, object, property, undefined);
      return Reflect.deleteProperty(object, property);
    }
  });
  proxies.set(target, proxy);
  rawTargets.set(proxy, target);
  return proxy;
}

export function updateDb(mutator) {
  assertWriteTargetSafe();
  ensureStore();
  return withDbLock(() => {
    const db = readDbUnlocked();
    const dirtyKeys = new Set<string>();
    const dirtyMemoryBuckets = new Set<string>();
    const appendStarts = new Map(HISTORY_NAMES.map(name => [name, db[name].length]));
    const trackedDb = trackedMutationProxy(db, dirtyKeys, '', new WeakMap(), new WeakMap(), dirtyMemoryBuckets, '',
      (key: HistoryName, object, property, value, deleted) => {
        if (!appendStarts.has(key)) return;
        if (!deleted && object === db[key] && ((property === 'length' && value === object.length)
          || (isArrayIndexProperty(property) && Number(property) === object.length))) return;
        appendStarts.delete(key);
      });
    let result;
    try {
      result = mutator(trackedDb);
      const appends: Partial<Record<HistoryName, any[]>> = {};
      for (const [name, start] of appendStarts) {
        if (dirtyKeys.has(name) && db[name].length > start) appends[name] = db[name].slice(Math.max(start, db[name].length - HISTORY_LIMITS[name]));
      }
      applyRetention(trackedDb, db);
      if (dirtyKeys.size > 0) {
        writeDirtyShards(db, dirtyKeys, dirtyMemoryBuckets, appends);
        autoBackupIfDue(db);
      }
    } catch (error) {
      // A failed mutator may have partially changed the cached object. Discard
      // it so the next read reconstructs the last committed disk state.
      cachedStore = null;
      invalidateStoreCaches();
      throw error;
    }
    return result ?? db;
  });
}

export function publicMemory(memory: any, includeSamples = true) {
  const value = { ...memory };
  if (!includeSamples) {
    delete value.samples;
    delete value.recentDynamics;
    delete value.profileMeta;
    return value;
  }
  return {
    ...value,
    samples: (memory.samples || []).slice(-10).map((sample) => ({
      ...sample,
      context: sample.context
        ? { ...sample.context, nearby: (sample.context.nearby || []).slice(-2) }
        : sample.context
    }))
  };
}

export function publicDb(db = readDb(), options: { includeMemorySamples?: boolean } = {}) {
  const includeMemorySamples = options.includeMemorySamples !== false;
  const minute = Math.floor(Date.now() / 60_000);
  if (
    cachedPublicDb?.db === db
    && cachedPublicDb.minute === minute
    && cachedPublicDb.includeMemorySamples === includeMemorySamples
  ) return cachedPublicDb.value;
  const now = Date.now();
  const localDayStart = usageDayStart(now);
  const usageStats = {
    ...buildUsageStats(db.usage, db.usageEvents, now),
    openai: buildOpenAIUsageStats(db.usage?.openai, now),
  };
  const {history: _usageHistory, openai: _usageOpenAI, ...publicUsage} = db.usage || initialDb.usage;
  const messages = (db.messages || []).slice(-500);
  const decisions = (db.decisions || []).slice(-300);
  const commandLogs = (db.commandLogs || []).slice(-300);
  const memories = (db.memories || []).map((memory) => publicMemory(memory, includeMemorySamples));

  const value = {
    settings: {
      ...db.settings,
      // Derived display-only identity. It is rejected by /api/settings because
      // it is not a persisted settings key.
      effectiveModel: activeModelName(db.settings),
      // Never send secrets back to the browser in plaintext. The GUI uses these
      // placeholders to show that a secret is present without exposing it.
      apiKey: db.settings.apiKey ? '已填写' : '',
      deepseekApiKey: db.settings.deepseekApiKey ? '已填写' : '',
      oneBotAccessToken: db.settings.oneBotAccessToken ? '已填写' : '',
      adminPassword: db.settings.adminPassword ? '已设置' : '',
      osuClientSecret: db.settings.osuClientSecret ? '已填写' : '',
      pplusClientSecret: db.settings.pplusClientSecret ? '已填写' : ''
    },
    groups: db.groups || [],
    users: db.users || [],
    memories,
    groupProfiles: db.groupProfiles || [],
    relationshipProfiles: db.relationshipProfiles || [],
    socialV2Summary: { revision: db.socialV2?.revision || 0, people: Object.keys(db.socialV2?.people || {}).length },
    botRegistry: db.botRegistry || db.settings?.botRegistry || { bots: [], updatedAt: '' },
    skillStore: db.skillStore || { records: [], updatedAt: '' },
    groupBotConfig: db.groupBotConfig || {},
    pendingPairCounts: db.pendingPairCounts || {},
    trustScores: db.trustScores || {},
    experience: db.experience || {},
    groupExperience: db.groupExperience || {},
    messages,
    decisions,
    commandLogs,
    usage: publicUsage,
    usageStats,
    stateStats: {
      totalMessages: (db.messages || []).length,
      todayMessages: (db.messages || []).filter((message) => {
        const time = new Date(message.createdAt || 0).getTime();
        return Number.isFinite(time) && time >= localDayStart;
      }).length,
      returnedMessages: messages.length,
      returnedDecisions: decisions.length,
      returnedCommandLogs: commandLogs.length
    }
  };
  cachedPublicDb = { db, minute, includeMemorySamples, value };
  return value;
}

export function upsertBy(list, key, item) {
  const index = list.findIndex((entry) => String(entry[key]) === String(item[key]));
  if (index >= 0) list[index] = { ...list[index], ...item, updatedAt: new Date().toISOString() };
  else list.push({ ...item, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

export function nowIso() {
  return new Date().toISOString();
}

// Config snapshots: save before each settings change, keep last 10
export function saveConfigSnapshot(db) {
  if (!db.configSnapshots) db.configSnapshots = [];
  db.configSnapshots.push({
    at: nowIso(),
    settings: JSON.parse(JSON.stringify(db.settings)),
  });
  db.configSnapshots = db.configSnapshots.slice(-10);
}

export function listConfigSnapshots(db) {
  return (db.configSnapshots || []).map((s, i) => ({ index: i, at: s.at }));
}

export function restoreConfigSnapshot(db, index) {
  const snapshots = db.configSnapshots || [];
  if (index < 0 || index >= snapshots.length) return false;
  db.settings = { ...db.settings, ...snapshots[index].settings };
  return true;
}
