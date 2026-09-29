// P01 — profiler result identity contract.  All HTTP is a loopback fixture;
// no real profiler, osu! API, or production DATA_DIR is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDataDir, cleanupTestDir, assertNotProduction } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-profiler-identity');
assertNotProduction(dataDir);
const realFetch = globalThis.fetch;
let responseMode = 'A';
let analyzeCalls = 0;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function contextForMods(mods = []) {
  const order = ['NF', 'EZ', 'HD', 'HR', 'SD', 'DT', 'RX', 'HT', 'NC', 'FL', 'AT', 'SO', 'AP', 'PF', 'DC'];
  const effective = [...new Set(mods.map((mod) => {
    const upper = String(mod).toUpperCase();
    return upper === 'NC' ? 'DT' : upper === 'DC' ? 'HT' : upper;
  }).filter((mod) => !new Set(['NM', 'NF', 'SD', 'PF']).has(mod)))];
  return effective.sort((left, right) => order.indexOf(left) - order.indexOf(right) || left.localeCompare(right)).join('') || 'NM';
}

function responseFor(body) {
  const context = contextForMods(body.mods || []);
  if (responseMode === 'missing') {
    return {
      status: 'OK',
      schema_version: 'map_demand_bid_analysis_v0.1.0',
      identity: { algorithm_id: 'ALGO-A', map_demand_version: 'DEMAND-A' },
      unified_measurements: { status: 'ATTACHED' },
      beatmap: { beatmap_id: Number(body.beatmap_id) },
      axes: {},
    };
  }
  if (responseMode === 'raw') {
    return {
      status: 'OK',
      schema_version: 'map_demand_bid_analysis_v0.1.0',
      identity: { algorithm_id: 'ALGO-A', map_demand_version: 'DEMAND-A' },
      unified_measurements: { status: 'NOT_CONFIGURED' },
      beatmap: { beatmap_id: Number(body.beatmap_id) },
      axes: {},
    };
  }
  const scale = responseMode === 'SCALE-B' ? 'SCALE-B' : 'SCALE-A';
  const mapCalibration = responseMode === 'MAP-B' ? 'MAP-B' : 'MAP-A';
  const unifiedCalibration = responseMode === 'CAL-B'
    ? 'UCAL-B'
    : responseMode === 'SCALE-B'
      ? 'UCAL-SCALE-B'
      : context === 'HR'
        ? 'UCAL-HR'
        : context === 'DT'
          ? 'UCAL-DT'
          : 'UCAL-NM';
  return {
    status: 'OK',
    schema_version: 'map_demand_bid_analysis_v0.1.0',
    identity: {
      algorithm_id: responseMode === 'ALGO-B' ? 'ALGO-B' : 'ALGO-A',
      map_demand_version: responseMode === 'VERSION-B' ? 'DEMAND-B' : 'DEMAND-A',
      calibration_id: mapCalibration,
    },
    unified_measurements: {
      status: 'ATTACHED',
      schema_version: 'unified-v1',
      scale_id: scale,
      mod_context: context,
      calibration_id: unifiedCalibration,
    },
    beatmap: { beatmap_id: Number(body.beatmap_id) },
    axes: {},
  };
}

globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  if (parsed.pathname === '/api/analyze') {
    analyzeCalls += 1;
    const body = options.body ? JSON.parse(options.body) : {};
    return jsonResponse(responseFor(body));
  }
  return jsonResponse({ error: 'NOT_FOUND' }, 404);
};

const fullIdentity = {
  algorithmId: 'ALGO-A',
  mapDemandVersion: 'DEMAND-A',
  analysisSchemaVersion: 'map_demand_bid_analysis_v0.1.0',
  axisSchemaVersion: 'axes-v040',
  unifiedSchemaVersion: 'unified-v1',
  unifiedScaleId: 'SCALE-A',
  unifiedCalibrationKey: 'DT:UCAL-DT:ACTIVE|HR:UCAL-HR:ACTIVE|NM:UCAL-NM:ACTIVE',
  mapDemandCalibrationId: 'MAP-A',
};

function identity(overrides = {}) {
  return { ...fullIdentity, ...overrides };
}

function rawIdentity() {
  return {
    algorithmId: 'ALGO-A',
    mapDemandVersion: 'DEMAND-A',
    unifiedScaleId: 'UNIFIED_SCALE_UNCONFIGURED',
    unifiedCalibrationKey: 'UNIFIED_CALIBRATION_UNCONFIGURED',
    mapDemandCalibrationId: 'MAP_DEMAND_CALIBRATION_UNCONFIGURED',
  };
}

async function request(profiler, beatmapId, mods, expected) {
  return profiler.requestSkillProfilerAnalysisCachedWithFetch(beatmapId, mods, expected);
}

try {
  const profiler = await import('../server/bots/skillProfiler.ts');

  // Old implementation counterexample: algorithm/version match while both
  // map-demand and unified calibration/scale belong to B.
  responseMode = 'SCALE-B';
  await assert.rejects(
    request(profiler, 4242, ['HR'], identity({
      unifiedScaleId: 'SCALE-A',
      unifiedCalibrationKey: 'HR:UCAL-HR:ACTIVE',
    })),
    /ANALYSIS_IDENTITY_MISMATCH/,
    'A request must reject a B-scale response',
  );
  console.log('PASS [identity:expected-A-response-B]');

  responseMode = 'MAP-B';
  await assert.rejects(
    request(profiler, 4243, [], fullIdentity),
    /ANALYSIS_IDENTITY_MISMATCH/,
    'a request must reject a B map-demand calibration',
  );
  console.log('PASS [identity:map-calibration-conflict]');

  // A valid response is cached; a manually corrupted identity is isolated,
  // refreshed exactly once, and the refreshed valid response becomes the hit.
  responseMode = 'A';
  analyzeCalls = 0;
  await request(profiler, 5001, [], fullIdentity);
  assert.equal(analyzeCalls, 1, 'initial valid response should call provider once');
  const cacheDir = path.join(dataDir, 'skill-profiler-analysis-cache');
  const cacheFile = fs.readdirSync(cacheDir).find((name) => name.endsWith('.json'));
  assert.ok(cacheFile, 'valid response should create a cache file');
  const cachePath = path.join(cacheDir, cacheFile);
  const corrupted = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  corrupted.analysis.unified_measurements.scale_id = 'SCALE-B';
  corrupted.analysis.unified_measurements.calibration_id = 'UCAL-B';
  fs.writeFileSync(cachePath, JSON.stringify(corrupted), 'utf8');
  const refreshed = await request(profiler, 5001, [], fullIdentity);
  assert.equal(refreshed.status, 'OK', 'valid refresh should be returned');
  assert.equal(analyzeCalls, 2, 'identity-conflicting cache should allow one controlled refresh');
  assert.ok(fs.readdirSync(cacheDir).some((name) => name.includes('.invalid-')), 'bad cache should be isolated');
  await request(profiler, 5001, [], fullIdentity);
  assert.equal(analyzeCalls, 2, 'refreshed valid response should be a cache hit');
  console.log('PASS [cache:conflict-isolated-refresh-hit]');

  // Same algorithm/version with only calibration changed must not reuse A.
  responseMode = 'CAL-B';
  await request(profiler, 5002, [], identity({ unifiedCalibrationKey: 'NM:UCAL-B:ACTIVE' }));
  assert.equal(analyzeCalls, 3, 'calibration-only change must create a new provider request');
  console.log('PASS [identity:calibration-change-invalidates]');

  // A scale change is independently part of the key and response contract.
  responseMode = 'SCALE-B';
  await request(profiler, 5003, [], identity({
    unifiedScaleId: 'SCALE-B',
    unifiedCalibrationKey: 'NM:UCAL-SCALE-B:ACTIVE',
  }));
  assert.equal(analyzeCalls, 4, 'scale-only change must create a new provider request');
  console.log('PASS [identity:scale-change-invalidates]');

  // Missing identity is not a match for a configured unified result.
  responseMode = 'missing';
  await assert.rejects(
    request(profiler, 5004, [], fullIdentity),
    /ANALYSIS_IDENTITY_MISMATCH/,
    'missing unified identity must fail closed',
  );
  console.log('PASS [identity:missing-rejected]');

  // Raw-axis-only/unconfigured results are legal, but have a separate cache
  // namespace and cannot claim ATTACHED unified evidence.
  responseMode = 'raw';
  const raw = await request(profiler, 5005, ['DT'], rawIdentity());
  assert.equal(raw.status, 'OK', 'raw-axis-only response remains usable');
  const rawAgain = await request(profiler, 5005, ['NC'], rawIdentity());
  assert.equal(rawAgain.status, 'OK', 'NC folds to the same raw DT request');
  assert.equal(analyzeCalls, 6, 'raw-axis-only result should be cached under its own identity');
  console.log('PASS [identity:raw-axis-only-separated]');

  // Current context is selected per request; all-context state metadata must
  // not make HR/DT look like NM or compare the whole contexts object.
  responseMode = 'A';
  const hr = await request(profiler, 5006, ['HR'], fullIdentity);
  const dt = await request(profiler, 5007, ['NC'], fullIdentity);
  assert.equal(hr.unified_measurements.mod_context, 'HR', 'HR context is preserved');
  assert.equal(dt.unified_measurements.mod_context, 'DT', 'NC folds to DT context');
  console.log('PASS [identity:NM-HR-DT-contexts]');

  // A single NM calibration is not a wildcard for DT/HD. The missing DT
  // context remains a legal raw-axis-only request, while an attached response
  // claiming DT calibration must fail closed.
  const nmOnlyIdentity = identity({
    unifiedCalibrationKey: 'NM:UCAL-NM:ACTIVE',
    mapDemandCalibrationId: 'MAP_DEMAND_CALIBRATION_UNCONFIGURED',
  });
  responseMode = 'raw';
  const dtRaw = await request(profiler, 5008, ['DT'], nmOnlyIdentity);
  assert.equal(dtRaw.unified_measurements.status, 'NOT_CONFIGURED', 'unconfigured DT stays raw-axis-only when only NM is calibrated');
  responseMode = 'A';
  await assert.rejects(
    request(profiler, 5009, ['DT'], nmOnlyIdentity),
    /ANALYSIS_IDENTITY_MISMATCH/,
    'an attached DT response must not borrow the only NM calibration',
  );
  console.log('PASS [identity:partial-context-does-not-wildcard]');

  const { playerProfileCacheKey } = await import('../server/bots/playerSkillProfile.ts');
  const { recentProfileCacheKey } = await import('../server/bots/playerRecentSkillProfile.ts');
  assert.notEqual(
    playerProfileCacheKey(1, 50, fullIdentity),
    playerProfileCacheKey(1, 50, identity({ mapDemandCalibrationId: 'MAP-B' })),
    'player profile cache includes map-demand calibration',
  );
  assert.notEqual(
    recentProfileCacheKey(1, fullIdentity),
    recentProfileCacheKey(1, identity({ unifiedSchemaVersion: 'unified-v2' })),
    'recent profile cache includes unified schema',
  );
  console.log('PASS [identity:upstream-profile-cache-keys]');
} finally {
  globalThis.fetch = realFetch;
  cleanupTestDir(dataDir);
}

console.log('skill profiler identity contract checks passed');
