// One-click group migration: `on` disables the original bots for a group
// (services stay running, bridge unaffected) and enables the Wuxin quick
// router; `off` restores the original bots and disables the quick router.
// Usage: tsx tools/group-migration.mjs <groupId> <on|off>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = 'http://127.0.0.1:8787';
const BOTS = ['yumu', 'kanon', 'hydrant', 'lazybot'];
const SHARED_CONFIG = '<BOTS_ROOT>/configs/group-bot-config.json';

const groupId = process.argv[2];
const mode = process.argv[3];
if (!groupId || !['on', 'off'].includes(mode || '')) {
  console.error('usage: group-migration.mjs <groupId> <on|off>');
  process.exit(1);
}

async function api(pathname, options = {}) {
  const res = await fetch(API + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Backup ──
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupDir = path.join(os.tmpdir(), `wuxin-migrate-${groupId}-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
const dbPath = path.join(process.env.APPDATA || '', 'Wuxin', 'db.json');
if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, path.join(backupDir, 'db.json'));
if (fs.existsSync(SHARED_CONFIG)) fs.copyFileSync(SHARED_CONFIG, path.join(backupDir, 'group-bot-config.json'));
console.log(`[backup] ${backupDir}`);

// ── Apply ──
const botsEnabled = mode === 'off'; // restore original bots when off
const quickEnabled = mode === 'on'; // quick router on when migrating
for (const botId of BOTS) {
  await api('/api/group-bot-config', {
    method: 'POST',
    body: { groupId, botId, enabled: botsEnabled },
  });
  console.log(`[config] ${groupId} ${botId}=${botsEnabled}`);
}
await api('/api/osu/quick', {
  method: 'POST',
  body: { groupId, enabled: quickEnabled },
});
console.log(`[config] ${groupId} quick=${quickEnabled}`);

// ── Verify ──
const status = await api('/api/osu/status');
const group = status.groups.find((g) => String(g.groupId) === String(groupId));
const botConfig = await api('/api/group-bot-config');
const dbGroup = botConfig.config[String(groupId)] || {};
const shared = JSON.parse(fs.readFileSync(SHARED_CONFIG, 'utf8'));
const sharedGroup = shared[String(groupId)] || {};

console.log('\n=== 校验清单 ===');
console.log(`群: ${group?.name || groupId} (${groupId}) | 群启用: ${group?.enabled}`);
console.log(`quick 路由: ${group?.quick}`);
for (const botId of BOTS) {
  const dbValue = dbGroup[botId] ?? '?';
  console.log(`原 bot ${botId}: db=${dbValue} shared=${sharedGroup[botId]}`);
}
console.log(`共享配置一致性: ${Object.entries(sharedGroup).filter(([k]) => BOTS.includes(k)).every(([k, v]) => v === botsEnabled) ? 'OK' : 'MISMATCH'}`);
