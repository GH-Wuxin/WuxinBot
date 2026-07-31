// oracle-cache-verify.mjs — per-beatmap classification cache behaviour:
// cached maps never spawn the classifier again, merge works, errors surface.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-oracle-')), 'oracle-cache.json');
process.env.ORACLE_CACHE_FILE = cacheFile;

const { classifyBeatmaps } = await import('../server/osu/classifier.ts');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

// Test 1: uncached ids go to the runner, results persisted
{
  const calls = [];
  const result = await classifyBeatmaps(['100', '200'], async (ids) => {
    calls.push([...ids]);
    return { 100: { aim: 0.8, stream: 0.1, tech: 0.05, alt: 0.05 }, 200: { stream: 0.7, aim: 0.2, tech: 0.05, alt: 0.05 } };
  });
  assert(calls.length === 1 && calls[0].join(',') === '100,200', `runner must see uncached ids, got ${JSON.stringify(calls)}`);
  assert(result.totalClassified === 2, 'both maps must be classified');
  assert(result.details['100']?.aim > 0.7, 'details must carry probabilities');
  assert(fs.existsSync(cacheFile), 'cache file must be written');
  passed++;
}

// Test 2: cached ids skip the runner; only new ids are sent
{
  const calls = [];
  const result = await classifyBeatmaps(['100', '300'], async (ids) => {
    calls.push([...ids]);
    return { 300: { tech: 0.9, aim: 0.05, stream: 0.03, alt: 0.02 } };
  });
  assert(calls.length === 1 && calls[0].join(',') === '300', `only uncached id must reach runner, got ${JSON.stringify(calls)}`);
  assert(result.totalClassified === 2, 'cached + fresh must merge');
  assert(result.details['100']?.aim > 0.7, 'cached details must be reused');
  passed++;
}

// Test 3: all cached → runner never called
{
  let called = false;
  const result = await classifyBeatmaps(['100', '300'], async () => {
    called = true;
    return {};
  });
  assert(!called, 'runner must not be called when everything is cached');
  assert(result.totalClassified === 2, 'fully cached request must still return distribution');
  passed++;
}

// Test 4: runner failure surfaces as error while cached maps still return
{
  const result = await classifyBeatmaps(['100', '999'], async () => {
    throw new Error('python exploded');
  });
  assert(result.totalClassified === 1, 'cached map must survive a runner failure');
  assert(result.errors.some((e) => e.includes('python exploded')), `failure must be visible: ${result.errors}`);
  passed++;
}

fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });

console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('ORACLE-CACHE-VERIFY FAILED');
  process.exit(1);
}
console.log('ORACLE-CACHE-VERIFY PASSED');
process.exit(0);
