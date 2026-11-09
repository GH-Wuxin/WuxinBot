import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { assertWriteTargetSafe, getDataDir } from './store.js';

export const OWN_ARCHIVE_FILE = 'own-messages.sqlite';
export const ARCHIVE_BACKUP_SUFFIX = '.own-messages.sqlite';
type Row = {id: string; account: string; scope: string; at: string; platform: string | null; outcome: string; source: string; data: string};

function archivePath(directory: string): string {
  const file = path.join(directory, OWN_ARCHIVE_FILE);
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw Error('Own-message archive is not a regular file');
  return file;
}

/** Short-lived connections avoid stale data roots and locked test/backup files. */
function connection<T>(directory: string, write: boolean, work: (db: DatabaseSync) => T): T | undefined {
  if (path.resolve(directory) !== getDataDir()) throw Error('Own-message archive data root mismatch');
  if (write) assertWriteTargetSafe();
  const file = archivePath(directory);
  if (!write && !fs.existsSync(file)) return undefined;
  if (write) fs.mkdirSync(directory, {recursive: true});
  const db = new DatabaseSync(file, {readOnly: !write});
  try {
    db.exec('PRAGMA busy_timeout=200');
    if (write) db.exec(`
      CREATE TABLE IF NOT EXISTS own_messages (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, scope TEXT NOT NULL, at TEXT NOT NULL,
        platform TEXT, outcome TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS own_scope_time ON own_messages(account, scope, at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS own_platform_lookup ON own_messages(account, scope, platform, at DESC);
      CREATE TABLE IF NOT EXISTS archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forgotten_receipts (digest TEXT PRIMARY KEY);
    `);
    if (write && (db.prepare("SELECT value FROM archive_meta WHERE key='schema'").get() as any)?.value !== '2') {
      db.exec("DROP INDEX IF EXISTS own_platform; INSERT OR REPLACE INTO archive_meta VALUES('schema','2')");
    }
    return work(db);
  } finally { db.close(); }
}

export function saveOwnArchive(directory: string, record: any): void {
  connection(directory, true, db => {
    const scope = record.type === 'group' ? `group:${record.groupId}` : `private:${record.peerId || record.replyToUserId || ''}`;
    const platform = record.sourceMessageId && String(record.sourceMessageId) !== '0' ? String(record.sourceMessageId) : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const digest = platform ? receiptDigest(record.accountId || '', scope, platform) : '';
      if (record.originModule === 'self_event' && digest && db.prepare('SELECT digest FROM forgotten_receipts WHERE digest=?').get(digest)) {
        const cleared = archiveClearTime(db,scope);
        if (!record.createdAt || cleared && record.createdAt <= cleared) {db.exec('COMMIT');return;}
      }
      const cutoff = db.prepare("SELECT MAX(value) AS at FROM archive_meta WHERE key IN ('cleared:*',?,?)")
        .get('cleared:' + scope,scope.startsWith('private:')?'cleared:private:*':'cleared:unused') as {at: string | null};
      if (cutoff.at && String(record.createdAt || '') <= cutoff.at) {db.exec('COMMIT');return;}
      const previous = db.prepare('SELECT account,scope,data FROM own_messages WHERE id=?').get(record.id) as Pick<Row,'account'|'scope'|'data'> | undefined;
      if (previous && (previous.account !== (record.accountId || '') || previous.scope !== scope)) throw Error('archive_record_scope_mismatch');
      // Platform IDs are lookup hints, not the archive's permanent identity.
      // Only an unattributed, contemporaneous echo can merge into an attempt;
      // distinct real sends reusing an ID retain their separate UUID records.
      const echoes = platform && record.originModule !== 'self_event'
        ? db.prepare('SELECT id,data FROM own_messages WHERE account=? AND scope=? AND platform=? AND id<>? ORDER BY at DESC')
          .all(record.accountId || '',scope,platform,record.id) as {id:string;data:string}[] : [];
      const echo = echoes.find(row => {const data=JSON.parse(row.data);return data.originModule==='self_event'
        && Math.abs(Date.parse(data.createdAt)-Date.parse(record.createdAt))<=120_000;});
      const echoRecord = echo ? JSON.parse(echo.data) : undefined;
      const older = previous ? JSON.parse(previous.data) : echoRecord;
      const merged = {...older, ...record};
      if (older?.deliveryOutcome === 'confirmed_success' || echoRecord?.deliveryOutcome === 'confirmed_success') {
        merged.deliveryOutcome = 'confirmed_success';
        merged.confirmedAt ||= echoRecord?.confirmedAt || older?.confirmedAt;
      }
      if (older?.messageSource?.certainty === 'recorded' && record.messageSource?.certainty !== 'recorded') merged.messageSource = older.messageSource;
      if (echo && echo.id !== record.id) db.prepare('DELETE FROM own_messages WHERE id=?').run(echo.id);
      db.prepare(`INSERT INTO own_messages(id,account,scope,at,platform,outcome,source,data) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,outcome=excluded.outcome,source=excluded.source,data=excluded.data`)
        .run(record.id, record.accountId || '', scope, record.createdAt, platform, merged.deliveryOutcome || 'unknown',
          merged.messageSource?.chain?.at(-1)?.module || 'unknown', JSON.stringify(merged));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

export function readOwnArchive(directory: string, account: string, scope: string, key: {id?: string; messageId?: string}): any | undefined {
  return connection(directory, false, db => {
    const row = db.prepare(`SELECT data FROM own_messages WHERE account=? AND scope=? AND ${key.id ? 'id' : 'platform'}=? ORDER BY at DESC,id DESC LIMIT 1`)
      .get(account, scope, key.id || key.messageId || '') as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  });
}

export function readOwnArchiveById(directory: string, id: string): any | undefined {
  return connection(directory, false, db => {
    const row = db.prepare('SELECT data FROM own_messages WHERE id=?').get(id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  });
}

export function forgottenOwnReceipt(directory: string, account: string, scope: string, platform: string, observedAt?: string): boolean {
  return Boolean(connection(directory, false, db => {
    if (!db.prepare('SELECT digest FROM forgotten_receipts WHERE digest=?').get(receiptDigest(account,scope,platform))) return false;
    const cleared=archiveClearTime(db,scope);
    return !observedAt || Boolean(cleared && observedAt <= cleared);
  }));
}

function archiveClearTime(db: DatabaseSync, scope: string): string | null {
  return (db.prepare("SELECT MAX(value) AS at FROM archive_meta WHERE key IN ('cleared:*',?,?)")
    .get('cleared:'+scope,scope.startsWith('private:')?'cleared:private:*':'cleared:unused') as {at:string|null}).at;
}

export function ownPlatformMatches(directory: string, account: string, scope: string, platform: string): number {
  return connection(directory,false,db => Number((db.prepare('SELECT COUNT(*) AS count FROM own_messages WHERE account=? AND scope=? AND platform=?')
    .get(account,scope,platform) as any).count)) || 0;
}

export function pageOwnArchive(directory: string, account: string, scope: string, options: {
  before?: string; source?: string; since?: string; until?: string; limit: number; includeUnconfirmed?: boolean;
}): {records: any[]; nextCursor: string | null} {
  return connection(directory, false, db => {
    const where = ['account=?', 'scope=?'];
    const values: (string | number)[] = [account, scope];
    if (!options.includeUnconfirmed) where.push("outcome='confirmed_success'");
    if (options.before) {
      const cursor = db.prepare('SELECT id,at FROM own_messages WHERE id=? AND account=? AND scope=?').get(options.before, account, scope) as Pick<Row,'id'|'at'> | undefined;
      if (!cursor) throw Error('invalid_cursor');
      where.push('(at<? OR (at=? AND id<?))'); values.push(cursor.at, cursor.at, cursor.id);
    }
    if (options.source) {where.push('source=?'); values.push(options.source);}
    if (options.since) {where.push('at>=?'); values.push(options.since);}
    if (options.until) {where.push('at<=?'); values.push(options.until);}
    const rows = db.prepare(`SELECT data FROM own_messages WHERE ${where.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`)
      .all(...values, options.limit + 1) as {data: string}[];
    const records = rows.slice(0, options.limit).map(row => JSON.parse(row.data));
    return {records, nextCursor: rows.length > options.limit ? records.at(-1).id : null};
  }) || {records: [], nextCursor: null};
}

export function ownArchiveMigrationDone(directory: string): boolean {
  return Boolean(connection(directory, false, db => db.prepare("SELECT value FROM archive_meta WHERE key='legacy_imported'").get()));
}
export function finishOwnArchiveMigration(directory: string): void {
  connection(directory, true, db => {db.prepare("INSERT OR REPLACE INTO archive_meta VALUES('legacy_imported',?)").run(new Date().toISOString());});
}
export function clearOwnArchive(directory: string, scope?: string): void {
  connection(directory, true, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = (scope==='private:*'?db.prepare("SELECT account,scope,platform FROM own_messages WHERE scope LIKE 'private:%' AND platform IS NOT NULL").all()
        :scope ? db.prepare('SELECT account,scope,platform FROM own_messages WHERE scope=? AND platform IS NOT NULL').all(scope)
        : db.prepare('SELECT account,scope,platform FROM own_messages WHERE platform IS NOT NULL').all()) as Pick<Row,'account'|'scope'|'platform'>[];
      const forget = db.prepare('INSERT OR IGNORE INTO forgotten_receipts VALUES(?)');
      for (const row of old) forget.run(receiptDigest(row.account,row.scope,row.platform!));
      if (scope==='private:*') db.exec("DELETE FROM own_messages WHERE scope LIKE 'private:%'");
      else if (scope) db.prepare('DELETE FROM own_messages WHERE scope=?').run(scope);
      else db.exec('DELETE FROM own_messages');
      db.prepare('INSERT OR REPLACE INTO archive_meta VALUES(?,?)').run('cleared:' + (scope || '*'), new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {db.exec('ROLLBACK');throw error;}
  });
}

function receiptDigest(account: string, scope: string, platform: string): string {
  return createHash('sha256').update(JSON.stringify([account,scope,platform])).digest('hex');
}

/** Existing JSON backups get a consistent adjacent archive, kept out of prompts. */
export function snapshotOwnArchive(directory: string, jsonBackup: string): boolean {
  assertWriteTargetSafe();
  if (path.dirname(path.resolve(jsonBackup)) !== path.join(getDataDir(), 'backups')) throw Error('Own-message backup path escaped');
  const destination = jsonBackup + ARCHIVE_BACKUP_SUFFIX;
  if (fs.existsSync(destination)) throw Error('Own-message archive snapshot already exists');
  return connection(directory, false, db => {
    const temporary = destination + '.tmp';
    if (fs.existsSync(temporary)) throw Error('Unfinished own-message archive snapshot exists');
    db.prepare('VACUUM INTO ?').run(temporary);
    fs.renameSync(temporary, destination);
    return true;
  }) || false;
}
export function validateOwnArchiveBackup(jsonBackup: string): void {
  const source = jsonBackup + ARCHIVE_BACKUP_SUFFIX;
  let required = false;
  if (fs.existsSync(jsonBackup + '.meta.json')) {
    const metaStat = fs.lstatSync(jsonBackup + '.meta.json');
    if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 64 * 1024) throw Error('Invalid backup metadata');
    required = JSON.parse(fs.readFileSync(jsonBackup + '.meta.json','utf8').replace(/^\uFEFF/, '')).ownMessageArchive === true;
  }
  if (!fs.existsSync(source)) {if(required)throw Error('Own-message archive backup is missing');return;}
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid own-message archive backup');
  const check = new DatabaseSync(source, {readOnly: true});
  try {
    if ((check.prepare('PRAGMA integrity_check').get() as any).integrity_check !== 'ok') throw Error('Invalid own-message archive backup');
    check.prepare('SELECT id,account,scope,at,data FROM own_messages LIMIT 1').all();
  } finally {check.close();}
}
export function restoreOwnArchive(directory: string, jsonBackup: string): void {
  assertWriteTargetSafe();
  if (path.resolve(directory) !== getDataDir() || path.dirname(path.resolve(jsonBackup)) !== path.join(getDataDir(), 'backups')) throw Error('Own-message restore path escaped');
  const source = jsonBackup + ARCHIVE_BACKUP_SUFFIX;
  validateOwnArchiveBackup(jsonBackup);
  if (!fs.existsSync(source)) return; // Older backups must not silently destroy a newer archive.
  const target = archivePath(directory);
  fs.copyFileSync(source, target + '.restore.tmp');
  fs.renameSync(target + '.restore.tmp', target);
}

/** Automatic core-store recovery must not roll back a newer, healthy send ledger. */
export function recoverOwnArchive(directory: string, jsonBackup: string): void {
  assertWriteTargetSafe();
  const target = archivePath(directory);
  if (fs.existsSync(target)) {
    let healthy = false;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(target, {readOnly:true});
      healthy = (db.prepare('PRAGMA quick_check').get() as any).quick_check === 'ok';
      db.prepare('SELECT id,account,scope,at,data FROM own_messages LIMIT 1').all();
    } catch {healthy=false;} finally {db?.close();}
    if (healthy) return;
    fs.copyFileSync(target,target+'.corrupt-'+Date.now());
  }
  restoreOwnArchive(directory,jsonBackup);
}
