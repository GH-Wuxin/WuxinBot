// kb-calibrate.mjs — prints raw BM25 top scores for route scenarios.
//
// Used to calibrate `retrievalConfig` thresholds in tools/kb-build.mjs.
//   npx tsx tools/kb-calibrate.mjs [--ids s015,s025,...]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = (process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1]?.split(',').filter(Boolean) || [];

const testDataDir = createTestDataDir('wuxin-kb-cal');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const build = spawnSync('npx.cmd', ['tsx', 'tools/kb-build.mjs', '--data-dir', testDataDir], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
});
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  cleanupTestDir(testDataDir);
  process.exit(1);
}

const { kbRawSearch } = await import('../server/bot/knowledgeBase.ts');
const { routeForText } = await import('../server/bot/kbRoute.ts');
const { routeCollections } = await import('../server/bot/kbPrompt.ts');
const scenarios = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'kb-scenarios.json'), 'utf8'));
const selected = scenarios.filter((s) => !ids.length || ids.includes(s.id));

for (const s of selected) {
  const route = routeForText(s.scene, s.text);
  const plans = routeCollections(route);
  if (plans.length === 0) continue;
  console.log(`\n[${s.id}] ${s.text}  -> ${route.kind}`);
  for (const plan of plans) {
    const top = kbRawSearch(plan.collection, s.text, 6);
    console.log(`  ${plan.collection}: ${top.map((t) => `${t.documentId}=${t.score}`).join(' | ')}`);
  }
}

cleanupTestDir(testDataDir);
