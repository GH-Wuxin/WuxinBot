import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createTestDataDir, cleanupTestDir } from './test-isolation.mjs';

const dataDir = createTestDataDir('wuxin-profiler-runtime');
process.env.NODE_ENV = 'test';
process.env.OSU_CLIENT_ID = 'fixture';
process.env.OSU_CLIENT_SECRET = 'fixture';
process.env.OSU_API_MIN_INTERVAL_MS = '0';
process.env.SKILL_PROFILER_TIMEOUT_MS = '1000';
process.env.SKILL_PROFILER_CONCURRENCY = '2';
const legacy = '\uFEFFosu file format v9\r\n[Metadata]\r\nTitle:Legacy\r\n';
const modern = 'osu file format v14\n[Metadata]\nBeatmapID:999\n';
const digest = text => createHash('md5').update(text).digest('hex');
const imported = new Map();
const counts = new Map();
let active = 0, peak = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'fixture', expires_in: 3600 }));
    if (req.url === '/api/state') return res.end(JSON.stringify({ algorithm_id: 'RUNTIME_TEST', map_demand_version: 'test' }));
    if (req.url.startsWith('/api/v2/beatmaps/')) {
      const id = Number(req.url.split('/').at(-1));
      return res.end(JSON.stringify({ id, checksum: id === 1 ? digest(legacy) : '0'.repeat(32) }));
    }
    if (req.url.startsWith('/osu/')) return res.end(req.url.endsWith('/3') ? modern : legacy);
    if (req.url === '/api/import') {
      const payload = JSON.parse(raw);
      imported.set(payload.beatmap_id, payload);
      return res.end(JSON.stringify({ status: 'IMPORTED' }));
    }
    if (req.url === '/api/analyze') {
      const { beatmap_id: bid } = JSON.parse(raw);
      counts.set(bid, (counts.get(bid) || 0) + 1);
      if (bid < 100 && !imported.has(bid)) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'BID_NOT_FOUND', message: 'not imported' }));
      }
      if (bid === 999) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: 'FIXTURE_FAILURE' }));
      }
      active += 1; peak = Math.max(peak, active);
      return setTimeout(() => {
        active -= 1;
        res.end(JSON.stringify({ status: 'OK', beatmap: { beatmap_id: bid } }));
      }, bid >= 100 ? 600 : 0);
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.SKILL_PROFILER_URL = base;
process.env.OSU_API_BASE_URL = base + '/api/v2';
process.env.OSU_TOKEN_URL = base + '/oauth/token';
process.env.OSU_BEATMAP_FILE_BASE_URL = base + '/osu/';
try {
  const { requestSkillProfilerAnalysis, requestSkillProfilerAnalysisWithFetch,
    requestSkillProfilerAnalysisCachedWithFetch } = await import('../server/bots/skillProfiler.ts');
  const started = Date.now();
  await Promise.all(Array.from({ length: 10 }, (_, i) => requestSkillProfilerAnalysis(100 + i)));
  assert.equal(peak, 2, 'different profiles/commands must share one global execution limit');
  assert.ok(Date.now() - started > 1000, 'queue wait exceeds the execution deadline without failing');
  await assert.rejects(requestSkillProfilerAnalysis(999), /FIXTURE_FAILURE/);
  await requestSkillProfilerAnalysis(110); // Error must release its reserved slot.
  await requestSkillProfilerAnalysisWithFetch(1);
  assert.deepEqual(imported.get(1), { beatmap_id: 1, content: legacy, expected_md5: digest(legacy) });
  await assert.rejects(requestSkillProfilerAnalysisWithFetch(2), /OSU_FILE_CHECKSUM_MISMATCH/);
  await assert.rejects(requestSkillProfilerAnalysisWithFetch(3), /OSU_FILE_BID_MISMATCH/);
  assert.equal(imported.size, 1, 'invalid files never reach import');
  await Promise.all(Array.from({ length: 8 }, () => requestSkillProfilerAnalysisCachedWithFetch(120, ['HD'])));
  await requestSkillProfilerAnalysisCachedWithFetch(120, ['HD']);
  assert.equal(counts.get(120), 1, 'same-map inflight coalescing and disk caching survive the queue');
  console.log('PASS: shared concurrency, queue deadline, error release, legacy checksum import, invalid-file rejection and cache reuse');
} finally {
  await new Promise(resolve => server.close(resolve));
  cleanupTestDir(dataDir);
}
