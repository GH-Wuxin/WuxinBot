// run-all-verifies.mjs — run every tools/*-verify.mjs in one pass.
// Usage: npm run verify-all
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = path.join(root, 'tools');
const files = fs.readdirSync(toolsDir)
  .filter((name) => name.endsWith('-verify.mjs'))
  .filter((name) => !['test-isolation.mjs', 'store-concurrency-worker.mjs'].includes(name))
  .sort();

let passed = 0;
const failures = [];
const startedAt = Date.now();

for (const file of files) {
  const result = spawnSync('npx.cmd', ['tsx', path.join(toolsDir, file)], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    timeout: 15 * 60_000,
  });
  const ok = result.status === 0 && !result.error;
  if (ok) {
    passed++;
    console.log(`PASS ${file}`);
  } else {
    failures.push(file + (result.error ? ` (${result.error.message})` : ` (exit ${result.status})`));
    console.log(`FAIL ${file}`);
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n${passed}/${files.length} passed in ${seconds}s`);
if (failures.length) {
  console.log('Failures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
