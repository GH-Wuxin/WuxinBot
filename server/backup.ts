import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
const dbPath = path.join(dataDir, 'db.json');
const backupDir = path.join(dataDir, 'backups');

function ensureBackupDir() {
  fs.mkdirSync(backupDir, { recursive: true });
}

function safeBackupName(name) {
  if (!name || typeof name !== 'string') return null;
  if (!name.endsWith('.json')) return null;
  if (name !== path.basename(name)) return null;
  if (/[/\\:]/.test(name) || name.includes('..')) return null;
  const resolved = path.resolve(backupDir, name);
  if (!resolved.startsWith(path.resolve(backupDir) + path.sep)) return null;
  return resolved;
}

export function createBackup(type = 'manual') {
  ensureBackupDir();
  if (!fs.existsSync(dbPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${type}-${ts}.json`;
  const dest = path.join(backupDir, name);
  fs.copyFileSync(dbPath, dest);
  // Write a tiny meta file
  const meta = { type, name, createdAt: new Date().toISOString(), size: fs.statSync(dest).size };
  fs.writeFileSync(dest + '.meta.json', JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

export function listBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
  return files.map((name) => {
    const filePath = path.join(backupDir, name);
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
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
    json = JSON.parse(raw);
    if (!json || typeof json !== 'object') throw new Error('不是有效的JSON对象');
  } catch (e) {
    return { ok: false, error: `备份文件 JSON 校验失败：${e.message}` };
  }
  // Auto-backup current DB before restore (pre-restore safety)
  createBackup('pre-restore');
  // Write restored data
  fs.writeFileSync(dbPath, JSON.stringify(json, null, 2), 'utf8');
  return { ok: true, name };
}

export function deleteBackup(name) {
  ensureBackupDir();
  const filePath = safeBackupName(name);
  if (!filePath) return { ok: false, error: `无效的备份名称: ${name}` };
  const metaPath = filePath + '.meta.json';
  if (!fs.existsSync(filePath)) return { ok: false, error: `备份 ${name} 不存在` };
  fs.unlinkSync(filePath);
  try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
  return { ok: true };
}

export function pruneAutoBackups() {
  ensureBackupDir();
  const all = listBackups();
  let pruned = 0;
  // Auto backups: keep latest 10
  const auto = all.filter((b) => b.type === 'auto');
  if (auto.length > 10) {
    for (const b of auto.slice(10)) {
      try { fs.unlinkSync(path.join(backupDir, b.name)); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(backupDir, b.name + '.meta.json')); } catch { /* ignore */ }
      pruned++;
    }
  }
  // Pre-restore backups: keep latest 5
  const preRestore = all.filter((b) => b.type === 'pre-restore');
  if (preRestore.length > 5) {
    for (const b of preRestore.slice(5)) {
      try { fs.unlinkSync(path.join(backupDir, b.name)); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(backupDir, b.name + '.meta.json')); } catch { /* ignore */ }
      pruned++;
    }
  }
  return { pruned };
}
