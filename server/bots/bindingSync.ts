// Unified-binding sync: /w osu bind writes Wuxin's osuBindings (db.json) AND
// mirrors the binding into the original LazyBot's MariaDB `token` table.
// LazyBot's /ppp (and friends) require a token row for the sender QQ even when
// a player name is supplied, so without this sync every newly bound user still
// gets "请先使用/link" from LazyBot.
//
// Uses the bundled MariaDB CLI (same approach as tools/bindings-import.mjs),
// so no new npm dependency is needed. Failures are non-fatal: the primary
// Wuxin binding stays authoritative and errors are only logged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BOTS_ROOT = 'REDACTED_BOTS_ROOT';
const MYSQL = path.join(BOTS_ROOT, 'runtime/mariadb-11.4.12-winx64/bin/mysql.exe');
const LAZY_CFG = path.join(BOTS_ROOT, 'configs/private/lazybot/application.yaml');
const LAZY_DB = 'lazybot';

export interface BindingSyncResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

function yamlBlock(text: string, header: string): string {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return '';
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && /^\S/.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

function yamlValue(text: string, key: string): string {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\r\n]+)["']?\\s*$`, 'm').exec(text);
  return match ? match[1].trim() : '';
}

function parseMySqlJdbc(url: string): { host: string; port: string; db: string } | null {
  const m = /jdbc:mysql:\/\/([^:]+):(\d+)\/(\w+)/.exec(url);
  return m ? { host: m[1], port: m[2], db: m[3] } : null;
}

function lazyEnv(): { host: string; port: string; user: string; password: string } | null {
  try {
    if (!fs.existsSync(MYSQL) || !fs.existsSync(LAZY_CFG)) return null;
    const yaml = fs.readFileSync(LAZY_CFG, 'utf8');
    const ds = yamlBlock(yaml, 'datasource:');
    const url = yamlValue(ds, 'url');
    const parsed = parseMySqlJdbc(url);
    if (!parsed) return null;
    return {
      host: parsed.host,
      port: parsed.port,
      user: yamlValue(ds, 'username') || 'lazybot',
      password: yamlValue(ds, 'password'),
    };
  } catch {
    return null;
  }
}

function runMySql(sql: string): string[] {
  const env = lazyEnv();
  if (!env) throw new Error('LazyBot MariaDB 配置不可用');
  const out = execFileSync(
    MYSQL,
    ['-h', env.host, '-P', env.port, '-u', env.user, '-D', LAZY_DB, '-N', '-e', sql],
    { env: { ...process.env, MYSQL_PWD: env.password }, encoding: 'utf8', windowsHide: true },
  );
  return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sqlEscape(value: string): string {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Mirror a Wuxin osu binding into LazyBot's token table (upsert by qq_code).
 * Preserves LazyBot-only fields (access_token, avatar_url, preferred panel...).
 */
export function syncLazybotBinding(
  qq: string | number,
  binding: { id?: number; username?: string },
): BindingSyncResult {
  const qqCode = String(qq ?? '').trim();
  const playerId = Number(binding?.id ?? 0);
  if (!/^\d+$/.test(qqCode) || !Number.isFinite(playerId) || playerId <= 0) {
    return { ok: false, skipped: true, error: '无效绑定参数' };
  }
  try {
    const existing = runMySql(`SELECT id FROM token WHERE qq_code = ${qqCode} LIMIT 1;`);
    const playerName = sqlEscape(String(binding.username || '').trim());
    if (existing.length > 0) {
      runMySql(
        `UPDATE token SET player_id = ${playerId}, player_name = '${playerName}', valid = 1 ` +
        `WHERE qq_code = ${qqCode};`,
      );
    } else {
      runMySql(
        `INSERT INTO token (qq_code, player_id, player_name, valid, default_mode) ` +
        `VALUES (${qqCode}, ${playerId}, '${playerName}', 1, 'osu');`,
      );
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** Remove a Wuxin osu binding from LazyBot's token table. */
export function removeLazybotBinding(qq: string | number): BindingSyncResult {
  const qqCode = String(qq ?? '').trim();
  if (!/^\d+$/.test(qqCode)) {
    return { ok: false, skipped: true, error: '无效 QQ' };
  }
  try {
    runMySql(`DELETE FROM token WHERE qq_code = ${qqCode};`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
