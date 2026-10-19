import fs from 'node:fs';
import path from 'node:path';
import { readDb, writeDb, isValidLogicalDbShape, getDataDir } from './store.js';

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

function safeBackupName(name) {
  if (!name || typeof name !== 'string') return null;
  if (!name.endsWith('.json')) return null;
  if (name.endsWith('.meta.json')) return null;
  if (name !== path.basename(name)) return null;
  if (/[/\\:]/.test(name) || name.includes('..')) return null;
  const resolved = path.resolve(backupDir(), name);
  if (!resolved.startsWith(path.resolve(backupDir()) + path.sep)) return null;
  return resolved;
}

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
  fs.writeFileSync(dest, JSON.stringify(readDb()), 'utf8');
  // Write a tiny meta file
  const meta = { type: safeType, name, createdAt: new Date().toISOString(), size: fs.statSync(dest).size };
  fs.writeFileSync(dest + '.meta.json', JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(backupDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  return files.map((name) => {
    const filePath = path.join(backupDir(), name);
    const metaPath = filePath + '.meta.json';
    let meta = { type: 'unknown', name, createdAt: '', size: 0 };
    try {
      if (fs.existsSync(metaPath)) meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
    } catch { /* ignore */ }
    try { meta.size = fs.statSync(filePath).size; } catch { meta.size = 0; }
    return meta;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
  const filePath = safeBackupName(name);
  if (!filePath) return { ok: false, error: `无效的备份名称: ${name}` };
  if (!fs.existsSync(filePath)) return { ok: false, error: `备份 ${name} 不存在` };
  fs.unlinkSync(filePath);
  try { fs.unlinkSync(filePath + '.meta.json'); } catch { /* ignore */ }
  return { ok: true };
}

export const DEFAULT_BACKUP_RETENTION = { auto: 10, preRestore: 5, manual: 0 };

/** 保留份数：0 表示不限。存在 settings.backupRetention，超出范围自动收口。 */
export function backupRetention(db = readDb()) {
  const saved = (db?.settings && db.settings.backupRetention) || {};
  const clamp = (value, fallback, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(max, Math.floor(parsed)));
  };
  return {
    auto: clamp(saved.auto, DEFAULT_BACKUP_RETENTION.auto, 200),
    preRestore: clamp(saved.preRestore, DEFAULT_BACKUP_RETENTION.preRestore, 200),
    manual: clamp(saved.manual, DEFAULT_BACKUP_RETENTION.manual, 500),
  };
}

function dropBackup(name) {
  try { fs.unlinkSync(path.join(backupDir(), name)); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(backupDir(), name + '.meta.json')); } catch { /* ignore */ }
}

/**
 * 批量清理：先按保留份数裁掉超出的最旧几份，再按天数删过期备份。
 * olderThanDays 只对自动/恢复前备份生效，手动备份不会被时间淘汰。
 */
export function pruneBackups(options: { olderThanDays?: number } = {}) {
  ensureBackupDir();
  const retention = backupRetention();
  const olderThanDays = Number(options.olderThanDays);
  const cutoff = Number.isFinite(olderThanDays) && olderThanDays > 0
    ? Date.now() - olderThanDays * 24 * 60 * 60_000
    : 0;
  const all = listBackups();
  const keepOf = { auto: retention.auto, 'pre-restore': retention.preRestore, manual: retention.manual };
  const removed = [];
  for (const type of ['auto', 'pre-restore', 'manual']) {
    const group = all
      .filter((backup) => backup.type === type || (!backup.type && type === 'manual'))
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime());
    const keep = keepOf[type];
    group.forEach((backup, index) => {
      const overLimit = keep > 0 && index >= keep;
      const expired = cutoff > 0 && type !== 'manual' && new Date(backup.createdAt || 0).getTime() < cutoff;
      if (!overLimit && !expired) return;
      dropBackup(backup.name);
      removed.push(backup.name);
    });
  }
  return { removed: removed.length, names: removed.slice(0, 50) };
}

export function pruneAutoBackups() {
  return { pruned: pruneBackups().removed };
}
