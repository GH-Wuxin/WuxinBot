// Console player-profile snapshots: a small JSON store in the runtime data
// directory so the GUI can show "fetched at" and refresh without hammering the
// osu! API. Analysis results for the console drawer are kept here too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir } from '../store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function storeFilePath(): string {
  // Runtime state belongs to the configured data root, not to the source
  // checkout — the old checkout-relative path broke DATA_DIR isolation and
  // was shared by every instance running the same source tree (finding F08).
  return path.join(getDataDir(), 'osu-console-profiles.json');
}

function legacyFilePath(): string {
  return path.resolve(__dirname, '..', '..', 'data', 'osu-console-profiles.json');
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

let cache: Record<string, PlayerRecord> | null = null;
let cacheDataDir = '';

function load(): Record<string, PlayerRecord> {
  const dataDir = getDataDir();
  if (cache && cacheDataDir === dataDir) return cache;
  const storePath = storeFilePath();
  let records: Record<string, PlayerRecord> = {};
  try {
    records = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch { /* missing or unreadable: start from an empty set */ }
  let imported = false;
  if (!fs.existsSync(storePath) && fs.existsSync(legacyFilePath())) {
    // One-time import from the pre-F08 checkout-relative location. The source
    // file is kept as the migration record and is never written again.
    try {
      records = JSON.parse(fs.readFileSync(legacyFilePath(), 'utf8'));
      imported = true;
      console.log(`[profileStore] imported console profiles from ${legacyFilePath()}`);
    } catch { /* keep the empty set */ }
  }
  // A persisted 'running' flag is not proof of a live worker: it belongs to a
  // previous process generation. Mark those tasks interrupted at first load so
  // the console can retry instead of receiving 202 started:false forever
  // (finding F07).
  let interrupted = 0;
  for (const record of Object.values(records)) {
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
  if (imported || interrupted > 0) persist();
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
  return load()[String(osuId)]?.profile || null;
}

export function setStoredProfile(osuId: string | number, user: any): void {
  const records = load();
  const key = String(osuId);
  records[key] = records[key] || {};
  records[key].profile = { fetchedAt: new Date().toISOString(), user };
  persist();
}

export function getStoredAnalysis(osuId: string | number): ConsoleAnalysisEntry | null {
  return load()[String(osuId)]?.analysis || null;
}

export function setStoredAnalysis(osuId: string | number, entry: ConsoleAnalysisEntry): void {
  const records = load();
  const key = String(osuId);
  records[key] = records[key] || {};
  records[key].analysis = entry;
  persist();
}
