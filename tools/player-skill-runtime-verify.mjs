import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wuxin-skill-batch-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.OSU_CLIENT_ID = 'fixture';
process.env.OSU_CLIENT_SECRET = 'fixture';
process.env.OSU_API_MIN_INTERVAL_MS = '0';
process.env.PPLUS_POLL_INTERVAL_MS = '10';
const axes = ['aim_control', 'jump_aim', 'spatial_precision', 'flow_aim', 'raw_speed', 'finger_control', 'stamina', 'endurance', 'reading'];
const requests = new Map();
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'fixture', expires_in: 3600 }));
    if (req.url.startsWith('/auth/token?')) return res.end(JSON.stringify({ code: 200, data: 'fixture-pplus' }));
    if (req.url.startsWith('/player/jobs?')) return res.end(JSON.stringify({ code: 200, data: { id: 1, status: 'running' } }));
    if (req.url.startsWith('/player/jobs/status?')) return res.end(JSON.stringify({ code: 200, data: {
      id: 1, status: 'completed', result: { performances: { pp: 1000, ppJumpAim: 900, ppFlowAim: 800, ppSpeed: 700, ppStamina: 600, ppPrecision: 500, ppAcc: 400 } },
    } }));
    if (req.url === '/api/state') return res.end(JSON.stringify({ algorithm_id: 'BATCH_TEST', map_demand_version: 'test' }));
    if (req.url === '/api/v2/users/1/osu') return res.end(JSON.stringify({ id: 1, username: 'Fixture', statistics: {} }));
    if (req.url.startsWith('/api/v2/users/1/scores/best?')) {
      return res.end(JSON.stringify([1, 2, 3].map(id => ({ id, mods: [], accuracy: .99, max_combo: 100, passed: true, rank: 'S', statistics: { count_300: 100 }, beatmap: { id, max_combo: 100 } }))));
    }
    if (req.url === '/api/analyze') {
      const bid = JSON.parse(raw).beatmap_id;
      const count = (requests.get(bid) || 0) + 1;
      requests.set(bid, count);
      if (bid === 2 && count === 1) {
        res.writeHead(503);
        return res.end(JSON.stringify({ error: 'TRANSIENT_FIXTURE_FAILURE' }));
      }
      return res.end(JSON.stringify({
        status: 'OK',
        schema_version: 'map_demand_bid_analysis_v0.1.0',
        beatmap: { beatmap_id: bid },
        axes: Object.fromEntries(axes.map(axis => [axis, { stars: 4 }])),
        identity: { algorithm_id: 'BATCH_TEST', map_demand_version: 'test' },
      }));
    }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.OSU_API_BASE_URL = base + '/api/v2';
process.env.OSU_TOKEN_URL = base + '/oauth/token';
process.env.SKILL_PROFILER_URL = base;
try {
  const { updateDb } = await import('../server/store.ts');
  updateDb(db => Object.assign(db.settings, { pplusBaseUrl: base, pplusClientId: 1, pplusClientSecret: 'fixture' }));
  const { buildPlayerSkillProfilePayload } = await import('../server/bots/playerSkillProfile.ts');
  const { startRequestTrace, withRequestTrace, listRequestTraces } = await import('../server/requestTrace.ts');
  const id = startRequestTrace({ messageId: 'batch-fixture', groupId: 'fixture', userId: 'fixture' });
  const partial = await withRequestTrace(id, () => buildPlayerSkillProfilePayload(1, 3));
  assert.equal(partial.sample.valid, 2);
  assert.equal(partial.ppPlus.ppTotal, 1000, 'first profile includes the awaited PP+ result');
  assert.equal(partial.sample.failed, 1);
  assert.ok(listRequestTraces(1)[0].events.some(event => event.data?.completed === 3 && event.data?.failed === 1));
  const complete = await buildPlayerSkillProfilePayload(1, 3);
  assert.equal(complete.sample.valid, 3, 'retry must rebuild an incomplete profile');
  assert.equal(complete.sample.failed, 0);
  assert.deepEqual([...requests].sort(), [[1, 1], [2, 2], [3, 1]], 'successful map analyses survive the retry');
  const cached = await buildPlayerSkillProfilePayload(1, 3);
  assert.deepEqual(cached, complete);
  assert.equal([...requests.values()].reduce((a, b) => a + b), 4);
  const rejectedAuth = http.createServer((_req, res) => res.end(JSON.stringify({ code: 401, data: null })));
  await new Promise(resolve => rejectedAuth.listen(0, '127.0.0.1', resolve));
  try {
    updateDb(db => { db.settings.pplusBaseUrl = `http://127.0.0.1:${rejectedAuth.address().port}`; });
    await assert.rejects(buildPlayerSkillProfilePayload(1, 3), { code: 'AUTH' }, 'cached BP must not hide a current PP+ authentication failure');
  } finally {
    await new Promise(resolve => rejectedAuth.close(resolve));
  }
  console.log('PASS: first PP+ payload, auth failure propagation, BP retries and profile caching');
} finally {
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
