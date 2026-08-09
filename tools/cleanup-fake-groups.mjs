// One-off maintenance: remove test-fake group entries (99999999xx series)
// from db.groupBotConfig. Run ONLY while Wuxin is stopped.
//
// Usage:
//   node tools/cleanup-fake-groups.mjs --dry-run
//   node tools/cleanup-fake-groups.mjs --apply
//
// DATA_DIR defaults to %APPDATA%\Wuxin (same default as server/store.ts).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = process.env.DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Wuxin');
const dbPath = path.join(dataDir, 'db.json');
const apply = process.argv.includes('--apply');
const dry = !apply;

if (!fs.existsSync(dbPath)) {
  console.error(`db.json not found: ${dbPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(dbPath, 'utf8');
const db = JSON.parse(raw);
const gbc = db.groupBotConfig || {};
const fakeKeys = Object.keys(gbc).filter((k) => /^99999999\d{2}$/.test(String(k)));

if (fakeKeys.length === 0) {
  console.log('no fake groups found; nothing to do');
  process.exit(0);
}

console.log(`fake groups to remove (${fakeKeys.length}): ${fakeKeys.join(', ')}`);

if (dry) {
  console.log('DRY-RUN: no changes written. Re-run with --apply to remove them.');
  process.exit(0);
}

for (const k of fakeKeys) delete gbc[k];
db.groupBotConfig = gbc;

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${dbPath}.bak-fakegroups-${ts}`;
fs.copyFileSync(dbPath, bak);
fs.writeFileSync(`${dbPath}.tmp`, JSON.stringify(db, null, 2), 'utf8');
fs.renameSync(`${dbPath}.tmp`, dbPath);

console.log(`removed ${fakeKeys.length} fake groups; backup written to ${bak}`);
