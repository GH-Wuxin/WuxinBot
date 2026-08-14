// Per-beatmap osu!oracle classification cache. Beatmap types are stable, so
// once a map is classified the result can be reused across players and days,
// which makes repeated BP type queries answer without spawning Python at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = process.env.ORACLE_CACHE_FILE
  || path.resolve(__dirname, '..', '..', 'data', 'oracle-cache.json');
const CACHE_TTL_MS = 30 * 24 * 3600_000;

interface MapClassification {
  probs: Record<string, number>;
  at: string;
}

const cache = new Map<string, MapClassification>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      for (const [id, entry] of Object.entries((raw as { maps?: Record<string, MapClassification> }).maps || {})) {
        cache.set(String(id), entry);
      }
    }
  } catch {
    // A corrupt cache is safe to ignore; it will be rebuilt.
  }
}

export function getCachedClassifications(ids: (string | number)[]): Map<string, Record<string, number>> {
  ensureLoaded();
  const now = Date.now();
  const hits = new Map<string, Record<string, number>>();
  for (const id of ids) {
    const key = String(id);
    const entry = cache.get(key);
    if (entry && now - new Date(entry.at).getTime() < CACHE_TTL_MS) {
      hits.set(key, entry.probs);
    }
  }
  return hits;
}

export function saveClassifications(entries: Record<string, Record<string, number>>): void {
  ensureLoaded();
  const now = new Date().toISOString();
  for (const [id, probs] of Object.entries(entries)) {
    cache.set(String(id), { probs, at: now });
  }
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: now, maps: Object.fromEntries(cache) }), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // Cache persistence is best-effort; in-memory results still work.
  }
}
