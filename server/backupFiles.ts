import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_TYPES = ['auto', 'pre-restore', 'manual'] as const;
export type BackupType = typeof BACKUP_TYPES[number];
export const DEFAULT_BACKUP_RETENTION = { auto: 10, preRestore: 5, manual: 0 };

// Shared by the store's recovery snapshots and the maintenance API. No store
// imports here: automatic snapshots are also made while a store lock is held.
export function resolveBackupRetention(db: any) {
  const saved = db?.settings?.backupRetention || {};
  const clamp = (value: unknown, fallback: number, max: number) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : fallback;
  };
  return {
    auto: clamp(saved.auto, DEFAULT_BACKUP_RETENTION.auto, 200),
    preRestore: clamp(saved.preRestore, DEFAULT_BACKUP_RETENTION.preRestore, 200),
    manual: clamp(saved.manual, DEFAULT_BACKUP_RETENTION.manual, 500),
  };
}

export function safeBackupPath(directory: string, name: unknown): string | null {
  if (typeof name !== 'string' || !name.endsWith('.json') || name.endsWith('.meta.json')
    || name !== path.basename(name) || /[/\\:]/.test(name) || name.includes('..')) return null;
  const file = path.resolve(directory, name);
  return path.dirname(file) === path.resolve(directory) ? file : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function listBackupFiles(directory: string) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap(name => {
    const file = safeBackupPath(directory, name);
    if (!file) return [];
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      let meta: any = {};
      try {
        const metaStat = fs.lstatSync(file + '.meta.json');
        if (metaStat.isFile() && !metaStat.isSymbolicLink() && metaStat.size < 64 * 1024) {
          meta = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8').replace(/^\uFEFF/, ''));
        }
      } catch { /* Store snapshots and older backups have no sidecar metadata. */ }
      const match = /^(auto|manual|pre-restore)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z?\.json$/.exec(name);
      const filenameDate = match ? isoDate(`${match[2]}T${match[3]}:${match[4]}:${match[5]}.${match[6] || '000'}Z`) : null;
      const type = match?.[1] || (BACKUP_TYPES.includes(meta?.type) ? meta.type : 'unknown');
      // The directory entry owns name and size; sidecars cannot redirect deletes.
      return [{ name, type, createdAt: filenameDate || isoDate(meta?.createdAt) || stat.mtime.toISOString(), size: stat.size }];
    } catch (error: any) {
      if (error.code === 'ENOENT') return []; // A concurrent cleanup removed it.
      throw error;
    }
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.name.localeCompare(a.name));
}

export function removeBackupFile(directory: string, name: string) {
  const file = safeBackupPath(directory, name);
  if (!file) throw new Error('无效的备份名称');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份不是普通文件');
  fs.unlinkSync(file);
  try { fs.unlinkSync(file + '.meta.json'); }
  catch (error: any) {
    if (error.code !== 'ENOENT') console.error('[backup] metadata cleanup failed:', name, error.code || 'UNKNOWN');
  }
}

export function pruneBackupFiles(directory: string, retention: ReturnType<typeof resolveBackupRetention>, options: { olderThanDays?: number; types?: readonly BackupType[] } = {}) {
  const days = Number(options.olderThanDays);
  const cutoff = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : 0;
  const keepOf = { auto: retention.auto, 'pre-restore': retention.preRestore, manual: retention.manual };
  const all = listBackupFiles(directory);
  const removed: string[] = [], failed: { name: string; error: string }[] = [];
  for (const type of options.types || BACKUP_TYPES) {
    const group = all.filter(backup => backup.type === type);
    group.forEach((backup, index) => {
      // The age-only button promises to leave manual backups alone.
      const shouldRemove = cutoff > 0
        ? type !== 'manual' && Date.parse(backup.createdAt) < cutoff
        : keepOf[type] > 0 && index >= keepOf[type];
      if (!shouldRemove) return;
      try { removeBackupFile(directory, backup.name); removed.push(backup.name); }
      catch (error: any) { failed.push({ name: backup.name, error: String(error.code || error.message || error) }); }
    });
  }
  return { removed: removed.length, names: removed.slice(0, 50), failed };
}
