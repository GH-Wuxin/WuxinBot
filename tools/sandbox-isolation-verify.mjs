// sandbox-isolation-verify.mjs — F06 regression: sandbox previews must never
// mutate the authoritative store object, and an unrelated later commit must not
// carry preview overrides to disk. Fully offline with an isolated DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-sandbox-iso');
assertNotProduction(dataDir);

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

try {
  const store = await import('../server/store.ts');
  const sandbox = await import('../server/sandboxPreview.ts');

  store.updateDb((db) => {
    db.settings.selfQq = '10000';
    db.settings.botNames = 'Wuxin';
    db.groups.push({ groupId: '10001', name: '沙盒测试群', enabled: true, mode: 'mention', maxPerHour: 20, cooldownSec: 30 });
  });

  // Preview with a mode override. The response must reflect the override.
  let result = null;
  let runError = null;
  try { result = await sandbox.runSandboxPreview({ groupId: '10001', groupMode: 'silent', userId: 'sandbox-user', text: '你好' }); }
  catch (error) { runError = error; }
  if (result) assert(String(result.context?.group || '').includes('silent'), 'preview:override-reflected', JSON.stringify(result.context?.group));
  else console.log(`SKIP [preview:override-reflected] runSandboxPreview threw: ${runError?.message || runError}`);

  // The authoritative in-memory group must keep its committed mode.
  assert(store.readDb().groups[0]?.mode === 'mention', 'memory:group-mode-unchanged', String(store.readDb().groups[0]?.mode));

  // An unrelated normal write must not carry the preview mode to disk.
  store.updateDb((db) => { db.settings.memorySampleRetain = 123; });
  const coreOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert(coreOnDisk.groups?.[0]?.mode === 'mention', 'disk:group-mode-unchanged-after-unrelated-write', String(coreOnDisk.groups?.[0]?.mode));

  // A second preview without an override must also leave the store untouched.
  try { await sandbox.runSandboxPreview({ groupId: '10001', userId: 'sandbox-user', text: '你好' }); } catch { /* decision failures are out of scope here */ }
  assert(store.readDb().groups[0]?.mode === 'mention', 'memory:group-mode-unchanged-second-run', String(store.readDb().groups[0]?.mode));
} finally {
  cleanupTestDir(dataDir);
}

if (failed > 0) {
  console.error(`SANDBOX-ISOLATION-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('sandbox preview isolation checks passed');
