// One-time binding import (M2): merge 雨沐/消防栓/LazyBot bindings into
// Wuxin osuBindings. 猫猫's users_osu overlaps 雨沐 entirely and is skipped.
// Old tables stay read-only. Run with Wuxin stopped.
//
// Usage: tsx tools/bindings-import.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStore, updateDb, readDb } from '../server/store.ts';

const BOTS_ROOT = 'REDACTED_BOTS_ROOT';
const PSQL = path.join(BOTS_ROOT, 'runtime/postgresql-16.10/pgsql/bin/psql.exe');
const MYSQL = path.join(BOTS_ROOT, 'runtime/mariadb-11.4.12-winx64/bin/mysql.exe');
const YUMU_CFG = path.join(BOTS_ROOT, 'configs/private/yumu/application.yaml');
const LAZY_CFG = path.join(BOTS_ROOT, 'configs/private/lazybot/application.yaml');
const HYDRANT_CFG = path.join(BOTS_ROOT, 'configs/private/hydrant/appsettings.json');

function yamlBlock(text, header) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return '';
  const block = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && /^\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function yamlValue(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\r\n]+)["']?\\s*$`, 'm').exec(text);
  return match ? match[1].trim() : '';
}

function parsePgJdbc(url) {
  const m = /jdbc:postgresql:\/\/([^:]+):(\d+)\/(\w+)/.exec(url);
  return m ? { host: m[1], port: m[2], db: m[3] } : null;
}

function parseMySqlJdbc(url) {
  const m = /jdbc:mysql:\/\/([^:]+):(\d+)\/(\w+)/.exec(url);
  return m ? { host: m[1], port: m[2], db: m[3] } : null;
}

function parseNpgsqlCs(cs) {
  const get = (key) => {
    const m = new RegExp(`(?:^|;)${key}\\s*=\\s*([^;]+)`, 'i').exec(String(cs || ''));
    return m ? m[1].trim() : '';
  };
  return {
    host: get('Server') || get('Host') || '127.0.0.1',
    port: get('Port') || '5432',
    db: get('Database'),
    user: get('User Id') || get('Username') || get('UserID'),
    password: get('Password'),
  };
}

function runPsql(env, sql) {
  const tmp = path.join(os.tmpdir(), `wuxin-bind-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.sql`);
  fs.writeFileSync(tmp, sql, 'utf8');
  try {
    const out = execFileSync(PSQL, ['-h', env.host, '-p', env.port, '-U', env.user, '-d', env.db, '-t', '-A', '-F', '\t', '-f', tmp], {
      env: { ...process.env, PGPASSWORD: env.password },
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
  }
}

function runMySql(env, sql) {
  const out = execFileSync(MYSQL, ['-h', env.host, '-P', env.port, '-u', env.user, '-D', env.db, '-N', '-e', sql], {
    env: { ...process.env, MYSQL_PWD: env.password },
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// ── Read sources ──

const yumuYaml = fs.readFileSync(YUMU_CFG, 'utf8');
const yumuDs = yamlBlock(yumuYaml, 'datasource:');
const yumuUrl = yamlValue(yumuDs, 'url');
const yumuPg = parsePgJdbc(yumuUrl);
if (!yumuPg) throw new Error('无法解析雨沐 datasource');
const yumuEnv = { ...yumuPg, user: yumuPg.db, password: yamlValue(yumuDs, 'password') };

const yumuRows = runPsql(yumuEnv, 'SELECT q.qq, u.osu_id, u.osu_name FROM osu_bind_qq q JOIN osu_bind_user u ON u.id = q.osu_user_id ORDER BY q.qq;');
const yumuBindings = new Map();
for (const row of yumuRows) {
  const [qq, osuId, osuName] = row.split('\t');
  yumuBindings.set(String(qq), { id: Number(osuId), username: String(osuName || '').trim() });
}
console.log(`[yumu] ${yumuBindings.size} bindings`);

const hydrantJson = JSON.parse(fs.readFileSync(HYDRANT_CFG, 'utf8'));
const hydrantUrl = hydrantJson.ConnectionStrings?.NewbieDatabase_Postgres || '';
const hydrantEnv = parseNpgsqlCs(hydrantUrl);
if (!hydrantEnv.db || !hydrantEnv.user) throw new Error('无法解析消防栓 datasource');

const hydrantRows = runPsql(hydrantEnv, 'SELECT "UserId", "OsuId" FROM "Bindings" ORDER BY "UserId";');
const hydrantBindings = new Map();
for (const row of hydrantRows) {
  const [qq, osuId] = row.split('\t');
  if (qq && osuId) hydrantBindings.set(String(qq), { id: Number(osuId), username: '' });
}
console.log(`[hydrant] ${hydrantBindings.size} bindings`);

const lazyYaml = fs.readFileSync(LAZY_CFG, 'utf8');
const lazyDs = yamlBlock(lazyYaml, 'datasource:');
const lazyUrl = yamlValue(lazyDs, 'url');
const lazyMy = parseMySqlJdbc(lazyUrl);
if (!lazyMy) throw new Error('无法解析 LazyBot datasource');
const lazyEnv = { ...lazyMy, user: 'lazybot', password: yamlValue(lazyDs, 'password') };

const lazyRows = runMySql(lazyEnv, 'SELECT qq_code, player_id, player_name FROM token WHERE valid = 1 ORDER BY qq_code;');
const lazyBindings = new Map();
for (const row of lazyRows) {
  const [qq, playerId, playerName] = row.split('\t');
  if (qq && playerId) lazyBindings.set(String(qq), { id: Number(playerId), username: String(playerName || '').trim() });
}
console.log(`[lazybot] ${lazyBindings.size} bindings`);

// ── Merge (priority: 雨沐 > Wuxin 现有 > 消防栓 > LazyBot) ──

ensureStore();
const existing = readDb().osuBindings || {};
const merged = new Map();
const conflictLog = [];

function addBinding(qq, entry, source) {
  const current = merged.get(qq);
  if (!current) {
    merged.set(qq, { ...entry });
    return;
  }
  if (current.id && entry.id && current.id !== entry.id) {
    conflictLog.push(`QQ ${qq}: ${source}(${entry.id}) != ${current.id}`);
  }
  if (!current.username && entry.username) {
    current.username = entry.username;
  }
}

function normalizeExisting(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return { id: value, username: '' };
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    return /^\d+$/.test(text) ? { id: Number(text), username: '' } : { id: 0, username: text };
  }
  if (value && typeof value === 'object') {
    const id = Number(value.osuUserId ?? value.userId ?? value.id ?? 0);
    return {
      id: Number.isFinite(id) && id > 0 ? id : 0,
      username: String(value.osuUsername ?? value.username ?? '').trim(),
    };
  }
  return { id: 0, username: '' };
}

for (const [qq, entry] of yumuBindings) addBinding(qq, entry, 'yumu');
for (const [qq, value] of Object.entries(existing)) addBinding(qq, normalizeExisting(value), 'wuxin');
for (const [qq, entry] of hydrantBindings) addBinding(qq, entry, 'hydrant');
for (const [qq, entry] of lazyBindings) addBinding(qq, entry, 'lazybot');

console.log(`[merge] ${merged.size} unique QQs, ${conflictLog.length} conflicts`);
for (const line of conflictLog) console.log('  CONFLICT', line);

// ── Resolve missing usernames via osu API ──

const { getUserById } = await import('../server/osu/api.ts');

let resolved = 0;
let failed = 0;
for (const [qq, entry] of merged) {
  if (!entry.id || entry.username) continue;
  try {
    const user = await getUserById(Number(entry.id));
    const name = String(user?.username || '').trim();
    if (name) {
      entry.username = name;
      resolved++;
      console.log(`  resolve ${qq} (${entry.id}) -> ${name}`);
      await new Promise((r) => setTimeout(r, 250));
    } else {
      failed++;
    }
  } catch (error) {
    failed++;
    console.error(`  resolve ${qq} (${entry.id}) 失败: ${String(error?.message || error)}`);
  }
}
console.log(`[resolve] usernames: ${resolved} resolved, ${failed} missing/failed`);

// ── Write ──

const normalized = {};
for (const [qq, entry] of merged) {
  normalized[qq] = entry.id ? { id: entry.id, username: entry.username } : { username: entry.username };
}

updateDb((draft) => {
  draft.osuBindings = normalized;
});

const report = {
  importedAt: new Date().toISOString(),
  counts: { yumu: yumuBindings.size, hydrant: hydrantBindings.size, lazybot: lazyBindings.size, existing: Object.keys(existing).length, merged: merged.size, resolved, failed },
  conflicts: conflictLog,
};
const reportPath = path.join(BOTS_ROOT, 'logs', `bindings-import-${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(`[report] ${reportPath}`);
console.log(`[done] osuBindings now ${Object.keys(normalized).length} entries`);
