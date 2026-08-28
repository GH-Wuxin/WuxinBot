// Random-ten generalization test: runs Analyze for arbitrary bound players.
// Usage: node --import tsx tools/osu-analyze-random-ten.mjs --players=<id,id,...> --label=<label>
import fs from 'node:fs';
import path from 'node:path';
import { readDb } from '../server/store.ts';

const API_BASE = process.env.OSU_ANALYZE_API_BASE || 'http://127.0.0.1:8787';
const TIMEOUT_MS = 12 * 60 * 1000;
function readLatestRun(id, startedAt) {
  const db = readDb();
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

function argValue(name, fallback = '') {
  const match = process.argv.find((item) => item.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

async function postAnalyze(osuId) {
  const res = await fetch(`${API_BASE}/api/osu/player/${osuId}/analyze`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST ${osuId}: HTTP ${res.status}`);
  return res.json();
}

async function getAnalyze(osuId) {
  const res = await fetch(`${API_BASE}/api/osu/player/${osuId}/analyze`);
  if (!res.ok) throw new Error(`GET ${osuId}: HTTP ${res.status}`);
  return res.json();
}

async function waitForResult(osuId) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { analysis } = await getAnalyze(osuId);
    if (analysis?.status === 'done') return analysis;
    if (analysis?.status === 'error') throw new Error(`analyze error: ${analysis.error || 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`timeout after ${TIMEOUT_MS / 1000}s`);
}

const label = argValue('label', 'random-ten');
const players = argValue('players', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((id) => ({ id: Number(id), osuId: Number(id) }));
if (players.length === 0) throw new Error('--players=<id,id,...> required');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = path.resolve(argValue('out', path.join('artifacts', 'osu-analyze-evals', `${stamp}-${label}`)));
fs.mkdirSync(outputDir, { recursive: true });

const manifest = {
  label,
  playerSet: 'random-bound-ten',
  startedAt: new Date().toISOString(),
  apiBase: API_BASE,
  players: [],
};

for (const player of players) {
  const startedAt = new Date().toISOString();
  console.log(`[eval] ${player.id} starting`);
  const entry = {
    key: String(player.id),
    id: player.id,
    startedAt,
  };
  try {
    const post = await postAnalyze(player.id);
    if (!post.started) {
      // already running from a previous call: just wait for it
      console.log(`[eval] ${player.id} already running, waiting`);
    }
    const analysis = await waitForResult(player.id);
    const outputFile = `${String(manifest.players.length + 1).padStart(2, '0')}-${player.id}.txt`;
    fs.writeFileSync(path.join(outputDir, outputFile), String(analysis.text || ''), 'utf8');
    entry.outputFile = outputFile;
    entry.finishedAt = new Date().toISOString();
    entry.metadata = publicRunMetadata(readLatestRun(player.id, startedAt));
    console.log(`[eval] ${player.id} done; source=${entry.metadata?.conclusionSource || 'unknown'}`);
  } catch (error) {
    entry.error = String(error?.message || error);
    entry.finishedAt = new Date().toISOString();
    console.error(`[eval] ${player.id} FAILED: ${entry.error}`);
  }
  manifest.players.push(entry);
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`[eval] complete: ${outputDir}`);
