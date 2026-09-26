// Compare failed broad-suite checks against an explicitly supplied pre-fix checkout.
// Each verifier retains its own isolated DATA_DIR; no test expectations are changed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv[2];
if (!baseline || path.resolve(baseline) === root) throw new Error('Pass a separate pre-fix checkout');
const files = [
  'agent-tool-surface-hardening-cross-run', 'bp-range-route', 'bp-type-analysis-guard',
  'db-consistency', 'experience', 'external-exposure', 'kb', 'match-listener-race',
  'natural-chat-delivery', 'onebot', 'osu-fixture', 'processIncoming-deterministic-route',
  'profile-log', 'prompt-review-slim-p1b', 'quick-bridge-qb07-shadow-refetch',
  'reasoning-wire', 'rewrite-telemetry-analyze', 'search-routing',
];
const rows = [];
for (const name of files) {
  const run = cwd => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', `tools/${name}-verify.mjs`], { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 });
    const output = String(result.stdout || '') + String(result.stderr || '');
    return { status: result.status, error: result.error?.code, findings: output.split(/\r?\n/).filter(line => /FAIL|AssertionError|Error:|actual:|expected:|Missing|not found/i.test(line)).slice(-8) };
  };
  const before = run(baseline), after = run(root);
  const row = { name, classification: after.status === 0 ? 'PASS_ON_RECHECK' : before.status === 0 ? 'NEW_FAILURE' : 'FAILS_ON_BOTH', before, after };
  rows.push(row); console.log(JSON.stringify(row));
}
console.log('SUMMARY ' + JSON.stringify(rows.map(({ name, classification }) => ({ name, classification }))));
if (rows.some(row => row.classification === 'NEW_FAILURE')) process.exitCode = 1;
