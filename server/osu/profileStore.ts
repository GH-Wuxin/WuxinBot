// Console player-profile snapshots: a small JSON store next to the runtime
// data so the GUI can show "fetched at" and refresh without hammering the
// osu! API. Analysis results for the console drawer are kept here too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(__dirname, '..', '..', 'data', 'osu-console-profiles.json');

export interface ConsoleAnalysisEntry {
  status: 'idle' | 'running' | 'done' | 'error';
  at?: string;
  finishedAt?: string;
  text?: string;
  error?: string;
}

interface PlayerRecord {
  profile?: { fetchedAt: string; user: any };
  analysis?: ConsoleAnalysisEntry;
}

let cache: Record<string, PlayerRecord> | null = null;

function load(): Record<string, PlayerRecord> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH);
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
