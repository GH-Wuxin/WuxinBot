// skill-profiler-cache-verify.mjs — Profiler adapter contract checks (findings
// F09/F10/F11 + batch identity §6.2). Runs the real adapter functions against a
// stubbed loopback workbench with an isolated DATA_DIR. No network access.
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-profiler-cache');
assertNotProduction(dataDir);

let failed = 0;
function assert(condition, label, detail = '') {
  if (condition) console.log(`PASS [${label}]`);
  else {
    console.error(`FAIL [${label}] ${detail}`);
    failed++;
  }
}

// ── Stub workbench ──────────────────────────────────────────────────────────
let calibrationId = 'CAL-A';
let analyzeCalls = 0;
let analyzeIdentityOverride = null; // force a self-reported identity mismatch
let unifiedValue = 8;
const realFetch = globalThis.fetch;
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = (async (url, options = {}) => {
  const parsed = new URL(String(url));
  const body = options.body ? JSON.parse(options.body) : {};
  if (parsed.pathname === '/api/state') {
    return jsonResponse({
      algorithm_id: 'v040-formal',
      map_demand_version: 'v0.40',
      unified_measurements: {
        scale_id: 'US-1',
        status: 'ATTACHED',
        contexts: { default: { calibration_id: calibrationId, status: 'ACTIVE' } },
      },
    });
  }
  if (parsed.pathname === '/api/analyze') {
    analyzeCalls += 1;
    const bid = Number(body.beatmap_id);
    return jsonResponse({
      status: 'OK',
      identity: analyzeIdentityOverride
        ? { algorithm_id: analyzeIdentityOverride.algorithm_id, map_demand_version: analyzeIdentityOverride.map_demand_version }
        : { algorithm_id: 'v040-formal', map_demand_version: 'v0.40' },
      beatmap: { beatmap_id: bid, local_nm_stars: 6.5 },
      axes: {
        reading: { stars: bid === 300 ? null : 7, unified_star_status: 'ADMITTED', unified_star_equivalent: bid === 300 ? null : unifiedValue, confidence: 'MEASURED' },
      },
      unified_measurements: { status: 'ATTACHED' },
    });
  }
  return jsonResponse({ error: 'NOT_FOUND' }, 404);
});

try {
  const profiler = await import('../server/bots/skillProfiler.ts');
  const axes = await import('../server/bots/playerSkillAxes.ts');

  // ── F10: missing values stay missing, real values keep their source ──
  const invalidUnified = profiler.skillProfilerAxisValue({
    unified_measurements: { status: 'ATTACHED' },
    axes: { reading: { stars: 7, unified_star_status: 'ADMITTED', unified_star_equivalent: null } },
  }, 'reading');
  assert(invalidUnified.value === 7 && invalidUnified.scale === 'v040_axis'
    && invalidUnified.status === 'UNIFIED_VALUE_INVALID_LEGACY',
  'f10:admitted-null-unified-falls-back-with-reason', JSON.stringify(invalidUnified));

  const missingEverything = profiler.skillProfilerAxisValue({
    unified_measurements: { status: 'ATTACHED' },
    axes: { reading: { stars: null, unified_star_status: 'ADMITTED', unified_star_equivalent: null } },
  }, 'reading');
  assert(missingEverything.value === null, 'f10:null-stars-stays-missing', JSON.stringify(missingEverything));

  const admitted = profiler.skillProfilerAxisValue({
    unified_measurements: { status: 'ATTACHED' },
    axes: { reading: { stars: 7, unified_star_status: 'ADMITTED', unified_star_equivalent: 8.25 } },
  }, 'reading');
  assert(admitted.value === 8.25 && admitted.scale === 'unified' && admitted.status === 'ADMITTED',
    'f10:real-admitted-unified-unchanged', JSON.stringify(admitted));

  // ── F09: calibration change must invalidate the per-map cache ──
  await profiler.resetSkillProfilerIdentityCacheForTests();
  analyzeCalls = 0;
  unifiedValue = 5;
  const first = await profiler.requestSkillProfilerAnalysisCachedWithFetch(100, []);
  assert(analyzeCalls === 1 && first.status === 'OK', 'f09:first-analysis-hits-provider', String(analyzeCalls));
  assert(profiler.skillProfilerAxisValue(first, 'reading').value === 5, 'f09:first-value-from-calibration-a');

  const secondSameIdentity = await profiler.requestSkillProfilerAnalysisCachedWithFetch(100, []);
  assert(analyzeCalls === 1, 'f09:same-identity-served-from-cache', String(analyzeCalls));

  await profiler.resetSkillProfilerIdentityCacheForTests();
  calibrationId = 'CAL-B';
  unifiedValue = 8;
  const third = await profiler.requestSkillProfilerAnalysisCachedWithFetch(100, []);
  assert(analyzeCalls === 2, 'f09:recalibration-invalidates-cache', String(analyzeCalls));
  assert(profiler.skillProfilerAxisValue(third, 'reading').value === 8, 'f09:second-value-from-calibration-b');

  // Old v1-format cache files must never be hits: only schema-v2 files exist.
  const cacheDir = path.join(dataDir, 'skill-profiler-analysis-cache');
  const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
  assert(cacheFiles.every((name) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
      return typeof parsed.key === 'string' && parsed.key.includes('"v040-formal"');
    } catch { return false; }
  }), 'f09:cache-files-carry-full-identity-key', JSON.stringify(cacheFiles));

  // ── F11: cache write failure must not override a successful analysis ──
  await profiler.resetSkillProfilerIdentityCacheForTests();
  const blocked = path.join(dataDir, 'blocked');
  fs.writeFileSync(blocked, 'not a directory', 'utf8');
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = path.join(blocked, 'nested');
  let degraded = null;
  let degradedError = null;
  try { degraded = await profiler.requestSkillProfilerAnalysisCachedWithFetch(200, []); }
  catch (error) { degradedError = error; }
  finally { process.env.DATA_DIR = previousDataDir; }
  assert(degraded?.status === 'OK' && !degradedError, 'f11:cache-write-failure-degrades', String(degradedError?.message || degradedError));

  // ── §6.2: batch identity pinning rejects mid-batch recalibration ──
  await profiler.resetSkillProfilerIdentityCacheForTests();
  calibrationId = 'CAL-A';
  analyzeIdentityOverride = { algorithm_id: 'v101', map_demand_version: 'v0.40' };
  let mismatchError = null;
  try {
    await profiler.requestSkillProfilerAnalysisCachedWithFetch(400, [], {
      algorithmId: 'v040-formal',
      mapDemandVersion: 'v0.40',
      unifiedScaleId: 'US-1',
      unifiedCalibrationKey: 'default:CAL-A:ACTIVE',
    });
  } catch (error) { mismatchError = error; }
  assert(String(mismatchError?.message || '').startsWith('ANALYSIS_IDENTITY_MISMATCH'),
    'batch:identity-mismatch-rejected', String(mismatchError?.message || mismatchError));
  analyzeIdentityOverride = null;

  // Mismatched results must not be cached: the next call with the expected
  // identity goes to the provider again and succeeds.
  analyzeCalls = 0;
  const pinned = await profiler.requestSkillProfilerAnalysisCachedWithFetch(400, [], {
    algorithmId: 'v040-formal',
    mapDemandVersion: 'v0.40',
    unifiedScaleId: 'US-1',
    unifiedCalibrationKey: 'default:CAL-A:ACTIVE',
  });
  assert(analyzeCalls === 1 && pinned.status === 'OK', 'batch:mismatch-not-cached', String(analyzeCalls));

  // Axis catalog sanity: every player axis label maps from the shared catalog.
  assert(axes.PLAYER_SKILL_AXIS_ORDER.length === 9, 'axes:nine-dimensions');
} finally {
  globalThis.fetch = realFetch;
  cleanupTestDir(dataDir);
}

if (failed > 0) {
  console.error(`SKILL-PROFILER-CACHE-VERIFY FAILED (${failed})`);
  process.exit(1);
}
console.log('skill profiler cache contract checks passed');
