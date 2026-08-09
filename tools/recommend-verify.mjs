// recommend-verify.mjs
// Regression guard for the beatmap recommendation engine. Fully OFFLINE:
// the osu! API base and token endpoints are pointed at a local mock HTTP
// server serving deterministic fixture data, so the suite never depends on
// osu.ppy.sh availability or rate limits. Asserts:
//   - mid/high players get 1..count candidates within star limits
//   - candidates never overlap the player's own top100
//   - sparse players get a definitive result (success or honest failure)
//   - numeric / similar-count / playable filters behave deterministically
//   - cooldown + 7-day anti-repeat persistence work
//   - executeInternalBotCommand('recommend') returns readable text + images
// Exit 0 on all pass, non-zero on any failure.

import http from 'node:http';
import { createTestDataDir, assertNotProduction, productionDbSnapshot, verifyProductionDbUnchanged, cleanupTestDir } from './test-isolation.mjs';

const testDataDir = createTestDataDir('wuxin-recommend');
process.env.DATA_DIR = testDataDir;
assertNotProduction(testDataDir);
const prodBefore = productionDbSnapshot();
console.log('[isolation] production db snapshot: ' + (prodBefore ? prodBefore.sha256.slice(0, 12) + '...' : 'N/A'));

// ── Offline osu! API mock ────────────────────────────────────────────────
// Synthetic world:
//   Wuxin(10000001) / BetaPlayer(10000002) / playable-user(10000003) have top plays
//   on maps 1001-1003 / 1004-1006. Twelve "similar" players (90001..90012)
//   share those leaderboards and also play candidate maps 1007/1008 (NM) and
//   1009 (DT), which the targets have not played. Candidate pp (205/195/185)
//   sits below the strict pp window of the 280-avg targets (>=210) but inside
//   the relaxed window (>=140), so the engine must use the relaxed pass to
//   produce candidates carrying 10 similar players - exactly what the
//   "similar>=10" cache-hit assertion needs.

const MAPS = [
  [1001, 7001, 'Alpha Fixture', '6.0', { bpm: 170, ar: 9.2, version: 'Insane' }],
  [1002, 7002, 'Beta Fixture', '5.8', { bpm: 175, ar: 9.0, version: 'Hard' }],
  [1003, 7003, 'Gamma Fixture', '6.2', { bpm: 185, ar: 8.8, version: 'Insane' }],
  [1004, 7004, 'Delta Fixture', '5.9', { bpm: 180, ar: 9.5, version: 'Insane' }],
  [1005, 7005, 'Epsilon Fixture', '6.1', { bpm: 190, ar: 9.3, version: 'Insane' }],
  [1006, 7006, 'Zeta Fixture', '5.7', { bpm: 200, ar: 8.5, version: 'Hard' }],
  [1007, 7007, 'Eta Fixture', '6.3', { bpm: 165, ar: 9.7, version: 'Insane' }],
  [1008, 7008, 'Theta Fixture', '5.5', { bpm: 172, ar: 9.1, version: 'Hard' }],
  [1009, 7009, 'Iota Fixture', '5.0', { bpm: 160, ar: 8.5, version: 'DT-Fixture' }],
];

const SETS = new Map();
const BEATMAPS = new Map();
for (const [id, setId, title, stars, opts] of MAPS) {
  const setIdNum = Number(setId);
  if (!SETS.has(setIdNum)) {
    SETS.set(setIdNum, {
      id: setIdNum,
      title,
      title_unicode: title,
      artist: 'Fixture Artist',
      creator: 'Fixture Creator',
      status: 'ranked',
      covers: { cover: `https://mock.invalid/cover/${setIdNum}`, 'cover@2x': '', list: '', 'list@2x': '' },
    });
  }
  BEATMAPS.set(id, {
    id,
    beatmapset_id: setIdNum,
    mode: 'osu',
    difficulty_rating: Number(stars),
    version: opts.version,
    accuracy: 8,
    ar: opts.ar,
    bpm: opts.bpm,
    cs: 4,
    drain: 6,
    total_length: 180,
    hit_length: 180,
    max_combo: 1000,
    count_circles: 500,
    count_sliders: 100,
    count_spinners: 0,
    status: 'ranked',
    url: `https://osu.ppy.sh/beatmaps/${id}`,
  });
}

function fixtureUser(id, username, pp) {
  return {
    id,
    username,
    country_code: 'CN',
    avatar_url: 'https://mock.invalid/avatar.png',
    is_online: true,
    join_date: '2020-01-01T00:00:00Z',
    statistics: {
      level: { current: 100, progress: 0 },
      global_rank: Math.max(1, Math.round(1_000_000 - pp * 100)),
      country_rank: 1,
      pp,
      ranked_score: 1,
      total_score: 1,
      total_hits: 1,
      hit_accuracy: 98,
      play_count: 100,
      play_time: 1000,
      maximum_combo: 1000,
      replays_watched_by_others: 0,
      is_ranked: true,
      grade_counts: { ss: 0, s: 0, a: 0 },
    },
    grade_counts: { ss: 0, ssh: 0, s: 0, sh: 0, a: 0 },
    follower_count: 0,
    support_level: 0,
  };
}

const USERS = new Map([
  [10000001, fixtureUser(10000001, '[TST]Alpha', 8700)],
  [10000002, fixtureUser(10000002, 'BetaPlayer', 7600)],
  [37645378, fixtureUser(37645378, 'sparse-user', 1200)],
  [10000003, fixtureUser(10000003, 'playable-user', 5000)],
]);
for (let i = 1; i <= 12; i++) {
  USERS.set(90000 + i, fixtureUser(90000 + i, `similar-${String(i).padStart(2, '0')}`, 8000 + i * 10));
}

function score(id, userId, beatmapId, pp, rank = 'S', mods = []) {
  const beatmap = BEATMAPS.get(beatmapId);
  return {
    id,
    user_id: userId,
    accuracy: 98,
    max_combo: 1000,
    mods,
    pp,
    rank,
    score: 1_000_000,
    statistics: { count_50: 0, count_100: 10, count_300: 500, count_geki: 0, count_katsu: 0, count_miss: 0 },
    beatmap,
    beatmapset: SETS.get(beatmap.beatmapset_id),
    created_at: '2026-01-01T00:00:00Z',
    mode: 'osu',
  };
}

let scoreId = 1;
function best(entries) {
  return entries.map(([uid, bid, pp, rank, mods]) => score(scoreId++, uid, bid, pp, rank, mods));
}

// Per-user best-score lists (returned by /users/:id/scores/best).
const BEST = new Map();
BEST.set(10000001, best([
  [10000001, 1001, 300, 'S'], [10000001, 1002, 280, 'S'], [10000001, 1003, 260, 'S'],
]));
BEST.set(10000002, best([
  [10000002, 1004, 300, 'S'], [10000002, 1005, 280, 'S'], [10000002, 1006, 260, 'S'],
]));
BEST.set(37645378, []);
BEST.set(10000003, best([
  [10000003, 1001, 200, 'S'], [10000003, 1002, 190, 'S'], [10000003, 1003, 180, 'S'],
]));
for (let i = 1; i <= 12; i++) {
  const uid = 90000 + i;
  BEST.set(uid, best([
    [uid, 1001, 299 + i, 'S'], [uid, 1002, 279 + i, 'S'], [uid, 1003, 259 + i, 'S'],
    [uid, 1007, 205, 'S'], [uid, 1008, 195, 'S'], [uid, 1009, 185, 'S', ['DT']],
  ]));
}

// Leaderboards (returned by /beatmaps/:id/scores).
const LEADERBOARDS = new Map();
function leaderboard(beatmapId, entries) {
  LEADERBOARDS.set(beatmapId, entries.map(([uid, pp]) => score(scoreId++, uid, beatmapId, pp, 'S', uid >= 90000 && beatmapId === 1009 ? ['DT'] : [])));
}
leaderboard(1001, [[10000001, 300], [10000003, 200], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 299 + i])]);
leaderboard(1002, [[10000001, 280], [10000003, 190], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 279 + i])]);
leaderboard(1003, [[10000001, 260], [10000003, 180], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 259 + i])]);
leaderboard(1004, [[10000002, 300], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 299 + i])]);
leaderboard(1005, [[10000002, 280], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 279 + i])]);
leaderboard(1006, [[10000002, 260], ...Array.from({ length: 12 }, (_, i) => [90001 + i, 259 + i])]);
leaderboard(1007, Array.from({ length: 12 }, (_, i) => [90001 + i, 205]));
leaderboard(1008, Array.from({ length: 12 }, (_, i) => [90001 + i, 195]));
leaderboard(1009, Array.from({ length: 12 }, (_, i) => [90001 + i, 185]));

function send(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let mockPort;
const mockServer = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${mockPort}`).pathname);

  if (req.method === 'POST' && pathname === '/oauth/token') {
    return send(res, { access_token: 'fixture-token', expires_in: 86400, token_type: 'Bearer' });
  }

  let m = /^\/api\/v2\/users\/(\d+)\/osu$/.exec(pathname);
  if (m) {
    const u = USERS.get(Number(m[1]));
    return u ? send(res, u) : send(res, { error: 'not_found' }, 404);
  }

  m = /^\/api\/v2\/users\/@(.+)\/osu$/.exec(pathname);
  if (m) {
    const u = [...USERS.values()].find((x) => x.username === m[1]);
    return u ? send(res, u) : send(res, { error: 'not_found' }, 404);
  }

  m = /^\/api\/v2\/users\/(\d+)\/scores\/best$/.exec(pathname);
  if (m) return send(res, BEST.get(Number(m[1])) || []);

  m = /^\/api\/v2\/beatmaps\/(\d+)\/scores$/.exec(pathname);
  if (m) return send(res, { scores: LEADERBOARDS.get(Number(m[1])) || [] });

  m = /^\/api\/v2\/beatmaps\/(\d+)\/attributes$/.exec(pathname);
  if (m && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let mods = [];
      try { mods = JSON.parse(body || '{}').mods || []; } catch { /* keep [] */ }
      const beatmap = BEATMAPS.get(Number(m[1]));
      let star = beatmap ? beatmap.difficulty_rating : 5;
      if (mods.some((mod) => mod === 'DT' || mod === 'NC')) star *= 1.4;
      else if (mods.some((mod) => mod === 'HR')) star *= 1.2;
      return send(res, { attributes: { star_rating: Math.round(star * 100) / 100, max_combo: 1000 } });
    });
    return;
  }

  return send(res, { error: 'not_found' }, 404);
});

await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
mockPort = mockServer.address().port;
process.env.OSU_API_BASE_URL = `http://127.0.0.1:${mockPort}/api/v2`;
process.env.OSU_TOKEN_URL = `http://127.0.0.1:${mockPort}/oauth/token`;
console.log(`[mock] osu! API served on 127.0.0.1:${mockPort}`);

const { ensureStore, updateDb } = await import('../server/store.ts');
ensureStore();
updateDb((draft) => {
  draft.settings.osuClientId = 'fixture-client';
  draft.settings.osuClientSecret = 'fixture-secret';
});

const {
  recommendForPlayer,
  checkRecommendCooldown,
  loadRecommendHistory,
  markRecommendation,
  clearRecommendHistory,
  formatRecommendLine,
} = await import('../server/osu/recommender.ts');
const { getUserBestScores } = await import('../server/osu/api.ts');
const { executeInternalBotCommand } = await import('../server/bots/executor.ts');
const { readDb } = await import('../server/store.ts');

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`PASS [${label}]`);
  passed++;
}

function fail(label, msg) {
  console.error(`FAIL [${label}]: ${msg}`);
  failed++;
}

function assert(cond, label, msg) {
  if (cond) pass(label);
  else fail(label, msg);
}

const db = readDb();

// ── 1. Engine: mid/high players ──
for (const [name, osuId] of [['[TST]Alpha', 10000001], ['BetaPlayer', 10000002]]) {
  const label = `engine:${name}`;
  try {
    const res = await recommendForPlayer({ kind: 'id', value: osuId }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      bypassCache: true,
    });
    assert(res.ok, label, `expected ok, got ${JSON.stringify(res).slice(0, 200)}`);
    if (!res.ok) continue;
    assert(res.candidates.length >= 1 && res.candidates.length <= 3, `${label}:count`, `got ${res.candidates.length}`);

    const ownTop = await getUserBestScores(osuId, 'osu', 100);
    const ownIds = new Set(ownTop.map((s) => s.beatmap?.id).filter(Boolean));
    const ownSetIds = new Set(ownTop.map((s) => s.beatmapset?.id || s.beatmap?.beatmapset_id).filter(Boolean));
    const overlap = res.candidates.filter((c) => ownIds.has(c.beatmapId) || ownSetIds.has(c.beatmapsetId));
    assert(overlap.length === 0, `${label}:no-top100-overlap`, `overlap: ${JSON.stringify(overlap.map((c) => c.title))}`);

    const topStars = ownTop.slice(0, 30).map((s) => s.beatmap?.difficulty_rating || 0).filter((v) => v > 0);
    const upper = Math.max(...topStars) * 1.3 + 0.01;
    const tooHard = res.candidates.filter((c) => c.stars > 0 && c.stars > upper);
    assert(tooHard.length === 0, `${label}:star-cap`, `above ${upper.toFixed(2)}*: ${JSON.stringify(tooHard.map((c) => c.title))}`);

    for (const c of res.candidates) {
      const line = formatRecommendLine(c, 0);
      assert(/https:\/\/osu\.ppy\.sh\/beatmaps\/\d+/.test(line), `${label}:link`, line);
    }
  } catch (e) {
    fail(label, e.message);
  }
}

// ── 2. Engine: sparse player gets a definitive result ──
{
  const label = 'engine:sparse';
  const res = await recommendForPlayer({ kind: 'id', value: 37645378 }, db, {
    count: 3,
    excludeBeatmapsetIds: new Set(),
    bypassCache: true,
  });
  assert(res.ok || (typeof res.reason === 'string' && res.reason.length > 0), label, `expected candidates or honest failure, got ${JSON.stringify(res).slice(0, 200)}`);
}

// ── 3. Engine: natural-language-style numeric filters (mod-adjusted) ──
{
  const label = 'engine:filters';
  const { parseRecommendStatement } = await import('../server/osu/recommendFilters.ts');
  const statement = 'bpm<=180 9<ar<10.3';
  const parsed = parseRecommendStatement(statement);
  assert(parsed.ok, `${label}:parse`, JSON.stringify(parsed));
  if (parsed.ok) {
    const res = await recommendForPlayer({ kind: 'id', value: 10000001 }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      bypassCache: true,
      filters: parsed.filters,
      filterStatement: statement,
    });
    assert(res.ok, `${label}:ok`, `expected ok, got ${JSON.stringify(res).slice(0, 200)}`);
    if (res.ok) {
      const outOfRange = res.candidates.filter(
        (c) => c.bpm > 180 + 0.01 || c.ar < 9 - 0.01 || c.ar > 10.3 + 0.01,
      );
      assert(outOfRange.length === 0, `${label}:values`, JSON.stringify(
        outOfRange.map((c) => ({ title: c.title, bpm: c.bpm, ar: c.ar })),
      ));
    }
    const impossible = await recommendForPlayer({ kind: 'id', value: 10000001 }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      bypassCache: true,
      filters: parseRecommendStatement('bpm<=80').filters,
      filterStatement: 'bpm<=80',
    });
    assert(
      !impossible.ok && String(impossible.reason || '').includes('筛选条件'),
      `${label}:empty-honest`,
      `expected filtered honest failure, got ${JSON.stringify(impossible).slice(0, 200)}`,
    );
    // Cache-hit path: same-tier player-count filter + no-DT must hold.
    const hot = await recommendForPlayer({ kind: 'id', value: 10000001 }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      filters: parseRecommendStatement('similar>=10 no_dt').filters,
      filterStatement: 'similar>=10 no_dt',
    });
    assert(hot.ok, `${label}:similar-ok`, `expected ok, got ${JSON.stringify(hot).slice(0, 200)}`);
    if (hot.ok) {
      const bad = hot.candidates.filter(
        (c) => c.similarCount < 10 || c.mods.includes('DT') || c.mods.includes('NC'),
      );
      assert(bad.length === 0, `${label}:similar-values`, JSON.stringify(
        bad.map((c) => ({ title: c.title, similarCount: c.similarCount, mods: c.mods })),
      ));
    }
    // "playable": cap candidates at the player's Top star × 1.1 (base domain)
    // and keep mod-adjusted display values (DT maps must show modded stars).
    const playable = await recommendForPlayer({ kind: 'id', value: 10000003 }, db, {
      count: 3,
      excludeBeatmapsetIds: new Set(),
      bypassCache: true,
      filters: parseRecommendStatement('playable').filters,
      filterStatement: 'playable',
    });
    assert(playable.ok, `${label}:playable-ok`, `expected ok, got ${JSON.stringify(playable).slice(0, 200)}`);
    if (playable.ok) {
      const cap = (playable.stats?.topStarMax || 0) * 1.1 + 0.01;
      const tooHard = playable.candidates.filter((c) => c.baseStars > cap);
      assert(tooHard.length === 0, `${label}:playable-cap`, JSON.stringify(
        tooHard.map((c) => ({ title: c.title, baseStars: c.baseStars, cap })),
      ));
      const modAdjusted = playable.candidates.filter(
        (c) => c.mods.length > 0 && c.stars > c.baseStars + 0.2,
      );
      assert(modAdjusted.length >= 1, `${label}:mod-adjusted`, JSON.stringify(
        playable.candidates.map((c) => ({ title: c.title, mods: c.mods, stars: c.stars, baseStars: c.baseStars })),
      ));
    }
  }
}

// ── 4. Cooldown + anti-repeat persistence ──
{
  const label = 'cooldown';
  const osuId = 10000002; // BetaPlayer (do not touch production binding)
  const before = checkRecommendCooldown(db, osuId);
  assert(before === 0, `${label}:fresh`, `expected 0, got ${before}`);

  markRecommendation(osuId, [
    { beatmapId: 99991, beatmapsetId: 88881, title: 't', artist: 'a', creator: 'c', version: 'v', coverUrl: '', mapUrl: '', stars: 5, bpm: 180, totalLength: 120, mods: [], pp: 100, similarCount: 1 },
  ]);
  const afterDb = readDb();
  const cooldown = checkRecommendCooldown(afterDb, osuId);
  assert(cooldown > 0, `${label}:set`, `expected > 0, got ${cooldown}`);
  const history = loadRecommendHistory(afterDb, osuId);
  assert(history.has(88881), `${label}:history`, `88881 missing from ${JSON.stringify([...history])}`);

  const cleared = clearRecommendHistory(osuId);
  assert(cleared >= 1, `${label}:clear-count`, `expected >=1, got ${cleared}`);
  const afterClearDb = readDb();
  assert(checkRecommendCooldown(afterClearDb, osuId) === 0, `${label}:clear-cooldown`, 'cooldown not reset');
  assert(loadRecommendHistory(afterClearDb, osuId).size === 0, `${label}:clear-history`, 'history not empty');
}

// ── 5. Internal bot command returns readable output ──
{
  const label = 'internal-command';
  try {
    const result = await executeInternalBotCommand('yumu', 'recommend', '[TST]Alpha', { db, userId: 'verify-user', groupId: 'test-group' });
    const text = typeof result === 'string' ? result : result.content;
    const images = typeof result === 'string' ? [] : (result.images || []);
    assert(String(text).includes('谱面推荐'), `${label}:content`, text.slice(0, 200));
    assert(Array.isArray(images) && images.length <= 3, `${label}:images`, `images=${JSON.stringify(images).slice(0, 120)}`);
  } catch (e) {
    fail(label, e.message);
  }
}

mockServer.close();
verifyProductionDbUnchanged(prodBefore);
cleanupTestDir(testDataDir);

console.log(`\nRECOMMEND-VERIFY: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
