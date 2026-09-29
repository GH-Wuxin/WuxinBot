// Console player-profile snapshots: a small JSON store in the runtime data
// directory so the GUI can show "fetched at" and refresh without hammering the
// osu! API. Analysis results for the console drawer are kept here too.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir } from '../store.js';

function storeFilePath(): string {
  // Runtime state belongs to the configured data root, not to the source
  // checkout — the old checkout-relative path broke DATA_DIR isolation and
  // was shared by every instance running the same source tree (finding F08).
  return path.join(getDataDir(), 'osu-console-profiles.json');
}

export interface ConsoleAnalysisEntry {
  status: 'idle' | 'running' | 'done' | 'error';
  at?: string;
  finishedAt?: string;
  text?: string;
  error?: string;
  source?: 'llm' | 'fallback';
  provider?: string;
  model?: string;
  formatVersion?: number;
  validationReasons?: string[];
  bestCount?: number;
  recentCount?: number;
}

interface PlayerRecord {
  profile?: { fetchedAt: string; user: any };
  analysis?: ConsoleAnalysisEntry;
}

const MIGRATION_META_KEY = '__wuxin_profile_store_meta__';

interface ProfileStoreMetadata {
  migration?: {
    status: 'completed';
    sourcePath: string;
    sourceSha256: string;
    sourceSize: number;
    migratedAt: string;
  };
}

type ProfileStoreRecords = Record<string, PlayerRecord | ProfileStoreMetadata>;

export interface ProfileMigrationResult {
  ok: boolean;
  status:
    | 'migrated'
    | 'already_migrated'
    | 'invalid_request'
    | 'invalid_source'
    | 'invalid_destination'
    | 'destination_not_empty'
    | 'destination_write_failed';
  source?: string;
  destination?: string;
  sourceSha256?: string;
  reason?: string;
}

let cache: ProfileStoreRecords | null = null;
let cacheDataDir = '';

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlayerRecord(value: unknown): value is PlayerRecord {
  if (!isObject(value)) return false;
  if (value.profile !== undefined) {
    if (!isObject(value.profile) || typeof value.profile.fetchedAt !== 'string' || !('user' in value.profile)) return false;
  }
  if (value.analysis !== undefined) {
    if (!isObject(value.analysis) || !['idle', 'running', 'done', 'error'].includes(value.analysis.status)) return false;
  }
  return true;
}

function isMetadataRecord(value: unknown): value is ProfileStoreMetadata {
  if (!isObject(value) || value.migration === undefined) return false;
  return isObject(value.migration) &&
    value.migration.status === 'completed' &&
    typeof value.migration.sourcePath === 'string' &&
    typeof value.migration.sourceSha256 === 'string' &&
    Number.isFinite(value.migration.sourceSize) &&
    typeof value.migration.migratedAt === 'string';
}

function validateRecords(value: unknown): { ok: true; records: ProfileStoreRecords } | { ok: false; reason: string } {
  if (!isObject(value)) return { ok: false, reason: 'profile store must be a JSON object' };
  for (const [key, record] of Object.entries(value)) {
    if (key === MIGRATION_META_KEY) {
      if (!isMetadataRecord(record)) return { ok: false, reason: 'invalid migration metadata' };
      continue;
    }
    if (!isPlayerRecord(record)) return { ok: false, reason: `invalid player record: ${key}` };
  }
  return { ok: true, records: value as ProfileStoreRecords };
}

function playerRecordsOnly(records: ProfileStoreRecords): Record<string, PlayerRecord> {
  const result: Record<string, PlayerRecord> = {};
  for (const [key, value] of Object.entries(records)) {
    if (key !== MIGRATION_META_KEY) result[key] = value as PlayerRecord;
  }
  return result;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJsonFile(filePath: string): { value: unknown; bytes: Buffer; sha256: string } | { error: string } {
  try {
    const bytes = fs.readFileSync(filePath);
    return {
      value: JSON.parse(bytes.toString('utf8')),
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the original error */ }
    throw error;
  }
}

function load(): ProfileStoreRecords {
  const dataDir = getDataDir();
  if (cache && cacheDataDir === dataDir) return cache;
  const storePath = storeFilePath();
  let records: ProfileStoreRecords = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (isObject(parsed)) records = parsed as ProfileStoreRecords;
  } catch { /* missing or unreadable: start from an empty set */ }
  // A persisted 'running' flag is not proof of a live worker: it belongs to a
  // previous process generation. Mark those tasks interrupted at first load so
  // the console can retry instead of receiving 202 started:false forever
  // (finding F07).
  let interrupted = 0;
  for (const [key, record] of Object.entries(records)) {
    if (key === MIGRATION_META_KEY || !isPlayerRecord(record)) continue;
    if (record.analysis?.status === 'running') {
      record.analysis = {
        ...record.analysis,
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: 'ANALYSIS_INTERRUPTED: 后端重启导致分析中断，可重新发起',
      };
      interrupted += 1;
    }
  }
  cache = records;
  cacheDataDir = dataDir;
  if (interrupted > 0) persist();
  return cache;
}

function persist(): void {
  const storePath = storeFilePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, storePath);
}

export function getStoredProfile(osuId: string | number): { fetchedAt: string; user: any } | null {
  const record = load()[String(osuId)];
  return isPlayerRecord(record) ? record.profile || null : null;
}

export function setStoredProfile(osuId: string | number, user: any): void {
  const records = load();
  const key = String(osuId);
  const existing = isPlayerRecord(records[key]) ? records[key] : {};
  records[key] = { ...existing, profile: { fetchedAt: new Date().toISOString(), user } };
  persist();
}

export function getStoredAnalysis(osuId: string | number): ConsoleAnalysisEntry | null {
  const record = load()[String(osuId)];
  return isPlayerRecord(record) ? record.analysis || null : null;
}

export function setStoredAnalysis(osuId: string | number, entry: ConsoleAnalysisEntry): void {
  const records = load();
  const key = String(osuId);
  const existing = isPlayerRecord(records[key]) ? records[key] : {};
  records[key] = { ...existing, analysis: entry };
  persist();
}

/**
 * Import a legacy checkout-relative profile file only when explicitly asked.
 * The caller must provide both paths.  Existing destination data is never
 * overwritten by default; a successful migration records a source digest in
 * the destination so an exact repeat is idempotent.
 */
export function migrateLegacyProfiles(options: { source?: string; destination?: string }): ProfileMigrationResult {
  const source = options?.source ? path.resolve(options.source) : '';
  const destination = options?.destination ? path.resolve(options.destination) : '';
  if (!source || !destination || source.toLowerCase() === destination.toLowerCase()) {
    return { ok: false, status: 'invalid_request', reason: 'source and destination must be distinct explicit paths' };
  }

  const sourceRead = readJsonFile(source);
  if ('error' in sourceRead) {
    return { ok: false, status: 'invalid_source', source, destination, reason: sourceRead.error };
  }
  const sourceValidation = validateRecords(sourceRead.value);
  if (sourceValidation.ok === false) {
    return { ok: false, status: 'invalid_source', source, destination, reason: sourceValidation.reason };
  }
  const sourceRecords = playerRecordsOnly(sourceValidation.records);

  let destinationRecords: ProfileStoreRecords = {};
  if (fs.existsSync(destination)) {
    const destinationRead = readJsonFile(destination);
    if ('error' in destinationRead) {
      return { ok: false, status: 'invalid_destination', source, destination, reason: destinationRead.error };
    }
    const destinationValidation = validateRecords(destinationRead.value);
    if (destinationValidation.ok === false) {
      return { ok: false, status: 'invalid_destination', source, destination, reason: destinationValidation.reason };
    }
    destinationRecords = destinationValidation.records;
    const destinationMeta = destinationRecords[MIGRATION_META_KEY];
    const destinationPlayers = playerRecordsOnly(destinationRecords);
    if (
      isMetadataRecord(destinationMeta) &&
      destinationMeta.migration?.status === 'completed' &&
      destinationMeta.migration.sourceSha256 === sourceRead.sha256 &&
      stableSerialize(destinationPlayers) === stableSerialize(sourceRecords)
    ) {
      return { ok: true, status: 'already_migrated', source, destination, sourceSha256: sourceRead.sha256 };
    }
    if (Object.keys(destinationPlayers).length > 0) {
      return { ok: false, status: 'destination_not_empty', source, destination, sourceSha256: sourceRead.sha256 };
    }
  }

  const output: ProfileStoreRecords = {
    ...sourceRecords,
    [MIGRATION_META_KEY]: {
      migration: {
        status: 'completed',
        sourcePath: source,
        sourceSha256: sourceRead.sha256,
        sourceSize: sourceRead.bytes.length,
        migratedAt: new Date().toISOString(),
      },
    },
  };
  try {
    atomicWrite(destination, JSON.stringify(output, null, 2) + '\n');
  } catch (error) {
    return {
      ok: false,
      status: 'destination_write_failed',
      source,
      destination,
      sourceSha256: sourceRead.sha256,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (path.resolve(storeFilePath()).toLowerCase() === destination.toLowerCase()) {
    cache = null;
    cacheDataDir = '';
  }
  return { ok: true, status: 'migrated', source, destination, sourceSha256: sourceRead.sha256 };
}
