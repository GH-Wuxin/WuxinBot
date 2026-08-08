// osu-api-mock.mjs — shared offline osu! API mock for verifies that must not
// depend on osu.ppy.sh availability or rate limits. Serve a deterministic
// synthetic world and point the runtime at it with:
//   process.env.OSU_API_BASE_URL = mock.apiBase;
//   process.env.OSU_TOKEN_URL = mock.tokenUrl;
// Set the env vars BEFORE importing any server module that reads them
// (server/osu/api.ts and server/osu/auth.ts capture them at module load).

import http from 'node:http';

// ── Synthetic world ────────────────────────────────────────────────────────

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
  [1010, 7010, 'Kappa Fixture', '6.4', { bpm: 168, ar: 8.8, version: 'Insane' }],
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
    country: { code: 'CN', name: 'China' },
  };
}

function fixtureScore(id, userId, beatmapId, pp, rank = 'S', mods = []) {
  const beatmap = BEATMAPS.get(beatmapId);
  if (!beatmap) throw new Error(`osu-api-mock: unknown beatmap ${beatmapId}`);
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
    ended_at: '2026-01-01T00:01:00Z',
    mode: 'osu',
    weight: { percentage: 100, pp },
  };
}

function buildDefaultFixture() {
  const users = new Map([
    [19244792, fixtureUser(19244792, '[SHK]Wuxin', 8700)],
    [24657559, fixtureUser(24657559, 'tan-X', 7600)],
    [1234567, fixtureUser(1234567, 'fixture-user', 5000)],
    [37645378, fixtureUser(37645378, 'sparse-user', 1200)],
    [80001, fixtureUser(80001, 'match-a', 5000)],
    [80002, fixtureUser(80002, 'match-b', 4800)],
    [80003, fixtureUser(80003, 'match-c', 4600)],
  ]);

  let scoreId = 1;
  const best = new Map();
  best.set(19244792, [
    fixtureScore(scoreId++, 19244792, 1001, 300, 'S'),
    fixtureScore(scoreId++, 19244792, 1002, 280, 'S'),
    fixtureScore(scoreId++, 19244792, 1003, 260, 'S'),
    fixtureScore(scoreId++, 19244792, 1004, 340, 'S', ['DT']),
    fixtureScore(scoreId++, 19244792, 1005, 310, 'S', ['HR']),
    fixtureScore(scoreId++, 19244792, 1006, 250, 'S', ['HD']),
    fixtureScore(scoreId++, 19244792, 1007, 240, 'S', ['NF', 'SO']),
  ]);
  best.set(24657559, [
    fixtureScore(scoreId++, 24657559, 1004, 300, 'S'),
    fixtureScore(scoreId++, 24657559, 1005, 280, 'S'),
    fixtureScore(scoreId++, 24657559, 1006, 260, 'S'),
    fixtureScore(scoreId++, 24657559, 1007, 320, 'S', ['HD']),
    fixtureScore(scoreId++, 24657559, 1008, 290, 'S', ['HR']),
  ]);
  best.set(1234567, Array.from({ length: 20 }, (_, i) => {
    const beatmapId = 1001 + (i % 10);
    const mods = i % 4 === 1 ? ['DT'] : i % 4 === 2 ? ['HR'] : [];
    return fixtureScore(scoreId++, 1234567, beatmapId, 320 - i * 3, i % 3 === 0 ? 'SS' : 'S', mods);
  }));
  best.set(37645378, []);
  best.set(80001, [fixtureScore(scoreId++, 80001, 1001, 300, 'S')]);
  best.set(80002, [fixtureScore(scoreId++, 80002, 1001, 280, 'S')]);
  best.set(80003, [fixtureScore(scoreId++, 80003, 1001, 260, 'S')]);

  const recent = new Map();
  recent.set(19244792, [fixtureScore(scoreId++, 19244792, 1008, 290, 'S')]);
  recent.set(1234567, [fixtureScore(scoreId++, 1234567, 1009, 240, 'S', ['DT'])]);

  const round = {
    id: 5001,
    beatmap: BEATMAPS.get(1001),
    beatmap_id: 1001,
    start_time: '2026-08-07T10:00:00Z',
    end_time: '2026-08-07T10:04:00Z',
    mode_int: 0,
    mods: [],
    scores: [
      { id: 6001, user_id: 80001, score: 1_000_000, max_combo: 1000, mods: [], passed: true, accuracy: 0.98, statistics: { count_300: 500, count_100: 10, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 0, team: null, pass: true } },
      { id: 6002, user_id: 80002, score: 980_000, max_combo: 990, mods: [], passed: true, accuracy: 0.97, statistics: { count_300: 480, count_100: 20, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 1, team: null, pass: true } },
      { id: 6003, user_id: 80003, score: 950_000, max_combo: 950, mods: [], passed: true, accuracy: 0.96, statistics: { count_300: 460, count_100: 30, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 2, team: null, pass: true } },
    ],
    team_type: 'head-to-head',
    scoring_type: 'score',
  };
  const teamVsRound = {
    id: 5002,
    beatmap: BEATMAPS.get(1002),
    beatmap_id: 1002,
    start_time: '2026-08-07T10:05:00Z',
    end_time: '2026-08-07T10:09:00Z',
    mode_int: 0,
    mods: [],
    scores: [
      { id: 6101, user_id: 80001, score: 900_000, max_combo: 900, mods: [], passed: true, accuracy: 0.97, statistics: { count_300: 450, count_100: 20, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 0, team: 'red', pass: true } },
      { id: 6102, user_id: 80002, score: 850_000, max_combo: 850, mods: [], passed: true, accuracy: 0.96, statistics: { count_300: 430, count_100: 25, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 1, team: 'red', pass: true } },
      { id: 6103, user_id: 80003, score: 800_000, max_combo: 800, mods: [], passed: true, accuracy: 0.95, statistics: { count_300: 400, count_100: 30, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 2, team: 'blue', pass: true } },
      { id: 6104, user_id: 80004, score: 780_000, max_combo: 780, mods: [], passed: true, accuracy: 0.94, statistics: { count_300: 390, count_100: 35, count_50: 0, count_miss: 0, count_geki: 0, count_katsu: 0 }, match: { slot: 3, team: 'blue', pass: true } },
    ],
    team_type: 'team-vs',
    scoring_type: 'score',
  };
  const liveMatch = {
    match: { id: 900900900, start_time: '2026-08-07T10:00:00Z', end_time: null, name: '离线测试房' },
    events: [
      { id: 1, detail: { type: 'player-joined', text: 'match-a joined the game' }, timestamp: '2026-08-07T09:59:00Z', user_id: 80001, game: null },
      { id: 2, detail: { type: 'match', text: 'round start' }, timestamp: '2026-08-07T10:00:00Z', user_id: null, game: round },
      { id: 3, detail: { type: 'match', text: 'round start' }, timestamp: '2026-08-07T10:05:00Z', user_id: null, game: teamVsRound },
    ],
    users: [
      { id: 80001, username: 'match-a', country_code: 'CN', avatar_url: '', is_online: true },
      { id: 80002, username: 'match-b', country_code: 'CN', avatar_url: '', is_online: true },
      { id: 80003, username: 'match-c', country_code: 'CN', avatar_url: '', is_online: true },
      { id: 80004, username: 'match-d', country_code: 'CN', avatar_url: '', is_online: true },
    ],
    first_event_id: 1,
    latest_event_id: 3,
    current_game_id: null,
  };

  const leaderboards = new Map();
  for (const [bid] of MAPS) {
    leaderboards.set(bid, [
      { user_id: 19244792, pp: 300 },
      { user_id: 24657559, pp: 280 },
      { user_id: 1234567, pp: 260 },
    ].map(({ user_id, pp }) => fixtureScore(scoreId++, user_id, bid, pp, 'S', bid === 1009 ? ['DT'] : [])));
  }

  return {
    users,
    best,
    recent,
    matches: new Map([[900900900, liveMatch]]),
    leaderboards,
  };
}

function attributesFor(beatmap, mods) {
  const normalized = (mods || []).map((m) => String(m || '').toUpperCase());
  let star = Number(beatmap?.difficulty_rating || 0);
  if (normalized.some((m) => m === 'DT' || m === 'NC')) star *= 1.4;
  else if (normalized.some((m) => m === 'HR')) star *= 1.2;
  else if (normalized.some((m) => m === 'EZ')) star *= 0.5;
  else if (normalized.some((m) => m === 'HT')) star *= 0.85;
  return { star_rating: Math.round(star * 100) / 100, max_combo: 1000 };
}

// ── HTTP server ────────────────────────────────────────────────────────────

export function startOsuApiMock(options = {}) {
  const fixture = options.fixture || buildDefaultFixture();
  const users = fixture.users || new Map();
  const best = fixture.best || new Map();
  const recent = fixture.recent || new Map();
  const matches = fixture.matches || new Map();
  const leaderboards = fixture.leaderboards || new Map();

  let port = 0;
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
    const send = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && pathname === '/oauth/token') {
      return send({ access_token: 'fixture-token', expires_in: 86400, token_type: 'Bearer' });
    }

    let m = /^\/api\/v2\/users\/(\d+)\/osu$/.exec(pathname);
    if (m) {
      const u = users.get(Number(m[1]));
      return u ? send(u) : send({ error: 'not_found' }, 404);
    }

    m = /^\/api\/v2\/users\/@(.+)\/osu$/.exec(pathname);
    if (m) {
      const u = [...users.values()].find((x) => x.username === m[1]);
      return u ? send(u) : send({ error: 'not_found' }, 404);
    }

    m = /^\/api\/v2\/users\/(\d+)\/scores\/best$/.exec(pathname);
    if (m) return send(best.get(Number(m[1])) || []);

    m = /^\/api\/v2\/users\/(\d+)\/scores\/recent$/.exec(pathname);
    if (m) return send(recent.get(Number(m[1])) || []);

    m = /^\/api\/v2\/beatmaps\/(\d+)\/scores\/users\/(\d+)$/.exec(pathname);
    if (m) {
      const uid = Number(m[2]);
      const bid = Number(m[1]);
      const all = [...(best.get(uid) || []), ...(recent.get(uid) || [])];
      const score = all.find((s) => Number(s.beatmap?.id) === bid);
      return score ? send({ score }) : send({ error: 'not_found' }, 404);
    }

    m = /^\/api\/v2\/beatmaps\/(\d+)\/scores$/.exec(pathname);
    if (m) return send({ scores: leaderboards.get(Number(m[1])) || [] });

    m = /^\/api\/v2\/beatmaps\/(\d+)\/attributes$/.exec(pathname);
    if (m && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let mods = [];
        try { mods = JSON.parse(body || '{}').mods || []; } catch { /* keep [] */ }
        const beatmap = BEATMAPS.get(Number(m[1]));
        return send({ attributes: attributesFor(beatmap, mods) });
      });
      return;
    }

    m = /^\/api\/v2\/beatmaps\/(\d+)$/.exec(pathname);
    if (m) {
      const beatmap = BEATMAPS.get(Number(m[1]));
      return beatmap ? send(beatmap) : send({ error: 'not_found' }, 404);
    }

    m = /^\/api\/v2\/matches\/(\d+)$/.exec(pathname);
    if (m) {
      const match = matches.get(Number(m[1]));
      return match ? send(match) : send({ error: 'not_found' }, 404);
    }

    return send({ error: 'not_found' }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        apiBase: `http://127.0.0.1:${port}/api/v2`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        fixture,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
