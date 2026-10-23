import fs from 'node:fs';
import path from 'node:path';
import { readDb, writeDb, isValidLogicalDbShape, getDataDir } from './store.js';
import { listBackupFiles, pruneBackupFiles, removeBackupFile, resolveBackupRetention, safeBackupPath, type BackupType } from './backupFiles.js';
export { DEFAULT_BACKUP_RETENTION } from './backupFiles.js';

// The data root is resolved per call (not at import time) so tests and tools
// that set DATA_DIR after importing this module stay isolated from production
// and every consumer follows the one shared DataRoot (finding F08).
function backupDir() {
  return path.join(getDataDir(), 'backups');
}
function dbPath() {
  return path.join(getDataDir(), 'db.json');
}
const BACKUP_TYPES = new Set(['manual', 'auto', 'pre-restore']);

function ensureBackupDir() {
  fs.mkdirSync(backupDir(), { recursive: true });
}

function safeBackupName(name) { return safeBackupPath(backupDir(), name); }

export function createBackup(type = 'manual') {
  ensureBackupDir();
  if (!fs.existsSync(dbPath())) return null;
  const safeType = String(type || '').trim();
  if (!BACKUP_TYPES.has(safeType)) {
    throw new Error(`不支持的备份类型: ${safeType || '(空)'}`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${safeType}-${ts}.json`;
  const dest = path.resolve(backupDir(), name);
  if (!dest.startsWith(path.resolve(backupDir()) + path.sep)) {
    throw new Error('备份路径越界');
  }
  // db.json is only the small core shard in storage v1. Backups deliberately
  // remain one complete logical JSON document so they are portable and can be
  // restored without knowing the on-disk shard layout.
  const db = readDb();
  fs.writeFileSync(dest, JSON.stringify(db), 'utf8');
  // Write a tiny meta file
  const meta = { type: safeType, name, createdAt: new Date().toISOString(), size: fs.statSync(dest).size };
  fs.writeFileSync(dest + '.meta.json', JSON.stringify(meta, null, 2), 'utf8');
  const result = pruneBackupFiles(backupDir(), resolveBackupRetention(db), { types: [safeType as BackupType] });
  if (result.failed.length) console.error('[backup] cleanup failed:', result.failed);
  return meta;
}

export function listBackups() {
  ensureBackupDir();
  return listBackupFiles(backupDir());
}

export function restoreBackup(name) {
  ensureBackupDir();
  const filePath = safeBackupName(name);
  if (!filePath) return { ok: false, error: `无效的备份名称: ${name}` };
  if (!fs.existsSync(filePath)) return { ok: false, error: `备份 ${name} 不存在` };
  // Validate JSON before restore
  let json;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('不是有效的JSON对象');
  } catch (e) {
    return { ok: false, error: `备份文件 JSON 校验失败：${e.message}` };
  }
  // A restorable backup must be a complete logical database, not merely
  // parseable JSON — fragments would normalize into a plausible empty store.
  if (!isValidLogicalDbShape(json)) {
    return { ok: false, error: '备份缺少核心数据结构（settings 或主要集合），不是完整的逻辑数据库，已拒绝恢复' };
  }
  // Auto-backup current DB before restore (pre-restore safety)
  createBackup('pre-restore');
  // Write restored data
  writeDb(json);
  return { ok: true, name };
}

export function deleteBackup(name) {
  ensureBackupDir();
  try { removeBackupFile(backupDir(), name); return { ok: true }; }
  catch (error: any) { return { ok: false, error: '删除备份失败：' + String(error.code || error.message || error) }; }
}

export function backupRetention(db = readDb()) { return resolveBackupRetention(db); }

/** Count cleanup and age cleanup share file discovery with store snapshots. */
export function pruneBackups(options: { olderThanDays?: number } = {}) {
  ensureBackupDir();
  return pruneBackupFiles(backupDir(), backupRetention(), options);
}

export function pruneAutoBackups() {
  const result = pruneBackups();
  if (result.failed.length) console.error('[backup] startup cleanup failed:', result.failed);
  return { pruned: result.removed };
}
