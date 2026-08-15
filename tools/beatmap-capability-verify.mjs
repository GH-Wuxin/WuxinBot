// beatmap-capability-verify.mjs — Phase B replay with the REAL sentences found
// in the 12k-message demand investigation, against mocked osu! API + yumu HTTP.
// Exit 0 on all pass, non-zero on any failure.
import http from 'node:http';
import { createTestDataDir, assertNotProduction, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-beatmap-cap');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);

const API_PORT = 63901;
const YUMU_PORT = 63902;
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${API_PORT}/api/v2`;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${API_PORT}/oauth/token`;
process.env.OSU_CLIENT_ID = 'fixture';
process.env.OSU_CLIENT_SECRET = 'fixture';
process.env.YUMU_HTTP_BASE = `http://127.0.0.1:${YUMU_PORT}`;

const BEATMAP = {
  id: 5518740,
  beatmapset_id: 2495916,
  mode: 'osu',
  difficulty_rating: 5.4,
  version: "Kuki's Extra",
  accuracy: 9.1,
  ar: 9.6,
  bpm: 180,
  cs: 3.4,
  drain: 5.8,
  total_length: 34,
  hit_length: 31,
  max_combo: 197,
  count_circles: 113,
  count_sliders: 33,
  count_spinners: 1,
  status: 'ranked',
  url: 'https://osu.ppy.sh/b/5518740',
  beatmapset: {
    id: 2495916,
    title: 'The Best of Both Worlds (Nightcore & Cut Ver.)',
    artist: 'Miley Cyrus',
    creator: 'Mimari',
    status: 'ranked',
    covers: { cover: '', 'cover@2x': '', list: '', 'list@2x': '' },
  },
};

const ATTRIBUTES = { attributes: { star_rating: 6.42, max_combo: 197 } };

const SCORES = {
  scores: [
    { id: 1, accuracy: 0.952, max_combo: 196, mods: ['HD', 'HR'], pp: 465.2, rank: 'SH', score: 1000000,
      statistics: { count_50: 0, count_100: 2, count_300: 190, count_geki: 0, count_katsu: 0, count_miss: 1 },
      beatmap: BEATMAP, beatmapset: BEATMAP.beatmapset, created_at: '2026-01-01T00:00:00Z', mode: 'osu', user_id: 10000004,
      user: { id: 10000004, username: '[TST]Delta' } },
    { id: 2, accuracy: 0.94, max_combo: 150, mods: ['HD', 'DT'], pp: 410.1, rank: 'S', score: 900000,
      statistics: { count_50: 0, count_100: 5, count_300: 180, count_geki: 0, count_katsu: 0, count_miss: 2 },
      beatmap: BEATMAP, beatmapset: BEATMAP.beatmapset, created_at: '2026-01-01T00:00:00Z', mode: 'osu', user_id: 2,
      user: { id: 2, username: 'other_player' } },
  ],
};

const YUMU_JSON = {
  engine: 'rosu', estimated: true, unavailable: false,
  beatmap: { id: 5518740, set_id: 2495916, title: 'The Best of Both Worlds (Nightcore & Cut Ver.)', artist: 'Miley Cyrus', version: "Kuki's Extra", creator: 'Mimari', mode: 'osu', status: 'ranked', bpm: 180, length_seconds: 34, max_combo: 197, cs: 3.4 },
  mods: ['HD', 'HR'],
  request: { accuracy: 0.99, combo: null, misses: 0 },
  calculation: {
    engine: 'rosu', estimated: true, stars: 6.42, ar: 10, od: 10, hp: 6.44, max_combo: 197,
    estimated_pp: 201.31, pp_aim: 145.2, pp_speed: 12.1, pp_accuracy: 28.9, pp_flashlight: 0, pp_reading: 15.1,
    effective_miss_count: 0, estimated_unstable_rate: null,
    fc_ladder: { '1.00': 201.31, '0.99': 188.93, '0.98': 169.79, '0.96': 147.31, '0.94': 133.14, '0.92': 125.63 },
  },
  density_26: [3, 5, 8, 6, 4, 7, 9, 6, 5, 8, 4, 6, 7, 9, 5, 6, 8, 4, 7, 5, 9, 6, 4, 5, 8, 6],
};

// ── Mock servers ──
const apiServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/oauth/token') return json({ access_token: 'fixture-token', expires_in: 86400 });
  if (!req.headers.authorization) return json({ error: 'unauthorized' }, 401);
  if (url.pathname === '/api/v2/beatmaps/5518740') return json(BEATMAP);
  if (url.pathname === '/api/v2/beatmaps/5518740/attributes') return json(ATTRIBUTES);
  if (url.pathname === '/api/v2/beatmaps/5518740/scores') return json(SCORES);
  return json({ error: 'not found' }, 404);
});
await new Promise((resolve) => apiServer.listen(API_PORT, '127.0.0.1', resolve));

const yumuServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${YUMU_PORT}`);
  if (url.pathname === '/pub/map/calculate') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Only the fixture beatmap is available; other bids must fail closed.
    if (url.searchParams.get('bid') === '5518740') res.end(JSON.stringify(YUMU_JSON));
    else res.end(JSON.stringify({ unavailable: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => yumuServer.listen(YUMU_PORT, '127.0.0.1', resolve));

// ── Replay ──
const { runBeatmapLookup, runPpCalc, runLeaderboard } = await import('../server/bots/beatmapCapabilities.ts');

let passed = 0;
let failed = 0;
function pass(label) { console.log(`PASS [${label}]`); passed++; }
function fail(label, msg) { console.error(`FAIL [${label}]: ${msg}`); failed++; }
function expectContains(label, text, markers) {
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length === 0) pass(label);
  else fail(label, `missing markers: ${missing.join(', ')} — got: ${text.slice(0, 200)}`);
}

// 1. "这图多少星" → beatmap_lookup (no mods)
{
  const text = await runBeatmapLookup({ beatmap_id: 5518740 });
  expectContains('replay-这图多少星', text, ['【谱面信息】', 'BID 5518740', '基础星数 5.40★', 'AR 9.6', 'Mimari', 'https://osu.ppy.sh/b/5518740']);
}

// 2. "hr之后多少星" → beatmap_lookup + mods=HR
{
  const text = await runBeatmapLookup({ beatmap_id: 5518740, mods: 'HR' });
  expectContains('replay-hr之后多少星', text, ['带 mod（HR）官方属性', '6.42★', 'max combo 197']);
}

// 3. "99acc fc多少pp" → pp_calc accuracy=99, no combo
{
  const text = await runPpCalc({ beatmap_id: 5518740, mods: 'HDHR', accuracy: 99 });
  expectContains('replay-99acc-fc多少pp', text, ['【pp 估算】', '估算约 201.31pp', 'rosu 估算值', 'FC（max combo）', 'FC acc 阶梯', '201.3']);
}

// 4. "95.2 acc 1miss 1200combo 呢" → pp_calc with combo/misses
{
  const text = await runPpCalc({ beatmap_id: 5518740, accuracy: 95.2, combo: 1200, misses: 1 });
  expectContains('replay-95.2acc-1miss', text, ['95.2% acc / 1200x combo / 1 miss']);
}

// 5. "榜一多少" → leaderboard limit=1
{
  const text = await runLeaderboard({ beatmap_id: 5518740, limit: 1 });
  expectContains('replay-榜一多少', text, ['【榜单】', '#1 [TST]Delta', '465.2pp', '95.20%', '+HDHR']);
}

// 6. "前十是谁" → leaderboard default limit (mock has 2 scores)
{
  const text = await runLeaderboard({ beatmap_id: 5518740 });
  expectContains('replay-前十是谁', text, ['#1 [TST]Delta', '#2 other_player', '+HDDT', '前 2 条']);
}

// 7. BP 富信息：SS 估算 + pp 组成 + 密度（LLM 工具路径的 bp 结果增强）。
{
  const { enrichBpScoresWithSs, formatBpEnrichmentSuffix, beatmapDensity } = await import('../server/bots/beatmapCapabilities.ts');
  const results = await enrichBpScoresWithSs([
    { beatmapId: 5518740, mods: ['HD', 'HR'], accuracy: 95.2, combo: 196, misses: 1 },
    { beatmapId: 999999, mods: [] },
  ]);
  const first = results[0];
  if (
    first?.ssPp === 201.31
    && String(first.breakdown || '').includes('aim')
    && Array.isArray(first.density26) && first.density26.length === 26
    && first.attributes?.perfect_pp === 201.31
    && first.attributes?.full_pp === 147.31 // closest ladder bucket to 95.2% → 0.96
    && first.attributes?.pp === 201.31
    && results[1] === null
  ) {
    pass('enrich-ss-bp');
  } else {
    fail('enrich-ss-bp', JSON.stringify(results));
  }
  const suffix = formatBpEnrichmentSuffix(201.3, 'aim 145.2/speed 12.1/acc 28.9', 4.5);
  if (suffix.includes('SS≈201.3pp') && suffix.includes('构成 aim 145.2/speed 12.1/acc 28.9') && suffix.includes('密度 4.5/s')) pass('enrich-suffix-format');
  else fail('enrich-suffix-format', suffix);
  const density = beatmapDensity({ count_circles: 113, count_sliders: 33, count_spinners: 1, hit_length: 31 });
  if (density !== null && Math.abs(density - 147 / 31) < 1e-9) pass('enrich-density');
  else fail('enrich-density', `density=${density}`);
}

apiServer.close();
yumuServer.close();
cleanupTestDir(testDataDir);

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error('BEATMAP-CAPABILITY-VERIFY FAILED');
  process.exit(1);
}
console.log('BEATMAP-CAPABILITY-VERIFY PASSED');
