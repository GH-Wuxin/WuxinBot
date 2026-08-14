import fs from 'node:fs';
import path from 'node:path';

const API_BASE = process.env.WUXIN_API_BASE || 'http://127.0.0.1:8787';
const DATA_DIR = process.env.DATA_DIR
  || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || 'C:', 'AppData', 'Roaming'), 'Wuxin');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const POLL_MS = 2000;
const TIMEOUT_MS = 12 * 60 * 1000;

const GOLDEN_PLAYERS = [
  { key: 'mrekk', id: 7562902 },
  { key: 'cryshina', id: 14715160 },
  { key: 'oliwakami', id: 3046750 },
  { key: 'wuxin', id: 10000001 },
  { key: 'ben-jiang', id: 7983528 },
  { key: 'nakanooooo', id: 36077706 },
  { key: 'elicyann', id: 900000025 },
  { key: '13451b', id: 0, username: '13451b' },
  { key: 'KiloPlayer', id: 39873822 },
];

// User-provided generalization pool. Names are resolved through the existing
// local osu! search route at run time; they are test inputs only and never
// enter any generation prompt as examples or special cases.
const PROVIDED_PLAYERS = [
  { key: 'akari-date', id: 0, username: 'Juliet Player' },
  { key: 'windpipeey', id: 0, username: 'windpipeey' },
  { key: 'shk-mriyu', id: 0, username: '[TST]Golf' },
  { key: 'maliszewski', id: 0, username: 'MALISZEWSKI' },
  { key: 'junmoyan', id: 0, username: 'Junmoyan' },
  { key: 'miko-parsley', id: 0, username: 'Miko_Parsley' },
  { key: 'qqfrr', id: 0, username: 'qqfrr' },
  { key: 'lolol233', id: 0, username: 'lolol233' },
];

function argValue(name, fallback = '') {
  const exact = process.argv.find((value) => value.startsWith(`--${name}=`));
  return exact ? exact.slice(name.length + 3) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`HTTP ${response.status} returned invalid JSON: ${text.slice(0, 160)}`); }
}

async function resolvePlayerId(player) {
  if (player.id > 0) return player.id;
  const response = await fetch(`${API_BASE}/api/osu/search?name=${encodeURIComponent(player.username)}`);
  const body = await readJsonResponse(response);
  if (!response.ok || !body.ok) throw new Error(`Unable to resolve ${player.username}: ${body.error || response.status}`);
  const candidate = body.player;
  const id = Number(candidate?.id || 0);
  if (!id) throw new Error(`No osu! user id returned for ${player.username}`);
  return id;
}

async function getStoredAnalysis(id) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}/api/osu/player/${id}/analyze`);
      const body = await readJsonResponse(response);
      if (!response.ok || !body.ok) throw new Error(body.error || `GET analyze HTTP ${response.status}`);
      return body.analysis || null;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await delay(attempt * 500);
    }
  }
  throw lastError;
}

async function startAnalysis(id) {
  const response = await fetch(`${API_BASE}/api/osu/player/${id}/analyze`, { method: 'POST' });
  const body = await readJsonResponse(response);
  if (!response.ok || !body.ok) throw new Error(body.error || `POST analyze HTTP ${response.status}`);
  return body;
}

async function waitForCompletion(id, previousAt) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const analysis = await getStoredAnalysis(id);
    const isNewRun = analysis?.at && analysis.at !== previousAt;
    if (isNewRun && analysis.status === 'done') return analysis;
    if (isNewRun && analysis.status === 'error') throw new Error(analysis.error || 'Analyze failed');
    await delay(POLL_MS);
  }
  throw new Error(`Analyze timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes`);
}

function readLatestRun(id, startedAt) {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const entries = Array.isArray(db.osuAnalyses) ? db.osuAnalyses : [];
  return [...entries].reverse().find((entry) => (
    Number(entry?.osuUserId || 0) === Number(id)
    && String(entry?.analysisType || 'full') === 'full'
    && (!startedAt || new Date(entry?.createdAt || 0).getTime() >= new Date(startedAt).getTime() - 2000)
  )) || null;
}

function publicRunMetadata(entry) {
  if (!entry) return null;
  return {
    target: entry.target,
    displayName: entry.displayName,
    osuUserId: entry.osuUserId,
    createdAt: entry.createdAt,
    analysisModel: entry.analysisModel,
    formatVersion: entry.formatVersion,
    conclusionSource: entry.conclusionSource,
    conclusionValidationReasons: entry.conclusionValidationReasons || [],
    sectionCommentsSource: entry.sectionCommentsSource,
    sectionCommentSources: entry.sectionCommentSources || null,
    sectionCommentsValidationReasons: entry.sectionCommentsValidationReasons || [],
    generationTrace: entry.generationTrace || null,
    reviewLog: entry.reviewLog || [],
    bestCount: entry.bestCount,
    recentCount: entry.recentCount,
    hasPPlus: Boolean(entry.ppBars),
    errors: entry.errors || [],
  };
}

const label = argValue('label', 'run');
const playerSet = argValue('set', 'golden').trim().toLocaleLowerCase();
const availablePlayers = playerSet === 'provided'
  ? PROVIDED_PLAYERS
  : playerSet === 'all'
    ? [...GOLDEN_PLAYERS, ...PROVIDED_PLAYERS]
    : GOLDEN_PLAYERS;
const selected = argValue('players', '')
  .split(',')
  .map((value) => value.trim().toLocaleLowerCase())
  .filter(Boolean);
const players = selected.length > 0
  ? availablePlayers.filter((player) => selected.includes(player.key.toLocaleLowerCase()))
  : availablePlayers;
if (players.length === 0) throw new Error('No matching players selected');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.resolve(argValue('out', path.join('artifacts', 'osu-analyze-evals', `${stamp}-${label}`)));
fs.mkdirSync(outputDir, { recursive: true });

const manifest = {
  label,
  playerSet,
  startedAt: new Date().toISOString(),
  apiBase: API_BASE,
  players: [],
};

for (const player of players) {
  const id = await resolvePlayerId(player);
  const before = await getStoredAnalysis(id);
  process.stdout.write(`[eval] ${player.key} (${id}) starting\n`);
  const started = await startAnalysis(id);
  const startedAt = started.analysis?.at || new Date().toISOString();
  const completed = await waitForCompletion(id, before?.at || '');
  const persisted = readLatestRun(id, startedAt);
  const outputName = `${String(manifest.players.length + 1).padStart(2, '0')}-${player.key}.txt`;
  fs.writeFileSync(path.join(outputDir, outputName), String(completed.text || ''), 'utf8');
  const item = {
    key: player.key,
    id,
    startedAt,
    finishedAt: completed.finishedAt,
    outputFile: outputName,
    metadata: publicRunMetadata(persisted),
  };
  manifest.players.push(item);
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  process.stdout.write(`[eval] ${player.key} done; source=${item.metadata?.conclusionSource || 'unknown'} reviewRounds=${item.metadata?.reviewLog?.length || 0}\n`);
}

manifest.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
process.stdout.write(`[eval] complete: ${outputDir}\n`);
