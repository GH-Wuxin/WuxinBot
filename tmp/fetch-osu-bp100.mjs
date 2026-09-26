// Fetch osu! top-100 best scores (BP100) for a player and save as JSON.
// Credentials are read from .env or the Wuxin DB settings; they are never printed.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const ROOT = 'G:\\QQ-AI-ChatBot';
const USERNAME = process.argv[2] || '[SHK]Wuxin';
const MODE = process.argv[3] || 'osu';
const LIMIT = 100;

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };
const TOKEN_URL = env.OSU_TOKEN_URL || 'https://osu.ppy.sh/oauth/token';
const API_BASE = (env.OSU_API_BASE_URL || 'https://osu.ppy.sh/api/v2').replace(/\/+$/, '');

function readCredentials() {
  const envId = String(env.OSU_CLIENT_ID || '').trim();
  const envSecret = String(env.OSU_CLIENT_SECRET || '').trim();
  if (envId && envSecret) return { id: envId, secret: envSecret, source: 'env' };
  const dbPath = path.join(process.env.APPDATA || '', 'Wuxin', 'db.json');
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (error) {
    console.error('DB_PARSE_FAILED: ' + error.message);
    return null;
  }
  const s = db.settings || {};
  const dbId = String(s.osuClientId || '').trim();
  const dbSecret = String(s.osuClientSecret || '').trim();
  if (dbId && dbSecret) return { id: dbId, secret: dbSecret, source: 'db-settings' };
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(creds) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: /^\d+$/.test(creds.id) ? Number(creds.id) : creds.id,
          client_secret: creds.secret,
          grant_type: 'client_credentials',
          scope: 'public',
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (attempt < 3 && (res.status === 429 || res.status >= 500)) { await sleep(500 * attempt); continue; }
        throw new Error('TOKEN_HTTP_' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
      }
      const data = await res.json();
      if (!data.access_token) throw new Error('TOKEN_RESPONSE_MISSING_ACCESS_TOKEN');
      return data.access_token;
    } catch (error) {
      lastError = error;
      if (attempt >= 3) break;
      await sleep(500 * attempt);
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

let token = '';
async function api(pathname, { retryAuth = true, attempt = 1 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(API_BASE + pathname, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 401 && retryAuth) {
      token = await getToken(CREDS);
      return api(pathname, { retryAuth: false, attempt });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * attempt);
      return api(pathname, { retryAuth: false, attempt: attempt + 1 });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('API_HTTP_' + res.status + ' ' + pathname + (body ? ': ' + body.slice(0, 300) : ''));
    }
    return res.json();
  } finally { clearTimeout(timer); }
}

const CREDS = readCredentials();
if (!CREDS) {
  console.error('MISSING_CREDENTIALS: env OSU_CLIENT_ID/OSU_CLIENT_SECRET not set and DB settings.osuClientId/osuClientSecret empty');
  process.exit(2);
}
console.log('[creds] source=' + CREDS.source + ' client_id_length=' + CREDS.id.length + ' secret_length=' + CREDS.secret.length);

token = await getToken(CREDS);
console.log('[auth] token acquired');

const user = await api('/users/' + encodeURIComponent(USERNAME) + '/' + MODE + '?key=username');
console.log('[user] ' + user.username + ' id=' + user.id + ' pp=' + user.statistics.pp + ' rank=' + (user.statistics.global_rank ?? 'unranked') + ' country=#' + (user.statistics.country_rank ?? '-'));

const scores = await api('/users/' + user.id + '/scores/best?limit=' + LIMIT + '&mode=' + MODE);
console.log('[scores] returned=' + scores.length);

const modCounts = {};
for (const s of scores) {
  const key = (s.mods || []).join('') || 'NM';
  modCounts[key] = (modCounts[key] || 0) + 1;
}
const ppValues = scores.map((s) => Number(s.pp) || 0);
const starValues = scores.map((s) => Number(s.beatmap?.difficulty_rating) || 0);
const accValues = scores.map((s) => Number(s.accuracy) * 100);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const payload = {
  meta: {
    fetchedAt: new Date().toISOString(),
    source: 'osu! API v2',
    endpoint: API_BASE + '/users/' + user.id + '/scores/best?limit=' + LIMIT + '&mode=' + MODE,
    mode: MODE,
    limit: LIMIT,
    order: 'BP1 -> BP' + scores.length + ' (pp descending, as returned by osu!)',
    fetchedBy: 'dsh agent',
  },
  user,
  summary: {
    username: user.username,
    userId: user.id,
    count: scores.length,
    totalPp: Math.round(ppValues.reduce((a, b) => a + b, 0) * 100) / 100,
    topPp: ppValues.length ? Math.max(...ppValues) : 0,
    lowestPp: ppValues.length ? Math.min(...ppValues) : 0,
    avgPp: Math.round(avg(ppValues) * 100) / 100,
    avgStars: Math.round(avg(starValues) * 100) / 100,
    avgAccuracy: Math.round(avg(accValues) * 100) / 100,
    modCounts,
    playerPp: user.statistics.pp,
    globalRank: user.statistics.global_rank ?? null,
    countryRank: user.statistics.country_rank ?? null,
  },
  scores,
};

const stamp = new Date().toISOString().slice(0, 10);
const safeName = USERNAME.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'player';
const outDir = path.join(ROOT, 'tmp');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, safeName + '-bp' + scores.length + '-' + MODE + '-' + stamp + '.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
console.log('[write] ' + outPath + ' (' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB)');
console.log('[top5]');
for (const s of scores.slice(0, 5)) {
  console.log('  ' + s.pp.toFixed(2) + 'pp  ' + (s.beatmapset?.artist || '?') + ' - ' + (s.beatmapset?.title || '?') + ' [' + (s.beatmap?.version || '?') + ']  ' + ((s.mods || []).join('') || 'NM') + '  ' + (s.accuracy * 100).toFixed(2) + '%  ' + (s.beatmap?.difficulty_rating || '?') + 'star');
}
console.log('[mods] ' + JSON.stringify(modCounts));
