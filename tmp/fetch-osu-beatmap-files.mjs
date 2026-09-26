// Fetch the raw .osu files for every beatmap in the BP100 export, byte-verified
// against the osu! API's beatmap checksum (md5 of the .osu file).
// Phase 2 optionally records the official ppy difficulty attributes per exact mod set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';

dns.setDefaultResultOrder('ipv4first');

const ROOT = 'G:\\QQ-AI-ChatBot';
const BP_JSON = path.join(ROOT, 'tmp', 'SHK-Wuxin-bp100-osu-2026-09-20.json');
const OUT_DIR = path.join(ROOT, 'tmp', 'osu-bp100-corpus');
const OSU_DIR = path.join(OUT_DIR, 'osu');
const WITH_ATTRIBUTES = !process.argv.includes('--no-attributes');

fs.mkdirSync(OSU_DIR, { recursive: true });

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
const API_BASE = (env.OSU_API_BASE_URL || 'https://osu.ppy.sh/api/v2').replace(/\/+$/, '');
const TOKEN_URL = env.OSU_TOKEN_URL || 'https://osu.ppy.sh/oauth/token';

function readCredentials() {
  const envId = String(env.OSU_CLIENT_ID || '').trim();
  const envSecret = String(env.OSU_CLIENT_SECRET || '').trim();
  if (envId && envSecret) return { id: envId, secret: envSecret };
  const dbPath = path.join(process.env.APPDATA || '', 'Wuxin', 'db.json');
  if (!fs.existsSync(dbPath)) return null;
  const s = (JSON.parse(fs.readFileSync(dbPath, 'utf8')).settings) || {};
  const id = String(s.osuClientId || '').trim();
  const secret = String(s.osuClientSecret || '').trim();
  return id && secret ? { id, secret } : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return { ok: false, status: res.status }; }
    return { ok: true, status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  } finally { clearTimeout(timer); }
}

const MIRRORS = [
  (id) => 'https://osu.ppy.sh/osu/' + id,
  (id) => 'https://catboy.best/osu/' + id,
  (id) => 'https://osu.direct/api/osu/' + id,
];

async function downloadOsuFile(beatmapId) {
  for (let i = 0; i < MIRRORS.length; i++) {
    const url = MIRRORS[i](beatmapId);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetchText(url);
      if (res.ok) return { url, buffer: res.body };
      if (res.status === 404) break;              // try next mirror
      if (attempt === 2) break;
      await sleep(800 * attempt);
    }
    await sleep(150);
  }
  return null;
}

// ---- load BP export -------------------------------------------------------
const bp = JSON.parse(fs.readFileSync(BP_JSON, 'utf8'));
const maps = new Map();
bp.scores.forEach((s, index) => {
  const id = s.beatmap.id;
  if (!maps.has(id)) {
    maps.set(id, {
      beatmap_id: id,
      beatmapset_id: s.beatmapset.id,
      artist: s.beatmapset.artist,
      title: s.beatmapset.title,
      version: s.beatmap.version,
      creator: s.beatmapset.creator,
      status: s.beatmap.status,
      checksum_md5: s.beatmap.checksum,
      difficulty_rating: s.beatmap.difficulty_rating,
      total_length: s.beatmap.total_length,
      bpm: s.beatmap.bpm,
      cs: s.beatmap.cs, ar: s.beatmap.ar, od: s.beatmap.accuracy, hp: s.beatmap.drain,
      count_circles: s.beatmap.count_circles, count_sliders: s.beatmap.count_sliders, count_spinners: s.beatmap.count_spinners,
      bp_entries: [],
    });
  }
  maps.get(id).bp_entries.push({ bp: index + 1, mods: (s.mods || []).join('') || 'NM', mods_array: s.mods || [], pp: s.pp, accuracy: s.accuracy, score_id: s.id });
});
const list = [...maps.values()];
console.log('[plan] unique beatmaps=' + list.length + ' (from ' + bp.scores.length + ' BP scores)');

// ---- phase 1: .osu files --------------------------------------------------
const results = [];
let ok = 0, cached = 0, failed = 0, mismatch = 0;

for (let i = 0; i < list.length; i++) {
  const m = list[i];
  const filePath = path.join(OSU_DIR, m.beatmap_id + '.osu');
  const record = { beatmap_id: m.beatmap_id, file: 'osu/' + m.beatmap_id + '.osu', expected_md5: m.checksum_md5 };

  let buffer = null;
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    if (md5(existing) === m.checksum_md5) { buffer = existing; record.source = 'cache'; cached++; }
  }
  if (!buffer) {
    const dl = await downloadOsuFile(m.beatmap_id);
    if (dl) { buffer = dl.buffer; record.source = new URL(dl.url).host; }
  }

  if (!buffer) {
    record.error = 'download_failed_all_mirrors';
    record.verified = false;
    failed++;
  } else {
    const text = buffer.toString('utf8');
    record.bytes = buffer.length;
    record.actual_md5 = md5(buffer);
    record.format_ok = /^osu file format v\d+/.test(text);
    record.has_hitobjects = text.includes('[HitObjects]');
    record.verified = record.actual_md5 === m.checksum_md5;
    record.in_game_hitobject_count = (text.split('[HitObjects]')[1] || '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//')).length;
    record.bp_entries = m.bp_entries;
    record.beatmap = {
      beatmapset_id: m.beatmapset_id, artist: m.artist, title: m.title, version: m.version, creator: m.creator,
      status: m.status, difficulty_rating: m.difficulty_rating, total_length: m.total_length, bpm: m.bpm,
      cs: m.cs, ar: m.ar, od: m.od, hp: m.hp,
      count_circles: m.count_circles, count_sliders: m.count_sliders, count_spinners: m.count_spinners,
    };
    if (!record.verified) mismatch++; else ok++;
    if (record.source !== 'cache') fs.writeFileSync(filePath, buffer);
  }
  results.push(record);
  if ((i + 1) % 10 === 0 || i + 1 === list.length) {
    console.log('[osu] ' + (i + 1) + '/' + list.length + '  verified=' + ok + ' cached=' + cached + ' mismatch=' + mismatch + ' failed=' + failed);
  }
  if (record.source !== 'cache') await sleep(120);
}

const manifest = {
  meta: {
    generatedAt: new Date().toISOString(),
    sourceExport: path.basename(BP_JSON),
    player: bp.summary.username,
    playerId: bp.summary.userId,
    uniqueBeatmaps: list.length,
    verification: 'md5 of the downloaded .osu file compared against beatmap.checksum from osu! API v2',
  },
  counts: { verified: ok, fromCache: cached, md5Mismatch: mismatch, failed },
  beatmaps: results,
};
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log('[manifest] written  verified=' + ok + ' cached=' + cached + ' mismatch=' + mismatch + ' failed=' + failed);

// ---- phase 2: official per-mod difficulty attributes ----------------------
if (WITH_ATTRIBUTES) {
  const CREDS = readCredentials();
  if (!CREDS) { console.log('[attrs] skipped: no credentials'); }
  else {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: /^\d+$/.test(CREDS.id) ? Number(CREDS.id) : CREDS.id, client_secret: CREDS.secret, grant_type: 'client_credentials', scope: 'public' }),
    });
    const token = (await tokenRes.json()).access_token;
    if (!token) console.log('[attrs] skipped: no token');
    else {
      const attrRecords = [];
      let aOk = 0, aFail = 0;
      for (const record of results) {
        const m = maps.get(record.beatmap_id);
        const mods = m.bp_entries[0].mods_array;
        const key = record.beatmap_id + ':' + (mods.join('') || 'NM');
        try {
          const res = await fetch(API_BASE + '/beatmaps/' + record.beatmap_id + '/attributes', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ mods, ruleset: 'osu' }),
          });
          if (res.status === 401) { await res.body?.cancel(); token = null; aFail++; attrRecords.push({ key, error: 'unauthorized' }); continue; }
          if (!res.ok) { await res.body?.cancel(); aFail++; attrRecords.push({ key, beatmap_id: record.beatmap_id, mods: mods.join('') || 'NM', error: 'http_' + res.status }); continue; }
          const data = await res.json();
          aOk++;
          attrRecords.push({
            key, beatmap_id: record.beatmap_id, mods: mods.join('') || 'NM', mods_array: mods,
            bp: m.bp_entries[0].bp, pp: m.bp_entries[0].pp,
            attributes: data.attributes,   // official ppy difficulty attributes for this exact mod set
          });
        } catch (error) { aFail++; attrRecords.push({ key, beatmap_id: record.beatmap_id, mods: mods.join('') || 'NM', error: error.message }); }
        await sleep(150);
      }
      fs.writeFileSync(path.join(OUT_DIR, 'mod_difficulty_attributes.json'), JSON.stringify({
        meta: {
          generatedAt: new Date().toISOString(),
          endpoint: 'POST ' + API_BASE + '/beatmaps/{beatmap}/attributes',
          note: 'Official osu! (lazer/ppy) difficulty attributes for the exact mod set of each BP score. Aggregate only: no per-object strains. Not a substitute for the local ppy runtime.',
          ok: aOk, failed: aFail,
        },
        records: attrRecords,
      }, null, 2), 'utf8');
      console.log('[attrs] written  ok=' + aOk + ' failed=' + aFail);
    }
  }
}

console.log('[done] out=' + OUT_DIR);
